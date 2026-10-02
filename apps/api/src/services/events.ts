import { actorCols, type Principal } from '../auth/principal.js';
import type { Ctx } from '../context.js';
import type { Queryable } from '../db.js';

/** What a webhook can subscribe to. The contract with whoever produces: see docs/phase-3.md. */
export const EVENT_TYPES = [
  'version.changes_requested',
  'version.approved',
  'version.rejected',
  'comment.created',
  'slot.needs_content',
  'publication.published',
  'publication.failed',
] as const;
export type EventType = (typeof EVENT_TYPES)[number];

export const EVENT_DESCRIPTIONS: Record<EventType, string> = {
  'version.changes_requested': 'Changes were requested on a version: the open comments with their anchors and frames. This is what starts an agent.',
  'version.approved': 'A version was approved, with the accounts it was approved for.',
  'version.rejected': 'A version was rejected, with the reason.',
  'comment.created': 'Someone commented on a version or replied to a comment.',
  'slot.needs_content': 'A calendar slot is still empty a few days before its date, with the campaign brief.',
  'publication.published': 'A post went out (by the app or by a person).',
  'publication.failed': 'A post could not be published.',
};

export interface Actor {
  kind: 'user' | 'token';
  name: string;
  /** A person acting through an AI assistant (MCP): the assistant's name. */
  via?: string;
}

/**
 * Writes an event and one delivery per active webhook that subscribed to it, in the caller's transaction: the event exists
 * exactly when the change it describes does. `only` sends it to a single webhook (the test button).
 */
export async function emit(
  ctx: Ctx,
  db: Queryable,
  brandId: string,
  type: EventType | 'ping',
  data: Record<string, unknown>,
  only?: { webhookId: string },
): Promise<string> {
  const now = ctx.now();
  const ev = (await db.one<{ id: string }>('insert into event (brand_id, type, data, created_at) values ($1,$2,$3,$4) returning id', [
    brandId, type, JSON.stringify(data), now,
  ]))!;
  await db.query(
    `insert into webhook_delivery (webhook_id, event_id, next_attempt_at, expires_at)
     select w.id, $1, $2::timestamptz, $2::timestamptz + interval '24 hours' from webhook w
     where w.brand_id = $3 and (w.id = $4 or ($4::uuid is null and w.active and $5 = any(w.events)))`,
    [ev.id, now, brandId, only?.webhookId ?? null, type],
  );
  return ev.id;
}

// ───────────────────────────── what events say ─────────────────────────────

export async function actorOf(db: Queryable, p: Principal | null): Promise<Actor | null> {
  if (!p) return null;
  const a = actorCols(p);
  if (a.user) {
    const u = await db.one<{ name: string }>('select coalesce(name, email) as name from app_user where id = $1', [a.user]);
    return { kind: 'user', name: u?.name ?? 'Someone', ...(p.kind === 'user' && p.via ? { via: p.via.clientName } : {}) };
  }
  const t = await db.one<{ name: string }>('select name from api_token where id = $1', [a.token]);
  return { kind: 'token', name: t?.name ?? 'A producer token' };
}

export async function pieceRef(db: Queryable, pieceId: string) {
  const p = await db.one(
    'select id, title, kind, brief, target_date, ai_generated, campaign_id, source, slot_id, slot_at from piece where id = $1',
    [pieceId],
  );
  return p && {
    id: p.id, title: p.title, kind: p.kind, brief: p.brief, target_date: p.target_date, ai_generated: p.ai_generated, campaign_id: p.campaign_id, source: p.source,
    // The slot occurrence it was made for, or null.
    slot: p.slot_at ? { id: p.slot_id, at: new Date(p.slot_at).toISOString() } : null,
  };
}

export async function versionRef(db: Queryable, versionId: string) {
  const v = await db.one(
    `select ver.id, ver.number, ver.fingerprint, ver.review_state, ver.created_at, ver.notes, v.id as variant_id, v.format, v.style,
       coalesce(u.name, u.email, t.name) as author, (ver.author_token_id is not null) as by_token, coalesce(cu.name, cu.email) as token_created_by
     from version ver join variant v on v.id = ver.variant_id
     left join app_user u on u.id = ver.author_user_id left join api_token t on t.id = ver.author_token_id
     left join app_user cu on cu.id = t.created_by
     where ver.id = $1`,
    [versionId],
  );
  return v && {
    id: v.id, number: v.number, fingerprint: v.fingerprint, review_state: v.review_state, created_at: v.created_at, notes: v.notes,
    variant: { id: v.variant_id, format: v.format, style: v.style },
    // A token's upload names the person who made the token too: they are not its author, but someone deciding may want to know.
    author: v.by_token ? { kind: 'token', name: v.author, created_by: v.token_created_by } : { kind: 'user', name: v.author },
  };
}

/**
 * The open threads of a variant as the agent needs them: what was said, where it points, the frame behind it (as a key:
 * the URL is made when the event is delivered, so it is still valid on the last retry) and whether it is for people only.
 */
