import { createHmac } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { emit } from '../src/services/events.js';
import { deliver, dueDeliveries } from '../src/services/webhooks.js';
import { createEnv, type Env } from './helpers.js';
import { Receiver } from './receiver.js';

let env: Env;
const rx = new Receiver();
const T0 = new Date('2026-10-02T10:00:00.000Z');

beforeAll(async () => {
  env = await createEnv({}, { fakes: true });
  await rx.start();
});
afterAll(async () => {
  await rx.stop();
  await env.close();
});
beforeEach(async () => {
  rx.reset();
  env.clock.set(T0);
  await env.db.query('delete from webhook where brand_id = $1', [env.brandId]);
  await env.db.query(`delete from notification where kind = 'webhook.failing'`);
});
afterEach(() => {
  env.ctx.config.webhookAllowPrivate = true;
  env.ctx.config.isProd = false;
});

const base = () => `/api/brands/${env.brandId}/webhooks`;
const admin = () => env.users.admin;

async function hook(events: string[] = ['version.approved'], extra: Record<string, unknown> = {}) {
  const r = await env.call(admin(), 'POST', base(), { url: rx.url, events, description: 'test receiver', ...extra });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body as { id: string; secret: string; secret_hint: string };
}

const send = (type: string, data: Record<string, unknown> = { ok: true }) =>
  env.db.tx((db) => emit(env.ctx, db, env.brandId, type as never, data));

/** Does every delivery that is due right now, until nothing more is. */
async function settleHooks() {
  const out: string[] = [];
  for (let i = 0; i < 50; i++) {
    const due = await dueDeliveries(env.ctx);
    if (!due.length) break;
    for (const id of due) out.push(await deliver(env.ctx, id));
  }
  return out;
}
/** What a receiver computes, written out here rather than imported, so the test does not check the code against itself. */
const signBody = (secret: string, ts: number | string, body: string) => createHmac('sha256', secret).update(`${ts}.${body}`).digest('hex');
const delivery = async (webhookId: string) => (await env.db.one('select * from webhook_delivery where webhook_id = $1 order by created_at desc limit 1', [webhookId]))!;

