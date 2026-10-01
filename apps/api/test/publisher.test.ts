import { randomBytes } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { accountToken } from '../src/services/connectors.js';
import { advance } from '../src/services/publisher.js';
import { createEnv, type Env } from './helpers.js';

let env: Env;
let ig: string, fb: string, yt: string;
beforeAll(async () => {
  env = await createEnv({}, { fakes: true });
  ig = await env.connect('instagram');
  fb = await env.connect('facebook');
  yt = await env.connect('youtube');
});
afterAll(async () => { await env.close(); });
afterEach(() => {
  env.meta.failures.length = 0;
  env.google.failures.length = 0;
});
beforeEach(() => {
  env.meta.calls.length = 0;
  env.google.calls.length = 0;
  env.meta.igQuota = { usage: 0, total: 50 };
  env.meta.processingPolls = 1;
  env.google.audited = false;
});

const MIN = 60_000;
const at = (ms: number) => new Date(env.clock.now().getTime() + ms);
const row = async (id: string) => (await env.db.one('select * from publication where id = $1', [id]))!;
const steps = async (id: string) => (await env.db.query('select step, outcome, error_class from publication_attempt where publication_id = $1 order by id', [id])).map((r) => `${r.step}:${r.outcome}${r.error_class ? `:${r.error_class}` : ''}`);

interface Opts {
  account: string;
  kind?: string;
  format?: string;
  files?: { name: string; mime: string; kind: string }[];
  leadMs?: number;
  text?: string;
  firstComment?: string;
  body?: Record<string, unknown>;
}

/** Makes a piece, uploads and approves it, and schedules it on an account. Returns the publication. */
async function scheduled(o: Opts) {
  const { users, call, makePiece, newVersion, approve } = env;
  const { variantId, pieceId } = await makePiece(users.producer, o.kind ?? 'video', o.format ?? '9:16');
  const v = await newVersion(users.producer, variantId, o.files ?? [{ name: 'reel.mp4', mime: 'video/mp4', kind: 'video' }]);
  expect(v.status, JSON.stringify(v.body)).toBe(201);
  const ok = await approve(users.approver, v.body.id, [o.account]);
  expect(ok.body.review_state).toBe('approved');
  const r = await call(users.approver, 'POST', `/api/versions/${v.body.id}/publications`, {
    accountId: o.account, scheduledAt: at(o.leadMs ?? 2 * 60 * MIN).toISOString(), text: o.text ?? 'Our spring menu #coffee', firstComment: o.firstComment ?? '', ...(o.body ?? {}),
  });
  return { res: r, pub: r.body, versionId: v.body.id as string, variantId, pieceId };
}

const IMAGE = [{ name: 'photo.png', mime: 'image/png', kind: 'image' }];

