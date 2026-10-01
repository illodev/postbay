/**
 * What each network accepts, as files. A connector names a profile for each placement; before publishing, the app checks
 * the file against it and only transcodes when the original does not already fit ("if it fits, it goes out as it is").
 *
 * The numbers come from the networks' public guidelines as the specification recorded them, and several of those pages
 * disagree with each other, so treat every figure here as something to re-check against the current documentation
 * before relying on it. Limits that are not certain are applied as warnings by the connectors, not as errors.
 */
export interface VideoProfile {
  kind: 'video';
  id: string;
  container: 'mp4';
  videoCodec: 'h264';
  audioCodec: 'aac';
  pixFmt: 'yuv420p';
  maxWidth: number;
  maxHeight: number;
  maxFps: number;
  maxVideoKbps: number;
  maxBytes: number;
}

export interface ImageProfile {
  kind: 'image';
  id: string;
  format: 'jpeg';
  maxWidth: number;
  maxBytes: number;
}

export type FileProfile = VideoProfile | ImageProfile;

const MB = 1024 * 1024;

const video = (id: string, maxWidth: number, maxHeight: number, maxFps: number, maxVideoKbps: number, maxBytes: number): VideoProfile => ({
  kind: 'video', id, container: 'mp4', videoCodec: 'h264', audioCodec: 'aac', pixFmt: 'yuv420p', maxWidth, maxHeight, maxFps, maxVideoKbps, maxBytes,
});

export const PROFILES: Record<string, FileProfile> = {
  'ig-reel': video('ig-reel', 1080, 1920, 60, 25_000, 300 * MB),
  'ig-story-video': video('ig-story-video', 1080, 1920, 60, 25_000, 100 * MB),
  'ig-feed-image': { kind: 'image', id: 'ig-feed-image', format: 'jpeg', maxWidth: 1440, maxBytes: 8 * MB },
  'ig-story-image': { kind: 'image', id: 'ig-story-image', format: 'jpeg', maxWidth: 1080, maxBytes: 8 * MB },
  'fb-video': video('fb-video', 1920, 1920, 60, 25_000, 1024 * MB),
  'fb-reel': video('fb-reel', 1080, 1920, 60, 25_000, 1024 * MB),
  'fb-photo': { kind: 'image', id: 'fb-photo', format: 'jpeg', maxWidth: 2048, maxBytes: 10 * MB },
  'yt-video': video('yt-video', 3840, 2160, 60, 50_000, 8 * 1024 * MB),
};

export function profileOf(id: string): FileProfile {
  const p = PROFILES[id];
  if (!p) throw new Error(`Unknown file profile ${id}`);
  return p;
}
