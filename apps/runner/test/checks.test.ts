import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { allCapabilities } from '../../api/src/connectors/registry.js';
import { PROFILES } from '../../api/src/connectors/profiles.js';
import { loadConfig as loadApiConfig } from '../../api/src/config.js';
import type { Requirements } from '../src/api.js';
import { checkOutput, coveredZonesWithDetail, loudness, type CheckFile } from '../src/checks.js';
import { parseConfig } from '../src/config.js';
import { detailBand, make } from './media.js';

const tools = { ffmpeg: 'ffmpeg', ffprobe: 'ffprobe' };
/** ffmpeg's sine source peaks at -18 dBFS; these are tones a known number of dB from that. A -20 dBFS tone reads about -23 LUFS. */
const tone = (db: number) => `sine=frequency=1000:sample_rate=48000,volume=${db}dB`;
let dir: string;

/** What the studio would say these networks accept: built from the connectors themselves, not copied. */
function requirements(networks: string[]): Requirements {
  const caps = allCapabilities(loadApiConfig({ SECRET: 'x'.repeat(40) }));
  return {
    networks: networks.map((n) => ({
      network: n,
      text: { maxChars: caps[n]!.text.maxChars },
      placements: caps[n]!.placements.map((p) => ({
        ...p,
        fileProfiles: Object.fromEntries(Object.entries(p.profiles).map(([kind, id]) => [kind, PROFILES[id as string] ?? null])),
      })) as Requirements['networks'][number]['placements'],
    })),
    approval_checklist: [],
  };
}
const cfg = (o: Record<string, unknown> = {}) =>
  parseConfig({ workspaceRoot: '/w', brands: { a: { api: 'https://s.example', token: 'est_0123456789', webhookSecret: 'whsec_0123456789', agent: { command: ['x'] }, checks: o } } }, '/x', {}).brands.a!.checks;
const video = (p: string): CheckFile => ({ path: p, kind: 'video', position: 0 });
const image = (p: string): CheckFile => ({ path: p, kind: 'image', position: 0 });
const codes = (r: { warnings: { code: string }[] }) => r.warnings.map((w) => w.code).sort();

beforeAll(() => { dir = mkdtempSync(path.join(tmpdir(), 'runner-checks-')); });
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('loudness', () => {
  it('measures what a known tone sounds like', async () => {
    const quiet = make(dir, 'tone-20.mp4', { src: 'testsrc2=s=360x640:r=25', audio: tone(-2), seconds: 6 });
    const loud = make(dir, 'tone-3.mp4', { src: 'testsrc2=s=360x640:r=25', audio: tone(18), seconds: 6 });
    const q = await loudness(tools, quiet);
    const l = await loudness(tools, loud);
    expect(q.lufs).toBeGreaterThan(-24.5);
    expect(q.lufs).toBeLessThan(-21);
    expect(l.lufs! - q.lufs!).toBeGreaterThan(19); // 20 dB louder, give or take the filter
    expect(l.truePeak).toBeGreaterThan(-1);
    expect(q.truePeak).toBeLessThan(-18);
  });

  it('reads silence as no loudness at all', async () => {
    const silent = make(dir, 'silent.mp4', { src: 'testsrc2=s=360x640:r=25', audio: 'anullsrc=r=48000:cl=stereo', seconds: 3 });
    expect((await loudness(tools, silent)).lufs).toBeNull();
  });
});

