import { createCipheriv, createECDH, createPrivateKey, createSign, hkdfSync, randomBytes, type KeyObject } from 'node:crypto';
import { checkUrl, post, type NetPolicy } from '../net.js';

/**
 * Web Push without a library: the message is encrypted for the browser (RFC 8291, `aes128gcm` content coding from RFC 8188) and the
 * request is signed with the deployment's VAPID key (RFC 8292). Only the browser's push service and the browser can read it.
 * Pure functions here; the keys, the subscriptions and the retries live in push.ts.
 */
const RECORD_SIZE = 4096;
const b64u = (b: Buffer) => b.toString('base64url');
const fromB64u = (s: string) => Buffer.from(s, 'base64url');

export interface PushSubscription {
  endpoint: string;
  /** The browser's public key: 65 bytes, uncompressed P-256, base64url. */
  p256dh: string;
  /** The browser's authentication secret: 16 bytes, base64url. */
  auth: string;
}

export interface VapidKeys {
  /** 65 bytes, uncompressed P-256, base64url: what the browser is given to subscribe with. */
  publicKey: string;
  /** The 32-byte private scalar, base64url. */
  privateKey: string;
}

export function newVapidKeys(): VapidKeys {
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  return { publicKey: b64u(ecdh.getPublicKey()), privateKey: b64u(ecdh.getPrivateKey()) };
}

/** A key object for signing with the private scalar and its public point. */
function signingKey(keys: VapidKeys): KeyObject {
  const pub = fromB64u(keys.publicKey);
  return createPrivateKey({ key: { kty: 'EC', crv: 'P-256', d: keys.privateKey, x: b64u(pub.subarray(1, 33)), y: b64u(pub.subarray(33, 65)) }, format: 'jwk' });
}

/** The `Authorization` header that says which deployment is sending (RFC 8292): a short-lived ES256 token for the push service's origin. */
export function vapidHeader(endpoint: string, keys: VapidKeys, subject: string, now: Date): string {
  const aud = new URL(endpoint).origin;
  const enc = (o: unknown) => b64u(Buffer.from(JSON.stringify(o)));
  const input = `${enc({ typ: 'JWT', alg: 'ES256' })}.${enc({ aud, exp: Math.floor(now.getTime() / 1000) + 12 * 3600, sub: subject })}`;
  // A JWT's ES256 signature is the raw r||s pair, not the DER form.
  const sig = createSign('SHA256').update(input).sign({ key: signingKey(keys), dsaEncoding: 'ieee-p1363' });
  return `vapid t=${input}.${b64u(sig)}, k=${keys.publicKey}`;
}

const hkdf = (salt: Buffer, ikm: Buffer, info: Buffer, length: number) => Buffer.from(hkdfSync('sha256', ikm, salt, info, length));

/**
 * Encrypts one message for a browser (RFC 8291 section 3). `ephemeral` and `salt` are only given by the test that checks this against
 * the RFC's own example; every real message gets a new random pair.
 */
export function encryptPayload(
  sub: Pick<PushSubscription, 'p256dh' | 'auth'>, payload: Buffer,
  fixed: { ephemeral?: { publicKey: Buffer; privateKey: Buffer }; salt?: Buffer } = {},
): Buffer {
  const uaPublic = fromB64u(sub.p256dh);
  const authSecret = fromB64u(sub.auth);
  if (uaPublic.length !== 65 || uaPublic[0] !== 0x04) throw new Error('The browser\'s public key is not an uncompressed P-256 point');
  if (authSecret.length !== 16) throw new Error('The browser\'s authentication secret is not 16 bytes');
  if (payload.length > RECORD_SIZE - 17 - 1) throw new Error('The message is too long for one push record');

  const as = createECDH('prime256v1');
  if (fixed.ephemeral) as.setPrivateKey(fixed.ephemeral.privateKey);
  else as.generateKeys();
  const asPublic = as.getPublicKey();
  const salt = fixed.salt ?? randomBytes(16);
  const shared = as.computeSecret(uaPublic);

  // The key both sides can compute, bound to both public keys and to the browser's secret…
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic]);
  const ikm = hkdf(authSecret, shared, keyInfo, 32);
  // …and from it, this message's content-encryption key and nonce.
  const cek = hkdf(salt, ikm, Buffer.from('Content-Encoding: aes128gcm\0'), 16);
  const nonce = hkdf(salt, ikm, Buffer.from('Content-Encoding: nonce\0'), 12);

  const cipher = createCipheriv('aes-128-gcm', cek, nonce);
  // One record, so the delimiter is 0x02 (the last record).
  const body = Buffer.concat([cipher.update(Buffer.concat([payload, Buffer.from([0x02])])), cipher.final(), cipher.getAuthTag()]);
  const rs = Buffer.alloc(4);
  rs.writeUInt32BE(RECORD_SIZE);
  return Buffer.concat([salt, rs, Buffer.from([asPublic.length]), asPublic, body]);
}

export type PushOutcome =
  | { ok: true }
  /** The push service says this subscription is gone for good (the person removed it, or uninstalled): forget it. */
  | { ok: false; gone: true; status: number }
  | { ok: false; gone: false; status: number | null; retryAfterSec?: number; message: string };

/**
 * Sends one message. Never throws: what happened is the answer. The address is one a browser handed us, so it goes through the same
 * address policy as a webhook: a subscription pointing at the server's own network is refused, not followed.
 */
export async function sendPush(sub: PushSubscription, message: object, keys: VapidKeys, subject: string, now: Date, policy: NetPolicy): Promise<PushOutcome> {
  const checked = checkUrl(sub.endpoint, policy);
  if ('error' in checked) return { ok: false, gone: true, status: 0 }; // not a place a push can be sent: forget it
  let r;
  try {
    r = await post(checked.url, {
      'content-encoding': 'aes128gcm', 'content-type': 'application/octet-stream', ttl: '86400', urgency: 'normal',
      authorization: vapidHeader(sub.endpoint, keys, subject, now),
    }, encryptPayload(sub, Buffer.from(JSON.stringify(message))), policy, 15_000);
  } catch (err) {
    return { ok: false, gone: false, status: null, message: (err as Error).message };
  }
  if (r.status >= 200 && r.status < 300) return { ok: true };
  if (r.status === 404 || r.status === 410) return { ok: false, gone: true, status: r.status };
  const retryAfter = Number(r.headers['retry-after']);
  return {
    ok: false, gone: false, status: r.status, ...(Number.isFinite(retryAfter) && retryAfter > 0 ? { retryAfterSec: retryAfter } : {}),
    message: r.text ? r.text.slice(0, 200) : `The push service answered ${r.status}`,
  };
}
