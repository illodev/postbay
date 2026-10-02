import { DateTime } from 'luxon';
import type { Principal } from '../auth/principal.js';
import type { Ctx } from '../context.js';
import type { Queryable, Row } from '../db.js';
import { slotFits } from '../domain/slotfit.js';
import { localDay } from '../domain/time.js';
import { AppError } from '../errors.js';
import { english, msg, requestLocale, t, type Key, type Localized } from '../i18n/index.js';
import { effectiveApproval } from './approvals.js';
import { loadBrand, rulesOf } from './loaders.js';
import { notifyUsers } from './notify.js';
import { calendarData, scheduleInput, scheduleVersion, type ScheduledBy } from './publications.js';

/**
 * Scheduling that follows a person's approval. The rule that nothing goes out without a person approving that very version stays: all
 * of this schedules only versions that are approved, for accounts they were approved for, through the same checks as a person
 * scheduling by hand (services/publications.ts, scheduleVersion).
 *
 * - **A piece made for a slot** (piece.slot_id and slot_at: an agent run started by `slot.needs_content` links the piece it makes, and a
 *   person can link one) is scheduled at that slot occurrence when a version of it is approved for the slot's account, unless an
 *   approver unticks it (`autoSchedule: false`). The version's page says beforehand what would be scheduled (`slot_schedule`).
 * - **Free slots** (rules.auto_fill_slots, off by default): the worker puts approved versions that were never scheduled into the next
 *   free weekly slots of an account they were approved for (fillFreeSlots), and tells whoever approved them.
 * - **The agent** (agent.can_schedule_approved, off by default) may schedule what is approved from inside one of its runs:
 *   services/publications.ts (schedule).
 */

/** The statuses in which a publication occupies its time on an account. */
const LIVE = ['scheduled', 'awaiting_reapproval', 'on_hold', 'preparing', 'ready', 'publishing', 'published'];
/** How far ahead free slots are filled. */
export const FILL_DAYS = 14;

export interface SlotSchedule {
  slot: { id: string | null; label: string | null };
  account: { id: string; network: string; display_name: string } | null;
  /** The occurrence: the instant, and its day and time in the brand's zone. */
  at: string;
  day: string;
  time: string;
  timezone: string;
  /** Whether approving the version now (for the slot's account, without unticking) would schedule it there. */
  ready: boolean;
  /** Why not, as a code: slot_removed, slot_inactive, already_scheduled, time_passed, brand_paused, blocked_date, slot_taken. */
  code: string | null;
  /** What the approver is told it would do, in their language ("It will be scheduled on Tuesday 6 at 19:00 on @account…"). */
  summary: string | null;
  /** Why it would not, in the reader's language. */
  reason: string | null;
  reason_i18n: Localized | null;
  /** The publication already in the slot for this version, if any. */
  publication_id: string | null;
}

/**
 * What approving this version would schedule, for a piece made for a slot: where and when, and whether it can (and if not, why). Null
 * for a piece that was not made for a slot.
 */
