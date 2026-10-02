import { randomUUID } from 'node:crypto';
import type { Queryable, Row } from '../db.js';
import { profileOf } from '../connectors/profiles.js';
import { redact } from '../connectors/http.js';
import {
  ConnectorError,
  type Account, type Connector, type Handle, type Issue, type MediaItem, type PlacementSpec, type PublishInput,
} from '../connectors/types.js';
import type { Ctx } from '../context.js';
import { localDay } from '../domain/time.js';
import { audit } from './audit.js';
import { effectiveApproval } from './approvals.js';
import { emitPublication } from './events.js';
import { scheduleSnapshots } from './metrics.js';
import { connectorEnv, loadConnectorAccount, markReconnectRequired } from './connectors.js';
import { notifyRoles, type NotifyKind } from './notify.js';
import { fileFor } from './renditions.js';
import { storedFilesMatch } from './versions.js';

/**
 * The publishing pipeline for an automatic publication. Each pass of `advance` does one step and writes down where it got
 * to, so a worker that dies halfway resumes instead of starting over:
 *
 *   scheduled ──(lead time before the hour)──▶ preparing ──▶ ready ──(at the hour)──▶ publishing ──▶ published
 *                                                 │  ▲                                     │
 *                                                 └──┴── waits and retries ────────────────┴──▶ failed
 *
 * `published` then keeps being checked until the post is seen live, because a success from an API does not always
 * mean the post is public (YouTube holds back videos until an audit passes, Facebook processes videos, and so on).
 *
 * Before preparing and before publishing, a publication is held back while its brand is paused or its date is blocked (what the
 * network already holds for it is taken down, and it is prepared again once that is over, or handed to a person if its hour
 * passed meanwhile), and while the publication it depends on has not gone out.
 */

export const TIMING = {
  /** Waits after a transient failure: the 5th failure in a row is the last. */
  backoffSeconds: [60, 120, 300, 600, 1200],
  maxAttempts: 5,
  /** While an account waits to be reconnected, look again this often. */
  reconnectRetrySeconds: 600,
  /**
   * A worker holds a publication this long and renews it while it works, so a worker that dies lets go within this time (also
   * after a crash and a restart) while a long step (a big conversion or upload) keeps it for as long as it lasts.
   */
  leaseSeconds: 120,
  renewEverySeconds: 30,
  /** How long the queue gives one wake-up before it may deliver it again. The lease, not this, decides who works on it. */
  jobExpireSeconds: 50 * 60,
  verifyEverySeconds: 60,
  maxVerifyChecks: 60,
  /** A natively scheduled post is checked this long after its hour, to give the network a moment to publish it. */
  nativeGraceSeconds: 20,
  /** While the brand is paused or the date is blocked, a publication is looked at again this often. */
  frozenRecheckSeconds: 300,
  /** While the publication it depends on has not gone out, this one is looked at again this often. */
  dependencyRecheckSeconds: 60,
};

type Step = 'prepare' | 'publish' | 'verify' | 'discard';

/** The publication a worker holds, and the lease it holds it with: every write names both. */
interface Held {
  id: string;
  lease: string;
}

export interface Loaded {
  pub: Row;
  w: Held;
  brandId: string;
  brandPaused: boolean;
  timezone: string;
  pieceId: string;
  pieceTitle: string;
  pieceKind: string;
  aiGenerated: boolean;
  format: string;
  toleranceMs: number;
  account: Account;
  connector: Connector | null;
}

const addSeconds = (d: Date, s: number) => new Date(d.getTime() + s * 1000);
const minDate = (a: Date, b: Date) => (a.getTime() < b.getTime() ? a : b);
const nonEmpty = (h: unknown) => !!h && typeof h === 'object' && Object.keys(h as object).length > 0;

async function load(ctx: Ctx, w: Held): Promise<Loaded | null> {
  const pub = await ctx.db.one(
    `select pub.*, p.id as piece_id, p.title as piece_title, p.kind as piece_kind, p.ai_generated as piece_ai_generated, p.brand_id, v.format,
       b.publishing, b.paused as brand_paused, b.timezone
     from publication pub join variant v on v.id = pub.variant_id join piece p on p.id = v.piece_id join brand b on b.id = p.brand_id
     where pub.id = $1`,
    [w.id],
  );
  if (!pub) return null;
  const account = await loadConnectorAccount(ctx, pub.social_account_id);
  if (!account) return null;
  const tolerance = Number(pub.publishing?.late_tolerance_minutes ?? 15) * 60_000;
  return {
    pub, w, brandId: pub.brand_id, brandPaused: !!pub.brand_paused, timezone: pub.timezone, pieceId: pub.piece_id,
    // What was approved goes out: the title as it was then. The AI label goes out if it was set then or has been set since.
    pieceTitle: pub.title ?? pub.piece_title, pieceKind: pub.piece_kind, aiGenerated: !!pub.ai_generated || !!pub.piece_ai_generated,
    format: pub.format, toleranceMs: tolerance, account, connector: ctx.connectors.connector(account.network),
  };
}

// ───────────────────────────── what a connector is given ─────────────────────────────

/**
 * The publication as the connector sees it. With `forSending` the files are made ready for the network (converted if they do
 * not fit its profile) and given a download address; without it, only what validation needs (shape and length) is filled in.
 */
