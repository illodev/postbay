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

async function spend(db: Queryable, where: string, params: unknown[]): Promise<number> {
  const r = await db.one<{ s: string }>(`select coalesce(sum(cost), 0) as s from agent_run where outcome is distinct from 'blocked' and ${where}`, params);
  return Number(r?.s ?? 0);
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

  const outcome = await ctx.db.tx(async (db): Promise<{ started: Started } | { blocked: { reason: BlockReason; message: string; details: Record<string, unknown> } }> => {
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
      if (piece.discarded_at) throw conflict('piece_discarded', 'The piece is discarded');
    } else {
      brandId = (scope as { brandId: string }).brandId;
      await authorize(db, p, brandId, 'version.upload');
    }
    const brand = await loadBrand(db, brandId);
    const s = agentOf(brand);
    const now = ctx.now();

    // A runner that stopped reporting does not hold the piece forever.
    if (pieceId) {
      await db.query(
        `update agent_run set status = 'finished', outcome = 'timeout', finished_at = $2, notes = 'The runner stopped reporting, so the run was closed'
         where piece_id = $1 and status = 'running' and lease_until < $2`,
        [pieceId, now],
      );
      const running = await db.one('select id, lease_until from agent_run where piece_id = $1 and status = \'running\'', [pieceId]);
      if (running) throw conflict('piece_busy', 'An agent is already working on this piece', { runId: running.id, retryAfterSeconds: 60 });
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

    let blocked: { reason: BlockReason; message: string; details: Record<string, unknown> } | null = null;
    if (s.max_cost_per_piece === null || s.max_cost_per_month === null) {
      blocked = { reason: 'budget_not_set', message: "Set the agent's budgets in Settings → Agent before it can start.", details: {} };
    } else if (pieceId && rounds >= s.max_rounds) {
      blocked = { reason: 'rounds_exhausted', message: `The agent has used its ${s.max_rounds} rounds on this piece. A person has to take it from here.`, details: { rounds, maxRounds: s.max_rounds } };
    } else if (pieceId && spentPiece >= s.max_cost_per_piece) {
      blocked = { reason: 'piece_budget_reached', message: `The agent has reached the budget for this piece (${spentPiece.toFixed(2)} of ${s.max_cost_per_piece} ${s.currency}).`, details: { spent: spentPiece, cap: s.max_cost_per_piece } };
    } else if (spentMonth >= s.max_cost_per_month) {
      blocked = { reason: 'monthly_budget_reached', message: `The agent has reached this month's budget (${spentMonth.toFixed(2)} of ${s.max_cost_per_month} ${s.currency}).`, details: { spent: spentMonth, cap: s.max_cost_per_month } };
    }

    if (blocked) {
      // Written down once per event, and the people who can take over are told once.
      const row = await db.one(
        `insert into agent_run (brand_id, piece_id, token_id, trigger, trigger_event_id, status, outcome, blocked_reason, notes, started_at, finished_at)
         values ($1,$2,$3,$4,$5,'finished','blocked',$6,$7,$8,$8) on conflict do nothing returning id`,
        [brandId, pieceId, token.tokenId, input.trigger, input.eventId ?? null, blocked.reason, blocked.message, now],
      );
      if (row) {
        await notifyRoles(db, brandId, ['approver', 'admin'], 'agent.needs_person', { pieceId, title: pieceTitle, reason: blocked.reason, message: blocked.message }, null);
        await audit(db, p, brandId, 'agent.blocked', 'agent_run', row.id, null, { reason: blocked.reason, piece_id: pieceId });
      }
      return { blocked };
    }

    // Not blocked, so both budgets are set.
    const capPiece = s.max_cost_per_piece as number;
    const capMonth = s.max_cost_per_month as number;
    const remaining = Math.min(pieceId ? capPiece - spentPiece : capPiece, capMonth - spentMonth);
    const lease = new Date(now.getTime() + (s.max_run_minutes + LEASE_GRACE_MINUTES) * 60_000);
    const run = (await db.one(
      `insert into agent_run (brand_id, piece_id, token_id, trigger, trigger_event_id, lease_until, started_at) values ($1,$2,$3,$4,$5,$6,$7) returning id`,
      [brandId, pieceId, token.tokenId, input.trigger, input.eventId ?? null, lease, now],
    ))!;
    await audit(db, p, brandId, 'agent.started', 'agent_run', run.id, null, { piece_id: pieceId, trigger: input.trigger, round: rounds + 1 });
    return {
      started: {
        id: run.id, round: rounds + 1, maxRounds: s.max_rounds, leaseUntil: lease,
        limits: { maxMinutes: s.max_run_minutes, maxCost: Math.round(remaining * 10_000) / 10_000, currency: s.currency },
      },
    };
  });

  if ('blocked' in outcome) {
    const b = outcome.blocked;
    throw conflict(b.reason, b.message, b.details);
  }
  return outcome.started;
}

/** The runner says it is still working: the lease moves ahead, so a stuck runner is told apart from a busy one. */
export async function heartbeat(ctx: Ctx, p: Principal, runId: string) {
  const token = requireToken(p);
  const row = await ctx.db.one(
    `update agent_run set lease_until = $3 where id = $1 and token_id = $2 and status = 'running' returning id, lease_until`,
    [runId, token.tokenId, new Date(ctx.now().getTime() + HEARTBEAT_MINUTES * 60_000)],
  );
  if (!row) throw conflict('not_running', 'That run is not running (it finished, or it was closed because the runner stopped reporting)');
  return { id: row.id, leaseUntil: row.lease_until };
}

export async function finishRun(ctx: Ctx, p: Principal, runId: string, raw: unknown) {
  const input = finishInput.parse(raw);
  const token = requireToken(p);
  return ctx.db.tx(async (db) => {
    const run = await db.one('select * from agent_run where id = $1 for update', [runId]);
    if (!run || run.token_id !== token.tokenId) throw notFound('Run');
    if (run.status === 'finished') {
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

const runView = (r: Record<string, any>) => ({
  id: r.id, piece_id: r.piece_id, trigger: r.trigger, status: r.status, outcome: r.outcome, blocked_reason: r.blocked_reason,
  started_at: r.started_at, finished_at: r.finished_at, cost: Number(r.cost), notes: r.notes, version_id: r.version_id, detail: r.detail,
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
    spent_month: await spend(ctx.db, 'brand_id = $1 and started_at >= $2', [piece.brand_id, monthStart]),
    status: live ? 'running' : needsPerson ? 'needs_person' : 'idle',
    blocked_reason: needsPerson ? lastBlocked!.blocked_reason : null,
    blocked_message: needsPerson ? lastBlocked!.notes : null,
    runs: runs.map((r) => ({ ...runView(r), version_number: r.version_number, counted: new Date(r.started_at) > since && r.outcome !== 'aborted' && r.outcome !== 'blocked' })),
  };
}

/**
 * Hands a piece back to the agent: rounds and spending on it count from zero again, and whatever request for changes is
 * still waiting is sent again (as a new event), because the agent was refused it and nothing else would wake it.
 */
export async function resetRounds(ctx: Ctx, p: Principal, pieceId: string) {
  if (p.kind !== 'user') throw forbidden('Only people can give the agent more rounds');
  await ctx.db.tx(async (db) => {
    const piece = await loadPiece(db, pieceId, true);
    await authorize(db, p, piece.brand_id, 'version.approve');
    if (piece.discarded_at) throw conflict('piece_discarded', 'The piece is discarded');
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
    spent_month: await spend(ctx.db, 'brand_id = $1 and started_at >= $2', [brandId, monthStart]),
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
