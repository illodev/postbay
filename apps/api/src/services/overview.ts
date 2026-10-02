import { DateTime } from 'luxon';
import { authorize, type Principal } from '../auth/principal.js';
import type { Ctx } from '../context.js';
import { can, type Role } from '../domain/roles.js';
import { forbidden } from '../errors.js';
import { loadBrand } from './loaders.js';

/**
 * "For you": the first screen. What waits for this person's decision, what goes out today, what is broken and needs a hand,
 * and what has just happened in the brand. Everyone who can see the brand gets it; what they can do about each thing follows
 * their role (a reader sees it all and is offered nothing to do).
 */

/** A person's name as lists show it: their name, else the part of the email before the @, else the token's name. */
const WHO = (u: string, t: string) => `coalesce(nullif(trim(${u}.name), ''), split_part(${u}.email, '@', 1), ${t}.name)`;

export type AwaitingMode = 'approve' | 'comment' | 'view';

export interface AwaitingItem {
  version_id: string;
  version_number: number;
  variant_id: string;
  variant_format: string;
  piece_id: string;
  piece_title: string;
  piece_kind: string;
  created_at: string;
  by_agent: boolean;
  author: string | null;
  /** Open threads across the variant (on this version and carried from earlier ones): what has to be settled before approving. */
  open_comments: number;
  /** Threads from earlier versions this version says it fixes… */
  resolves: number;
  /** …out of the ones that were still open when it arrived. */
  earlier_comments: number;
  thumb: string;
}

export interface TodayItem {
  id: string;
  scheduled_at: string;
  /** HH:mm in the brand's zone. */
  time: string;
  status: string;
  manual: boolean;
  /** A manual publication whose hour has come: it is in the publish-by-hand queue now. */
  due: boolean;
  placement: string | null;
  url: string | null;
  network: string;
  account_name: string;
  piece_id: string;
  piece_title: string;
  piece_kind: string;
  version_id: string;
  version_number: number;
  thumb: string;
}

export type AttentionKind =
  | 'publication_failed'
  | 'publication_on_hold'
  | 'publication_awaiting_confirmation'
  | 'account_reconnect'
  | 'webhook_failing'
  | 'agent_needs_person';

export type AttentionAction =
  | { type: 'retry'; publication_id: string }
  | { type: 'confirm'; publication_id: string }
  | { type: 'review'; to: string }
  | { type: 'open'; to: string }
  | { type: 'reconnect'; to: string }
  | { type: 'webhooks'; to: string };

export interface AttentionItem {
  kind: AttentionKind;
  id: string;
  at: string;
  /** A code the interface words itself: an error class, a block reason, why a publication is held. */
  reason: string | null;
  /** What the server or the network said, as it said it. */
  detail: string | null;
  piece_id: string | null;
  piece_title: string | null;
  version_id: string | null;
  network: string | null;
  account_name: string | null;
  /** For a publication: when it was to go out. */
  scheduled_at: string | null;
  thumb: string | null;
  /** What to do about it, or null when this person cannot do anything here. */
  action: AttentionAction | null;
}

export type ActivityKind = 'comment' | 'version' | 'approved' | 'rejected' | 'changes_requested' | 'published' | 'agent_handed';

export interface ActivityItem {
  kind: ActivityKind;
  id: string;
  at: string;
  /** Who did it: a person's name, the token's name for the agent, or null for the studio itself (an automatic publication). */
  actor: string | null;
  by_agent: boolean;
  piece_id: string | null;
  piece_title: string | null;
  version_id: string | null;
  version_number: number | null;
  /** The first line of a comment or note, or what the agent said when it handed a piece back. */
  text: string | null;
  /** A comment on a moment: where it starts and ends, in seconds. */
  t: number | null;
  t_end: number | null;
  /** A comment on a region: which page. */
  page: number | null;
  /** Approved for, or published on. */
  networks: string[];
  account_name: string | null;
  /** A new version: how many earlier threads it resolves. */
  resolves: number | null;
}

export interface Overview {
  role: Role;
  timezone: string;
  now: string;
  awaiting_mode: AwaitingMode;
  awaiting: AwaitingItem[];
  today: TodayItem[];
  attention: AttentionItem[];
  activity: ActivityItem[];
}