describe('Instagram, from scheduling to a verified post', () => {
  it('prepares ahead of the hour, publishes on it and confirms the post is live', async () => {
    const { pub, res } = await scheduled({ account: ig, firstComment: 'Link in bio' });
    expect(res.status).toBe(201);
    expect(pub).toMatchObject({ manual: false, status: 'scheduled', placement: 'reel' });
    const when = new Date(pub.scheduled_at);
    expect(new Date(pub.prepare_at).getTime()).toBe(when.getTime() - 30 * MIN); // the brand's lead time

    expect(await env.settle()).toEqual([]); // nothing to do until it is time to prepare

    env.clock.set(new Date(pub.prepare_at));
    expect((await env.settle()).map((x) => x.split(':')[1])).toEqual(['preparing']); // the container is still processing
    expect((await row(pub.id)).status).toBe('preparing');
    expect(await env.settle()).toEqual([]); // and nothing happens until it is time to ask again

    env.clock.advance(11_000);
    expect((await env.settle()).map((x) => x.split(':')[1])).toEqual(['ready']);
    expect(await env.settle()).toEqual([]); // ready, waiting for the hour: not published early
    expect(env.meta.callsTo(/media_publish/)).toHaveLength(0);

    env.clock.set(when);
    expect((await env.settle()).map((x) => x.split(':')[1])).toEqual(['published', 'public']);
    const done = await row(pub.id);
    expect(done).toMatchObject({ status: 'published', visibility: 'public', next_run_at: null, attempts: 0 });
    expect(done.external_id).toMatch(/^m-/);
    expect(done.url).toContain('instagram.com');
    expect(env.meta.media.get(done.external_id)!.params).toMatchObject({ media_type: 'REELS', caption: 'Our spring menu #coffee' });
    expect(env.meta.media.get(done.external_id)!.comments).toEqual(['Link in bio']);

    expect(await steps(pub.id)).toEqual(['prepare:pending', 'prepare:ok', 'publish:ok', 'verify:ok']);
    // Every attempt is in the audit log too.
    const audit = await env.db.query(`select after from audit_event where entity_id = $1 and action = 'publication.attempt'`, [pub.id]);
    expect(audit.map((a) => a.after.step)).toEqual(['prepare', 'prepare', 'publish', 'verify']);
    // The approvers are told once it is live.
    const told = await env.db.query(`select user_id from notification where kind = 'publication.published' and payload->>'publicationId' = $1`, [pub.id]);
    expect(told.map((t) => t.user_id).sort()).toEqual([env.users.admin.id, env.users.approver.id, env.users.approver2.id].sort());
  });

  it('converts files to what the network accepts before sending, once', async () => {
    const { pub } = await scheduled({ account: ig, kind: 'post', format: '4:5', files: IMAGE });
    expect(pub.placement).toBe('feed_image');
    env.clock.set(new Date(pub.prepare_at));
    await env.settle();
    const sent = env.meta.callsTo(/^222\/media$/, 'POST')[0]!.body.image_url;
    expect(sent).toContain('/renditions/'); // not the PNG that was uploaded
    expect(sent).toContain('ig-feed-image.jpg');
    const renditions = await env.db.query('select profile, mime from rendition');
    expect(renditions.map((r) => r.profile)).toContain('ig-feed-image');
  });

  it('refuses to publish twice when two workers pick it up at once', async () => {
    const { pub } = await scheduled({ account: ig, kind: 'post', format: '4:5', files: IMAGE, leadMs: 40 * MIN });
    env.meta.processingPolls = 0;
    env.clock.set(new Date(pub.prepare_at));
    await env.settle();
    expect((await row(pub.id)).status).toBe('ready');
    env.clock.set(new Date(pub.scheduled_at));
    const results = await Promise.all([advance(env.ctx, pub.id), advance(env.ctx, pub.id), advance(env.ctx, pub.id)]);
    expect(results.filter((r) => r === 'published')).toHaveLength(1);
    expect(env.meta.callsTo(/media_publish/)).toHaveLength(1);
  });

  it('does not publish late by itself: past the tolerance it fails and says so', async () => {
    const { pub } = await scheduled({ account: ig, kind: 'post', format: '4:5', files: IMAGE });
    // The worker was down: it comes back 20 minutes after the hour (the brand tolerates 15).
    env.clock.set(new Date(new Date(pub.scheduled_at).getTime() + 20 * MIN));
    await env.settle();
    const r = await row(pub.id);
    expect(r).toMatchObject({ status: 'failed', last_error_class: 'missed_window' });
    expect(env.meta.callsTo(/media_publish|^222\/media$/)).toHaveLength(0);
    const told = await env.db.query(`select 1 from notification where kind = 'publication.failed' and payload->>'publicationId' = $1`, [pub.id]);
    expect(told.length).toBeGreaterThan(0);
  });

  it('publishes a little late when the delay is within the tolerance', async () => {
    const { pub } = await scheduled({ account: ig, kind: 'post', format: '4:5', files: IMAGE });
    env.meta.processingPolls = 0;
    env.clock.set(new Date(new Date(pub.scheduled_at).getTime() + 5 * MIN));
    await env.settle();
    expect((await row(pub.id)).status).toBe('published');
  });
});

