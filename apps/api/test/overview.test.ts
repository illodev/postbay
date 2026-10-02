import { DateTime } from 'luxon';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createEnv, type Actor, type Env } from './helpers.js';

let env: Env;
let agent: Actor;

beforeAll(async () => {
  env = await createEnv();
  const tok = await env.call(env.users.admin, 'POST', `/api/brands/${env.brandId}/tokens`, { name: 'Agent runner' });
  agent = { id: 'tok', email: 'agent', bearer: tok.body.token };
  const limits = await env.call(env.users.admin, 'PATCH', `/api/brands/${env.brandId}`, {
    agent: { max_rounds: 3, max_cost_per_piece: 5, max_cost_per_month: 20, max_run_minutes: 30, currency: 'USD', slot_alert_days: 3 },
  });
  expect(limits.status, JSON.stringify(limits.body)).toBe(200);
});
afterAll(async () => { await env.close(); });

const overview = async (as: Actor) => {
  const r = await env.call(as, 'GET', `/api/brands/${env.brandId}/overview`);
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return r.body;
};
const waitingIds = (o: { awaiting: { version_id: string }[] }) => o.awaiting.map((a) => a.version_id);

/** Writes a publication straight into the table: these tests are about what the overview shows, not about scheduling. */
async function publication(versionId: string, o: { at: Date; status: string; manual?: boolean; account?: string; error?: string; errorClass?: string; movedBy?: string }) {
  const v = (await env.db.one<{ variant_id: string }>('select variant_id from version where id = $1', [versionId]))!;
  const row = await env.db.one<{ id: string }>(
    `insert into publication (variant_id, social_account_id, version_id, scheduled_at, status, manual, created_by, last_error, last_error_class, failed_at, moved_by, hold_reason)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,case when $5 = 'failed' then now() end,$10,case when $5 = 'on_hold' then 'A new version is awaiting approval' end) returning id`,
    [v.variant_id, o.account ?? env.accounts.instagram, versionId, o.at, o.status, o.manual ?? true, env.users.admin.id, o.error ?? null, o.errorClass ?? null, o.movedBy ?? null],
  );
  return row!.id;
}

describe('what waits for a decision', () => {
  it('lists the versions in review for an approver, without their own uploads or the ones they already decided on', async () => {
    const { users, makePiece, newVersion, approve, call, db, brandId } = env;
    const a = await makePiece(users.producer);
    const va = (await newVersion(users.producer, a.variantId)).body;
    const b = await makePiece(users.approver);
    const vb = (await newVersion(users.approver, b.variantId)).body;

    const mine = await overview(users.approver);
    expect(mine.awaiting_mode).toBe('approve');
    expect(waitingIds(mine)).toContain(va.id);
    expect(waitingIds(mine)).not.toContain(vb.id); // their own upload: they cannot approve it
    expect(waitingIds(await overview(users.approver2))).toEqual(expect.arrayContaining([va.id, vb.id]));

    const item = mine.awaiting.find((x: { version_id: string }) => x.version_id === va.id);
    expect(item).toMatchObject({
      version_number: 1, piece_id: a.pieceId, piece_kind: 'video', variant_format: '9:16', by_agent: false, author: 'producer',
      open_comments: 0, resolves: 0, earlier_comments: 0, thumb: `/api/versions/${va.id}/thumb?w=240`,
    });

    // With two approvals needed, a version stays in review after the first, but no longer waits for whoever gave it.
    await db.query(`update brand set approval_rules = '{"required_approvals":2,"reapprove_on_move":false,"checklist":[]}' where id = $1`, [brandId]);
    try {
      expect((await approve(users.approver, va.id)).status).toBe(201);
      expect((await call(users.approver, 'GET', `/api/versions/${va.id}`)).body.review_state).toBe('in_review');
      expect(waitingIds(await overview(users.approver))).not.toContain(va.id);
      expect(waitingIds(await overview(users.approver2))).toContain(va.id);
    } finally {
      await db.query(`update brand set approval_rules = '{"required_approvals":1,"reapprove_on_move":false,"checklist":[]}' where id = $1`, [brandId]);
    }
  });

  it('says how many of the earlier comments a new version resolves', async () => {
    const { users, makePiece, newVersion, call } = env;
    const { variantId } = await makePiece(users.producer);
    const v1 = (await newVersion(users.producer, variantId)).body;
    const c1 = (await call(users.reviewer, 'POST', `/api/versions/${v1.id}/comments`, { body: 'Shorter intro', anchor: { type: 'time', t: 2 } })).body;
    const c2 = (await call(users.reviewer, 'POST', `/api/versions/${v1.id}/comments`, { body: 'Logo in the corner' })).body;
    await call(users.reviewer, 'POST', `/api/versions/${v1.id}/comments`, { body: 'Louder music' });
    expect((await call(users.reviewer, 'POST', `/api/versions/${v1.id}/request-changes`, {})).status).toBe(200);
    const v2 = (await newVersion(users.producer, variantId, [{}], { resolves: [c1.id, c2.id] })).body;
    expect(v2.number).toBe(2);

    const o = await overview(users.approver);
    expect(waitingIds(o)).not.toContain(v1.id);
    expect(o.awaiting.find((x: { version_id: string }) => x.version_id === v2.id)).toMatchObject({ version_number: 2, resolves: 2, earlier_comments: 3, open_comments: 1 });
  });

  it('shows a reviewer what they can comment on, and a reader what is in review, saying which it is', async () => {
    const { users, makePiece, newVersion } = env;
    const { variantId } = await makePiece(users.approver);
    const v = (await newVersion(users.approver, variantId)).body;
    const reviewer = await overview(users.reviewer);
    expect(reviewer.awaiting_mode).toBe('comment');
    expect(waitingIds(reviewer)).toContain(v.id);
    const reader = await overview(users.reader);
    expect(reader.awaiting_mode).toBe('view');
    expect(waitingIds(reader)).toContain(v.id);
    expect((await overview(users.producer)).awaiting_mode).toBe('view');
  });
});

