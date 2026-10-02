import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { actorCols, authorize, type Principal } from '../auth/principal.js';
import { mediaSource, type Ctx } from '../context.js';
import type { Queryable } from '../db.js';
import { anchorSchema, type Anchor } from '../domain/anchors.js';
import { trackAt } from './subtitles.js';
import { badRequest, conflict, forbidden, notFound } from '../errors.js';
import { msg } from '../i18n/index.js';
import { audit } from './audit.js';
import { commentRef, emit } from './events.js';
import { loadBrand, loadVersion } from './loaders.js';
import { notifyUsers } from './notify.js';

const LIVE = ['in_review', 'changes_requested', 'approved'];

export const commentInput = z.object({
  body: z.string().trim().min(1).max(5000),
  anchor: anchorSchema.nullish(),
  /** For people only: something an agent must leave alone. */
  peopleOnly: z.boolean().default(false),
});
export const replyInput = z.object({
  body: z.string().trim().min(1).max(5000),
  kind: z.enum(['fixed', 'cannot_do', 'needs_human']).optional(),
});

async function loadComment(db: Queryable, id: string) {
  const row = await db.one(
    `select c.*, ver.variant_id, ver.review_state as version_state, v.piece_id, p.brand_id, p.discarded_at
     from comment c join version ver on ver.id = c.version_id join variant v on v.id = ver.variant_id join piece p on p.id = v.piece_id
     where c.id = $1`,
    [id],
  );
  if (!row) throw notFound('Comment');
  return row;
}

/** Open root comments across the whole variant: those on the current version and those carried over from earlier ones. */
export async function openCommentCount(db: Queryable, variantId: string): Promise<number> {
  const r = await db.one<{ n: number }>(
    `select count(*)::int as n from comment c join version ver on ver.id = c.version_id
     where ver.variant_id = $1 and c.parent_id is null and c.status = 'open'`,
    [variantId],
  );
  return r?.n ?? 0;
}

async function checkAnchor(ctx: Ctx, versionId: string, anchor: Anchor): Promise<{ video: { storage_key: string } | null; anchor: Anchor }> {
  const assets = await ctx.db.query<{ kind: string; position: number; duration_ms: number | null; storage_key: string }>(
    `select kind, position, duration_ms, storage_key from asset where version_id = $1 order by position, kind`,
    [versionId],
  );
  const primary = assets.filter((a) => a.kind === 'video' || a.kind === 'image');
  if (anchor.type === 'time') {
    const video = assets.find((a) => a.kind === 'video' && (anchor.position === undefined || a.position === anchor.position));
    if (!video) throw badRequest('invalid_anchor', msg('error.comment.noVideo'));
    const afterEnd = (t: number) => video.duration_ms !== null && t * 1000 > video.duration_ms + 1000;
    if (anchor.cue === undefined) {
      if (anchor.track !== undefined || anchor.cue_text !== undefined) throw badRequest('invalid_anchor', msg('error.comment.cueByNumber'));
      if (afterEnd(anchor.t)) throw badRequest('invalid_anchor', msg('error.comment.afterEnd'));
      return { video, anchor };
    }
    // A comment on a subtitle line: the line must exist in this version, and its times and words are the file's, not the sender's.
    const track = await trackAt(ctx, versionId, anchor.track ?? 0);
    if (!track) throw badRequest('invalid_anchor', msg('error.comment.noSuchSubtitles'));
    const cue = track.cues[anchor.cue];
    if (!cue) throw badRequest('invalid_anchor', msg('error.comment.noSuchCue'));
    if (afterEnd(cue.start)) throw badRequest('invalid_anchor', msg('error.comment.cueAfterEnd'));
    return {
      video,
      anchor: {
        type: 'time', t: cue.start, t_end: cue.end, position: anchor.position, track: track.position, cue: cue.index, cue_text: cue.text.slice(0, 1000),
        ...(anchor.drawing ? { drawing: anchor.drawing } : {}),
      },
    };
  }
  const hasPdf = assets.some((a) => a.kind === 'pdf');
  if (!hasPdf && anchor.page > primary.length) throw badRequest('invalid_anchor', msg('error.comment.pages', { count: primary.length }));
  if (!hasPdf && primary.length === 0) throw badRequest('invalid_anchor', msg('error.comment.noPages'));
  return { video: null, anchor };
}

