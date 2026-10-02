import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { ImageProfile, FileProfile, VideoProfile } from '../connectors/profiles.js';
import { ConnectorError } from '../connectors/types.js';
import { mediaSource, type Ctx } from '../context.js';
import type { Row } from '../db.js';
import type { ProbeResult } from '../media/ffmpeg.js';

export interface PreparedFile {
  key: string;
  mime: string;
  bytes: number;
  sha256: string;
  width: number | null;
  height: number | null;
  durationMs: number | null;
  /** True when a copy was made; false when the original already fit and goes out as it is. */
  transcoded: boolean;
  /** Why the original did not fit, when a copy was needed. */
  reasons: string[];
}

/** The probe details worth keeping on the asset, so a profile can be checked later without reading the file again. */
export function probeMeta(p: ProbeResult): Record<string, unknown> {
  return {
    videoCodec: p.videoCodec ?? null,
    audioCodec: p.audioCodec ?? null,
    pixFmt: p.pixFmt ?? null,
    mp4: p.mp4 ?? null,
    container: p.container ?? null,
    faststart: p.faststart ?? null,
    mpo: p.mpo ?? null,
    videoKbps: p.videoKbps ?? null,
    hasAudio: p.hasAudio ?? null,
  };
}

const CONTAINER_NAME: Record<string, string> = { mov: 'QuickTime (MOV)', matroska: 'Matroska/WebM', unknown: 'not one this app can read' };

/** Everything about an original that makes it unfit for a video profile. Empty means it goes out as it is. */
export function videoMismatches(p: ProbeResult, bytes: number, profile: VideoProfile): string[] {
  const out: string[] = [];
  // The real container, from the file's first bytes: ffprobe calls an MP4 and a MOV by the same family name.
  if (p.container !== undefined && p.container !== null ? p.container !== 'mp4' : !p.mp4) {
    out.push(`the container is ${p.container && CONTAINER_NAME[p.container] ? `${CONTAINER_NAME[p.container]}, ` : ''}not MP4`);
  }
  if (profile.faststart && p.faststart === false) out.push('its index (the moov atom) is at the end of the file, not at the front');
  if (p.videoCodec !== profile.videoCodec) out.push(`the video codec is ${p.videoCodec ?? 'unknown'}, not H.264`);
  if (p.audioCodec && p.audioCodec !== profile.audioCodec) out.push(`the audio codec is ${p.audioCodec}, not AAC`);
  if (p.pixFmt !== profile.pixFmt) out.push(`the pixel format is ${p.pixFmt ?? 'unknown'}, not ${profile.pixFmt}`);
  if ((p.width ?? 0) > profile.maxWidth || (p.height ?? 0) > profile.maxHeight) out.push(`it is larger than ${profile.maxWidth}×${profile.maxHeight}`);
  if ((p.fps ?? 0) > profile.maxFps) out.push(`it runs above ${profile.maxFps} fps`);
  if (profile.minFps && p.fps && p.fps < profile.minFps - 0.01) out.push(`it runs below ${profile.minFps} fps`);
  if ((p.videoKbps ?? 0) > profile.maxVideoKbps) out.push(`its bitrate is above ${profile.maxVideoKbps} kbps`);
  if (bytes > profile.maxBytes) out.push('it is larger than the size limit');
  return out;
}

export function imageMismatches(p: ProbeResult, mime: string, bytes: number, profile: ImageProfile): string[] {
  const out: string[] = [];
  // What the file is, not what it was declared as: a PNG named .jpg is not a JPEG, and an MPO (two pictures in one file) is refused.
  const container = p.container ?? (mime === 'image/jpeg' ? 'jpeg' : 'other');
  if (container !== 'jpeg') out.push('it is not a JPEG');
  else if (p.mpo) out.push('it is a Multi-Picture Object (MPO), not a plain JPEG');
  if ((p.width ?? 0) > profile.maxWidth) out.push(`it is wider than ${profile.maxWidth} px`);
  if (bytes > profile.maxBytes) out.push('it is larger than the size limit');
  return out;
}

