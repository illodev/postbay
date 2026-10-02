import { DateTime } from 'luxon';
import { z } from 'zod';
import { authorize, type Principal } from '../auth/principal.js';
import { allCapabilities } from '../connectors/registry.js';
import { PROFILES } from '../connectors/profiles.js';
import type { Ctx } from '../context.js';
import type { Queryable } from '../db.js';
import { badRequest, conflict, forbidden, notFound } from '../errors.js';
import { audit } from './audit.js';
import { emitChangesRequested } from './approvals.js';
import { loadBrand, loadPiece } from './loaders.js';
import { notifyRoles } from './notify.js';
import { english, msg, type Localized } from '../i18n/index.js';

// ───────────────────────────── the brand's limits ─────────────────────────────

/**
 * What the agent may do for a brand. Rounds are counted per piece; the budgets are in the unit the runner reports its cost
 * in, and the currency is only a label for people. A budget that is not set means the agent may not start: spending is a
 * decision someone makes, not a default.
 */
export const agentSettings = z.object({
  max_rounds: z.number().int().min(1).max(10),
  max_cost_per_piece: z.number().min(0).max(1_000_000).nullable(),
  max_cost_per_month: z.number().min(0).max(10_000_000).nullable(),
  max_run_minutes: z.number().int().min(1).max(240),
  slot_alert_days: z.number().int().min(0).max(30),
  currency: z.string().trim().min(1).max(8),
});
export type AgentSettings = z.infer<typeof agentSettings>;

export const DEFAULT_AGENT: AgentSettings = {
  max_rounds: 3, max_cost_per_piece: null, max_cost_per_month: null, max_run_minutes: 30, slot_alert_days: 3, currency: 'USD',
};

export const agentOf = (brand: { agent?: unknown }): AgentSettings => ({ ...DEFAULT_AGENT, ...((brand.agent as Partial<AgentSettings> | null) ?? {}) });

// ───────────────────────────── runs ─────────────────────────────

const LEASE_GRACE_MINUTES = 5;
export const HEARTBEAT_MINUTES = 5;

export const startInput = z.object({
  /** The event type that started it, for the record. */
  trigger: z.string().trim().min(1).max(60),
  /** The event it is handling, so the same event does not start a second run. */
  eventId: z.string().uuid().optional(),
});

export const finishInput = z.object({
  outcome: z.enum(['uploaded', 'needs_people', 'failed', 'checks_failed', 'timeout', 'aborted']),
  cost: z.number().min(0).max(1_000_000).default(0),
  notes: z.string().max(5000).default(''),
  versionId: z.string().uuid().optional(),
  detail: z.record(z.string(), z.unknown()).default({}),
});

type BlockReason = 'budget_not_set' | 'rounds_exhausted' | 'piece_budget_reached' | 'monthly_budget_reached';

const monthStartOf = (ctx: Ctx, zone: string) => DateTime.fromJSDate(ctx.now(), { zone }).startOf('month').toJSDate();

/**
 * What has been spent: the cost each finished run reported, and for a run still going what it was allowed to spend when it started
 * (it may yet spend all of it). So runs at the same time share what is left instead of each being told all of it.
 */
async function spend(db: Queryable, where: string, params: unknown[]): Promise<number> {
  const r = await spending(db, where, params);
  return r.spent + r.reserved;
}

/** Spent by finished runs, and set aside for the runs still going, separately: what people are shown. */
async function spending(db: Queryable, where: string, params: unknown[]): Promise<{ spent: number; reserved: number }> {
  const r = await db.one<{ spent: string; reserved: string }>(
    `select coalesce(sum(cost) filter (where status <> 'running'), 0) as spent,
       coalesce(sum(greatest(cost, reserved)) filter (where status = 'running'), 0) as reserved
     from agent_run where outcome is distinct from 'blocked' and ${where}`,
    params,
  );
  return { spent: Number(r?.spent ?? 0), reserved: Number(r?.reserved ?? 0) };
}

const STUDIO_TIMEOUT_NOTE = 'The runner stopped reporting, or ran past the longest run, so the studio closed the run';
const STUDIO_TIMEOUT_TEXT = msg('agent.studioTimeout');

/**
 * Closes the runs whose lease ran out (the runner stopped reporting) or that went past their longest run, as timeouts, and tells the
 * people who can pick the pieces up. What they cost is not known yet: a late report from the runner is still recorded (finishRun).
 */
