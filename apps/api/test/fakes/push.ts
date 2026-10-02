import { createDecipheriv, createECDH, createPublicKey, createVerify, hkdfSync, randomBytes } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { FakeServer, type Call } from './base.js';

const b64u = (b: Buffer) => b.toString('base64url');
const hkdf = (salt: Buffer, ikm: Buffer, info: string | Buffer, len: number) => Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from(info), len));

/** A browser's keys, as a push subscription: what a real browser makes when a person agrees to notifications. */
export class FakeBrowser {
  private ecdh = createECDH('prime256v1');
  auth = randomBytes(16);
  constructor(public endpoint: string) { this.ecdh.generateKeys(); }
  get subscription() {
    return { endpoint: this.endpoint, keys: { p256dh: b64u(this.ecdh.getPublicKey()), auth: b64u(this.auth) } };
  }

  /**
   * Reads a message the way a browser does (RFC 8291 section 4), written separately from the code that encrypts it: header, shared secret,
   * the two HKDF steps, AES-128-GCM, and the padding delimiter.
   */
  decrypt(body: Buffer): string {
    const salt = body.subarray(0, 16);
    const rs = body.readUInt32BE(16);
    const idlen = body[20]!;
    const asPublic = body.subarray(21, 21 + idlen);
    const cipher = body.subarray(21 + idlen);
    if (cipher.length > rs) throw new Error('more than one record');
    const secret = this.ecdh.computeSecret(asPublic);
    const ikm = hkdf(this.auth, secret, Buffer.concat([Buffer.from('WebPush: info\0'), this.ecdh.getPublicKey(), asPublic]), 32);
    const cek = hkdf(salt, ikm, 'Content-Encoding: aes128gcm\0', 16);
    const nonce = hkdf(salt, ikm, 'Content-Encoding: nonce\0', 12);
    const d = createDecipheriv('aes-128-gcm', cek, nonce);
    d.setAuthTag(cipher.subarray(cipher.length - 16));
    const plain = Buffer.concat([d.update(cipher.subarray(0, cipher.length - 16)), d.final()]);
    const end = plain.lastIndexOf(0x02);
    if (end === -1 || plain.subarray(end + 1).some((x) => x !== 0)) throw new Error('bad padding');
    return plain.subarray(0, end).toString('utf8');
  }
}

/** A stand-in for a browser's push service (FCM, Mozilla, Apple): it checks the VAPID signature and keeps what it was given. */
export class FakePushService extends FakeServer {
  received: { path: string; headers: Record<string, any>; body: Buffer }[] = [];
  /** Paths whose subscription the service says is gone (410). */
  gone = new Set<string>();
  /** Set to make it refuse the VAPID signature. */
  rejectVapid = false;
  vapidProblems: string[] = [];
  private browsers = new Map<string, FakeBrowser>();

  /** A new browser subscribed through this service. */
  browser(name = randomBytes(6).toString('hex')): FakeBrowser {
    const b = new FakeBrowser(`${this.url}/push/${name}`);
    this.browsers.set(`/push/${name}`, b);
    return b;
  }

  /** Checks the `Authorization: vapid t=…, k=…` header the way a push service does (RFC 8292). Returns the claims, or throws. */
  private checkVapid(header: string, path: string): Record<string, any> {
    const m = /^vapid t=([\w-]+)\.([\w-]+)\.([\w-]+), k=([\w-]+)$/.exec(header);
    if (!m) throw new Error('not a vapid header');
    const [, h, p, sig, k] = m as unknown as [string, string, string, string, string];
    const pub = Buffer.from(k, 'base64url');
    if (pub.length !== 65 || pub[0] !== 4) throw new Error('bad public key');
    const key = createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: b64u(pub.subarray(1, 33)), y: b64u(pub.subarray(33, 65)) }, format: 'jwk' });
    const ok = createVerify('SHA256').update(`${h}.${p}`).verify({ key, dsaEncoding: 'ieee-p1363' }, Buffer.from(sig, 'base64url'));
    if (!ok) throw new Error('signature does not verify');
    const header_ = JSON.parse(Buffer.from(h, 'base64url').toString());
    if (header_.alg !== 'ES256') throw new Error('not ES256');
    const claims = JSON.parse(Buffer.from(p, 'base64url').toString());
    if (claims.aud !== new URL(this.url).origin) throw new Error(`aud ${claims.aud} is not ${new URL(this.url).origin}`);
    if (!(claims.exp > Date.now() / 1000) || claims.exp > Date.now() / 1000 + 24 * 3600) throw new Error('exp is not within 24 hours');
    if (!/^(mailto:|https?:)/.test(claims.sub ?? '')) throw new Error('sub is not mailto: or a URL');
    void path;
    return claims;
  }

  async handle(c: Call, _req: FastifyRequest, reply: FastifyReply) {
    if (c.method !== 'POST' || !c.path.startsWith('/push/')) return reply.code(404).send('no');
    if (this.gone.has(c.path)) return reply.code(410).send('gone');
    const h = c.headers;
    try {
      if (this.rejectVapid) throw new Error('rejected on purpose');
      this.checkVapid(String(h.authorization ?? ''), c.path);
      if (h['content-encoding'] !== 'aes128gcm') throw new Error('content-encoding is not aes128gcm');
      if (!/^\d+$/.test(String(h.ttl ?? ''))) throw new Error('no TTL');
    } catch (err) {
      this.vapidProblems.push((err as Error).message);
      return reply.code(401).send((err as Error).message);
    }
    // Anything that is not JSON or a form reaches the stand-in as a stream.
    const chunks: Buffer[] = [];
    for await (const chunk of c.body as AsyncIterable<Buffer>) chunks.push(Buffer.from(chunk));
    const body = Buffer.concat(chunks);
    this.received.push({ path: c.path, headers: h, body });
    return reply.code(201).send('');
  }

  /** What a browser would have shown, for each message that reached it. */
  messagesFor(browser: FakeBrowser): Record<string, any>[] {
    const path = new URL(browser.endpoint).pathname;
    return this.received.filter((r) => r.path === path).map((r) => JSON.parse(browser.decrypt(r.body)));
  }
}

