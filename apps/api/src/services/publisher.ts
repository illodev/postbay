import type { Row } from '../db.js';
import { profileOf } from '../connectors/profiles.js';
import { redact } from '../connectors/http.js';
import {
  ConnectorError,
  type Account, type Connector, type Handle, type Issue, type MediaItem, type PlacementSpec, type PublishInput,
} from '../connectors/types.js';
import type { Ctx } from '../context.js';
import { audit } from './audit.js';
import { effectiveApproval } from './approvals.js';
import { emitPublication } from './events.js';
import { scheduleSnapshots } from './metrics.js';
import { connectorEnv, loadConnectorAccount, markReconnectRequired } from './connectors.js';
import { notifyRoles, type NotifyKind } from './notify.js';
import { fileFor } from './renditions.js';

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
 */

export const TIMING = {
  /** Waits after a transient failure: the 5th failure in a row is the last. */
  backoffSeconds: [60, 120, 300, 600, 1200],
  maxAttempts: 5,
  /** While an account waits to be reconnected, look again this often. */
  reconnectRetrySeconds: 600,
  leaseMinutes: 45,
  verifyEverySeconds: 60,
  maxVerifyChecks: 60,
  /** A natively scheduled post is checked this long after its hour, to give the network a moment to publish it. */
  nativeGraceSeconds: 20,
};

type Step = 'prepare' | 'publish' | 'verify' | 'discard';

