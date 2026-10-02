import { createHash, randomBytes } from 'node:crypto';
import { appendFile, readFile, readdir, stat, utimes, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { appendPiece, CHUNK_BYTES, MAX_CHUNK_BYTES, maxPendingBytes, purgeStaging, stagingFile } from '../src/services/resumable.js';
import { createEnv, type Actor, type Env } from './helpers.js';

let env: Env;
beforeAll(async () => { env = await createEnv(); });
afterAll(async () => { await env.close(); });

const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const PIECE = 'application/offset+octet-stream';

interface Started { variantId: string; uploadId: string; data: Buffer; progress: { offset: number; bytes: number; complete: boolean; chunkSize: number } }

/** Declares a file to be sent in pieces, the way the browser does. */
async function start(as: Actor = env.users.producer, size = 1000, data = randomBytes(size), name = 'big.mp4', variantId?: string): Promise<Started> {
  const v = variantId ?? (await env.makePiece(as)).variantId;
  const r = await env.call(as, 'POST', `/api/variants/${v}/uploads`, { files: [{ name, mime: 'video/mp4', bytes: data.length, sha256: sha(data), resumable: true }] });
  expect(r.status).toBe(200);
  const u = r.body.uploads[0];
  expect(u.url).toBeUndefined();
  return { variantId: v, uploadId: u.uploadId, data, progress: u.resumable };
}

const send = (as: Actor, id: string, offset: number | string, body: Buffer, headers: Record<string, string> = {}) =>
  env.app.inject({
    method: 'PATCH',
    url: `/api/uploads/${id}/resumable`,
    headers: { cookie: as.cookie!, 'x-requested-by': 'studio', 'upload-offset': String(offset), 'content-type': PIECE, ...headers },
    payload: body,
  });
const progress = (as: Actor, id: string) => env.call(as, 'GET', `/api/uploads/${id}/resumable`);
const finish = (as: Actor, id: string) => env.call(as, 'POST', `/api/uploads/${id}/resumable/finish`);
const close = (as: Actor, s: Started) =>
  env.call(as, 'POST', `/api/variants/${s.variantId}/versions`, { files: [{ uploadId: s.uploadId, kind: 'video', position: 0 }] });
const P = () => env.users.producer;

describe('sending a file in pieces', () => {
  it('carries a file from the first piece to a closed version', async () => {
    const s = await start(P(), 2500);
    expect(s.progress).toEqual({ offset: 0, bytes: 2500, complete: false, chunkSize: CHUNK_BYTES });
    let offset = 0;
    for (const size of [1000, 1000, 500]) {
      const r = await send(P(), s.uploadId, offset, s.data.subarray(offset, offset + size));
      expect(r.statusCode).toBe(200);
      offset += size;
      expect(r.json().offset).toBe(offset);
    }
    expect((await progress(P(), s.uploadId)).body).toMatchObject({ offset: 2500, complete: false });
    const done = await finish(P(), s.uploadId);
    expect(done.status).toBe(200);
    expect(done.body).toMatchObject({ offset: 2500, bytes: 2500, complete: true });

    // The file is in storage, byte for byte, and the staging copy is gone.
    expect(await env.ctx.storage.get((await env.db.one('select storage_key from upload where id = $1', [s.uploadId]))!.storage_key)).toEqual(s.data);
    await expect(stat(stagingFile(env.ctx, s.uploadId))).rejects.toThrow();

    const closed = await close(P(), s);
    expect(closed.status).toBe(201);
    expect((await env.db.one('select sha256, bytes from asset where version_id = $1', [closed.body.id]))).toMatchObject({ sha256: sha(s.data), bytes: 2500 });
  });

  it('carries on where it stopped when the same file is chosen again', async () => {
    const s = await start(P(), 3000);
    expect((await send(P(), s.uploadId, 0, s.data.subarray(0, 1200))).statusCode).toBe(200);

    // The connection dropped, the tab was closed: the producer picks the same file for the same variant.
    const again = await env.call(P(), 'POST', `/api/variants/${s.variantId}/uploads`, {
      files: [{ name: 'big.mp4', mime: 'video/mp4', bytes: 3000, sha256: sha(s.data), resumable: true }],
    });
    expect(again.body.uploads[0].uploadId).toBe(s.uploadId);
    expect(again.body.uploads[0].resumable).toMatchObject({ offset: 1200, complete: false });
    expect((await env.db.query('select id from upload where variant_id = $1', [s.variantId]))).toHaveLength(1);

    expect((await send(P(), s.uploadId, 1200, s.data.subarray(1200))).statusCode).toBe(200);
    expect((await finish(P(), s.uploadId)).status).toBe(200);
    expect((await close(P(), s)).status).toBe(201);
  });

  it('does not offer another file, another name, another person or another variant the same upload', async () => {
    const s = await start(P(), 600);
    const ask = async (as: Actor, variantId: string, over: Record<string, unknown>) =>
      (await env.call(as, 'POST', `/api/variants/${variantId}/uploads`, { files: [{ name: 'big.mp4', mime: 'video/mp4', bytes: 600, sha256: sha(s.data), resumable: true, ...over }] })).body.uploads[0].uploadId;
    expect(await ask(P(), s.variantId, {})).toBe(s.uploadId);
    expect(await ask(P(), s.variantId, { name: 'other.mp4' })).not.toBe(s.uploadId);
    expect(await ask(P(), s.variantId, { mime: 'video/webm' })).not.toBe(s.uploadId);
    expect(await ask(P(), s.variantId, { bytes: 601, sha256: sha(randomBytes(601)) })).not.toBe(s.uploadId);
    expect(await ask(env.users.admin, s.variantId, {})).not.toBe(s.uploadId);
    expect(await ask(P(), (await env.makePiece(P())).variantId, {})).not.toBe(s.uploadId);
  });

  it('refuses a piece that does not begin where the file ends, and says where that is', async () => {
    const s = await start(P(), 2000);
    await send(P(), s.uploadId, 0, s.data.subarray(0, 800));

    for (const wrong of [0, 500, 801, 1500]) {
      const r = await send(P(), s.uploadId, wrong, s.data.subarray(wrong, wrong + 100));
      expect(r.statusCode).toBe(409);
      expect(r.json().error).toMatchObject({ code: 'offset_mismatch', details: { offset: 800 } });
    }
    // Nothing of those pieces was kept.
    expect((await progress(P(), s.uploadId)).body.offset).toBe(800);
    expect((await readFile(stagingFile(env.ctx, s.uploadId))).length).toBe(800);

    // A piece sent twice (the answer was lost) is told the file is already further on, and the file is not damaged.
    const first = await send(P(), s.uploadId, 800, s.data.subarray(800, 1300));
    expect(first.statusCode).toBe(200);
    const twice = await send(P(), s.uploadId, 800, s.data.subarray(800, 1300));
    expect(twice.statusCode).toBe(409);
    expect(twice.json().error.details.offset).toBe(1300);
    await send(P(), s.uploadId, 1300, s.data.subarray(1300));
    expect((await finish(P(), s.uploadId)).status).toBe(200);
  });

  it('lets only one of several pieces sent at the same time in, and keeps the file whole', async () => {
    const s = await start(P(), 4000);
    const rivals = await Promise.all(Array.from({ length: 10 }, () => send(P(), s.uploadId, 0, s.data.subarray(0, 1000))));
    expect(rivals.filter((r) => r.statusCode === 200)).toHaveLength(1);
    expect(rivals.filter((r) => r.statusCode === 409)).toHaveLength(9);
    expect((await progress(P(), s.uploadId)).body.offset).toBe(1000);
    // Pieces that follow each other are all kept, in order.
    for (let o = 1000; o < 4000; o += 1000) expect((await send(P(), s.uploadId, o, s.data.subarray(o, o + 1000))).statusCode).toBe(200);
    expect((await finish(P(), s.uploadId)).status).toBe(200);
    expect((await close(P(), s)).status).toBe(201);
  });

  it('refuses pieces that are empty, too long for the file, too large to take, or not raw bytes', async () => {
    const s = await start(P(), 1000);
    expect((await send(P(), s.uploadId, 0, Buffer.alloc(0))).statusCode).toBe(400);
    const over = await send(P(), s.uploadId, 0, randomBytes(1001));
    expect(over.statusCode).toBe(400);
    expect(over.json().error.code).toBe('too_much_data');
    expect((await send(P(), s.uploadId, 0, Buffer.alloc(MAX_CHUNK_BYTES + 1))).statusCode).toBe(413);
    for (const bad of ['abc', '-1', '1.5', '', ' ', '1e3', '0x10', '99999999999999999']) expect((await send(P(), s.uploadId, bad, s.data.subarray(0, 10))).statusCode, `offset ${JSON.stringify(bad)}`).toBe(400);
    const noHeader = await env.app.inject({ method: 'PATCH', url: `/api/uploads/${s.uploadId}/resumable`, headers: { cookie: P().cookie!, 'x-requested-by': 'studio', 'content-type': PIECE }, payload: s.data.subarray(0, 10) });
    expect(noHeader.statusCode).toBe(400);
    const json = await env.app.inject({ method: 'PATCH', url: `/api/uploads/${s.uploadId}/resumable`, headers: { cookie: P().cookie!, 'x-requested-by': 'studio', 'upload-offset': '0', 'content-type': 'application/json' }, payload: { a: 1 } });
    expect(json.statusCode).toBe(400);
    expect((await progress(P(), s.uploadId)).body.offset).toBe(0);
  });

  it('refuses a piece without the header that guards cookie sessions', async () => {
    const s = await start(P(), 100);
    const r = await env.app.inject({ method: 'PATCH', url: `/api/uploads/${s.uploadId}/resumable`, headers: { cookie: P().cookie!, 'upload-offset': '0', 'content-type': PIECE }, payload: s.data });
    expect(r.statusCode).toBe(403);
    expect((await progress(P(), s.uploadId)).body.offset).toBe(0);
  });
});

describe('the service on its own, whatever the route lets through', () => {
  const asProducer = { kind: 'user' as const, userId: '', email: '' };
  it('refuses offsets that are not whole numbers of bytes, and pieces that are empty or too large', async () => {
    const s = await start(P(), 100);
    const as = { ...asProducer, userId: P().id, email: P().email };
    for (const bad of [-1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 2]) {
      await expect(appendPiece(env.ctx, as, s.uploadId, bad, s.data), `offset ${bad}`).rejects.toMatchObject({ code: 'invalid_offset' });
    }
    await expect(appendPiece(env.ctx, as, s.uploadId, 0, Buffer.alloc(0))).rejects.toMatchObject({ code: 'empty_piece' });
    await expect(appendPiece(env.ctx, as, s.uploadId, 0, Buffer.alloc(MAX_CHUNK_BYTES + 1))).rejects.toMatchObject({ code: 'piece_too_large' });
    expect((await progress(P(), s.uploadId)).body.offset).toBe(0);
    await expect(appendPiece(env.ctx, as, s.uploadId, 0, s.data)).resolves.toMatchObject({ offset: 100 });
  });
});

describe('checking the whole file', () => {
  it('discards a file that is not what was declared, and starts again from nothing', async () => {
    const declared = randomBytes(900);
    const s = await start(P(), 900, declared);
    const wrong = randomBytes(900);
    await send(P(), s.uploadId, 0, wrong);
    const r = await finish(P(), s.uploadId);
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('upload_mismatch');
    await expect(stat(stagingFile(env.ctx, s.uploadId))).rejects.toThrow();
    expect((await progress(P(), s.uploadId)).body).toMatchObject({ offset: 0, complete: false });
    // Nothing reached storage, so the version cannot be closed with it.
    expect((await close(P(), s)).body.error.code).toBe('upload_missing');
    // And the right file can still be sent to the same upload.
    await send(P(), s.uploadId, 0, declared);
    expect((await finish(P(), s.uploadId)).status).toBe(200);
    expect((await close(P(), s)).status).toBe(201);
  });

  it('does not finish a file that has not all arrived', async () => {
    const s = await start(P(), 900);
    await send(P(), s.uploadId, 0, s.data.subarray(0, 400));
    const r = await finish(P(), s.uploadId);
    expect(r.status).toBe(409);
    expect(r.body.error).toMatchObject({ code: 'upload_incomplete', details: { offset: 400 } });
    expect((await close(P(), s)).body.error.code).toBe('upload_missing');
  });

  it('can be finished again after a lost answer, and then takes no more pieces', async () => {
    const s = await start(P(), 300);
    await send(P(), s.uploadId, 0, s.data);
    const a = await finish(P(), s.uploadId);
    const b = await finish(P(), s.uploadId);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(b.body.complete).toBe(true);
    const more = await send(P(), s.uploadId, 300, randomBytes(10));
    expect(more.statusCode).toBe(409);
    expect(more.json().error.code).toBe('upload_complete');
  });

  it('finishing twice at the same moment stores the file once', async () => {
    const s = await start(P(), 700);
    await send(P(), s.uploadId, 0, s.data);
    const both = await Promise.all(Array.from({ length: 6 }, () => finish(P(), s.uploadId)));
    expect(both.map((r) => r.status)).toEqual([200, 200, 200, 200, 200, 200]);
    expect((await close(P(), s)).status).toBe(201);
  });

  it('offers a finished upload again with nothing left to send, so a closed tab costs nothing', async () => {
    const s = await start(P(), 500);
    await send(P(), s.uploadId, 0, s.data);
    await finish(P(), s.uploadId);
    const again = await env.call(P(), 'POST', `/api/variants/${s.variantId}/uploads`, { files: [{ name: 'big.mp4', mime: 'video/mp4', bytes: 500, sha256: sha(s.data), resumable: true }] });
    expect(again.body.uploads[0]).toMatchObject({ uploadId: s.uploadId, resumable: { offset: 500, complete: true } });
    expect((await close(P(), s)).status).toBe(201);
    // Once used in a version it is not offered again.
    const after = await env.call(P(), 'POST', `/api/variants/${s.variantId}/uploads`, { files: [{ name: 'big.mp4', mime: 'video/mp4', bytes: 500, sha256: sha(s.data), resumable: true }] });
    expect(after.body.uploads[0].uploadId).not.toBe(s.uploadId);
    expect((await send(P(), s.uploadId, 500, randomBytes(1))).json().error.code).toBe('upload_used');
  });
});

describe('who may send, and for how long', () => {
  it('shows an upload only to the person who made it', async () => {
    const s = await start(P(), 200);
    for (const other of [env.users.admin, env.users.approver, env.users.reader]) {
      expect((await progress(other, s.uploadId)).status).toBe(404);
      expect((await send(other, s.uploadId, 0, s.data)).statusCode).toBe(404);
      expect((await finish(other, s.uploadId)).status).toBe(404);
    }
    expect((await env.call(null, 'GET', `/api/uploads/${s.uploadId}/resumable`)).status).toBe(401);
    expect((await progress(P(), s.uploadId)).status).toBe(200);
  });

  it('stops a person who lost the right to upload', async () => {
    const s = await start(P(), 200);
    await env.db.query(`update member set role = 'reader' where user_id = $1`, [P().id]);
    try {
      expect((await send(P(), s.uploadId, 0, s.data)).statusCode).toBe(403);
      expect((await progress(P(), s.uploadId)).status).toBe(403);
    } finally {
      await env.db.query(`update member set role = 'producer' where user_id = $1`, [P().id]);
    }
  });

  it('refuses an upload that was not made to be sent in pieces', async () => {
    const v = (await env.makePiece(P())).variantId;
    const r = await env.call(P(), 'POST', `/api/variants/${v}/uploads`, { files: [{ name: 'a.mp4', mime: 'video/mp4', bytes: 10, sha256: sha(Buffer.alloc(10)) }] });
    expect(r.body.uploads[0].url).toBeDefined();
    const id = r.body.uploads[0].uploadId;
    expect((await send(P(), id, 0, Buffer.alloc(10))).statusCode).toBe(400);
    expect((await progress(P(), id)).body.error.code).toBe('not_resumable');
  });

  it('keeps an upload open for a day after the last piece, and no longer', async () => {
    const s = await start(P(), 400);
    const ttl = async () => Number((await env.db.one(`select extract(epoch from expires_at - now()) as s from upload where id = $1`, [s.uploadId]))!.s);
    expect(await ttl()).toBeGreaterThan(23.9 * 3600);
    // Each piece starts the day again.
    await env.db.query(`update upload set expires_at = now() + interval '2 minutes' where id = $1`, [s.uploadId]);
    await send(P(), s.uploadId, 0, s.data.subarray(0, 100));
    expect(await ttl()).toBeGreaterThan(23.9 * 3600);
    await env.db.query(`update upload set expires_at = now() + interval '2 minutes' where id = $1`, [s.uploadId]);
    await env.call(P(), 'POST', `/api/variants/${s.variantId}/uploads`, { files: [{ name: 'big.mp4', mime: 'video/mp4', bytes: 400, sha256: sha(s.data), resumable: true }] });
    expect(await ttl()).toBeGreaterThan(23.9 * 3600);

    await env.db.query(`update upload set expires_at = now() - interval '1 second' where id = $1`, [s.uploadId]);
    for (const r of [await send(P(), s.uploadId, 100, s.data.subarray(100)), await progress(P(), s.uploadId), await finish(P(), s.uploadId)]) {
      const body = 'json' in r && typeof r.json === 'function' ? (r as any).json() : (r as any).body;
      expect(body.error.code).toBe('upload_expired');
    }
    // Choosing the file again starts a new upload instead of reviving the expired one.
    const fresh = await env.call(P(), 'POST', `/api/variants/${s.variantId}/uploads`, { files: [{ name: 'big.mp4', mime: 'video/mp4', bytes: 400, sha256: sha(s.data), resumable: true }] });
    expect(fresh.body.uploads[0].uploadId).not.toBe(s.uploadId);
    expect(fresh.body.uploads[0].resumable.offset).toBe(0);
  });

  it('works for a producer token too', async () => {
    const t = await env.call(env.users.admin, 'POST', `/api/brands/${env.brandId}/tokens`, { name: 'script' });
    expect(t.status).toBe(201);
    const bearer = t.body.token as string;
    const variantId = (await env.makePiece(P())).variantId;
    const data = randomBytes(300);
    const asToken = async (method: string, url: string, body?: unknown, headers: Record<string, string> = {}) =>
      env.app.inject({ method: method as 'GET', url, headers: { authorization: `Bearer ${bearer}`, ...headers }, payload: body as any });
    const made = await asToken('POST', `/api/variants/${variantId}/uploads`, { files: [{ name: 't.mp4', mime: 'video/mp4', bytes: 300, sha256: sha(data), resumable: true }] });
    const id = made.json().uploads[0].uploadId;
    expect((await asToken('PATCH', `/api/uploads/${id}/resumable`, data, { 'upload-offset': '0', 'content-type': PIECE })).statusCode).toBe(200);
    expect((await asToken('POST', `/api/uploads/${id}/resumable/finish`)).statusCode).toBe(200);
    // A person cannot touch the token's upload, nor the token a person's.
    expect((await progress(P(), id)).status).toBe(404);
    const mine = await start(P(), 50);
    expect((await asToken('GET', `/api/uploads/${mine.uploadId}/resumable`)).statusCode).toBe(404);

    // Nor can another token of the same brand.
    const other = await env.call(env.users.admin, 'POST', `/api/brands/${env.brandId}/tokens`, { name: 'second script' });
    const otherCall = (method: string, url: string) => env.app.inject({ method: method as 'GET', url, headers: { authorization: `Bearer ${other.body.token}` } });
    expect((await otherCall('GET', `/api/uploads/${id}/resumable`)).statusCode).toBe(404);
    expect((await otherCall('POST', `/api/uploads/${id}/resumable/finish`)).statusCode).toBe(404);
  });
});

describe('a crash between the file and the count', () => {
  it('cuts the file back to what was counted before adding the next piece', async () => {
    const s = await start(P(), 1000);
    await send(P(), s.uploadId, 0, s.data.subarray(0, 400));
    // A piece reached the disk, but the count was never saved.
    await appendFile(stagingFile(env.ctx, s.uploadId), randomBytes(250));
    expect((await send(P(), s.uploadId, 400, s.data.subarray(400))).statusCode).toBe(200);
    expect((await finish(P(), s.uploadId)).status).toBe(200);
    expect((await close(P(), s)).status).toBe(201);
  });

  it('starts over when the file has lost data the count says arrived', async () => {
    const s = await start(P(), 1000);
    await send(P(), s.uploadId, 0, s.data.subarray(0, 600));
    await writeFile(stagingFile(env.ctx, s.uploadId), s.data.subarray(0, 100));
    const r = await send(P(), s.uploadId, 600, s.data.subarray(600));
    expect(r.statusCode).toBe(409);
    expect(r.json().error.details.offset).toBe(0);
    expect((await progress(P(), s.uploadId)).body.offset).toBe(0);
    await send(P(), s.uploadId, 0, s.data);
    expect((await finish(P(), s.uploadId)).status).toBe(200);
  });

  it('starts over when the file is gone', async () => {
    const s = await start(P(), 500);
    await send(P(), s.uploadId, 0, s.data.subarray(0, 300));
    await purgeFile(s.uploadId);
    const r = await send(P(), s.uploadId, 300, s.data.subarray(300));
    expect(r.statusCode).toBe(409);
    expect(r.json().error.details.offset).toBe(0);
    const f = await finish(P(), s.uploadId);
    expect(f.status).toBe(409);
  });

  it('does not finish a file whose staging copy has gone missing, and says so plainly', async () => {
    const s = await start(P(), 500);
    await send(P(), s.uploadId, 0, s.data);
    await purgeFile(s.uploadId);
    const r = await finish(P(), s.uploadId);
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('upload_mismatch');
    expect((await progress(P(), s.uploadId)).body.offset).toBe(0);
  });

  it('does not finish a file whose staging copy has the wrong length', async () => {
    const s = await start(P(), 500);
    await send(P(), s.uploadId, 0, s.data);
    await appendFile(stagingFile(env.ctx, s.uploadId), Buffer.from('x'));
    expect((await finish(P(), s.uploadId)).body.error.code).toBe('upload_mismatch');
    expect((await progress(P(), s.uploadId)).body.offset).toBe(0);
  });

  it('hands storage the hash it checked, so a bucket can vouch for the file later', async () => {
    const s = await start(P(), 400);
    await send(P(), s.uploadId, 0, s.data);
    const calls: unknown[][] = [];
    const real = env.ctx.storage.putFile.bind(env.ctx.storage);
    env.ctx.storage.putFile = async (...args: Parameters<typeof real>) => { calls.push(args); return real(...args); };
    try {
      expect((await finish(P(), s.uploadId)).status).toBe(200);
    } finally {
      env.ctx.storage.putFile = real;
    }
    expect(calls).toHaveLength(1);
    expect(calls[0]!.slice(1)).toEqual([stagingFile(env.ctx, s.uploadId), 'video/mp4', { sha256: sha(s.data) }]);
    expect(String(calls[0]![0])).toMatch(/^brands\/.+\/big\.mp4$/);
  });

  it('does not finish a file whose staging copy is damaged', async () => {
    const s = await start(P(), 500);
    await send(P(), s.uploadId, 0, s.data);
    await writeFile(stagingFile(env.ctx, s.uploadId), randomBytes(500));
    expect((await finish(P(), s.uploadId)).body.error.code).toBe('upload_mismatch');
    expect((await progress(P(), s.uploadId)).body.offset).toBe(0);
    await writeFile(stagingFile(env.ctx, s.uploadId), s.data.subarray(0, 300));
    await send(P(), s.uploadId, 0, s.data);
    expect((await finish(P(), s.uploadId)).status).toBe(200);
  });
});

async function purgeFile(id: string) {
  const { rm } = await import('node:fs/promises');
  await rm(stagingFile(env.ctx, id), { force: true });
}

describe('clearing what nobody will finish', () => {
  const age = (file: string, minutes: number) => utimes(file, new Date(Date.now() - minutes * 60_000), new Date(Date.now() - minutes * 60_000));
  const names = async () => (await readdir(path.resolve(env.ctx.config.STAGING_DIR)).catch(() => [])).filter((n) => n.endsWith('.part'));

  it('removes the files of expired, used and unknown uploads, and keeps those still in progress', async () => {
    const live = await start(P(), 100);
    const expired = await start(P(), 100);
    const used = await start(P(), 100);
    const recent = await start(P(), 100);
    for (const s of [live, expired, used, recent]) await send(P(), s.uploadId, 0, s.data.subarray(0, 50));
    await env.db.query(`update upload set expires_at = now() - interval '1 hour' where id = $1`, [expired.uploadId]);
    await env.db.query(`update upload set consumed_at = now() where id = $1`, [used.uploadId]);
    const orphan = path.join(path.resolve(env.ctx.config.STAGING_DIR), '11111111-1111-4111-8111-111111111111.part');
    await writeFile(orphan, 'x');
    const stray = path.join(path.resolve(env.ctx.config.STAGING_DIR), 'notes.txt');
    await writeFile(stray, 'keep me');
    for (const s of [live, expired, used]) await age(stagingFile(env.ctx, s.uploadId), 30);
    await age(orphan, 30);
    await age(stray, 30);

    expect(await purgeStaging(env.ctx)).toBe(3);
    const left = await names();
    expect(left).toContain(`${live.uploadId}.part`);
    expect(left).toContain(`${recent.uploadId}.part`);
    expect(left).not.toContain(`${expired.uploadId}.part`);
    expect(left).not.toContain(`${used.uploadId}.part`);
    expect(left).not.toContain('11111111-1111-4111-8111-111111111111.part');
    expect(await readFile(stray, 'utf8')).toBe('keep me');
    // Nothing more to do the second time.
    expect(await purgeStaging(env.ctx)).toBe(0);
  });

  it('does nothing when no upload has ever been staged', async () => {
    const quiet = await createEnv();
    try {
      expect(await purgeStaging(quiet.ctx)).toBe(0);
    } finally {
      await quiet.close();
    }
  });
});

describe('what the staging disk can be asked to hold', () => {
  const pending = async () => Number((await env.db.one(
    `select coalesce(sum(bytes), 0) as n from upload where brand_id = $1 and resumable and completed_at is null and consumed_at is null and expires_at > now()`,
    [env.brandId],
  ))!.n);

  it('refuses a big file over what the brand may have waiting, and takes it once room is made', async () => {
    // The cap is configuration (STAGING_MAX_GB_PER_BRAND, in GB): set to what is waiting now plus 1000 bytes.
    const saved = env.ctx.config.STAGING_MAX_GB_PER_BRAND;
    const cap = (await pending()) + 1000;
    env.ctx.config.STAGING_MAX_GB_PER_BRAND = cap / 1024 ** 3;
    expect(maxPendingBytes(env.ctx)).toBe(cap);
    try {
      const a = await start(P(), 600);
      const data = randomBytes(600);
      const refused = await env.call(P(), 'POST', `/api/variants/${a.variantId}/uploads`, { files: [{ name: 'other.mp4', mime: 'video/mp4', bytes: 600, sha256: sha(data), resumable: true }] });
      expect(refused.status).toBe(409);
      expect(refused.body.error.code).toBe('staging_full');
      // Two files in one request count together: each would fit alone, both do not.
      const both = await env.call(P(), 'POST', `/api/variants/${a.variantId}/uploads`, {
        files: [250, 250].map((n, i) => { const d = randomBytes(n); return { name: `q${i}.mp4`, mime: 'video/mp4', bytes: n, sha256: sha(d), resumable: true }; }),
      });
      expect(both.body.error.code).toBe('staging_full');
      const two = await env.call(P(), 'POST', `/api/variants/${a.variantId}/uploads`, {
        files: [150, 200].map((n, i) => { const d = randomBytes(n); return { name: `p${i}.mp4`, mime: 'video/mp4', bytes: n, sha256: sha(d), resumable: true }; }),
      });
      expect(two.status).toBe(200);
      // Choosing the same file again resumes it: it is not counted a second time.
      expect((await env.call(P(), 'POST', `/api/variants/${a.variantId}/uploads`, { files: [{ name: 'big.mp4', mime: 'video/mp4', bytes: 600, sha256: sha(a.data), resumable: true }] })).status).toBe(200);
      // Once the first file is whole, it has left the disk for storage, and there is room again.
      expect((await send(P(), a.uploadId, 0, a.data)).statusCode).toBe(200);
      expect((await finish(P(), a.uploadId)).status).toBe(200);
      expect((await env.call(P(), 'POST', `/api/variants/${a.variantId}/uploads`, { files: [{ name: 'other.mp4', mime: 'video/mp4', bytes: 600, sha256: sha(data), resumable: true }] })).status).toBe(200);
      // A file sent straight to storage does not wait on this disk, so it is not counted.
      const direct = randomBytes(5000);
      expect((await env.call(P(), 'POST', `/api/variants/${a.variantId}/uploads`, { files: [{ name: 'd.mp4', mime: 'video/mp4', bytes: direct.length, sha256: sha(direct) }] })).status).toBe(200);
    } finally {
      env.ctx.config.STAGING_MAX_GB_PER_BRAND = saved;
    }
  });

  it('drops an unfinished upload a few days after it began, however often it is resumed', async () => {
    const s = await start(P(), 1000);
    // It began just over three days ago and has been resumed ever since.
    await env.db.query(`update upload set created_at = now() - interval '73 hours' where id = $1`, [s.uploadId]);
    expect((await send(P(), s.uploadId, 0, s.data.subarray(0, 400))).statusCode).toBe(200);
    const again = await progress(P(), s.uploadId);
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('upload_expired');
  });
});
