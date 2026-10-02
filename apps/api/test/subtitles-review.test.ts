import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createEnv, type Env } from './helpers.js';

let env: Env;
beforeAll(async () => { env = await createEnv(); });
afterAll(async () => { await env.close(); });

const VTT = `WEBVTT

00:00:01.000 --> 00:00:03.000
Welcome to the <i>spring</i> menu

00:00:03.500 --> 00:00:05.000
Our flat white is back
`;
const SRT = '1\n00:00:01,000 --> 00:00:02,000\nUno\n\n2\n00:00:02,500 --> 00:00:04,000\nDos\n';

/** A version with a video and the given subtitle files. */
async function withSubtitles(files: { data: Buffer | string; mime?: string; name?: string }[]) {
  const { variantId, pieceId } = await env.makePiece(env.users.producer, 'video', '9:16');
  const specs = [
    { name: 'reel.mp4', mime: 'video/mp4', kind: 'video', position: 0 },
    ...files.map((f, i) => ({ name: f.name ?? `subs-${i}.vtt`, mime: f.mime ?? 'text/vtt', kind: 'subtitles', position: i, data: Buffer.from(f.data) })),
  ];
  const v = await env.newVersion(env.users.producer, variantId, specs);
  expect(v.status, JSON.stringify(v.body)).toBe(201);
  return { versionId: v.body.id as string, pieceId };
}
const comment = (versionId: string, anchor: unknown, body = 'Check this line') => env.call(env.users.reviewer, 'POST', `/api/versions/${versionId}/comments`, { body, anchor });

describe('reading the subtitles of a version', () => {
  it('lists each file with its lines, times and words, for anyone who can see the version', async () => {
    const { versionId } = await withSubtitles([{ data: VTT }, { data: SRT, mime: 'application/x-subrip', name: 'es.srt' }]);
    for (const who of [env.users.reader, env.users.reviewer, env.users.producer, env.users.admin]) {
      const r = await env.call(who, 'GET', `/api/versions/${versionId}/subtitles`);
      expect(r.status).toBe(200);
      expect(r.body.tracks).toHaveLength(2);
    }
    const r = (await env.call(env.users.reader, 'GET', `/api/versions/${versionId}/subtitles`)).body;
    expect(r.tracks[0]).toMatchObject({ position: 0, name: 'subs-0.vtt', skipped: 0, truncated: false });
    expect(r.tracks[0].cues).toEqual([
      { index: 0, start: 1, end: 3, text: 'Welcome to the spring menu' },
      { index: 1, start: 3.5, end: 5, text: 'Our flat white is back' },
    ]);
    expect(r.tracks[1]).toMatchObject({ position: 1, name: 'es.srt' });
    expect(r.tracks[1].cues.map((c: { text: string }) => c.text)).toEqual(['Uno', 'Dos']);
    expect(r.tracks[0].problem).toBeUndefined();
  });

  it('says so when a file has no readable lines, or is too large to be subtitles, instead of failing', async () => {
    const { versionId } = await withSubtitles([{ data: 'this is not a subtitle file at all' }, { data: Buffer.alloc(2_100_000, 65), name: 'huge.vtt' }]);
    const r = (await env.call(env.users.reader, 'GET', `/api/versions/${versionId}/subtitles`)).body;
    expect(r.tracks[0]).toMatchObject({ cues: [], problem: 'No subtitle lines could be read from this file' });
    expect(r.tracks[1]).toMatchObject({ cues: [], problem: 'This file is too large to be subtitles' });
  });

  it('says so when the file has gone from storage, instead of failing', async () => {
    const { rm } = await import('node:fs/promises');
    const { LocalStorage } = await import('../src/storage/index.js');
    const { versionId } = await withSubtitles([{ data: VTT }]);
    const key = (await env.db.one<{ storage_key: string }>(`select storage_key from asset where version_id = $1 and kind = 'subtitles'`, [versionId]))!.storage_key;
    await rm((env.ctx.storage as InstanceType<typeof LocalStorage>).localPath(key));
    const r = await env.call(env.users.reader, 'GET', `/api/versions/${versionId}/subtitles`);
    expect(r.status).toBe(200);
    expect(r.body.tracks[0]).toMatchObject({ cues: [], problem: 'The file could not be found' });
    expect((await comment(versionId, { type: 'time', t: 1, cue: 0 })).status).toBe(400);
  });

  it('gives an empty list for a version with none, and is closed to people outside the brand and to the signed-out', async () => {
    const { variantId } = await env.makePiece(env.users.producer, 'video', '9:16');
    const v = await env.newVersion(env.users.producer, variantId, [{ name: 'reel.mp4', mime: 'video/mp4', kind: 'video', position: 0 }]);
    expect((await env.call(env.users.reader, 'GET', `/api/versions/${v.body.id}/subtitles`)).body).toEqual({ tracks: [] });
    expect((await env.call(null, 'GET', `/api/versions/${v.body.id}/subtitles`)).status).toBe(401);
    const w = (await env.db.one<{ id: string }>('select id from workspace limit 1'))!;
    const other = (await env.db.one<{ id: string }>(`insert into brand (workspace_id, name, timezone) values ($1,'Another','Europe/Madrid') returning id`, [w.id]))!;
    const u = (await env.db.one<{ id: string }>(`insert into app_user (email) values ('outsider@example.com') returning id`))!;
    await env.db.query(`insert into member (user_id, brand_id, role) values ($1,$2,'admin')`, [u.id, other.id]);
    const { randomBytes, createHash } = await import('node:crypto');
    const token = randomBytes(24).toString('base64url');
    await env.db.query(`insert into session (token_hash, user_id, expires_at) values ($1,$2, now() + interval '1 day')`, [createHash('sha256').update(token).digest('hex'), u.id]);
    expect((await env.call({ id: u.id, email: 'outsider@example.com', cookie: `sid=${token}` }, 'GET', `/api/versions/${v.body.id}/subtitles`)).status).toBe(404);
  });
});