describe('what goes out today', () => {
  it('lists today in the brand\'s zone, automatic and by hand, and nothing from tomorrow or cancelled', async () => {
    const { users, makePiece, newVersion } = env;
    const { variantId } = await makePiece(users.producer);
    const v = (await newVersion(users.producer, variantId)).body;
    const day = DateTime.now().setZone('Europe/Madrid').startOf('day');
    const early = await publication(v.id, { at: day.plus({ hours: 0, minutes: 5 }).toJSDate(), status: 'published', manual: false });
    const late = await publication(v.id, { at: day.plus({ hours: 23, minutes: 50 }).toJSDate(), status: 'scheduled', manual: true, account: env.accounts.facebook });
    const tomorrow = await publication(v.id, { at: day.plus({ days: 1, minutes: 5 }).toJSDate(), status: 'scheduled' });
    const cancelled = await publication(v.id, { at: day.plus({ hours: 12 }).toJSDate(), status: 'cancelled', account: env.accounts.youtube });

    const o = await overview(users.reader);
    const ids = o.today.map((x: { id: string }) => x.id);
    expect(ids).toEqual(expect.arrayContaining([early, late]));
    expect(ids).not.toContain(tomorrow);
    expect(ids).not.toContain(cancelled);
    expect(ids.indexOf(early)).toBeLessThan(ids.indexOf(late));
    expect(o.today.find((x: { id: string }) => x.id === early)).toMatchObject({ time: '00:05', status: 'published', manual: false, network: 'instagram', due: false, version_id: v.id });
    expect(o.today.find((x: { id: string }) => x.id === late)).toMatchObject({ time: '23:50', status: 'scheduled', manual: true, network: 'facebook', account_name: 'brand_fb' });
    expect(o.timezone).toBe('Europe/Madrid');
  });
});

