import { spawn } from 'node:child_process';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import type { Brand } from './config.js';
import type { Requirements } from './api.js';

export interface Issue {
  severity: 'error' | 'warning';
  code: string;
  message: string;
  file?: string;
}

export interface CheckResult {
  errors: Issue[];
  warnings: Issue[];
  /** One line each, for the version notes and the studio's run history. */
  summary: string[];
}

export interface CheckFile {
  path: string;
  kind: string;
  position: number;
}

export interface Tools {
  ffmpeg: string;
  ffprobe: string;
}

interface Facts {
  width: number | null;
  height: number | null;
  fps: number | null;
  durationSec: number | null;
  bytes: number;
  hasAudio: boolean;
}

type Placement = Requirements['networks'][number]['placements'][number];

function run(cmd: string, args: string[], timeoutMs = 120_000): Promise<{ code: number | null; stdout: Buffer; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const out: Buffer[] = [];
    let err = '';
    child.stdout.on('data', (c: Buffer) => out.push(c));
    child.stderr.on('data', (c: Buffer) => { err = (err + c.toString('utf8')).slice(-200_000); });
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.on('error', (e) => { clearTimeout(timer); reject(new Error(`Could not run ${cmd}: ${e.message}`)); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, stdout: Buffer.concat(out), stderr: err }); });
  });
}

async function probe(tools: Tools, file: string): Promise<Facts> {
  const r = await run(tools.ffprobe, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file]);
  if (r.code !== 0) throw new Error(`ffprobe could not read ${path.basename(file)}`);
  const j = JSON.parse(r.stdout.toString('utf8')) as { streams?: any[]; format?: { duration?: string } };
  const v = (j.streams ?? []).find((s) => s.codec_type === 'video');
  const fpsRaw = v?.avg_frame_rate && v.avg_frame_rate !== '0/0' ? v.avg_frame_rate : v?.r_frame_rate;
  let fps: number | null = null;
  if (typeof fpsRaw === 'string' && fpsRaw.includes('/')) {
    const [a, b] = fpsRaw.split('/').map(Number);
    if (a && b) fps = a / b;
  }
  const dur = Number(j.format?.duration ?? v?.duration);
  return {
    width: v?.width ?? null, height: v?.height ?? null, fps, durationSec: Number.isFinite(dur) && dur > 0 ? dur : null,
    bytes: (await stat(file)).size, hasAudio: (j.streams ?? []).some((s) => s.codec_type === 'audio'),
  };
}

/** Integrated loudness (LUFS) and true peak (dBTP), read with ffmpeg's EBU R128 filter. */
export async function loudness(tools: Tools, file: string): Promise<{ lufs: number | null; truePeak: number | null }> {
  const r = await run(tools.ffmpeg, ['-hide_banner', '-nostats', '-i', file, '-vn', '-filter_complex', 'ebur128=peak=true', '-f', 'null', '-']);
  const tail = r.stderr.slice(r.stderr.lastIndexOf('Summary:'));
  const num = (re: RegExp) => {
    const m = re.exec(tail);
    return m && m[1] !== '-inf' ? Number(m[1]) : null;
  };
  const lufs = num(/\bI:\s+(-?\d+(?:\.\d+)?|-inf)\s+LUFS/);
  // The measurement bottoms out at -70 LUFS (its absolute gate): that is what silence reads as.
  return { lufs: lufs !== null && lufs <= -69.5 ? null : lufs, truePeak: num(/\bPeak:\s+(-?\d+(?:\.\d+)?|-inf)\s+dBFS/) };
}

// ───────────────────────────── covered zones ─────────────────────────────

const SAMPLE_WIDTH = 180;