export async function buildInput(
  ctx: Ctx,
  d: {
    publicationId: string; brandId: string; versionId: string; placement: string; title: string; text: string; firstComment: string;
    options: Record<string, unknown>; scheduledAt: Date; aiGenerated: boolean; spec?: PlacementSpec;
  },
  forSending: boolean,
): Promise<PublishInput> {
  const assets = await ctx.db.query('select * from asset where version_id = $1 order by position, kind', [d.versionId]);
  const media: MediaItem[] = [];
  for (const a of assets) {
    // Pictures, videos, covers, and PDFs (a LinkedIn document); subtitles are not sent anywhere yet.
    if (a.kind !== 'video' && a.kind !== 'image' && a.kind !== 'cover' && a.kind !== 'pdf') continue;
    let key = a.storage_key, mime = a.mime, bytes = a.bytes, width = a.width, height = a.height, durationMs = a.duration_ms;
    let url = '';
    if (forSending) {
      const profileId = a.kind === 'cover' ? undefined : d.spec?.profiles[a.kind as 'video' | 'image'];
      if (profileId) {
        const f = await fileFor(ctx, d.brandId, a, profileOf(profileId));
        ({ key, mime, bytes, width, height, durationMs } = f);
      }
      url = await ctx.storage.presignGet(key, { expiresSec: ctx.config.PUBLIC_MEDIA_TTL_SECONDS });
    }
    media.push({ kind: a.kind, position: a.position, name: a.name, mime, bytes, width, height, durationMs, key, url });
  }
  return {
    publicationId: d.publicationId, placement: d.placement, title: d.title, text: d.text, firstComment: d.firstComment,
    options: d.options, scheduledAt: d.scheduledAt, aiGenerated: d.aiGenerated, media,
  };
}

async function inputFor(ctx: Ctx, L: Loaded, forSending: boolean): Promise<PublishInput> {
  const spec = L.connector?.capabilities(L.account).placements.find((p) => p.id === L.pub.placement);
  return buildInput(ctx, {
    publicationId: L.pub.id, brandId: L.brandId, versionId: L.pub.version_id, placement: L.pub.placement, title: L.pieceTitle, text: L.pub.text,
    firstComment: L.pub.first_comment, options: L.pub.options ?? {}, scheduledAt: new Date(L.pub.scheduled_at), aiGenerated: L.aiGenerated, spec,
  }, forSending);
}

// ───────────────────────────── bookkeeping ─────────────────────────────

type Patch = Partial<{
  status: string; next_run_at: Date | null; handle: Handle; native_scheduled: boolean; visibility: string | null; attempts: number;
  verify_attempts: number; last_error_class: string | null; last_error: string | null; failed_at: Date | null; external_id: string | null;
  url: string | null; published_at: Date | null; manual: boolean; hold_reason: string | null; held_on_network: boolean;
  frozen_at: Date | null; prepare_at: Date | null; due_notified_at: Date | null;
}>;

/**
 * Writes a change only if the publication is still in a state the step expected (so a cancel or hold in the meantime wins) and
 * this worker still holds its lease (so a worker that lost it, to a long pause say, cannot overwrite the one that took over).
 */
async function commit(db: Queryable, w: Held, expected: string[], patch: Patch): Promise<boolean> {
  const keys = Object.keys(patch) as (keyof Patch)[];
  const sets = keys.map((k, i) => `${k} = $${i + 4}`);
  const values = keys.map((k) => (k === 'handle' ? JSON.stringify(patch[k]) : patch[k]));
  const row = await db.one(
    `update publication set ${sets.join(', ')}${sets.length ? ',' : ''} updated_at = now() where id = $1 and status = any($2) and lease_token = $3 returning id`,
    [w.id, expected, w.lease, ...values],
  );
  return !!row;
}

/**
 * Saves a connector's progress as soon as it makes it. While preparing, anything saved may be held by the network, so it is marked
 * to be taken down, at once if the publication was cancelled or held in the meantime. While publishing, it means the network may
 * have the post, so the publication is never started again from nothing.
 */
async function saveHandle(ctx: Ctx, L: Loaded, handle: Handle, during: 'prepare' | 'publish' | 'verify') {
  const takeDown = during === 'prepare' && !!L.connector?.discard && nonEmpty(handle);
  const row = await ctx.db.one(
    `update publication set handle = $3, updated_at = now(),
       held_on_network = held_on_network or $4,
       next_run_at = case when $4 and status in ('cancelled','on_hold','failed') then $5::timestamptz else next_run_at end,
       publish_progress_at = case when $6 then coalesce(publish_progress_at, $5::timestamptz) else publish_progress_at end
     where id = $1 and lease_token = $2 returning id`,
    [L.w.id, L.w.lease, JSON.stringify(handle), takeDown, ctx.now(), during === 'publish'],
  );
  if (!row) {
    // Another worker took the publication over. Whatever this one made on the network is in the log, so a person can find it.
    ctx.log.error({ publicationId: L.w.id, handleKeys: Object.keys(handle) }, 'lost the lease while the network was being changed: this progress was not saved');
  }
}

async function record(
  ctx: Ctx, L: Loaded, step: Step, outcome: 'ok' | 'pending' | 'error',
  o: { errorClass?: string; httpStatus?: number; detail?: unknown } = {},
) {
  await ctx.db.tx(async (db) => {
    const n = ((await db.one<{ n: number }>('select count(*)::int as n from publication_attempt where publication_id = $1 and step = $2', [L.pub.id, step]))?.n ?? 0) + 1;
    await db.query(
      `insert into publication_attempt (publication_id, step, attempt, started_at, finished_at, outcome, error_class, http_status, detail)
       values ($1,$2,$3,$4,$4,$5,$6,$7,$8)`,
      [L.pub.id, step, n, ctx.now(), outcome, o.errorClass ?? null, o.httpStatus ?? null, JSON.stringify(redact(o.detail ?? {}))],
    );
    await audit(db, null, L.brandId, 'publication.attempt', 'publication', L.pub.id, null, { step, attempt: n, outcome, errorClass: o.errorClass ?? null, httpStatus: o.httpStatus ?? null });
  });
}

async function tell(db: Queryable, L: Loaded, kind: NotifyKind, extra: Record<string, unknown> = {}) {
  await notifyRoles(db, L.brandId, ['approver', 'admin'], kind, { publicationId: L.pub.id, pieceId: L.pieceId, title: L.pieceTitle, network: L.account.network, ...extra }, null);
}

