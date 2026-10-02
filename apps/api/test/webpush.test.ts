import { createVerify, createPublicKey } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { encryptPayload, newVapidKeys, sendPush, vapidHeader } from '../src/services/webpush.js';
import { FakePushService } from './fakes/push.js';

const policy = { allowPrivate: true, httpsForPublic: false };
/** The shape the sender takes: the endpoint with the two keys beside it (a browser's own shape nests the keys). */
const flat = (b: { subscription: { endpoint: string; keys: { p256dh: string; auth: string } } }) => ({ endpoint: b.subscription.endpoint, ...b.subscription.keys });
const service = new FakePushService();
beforeAll(async () => { await service.start(); });
afterAll(async () => { await service.stop(); });

describe('encrypting a message for a browser', () => {
  it('produces exactly what RFC 8291 gives for its own example (section 5 and appendix A)', () => {
    const b = (s: string) => Buffer.from(s, 'base64url');
    const out = encryptPayload(
      { p256dh: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4', auth: 'BTBZMqHH6r4Tts7J_aSIgg' },
      Buffer.from('When I grow up, I want to be a watermelon'),
      {
        ephemeral: {
          privateKey: b('yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw'),
          publicKey: b('BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8'),
        },
        salt: b('DGv6ra1nlYgDCS1FRnbzlw'),
      },
    );
    expect(out.toString('base64url')).toBe(
      'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN',
    );
  });

  it('can be read by the browser it was made for, at any length that fits one record', () => {
    const browser = service.browser();
    for (const length of [0, 1, 80, 1000, 4096 - 18 - 17]) {
      const text = 'é'.repeat(length / 2) + 'x'.repeat(length % 2);
      const body = encryptPayload(browser.subscription.keys, Buffer.from(text));
      expect(browser.decrypt(body), `${length} bytes`).toBe(text);
    }
  });

  it('is different every time (a new key and salt per message), and unreadable by another browser', () => {
    const a = service.browser();
    const b = service.browser();
    const one = encryptPayload(a.subscription.keys, Buffer.from('hello'));
    const two = encryptPayload(a.subscription.keys, Buffer.from('hello'));
    expect(one.equals(two)).toBe(false);
    expect(one.subarray(0, 16).equals(two.subarray(0, 16))).toBe(false); // salt
    expect(one.subarray(21, 86).equals(two.subarray(21, 86))).toBe(false); // the sender's one-off public key
    expect(() => b.decrypt(one)).toThrow();
  });

  it('is refused for a message that does not fit one record, and for keys of the wrong shape', () => {
    const browser = service.browser();
    expect(() => encryptPayload(browser.subscription.keys, Buffer.alloc(4096))).toThrow(/too long/);
    expect(() => encryptPayload({ p256dh: 'AAAA', auth: browser.subscription.keys.auth }, Buffer.from('x'))).toThrow(/P-256/);
    expect(() => encryptPayload({ p256dh: browser.subscription.keys.p256dh, auth: 'AAAA' }, Buffer.from('x'))).toThrow(/16 bytes/);
  });

  it('tampering with the body is noticed by the browser', () => {
    const browser = service.browser();
    const body = encryptPayload(browser.subscription.keys, Buffer.from('a message'));
    body[body.length - 3]! ^= 1;
    expect(() => browser.decrypt(body)).toThrow();
  });
});

describe('signing as the deployment (VAPID)', () => {
  it('makes a P-256 key pair: 65 bytes public, 32 private, a new one each time', () => {
    const k = newVapidKeys();
    expect(Buffer.from(k.publicKey, 'base64url')).toHaveLength(65);
    expect(Buffer.from(k.publicKey, 'base64url')[0]).toBe(4);
    expect(Buffer.from(k.privateKey, 'base64url')).toHaveLength(32);
    expect(newVapidKeys().publicKey).not.toBe(k.publicKey);
  });

  it('puts a short-lived ES256 token for the push service\'s origin in the header, with the public key', () => {
    const keys = newVapidKeys();
    const now = new Date('2026-10-02T10:00:00Z');
    const header = vapidHeader('https://fcm.googleapis.com/fcm/send/abc', keys, 'mailto:ops@example.com', now);
    const m = /^vapid t=([\w-]+)\.([\w-]+)\.([\w-]+), k=([\w-]+)$/.exec(header)!;
    expect(m).not.toBeNull();
    expect(m[4]).toBe(keys.publicKey);
    const [h, p, sig] = [m[1]!, m[2]!, m[3]!];
    expect(JSON.parse(Buffer.from(h, 'base64url').toString())).toEqual({ typ: 'JWT', alg: 'ES256' });
    expect(JSON.parse(Buffer.from(p, 'base64url').toString())).toEqual({ aud: 'https://fcm.googleapis.com', exp: Math.floor(now.getTime() / 1000) + 12 * 3600, sub: 'mailto:ops@example.com' });
    expect(Buffer.from(sig, 'base64url')).toHaveLength(64); // raw r||s, not DER
    const pub = Buffer.from(keys.publicKey, 'base64url');
    const key = createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: pub.subarray(1, 33).toString('base64url'), y: pub.subarray(33).toString('base64url') }, format: 'jwk' });
    expect(createVerify('SHA256').update(`${h}.${p}`).verify({ key, dsaEncoding: 'ieee-p1363' }, Buffer.from(sig, 'base64url'))).toBe(true);
    // Another key does not verify it.
    const other = newVapidKeys();
    const op = Buffer.from(other.publicKey, 'base64url');
    const otherKey = createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: op.subarray(1, 33).toString('base64url'), y: op.subarray(33).toString('base64url') }, format: 'jwk' });
    expect(createVerify('SHA256').update(`${h}.${p}`).verify({ key: otherKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(sig, 'base64url'))).toBe(false);
  });
});