describe('webhook subscriptions', () => {
  it('shows the secret once, and keeps only a sealed copy', async () => {
    const w = await hook(['version.approved', 'publication.failed']);
    expect(w.secret).toMatch(/^whsec_[A-Za-z0-9_-]{40,}$/);
    expect(w.secret_hint).toBe(w.secret.slice(-4));

    const list = await env.call(admin(), 'GET', base());
    expect(list.status).toBe(200);
    expect(JSON.stringify(list.body)).not.toContain(w.secret);
    expect(list.body.items[0]).toMatchObject({ id: w.id, events: ['version.approved', 'publication.failed'], active: true, secret_hint: w.secret_hint });
    expect(list.body.eventTypes.map((e: { type: string }) => e.type)).toContain('version.changes_requested');

    const row = (await env.db.one('select secret_encrypted from webhook where id = $1', [w.id]))!;
    expect(Buffer.from(row.secret_encrypted).includes(Buffer.from(w.secret))).toBe(false);
    const audit = await env.db.query(`select after from audit_event where entity = 'webhook' and entity_id = $1`, [w.id]);
    expect(JSON.stringify(audit)).not.toContain(w.secret);
  });

  it('is for admins only: not approvers, reviewers, readers or producer tokens', async () => {
    const w = await hook();
    const tok = await env.call(admin(), 'POST', `/api/brands/${env.brandId}/tokens`, { name: 'agent' });
    const bearer = { id: 'tok', email: 'agent', bearer: tok.body.token };
    for (const who of [env.users.approver, env.users.reviewer, env.users.reader, env.users.producer, bearer]) {
      expect((await env.call(who, 'GET', base())).status).toBe(403);
      expect((await env.call(who, 'POST', base(), { url: rx.url, events: ['version.approved'] })).status).toBe(403);
      expect((await env.call(who, 'POST', `/api/webhooks/${w.id}/rotate-secret`)).status).toBe(403);
      expect((await env.call(who, 'DELETE', `/api/webhooks/${w.id}`)).status).toBe(403);
    }
    expect((await env.call(null, 'GET', base())).status).toBe(401);
  });

  it('refuses events that do not exist, and an empty list', async () => {
    expect((await env.call(admin(), 'POST', base(), { url: rx.url, events: [] })).status).toBe(400);
    expect((await env.call(admin(), 'POST', base(), { url: rx.url, events: ['version.exploded'] })).status).toBe(400);
  });

  it('refuses addresses it must not send to', async () => {
    const try_ = async (url: string) => env.call(admin(), 'POST', base(), { url, events: ['version.approved'] });
    for (const url of ['ftp://example.com/x', 'not a url', 'https://user:pw@example.com/x', 'http://169.254.169.254/latest/meta-data/', 'http://[fe80::1]/x']) {
      const r = await try_(url);
      expect(r.status, url).toBe(400);
      expect(r.body.error.code).toBe('invalid_url');
    }
    env.ctx.config.webhookAllowPrivate = false;
    for (const url of ['http://127.0.0.1:9/x', 'http://localhost/x', 'http://10.1.2.3/x', 'http://192.168.0.9/x', 'http://[::1]/x', 'http://[::ffff:10.0.0.1]/x']) {
      expect((await try_(url)).status, url).toBe(400);
    }
    // In production a public address has to be https, while a private one (a runner on the LAN) may be plain http.
    env.ctx.config.webhookAllowPrivate = true;
    env.ctx.config.isProd = true;
    expect((await try_('http://93.184.216.34/x')).status).toBe(400);
    expect((await try_('https://93.184.216.34/x')).status).toBe(201);
    expect((await try_('http://10.1.2.3/x')).status).toBe(201);
  });

  it('needs TOKEN_KEY, because the secret has to be kept to sign with', async () => {
    const saved = env.ctx.vault;
    env.ctx.vault = null;
    try {
      const r = await env.call(admin(), 'POST', base(), { url: rx.url, events: ['version.approved'] });
      expect(r.status).toBe(409);
      expect(r.body.error.code).toBe('token_key_missing');
    } finally {
      env.ctx.vault = saved;
    }
  });

  it('can be edited, disabled, have its secret rotated, and be deleted', async () => {
    const w = await hook();
    const edited = await env.call(admin(), 'PATCH', `/api/webhooks/${w.id}`, { events: ['comment.created'], description: 'renamed', active: false });
    expect(edited.body).toMatchObject({ events: ['comment.created'], description: 'renamed', active: false });
    expect((await env.call(admin(), 'PATCH', `/api/webhooks/${w.id}`, { url: 'http://169.254.169.254/' })).status).toBe(400);
    const back = await env.call(admin(), 'PATCH', `/api/webhooks/${w.id}`, { active: true });
    expect(back.body.active).toBe(true);

    const rotated = await env.call(admin(), 'POST', `/api/webhooks/${w.id}/rotate-secret`);
    expect(rotated.body.secret).not.toBe(w.secret);
    expect(rotated.body.secret_hint).toBe(rotated.body.secret.slice(-4));

    await send('comment.created');
    await settleHooks();
    const got = rx.requests[0]!;
    const sig = (got.headers['x-studio-signature'] as string).replace('v1=', '');
    expect(sig).toBe(signBody(rotated.body.secret, got.headers['x-studio-timestamp'] as string, got.body));
    expect(sig).not.toBe(signBody(w.secret, got.headers['x-studio-timestamp'] as string, got.body));

    expect((await env.call(admin(), 'DELETE', `/api/webhooks/${w.id}`)).status).toBe(200);
    expect(await env.db.one('select 1 from webhook_delivery where webhook_id = $1', [w.id])).toBeNull();
    const trail = (await env.db.query(`select action from audit_event where entity = 'webhook' and entity_id = $1 order by id`, [w.id])).map((r) => r.action);
    expect(trail).toEqual(['webhook.created', 'webhook.updated', 'webhook.updated', 'webhook.secret_rotated', 'webhook.deleted']);
  });
});

