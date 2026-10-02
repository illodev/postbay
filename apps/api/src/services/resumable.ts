import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, open, readdir, rm, stat, truncate } from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { actorCols, authorize, type Principal } from '../auth/principal.js';
import type { Ctx } from '../context.js';
import type { Queryable } from '../db.js';
import { badRequest, conflict, notFound } from '../errors.js';

/**
 * Uploads that can be resumed. A big file sent in one request is lost whenever the connection drops; here the browser sends it in
 * pieces, each at the place where the last one ended, and after any interruption asks how much has arrived and carries on.
 *
 * The pieces are appended to a staging file on this server's disk. When all the bytes are there, `finish` checks the size and the hash
 * the producer declared and only then puts the file in storage, so storage never holds anything unchecked. The rest of the flow is
 * the same as for a direct upload: the version is closed with the upload's id, and closing checks storage once more.
 *
 * All of a piece is written, flushed and counted in the database inside one lock on the upload's row, so two pieces for the same upload
 * cannot interleave, and a crash between the file and the database is repaired by trusting the database: the file is cut back to the
 * counted size before the next piece is added.
 */

/** What the browser is told to send per request. */
export const CHUNK_BYTES = 8 * 1024 ** 2;
/** What the server accepts per request (a little room over what it asks for). */
export const MAX_CHUNK_BYTES = 16 * 1024 ** 2;
/** An unfinished upload is kept this long after the last piece (or the last time the same file was chosen again). */
export const RESUME_TTL_SEC = 24 * 3600;

export const stagingFile = (ctx: Ctx, uploadId: string) => path.join(path.resolve(ctx.config.STAGING_DIR), `${uploadId}.part`);

interface UploadRow {
  id: string;
  brand_id: string;
  storage_key: string;
  mime: string;
  bytes: string | number;
  sha256: string;
  received_bytes: string | number;
  completed_at: Date | null;
  consumed_at: Date | null;
  resumable: boolean;
  expired: boolean;
}

export interface UploadProgress {
  offset: number;
  bytes: number;
  complete: boolean;
  chunkSize: number;
}

const progressOf = (u: UploadRow): UploadProgress => ({ offset: Number(u.received_bytes), bytes: Number(u.bytes), complete: !!u.completed_at, chunkSize: CHUNK_BYTES });

/** The upload if it is the caller's own, still open and resumable. Anyone else's looks like one that does not exist. */
async function loadOwn(ctx: Ctx, db: Queryable, p: Principal, uploadId: string, lock: boolean): Promise<UploadRow> {
  const a = actorCols(p);
  const u = await db.one<UploadRow & { created_by_user: string | null; created_by_token: string | null }>(
    `select id, brand_id, storage_key, mime, bytes, sha256, received_bytes, completed_at, consumed_at, resumable, created_by_user, created_by_token,
            expires_at < now() as expired
     from upload where id = $1 ${lock ? 'for update' : ''}`,
    [uploadId],
  );
  if (!u || u.created_by_user !== a.user || u.created_by_token !== a.token) throw notFound('Upload');
  await authorize(ctx.db, p, u.brand_id, 'version.upload');
  if (!u.resumable) throw badRequest('not_resumable', 'This upload was not made to be sent in pieces');
  if (u.consumed_at) throw conflict('upload_used', 'This upload was already used in a version');
  if (u.expired) throw conflict('upload_expired', 'This upload has expired: choose the file again to start a new one');
  return u;
}

/** How much of the file has arrived, so the browser knows where to carry on from. */
export async function uploadProgress(ctx: Ctx, p: Principal, uploadId: string): Promise<UploadProgress> {
  return progressOf(await loadOwn(ctx, ctx.db, p, uploadId, false));
}

type Appended = { kind: 'ok'; progress: UploadProgress } | { kind: 'mismatch'; offset: number };

