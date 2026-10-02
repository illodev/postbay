import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createEnv, type Actor, type Env } from './helpers.js';

let env: Env;
let agent: Actor;
const T0 = new Date('2026-10-05T08:00:00.000Z');

beforeAll(async () => {
  env = await createEnv({}, { fakes: true });
  const tok = await env.call(env.users.admin, 'POST', `/api/brands/${env.brandId}/tokens`, { name: 'Agent runner' });
  agent = { id: 'tok', email: 'agent', bearer: tok.body.token };
});
afterAll(async () => { await env.close(); });
beforeEach(async () => {
  env.clock.set(T0);
  await env.db.query('delete from agent_run');
  await env.db.query(`delete from notification where kind like 'agent.%'`);
  await limits({ max_rounds: 3, max_cost_per_piece: 5, max_cost_per_month: 20, max_run_minutes: 30, currency: 'USD', slot_alert_days: 3 });
});

const admin = () => env.users.admin;
const limits = async (agentSettings: Record<string, unknown>) => {
  const r = await env.call(admin(), 'PATCH', `/api/brands/${env.brandId}`, { agent: agentSettings });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return r.body;
};
const piece = async () => (await env.makePiece(env.users.producer, 'video', '9:16')).pieceId;
const start = (pieceId: string, body: Record<string, unknown> = { trigger: 'version.changes_requested' }, as: Actor = agent) =>
  env.call(as, 'POST', `/api/pieces/${pieceId}/agent-runs`, body);
const finish = (runId: string, body: Record<string, unknown>, as: Actor = agent) => env.call(as, 'POST', `/api/agent-runs/${runId}/finish`, body);
const summary = async (pieceId: string) => (await env.call(env.users.approver, 'GET', `/api/pieces/${pieceId}/agent`)).body;
const told = (kind: string) => env.db.query(`select user_id, payload from notification where kind = $1`, [kind]);

/** Runs a full round that costs `cost`, as the runner would. */
async function round(pieceId: string, cost = 0, outcome: string = 'needs_people') {
  const s = await start(pieceId, { trigger: 'version.changes_requested', eventId: randomUUID() });
  expect(s.status, JSON.stringify(s.body)).toBe(201);
  const f = await finish(s.body.id, { outcome, cost });
  expect(f.status, JSON.stringify(f.body)).toBe(200);
  return s.body;
}

describe('the agent settings', () => {
  it('start with three rounds and no budget, and are the admin\'s to change', async () => {
    const fresh = await env.db.one(`select agent from brand where id = $1`, [env.brandId]);
    expect(Object.keys(fresh!.agent)).toContain('max_rounds');
    await env.db.query(`update brand set agent = '{"max_rounds":3,"max_cost_per_piece":null,"max_cost_per_month":null,"max_run_minutes":30,"slot_alert_days":3,"currency":"USD"}' where id = $1`, [env.brandId]);
    const got = await env.call(admin(), 'GET', `/api/brands/${env.brandId}`);
    expect(got.body.agent).toEqual({ max_rounds: 3, max_cost_per_piece: null, max_cost_per_month: null, max_run_minutes: 30, slot_alert_days: 3, currency: 'USD' });

    const set = await limits({ max_rounds: 5, max_cost_per_piece: 2.5, currency: 'EUR' });
    expect(set.agent).toMatchObject({ max_rounds: 5, max_cost_per_piece: 2.5, currency: 'EUR', max_run_minutes: 30 }); // the rest is kept
    for (const bad of [{ max_rounds: 0 }, { max_rounds: 11 }, { max_cost_per_piece: -1 }, { max_run_minutes: 0 }, { max_run_minutes: 500 }, { slot_alert_days: 31 }, { currency: '' }]) {
      expect((await env.call(admin(), 'PATCH', `/api/brands/${env.brandId}`, { agent: bad })).status, JSON.stringify(bad)).toBe(400);
    }
    for (const who of [env.users.approver, env.users.reviewer, agent]) {
      expect((await env.call(who, 'PATCH', `/api/brands/${env.brandId}`, { agent: { max_rounds: 9 } })).status).toBe(403);
    }
    const trail = await env.db.query(`select after from audit_event where action = 'brand.updated' order by id desc limit 1`);
    expect(trail[0]!.after.agent.max_rounds).toBe(5);
  });
});

