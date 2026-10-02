import { z } from 'zod';
import { authorize, type Principal } from '../auth/principal.js';
import type { Ctx } from '../context.js';
import type { Queryable, Row } from '../db.js';
import { daysBetween, isoWeekday, localDay, zonedInstant } from '../domain/time.js';
import { DateTime } from 'luxon';
import { AppError, badRequest, conflict, forbidden, notFound } from '../errors.js';
import { audit } from './audit.js';
import { effectiveApproval } from './approvals.js';
import { emitPublication } from './events.js';
import { loadBrand, loadVersion, rulesOf } from './loaders.js';
import { notifyRoles } from './notify.js';
import { planPublication, type Plan } from './publisher.js';
import { loadVariant } from './loaders.js';

const iso = z.iso.datetime({ offset: true });

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
  if (p.kind !== 'user') throw forbidden('Only people can schedule publications');
  return p.userId;
}

async function assertSchedulable(db: Queryable, brand: Row, when: Date, now: Date) {
  if (brand.paused) throw conflict('brand_paused', 'The brand is paused: nothing can be scheduled or moved');
  if (when.getTime() <= now.getTime()) throw badRequest('past_date', 'The date must be in the future');
  const day = localDay(when, brand.timezone);
  const blocked = await db.one('select reason from blocked_date where brand_id = $1 and day = $2', [brand.id, day]);
  if (blocked) throw conflict('blocked_date', `Nothing is published on ${day}${blocked.reason ? ` (${blocked.reason})` : ''}`);
}

const isUniqueViolation = (err: unknown) => (err as { code?: string }).code === '23505';

const errorsOf = (plan: Plan) => plan.issues.filter((i) => i.severity === 'error');

/**
 * Checks what scheduling this would do, without doing it: whether the app will publish it itself or a person has to, which
 * kind of post it would be, and anything the network would refuse. The editor calls this as the person types.
 */
export async function validatePublication(ctx: Ctx, p: Principal, versionId: string, raw: unknown) {
  const input = validateInput.parse(raw);
  const version = await loadVersion(ctx.db, versionId);
  await authorize(ctx.db, p, version.brand_id, 'publication.schedule');
  const variant = await loadVariant(ctx.db, version.variant_id);
  const piece = await ctx.db.one('select * from piece where id = $1', [version.piece_id]);
  const plan = await planPublication(ctx, {
    brandId: version.brand_id, versionId, accountId: input.accountId, piece: piece!, variantFormat: variant.format, text: input.text,
    firstComment: input.firstComment, options: input.options, scheduledAt: new Date(input.scheduledAt ?? ctx.now().getTime() + 86_400_000),
    mode: input.mode, placement: input.placement,
  });
  return plan;
}

