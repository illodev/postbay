import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { actorCols, authorize, type Principal } from '../auth/principal.js';
import { mediaSource, type Ctx } from '../context.js';
import type { Queryable } from '../db.js';
import { fingerprintOf } from '../domain/fingerprint.js';
import type { ProbeResult } from '../media/ffmpeg.js';
import { badRequest, conflict, forbidden } from '../errors.js';
import { audit } from './audit.js';
import { loadVariant, loadVersion } from './loaders.js';
import { notifyRoles } from './notify.js';
import { refreshPieceState } from './pieces.js';
import { probeMeta } from './renditions.js';
import { CHUNK_BYTES, RESUME_TTL_SEC } from './resumable.js';

const MAX_BYTES = 4 * 1024 ** 3;
const UPLOAD_TTL_SEC = 3600;

export const ASSET_KINDS = ['video', 'image', 'pdf', 'subtitles', 'cover'] as const;
type AssetKind = (typeof ASSET_KINDS)[number];

const MIME_OK: Record<AssetKind, RegExp> = {
  video: /^video\/(mp4|quicktime|webm|x-matroska)$/,
  image: /^image\/(jpeg|png|webp|gif)$/,
  pdf: /^application\/pdf$/,
  subtitles: /^(text\/vtt|text\/plain|application\/x-subrip)$/,
  cover: /^image\/(jpeg|png|webp)$/,
};

export const uploadsInput = z.object({
  files: z
    .array(
      z.object({
        name: z.string().trim().min(1).max(200),
        mime: z.string().min(3).max(100),
        bytes: z.number().int().positive().max(MAX_BYTES),
        sha256: z.string().regex(/^[0-9a-fA-F]{64}$/).transform((s) => s.toLowerCase()),
        /** Send the file in pieces through the app (see services/resumable.ts) instead of one request straight to storage. */
        resumable: z.boolean().default(false),
      }),
    )
    .min(1)
    .max(30),
});

export const closeInput = z.object({
  files: z
    .array(
      z.object({
        uploadId: z.string().uuid(),
        kind: z.enum(ASSET_KINDS),
        position: z.number().int().min(0).max(100).default(0),
      }),
    )
    .min(1)
    .max(30),
  notes: z.string().max(5000).default(''),
  resolves: z.array(z.string().uuid()).max(200).default([]),
});

const safeName = (n: string) => n.replace(/[^A-Za-z0-9._-]+/g, '_').slice(-100) || 'file';

/**
 * The producer declares each file with its hash and gets a signed URL to upload it straight to storage. A file declared `resumable`
 * is sent in pieces through the app instead; if the same person already began (or finished) sending that very file to this variant, the
 * answer is that upload, with how much of it has arrived, so choosing the file again carries on where it stopped.
 */
export async function requestUploads(ctx: Ctx, p: Principal, variantId: string, raw: unknown) {
  const input = uploadsInput.parse(raw);
  const variant = await loadVariant(ctx.db, variantId);
  await authorize(ctx.db, p, variant.brand_id, 'version.upload');
  if (variant.piece_discarded) throw conflict('piece_discarded', 'The piece is discarded');
  const a = actorCols(p);
  const out = [];
  for (const f of input.files) {
    if (f.resumable) {
      const again = await ctx.db.one<{ id: string; received_bytes: string; completed_at: Date | null }>(
        `update upload set expires_at = now() + make_interval(secs => $8)
         where id = (select id from upload where variant_id = $1 and resumable and consumed_at is null and expires_at > now()
                       and sha256 = $2 and bytes = $3 and name = $4 and mime = $5
                       and created_by_user is not distinct from $6 and created_by_token is not distinct from $7
                     order by created_at desc limit 1)
         returning id, received_bytes, completed_at`,
        [variantId, f.sha256, f.bytes, f.name, f.mime, a.user, a.token, RESUME_TTL_SEC],
      );
      if (again) {
        out.push({ uploadId: again.id, name: f.name, resumable: { offset: Number(again.received_bytes), bytes: f.bytes, complete: !!again.completed_at, chunkSize: CHUNK_BYTES } });
        continue;
      }
    }
    const id = randomUUID();
    const key = `brands/${variant.brand_id}/pieces/${variant.piece_id}/${id}/${safeName(f.name)}`;
    await ctx.db.query(
      `insert into upload (id, brand_id, variant_id, created_by_user, created_by_token, storage_key, name, mime, bytes, sha256, resumable, expires_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11, now() + make_interval(secs => $12))`,
      [id, variant.brand_id, variantId, a.user, a.token, key, f.name, f.mime, f.bytes, f.sha256, f.resumable, f.resumable ? RESUME_TTL_SEC : UPLOAD_TTL_SEC],
    );
    if (f.resumable) {
      out.push({ uploadId: id, name: f.name, resumable: { offset: 0, bytes: f.bytes, complete: false, chunkSize: CHUNK_BYTES } });
      continue;
    }
    const put = await ctx.storage.presignPut(key, { mime: f.mime, bytes: f.bytes, sha256: f.sha256, expiresSec: UPLOAD_TTL_SEC });
    out.push({ uploadId: id, name: f.name, ...put });
  }
  return out;
}

