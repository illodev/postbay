import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { checkUrl, classifyAddress, PolicyError, post, refusal } from '../src/net.js';
import { Receiver } from './receiver.js';

const rx = new Receiver();
beforeAll(async () => { await rx.start(); });
afterAll(async () => { await rx.stop(); });

describe('address classes', () => {
  it('knows which addresses are public, private, or never allowed', () => {
    const cases: [string, string][] = [
      ['93.184.216.34', 'public'], ['8.8.8.8', 'public'], ['2606:2800:220:1:248:1893:25c8:1946', 'public'],
      ['127.0.0.1', 'private'], ['10.0.0.1', 'private'], ['172.16.5.4', 'private'], ['172.31.255.255', 'private'], ['192.168.1.1', 'private'],
      ['100.64.0.1', 'private'], ['::1', 'private'], ['fd12:3456::1', 'private'],
      ['172.32.0.1', 'public'], ['172.15.0.1', 'public'], ['11.0.0.1', 'public'],
      ['169.254.169.254', 'never'], ['169.254.0.1', 'never'], ['0.0.0.0', 'never'], ['224.0.0.1', 'never'], ['255.255.255.255', 'never'],
      ['fe80::1', 'never'], ['::', 'never'], ['ff02::1', 'never'],
      // IPv4 written as IPv6 is judged as the IPv4 address it wraps.
      ['::ffff:169.254.169.254', 'never'], ['::ffff:10.0.0.1', 'private'], ['::ffff:8.8.8.8', 'public'], ['::ffff:a9fe:a9fe', 'never'],
    ];
    for (const [ip, cls] of cases) expect(classifyAddress(ip), ip).toBe(cls);
  });

  it('applies the policy: private only when allowed, plain http to a public address only outside production', () => {
    const open = { allowPrivate: true, httpsForPublic: false };
    const prod = { allowPrivate: false, httpsForPublic: true };
    expect(refusal('10.0.0.1', 'http:', open)).toBeNull();
    expect(refusal('10.0.0.1', 'http:', prod)).toMatch(/private network/);
    expect(refusal('169.254.169.254', 'https:', open)).toMatch(/not an address/);
    expect(refusal('93.184.216.34', 'http:', prod)).toMatch(/https/);
    expect(refusal('93.184.216.34', 'https:', prod)).toBeNull();
    expect(refusal('93.184.216.34', 'http:', open)).toBeNull();
  });

  it('checks what an address says before anything is resolved', () => {
    const open = { allowPrivate: true, httpsForPublic: false };
    expect('url' in checkUrl('https://hooks.example.com/in', open)).toBe(true);
    expect('error' in checkUrl('javascript:alert(1)', open)).toBe(true);
    expect('error' in checkUrl('https://a:b@example.com', open)).toBe(true);
    expect('error' in checkUrl('http://localhost/x', { allowPrivate: false, httpsForPublic: false })).toBe(true);
    expect('url' in checkUrl('http://localhost/x', open)).toBe(true);
  });
});

describe('post', () => {
  const open = { allowPrivate: true, httpsForPublic: false };

  it('sends a body and returns the status and the start of the answer', async () => {
    rx.responder = () => ({ status: 202, body: 'queued' });
    const r = await post(new URL(rx.url), { 'content-type': 'application/json' }, '{"a":1}', open);
    expect(r.status).toBe(202);
    expect(r.text).toBe('queued');
    expect(rx.requests.at(-1)!.body).toBe('{"a":1}');
  });

  it('gives up on a receiver that never answers', async () => {
    rx.responder = () => 'hang';
    const t0 = Date.now();
    await expect(post(new URL(rx.url), {}, '{}', open, 300)).rejects.toThrow(/No answer after/);
    expect(Date.now() - t0).toBeLessThan(3000);
  });

  it('keeps only a small part of a huge answer', async () => {
    rx.responder = () => ({ status: 500, body: 'x'.repeat(100_000) });
    const r = await post(new URL(rx.url), {}, '{}', open);
    expect(r.status).toBe(500);
    expect(r.text.length).toBeLessThanOrEqual(2000);
  });

  it('refuses an address literal and a resolved name by the policy', async () => {
    const closed = { allowPrivate: false, httpsForPublic: false };
    await expect(post(new URL('http://127.0.0.1:9/x'), {}, '{}', closed)).rejects.toBeInstanceOf(PolicyError);
    await expect(post(new URL('http://localhost:9/x'), {}, '{}', closed)).rejects.toBeInstanceOf(PolicyError);
    await expect(post(new URL('http://[::ffff:169.254.169.254]/x'), {}, '{}', open)).rejects.toBeInstanceOf(PolicyError);
  });
});
