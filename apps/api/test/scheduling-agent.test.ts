import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createEnv, inDays, type Actor, type Env } from './helpers.js';

/**
 * The agent may schedule what people approved, where the brand allows it (agent.can_schedule_approved): from inside one of its runs,
 * only an approved version, only on accounts the approval covers, at a time a person could choose. It never approves, never schedules
 * what is not approved, and never cancels or moves anything.
 */
let env: Env;
let bot: Actor;
beforeAll(async () => {
  env = await createEnv();
  const tok = await env.call(env.users.admin, 'POST', `/api/brands/${env.brandId}/tokens`, { name: 'Scheduling agent' });
  bot = { id: 'bot', email: 'bot', bearer: tok.body.token };
  await env.call(env.users.admin, 'PATCH', `/api/brands/${env.brandId}`, { agent: { max_cost_per_piece: 5, max_cost_per_month: 100 } });
});
afterAll(async () => { await env.close(); });

const allow = (on: boolean) => env.call(env.users.admin, 'PATCH', `/api/brands/${env.brandId}`, { agent: { can_schedule_approved: on } });
async function approvedPiece(accounts = [env.accounts.instagram]) {
  const { pieceId, variantId } = await env.makePiece(env.users.producer);
  const v = await env.newVersion(env.users.producer, variantId);
  expect((await env.approve(env.users.approver, v.body.id, accounts)).status).toBe(201);
  return { pieceId, variantId, versionId: v.body.id as string };
}
const startRun = (pieceId: string, trigger = 'version.approved') => env.call(bot, 'POST', `/api/pieces/${pieceId}/agent-runs`, { trigger });
const scheduleAs = (who: Actor, versionId: string, body: Record<string, unknown>) => env.call(who, 'POST', `/api/versions/${versionId}/publications`, body);

