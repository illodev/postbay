import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createEnv, inDays, type Env } from './helpers.js';

let env: Env;
beforeAll(async () => { env = await createEnv(); });
afterAll(async () => { await env.close(); });

async function approved(accountIds?: string[]) {
  const { users, makePiece, newVersion, approve, accounts } = env;
  const { pieceId, variantId } = await makePiece(users.producer);
  const v = await newVersion(users.producer, variantId);
  const a = await approve(users.approver, v.body.id, accountIds ?? [accounts.instagram, accounts.youtube]);
  expect(a.body.review_state).toBe('approved');
  return { pieceId, variantId, versionId: v.body.id as string };
}

const schedule = (versionId: string, extra: Record<string, unknown> = {}, as = env.users.approver) =>
  env.call(as, 'POST', `/api/versions/${versionId}/publications`, {
    accountId: env.accounts.instagram, scheduledAt: inDays(5), text: 'Hello world', ...extra,
  });

describe('scheduling', () => {
  it('only schedules what is approved, for the accounts it was approved for, by approvers', async () => {
    const { users, makePiece, newVersion, accounts } = env;
    const { variantId } = await makePiece(users.producer);
    const draft = await newVersion(users.producer, variantId);
    expect((await schedule(draft.body.id)).body.error.code).toBe('not_approved');

    const { versionId } = await approved([accounts.instagram]);
    expect((await schedule(versionId, { accountId: accounts.youtube })).body.error.code).toBe('account_not_approved');
    expect((await schedule(versionId, {}, users.reviewer)).status).toBe(403);
    expect((await schedule(versionId, {}, users.producer)).status).toBe(403);
    const ok = await schedule(versionId);
    expect(ok.status).toBe(201);
    expect(ok.body.status).toBe('scheduled');
    expect(ok.body.manual).toBe(true);
  });

  it('refuses past dates, blocked dates and a second publication in the same slot', async () => {
    const { users, call, brandId, db } = env;
    const { versionId } = await approved();
    expect((await schedule(versionId, { scheduledAt: '2020-01-01T10:00:00Z' })).body.error.code).toBe('past_date');

    const when = inDays(9, 17); // 17:00Z is 18:00 or 19:00 in Madrid: same local day
    const day = new Date(when).toISOString().slice(0, 10);
    expect((await call(users.reviewer, 'POST', `/api/brands/${brandId}/blocked-dates`, { day, reason: 'Bank holiday' })).status).toBe(403);
    expect((await call(users.approver, 'POST', `/api/brands/${brandId}/blocked-dates`, { day, reason: 'Bank holiday' })).status).toBe(201);
    const blocked = await schedule(versionId, { scheduledAt: when });
    expect(blocked.body.error.code).toBe('blocked_date');
    expect(blocked.body.error.message).toContain('Bank holiday');
    await db.query('delete from blocked_date where brand_id = $1', [brandId]);

    expect((await schedule(versionId, { scheduledAt: when })).status).toBe(201);
    expect((await schedule(versionId, { scheduledAt: when })).body.error.code).toBe('slot_taken');
  });

  it('only allows a dependent publication after the one it depends on', async () => {
    const { users, call } = env;
    const a = await approved();
    const b = await approved();
    const first = await schedule(a.versionId, { scheduledAt: inDays(12) });
    const early = await schedule(b.versionId, { scheduledAt: inDays(11), dependsOn: first.body.id });
    expect(early.body.error.code).toBe('invalid_dependency');
    const later = await schedule(b.versionId, { scheduledAt: inDays(13), dependsOn: first.body.id });
    expect(later.status).toBe(201);
    const blocked = await call(users.approver, 'POST', `/api/publications/${later.body.id}/mark-published`, {});
    expect(blocked.body.error.code).toBe('dependency_pending');
    expect((await call(users.approver, 'POST', `/api/publications/${first.body.id}/mark-published`, {})).status).toBe(200);
    expect((await call(users.approver, 'POST', `/api/publications/${later.body.id}/mark-published`, {})).status).toBe(200);
  });
});