describe('what needs attention', () => {
  it('offers to retry a failed automatic publication to whoever can schedule, and nothing to a reader', async () => {
    const { users, makePiece, newVersion } = env;
    const { pieceId, variantId } = await makePiece(users.producer);
    const v = (await newVersion(users.producer, variantId)).body;
    const id = await publication(v.id, { at: new Date(Date.now() - 3600_000), status: 'failed', manual: false, error: 'The network refused the file', errorClass: 'file_rejected' });

    const item = (await overview(users.approver)).attention.find((x: { id: string }) => x.id === id);
    expect(item).toMatchObject({ kind: 'publication_failed', reason: 'file_rejected', detail: 'The network refused the file', piece_id: pieceId, network: 'instagram', action: { type: 'retry', publication_id: id } });
    expect((await overview(users.reviewer)).attention.find((x: { id: string }) => x.id === id).action).toEqual({ type: 'open', to: `/pieces/${pieceId}` });
    expect((await overview(users.reader)).attention.find((x: { id: string }) => x.id === id).action).toBeNull();
  });

  it('points a held publication at the new version that holds it, and asks someone else to confirm a moved date', async () => {
    const { users, makePiece, newVersion } = env;
    const { variantId } = await makePiece(users.producer);
    const v1 = (await newVersion(users.producer, variantId)).body;
    const held = await publication(v1.id, { at: new Date(Date.now() + 86_400_000), status: 'on_hold' });
    const v2 = (await newVersion(users.producer, variantId)).body;
    const moved = await publication(v1.id, { at: new Date(Date.now() + 2 * 86_400_000), status: 'awaiting_reapproval', account: env.accounts.youtube, movedBy: users.approver.id });

    const o = await overview(users.approver2);
    expect(o.attention.find((x: { id: string }) => x.id === held)).toMatchObject({ kind: 'publication_on_hold', reason: 'new_version', version_id: v2.id, action: { type: 'review', to: `/review/${v2.id}` } });
    expect(o.attention.find((x: { id: string }) => x.id === moved)).toMatchObject({ kind: 'publication_awaiting_confirmation', reason: 'moved', action: { type: 'confirm', publication_id: moved } });
    // Whoever moved it cannot confirm it.
    expect((await overview(users.approver)).attention.find((x: { id: string }) => x.id === moved)).toMatchObject({ reason: 'moved_by_you', action: { type: 'open' } });
  });

  it('tells about accounts to reconnect, and the admin alone about failing webhooks', async () => {
    const { users, db, brandId } = env;
    await db.query(`update social_account set status = 'reconnect_required', last_error = 'The token expired' where id = $1`, [env.accounts.youtube]);
    const hook = (await db.one<{ id: string }>(
      `insert into webhook (brand_id, url, events, secret_encrypted, secret_hint, active, disabled_reason, last_failure_at)
       values ($1, 'https://hooks.example.com/x', '{comment.created}', '\\x00', 'abcd', false, 'The receiver answered 410 Gone', now()) returning id`,
      [brandId],
    ))!.id;
    try {
      const admin = await overview(users.admin);
      expect(admin.attention.find((x: { id: string }) => x.id === env.accounts.youtube)).toMatchObject({
        kind: 'account_reconnect', network: 'youtube', account_name: 'brand_yt', detail: 'The token expired', action: { type: 'reconnect', to: '/settings?tab=accounts' },
      });
      expect(admin.attention.find((x: { id: string }) => x.id === hook)).toMatchObject({ kind: 'webhook_failing', reason: 'disabled', action: { type: 'webhooks' } });
      const approver = await overview(users.approver);
      expect(approver.attention.find((x: { id: string }) => x.id === env.accounts.youtube).action).toBeNull();
      expect(approver.attention.find((x: { id: string }) => x.id === hook)).toBeUndefined();
    } finally {
      await db.query(`update social_account set status = 'manual', last_error = null where id = $1`, [env.accounts.youtube]);
      await db.query('delete from webhook where id = $1', [hook]);
    }
  });

  it('lists a piece the agent handed back until a person takes it up', async () => {
    const { users, makePiece, newVersion, call } = env;
    const { pieceId, variantId } = await makePiece(users.producer);
    await newVersion(users.producer, variantId);
    const run = await call(agent, 'POST', `/api/pieces/${pieceId}/agent-runs`, { trigger: 'version.changes_requested' });
    expect(run.status, JSON.stringify(run.body)).toBe(201);
    expect((await call(agent, 'POST', `/api/agent-runs/${run.body.id}/finish`, { outcome: 'needs_people', cost: 0.1, notes: 'I cannot change the voice without the new line.\nWhich one?' })).status).toBe(200);

    const o = await overview(users.approver);
    expect(o.attention.find((x: { id: string }) => x.id === run.body.id)).toMatchObject({
      kind: 'agent_needs_person', reason: 'agent_declined', piece_id: pieceId, detail: 'I cannot change the voice without the new line.\nWhich one?', action: { type: 'open', to: `/pieces/${pieceId}` },
    });
    expect(o.activity.find((x: { id: string }) => x.id === run.body.id)).toMatchObject({ kind: 'agent_handed', by_agent: true, actor: 'Agent runner', text: 'I cannot change the voice without the new line.' });

    await newVersion(users.producer, variantId);
    expect((await overview(users.approver)).attention.find((x: { id: string }) => x.id === run.body.id)).toBeUndefined();
  });
});