/** What a step may have changed in the row since the pass began (a connector saves its progress as it goes). */
async function refresh(ctx: Ctx, L: Loaded) {
  const r = await ctx.db.one('select handle, held_on_network, native_scheduled, publish_progress_at from publication where id = $1', [L.w.id]);
  if (r) Object.assign(L.pub, r);
}

async function fail(ctx: Ctx, L: Loaded, errorClass: string, message: string, attempts?: number): Promise<string> {
  await refresh(ctx, L);
  const reached = !!L.pub.publish_progress_at && !L.pub.native_scheduled;
  const text = reached ? `${message} It may already be on ${L.account.network}: check there before trying again.` : message;
  return ctx.db.tx(async (db) => {
    const ok = await commit(db, L.w, ['scheduled', 'preparing', 'ready', 'publishing', 'published'], {
      ...(attempts === undefined ? {} : { attempts }),
      status: 'failed', failed_at: ctx.now(), last_error_class: errorClass, last_error: text.slice(0, 1000),
      // Whatever the network is holding must be taken down, or it would still go out at its hour.
      next_run_at: L.pub.held_on_network || L.pub.native_scheduled ? ctx.now() : null,
    });
    if (!ok) return 'changed';
    await audit(db, null, L.brandId, 'publication.failed', 'publication', L.pub.id, { status: L.pub.status }, { errorClass, message: text.slice(0, 300) });
    await tell(db, L, 'publication.failed', { errorClass, message: text.slice(0, 300) });
    await emitPublication(ctx, db, L.brandId, L.pub.id, 'publication.failed', { error: { class: errorClass, message: text.slice(0, 500) } });
    return 'failed';
  });
}

/**
 * Gives up on automation for one publication: it becomes a manual one, with everything ready for a person, who is told why. What
 * the network held for it must already have been taken down.
 */
async function handOver(ctx: Ctx, L: Loaded, errorClass: string, message: string): Promise<string> {
  return ctx.db.tx(async (db) => {
    const ok = await commit(db, L.w, ['scheduled', 'preparing', 'ready'], {
      status: 'scheduled', manual: true, handle: {}, next_run_at: null, prepare_at: null, native_scheduled: false, held_on_network: false,
      frozen_at: null, attempts: 0, due_notified_at: null, last_error_class: errorClass, last_error: message.slice(0, 1000),
    });
    if (!ok) return 'changed';
    await audit(db, null, L.brandId, 'publication.handed_over', 'publication', L.pub.id, { manual: false }, { manual: true, reason: message.slice(0, 200) });
    await tell(db, L, 'publication.failed', { errorClass, handedOver: true, message: `${message} It now needs a person: publish it by hand or cancel it.`.slice(0, 400) });
    return 'handed-over';
  });
}

/** Lets whatever waits for this publication know it has gone out (a post that depends on it). */
export async function wakeDependents(db: Queryable, publicationId: string, now: Date) {
  await db.query(
    `update publication set next_run_at = $2 where depends_on = $1 and manual = false and status in ('scheduled','ready') and next_run_at > $2`,
    [publicationId, now],
  );
}

// ───────────────────────────── errors ─────────────────────────────

/** Decides what a failed step means: wait, try again, hand it to a person, or give up and say so. */
async function onError(ctx: Ctx, L: Loaded, step: Step, err: unknown): Promise<string> {
  const e = err instanceof ConnectorError ? err : new ConnectorError('unknown', (err as Error)?.message ?? String(err));
  await record(ctx, L, step, 'error', { errorClass: e.errorClass, httpStatus: e.httpStatus, detail: { message: e.message, ...(e.detail ? { response: e.detail } : {}) } });
  await refresh(ctx, L);
  const now = ctx.now();
  const dueBy = new Date(new Date(L.pub.scheduled_at).getTime() + L.toleranceMs);
  const status = L.pub.status as string;
  const live = status === 'published';
  const schedule = async (next: Date, patch: Patch = {}) => {
    await commit(ctx.db, L.w, ['scheduled', 'preparing', 'ready', 'publishing', 'published', 'cancelled', 'on_hold', 'failed'], { next_run_at: next, last_error_class: e.errorClass, last_error: e.message.slice(0, 1000), ...patch });
    return `retry:${e.errorClass}`;
  };

  if (step === 'discard') {
    // Nothing is lost by trying again, but after a few tries a person has to remove it by hand.
    const attempts = (L.pub.attempts as number) + 1;
    if (e.errorClass === 'auth') await markReconnectRequired(ctx, L.account.id, e.message);
    if (attempts >= TIMING.maxAttempts * 2) {
      await ctx.db.tx(async (db) => {
        await commit(db, L.w, ['cancelled', 'on_hold', 'failed'], { next_run_at: null, attempts });
        await tell(db, L, 'publication.failed', { errorClass: e.errorClass, message: `Could not remove the post from ${L.account.network}: delete it there by hand. (${e.message.slice(0, 200)})` });
      });
      return 'discard-gave-up';
    }
    return schedule(addSeconds(now, e.errorClass === 'rate_limit' ? (e.retryAfterSec ?? 900) : e.errorClass === 'auth' ? TIMING.reconnectRetrySeconds : TIMING.backoffSeconds[Math.min(attempts - 1, 4)]!), { attempts });
  }

  switch (e.errorClass) {
    case 'auth': {
      await markReconnectRequired(ctx, L.account.id, e.message);
      if (live || now < dueBy) return schedule(addSeconds(now, TIMING.reconnectRetrySeconds), live ? { verify_attempts: (L.pub.verify_attempts as number) + 1 } : {});
      return fail(ctx, L, 'auth', `${e.message} The account was not reconnected in time.`);
    }
    case 'rate_limit': {
      const next = addSeconds(now, Math.max(30, e.retryAfterSec ?? 900));
      if (!live && next > dueBy) return fail(ctx, L, 'rate_limit', `${e.message} The limit did not clear before the post was due.`);
      return schedule(next);
    }
    case 'file_rejected':
      return fail(ctx, L, 'file_rejected', e.message);
    case 'unsupported': {
      // The API cannot do this: it becomes a manual publication, with everything ready for a person. Unless the network already holds
      // something for it, which has to come down first: then it fails, which takes it down, and a person can hand it over after.
      if (L.pub.held_on_network || L.pub.publish_progress_at || status === 'publishing') return fail(ctx, L, 'unsupported', e.message);
      return handOver(ctx, L, 'unsupported', e.message);
    }
    default: {
      // Transient or unknown: try again, waiting longer each time. The fifth failure in a row is the last.
      const attempts = (L.pub.attempts as number) + 1;
      if (live) {
        const checks = (L.pub.verify_attempts as number) + 1;
        return schedule(addSeconds(now, TIMING.backoffSeconds[Math.min(checks - 1, 4)]!), { verify_attempts: checks });
      }
      if (attempts >= TIMING.maxAttempts) return fail(ctx, L, e.errorClass, `${e.message} (failed ${attempts} times in a row)`, attempts);
      return schedule(addSeconds(now, TIMING.backoffSeconds[attempts - 1]!), { attempts });
    }
  }
}