describe('what happens when a step fails', () => {
  it('retries a transient failure with growing waits and gives up after the fifth, telling the team', async () => {
    const { pub } = await scheduled({ account: ig, kind: 'post', format: '4:5', files: IMAGE, leadMs: 5 * 60 * MIN });
    env.meta.processingPolls = 0;
    env.meta.fail((c) => /^222\/media$/.test(c.path), { error: { message: 'Service unavailable', code: 2 } }, 503, 99);
    env.clock.set(new Date(pub.prepare_at));
    const waits: number[] = [];
    for (let i = 0; i < 5; i++) {
      await env.settle();
      const r = await row(pub.id);
      if (r.status === 'failed') break;
      waits.push((new Date(r.next_run_at).getTime() - env.clock.now().getTime()) / 1000);
      env.clock.set(new Date(r.next_run_at));
    }
    expect(waits).toEqual([60, 120, 300, 600]); // the fifth failure is the last
    const r = await row(pub.id);
    expect(r).toMatchObject({ status: 'failed', last_error_class: 'transient', attempts: 5 });
    expect(r.last_error).toMatch(/failed 5 times/);
    expect(await steps(pub.id)).toEqual(Array(5).fill('prepare:error:transient'));
    const told = await env.db.query(`select 1 from notification where kind = 'publication.failed' and payload->>'publicationId' = $1`, [pub.id]);
    expect(told.length).toBeGreaterThan(0);
  });

  it('recovers when the network comes back before the retries run out', async () => {
    const { pub } = await scheduled({ account: ig, kind: 'post', format: '4:5', files: IMAGE });
    env.meta.processingPolls = 0;
    env.meta.fail((c) => /^222\/media$/.test(c.path), { error: { message: 'Service unavailable' } }, 503, 2);
    env.clock.set(new Date(pub.prepare_at));
    await env.settle();
    env.clock.advance(61_000);
    await env.settle();
    env.clock.advance(121_000);
    await env.settle();
    const r = await row(pub.id);
    expect(r.status).toBe('ready');
    expect(r.attempts).toBe(0); // a success clears the count
    expect(await steps(pub.id)).toEqual(['prepare:error:transient', 'prepare:error:transient', 'prepare:ok']);
  });

  it('waits out a rate limit without counting it as a failure, and gives up if it would clear after the hour', async () => {
    const { pub } = await scheduled({ account: ig, kind: 'post', format: '4:5', files: IMAGE });
    env.meta.processingPolls = 0;
    env.meta.fail((c) => /content_publishing_limit/.test(c.path), env.meta.err(4, 'Application request limit reached'), 400, 1, { 'x-business-use-case-usage': JSON.stringify({ '222': [{ estimated_time_to_regain_access: 10 }] }) });
    env.clock.set(new Date(pub.prepare_at));
    await env.settle();
    let r = await row(pub.id);
    expect(r.status).toBe('preparing');
    expect(r.attempts).toBe(0);
    expect(new Date(r.next_run_at).getTime() - env.clock.now().getTime()).toBe(10 * MIN);

    env.clock.set(new Date(r.next_run_at));
    env.meta.fail((c) => /content_publishing_limit/.test(c.path), env.meta.err(4, 'Application request limit reached'), 400, 1, { 'x-business-use-case-usage': JSON.stringify({ '222': [{ estimated_time_to_regain_access: 600 }] }) });
    await env.settle();
    r = await row(pub.id);
    expect(r).toMatchObject({ status: 'failed', last_error_class: 'rate_limit' });
  });

  it('fails at once on content the network refuses, keeping the reason and no secrets', async () => {
    const { pub } = await scheduled({ account: ig, kind: 'post', format: '4:5', files: IMAGE });
    env.meta.fail((c) => /^222\/media$/.test(c.path), env.meta.err(100, 'Invalid parameter', { error_subcode: 2207005, error_user_msg: 'The image format is not supported' }), 400);
    env.clock.set(new Date(pub.prepare_at));
    await env.settle();
    const r = await row(pub.id);
    expect(r).toMatchObject({ status: 'failed', last_error_class: 'file_rejected', last_error: 'The image format is not supported', attempts: 0 });
    expect(await steps(pub.id)).toEqual(['prepare:error:file_rejected']);
    const attempt = (await env.db.query('select detail from publication_attempt where publication_id = $1', [pub.id]))[0]!;
    expect(JSON.stringify(attempt.detail)).toContain('2207005');
    expect(JSON.stringify(attempt.detail)).not.toContain('page-token');
  });

  it('can be retried by an approver once the problem is fixed, keeping its hour if that is still ahead', async () => {
    const { pub } = await scheduled({ account: ig, kind: 'post', format: '4:5', files: IMAGE });
    env.meta.processingPolls = 0;
    env.meta.fail((c) => /^222\/media$/.test(c.path), env.meta.err(100, 'Invalid parameter'), 400);
    env.clock.set(new Date(pub.prepare_at));
    await env.settle();
    expect((await row(pub.id)).status).toBe('failed');

    expect((await env.call(env.users.reviewer, 'POST', `/api/publications/${pub.id}/retry`, {})).status).toBe(403);
    const retried = await env.call(env.users.approver, 'POST', `/api/publications/${pub.id}/retry`, {});
    expect(retried.status).toBe(200);
    expect(retried.body).toMatchObject({ status: 'scheduled', attempts: 0, last_error: null });
    expect(new Date(retried.body.scheduled_at).toISOString()).toBe(new Date(pub.scheduled_at).toISOString());
    await env.settle();
    expect((await row(pub.id)).status).toBe('ready');
    env.clock.set(new Date(pub.scheduled_at));
    await env.settle();
    expect((await row(pub.id)).status).toBe('published');
  });

  it('moves a retried publication a couple of minutes ahead when its hour has passed, instead of publishing late behind the team\'s back', async () => {
    const { pub } = await scheduled({ account: ig, kind: 'post', format: '4:5', files: IMAGE });
    env.meta.processingPolls = 0;
    env.clock.set(new Date(new Date(pub.scheduled_at).getTime() + 20 * MIN));
    await env.settle();
    expect(await row(pub.id)).toMatchObject({ status: 'failed', last_error_class: 'missed_window' });
    const retried = await env.call(env.users.approver, 'POST', `/api/publications/${pub.id}/retry`, {});
    expect(new Date(retried.body.scheduled_at).getTime() - env.clock.now().getTime()).toBe(2 * MIN);
    env.clock.advance(2 * MIN);
    await env.settle();
    expect((await row(pub.id)).status).toBe('published');
  });

  it('hands a publication to a person when the network cannot do it at run time', async () => {
    const { pub } = await scheduled({ account: ig, kind: 'post', format: '4:5', files: IMAGE });
    // The connector for this network is gone from this server (credentials removed): the post becomes manual.
    const saved = env.ctx.connectors;
    env.ctx.connectors = { ...saved, connector: () => null } as typeof saved;
    try {
      env.clock.set(new Date(pub.prepare_at));
      await env.settle();
    } finally {
      env.ctx.connectors = saved;
    }
    const r = await row(pub.id);
    expect(r).toMatchObject({ manual: true, status: 'scheduled', last_error_class: 'unsupported' });
    expect(r.next_run_at).toBeNull();
    expect(await env.settle()).toEqual([]);
  });
});

