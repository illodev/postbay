import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { scanSlotAlerts } from '../src/services/slots.js';
import { deliver, dueDeliveries } from '../src/services/webhooks.js';
import { createEnv, type Actor, type Env } from './helpers.js';
import { Receiver } from './receiver.js';

let env: Env;
const rx = new Receiver();
let agent: Actor;
const T0 = new Date('2026-10-05T08:00:00.000Z'); // a Monday

beforeAll(async () => {
  env = await createEnv({}, { fakes: true });
  await rx.start();
  const tok = await env.call(env.users.admin, 'POST', `/api/brands/${env.brandId}/tokens`, { name: 'Agent runner' });
  agent = { id: 'tok', email: 'agent', bearer: tok.body.token };
});
afterAll(async () => {
  await rx.stop();
  await env.close();
});
beforeEach(async () => {
  rx.reset();
  env.clock.set(T0);
  await env.db.query('delete from webhook where brand_id = $1', [env.brandId]);
  await env.db.query('delete from event');
  await env.db.query('delete from slot_alert');
});

const ALL = ['version.changes_requested', 'version.approved', 'version.rejected', 'comment.created', 'slot.needs_content', 'publication.published', 'publication.failed'];
async function subscribe(events = ALL) {
  const r = await env.call(env.users.admin, 'POST', `/api/brands/${env.brandId}/webhooks`, { url: rx.url, events });
  expect(r.status).toBe(201);
  return r.body.id as string;
}
async function flush() {
  for (let i = 0; i < 30; i++) {
    const due = await dueDeliveries(env.ctx);
    if (!due.length) return;
    for (const id of due) await deliver(env.ctx, id);
  }
}
const types = () => rx.requests.map((r) => r.json.type);
const of = (type: string) => rx.requests.filter((r) => r.json.type === type).map((r) => r.json);

/** A piece with one version in review, ready to be commented on. */
async function inReview() {
  const { users, makePiece, newVersion } = env;
  const { pieceId, variantId } = await makePiece(users.producer, 'video', '9:16');
  const v = await newVersion(users.producer, variantId);
  expect(v.status).toBe(201);
  return { pieceId, variantId, versionId: v.body.id as string };
}
const comment = (versionId: string, body: string, extra: Record<string, unknown> = {}) =>
  env.call(env.users.reviewer, 'POST', `/api/versions/${versionId}/comments`, { body, ...extra });