// ───────────────────────────── holding back ─────────────────────────────

/** Why nothing may go out for this publication right now: its brand is paused or its day is blocked. */
async function freezeReason(ctx: Ctx, L: Loaded): Promise<string | null> {
  const scheduled = new Date(L.pub.scheduled_at);
  if (L.brandPaused) return `the brand was paused`;
  const day = localDay(scheduled, L.timezone);
  const blocked = await ctx.db.one('select reason from blocked_date where brand_id = $1 and day = $2', [L.brandId, day]);
  return blocked ? `${day} is blocked${blocked.reason ? ` (${blocked.reason})` : ''}` : null;
}

/**
 * Holds a publication back while its brand is paused or its date is blocked. What the network holds for it is taken down first,
 * so it cannot go out at its hour; the publication goes back to "scheduled", to be prepared again once the freeze is over. If its
 * hour (and the tolerance) passes meanwhile, a person gets it instead.
 */
async function freeze(ctx: Ctx, L: Loaded, reason: string): Promise<string> {
  const { pub, connector, account } = L;
  const now = ctx.now();
  const deadline = new Date(new Date(pub.scheduled_at).getTime() + L.toleranceMs);
  const tookDown = pub.held_on_network && !!connector?.discard;
  if (tookDown) {
    try {
      await connector!.discard!(account, pub.handle ?? {}, connectorEnv(ctx, account.id));
    } catch (err) {
      const e = err instanceof ConnectorError ? err : new ConnectorError('unknown', (err as Error)?.message ?? String(err));
      await record(ctx, L, 'discard', 'error', { errorClass: e.errorClass, httpStatus: e.httpStatus, detail: { message: e.message, reason } });
      if (e.errorClass === 'auth') await markReconnectRequired(ctx, account.id, e.message);
      const attempts = (pub.attempts as number) + 1;
      await ctx.db.tx(async (db) => {
        await commit(db, L.w, [pub.status], {
          attempts, frozen_at: pub.frozen_at ?? now, last_error_class: e.errorClass, last_error: e.message.slice(0, 1000),
          next_run_at: addSeconds(now, TIMING.backoffSeconds[Math.min(attempts - 1, 4)]!),
        });
        if (attempts === TIMING.maxAttempts) {
          await tell(db, L, 'publication.failed', { errorClass: e.errorClass, message: `Nothing may go out because ${reason}, but the post could not be taken down from ${account.network}: delete it there by hand. (${e.message.slice(0, 200)})` });
        }
      });
      return `retry:${e.errorClass}`;
    }
    await record(ctx, L, 'discard', 'ok', { detail: { reason } });
  }
  // A send that had begun before (a retried one) keeps what the connector recorded, so it can still be found again: it only waits.
  const keep = !!pub.publish_progress_at;
  if (now > deadline && !keep) {
    return handOver(ctx, L, 'missed_window', `It was due ${new Date(pub.scheduled_at).toISOString()}, while ${reason}, so the app did not publish it.`);
  }
  if (now > deadline) return fail(ctx, L, 'missed_window', `It was due ${new Date(pub.scheduled_at).toISOString()}, while ${reason}, so the app did not publish it.`);
  return ctx.db.tx(async (db) => {
    const park = { frozen_at: pub.frozen_at ?? now, next_run_at: minDate(addSeconds(now, TIMING.frozenRecheckSeconds), addSeconds(deadline, 1)) };
    const ok = keep
      ? await commit(db, L.w, [pub.status], park)
      : await commit(db, L.w, ['scheduled', 'preparing', 'ready'], { status: 'scheduled', handle: {}, native_scheduled: false, held_on_network: false, attempts: 0, ...park });
    if (!ok) return 'changed';
    if (tookDown) await audit(db, null, L.brandId, 'publication.discarded', 'publication', pub.id, null, { network: account.network, reason });
    if (!pub.frozen_at) await audit(db, null, L.brandId, 'publication.frozen', 'publication', pub.id, { status: pub.status }, { status: keep ? pub.status : 'scheduled', reason });
    return 'frozen';
  });
}

/**
 * What may stop a publication before it is prepared or sent, in order: a freeze (pause, blocked date), the end of one (it carries
 * on, or a person gets it if its hour passed meanwhile), and a publication it depends on that has not gone out. Null means go on.
 */