describe('accounts that need reconnecting', () => {
  it('marks the account, tells its admin once, and keeps the post waiting until it is reconnected', async () => {
    const igBad = await env.connect('instagram', { externalId: '333', name: '@other', token: 'revoked-token' });
    const { pub } = await scheduled({ account: igBad, kind: 'post', format: '4:5', files: IMAGE });
    env.meta.processingPolls = 0;
    env.clock.set(new Date(pub.prepare_at));
    await env.settle();
    const acc = (await env.db.one('select status, last_error from social_account where id = $1', [igBad]))!;
    expect(acc.status).toBe('reconnect_required');
    let r = await row(pub.id);
    expect(r.status).toBe('preparing'); // waiting, not failed
    expect(r.attempts).toBe(0);
    expect(new Date(r.next_run_at).getTime() - env.clock.now().getTime()).toBe(10 * MIN);
    let told = await env.db.query(`select user_id from notification where kind = 'account.reconnect' and payload->>'accountId' = $1`, [igBad]);
    expect(told.map((t) => t.user_id)).toEqual([env.users.admin.id]);

    // Ten minutes later: still not reconnected, still waiting, and the admin is not told a second time.
    env.clock.set(new Date(r.next_run_at));
    await env.settle();
    told = await env.db.query(`select user_id from notification where kind = 'account.reconnect' and payload->>'accountId' = $1`, [igBad]);
    expect(told).toHaveLength(1);
    expect((await row(pub.id)).status).toBe('preparing');

    // The admin reconnects it (here: a good token and the active status), and the post carries on.
    const id = igBad;
    await env.db.query(`update social_account set status = 'active', token_encrypted = $2 where id = $1`, [id, env.ctx.vault!.seal({ accessToken: 'page-token-111' }, `account:${id}`)]);
    env.clock.advance(10 * MIN);
    await env.settle();
    expect((await row(pub.id)).status).toBe('ready');
  });

  it('carries on at once when the account is reconnected through the app, without waiting out the retry timer', async () => {
    const id = await env.connect('instagram', { externalId: '340', name: '@wait', token: 'revoked-token' });
    const { pub } = await scheduled({ account: id, kind: 'post', format: '4:5', files: IMAGE });
    env.meta.processingPolls = 0;
    env.clock.set(new Date(pub.prepare_at));
    await env.settle();
    expect((await row(pub.id)).status).toBe('preparing');
    expect(new Date((await row(pub.id)).next_run_at).getTime() - env.clock.now().getTime()).toBe(10 * MIN);

    const saved = env.meta.pages;
    env.meta.pages = [{ id: '555', name: 'Other', token: 'page-token-111', ig: { id: '340', username: 'wait' } }];
    try {
      const start = await env.call(env.users.admin, 'POST', `/api/brands/${env.brandId}/connections/meta`, { reconnectAccountId: id });
      const state = new URL(start.body.url).searchParams.get('state')!;
      const back = await env.app.inject({ method: 'GET', url: `/api/oauth/callback?code=good&state=${state}`, headers: { cookie: env.users.admin.cookie! } });
      const pending = new URL(back.headers.location as string, 'http://app.test').searchParams.get('connection')!;
      const done = await env.call(env.users.admin, 'POST', `/api/brands/${env.brandId}/connections/${pending}/select`, { keys: ['instagram:340'] });
      expect(done.status, JSON.stringify(done.body)).toBe(200);
    } finally {
      env.meta.pages = saved;
    }
    // No time has passed: the worker is told to look at it right now.
    expect(new Date((await row(pub.id)).next_run_at).getTime()).toBeLessThanOrEqual(env.clock.now().getTime());
    await env.settle();
    expect((await row(pub.id)).status).toBe('ready');
  });

  it('gives up if the account is still not reconnected when the hour and its tolerance have passed', async () => {
    const igBad = await env.connect('instagram', { externalId: '334', name: '@other2', token: 'revoked-token' });
    const { pub } = await scheduled({ account: igBad, kind: 'post', format: '4:5', files: IMAGE });
    env.clock.set(new Date(pub.prepare_at));
    await env.settle();
    env.clock.set(new Date(new Date(pub.scheduled_at).getTime() + 16 * MIN));
    await env.settle();
    expect(await row(pub.id)).toMatchObject({ status: 'failed', last_error_class: 'missed_window' });
  });

  it('plans a publication on an account that needs reconnecting as manual, with the reason', async () => {
    const igBad = await env.connect('instagram', { externalId: '335', name: '@other3' });
    const { users, call, makePiece, newVersion, approve } = env;
    const { variantId } = await makePiece(users.producer, 'post', '4:5');
    const v = await newVersion(users.producer, variantId, IMAGE);
    await approve(users.approver, v.body.id, [igBad]);
    // The connection breaks after approval, before scheduling.
    await env.db.query(`update social_account set status = 'reconnect_required' where id = $1`, [igBad]);
    const res = await call(users.approver, 'POST', `/api/versions/${v.body.id}/publications`, { accountId: igBad, scheduledAt: at(3 * 60 * MIN).toISOString(), text: 'hi' });
    expect(res.status).toBe(201);
    expect(res.body.manual).toBe(true);
    expect(res.body.manual_reason).toMatch(/reconnected/);
    // And it cannot be approved for in the first place while it needs reconnecting.
    const v2 = await newVersion(users.producer, variantId, [{ name: 'photo3.png', mime: 'image/png', kind: 'image' }]);
    const refused = await approve(users.approver, v2.body.id, [igBad]);
    expect(refused.body.error.code).toBe('invalid_accounts');
  });
});