async function closeExpired(ctx: Ctx, db: Queryable, where: string, params: unknown[]): Promise<number> {
  const now = ctx.now();
  const closed = await db.query<{ id: string; brand_id: string; piece_id: string | null; token_id: string }>(
    `update agent_run set status = 'finished', outcome = 'timeout', finished_at = $1, notes = '${STUDIO_TIMEOUT_NOTE}',
       notes_i18n = '${JSON.stringify(STUDIO_TIMEOUT_TEXT)}'::jsonb, detail = detail || '{"closed_by_studio": true}'::jsonb
     where status = 'running' and (lease_until < $1 or deadline_at < $1) and ${where}
     returning id, brand_id, piece_id, token_id`,
    [now, ...params],
  );
  for (const r of closed) {
    const piece = r.piece_id ? await db.one('select title from piece where id = $1', [r.piece_id]) : null;
    await audit(db, null, r.brand_id, 'agent.timed_out', 'agent_run', r.id, { status: 'running' }, { outcome: 'timeout' });
    // A kind of its own (it used to be agent.failed): nobody did anything wrong, the run simply ran out of time.
    await notifyRoles(db, r.brand_id, ['approver', 'admin'], 'agent.timed_out', {
      pieceId: r.piece_id, title: piece?.title ?? null, runId: r.id, outcome: 'timeout', message: STUDIO_TIMEOUT_NOTE, message_i18n: STUDIO_TIMEOUT_TEXT,
    }, null);
  }
  return closed.length;
}

/** For the worker: closes every run past its lease or its longest run, whichever brand it is in. */
export async function expireRuns(ctx: Ctx): Promise<number> {
  return ctx.db.tx((db) => closeExpired(ctx, db, 'true', []));
}

/**
 * The run of this token that covers work on this piece right now, if any: one it started on the piece, or one it started for the
 * brand (an empty slot) during which it made the piece. Only a run that is still running, inside its lease and its longest run.
 */
export async function runCovering(db: Queryable, tokenId: string, pieceId: string, now: Date): Promise<string | null> {
  const r = await db.one<{ id: string }>(
    `select r.id from agent_run r join piece p on p.id = $2
     where r.token_id = $1 and r.status = 'running' and r.lease_until >= $3 and (r.deadline_at is null or r.deadline_at >= $3)
       and (r.piece_id = p.id or (r.piece_id is null and p.created_by_token = r.token_id and p.created_at >= r.opened_at))
     order by r.started_at limit 1`,
    [tokenId, pieceId, now],
  );
  return r?.id ?? null;
}

function requireToken(p: Principal) {
  if (p.kind !== 'token') throw forbidden('Only a producer token starts agent runs');
  return p;
}

interface Started {
  id: string;
  round: number;
  maxRounds: number;
  leaseUntil: Date;
  limits: { maxMinutes: number; maxCost: number | null; currency: string };
}

/**
 * An agent asks to start work on a piece (or, with no piece, on something new). This is where the safeguards are enforced,
 * so no runner can skip them: one agent per piece at a time, a cap on rounds per piece, budgets per piece and per month.
 * A refused start for a limit is recorded once per event and tells the people who can take the piece over.
 */