async function holdBack(ctx: Ctx, L: Loaded): Promise<string | null> {
  const { pub } = L;
  const now = ctx.now();
  const scheduled = new Date(pub.scheduled_at);
  const deadline = new Date(scheduled.getTime() + L.toleranceMs);
  // A post the network holds is out once its hour has come: nothing can bring it back, and it is checked like any other.
  const out = pub.native_scheduled && now.getTime() >= scheduled.getTime();
  if (!out) {
    const reason = await freezeReason(ctx, L);
    if (reason) return freeze(ctx, L, reason);
  }
  if (pub.frozen_at) {
    if (!pub.held_on_network && now > deadline) {
      return handOver(ctx, L, 'missed_window', `It was due ${scheduled.toISOString()}, while the brand was paused or the date blocked, so the app did not publish it.`);
    }
    if (!(await commit(ctx.db, L.w, [pub.status], { frozen_at: null }))) return 'changed';
    pub.frozen_at = null;
  }
  if (pub.depends_on && !out) {
    const dep = await ctx.db.one<{ status: string }>('select status from publication where id = $1', [pub.depends_on]);
    if (dep && dep.status !== 'published') {
      const gone = ['cancelled', 'failed', 'on_hold'].includes(dep.status);
      if (!gone && now <= deadline) {
        await commit(ctx.db, L.w, [pub.status], { next_run_at: minDate(addSeconds(now, TIMING.dependencyRecheckSeconds), addSeconds(deadline, 1)) });
        return 'waiting-dependency';
      }
      const why = gone
        ? `The publication it depends on is ${dep.status === 'on_hold' ? 'on hold' : dep.status}, so this one was not published`
        : 'The publication it depends on had not gone out by this one\'s hour, so this one was not published';
      return ctx.db.tx(async (db) => {
        const ok = await commit(db, L.w, ['scheduled', 'preparing', 'ready'], {
          status: 'on_hold', hold_reason: why, next_run_at: pub.held_on_network || pub.native_scheduled ? now : null,
        });
        if (!ok) return 'changed';
        await audit(db, null, L.brandId, 'publication.on_hold', 'publication', pub.id, { status: pub.status }, { reason: 'dependency', dependency_status: dep.status });
        await notifyRoles(db, L.brandId, ['approver', 'admin'], 'publication.on_hold', { pieceId: L.pieceId, publicationId: pub.id, count: 1, reason: why }, null);
        return 'held';
      });
    }
  }
  return null;
}

// ───────────────────────────── the steps ─────────────────────────────

/**
 * Right before anything is sent to a network, the approval is checked again, from the stored files themselves, the same way
 * scheduling checks it: nothing goes out that is not approved, for this account, as it stands. If it no longer counts the post
 * is put on hold (and taken down from the network if the network was holding it) instead of being sent.
 */
async function holdIfApprovalLapsed(ctx: Ctx, L: Loaded): Promise<string | null> {
  const eff = await effectiveApproval(ctx.db, L.pub.version_id);
  let reason: string | null = null;
  if (!eff.approved || !eff.accountIds.includes(L.pub.social_account_id)) reason = 'The approval behind this publication no longer counts';
  else if (!(await storedFilesMatch(ctx, L.pub.version_id))) reason = 'The stored files no longer match the approved ones';
  if (!reason) return null;
  return ctx.db.tx(async (db) => {
    const held = await commit(db, L.w, ['scheduled', 'preparing', 'ready', 'publishing'], { status: 'on_hold', hold_reason: reason, next_run_at: ctx.now() });
    if (!held) return 'changed';
    await audit(db, null, L.brandId, 'publication.on_hold', 'publication', L.pub.id, null, { reason: reason === 'The approval behind this publication no longer counts' ? 'approval no longer counts' : 'stored files changed' });
    await notifyRoles(db, L.brandId, ['approver', 'admin'], 'publication.on_hold', { pieceId: L.pieceId, count: 1 }, null);
    return 'held';
  });
}

async function prepare(ctx: Ctx, L: Loaded): Promise<string> {
  const { pub, connector, account } = L;
  const now = ctx.now();
  const scheduled = new Date(pub.scheduled_at);
  if (!connector) return onError(ctx, L, 'prepare', new ConnectorError('unsupported', `This server cannot publish to ${account.network}`));
  if (now.getTime() > scheduled.getTime() + L.toleranceMs) {
    return fail(ctx, L, 'missed_window', `It was due ${scheduled.toISOString()} and could not be prepared in time, so it was not published late.`);
  }
  const lapsed = await holdIfApprovalLapsed(ctx, L);
  if (lapsed) return lapsed;
  try {
    const input = await inputFor(ctx, L, true);
    const errors = connector.validate(input, account).filter((i) => i.severity === 'error');
    if (errors.length) throw new ConnectorError('file_rejected', errors.map((i) => i.message).join(' '));
    const r = await connector.prepare(input, account, pub.handle ?? {}, connectorEnv(ctx, account.id, (h) => saveHandle(ctx, L, h, 'prepare')));
    // Whatever the connector made may be held by the network until it is taken down (a Facebook video still processing, say).
    const holds = !!r.nativeScheduled || (!!connector.discard && nonEmpty(r.handle));
    if (!r.done) {
      await record(ctx, L, 'prepare', 'pending', { detail: { retryAfterSec: r.retryAfterSec } });
      const ok = await commit(ctx.db, L.w, ['preparing'], { handle: r.handle, held_on_network: holds || pub.held_on_network, next_run_at: addSeconds(now, r.retryAfterSec ?? 10) });
      if (!ok && holds) await takeDownLater(ctx, L, r.handle);
      return ok ? 'preparing' : 'changed';
    }
    await record(ctx, L, 'prepare', 'ok', { detail: { nativeScheduled: !!r.nativeScheduled } });
    const native = !!r.nativeScheduled;
    const at = native ? addSeconds(scheduled, TIMING.nativeGraceSeconds) : scheduled;
    const ok = await commit(ctx.db, L.w, ['preparing'], {
      status: 'ready', handle: r.handle, native_scheduled: native, held_on_network: holds, attempts: 0, last_error: null, last_error_class: null,
      next_run_at: at < now ? now : at,
    });
    // Cancelled or held while we were preparing: the network may now hold a post nobody wants. Take it down.
    if (!ok && holds) await takeDownLater(ctx, L, r.handle, native);
    return ok ? 'ready' : 'changed';
  } catch (err) {
    return onError(ctx, L, 'prepare', err);
  }
}