describe('starting a run', () => {
  it('hands back the round, the limits and a lease', async () => {
    const id = await piece();
    const r = await start(id, { trigger: 'version.changes_requested' });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ round: 1, maxRounds: 3, limits: { maxMinutes: 30, maxCost: 5, currency: 'USD' } });
    expect(new Date(r.body.leaseUntil).getTime() - T0.getTime()).toBe(35 * 60_000); // the time allowed, and a few minutes of grace
    const row = (await env.db.one('select * from agent_run where id = $1', [r.body.id]))!;
    expect(row).toMatchObject({ status: 'running', piece_id: id, trigger: 'version.changes_requested' });
    expect((await env.db.query(`select 1 from audit_event where action = 'agent.started' and entity_id = $1`, [r.body.id]))).toHaveLength(1);
  });

  it('is for producer tokens of the brand, not people and not other brands', async () => {
    const id = await piece();
    expect((await start(id, { trigger: 'x' }, admin())).status).toBe(403);
    expect((await start(id, { trigger: 'x' }, env.users.producer)).status).toBe(403);
    expect((await env.call(null, 'POST', `/api/pieces/${id}/agent-runs`, { trigger: 'x' })).status).toBe(401);

    const other = await env.db.one(`insert into brand (workspace_id, name, timezone) values ($1,'Other','UTC') returning id`, [env.workspaceId]);
    const otherUser = (await env.db.one(`insert into app_user (email) values ('other-admin@example.com') returning id`))!;
    const secret = `est_${randomBytes(24).toString('base64url')}`;
    const { hashToken } = await import('../src/services/brand.js');
    await env.db.query(`insert into api_token (brand_id, name, token_hash, created_by, expires_at) values ($1,'other',$2,$3, now() + interval '1 day')`, [other!.id, hashToken(secret), otherUser.id]);
    expect((await start(id, { trigger: 'x' }, { id: 'o', email: 'o', bearer: secret })).status).toBe(404);
    expect((await start(randomUUID(), { trigger: 'x' })).status).toBe(404);
  });

  it('refuses to start on a discarded piece', async () => {
    const id = await piece();
    await env.call(env.users.approver, 'POST', `/api/pieces/${id}/discard`);
    const r = await start(id);
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('piece_discarded');
  });

  it('does not start without budgets, says so once per event, and tells the people who can fix it', async () => {
    await limits({ max_cost_per_piece: null });
    const id = await piece();
    const eventId = randomUUID();
    for (let i = 0; i < 3; i++) {
      const r = await start(id, { trigger: 'version.changes_requested', eventId });
      expect(r.status).toBe(409);
      expect(r.body.error.code).toBe('budget_not_set');
    }
    expect(await env.db.query(`select 1 from agent_run where piece_id = $1`, [id])).toHaveLength(1);
    const to = (await told('agent.needs_person')).map((n) => n.user_id).sort();
    expect(to).toEqual([env.users.admin.id, env.users.approver.id, env.users.approver2.id].sort()); // approvers and admins, not reviewers or producers
    expect((await told('agent.needs_person'))[0]!.payload).toMatchObject({ pieceId: id, reason: 'budget_not_set' });
    await limits({ max_cost_per_piece: 5, max_cost_per_month: null });
    expect((await start(id, { trigger: 'x' })).body.error.code).toBe('budget_not_set');
  });
});

describe('one agent per piece', () => {
  it('lets a second one wait while the first works, and go once it has finished', async () => {
    const id = await piece();
    const first = await start(id);
    const second = await start(id);
    expect(second.status).toBe(409);
    expect(second.body.error).toMatchObject({ code: 'piece_busy', details: { runId: first.body.id } });
    await finish(first.body.id, { outcome: 'needs_people' });
    expect((await start(id)).status).toBe(201);
  });

  it('is enforced by the database even if two ask at the same instant', async () => {
    const id = await piece();
    const results = await Promise.all([start(id), start(id), start(id)]);
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(results.filter((r) => r.body?.error?.code === 'piece_busy')).toHaveLength(2);
    await expect(env.db.query(`insert into agent_run (brand_id, piece_id, token_id, trigger) select brand_id, piece_id, token_id, 'x' from agent_run where piece_id = $1`, [id])).rejects.toThrow(/agent_run_one_running/);
  });

  it('does not hold a piece for ever when the runner stops reporting', async () => {
    const id = await piece();
    const first = await start(id);
    env.clock.advance(34 * 60_000);
    expect((await start(id)).body.error.code).toBe('piece_busy'); // still inside its lease
    env.clock.advance(2 * 60_000);
    const next = await start(id);
    expect(next.status).toBe(201);
    expect(next.body.round).toBe(2); // the abandoned run used a round
    const stale = (await env.db.one('select status, outcome, notes from agent_run where id = $1', [first.body.id]))!;
    expect(stale).toMatchObject({ status: 'finished', outcome: 'timeout' });
    expect((await finish(first.body.id, { outcome: 'uploaded' })).status).toBe(409); // the late runner cannot report a closed run
  });

  it('keeps the lease ahead while the runner reports in', async () => {
    const id = await piece();
    const r = await start(id);
    env.clock.advance(30 * 60_000);
    const beat = await env.call(agent, 'POST', `/api/agent-runs/${r.body.id}/heartbeat`);
    expect(beat.status).toBe(200);
    env.clock.advance(4 * 60_000);
    expect((await start(id)).body.error.code).toBe('piece_busy'); // five minutes from the last heartbeat
    await finish(r.body.id, { outcome: 'failed' });
    expect((await env.call(agent, 'POST', `/api/agent-runs/${r.body.id}/heartbeat`)).status).toBe(409);
  });
});