export async function slotScheduleOf(ctx: Ctx, db: Queryable, versionId: string): Promise<SlotSchedule | null> {
  const piece = await db.one<{ id: string; brand_id: string; slot_id: string | null; slot_at: Date | null }>(
    `select p.id, p.brand_id, p.slot_id, p.slot_at from version ver join variant v on v.id = ver.variant_id join piece p on p.id = v.piece_id where ver.id = $1`,
    [versionId],
  );
  if (!piece?.slot_at) return null;
  const brand = await loadBrand(db, piece.brand_id);
  const zone = brand.timezone as string;
  const at = new Date(piece.slot_at);
  const local = DateTime.fromJSDate(at, { zone });
  const s = piece.slot_id
    ? await db.one<{ id: string; label: string; active: boolean; account_id: string; network: string; display_name: string }>(
        `select s.id, s.label, s.active, sa.id as account_id, sa.network, sa.display_name from slot s join social_account sa on sa.id = s.social_account_id where s.id = $1`,
        [piece.slot_id],
      )
    : null;
  let code: string | null = null;
  let why: Localized | null = null;
  let publicationId: string | null = null;
  const now = ctx.now();
  if (!s) [code, why] = ['slot_removed', msg('sched.slot.removed')];
  else {
    const already = await db.one<{ id: string }>(
      'select id from publication where version_id = $1 and social_account_id = $2 and scheduled_at = $3 and status = any($4) limit 1',
      [versionId, s.account_id, at, LIVE],
    );
    const blocked = await db.one<{ reason: string }>('select reason from blocked_date where brand_id = $1 and day = $2', [piece.brand_id, localDay(at, zone)]);
    if (already) [code, why, publicationId] = ['already_scheduled', msg('sched.slot.alreadyScheduled'), already.id];
    else if (!s.active) [code, why] = ['slot_inactive', msg('sched.slot.inactive')];
    else if (at.getTime() <= now.getTime()) [code, why] = ['time_passed', msg('sched.slot.timePassed')];
    else if (brand.paused) [code, why] = ['brand_paused', msg('sched.slot.paused')];
    else if (blocked) {
      const day = localDay(at, zone);
      [code, why] = ['blocked_date', blocked.reason ? msg('error.pub.blockedDateWhy', { day, reason: blocked.reason }) : msg('error.pub.blockedDate', { day })];
    } else if (await occupied(db, s.account_id, s.id, at)) [code, why] = ['slot_taken', msg('sched.slot.taken')];
  }
  const locale = requestLocale();
  const summary = s && !code
    ? t(locale, (s.label ? 'sched.slot.summary' : 'sched.slot.summaryNoLabel') as Key, {
        day: local.setLocale(locale === 'es' ? 'es' : 'en-GB').toFormat('cccc d'), time: local.toFormat('HH:mm'), account: s.display_name, slot: s.label,
      })
    : null;
  return {
    slot: { id: s?.id ?? null, label: s?.label ?? null },
    account: s ? { id: s.account_id, network: s.network, display_name: s.display_name } : null,
    at: at.toISOString(), day: local.toISODate()!, time: local.toFormat('HH:mm'), timezone: zone,
    ready: code === null, code, summary, reason: why ? english(why) : null, reason_i18n: why, publication_id: publicationId,
  };
}

/** Whether something already takes this time on the account, or this slot occurrence. */
async function occupied(db: Queryable, accountId: string, slotId: string, at: Date): Promise<boolean> {
  return !!(await db.one(
    `select 1 from publication where status = any($4) and scheduled_at = $3 and (social_account_id = $1 or slot_id = $2) limit 1`,
    [accountId, slotId, at, LIVE],
  ));
}

/** What the approvers of a version chose about scheduling it by themselves: whether any said no, and the text they gave it. */
async function approversChoice(db: Queryable, versionId: string) {
  const rows = await db.query<{ approver_user_id: string; auto_schedule: boolean | null; schedule_text: string | null; schedule_first_comment: string | null }>(
    `select a.approver_user_id, a.auto_schedule, a.schedule_text, a.schedule_first_comment from approval a join version ver on ver.id = a.version_id
     where a.version_id = $1 and a.decision = 'approve' and a.approved_fingerprint = ver.fingerprint order by a.created_at, a.id`,
    [versionId],
  );
  const last = (xs: (string | null)[]) => xs.filter((x): x is string => !!x).pop() ?? '';
  return {
    declined: rows.some((r) => r.auto_schedule === false),
    text: last(rows.map((r) => r.schedule_text)),
    firstComment: last(rows.map((r) => r.schedule_first_comment)),
    approvers: [...new Set(rows.map((r) => r.approver_user_id))],
  };
}

export type SlotOutcome = (SlotSchedule & { scheduled: false }) | (SlotSchedule & { scheduled: true; publication: Row });

const notScheduled = (plan: SlotSchedule, code: string, why: Localized | string): SlotOutcome => ({
  ...plan, ready: false, summary: null, scheduled: false, code,
  reason: typeof why === 'string' ? why : english(why), reason_i18n: typeof why === 'string' ? null : why,
});

/**
 * Runs inside the approval that completes a version's approvals: a piece made for a slot is scheduled at the slot, by the approver,
 * unless an approver unticked it, the version was not approved for the slot's account, or the slot cannot take it now (its time has
 * passed, the brand is paused, the day is blocked, something else is there, or the network would refuse it). It never makes the
 * approval fail: what could not be done is in the answer, with why. Null for a piece not made for a slot.
 */
