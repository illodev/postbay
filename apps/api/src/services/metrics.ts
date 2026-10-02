import { z } from 'zod';
import { authorize, type Principal } from '../auth/principal.js';
import { redact } from '../connectors/http.js';
import { ConnectorError, type CommonMetrics } from '../connectors/types.js';
import type { Ctx } from '../context.js';
import type { Queryable } from '../db.js';
import { notFound } from '../errors.js';
import { connectorEnv, loadConnectorAccount } from './connectors.js';

/**
 * What came of each post: its numbers, read at set ages after it went live, so a post can be compared with the last one at the
 * same age and not only at whatever moment somebody happened to look.
 *
 * A published post gets one row per age at once (see scheduleSnapshots); the worker reads each when it falls due. Stories get
 * theirs early, because a network drops a story's numbers after a day. Each network counts a "view" its own way, so the
 * figures are only ever put side by side within one network.
 */
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
export const STANDARD_AGES: readonly [string, number][] = [['1h', HOUR], ['1d', DAY], ['7d', 7 * DAY], ['28d', 28 * DAY]];
export const STORY_AGES: readonly [string, number][] = [['1h', HOUR], ['6h', 6 * HOUR], ['22h', 22 * HOUR]];
/** After this long a story's numbers are gone from the network. */
const STORY_WINDOW = DAY;
/** Waits after a failure, in seconds; the fifth failure is the last. */
const BACKOFF = [300, 900, 3600, 3 * 3600, 6 * 3600];
const MAX_ATTEMPTS = BACKOFF.length;
const LEASE_MS = 5 * 60_000;
/** A reading that has been held back by limits for this long is given up. */
const GIVE_UP_AFTER = 3 * DAY;

export const agesFor = (placement: string | null) => (placement === 'story' ? STORY_AGES : STANDARD_AGES);

/** Makes the rows for a post that has gone live. Safe to repeat: a post that was already scheduled keeps what it has. */
export async function scheduleSnapshots(db: Queryable, pub: { id: string; placement: string | null; published_at: Date | string }): Promise<void> {
  const at = new Date(pub.published_at).getTime();
  for (const [age, offset] of agesFor(pub.placement)) {
    const due = new Date(at + offset);
    await db.query(
      `insert into metric_snapshot (publication_id, age, due_at, next_attempt_at) values ($1,$2,$3,$3) on conflict (publication_id, age) do nothing`,
      [pub.id, age, due],
    );
  }
}

/** Drops the keys a network did not give, so nothing is read as zero. */
export function compact(m: CommonMetrics): CommonMetrics {
  return Object.fromEntries(Object.entries(m).filter(([, v]) => typeof v === 'number' && Number.isFinite(v))) as CommonMetrics;
}

type Row = Record<string, any>;

async function settle(ctx: Ctx, id: number, patch: { status: string; note?: string | null; metrics?: CommonMetrics; raw?: unknown; next?: Date }) {
  await ctx.db.query(
    `update metric_snapshot set status = $2, note = $3, metrics = coalesce($4::jsonb, metrics), raw = $5, taken_at = case when $2 = 'ok' then $6::timestamptz else taken_at end,
       next_attempt_at = coalesce($7::timestamptz, next_attempt_at), lease_until = null where id = $1`,
    [id, patch.status, patch.note ?? null, patch.metrics ? JSON.stringify(patch.metrics) : null, patch.raw === undefined ? null : JSON.stringify(patch.raw), ctx.now(), patch.next ?? null],
  );
}