describe('the approval is checked again before anything is sent', () => {
  // The approval is voided directly in the database, as if it had lapsed by some route this code does not know about.
  const lapse = (versionId: string) => env.db.query(`update version set review_state = 'superseded' where id = $1`, [versionId]);

  it('holds a post whose approval lapsed before preparation, without contacting the network', async () => {
    const { pub, versionId, pieceId } = await scheduled({ account: ig, kind: 'post', format: '4:5', files: IMAGE });
    await lapse(versionId);
    env.clock.set(new Date(pub.prepare_at));
    await env.settle();
    expect(await row(pub.id)).toMatchObject({ status: 'on_hold', hold_reason: 'The approval behind this publication no longer counts' });
    expect(env.meta.callsTo(/\/media$/, 'POST')).toHaveLength(0);
    const told = await env.db.query(`select 1 from notification where kind = 'publication.on_hold' and payload->>'pieceId' = $1`, [pieceId]);
    expect(told.length).toBeGreaterThan(0);
    const audited = await env.db.query(`select 1 from audit_event where action = 'publication.on_hold' and entity_id = $1`, [pub.id]);
    expect(audited).toHaveLength(1);
    expect(await env.settle()).toEqual([]); // and it stays held
  });

  it('holds a post whose approval lapsed after preparation, instead of publishing it at the hour', async () => {
    env.meta.processingPolls = 0;
    const { pub, versionId } = await scheduled({ account: ig, kind: 'post', format: '4:5', files: IMAGE });
    env.clock.set(new Date(pub.prepare_at));
    await env.settle();
    expect((await row(pub.id)).status).toBe('ready');
    await lapse(versionId);
    env.clock.set(new Date(pub.scheduled_at));
    await env.settle();
    expect((await row(pub.id)).status).toBe('on_hold');
    expect(env.meta.callsTo(/media_publish$/, 'POST')).toHaveLength(0);
  });
});