describe('the round cap', () => {
  it('sends the piece to a person after three rounds, and says so once per request', async () => {
    const id = await piece();
    for (let n = 1; n <= 3; n++) expect((await round(id)).round).toBe(n);
    expect((await summary(id))).toMatchObject({ rounds: 3, max_rounds: 3, status: 'idle' });

    const eventId = randomUUID();
    const refused = await start(id, { trigger: 'version.changes_requested', eventId });
    expect(refused.status).toBe(409);
    expect(refused.body.error).toMatchObject({ code: 'rounds_exhausted', details: { rounds: 3, maxRounds: 3 } });
    await start(id, { trigger: 'version.changes_requested', eventId }); // the runner asks again
    // (the three rounds above ended as "needs a person" too, which is told separately: only the refusal counts here)
    expect((await told('agent.needs_person')).filter((n) => n.payload.reason === 'rounds_exhausted')).toHaveLength(3); // the two approvers and the admin, once
    const s = await summary(id);
    expect(s).toMatchObject({ rounds: 3, status: 'needs_person', blocked_reason: 'rounds_exhausted' });
    expect(s.blocked_message).toContain('3 rounds');
    expect(s.runs[0]).toMatchObject({ outcome: 'blocked', counted: false });
  });

  it('does not count a run that was aborted before it did anything, nor a refusal', async () => {
    const id = await piece();
    await round(id, 0, 'aborted');
    await round(id);
    await round(id);
    expect((await summary(id)).rounds).toBe(2);
    expect((await start(id)).status).toBe(201); // a third round is still there
  });

  it('can be given again by a person, who takes the piece back and hands it over', async () => {
    const id = await piece();
    for (let n = 0; n < 3; n++) await round(id);
    await start(id, { trigger: 'x', eventId: randomUUID() });
    expect((await summary(id)).status).toBe('needs_person');

    for (const who of [env.users.reviewer, env.users.producer, agent]) {
      expect((await env.call(who, 'POST', `/api/pieces/${id}/agent/reset`)).status).toBe(403);
    }
    const back = await env.call(env.users.approver, 'POST', `/api/pieces/${id}/agent/reset`);
    expect(back.status).toBe(200);
    expect(back.body).toMatchObject({ rounds: 0, status: 'idle' });
    env.clock.advance(1000);
    expect((await start(id)).body.round).toBe(1);
    expect((await env.db.query(`select 1 from audit_event where action = 'agent.rounds_reset' and entity_id = $1`, [id]))).toHaveLength(1);
  });

  it('sends the pending request for changes to the agent again when it is handed back, and only then', async () => {
    const { users } = env;
    const { pieceId, variantId } = await env.makePiece(users.producer, 'video', '9:16');
    const v = await env.newVersion(users.producer, variantId);
    await env.call(users.reviewer, 'POST', `/api/versions/${v.body.id}/comments`, { body: 'Brighter', anchor: { type: 'time', t: 1 } });
    await env.call(users.reviewer, 'POST', `/api/versions/${v.body.id}/comments`, { body: 'Only for Ana', peopleOnly: true });
    await env.call(users.reviewer, 'POST', `/api/versions/${v.body.id}/request-changes`, {});
    await env.db.query('delete from event');
    for (let n = 0; n < 3; n++) await round(pieceId);
    await start(pieceId, { trigger: 'x', eventId: randomUUID() });
    expect(await env.db.query('select 1 from event')).toHaveLength(0); // nothing is sent just because it was refused

    expect((await env.call(users.approver, 'POST', `/api/pieces/${pieceId}/agent/reset`)).status).toBe(200);
    const events = await env.db.query(`select type, data from event`);
    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe('version.changes_requested');
    expect(events[0]!.data).toMatchObject({ reason: 'agent_reset', piece: { id: pieceId }, version: { id: v.body.id }, people_only_open: 1 });
    expect(events[0]!.data.comments.map((c: any) => c.body)).toEqual(['Brighter', 'Only for Ana']);

    // A piece that is not waiting for changes has nothing to send.
    const other = await piece();
    await env.db.query('delete from event');
    await env.call(users.approver, 'POST', `/api/pieces/${other}/agent/reset`);
    expect(await env.db.query('select 1 from event')).toHaveLength(0);
  });

  it('stops waiting for a person once a person uploads a new version', async () => {
    const id = await piece();
    for (let n = 0; n < 3; n++) await round(id);
    await start(id, { trigger: 'x', eventId: randomUUID() });
    expect((await summary(id)).status).toBe('needs_person');
    const variant = (await env.db.one('select id from variant where piece_id = $1', [id]))!;
    env.clock.advance(1000);
    // (versions are stamped by the database's own clock, which this test does not move)
    await env.db.query(`update agent_run set started_at = now() - interval '1 minute' where piece_id = $1 and outcome = 'blocked'`, [id]);
    await env.newVersion(env.users.producer, variant.id, [{ data: Buffer.from('a person made this') }]);
    expect((await summary(id)).status).toBe('idle');
  });
});