describe('version.changes_requested', () => {
  it('carries the open comments with their anchors, frames and flags, and who asked', async () => {
    await subscribe(['version.changes_requested']);
    const { versionId, pieceId, variantId } = await inReview();
    const c1 = await comment(versionId, 'The logo is cut off here', { anchor: { type: 'time', t: 2.5 } });
    const c2 = await comment(versionId, 'Check this with legal before it goes out', { peopleOnly: true });
    const c3 = await comment(versionId, 'Music is too loud', { anchor: { type: 'time', t: 4, t_end: 6 } });
    // An earlier discussion on one of them is part of what the agent should know.
    await env.call(env.users.producer, 'POST', `/api/comments/${c3.body.id}/replies`, { body: 'Which part?', kind: 'needs_human' });

    const r = await env.call(env.users.reviewer, 'POST', `/api/versions/${versionId}/request-changes`, { note: 'Please also keep it under 8 seconds' });
    expect(r.status).toBe(200);
    await flush();

    const [ev] = of('version.changes_requested');
    expect(ev).toBeTruthy();
    expect(ev.brand).toMatchObject({ id: env.brandId });
    expect(ev.data).toMatchObject({
      reason: 'changes_requested', note: 'Please also keep it under 8 seconds', requested_by: { kind: 'user', name: 'reviewer' },
      piece: { id: pieceId }, version: { id: versionId, number: 1, variant: { id: variantId, format: '9:16' } }, people_only_open: 1,
    });
    const bodies = ev.data.comments.map((c: any) => c.body);
    expect(bodies).toEqual(['The logo is cut off here', 'Check this with legal before it goes out', 'Music is too loud', 'Please also keep it under 8 seconds']);
    const logo = ev.data.comments[0];
    expect(logo).toMatchObject({ id: c1.body.id, anchor: { type: 'time', t: 2.5 }, people_only: false });
    expect(logo.frame_url).toMatch(/^https?:\/\/.+/); // the frame the reviewer was looking at
    expect(JSON.stringify(ev)).not.toContain('frame_key');
    expect(ev.data.comments[1]).toMatchObject({ id: c2.body.id, people_only: true, anchor: null, frame_url: null });
    expect(ev.data.comments[2]).toMatchObject({ anchor: { type: 'time', t: 4, t_end: 6 } });
    expect(ev.data.comments[2].replies).toEqual([expect.objectContaining({ body: 'Which part?', kind: 'needs_human' })]);
  });

  it('is sent when an approver rejects, after the rejection itself', async () => {
    await subscribe(['version.changes_requested', 'version.rejected']);
    const { versionId } = await inReview();
    await comment(versionId, 'Wrong music');
    const r = await env.call(env.users.approver, 'POST', `/api/versions/${versionId}/approvals`, { decision: 'reject', note: 'Not on brand' });
    expect(r.body.review_state).toBe('changes_requested');
    await flush();
    expect(of('version.rejected')[0].data).toMatchObject({ note: 'Not on brand', rejected_by: { name: 'approver' } });
    expect(of('version.changes_requested')[0].data).toMatchObject({ reason: 'rejected', note: 'Not on brand', requested_by: { name: 'approver' } });
    expect(of('version.changes_requested')[0].data.comments.map((c: any) => c.body)).toEqual(['Wrong music']);
  });

  it('is not sent when the request is refused', async () => {
    await subscribe(['version.changes_requested', 'comment.created']);
    const { versionId } = await inReview();
    expect((await env.call(env.users.reviewer, 'POST', `/api/versions/${versionId}/request-changes`, {})).status).toBe(400); // nothing to change
    expect((await env.call(env.users.reader, 'POST', `/api/versions/${versionId}/request-changes`, { note: 'x' })).status).toBe(403);
    await flush();
    expect(types()).toEqual([]);
  });
});

describe('version.approved', () => {
  it('is sent when the approval is complete, with the accounts', async () => {
    await subscribe(['version.approved']);
    const { versionId } = await inReview();
    const ok = await env.approve(env.users.approver, versionId, [env.accounts.instagram, env.accounts.youtube]);
    expect(ok.body.review_state).toBe('approved');
    await flush();
    const [ev] = of('version.approved');
    expect(ev.data.accounts.map((a: any) => a.network).sort()).toEqual(['instagram', 'youtube']);
    expect(ev.data).toMatchObject({ approvals: 1, version: { id: versionId, review_state: 'approved' } });
  });

  it('waits for enough approvers when the brand needs more than one', async () => {
    await subscribe(['version.approved']);
    await env.call(env.users.admin, 'PATCH', `/api/brands/${env.brandId}`, { rules: { required_approvals: 2 } });
    try {
      const { versionId } = await inReview();
      await env.approve(env.users.approver, versionId);
      await flush();
      expect(types()).toEqual([]); // one of two: not approved yet
      await env.approve(env.users.approver2, versionId);
      await flush();
      expect(types()).toEqual(['version.approved']);
      expect(of('version.approved')[0].data.approvals).toBe(2);
    } finally {
      await env.call(env.users.admin, 'PATCH', `/api/brands/${env.brandId}`, { rules: { required_approvals: 1 } });
    }
  });
});