const thumbOf = (versionId: string, w = 240) => `/api/versions/${versionId}/thumb?w=${w}`;
const iso = (d: Date | string | null) => (d === null ? null : new Date(d).toISOString());

export async function brandOverview(ctx: Ctx, p: Principal, brandId: string): Promise<Overview> {
  if (p.kind !== 'user') throw forbidden('This is only available to signed-in people');
  const role = await authorize(ctx.db, p, brandId, 'brand.view');
  const brand = await loadBrand(ctx.db, brandId);
  const zone = brand.timezone as string;
  const now = ctx.now();
  const mode: AwaitingMode = can(role, 'version.approve') ? 'approve' : can(role, 'comment.create') ? 'comment' : 'view';

  const [awaiting, today, attention, activity] = await Promise.all([
    awaitingFor(ctx, brandId, p.userId, mode),
    todayIn(ctx, brandId, zone, now),
    attentionFor(ctx, brandId, p.userId, role),
    recentActivity(ctx, brandId),
  ]);
  return { role, timezone: zone, now: now.toISOString(), awaiting_mode: mode, awaiting, today, attention, activity };
}

/**
 * Versions in review. For someone who approves, the ones waiting for their own decision: not their own uploads (they cannot approve
 * those) and not the ones they have already approved (a brand that needs two approvals keeps a version in review after the first).
 * For anyone else, every version in review, which a reviewer can comment on and a reader can look at.
 */
async function awaitingFor(ctx: Ctx, brandId: string, userId: string, mode: AwaitingMode): Promise<AwaitingItem[]> {
  const rows = await ctx.db.query(
    `select ver.id as version_id, ver.number as version_number, ver.created_at, (ver.author_token_id is not null) as by_agent,
       ${WHO('u', 't')} as author, v.id as variant_id, v.format as variant_format, p.id as piece_id, p.title as piece_title, p.kind as piece_kind,
       (select count(*)::int from comment c join version cv on cv.id = c.version_id
         where cv.variant_id = v.id and c.parent_id is null and c.status = 'open') as open_comments,
       (select count(*)::int from comment c where c.resolved_in_version_id = ver.id and c.parent_id is null) as resolves,
       (select count(*)::int from comment c join version cv on cv.id = c.version_id
         where cv.variant_id = v.id and cv.number < ver.number and c.parent_id is null
           and (c.status = 'open' or c.resolved_in_version_id = ver.id)) as earlier_comments
     from version ver
     join variant v on v.id = ver.variant_id
     join piece p on p.id = v.piece_id
     left join app_user u on u.id = ver.author_user_id
     left join api_token t on t.id = ver.author_token_id
     where p.brand_id = $1 and p.discarded_at is null and ver.review_state = 'in_review'
       and (not $2::boolean or (ver.author_user_id is distinct from $3
         and not exists (select 1 from approval a where a.version_id = ver.id and a.approver_user_id = $3)))
     order by ver.created_at desc, ver.id
     limit 60`,
    [brandId, mode === 'approve', userId],
  );
  return rows.map((r) => ({
    version_id: r.version_id, version_number: r.version_number, variant_id: r.variant_id, variant_format: r.variant_format,
    piece_id: r.piece_id, piece_title: r.piece_title, piece_kind: r.piece_kind, created_at: iso(r.created_at)!, by_agent: r.by_agent,
    author: r.author, open_comments: r.open_comments, resolves: r.resolves, earlier_comments: r.earlier_comments, thumb: thumbOf(r.version_id),
  }));
}

