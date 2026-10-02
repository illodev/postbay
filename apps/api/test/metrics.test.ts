import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { agesFor, scanMetrics, scheduleSnapshots } from '../src/services/metrics.js';
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
beforeEach(async () => {
  // Each test counts its own readings: whatever earlier tests left pending is cleared.
  await env.db.query('delete from metric_snapshot');
  env.meta.failures.length = 0;
  env.google.failures.length = 0;
  env.meta.calls.length = 0;
  env.meta.insightsPermission = true;
  env.meta.igInsights = { views: 2000, reach: 1500, likes: 120, comments: 14, saved: 30, shares: 22, replies: 5, navigation: 40, ig_reels_avg_watch_time: 6500 };
  env.google.audited = false;
});

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const at = (ms: number) => new Date(env.clock.now().getTime() + ms);
const pub = async (id: string) => (await env.db.one('select * from publication where id = $1', [id]))!;
const snaps = async (id: string) => await env.db.query('select * from metric_snapshot where publication_id = $1 order by due_at', [id]);
const byAge = async (id: string) => Object.fromEntries((await snaps(id)).map((s) => [s.age, s]));

/** Schedules a post on an account and runs the worker's steps until it is live (or as live as it gets). */
async function published(account: string, o: { kind?: string; format?: string; files?: { name: string; mime: string; kind: string }[] } = {}) {
  const { users, call, makePiece, newVersion, approve } = env;
  const { variantId, pieceId } = await makePiece(users.producer, o.kind ?? 'video', o.format ?? '9:16');
  const v = await newVersion(users.producer, variantId, o.files ?? [{ name: 'reel.mp4', mime: 'video/mp4', kind: 'video' }]);
  await approve(users.approver, v.body.id, [account]);
  const r = await call(users.approver, 'POST', `/api/versions/${v.body.id}/publications`, { accountId: account, scheduledAt: at(2 * HOUR).toISOString(), text: 'Our spring menu' });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  env.clock.set(new Date(r.body.prepare_at));
  await env.settle();
  env.clock.advance(11_000);
  await env.settle();
  env.clock.set(new Date(r.body.scheduled_at));
  await env.settle();
  // A network that holds the post itself (Facebook) has it published a moment after its hour.
  env.clock.advance(60_000);
  await env.settle();
  return { id: r.body.id as string, pieceId };
}

describe('scheduling the readings', () => {
  it('makes a row for each age when a post goes live, due that long after it was published', async () => {
    const { id } = await published(ig);
    const p = await pub(id);
    expect(p.status).toBe('published');
    const rows = await snaps(id);
    expect(rows.map((r) => r.age)).toEqual(['1h', '1d', '7d', '28d']);
    expect(rows.map((r) => new Date(r.due_at).getTime() - new Date(p.published_at).getTime())).toEqual([HOUR, DAY, 7 * DAY, 28 * DAY]);
    expect(rows.every((r) => r.status === 'pending')).toBe(true);
  });

  it('is safe to repeat: a post that is checked again keeps what it has', async () => {
    const { id } = await published(ig);
    const before = await snaps(id);
    await scheduleSnapshots(env.db, await pub(id) as any);
    await scheduleSnapshots(env.db, await pub(id) as any);
    expect((await snaps(id)).map((r) => r.id)).toEqual(before.map((r) => r.id));
  });

  it("gives a story readings inside its day: after an hour, six hours and twenty-two", async () => {
    expect(agesFor('story').map(([a]) => a)).toEqual(['1h', '6h', '22h']);
    expect(agesFor('reel').map(([a]) => a)).toEqual(['1h', '1d', '7d', '28d']);
    const { id } = await published(ig, { kind: 'story', format: '9:16', files: [{ name: 's.png', mime: 'image/png', kind: 'image' }] });
    expect((await pub(id)).placement).toBe('story');
    expect((await snaps(id)).map((r) => r.age)).toEqual(['1h', '6h', '22h']);
  });

  it('makes none for a post that is only private (YouTube before its audit), and some once it is public', async () => {
    const { id } = await published(yt);
    expect((await pub(id)).visibility).toBe('private');
    expect(await snaps(id)).toHaveLength(0); // nothing to count on a post nobody can see
    env.google.audited = true;
    await env.db.query(`update social_account set provider_data = provider_data || '{"audited":true}' where id = $1`, [yt]);
    const r = await env.call(env.users.approver, 'POST', `/api/publications/${id}/recheck`, {});
    expect(r.status).toBe(200);
    await env.settle();
    expect((await pub(id)).visibility).toBe('public');
    expect((await snaps(id)).map((s) => s.age)).toEqual(['1h', '1d', '7d', '28d']);
  });
});