describe('comment.created', () => {
  it('is sent for comments, replies and the note that comes with a request for changes', async () => {
    await subscribe(['comment.created']);
    const { versionId } = await inReview();
    const c = await comment(versionId, 'Make it brighter', { anchor: { type: 'time', t: 1 } });
    await env.call(agent, 'POST', `/api/comments/${c.body.id}/replies`, { body: 'Done', kind: 'fixed' });
    await env.call(env.users.reviewer, 'POST', `/api/versions/${versionId}/request-changes`, { note: 'And shorter' });
    await flush();
    const got = of('comment.created').map((e) => e.data);
    expect(got.map((d) => d.comment.body)).toEqual(['Make it brighter', 'Done', 'And shorter']);
    expect(got[0].comment).toMatchObject({ parent_id: null, anchor: { type: 'time', t: 1 }, author: { kind: 'user', name: 'reviewer' } });
    expect(got[0].comment.frame_url).toBeTruthy();
    expect(got[1].comment).toMatchObject({ parent_id: c.body.id, reply_kind: 'fixed', author: { kind: 'token', name: 'Agent runner' } });
  });
});

describe('publication events', () => {
  it('announces a post published by hand', async () => {
    await subscribe(['publication.published']);
    const { versionId } = await inReview();
    await env.approve(env.users.approver, versionId, [env.accounts.facebook]);
    const pub = await env.call(env.users.approver, 'POST', `/api/versions/${versionId}/publications`, {
      accountId: env.accounts.facebook, scheduledAt: new Date(T0.getTime() + 3 * 3600_000).toISOString(), text: 'Hi',
    });
    expect(pub.body.manual).toBe(true);
    env.clock.set(new Date(T0.getTime() + 3 * 3600_000));
    const done = await env.call(env.users.approver, 'POST', `/api/publications/${pub.body.id}/mark-published`, { url: 'https://facebook.example/post/1' });
    expect(done.status).toBe(200);
    await flush();
    expect(of('publication.published')[0].data.publication).toMatchObject({ id: pub.body.id, manual: true, url: 'https://facebook.example/post/1', account: { network: 'facebook' } });
  });

  it('announces a post the app published, once it is confirmed live, and a post that failed', async () => {
    await subscribe(['publication.published', 'publication.failed']);
    const ig = await env.connect('instagram', { externalId: '901', name: '@events' });
    env.meta.processingPolls = 0;
    const make = async (leadMin: number) => {
      const { users, makePiece, newVersion, approve, call } = env;
      const { variantId } = await makePiece(users.producer, 'post', '4:5');
      const v = await newVersion(users.producer, variantId, [{ name: 'p.png', mime: 'image/png', kind: 'image' }]);
      await approve(users.approver, v.body.id, [ig]);
      const r = await call(users.approver, 'POST', `/api/versions/${v.body.id}/publications`, {
        accountId: ig, scheduledAt: new Date(env.clock.now().getTime() + leadMin * 60_000).toISOString(), text: 'Auto',
      });
      expect(r.body.manual).toBe(false);
      return r.body;
    };
    const good = await make(120);
    env.clock.set(new Date(good.prepare_at));
    await env.settle();
    env.clock.set(new Date(good.scheduled_at));
    await env.settle();
    await flush();
    expect(types()).toEqual(['publication.published']);
    expect(of('publication.published')[0].data.publication).toMatchObject({ id: good.id, manual: false, status: 'published', account: { network: 'instagram' } });

    rx.reset();
    const bad = await make(120);
    env.meta.fail((c) => /\/media$/.test(c.path), env.meta.err(100, 'Invalid image', {}), 400, 5);
    env.clock.set(new Date(bad.prepare_at));
    await env.settle();
    await flush();
    expect(types()).toEqual(['publication.failed']);
    expect(of('publication.failed')[0].data).toMatchObject({ publication: { id: bad.id, status: 'failed' }, error: { class: 'file_rejected' } });
    env.meta.failures.length = 0;
  });
});