describe('the checks on a video', () => {
  const both = requirements(['instagram', 'youtube']);

  it('passes a file that suits the networks, and says which placements it fits and how loud it is', async () => {
    const f = make(dir, 'good.mp4', { src: detailBand('1080x1920', 'none'), audio: tone(6), seconds: 5 });
    const r = await checkOutput([video(f)], both, cfg(), tools);
    expect(r.errors).toEqual([]);
    expect(r.warnings.map((w) => w.message)).toEqual([]);
    expect(r.summary[0]).toMatch(/good\.mp4: fits Instagram Reel.*YouTube/);
    expect(r.summary.join('\n')).toMatch(/loudness -?\d+\.\d LUFS/);
    expect(r.summary.at(-1)).toBe('no problems found');
  });

  it('warns about loudness outside the range, and a peak that will distort', async () => {
    const quiet = make(dir, 'quiet.mp4', { src: detailBand('1080x1920', 'none'), audio: tone(-22), seconds: 4 });
    const loud = make(dir, 'loud.mp4', { src: detailBand('1080x1920', 'none'), audio: tone(18), seconds: 4 });
    expect(codes(await checkOutput([video(quiet)], both, cfg(), tools))).toEqual(['loudness']);
    expect(codes(await checkOutput([video(loud)], both, cfg(), tools))).toEqual(['loudness', 'true_peak']);
    // The range is the brand's to set.
    expect(codes(await checkOutput([video(quiet)], both, cfg({ loudness: { min: -60, max: -9 } }), tools))).toEqual([]);
  });

  it('notes a missing audio track, and warns about an audio track with nothing in it', async () => {
    const none = make(dir, 'noaudio.mp4', { src: detailBand('1080x1920', 'none'), seconds: 4 });
    const silent = make(dir, 'silent2.mp4', { src: detailBand('1080x1920', 'none'), audio: 'anullsrc=r=48000:cl=stereo', seconds: 4 });
    const a = await checkOutput([video(none)], both, cfg(), tools);
    expect(a.warnings).toEqual([]);
    expect(a.summary.join('\n')).toContain('no audio track');
    expect(codes(await checkOutput([video(silent)], both, cfg(), tools))).toEqual(['silent']);
  });

  it('warns about resolution and weight the publisher will fix by converting, and says so', async () => {
    const large = make(dir, 'large.mp4', { src: detailBand('1440x2560', 'none'), audio: tone(6), seconds: 3 });
    const r = await checkOutput([video(large)], both, cfg(), tools);
    expect(r.errors).toEqual([]);
    expect(r.warnings.some((w) => w.code === 'large' && /larger than Instagram Reel takes \(1080×1920\).*scaled down/.test(w.message))).toBe(true);
    const small = make(dir, 'small.mp4', { src: detailBand('360x640', 'none'), audio: tone(6), seconds: 3 });
    expect(codes(await checkOutput([video(small)], both, cfg(), tools))).toContain('low_resolution');
    expect(codes(await checkOutput([video(small)], both, cfg({ minShortSide: 300 }), tools))).not.toContain('low_resolution');
  });

  it('warns when the shape is allowed but not what the network is made for', async () => {
    const square = make(dir, 'square.mp4', { src: detailBand('1080x1080', 'none'), audio: tone(6), seconds: 3 });
    const r = await checkOutput([video(square)], both, cfg(), tools);
    expect(r.errors).toEqual([]);
    expect(r.warnings.some((w) => w.code === 'aspect' && /looks right/.test(w.message))).toBe(true);
  });

  it('is an error when no network of the brand can publish the file', async () => {
    // Under a second: no Instagram placement takes it, and the brand has only Instagram.
    const blink = make(dir, 'blink.mp4', { src: detailBand('1080x1920', 'none'), audio: tone(6), seconds: 0.5 });
    const r = await checkOutput([video(blink)], requirements(['instagram']), cfg(), tools);
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]).toMatchObject({ code: 'no_network' });
    expect(r.errors[0]!.message).toMatch(/Reel takes 3–900 seconds and this is 0\.\d/);
    // With YouTube as well, the file can go out somewhere: Instagram is a warning.
    const mixed = await checkOutput([video(blink)], both, cfg(), tools);
    expect(mixed.errors).toEqual([]);
    expect(mixed.warnings.some((w) => w.code === 'network_cannot_publish' && /Instagram cannot publish/.test(w.message))).toBe(true);
  });

  it('is an error when a network the brand requires cannot publish it', async () => {
    const blink = make(dir, 'blink2.mp4', { src: detailBand('1080x1920', 'none'), audio: tone(6), seconds: 0.5 });
    const r = await checkOutput([video(blink)], both, cfg({ requireNetworks: ['instagram'] }), tools);
    expect(r.errors.map((e) => e.code)).toEqual(['network_cannot_publish']);
    const missing = await checkOutput([video(blink)], both, cfg({ requireNetworks: ['tiktok'] }), tools);
    expect(missing.errors.some((e) => e.code === 'unknown_network')).toBe(true);
  });

  it('is an error for a file that cannot be read', async () => {
    const r = await checkOutput([video(path.join(dir, 'does-not-exist.mp4'))], both, cfg(), tools);
    expect(r.errors[0]).toMatchObject({ code: 'unreadable' });
  });
});