describe('reading them', () => {
  it('reads nothing before it is due, and the common set when it is, with the whole answer kept apart', async () => {
    const { id } = await published(ig);
    expect(await scanMetrics(env.ctx)).toBe(0);
    const due = new Date((await byAge(id))['1h'].due_at).getTime();
    env.clock.set(new Date(due - 1000));
    expect(await scanMetrics(env.ctx)).toBe(0);
    env.clock.set(new Date(due + 1000));
    expect(await scanMetrics(env.ctx)).toBe(1);
    const one = (await byAge(id))['1h'];
    expect(one).toMatchObject({ status: 'ok', attempts: 1, lease_until: null });
    expect(one.metrics).toEqual({ views: 2000, reach: 1500, likes: 120, comments: 14, shares: 22, saves: 30, avgWatchSeconds: 6.5 });
    expect(new Date(one.taken_at).getTime()).toBeGreaterThanOrEqual(new Date(one.due_at).getTime());
    expect(one.raw.data).toHaveLength(7); // the network's own answer, as it came
    expect(JSON.stringify(one.raw)).not.toContain('page-token');
    expect((await byAge(id))['1d'].status).toBe('pending');
  });

  it('keeps each age as it was read, so growth can be seen', async () => {
    const { id } = await published(ig);
    env.clock.advance(HOUR + 1000);
    await scanMetrics(env.ctx);
    env.meta.igInsights = { ...env.meta.igInsights, views: 9000, likes: 400 };
    env.clock.advance(DAY);
    await scanMetrics(env.ctx);
    const a = await byAge(id);
    expect(a['1h'].metrics.views).toBe(2000);
    expect(a['1d'].metrics.views).toBe(9000);
    expect(a['1d'].metrics.likes).toBe(400);
  });

  it('catches up after the worker was down, reading what fell due while it was away', async () => {
    const { id } = await published(ig);
    env.clock.advance(8 * DAY);
    expect(await scanMetrics(env.ctx)).toBe(3); // 1h, 1d and 7d
    const a = await byAge(id);
    expect([a['1h'].status, a['1d'].status, a['7d'].status, a['28d'].status]).toEqual(['ok', 'ok', 'ok', 'pending']);
  });

  it("does not read a story's numbers after its day: they would be gone, so the reading is closed as expired", async () => {
    const { id } = await published(ig, { kind: 'story', format: '9:16', files: [{ name: 's.png', mime: 'image/png', kind: 'image' }] });
    env.clock.advance(23 * HOUR);
    await scanMetrics(env.ctx); // 1h, 6h and 22h are all due by now and inside the window
    expect(Object.values(await byAge(id)).map((s: any) => s.status)).toEqual(['ok', 'ok', 'ok']);
    expect(env.meta.callsTo(/insights/).every((c) => c.query.metric === 'views,reach,replies,shares,navigation')).toBe(true);

    const second = await published(ig, { kind: 'story', format: '9:16', files: [{ name: 's2.png', mime: 'image/png', kind: 'image' }] });
    env.clock.advance(26 * HOUR); // the service was down for the whole day
    await scanMetrics(env.ctx);
    const rows = await snaps(second.id);
    expect(rows.map((r) => r.status)).toEqual(['expired', 'expired', 'expired']);
    expect(rows[0]!.note).toContain('24 hours');
  });

  it('says so, and does not pretend, when the network has no figures for a post', async () => {
    const { id } = await published(ig);
    env.meta.igInsights = {};
    env.clock.advance(HOUR + 1000);
    // Instagram answers, but with no values we know: nothing is written as zero.
    env.meta.fail((c) => /insights/.test(c.path), { data: [] }, 200);
    await scanMetrics(env.ctx);
    const one = (await byAge(id))['1h'];
    expect(one.status).toBe('unavailable');
    expect(one.metrics).toEqual({});
  });
});

