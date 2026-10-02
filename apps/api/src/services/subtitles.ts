import { authorize, type Principal } from '../auth/principal.js';
import { parseSubtitles, type Cue, type ParsedSubtitles } from '../domain/subtitles.js';
import type { Ctx } from '../context.js';
import { loadVersion } from './loaders.js';

/** Subtitle files of a version, read into lines. A file too large to be real subtitles is left alone rather than read into memory. */
const MAX_FILE_BYTES = 2_000_000;

export interface Track {
  assetId: string;
  /** Which subtitle file of the version: the position it was uploaded at (0, 1, 2…). */
  position: number;
  name: string;
  cues: Cue[];
  skipped: number;
  truncated: boolean;
  /** Set instead of cues when the file could not be read at all. */
  problem?: string;
}

async function readTrack(ctx: Ctx, a: { id: string; position: number; name: string; storage_key: string; bytes: number | string }): Promise<Track> {
  const base = { assetId: a.id, position: a.position, name: a.name };
  if (Number(a.bytes) > MAX_FILE_BYTES) return { ...base, cues: [], skipped: 0, truncated: false, problem: 'This file is too large to be subtitles' };
  const data = await ctx.storage.get(a.storage_key);
  if (!data) return { ...base, cues: [], skipped: 0, truncated: false, problem: 'The file could not be found' };
  const parsed: ParsedSubtitles = parseSubtitles(data.toString('utf8'));
  return { ...base, ...parsed, ...(parsed.cues.length === 0 ? { problem: 'No subtitle lines could be read from this file' } : {}) };
}

export async function tracksOf(ctx: Ctx, versionId: string): Promise<Track[]> {
  const rows = await ctx.db.query<{ id: string; position: number; name: string; storage_key: string; bytes: number }>(
    `select id, position, name, storage_key, bytes from asset where version_id = $1 and kind = 'subtitles' order by position`,
    [versionId],
  );
  return Promise.all(rows.map((r) => readTrack(ctx, r)));
}

/** One subtitle file of a version, for checking a comment against it. */
export async function trackAt(ctx: Ctx, versionId: string, position: number): Promise<Track | null> {
  const r = await ctx.db.one<{ id: string; position: number; name: string; storage_key: string; bytes: number }>(
    `select id, position, name, storage_key, bytes from asset where version_id = $1 and kind = 'subtitles' and position = $2`,
    [versionId, position],
  );
  return r ? readTrack(ctx, r) : null;
}

export async function getSubtitles(ctx: Ctx, p: Principal, versionId: string) {
  const version = await loadVersion(ctx.db, versionId);
  await authorize(ctx.db, p, version.brand_id, 'brand.view');
  return { tracks: await tracksOf(ctx, versionId) };
}