export async function startRun(ctx: Ctx, p: Principal, scope: { pieceId: string } | { brandId: string }, raw: unknown): Promise<Started> {
  const input = startInput.parse(raw);
  const token = requireToken(p);
  const pieceId = 'pieceId' in scope ? scope.pieceId : null;

  const outcome = await ctx.db.tx(async (db): Promise<{ started: Started } | { blocked: { reason: BlockReason; text: Localized; details: Record<string, unknown> } }> => {
    let brandId: string;
    let reset: Date | null = null;
    let pieceTitle: string | null = null;
    if (pieceId) {
      const piece = await db.one('select * from piece where id = $1 for update', [pieceId]);
      if (!piece) throw notFound('Piece');
      brandId = piece.brand_id;
      reset = piece.agent_reset_at ? new Date(piece.agent_reset_at) : null;
      pieceTitle = piece.title;
      await authorize(db, p, brandId, 'version.upload');
      if (piece.discarded_at) throw conflict('piece_discarded', msg('error.pieceDiscarded'));
    } else {
      brandId = (scope as { brandId: string }).brandId;
      await authorize(db, p, brandId, 'version.upload');
    }
    const brand = await loadBrand(db, brandId);
    const s = agentOf(brand);
    const now = ctx.now();

    // A runner that stopped reporting, or ran past its longest run, does not hold the piece (nor the budget) forever.
    await closeExpired(ctx, db, 'brand_id = $2', [brandId]);
    if (pieceId) {
      const running = await db.one('select id, lease_until from agent_run where piece_id = $1 and status = \'running\'', [pieceId]);
      if (running) throw conflict('piece_busy', 'An agent is already working on this piece', { runId: running.id, retryAfterSeconds: 60 });
      // A run for the brand that made this piece is still working on it: it is that run's until it finishes.
      const making = await db.one(
        `select r.id from agent_run r join piece p on p.id = $1
         where r.status = 'running' and r.piece_id is null and r.token_id = p.created_by_token and p.created_at >= r.opened_at limit 1`,
        [pieceId],
      );
      if (making) throw conflict('piece_busy', 'An agent is still making this piece', { runId: making.id, retryAfterSeconds: 60 });
    }
    if (input.eventId) {
      const done = await db.one(
        `select outcome from agent_run where trigger_event_id = $1 and brand_id = $2 and outcome in ('uploaded','needs_people')`,
        [input.eventId, brandId],
      );
      if (done) throw conflict('already_handled', 'An agent already handled this event');
    }

    const monthStart = monthStartOf(ctx, brand.timezone as string);
    const spentMonth = await spend(db, 'brand_id = $1 and started_at >= $2', [brandId, monthStart]);
    const spentPiece = pieceId ? await spend(db, 'piece_id = $1 and started_at > $2', [pieceId, reset ?? new Date(0)]) : 0;
    const rounds = pieceId
      ? (await db.one<{ n: number }>(
          `select count(*)::int as n from agent_run where piece_id = $1 and started_at > $2 and outcome is distinct from 'aborted' and outcome is distinct from 'blocked'`,
          [pieceId, reset ?? new Date(0)],
        ))!.n
      : 0;

    // Why it may not start, kept as a code so each person reads it in their language (the English goes in `notes`, for the runner).
    let blocked: { reason: BlockReason; text: Localized; details: Record<string, unknown> } | null = null;
    const money = (n: number) => n.toFixed(2);
    if (s.max_cost_per_piece === null || s.max_cost_per_month === null) {
      blocked = { reason: 'budget_not_set', text: msg('agent.blocked.budgetNotSet'), details: {} };
    } else if (pieceId && rounds >= s.max_rounds) {
      blocked = { reason: 'rounds_exhausted', text: msg('agent.blocked.roundsExhausted', { rounds: s.max_rounds }), details: { rounds, maxRounds: s.max_rounds } };
    } else if (pieceId && spentPiece >= s.max_cost_per_piece) {
      blocked = { reason: 'piece_budget_reached', text: msg('agent.blocked.pieceBudget', { spent: money(spentPiece), cap: String(s.max_cost_per_piece), currency: s.currency }), details: { spent: spentPiece, cap: s.max_cost_per_piece } };
    } else if (spentMonth >= s.max_cost_per_month) {
      blocked = { reason: 'monthly_budget_reached', text: msg('agent.blocked.monthBudget', { spent: money(spentMonth), cap: String(s.max_cost_per_month), currency: s.currency }), details: { spent: spentMonth, cap: s.max_cost_per_month } };
    }

    if (blocked) {
      const message = english(blocked.text);
      // Written down once per event, and the people who can take over are told once.
      const row = await db.one(
        `insert into agent_run (brand_id, piece_id, token_id, trigger, trigger_event_id, status, outcome, blocked_reason, notes, notes_i18n, started_at, finished_at)
         values ($1,$2,$3,$4,$5,'finished','blocked',$6,$7,$8,$9,$9) on conflict do nothing returning id`,
        [brandId, pieceId, token.tokenId, input.trigger, input.eventId ?? null, blocked.reason, message, JSON.stringify(blocked.text), now],
      );
      if (row) {
        await notifyRoles(db, brandId, ['approver', 'admin'], 'agent.needs_person', { pieceId, title: pieceTitle, reason: blocked.reason, message, message_i18n: blocked.text }, null);
        await audit(db, p, brandId, 'agent.blocked', 'agent_run', row.id, null, { reason: blocked.reason, piece_id: pieceId });
      }
      return { blocked };
    }

    // Not blocked, so both budgets are set.
    const capPiece = s.max_cost_per_piece as number;
    const capMonth = s.max_cost_per_month as number;
    // What this run may spend, and what is set aside for it while it runs: what is left of the piece and of the month, after what the
    // runs already going were given.
    const remaining = Math.round(Math.min(pieceId ? capPiece - spentPiece : capPiece, capMonth - spentMonth) * 10_000) / 10_000;
    const lease = new Date(now.getTime() + (s.max_run_minutes + LEASE_GRACE_MINUTES) * 60_000);
    const run = (await db.one(
      `insert into agent_run (brand_id, piece_id, token_id, trigger, trigger_event_id, lease_until, started_at, reserved, deadline_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$6) returning id`,
      [brandId, pieceId, token.tokenId, input.trigger, input.eventId ?? null, lease, now, remaining],
    ))!;
    await audit(db, p, brandId, 'agent.started', 'agent_run', run.id, null, { piece_id: pieceId, trigger: input.trigger, round: rounds + 1 });
    return {
      started: {
        id: run.id, round: rounds + 1, maxRounds: s.max_rounds, leaseUntil: lease,
        limits: { maxMinutes: s.max_run_minutes, maxCost: remaining, currency: s.currency },
      },
    };
  });

  if ('blocked' in outcome) {
    const b = outcome.blocked;
    throw conflict(b.reason, b.text, b.details);
  }
  return outcome.started;
}

