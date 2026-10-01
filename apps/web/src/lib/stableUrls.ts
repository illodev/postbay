import { useRef } from 'react';

/**
 * Signed media URLs change on every fetch (they carry a fresh signature), and a changed `src` makes a <video>
 * reload from the start. This keeps the first URL seen for each id for a while, so a background refetch of the
 * version or its comments never interrupts playback or flickers a thumbnail. Signed URLs live for an hour,
 * so after 30 minutes the new one is taken.
 */
export function useStableUrls() {
  const seen = useRef(new Map<string, { url: string; at: number }>());
  return (id: string, url: string): string => {
    const hit = seen.current.get(id);
    if (hit && Date.now() - hit.at < 30 * 60_000) return hit.url;
    seen.current.set(id, { url, at: Date.now() });
    return url;
  };
}