describe('a new version after scheduling', () => {
  it('puts the publication on hold until the new version is approved and it is rescheduled', async () => {
    const { users, call, newVersion, approve, accounts } = env;
    const { variantId, versionId } = await approved();
    const pub = await schedule(versionId, { scheduledAt: inDays(6) });
    const v2 = await newVersion(users.producer, variantId);
    const held = await call(users.approver, 'GET', `/api/publications/${pub.body.id}/pack`);
    expect(held.body.status).toBe('on_hold');
    // On hold, it can be neither moved nor published.
    expect((await call(users.approver, 'PATCH', `/api/publications/${pub.body.id}`, { text: 'x' })).body.error.code).toBe('on_hold');
    expect((await call(users.approver, 'POST', `/api/publications/${pub.body.id}/mark-published`, {})).body.error.code).toBe('invalid_state');
    // The old version cannot bring it back either.
    expect((await call(users.approver, 'POST', `/api/publications/${pub.body.id}/reschedule`, { versionId })).body.error.code).toBe('not_approved');

    await approve(users.approver, v2.body.id, [accounts.instagram]);
    const back = await call(users.approver, 'POST', `/api/publications/${pub.body.id}/reschedule`, { versionId: v2.body.id });
    expect(back.status).toBe(200);
    expect(back.body.status).toBe('scheduled');
    expect(back.body.version_id).toBe(v2.body.id);
  });

  it('tells the approvers about the hold', async () => {
    const { db, users } = env;
    const rows = await db.query(`select 1 from notification where user_id = $1 and kind = 'publication.on_hold'`, [users.approver.id]);
    expect(rows.length).toBeGreaterThan(0);
  });
});

describe('moving, confirming, cancelling and publishing', () => {
  it('moves a publication without confirmation by default', async () => {
    const { users, call } = env;
    const { versionId } = await approved();
    const pub = await schedule(versionId, { scheduledAt: inDays(20) });
    const moved = await call(users.approver, 'PATCH', `/api/publications/${pub.body.id}`, { scheduledAt: inDays(21) });
    expect(moved.body.status).toBe('scheduled');
    expect(new Date(moved.body.scheduled_at).toISOString()).toBe(inDays(21));
    expect((await call(users.reviewer, 'PATCH', `/api/publications/${pub.body.id}`, { scheduledAt: inDays(22) })).status).toBe(403);
  });

  it('when the brand asks for it, a change needs a different approver to confirm', async () => {
    const { users, call, brandId, db } = env;
    await call(users.admin, 'PATCH', `/api/brands/${brandId}`, { rules: { reapprove_on_move: true } });
    const { versionId } = await approved();
    const pub = await schedule(versionId, { scheduledAt: inDays(30) });
    const moved = await call(users.approver, 'PATCH', `/api/publications/${pub.body.id}`, { scheduledAt: inDays(31) });
    expect(moved.body.status).toBe('awaiting_reapproval');
    expect((await call(users.approver, 'POST', `/api/publications/${pub.body.id}/confirm`)).status).toBe(403);
    expect((await call(users.approver, 'POST', `/api/publications/${pub.body.id}/mark-published`, {})).body.error.code).toBe('invalid_state');
    const ok = await call(users.approver2, 'POST', `/api/publications/${pub.body.id}/confirm`);
    expect(ok.body.status).toBe('scheduled');
    await db.query(`update brand set approval_rules = approval_rules || '{"reapprove_on_move":false}' where id = $1`, [brandId]);
  });

  it('cancels a publication and frees its slot', async () => {
    const { users, call } = env;
    const { versionId } = await approved();
    const when = inDays(40);
    const pub = await schedule(versionId, { scheduledAt: when });
    expect((await call(users.approver, 'POST', `/api/publications/${pub.body.id}/cancel`)).body.status).toBe('cancelled');
    expect((await schedule(versionId, { scheduledAt: when })).status).toBe(201);
  });

  it('marks a publication as published with its link, once', async () => {
    const { users, call } = env;
    const { versionId } = await approved();
    const pub = await schedule(versionId, { scheduledAt: inDays(15) });
    const bad = await call(users.approver, 'POST', `/api/publications/${pub.body.id}/mark-published`, { url: 'not a url' });
    expect(bad.status).toBe(400);
    // The link is shown as a clickable link, so only web addresses are accepted.
    const script = await call(users.approver, 'POST', `/api/publications/${pub.body.id}/mark-published`, { url: 'javascript:alert(1)' });
    expect(script.status).toBe(400);
    expect(script.body.error.message).toMatch(/http/);
    const ok = await call(users.approver, 'POST', `/api/publications/${pub.body.id}/mark-published`, { url: 'https://example.com/p/1' });
    expect(ok.body.status).toBe('published');
    expect(ok.body.url).toBe('https://example.com/p/1');
    expect(ok.body.published_by).toBe(users.approver.id);
    expect((await call(users.approver, 'POST', `/api/publications/${pub.body.id}/mark-published`, {})).status).toBe(409);
  });

  it('gives the person publishing by hand the files and the text', async () => {
    const { users, call } = env;
    const { versionId } = await approved();
    const pub = await schedule(versionId, { scheduledAt: inDays(16), text: 'Caption', firstComment: 'Link in bio' });
    const pack = await call(users.reader, 'GET', `/api/publications/${pub.body.id}/pack`);
    expect(pack.body.text).toBe('Caption');
    expect(pack.body.first_comment).toBe('Link in bio');
    expect(pack.body.files).toHaveLength(1);
    expect(pack.body.files[0].url).toContain('name=');
  });
});