/** Adds the next piece, which must begin exactly where the file ends so far. A piece at any other place is refused with the right place. */
export async function appendPiece(ctx: Ctx, p: Principal, uploadId: string, offset: number, piece: Buffer): Promise<UploadProgress> {
  if (!Number.isSafeInteger(offset) || offset < 0) throw badRequest('invalid_offset', 'Upload-Offset must be the number of bytes already sent');
  if (piece.length === 0) throw badRequest('empty_piece', 'A piece has to carry some bytes');
  if (piece.length > MAX_CHUNK_BYTES) throw badRequest('piece_too_large', `Send at most ${MAX_CHUNK_BYTES} bytes at a time`);
  const done = await ctx.db.tx<Appended>(async (db) => {
    const u = await loadOwn(ctx, db, p, uploadId, true);
    if (u.completed_at) throw conflict('upload_complete', 'All of this file has already arrived');
    const have = Number(u.received_bytes);
    const total = Number(u.bytes);
    const file = stagingFile(ctx, uploadId);
    // The database is the truth. A file longer than it says holds a piece whose count was lost: cut it back. A shorter one lost data: start over.
    const onDisk = (await stat(file).catch(() => null))?.size ?? 0;
    if (onDisk < have) {
      await rm(file, { force: true });
      await db.query('update upload set received_bytes = 0 where id = $1', [uploadId]);
      return { kind: 'mismatch', offset: 0 };
    }
    if (offset !== have) return { kind: 'mismatch', offset: have };
    if (have + piece.length > total) throw badRequest('too_much_data', 'That would make the file longer than declared');
    await mkdir(path.dirname(file), { recursive: true });
    if (onDisk > have) await truncate(file, have);
    const handle = await open(file, 'a');
    try {
      await handle.write(piece);
      await handle.sync();
    } finally {
      await handle.close();
    }
    const after = await db.one<UploadRow>(
      `update upload set received_bytes = received_bytes + $2, expires_at = now() + make_interval(secs => $3) where id = $1
       returning id, brand_id, storage_key, mime, bytes, sha256, received_bytes, completed_at, consumed_at, resumable, false as expired`,
      [uploadId, piece.length, RESUME_TTL_SEC],
    );
    return { kind: 'ok', progress: progressOf(after!) };
  });
  if (done.kind === 'mismatch') throw conflict('offset_mismatch', 'That piece does not continue where the file ends', { offset: done.offset });
  return done.progress;
}

type Finished = { kind: 'ok'; progress: UploadProgress } | { kind: 'bad'; message: string } | { kind: 'short'; offset: number };

/**
 * Called once every byte has arrived: checks the hash, puts the file in storage and removes the staging file. Safe to call again after a
 * timeout or a lost answer. A file that does not match what was declared is discarded and the upload starts again from nothing.
 */
export async function finishUpload(ctx: Ctx, p: Principal, uploadId: string): Promise<UploadProgress> {
  const done = await ctx.db.tx<Finished>(async (db) => {
    const u = await loadOwn(ctx, db, p, uploadId, true);
    if (u.completed_at) return { kind: 'ok', progress: progressOf(u) };
    const have = Number(u.received_bytes);
    if (have !== Number(u.bytes)) return { kind: 'short', offset: have };
    const file = stagingFile(ctx, uploadId);
    const onDisk = (await stat(file).catch(() => null))?.size;
    const hash = createHash('sha256');
    if (onDisk === have) await pipeline(createReadStream(file), hash);
    if (onDisk !== have || hash.digest('hex') !== u.sha256) {
      await rm(file, { force: true });
      await db.query('update upload set received_bytes = 0 where id = $1', [uploadId]);
      return { kind: 'bad', message: 'What arrived does not match the declared size and hash, so it was discarded. Choose the file again to send it from the start.' };
    }
    await ctx.storage.putFile(u.storage_key, file, u.mime, { sha256: u.sha256 });
    await rm(file, { force: true });
    const row = await db.one<UploadRow>(
      `update upload set completed_at = now(), expires_at = now() + make_interval(secs => $2) where id = $1
       returning id, brand_id, storage_key, mime, bytes, sha256, received_bytes, completed_at, consumed_at, resumable, false as expired`,
      [uploadId, RESUME_TTL_SEC],
    );
    return { kind: 'ok', progress: progressOf(row!) };
  });
  if (done.kind === 'short') throw conflict('upload_incomplete', 'Not all of the file has arrived yet', { offset: done.offset });
  if (done.kind === 'bad') throw badRequest('upload_mismatch', done.message);
  return done.progress;
}

/** Removes staging files nobody will finish: of uploads that expired, were used or completed, or that have no upload at all. Returns how many. */
export async function purgeStaging(ctx: Ctx): Promise<number> {
  const dir = path.resolve(ctx.config.STAGING_DIR);
  const names = await readdir(dir).catch(() => [] as string[]);
  let removed = 0;
  for (const name of names) {
    const id = /^([0-9a-f-]{36})\.part$/.exec(name)?.[1];
    if (!id) continue;
    const file = path.join(dir, name);
    // A file written in the last minutes may belong to a piece being added right now.
    const s = await stat(file).catch(() => null);
    if (!s || Date.now() - s.mtimeMs < 5 * 60_000) continue;
    const u = await ctx.db.one<{ live: boolean }>(
      `select (completed_at is null and consumed_at is null and expires_at > now()) as live from upload where id = $1`,
      [id],
    );
    if (u?.live) continue;
    await rm(file, { force: true });
    removed++;
  }
  return removed;
}