function probeOf(asset: Row): ProbeResult {
  const m = (asset.meta ?? {}) as Record<string, any>;
  return {
    width: asset.width, height: asset.height, durationMs: asset.duration_ms, fps: asset.fps === null ? null : Number(asset.fps),
    videoCodec: m.videoCodec ?? null, audioCodec: m.audioCodec ?? null, pixFmt: m.pixFmt ?? null,
    mp4: m.mp4 ?? undefined, videoKbps: m.videoKbps ?? null, hasAudio: m.hasAudio ?? undefined,
    // Rows measured before these were kept lack them, and are measured again.
    container: m.container ?? undefined, faststart: m.faststart === undefined ? undefined : m.faststart, mpo: m.mpo ?? undefined,
  };
}

async function sha256OfFile(file: string): Promise<string> {
  const h = createHash('sha256');
  await pipeline(createReadStream(file), h);
  return h.digest('hex');
}

/**
 * The file to hand a network for this asset: the original if it already fits the profile, otherwise a copy made once and
 * kept (so a retry, or the same asset going to a second account, does not transcode again).
 */
export async function fileFor(ctx: Ctx, brandId: string, asset: Row, profile: FileProfile): Promise<PreparedFile> {
  const cached = await ctx.db.one('select * from rendition where asset_id = $1 and profile = $2', [asset.id, profile.id]);
  if (cached) {
    return { key: cached.storage_key, mime: cached.mime, bytes: cached.bytes, sha256: cached.sha256, width: cached.width, height: cached.height, durationMs: cached.duration_ms, transcoded: true, reasons: [] };
  }

  let probe = probeOf(asset);
  const source = await mediaSource(ctx, asset.storage_key);
  const needsFullProbe = profile.kind === 'video'
    ? probe.videoCodec === null || probe.container === undefined || (profile.faststart && probe.faststart === undefined)
    : probe.width === null || probe.container === undefined;
  if (needsFullProbe) probe = { ...probe, ...(await ctx.media.probe(source)) };

  const reasons = profile.kind === 'video' ? videoMismatches(probe, asset.bytes, profile) : imageMismatches(probe, asset.mime, asset.bytes, profile);
  if (reasons.length === 0) {
    // It goes out as it is, under the type it really is (an MP4 someone declared as video/quicktime is still an MP4).
    const mime = probe.container === 'mp4' ? 'video/mp4' : probe.container === 'jpeg' ? 'image/jpeg' : asset.mime;
    return { key: asset.storage_key, mime, bytes: asset.bytes, sha256: asset.sha256, width: asset.width, height: asset.height, durationMs: asset.duration_ms, transcoded: false, reasons: [] };
  }

  const ext = profile.kind === 'video' ? 'mp4' : 'jpg';
  const mime = profile.kind === 'video' ? 'video/mp4' : 'image/jpeg';
  const dir = path.join(tmpdir(), `estudio-${randomUUID()}`);
  await mkdir(dir, { recursive: true });
  const out = path.join(dir, `out.${ext}`);
  try {
    try {
      await ctx.media.transcode(source, out, profile, probe);
    } catch (err) {
      const msg = (err as Error).message;
      // ffmpeg missing or killed is ours to fix and worth retrying; ffmpeg rejecting the file is not.
      throw new ConnectorError(/could not start|timed out/.test(msg) ? 'transient' : 'file_rejected', `Could not make a ${profile.id} copy: ${msg}`);
    }
    const bytes = (await stat(out)).size;
    if (bytes > profile.maxBytes) {
      throw new ConnectorError('file_rejected', `Even after conversion the file is larger than the ${profile.id} limit (${Math.round(bytes / 1048576)} MB)`);
    }
    const sha = await sha256OfFile(out);
    const measured = await ctx.media.probe(out);
    const key = `brands/${brandId}/renditions/${asset.id}/${profile.id}.${ext}`;
    await ctx.storage.putFile(key, out, mime);
    await ctx.db.query(
      `insert into rendition (asset_id, profile, storage_key, mime, bytes, sha256, width, height, duration_ms)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9) on conflict (asset_id, profile) do nothing`,
      [asset.id, profile.id, key, mime, bytes, sha, measured.width, measured.height, measured.durationMs],
    );
    return { key, mime, bytes, sha256: sha, width: measured.width, height: measured.height, durationMs: measured.durationMs, transcoded: true, reasons };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