export async function createComment(ctx: Ctx, p: Principal, versionId: string, raw: unknown) {
  const input = commentInput.parse(raw);
  const version = await loadVersion(ctx.db, versionId);
  await authorize(ctx.db, p, version.brand_id, 'comment.create');
  if (!LIVE.includes(version.review_state)) throw conflict('version_closed', msg('error.comment.versionClosed'));
  const checked = input.anchor ? await checkAnchor(ctx, versionId, input.anchor) : null;
  const anchor = checked?.anchor ?? null;
  const video = checked?.video ?? null;

  // Commenting on a moment also stores the frame: it is what the agent receives later.
  const id = randomUUID();
  let frameKey: string | null = null;
  if (anchor?.type === 'time' && video) {
    const jpg = await ctx.media.frame(await mediaSource(ctx, video.storage_key), anchor.t);
    if (jpg) {
      frameKey = `brands/${version.brand_id}/comments/${id}.jpg`;
      await ctx.storage.put(frameKey, jpg, 'image/jpeg');
    } else {
      ctx.log.warn({ commentId: id }, 'comment without frame');
    }
  }

  const a = actorCols(p);
  return ctx.db.tx(async (db) => {
    const row = (await db.one(
      `insert into comment (id, version_id, author_user_id, author_token_id, body, anchor, frame_key, people_only)
       values ($1,$2,$3,$4,$5,$6,$7,$8) returning *`,
      [id, versionId, a.user, a.token, input.body, anchor ? JSON.stringify(anchor) : null, frameKey, input.peopleOnly],
    ))!;
    const piece = await db.one('select created_by_user from piece where id = $1', [version.piece_id]);
    await audit(db, p, version.brand_id, 'comment.created', 'comment', id, null, { version_id: versionId, anchor });
    await notifyUsers(db, version.brand_id, [version.author_user_id, piece?.created_by_user], 'comment.created',
      { versionId, pieceId: version.piece_id, commentId: id }, a.user);
    await emitComment(ctx, db, version.brand_id, id);
    return row;
  });
}

export async function replyToComment(ctx: Ctx, p: Principal, commentId: string, raw: unknown) {
  const input = replyInput.parse(raw);
  const parent = await loadComment(ctx.db, commentId);
  await authorize(ctx.db, p, parent.brand_id, 'comment.reply');
  if (parent.parent_id) throw badRequest('invalid_reply', msg('error.comment.replyToThread'));
  if (parent.discarded_at) throw conflict('piece_discarded', msg('error.pieceDiscarded'));
  if (parent.people_only && p.kind === 'token') throw forbidden(msg('error.comment.peopleOnly'));
  const a = actorCols(p);
  return ctx.db.tx(async (db) => {
    const row = (await db.one(
      `insert into comment (version_id, parent_id, author_user_id, author_token_id, body, reply_kind)
       values ($1,$2,$3,$4,$5,$6) returning *`,
      [parent.version_id, commentId, a.user, a.token, input.body, input.kind ?? null],
    ))!;
    await audit(db, p, parent.brand_id, 'comment.replied', 'comment', row.id, null, { parent_id: commentId, kind: input.kind ?? null });
    await notifyUsers(db, parent.brand_id, [parent.author_user_id], 'comment.created',
      { versionId: parent.version_id, pieceId: parent.piece_id, commentId: row.id, replyKind: input.kind ?? null }, a.user);
    await emitComment(ctx, db, parent.brand_id, row.id);
    return row;
  });
}

export async function resolveComment(ctx: Ctx, p: Principal, commentId: string) {
  return ctx.db.tx(async (db) => {
    const c = await loadComment(db, commentId);
    await authorize(db, p, c.brand_id, 'comment.resolve');
    if (c.parent_id) throw badRequest('invalid_comment', msg('error.comment.resolveThread'));
    if (c.people_only && p.kind === 'token') throw forbidden(msg('error.comment.peopleOnly'));
    if (c.status === 'resolved') return c;
    const a = actorCols(p);
    const row = (await db.one(
      `update comment set status = 'resolved', resolved_by_user_id = $2, resolved_at = now() where id = $1 returning *`,
      [commentId, a.user],
    ))!;
    await audit(db, p, c.brand_id, 'comment.resolved', 'comment', commentId, { status: 'open' }, { status: 'resolved' });
    return row;
  });
}

