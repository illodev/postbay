import { createHmac, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import type http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { interpolate, parseConfig } from '../src/config.js';
import { silentLogger } from '../src/log.js';
import { Queue } from '../src/queue.js';
import { createServer } from '../src/server.js';
import { verifySignature } from '../src/signature.js';

const SECRET = 'whsec_test_secret_for_the_runner';
const NEW_SECRET = 'whsec_the_replacement_secret_value';

const sign = (secret: string, ts: number, body: string) => `v1=${createHmac('sha256', secret).update(`${ts}.${body}`).digest('hex')}`;
const NOW = Date.parse('2026-10-05T10:00:00Z');
const ts = Math.floor(NOW / 1000);

function config(dir: string) {
  return parseConfig(
    {
      workspaceRoot: path.join(dir, 'work'),
      brands: {
        lumen: {
          api: 'https://studio.example.com', token: 'est_0123456789', webhookSecret: [SECRET, NEW_SECRET],
          templates: { 'version.changes_requested': 'templates/changes.md' }, agent: { command: ['true'] },
        },
      },
    },
    dir,
    {},
  );
}

describe('the signature', () => {
  const body = '{"a":1}';
  const hdr = (secret: string, t = ts, b = body) => ({ 'x-studio-timestamp': String(t), 'x-studio-signature': sign(secret, t, b) });

  it('accepts what was signed with the secret, and any secret of the list', () => {
    expect(verifySignature([SECRET], hdr(SECRET), body, NOW)).toEqual({ ok: true });
    expect(verifySignature(['other-secret-value', SECRET], hdr(SECRET), body, NOW)).toEqual({ ok: true });
    expect(verifySignature([SECRET, NEW_SECRET], hdr(NEW_SECRET), body, NOW)).toEqual({ ok: true });
  });

  it('refuses a wrong secret, a changed body, a missing or malformed header', () => {
    expect(verifySignature([SECRET], hdr('wrong-secret-entirely'), body, NOW)).toMatchObject({ ok: false });
    expect(verifySignature([SECRET], hdr(SECRET), '{"a":2}', NOW)).toMatchObject({ ok: false });
    expect(verifySignature([SECRET], {}, body, NOW)).toMatchObject({ ok: false, reason: 'missing signature headers' });
    expect(verifySignature([SECRET], { 'x-studio-timestamp': String(ts), 'x-studio-signature': 'v1=zz' }, body, NOW)).toMatchObject({ ok: false });
    expect(verifySignature([SECRET], { 'x-studio-timestamp': 'yesterday', 'x-studio-signature': sign(SECRET, ts, body) }, body, NOW)).toMatchObject({ ok: false });
    // The timestamp is part of what is signed: a captured delivery cannot be given a fresh one.
    expect(verifySignature([SECRET], { 'x-studio-timestamp': String(ts + 10), 'x-studio-signature': sign(SECRET, ts, body) }, body, NOW)).toMatchObject({ ok: false });
  });

  it('refuses a delivery that is too old or from too far ahead, so a captured one cannot be replayed', () => {
    expect(verifySignature([SECRET], hdr(SECRET, ts - 299), body, NOW)).toEqual({ ok: true });
    expect(verifySignature([SECRET], hdr(SECRET, ts - 301), body, NOW)).toMatchObject({ ok: false, reason: expect.stringContaining('timestamp') });
    expect(verifySignature([SECRET], hdr(SECRET, ts + 301), body, NOW)).toMatchObject({ ok: false });
  });
});

describe('the configuration', () => {
  it('fills ${NAME} from the environment and says which one is missing', () => {
    expect(interpolate({ a: ['x-${TOKEN}'], b: { c: '${TOKEN}' } }, { TOKEN: 'abc' })).toEqual({ a: ['x-abc'], b: { c: 'abc' } });
    expect(() => interpolate('${NOPE}', {})).toThrow(/\$\{NOPE\}.*not set/);
    expect(() => interpolate('${EMPTY}', { EMPTY: '' })).toThrow(/EMPTY/);
  });

  it('checks the shape, with the path of what is wrong, and resolves paths against the file', () => {
    expect(() => parseConfig({ workspaceRoot: '/w', brands: {} }, '/x', {})).toThrow(/at least one brand/);
    const ok = { api: 'https://s.example', token: 'est_0123456789', webhookSecret: 'whsec_0123456789', agent: { command: ['x'] } };
    expect(() => parseConfig({ workspaceRoot: '/w', brands: { 'bad key!': ok } }, '/x', {})).toThrow(/Brand keys/);
    expect(() => parseConfig({ workspaceRoot: '/w', brands: { a: { api: 'not a url', token: 'est_0123456789', webhookSecret: 'whsec_0123456789', agent: { command: ['x'] } } } }, '/x', {})).toThrow(/brands\.a\.api/);
    const c = parseConfig({ workspaceRoot: 'work', brands: { a: { api: 'https://s.example', token: 'est_0123456789', webhookSecret: 'whsec_0123456789', agent: { command: ['x'] } } } }, '/etc/runner', {});
    expect(c.workspaceRoot).toBe('/etc/runner/work');
    expect(c.stateDir).toBe('/etc/runner/work/.state');
    expect(c.brands.a!.checkRetries).toBe(1);
    expect(c.brands.a!.agent.input).toBe('stdin');
    expect(c.brands.a!.checks.loudness).toEqual({ min: -23, max: -9 });
  });
});

describe('the webhook endpoint', () => {
  let dir: string;
  let queue: Queue;
  let server: http.Server;
  let base: string;
  let woken = 0;

  beforeAll(async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'runner-test-'));
    queue = new Queue(path.join(dir, 'state'));
    server = createServer({ config: config(dir), queue, log: silentLogger, now: () => NOW, wake: () => { woken++; } });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });
  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    rmSync(dir, { recursive: true, force: true });
  });
  beforeEach(() => {
    for (const i of queue.list()) queue.done(i);
    woken = 0;
  });

  const event = (type = 'version.changes_requested', id = randomUUID()) => ({ id, type, created_at: '2026-10-05T10:00:00Z', brand: { id: 'b', name: 'Lumen' }, data: { piece: { id: 'p' } } });
  async function post(pathname: string, body: unknown, o: { secret?: string; ts?: number; headers?: Record<string, string>; raw?: string } = {}) {
    const text = o.raw ?? JSON.stringify(body);
    const t = o.ts ?? ts;
    const res = await fetch(base + pathname, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-studio-timestamp': String(t), 'x-studio-signature': sign(o.secret ?? SECRET, t, text), ...(o.headers ?? {}) },
      body: text,
    });
    return { status: res.status, body: await res.json() };
  }

  it('queues a signed event for which the brand has a template, before it answers', async () => {
    const ev = event();
    const r = await post('/webhooks/lumen', ev);
    expect(r).toMatchObject({ status: 202, body: { queued: true } });
    expect(woken).toBe(1);
    const [item] = queue.list();
    expect(item).toMatchObject({ id: ev.id, brand: 'lumen', type: 'version.changes_requested', stage: 'queued', payload: { data: { piece: { id: 'p' } } } });
  });

  it('answers a repeat delivery with a success and queues nothing twice', async () => {
    const ev = event();
    expect((await post('/webhooks/lumen', ev)).status).toBe(202);
    expect(await post('/webhooks/lumen', ev)).toMatchObject({ status: 200, body: { duplicate: true } });
    expect(queue.list()).toHaveLength(1);
    // Still a repeat after it was handled.
    queue.done(queue.list()[0]!);
    expect(await post('/webhooks/lumen', ev)).toMatchObject({ status: 200, body: { duplicate: true } });
    expect(queue.list()).toHaveLength(0);
  });

  it('accepts a delivery signed with the replacement secret while the old one is still listed', async () => {
    expect((await post('/webhooks/lumen', event(), { secret: NEW_SECRET })).status).toBe(202);
  });

  it('refuses a bad signature, a stale timestamp and an unknown brand, and queues nothing', async () => {
    expect((await post('/webhooks/lumen', event(), { secret: 'not-the-secret-at-all-no' })).status).toBe(401);
    expect((await post('/webhooks/lumen', event(), { ts: ts - 3600 })).status).toBe(401);
    expect((await post('/webhooks/lumen', event(), { headers: { 'x-studio-signature': 'v1=' + '0'.repeat(64) } })).status).toBe(401);
    expect((await post('/webhooks/nobody', event())).status).toBe(404);
    expect((await post('/webhooks/__proto__', event())).status).toBe(404);
    expect(queue.list()).toHaveLength(0);
  });

  it('answers a test ping, and ignores events the brand has no template for, without queueing them', async () => {
    expect(await post('/webhooks/lumen', event('ping'))).toMatchObject({ status: 200, body: { pong: true } });
    expect(await post('/webhooks/lumen', event('comment.created'))).toMatchObject({ status: 200, body: { ignored: true } });
    expect(queue.list()).toHaveLength(0);
  });

  it('refuses what is not an event, and bodies that are far too large', async () => {
    expect((await post('/webhooks/lumen', null, { raw: 'not json at all' })).status).toBe(400);
    expect((await post('/webhooks/lumen', { type: 'version.changes_requested' })).status).toBe(400);
    expect((await post('/webhooks/lumen', { id: '../../etc/passwd', type: 'version.changes_requested', data: {} })).status).toBe(400);
    const big = await fetch(base + '/webhooks/lumen', { method: 'POST', body: 'x'.repeat(2 * 1024 * 1024) }).then((r) => r.status).catch(() => 413);
    expect(big).toBe(413);
    expect(queue.list()).toHaveLength(0);
  });

  it('has a health check, and nothing else', async () => {
    expect((await fetch(base + '/health').then((r) => r.json()))).toMatchObject({ ok: true });
    expect((await fetch(base + '/webhooks/lumen')).status).toBe(405);
    expect((await fetch(base + '/')).status).toBe(404);
  });
});

