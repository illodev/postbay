import { z } from 'zod';
import { authorize, type Principal } from '../auth/principal.js';
import type { Ctx } from '../context.js';
import type { Queryable, Row } from '../db.js';
import { isKnown, msg, type Key, type Localized } from '../i18n/index.js';
import { daysBetween, isoWeekday, localDay, zonedInstant } from '../domain/time.js';
import { DateTime } from 'luxon';
import { AppError, badRequest, conflict, forbidden, notFound } from '../errors.js';
import { agentOf, runCovering } from './agent.js';
import { audit } from './audit.js';
import { effectiveApproval } from './approvals.js';
import { emitPublication } from './events.js';
import { loadBrand, loadVersion, rulesOf } from './loaders.js';
import { notifyRoles } from './notify.js';
import { planPublication, wakeDependents, type Plan } from './publisher.js';
import { loadVariant } from './loaders.js';
import { storedFilesMatch } from './versions.js';

const iso = z.iso.datetime({ offset: true });

/** A publication's state as a word in a sentence, in the reader's language (the English is the state's code, as it always was). */
const pubState = (status: string): Localized | string => (isKnown(`error.pubState.${status}`) ? msg(`error.pubState.${status}` as Key) : status);

export const scheduleInput = z.object({
  accountId: z.string().uuid(),
  scheduledAt: iso,
  text: z.string().max(10_000).default(''),
  firstComment: z.string().max(5000).default(''),
  options: z.record(z.string(), z.unknown()).default({}),
  dependsOn: z.string().uuid().nullish(),
  /** "auto" insists on automatic publishing and is refused if the network cannot do it; "manual" always means a person. Unset = automatic when possible. */
  mode: z.enum(['auto', 'manual']).optional(),
  /** Which kind of post (a Reel or a feed photo, say). Unset = the connector picks from the content. */
  placement: z.string().max(40).optional(),
});

export const validateInput = scheduleInput.partial({ scheduledAt: true });

export const patchInput = z.object({
  scheduledAt: iso.optional(),
  text: z.string().max(10_000).optional(),
  firstComment: z.string().max(5000).optional(),
  /** The title that goes out with it (YouTube, LinkedIn, Pinterest, TikTok). Unset: the one the version was approved with. */
  title: z.string().trim().min(1).max(200).optional(),
});

export const rescheduleInput = z.object({
  versionId: z.string().uuid(),
  scheduledAt: iso.optional(),
});