async function readOne(ctx: Ctx, snap: Row): Promise<string> {
  const now = ctx.now();
  const pub = await ctx.db.one(
    `select p.id, p.status, p.manual, p.external_id, p.handle, p.placement, p.published_at, p.social_account_id, a.status as account_status, a.network
     from publication p join social_account a on a.id = p.social_account_id where p.id = $1`,
    [snap.publication_id],
  );
  if (!pub || pub.status !== 'published' || pub.manual || !pub.external_id) {
    await settle(ctx, snap.id, { status: 'unavailable', note: 'This post is no longer published through the app, so there is nothing to read' });
    return 'unavailable';
  }
  const publishedAt = new Date(pub.published_at);
  const story = pub.placement === 'story';
  if (story && now.getTime() > publishedAt.getTime() + STORY_WINDOW) {
    await settle(ctx, snap.id, { status: 'expired', note: "A story's numbers can only be read for 24 hours, and this reading came too late" });
    return 'expired';
  }
  const connector = ctx.connectors.connector(pub.network);
  const account = await loadConnectorAccount(ctx, pub.social_account_id);
  if (!connector?.fetchMetrics || !account) {
    await settle(ctx, snap.id, { status: 'unavailable', note: `The app cannot read numbers from ${pub.network} here` });
    return 'unavailable';
  }
  const later = (seconds: number) => new Date(now.getTime() + seconds * 1000);
  const giveUpOrWait = async (note: string, seconds: number, countIt = true): Promise<string> => {
    const next = later(seconds);
    if (story && next.getTime() > publishedAt.getTime() + STORY_WINDOW) {
      await settle(ctx, snap.id, { status: 'expired', note: `${note} (and the story's 24 hours are over)` });
      return 'expired';
    }
    if (now.getTime() - new Date(snap.due_at).getTime() > GIVE_UP_AFTER || (countIt && snap.attempts >= MAX_ATTEMPTS)) {
      await settle(ctx, snap.id, { status: 'failed', note });
      return 'failed';
    }
    if (!countIt) await ctx.db.query('update metric_snapshot set attempts = attempts - 1 where id = $1', [snap.id]);
    await settle(ctx, snap.id, { status: 'pending', note, next });
    return 'retry';
  };

  if (pub.account_status === 'reconnect_required') return giveUpOrWait('The account has to be connected again before its numbers can be read', 6 * 3600);

  try {
    const res = await connector.fetchMetrics(account, pub.external_id, pub.handle ?? {}, connectorEnv(ctx, pub.social_account_id), { publishedAt, placement: pub.placement ?? '' });
    const metrics = compact(res.common);
    if (Object.keys(metrics).length === 0) {
      await settle(ctx, snap.id, { status: 'unavailable', note: res.note ?? 'The network gave no figures for this post', raw: redact(res.raw) });
      return 'unavailable';
    }
    await settle(ctx, snap.id, { status: 'ok', note: res.note ?? null, metrics, raw: redact(res.raw) });
    return 'ok';
  } catch (err) {
    if (!(err instanceof ConnectorError)) {
      ctx.log.warn({ err: String(err), snapshot: snap.id }, 'reading metrics failed');
      return giveUpOrWait(`Reading the numbers failed: ${String((err as Error).message).slice(0, 300)}`, BACKOFF[Math.min(snap.attempts - 1, BACKOFF.length - 1)]!);
    }
    switch (err.errorClass) {
      case 'rate_limit':
        // Waiting out a limit is not a failed try.
        return giveUpOrWait(`${err.message} (the network's limit: it will be read when it clears)`, Math.min(Math.max(60, err.retryAfterSec ?? 900), 6 * 3600), false);
      case 'auth':
        // Often a connection made before the numbers were asked for. It does not stop the account publishing, so it is not a reconnection alarm here.
        return giveUpOrWait(`The connection is not allowed to read numbers: ${err.message}. Connecting the account again grants it.`, BACKOFF[Math.min(snap.attempts - 1, BACKOFF.length - 1)]!);
      case 'file_rejected':
      case 'unsupported':
        await settle(ctx, snap.id, { status: 'unavailable', note: err.message.slice(0, 400) });
        return 'unavailable';
      default:
        return giveUpOrWait(err.message.slice(0, 400), BACKOFF[Math.min(snap.attempts - 1, BACKOFF.length - 1)]!);
    }
  }
}

/** Reads the snapshots that are due. One worker or several: each row is claimed with a lease before it is read. */
export async function scanMetrics(ctx: Ctx, limit = 20): Promise<number> {
  const now = ctx.now();
  const claimed = await ctx.db.query(
    `update metric_snapshot s set lease_until = $2, attempts = s.attempts + 1
     where s.id in (
       select id from metric_snapshot where status = 'pending' and next_attempt_at <= $1 and (lease_until is null or lease_until < $1)
       order by next_attempt_at limit $3 for update skip locked)
     returning s.*`,
    [now, new Date(now.getTime() + LEASE_MS), limit],
  );
  for (const snap of claimed) {
    try {
      await readOne(ctx, snap);
    } catch (err) {
      // Whatever went wrong, the row is released and tried again later, never left holding its lease.
      ctx.log.error({ err: String(err), snapshot: snap.id }, 'metric snapshot failed');
      await ctx.db.query(`update metric_snapshot set lease_until = null, next_attempt_at = $2 where id = $1`, [snap.id, new Date(ctx.now().getTime() + 300_000)]);
    }
  }
  return claimed.length;
}

