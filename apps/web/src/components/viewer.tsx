// The legacy build carries the polyfills that older browsers need (Map.getOrInsertComputed, for one).
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import workerUrl from 'pdfjs-dist/legacy/build/pdf.worker.min.mjs?url';
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent as RKeyboardEvent, type PointerEvent as RPointerEvent, type ReactNode, type RefObject } from 'react';
import type { Anchor, Asset, CommentThread } from '../api';
import { t } from '../i18n';
import { playhead } from '../lib/playhead';
import '../styles/review.css';

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));
const round2 = (n: number) => Math.round(n * 100) / 100;

/** 0:14.2 — minutes, seconds and tenths; without tenths, 0:14. */
export function timecode(seconds: number, tenths = true): string {
  const s = Math.max(0, seconds || 0);
  if (!tenths) {
    const whole = Math.floor(s);
    return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`;
  }
  const total = Math.round(s * 10);
  const m = Math.floor(total / 600);
  return `${m}:${((total - m * 600) / 10).toFixed(1).padStart(4, '0')}`;
}

/** The timecode as a comment shows it: 0:05 when it falls on a whole second, 0:05.3 otherwise. */
export function shortTimecode(seconds: number): string {
  const full = timecode(seconds);
  return full.endsWith('.0') ? full.slice(0, -2) : full;
}

/** A request from outside the stage to show a place: a page and/or a moment of a video. The nonce makes repeats count. */
export interface Jump {
  nonce: number;
  page?: number;
  t?: number;
  position?: number;
}

const primariesOf = (assets: Asset[]) =>
  assets.filter((a) => a.kind === 'video' || a.kind === 'image').sort((a, b) => a.position - b.position);

/**
 * Keys typed into a control are the control's: the stage's shortcuts only listen when nothing editable has the focus. A focused
 * button keeps Space and the arrows (it would act twice otherwise), but lets the frame keys through.
 */
const typing = (e: RKeyboardEvent, buttonsToo = true) =>
  !!(e.target as HTMLElement).closest(buttonsToo ? 'input, select, textarea, button, [role="slider"]' : 'input, select, textarea, [role="slider"]');

// ───────────────────────────── icons ─────────────────────────────

const Svg = ({ children }: { children: ReactNode }) => (
  <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{children}</svg>
);
const IconPlay = () => <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path d="M7 4.5v15l12.5-7.5z" fill="currentColor" /></svg>;
const IconPause = () => <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path d="M6.5 4.5h4v15h-4zM13.5 4.5h4v15h-4z" fill="currentColor" /></svg>;
const IconFrameBack = () => <Svg><path d="M18 6v12M14 6l-7 6 7 6" /></Svg>;
const IconFrameFwd = () => <Svg><path d="M6 6v12M10 6l7 6-7 6" /></Svg>;
const IconPrev = () => <Svg><path d="M15 5l-7 7 7 7" /></Svg>;
const IconNext = () => <Svg><path d="M9 5l7 7-7 7" /></Svg>;
const IconSound = () => <Svg><path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4zM16 9a4 4 0 0 1 0 6M18.5 6.5a7.5 7.5 0 0 1 0 11" /></Svg>;
const IconMuted = () => <Svg><path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4zM16.5 9.5l5 5M21.5 9.5l-5 5" /></Svg>;
const IconFull = () => <Svg><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" /></Svg>;

function useFullscreen(target: RefObject<HTMLElement | null>) {
  const [on, setOn] = useState(false);
  useEffect(() => {
    const sync = () => setOn(!!document.fullscreenElement && document.fullscreenElement === target.current);
    document.addEventListener('fullscreenchange', sync);
    return () => document.removeEventListener('fullscreenchange', sync);
  }, [target]);
  const toggle = () => {
    if (document.fullscreenElement) void document.exitFullscreen();
    else void target.current?.requestFullscreen?.().catch(() => {});
  };
  return { on, toggle, supported: typeof document !== 'undefined' && !!document.fullscreenEnabled };
}

function FullscreenButton({ fs }: { fs: ReturnType<typeof useFullscreen> }) {
  if (!fs.supported) return null;
  const label = fs.on ? t('review.media.exitFullscreen') : t('review.media.fullscreen');
  return <button type="button" className="rv-ic" onClick={fs.toggle} aria-label={label} title={label}><IconFull /></button>;
}

// ───────────────────────────── region layer (images and PDF pages) ─────────────────────────────

type RegionThread = CommentThread & { anchor: Extract<Anchor, { type: 'region' }> };

interface RegionProps {
  page: number;
  threads: CommentThread[];
  numbers: Map<string, number>;
  draft: Anchor | null;
  onDraft: (a: Anchor | null) => void;
  canAnnotate: boolean;
  focus: string | null;
  onFocus: (id: string) => void;
}

/**
 * Transparent layer over a page: drag to mark a rectangle, click to drop a point, click an existing mark to open its thread.
 * Everything is stored as fractions of the page, so it survives any screen size. Each mark carries the number its thread has
 * in the list beside it.
 */
function RegionLayer({ page, threads, numbers, draft, onDraft, canAnnotate, focus, onFocus }: RegionProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null);
  const marks = threads.filter((c): c is RegionThread => c.anchor?.type === 'region' && c.anchor.page === page);

  const rel = (e: RPointerEvent) => {
    const r = ref.current!.getBoundingClientRect();
    return { x: clamp((e.clientX - r.left) / r.width, 0, 1), y: clamp((e.clientY - r.top) / r.height, 0, 1), w: r.width, h: r.height };
  };

  const down = (e: RPointerEvent) => {
    if (e.button !== 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    const p = rel(e);
    setDrag({ x0: p.x, y0: p.y, x1: p.x, y1: p.y });
  };
  const move = (e: RPointerEvent) => {
    if (!drag) return;
    const p = rel(e);
    setDrag({ ...drag, x1: p.x, y1: p.y });
  };
  const up = (e: RPointerEvent) => {
    if (!drag) return;
    const p = rel(e);
    const x = Math.min(drag.x0, p.x), y = Math.min(drag.y0, p.y);
    const w = Math.abs(p.x - drag.x0), h = Math.abs(p.y - drag.y0);
    setDrag(null);
    if (w < 0.012 && h < 0.012) {
      // A click: open the mark under it, or drop a point. A point is hit within 16 px of where it was dropped.
      const hit = marks.find((m) => {
        const a = m.anchor;
        return a.w === 0 && a.h === 0 ? Math.hypot((a.x - p.x) * p.w, (a.y - p.y) * p.h) < 16 : p.x >= a.x && p.x <= a.x + a.w && p.y >= a.y && p.y <= a.y + a.h;
      });
      if (hit) onFocus(hit.id);
      else if (canAnnotate) onDraft({ type: 'region', page, x: round2(p.x), y: round2(p.y), w: 0, h: 0 });
      return;
    }
    if (canAnnotate) onDraft({ type: 'region', page, x: round2(x), y: round2(y), w: round2(w), h: round2(h) });
  };

  const pin = (a: { x: number; y: number; w: number; h: number }, cls: string, key: string, label: ReactNode, open?: () => void) => {
    const point = a.w === 0 && a.h === 0;
    // Near the top edge the pin hangs below its point instead of standing above it, so it is never cut off.
    const flip = a.y < 0.07;
    const head = open ? (
      <button
        type="button"
        className={`rv-pin ${flip ? 'flip' : ''} ${point ? '' : 'corner'}`}
        aria-label={t('review.pin.open', { n: String(label) })}
        onPointerDown={(e) => e.stopPropagation()}
        onClick={(e) => { e.stopPropagation(); open(); }}
      >
        {label}
      </button>
    ) : (
      <span className={`rv-pin ${flip ? 'flip' : ''} ${point ? '' : 'corner'}`} aria-hidden="true">{label}</span>
    );
    return point ? (
      <div key={key} className={`region-box rv-point ${cls}`} style={{ left: `${a.x * 100}%`, top: `${a.y * 100}%` }}>{head}</div>
    ) : (
      <div key={key} className={`region-box rv-area ${cls}`} style={{ left: `${a.x * 100}%`, top: `${a.y * 100}%`, width: `${a.w * 100}%`, height: `${a.h * 100}%` }}>{head}</div>
    );
  };

  const live = drag && { x: Math.min(drag.x0, drag.x1), y: Math.min(drag.y0, drag.y1), w: Math.abs(drag.x1 - drag.x0), h: Math.abs(drag.y1 - drag.y0) };
  return (
    <div
      ref={ref}
      className={`region-layer ${canAnnotate ? 'annotate' : ''}`}
      onPointerDown={down}
      onPointerMove={move}
      onPointerUp={up}
      onPointerCancel={() => setDrag(null)}
    >
      {marks.map((m) => pin(m.anchor, `${m.status === 'resolved' ? 'resolved' : ''} ${focus === m.id ? 'focus' : ''}`, m.id, numbers.get(m.id) ?? (m.status === 'resolved' ? '✓' : '•'), () => onFocus(m.id)))}
      {draft?.type === 'region' && draft.page === page && pin(draft, 'draft', 'draft', '+')}
      {live && (live.w >= 0.012 || live.h >= 0.012) && pin(live, 'draft', 'live', '+')}
    </div>
  );
}

// ───────────────────────────── PDF page ─────────────────────────────

/** Draws one page of a PDF as large as its box allows: the full width, and no taller than the box's height limit. */
export function PdfCanvas({ url, page, onPages }: { url: string; page: number; onPages?: (n: number) => void }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [doc, setDoc] = useState<pdfjs.PDFDocumentProxy | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [size, setSize] = useState(0);

  useEffect(() => {
    let cancelled = false;
    const task = pdfjs.getDocument({ url });
    task.promise.then(
      (d) => {
        if (cancelled) return;
        setDoc(d);
        onPages?.(d.numPages);
      },
      (e) => !cancelled && setError(String(e?.message ?? e)),
    );
    return () => {
      cancelled = true;
      task.destroy();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url]);

  // Draw again when the window changes size, once it has settled.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onResize = () => {
      clearTimeout(timer);
      timer = setTimeout(() => setSize((n) => n + 1), 200);
    };
    window.addEventListener('resize', onResize);
    document.addEventListener('fullscreenchange', onResize);
    return () => {
      clearTimeout(timer);
      window.removeEventListener('resize', onResize);
      document.removeEventListener('fullscreenchange', onResize);
    };
  }, []);

  useEffect(() => {
    if (!doc || !canvas.current) return;
    let cancelled = false;
    let renderTask: pdfjs.RenderTask | null = null;
    doc.getPage(clamp(page, 1, doc.numPages)).then((p) => {
      if (cancelled || !canvas.current) return;
      const base = p.getViewport({ scale: 1 });
      const box = canvas.current.closest<HTMLElement>('.rv-media');
      const maxW = Math.min(1100, box?.clientWidth ?? 800);
      const maxH = parseFloat(box ? getComputedStyle(box).maxHeight : '') || window.innerHeight * 0.74;
      const fit = Math.min(maxW / base.width, maxH / base.height);
      const ratio = window.devicePixelRatio || 1;
      const viewport = p.getViewport({ scale: fit * ratio });
      const c = canvas.current;
      c.width = Math.floor(viewport.width);
      c.height = Math.floor(viewport.height);
      c.style.width = `${Math.floor(viewport.width / ratio)}px`;
      c.style.height = `${Math.floor(viewport.height / ratio)}px`;
      renderTask = p.render({ canvas: c, viewport });
      renderTask.promise.catch(() => {});
    });
    return () => {
      cancelled = true;
      renderTask?.cancel();
    };
  }, [doc, page, size]);

  if (error) return <div className="notice notice-bad rv-pdf-error">{t('review.pdf.error', { error })}</div>;
  return <canvas ref={canvas} className="rv-pdf" aria-label={t('review.pdf.page', { n: page })} />;
}

// ───────────────────────────── safe zones ─────────────────────────────

/** Fractions of the frame that a network's own interface (name, caption, buttons) covers. */
export interface SafeZone {
  label: string;
  top: number;
  bottom: number;
  left: number;
  right: number;
}

/** Shades the areas a network covers with its interface. Drawn over the picture and never takes a click. */
export function SafeZoneOverlay({ zone }: { zone: SafeZone | null | undefined }) {
  if (!zone) return null;
  const pct = (n: number) => `${n * 100}%`;
  return (
    <div className="safe-zone" aria-hidden="true" data-testid="safe-zone">
      {zone.top > 0 && <div className="safe-band" style={{ top: 0, left: 0, right: 0, height: pct(zone.top) }} />}
      {zone.bottom > 0 && <div className="safe-band" style={{ bottom: 0, left: 0, right: 0, height: pct(zone.bottom) }} />}
      {zone.left > 0 && <div className="safe-band" style={{ top: pct(zone.top), bottom: pct(zone.bottom), left: 0, width: pct(zone.left) }} />}
      {zone.right > 0 && <div className="safe-band" style={{ top: pct(zone.top), bottom: pct(zone.bottom), right: 0, width: pct(zone.right) }} />}
      <div className="safe-frame" style={{ top: pct(zone.top), bottom: pct(zone.bottom), left: pct(zone.left), right: pct(zone.right) }} />
      <span className="safe-label">{zone.label}</span>
    </div>
  );
}

// ───────────────────────────── timeline ─────────────────────────────

/** Seconds between the labels under the timeline: the smallest round step that leaves room for each label. */
function tickStep(dur: number, width: number): number {
  const fit = Math.max(2, Math.floor(width / 64));
  for (const s of [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600]) if (dur / s <= fit) return s;
  return 7200;
}

function useWidth(ref: RefObject<HTMLElement | null>) {
  const [w, setW] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setW(e!.contentRect.width));
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return w;
}

// ───────────────────────────── video player ─────────────────────────────

type TimeThread = CommentThread & { anchor: Extract<Anchor, { type: 'time' }> };

interface VideoProps {
  asset: Asset;
  poster?: string;
  threads: CommentThread[];
  numbers: Map<string, number>;
  firstVideoPosition: number;
  draft: Anchor | null;
  onDraft: (a: Anchor | null) => void;
  canAnnotate: boolean;
  focus: string | null;
  onFocus: (id: string) => void;
  jump: Jump | null;
  safeZone?: SafeZone | null;
  tools?: ReactNode;
}

/**
 * The video with its own controls: play, frame by frame, and a timeline that carries every comment as a numbered mark. Clicking
 * the picture or the timeline (when one can comment) stops the video there and starts a comment on that moment.
 */
function VideoPlayer({ asset, poster, threads, numbers, firstVideoPosition, draft, onDraft, canAnnotate, focus, onFocus, jump, safeZone, tools }: VideoProps) {
  const ref = useRef<HTMLVideoElement>(null);
  const player = useRef<HTMLDivElement>(null);
  const track = useRef<HTMLDivElement>(null);
  const drag = useRef<{ x: number; moved: boolean } | null>(null);
  const [now, setT] = useState(0);
  const [dur, setDur] = useState(asset.duration_ms ? asset.duration_ms / 1000 : 0);
  const [playing, setPlaying] = useState(false);
  const [muted, setMuted] = useState(false);
  const width = useWidth(track);
  // Full screen takes the player with its controls and timeline, so reviewing goes on there.
  const fs = useFullscreen(player);
  const fps = asset.fps || 30;

  useEffect(() => {
    const v = ref.current;
    if (!v) return;
    let raf: number | null = null;
    const rvfc = 'requestVideoFrameCallback' in v;
    const tick = () => {
      setT(v.currentTime);
      if (rvfc) raf = (v as HTMLVideoElement & { requestVideoFrameCallback: (cb: () => void) => number }).requestVideoFrameCallback(tick);
    };
    const meta = () => v.duration && Number.isFinite(v.duration) && setDur(v.duration);
    const sync = () => setT(v.currentTime);
    const play = () => setPlaying(true);
    const pause = () => setPlaying(false);
    const volume = () => setMuted(v.muted);
    v.addEventListener('loadedmetadata', meta);
    v.addEventListener('timeupdate', sync);
    v.addEventListener('seeked', sync);
    v.addEventListener('play', play);
    v.addEventListener('pause', pause);
    v.addEventListener('ended', pause);
    v.addEventListener('volumechange', volume);
    if (rvfc) raf = (v as HTMLVideoElement & { requestVideoFrameCallback: (cb: () => void) => number }).requestVideoFrameCallback(tick);
    return () => {
      v.removeEventListener('loadedmetadata', meta);
      v.removeEventListener('timeupdate', sync);
      v.removeEventListener('seeked', sync);
      v.removeEventListener('play', play);
      v.removeEventListener('pause', pause);
      v.removeEventListener('ended', pause);
      v.removeEventListener('volumechange', volume);
      if (raf !== null && 'cancelVideoFrameCallback' in v) (v as HTMLVideoElement & { cancelVideoFrameCallback: (h: number) => void }).cancelVideoFrameCallback(raf);
    };
  }, [asset.url]);

  useEffect(() => {
    const v = ref.current;
    if (!v || !jump || jump.t === undefined) return;
    if (jump.position !== undefined && jump.position !== asset.position) return;
    v.pause();
    v.currentTime = clamp(jump.t, 0, dur || jump.t);
    setT(v.currentTime);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jump?.nonce]);

  const step = useCallback((d: number) => {
    const v = ref.current;
    if (!v) return;
    v.pause();
    const frame = Math.floor(v.currentTime * fps + 1e-3);
    // Land in the middle of the target frame so rounding never shows the neighbour.
    v.currentTime = clamp((frame + d + 0.5) / fps, 0, v.duration || dur);
    setT(v.currentTime);
  }, [fps, dur]);

  const toggle = () => {
    const v = ref.current;
    if (!v) return;
    if (v.paused) void v.play().catch(() => {});
    else v.pause();
  };
  const seekTo = (s: number) => {
    const v = ref.current;
    if (!v || !dur) return;
    v.currentTime = clamp(s, 0, dur);
    setT(v.currentTime);
  };
  const timeAt = (clientX: number) => {
    const r = track.current!.getBoundingClientRect();
    return clamp((clientX - r.left) / r.width, 0, 1) * dur;
  };
  const dropAt = (s: number) => onDraft({ type: 'time', t: round2(s), position: asset.position });

  const clickPicture = () => {
    const v = ref.current;
    if (!v) return;
    if (!canAnnotate) return toggle();
    v.pause();
    dropAt(v.currentTime);
  };

  // The subtitle list follows the video.
  useEffect(() => { playhead.set(now); }, [now]);

  const mine = threads.filter((c): c is TimeThread => c.anchor?.type === 'time' && (c.anchor.position ?? firstVideoPosition) === asset.position);
  const draftHere = draft?.type === 'time' && (draft.position ?? firstVideoPosition) === asset.position ? draft : null;
  const pct = (s: number) => (dur ? clamp((s / dur) * 100, 0, 100) : 0);

  // A mark shows its number when its neighbours leave room for it; otherwise it is a thin bar.
  const marks = [...mine].sort((a, b) => a.anchor.t - b.anchor.t);
  const px = (s: number) => (pct(s) / 100) * width;
  const roomy = (i: number) => {
    const x = px(marks[i]!.anchor.t);
    const prev = i > 0 ? px(marks[i - 1]!.anchor.t) : -Infinity;
    const next = i < marks.length - 1 ? px(marks[i + 1]!.anchor.t) : Infinity;
    return width > 0 && x - prev >= 20 && next - x >= 20;
  };
  const step10 = tickStep(dur, width);
  const ticks: number[] = [];
  if (dur > 0 && width > 0) for (let s = 0; s <= dur + 1e-6; s += step10) ticks.push(s);

  return (
    <div
      ref={player}
      className={`rv-player ${fs.on ? 'is-full' : ''}`}
      onKeyDown={(e) => {
        if (typing(e, false)) return;
        if (e.key === ',') { e.preventDefault(); step(-1); }
        if (e.key === '.') { e.preventDefault(); step(1); }
        if ((e.key === ' ' || e.key === 'k') && !typing(e)) { e.preventDefault(); toggle(); }
      }}
    >
      <div className="rv-media" tabIndex={0} aria-label={t('review.video.label')}>
        <div className="stage-inner">
          <video
            ref={ref}
            src={asset.url}
            poster={poster}
            playsInline
            preload="metadata"
            onClick={clickPicture}
            className={canAnnotate ? 'annotate' : ''}
            title={canAnnotate ? t('review.video.clickToComment') : undefined}
          />
          <SafeZoneOverlay zone={safeZone} />
        </div>
      </div>

      <div className="rv-bar">
        <div className="rv-ctl">
          <div className="rv-ctl-group">
            <button type="button" className="rv-ic rv-play" onClick={toggle} aria-label={playing ? t('review.video.pause') : t('review.video.play')}>
              {playing ? <IconPause /> : <IconPlay />}
            </button>
            <button type="button" className="rv-ic" onClick={() => step(-1)} aria-label={t('review.video.prevFrame')} title={t('review.video.prevFrameHint')}><IconFrameBack /></button>
            <button type="button" className="rv-ic" onClick={() => step(1)} aria-label={t('review.video.nextFrame')} title={t('review.video.nextFrameHint')}><IconFrameFwd /></button>
            <button type="button" className="rv-ic" onClick={() => { const v = ref.current; if (v) v.muted = !v.muted; }} aria-label={muted ? t('review.video.unmute') : t('review.video.mute')}>
              {muted ? <IconMuted /> : <IconSound />}
            </button>
            <FullscreenButton fs={fs} />
            <span className="rv-tc" aria-live="off">
              <b>{timecode(now)}</b> / {timecode(dur)}
              <span className="rv-frame" title={t('review.video.frameHint', { fps })}>f{Math.floor(now * fps + 1e-3)}</span>
            </span>
          </div>
          <div className="rv-ctl-group rv-ctl-end">
            {canAnnotate && (
              <>
                <button type="button" className="btn btn-small" onClick={() => dropAt(now)}>{t('review.video.commentHere')}</button>
                {draftHere && (
                  <button type="button" className="btn btn-small" disabled={now < draftHere.t} onClick={() => onDraft({ ...draftHere, t_end: round2(now) })} title={t('review.video.setEndHint')}>
                    {t('review.video.setEnd')}
                  </button>
                )}
              </>
            )}
            {tools}
          </div>
        </div>

        <div
          ref={track}
          className="timeline rv-track"
          role="slider"
          tabIndex={0}
          aria-label={t('review.timeline.label')}
          aria-valuemin={0}
          aria-valuemax={Math.round(dur)}
          aria-valuenow={Math.round(now)}
          aria-valuetext={timecode(now)}
          onKeyDown={(e) => {
            if (e.key === 'ArrowLeft') { e.preventDefault(); seekTo(now - (e.shiftKey ? 5 : 1)); }
            if (e.key === 'ArrowRight') { e.preventDefault(); seekTo(now + (e.shiftKey ? 5 : 1)); }
            if (e.key === 'Home') { e.preventDefault(); seekTo(0); }
            if (e.key === 'End') { e.preventDefault(); seekTo(dur); }
            if (e.key === ',') { e.preventDefault(); step(-1); }
            if (e.key === '.') { e.preventDefault(); step(1); }
          }}
          onPointerDown={(e) => {
            if (e.button !== 0) return;
            e.currentTarget.setPointerCapture(e.pointerId);
            drag.current = { x: e.clientX, moved: false };
            seekTo(timeAt(e.clientX));
          }}
          onPointerMove={(e) => {
            const d = drag.current;
            if (!d) return;
            if (Math.abs(e.clientX - d.x) > 4) d.moved = true;
            seekTo(timeAt(e.clientX));
          }}
          onPointerUp={(e) => {
            const d = drag.current;
            drag.current = null;
            // A click (not a drag) is "comment here"; a drag only moves through the video.
            if (d && !d.moved && canAnnotate) {
              ref.current?.pause();
              dropAt(timeAt(e.clientX));
            }
          }}
          onPointerCancel={() => { drag.current = null; }}
        >
          <span className="rv-fill" style={{ width: `${pct(now)}%` }} />
          {marks.map((c) => c.anchor.t_end !== undefined && (
            <span
              key={`span-${c.id}`}
              className={`rv-span ${c.status === 'resolved' ? 'resolved' : ''}`}
              style={{ left: `${pct(c.anchor.t)}%`, width: `${Math.max(0.6, pct(c.anchor.t_end) - pct(c.anchor.t))}%` }}
            />
          ))}
          {draftHere?.t_end !== undefined && (
            <span className="rv-span draft" style={{ left: `${pct(draftHere.t)}%`, width: `${Math.max(0.6, pct(draftHere.t_end) - pct(draftHere.t))}%` }} />
          )}
          {marks.map((c, i) => {
            const n = numbers.get(c.id);
            const big = n !== undefined && roomy(i);
            return (
              <button
                key={c.id}
                type="button"
                className={`marker rv-mk ${big ? 'num' : ''} ${c.status === 'resolved' ? 'resolved' : ''} ${focus === c.id ? 'focus' : ''}`}
                style={{ left: `${pct(c.anchor.t)}%` }}
                aria-label={t('review.timeline.marker', { n: n ?? '', time: shortTimecode(c.anchor.t) })}
                onPointerDown={(e) => e.stopPropagation()}
                onClick={() => {
                  onFocus(c.id);
                  const v = ref.current;
                  if (v) { v.pause(); v.currentTime = c.anchor.t; setT(c.anchor.t); }
                }}
              >
                {big && n}
              </button>
            );
          })}
          {draftHere && <span className="rv-mk-draft" style={{ left: `${pct(draftHere.t)}%` }} aria-hidden="true" />}
          <span className="rv-playhead" style={{ left: `${pct(now)}%` }} />
        </div>
        <div className="rv-ticks" aria-hidden="true">
          {ticks.map((s) => {
            const at = pct(s);
            // The last label is dropped when it would run into the end of the bar.
            if (s > 0 && at > 96) return null;
            return <span key={s} style={{ left: `${at}%` }} className={s === 0 ? 'first' : ''}>{timecode(s, false)}</span>;
          })}
        </div>
      </div>
    </div>
  );
}

// ───────────────────────────── pages of a carousel or a PDF ─────────────────────────────

function Pager({ unit, page, count, onPage, thumbs, counts, tools, fs }: {
  unit: 'page' | 'item';
  page: number;
  count: number;
  onPage: (n: number) => void;
  thumbs: (string | undefined)[];
  counts: number[];
  tools?: ReactNode;
  fs?: ReturnType<typeof useFullscreen>;
}) {
  if (count <= 1 && !tools && !fs?.supported) return null;
  return (
    <div className="rv-bar rv-pager">
      <div className="rv-ctl">
        {count > 1 && (
          <div className="rv-pages" role="group" aria-label={unit === 'page' ? t('review.pager.pdfGroup') : t('review.pager.itemGroup')}>
            <button type="button" className="rv-ic" disabled={page <= 1} onClick={() => onPage(page - 1)} aria-label={t('review.pager.prev')}><IconPrev /></button>
            <span className="rv-tc" aria-live="polite">{unit === 'page' ? t('review.pager.page', { n: page, count }) : t('review.pager.item', { n: page, count })}</span>
            <button type="button" className="rv-ic" disabled={page >= count} onClick={() => onPage(page + 1)} aria-label={t('review.pager.next')}><IconNext /></button>
          </div>
        )}
        <span className="grow" />
        {tools}
        {fs && <FullscreenButton fs={fs} />}
      </div>
      {count > 1 && (
        <div className="rv-strip">
          {Array.from({ length: count }, (_, i) => (
            <button
              key={i}
              type="button"
              className={`rv-tile ${i + 1 === page ? 'on' : ''}`}
              aria-label={unit === 'page' ? t('review.pager.goToPage', { n: i + 1 }) : t('review.pager.goToItem', { n: i + 1 })}
              aria-current={i + 1 === page ? 'true' : undefined}
              onClick={() => onPage(i + 1)}
            >
              {thumbs[i] ? <img src={thumbs[i]} alt="" loading="lazy" draggable={false} /> : <span className="rv-tile-n">{i + 1}</span>}
              {(counts[i] ?? 0) > 0 && <span className="rv-tile-c">{counts[i]}</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ───────────────────────────── the stage ─────────────────────────────

export interface StageProps {
  assets: Asset[];
  threads: CommentThread[];
  /** The number each anchored thread carries in the list, shown on its mark. */
  numbers: Map<string, number>;
  draft: Anchor | null;
  onDraft: (a: Anchor | null) => void;
  canAnnotate: boolean;
  focus: string | null;
  onFocus: (id: string) => void;
  jump: Jump | null;
  safeZone?: SafeZone | null;
  /** Extra controls for the picture (what the network covers), placed in its control bar. */
  tools?: ReactNode;
}

/** Shows a version's pages one at a time: a video, an image, a carousel item or a PDF page, with its comments on top. */
export function Stage(p: StageProps) {
  const primaries = useMemo(() => primariesOf(p.assets), [p.assets]);
  const pdf = p.assets.find((a) => a.kind === 'pdf');
  const cover = p.assets.find((a) => a.kind === 'cover');
  const firstVideoPosition = primaries.find((a) => a.kind === 'video')?.position ?? 0;
  const [page, setPage] = useState(1);
  const [pdfPages, setPdfPages] = useState(0);
  const stage = useRef<HTMLDivElement>(null);
  const fs = useFullscreen(stage);
  const count = pdf ? pdfPages : primaries.length;

  useEffect(() => {
    const j = p.jump;
    if (!j) return;
    if (j.page !== undefined) setPage(j.page);
    else if (j.t !== undefined) {
      const idx = primaries.findIndex((a) => a.kind === 'video' && a.position === (j.position ?? firstVideoPosition));
      if (idx >= 0) setPage(idx + 1);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p.jump?.nonce]);

  const current = primaries[page - 1];
  const regionProps = { page, threads: p.threads, numbers: p.numbers, draft: p.draft, onDraft: p.onDraft, canAnnotate: p.canAnnotate, focus: p.focus, onFocus: p.onFocus };
  const go = (n: number) => setPage(clamp(n, 1, Math.max(count, 1)));

  // Open comments per page, for the badges on the strip.
  const counts = Array.from({ length: count }, (_, i) => p.threads.filter((c) => {
    if (c.status !== 'open' || !c.anchor) return false;
    if (c.anchor.type === 'region') return c.anchor.page === i + 1;
    const item = primaries[i];
    return !pdf && item?.kind === 'video' && (c.anchor.position ?? firstVideoPosition) === item.position;
  }).length);
  const thumbs = pdf ? [] : primaries.map((a) => (a.kind === 'image' ? a.url : cover?.url));
  const unit = pdf ? 'page' : 'item';

  return (
    <div
      ref={stage}
      className={`rv-stage ${fs.on ? 'is-full' : ''}`}
      onKeyDown={(e) => {
        if (count <= 1 || (typing(e) && !(e.target as HTMLElement).closest('.rv-tile')) || current?.kind === 'video') return;
        if (e.key === 'ArrowLeft') { e.preventDefault(); go(page - 1); }
        if (e.key === 'ArrowRight') { e.preventDefault(); go(page + 1); }
      }}
    >
      {pdf ? (
        <>
          <div className="rv-media rv-paper" tabIndex={-1}>
            <div className="stage-inner">
              <PdfCanvas url={pdf.url} page={page} onPages={setPdfPages} />
              <RegionLayer {...regionProps} />
            </div>
          </div>
          <Pager unit="page" page={page} count={count} onPage={go} thumbs={[]} counts={counts} fs={fs} />
        </>
      ) : current?.kind === 'video' ? (
        <>
          <VideoPlayer
            key={current.id}
            asset={current}
            poster={cover?.url}
            threads={p.threads}
            numbers={p.numbers}
            firstVideoPosition={firstVideoPosition}
            draft={p.draft}
            onDraft={p.onDraft}
            canAnnotate={p.canAnnotate}
            focus={p.focus}
            onFocus={p.onFocus}
            jump={p.jump}
            safeZone={p.safeZone}
            tools={p.tools}
          />
          {count > 1 && <Pager unit={unit} page={page} count={count} onPage={go} thumbs={thumbs} counts={counts} />}
        </>
      ) : current ? (
        <>
          <div className="rv-media" tabIndex={-1}>
            <div className="stage-inner">
              <img src={current.url} alt={current.name} draggable={false} />
              <SafeZoneOverlay zone={p.safeZone} />
              <RegionLayer {...regionProps} />
            </div>
          </div>
          <Pager unit={unit} page={page} count={count} onPage={go} thumbs={thumbs} counts={counts} tools={p.tools} fs={fs} />
        </>
      ) : (
        <div className="rv-media rv-nothing">{t('review.stage.empty')}</div>
      )}
    </div>
  );
}

// ───────────────────────────── compare two versions ─────────────────────────────

/**
 * Two versions side by side. Videos play in sync from one control bar; images can be shown side by side or flipped;
 * PDFs share the page number.
 */
export function CompareStage({ left, right, leftLabel, rightLabel }: { left: Asset[]; right: Asset[]; leftLabel: string; rightLabel: string }) {
  const lp = primariesOf(left), rp = primariesOf(right);
  const lpdf = left.find((a) => a.kind === 'pdf'), rpdf = right.find((a) => a.kind === 'pdf');
  const [page, setPage] = useState(1);
  const [pages, setPages] = useState(0);
  const [mode, setMode] = useState<'side' | 'flip'>('side');
  const [showRight, setShowRight] = useState(true);
  const a = useRef<HTMLVideoElement>(null), b = useRef<HTMLVideoElement>(null);
  const [now, setT] = useState(0);
  const [playing, setPlaying] = useState(false);

  const la = lpdf ? undefined : lp[page - 1], ra = rpdf ? undefined : rp[page - 1];
  const count = lpdf || rpdf ? pages : Math.max(lp.length, rp.length);
  const bothVideo = la?.kind === 'video' && ra?.kind === 'video';
  const fps = la?.fps || 30;
  const dur = Math.max(a.current?.duration || 0, la?.duration_ms ? la.duration_ms / 1000 : 0);

  useEffect(() => {
    const va = a.current, vb = b.current;
    if (!bothVideo || !va || !vb) return;
    vb.muted = true;
    const onTime = () => {
      setT(va.currentTime);
      if (Math.abs(vb.currentTime - va.currentTime) > 0.15) vb.currentTime = va.currentTime;
    };
    const onPlay = () => { setPlaying(true); void vb.play(); };
    const onPause = () => { setPlaying(false); vb.pause(); vb.currentTime = va.currentTime; };
    va.addEventListener('timeupdate', onTime);
    va.addEventListener('seeked', onTime);
    va.addEventListener('play', onPlay);
    va.addEventListener('pause', onPause);
    return () => {
      va.removeEventListener('timeupdate', onTime);
      va.removeEventListener('seeked', onTime);
      va.removeEventListener('play', onPlay);
      va.removeEventListener('pause', onPause);
    };
  }, [bothVideo, la?.id, ra?.id]);

  const toggle = () => {
    const va = a.current;
    if (!va) return;
    if (va.paused) void va.play().catch(() => {});
    else va.pause();
  };
  const stepFrame = (d: number) => {
    const va = a.current, vb = b.current;
    if (!va || !vb) return;
    va.pause();
    const target = clamp((Math.floor(va.currentTime * fps + 1e-3) + d + 0.5) / fps, 0, va.duration || dur);
    va.currentTime = target;
    vb.currentTime = target;
    setT(target);
  };

  const view = (asset: Asset | undefined, pdf: Asset | undefined, ref: RefObject<HTMLVideoElement | null>, label: string, side: 'left' | 'right') => (
    <figure className={`rv-cmp-pane ${side}`}>
      <figcaption><span className={`tag ${side === 'right' ? 'rv-tag-now' : ''}`}>{label}</span></figcaption>
      <div className={`rv-media ${pdf ? 'rv-paper' : ''}`}>
        {pdf ? <div className="stage-inner"><PdfCanvas url={pdf.url} page={page} onPages={(n) => setPages((p) => Math.max(p, n))} /></div>
          : asset?.kind === 'video' ? <video ref={ref} src={asset.url} playsInline preload="auto" muted={ref === b} onClick={toggle} />
          : asset ? <img src={asset.url} alt={t('review.compare.imageAlt', { label, name: asset.name })} />
          : <div className="rv-nothing">{t('review.compare.nothing')}</div>}
      </div>
    </figure>
  );

  return (
    <div className="rv-stage rv-compare">
      {mode === 'flip' && !bothVideo ? (
        <div className="compare flip">{showRight ? view(ra, rpdf, b, rightLabel, 'right') : view(la, lpdf, a, leftLabel, 'left')}</div>
      ) : (
        <div className="compare">
          {view(la, lpdf, a, leftLabel, 'left')}
          {view(ra, rpdf, b, rightLabel, 'right')}
        </div>
      )}
      <div className="rv-bar">
        <div className="rv-ctl">
          {count > 1 && (
            <div className="rv-pages" role="group" aria-label={lpdf || rpdf ? t('review.pager.pdfGroup') : t('review.pager.itemGroup')}>
              <button type="button" className="rv-ic" disabled={page <= 1} onClick={() => setPage(page - 1)} aria-label={t('review.pager.prev')}><IconPrev /></button>
              <span className="rv-tc">{lpdf || rpdf ? t('review.pager.page', { n: page, count }) : t('review.pager.item', { n: page, count })}</span>
              <button type="button" className="rv-ic" disabled={page >= count} onClick={() => setPage(page + 1)} aria-label={t('review.pager.next')}><IconNext /></button>
            </div>
          )}
          {bothVideo && (
            <>
              <button type="button" className="rv-ic rv-play" onClick={toggle} aria-label={playing ? t('review.compare.pauseBoth') : t('review.compare.playBoth')} title={playing ? t('review.compare.pauseBoth') : t('review.compare.playBoth')}>
                {playing ? <IconPause /> : <IconPlay />}
              </button>
              <button type="button" className="rv-ic" onClick={() => stepFrame(-1)} aria-label={t('review.video.prevFrame')}><IconFrameBack /></button>
              <button type="button" className="rv-ic" onClick={() => stepFrame(1)} aria-label={t('review.video.nextFrame')}><IconFrameFwd /></button>
              <span className="rv-tc"><b>{timecode(now)}</b> / {timecode(dur)}</span>
            </>
          )}
          <span className="grow" />
          {!bothVideo && (
            <div className="rv-seg" role="group" aria-label={t('review.compare.modeGroup')}>
              <button type="button" aria-pressed={mode === 'side'} onClick={() => setMode('side')}>{t('review.compare.side')}</button>
              <button type="button" aria-pressed={mode === 'flip'} onClick={() => setMode('flip')}>{t('review.compare.flip')}</button>
            </div>
          )}
          {mode === 'flip' && !bothVideo && (
            <button type="button" className="btn btn-small" onClick={() => setShowRight((s) => !s)}>{t('review.compare.showing', { label: showRight ? rightLabel : leftLabel })}</button>
          )}
        </div>
        {bothVideo && (
          <input
            type="range" className="rv-range" min={0} max={dur || 1} step={0.01} value={now} aria-label={t('review.compare.position')}
            onChange={(e) => { const v = Number(e.target.value); if (a.current && b.current) { a.current.currentTime = v; b.current.currentTime = v; setT(v); } }}
          />
        )}
      </div>
    </div>
  );
}