describe('budgets', () => {
  it('stop the agent at the budget of a piece, and tell it how much is left before that', async () => {
    const id = await piece();
    await limits({ max_cost_per_piece: 3, max_cost_per_month: 100 });
    const a = await start(id);
    expect(a.body.limits.maxCost).toBe(3);
    await finish(a.body.id, { outcome: 'uploaded', cost: 1.25, versionId: await versionOf(id) });
    const b = await start(id);
    expect(b.body.limits.maxCost).toBe(1.75);
    await finish(b.body.id, { outcome: 'needs_people', cost: 1.75 });
    const c = await start(id);
    expect(c.status).toBe(409);
    expect(c.body.error.code).toBe('piece_budget_reached');
    expect(c.body.error.message).toContain('3.00 of 3 USD');
    expect((await summary(id))).toMatchObject({ spent_piece: 3, status: 'needs_person', blocked_reason: 'piece_budget_reached' });
  });

  it('stop it at the monthly budget of the brand, across pieces', async () => {
    await limits({ max_cost_per_piece: 10, max_cost_per_month: 6 });
    const p1 = await piece(), p2 = await piece(), p3 = await piece();
    await round(p1, 4);
    const s = await start(p2);
    expect(s.body.limits.maxCost).toBe(2); // what is left of the month, which is less than the piece budget
    await finish(s.body.id, { outcome: 'needs_people', cost: 2 });
    const r = await start(p3);
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('monthly_budget_reached');
    const brand = await env.call(admin(), 'GET', `/api/brands/${env.brandId}/agent`);
    expect(brand.body.spent_month).toBe(6);
  });

  it('start over with the new month, counted in the brand\'s own time zone', async () => {
    await limits({ max_cost_per_piece: 10, max_cost_per_month: 6 });
    const id = await piece();
    await round(id, 6);
    expect((await start(id)).body.error.code).toBe('monthly_budget_reached');
    // 23:30 UTC on 31 October is already 1 November in Madrid (UTC+1 after the clocks go back).
    env.clock.set(new Date('2026-10-31T23:30:00.000Z'));
    const next = await start(id, { trigger: 'x', eventId: randomUUID() });
    expect(next.status, JSON.stringify(next.body)).toBe(201);
    expect((await env.call(admin(), 'GET', `/api/brands/${env.brandId}/agent`)).body.spent_month).toBe(0);
  });

  it('are not bypassed by a run that creates something new (no piece)', async () => {
    await limits({ max_cost_per_piece: 3, max_cost_per_month: 5 });
    const a = await env.call(agent, 'POST', `/api/brands/${env.brandId}/agent-runs`, { trigger: 'slot.needs_content' });
    expect(a.status).toBe(201);
    expect(a.body.limits.maxCost).toBe(3); // the per-piece budget bounds a run that makes a piece
    const b = await env.call(agent, 'POST', `/api/brands/${env.brandId}/agent-runs`, { trigger: 'slot.needs_content' });
    expect(b.status).toBe(201); // no piece, so nothing to lock
    await finish(a.body.id, { outcome: 'needs_people', cost: 5 });
    const c = await env.call(agent, 'POST', `/api/brands/${env.brandId}/agent-runs`, { trigger: 'slot.needs_content' });
    expect(c.body.error.code).toBe('monthly_budget_reached');
  });
});