describe('when reading goes wrong', () => {
  async function dueRow() {
    const { id } = await published(ig);
    env.clock.advance(HOUR + 1000);
    return id;
  }

  it('waits out a rate limit without counting it as a failed try', async () => {
    const id = await dueRow();
    env.meta.fail((c) => /insights/.test(c.path), env.meta.err(4, '(#4) Application request limit reached'), 400, 1, { 'x-business-use-case-usage': JSON.stringify({ '222': [{ estimated_time_to_regain_access: 20 }] }) });
    await scanMetrics(env.ctx);
    const one = (await byAge(id))['1h'];
    expect(one).toMatchObject({ status: 'pending', attempts: 0 });
    expect(one.note).toContain('limit');
    expect(new Date(one.next_attempt_at).getTime()).toBeGreaterThanOrEqual(env.clock.now().getTime() + 20 * MIN - 1000);
    // Not read again until the limit clears.
    expect(await scanMetrics(env.ctx)).toBe(0);
    env.clock.advance(21 * MIN);
    await scanMetrics(env.ctx);
    expect((await byAge(id))['1h'].status).toBe('ok');
  });

  it('tries a temporary failure again with growing waits, and gives up after five tries, saying why', async () => {
    const id = await dueRow();
    env.meta.fail((c) => /insights/.test(c.path), env.meta.err(2, 'An unexpected error has occurred', { is_transient: true }), 500, 20);
    const waits: number[] = [];
    for (let i = 0; i < 5; i++) {
      await scanMetrics(env.ctx);
      const one = (await byAge(id))['1h'];
      if (one.status !== 'pending') break;
      const wait = new Date(one.next_attempt_at).getTime() - env.clock.now().getTime();
      waits.push(Math.round(wait / MIN));
      env.clock.advance(wait + 1000);
    }
    expect(waits).toEqual([5, 15, 60, 180]);
    const last = (await byAge(id))['1h'];
    expect(last).toMatchObject({ status: 'failed', attempts: 5 });
    expect(last.note).toContain('unexpected error');
  });

  it('says to connect the account again when it was connected before numbers were asked for, and does not mark it for reconnecting', async () => {
    const id = await dueRow();
    env.meta.insightsPermission = false;
    for (let i = 0; i < 5; i++) {
      await scanMetrics(env.ctx);
      const one = (await byAge(id))['1h'];
      if (one.status !== 'pending') break;
      env.clock.advance(7 * HOUR);
    }
    const one = (await byAge(id))['1h'];
    expect(one.status).toBe('failed');
    expect(one.note).toContain('Connecting the account again grants it');
    expect((await env.db.one('select status from social_account where id = $1', [ig]))!.status).toBe('active'); // publishing is unaffected
  });

  it('closes a reading for a post that has been removed from the network as unavailable, and does not retry it', async () => {
    const id = await dueRow();
    env.meta.media.clear(); // the post is gone
    await scanMetrics(env.ctx);
    const one = (await byAge(id))['1h'];
    expect(one.status).toBe('unavailable');
    expect(one.note).toContain('does not exist');
  });

  it('postpones a reading while the account has to be reconnected, then reads it once it is back', async () => {
    const id = await dueRow();
    await env.db.query(`update social_account set status = 'reconnect_required' where id = $1`, [ig]);
    await scanMetrics(env.ctx);
    const one = (await byAge(id))['1h'];
    expect(one.status).toBe('pending');
    expect(one.note).toContain('connected again');
    expect(env.meta.callsTo(/insights/)).toHaveLength(0); // nothing was sent with a token that does not work
    await env.db.query(`update social_account set status = 'active' where id = $1`, [ig]);
    env.clock.advance(7 * HOUR);
    await scanMetrics(env.ctx);
    expect((await byAge(id))['1h'].status).toBe('ok');
  });

  it('does not read a post that was taken down or is not the app\'s to read', async () => {
    const id = await dueRow();
    await env.db.query(`update publication set status = 'cancelled' where id = $1`, [id]);
    await scanMetrics(env.ctx);
    expect((await byAge(id))['1h'].status).toBe('unavailable');
    expect(env.meta.callsTo(/insights/)).toHaveLength(0);
  });

  it('never reads one row twice when two workers scan at once', async () => {
    const id = await dueRow();
    const [a, b] = await Promise.all([scanMetrics(env.ctx), scanMetrics(env.ctx)]);
    expect(a + b).toBe(1);
    expect(env.meta.callsTo(/insights/)).toHaveLength(1);
    expect((await byAge(id))['1h'].attempts).toBe(1);
  });

  it('lets a row whose reader died be taken up again once its lease runs out', async () => {
    const id = await dueRow();
    await env.db.query(`update metric_snapshot set lease_until = $2 where publication_id = $1 and age = '1h'`, [id, at(4 * MIN)]);
    expect(await scanMetrics(env.ctx)).toBe(0); // still held
    env.clock.advance(6 * MIN);
    expect(await scanMetrics(env.ctx)).toBe(1);
  });
});