export async function openComments(db: Queryable, variantId: string) {
  const roots = await db.query(
    `select c.id, c.version_id, ver.number as version_number, c.body, c.anchor, c.frame_key, c.people_only, c.created_at,
       coalesce(u.name, u.email, t.name) as author, (c.author_token_id is not null) as by_token
     from comment c join version ver on ver.id = c.version_id
     left join app_user u on u.id = c.author_user_id left join api_token t on t.id = c.author_token_id
     where c.parent_id is null and c.status = 'open' and ver.variant_id = $1
     order by c.created_at`,
    [variantId],
  );
  const ids = roots.map((r) => r.id);
  const replies = ids.length
    ? await db.query(
        `select c.parent_id, c.body, c.reply_kind, c.created_at, coalesce(u.name, u.email, t.name) as author, (c.author_token_id is not null) as by_token
         from comment c left join app_user u on u.id = c.author_user_id left join api_token t on t.id = c.author_token_id
         where c.parent_id = any($1) order by c.created_at`,
        [ids],
      )
    : [];
  return roots.map((r) => ({
    id: r.id, version_id: r.version_id, version_number: r.version_number, body: r.body, anchor: r.anchor, frame_key: r.frame_key,
    people_only: r.people_only, created_at: r.created_at, author: { kind: r.by_token ? 'token' : 'user', name: r.author },
    replies: replies.filter((x) => x.parent_id === r.id).map((x) => ({
      body: x.body, kind: x.reply_kind, created_at: x.created_at, author: { kind: x.by_token ? 'token' : 'user', name: x.author },
    })),
  }));
}

export async function accountRef(db: Queryable, accountId: string) {
  const a = await db.one('select id, network, display_name from social_account where id = $1', [accountId]);
  return a && { id: a.id, network: a.network, display_name: a.display_name };
}

// ───────────────────────────── at delivery ─────────────────────────────

/**
 * What goes out: a stored frame key becomes a signed URL, valid for an hour from this attempt. Anything else is sent as it
 * was stored.
 */
export async function materialize(ctx: Ctx, value: unknown): Promise<unknown> {
  if (Array.isArray(value)) return Promise.all(value.map((v) => materialize(ctx, v)));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (k === 'frame_key') {
        out.frame_url = typeof v === 'string' ? await ctx.storage.presignGet(v, { expiresSec: 3600 }) : null;
      } else {
        out[k] = await materialize(ctx, v);
      }
    }
    return out;
  }
  return value;
}

// ───────────────────────────── per-event builders ─────────────────────────────

/** A comment or reply as an event describes it. */
export async function commentRef(db: Queryable, commentId: string) {
  const c = await db.one(
    `select c.id, c.parent_id, c.body, c.anchor, c.frame_key, c.people_only, c.reply_kind, c.created_at, c.version_id, ver.number as version_number,
       v.piece_id, coalesce(u.name, u.email, t.name) as author, (c.author_token_id is not null) as by_token
     from comment c join version ver on ver.id = c.version_id join variant v on v.id = ver.variant_id
     left join app_user u on u.id = c.author_user_id left join api_token t on t.id = c.author_token_id
     where c.id = $1`,
    [commentId],
  );
  if (!c) return null;
  return {
    piece: await pieceRef(db, c.piece_id),
    version: { id: c.version_id, number: c.version_number },
    comment: {
      id: c.id, parent_id: c.parent_id, body: c.body, anchor: c.anchor, frame_key: c.frame_key, people_only: c.people_only,
      reply_kind: c.reply_kind, created_at: c.created_at, author: { kind: c.by_token ? 'token' : 'user', name: c.author },
    },
  };
}

/** A publication as an event describes it. */
export async function publicationRef(db: Queryable, publicationId: string) {
  const p = await db.one(
    `select pub.id, pub.scheduled_at, pub.published_at, pub.url, pub.manual, pub.status, pub.placement, pub.text, pub.version_id, v.piece_id,
       ver.number as version_number, sa.id as account_id, sa.network, sa.display_name
     from publication pub join variant v on v.id = pub.variant_id join version ver on ver.id = pub.version_id
     join social_account sa on sa.id = pub.social_account_id where pub.id = $1`,
    [publicationId],
  );
  if (!p) return null;
  return {
    piece: await pieceRef(db, p.piece_id),
    version: { id: p.version_id, number: p.version_number },
    publication: {
      id: p.id, status: p.status, scheduled_at: p.scheduled_at, published_at: p.published_at, url: p.url, manual: p.manual, placement: p.placement,
      account: { id: p.account_id, network: p.network, display_name: p.display_name },
    },
  };
}

export async function emitPublication(ctx: Ctx, db: Queryable, brandId: string, publicationId: string, type: 'publication.published' | 'publication.failed', extra: Record<string, unknown> = {}) {
  const ref = await publicationRef(db, publicationId);
  if (ref) await emit(ctx, db, brandId, type, { ...ref, ...extra });
}
