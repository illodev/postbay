import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import type { FileProfile } from '../connectors/profiles.js';

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
  /** True when it can be treated as an MP4 (the mov/mp4 family). */
  mp4?: boolean;
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

/** ffmpeg arguments that turn any video into one that fits the profile. Exported so the choices can be tested. */
export function videoArgs(src: string, dest: string, p: Extract<FileProfile, { kind: 'video' }>, probe: ProbeResult): string[] {
  const args = [
    '-y', '-v', 'error', '-i', src,
    '-map', '0:v:0', '-map', '0:a:0?',
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '21', '-pix_fmt', p.pixFmt,
    // Shrink to fit, never enlarge, keep the aspect ratio, and keep both sides even (H.264 needs it).
    '-vf', `scale=w='min(iw,${p.maxWidth})':h='min(ih,${p.maxHeight})':force_original_aspect_ratio=decrease:force_divisible_by=2`,
    '-maxrate', `${p.maxVideoKbps}k`, '-bufsize', `${p.maxVideoKbps * 2}k`,
    '-c:a', 'aac', '-b:a', '128k', '-ac', '2',
    '-movflags', '+faststart',
  ];
  if (probe.fps && probe.fps > p.maxFps) args.push('-r', String(p.maxFps));
  args.push(dest);
  return args;
}

export function imageArgs(src: string, dest: string, p: Extract<FileProfile, { kind: 'image' }>): string[] {
  return [
    '-y', '-v', 'error', '-i', src,
    '-frames:v', '1',
    '-vf', `scale=w='min(iw,${p.maxWidth})':h=-2`,
    '-q:v', '2', '-pix_fmt', 'yuvj420p',
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
        const { stdout } = await run(
          'ffprobe',
          ['-v', 'error', '-print_format', 'json', '-show_streams', '-show_format', src],
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
          mp4: /\bmp4\b/.test(info.format?.format_name ?? ''),
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
        const { stdout } = await run(
          'ffmpeg',
          ['-v', 'error', '-ss', String(Math.max(0, seconds)), '-i', src, '-frames:v', '1', '-q:v', '3', '-f', 'image2pipe', '-vcodec', 'mjpeg', 'pipe:1'],
          { timeout: 20_000, encoding: 'buffer', maxBuffer: 16 * 1024 * 1024 },
        );
        return stdout.length > 0 ? stdout : null;
      } catch (err) {
        log?.warn({ err: String(err) }, 'ffmpeg could not extract the frame');
        return null;
      }
    },

    async transcode(src, dest, profile, probe) {
      const args = profile.kind === 'video' ? videoArgs(src, dest, profile, probe) : imageArgs(src, dest, profile);
      await runFfmpeg(args, profile.kind === 'video' ? 45 * 60_000 : 2 * 60_000);
    },
  };
}
