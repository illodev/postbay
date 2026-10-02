import { execFile, spawn } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { promisify } from 'node:util';
import type { FileProfile } from '../connectors/profiles.js';
import { inputArgs, sniff, type Container, type Sniffed } from './sniff.js';

const run = promisify(execFile);

export interface ProbeResult {
  width: number | null;
  height: number | null;
  durationMs: number | null;
  fps: number | null;
  /** The rest is what a network's file profile is checked against. Optional because older rows and stubs lack it. */
  videoCodec?: string | null;
  audioCodec?: string | null;
  pixFmt?: string | null;
  /** True when the container really is MP4 (an ftyp brand other than QuickTime's), not merely of the mov/mp4 family. */
  mp4?: boolean;
  /** What the file really is, from its first bytes (see sniff.ts). */
  container?: Container;
  /** For MP4 and MOV: the index (moov) comes before the media, so the file can be read while it downloads. */
  faststart?: boolean | null;
  /** A JPEG that is really a Multi-Picture Object. */
  mpo?: boolean;
  videoKbps?: number | null;
  hasAudio?: boolean;
}

export interface Media {
  /** Measures a video or image file. Returns nulls if ffprobe is missing or cannot read the file. */
  probe(src: string): Promise<ProbeResult>;
  /** JPEG frame at second t, or null if ffmpeg is missing or fails. */
  frame(src: string, seconds: number): Promise<Buffer | null>;
  /** Makes a copy of `src` that fits `profile`, written to `dest`. Throws a ConnectorError-like message on failure. */
  transcode(src: string, dest: string, profile: FileProfile, probe: ProbeResult): Promise<void>;
}

function parseRate(r: string | undefined): number | null {
  if (!r) return null;
  const [n, d] = r.split('/').map(Number);
  if (!n || !d) return null;
  return Math.round((n / d) * 1000) / 1000;
}

type VideoProfileOf = Extract<FileProfile, { kind: 'video' }>;

/** Whether the picture itself already fits, so it can be copied as it is and only the container (or the sound) changes. */
export function videoStreamFits(p: VideoProfileOf, probe: ProbeResult): boolean {
  return probe.videoCodec === p.videoCodec && probe.pixFmt === p.pixFmt
    && !!probe.width && !!probe.height && probe.width <= p.maxWidth && probe.height <= p.maxHeight
    && !!probe.fps && probe.fps <= p.maxFps + 0.01 && probe.fps >= (p.minFps ?? 0) - 0.01
    && (probe.videoKbps ?? 0) <= p.maxVideoKbps;
}

/**
 * ffmpeg arguments that turn a video into one that fits the profile. When the picture already fits (an H.264 MOV, an MP4 whose index
 * is at the end) it is copied, not encoded again: the file is only rewritten as an MP4 with its index at the front. Exported so the
 * choices can be tested. `input` is what goes before -i (the reader and the protocols allowed; see sniff.ts).
 */
export function videoArgs(src: string, dest: string, p: VideoProfileOf, probe: ProbeResult, input: string[] = []): string[] {
  const copyVideo = videoStreamFits(p, probe);
  const copyAudio = !probe.audioCodec || probe.audioCodec === p.audioCodec;
  const args = ['-y', '-v', 'error', ...input, '-i', src, '-map', '0:v:0', '-map', '0:a:0?'];
  if (copyVideo) {
    args.push('-c:v', 'copy');
  } else {
    args.push(
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '21', '-pix_fmt', p.pixFmt,
      // Shrink to fit, never enlarge, keep the aspect ratio, and keep both sides even (H.264 needs it).
      '-vf', `scale=w='min(iw,${p.maxWidth})':h='min(ih,${p.maxHeight})':force_original_aspect_ratio=decrease:force_divisible_by=2`,
      '-maxrate', `${p.maxVideoKbps}k`, '-bufsize', `${p.maxVideoKbps * 2}k`,
    );
    if (probe.fps && probe.fps > p.maxFps) args.push('-r', String(p.maxFps));
    else if (probe.fps && p.minFps && probe.fps < p.minFps) args.push('-r', String(p.minFps));
  }
  args.push(...(copyAudio ? ['-c:a', 'copy'] : ['-c:a', 'aac', '-b:a', '128k', '-ac', '2']));
  // The index at the front, in an MP4 container whatever the name of the output says.
  args.push('-movflags', '+faststart', '-f', 'mp4', dest);
  return args;
}

/** JPEG quality steps (ffmpeg's -q:v, lower is better): the first is used unless the result is over the profile's size. */
export const IMAGE_QUALITY_LADDER = [2, 5, 9, 14, 20, 28];