describe('what just happened', () => {
  it('tells comments with their moment, versions by the agent, approvals with their networks, changes asked for and posts that went out', async () => {
    const { users, makePiece, newVersion, approve, call } = env;
    const { pieceId, variantId } = await makePiece(users.producer);
    const v1 = (await newVersion(users.producer, variantId)).body;
    const c = (await call(users.reviewer, 'POST', `/api/versions/${v1.id}/comments`, { body: 'The referee covers the figure\non the phone', anchor: { type: 'time', t: 3.5, t_end: 5 } })).body;
    expect((await call(users.reviewer, 'POST', `/api/versions/${v1.id}/request-changes`, {})).status).toBe(200);
    const run = (await call(agent, 'POST', `/api/pieces/${pieceId}/agent-runs`, { trigger: 'version.changes_requested' })).body;
    const v2 = (await newVersion(agent, variantId, [{}], { resolves: [c.id] })).body;
    expect(v2.number, JSON.stringify(v2)).toBe(2);
    await call(agent, 'POST', `/api/agent-runs/${run.id}/finish`, { outcome: 'uploaded', cost: 0.2, versionId: v2.id });
    expect((await approve(users.approver, v2.id, [env.accounts.instagram, env.accounts.facebook])).status).toBe(201);
    const pub = await publication(v2.id, { at: new Date(), status: 'published', manual: false });

    const o = await overview(users.reader);
    expect(o.activity.length).toBeLessThanOrEqual(20);
    const ats = o.activity.map((x: { at: string }) => x.at);
    expect([...ats].sort().reverse()).toEqual(ats);
    const find = (kind: string, id: string) => o.activity.find((x: { kind: string; id: string }) => x.kind === kind && x.id === id);
    expect(find('comment', c.id)).toMatchObject({ actor: 'reviewer', by_agent: false, piece_id: pieceId, version_number: 1, text: 'The referee covers the figure', t: 3.5, t_end: 5, page: null });
    expect(o.activity.find((x: { kind: string; version_id: string }) => x.kind === 'changes_requested' && x.version_id === v1.id)).toMatchObject({ actor: 'reviewer', version_number: 1 });
    expect(find('version', v2.id)).toMatchObject({ actor: 'Agent runner', by_agent: true, version_number: 2, resolves: 1 });
    expect(o.activity.find((x: { kind: string; version_id: string }) => x.kind === 'approved' && x.version_id === v2.id)).toMatchObject({ actor: 'approver', networks: ['facebook', 'instagram'] });
    expect(find('published', pub)).toMatchObject({ actor: null, networks: ['instagram'], account_name: 'brand_ig' });
  });
});

describe('who may ask', () => {
  it('is for signed-in members of the brand', async () => {
    expect((await env.call(agent, 'GET', `/api/brands/${env.brandId}/overview`)).status).toBe(403);
    const other = (await env.db.one<{ id: string }>(`insert into brand (workspace_id, name, timezone) values ($1, 'Other', 'Europe/Madrid') returning id`, [env.workspaceId]))!.id;
    expect((await env.call(env.users.approver, 'GET', `/api/brands/${other}/overview`)).status).toBe(404);
    expect((await env.call(null, 'GET', `/api/brands/${env.brandId}/overview`)).status).toBe(401);
  });
});