// ───────────────────────────── reading them ─────────────────────────────

const snapshotView = (r: Row) => ({
  age: r.age, status: r.status, due_at: r.due_at, taken_at: r.taken_at, metrics: r.status === 'ok' ? r.metrics : {}, note: r.note,
});

export async function publicationMetrics(ctx: Ctx, p: Principal, publicationId: string) {
  const pub = await ctx.db.one(
    `select p.id, p.placement, p.published_at, p.url, p.visibility, a.network, a.display_name, a.brand_id, pc.title as piece_title
     from publication p join social_account a on a.id = p.social_account_id join variant v on v.id = p.variant_id join piece pc on pc.id = v.piece_id where p.id = $1`,
    [publicationId],
  );
  if (!pub) throw notFound('Publication');
  await authorize(ctx.db, p, pub.brand_id, 'brand.view');
  const rows = await ctx.db.query('select * from metric_snapshot where publication_id = $1 order by due_at', [publicationId]);
  return {
    publication: { id: pub.id, network: pub.network, account: pub.display_name, piece: pub.piece_title, placement: pub.placement, published_at: pub.published_at, url: pub.url },
    snapshots: rows.map(snapshotView),
  };
}

export const rangeQuery = z.object({
  from: z.string().date().optional(),
  to: z.string().date().optional(),
  network: z.string().max(20).optional(),
});

/** The posts published in a period, each with its readings so far, grouped by network by the caller: networks are never added together. */
export async function brandMetrics(ctx: Ctx, p: Principal, brandId: string, raw: unknown) {
  const q = rangeQuery.parse(raw);
  await authorize(ctx.db, p, brandId, 'brand.view');
  const to = q.to ? new Date(`${q.to}T23:59:59.999Z`) : ctx.now();
  const from = q.from ? new Date(`${q.from}T00:00:00Z`) : new Date(to.getTime() - 90 * DAY);
  const pubs = await ctx.db.query(
    `select p.id, p.placement, p.published_at, p.url, p.visibility, a.network, a.display_name, pc.id as piece_id, pc.title as piece_title
     from publication p join social_account a on a.id = p.social_account_id join variant v on v.id = p.variant_id join piece pc on pc.id = v.piece_id
     where a.brand_id = $1 and p.status = 'published' and p.manual = false and p.published_at between $2 and $3 and ($4::text is null or a.network = $4)
     order by p.published_at desc limit 500`,
    [brandId, from, to, q.network ?? null],
  );
  const ids = pubs.map((r) => r.id);
  const snaps = ids.length ? await ctx.db.query('select * from metric_snapshot where publication_id = any($1) order by due_at', [ids]) : [];
  const rows = pubs.map((r) => {
    const mine = snaps.filter((s) => s.publication_id === r.id);
    const ok = mine.filter((s) => s.status === 'ok');
    const latest = ok.at(-1);
    return {
      publication: { id: r.id, network: r.network, account: r.display_name, piece_id: r.piece_id, piece: r.piece_title, placement: r.placement, published_at: r.published_at, url: r.url, visibility: r.visibility },
      snapshots: mine.map(snapshotView),
      latest: latest ? { age: latest.age, taken_at: latest.taken_at, metrics: latest.metrics } : null,
    };
  });
  // Totals per network of the latest reading of each post: how a network did, never how "social" did.
  const byNetwork: Record<string, { network: string; posts: number; read: number; totals: CommonMetrics }> = {};
  for (const r of rows) {
    const n = (byNetwork[r.publication.network] ??= { network: r.publication.network, posts: 0, read: 0, totals: {} });
    n.posts++;
    if (r.latest) {
      n.read++;
      for (const [k, v] of Object.entries(r.latest.metrics as CommonMetrics)) {
        if (k === 'avgWatchSeconds') continue; // an average is not added up
        (n.totals as Record<string, number>)[k] = ((n.totals as Record<string, number>)[k] ?? 0) + (v as number);
      }
    }
  }
  return { from, to, rows, networks: Object.values(byNetwork) };
}