describe('Facebook: the network holds the post', () => {
  it('schedules natively at preparation, so it goes out even if the app is down at the hour', async () => {
    const { pub } = await scheduled({ account: fb, kind: 'post', format: '4:5', files: IMAGE, text: 'Hello from the Page', firstComment: 'Menu in the comments' });
    expect(pub.placement).toBe('photo');
    env.clock.set(new Date(pub.prepare_at));
    await env.settle();
    let r = await row(pub.id);
    expect(r).toMatchObject({ status: 'ready', native_scheduled: true });
    const created = env.meta.callsTo(/^111\/photos$/, 'POST')[0]!;
    expect(created.body).toMatchObject({ published: 'false', caption: 'Hello from the Page', scheduled_publish_time: String(Math.floor(new Date(pub.scheduled_at).getTime() / 1000)) });

    // The app is down through the hour. The network publishes by itself.
    env.clock.set(new Date(new Date(pub.scheduled_at).getTime() + 8 * MIN));
    await env.settle();
    r = await row(pub.id);
    expect(r).toMatchObject({ status: 'published', visibility: 'public' });
    expect(r.url).toMatch(/^https:\/\/www\.facebook\.com\//);
    expect(env.meta.callsTo(/^111\/photos$/, 'POST')).toHaveLength(1); // nothing was created a second time
    expect(env.meta.posts.get(r.external_id)!.comments).toEqual(['Menu in the comments']);
  });

  it('takes the held post down from the network when the publication is cancelled', async () => {
    const { pub } = await scheduled({ account: fb, kind: 'post', format: '4:5', files: IMAGE });
    env.clock.set(new Date(pub.prepare_at));
    await env.settle();
    const held = (await row(pub.id)).handle.objectId;
    expect(env.meta.posts.has(held)).toBe(true);

    const cancelled = await env.call(env.users.approver, 'POST', `/api/publications/${pub.id}/cancel`);
    expect(cancelled.body.status).toBe('cancelled');
    expect((await row(pub.id)).native_scheduled).toBe(true); // still to be cleaned up
    await env.settle();
    expect(env.meta.posts.has(held)).toBe(false); // gone from the network
    expect(await row(pub.id)).toMatchObject({ native_scheduled: false, next_run_at: null, handle: {} });
    expect(await steps(pub.id)).toContain('discard:ok');

    // Even at the hour nothing goes out.
    env.clock.set(new Date(new Date(pub.scheduled_at).getTime() + 5 * MIN));
    expect(await env.settle()).toEqual([]);
  });

  it('takes the held post down when a new version replaces what was approved, and can be rescheduled after', async () => {
    const { users, call, newVersion, approve } = env;
    const s = await scheduled({ account: fb, kind: 'post', format: '4:5', files: IMAGE });
    env.clock.set(new Date(s.pub.prepare_at));
    await env.settle();
    const held = (await row(s.pub.id)).handle.objectId;
    expect(env.meta.posts.has(held)).toBe(true);

    const v2 = await newVersion(users.producer, s.variantId, [{ name: 'photo2.png', mime: 'image/png', kind: 'image' }]);
    expect((await row(s.pub.id)).status).toBe('on_hold');
    await env.settle();
    expect(env.meta.posts.has(held)).toBe(false);

    // Until the old post is gone it cannot be rescheduled; once it is, the new approved version carries it on.
    await approve(users.approver, v2.body.id, [fb]);
    const back = await call(users.approver, 'POST', `/api/publications/${s.pub.id}/reschedule`, { versionId: v2.body.id, scheduledAt: at(3 * 60 * MIN).toISOString() });
    expect(back.status).toBe(200);
    expect(back.body).toMatchObject({ status: 'scheduled', version_id: v2.body.id });
    env.clock.advance(2.6 * 60 * MIN);
    await env.settle();
    expect((await row(s.pub.id)).status).toBe('ready');
    const fresh = (await row(s.pub.id)).handle.objectId;
    expect(fresh).not.toBe(held);
    expect(env.meta.posts.has(fresh)).toBe(true); // a new post for the new version
    expect(env.meta.posts.has(held)).toBe(false); // and the old one is still gone
  });

  it('posts at once when the app only gets to it with too little time to hold it natively', async () => {
    const { pub } = await scheduled({ account: fb, kind: 'post', format: '4:5', files: IMAGE, leadMs: 20 * MIN });
    // Preparation was meant to start 10 minutes ago; the worker only comes back now, 5 minutes before the hour.
    env.clock.set(new Date(new Date(pub.scheduled_at).getTime() - 5 * MIN));
    await env.settle();
    let r = await row(pub.id);
    expect(r).toMatchObject({ status: 'ready', native_scheduled: false });
    env.clock.set(new Date(pub.scheduled_at));
    await env.settle();
    r = await row(pub.id);
    expect(r).toMatchObject({ status: 'published', visibility: 'public' });
    expect(env.meta.callsTo(/\/photos$/, 'POST')[0]!.body.published).toBe('true');
  });

  it('cannot move an automatic post once preparation has started', async () => {
    const { pub } = await scheduled({ account: fb, kind: 'post', format: '4:5', files: IMAGE });
    // Before preparation it can be moved, and its preparation moves with it.
    const later = at(4 * 60 * MIN);
    const moved = await env.call(env.users.approver, 'PATCH', `/api/publications/${pub.id}`, { scheduledAt: later.toISOString() });
    expect(moved.status).toBe(200);
    expect(new Date(moved.body.prepare_at).getTime()).toBe(later.getTime() - 30 * MIN);
    expect(new Date(moved.body.next_run_at).getTime()).toBe(later.getTime() - 30 * MIN);
    env.clock.set(new Date(moved.body.prepare_at));
    await env.settle();
    const refused = await env.call(env.users.approver, 'PATCH', `/api/publications/${pub.id}`, { text: 'Edited' });
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe('already_prepared');
  });
});

describe('YouTube: private until the audit passes', () => {
  const yFile = [{ name: 'clip.mp4', mime: 'video/mp4', kind: 'video' }];

  it('uploads at preparation with a publish time, and reports the video as private when the audit has not passed', async () => {
    const s = await scheduled({ account: yt, kind: 'video', format: '16:9', files: yFile, text: 'A longer look at the spring menu' });
    expect(s.pub.placement).toBe('video');
    expect(s.res.body.issues.map((i: any) => i.code)).toContain('youtube.unaudited'); // warned when scheduling
    env.clock.set(new Date(s.pub.prepare_at));
    await env.settle();
    let r = await row(s.pub.id);
    expect(r).toMatchObject({ status: 'ready', native_scheduled: true });
    const video = env.google.videos.get(r.handle.videoId)!;
    expect(video.status).toMatchObject({ privacyStatus: 'private', publishAt: new Date(s.pub.scheduled_at).toISOString() });

    env.clock.set(new Date(new Date(s.pub.scheduled_at).getTime() + 2 * MIN));
    await env.settle();
    r = await row(s.pub.id);
    expect(r).toMatchObject({ status: 'published', visibility: 'private' }); // not a failure: a state
    const told = await env.db.query(`select 1 from notification where kind = 'publication.private' and payload->>'publicationId' = $1`, [s.pub.id]);
    expect(told.length).toBeGreaterThan(0);
    expect(r.next_run_at).toBeNull();

    // Once Google has audited the project, asking for a re-check finds it public.
    env.google.audited = true;
    expect((await env.call(env.users.reviewer, 'POST', `/api/publications/${s.pub.id}/recheck`)).status).toBe(403);
    expect((await env.call(env.users.approver, 'POST', `/api/publications/${s.pub.id}/recheck`)).status).toBe(200);
    await env.settle();
    expect(await row(s.pub.id)).toMatchObject({ visibility: 'public' });
  });

  it('goes public on time when the project is audited', async () => {
    env.google.audited = true;
    const s = await scheduled({ account: yt, kind: 'video', format: '16:9', files: yFile });
    env.clock.set(new Date(s.pub.prepare_at));
    await env.settle();
    env.clock.set(new Date(new Date(s.pub.scheduled_at).getTime() + 60_000));
    await env.settle();
    expect(await row(s.pub.id)).toMatchObject({ status: 'published', visibility: 'public' });
  });

  it('refreshes an expired access token before uploading, once, and stores the new one', async () => {
    const ytExpiring = await env.connect('youtube', { externalId: 'UC-exp', name: 'Second channel', expiresAt: at(30_000).toISOString() });
    const before = env.google.calls.filter((c) => c.path === '/token').length;
    const t = await accountToken(env.ctx, ytExpiring);
    expect(t.accessToken).toMatch(/^access-/);
    expect(env.google.calls.filter((c) => c.path === '/token')).toHaveLength(before + 1);
    const again = await accountToken(env.ctx, ytExpiring);
    expect(again.accessToken).toBe(t.accessToken); // the fresh one was kept
    expect(env.google.calls.filter((c) => c.path === '/token')).toHaveLength(before + 1);
    const stored = (await env.db.one('select token_expires_at from social_account where id = $1', [ytExpiring]))!;
    expect(new Date(stored.token_expires_at).getTime()).toBeGreaterThan(env.clock.now().getTime() + 30 * MIN);
  });

  it('marks the account for reconnection when Google revokes the grant during a refresh', async () => {
    const ytRevoked = await env.connect('youtube', { externalId: 'UC-rev', name: 'Third channel', expiresAt: at(10_000).toISOString(), refreshToken: 'revoked-refresh' });
    await expect(accountToken(env.ctx, ytRevoked)).rejects.toThrow(/no longer accepts/);
    expect((await env.db.one('select status from social_account where id = $1', [ytRevoked]))!.status).toBe('reconnect_required');
    const told = await env.db.query(`select 1 from notification where kind = 'account.reconnect' and payload->>'accountId' = $1`, [ytRevoked]);
    expect(told).toHaveLength(1);
  });
});

describe('scheduling decisions', () => {
  it('keeps manual accounts manual, as in phase 1, and honours a request for manual', async () => {
    const m = await scheduled({ account: env.accounts.instagram, kind: 'post', format: '4:5', files: IMAGE });
    expect(m.pub).toMatchObject({ manual: true, next_run_at: null, prepare_at: null });
    expect(m.pub.manual_reason).toMatch(/not connected/);
    const forced = await scheduled({ account: ig, kind: 'post', format: '4:5', files: IMAGE, body: { mode: 'manual' } });
    expect(forced.pub.manual).toBe(true);
    expect(forced.pub.manual_reason).toMatch(/by hand/);
    // Manual ones are not touched by the worker and show up in the due list when their hour comes.
    env.clock.set(new Date(forced.pub.scheduled_at));
    expect(await env.settle()).toEqual([]);
  });

  it('turns content a network cannot publish into a manual publication, with the reason; insisting on automatic is refused', async () => {
    const story = await scheduled({ account: fb, kind: 'story', format: '9:16', files: IMAGE });
    expect(story.pub.manual).toBe(true);
    expect(story.pub.manual_reason).toMatch(/cannot publish this kind of content/);
    const refused = await scheduled({ account: fb, kind: 'story', format: '9:16', files: IMAGE, body: { mode: 'auto' } });
    expect(refused.res.status).toBe(409);
    expect(refused.res.body.error.code).toBe('cannot_automate');
  });

  it('refuses what the network would refuse, with every reason', async () => {
    const r = await scheduled({ account: ig, kind: 'post', format: '4:5', files: IMAGE, text: 'x'.repeat(2300) + ' ' + Array.from({ length: 31 }, (_, i) => `#t${i}`).join(' ') });
    expect(r.res.status).toBe(400);
    expect(r.res.body.error.code).toBe('validation_failed');
    expect(r.res.body.error.message).toMatch(/2200/);
    expect(r.res.body.error.message).toMatch(/hashtags/);
    expect(r.res.body.error.details.issues.every((i: any) => i.severity)).toBe(true);
  });

  it('answers a dry run with the plan and what is wrong, as the editor needs it', async () => {
    const { users, call, makePiece, newVersion, approve } = env;
    const { variantId } = await makePiece(users.producer, 'video', '9:16');
    const v = await newVersion(users.producer, variantId);
    await approve(users.approver, v.body.id, [ig, yt]);
    const plan = await call(users.approver, 'POST', `/api/versions/${v.body.id}/publications/validate`, { accountId: ig, text: 'x'.repeat(2300) });
    expect(plan.body).toMatchObject({ automated: true, placement: 'reel' });
    expect(plan.body.issues.map((i: any) => i.code)).toContain('text.length');
    expect(plan.body.placements.map((p: any) => p.id)).toEqual(['reel', 'feed_image', 'carousel', 'story']);
    const yPlan = await call(users.approver, 'POST', `/api/versions/${v.body.id}/publications/validate`, { accountId: yt, text: 'ok' });
    expect(yPlan.body.placement).toBe('short');
    expect((await call(users.reviewer, 'POST', `/api/versions/${v.body.id}/publications/validate`, { accountId: ig })).status).toBe(403);
  });

  it('lets a person choose another placement', async () => {
    const r = await scheduled({ account: ig, kind: 'video', format: '9:16', body: { placement: 'story' } });
    expect(r.pub.placement).toBe('story');
    const bad = await scheduled({ account: ig, kind: 'video', format: '9:16', body: { placement: 'nonsense' } });
    expect(bad.res.status).toBe(400);
  });

  it('shows automatic publications in the calendar and piece with their state, and keeps them out of the manual due list', async () => {
    const s = await scheduled({ account: ig, kind: 'post', format: '4:5', files: IMAGE });
    env.clock.set(new Date(s.pub.scheduled_at));
    const due = await env.call(env.users.approver, 'GET', `/api/brands/${env.brandId}/publications/due`);
    expect(due.body.map((d: any) => d.id)).not.toContain(s.pub.id);
    const piece = await env.call(env.users.reader, 'GET', `/api/pieces/${s.pieceId}`);
    expect(piece.body.publications[0]).toMatchObject({ manual: false, placement: 'feed_image', status: 'scheduled' });
    const attempts = await env.call(env.users.reader, 'GET', `/api/publications/${s.pub.id}/attempts`);
    expect(attempts.status).toBe(200);
  });

  it('will not mark an automatic publication as published by hand, but can hand it over', async () => {
    const s = await scheduled({ account: ig, kind: 'post', format: '4:5', files: IMAGE });
    const mark = await env.call(env.users.approver, 'POST', `/api/publications/${s.pub.id}/mark-published`, {});
    expect(mark.body.error.code).toBe('automatic');
    expect((await env.call(env.users.reviewer, 'POST', `/api/publications/${s.pub.id}/hand-over`)).status).toBe(403);
    const handed = await env.call(env.users.approver, 'POST', `/api/publications/${s.pub.id}/hand-over`);
    expect(handed.body).toMatchObject({ manual: true, status: 'scheduled', next_run_at: null });
    expect((await env.call(env.users.approver, 'POST', `/api/publications/${s.pub.id}/mark-published`, {})).status).toBe(200);
  });
});

describe('brand publishing settings', () => {
  it('lets an admin change how far ahead preparation starts and how late the app will still publish', async () => {
    const { users, call, brandId } = env;
    expect((await call(users.approver, 'PATCH', `/api/brands/${brandId}`, { publishing: { prepare_lead_minutes: 60 } })).status).toBe(403);
    expect((await call(users.admin, 'PATCH', `/api/brands/${brandId}`, { publishing: { prepare_lead_minutes: 5 } })).status).toBe(400); // under Facebook's own 10-minute minimum
    const r = await call(users.admin, 'PATCH', `/api/brands/${brandId}`, { publishing: { prepare_lead_minutes: 60, late_tolerance_minutes: 5 } });
    expect(r.body.publishing).toEqual({ prepare_lead_minutes: 60, late_tolerance_minutes: 5 });
    try {
      const s = await scheduled({ account: ig, kind: 'post', format: '4:5', files: IMAGE, leadMs: 3 * 60 * MIN });
      expect(new Date(s.pub.prepare_at).getTime()).toBe(new Date(s.pub.scheduled_at).getTime() - 60 * MIN);
      // The shorter tolerance applies too: 6 minutes late is now too late.
      env.clock.set(new Date(new Date(s.pub.scheduled_at).getTime() + 6 * MIN));
      await env.settle();
      expect(await row(s.pub.id)).toMatchObject({ status: 'failed', last_error_class: 'missed_window' });
    } finally {
      await call(users.admin, 'PATCH', `/api/brands/${brandId}`, { publishing: { prepare_lead_minutes: 30, late_tolerance_minutes: 15 } });
    }
    expect((await call(users.reader, 'GET', `/api/brands/${brandId}`)).body.publishing).toEqual({ prepare_lead_minutes: 30, late_tolerance_minutes: 15 });
  });
});