describe('the API', () => {
  it("lists a post's readings to anyone who can see the brand, and refuses anyone else", async () => {
    const { id } = await published(ig);
    env.clock.advance(HOUR + 1000);
    await scanMetrics(env.ctx);
    const r = await env.call(env.users.reader, 'GET', `/api/publications/${id}/metrics`);
    expect(r.status).toBe(200);
    expect(r.body.publication).toMatchObject({ network: 'instagram', placement: 'reel' });
    expect(r.body.snapshots.map((s: any) => [s.age, s.status])).toEqual([['1h', 'ok'], ['1d', 'pending'], ['7d', 'pending'], ['28d', 'pending']]);
    expect(r.body.snapshots[0].metrics.views).toBe(2000);
    expect(r.body.snapshots[1].metrics).toEqual({});
    expect((await env.call(null, 'GET', `/api/publications/${id}/metrics`)).status).toBe(401);
    expect((await env.call(env.users.reader, 'GET', '/api/publications/00000000-0000-0000-0000-000000000000/metrics')).status).toBe(404);
  });

  it('lists a period by post with its latest reading, and totals each network on its own', async () => {
    const a = await published(ig);
    const b = await published(fb);
    env.clock.advance(HOUR + 1000);
    await scanMetrics(env.ctx);
    const r = await env.call(env.users.reader, 'GET', `/api/brands/${env.brandId}/metrics`);
    expect(r.status).toBe(200);
    const mine = r.body.rows.filter((x: any) => [a.id, b.id].includes(x.publication.id));
    expect(mine).toHaveLength(2);
    const igRow = mine.find((x: any) => x.publication.id === a.id);
    expect(igRow.latest).toMatchObject({ age: '1h', metrics: { views: 2000, likes: 120 } });
    const nets = Object.fromEntries(r.body.networks.map((n: any) => [n.network, n]));
    expect(nets.instagram.totals.views).toBeGreaterThanOrEqual(2000);
    expect(nets.facebook.totals.views).toBeGreaterThanOrEqual(1); // another network, another count: never added to Instagram's
    expect(nets.instagram.totals.avgWatchSeconds).toBeUndefined(); // an average is not a total

    const only = await env.call(env.users.reader, 'GET', `/api/brands/${env.brandId}/metrics?network=facebook`);
    expect(only.body.rows.every((x: any) => x.publication.network === 'facebook')).toBe(true);
    const old = await env.call(env.users.reader, 'GET', `/api/brands/${env.brandId}/metrics?from=2001-01-01&to=2001-12-31`);
    expect(old.body.rows).toEqual([]);
    expect((await env.call(env.users.reader, 'GET', `/api/brands/${env.brandId}/metrics?from=yesterday`)).status).toBe(400);
  });
});