/**
 * The runner says it is still working: the lease moves ahead, so a stuck runner is told apart from a busy one. Never past the run's
 * longest time: a run that has used it up is closed here, and the runner is told to stop.
 */
export async function heartbeat(ctx: Ctx, p: Principal, runId: string) {
  const token = requireToken(p);
  const now = ctx.now();
  const row = await ctx.db.tx(async (db) => {
    await closeExpired(ctx, db, 'id = $2 and token_id = $3', [runId, token.tokenId]);
    return db.one(
      `update agent_run set lease_until = case when deadline_at is null then $3 else least($3, deadline_at) end
       where id = $1 and token_id = $2 and status = 'running' returning id, lease_until`,
      [runId, token.tokenId, new Date(now.getTime() + HEARTBEAT_MINUTES * 60_000)],
    );
  });
  if (!row) throw conflict('not_running', 'That run is not running (it finished, it ran past the longest run allowed, or it was closed because the runner stopped reporting)');
  return { id: row.id, leaseUntil: row.lease_until };
}

export async function finishRun(ctx: Ctx, p: Principal, runId: string, raw: unknown) {
  const input = finishInput.parse(raw);
  const token = requireToken(p);
  return ctx.db.tx(async (db) => {
    const run = await db.one('select * from agent_run where id = $1 for update', [runId]);
    if (!run || run.token_id !== token.tokenId) throw notFound('Run');
    if (run.status === 'finished') {
      // A run the studio closed as a timeout still spent what it spent: the runner's late word on it is recorded, once, so the
      // budgets count it. The outcome stays a timeout.
      if (run.outcome === 'timeout' && run.detail?.closed_by_studio && !run.detail?.late_report) {
        const late = { outcome: input.outcome, cost: input.cost, notes: input.notes.slice(0, 900), at: ctx.now().toISOString() };
        const row = (await db.one(
          `update agent_run set cost = $2, detail = detail || $3::jsonb where id = $1 returning *`,
          [runId, input.cost, JSON.stringify({ late_report: late })],
        ))!;
        await audit(db, p, run.brand_id, 'agent.late_report', 'agent_run', runId, { cost: Number(run.cost) }, { cost: input.cost, outcome: input.outcome });
        return runView(row);
      }
      if (run.outcome === input.outcome) return runView(run);
      throw conflict('already_finished', `This run already finished as ${run.outcome}`);
    }
    // A version belongs to the piece the run worked on; a run that made something new points at the piece it made.
    let versionPiece: string | null = null;
    if (input.versionId) {
      const v = await db.one<{ piece_id: string }>(
        `select v.piece_id from version ver join variant v on v.id = ver.variant_id join piece p on p.id = v.piece_id
         where ver.id = $1 and p.brand_id = $2 and ($3::uuid is null or v.piece_id = $3)`,
        [input.versionId, run.brand_id, run.piece_id],
      );
      if (!v) throw badRequest('invalid_version', run.piece_id ? 'That version is not one of this piece' : 'That version is not one of this brand');
      versionPiece = v.piece_id;
    }
    if (input.outcome === 'uploaded' && !input.versionId) throw badRequest('version_required', 'An uploaded outcome names the version');
    const row = (await db.one(
      `update agent_run set status = 'finished', outcome = $2, cost = $3, notes = $4, version_id = $5, detail = $6, finished_at = $7, piece_id = coalesce(piece_id, $8)
       where id = $1 returning *`,
      [runId, input.outcome, input.cost, input.notes, input.versionId ?? null, JSON.stringify(input.detail), ctx.now(), versionPiece],
    ))!;
    await audit(db, p, run.brand_id, 'agent.finished', 'agent_run', runId, { status: 'running' }, { outcome: input.outcome, cost: input.cost, version_id: input.versionId ?? null });
    if (input.outcome === 'needs_people') {
      // The agent made nothing and handed the comments back: someone has to pick the piece up, and has to be told.
      const piece = run.piece_id ? await db.one('select title from piece where id = $1', [run.piece_id]) : null;
      await notifyRoles(db, run.brand_id, ['approver', 'admin'], 'agent.needs_person', { pieceId: run.piece_id, title: piece?.title ?? null, runId, reason: 'agent_declined', message: input.notes.slice(0, 300) }, null);
    }
    if (['failed', 'checks_failed', 'timeout'].includes(input.outcome)) {
      const piece = run.piece_id ? await db.one('select title from piece where id = $1', [run.piece_id]) : null;
      await notifyRoles(db, run.brand_id, ['approver', 'admin'], 'agent.failed', { pieceId: run.piece_id, title: piece?.title ?? null, runId, outcome: input.outcome, message: input.notes.slice(0, 300) }, null);
    }
    return runView(row);
  });
}