describe('the agent scheduling what is approved', () => {
  it('is refused while the brand does not allow it, and outside a run on the piece', async () => {
    const { pieceId, versionId } = await approvedPiece();
    const run = await startRun(pieceId);
    expect(run.status, JSON.stringify(run.body)).toBe(201);
    const off = await scheduleAs(bot, versionId, { accountId: env.accounts.instagram, scheduledAt: inDays(3) });
    expect(off.status).toBe(403);
    expect(off.body.error).toMatchObject({ code: 'agent_cannot_schedule', message: 'This brand does not let the agent schedule: an admin can allow it in Settings › Agent' });
    await env.call(bot, 'POST', `/api/agent-runs/${run.body.id}/finish`, { outcome: 'aborted' });

    expect((await allow(true)).body.agent.can_schedule_approved).toBe(true);
    const noRun = await scheduleAs(bot, versionId, { accountId: env.accounts.instagram, scheduledAt: inDays(3) });
    expect(noRun.status).toBe(409);
    expect(noRun.body.error.code).toBe('no_run');
    // A run on another piece does not cover this one.
    const other = await approvedPiece();
    const elsewhere = await startRun(other.pieceId);
    expect((await scheduleAs(bot, versionId, { accountId: env.accounts.instagram, scheduledAt: inDays(3) })).body.error.code).toBe('no_run');
    await env.call(bot, 'POST', `/api/agent-runs/${elsewhere.body.id}/finish`, { outcome: 'aborted' });
    // Only an admin changes the setting.
    expect((await env.call(env.users.approver, 'PATCH', `/api/brands/${env.brandId}`, { agent: { can_schedule_approved: false } })).status).toBe(403);
  });

  it('inside a run, schedules an approved version on an approved account, marked and recorded as the agent\'s', async () => {
    await allow(true);
    const { pieceId, versionId } = await approvedPiece([env.accounts.instagram, env.accounts.facebook]);
    const run = await startRun(pieceId);
    // What a person would be told before scheduling, the agent can ask too.
    const check = await env.call(bot, 'POST', `/api/versions/${versionId}/publications/validate`, { accountId: env.accounts.instagram, scheduledAt: inDays(3) });
    expect(check.status).toBe(200);
    const r = await scheduleAs(bot, versionId, { accountId: env.accounts.instagram, scheduledAt: inDays(3, 18), text: 'Picked by the agent' });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body).toMatchObject({ scheduled_by: 'agent', created_by: null, text: 'Picked by the agent', status: 'scheduled' });
    expect((await env.db.one('select created_by_token from publication where id = $1', [r.body.id]))!.created_by_token).toBeTruthy();
    const trail = (await env.db.one(`select actor_user_id, actor_token_id, after from audit_event where action = 'publication.scheduled' and entity_id = $1`, [r.body.id]))!;
    expect(trail).toMatchObject({ actor_user_id: null, after: { scheduled_by: 'agent' } });
    expect(trail.actor_token_id).toBeTruthy();
    const day = inDays(3, 18).slice(0, 10);
    const cal = (await env.call(env.users.reader, 'GET', `/api/brands/${env.brandId}/calendar?from=${day}&to=${day}`)).body;
    expect(cal.publications.find((p: any) => p.id === r.body.id)).toMatchObject({ scheduled_by: 'agent', scheduled_by_name: 'Scheduling agent' });
    expect((await env.call(env.users.reader, 'GET', `/api/pieces/${pieceId}`)).body.publications[0]).toMatchObject({ scheduled_by: 'agent', scheduled_by_name: 'Scheduling agent' });

    // Never an account the approval does not cover, a time a person could not choose, or a version that is not approved.
    expect((await scheduleAs(bot, versionId, { accountId: env.accounts.youtube, scheduledAt: inDays(4) })).body.error.code).toBe('account_not_approved');
    expect((await scheduleAs(bot, versionId, { accountId: env.accounts.facebook, scheduledAt: new Date(Date.now() - 60_000).toISOString() })).body.error.code).toBe('past_date');
    await env.call(env.users.approver, 'POST', `/api/brands/${env.brandId}/blocked-dates`, { day: inDays(5).slice(0, 10), reason: '' });
    expect((await scheduleAs(bot, versionId, { accountId: env.accounts.facebook, scheduledAt: inDays(5) })).body.error.code).toBe('blocked_date');
    await env.call(env.users.approver, 'POST', `/api/brands/${env.brandId}/pause`, { paused: true });
    expect((await scheduleAs(bot, versionId, { accountId: env.accounts.facebook, scheduledAt: inDays(6) })).body.error.code).toBe('brand_paused');
    await env.call(env.users.approver, 'POST', `/api/brands/${env.brandId}/pause`, { paused: false });
    await env.call(bot, 'POST', `/api/agent-runs/${run.body.id}/finish`, { outcome: 'scheduled', notes: 'Scheduled on Instagram' });
    expect((await env.db.one('select outcome from agent_run where id = $1', [run.body.id]))!.outcome).toBe('scheduled');
  });

  it('never touches what is not approved, approves, cancels or moves anything, its own included', async () => {
    await allow(true);
    const { pieceId, variantId } = await env.makePiece(env.users.producer);
    const v = await env.newVersion(env.users.producer, variantId);
    const run = await startRun(pieceId);
    expect((await scheduleAs(bot, v.body.id, { accountId: env.accounts.instagram, scheduledAt: inDays(3) })).body.error.code).toBe('not_approved');
    expect((await env.approve(bot, v.body.id)).status).toBe(403);
    await env.approve(env.users.approver, v.body.id, [env.accounts.instagram]);
    const mine = await scheduleAs(bot, v.body.id, { accountId: env.accounts.instagram, scheduledAt: inDays(7) });
    expect(mine.status).toBe(201);
    const persons = await scheduleAs(env.users.approver, v.body.id, { accountId: env.accounts.instagram, scheduledAt: inDays(8) });
    expect(persons.body.scheduled_by).toBe('person');
    for (const id of [mine.body.id, persons.body.id]) {
      expect((await env.call(bot, 'PATCH', `/api/publications/${id}`, { scheduledAt: inDays(9) })).status).toBe(403);
      expect((await env.call(bot, 'POST', `/api/publications/${id}/cancel`)).status).toBe(403);
    }
    await env.call(bot, 'POST', `/api/agent-runs/${run.body.id}/finish`, { outcome: 'scheduled' });
  });

  it('runs that only schedule are not rounds of changes, and no version is uploaded inside one', async () => {
    await env.call(env.users.admin, 'PATCH', `/api/brands/${env.brandId}`, { agent: { max_rounds: 1 } });
    try {
      const { pieceId, variantId } = await env.makePiece(env.users.producer);
      await env.newVersion(env.users.producer, variantId);
      // One round of changes used up.
      const round = await startRun(pieceId, 'version.changes_requested');
      expect(round.body.round).toBe(1);
      await env.call(bot, 'POST', `/api/agent-runs/${round.body.id}/finish`, { outcome: 'failed' });
      expect((await startRun(pieceId, 'version.changes_requested')).body.error.code).toBe('rounds_exhausted');
      // A scheduling run still starts, and does not count.
      const sched = await startRun(pieceId);
      expect(sched.status, JSON.stringify(sched.body)).toBe(201);
      expect(sched.body.round).toBe(1);
      const up = await env.newVersion(bot, variantId);
      expect(up.status).toBe(409);
      expect(up.body.error.code).toBe('no_run');
      await env.call(bot, 'POST', `/api/agent-runs/${sched.body.id}/finish`, { outcome: 'needs_people' });
      const view = (await env.call(env.users.approver, 'GET', `/api/pieces/${pieceId}/agent`)).body;
      expect(view.rounds).toBe(1);
      expect(view.runs.find((r: any) => r.id === sched.body.id).counted).toBe(false);
    } finally {
      await env.call(env.users.admin, 'PATCH', `/api/brands/${env.brandId}`, { agent: { max_rounds: 3 } });
    }
  });
});