export const markPublishedInput = z.object({
  url: z
    .string()
    .url()
    .max(2000)
    .refine((u) => /^https?:\/\//i.test(u), 'The link must start with http:// or https://')
    .optional(),
  externalId: z.string().max(200).optional(),
});

/** Anything that can still be cancelled: not yet out, and not in the middle of going out. */
const OPEN = ['scheduled', 'awaiting_reapproval', 'on_hold', 'preparing', 'ready', 'failed'];
/** Statuses where a publication is waiting for its hour and has not been touched by a connector yet. */
const UNSTARTED = ['scheduled', 'awaiting_reapproval'];

const leadMinutes = (brand: Row) => Number(brand.publishing?.prepare_lead_minutes ?? 30);
const prepareAt = (brand: Row, when: Date) => new Date(when.getTime() - leadMinutes(brand) * 60_000);

async function loadPublication(db: Queryable, id: string, lock = false) {
  const row = await db.one(
    `select pub.*, p.brand_id, p.id as piece_id, p.title as piece_title
     from publication pub join variant v on v.id = pub.variant_id join piece p on p.id = v.piece_id
     where pub.id = $1 ${lock ? 'for update of pub' : ''}`,
    [id],
  );
  if (!row) throw notFound('Publication');
  return row;
}

function requireUser(p: Principal): string {
  if (p.kind !== 'user') throw forbidden(msg('error.pub.peopleOnly'));
  return p.userId;
}

async function assertSchedulable(db: Queryable, brand: Row, when: Date, now: Date) {
  if (brand.paused) throw conflict('brand_paused', msg('error.pub.brandPaused'));
  if (when.getTime() <= now.getTime()) throw badRequest('past_date', msg('error.pub.pastDate'));
  const day = localDay(when, brand.timezone);
  const blocked = await db.one('select reason from blocked_date where brand_id = $1 and day = $2', [brand.id, day]);
  if (blocked) throw conflict('blocked_date', blocked.reason ? msg('error.pub.blockedDateWhy', { day, reason: blocked.reason }) : msg('error.pub.blockedDate', { day }));
}

const isUniqueViolation = (err: unknown) => (err as { code?: string }).code === '23505';

/**
 * Takes the variant's lock for the rest of the transaction, the one closing a new version takes for update. A publication put on the
 * calendar here and a new version closed at the same moment then happen one after the other: either the new version sees this
 * publication and holds it, or this sees the version superseded and refuses.
 */
async function lockVariant(db: Queryable, variantId: string) {
  await db.query('select 1 from variant where id = $1 for share', [variantId]);
}

/**
 * Keeps an order between publications right: not before the one it depends on, and not after one that depends on it (unless that
 * one is out already or no longer going out).
 */
async function assertOrder(db: Queryable, brandId: string, when: Date, dependsOn: string | null, selfId: string | null) {
  if (dependsOn) {
    const dep = await db.one(
      `select pub.scheduled_at, pub.status from publication pub join variant v on v.id = pub.variant_id join piece p on p.id = v.piece_id
       where pub.id = $1 and p.brand_id = $2 and pub.status <> 'cancelled'`,
      [dependsOn, brandId],
    );
    if (!dep) throw badRequest('invalid_dependency', msg('error.pub.dependencyMissing'));
    if (dep.status !== 'published' && when < new Date(dep.scheduled_at)) throw badRequest('invalid_dependency', msg('error.pub.dependencyLater'));
  }
  if (selfId) {
    const early = await db.one(
      `select id, scheduled_at from publication where depends_on = $1 and scheduled_at < $2
         and status in ('scheduled','awaiting_reapproval','on_hold','preparing','ready') order by scheduled_at limit 1`,
      [selfId, when],
    );
    if (early) {
      throw badRequest('invalid_dependency', msg('error.pub.dependentEarlier', { at: new Date(early.scheduled_at).toISOString() }), { publicationId: early.id });
    }
  }
}

const errorsOf = (plan: Plan) => plan.issues.filter((i) => i.severity === 'error');

/**
 * Checks what scheduling this would do, without doing it: whether the app will publish it itself or a person has to, which
 * kind of post it would be, and anything the network would refuse. The editor calls this as the person types.
 */
export async function validatePublication(ctx: Ctx, p: Principal, versionId: string, raw: unknown) {
  const input = validateInput.parse(raw);
  const version = await loadVersion(ctx.db, versionId);
  await schedulerOf(ctx, ctx.db, p, version.brand_id, version.piece_id);
  const variant = await loadVariant(ctx.db, version.variant_id);
  const piece = await ctx.db.one('select * from piece where id = $1', [version.piece_id]);
  const plan = await planPublication(ctx, {
    brandId: version.brand_id, versionId, accountId: input.accountId, piece: piece!, variantFormat: variant.format, text: input.text,
    firstComment: input.firstComment, options: input.options, scheduledAt: new Date(input.scheduledAt ?? ctx.now().getTime() + 86_400_000),
    mode: input.mode, placement: input.placement,
  });
  return plan;
}

/**
 * Who puts a publication on the calendar. Always after a person's approval of that version, for an account it was approved for: a
 * person scheduling it (or approving a piece made for a slot, which schedules it at the slot), the studio filling a free slot ('auto'),
 * or the agent, with a producer token inside one of its runs, where the brand allows it ('agent').
 */
export type ScheduledBy = { kind: 'person'; userId: string } | { kind: 'auto' } | { kind: 'agent'; tokenId: string };

/**
 * Schedules an approved version on an account. Only what is approved, for the accounts approved, can be scheduled. A person with the
 * permission to schedule may; so may a producer token, inside an agent run on the piece that is still going, when the brand lets the
 * agent schedule what is approved (agent.can_schedule_approved): it is then recorded as scheduled by the agent.
 */
export async function schedule(ctx: Ctx, p: Principal, versionId: string, raw: unknown) {
  const input = scheduleInput.parse(raw);
  return ctx.db.tx(async (db) => {
    const version = await loadVersion(db, versionId);
    const by = await schedulerOf(ctx, db, p, version.brand_id, version.piece_id);
    return scheduleVersion(ctx, db, p, versionId, input, by);
  });
}

/** Whether this principal may schedule in the brand, and as whom. */
async function schedulerOf(ctx: Ctx, db: Queryable, p: Principal, brandId: string, pieceId: string): Promise<ScheduledBy> {
  if (p.kind === 'token') {
    await authorize(db, p, brandId, 'brand.view');
    const brand = await loadBrand(db, brandId);
    if (!agentOf(brand).can_schedule_approved) throw new AppError(403, 'agent_cannot_schedule', msg('sched.agent.off'));
    if (!(await runCovering(db, p.tokenId, pieceId, ctx.now(), 'schedule'))) throw conflict('no_run', msg('sched.agent.noRun'));
    return { kind: 'agent', tokenId: p.tokenId };
  }
  await authorize(db, p, brandId, 'publication.schedule');
  return { kind: 'person', userId: requireUser(p) };
}

/**
 * The scheduling itself, in the caller's transaction, whoever does it: every check a person's scheduling goes through (the brand is not
 * paused, the date is not blocked or past, the version is approved for that account and its stored files are still the approved ones,
 * the order between posts, what the network would refuse). `slotId` names the slot occurrence it fills.
 */
export async function scheduleVersion(
  ctx: Ctx, db: Queryable, p: Principal | null, versionId: string, input: z.infer<typeof scheduleInput>, by: ScheduledBy, slotId: string | null = null,
): Promise<Row> {
  const when = new Date(input.scheduledAt);
  // A post that depends on another holds that other one to its order: the agent does not get to tie a person's post down.
  if (by.kind === 'agent' && input.dependsOn) throw badRequest('invalid_dependency', msg('sched.agent.noDependency'));
  const version = await loadVersion(db, versionId);
  await lockVariant(db, version.variant_id);
  const brand = await loadBrand(db, version.brand_id);
  await assertSchedulable(db, brand, when, ctx.now());
  const eff = await effectiveApproval(db, versionId);
  if (!eff.approved) throw conflict('not_approved', msg('error.pub.versionNotApproved'));
  if (!eff.accountIds.includes(input.accountId)) throw conflict('account_not_approved', msg('error.pub.versionNotForAccount'));
  if (!(await storedFilesMatch(ctx, versionId, db))) throw conflict('fingerprint_mismatch', msg('error.pub.filesChanged'));
  await assertOrder(db, version.brand_id, when, input.dependsOn ?? null, null);

  // How will it go out? Automatic when the account is connected and the network can do this content; otherwise a person.
  const variant = await loadVariant(db, version.variant_id);
  const piece = (await db.one('select * from piece where id = $1', [version.piece_id]))!;
  // The title and the AI label go out as they were approved; the label also if it has been added since.
  const title = eff.title ?? piece.title;
  const ai = eff.aiGenerated || !!piece.ai_generated;
  const plan = await planPublication(ctx, {
    brandId: version.brand_id, versionId, accountId: input.accountId, piece, variantFormat: variant.format, text: input.text,
    firstComment: input.firstComment, options: input.options, scheduledAt: when, mode: input.mode, placement: input.placement, title, aiGenerated: ai,
  });
  if (input.mode === 'auto' && !plan.automated) throw conflict('cannot_automate', plan.manualReason ?? msg('error.pub.cannotAutomate'));
  if (plan.automated && errorsOf(plan).length) {
    throw badRequest('validation_failed', errorsOf(plan).map((i) => i.message).join(' '), { issues: plan.issues });
  }
  const manual = !plan.automated;
  const prepare = manual ? null : prepareAt(brand, when);

  try {
    const pub = (await db.one(
      `insert into publication (variant_id, social_account_id, version_id, text, first_comment, options, scheduled_at, depends_on, created_by,
                                manual, placement, prepare_at, next_run_at, title, ai_generated, created_by_token, scheduled_by, slot_id)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::timestamptz,$12::timestamptz,$13,$14,$15,$16,$17) returning *`,
      [version.variant_id, input.accountId, versionId, input.text, input.firstComment, JSON.stringify(input.options), when, input.dependsOn ?? null,
        by.kind === 'person' ? by.userId : null, manual, plan.placement, prepare, title, ai, by.kind === 'agent' ? by.tokenId : null, by.kind, slotId],
    ))!;
    await audit(db, p, version.brand_id, 'publication.scheduled', 'publication', pub.id, null,
      { version_id: versionId, account_id: input.accountId, scheduled_at: when.toISOString(), fingerprint: eff.fingerprint, manual, placement: plan.placement, title, ai_generated: ai,
        scheduled_by: by.kind, slot_id: slotId });
    return { ...pub, issues: plan.issues, manual_reason: plan.manualReason ?? null };
  } catch (err) {
    if (isUniqueViolation(err)) throw conflict('slot_taken', msg('error.pub.slotTaken'));
    throw err;
  }
}

/**
 * Moves a publication or edits its text. If the brand requires it, any change to something already scheduled
 * needs a second person to confirm it before it counts again. An automatic publication can only be changed before
 * its preparation starts: after that it is already on the network, so it has to be cancelled and scheduled again.
 */
export async function patchPublication(ctx: Ctx, p: Principal, pubId: string, raw: unknown) {
  const input = patchInput.parse(raw);
  return ctx.db.tx(async (db) => {
    const before = await loadPublication(db, pubId, true);
    await authorize(db, p, before.brand_id, 'publication.schedule');
    const userId = requireUser(p);
    if (before.status === 'on_hold') throw conflict('on_hold', msg('error.pub.onHold'));
    if (!before.manual && ['preparing', 'ready', 'publishing'].includes(before.status)) {
      throw conflict('already_prepared', msg('error.pub.alreadyPrepared'));
    }
    if (!['scheduled', 'awaiting_reapproval'].includes(before.status)) throw conflict('invalid_state', msg('error.pub.cannotChange', { state: pubState(before.status) }));
    const brand = await loadBrand(db, before.brand_id);
    const when = input.scheduledAt ? new Date(input.scheduledAt) : null;
    if (when) await assertSchedulable(db, brand, when, ctx.now());
    else if (brand.paused) throw conflict('brand_paused', msg('error.pub.brandPaused'));

    const moved = when !== null && when.getTime() !== new Date(before.scheduled_at).getTime();
    const changed =
      moved ||
      (input.text !== undefined && input.text !== before.text) ||
      (input.firstComment !== undefined && input.firstComment !== before.first_comment) ||
      (input.title !== undefined && input.title !== before.title);
    if (!changed) return before;

    const nextWhen = when ?? new Date(before.scheduled_at);
    if (moved) await assertOrder(db, before.brand_id, nextWhen, before.depends_on, pubId);
    if (!before.manual) {
      // Re-check what the network would say to the new time or text.
      const version = await loadVersion(db, before.version_id);
      const variant = await loadVariant(db, version.variant_id);
      const piece = (await db.one('select * from piece where id = $1', [version.piece_id]))!;
      const plan = await planPublication(ctx, {
        brandId: before.brand_id, versionId: before.version_id, accountId: before.social_account_id, piece, variantFormat: variant.format,
        text: input.text ?? before.text, firstComment: input.firstComment ?? before.first_comment, options: before.options ?? {}, scheduledAt: nextWhen,
        mode: 'auto', placement: before.placement ?? undefined, title: input.title ?? before.title ?? undefined, aiGenerated: !!before.ai_generated || !!piece.ai_generated,
      });
      if (errorsOf(plan).length) throw badRequest('validation_failed', errorsOf(plan).map((i) => i.message).join(' '), { issues: plan.issues });
    }

    const needsConfirm = rulesOf(brand).reapprove_on_move;
    const prepare = before.manual ? null : prepareAt(brand, nextWhen);
    try {
      const after = (await db.one(
        `update publication set slot_id = case when $2::timestamptz is null or $2::timestamptz = scheduled_at then slot_id end,
           scheduled_at = coalesce($2, scheduled_at), text = coalesce($3, text),
           first_comment = coalesce($4, first_comment), title = coalesce($8, title), moved_by = $5, due_notified_at = null, updated_at = now(),
           prepare_at = $7::timestamptz, next_run_at = case when $6::boolean then null else $7::timestamptz end,
           status = case when $6::boolean then 'awaiting_reapproval' else status end
         where id = $1 returning *`,
        [pubId, when, input.text ?? null, input.firstComment ?? null, userId, needsConfirm, prepare, input.title ?? null],
      ))!;
      await audit(db, p, before.brand_id, 'publication.changed', 'publication', pubId,
        { scheduled_at: before.scheduled_at, text: before.text, title: before.title, status: before.status },
        { scheduled_at: after.scheduled_at, text: after.text, title: after.title, status: after.status });
      if (needsConfirm) {
        await notifyRoles(db, before.brand_id, ['approver', 'admin'], 'publication.reapproval',
          { publicationId: pubId, pieceId: before.piece_id }, userId);
      }
      return after;
    } catch (err) {
      if (isUniqueViolation(err)) throw conflict('slot_taken', msg('error.pub.slotTaken'));
      throw err;
    }
  });
}

/** A different approver confirms a change that needed a second look. */
export async function confirmPublication(ctx: Ctx, p: Principal, pubId: string) {
  return ctx.db.tx(async (db) => {
    const pub = await loadPublication(db, pubId, true);
    await authorize(db, p, pub.brand_id, 'publication.schedule');
    const userId = requireUser(p);
    if (pub.status !== 'awaiting_reapproval') throw conflict('invalid_state', msg('error.pub.notAwaitingConfirmation'));
    if (pub.moved_by === userId) throw forbidden(msg('error.pub.someoneElseConfirms'));
    const eff = await effectiveApproval(db, pub.version_id);
    if (!eff.approved || !eff.accountIds.includes(pub.social_account_id)) {
      throw conflict('not_approved', msg('pub.hold.approvalLapsed'));
    }
    const row = (await db.one(
      `update publication set status = 'scheduled', updated_at = now(), next_run_at = case when manual then null else prepare_at end where id = $1 returning *`,
      [pubId],
    ))!;
    await audit(db, p, pub.brand_id, 'publication.confirmed', 'publication', pubId, { status: pub.status }, { status: 'scheduled' });
    return row;
  });
}

/**
 * Cancels a publication. One the network is already holding (a scheduled Facebook post, an uploaded YouTube video) is taken
 * down by the worker straight away; until then it could still go out at its hour, which is why this happens at once.
 */
export async function cancelPublication(ctx: Ctx, p: Principal, pubId: string) {
  return ctx.db.tx(async (db) => {
    const pub = await loadPublication(db, pubId, true);
    await authorize(db, p, pub.brand_id, 'publication.schedule');
    requireUser(p);
    if (pub.status === 'publishing') throw conflict('in_flight', msg('error.pub.inFlight'));
    if (!OPEN.includes(pub.status)) throw conflict('invalid_state', msg('error.pub.cannotCancel', { state: pubState(pub.status) }));
    const row = (await db.one(
      `update publication set status = 'cancelled', updated_at = now(),
         next_run_at = case when native_scheduled or held_on_network then $2::timestamptz else null end where id = $1 returning *`,
      [pubId, ctx.now()],
    ))!;
    await audit(db, p, pub.brand_id, 'publication.cancelled', 'publication', pubId, { status: pub.status }, { status: 'cancelled' });
    return row;
  });
}

/** Puts a held publication back on the calendar with a newly approved version of the same variant. */
export async function reschedulePublication(ctx: Ctx, p: Principal, pubId: string, raw: unknown) {
  const input = rescheduleInput.parse(raw);
  return ctx.db.tx(async (db) => {
    const pub = await loadPublication(db, pubId, true);
    await authorize(db, p, pub.brand_id, 'publication.schedule');
    requireUser(p);
    if (pub.status !== 'on_hold') throw conflict('invalid_state', msg('error.pub.onlyOnHoldRescheduled'));
    if (pub.native_scheduled || pub.held_on_network) throw conflict('cleanup_pending', msg('error.pub.heldStillComingDown'));
    await lockVariant(db, pub.variant_id);
    const version = await loadVersion(db, input.versionId);
    if (version.variant_id !== pub.variant_id) throw badRequest('invalid_version', msg('error.pub.versionOtherVariant'));
    const eff = await effectiveApproval(db, input.versionId);
    if (!eff.approved) throw conflict('not_approved', msg('error.pub.thatVersionNotApproved'));
    if (!eff.accountIds.includes(pub.social_account_id)) throw conflict('account_not_approved', msg('error.pub.thatVersionNotForAccount'));
    if (!(await storedFilesMatch(ctx, input.versionId, db))) throw conflict('fingerprint_mismatch', msg('error.pub.filesChanged'));
    const brand = await loadBrand(db, pub.brand_id);
    const when = input.scheduledAt ? new Date(input.scheduledAt) : new Date(pub.scheduled_at);
    await assertSchedulable(db, brand, when, ctx.now());
    await assertOrder(db, pub.brand_id, when, pub.depends_on, pubId);
    const prepare = pub.manual ? null : prepareAt(brand, when);
    const piece = (await db.one<{ title: string; ai_generated: boolean }>('select title, ai_generated from piece where id = $1', [pub.piece_id]))!;
    try {
      const row = (await db.one(
        `update publication set status = 'scheduled', version_id = $2, slot_id = case when scheduled_at = $3 then slot_id end, scheduled_at = $3,
           hold_reason = null, due_notified_at = null, updated_at = now(),
           handle = '{}', attempts = 0, verify_attempts = 0, last_error = null, last_error_class = null, prepare_at = $4::timestamptz, next_run_at = $4::timestamptz,
           publish_progress_at = null, frozen_at = null, title = $5, ai_generated = $6
         where id = $1 returning *`,
        [pubId, input.versionId, when, prepare, eff.title ?? piece.title, eff.aiGenerated || piece.ai_generated],
      ))!;
      await audit(db, p, pub.brand_id, 'publication.rescheduled', 'publication', pubId,
        { version_id: pub.version_id, status: 'on_hold' }, { version_id: input.versionId, status: 'scheduled', fingerprint: eff.fingerprint });
      return row;
    } catch (err) {
      if (isUniqueViolation(err)) throw conflict('slot_taken', msg('error.pub.slotTaken'));
      throw err;
    }
  });
}

export const retryInput = z.object({ scheduledAt: iso.optional() });

/**
 * Tries a failed automatic publication again. Whatever the network was holding has been taken down by then, so it starts
 * clean; unless publishing had begun and the network may already have the post: then what the connector recorded is kept and the
 * retry finishes that send through the connector's recovery (which never posts twice), skipping preparation. If its hour has
 * passed it is moved a couple of minutes ahead, because the app never publishes late by itself.
 */
export async function retryPublication(ctx: Ctx, p: Principal, pubId: string, raw: unknown) {
  const input = retryInput.parse(raw ?? {});
  return ctx.db.tx(async (db) => {
    const pub = await loadPublication(db, pubId, true);
    await authorize(db, p, pub.brand_id, 'publication.schedule');
    requireUser(p);
    if (pub.manual || pub.status !== 'failed') throw conflict('invalid_state', msg('error.pub.onlyFailedRetried'));
    if (pub.native_scheduled || pub.held_on_network) throw conflict('cleanup_pending', msg('error.pub.stillComingDown'));
    await lockVariant(db, pub.variant_id);
    const brand = await loadBrand(db, pub.brand_id);
    const eff = await effectiveApproval(db, pub.version_id);
    if (!eff.approved || !eff.accountIds.includes(pub.social_account_id)) throw conflict('not_approved', msg('pub.hold.approvalLapsed'));
    if (!(await storedFilesMatch(ctx, pub.version_id, db))) throw conflict('fingerprint_mismatch', msg('error.pub.filesChanged'));
    const now = ctx.now();
    let when = input.scheduledAt ? new Date(input.scheduledAt) : new Date(pub.scheduled_at);
    if (when.getTime() < now.getTime() + 120_000) when = new Date(now.getTime() + 120_000);
    await assertSchedulable(db, brand, when, now);
    await assertOrder(db, pub.brand_id, when, pub.depends_on, pubId);
    // Publishing had begun: the network may have the post, and what the connector wrote down is how it is found again.
    const resume = !!pub.publish_progress_at;
    try {
      const row = (await db.one(
        `update publication set status = case when $4 then 'ready' else 'scheduled' end, slot_id = case when scheduled_at = $2 then slot_id end, scheduled_at = $2,
           handle = case when $4 then handle else '{}'::jsonb end, attempts = 0, verify_attempts = 0, failed_at = null,
           last_error = null, last_error_class = null, external_id = null, url = null, visibility = null, frozen_at = null,
           prepare_at = $3::timestamptz, next_run_at = case when $4 then $2 else $3::timestamptz end, updated_at = now()
         where id = $1 returning *`,
        [pubId, when, prepareAt(brand, when), resume],
      ))!;
      await audit(db, p, pub.brand_id, 'publication.retried', 'publication', pubId, { status: 'failed' }, { status: row.status, scheduled_at: when.toISOString(), resumed: resume });
      return row;
    } catch (err) {
      if (isUniqueViolation(err)) throw conflict('slot_taken', msg('error.pub.slotTaken'));
      throw err;
    }
  });
}

/** Gives up on automation for one publication: it becomes a manual one, with the files and text ready for a person. */
export async function handOverPublication(ctx: Ctx, p: Principal, pubId: string) {
  return ctx.db.tx(async (db) => {
    const pub = await loadPublication(db, pubId, true);
    await authorize(db, p, pub.brand_id, 'publication.schedule');
    requireUser(p);
    if (pub.manual) throw conflict('invalid_state', msg('error.pub.alreadyByHand'));
    if (pub.native_scheduled || pub.held_on_network || !['scheduled', 'failed'].includes(pub.status)) {
      throw conflict('invalid_state', msg('error.pub.cannotHandOver'));
    }
    const row = (await db.one(
      `update publication set manual = true, status = 'scheduled', handle = '{}', next_run_at = null, prepare_at = null, attempts = 0, frozen_at = null,
         failed_at = null, last_error = null, last_error_class = null, due_notified_at = null, updated_at = now() where id = $1 returning *`,
      [pubId],
    ))!;
    await audit(db, p, pub.brand_id, 'publication.handed_over', 'publication', pubId, { manual: false }, { manual: true });
    return row;
  });
}

/** Asks the worker to look at a published post again (a YouTube video that was private, now that the audit has passed). */
export async function recheckPublication(ctx: Ctx, p: Principal, pubId: string) {
  return ctx.db.tx(async (db) => {
    const pub = await loadPublication(db, pubId, true);
    await authorize(db, p, pub.brand_id, 'publication.schedule');
    requireUser(p);
    if (pub.manual || pub.status !== 'published') throw conflict('invalid_state', msg('error.pub.onlyPublishedRechecked'));
    await db.query('update publication set next_run_at = $2, verify_attempts = 0 where id = $1', [pubId, ctx.now()]);
    return { id: pubId };
  });
}

export async function listAttempts(ctx: Ctx, p: Principal, pubId: string) {
  const pub = await loadPublication(ctx.db, pubId);
  await authorize(ctx.db, p, pub.brand_id, 'brand.view');
  return ctx.db.query(
    `select id, step, attempt, started_at, outcome, error_class, http_status, detail from publication_attempt where publication_id = $1 order by id`,
    [pubId],
  );
}

/** In phase 1 a person publishes by hand and records it here, with the link if there is one. Automatic publications do this themselves. */
export async function markPublished(ctx: Ctx, p: Principal, pubId: string, raw: unknown) {
  const input = markPublishedInput.parse(raw);
  return ctx.db.tx(async (db) => {
    const pub = await loadPublication(db, pubId, true);
    await authorize(db, p, pub.brand_id, 'publication.schedule');
    const userId = requireUser(p);
    if (!pub.manual) throw conflict('automatic', msg('error.pub.automatic'));
    if (pub.status !== 'scheduled') throw conflict('invalid_state', msg('error.pub.cannotMarkPublished', { state: pubState(pub.status) }));
    const eff = await effectiveApproval(db, pub.version_id);
    if (!eff.approved || !eff.accountIds.includes(pub.social_account_id) || !(await storedFilesMatch(ctx, pub.version_id, db))) {
      throw conflict('not_approved', msg('pub.hold.approvalLapsed'));
    }
    if (pub.depends_on) {
      const dep = await db.one('select status from publication where id = $1', [pub.depends_on]);
      if (dep && dep.status !== 'published') throw conflict('dependency_pending', msg('error.pub.dependencyPending'));
    }
    const row = (await db.one(
      `update publication set status = 'published', published_at = now(), published_by = $2, url = $3, external_id = $4, visibility = 'public', updated_at = now()
       where id = $1 returning *`,
      [pubId, userId, input.url ?? null, input.externalId ?? null],
    ))!;
    await audit(db, p, pub.brand_id, 'publication.published', 'publication', pubId, { status: 'scheduled' }, { status: 'published', url: input.url ?? null });
    await emitPublication(ctx, db, pub.brand_id, pubId, 'publication.published');
    await wakeDependents(db, pubId, ctx.now());
    return row;
  });
}

/** What the person who publishes by hand needs: the files, the text and the first comment, ready to copy. */
export async function publicationPack(ctx: Ctx, p: Principal, pubId: string) {
  const pub = await loadPublication(ctx.db, pubId);
  await authorize(ctx.db, p, pub.brand_id, 'brand.view');
  const assets = await ctx.db.query('select * from asset where version_id = $1 order by position, kind', [pub.version_id]);
  const account = await ctx.db.one('select network, display_name from social_account where id = $1', [pub.social_account_id]);
  const files = [];
  for (const a of assets) {
    files.push({
      kind: a.kind, position: a.position, name: a.name, mime: a.mime, bytes: a.bytes,
      url: await ctx.storage.presignGet(a.storage_key, { expiresSec: 3600, filename: a.name }),
    });
  }
  return {
    id: pub.id, status: pub.status, manual: pub.manual, scheduled_at: pub.scheduled_at, text: pub.text, first_comment: pub.first_comment,
    account, piece: { id: pub.piece_id, title: pub.piece_title }, files, last_error: pub.last_error, last_error_i18n: pub.last_error_i18n ?? null,
  };
}

/** Manual publications that are due: scheduled, past their time and not blocked by one they depend on. Empty while the brand is paused. */
export async function duePublications(ctx: Ctx, p: Principal, brandId: string) {
  await authorize(ctx.db, p, brandId, 'brand.view');
  return ctx.db.query(
    `select pub.id, pub.scheduled_at, pub.text, pub.status, p.id as piece_id, p.title as piece_title, sa.network, sa.display_name as account_name,
       pub.last_error, pub.last_error_i18n,
       (pub.depends_on is not null and exists (select 1 from publication d where d.id = pub.depends_on and d.status <> 'published')) as waiting_for_dependency
     from publication pub
     join variant v on v.id = pub.variant_id join piece p on p.id = v.piece_id
     join social_account sa on sa.id = pub.social_account_id
     join brand b on b.id = p.brand_id
     where p.brand_id = $1 and pub.manual and pub.status = 'scheduled' and pub.scheduled_at <= $2 and not b.paused
     order by pub.scheduled_at`,
    [brandId, ctx.now()],
  );
}

export interface CalendarSlot {
  id: string;
  account_id: string;
  network: string;
  account_name: string;
  label: string;
  day: string;
  at: string;
  filled: boolean;
  past: boolean;
  blocked: boolean;
}

/**
 * Calendar for a brand between two local dates (inclusive): publications, blocked dates and the fixed slots
 * expanded into concrete instants in the brand's own time zone.
 */
export async function calendar(ctx: Ctx, p: Principal, brandId: string, from: string, to: string) {
  await authorize(ctx.db, p, brandId, 'brand.view');
  return calendarData(ctx, brandId, from, to);
}

/** The same, without asking who is looking: for the app's own jobs. */
export async function calendarData(ctx: Ctx, brandId: string, from: string, to: string) {
  const brand = await loadBrand(ctx.db, brandId);
  const days = daysBetween(from, to);
  if (days.length === 0 || days.length > 366) throw badRequest('invalid_range', msg('error.pub.invalidRange'));
  const zone = brand.timezone as string;
  const start = zonedInstant(days[0]!, '00:00', zone);
  const end = DateTime.fromJSDate(zonedInstant(days[days.length - 1]!, '00:00', zone), { zone }).plus({ days: 1 }).toJSDate();

  const publications = await ctx.db.query(
    `select pub.id, pub.status, pub.scheduled_at, pub.text, pub.hold_reason, pub.url, pub.depends_on, pub.social_account_id as account_id,
       pub.manual, pub.visibility, pub.last_error, pub.last_error_class, pub.native_scheduled, pub.placement, pub.hold_reason_i18n, pub.last_error_i18n,
       sa.network, sa.display_name as account_name, p.id as piece_id, p.title as piece_title, ver.number as version_number,
       pub.scheduled_by, coalesce(cu.name, cu.email, ct.name) as scheduled_by_name, pub.slot_id
     from publication pub
     join variant v on v.id = pub.variant_id join piece p on p.id = v.piece_id
     join social_account sa on sa.id = pub.social_account_id join version ver on ver.id = pub.version_id
     left join app_user cu on cu.id = pub.created_by left join api_token ct on ct.id = pub.created_by_token
     where p.brand_id = $1 and pub.status <> 'cancelled' and pub.scheduled_at >= $2 and pub.scheduled_at < $3
     order by pub.scheduled_at`,
    [brandId, start, end],
  );
  const blocked = await ctx.db.query('select day, reason from blocked_date where brand_id = $1 and day between $2 and $3 order by day', [brandId, days[0], days[days.length - 1]]);
  const blockedDays = new Set(blocked.map((b) => b.day as string));
  const slotRows = await ctx.db.query(
    `select s.id, s.weekday, to_char(s.local_time, 'HH24:MI') as local_time, s.label, s.social_account_id as account_id,
       sa.network, sa.display_name as account_name
     from slot s join social_account sa on sa.id = s.social_account_id where s.brand_id = $1 and s.active`,
    [brandId],
  );
  // A slot occurrence is filled by anything on its account at its time, and by what was scheduled into it (moved or not).
  const taken = new Set(publications.map((x) => `${x.account_id}|${new Date(x.scheduled_at).getTime()}`));
  for (const x of publications) if (x.slot_id) taken.add(`slot:${x.slot_id}|${new Date(x.scheduled_at).getTime()}`);
  const slots: CalendarSlot[] = [];
  for (const day of days) {
    for (const s of slotRows) {
      if (s.weekday !== isoWeekday(day)) continue;
      const at = zonedInstant(day, s.local_time, zone);
      slots.push({
        id: s.id, account_id: s.account_id, network: s.network, account_name: s.account_name, label: s.label, day,
        at: at.toISOString(), filled: taken.has(`${s.account_id}|${at.getTime()}`) || taken.has(`slot:${s.id}|${at.getTime()}`),
        past: at.getTime() <= ctx.now().getTime(), blocked: blockedDays.has(day),
      });
    }
  }
  return { timezone: zone, paused: brand.paused as boolean, publications, blocked, slots };
}

/** Slots with nothing scheduled that are still ahead and not on a blocked date: the ones asking for content. */
export async function emptySlots(ctx: Ctx, p: Principal, brandId: string, from: string, to: string) {
  const cal = await calendar(ctx, p, brandId, from, to);
  return cal.slots.filter((s) => !s.filled && !s.past && !s.blocked);
}

export { AppError };

/**
 * Adds to publication rows read without them the texts kept as codes (why each is on hold, why it failed), so the answer carries them
 * in the reader's language (see renderStored in src/i18n). For a reader that selects only some columns of a publication.
 */
export async function attachKeptTexts<T extends { id: string; hold_reason_i18n?: unknown; last_error_i18n?: unknown }>(db: Queryable, rows: T[]): Promise<T[]> {
  const missing = rows.filter((r) => !('last_error_i18n' in r) || !('hold_reason_i18n' in r));
  if (!missing.length) return rows;
  const kept = await db.query<{ id: string; hold_reason_i18n: unknown; last_error_i18n: unknown }>(
    'select id, hold_reason_i18n, last_error_i18n from publication where id = any($1)', [missing.map((r) => r.id)],
  );
  const byId = new Map(kept.map((k) => [k.id, k]));
  for (const r of missing) {
    const k = byId.get(r.id);
    if (k) Object.assign(r, { hold_reason_i18n: k.hold_reason_i18n, last_error_i18n: k.last_error_i18n });
  }
  return rows;
}