/** What goes out today, from midnight to midnight in the brand's zone: by the studio or by hand, already out or still to go. */
async function todayIn(ctx: Ctx, brandId: string, zone: string, now: Date): Promise<TodayItem[]> {
  const start = DateTime.fromJSDate(now, { zone }).startOf('day');
  const end = start.plus({ days: 1 });
  const rows = await ctx.db.query(
    `select pub.id, pub.scheduled_at, pub.status, pub.manual, pub.placement, pub.url, sa.network, sa.display_name as account_name,
       p.id as piece_id, p.title as piece_title, p.kind as piece_kind, pub.version_id, ver.number as version_number
     from publication pub
     join variant v on v.id = pub.variant_id join piece p on p.id = v.piece_id
     join social_account sa on sa.id = pub.social_account_id join version ver on ver.id = pub.version_id
     where p.brand_id = $1 and pub.status <> 'cancelled' and pub.scheduled_at >= $2 and pub.scheduled_at < $3
     order by pub.scheduled_at, pub.id`,
    [brandId, start.toJSDate(), end.toJSDate()],
  );
  return rows.map((r) => ({
    id: r.id, scheduled_at: iso(r.scheduled_at)!, time: DateTime.fromJSDate(new Date(r.scheduled_at), { zone }).toFormat('HH:mm'),
    status: r.status, manual: r.manual, due: r.manual && r.status === 'scheduled' && new Date(r.scheduled_at).getTime() <= now.getTime(),
    placement: r.placement, url: r.url, network: r.network, account_name: r.account_name, piece_id: r.piece_id, piece_title: r.piece_title,
    piece_kind: r.piece_kind, version_id: r.version_id, version_number: r.version_number, thumb: thumbOf(r.version_id),
  }));
}