export interface Loaded {
  pub: Row;
  brandId: string;
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

async function load(ctx: Ctx, id: string): Promise<Loaded | null> {
  const pub = await ctx.db.one(
    `select pub.*, p.id as piece_id, p.title as piece_title, p.kind as piece_kind, p.ai_generated, p.brand_id, v.format, b.publishing
     from publication pub join variant v on v.id = pub.variant_id join piece p on p.id = v.piece_id join brand b on b.id = p.brand_id
     where pub.id = $1`,
    [id],
  );
  if (!pub) return null;
  const account = await loadConnectorAccount(ctx, pub.social_account_id);
  if (!account) return null;
  const tolerance = Number(pub.publishing?.late_tolerance_minutes ?? 15) * 60_000;
  return {
    pub, brandId: pub.brand_id, pieceId: pub.piece_id, pieceTitle: pub.piece_title, pieceKind: pub.piece_kind, aiGenerated: pub.ai_generated,
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
  url: string | null; published_at: Date | null; manual: boolean; hold_reason: string | null;
}>;

/** Writes a change only if the publication is still in a state the step expected, so a cancel or hold in the meantime wins. */
async function commit(ctx: Ctx, id: string, expected: string[], patch: Patch): Promise<boolean> {
  const keys = Object.keys(patch) as (keyof Patch)[];
  const sets = keys.map((k, i) => `${k} = $${i + 3}`);
  const values = keys.map((k) => (k === 'handle' ? JSON.stringify(patch[k]) : patch[k]));
  const row = await ctx.db.one(
    `update publication set ${sets.join(', ')}${sets.length ? ',' : ''} updated_at = now() where id = $1 and status = any($2) returning id`,
    [id, expected, ...values],
  );
  return !!row;
}

async function saveHandle(ctx: Ctx, id: string, handle: Handle) {
  await ctx.db.query('update publication set handle = $2, updated_at = now() where id = $1', [id, JSON.stringify(handle)]);
}

async function record(
  ctx: Ctx, L: Loaded, step: Step, outcome: 'ok' | 'pending' | 'error',
  o: { errorClass?: string; httpStatus?: number; detail?: unknown } = {},
) {
  const n = ((await ctx.db.one<{ n: number }>('select count(*)::int as n from publication_attempt where publication_id = $1 and step = $2', [L.pub.id, step]))?.n ?? 0) + 1;
  await ctx.db.query(
    `insert into publication_attempt (publication_id, step, attempt, started_at, finished_at, outcome, error_class, http_status, detail)
     values ($1,$2,$3,$4,$4,$5,$6,$7,$8)`,
    [L.pub.id, step, n, ctx.now(), outcome, o.errorClass ?? null, o.httpStatus ?? null, JSON.stringify(redact(o.detail ?? {}))],
  );
  await audit(ctx.db, null, L.brandId, 'publication.attempt', 'publication', L.pub.id, null, { step, attempt: n, outcome, errorClass: o.errorClass ?? null, httpStatus: o.httpStatus ?? null });
}

async function tell(ctx: Ctx, L: Loaded, kind: NotifyKind, extra: Record<string, unknown> = {}) {
  await notifyRoles(ctx.db, L.brandId, ['approver', 'admin'], kind, { publicationId: L.pub.id, pieceId: L.pieceId, title: L.pieceTitle, network: L.account.network, ...extra }, null);
}

async function fail(ctx: Ctx, L: Loaded, errorClass: string, message: string, attempts?: number): Promise<string> {
  const native = L.pub.native_scheduled as boolean;
  const ok = await commit(ctx, L.pub.id, ['scheduled', 'preparing', 'ready', 'publishing', 'published'], {
    ...(attempts === undefined ? {} : { attempts }),
    status: 'failed', failed_at: ctx.now(), last_error_class: errorClass, last_error: message.slice(0, 1000),
    // A post the network is holding must be taken down, or it would still go out at its hour.
    next_run_at: native ? ctx.now() : null,
  });
  if (!ok) return 'changed';
  await audit(ctx.db, null, L.brandId, 'publication.failed', 'publication', L.pub.id, { status: L.pub.status }, { errorClass, message: message.slice(0, 300) });
  await tell(ctx, L, 'publication.failed', { errorClass, message: message.slice(0, 300) });
  await emitPublication(ctx, ctx.db, L.brandId, L.pub.id, 'publication.failed', { error: { class: errorClass, message: message.slice(0, 500) } });
  return 'failed';
}

// ───────────────────────────── errors ─────────────────────────────

/** Decides what a failed step means: wait, try again, hand it to a person, or give up and say so. */
async function onError(ctx: Ctx, L: Loaded, step: Step, err: unknown): Promise<string> {
  const e = err instanceof ConnectorError ? err : new ConnectorError('unknown', (err as Error)?.message ?? String(err));
  await record(ctx, L, step, 'error', { errorClass: e.errorClass, httpStatus: e.httpStatus, detail: { message: e.message, ...(e.detail ? { response: e.detail } : {}) } });
  const now = ctx.now();
  const dueBy = new Date(new Date(L.pub.scheduled_at).getTime() + L.toleranceMs);
  const status = L.pub.status as string;
  const live = status === 'published';
  const schedule = async (next: Date, patch: Patch = {}) => {
    await commit(ctx, L.pub.id, ['scheduled', 'preparing', 'ready', 'publishing', 'published', 'cancelled', 'on_hold', 'failed'], { next_run_at: next, last_error_class: e.errorClass, last_error: e.message.slice(0, 1000), ...patch });
    return `retry:${e.errorClass}`;
  };

  if (step === 'discard') {
    // Nothing is lost by trying again, but after a few tries a person has to remove it by hand.
    const attempts = (L.pub.attempts as number) + 1;
    if (e.errorClass === 'auth') await markReconnectRequired(ctx, L.account.id, e.message);
    if (attempts >= TIMING.maxAttempts * 2) {
      await commit(ctx, L.pub.id, ['cancelled', 'on_hold', 'failed'], { next_run_at: null, attempts });
      await tell(ctx, L, 'publication.failed', { errorClass: e.errorClass, message: `Could not remove the post from ${L.account.network}: delete it there by hand. (${e.message.slice(0, 200)})` });
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
      // The API cannot do this: it becomes a manual publication, with everything ready for a person.
      const ok = await commit(ctx, L.pub.id, ['scheduled', 'preparing', 'ready', 'publishing'], { status: 'scheduled', manual: true, handle: {}, next_run_at: null, native_scheduled: false, last_error_class: 'unsupported', last_error: e.message.slice(0, 1000) });
      if (ok) {
        await audit(ctx.db, null, L.brandId, 'publication.handed_over', 'publication', L.pub.id, { manual: false }, { manual: true, reason: e.message.slice(0, 200) });
        await tell(ctx, L, 'publication.failed', { errorClass: 'unsupported', handedOver: true, message: `${e.message} It now needs to be published by hand.` });
      }
      return 'handed-over';
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

// ───────────────────────────── the steps ─────────────────────────────

/**
 * Right before anything is sent to a network, the approval is checked again from the stored files, the same way scheduling
 * checks it: nothing goes out that is not approved, for this account, as it stands. If it no longer counts the post is put
 * on hold (and taken down from the network if the network was holding it) instead of being sent.
 */
async function holdIfApprovalLapsed(ctx: Ctx, L: Loaded): Promise<string | null> {
  const eff = await effectiveApproval(ctx.db, L.pub.version_id);
  if (eff.approved && eff.accountIds.includes(L.pub.social_account_id)) return null;
  const held = await commit(ctx, L.pub.id, ['scheduled', 'preparing', 'ready', 'publishing'], {
    status: 'on_hold', hold_reason: 'The approval behind this publication no longer counts', next_run_at: ctx.now(),
  });
  if (!held) return 'changed';
  await audit(ctx.db, null, L.brandId, 'publication.on_hold', 'publication', L.pub.id, null, { reason: 'approval no longer counts' });
  await notifyRoles(ctx.db, L.brandId, ['approver', 'admin'], 'publication.on_hold', { pieceId: L.pieceId, count: 1 }, null);
  return 'held';
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
    const r = await connector.prepare(input, account, pub.handle ?? {}, connectorEnv(ctx, account.id, (h) => saveHandle(ctx, pub.id, h)));
    if (!r.done) {
      await record(ctx, L, 'prepare', 'pending', { detail: { retryAfterSec: r.retryAfterSec } });
      await commit(ctx, pub.id, ['preparing'], { handle: r.handle, next_run_at: addSeconds(now, r.retryAfterSec ?? 10) });
      return 'preparing';
    }
    await record(ctx, L, 'prepare', 'ok', { detail: { nativeScheduled: !!r.nativeScheduled } });
    const native = !!r.nativeScheduled;
    const at = native ? addSeconds(scheduled, TIMING.nativeGraceSeconds) : scheduled;
    const ok = await commit(ctx, pub.id, ['preparing'], {
      status: 'ready', handle: r.handle, native_scheduled: native, attempts: 0, last_error: null, last_error_class: null,
      next_run_at: at < now ? now : at,
    });
    if (!ok && native) {
      // Cancelled or held while we were preparing: the network may now hold a post nobody wants. Take it down.
      await ctx.db.query('update publication set native_scheduled = true, handle = $2, next_run_at = $3 where id = $1', [pub.id, JSON.stringify(r.handle), now]);
    }
    return ok ? 'ready' : 'changed';
  } catch (err) {
    return onError(ctx, L, 'prepare', err);
  }
}

async function publish(ctx: Ctx, L: Loaded): Promise<string> {
  const { pub, connector, account } = L;
  const now = ctx.now();
  const scheduled = new Date(pub.scheduled_at);
  if (!connector) return onError(ctx, L, 'publish', new ConnectorError('unsupported', `This server cannot publish to ${account.network}`));
  // A post the network holds goes out by itself even if we were down. One that we publish ourselves is not sent late.
  if (!pub.native_scheduled && now.getTime() > scheduled.getTime() + L.toleranceMs) {
    return fail(ctx, L, 'missed_window', `It was due ${scheduled.toISOString()} and the app was not able to publish it within ${Math.round(L.toleranceMs / 60000)} minutes, so it was not sent late.`);
  }
  // A post the network is holding was checked when it was handed over, and a later change takes it down (versions.ts).
  if (!pub.native_scheduled) {
    const lapsed = await holdIfApprovalLapsed(ctx, L);
    if (lapsed) return lapsed;
  }
  try {
    const input = await inputFor(ctx, L, true);
    const out = await connector.publish(input, account, pub.handle ?? {}, connectorEnv(ctx, account.id, (h) => saveHandle(ctx, pub.id, h)));
    await record(ctx, L, 'publish', 'ok', { detail: { externalId: out.externalId } });
    const ok = await commit(ctx, pub.id, ['publishing'], {
      status: 'published', external_id: out.externalId, url: out.url ?? null, published_at: now, attempts: 0, verify_attempts: 0,
      visibility: null, last_error: null, last_error_class: null, next_run_at: now,
    });
    if (ok) await audit(ctx.db, null, L.brandId, 'publication.published', 'publication', pub.id, { status: 'publishing' }, { externalId: out.externalId, url: out.url ?? null });
    return ok ? 'published' : 'changed';
  } catch (err) {
    return onError(ctx, L, 'publish', err);
  }
}

async function verify(ctx: Ctx, L: Loaded): Promise<string> {
  const { pub, connector, account } = L;
  const now = ctx.now();
  if (!connector || !pub.external_id) {
    await commit(ctx, pub.id, ['published'], { next_run_at: null });
    return 'nothing-to-verify';
  }
  try {
    const res = await connector.verify(account, pub.external_id, pub.handle ?? {}, connectorEnv(ctx, account.id, (h) => saveHandle(ctx, pub.id, h)));
    await record(ctx, L, 'verify', 'ok', { detail: { visibility: res.visibility, note: res.note } });
    const handle = res.handle ? { ...(pub.handle ?? {}), ...res.handle } : (pub.handle ?? {});
    const checks = (pub.verify_attempts as number) + 1;
    const base: Patch = { handle, url: res.url ?? pub.url, visibility: res.visibility, verify_attempts: checks, last_error: null, last_error_class: null };
    const scheduled = new Date(pub.scheduled_at);
    const sameAsBefore = pub.visibility === res.visibility;

    switch (res.visibility) {
      case 'public':
        await commit(ctx, pub.id, ['published'], { ...base, verify_attempts: 0, next_run_at: null });
        // Its numbers are read at set ages from now on. Repeating this is harmless: what is already scheduled stays.
        await scheduleSnapshots(ctx.db, { id: pub.id, placement: pub.placement, published_at: pub.published_at });
        if (!sameAsBefore) {
          await audit(ctx.db, null, L.brandId, 'publication.live', 'publication', pub.id, { visibility: pub.visibility }, { visibility: 'public', url: res.url ?? pub.url });
          await tell(ctx, L, 'publication.published', { url: res.url ?? pub.url });
          await emitPublication(ctx, ctx.db, L.brandId, pub.id, 'publication.published');
        }
        return 'public';
      case 'private':
        // Not a failure: the network is holding the post back (YouTube, until its audit passes). A person has to finish it.
        await commit(ctx, pub.id, ['published'], { ...base, next_run_at: null });
        if (!sameAsBefore) {
          await audit(ctx.db, null, L.brandId, 'publication.private', 'publication', pub.id, { visibility: pub.visibility }, { visibility: 'private', note: res.note ?? null });
          await tell(ctx, L, 'publication.private', { url: res.url ?? pub.url, message: res.note });
        }
        return 'private';
      case 'scheduled': {
        if (now.getTime() > scheduled.getTime() + 30 * 60_000) {
          return fail(ctx, L, 'unknown', 'The network still shows this post as scheduled, long after its hour.');
        }
        const next = new Date(Math.max(scheduled.getTime() + 30_000, now.getTime() + TIMING.verifyEverySeconds * 1000));
        await commit(ctx, pub.id, ['published'], { ...base, next_run_at: next });
        return 'scheduled';
      }
      case 'processing':
      case 'unknown': {
        const limit = res.visibility === 'unknown' ? 3 : TIMING.maxVerifyChecks;
        if (checks > limit) {
          await commit(ctx, pub.id, ['published'], { ...base, next_run_at: null });
          await tell(ctx, L, 'publication.failed', { errorClass: 'unknown', message: res.visibility === 'unknown' ? 'The network no longer shows this post. Check it there.' : 'The network is still processing this post after an hour. Check it there.' });
          return 'gave-up-verifying';
        }
        await commit(ctx, pub.id, ['published'], { ...base, next_run_at: addSeconds(now, res.visibility === 'unknown' ? 300 : TIMING.verifyEverySeconds) });
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
  if (!connector?.discard || !pub.native_scheduled) {
    await ctx.db.query('update publication set native_scheduled = false, next_run_at = null where id = $1', [pub.id]);
    return 'nothing-to-discard';
  }
  try {
    await connector.discard(account, pub.handle ?? {}, connectorEnv(ctx, account.id));
    await record(ctx, L, 'discard', 'ok');
    await ctx.db.query(`update publication set native_scheduled = false, handle = '{}', attempts = 0, next_run_at = null where id = $1`, [pub.id]);
    await audit(ctx.db, null, L.brandId, 'publication.discarded', 'publication', pub.id, null, { network: account.network });
    return 'discarded';
  } catch (err) {
    return onError(ctx, L, 'discard', err);
  }
}

// ───────────────────────────── the entry point ─────────────────────────────

/**
 * Does whatever one automatic publication needs next. Safe to call at any time and more than once: it takes a lease on the
 * publication, looks at its state and the clock, and does nothing if there is nothing due.
 */
export async function advance(ctx: Ctx, publicationId: string): Promise<string> {
  const now = ctx.now();
  const claimed = await ctx.db.one(
    `update publication set lease_until = $2
     where id = $1 and manual = false and next_run_at is not null and next_run_at <= $3 and (lease_until is null or lease_until < $3) returning id`,
    [publicationId, addSeconds(now, TIMING.leaseMinutes * 60), now],
  );
  if (!claimed) return 'skipped';
  try {
    let L = await load(ctx, publicationId);
    if (!L) return 'gone';
    const scheduled = new Date(L.pub.scheduled_at);
    switch (L.pub.status) {
      case 'scheduled': {
        const prepareAt = new Date(L.pub.prepare_at ?? scheduled);
        if (now < prepareAt) {
          await commit(ctx, publicationId, ['scheduled'], { next_run_at: prepareAt });
          return 'waiting';
        }
        if (!(await commit(ctx, publicationId, ['scheduled'], { status: 'preparing', attempts: 0, handle: {} }))) return 'changed';
        L = (await load(ctx, publicationId))!;
        return prepare(ctx, L);
      }
      case 'preparing':
        return prepare(ctx, L);
      case 'ready': {
        const at = L.pub.native_scheduled ? addSeconds(scheduled, TIMING.nativeGraceSeconds) : scheduled;
        if (now < at) {
          await commit(ctx, publicationId, ['ready'], { next_run_at: at });
          return 'waiting';
        }
        if (!(await commit(ctx, publicationId, ['ready'], { status: 'publishing' }))) return 'changed';
        L = (await load(ctx, publicationId))!;
        return publish(ctx, L);
      }
      case 'publishing':
        return publish(ctx, L);
      case 'published':
        return verify(ctx, L);
      case 'cancelled':
      case 'on_hold':
      case 'failed':
        return discard(ctx, L);
      default:
        await commit(ctx, publicationId, [L.pub.status], { next_run_at: null });
        return 'idle';
    }
  } finally {
    await ctx.db.query('update publication set lease_until = null where id = $1', [publicationId]);
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
    options: Record<string, unknown>; scheduledAt: Date; mode?: 'auto' | 'manual'; placement?: string;
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
    publicationId: '', brandId: d.brandId, versionId: d.versionId, placement, title: d.piece.title, text: d.text, firstComment: d.firstComment,
    options: d.options, scheduledAt: d.scheduledAt, aiGenerated: d.piece.ai_generated,
  }, false);
  return { automated: true, placement, placements, issues: connector.validate(input, account) };
}