describe('events', () => {
  it('exist exactly when the change they describe does', async () => {
    await hook();
    const before = (await env.db.one<{ n: number }>('select count(*)::int as n from event'))!.n;
    await expect(
      env.db.tx(async (db) => {
        await emit(env.ctx, db, env.brandId, 'version.approved', { a: 1 });
        throw new Error('the change failed');
      }),
    ).rejects.toThrow('the change failed');
    expect((await env.db.one<{ n: number }>('select count(*)::int as n from event'))!.n).toBe(before);
    expect(await env.db.one('select 1 from webhook_delivery')).toBeNull();
  });

  it('cannot be rewritten', async () => {
    const id = await send('version.approved');
    await expect(env.db.query(`update event set data = '{}' where id = $1`, [id])).rejects.toThrow(/append-only/);
  });

  it('go only to active webhooks that subscribed to them', async () => {
    const yes = await hook(['version.approved']);
    const other = await hook(['comment.created']);
    const off = await hook(['version.approved']);
    await env.call(admin(), 'PATCH', `/api/webhooks/${off.id}`, { active: false });
    await send('version.approved');
    expect(await env.db.one('select 1 from webhook_delivery where webhook_id = $1', [yes.id])).not.toBeNull();
    expect(await env.db.one('select 1 from webhook_delivery where webhook_id = $1', [other.id])).toBeNull();
    expect(await env.db.one('select 1 from webhook_delivery where webhook_id = $1', [off.id])).toBeNull();
  });

  it('turn a stored frame key into a signed URL when they are sent, and never expose the key', async () => {
    const w = await hook(['version.changes_requested']);
    await env.ctx.storage.put(`brands/${env.brandId}/comments/frame.jpg`, Buffer.from([0xff, 0xd8, 0xff, 0xd9]), 'image/jpeg');
    await send('version.changes_requested', {
      comments: [{ id: 'c1', frame_key: `brands/${env.brandId}/comments/frame.jpg` }, { id: 'c2', frame_key: null }],
    });
    await settleHooks();
    const got = rx.requests[0]!.json;
    expect(JSON.stringify(got)).not.toContain('frame_key');
    expect(got.data.comments[0].frame_url).toMatch(/^https?:\/\/.+\/media\//);
    expect(got.data.comments[1].frame_url).toBeNull();
    expect((await delivery(w.id)).status).toBe('delivered');
  });
});

describe('delivery', () => {
  it('sends the event signed, with the headers a receiver needs', async () => {
    const w = await hook();
    const id = await send('version.approved', { piece: { title: 'Spring' } });
    expect(await settleHooks()).toEqual(['delivered']);

    const got = rx.requests[0]!;
    expect(got.method).toBe('POST');
    expect(got.headers['content-type']).toBe('application/json');
    expect(got.headers['x-studio-event']).toBe('version.approved');
    expect(got.headers['x-studio-event-id']).toBe(id);
    expect(got.headers['x-studio-delivery']).toBe((await delivery(w.id)).id);
    expect(got.headers['x-studio-timestamp']).toBe(String(Math.floor(T0.getTime() / 1000)));
    expect(got.headers['x-studio-signature']).toBe(`v1=${signBody(w.secret, got.headers['x-studio-timestamp'] as string, got.body)}`);
    expect(got.json).toMatchObject({
      id, type: 'version.approved', created_at: T0.toISOString(), brand: { id: env.brandId, name: 'Test brand' }, data: { piece: { title: 'Spring' } },
    });
    expect(await settleHooks()).toEqual([]); // delivered once, not again
    const d = await delivery(w.id);
    expect(d).toMatchObject({ status: 'delivered', attempts: 1, last_status: 200 });
    expect((await env.db.one('select last_success_at from webhook where id = $1', [w.id]))!.last_success_at).not.toBeNull();
  });

  it('retries with growing waits, signing again each time, until the receiver answers', async () => {
    const w = await hook();
    rx.responder = (_r, n) => (n <= 3 ? { status: 500, body: 'boom' } : { status: 200 });
    await send('version.approved');

    const waits: number[] = [];
    for (let i = 0; i < 3; i++) {
      expect(await settleHooks()).toEqual(['retry']);
      const d = await delivery(w.id);
      expect(d.attempts).toBe(i + 1);
      expect(d.last_error).toContain('500');
      waits.push((new Date(d.next_attempt_at).getTime() - env.clock.now().getTime()) / 1000);
      env.clock.advance(waits[i]! * 1000 - 1);
      expect(await settleHooks()).toEqual([]); // not due yet
      env.clock.advance(1);
    }
    expect(waits).toEqual([10, 30, 120]); // seconds
    expect(await settleHooks()).toEqual(['delivered']);
    expect(rx.requests).toHaveLength(4);
    const stamps = rx.requests.map((r) => Number(r.headers['x-studio-timestamp']));
    expect(new Set(stamps).size).toBe(4); // each attempt carries its own timestamp
    for (const r of rx.requests) expect(r.headers['x-studio-signature']).toBe(`v1=${signBody(w.secret, r.headers['x-studio-timestamp'] as string, r.body)}`);
    const log = await env.db.query('select http_status from webhook_attempt order by id');
    expect(log.map((l) => l.http_status)).toEqual([500, 500, 500, 200]);
  });

  it('gives up after eleven attempts inside the 24 hours, and warns the admins once a day', async () => {
    const w = await hook();
    rx.responder = () => ({ status: 503 });
    await send('version.approved');
    const waited: number[] = [];
    for (let i = 0; i < 11; i++) {
      await settleHooks();
      const d = await delivery(w.id);
      if (d.status === 'failed') break;
      waited.push((new Date(d.next_attempt_at).getTime() - env.clock.now().getTime()) / 1000);
      env.clock.set(new Date(d.next_attempt_at));
    }
    expect(waited).toEqual([10, 30, 120, 600, 1800, 3600, 7200, 14400, 21600, 28800]); // seconds, then it stops
    const d = await delivery(w.id);
    expect(d.status).toBe('failed');
    expect(d.attempts).toBe(11);
    expect(d.last_error).toContain('gave up after 11 attempts');
    const elapsedHours = (env.clock.now().getTime() - T0.getTime()) / 3_600_000;
    expect(elapsedHours).toBeGreaterThan(20);
    expect(elapsedHours).toBeLessThan(24);
    expect(rx.requests).toHaveLength(11);

    const told = () => env.db.query(`select user_id, payload from notification where kind = 'webhook.failing'`);
    expect((await told()).map((n) => n.user_id)).toEqual([admin().id]);

    // A second event fails the same way within the day: the admins are not told again.
    await send('version.approved');
    for (let i = 0; i < 11; i++) {
      await settleHooks();
      const last = await delivery(w.id);
      if (last.status === 'failed') break;
      env.clock.set(new Date(last.next_attempt_at));
    }
    expect((await told())).toHaveLength(1);
  });

  it('does not keep trying past 24 hours', async () => {
    const w = await hook();
    rx.responder = () => ({ status: 500 });
    await send('version.approved');
    env.clock.set(new Date(T0.getTime() + 25 * 3_600_000)); // the worker was down for a day
    expect(await settleHooks()).toEqual(['failed']);
    const d = await delivery(w.id);
    expect(d.status).toBe('failed');
    expect(d.attempts).toBe(1);
  });

  it('waits at least as long as the receiver asks (Retry-After)', async () => {
    const w = await hook();
    rx.responder = () => ({ status: 429, headers: { 'retry-after': '900' } });
    await send('version.approved');
    await settleHooks();
    const d = await delivery(w.id);
    expect((new Date(d.next_attempt_at).getTime() - T0.getTime()) / 1000).toBe(900);
  });

  it('stops sending to a receiver that says it is gone (410), and says why', async () => {
    const w = await hook();
    rx.responder = () => ({ status: 410 });
    await send('version.approved');
    expect(await settleHooks()).toEqual(['failed']);
    const row = (await env.db.one('select active, disabled_reason from webhook where id = $1', [w.id]))!;
    expect(row).toMatchObject({ active: false, disabled_reason: 'The receiver answered 410 Gone' });
    const d = await delivery(w.id);
    expect(d.status).toBe('failed');

    expect((await env.call(admin(), 'POST', `/api/webhook-deliveries/${d.id}/redeliver`)).body.error.code).toBe('webhook_disabled');
    await env.call(admin(), 'PATCH', `/api/webhooks/${w.id}`, { active: true });
    expect((await env.db.one('select disabled_reason from webhook where id = $1', [w.id]))!.disabled_reason).toBeNull();
    rx.responder = () => ({ status: 200 });
    expect((await env.call(admin(), 'POST', `/api/webhook-deliveries/${d.id}/redeliver`)).status).toBe(200);
    expect(await settleHooks()).toEqual(['delivered']);
  });

  it('does not follow redirects', async () => {
    const w = await hook();
    rx.responder = () => ({ status: 302, headers: { location: 'http://169.254.169.254/' } });
    await send('version.approved');
    await settleHooks();
    const d = await delivery(w.id);
    expect(d.last_error).toContain('redirects are not followed');
    expect(rx.requests).toHaveLength(1);
  });

  it('can be sent again by hand, with a fresh window', async () => {
    const w = await hook();
    await send('version.approved');
    await settleHooks();
    const d = await delivery(w.id);
    expect((await env.call(admin(), 'POST', `/api/webhook-deliveries/${d.id}/redeliver`)).status).toBe(200);
    expect((await env.call(admin(), 'POST', `/api/webhook-deliveries/${d.id}/redeliver`)).body.error.code).toBe('already_pending');
    expect(await settleHooks()).toEqual(['delivered']);
    expect(rx.requests).toHaveLength(2);
    expect(rx.requests[0]!.headers['x-studio-event-id']).toBe(rx.requests[1]!.headers['x-studio-event-id']); // same event id: receivers can drop the repeat
    const detail = await env.call(admin(), 'GET', `/api/webhook-deliveries/${d.id}`);
    expect(detail.body.attempts).toHaveLength(2);
  });

  it('has a test button that pings that webhook only', async () => {
    const a = await hook(['version.approved']);
    const b = await hook(['version.approved']);
    const r = await env.call(admin(), 'POST', `/api/webhooks/${a.id}/test`);
    expect(r.status).toBe(200);
    expect(await settleHooks()).toEqual(['delivered']);
    expect(rx.requests).toHaveLength(1);
    expect(rx.requests[0]!.json.type).toBe('ping');
    expect(await env.db.one('select 1 from webhook_delivery where webhook_id = $1', [b.id])).toBeNull();

    await env.call(admin(), 'PATCH', `/api/webhooks/${a.id}`, { active: false });
    expect((await env.call(admin(), 'POST', `/api/webhooks/${a.id}/test`)).body.error.code).toBe('webhook_disabled');
    const list = await env.call(admin(), 'GET', `/api/webhooks/${a.id}/deliveries`);
    expect(list.body[0]).toMatchObject({ type: 'ping', status: 'delivered' });
  });

  it('only one process sends a delivery at a time', async () => {
    const w = await hook();
    rx.responder = () => 'hang';
    await send('version.approved');
    const id = (await delivery(w.id)).id;
    // While the first attempt is in flight (leased), a second worker finds nothing to do.
    const first = deliver(env.ctx, id);
    await new Promise((r) => setTimeout(r, 200));
    expect(await deliver(env.ctx, id)).toBe('skipped');
    await rx.stop();
    await first.catch(() => {});
    await rx.start();
  });
});

describe('the address policy, where the request is made', () => {
  it('refuses a private address at delivery time even if it was allowed when the webhook was made', async () => {
    const w = await hook();
    await send('version.approved');
    env.ctx.config.webhookAllowPrivate = false;
    expect(await settleHooks()).toEqual(['failed']);
    expect(rx.requests).toHaveLength(0);
    expect((await delivery(w.id)).last_error).toContain('private network');
  });

  it('refuses a name that resolves to a private address', async () => {
    const w = await hook();
    const port = new URL(rx.url).port;
    await env.db.query('update webhook set url = $2 where id = $1', [w.id, `http://localhost:${port}/hook`]);
    await send('version.approved');
    env.ctx.config.webhookAllowPrivate = false;
    expect(await settleHooks()).toEqual(['failed']);
    expect(rx.requests).toHaveLength(0);
    expect((await delivery(w.id)).last_error).toMatch(/localhost resolves to .*private network/);
  });

  it('never reaches the cloud metadata address, whatever the setting', async () => {
    const w = await hook();
    await env.db.query(`update webhook set url = 'http://169.254.169.254/latest/meta-data/' where id = $1`, [w.id]);
    await send('version.approved');
    expect(await settleHooks()).toEqual(['failed']);
    const d = await delivery(w.id);
    expect(d.last_error).toContain('not an address webhooks may be sent to');
    expect(d.attempts).toBe(1); // not retried: it will not become a different address
  });
});
