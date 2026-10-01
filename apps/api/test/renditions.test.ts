import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PROFILES, profileOf, type ImageProfile, type VideoProfile } from '../src/connectors/profiles.js';
import { ConnectorError } from '../src/connectors/types.js';
import { videoArgs } from '../src/media/ffmpeg.js';
import { fileFor, imageMismatches, videoMismatches } from '../src/services/renditions.js';
import { LocalStorage } from '../src/storage/index.js';
import { createEnv, type Env } from './helpers.js';

// These run the real ffmpeg and ffprobe on real (small) files.
let env: Env;
let dir: string;
beforeAll(async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'estudio-media-test-'));
  env = await createEnv({}, { fakes: true, realMedia: true });
});
afterAll(async () => {
  await env.close();
  rmSync(dir, { recursive: true, force: true });
});

function ffmpeg(args: string[], out: string): Buffer {
  const file = path.join(dir, out);
  const r = spawnSync('ffmpeg', ['-v', 'error', '-y', ...args, file], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`ffmpeg failed: ${r.stderr}`);
  return readFileSync(file);
}
const lavfi = (spec: string) => ['-f', 'lavfi', '-i', spec];
const sine = ['-f', 'lavfi', '-i', 'sine=frequency=440'];

async function assetOf(name: string, mime: string, kind: 'video' | 'image', data: Buffer, pieceKind = 'video', format = '9:16') {
  const { users, makePiece, newVersion, db } = env;
  const { variantId } = await makePiece(users.producer, pieceKind, format);
  const v = await newVersion(users.producer, variantId, [{ name, mime, kind, data }]);
  expect(v.status, JSON.stringify(v.body)).toBe(201);
  return (await db.one('select * from asset where version_id = $1 and kind = $2', [v.body.id, kind]))!;
}

const probe = (key: string) => env.ctx.media.probe((env.ctx.storage as LocalStorage).localPath(key));
const brand = () => env.brandId;

describe('deciding whether a file fits', () => {
  const ig = profileOf('ig-reel') as VideoProfile;
  const fits = { width: 1080, height: 1920, durationMs: 5000, fps: 30, videoCodec: 'h264', audioCodec: 'aac', pixFmt: 'yuv420p', mp4: true, videoKbps: 4000 };
  it('accepts a file that already fits', () => {
    expect(videoMismatches(fits, 1_000_000, ig)).toEqual([]);
  });
  it('says what is wrong, one reason per problem', () => {
    const reasons = videoMismatches({ ...fits, mp4: false, videoCodec: 'vp9', audioCodec: 'opus', pixFmt: 'yuv444p', width: 2160, height: 3840, fps: 120, videoKbps: 90_000 }, 900 * 1024 * 1024, ig);
    expect(reasons).toHaveLength(8);
    expect(reasons.join(' | ')).toMatch(/not MP4.*vp9.*opus.*yuv444p.*larger than 1080.*above 60 fps.*bitrate.*size limit/);
  });
  it('treats a silent video as fine', () => {
    expect(videoMismatches({ ...fits, audioCodec: null, hasAudio: false }, 1000, ig)).toEqual([]);
  });
  it('holds images to JPEG, width and size', () => {
    const p = profileOf('ig-feed-image') as ImageProfile;
    expect(imageMismatches({ width: 1080, height: 1350, durationMs: null, fps: null }, 'image/jpeg', 100_000, p)).toEqual([]);
    expect(imageMismatches({ width: 3000, height: 2000, durationMs: null, fps: null }, 'image/png', 20_000_000, p)).toHaveLength(3);
  });
  it('every profile named by a connector exists', () => {
    for (const id of ['ig-reel', 'ig-story-video', 'ig-feed-image', 'ig-story-image', 'fb-video', 'fb-reel', 'fb-photo', 'yt-video']) expect(PROFILES[id]).toBeDefined();
  });
  it('asks ffmpeg to shrink, never enlarge, keep the shape and cap the frame rate', () => {
    const args = videoArgs('in.webm', 'out.mp4', ig, { width: 2160, height: 3840, durationMs: 1, fps: 100 }).join(' ');
    expect(args).toContain("scale=w='min(iw,1080)':h='min(ih,1920)':force_original_aspect_ratio=decrease:force_divisible_by=2");
    expect(args).toContain('-r 60');
    expect(videoArgs('in.mp4', 'out.mp4', ig, { width: 540, height: 960, durationMs: 1, fps: 30 }).join(' ')).not.toContain('-r ');
  });
});