describe('sending', () => {
  it('reaches the browser, which reads the message, and the push service accepts the signature', async () => {
    const browser = service.browser();
    const keys = newVapidKeys();
    const r = await sendPush(flat(browser), { title: 'Hello', body: 'World' }, keys, 'mailto:ops@example.com', new Date(), policy);
    expect(r).toEqual({ ok: true });
    expect(service.messagesFor(browser)).toEqual([{ title: 'Hello', body: 'World' }]);
    expect(service.vapidProblems).toEqual([]);
  });

  it('says a subscription is gone when the push service says so (404 or 410), and says to try again for anything else', async () => {
    const keys = newVapidKeys();
    const gone = service.browser('gone');
    service.gone.add('/push/gone');
    expect(await sendPush(flat(gone), { a: 1 }, keys, 'mailto:a@b.c', new Date(), policy)).toMatchObject({ ok: false, gone: true, status: 410 });

    const unknown = service.browser('x');
    expect(await sendPush({ ...flat(unknown), endpoint: `${service.url}/nowhere` }, { a: 1 }, keys, 'mailto:a@b.c', new Date(), policy)).toMatchObject({ ok: false, gone: true, status: 404 });

    service.rejectVapid = true;
    const rejected = await sendPush(flat(service.browser()), { a: 1 }, keys, 'mailto:a@b.c', new Date(), policy);
    service.rejectVapid = false;
    expect(rejected).toMatchObject({ ok: false, gone: false, status: 401 });

    const nobody = await sendPush({ ...flat(service.browser()), endpoint: 'http://127.0.0.1:1/push/x' }, { a: 1 }, keys, 'mailto:a@b.c', new Date(), policy);
    expect(nobody).toMatchObject({ ok: false, gone: false, status: null });
  });

  it('does not send to an address the server must not reach (cloud metadata), or a private one when the deployment forbids it', async () => {
    const keys = newVapidKeys();
    const browser = service.browser();
    const before = service.calls.length;
    for (const endpoint of ['http://169.254.169.254/latest/meta-data', 'https://user:pw@push.example.com/x', 'ftp://push.example.com/x']) {
      const r = await sendPush({ ...flat(browser), endpoint }, { a: 1 }, keys, 'mailto:a@b.c', new Date(), policy);
      expect(r, endpoint).toMatchObject({ ok: false, gone: true });
    }
    const priv = await sendPush(flat(browser), { a: 1 }, keys, 'mailto:a@b.c', new Date(), { allowPrivate: false, httpsForPublic: true });
    expect(priv).toMatchObject({ ok: false, gone: true });
    expect(service.calls.length).toBe(before);
  });
});