describe('people-only comments', () => {
  it('can be marked and unmarked by reviewers and above, not by agents or readers', async () => {
    const { versionId } = await inReview();
    const c = await comment(versionId, 'Ask legal');
    expect(c.body.people_only).toBe(false);
    for (const who of [env.users.reader, env.users.producer, agent]) {
      expect((await env.call(who, 'POST', `/api/comments/${c.body.id}/people-only`, { value: true })).status).toBe(403);
    }
    expect((await env.call(env.users.approver, 'POST', `/api/comments/${c.body.id}/people-only`, { value: true })).body.people_only).toBe(true);
    expect((await env.call(env.users.reviewer, 'POST', `/api/comments/${c.body.id}/people-only`, { value: false })).body.people_only).toBe(false);
    const trail = (await env.db.query(`select action from audit_event where entity = 'comment' and entity_id = $1 order by id`, [c.body.id])).map((r) => r.action);
    expect(trail).toEqual(['comment.created', 'comment.people_only', 'comment.agent_allowed']);
  });

  it('are left alone by an agent: it can neither reply to them nor resolve them nor claim to have fixed them', async () => {
    const { versionId, variantId } = await inReview();
    const mine = await comment(versionId, 'Make it brighter');
    const theirs = await comment(versionId, 'Do not touch the legal line', { peopleOnly: true });

    expect((await env.call(agent, 'POST', `/api/comments/${theirs.body.id}/replies`, { body: 'Done', kind: 'fixed' })).status).toBe(403);
    expect((await env.call(agent, 'POST', `/api/comments/${theirs.body.id}/resolve`)).status).toBe(403);
    const claim = await env.newVersion(agent, variantId, [{ data: Buffer.from('new-take-1') }], { resolves: [theirs.body.id] });
    expect(claim.status).toBe(400);
    expect(claim.body.error.code).toBe('people_only');

    // Its own comment is fine, and a person can still answer the other one.
    const ok = await env.newVersion(agent, variantId, [{ data: Buffer.from('new-take-2') }], { resolves: [mine.body.id] });
    expect(ok.status).toBe(201);
    // It still shows up for the agent, flagged, so it knows what to leave alone.
    const list = await env.call(agent, 'GET', `/api/versions/${ok.body.id}/comments?carried=true&status=open`);
    expect(list.body.map((c: any) => [c.body, c.people_only])).toEqual([['Do not touch the legal line', true]]);

    expect((await env.call(env.users.reviewer, 'POST', `/api/comments/${theirs.body.id}/replies`, { body: 'Checked, fine' })).status).toBe(201);
    expect((await env.call(env.users.reviewer, 'POST', `/api/comments/${theirs.body.id}/resolve`)).status).toBe(200);
  });
});