describe('making a copy that fits, with the real ffmpeg', () => {
  it('converts a WebM to H.264/AAC MP4 and keeps it for next time', async () => {
    const data = ffmpeg([...lavfi('testsrc2=size=540x960:rate=30'), ...sine, '-t', '2', '-c:v', 'libvpx-vp9', '-c:a', 'libvorbis', '-shortest'], 'a.webm');
    const asset = await assetOf('a.webm', 'video/webm', 'video', data);
    const p = profileOf('ig-reel');
    const first = await fileFor(env.ctx, brand(), asset, p);
    expect(first).toMatchObject({ transcoded: true, mime: 'video/mp4' });
    expect(first.reasons.join(' ')).toMatch(/not MP4/);
    expect(first.key).toContain(`/renditions/${asset.id}/ig-reel.mp4`);
    const out = await probe(first.key);
    expect(out).toMatchObject({ videoCodec: 'h264', audioCodec: 'aac', pixFmt: 'yuv420p', mp4: true, width: 540, height: 960 });
    expect(out.durationMs).toBeGreaterThan(1800);
    expect(out.durationMs).toBeLessThan(2400);
    expect(first.sha256).toMatch(/^[0-9a-f]{64}$/);
    // The stored bytes are the ones the hash describes.
    const stat = await env.ctx.storage.stat(first.key);
    expect(stat).toEqual({ bytes: first.bytes, sha256: first.sha256 });

    const second = await fileFor(env.ctx, brand(), asset, p);
    expect(second.key).toBe(first.key);
    expect(second.sha256).toBe(first.sha256);
    expect((await env.db.query('select 1 from rendition where asset_id = $1', [asset.id]))).toHaveLength(1);
  });

  it('sends a file that already fits as it is, without converting it', async () => {
    const data = ffmpeg([...lavfi('testsrc2=size=540x960:rate=30'), ...sine, '-t', '1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-movflags', '+faststart', '-shortest'], 'fits.mp4');
    const asset = await assetOf('fits.mp4', 'video/mp4', 'video', data);
    const f = await fileFor(env.ctx, brand(), asset, profileOf('ig-reel'));
    expect(f).toMatchObject({ transcoded: false, key: asset.storage_key, sha256: asset.sha256, reasons: [] });
    expect((await env.db.query('select 1 from rendition where asset_id = $1', [asset.id]))).toHaveLength(0);
  });

  it('shrinks a 4K video to fit, keeping its shape', async () => {
    const data = ffmpeg([...lavfi('testsrc2=size=2160x3840:rate=10'), '-t', '1', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p'], 'big.mp4');
    const asset = await assetOf('big.mp4', 'video/mp4', 'video', data);
    const f = await fileFor(env.ctx, brand(), asset, profileOf('ig-reel'));
    expect(f.transcoded).toBe(true);
    expect(f.reasons.join(' ')).toMatch(/larger than 1080/);
    expect([f.width, f.height]).toEqual([1080, 1920]);
  });

  it('caps the frame rate', async () => {
    const data = ffmpeg([...lavfi('testsrc2=size=360x640:rate=100'), '-t', '1', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p'], 'fast.mp4');
    const asset = await assetOf('fast.mp4', 'video/mp4', 'video', data);
    const f = await fileFor(env.ctx, brand(), asset, profileOf('ig-reel'));
    expect(f.reasons.join(' ')).toMatch(/fps/);
    expect((await probe(f.key)).fps).toBeLessThanOrEqual(60);
  });

  it('turns a PNG into a JPEG and shrinks a wide image, but leaves a good JPEG alone', async () => {
    const png = ffmpeg([...lavfi('testsrc2=size=3000x2000'), '-frames:v', '1'], 'wide.png');
    const a1 = await assetOf('wide.png', 'image/png', 'image', png, 'post', '4:5');
    const f1 = await fileFor(env.ctx, brand(), a1, profileOf('ig-feed-image'));
    expect(f1).toMatchObject({ transcoded: true, mime: 'image/jpeg', width: 1440, height: 960 });
    expect(readFileSync((env.ctx.storage as LocalStorage).localPath(f1.key)).subarray(0, 2).toString('hex')).toBe('ffd8'); // a real JPEG

    const jpg = ffmpeg([...lavfi('testsrc2=size=1080x1350'), '-frames:v', '1', '-q:v', '3'], 'ok.jpg');
    const a2 = await assetOf('ok.jpg', 'image/jpeg', 'image', jpg, 'post', '4:5');
    expect(await fileFor(env.ctx, brand(), a2, profileOf('ig-feed-image'))).toMatchObject({ transcoded: false, key: a2.storage_key });
  });

  it('says a file is unusable when ffmpeg cannot read it, as a rejection that will not be retried', async () => {
    const asset = await assetOf('broken.mp4', 'video/mp4', 'video', randomBytes(5000));
    await expect(fileFor(env.ctx, brand(), asset, profileOf('ig-reel'))).rejects.toMatchObject({ errorClass: 'file_rejected' });
    await expect(fileFor(env.ctx, brand(), asset, profileOf('ig-reel'))).rejects.toBeInstanceOf(ConnectorError);
  });
});

describe('the whole pipeline with real media', () => {
  it('publishes an Instagram Reel from a WebM: converted, uploaded as a URL Meta can fetch, verified', async () => {
    const { users, call, makePiece, newVersion, approve } = env;
    const ig = await env.connect('instagram', { externalId: '2222', name: '@real.media', token: 'page-token-2222', providerData: { igUserId: '2222', pageId: '1111' } });
    env.meta.pages.push({ id: '1111', name: 'Real media page', token: 'page-token-2222', ig: { id: '2222', username: 'real.media' } });
    const data = ffmpeg([...lavfi('testsrc2=size=540x960:rate=30'), ...sine, '-t', '3', '-c:v', 'libvpx-vp9', '-c:a', 'libvorbis', '-shortest'], 'pipeline.webm');
    const { variantId } = await makePiece(users.producer, 'video', '9:16');
    const v = await newVersion(users.producer, variantId, [{ name: 'pipeline.webm', mime: 'video/webm', kind: 'video', data }]);
    await approve(users.approver, v.body.id, [ig]);
    const when = new Date(env.clock.now().getTime() + 3600_000);
    const pub = await call(users.approver, 'POST', `/api/versions/${v.body.id}/publications`, { accountId: ig, scheduledAt: when.toISOString(), text: 'Real files, real ffmpeg' });
    expect(pub.status, JSON.stringify(pub.body)).toBe(201);
    expect(pub.body.manual).toBe(false);

    env.clock.set(new Date(pub.body.prepare_at));
    await env.settle();
    env.clock.advance(11_000);
    await env.settle();
    const sent = env.meta.callsTo(/^2222\/media$/, 'POST')[0]!.body;
    expect(sent.video_url).toContain('/renditions/');
    expect(sent.video_url).toContain('ig-reel.mp4');
    const rend = (await env.db.one('select * from rendition where profile = $1 order by created_at desc limit 1', ['ig-reel']))!;
    expect(await probe(rend.storage_key)).toMatchObject({ videoCodec: 'h264', mp4: true });

    env.clock.set(when);
    await env.settle();
    expect(await env.db.one('select status, visibility from publication where id = $1', [pub.body.id])).toMatchObject({ status: 'published', visibility: 'public' });
  });
});
