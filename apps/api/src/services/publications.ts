import { z } from 'zod';
import { authorize, type Principal } from '../auth/principal.js';
import type { Ctx } from '../context.js';
import type { Queryable, Row } from '../db.js';
import { daysBetween, isoWeekday, localDay, zonedInstant } from '../domain/time.js';
import { DateTime } from 'luxon';
import { AppError, badRequest, conflict, forbidden, notFound } from '../errors.js';
import { audit } from './audit.js';
import { effectiveApproval } from './approvals.js';
import { loadBrand, loadVersion, rulesOf } from './loaders.js';
import { notifyRoles } from './notify.js';

const iso = z.iso.datetime({ offset: true });

export const scheduleInput = z.object({
  accountId: z.string().uuid(),
  scheduledAt: iso,
  text: z.string().max(10_000).default(''),
  firstComment: z.string().max(5000).default(''),
  options: z.record(z.string(), z.unknown()).default({}),
  dependsOn: z.string().uuid().nullish(),
});

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

const OPEN = ['scheduled', 'awaiting_reapproval', 'on_hold'];

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

async function assertSchedulable(db: Queryable, brand: Row, when: Date) {
  if (brand.paused) throw conflict('brand_paused', 'The brand is paused: nothing can be scheduled or moved');
  if (when.getTime() <= Date.now()) throw badRequest('past_date', 'The date must be in the future');
  const day = localDay(when, brand.timezone);
  const blocked = await db.one('select reason from blocked_date where brand_id = $1 and day = $2', [brand.id, day]);
  if (blocked) throw conflict('blocked_date', `Nothing is published on ${day}${blocked.reason ? ` (${blocked.reason})` : ''}`);
}

const isUniqueViolation = (err: unknown) => (err as { code?: string }).code === '23505';

/** Schedules an approved version on an account. Only what is approved, for the accounts approved, can be scheduled. */
export async function schedule(ctx: Ctx, p: Principal, versionId: string, raw: unknown) {
  const input = scheduleInput.parse(raw);
  const when = new Date(input.scheduledAt);
  return ctx.db.tx(async (db) => {
    const version = await loadVersion(db, versionId);
    await authorize(db, p, version.brand_id, 'publication.schedule');
    const userId = requireUser(p);
    const brand = await loadBrand(db, version.brand_id);
    await assertSchedulable(db, brand, when);
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
    try {
      const pub = (await db.one(
        `insert into publication (variant_id, social_account_id, version_id, text, first_comment, options, scheduled_at, depends_on, created_by)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9) returning *`,
        [version.variant_id, input.accountId, versionId, input.text, input.firstComment, JSON.stringify(input.options), when, input.dependsOn ?? null, userId],
      ))!;
      await audit(db, p, version.brand_id, 'publication.scheduled', 'publication', pub.id, null,
        { version_id: versionId, account_id: input.accountId, scheduled_at: when.toISOString(), fingerprint: eff.fingerprint });
      return pub;
    } catch (err) {
      if (isUniqueViolation(err)) throw conflict('slot_taken', 'That variant is already scheduled on that account at that time');
      throw err;
    }
  });
}

/**
 * Moves a publication or edits its text. If the brand requires it, any change to something already scheduled
 * needs a second person to confirm it before it counts again.
 */