describe('pausing a brand', () => {
  it('freezes scheduling and moving without losing the dates, and hides due publications', async () => {
    const { users, call, brandId, db } = env;
    const { versionId } = await approved();
    const pub = await schedule(versionId, { scheduledAt: inDays(50) });
    expect((await call(users.reviewer, 'POST', `/api/brands/${brandId}/pause`, { paused: true })).status).toBe(403);
    expect((await call(users.approver, 'POST', `/api/brands/${brandId}/pause`, { paused: true })).body.paused).toBe(true);
    expect((await schedule(versionId, { scheduledAt: inDays(51) })).body.error.code).toBe('brand_paused');
    expect((await call(users.approver, 'PATCH', `/api/publications/${pub.body.id}`, { scheduledAt: inDays(52) })).body.error.code).toBe('brand_paused');

    // Make it due, then check the due list is empty while paused and full after resuming.
    await db.query(`update publication set scheduled_at = now() - interval '1 minute' where id = $1`, [pub.body.id]);
    expect((await call(users.approver, 'GET', `/api/brands/${brandId}/publications/due`)).body).toHaveLength(0);
    await call(users.approver, 'POST', `/api/brands/${brandId}/pause`, { paused: false });
    const due = await call(users.approver, 'GET', `/api/brands/${brandId}/publications/due`);
    expect(due.body.map((d: any) => d.id)).toContain(pub.body.id);
    const stored = await db.one('select scheduled_at from publication where id = $1', [pub.body.id]);
    expect(new Date(stored!.scheduled_at).getTime()).toBeLessThan(Date.now());
  });
});

describe('calendar', () => {
  it('expands fixed slots at the brand local time across a clock change and shows what is filled', async () => {
    const { users, call, brandId, accounts, makePiece, newVersion, approve } = env;
    // Tuesdays and Thursdays at 19:00 on Instagram.
    for (const weekday of [2, 4]) {
      const r = await call(users.admin, 'POST', `/api/brands/${brandId}/slots`, { accountId: accounts.instagram, weekday, localTime: '19:00', label: 'Reels' });
      expect(r.status).toBe(201);
    }
    expect((await call(users.approver, 'POST', `/api/brands/${brandId}/slots`, { accountId: accounts.instagram, weekday: 1, localTime: '10:00' })).status).toBe(403);

    // 2030-03-26 is a Tuesday and 2030-04-02 the following one; clocks go forward on 2030-03-31.
    const cal = await call(users.reader, 'GET', `/api/brands/${brandId}/calendar?from=2030-03-25&to=2030-04-04`);
    expect(cal.body.timezone).toBe('Europe/Madrid');
    const at = cal.body.slots.map((s: any) => [s.day, s.at]);
    expect(at).toEqual([
      ['2030-03-26', '2030-03-26T18:00:00.000Z'],
      ['2030-03-28', '2030-03-28T18:00:00.000Z'],
      ['2030-04-02', '2030-04-02T17:00:00.000Z'],
      ['2030-04-04', '2030-04-04T17:00:00.000Z'],
    ]);
    expect(cal.body.slots.every((s: any) => !s.filled && !s.past)).toBe(true);

    // Schedule into the first slot: it shows as filled and drops out of the empty list.
    const { variantId } = await makePiece(users.producer);
    const v = await newVersion(users.producer, variantId);
    await approve(users.approver, v.body.id, [accounts.instagram]);
    const pub = await call(users.approver, 'POST', `/api/versions/${v.body.id}/publications`, { accountId: accounts.instagram, scheduledAt: '2030-03-26T18:00:00Z' });
    expect(pub.status).toBe(201);
    const after = await call(users.reader, 'GET', `/api/brands/${brandId}/calendar?from=2030-03-25&to=2030-04-04`);
    expect(after.body.slots.filter((s: any) => s.filled).map((s: any) => s.day)).toEqual(['2030-03-26']);
    expect(after.body.publications).toHaveLength(1);
    const empty = await call(users.producer, 'GET', `/api/brands/${brandId}/slots?status=empty&from=2030-03-25&to=2030-04-04`);
    expect(empty.body.map((s: any) => s.day)).toEqual(['2030-03-28', '2030-04-02', '2030-04-04']);
  });

  it('rejects absurd ranges', async () => {
    const { users, call, brandId } = env;
    expect((await call(users.reader, 'GET', `/api/brands/${brandId}/calendar?from=2030-01-01&to=2032-01-01`)).body.error.code).toBe('invalid_range');
    expect((await call(users.reader, 'GET', `/api/brands/${brandId}/calendar?from=2030-02-01&to=2030-01-01`)).body.error.code).toBe('invalid_range');
  });
});
