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
  // Phase 4. As above, every figure is the networks' public guidance as the specification recorded it: check before relying on it.
  'th-video': video('th-video', 1080, 1920, 60, 25_000, 1024 * MB),
  'th-image': { kind: 'image', id: 'th-image', format: 'jpeg', maxWidth: 1440, maxBytes: 8 * MB },
  'tt-video': video('tt-video', 1080, 1920, 60, 25_000, 4 * 1024 * MB),
  'tt-photo': { kind: 'image', id: 'tt-photo', format: 'jpeg', maxWidth: 1080, maxBytes: 20 * MB },
  'li-video': video('li-video', 1920, 1920, 60, 30_000, 5 * 1024 * MB),
  'li-image': { kind: 'image', id: 'li-image', format: 'jpeg', maxWidth: 4096, maxBytes: 8 * MB },
  'x-video': video('x-video', 1920, 1200, 60, 25_000, 512 * MB),
  'x-image': { kind: 'image', id: 'x-image', format: 'jpeg', maxWidth: 4096, maxBytes: 5 * MB },
  'pin-video': video('pin-video', 1920, 1920, 60, 25_000, 2 * 1024 * MB),
  'pin-image': { kind: 'image', id: 'pin-image', format: 'jpeg', maxWidth: 2000, maxBytes: 20 * MB },
  // Bluesky takes a picture as a blob of under about 1 MB, so the conversion trades quality for size until it fits.
  'bsky-video': video('bsky-video', 1920, 1920, 60, 12_000, 100 * MB),
  'bsky-image': { kind: 'image', id: 'bsky-image', format: 'jpeg', maxWidth: 2000, maxBytes: 950_000 },
};

export function profileOf(id: string): FileProfile {
  const p = PROFILES[id];
  if (!p) throw new Error(`Unknown file profile ${id}`);
  return p;
}