describe('slot.needs_content', () => {
  let ig: string;
  beforeAll(async () => {
    ig = env.accounts.instagram;
  });
  const addSlot = (weekday: number, localTime: string, label = 'Reels') =>
    env.call(env.users.admin, 'POST', `/api/brands/${env.brandId}/slots`, { accountId: ig, weekday, localTime, label });
  const setAlertDays = (n: number) => env.db.query(`update brand set agent = agent || jsonb_build_object('slot_alert_days', $2::int) where id = $1`, [env.brandId, n]);
  const clearSlots = () => env.db.query('delete from slot where brand_id = $1', [env.brandId]);

  it('announces an empty slot once, a few days before its date, with the campaigns running that day', async () => {
    await clearSlots();
    await setAlertDays(3);
    await subscribe(['slot.needs_content']);
    await env.call(env.users.admin, 'POST', `/api/brands/${env.brandId}/campaigns`, { name: 'Spring launch', startsOn: '2026-10-01', endsOn: '2026-10-31', objective: 'Make the new menu famous' });
    await env.call(env.users.admin, 'POST', `/api/brands/${env.brandId}/campaigns`, { name: 'Summer sale', startsOn: '2026-06-01', endsOn: '2026-08-31', objective: 'Old news' });
    const soon = (await addSlot(2, '19:00')).body; // Tuesday: tomorrow
    await addSlot(5, '19:00'); // Friday: four days away, outside the three days

    expect(await scanSlotAlerts(env.ctx)).toBe(1);
    expect(await scanSlotAlerts(env.ctx)).toBe(0); // however often the scan runs
    await flush();
    const [ev] = of('slot.needs_content');
    expect(ev.data.slot).toMatchObject({ id: soon.id, label: 'Reels', day: '2026-10-06' });
    expect(ev.data.account).toMatchObject({ id: ig, network: 'instagram' });
    expect(ev.data.days_ahead).toBe(2);
    expect(ev.data.campaigns).toEqual([expect.objectContaining({ name: 'Spring launch', objective: 'Make the new menu famous' })]);

    // Two days later the Friday slot comes into range and is announced, the Tuesday one is not announced again.
    env.clock.set(new Date(T0.getTime() + 2 * 86_400_000));
    expect(await scanSlotAlerts(env.ctx)).toBe(1);
  });

  it('does not announce a slot that is filled, blocked, or in a paused brand, or when alerts are off', async () => {
    await clearSlots();
    await setAlertDays(3);
    await subscribe(['slot.needs_content']);
    await addSlot(2, '19:00');
    await env.call(env.users.admin, 'POST', `/api/brands/${env.brandId}/blocked-dates`, { day: '2026-10-06', reason: 'Holiday' });
    expect(await scanSlotAlerts(env.ctx)).toBe(0);
    await env.call(env.users.admin, 'DELETE', `/api/brands/${env.brandId}/blocked-dates/2026-10-06`);

    await env.call(env.users.approver, 'POST', `/api/brands/${env.brandId}/pause`, { paused: true });
    expect(await scanSlotAlerts(env.ctx)).toBe(0);
    await env.call(env.users.approver, 'POST', `/api/brands/${env.brandId}/pause`, { paused: false });

    await setAlertDays(0);
    expect(await scanSlotAlerts(env.ctx)).toBe(0);
    await setAlertDays(3);

    // Filled: a post is already scheduled for it.
    const { versionId } = await inReview();
    await env.approve(env.users.approver, versionId, [ig]);
    const tuesday = new Date('2026-10-06T17:00:00.000Z'); // 19:00 in Madrid
    await env.call(env.users.approver, 'POST', `/api/versions/${versionId}/publications`, { accountId: ig, scheduledAt: tuesday.toISOString(), text: 'x', mode: 'manual' });
    expect(await scanSlotAlerts(env.ctx)).toBe(0);
    expect(types()).toEqual([]);
  });
});

describe('what a producer token can learn about itself', () => {
  it('knows its brand, and finds empty slots without being given a date range', async () => {
    const me = await env.call(agent, 'GET', '/api/token');
    expect(me.status).toBe(200);
    expect(me.body).toMatchObject({ token: { name: 'Agent runner' }, brand: { id: env.brandId, name: 'Test brand', timezone: 'Europe/Madrid' } });
    expect((await env.call(env.users.admin, 'GET', '/api/token')).status).toBe(403);
    await env.call(env.users.admin, 'DELETE', `/api/brands/${env.brandId}/slots/${(await env.call(env.users.admin, 'GET', `/api/brands/${env.brandId}/slots`)).body[0]?.id ?? '00000000-0000-0000-0000-000000000000'}`);
    await env.call(env.users.admin, 'POST', `/api/brands/${env.brandId}/slots`, { accountId: env.accounts.instagram, weekday: 3, localTime: '12:00', label: 'Stories' });
    const empty = await env.call(agent, 'GET', `/api/brands/${env.brandId}/slots?status=empty`);
    expect(empty.status).toBe(200);
    expect(empty.body.some((s: any) => s.label === 'Stories' && s.day === '2026-10-07')).toBe(true);
    expect(empty.body.every((s: any) => s.day >= '2026-10-05' && s.day <= '2026-11-04')).toBe(true);
  });
});