interface Resolved {
  upload: { id: string; storage_key: string; name: string; mime: string; bytes: number; sha256: string };
  kind: AssetKind;
  position: number;
  meta: ProbeResult;
}

/** Which files each variant format accepts. */
export function checkComposition(format: string, files: { kind: AssetKind; position: number }[]) {
  const count = (k: AssetKind) => files.filter((f) => f.kind === k).length;
  const primary = files.filter((f) => f.kind === 'video' || f.kind === 'image');
  const fail = (m: string) => badRequest('invalid_files', m);
  if (new Set(primary.map((f) => f.position)).size !== primary.length) throw fail('Two main files cannot take the same position');
  if (count('cover') > 1) throw fail('There can be only one cover');
  if (count('subtitles') > 10) throw fail('Too many subtitle files');
  if (count('subtitles') > 0 && count('video') === 0) throw fail('Subtitles only apply to a video');
  if (format === 'document') {
    if (count('pdf') !== 1 || primary.length > 0) throw fail('A document variant takes exactly one PDF');
  } else if (format === 'carousel') {
    if (count('pdf') > 0) throw fail('A carousel takes no PDF');
    if (primary.length < 2 || primary.length > 20) throw fail('A carousel takes between 2 and 20 images or videos');
  } else {
    if (count('pdf') > 0) throw fail('This variant takes no PDF');
    if (primary.length !== 1) throw fail('This variant takes exactly one image or video');
  }
  if (count('cover') > 0 && count('video') === 0) throw fail('A cover only applies to a video');
}

/**
 * Closes a version: checks that what was uploaded is what was declared, measures the files, computes the fingerprint
 * of the set and creates the immutable version. A new version always goes back to review, voids the previous approval
 * and puts on hold anything that was scheduled with the old version.
 */