/** Things that stopped and wait for a person, each with what this person can do about it. */
async function attentionFor(ctx: Ctx, brandId: string, userId: string, role: Role): Promise<AttentionItem[]> {
  const schedule = can(role, 'publication.schedule');
  const manage = can(role, 'brand.manage');
  const acts = role !== 'reader';
  const out: AttentionItem[] = [];

  const pubs = await ctx.db.query(
    `select pub.id, pub.status, pub.manual, pub.scheduled_at, pub.failed_at, pub.updated_at, pub.last_error, pub.last_error_class, pub.hold_reason,
       pub.moved_by, sa.network, sa.display_name as account_name, p.id as piece_id, p.title as piece_title, pub.version_id,
       latest.id as latest_version_id, latest.review_state as latest_state
     from publication pub
     join variant v on v.id = pub.variant_id join piece p on p.id = v.piece_id
     join social_account sa on sa.id = pub.social_account_id
     left join lateral (select id, review_state from version where variant_id = pub.variant_id order by number desc limit 1) latest on true
     where p.brand_id = $1 and pub.status in ('failed','on_hold','awaiting_reapproval')
     order by coalesce(pub.failed_at, pub.updated_at) desc
     limit 30`,
    [brandId],
  );
  for (const r of pubs) {
    const base = {
      id: r.id, piece_id: r.piece_id, piece_title: r.piece_title, network: r.network, account_name: r.account_name,
      scheduled_at: iso(r.scheduled_at), thumb: thumbOf(r.version_id),
    };
    const openPiece = acts ? ({ type: 'open', to: `/pieces/${r.piece_id}` } as const) : null;
    if (r.status === 'failed') {
      out.push({
        ...base, kind: 'publication_failed', at: iso(r.failed_at ?? r.updated_at)!, reason: r.last_error_class, detail: r.last_error, version_id: r.version_id,
        action: schedule && !r.manual ? { type: 'retry', publication_id: r.id } : openPiece,
      });
    } else if (r.status === 'on_hold') {
      // Held because a newer version is waiting: deciding on that version is what lets it go.
      const newer = r.latest_version_id !== r.version_id && r.latest_state === 'in_review';
      out.push({
        ...base, kind: 'publication_on_hold', at: iso(r.updated_at)!, reason: newer ? 'new_version' : 'held', detail: r.hold_reason,
        version_id: newer ? r.latest_version_id : r.version_id,
        action: newer && acts ? { type: 'review', to: `/review/${r.latest_version_id}` } : openPiece,
      });
    } else {
      // A moved date that someone other than whoever moved it has to confirm.
      const mine = r.moved_by === userId;
      out.push({
        ...base, kind: 'publication_awaiting_confirmation', at: iso(r.updated_at)!, reason: mine ? 'moved_by_you' : 'moved', detail: null, version_id: r.version_id,
        action: schedule && !mine ? { type: 'confirm', publication_id: r.id } : openPiece,
      });
    }
  }

  const accounts = await ctx.db.query(
    `select id, network, display_name, last_error, coalesce(last_health_at, connected_at, created_at) as at
     from social_account where brand_id = $1 and status = 'reconnect_required' order by display_name`,
    [brandId],
  );
  for (const a of accounts) {
    out.push({
      kind: 'account_reconnect', id: a.id, at: iso(a.at)!, reason: null, detail: a.last_error, piece_id: null, piece_title: null, version_id: null,
      network: a.network, account_name: a.display_name, scheduled_at: null, thumb: null,
      action: manage ? { type: 'reconnect', to: '/settings?tab=accounts' } : null,
    });
  }

  // Webhooks are the admin's: only they see them, so only they are told about them.
  if (manage) {
    const hooks = await ctx.db.query(
      `select w.id, w.url, w.active, w.disabled_reason, w.last_failure_at, w.created_at,
         (select count(*)::int from webhook_delivery d where d.webhook_id = w.id and d.status = 'failed' and d.created_at > $2::timestamptz - interval '24 hours') as failed_24h,
         (select d.last_error from webhook_delivery d where d.webhook_id = w.id and d.status = 'failed' order by d.created_at desc limit 1) as last_error
       from webhook w where w.brand_id = $1`,
      [brandId, ctx.now()],
    );
    for (const w of hooks) {
      const failing = (w.active && w.failed_24h > 0) || (!w.active && w.disabled_reason);
      if (!failing) continue;
      out.push({
        kind: 'webhook_failing', id: w.id, at: iso(w.last_failure_at ?? w.created_at)!, reason: w.active ? 'failing' : 'disabled',
        detail: w.active ? w.last_error : w.disabled_reason, piece_id: null, piece_title: w.url, version_id: null, network: null, account_name: null,
        scheduled_at: null, thumb: null, action: { type: 'webhooks', to: '/settings?tab=webhooks' },
      });
    }
  }

  // The agent gave a piece back (it declined, or it was not allowed to start) and no person has picked it up since.
  const handed = await ctx.db.query(
    `select r.id, r.outcome, r.blocked_reason, r.notes, coalesce(r.finished_at, r.started_at) as at, p.id as piece_id, p.title as piece_title,
       (select ver.id from version ver join variant v on v.id = ver.variant_id where v.piece_id = p.id order by v.created_at, ver.number desc limit 1) as version_id
     from piece p
     join lateral (select * from agent_run r where r.piece_id = p.id and r.status = 'finished' order by r.started_at desc, r.seq desc limit 1) r on true
     where p.brand_id = $1 and p.discarded_at is null and r.outcome in ('needs_people','blocked')
       and (p.agent_reset_at is null or p.agent_reset_at < r.started_at)
       and not exists (select 1 from version ver join variant v on v.id = ver.variant_id where v.piece_id = p.id and ver.created_at > r.started_at)
     order by r.started_at desc
     limit 20`,
    [brandId],
  );
  for (const h of handed) {
    out.push({
      kind: 'agent_needs_person', id: h.id, at: iso(h.at)!, reason: h.outcome === 'blocked' ? h.blocked_reason : 'agent_declined',
      detail: h.notes || null, piece_id: h.piece_id, piece_title: h.piece_title, version_id: h.version_id, network: null, account_name: null,
      scheduled_at: null, thumb: h.version_id ? thumbOf(h.version_id) : null, action: acts ? { type: 'open', to: `/pieces/${h.piece_id}` } : null,
    });
  }

  return out.sort((a, b) => b.at.localeCompare(a.at));
}

