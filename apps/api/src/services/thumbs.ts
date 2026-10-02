import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { mediaSource, type Ctx } from '../context.js';
import { authorize, type Principal } from '../auth/principal.js';
import { notFound } from '../errors.js';

/**
 * Small JPEG previews for the pieces list: one per version, made once and kept in storage under `thumbs/`.
 * The picture is the version's cover if it has one, else its first image, else a frame of its video. A PDF has none:
 * the list draws its own placeholder.
 */

export const THUMB_WIDTHS = [240, 480, 960] as const;
export type ThumbWidth = (typeof THUMB_WIDTHS)[number];

interface AssetRow {
  storage_key: string;
  kind: string;
  duration_ms: number | null;
}

/** The piece's preview version: the latest of its first variant (the main one; later ones are crops and documents), or null. */
export async function latestVersionId(ctx: Ctx, p: Principal, pieceId: string): Promise<string | null> {
  const piece = await ctx.db.one<{ brand_id: string }>('select brand_id from piece where id = $1', [pieceId]);
  if (!piece) throw notFound('Piece');
  await authorize(ctx.db, p, piece.brand_id, 'brand.view');
  const row = await ctx.db.one<{ id: string }>(
    `select ver.id from version ver join variant v on v.id = ver.variant_id
     where v.piece_id = $1 order by v.created_at, ver.number desc limit 1`,
    [pieceId],
  );
  return row?.id ?? null;
}

/** The preview of a version at a width, generated on first use. Null when the version has nothing to draw. */
export async function versionThumb(ctx: Ctx, p: Principal, versionId: string, width: ThumbWidth): Promise<Buffer | null> {
  const ver = await ctx.db.one<{ brand_id: string }>(
    `select pc.brand_id from version ver join variant v on v.id = ver.variant_id join piece pc on pc.id = v.piece_id where ver.id = $1`,
    [versionId],
  );
  if (!ver) throw notFound('Version');
  await authorize(ctx.db, p, ver.brand_id, 'brand.view');

  const cacheKey = `thumbs/${versionId}-${width}.jpg`;
  const cached = await ctx.storage.get(cacheKey);
  if (cached) return cached;

  const assets = await ctx.db.query<AssetRow>(
    `select storage_key, kind, duration_ms from asset where version_id = $1
     order by case kind when 'cover' then 0 when 'image' then 1 when 'video' then 2 else 3 end, position`,
    [versionId],
  );
  const pick = assets.find((a) => a.kind === 'cover' || a.kind === 'image' || a.kind === 'video');
  if (!pick) return null;

  // A frame a third of the way in: the first ones are often a black, a fade or a title card.
  const at = pick.kind === 'video' ? Math.min(8, ((pick.duration_ms ?? 0) / 1000) * 0.3) : null;
  const jpg = await scaledFrame(await mediaSource(ctx, pick.storage_key), at, width);
  if (!jpg) return null;
  await ctx.storage.put(cacheKey, jpg, 'image/jpeg');
  return jpg;
}

/**
 * One frame of `src` (a local path, or a signed URL for S3 storage), scaled to `width`, as JPEG. `seconds` only for a video:
 * on a still image any -ss, even 0, leaves ffmpeg with no frame to write.
 */
async function scaledFrame(src: string, seconds: number | null, width: number): Promise<Buffer | null> {
  const dir = await mkdtemp(path.join(tmpdir(), 'thumb-'));
  const out = path.join(dir, 'thumb.jpg');
  // Local storage hands a path; S3 a signed https URL. Nothing else is ever opened (no playlists, no other protocols).
  const protocols = /^https:\/\//.test(src) ? 'file,https,tls,tcp' : 'file';
  try {
    await new Promise<void>((resolve, reject) => {
      execFile(
        'ffmpeg',
        ['-v', 'error', '-y', '-protocol_whitelist', protocols, ...(seconds === null ? [] : ['-ss', String(seconds)]), '-i', src, '-frames:v', '1',
          '-vf', `scale=w='min(iw,${width})':h=-2`, '-q:v', '4', out],
        { timeout: 30_000 },
        (err) => (err ? reject(err) : resolve()),
      );
    });
    return await readFile(out);
  } catch {
    return null;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