describe('the checks on an image', () => {
  it('fits a feed photo, and an image of the wrong shape is refused by the network that cannot take it', async () => {
    const feed = make(dir, 'feed.png', { src: detailBand('1080x1350', 'none') });
    const wide = make(dir, 'wide.png', { src: detailBand('6000x500', 'none') });
    const r = await checkOutput([image(feed)], requirements(['instagram', 'facebook']), cfg(), tools);
    expect(r.errors).toEqual([]);
    expect(r.summary[0]).toMatch(/fits Instagram Feed photo, Facebook Photo post/);
    const w = await checkOutput([image(wide)], requirements(['instagram']), cfg(), tools);
    expect(w.errors[0]).toMatchObject({ code: 'no_network' });
    expect(w.errors[0]!.message).toMatch(/aspect ratio of .*and this is 12\.00/);
    const mixed = await checkOutput([image(wide)], requirements(['instagram', 'facebook']), cfg(), tools);
    expect(mixed.errors).toEqual([]); // Facebook takes any shape
  });
});

describe('detail under the covered areas', () => {
  const zones = { top: 0.1, bottom: 0.2, left: 0.05, right: 0.15 };
  const frame = (w: number, h: number, f: (x: number, y: number) => number) => {
    const px = Buffer.alloc(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) px[y * w + x] = Math.max(0, Math.min(255, Math.round(f(x, y))));
    return { w, h, px };
  };
  const smooth = (x: number) => 40 + (x * 60) / 180;
  const stripes = (x: number) => 128 + 100 * Math.sin(x * 1.2);

  it('flags fine detail in a covered band and nothing else', () => {
    const bottom = frame(180, 320, (x, y) => (y > 320 * 0.88 ? stripes(x) : smooth(x)));
    const middle = frame(180, 320, (x, y) => (y > 320 * 0.45 && y < 320 * 0.55 ? stripes(x) : smooth(x)));
    const everywhere = frame(180, 320, (x) => stripes(x));
    const plain = frame(180, 320, (x) => smooth(x));
    expect(coveredZonesWithDetail([bottom, bottom, bottom], zones)).toEqual(['bottom']);
    expect(coveredZonesWithDetail([middle, middle, middle], zones)).toEqual([]); // in the part nobody covers
    expect(coveredZonesWithDetail([everywhere, everywhere, everywhere], zones)).toEqual([]); // busy all over: no more than the rest
    expect(coveredZonesWithDetail([plain, plain], zones)).toEqual([]);
  });

  it('wants it in more than one sampled frame, so a flash does not count', () => {
    const bottom = frame(180, 320, (x, y) => (y > 320 * 0.88 ? stripes(x) : smooth(x)));
    const plain = frame(180, 320, (x) => smooth(x));
    expect(coveredZonesWithDetail([bottom, plain, plain, plain, plain], zones)).toEqual([]);
    expect(coveredZonesWithDetail([bottom, bottom, plain, plain, plain], zones)).toEqual(['bottom']);
    expect(coveredZonesWithDetail([bottom], zones)).toEqual(['bottom']); // an image is one frame
  });

  it('works on real files, naming the network and the part of the frame', async () => {
    const reqs = requirements(['instagram']);
    const text = make(dir, 'caption-low.mp4', { src: detailBand('1080x1920', 'bottom'), audio: tone(6), seconds: 5 });
    const fine = make(dir, 'caption-mid.mp4', { src: detailBand('1080x1920', 'middle'), audio: tone(6), seconds: 5 });
    const a = await checkOutput([video(text)], reqs, cfg(), tools);
    expect(a.errors).toEqual([]);
    expect(a.warnings.filter((w) => w.code === 'covered_zone').map((w) => w.message)).toEqual([
      expect.stringMatching(/under the bottom of Instagram (Reel|Story)/),
      expect.stringMatching(/under the bottom of Instagram (Reel|Story)/),
    ].slice(0, a.warnings.filter((w) => w.code === 'covered_zone').length));
    expect(a.warnings.some((w) => w.code === 'covered_zone')).toBe(true);
    const b = await checkOutput([video(fine)], reqs, cfg(), tools);
    expect(b.warnings.some((w) => w.code === 'covered_zone')).toBe(false);
    const off = await checkOutput([video(text)], reqs, cfg({ coveredZones: 'off' }), tools);
    expect(off.warnings.some((w) => w.code === 'covered_zone')).toBe(false);
  });
});