describe('the queue', () => {
  let dir: string;
  beforeAll(() => { dir = mkdtempSync(path.join(tmpdir(), 'runner-queue-')); });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  const mk = (id: string, receivedAt: string, extra = {}) => ({ id, brand: 'lumen', type: 'version.changes_requested', receivedAt, payload: {}, ...extra });
  const ids = [randomUUID(), randomUUID(), randomUUID()];

  it('survives a restart: what was accepted is still there, in order, with its progress', () => {
    const q1 = new Queue(path.join(dir, 's1'));
    q1.add(mk(ids[1]!, '2026-10-05T10:00:02Z'));
    q1.add(mk(ids[0]!, '2026-10-05T10:00:01Z'));
    const first = q1.take(Date.now())!;
    expect(first.id).toBe(ids[0]);
    q1.save({ ...first, stage: 'agent_done', runId: 'run-1', work: { files: ['a.mp4'] } });

    const q2 = new Queue(path.join(dir, 's1')); // a new process
    const items = q2.list();
    expect(items.map((i) => i.id)).toEqual([ids[0], ids[1]]);
    expect(items[0]).toMatchObject({ stage: 'agent_done', runId: 'run-1', work: { files: ['a.mp4'] } });
  });

  it('hands an item to one worker at a time, and not before its time', () => {
    const q = new Queue(path.join(dir, 's2'));
    q.add(mk(ids[0]!, '2026-10-05T10:00:01Z', { notBefore: 5000 }));
    q.add(mk(ids[1]!, '2026-10-05T10:00:02Z'));
    expect(q.take(1000)!.id).toBe(ids[1]); // the first is not due yet
    expect(q.take(1000)).toBeNull(); // the second is taken
    expect(q.take(6000)!.id).toBe(ids[0]);
    q.release(ids[1]!);
    expect(q.take(6000)!.id).toBe(ids[1]);
  });

  it('remembers finished events, and forgets them after a week', () => {
    const q = new Queue(path.join(dir, 's3'));
    q.add(mk(ids[2]!, '2026-10-05T10:00:01Z'));
    q.done(q.take(Date.now())!);
    expect(q.list()).toHaveLength(0);
    expect(q.has(ids[2]!)).toBe(true);
    expect(q.add(mk(ids[2]!, '2026-10-05T10:00:09Z'))).toBe(false);
    q.tidy(Date.now() + 8 * 86_400_000);
    expect(q.has(ids[2]!)).toBe(false);
  });
});