/** Grayscale frames, small enough to look at pixel by pixel. */
async function sampleFrames(tools: Tools, file: string, facts: Facts, kind: string, n: number): Promise<{ w: number; h: number; px: Buffer }[]> {
  if (!facts.width || !facts.height) return [];
  const w = SAMPLE_WIDTH;
  const h = Math.max(4, Math.round((SAMPLE_WIDTH * facts.height) / facts.width / 2) * 2);
  const times = kind === 'video' && facts.durationSec ? Array.from({ length: n }, (_, i) => ((i + 0.5) / n) * facts.durationSec!) : [0];
  const frames: { w: number; h: number; px: Buffer }[] = [];
  for (const t of times) {
    const r = await run(tools.ffmpeg, ['-v', 'error', '-ss', t.toFixed(3), '-i', file, '-frames:v', '1', '-vf', `scale=${w}:${h},format=gray`, '-f', 'rawvideo', '-']);
    if (r.code === 0 && r.stdout.length === w * h) frames.push({ w, h, px: r.stdout });
  }
  return frames;
}

/** Mean gradient (how much fine detail there is) over a rectangle of a grayscale frame. */
function detail(f: { w: number; h: number; px: Buffer }, x0: number, y0: number, x1: number, y1: number): number {
  let sum = 0;
  let n = 0;
  for (let y = Math.max(1, y0); y < Math.min(f.h - 1, y1); y++) {
    for (let x = Math.max(1, x0); x < Math.min(f.w - 1, x1); x++) {
      const p = (dx: number, dy: number) => f.px[(y + dy) * f.w + x + dx]!;
      const gx = p(1, -1) + 2 * p(1, 0) + p(1, 1) - p(-1, -1) - 2 * p(-1, 0) - p(-1, 1);
      const gy = p(-1, 1) + 2 * p(0, 1) + p(1, 1) - p(-1, -1) - 2 * p(0, -1) - p(1, -1);
      sum += (Math.abs(gx) + Math.abs(gy)) / 8;
      n++;
    }
  }
  return n ? sum / n : 0;
}

/** A covered band is flagged when it holds clearly more fine detail (text, a logo) than the part of the frame left uncovered. */
const ZONE_RATIO = 1.8;
const ZONE_MIN_DETAIL = 6;
const ZONE_NAMES = { top: 'top', bottom: 'bottom', left: 'left side', right: 'right side' } as const;

/** Which covered zones of a network's interface hold detail, in at least two of the sampled frames (or the one frame of an image). */
export function coveredZonesWithDetail(frames: { w: number; h: number; px: Buffer }[], zones: NonNullable<Placement['safeZones']>): (keyof typeof ZONE_NAMES)[] {
  const need = frames.length === 1 ? 1 : 2;
  const hits: Record<string, number> = { top: 0, bottom: 0, left: 0, right: 0 };
  for (const f of frames) {
    const sx0 = Math.round(zones.left * f.w), sx1 = Math.round(f.w * (1 - zones.right));
    const sy0 = Math.round(zones.top * f.h), sy1 = Math.round(f.h * (1 - zones.bottom));
    const safe = detail(f, sx0, sy0, sx1, sy1);
    const bands = {
      top: zones.top > 0 ? detail(f, 0, 0, f.w, sy0) : 0,
      bottom: zones.bottom > 0 ? detail(f, 0, sy1, f.w, f.h) : 0,
      left: zones.left > 0 ? detail(f, 0, sy0, sx0, sy1) : 0,
      right: zones.right > 0 ? detail(f, sx1, sy0, f.w, sy1) : 0,
    };
    for (const [name, d] of Object.entries(bands)) if (d >= ZONE_MIN_DETAIL && d > ZONE_RATIO * Math.max(safe, 1)) hits[name]!++;
  }
  return (Object.keys(hits) as (keyof typeof ZONE_NAMES)[]).filter((k) => hits[k]! >= need);
}

// ───────────────────────────── the checks ─────────────────────────────

const within = (v: number, r: { min: number; max: number }) => v >= r.min && v <= r.max;
const fmtRange = (r: { min: number; max: number }) => `${r.min}–${r.max}`;

/** What stops a file from being published through a placement at all: things converting it cannot fix. */
function blockers(p: Placement, kind: string, f: Facts): string[] {
  const out: string[] = [];
  if (kind === 'video' && p.durationSec && f.durationSec !== null && !within(f.durationSec, p.durationSec)) {
    out.push(`${p.label} takes ${fmtRange(p.durationSec)} seconds and this is ${f.durationSec.toFixed(1)}`);
  }
  if (p.aspect && f.width && f.height && !within(f.width / f.height, p.aspect)) {
    out.push(`${p.label} takes an aspect ratio of ${fmtRange(p.aspect)} (width/height) and this is ${(f.width / f.height).toFixed(2)}`);
  }
  return out;
}