describe('commenting on one line', () => {
  it('stores the line\'s own times and words, whatever the sender claimed, and a frame from where it starts', async () => {
    const { versionId } = await withSubtitles([{ data: VTT }]);
    const r = await comment(versionId, { type: 'time', t: 99, t_end: 100, cue: 1, text: 'forged' } as never);
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.anchor).toEqual({ type: 'time', t: 3.5, t_end: 5, track: 0, cue: 1, cue_text: 'Our flat white is back' });
    expect(r.body.frame_key).toBeTruthy();
    const listed = (await env.call(env.users.reviewer, 'GET', `/api/versions/${versionId}/comments`)).body;
    expect(listed[0].anchor).toMatchObject({ cue: 1, cue_text: 'Our flat white is back', t: 3.5, t_end: 5 });
  });

  it('can name the file by its position, and a video of a carousel by its own', async () => {
    const { versionId } = await withSubtitles([{ data: VTT }, { data: SRT, mime: 'application/x-subrip', name: 'es.srt' }]);
    const r = await comment(versionId, { type: 'time', t: 0, track: 1, cue: 0, position: 0 });
    expect(r.status).toBe(201);
    expect(r.body.anchor).toEqual({ type: 'time', t: 1, t_end: 2, position: 0, track: 1, cue: 0, cue_text: 'Uno' });
  });

  it('stores the words of the file even when the sender sends words of their own for that line', async () => {
    const { versionId } = await withSubtitles([{ data: VTT }]);
    const r = await comment(versionId, { type: 'time', t: 1, cue: 0, cue_text: 'words nobody said' });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.anchor.cue_text).toBe('Welcome to the spring menu');
  });

  it('finds the file by the position it was uploaded at, not by its order or the first one that is high enough', async () => {
    // The files are sent in the order 2, 1: asking for 1 must not give the one that was stored first.
    const { variantId } = await env.makePiece(env.users.producer, 'video', '9:16');
    const v = await env.newVersion(env.users.producer, variantId, [
      { name: 'reel.mp4', mime: 'video/mp4', kind: 'video', position: 0 },
      { name: 'two.vtt', mime: 'text/vtt', kind: 'subtitles', position: 2, data: Buffer.from('WEBVTT\n\n00:01.000 --> 00:02.000\nfrom file two') },
      { name: 'one.vtt', mime: 'text/vtt', kind: 'subtitles', position: 1, data: Buffer.from('WEBVTT\n\n00:01.000 --> 00:02.000\nfrom file one') },
    ]);
    expect(v.status, JSON.stringify(v.body)).toBe(201);
    expect((await comment(v.body.id, { type: 'time', t: 1, track: 1, cue: 0 })).body.anchor).toMatchObject({ track: 1, cue_text: 'from file one' });
    expect((await comment(v.body.id, { type: 'time', t: 1, track: 2, cue: 0 })).body.anchor).toMatchObject({ track: 2, cue_text: 'from file two' });
    // Nothing was uploaded at position 0, so naming no file (the first) finds nothing, rather than another file.
    expect((await comment(v.body.id, { type: 'time', t: 1, cue: 0 })).status).toBe(400);
  });

  it('refuses a line that is not in the file, a file that is not there, and a version with no subtitles', async () => {
    const { versionId } = await withSubtitles([{ data: VTT }]);
    expect((await comment(versionId, { type: 'time', t: 1, cue: 2 })).status).toBe(400);
    expect((await comment(versionId, { type: 'time', t: 1, cue: 0, track: 5 })).status).toBe(400);
    const { versionId: bare } = await (async () => {
      const { variantId } = await env.makePiece(env.users.producer, 'video', '9:16');
      const v = await env.newVersion(env.users.producer, variantId, [{ name: 'reel.mp4', mime: 'video/mp4', kind: 'video', position: 0 }]);
      return { versionId: v.body.id as string };
    })();
    const r = await comment(bare, { type: 'time', t: 1, cue: 0 });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('invalid_anchor');
    expect((await env.call(env.users.reviewer, 'GET', `/api/versions/${versionId}/comments`)).body).toHaveLength(0);
  });

  it('refuses a line that comes after the end of the video (the stand-in video lasts ten seconds)', async () => {
    const { versionId } = await withSubtitles([{ data: 'WEBVTT\n\n00:00:02.000 --> 00:00:03.000\nin\n\n00:00:30.000 --> 00:00:31.000\nafter the end' }]);
    expect((await comment(versionId, { type: 'time', t: 0, cue: 0 })).status).toBe(201);
    const r = await comment(versionId, { type: 'time', t: 0, cue: 1 });
    expect(r.status).toBe(400);
    expect(r.body.error.message).toMatch(/after the end of the video/);
  });

  it('refuses the extras of a subtitle comment when no line is named, so nobody can attach words the file does not have', async () => {
    const { versionId } = await withSubtitles([{ data: VTT }]);
    expect((await comment(versionId, { type: 'time', t: 1, cue_text: 'made up' })).status).toBe(400);
    expect((await comment(versionId, { type: 'time', t: 1, track: 0 })).status).toBe(400);
    // An ordinary moment comment is as before.
    const plain = await comment(versionId, { type: 'time', t: 1.2 });
    expect(plain.status).toBe(201);
    expect(plain.body.anchor).toEqual({ type: 'time', t: 1.2 });
  });

  it('refuses a line of a file that cannot be read', async () => {
    const { versionId } = await withSubtitles([{ data: 'nothing here' }]);
    expect((await comment(versionId, { type: 'time', t: 0, cue: 0 })).status).toBe(400);
  });
});