async function versionOf(pieceId: string): Promise<string> {
  const variant = (await env.db.one('select id from variant where piece_id = $1', [pieceId]))!;
  const v = await env.newVersion(env.users.producer, variant.id, [{ data: randomBytes(32) }]);
  expect(v.status).toBe(201);
  return v.body.id;
}

describe('finishing a run', () => {
  it('records what it cost and what came of it, once', async () => {
    const id = await piece();
    const s = await start(id);
    const versionId = await versionOf(id);
    const f = await finish(s.body.id, { outcome: 'uploaded', cost: 0.4321, notes: 'Brightened the first seconds', versionId, detail: { checks: { warnings: 1 } } });
    expect(f.status).toBe(200);
    expect(f.body).toMatchObject({ outcome: 'uploaded', cost: 0.4321, version_id: versionId, status: 'finished', detail: { checks: { warnings: 1 } } });
    expect((await finish(s.body.id, { outcome: 'uploaded', cost: 0.4321, versionId })).status).toBe(200); // saying it twice is fine
    const other = await finish(s.body.id, { outcome: 'failed' });
    expect(other.status).toBe(409);
    expect(other.body.error.code).toBe('already_finished');
    expect((await summary(id)).runs[0]).toMatchObject({ version_number: 1, counted: true, cost: 0.4321 });
  });

  it('is for the token that started it, and checks what it is told', async () => {
    const id = await piece();
    const s = await start(id);
    const tok2 = await env.call(admin(), 'POST', `/api/brands/${env.brandId}/tokens`, { name: 'Another agent' });
    expect((await finish(s.body.id, { outcome: 'failed' }, { id: 't2', email: 't2', bearer: tok2.body.token })).status).toBe(404);
    expect((await finish(s.body.id, { outcome: 'failed' }, admin())).status).toBe(403);
    expect((await finish(s.body.id, { outcome: 'uploaded' })).body.error.code).toBe('version_required');
    expect((await finish(s.body.id, { outcome: 'uploaded', versionId: randomUUID() })).body.error.code).toBe('invalid_version');
    const elsewhere = await versionOf(await piece());
    expect((await finish(s.body.id, { outcome: 'uploaded', versionId: elsewhere })).body.error.code).toBe('invalid_version');
    expect((await finish(s.body.id, { outcome: 'unknown-outcome' })).status).toBe(400);
    expect((await finish(s.body.id, { outcome: 'failed', cost: -1 })).status).toBe(400);
  });

  it('tells approvers and admins when a run failed, timed out or did not pass its checks', async () => {
    for (const outcome of ['failed', 'timeout', 'checks_failed']) {
      const id = await piece();
      const s = await start(id);
      await finish(s.body.id, { outcome, notes: `it ended as ${outcome}` });
    }
    const failed = await told('agent.failed');
    expect(failed).toHaveLength(9); // three runs, to the admin and the two approvers
    expect(new Set(failed.map((n) => n.payload.outcome))).toEqual(new Set(['failed', 'timeout', 'checks_failed']));
    const quiet = await piece();
    const ok = await start(quiet);
    await finish(ok.body.id, { outcome: 'needs_people', notes: 'The agent could not enlarge text that is part of the picture.' });
    expect(await told('agent.failed')).toHaveLength(9); // not a failure...
    // ...but someone has to pick the piece up, so the people who can act are told, with the agent's own words.
    const handed = (await told('agent.needs_person')).filter((n) => n.payload.reason === 'agent_declined');
    expect(handed).toHaveLength(3);
    expect(handed[0]!.payload).toMatchObject({ pieceId: quiet, message: 'The agent could not enlarge text that is part of the picture.' });
  });

  it('is not repeated for an event that was handled, but is for one that failed', async () => {
    const id = await piece();
    const eventId = randomUUID();
    const a = await start(id, { trigger: 'version.changes_requested', eventId });
    await finish(a.body.id, { outcome: 'failed' });
    const b = await start(id, { trigger: 'version.changes_requested', eventId }); // a failed attempt may be tried again
    expect(b.status).toBe(201);
    await finish(b.body.id, { outcome: 'needs_people' });
    const c = await start(id, { trigger: 'version.changes_requested', eventId });
    expect(c.status).toBe(409);
    expect(c.body.error.code).toBe('already_handled');
  });
});