export async function scheduleOnApproval(ctx: Ctx, db: Queryable, p: Principal & { kind: 'user' }, versionId: string): Promise<SlotOutcome | null> {
  const plan = await slotScheduleOf(ctx, db, versionId);
  if (!plan) return null;
  const choice = await approversChoice(db, versionId);
  if (choice.declined) return notScheduled(plan, 'unticked', msg('sched.slot.unticked'));
  if (plan.code) return notScheduled(plan, plan.code, plan.reason_i18n ?? plan.reason ?? '');
  const eff = await effectiveApproval(db, versionId);
  if (!eff.accountIds.includes(plan.account!.id)) return notScheduled(plan, 'account_not_approved', msg('sched.slot.accountNotApproved', { account: plan.account!.display_name }));
  const input = scheduleInput.parse({ accountId: plan.account!.id, scheduledAt: plan.at, text: choice.text, firstComment: choice.firstComment });
  const by: ScheduledBy = { kind: 'person', userId: p.userId };
  // A refusal leaves the approval standing: only the scheduling is undone.
  await db.query('savepoint slot_schedule');
  try {
    const pub = await scheduleVersion(ctx, db, p, versionId, input, by, plan.slot.id);
    await db.query('release savepoint slot_schedule');
    return { ...plan, scheduled: true, publication: { id: pub.id, status: pub.status, scheduled_at: pub.scheduled_at, manual: pub.manual, scheduled_by: pub.scheduled_by } };
  } catch (err) {
    await db.query('rollback to savepoint slot_schedule');
    if (err instanceof AppError) return notScheduled(plan, err.code, err.text ?? err.message);
    throw err;
  }
}

/** For an approval that did not complete the version's approvals yet: what will happen once it does. */
export async function awaitingApprovals(ctx: Ctx, db: Queryable, versionId: string): Promise<SlotOutcome | null> {
  const plan = await slotScheduleOf(ctx, db, versionId);
  return plan && notScheduled(plan, 'awaiting_approvals', msg('sched.slot.awaitingApprovals'));
}

// ───────────────────────────── filling free slots ─────────────────────────────

/**
 * The worker's sweep for brands that fill their free slots (rules.auto_fill_slots), not paused. For each version approved since the
 * setting was switched on, oldest approval first, that has never been scheduled (nor cancelled: a person who cancelled it meant it), whose
 * variant has nothing else waiting (scheduled or on hold), and that no approver unticked: the earliest free weekly slot occurrence in the
 * next FILL_DAYS days that
 *
 * - is on an account the version was approved for, and whose network takes the piece as it is (domain/slotfit.ts: no stories, the format
 *   must suit the network, never TikTok or Pinterest, which need a setting a person chooses);
 * - for a piece made for a slot, is that slot (a later week's occurrence when its own has passed);
 * - is not taken (anything on that account at that time, or in that occurrence), not on a blocked day, and starts after the brand's
 *   preparation lead from now.
 *
 * One version per slot occurrence, ever (a unique index, and a lock per brand while it is decided). It goes out with the text the
 * approver gave it when approving (or none), as the studio's ('auto'), and whoever approved it is told.
 */
export async function fillFreeSlots(ctx: Ctx): Promise<number> {
  const brands = await ctx.db.query(`select * from brand where not paused and coalesce((approval_rules->>'auto_fill_slots')::boolean, false)`);
  let filled = 0;
  for (const b of brands) {
    try {
      filled += await fillBrand(ctx, b);
    } catch (err) {
      ctx.log.error({ err: String(err), brandId: b.id }, 'filling free slots failed');
    }
  }
  return filled;
}