/** The latest things that happened in the brand, newest first. */
async function recentActivity(ctx: Ctx, brandId: string, limit = 20): Promise<ActivityItem[]> {
  const rows = await ctx.db.query(
    `(select 'comment' as kind, c.id::text as id, c.created_at as at, ${WHO('u', 't')} as actor, (c.author_token_id is not null) as by_agent,
        p.id as piece_id, p.title as piece_title, ver.id as version_id, ver.number as version_number,
        left(split_part(trim(c.body), E'\\n', 1), 200) as text, c.anchor, '{}'::text[] as networks, null::text as account_name, null::int as resolves
      from comment c join version ver on ver.id = c.version_id join variant v on v.id = ver.variant_id join piece p on p.id = v.piece_id
      left join app_user u on u.id = c.author_user_id left join api_token t on t.id = c.author_token_id
      where p.brand_id = $1 and c.parent_id is null
      order by c.created_at desc limit $2)
     union all
     (select 'version', ver.id::text, ver.created_at, ${WHO('u', 't')}, (ver.author_token_id is not null),
        p.id, p.title, ver.id, ver.number, nullif(left(split_part(trim(ver.notes), E'\\n', 1), 200), ''), null, '{}'::text[], null,
        (select count(*)::int from comment c where c.resolved_in_version_id = ver.id and c.parent_id is null)
      from version ver join variant v on v.id = ver.variant_id join piece p on p.id = v.piece_id
      left join app_user u on u.id = ver.author_user_id left join api_token t on t.id = ver.author_token_id
      where p.brand_id = $1
      order by ver.created_at desc limit $2)
     union all
     (select case a.decision when 'approve' then 'approved' else 'rejected' end, a.id::text, a.created_at, ${WHO('u', 'u')}, false,
        p.id, p.title, ver.id, ver.number, nullif(left(split_part(trim(a.note), E'\\n', 1), 200), ''), null,
        array(select distinct sa.network from social_account sa where sa.id = any(a.account_ids) order by sa.network), null, null
      from approval a join version ver on ver.id = a.version_id join variant v on v.id = ver.variant_id join piece p on p.id = v.piece_id
      join app_user u on u.id = a.approver_user_id
      where p.brand_id = $1
      order by a.created_at desc limit $2)
     union all
     (select 'changes_requested', e.id::text, e.at, ${WHO('u', 't')}, (e.actor_token_id is not null),
        p.id, p.title, ver.id, ver.number, null, null, '{}'::text[], null, null
      from audit_event e join version ver on ver.id = e.entity_id join variant v on v.id = ver.variant_id join piece p on p.id = v.piece_id
      left join app_user u on u.id = e.actor_user_id left join api_token t on t.id = e.actor_token_id
      where e.brand_id = $1 and e.action = 'version.changes_requested'
      order by e.id desc limit $2)
     union all
     (select 'published', pub.id::text, coalesce(pub.published_at, pub.scheduled_at), ${WHO('u', 'u')}, false,
        p.id, p.title, ver.id, ver.number, null, null, array[sa.network], sa.display_name, null
      from publication pub join version ver on ver.id = pub.version_id join variant v on v.id = pub.variant_id join piece p on p.id = v.piece_id
      join social_account sa on sa.id = pub.social_account_id left join app_user u on u.id = pub.published_by
      where p.brand_id = $1 and pub.status = 'published'
      order by coalesce(pub.published_at, pub.scheduled_at) desc limit $2)
     union all
     (select 'agent_handed', r.id::text, coalesce(r.finished_at, r.started_at), t.name, true,
        p.id, p.title, null, null, nullif(left(split_part(trim(r.notes), E'\\n', 1), 200), ''), null, '{}'::text[], null, null
      from agent_run r join piece p on p.id = r.piece_id join api_token t on t.id = r.token_id
      where r.brand_id = $1 and r.outcome = 'needs_people'
      order by r.started_at desc limit $2)
     order by at desc
     limit $2`,
    [brandId, limit],
  );
  return rows.map((r) => {
    const anchor = r.anchor as { type?: string; t?: number; t_end?: number; page?: number } | null;
    return {
      kind: r.kind, id: r.id, at: iso(r.at)!, actor: r.actor, by_agent: r.by_agent, piece_id: r.piece_id, piece_title: r.piece_title,
      version_id: r.version_id, version_number: r.version_number, text: r.text,
      t: anchor?.type === 'time' && typeof anchor.t === 'number' ? anchor.t : null,
      t_end: anchor?.type === 'time' && typeof anchor.t_end === 'number' ? anchor.t_end : null,
      page: anchor?.type === 'region' && typeof anchor.page === 'number' ? anchor.page : null,
      networks: r.networks ?? [], account_name: r.account_name, resolves: r.resolves,
    };
  });
}