export function imageArgs(src: string, dest: string, p: Extract<FileProfile, { kind: 'image' }>, quality = IMAGE_QUALITY_LADDER[0]!, input: string[] = []): string[] {
  return [
    '-y', '-v', 'error', ...input, '-i', src,
    '-frames:v', '1',
    '-vf', `scale=w='min(iw,${p.maxWidth})':h=-2`,
    '-q:v', String(quality), '-pix_fmt', 'yuvj420p',
    dest,
  ];
}

function runFfmpeg(args: string[], timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (d) => { stderr = (stderr + d).slice(-4000); });
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('ffmpeg timed out')); }, timeoutMs);
    child.on('error', (err) => { clearTimeout(timer); reject(new Error(`ffmpeg could not start: ${err.message}`)); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg failed (${code}): ${stderr.trim().split('\n').slice(-3).join(' | ')}`));
    });
  });
}

export function createMedia(log?: { warn: (o: object, m?: string) => void }): Media {
  return {
    async probe(src) {
      try {
        // What the file is, from its own bytes: ffprobe is then told which reader to use and may open nothing else.
        const kind = await sniff(src);
        const { stdout } = await run(
          'ffprobe',
          ['-v', 'error', ...inputArgs(src, kind), '-print_format', 'json', '-show_streams', '-show_format', src],
          { timeout: 30_000, maxBuffer: 4 * 1024 * 1024 },
        );
        const info = JSON.parse(stdout) as {
          streams?: { codec_type?: string; codec_name?: string; pix_fmt?: string; width?: number; height?: number; avg_frame_rate?: string; duration?: string; bit_rate?: string }[];
          format?: { duration?: string; format_name?: string; bit_rate?: string };
        };
        const v = info.streams?.find((s) => s.codec_type === 'video');
        const a = info.streams?.find((s) => s.codec_type === 'audio');
        const dur = Number(info.format?.duration ?? v?.duration);
        const isStill = !Number.isFinite(dur) || dur <= 0;
        const vbr = Number(v?.bit_rate ?? info.format?.bit_rate);
        return {
          width: v?.width ?? null,
          height: v?.height ?? null,
          durationMs: isStill ? null : Math.round(dur * 1000),
          fps: isStill ? null : parseRate(v?.avg_frame_rate),
          videoCodec: v?.codec_name ?? null,
          audioCodec: a?.codec_name ?? null,
          pixFmt: v?.pix_fmt ?? null,
          // ffprobe names the whole family ("mov,mp4,m4a,…") for an MP4 and a MOV alike: the first bytes tell them apart.
          mp4: kind.container === 'mp4',
          container: kind.container,
          faststart: kind.faststart ?? null,
          ...(kind.container === 'jpeg' ? { mpo: kind.mpo === true } : {}),
          videoKbps: Number.isFinite(vbr) && vbr > 0 ? Math.round(vbr / 1000) : null,
          hasAudio: !!a,
        };
      } catch (err) {
        log?.warn({ err: String(err) }, 'ffprobe could not measure the file');
        return { width: null, height: null, durationMs: null, fps: null };
      }
    },

    async frame(src, seconds) {
      try {
        const kind = await sniff(src);
        const { stdout } = await run(
          'ffmpeg',
          ['-v', 'error', '-ss', String(Math.max(0, seconds)), ...inputArgs(src, kind), '-i', src, '-frames:v', '1', '-q:v', '3', '-f', 'image2pipe', '-vcodec', 'mjpeg', 'pipe:1'],
          { timeout: 20_000, encoding: 'buffer', maxBuffer: 16 * 1024 * 1024 },
        );
        return stdout.length > 0 ? stdout : null;
      } catch (err) {
        log?.warn({ err: String(err) }, 'ffmpeg could not extract the frame');
        return null;
      }
    },

    async transcode(src, dest, profile, probe) {
      let kind: Sniffed;
      let input: string[];
      try {
        kind = await sniff(src);
        input = inputArgs(src, kind);
      } catch (err) {
        throw new Error(`ffmpeg failed (not converted): ${(err as Error).message}`);
      }
      if (profile.kind === 'video') {
        // What the bytes say wins over what was measured before, for the container and the index.
        await runFfmpeg(videoArgs(src, dest, profile, { ...probe, container: kind.container, mp4: kind.container === 'mp4', faststart: kind.faststart ?? null }, input), 45 * 60_000);
        return;
      }
      // Best quality first; only when the picture is still too large for the network does it get worse, step by step.
      for (const q of IMAGE_QUALITY_LADDER) {
        await runFfmpeg(imageArgs(src, dest, profile, q, input), 2 * 60_000);
        if ((await stat(dest)).size <= profile.maxBytes) return;
      }
    },
  };
}
