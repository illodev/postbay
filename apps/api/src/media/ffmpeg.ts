import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

export interface ProbeResult {
  width: number | null;
  height: number | null;
  durationMs: number | null;
  fps: number | null;
}

export interface Media {
  /** Measures a video or image file. Returns nulls if ffprobe is missing or cannot read the file. */
  probe(src: string): Promise<ProbeResult>;
  /** JPEG frame at second t, or null if ffmpeg is missing or fails. */
  frame(src: string, seconds: number): Promise<Buffer | null>;
}

function parseRate(r: string | undefined): number | null {
  if (!r) return null;
  const [n, d] = r.split('/').map(Number);
  if (!n || !d) return null;
  return Math.round((n / d) * 1000) / 1000;
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
          streams?: { codec_type?: string; width?: number; height?: number; avg_frame_rate?: string; duration?: string }[];
          format?: { duration?: string };
        };
        const v = info.streams?.find((s) => s.codec_type === 'video');
        const dur = Number(info.format?.duration ?? v?.duration);
        const isStill = !Number.isFinite(dur) || dur <= 0;
        return {
          width: v?.width ?? null,
          height: v?.height ?? null,
          durationMs: isStill ? null : Math.round(dur * 1000),
          fps: isStill ? null : parseRate(v?.avg_frame_rate),
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
  };
}