/** The publication was stopped while the network was being given something: have that taken down as soon as the lease is let go. */
async function takeDownLater(ctx: Ctx, L: Loaded, handle: Handle, native = false) {
  await ctx.db.query(
    `update publication set handle = $3, held_on_network = true, native_scheduled = native_scheduled or $4, next_run_at = $5, updated_at = now()
     where id = $1 and lease_token = $2 and status in ('cancelled','on_hold','failed')`,
    [L.w.id, L.w.lease, JSON.stringify(handle), native, ctx.now()],
  );
}

/**
 * Sends the post. `resumed` is a pass that finds it already publishing: an earlier one began sending and did not finish (the worker
 * died, or the network failed). If the connector recorded progress then, the network may have the post, so it is finished through
 * the connector's own recovery (which never posts twice) even past the tolerance: that is the end of a send that began on time, not
 * a late one. If it recorded none, the usual rule applies, and the team is told it could not be confirmed.
 */
async function publish(ctx: Ctx, L: Loaded, resumed: boolean): Promise<string> {
  const { pub, connector, account } = L;
  const now = ctx.now();
  const scheduled = new Date(pub.scheduled_at);
  if (!connector) return onError(ctx, L, 'publish', new ConnectorError('unsupported', `This server cannot publish to ${account.network}`));
  const progressed = !!pub.publish_progress_at;
  // A post the network holds goes out by itself even if we were down. One that we publish ourselves is not sent late.
  if (!pub.native_scheduled && !progressed && now.getTime() > scheduled.getTime() + L.toleranceMs) {
    const late = `It was due ${scheduled.toISOString()} and the app was not able to publish it within ${Math.round(L.toleranceMs / 60000)} minutes, so it was not sent late.`;
    return fail(ctx, L, 'missed_window', resumed ? `${late} Publishing had begun and was interrupted before anything was recorded: check ${account.network} in case it went out.` : late);
  }
  // A post the network is holding was checked when it was handed over, and a later change takes it down (versions.ts). A send that
  // had begun is finished as it was approved then, like one that is going out at the moment a new version arrives.
  if (!pub.native_scheduled && !progressed) {
    const lapsed = await holdIfApprovalLapsed(ctx, L);
    if (lapsed) return lapsed;
  }
  try {
    const input = await inputFor(ctx, L, true);
    const out = await connector.publish(input, account, pub.handle ?? {}, connectorEnv(ctx, account.id, (h) => saveHandle(ctx, L, h, 'publish')));
    await record(ctx, L, 'publish', 'ok', { detail: { externalId: out.externalId, ...(progressed ? { recovered: true } : {}) } });
    return await ctx.db.tx(async (db) => {
      const ok = await commit(db, L.w, ['publishing'], {
        status: 'published', external_id: out.externalId, url: out.url ?? null, published_at: now, attempts: 0, verify_attempts: 0,
        visibility: null, last_error: null, last_error_class: null, next_run_at: now,
      });
      if (!ok) return 'changed';
      await audit(db, null, L.brandId, 'publication.published', 'publication', pub.id, { status: 'publishing' }, { externalId: out.externalId, url: out.url ?? null });
      await wakeDependents(db, pub.id, now);
      return 'published';
    });
  } catch (err) {
    return onError(ctx, L, 'publish', err);
  }
}

