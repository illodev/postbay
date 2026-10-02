/**
 * Where the video is, shared with whatever follows it (the subtitle list). A tiny store outside React: the player updates it on every
 * frame, and only a subscriber whose own answer changes (the line on screen) re-renders.
 */
let time = 0;
const listeners = new Set<() => void>();

export const playhead = {
  get t() { return time; },
  set(t: number) {
    if (t === time) return;
    time = t;
    for (const l of listeners) l();
  },
  subscribe(fn: () => void) {
    listeners.add(fn);
    return () => { listeners.delete(fn); };
  },
};