export async function closeVersion(ctx: Ctx, p: Principal, variantId: string, raw: unknown) {
  const input = closeInput.parse(raw);
  const variant = await loadVariant(ctx.db, variantId);
  await authorize(ctx.db, p, variant.brand_id, 'version.upload');
  const a = actorCols(p);

  const ids = input.files.map((f) => f.uploadId);
  if (new Set(ids).size !== ids.length) throw badRequest('invalid_files', 'An uploaded file cannot be used twice');
  const uploads = await ctx.db.query(
    `select * from upload where id = any($1) and variant_id = $2 and consumed_at is null
       and created_by_user is not distinct from $3 and created_by_token is not distinct from $4`,
    [ids, variantId, a.user, a.token],
  );
  if (uploads.length !== ids.length) throw badRequest('invalid_upload', 'An upload does not exist, was already used or is not yours');
  if (uploads.some((u) => new Date(u.expires_at) < new Date())) throw badRequest('upload_expired', 'An upload has expired: request the URLs again');

  const files = input.files.map((f) => ({ kind: f.kind as AssetKind, position: f.position }));
  checkComposition(variant.format, files);

  const resolved: Resolved[] = [];
  for (const f of input.files) {
    const u = uploads.find((x) => x.id === f.uploadId)!;
    if (!MIME_OK[f.kind].test(u.mime)) throw badRequest('invalid_files', `${u.name}: type ${u.mime} is not valid as ${f.kind}`);
    const stored = await ctx.storage.stat(u.storage_key);
    if (!stored) throw badRequest('upload_missing', `${u.name}: the file has not been uploaded`);
    if (stored.bytes !== u.bytes || stored.sha256 !== u.sha256) {
      throw badRequest('upload_mismatch', `${u.name}: what was uploaded does not match the declared size and hash`);
    }
    const measurable = f.kind === 'video' || f.kind === 'image' || f.kind === 'cover';
    const meta = measurable
      ? await ctx.media.probe(await mediaSource(ctx, u.storage_key))
      : { width: null, height: null, durationMs: null, fps: null };
    resolved.push({ upload: u as Resolved['upload'], kind: f.kind as AssetKind, position: f.position, meta });
  }

  const fingerprint = fingerprintOf(resolved.map((r) => ({ kind: r.kind, position: r.position, sha256: r.upload.sha256 })));

  return ctx.db.tx(async (db) => {
    await db.query('select 1 from variant where id = $1 for update', [variantId]);
    const fresh = await loadVariant(db, variantId);
    if (fresh.piece_discarded) throw conflict('piece_discarded', 'The piece is discarded');
    const still = await db.query('select id from upload where id = any($1) and consumed_at is null for update', [ids]);
    if (still.length !== ids.length) throw conflict('upload_consumed', 'An upload was already used in another version');

    const last = await db.one<{ number: number; fingerprint: string }>(
      'select number, fingerprint from version where variant_id = $1 order by number desc limit 1',
      [variantId],
    );
    if (last && last.fingerprint === fingerprint) {
      throw conflict('identical_version', 'The files are identical to those of the previous version');
    }
    const number = (last?.number ?? 0) + 1;

    await db.query(
      `update version set review_state = 'superseded'
       where variant_id = $1 and review_state in ('in_review','changes_requested','approved')`,
      [variantId],
    );
    // Anything not yet out is held. One a network is already holding is taken down by the worker, starting now; one that is
    // being published this very moment cannot be stopped and goes out as approved.
    const held = await db.query(
      `update publication set status = 'on_hold', updated_at = now(), hold_reason = 'A new version is awaiting approval',
         next_run_at = case when native_scheduled or held_on_network then $2::timestamptz else null end
       where variant_id = $1 and status in ('scheduled','awaiting_reapproval','preparing','ready') returning id`,
      [variantId, ctx.now()],
    );

    const version = (await db.one(
      `insert into version (variant_id, number, author_user_id, author_token_id, notes, fingerprint)
       values ($1,$2,$3,$4,$5,$6) returning *`,
      [variantId, number, a.user, a.token, input.notes, fingerprint],
    ))!;
    for (const r of resolved) {
      await db.query(
        `insert into asset (version_id, kind, position, storage_key, name, mime, width, height, duration_ms, fps, bytes, sha256, meta)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
        [version.id, r.kind, r.position, r.upload.storage_key, r.upload.name, r.upload.mime, r.meta.width, r.meta.height,
          r.meta.durationMs, r.meta.fps, r.upload.bytes, r.upload.sha256, JSON.stringify(probeMeta(r.meta))],
      );
    }
    await db.query('update upload set consumed_at = now() where id = any($1)', [ids]);

    if (input.resolves.length) {
      // An agent leaves the comments marked for people alone, even if it claims to have fixed them.
      if (a.token) {
        const mine = await db.one('select 1 from comment where id = any($1) and people_only', [input.resolves]);
        if (mine) throw badRequest('people_only', 'A comment marked for people only cannot be resolved by an agent');
      }
      const done = await db.query(
        `update comment set status = 'resolved', resolved_in_version_id = $2, resolved_by_user_id = $3, resolved_at = now()
         where id = any($1) and parent_id is null and status = 'open'
           and version_id in (select id from version where variant_id = $4) returning id`,
        [input.resolves, version.id, a.user, variantId],
      );
      if (done.length !== new Set(input.resolves).size) {
        throw badRequest('invalid_comment', 'A comment to resolve does not exist, is not on this variant or was already resolved');
      }
    }

    await refreshPieceState(db, fresh.piece_id);
    await audit(db, p, fresh.brand_id, 'version.created', 'version', version.id, null, {
      variant_id: variantId, number, fingerprint, files: resolved.length, resolves: input.resolves.length, held_publications: held.length,
    });
    for (const h of held) await audit(db, p, fresh.brand_id, 'publication.on_hold', 'publication', h.id, null, { reason: 'new version' });
    await notifyRoles(db, fresh.brand_id, ['reviewer', 'approver', 'admin'], 'version.uploaded',
      { versionId: version.id, pieceId: fresh.piece_id, number }, a.user);
    if (held.length) {
      await notifyRoles(db, fresh.brand_id, ['approver', 'admin'], 'publication.on_hold',
        { pieceId: fresh.piece_id, count: held.length }, a.user);
    }
    return version;
  });
}

export async function listAssets(db: Queryable, versionId: string) {
  return db.query('select * from asset where version_id = $1 order by position, kind', [versionId]);
}

/** Fingerprint recomputed from the version's file records. It must always match the version's own. */
export async function recomputeFingerprint(db: Queryable, versionId: string): Promise<string> {
  const assets = await listAssets(db, versionId);
  return fingerprintOf(assets.map((x) => ({ kind: x.kind, position: x.position, sha256: x.sha256 })));
}

/**
 * Whether the objects in storage are still the files the version was made of: each one's size and sha256 as storage reports them
 * (S3 keeps the checksum the upload was verified with; local storage hashes the file again). A file replaced or removed in storage,
 * which the database cannot see, makes this false.
 */
export async function storedFilesMatch(ctx: Ctx, versionId: string, db: Queryable = ctx.db): Promise<boolean> {
  for (const a of await listAssets(db, versionId)) {
    const stored = await ctx.storage.stat(a.storage_key).catch(() => null);
    if (!stored || stored.bytes !== Number(a.bytes) || stored.sha256 !== a.sha256) return false;
  }
  return true;
}

export type Uploader =
  | { kind: 'user'; id: string; name: string | null }
  | { kind: 'token'; id: string; name: string; created_by: { id: string; name: string | null } };

/**
 * Who uploaded a version: a person, or a producer token and the person who made it. Approval does not depend on this (only on
 * permissions: whoever made a token is not the author of what it uploads), but people deciding should see it.
 */
export async function uploaderOf(db: Queryable, versionId: string): Promise<Uploader | null> {
  const r = await db.one(
    `select ver.author_user_id, ver.author_token_id, coalesce(u.name, u.email) as user_name, t.name as token_name,
       t.created_by as token_created_by, coalesce(cu.name, cu.email) as token_created_by_name
     from version ver left join app_user u on u.id = ver.author_user_id
     left join api_token t on t.id = ver.author_token_id left join app_user cu on cu.id = t.created_by
     where ver.id = $1`,
    [versionId],
  );
  if (!r) return null;
  if (r.author_token_id) return { kind: 'token', id: r.author_token_id, name: r.token_name, created_by: { id: r.token_created_by, name: r.token_created_by_name } };
  return { kind: 'user', id: r.author_user_id, name: r.user_name };
}

export async function getVersion(ctx: Ctx, p: Principal, versionId: string) {
  const version = await loadVersion(ctx.db, versionId);
  await authorize(ctx.db, p, version.brand_id, 'brand.view');
  const assets = await listAssets(ctx.db, versionId);
  const withUrls = [];
  for (const x of assets) {
    withUrls.push({
      id: x.id, kind: x.kind, position: x.position, name: x.name, mime: x.mime, width: x.width, height: x.height,
      duration_ms: x.duration_ms, fps: x.fps === null ? null : Number(x.fps), bytes: x.bytes, sha256: x.sha256,
      url: await ctx.storage.presignGet(x.storage_key, { expiresSec: 3600 }),
    });
  }
  const approvals = await ctx.db.query(
    `select a.id, a.decision, a.account_ids, a.checklist, a.note, a.created_at, a.approved_fingerprint, a.piece_title, a.ai_generated,
       coalesce(u.name, u.email) as approver, a.approved_fingerprint = $2 as matches_fingerprint
     from approval a join app_user u on u.id = a.approver_user_id where a.version_id = $1 order by a.created_at`,
    [versionId, version.fingerprint],
  );
  const siblings = await ctx.db.query<{ id: string; number: number }>(
    'select id, number from version where variant_id = $1 order by number',
    [version.variant_id],
  );
  const variant = await loadVariant(ctx.db, version.variant_id);
  const brand = await ctx.db.one('select name, timezone, approval_rules, paused from brand where id = $1', [version.brand_id]);
  const author = await ctx.db.one<{ name: string }>(
    `select coalesce(u.name, u.email, t.name) as name from version ver
     left join app_user u on u.id = ver.author_user_id left join api_token t on t.id = ver.author_token_id where ver.id = $1`,
    [versionId],
  );
  return {
    id: version.id, number: version.number, notes: version.notes, fingerprint: version.fingerprint,
    review_state: version.review_state, created_at: version.created_at, author: author?.name ?? null,
    author_user_id: version.author_user_id, by_agent: version.author_token_id !== null, uploaded_by: await uploaderOf(ctx.db, versionId),
    variant: { id: variant.id, format: variant.format, style: variant.style, piece_id: variant.piece_id },
    piece: await ctx.db.one('select id, title, kind, brief, ai_generated, review_state from piece where id = $1', [version.piece_id]),
    brand, assets: withUrls, approvals, versions: siblings,
  };
}

export { forbidden };