/** `notes_i18n` is the studio's own note kept as a code: the answer carries it in the reader's language as `notes` (see renderStored). */
const runView = (r: Record<string, any>) => ({
  id: r.id, piece_id: r.piece_id, trigger: r.trigger, status: r.status, outcome: r.outcome, blocked_reason: r.blocked_reason,
  started_at: r.started_at, finished_at: r.finished_at, cost: Number(r.cost), notes: r.notes, notes_i18n: r.notes_i18n ?? null, version_id: r.version_id, detail: r.detail,
});

// ───────────────────────────── what people see ─────────────────────────────

/** Where a piece stands with the agent: how many rounds it has used, what it has cost, and whether a person has to step in. */
export async function pieceAgent(ctx: Ctx, p: Principal, pieceId: string) {
  const piece = await loadPiece(ctx.db, pieceId);
  await authorize(ctx.db, p, piece.brand_id, 'brand.view');
  const brand = await loadBrand(ctx.db, piece.brand_id);
  const s = agentOf(brand);
  const since = piece.agent_reset_at ? new Date(piece.agent_reset_at) : new Date(0);
  const runs = await ctx.db.query(
    `select r.*, ver.number as version_number from agent_run r left join version ver on ver.id = r.version_id
     where r.piece_id = $1 order by r.started_at desc, r.seq desc limit 30`,
    [pieceId],
  );
  const counted = runs.filter((r) => new Date(r.started_at) > since && r.outcome !== 'aborted' && r.outcome !== 'blocked');
  const live = runs.find((r) => r.status === 'running' && new Date(r.lease_until) > ctx.now());
  const lastBlocked = runs.find((r) => r.outcome === 'blocked' && new Date(r.started_at) > since);
  let needsPerson = false;
  if (lastBlocked && !live) {
    // A person who uploads a version after the refusal has taken it over: it no longer waits for one.
    const newer = await ctx.db.one(
      `select 1 from version ver join variant v on v.id = ver.variant_id where v.piece_id = $1 and ver.created_at > $2 limit 1`,
      [pieceId, lastBlocked.started_at],
    );
    needsPerson = !newer;
  }
  const monthStart = monthStartOf(ctx, brand.timezone as string);
  return {
    settings: s,
    rounds: counted.length,
    max_rounds: s.max_rounds,
    spent_piece: counted.reduce((n, r) => n + Number(r.cost), 0),
    spent_month: (await spending(ctx.db, 'brand_id = $1 and started_at >= $2', [piece.brand_id, monthStart])).spent,
    status: live ? 'running' : needsPerson ? 'needs_person' : 'idle',
    blocked_reason: needsPerson ? lastBlocked!.blocked_reason : null,
    blocked_message: needsPerson ? lastBlocked!.notes : null,
    blocked_message_i18n: needsPerson ? (lastBlocked!.notes_i18n ?? null) : null,
    runs: runs.map((r) => ({ ...runView(r), version_number: r.version_number, counted: new Date(r.started_at) > since && r.outcome !== 'aborted' && r.outcome !== 'blocked' })),
  };
}