async function verify(ctx: Ctx, L: Loaded): Promise<string> {
  const { pub, connector, account } = L;
  const now = ctx.now();
  if (!connector || !pub.external_id) {
    await commit(ctx.db, L.w, ['published'], { next_run_at: null });
    return 'nothing-to-verify';
  }
  try {
    const res = await connector.verify(account, pub.external_id, pub.handle ?? {}, connectorEnv(ctx, account.id, (h) => saveHandle(ctx, L, h, 'verify')));
    await record(ctx, L, 'verify', 'ok', { detail: { visibility: res.visibility, note: res.note } });
    const handle = res.handle ? { ...(pub.handle ?? {}), ...res.handle } : (pub.handle ?? {});
    const checks = (pub.verify_attempts as number) + 1;
    const base: Patch = { handle, url: res.url ?? pub.url, visibility: res.visibility, verify_attempts: checks, last_error: null, last_error_class: null };
    const scheduled = new Date(pub.scheduled_at);
    const sameAsBefore = pub.visibility === res.visibility;

    switch (res.visibility) {
      case 'public':
        return await ctx.db.tx(async (db) => {
          if (!(await commit(db, L.w, ['published'], { ...base, verify_attempts: 0, next_run_at: null }))) return 'changed';
          // Its numbers are read at set ages from now on. Repeating this is harmless: what is already scheduled stays.
          await scheduleSnapshots(db, { id: pub.id, placement: pub.placement, published_at: pub.published_at });
          if (!sameAsBefore) {
            await audit(db, null, L.brandId, 'publication.live', 'publication', pub.id, { visibility: pub.visibility }, { visibility: 'public', url: res.url ?? pub.url });
            await tell(db, L, 'publication.published', { url: res.url ?? pub.url });
            await emitPublication(ctx, db, L.brandId, pub.id, 'publication.published');
          }
          return 'public';
        });
      case 'private':
        // Not a failure: the network is holding the post back (YouTube, until its audit passes). A person has to finish it.
        return await ctx.db.tx(async (db) => {
          if (!(await commit(db, L.w, ['published'], { ...base, next_run_at: null }))) return 'changed';
          if (!sameAsBefore) {
            await audit(db, null, L.brandId, 'publication.private', 'publication', pub.id, { visibility: pub.visibility }, { visibility: 'private', note: res.note ?? null });
            await tell(db, L, 'publication.private', { url: res.url ?? pub.url, message: res.note });
          }
          return 'private';
        });
      case 'scheduled': {
        if (now.getTime() > scheduled.getTime() + 30 * 60_000) {
          return fail(ctx, L, 'unknown', 'The network still shows this post as scheduled, long after its hour.');
        }
        const next = new Date(Math.max(scheduled.getTime() + 30_000, now.getTime() + TIMING.verifyEverySeconds * 1000));
        await commit(ctx.db, L.w, ['published'], { ...base, next_run_at: next });
        return 'scheduled';
      }
      case 'processing':
      case 'unknown': {
        const limit = res.visibility === 'unknown' ? 3 : TIMING.maxVerifyChecks;
        if (checks > limit) {
          return await ctx.db.tx(async (db) => {
            if (!(await commit(db, L.w, ['published'], { ...base, next_run_at: null }))) return 'changed';
            await tell(db, L, 'publication.failed', { errorClass: 'unknown', message: res.visibility === 'unknown' ? 'The network no longer shows this post. Check it there.' : 'The network is still processing this post after an hour. Check it there.' });
            return 'gave-up-verifying';
          });
        }
        await commit(ctx.db, L.w, ['published'], { ...base, next_run_at: addSeconds(now, res.visibility === 'unknown' ? 300 : TIMING.verifyEverySeconds) });
        return res.visibility;
      }
    }
  } catch (err) {
    return onError(ctx, L, 'verify', err);
  }
}

/** Takes down what the network is holding for a publication that was cancelled, held or failed. */
async function discard(ctx: Ctx, L: Loaded): Promise<string> {
  const { pub, connector, account } = L;
  const cleared: Patch = { native_scheduled: false, held_on_network: false, next_run_at: null };
  if (!connector?.discard || !(pub.held_on_network || pub.native_scheduled)) {
    await commit(ctx.db, L.w, [pub.status], cleared);
    return 'nothing-to-discard';
  }
  try {
    await connector.discard(account, pub.handle ?? {}, connectorEnv(ctx, account.id));
    await record(ctx, L, 'discard', 'ok');
    await ctx.db.tx(async (db) => {
      await commit(db, L.w, [pub.status], { ...cleared, handle: {}, attempts: 0 });
      await audit(db, null, L.brandId, 'publication.discarded', 'publication', pub.id, null, { network: account.network });
    });
    return 'discarded';
  } catch (err) {
    return onError(ctx, L, 'discard', err);
  }
}

// ───────────────────────────── the entry point ─────────────────────────────

/**
 * Does whatever one automatic publication needs next. Safe to call at any time and more than once: it takes a lease on the
 * publication, looks at its state and the clock, and does nothing if there is nothing due. The lease is renewed while the work
 * lasts and every write is fenced by it.
 */
export async function advance(ctx: Ctx, publicationId: string): Promise<string> {
  const now = ctx.now();
  const w: Held = { id: publicationId, lease: randomUUID() };
  const claimed = await ctx.db.one(
    `update publication set lease_until = $2, lease_token = $4
     where id = $1 and manual = false and next_run_at is not null and next_run_at <= $3 and (lease_until is null or lease_until < $3) returning id`,
    [publicationId, addSeconds(now, TIMING.leaseSeconds), now, w.lease],
  );
  if (!claimed) return 'skipped';
  const renew = setInterval(() => {
    ctx.db.query('update publication set lease_until = $3 where id = $1 and lease_token = $2', [w.id, w.lease, addSeconds(ctx.now(), TIMING.leaseSeconds)])
      .catch((err) => ctx.log.warn({ publicationId, err: String(err) }, 'could not renew the publishing lease'));
  }, TIMING.renewEverySeconds * 1000);
  renew.unref();
  // Every `return` below is awaited: the lease is let go in `finally`, and a bare `return somePromise` would let it go while the work is still going.
  try {
    let L = await load(ctx, w);
    if (!L) return 'gone';
    const scheduled = new Date(L.pub.scheduled_at);
    switch (L.pub.status) {
      case 'scheduled': {
        const prepareAt = new Date(L.pub.prepare_at ?? scheduled);
        if (now < prepareAt) {
          await commit(ctx.db, w, ['scheduled'], { next_run_at: prepareAt });
          return 'waiting';
        }
        const held = await holdBack(ctx, L);
        if (held) return held;
        if (!(await commit(ctx.db, w, ['scheduled'], { status: 'preparing', attempts: 0, handle: {} }))) return 'changed';
        L = (await load(ctx, w))!;
        return await prepare(ctx, L);
      }
      case 'preparing': {
        const held = await holdBack(ctx, L);
        if (held) return held;
        return await prepare(ctx, L);
      }
      case 'ready': {
        const frozen = await holdBack(ctx, L);
        if (frozen) return frozen;
        const at = L.pub.native_scheduled ? addSeconds(scheduled, TIMING.nativeGraceSeconds) : scheduled;
        if (now < at) {
          await commit(ctx.db, w, ['ready'], { next_run_at: at });
          return 'waiting';
        }
        // From here the network gets the post; what it held before (a container, an upload) is the post itself now.
        if (!(await commit(ctx.db, w, ['ready'], { status: 'publishing', held_on_network: !!L.pub.native_scheduled }))) return 'changed';
        L = (await load(ctx, w))!;
        return await publish(ctx, L, false);
      }
      case 'publishing':
        return await publish(ctx, L, true);
      case 'published':
        return await verify(ctx, L);
      case 'cancelled':
      case 'on_hold':
      case 'failed':
        return await discard(ctx, L);
      default:
        await commit(ctx.db, w, [L.pub.status], { next_run_at: null });
        return 'idle';
    }
  } finally {
    clearInterval(renew);
    await ctx.db.query('update publication set lease_until = null, lease_token = null where id = $1 and lease_token = $2', [publicationId, w.lease]);
  }
}