describe('a run that makes something new', () => {
  it('points at the piece it made when it finishes, and can only name a version of its own brand', async () => {
    const run = await env.call(agent, 'POST', `/api/brands/${env.brandId}/agent-runs`, { trigger: 'slot.needs_content' });
    expect(run.status).toBe(201);
    const id = await piece();
    const versionId = await versionOf(id);
    const done = await finish(run.body.id, { outcome: 'uploaded', cost: 0.2, versionId });
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    expect(done.body).toMatchObject({ piece_id: id, version_id: versionId, outcome: 'uploaded' });
    expect((await summary(id)).runs[0]).toMatchObject({ outcome: 'uploaded', version_number: 1, counted: true }); // it shows on that piece's card, as its first round
    expect((await finish((await env.call(agent, 'POST', `/api/brands/${env.brandId}/agent-runs`, { trigger: 'x' })).body.id, { outcome: 'uploaded', versionId: randomUUID() })).body.error.code).toBe('invalid_version');
  });
});

describe('what the agent can never do', () => {
  it('approve, reject, request changes, schedule, or touch the brand\'s settings', async () => {
    const { users } = env;
    const { pieceId, variantId } = await env.makePiece(users.producer, 'video', '9:16');
    const v = await env.newVersion(users.producer, variantId);
    const base = `/api/versions/${v.body.id}`;
    expect((await env.call(agent, 'POST', `${base}/approvals`, { decision: 'approve', accountIds: [env.accounts.instagram] })).status).toBe(403);
    expect((await env.call(agent, 'POST', `${base}/approvals`, { decision: 'reject', note: 'no' })).status).toBe(403);
    expect((await env.call(agent, 'POST', `${base}/request-changes`, { note: 'no' })).status).toBe(403);
    expect((await env.call(agent, 'POST', `${base}/comments`, { body: 'hello' })).status).toBe(403);
    expect((await env.call(agent, 'POST', `${base}/publications`, { accountId: env.accounts.instagram, scheduledAt: new Date(Date.now() + 86_400_000 * 3).toISOString() })).status).toBe(403);
    expect((await env.call(agent, 'POST', `/api/brands/${env.brandId}/pause`, { paused: true })).status).toBe(403);
    expect((await env.call(agent, 'PATCH', `/api/brands/${env.brandId}`, { name: 'Hijacked' })).status).toBe(403);
    expect((await env.call(agent, 'POST', `/api/brands/${env.brandId}/tokens`, { name: 'mine' })).status).toBe(403);
    expect((await env.call(agent, 'POST', `/api/pieces/${pieceId}/agent/reset`)).status).toBe(403);
    // What it may do: read, upload, reply, resolve its own comments.
    expect((await env.call(agent, 'GET', `/api/pieces/${pieceId}`)).status).toBe(200);
    expect((await env.call(agent, 'GET', `${base}`)).status).toBe(200);
  });
});

describe('what a check needs to know', () => {
  it('lists what each network of the brand accepts, with the file profile of each placement', async () => {
    const r = await env.call(agent, 'GET', `/api/brands/${env.brandId}/requirements`);
    expect(r.status).toBe(200);
    expect(r.body.networks.map((n: any) => n.network).sort()).toEqual(['facebook', 'instagram', 'youtube']);
    const ig = r.body.networks.find((n: any) => n.network === 'instagram');
    const reel = ig.placements.find((p: any) => p.id === 'reel');
    expect(reel).toMatchObject({ accepts: ['video'], safeZones: expect.any(Object), durationSec: expect.any(Object), aspect: expect.any(Object) });
    expect(reel.fileProfiles.video).toMatchObject({ id: 'ig-reel', maxWidth: 1080, maxHeight: 1920, maxBytes: expect.any(Number) });
    expect(ig.text.maxChars).toBe(2200);
    expect(Array.isArray(r.body.approval_checklist)).toBe(true);
    expect((await env.call(null, 'GET', `/api/brands/${env.brandId}/requirements`)).status).toBe(401);
  });
});