/**
 * Hands a piece back to the agent: rounds and spending on it count from zero again, and whatever request for changes is
 * still waiting is sent again (as a new event), because the agent was refused it and nothing else would wake it.
 */
export async function resetRounds(ctx: Ctx, p: Principal, pieceId: string) {
  if (p.kind !== 'user') throw forbidden(msg('error.agent.peopleOnlyRounds'));
  await ctx.db.tx(async (db) => {
    const piece = await loadPiece(db, pieceId, true);
    await authorize(db, p, piece.brand_id, 'version.approve');
    if (piece.discarded_at) throw conflict('piece_discarded', msg('error.pieceDiscarded'));
    await db.query('update piece set agent_reset_at = $2 where id = $1', [pieceId, ctx.now()]);
    await audit(db, p, piece.brand_id, 'agent.rounds_reset', 'piece', pieceId, { agent_reset_at: piece.agent_reset_at }, { agent_reset_at: ctx.now().toISOString() });
    const waiting = await db.query<{ id: string; variant_id: string }>(
      `select ver.id, ver.variant_id from version ver join variant v on v.id = ver.variant_id
       where v.piece_id = $1 and ver.review_state = 'changes_requested'
         and ver.number = (select max(number) from version where variant_id = v.id)`,
      [pieceId],
    );
    for (const w of waiting) {
      await emitChangesRequested(ctx, db, p, { id: w.id, brand_id: piece.brand_id, piece_id: pieceId, variant_id: w.variant_id }, 'agent_reset', null);
    }
  });
  return pieceAgent(ctx, p, pieceId);
}

/** The month so far, and the latest runs, for the settings screen. */
export async function brandAgent(ctx: Ctx, p: Principal, brandId: string) {
  await authorize(ctx.db, p, brandId, 'brand.manage');
  const brand = await loadBrand(ctx.db, brandId);
  const monthStart = monthStartOf(ctx, brand.timezone as string);
  const runs = await ctx.db.query(
    `select r.*, pc.title as piece_title, ver.number as version_number, t.name as token_name
     from agent_run r left join piece pc on pc.id = r.piece_id left join version ver on ver.id = r.version_id left join api_token t on t.id = r.token_id
     where r.brand_id = $1 order by r.started_at desc, r.seq desc limit 40`,
    [brandId],
  );
  return {
    settings: agentOf(brand),
    month_start: monthStart,
    ...(await spending(ctx.db, 'brand_id = $1 and started_at >= $2', [brandId, monthStart]).then((m) => ({ spent_month: m.spent, reserved_month: m.reserved }))),
    runs: runs.map((r) => ({ ...runView(r), piece_title: r.piece_title, version_number: r.version_number, token_name: r.token_name })),
  };
}

// ───────────────────────────── what a check needs to know ─────────────────────────────

/**
 * What the networks this brand publishes to accept, so a producer can check a file before uploading it: durations,
 * aspect ratios, sizes, the areas each network covers, and the file profile each placement is converted to.
 */
export async function requirements(ctx: Ctx, p: Principal, brandId: string) {
  await authorize(ctx.db, p, brandId, 'brand.view');
  const brand = await loadBrand(ctx.db, brandId);
  const networks = (await ctx.db.query<{ network: string }>('select distinct network from social_account where brand_id = $1', [brandId])).map((r) => r.network);
  const caps = allCapabilities(ctx.config);
  return {
    networks: networks.filter((n) => caps[n]).map((n) => {
      const c = caps[n]!;
      return {
        network: n,
        text: c.text,
        placements: c.placements.map((pl) => ({
          ...pl,
          fileProfiles: Object.fromEntries(Object.entries(pl.profiles).map(([kind, id]) => [kind, PROFILES[id as string] ?? null])),
        })),
      };
    }),
    approval_checklist: (brand.approval_rules as { checklist?: string[] } | null)?.checklist ?? [],
  };
}