async function fillBrand(ctx: Ctx, brand: Row): Promise<number> {
  const since = rulesOf(brand).auto_fill_since;
  if (!since) return 0;
  const candidates = await ctx.db.query<{ id: string; format: string; kind: string; slot_id: string | null; piece_id: string; title: string }>(
    `select ver.id, v.format, p.kind, p.slot_id, p.id as piece_id, p.title
     from version ver join variant v on v.id = ver.variant_id join piece p on p.id = v.piece_id join version_approved va on va.version_id = ver.id
     where p.brand_id = $1 and p.discarded_at is null and ver.review_state = 'approved' and va.approved_at >= $2 and p.kind <> 'story'
       and not exists (select 1 from publication x where x.version_id = ver.id)
       and not exists (select 1 from publication x where x.variant_id = ver.variant_id and x.status in ('scheduled','awaiting_reapproval','on_hold','preparing','ready','publishing'))
       and not exists (select 1 from approval a where a.version_id = ver.id and a.decision = 'approve' and a.approved_fingerprint = ver.fingerprint and a.auto_schedule = false)
     order by va.approved_at, ver.id limit 50`,
    [brand.id, since],
  );
  if (!candidates.length) return 0;
  const zone = brand.timezone as string;
  const now = ctx.now();
  const today = DateTime.fromJSDate(now, { zone });
  const cal = await calendarData(ctx, brand.id, today.toISODate()!, today.plus({ days: FILL_DAYS }).toISODate()!);
  const lead = Number(brand.publishing?.prepare_lead_minutes ?? 30) * 60_000;
  const free = cal.slots
    .filter((s) => !s.filled && !s.past && !s.blocked && new Date(s.at).getTime() > now.getTime() + lead)
    .sort((a, b) => a.at.localeCompare(b.at));
  const used = new Set<string>();
  const key = (s: { id: string; at: string }) => `${s.id}|${s.at}`;
  let filled = 0;
  for (const c of candidates) {
    const eff = await effectiveApproval(ctx.db, c.id);
    if (!eff.approved) continue;
    const fits = free.filter((s) => !used.has(key(s)) && eff.accountIds.includes(s.account_id) && slotFits(s.network, c.kind, c.format) && (!c.slot_id || s.id === c.slot_id));
    // The earliest that takes it; one taken meanwhile, or that the network would refuse, gives way to the next, a few at most.
    for (const s of fits.slice(0, 3)) {
      const out = await fillOne(ctx, brand.id, c, s).catch((err) => {
        if (err instanceof AppError) {
          ctx.log.warn({ versionId: c.id, slotId: s.id, at: s.at, code: err.code }, 'a free slot could not take an approved version');
          return 'refused' as const;
        }
        throw err;
      });
      if (out === 'taken') used.add(key(s));
      if (out === 'taken' || out === 'refused') continue;
      if (out !== 'skip') {
        used.add(key(s));
        filled++;
      }
      break;
    }
  }
  return filled;
}

async function fillOne(ctx: Ctx, brandId: string, c: { id: string; piece_id: string; title: string }, s: { id: string; at: string; account_id: string; network: string; account_name: string; label: string }) {
  return ctx.db.tx(async (db) => {
    // One sweep at a time per brand decides what goes where.
    await db.query(`select pg_advisory_xact_lock(hashtext('fill-slots:' || $1::text))`, [brandId]);
    const at = new Date(s.at);
    if (await occupied(db, s.account_id, s.id, at)) return 'taken' as const;
    // Scheduled meanwhile (by a person, or another sweep), or unticked: nothing more to do for this version.
    if (await db.one('select 1 from publication where version_id = $1 limit 1', [c.id])) return 'skip' as const;
    const choice = await approversChoice(db, c.id);
    if (choice.declined) return 'skip' as const;
    const pub = await scheduleVersion(ctx, db, null, c.id, scheduleInput.parse({ accountId: s.account_id, scheduledAt: s.at, text: choice.text, firstComment: choice.firstComment }), { kind: 'auto' }, s.id);
    const brand = await loadBrand(db, brandId);
    const local = DateTime.fromJSDate(at, { zone: brand.timezone as string });
    const vars = { day: local.toISODate()!, time: local.toFormat('HH:mm'), account: s.account_name, network: s.network, slot: s.label };
    const detail = msg(s.label ? 'sched.autoScheduled.detail' : 'sched.autoScheduled.detailNoLabel', vars);
    await notifyUsers(db, brandId, choice.approvers, 'publication.auto_scheduled', {
      pieceId: c.piece_id, publicationId: pub.id, versionId: c.id, accountId: s.account_id, account: s.account_name, network: s.network,
      at: s.at, slot: s.label, message: english(detail), message_i18n: detail,
    }, null);
    return pub;
  });
}