export async function patchPublication(ctx: Ctx, p: Principal, pubId: string, raw: unknown) {
  const input = patchInput.parse(raw);
  return ctx.db.tx(async (db) => {
    const before = await loadPublication(db, pubId, true);
    await authorize(db, p, before.brand_id, 'publication.schedule');
    const userId = requireUser(p);
    if (before.status === 'on_hold') throw conflict('on_hold', 'This publication is on hold: reschedule it with the new approved version');
    if (!['scheduled', 'awaiting_reapproval'].includes(before.status)) throw conflict('invalid_state', `A ${before.status} publication cannot be changed`);
    const brand = await loadBrand(db, before.brand_id);
    const when = input.scheduledAt ? new Date(input.scheduledAt) : null;
    if (when) await assertSchedulable(db, brand, when);
    else if (brand.paused) throw conflict('brand_paused', 'The brand is paused: nothing can be scheduled or moved');

    const changed =
      (when !== null && when.getTime() !== new Date(before.scheduled_at).getTime()) ||
      (input.text !== undefined && input.text !== before.text) ||
      (input.firstComment !== undefined && input.firstComment !== before.first_comment);
    if (!changed) return before;
    const needsConfirm = rulesOf(brand).reapprove_on_move;
    try {
      const after = (await db.one(
        `update publication set scheduled_at = coalesce($2, scheduled_at), text = coalesce($3, text),
           first_comment = coalesce($4, first_comment), moved_by = $5, due_notified_at = null, updated_at = now(),
           status = case when $6::boolean then 'awaiting_reapproval' else status end
         where id = $1 returning *`,
        [pubId, when, input.text ?? null, input.firstComment ?? null, userId, needsConfirm],
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
    const row = (await db.one(`update publication set status = 'scheduled', updated_at = now() where id = $1 returning *`, [pubId]))!;
    await audit(db, p, pub.brand_id, 'publication.confirmed', 'publication', pubId, { status: pub.status }, { status: 'scheduled' });
    return row;
  });
}

export async function cancelPublication(ctx: Ctx, p: Principal, pubId: string) {
  return ctx.db.tx(async (db) => {
    const pub = await loadPublication(db, pubId, true);
    await authorize(db, p, pub.brand_id, 'publication.schedule');
    requireUser(p);
    if (!OPEN.includes(pub.status)) throw conflict('invalid_state', `A ${pub.status} publication cannot be cancelled`);
    const row = (await db.one(`update publication set status = 'cancelled', updated_at = now() where id = $1 returning *`, [pubId]))!;
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
    const version = await loadVersion(db, input.versionId);
    if (version.variant_id !== pub.variant_id) throw badRequest('invalid_version', 'That version belongs to a different variant');
    const eff = await effectiveApproval(db, input.versionId);
    if (!eff.approved) throw conflict('not_approved', 'That version is not approved');
    if (!eff.accountIds.includes(pub.social_account_id)) throw conflict('account_not_approved', 'That version was not approved for this account');
    const brand = await loadBrand(db, pub.brand_id);
    const when = input.scheduledAt ? new Date(input.scheduledAt) : new Date(pub.scheduled_at);
    await assertSchedulable(db, brand, when);
    try {
      const row = (await db.one(
        `update publication set status = 'scheduled', version_id = $2, scheduled_at = $3, hold_reason = null, due_notified_at = null, updated_at = now()
         where id = $1 returning *`,
        [pubId, input.versionId, when],
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

/** In phase 1 a person publishes by hand and records it here, with the link if there is one. */
export async function markPublished(ctx: Ctx, p: Principal, pubId: string, raw: unknown) {
  const input = markPublishedInput.parse(raw);
  return ctx.db.tx(async (db) => {
    const pub = await loadPublication(db, pubId, true);
    await authorize(db, p, pub.brand_id, 'publication.schedule');
    const userId = requireUser(p);
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
      `update publication set status = 'published', published_at = now(), published_by = $2, url = $3, external_id = $4, updated_at = now()
       where id = $1 returning *`,
      [pubId, userId, input.url ?? null, input.externalId ?? null],
    ))!;
    await audit(db, p, pub.brand_id, 'publication.published', 'publication', pubId, { status: 'scheduled' }, { status: 'published', url: input.url ?? null });
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
    id: pub.id, status: pub.status, scheduled_at: pub.scheduled_at, text: pub.text, first_comment: pub.first_comment,
    account, piece: { id: pub.piece_id, title: pub.piece_title }, files,
  };
}

/** Publications that are due: scheduled, past their time and not blocked by one they depend on. Empty while the brand is paused. */
export async function duePublications(ctx: Ctx, p: Principal, brandId: string) {
  await authorize(ctx.db, p, brandId, 'brand.view');
  return ctx.db.query(
    `select pub.id, pub.scheduled_at, pub.text, pub.status, p.id as piece_id, p.title as piece_title, sa.network, sa.display_name as account_name,
       (pub.depends_on is not null and exists (select 1 from publication d where d.id = pub.depends_on and d.status <> 'published')) as waiting_for_dependency
     from publication pub
     join variant v on v.id = pub.variant_id join piece p on p.id = v.piece_id
     join social_account sa on sa.id = pub.social_account_id
     join brand b on b.id = p.brand_id
     where p.brand_id = $1 and pub.status = 'scheduled' and pub.scheduled_at <= now() and not b.paused
     order by pub.scheduled_at`,
    [brandId],
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
  const brand = await loadBrand(ctx.db, brandId);
  const days = daysBetween(from, to);
  if (days.length === 0 || days.length > 366) throw badRequest('invalid_range', 'The range must cover between 1 and 366 days');
  const zone = brand.timezone as string;
  const start = zonedInstant(days[0]!, '00:00', zone);
  const end = DateTime.fromJSDate(zonedInstant(days[days.length - 1]!, '00:00', zone), { zone }).plus({ days: 1 }).toJSDate();

  const publications = await ctx.db.query(
    `select pub.id, pub.status, pub.scheduled_at, pub.text, pub.hold_reason, pub.url, pub.depends_on, pub.social_account_id as account_id,
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
        at: at.toISOString(), filled: taken.has(`${s.account_id}|${at.getTime()}`), past: at.getTime() <= Date.now(), blocked: blockedDays.has(day),
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