/** The automatic publications that need a look right now. The worker hands each to the queue. */
export async function dueForAttention(ctx: Ctx, limit = 100): Promise<{ id: string; nextRunAt: Date }[]> {
  const now = ctx.now();
  const rows = await ctx.db.query(
    `select id, next_run_at from publication
     where manual = false and next_run_at is not null and next_run_at <= $1 and (lease_until is null or lease_until < $1)
     order by next_run_at limit $2`,
    [now, limit],
  );
  return rows.map((r) => ({ id: r.id, nextRunAt: new Date(r.next_run_at) }));
}

/**
 * Brings forward the publications a freeze has caught while they wait for their hour: prepared ones of a paused brand or on a
 * blocked date, which the worker would otherwise only look at when it is too late (a post the network holds goes out at its hour
 * by itself). Ones the publisher has already held back are left to their own timer. Returns how many.
 */
export async function wakeFrozen(ctx: Ctx): Promise<number> {
  const now = ctx.now();
  const rows = await ctx.db.query(
    `update publication pub set next_run_at = $1
     from variant v, piece p, brand b
     where v.id = pub.variant_id and p.id = v.piece_id and b.id = p.brand_id
       and pub.manual = false and pub.status in ('preparing','ready') and pub.frozen_at is null
       and (pub.next_run_at is null or pub.next_run_at > $1) and pub.scheduled_at > $1
       and (b.paused or exists (select 1 from blocked_date bd where bd.brand_id = b.id and bd.day = (pub.scheduled_at at time zone b.timezone)::date))
     returning pub.id`,
    [now],
  );
  return rows.length;
}

/**
 * Brings forward the ones waiting for a publication that will not go out any more (cancelled, failed, held), so they are held with
 * the reason now instead of at their hour, which for one the network holds would be too late. Returns how many.
 */
export async function wakeOrphans(ctx: Ctx): Promise<number> {
  const now = ctx.now();
  const rows = await ctx.db.query(
    `update publication pub set next_run_at = $1
     from publication dep
     where dep.id = pub.depends_on and dep.status in ('cancelled','failed','on_hold')
       and pub.manual = false and pub.status in ('scheduled','preparing','ready') and pub.next_run_at > $1 and pub.scheduled_at > $1
       and (pub.status <> 'scheduled' or pub.prepare_at <= $1)
     returning pub.id`,
    [now],
  );
  return rows.length;
}

// ───────────────────────────── planning, at the moment of scheduling ─────────────────────────────

export interface Plan {
  /** True when the app will publish this itself; false when a person does. */
  automated: boolean;
  placement: string | null;
  /** The placements this account could use, so the editor can offer a choice. */
  placements: { id: string; label: string }[];
  issues: Issue[];
  /** Why it is manual, when it is. */
  manualReason?: string;
}

/**
 * Works out how a publication would go out and what is wrong with it. A connected account with a connector is automatic
 * unless the person asks for manual or the network cannot do this kind of content, in which case it stays manual with the
 * reason given.
 */
export async function planPublication(
  ctx: Ctx,
  d: {
    brandId: string; versionId: string; accountId: string; piece: Row; variantFormat: string; text: string; firstComment: string;
    options: Record<string, unknown>; scheduledAt: Date; mode?: 'auto' | 'manual'; placement?: string; title?: string; aiGenerated?: boolean;
  },
): Promise<Plan> {
  const row = await ctx.db.one('select id, network, status, token_encrypted from social_account where id = $1 and brand_id = $2', [d.accountId, d.brandId]);
  const account = await loadConnectorAccount(ctx, d.accountId);
  const connector = row ? ctx.connectors.connector(row.network) : null;
  if (!row || !account) return { automated: false, placement: null, placements: [], issues: [], manualReason: 'Unknown account' };

  const placements = connector ? connector.capabilities(account).placements.map((p) => ({ id: p.id, label: p.label })) : [];
  if (d.mode === 'manual') return { automated: false, placement: null, placements, issues: [], manualReason: 'Chosen to be published by hand' };
  if (!connector) return { automated: false, placement: null, placements, issues: [], manualReason: 'This account is published by hand: it is not connected to its network' };
  if (row.status !== 'active' || !row.token_encrypted) {
    return { automated: false, placement: null, placements, issues: [], manualReason: row.status === 'reconnect_required' ? 'This account has to be reconnected before the app can publish to it' : 'This account is not connected to its network' };
  }

  const assets = await ctx.db.query('select kind from asset where version_id = $1', [d.versionId]);
  const placement = d.placement ?? connector.defaultPlacement({ pieceKind: d.piece.kind, format: d.variantFormat, media: assets.map((a) => ({ kind: a.kind })) });
  if (!placement) {
    return { automated: false, placement: null, placements, issues: [], manualReason: `${account.network} cannot publish this kind of content through its API, so a person has to` };
  }
  const input = await buildInput(ctx, {
    publicationId: '', brandId: d.brandId, versionId: d.versionId, placement, title: d.title ?? d.piece.title, text: d.text, firstComment: d.firstComment,
    options: d.options, scheduledAt: d.scheduledAt, aiGenerated: d.aiGenerated ?? d.piece.ai_generated,
  }, false);
  return { automated: true, placement, placements, issues: connector.validate(input, account) };
}