const NETWORK_NAME: Record<string, string> = { instagram: 'Instagram', facebook: 'Facebook', youtube: 'YouTube' };
const networkName = (n: string) => NETWORK_NAME[n] ?? n;

/**
 * The automatic checks a version has to pass before it is uploaded: duration, aspect, resolution, loudness, weight per
 * network and, as a hint, detail under the areas each network covers. A file that no network can publish is an error, as is
 * a file a network the brand requires cannot publish. Everything the publisher can fix by converting (too heavy, too
 * large) is a warning, because the app converts such files when it publishes.
 */
export async function checkOutput(files: CheckFile[], req: Requirements, cfg: Brand['checks'], tools: Tools): Promise<CheckResult> {
  const errors: Issue[] = [];
  const warnings: Issue[] = [];
  const summary: string[] = [];
  const seen = new Set<string>();
  const warn = (i: Issue) => {
    const key = `${i.code}|${i.message}`;
    if (!seen.has(key)) {
      seen.add(key);
      warnings.push(i);
    }
  };

  for (const file of files.filter((f) => f.kind === 'video' || f.kind === 'image')) {
    const name = path.basename(file.path);
    let facts: Facts;
    try {
      facts = await probe(tools, file.path);
    } catch (err) {
      errors.push({ severity: 'error', code: 'unreadable', message: (err as Error).message, file: name });
      continue;
    }
    if (!facts.width || !facts.height) {
      errors.push({ severity: 'error', code: 'unreadable', message: `${name} has no picture`, file: name });
      continue;
    }
    const kind = file.kind as 'video' | 'image';
    const ok: { network: string; placement: Placement }[] = [];
    const failed: { network: string; why: string }[] = [];
    for (const net of req.networks) {
      const candidates = net.placements.filter((p) => p.accepts.includes(kind));
      if (candidates.length === 0) continue;
      const evaluated = candidates.map((p) => ({ p, why: blockers(p, kind, facts) }));
      const pass = evaluated.find((e) => e.why.length === 0);
      if (pass) ok.push({ network: net.network, placement: pass.p });
      else failed.push({ network: net.network, why: [...evaluated].sort((a, b) => a.why.length - b.why.length)[0]!.why.join('; ') });
    }

    const required = cfg.requireNetworks;
    for (const f of failed) {
      const isRequired = required.includes(f.network);
      const issue: Issue = { severity: isRequired ? 'error' : 'warning', code: 'network_cannot_publish', message: `${networkName(f.network)} cannot publish ${name}: ${f.why}`, file: name };
      if (isRequired) errors.push(issue); else warn(issue);
    }
    for (const r of required) {
      if (!req.networks.some((n) => n.network === r)) errors.push({ severity: 'error', code: 'unknown_network', message: `The brand has no ${networkName(r)} account, but the runner requires ${networkName(r)}`, file: name });
    }
    if (ok.length === 0 && req.networks.some((n) => n.placements.some((p) => p.accepts.includes(kind)))) {
      errors.push({ severity: 'error', code: 'no_network', message: `No network of this brand can publish ${name}: ${failed.map((f) => `${networkName(f.network)}: ${f.why}`).join(' | ')}`, file: name });
    }
    if (ok.length > 0) summary.push(`${name}: fits ${ok.map((o) => `${networkName(o.network)} ${o.placement.label}`).join(', ')}`);

    // What the publisher can fix by converting is only worth a word.
    for (const { network, placement } of ok) {
      const prof = placement.fileProfiles[kind];
      if (prof) {
        if (facts.bytes > prof.maxBytes) warn({ severity: 'warning', code: 'heavy', message: `${name} is ${(facts.bytes / 1048576).toFixed(0)} MB, over what ${networkName(network)} ${placement.label} takes (${(prof.maxBytes / 1048576).toFixed(0)} MB): it will be converted when it is published`, file: name });
        const long = Math.max(facts.width, facts.height), short = Math.min(facts.width, facts.height);
        if ('maxHeight' in prof) {
          if (long > Math.max(prof.maxWidth, prof.maxHeight) || short > Math.min(prof.maxWidth, prof.maxHeight)) warn({ severity: 'warning', code: 'large', message: `${name} is ${facts.width}×${facts.height}, larger than ${networkName(network)} ${placement.label} takes (${prof.maxWidth}×${prof.maxHeight}): it will be scaled down when it is published`, file: name });
          if (facts.fps && facts.fps > prof.maxFps + 0.5) warn({ severity: 'warning', code: 'fps', message: `${name} runs at ${facts.fps.toFixed(0)} fps, above the ${prof.maxFps} that ${networkName(network)} takes: it will be converted`, file: name });
        } else if (facts.width > prof.maxWidth) {
          warn({ severity: 'warning', code: 'large', message: `${name} is ${facts.width} pixels wide, wider than ${networkName(network)} ${placement.label} takes (${prof.maxWidth}): it will be scaled down when it is published`, file: name });
        }
      }
      if (placement.recommendedAspect && !within(facts.width / facts.height, placement.recommendedAspect)) {
        warn({ severity: 'warning', code: 'aspect', message: `${name} has an aspect ratio of ${(facts.width / facts.height).toFixed(2)}, outside the ${fmtRange(placement.recommendedAspect)} where ${networkName(network)} ${placement.label} looks right`, file: name });
      }
    }
    if (Math.min(facts.width, facts.height) < cfg.minShortSide) {
      warn({ severity: 'warning', code: 'low_resolution', message: `${name} is ${facts.width}×${facts.height}: the shorter side is under ${cfg.minShortSide} pixels, so it will look soft on a phone`, file: name });
    }

    if (kind === 'video') {
      if (!facts.hasAudio) {
        summary.push(`${name}: no audio track`);
      } else {
        const l = await loudness(tools, file.path);
        if (l.lufs === null) {
          warn({ severity: 'warning', code: 'silent', message: `${name} has an audio track with no sound in it`, file: name });
        } else {
          summary.push(`${name}: loudness ${l.lufs.toFixed(1)} LUFS, true peak ${l.truePeak === null ? 'n/a' : `${l.truePeak.toFixed(1)} dBTP`}`);
          if (l.lufs < cfg.loudness.min || l.lufs > cfg.loudness.max) {
            warn({ severity: 'warning', code: 'loudness', message: `${name} is ${l.lufs.toFixed(1)} LUFS: outside ${cfg.loudness.min} to ${cfg.loudness.max}, so networks will turn it ${l.lufs < cfg.loudness.min ? 'up' : 'down'}`, file: name });
          }
          if (l.truePeak !== null && l.truePeak > cfg.truePeakMax) {
            warn({ severity: 'warning', code: 'true_peak', message: `${name} peaks at ${l.truePeak.toFixed(1)} dBTP, above ${cfg.truePeakMax}: it may distort after the network compresses it`, file: name });
          }
        }
      }
    }

    if (cfg.coveredZones === 'warn') {
      const withZones = ok.filter((o) => o.placement.safeZones);
      if (withZones.length) {
        const frames = await sampleFrames(tools, file.path, facts, kind, 5);
        if (frames.length) {
          for (const { network, placement } of withZones) {
            for (const zone of coveredZonesWithDetail(frames, placement.safeZones!)) {
              warn({ severity: 'warning', code: 'covered_zone', message: `${name} may have text or a logo under the ${ZONE_NAMES[zone]} of ${networkName(network)} ${placement.label}, where the network draws its own buttons and caption (a guess from how much detail is there: look at it with the overlay on)`, file: name });
            }
          }
        }
      }
    }
  }
  if (errors.length === 0 && warnings.length === 0 && summary.length) summary.push('no problems found');
  else if (warnings.length) summary.push(`${warnings.length} warning${warnings.length === 1 ? '' : 's'}`);
  return { errors, warnings, summary };
}