/** Schedules an approved version on an account. Only what is approved, for the accounts approved, can be scheduled. */
export async function schedule(ctx: Ctx, p: Principal, versionId: string, raw: unknown) {
  const input = scheduleInput.parse(raw);
  const when = new Date(input.scheduledAt);
  return ctx.db.tx(async (db) => {
    const version = await loadVersion(db, versionId);
    await authorize(db, p, version.brand_id, 'publication.schedule');
    const userId = requireUser(p);
    const brand = await loadBrand(db, version.brand_id);
    await assertSchedulable(db, brand, when, ctx.now());
    const eff = await effectiveApproval(db, versionId);
    if (!eff.approved) throw conflict('not_approved', 'This version is not approved (or its approval no longer counts)');
    if (!eff.accountIds.includes(input.accountId)) throw conflict('account_not_approved', 'This version was not approved for that account');
    if (input.dependsOn) {
      const dep = await db.one(
        `select pub.scheduled_at from publication pub join variant v on v.id = pub.variant_id join piece p on p.id = v.piece_id
         where pub.id = $1 and p.brand_id = $2 and pub.status <> 'cancelled'`,
        [input.dependsOn, version.brand_id],
      );
      if (!dep) throw badRequest('invalid_dependency', 'The publication it depends on does not exist in this brand');
      if (when < new Date(dep.scheduled_at)) throw badRequest('invalid_dependency', 'It cannot go out before the publication it depends on');
    }

    // How will it go out? Automatic when the account is connected and the network can do this content; otherwise a person.
    const variant = await loadVariant(db, version.variant_id);
    const piece = (await db.one('select * from piece where id = $1', [version.piece_id]))!;
    const plan = await planPublication(ctx, {
      brandId: version.brand_id, versionId, accountId: input.accountId, piece, variantFormat: variant.format, text: input.text,
      firstComment: input.firstComment, options: input.options, scheduledAt: when, mode: input.mode, placement: input.placement,
    });
    if (input.mode === 'auto' && !plan.automated) throw conflict('cannot_automate', plan.manualReason ?? 'The app cannot publish this automatically');
    if (plan.automated && errorsOf(plan).length) {
      throw badRequest('validation_failed', errorsOf(plan).map((i) => i.message).join(' '), { issues: plan.issues });
    }
    const manual = !plan.automated;
    const prepare = manual ? null : prepareAt(brand, when);

    try {
      const pub = (await db.one(
        `insert into publication (variant_id, social_account_id, version_id, text, first_comment, options, scheduled_at, depends_on, created_by,
                                  manual, placement, prepare_at, next_run_at)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::timestamptz,$12::timestamptz) returning *`,
        [version.variant_id, input.accountId, versionId, input.text, input.firstComment, JSON.stringify(input.options), when, input.dependsOn ?? null, userId,
          manual, plan.placement, prepare],
      ))!;
      await audit(db, p, version.brand_id, 'publication.scheduled', 'publication', pub.id, null,
        { version_id: versionId, account_id: input.accountId, scheduled_at: when.toISOString(), fingerprint: eff.fingerprint, manual, placement: plan.placement });
      return { ...pub, issues: plan.issues, manual_reason: plan.manualReason ?? null };
    } catch (err) {
      if (isUniqueViolation(err)) throw conflict('slot_taken', 'That variant is already scheduled on that account at that time');
      throw err;
    }
  });
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
    if (before.status === 'on_hold') throw conflict('on_hold', 'This publication is on hold: reschedule it with the new approved version');
    if (!before.manual && ['preparing', 'ready', 'publishing'].includes(before.status)) {
      throw conflict('already_prepared', 'This post is already being prepared on its network. Cancel it and schedule it again to change it.');
    }
    if (!['scheduled', 'awaiting_reapproval'].includes(before.status)) throw conflict('invalid_state', `A ${before.status} publication cannot be changed`);
    const brand = await loadBrand(db, before.brand_id);
    const when = input.scheduledAt ? new Date(input.scheduledAt) : null;
    if (when) await assertSchedulable(db, brand, when, ctx.now());
    else if (brand.paused) throw conflict('brand_paused', 'The brand is paused: nothing can be scheduled or moved');

    const changed =
      (when !== null && when.getTime() !== new Date(before.scheduled_at).getTime()) ||
      (input.text !== undefined && input.text !== before.text) ||
      (input.firstComment !== undefined && input.firstComment !== before.first_comment);
    if (!changed) return before;

    const nextWhen = when ?? new Date(before.scheduled_at);
    if (!before.manual) {
      // Re-check what the network would say to the new time or text.
      const version = await loadVersion(db, before.version_id);
      const variant = await loadVariant(db, version.variant_id);
      const piece = (await db.one('select * from piece where id = $1', [version.piece_id]))!;
      const plan = await planPublication(ctx, {
        brandId: before.brand_id, versionId: before.version_id, accountId: before.social_account_id, piece, variantFormat: variant.format,
        text: input.text ?? before.text, firstComment: input.firstComment ?? before.first_comment, options: before.options ?? {}, scheduledAt: nextWhen,
        mode: 'auto', placement: before.placement ?? undefined,
      });
      if (errorsOf(plan).length) throw badRequest('validation_failed', errorsOf(plan).map((i) => i.message).join(' '), { issues: plan.issues });
    }

    const needsConfirm = rulesOf(brand).reapprove_on_move;
    const prepare = before.manual ? null : prepareAt(brand, nextWhen);
    try {
      const after = (await db.one(
        `update publication set scheduled_at = coalesce($2, scheduled_at), text = coalesce($3, text),
           first_comment = coalesce($4, first_comment), moved_by = $5, due_notified_at = null, updated_at = now(),
           prepare_at = $7::timestamptz, next_run_at = case when $6::boolean then null else $7::timestamptz end,
           status = case when $6::boolean then 'awaiting_reapproval' else status end
         where id = $1 returning *`,
        [pubId, when, input.text ?? null, input.firstComment ?? null, userId, needsConfirm, prepare],
      ))!;
      await audit(db, p, before.brand_id, 'publication.changed', 'publication', pubId,
        { scheduled_at: before.scheduled_at, text: before.text, status: before.status },
        { scheduled_at: after.scheduled_at, text: after.text, status: after.status });
      if (needsConfirm) {
        await notifyRoles(db, before.brand_id, ['approver', 'admin'], 'publication.reapproval',
          { publicationId: pubId, pieceId: before.piece_id }, userId);
      }
      return after;
    } catch (err) {
      if (isUniqueViolation(err)) throw conflict('slot_taken', 'That variant is already scheduled on that account at that time');
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
    if (pub.status !== 'awaiting_reapproval') throw conflict('invalid_state', 'This publication is not waiting for confirmation');
    if (pub.moved_by === userId) throw forbidden('Someone else has to confirm your change');
    const eff = await effectiveApproval(db, pub.version_id);
    if (!eff.approved || !eff.accountIds.includes(pub.social_account_id)) {
      throw conflict('not_approved', 'The approval behind this publication no longer counts');
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
    if (pub.status === 'publishing') throw conflict('in_flight', 'This post is being published right now: wait a moment');
    if (!OPEN.includes(pub.status)) throw conflict('invalid_state', `A ${pub.status} publication cannot be cancelled`);
    const row = (await db.one(
      `update publication set status = 'cancelled', updated_at = now(), next_run_at = case when native_scheduled then $2::timestamptz else null end where id = $1 returning *`,
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
    if (pub.status !== 'on_hold') throw conflict('invalid_state', 'Only a publication on hold can be rescheduled');
    if (pub.native_scheduled) throw conflict('cleanup_pending', 'The held post is still being taken down from its network: try again in a minute');
    const version = await loadVersion(db, input.versionId);
    if (version.variant_id !== pub.variant_id) throw badRequest('invalid_version', 'That version belongs to a different variant');
    const eff = await effectiveApproval(db, input.versionId);
    if (!eff.approved) throw conflict('not_approved', 'That version is not approved');
    if (!eff.accountIds.includes(pub.social_account_id)) throw conflict('account_not_approved', 'That version was not approved for this account');
    const brand = await loadBrand(db, pub.brand_id);
    const when = input.scheduledAt ? new Date(input.scheduledAt) : new Date(pub.scheduled_at);
    await assertSchedulable(db, brand, when, ctx.now());
    const prepare = pub.manual ? null : prepareAt(brand, when);
    try {
      const row = (await db.one(
        `update publication set status = 'scheduled', version_id = $2, scheduled_at = $3, hold_reason = null, due_notified_at = null, updated_at = now(),
           handle = '{}', attempts = 0, verify_attempts = 0, last_error = null, last_error_class = null, prepare_at = $4::timestamptz, next_run_at = $4::timestamptz
         where id = $1 returning *`,
        [pubId, input.versionId, when, prepare],
      ))!;
      await audit(db, p, pub.brand_id, 'publication.rescheduled', 'publication', pubId,
        { version_id: pub.version_id, status: 'on_hold' }, { version_id: input.versionId, status: 'scheduled', fingerprint: eff.fingerprint });
      return row;
    } catch (err) {
      if (isUniqueViolation(err)) throw conflict('slot_taken', 'That variant is already scheduled on that account at that time');
      throw err;
    }
  });
}

export const retryInput = z.object({ scheduledAt: iso.optional() });

/**
 * Tries a failed automatic publication again. Whatever the network was holding has been taken down by then, so it starts
 * clean. If its hour has passed it is moved a couple of minutes ahead, because the app never publishes late by itself.
 */
export async function retryPublication(ctx: Ctx, p: Principal, pubId: string, raw: unknown) {
  const input = retryInput.parse(raw ?? {});
  return ctx.db.tx(async (db) => {
    const pub = await loadPublication(db, pubId, true);
    await authorize(db, p, pub.brand_id, 'publication.schedule');
    requireUser(p);
    if (pub.manual || pub.status !== 'failed') throw conflict('invalid_state', 'Only a failed automatic publication can be retried');
    if (pub.native_scheduled) throw conflict('cleanup_pending', 'The post is still being taken down from its network: try again in a minute');
    const brand = await loadBrand(db, pub.brand_id);
    const eff = await effectiveApproval(db, pub.version_id);
    if (!eff.approved || !eff.accountIds.includes(pub.social_account_id)) throw conflict('not_approved', 'The approval behind this publication no longer counts');
    const now = ctx.now();
    let when = input.scheduledAt ? new Date(input.scheduledAt) : new Date(pub.scheduled_at);
    if (when.getTime() < now.getTime() + 120_000) when = new Date(now.getTime() + 120_000);
    await assertSchedulable(db, brand, when, now);
    try {
      const row = (await db.one(
        `update publication set status = 'scheduled', scheduled_at = $2, handle = '{}', attempts = 0, verify_attempts = 0, failed_at = null,
           last_error = null, last_error_class = null, external_id = null, url = null, visibility = null, prepare_at = $3::timestamptz, next_run_at = $3::timestamptz, updated_at = now()
         where id = $1 returning *`,
        [pubId, when, prepareAt(brand, when)],
      ))!;
      await audit(db, p, pub.brand_id, 'publication.retried', 'publication', pubId, { status: 'failed' }, { status: 'scheduled', scheduled_at: when.toISOString() });
      return row;
    } catch (err) {
      if (isUniqueViolation(err)) throw conflict('slot_taken', 'That variant is already scheduled on that account at that time');
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
    if (pub.manual) throw conflict('invalid_state', 'This publication is already published by hand');
    if (pub.native_scheduled || !['scheduled', 'failed'].includes(pub.status)) {
      throw conflict('invalid_state', 'Only a publication that has not reached its network yet can be handed over. Cancel this one and schedule it as manual instead.');
    }
    const row = (await db.one(
      `update publication set manual = true, status = 'scheduled', handle = '{}', next_run_at = null, prepare_at = null, attempts = 0,
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
    if (pub.manual || pub.status !== 'published') throw conflict('invalid_state', 'Only an automatic publication that has gone out can be checked again');
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
    if (!pub.manual) throw conflict('automatic', 'The app publishes this one itself. Hand it over to publish it by hand.');
    if (pub.status !== 'scheduled') throw conflict('invalid_state', `A ${pub.status} publication cannot be marked as published`);
    const eff = await effectiveApproval(db, pub.version_id);
    if (!eff.approved || !eff.accountIds.includes(pub.social_account_id)) {
      throw conflict('not_approved', 'The approval behind this publication no longer counts');
    }
    if (pub.depends_on) {
      const dep = await db.one('select status from publication where id = $1', [pub.depends_on]);
      if (dep && dep.status !== 'published') throw conflict('dependency_pending', 'Publish the one it depends on first');
    }
    const row = (await db.one(
      `update publication set status = 'published', published_at = now(), published_by = $2, url = $3, external_id = $4, visibility = 'public', updated_at = now()
       where id = $1 returning *`,
      [pubId, userId, input.url ?? null, input.externalId ?? null],
    ))!;
    await audit(db, p, pub.brand_id, 'publication.published', 'publication', pubId, { status: 'scheduled' }, { status: 'published', url: input.url ?? null });
    await emitPublication(ctx, db, pub.brand_id, pubId, 'publication.published');
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
    account, piece: { id: pub.piece_id, title: pub.piece_title }, files, last_error: pub.last_error,
  };
}

/** Manual publications that are due: scheduled, past their time and not blocked by one they depend on. Empty while the brand is paused. */
export async function duePublications(ctx: Ctx, p: Principal, brandId: string) {
  await authorize(ctx.db, p, brandId, 'brand.view');
  return ctx.db.query(
    `select pub.id, pub.scheduled_at, pub.text, pub.status, p.id as piece_id, p.title as piece_title, sa.network, sa.display_name as account_name,
       pub.last_error,
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
  if (days.length === 0 || days.length > 366) throw badRequest('invalid_range', 'The range must cover between 1 and 366 days');
  const zone = brand.timezone as string;
  const start = zonedInstant(days[0]!, '00:00', zone);
  const end = DateTime.fromJSDate(zonedInstant(days[days.length - 1]!, '00:00', zone), { zone }).plus({ days: 1 }).toJSDate();

  const publications = await ctx.db.query(
    `select pub.id, pub.status, pub.scheduled_at, pub.text, pub.hold_reason, pub.url, pub.depends_on, pub.social_account_id as account_id,
       pub.manual, pub.visibility, pub.last_error, pub.last_error_class, pub.native_scheduled, pub.placement,
       sa.network, sa.display_name as account_name, p.id as piece_id, p.title as piece_title, ver.number as version_number
     from publication pub
     join variant v on v.id = pub.variant_id join piece p on p.id = v.piece_id
     join social_account sa on sa.id = pub.social_account_id join version ver on ver.id = pub.version_id
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
  const taken = new Set(publications.map((x) => `${x.account_id}|${new Date(x.scheduled_at).getTime()}`));
  const slots: CalendarSlot[] = [];
  for (const day of days) {
    for (const s of slotRows) {
      if (s.weekday !== isoWeekday(day)) continue;
      const at = zonedInstant(day, s.local_time, zone);
      slots.push({
        id: s.id, account_id: s.account_id, network: s.network, account_name: s.account_name, label: s.label, day,
        at: at.toISOString(), filled: taken.has(`${s.account_id}|${at.getTime()}`), past: at.getTime() <= ctx.now().getTime(), blocked: blockedDays.has(day),
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