export async function reopenComment(ctx: Ctx, p: Principal, commentId: string) {
  return ctx.db.tx(async (db) => {
    const c = await loadComment(db, commentId);
    await authorize(db, p, c.brand_id, 'comment.create');
    if (c.parent_id) throw badRequest('invalid_comment', msg('error.comment.reopenThread'));
    if (c.status === 'open') return c;
    const row = (await db.one(
      `update comment set status = 'open', resolved_by_user_id = null, resolved_at = null, resolved_in_version_id = null
       where id = $1 returning *`,
      [commentId],
    ))!;
    await audit(db, p, c.brand_id, 'comment.reopened', 'comment', commentId, { status: 'resolved' }, { status: 'open' });
    return row;
  });
}

/** Marks a thread as for people only, or hands it back: reviewers and above, never an agent. */
export async function setPeopleOnly(ctx: Ctx, p: Principal, commentId: string, value: unknown) {
  const flag = z.boolean().parse(value);
  return ctx.db.tx(async (db) => {
    const c = await loadComment(db, commentId);
    await authorize(db, p, c.brand_id, 'comment.create');
    if (c.parent_id) throw badRequest('invalid_comment', msg('error.comment.markThread'));
    if (c.people_only === flag) return c;
    const row = (await db.one('update comment set people_only = $2 where id = $1 returning *', [commentId, flag]))!;
    await audit(db, p, c.brand_id, flag ? 'comment.people_only' : 'comment.agent_allowed', 'comment', commentId, { people_only: c.people_only }, { people_only: flag });
    return row;
  });
}

/** Announces a comment or reply to the webhooks. */
async function emitComment(ctx: Ctx, db: Queryable, brandId: string, commentId: string) {
  const ref = await commentRef(db, commentId);
  if (ref) await emit(ctx, db, brandId, 'comment.created', ref);
}

/**
 * Threads of a version. With `carried`, threads from earlier versions of the variant are added when they are still
 * open (what the producer must see before uploading, and what blocks approval) or were resolved by this very version
 * ("resolved in v2"), which is what a reviewer wants to check when comparing versions.
 */
export async function listComments(ctx: Ctx, p: Principal, versionId: string, f: { status?: 'open' | 'resolved'; carried?: boolean }) {
  const version = await loadVersion(ctx.db, versionId);
  await authorize(ctx.db, p, version.brand_id, 'brand.view');
  const roots = await ctx.db.query(
    `select c.*, coalesce(u.name, u.email, t.name) as author, ver.number as version_number,
       (c.version_id <> $1) as carried, rv.number as resolved_in_number,
       coalesce(ru.name, ru.email) as resolved_by
     from comment c
     join version ver on ver.id = c.version_id
     left join app_user u on u.id = c.author_user_id
     left join api_token t on t.id = c.author_token_id
     left join version rv on rv.id = c.resolved_in_version_id
     left join app_user ru on ru.id = c.resolved_by_user_id
     where c.parent_id is null and ver.variant_id = $2
       and (c.version_id = $1 or ($3::boolean and ver.number < $4 and (c.status = 'open' or c.resolved_in_version_id = $1)))
       and ($5::text is null or c.status = $5)
     order by c.created_at`,
    [versionId, version.variant_id, f.carried ?? false, version.number, f.status ?? null],
  );
  const ids = roots.map((r) => r.id);
  const replies = ids.length
    ? await ctx.db.query(
        `select c.id, c.parent_id, c.body, c.reply_kind, c.created_at, coalesce(u.name, u.email, t.name) as author,
           (c.author_token_id is not null) as by_agent
         from comment c left join app_user u on u.id = c.author_user_id left join api_token t on t.id = c.author_token_id
         where c.parent_id = any($1) order by c.created_at`,
        [ids],
      )
    : [];
  const out = [];
  for (const r of roots) {
    out.push({
      id: r.id, version_id: r.version_id, version_number: r.version_number, body: r.body, anchor: r.anchor,
      status: r.status, author: r.author, created_at: r.created_at, carried: r.carried, people_only: r.people_only,
      resolved_in_number: r.resolved_in_number, resolved_by: r.resolved_by,
      frame_url: r.frame_key ? await ctx.storage.presignGet(r.frame_key, { expiresSec: 3600 }) : null,
      replies: replies.filter((x) => x.parent_id === r.id),
    });
  }
  return out;
}

export { forbidden, loadBrand };
