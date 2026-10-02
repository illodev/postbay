// The legacy build carries the polyfills that older browsers need (Map.getOrInsertComputed, for one).
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import workerUrl from 'pdfjs-dist/legacy/build/pdf.worker.min.mjs?url';
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent as RPointerEvent, type ReactNode, type RefObject } from 'react';
import type { Anchor, Asset, CommentThread, DrawColour, Shape } from '../api';
import { t } from '../i18n';
import { playhead } from '../lib/playhead';
import { Avatar } from './Avatar';
import { bboxOf, DrawLayer, DrawTools, type Tool } from './Drawing';
import { Icon } from './icons';
import { Segmented } from './ui';
import '../styles/review.css';

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));
export const round2 = (n: number) => Math.round(n * 100) / 100;

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

/** The first line of a comment, short enough for a tooltip. */
export const firstLine = (text: string, max = 90) => {
  const line = text.split('\n')[0]!.trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
};

/** A person's name as the list shows it: an e-mail address loses its domain (the whole address is in the tooltip). */
export const shortName = (author: string) => (author.includes('@') ? author.split('@')[0]! : author);

/** Which video the playhead belongs to, for a comment written "at the current moment". */
export const liveVideo = { position: 0 };

/** Whether the agent took part in a thread (it answered it): its mark carries the agent's sign. */
export const agentInThread = (c: CommentThread) => c.replies.some((r) => r.by_agent);

/** The thread being said right now: the latest whose moment (or span) holds the playhead. */
export function threadAt(threads: CommentThread[], now: number, position?: number): string | null {
  let best: CommentThread | null = null;
  for (const c of threads) {
    const a = c.anchor;
    if (a?.type !== 'time') continue;
    if (position !== undefined && a.position !== undefined && a.position !== position) continue;
    const end = a.t_end ?? a.t + 2.5;
    if (a.t <= now + 0.05 && now < end && (!best || (best.anchor as { t: number }).t <= a.t)) best = c;
  }
  return best?.id ?? null;
}

/** A request from outside the stage to show a place: a page and/or a moment of a video. The nonce makes repeats count. */
export interface Jump {
  nonce: number;
  page?: number;
  t?: number;
  position?: number;
}

/** What the stage needs to draw over the picture: the tool, the colour, the drawing being made and how to add to it. */
export interface DrawProps {
  tool: Tool | null;
  onTool: (t: Tool | null) => void;
  colour: DrawColour;
  onColour: (c: DrawColour) => void;
  sketch: Shape[];
  /** A new shape, with the place it belongs to (the moment of the video, or the page and the box the drawing covers). */
  onSketch: (shapes: Shape[], base: Anchor) => void;
  onUndo: () => void;
  onClear: () => void;
}

const primariesOf = (assets: Asset[]) =>
  assets.filter((a) => a.kind === 'video' || a.kind === 'image').sort((a, b) => a.position - b.position);

/**
 * The review's keyboard: it listens on the whole page, so the shortcuts work without first clicking the player, and stays out of
 * the way of anything that takes typing (fields, a dialog). The handler says whether it used the key.
 */
function useStageKeys(handler: (e: KeyboardEvent, onControl: boolean) => boolean) {
  const ref = useRef(handler);
  ref.current = handler;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return;
      const el = e.target as HTMLElement | null;
      if (el?.closest?.('input, textarea, select, [contenteditable="true"]')) return;
      if (document.querySelector('dialog[open]')) return;
      if (ref.current(e, !!el?.closest?.('button, a, [role="tab"], [role="menuitem"]'))) e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
}

// ───────────────────────────── icons ─────────────────────────────

const IconPlay = () => <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M7.5 4.8v14.4a1 1 0 0 0 1.5.86l11.6-7.2a1 1 0 0 0 0-1.72L9 3.94a1 1 0 0 0-1.5.86z" fill="currentColor" /></svg>;
const IconPause = () => <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><rect x="6" y="4.5" width="4" height="15" rx="1.2" fill="currentColor" /><rect x="14" y="4.5" width="4" height="15" rx="1.2" fill="currentColor" /></svg>;

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
  return <button type="button" className="rv-ic rv-ic-full" onClick={fs.toggle} aria-label={label} title={`${label} (F)`}><Icon name="expand" size={17} /></button>;
}

/** The "?" in the control bar: the keyboard shortcuts of what is on the stage. The same key opens it. */
function ShortcutHelp({ open, onToggle, rows }: { open: boolean; onToggle: () => void; rows: [string, string][] }) {
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => { if (box.current && !box.current.contains(e.target as Node)) onToggle(); };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open, onToggle]);
  return (
    <div ref={box} className="rv-help">
      <button type="button" className="rv-ic rv-help-btn" aria-expanded={open} onClick={onToggle} aria-label={t('review.keys.title')} title={`${t('review.keys.title')} (?)`}>?</button>
      {open && (
        <div className="rv-help-pop" role="dialog" aria-label={t('review.keys.title')}>
          <strong>{t('review.keys.title')}</strong>
          <dl>
            {rows.map(([k, v]) => (
              <div key={k}><dt>{k.split(' ').map((p, i) => (p === '/' || p === '+' ? <span key={i}> {p} </span> : <kbd key={i}>{p}</kbd>))}</dt><dd>{v}</dd></div>
            ))}
          </dl>
        </div>
      )}
    </div>
  );
}

const videoKeys = (draw: boolean): [string, string][] => [
  [t('review.keys.space'), t('review.keys.play')],
  ['← / →', t('review.keys.frame')],
  [`${t('review.keys.shift')} + ← / →`, t('review.keys.second')],
  ['C', t('review.keys.comment')],
  ...(draw ? [['D', t('review.keys.draw')] as [string, string]] : []),
  ['F', t('review.keys.fullscreen')],
  ['Esc', t('review.keys.cancel')],
  [t('review.keys.enter'), t('review.keys.send')],
  [`${t('review.keys.shift')} + ${t('review.keys.enter')}`, t('review.keys.newline')],
];
const pageKeys = (draw: boolean): [string, string][] => [
  ['← / →', t('review.keys.page')],
  ...(draw ? [['D', t('review.keys.draw')] as [string, string]] : []),
  ['Esc', t('review.keys.cancel')],
  [t('review.keys.enter'), t('review.keys.send')],
  [`${t('review.keys.shift')} + ${t('review.keys.enter')}`, t('review.keys.newline')],
];

/** The label over a saved drawing: who drew it, and when in the video. */
const inkLabel = (c: CommentThread) => {
  const who = shortName(c.author).split(' ')[0]!;
  return c.anchor?.type === 'time' ? `${who} · ${shortTimecode(c.anchor.t)}` : who;
};

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
 * Transparent layer over a page: drag to mark a rectangle, click to drop a point. A mark's pin opens its thread; anywhere else, a
 * click or a drag starts a new comment there (replacing the one being written), even inside an area that already has comments.
 * Everything is stored as fractions of the page, so it survives any screen size. The box a gesture is measured against is taken
 * when it starts, and the pointer is always released at its end, so one gesture can never leave the next one measured wrong.
 */
function RegionLayer({ page, threads, numbers, draft, onDraft, canAnnotate, focus, onFocus, hideDraft }: RegionProps & { hideDraft?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const gesture = useRef<{ id: number; rect: DOMRect; x0: number; y0: number } | null>(null);
  const [live, setLive] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  const marks = threads.filter((c): c is RegionThread => c.anchor?.type === 'region' && c.anchor.page === page);

  const rel = (e: RPointerEvent, r: DOMRect) => ({ x: clamp((e.clientX - r.left) / r.width, 0, 1), y: clamp((e.clientY - r.top) / r.height, 0, 1) });
  const boxOf = (g: NonNullable<typeof gesture.current>, p: { x: number; y: number }) => ({
    x: Math.min(g.x0, p.x), y: Math.min(g.y0, p.y), w: Math.abs(p.x - g.x0), h: Math.abs(p.y - g.y0),
  });
  const release = (e: RPointerEvent<HTMLDivElement>) => {
    gesture.current = null;
    setLive(null);
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
  };

  const down = (e: RPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || !e.isPrimary || !canAnnotate) return;
    // Only the layer itself starts a mark: a pin is a button of its own.
    if (e.target !== e.currentTarget) return;
    e.preventDefault();
    const rect = e.currentTarget.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    const p = rel(e, rect);
    gesture.current = { id: e.pointerId, rect, x0: p.x, y0: p.y };
    setLive(null);
  };
  const move = (e: RPointerEvent<HTMLDivElement>) => {
    const g = gesture.current;
    if (!g || g.id !== e.pointerId) return;
    const b = boxOf(g, rel(e, g.rect));
    setLive(b.w * g.rect.width >= 6 || b.h * g.rect.height >= 6 ? b : null);
  };
  const up = (e: RPointerEvent<HTMLDivElement>) => {
    const g = gesture.current;
    if (!g || g.id !== e.pointerId) return;
    const b = boxOf(g, rel(e, g.rect));
    const small = b.w * g.rect.width < 6 && b.h * g.rect.height < 6;
    release(e);
    if (small) {
      // A click: a point lands where the gesture started (a hand that moves a pixel while clicking does not move it).
      onDraft({ type: 'region', page, x: round2(g.x0), y: round2(g.y0), w: 0, h: 0 });
      return;
    }
    const x = round2(b.x), y = round2(b.y);
    onDraft({ type: 'region', page, x, y, w: Math.min(round2(b.w), round2(1 - x)), h: Math.min(round2(b.h), round2(1 - y)) });
  };

  const pin = (a: { x: number; y: number; w: number; h: number }, cls: string, key: string, label: ReactNode, open?: () => void, tip?: string) => {
    const point = a.w === 0 && a.h === 0;
    // Near the top edge the pin hangs below its point, and near the right edge it leans left, so it never leaves the page.
    const flip = a.y < 0.07;
    // Near the right edge it leans left.
    const lean = a.x > 0.9;
    const classes = `rv-pin ${flip ? 'flip' : ''} ${lean ? 'lean' : ''}`;
    const head = open ? (
      <button
        type="button"
        className={classes}
        aria-label={tip ?? t('review.pin.open', { n: String(label) })}
        data-tip={tip}
        onPointerDown={(e) => e.stopPropagation()}
        onClick={(e) => { e.stopPropagation(); open(); }}
      >
        {label}
      </button>
    ) : (
      <span className={classes} aria-hidden="true">{label}</span>
    );
    return point ? (
      <div key={key} className={`region-box rv-point ${cls}`} style={{ left: `${a.x * 100}%`, top: `${a.y * 100}%` }}>{head}</div>
    ) : (
      <div key={key} className={`region-box rv-area ${cls}`} style={{ left: `${a.x * 100}%`, top: `${a.y * 100}%`, width: `${a.w * 100}%`, height: `${a.h * 100}%` }}>{head}</div>
    );
  };

  return (
    <div
      ref={ref}
      className={`region-layer ${canAnnotate ? 'annotate' : ''}`}
      onPointerDown={down}
      onPointerMove={move}
      onPointerUp={up}
      onPointerCancel={release}
      onLostPointerCapture={() => { gesture.current = null; setLive(null); }}
    >
      {marks.map((m) => {
        const n = numbers.get(m.id);
        // A drawing marks its own place: its thread keeps only the pin, at the drawing's corner.
        const a = m.anchor.drawing?.length ? { x: m.anchor.x, y: m.anchor.y, w: 0, h: 0 } : m.anchor;
        return pin(
          a,
          `${m.status === 'resolved' ? 'resolved' : ''} ${focus === m.id ? 'focus' : ''}`,
          m.id,
          m.status === 'resolved' ? '✓' : n ?? '•',
          () => onFocus(m.id),
          `${n ? `#${n} · ` : ''}${shortName(m.author)}: ${firstLine(m.body, 70)}`,
        );
      })}
      {draft?.type === 'region' && draft.page === page && !live && !hideDraft && pin(draft, 'draft', 'draft', '+')}
      {live && pin(live, 'draft', 'live', '+')}
    </div>
  );
}

// ───────────────────────────── PDF page ─────────────────────────────

/** Draws one page of a PDF as large as its box allows, and again whenever the box changes size. */
export function PdfCanvas({ url, page, onPages }: { url: string; page: number; onPages?: (n: number) => void }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [doc, setDoc] = useState<pdfjs.PDFDocumentProxy | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });

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

  // The box the page fits in; drawn again once its size settles.
  useEffect(() => {
    const box = canvas.current?.closest<HTMLElement>('.rv-media');
    if (!box) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const ro = new ResizeObserver(() => {
      clearTimeout(timer);
      timer = setTimeout(() => setSize({ w: box.clientWidth, h: box.clientHeight }), 120);
    });
    ro.observe(box);
    return () => { clearTimeout(timer); ro.disconnect(); };
  }, []);

  useEffect(() => {
    if (!doc || !canvas.current || !size.w || !size.h) return;
    let cancelled = false;
    let renderTask: pdfjs.RenderTask | null = null;
    doc.getPage(clamp(page, 1, doc.numPages)).then((p) => {
      if (cancelled || !canvas.current) return;
      const base = p.getViewport({ scale: 1 });
      const fit = Math.min(Math.min(1400, size.w) / base.width, size.h / base.height);
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

type TimeThread = CommentThread & { anchor: Extract<Anchor, { type: 'time' }> };

/**
 * The line under the video: what has played in violet, the playhead as a knob, each comment as its author's mark above the line
 * (the agent's sign when the agent answered it), its span as a yellow stretch, and the comment in view ringed in yellow. Hovering
 * a mark shows the comment; hovering the line shows the time under the pointer. A click or a drag moves through the video.
 */
function Timeline({ now, dur, marks, numbers, focus, current, draft, onSeek, onScrub, onMark }: {
  now: number;
  dur: number;
  marks: TimeThread[];
  numbers: Map<string, number>;
  focus: string | null;
  current: string | null;
  draft: Extract<Anchor, { type: 'time' }> | null;
  onSeek: (s: number) => void;
  onScrub?: (scrubbing: boolean) => void;
  onMark: (c: TimeThread) => void;
}) {
  const track = useRef<HTMLDivElement>(null);
  const width = useWidth(track);
  const drag = useRef<number | null>(null);
  const [tip, setTip] = useState<string | null>(null);
  const [hover, setHover] = useState<number | null>(null);
  const pct = (s: number) => (dur ? clamp((s / dur) * 100, 0, 100) : 0);
  const timeAt = (clientX: number) => {
    const r = track.current!.getBoundingClientRect();
    return clamp((clientX - r.left) / r.width, 0, 1) * dur;
  };
  const sorted = [...marks].sort((a, b) => a.anchor.t - b.anchor.t);
  const tipped = sorted.find((c) => c.id === tip);
  const edge = (p: number) => (p < 14 ? 'start' : p > 86 ? 'end' : '');

  return (
    <div
      ref={track}
      className="rv-tl"
      role="slider"
      tabIndex={0}
      aria-label={t('review.timeline.label')}
      aria-valuemin={0}
      aria-valuemax={Math.round(dur)}
      aria-valuenow={Math.round(now)}
      aria-valuetext={timecode(now)}
      onPointerDown={(e) => {
        if (e.button !== 0 || !dur) return;
        e.currentTarget.setPointerCapture(e.pointerId);
        drag.current = e.pointerId;
        onScrub?.(true);
        onSeek(timeAt(e.clientX));
      }}
      onPointerMove={(e) => {
        if (!dur) return;
        if (e.pointerType === 'mouse') setHover(timeAt(e.clientX));
        if (drag.current === e.pointerId) onSeek(timeAt(e.clientX));
      }}
      onPointerLeave={() => setHover(null)}
      onPointerUp={(e) => {
        if (drag.current !== e.pointerId) return;
        drag.current = null;
        onScrub?.(false);
        if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
      }}
      onPointerCancel={() => { drag.current = null; onScrub?.(false); }}
    >
      <div className="rv-tl-lane">
        {sorted.map((c) => {
          const n = numbers.get(c.id);
          const on = focus === c.id || current === c.id;
          return (
            <button
              key={c.id}
              type="button"
              className={`rv-mark ${c.status === 'resolved' ? 'resolved' : ''} ${on ? 'on' : ''}`}
              style={{ left: `${pct(c.anchor.t)}%`, zIndex: on ? 3 : 1 }}
              aria-label={t('review.timeline.marker', { n: n ?? '', time: shortTimecode(c.anchor.t) })}
              onPointerDown={(e) => e.stopPropagation()}
              onPointerEnter={() => setTip(c.id)}
              onPointerLeave={() => setTip((x) => (x === c.id ? null : x))}
              onFocus={() => setTip(c.id)}
              onBlur={() => setTip((x) => (x === c.id ? null : x))}
              onClick={() => onMark(c)}
            >
              <Avatar name={shortName(c.author)} size={20} title="" />
              {agentInThread(c) && <span className="rv-mark-bot" aria-hidden="true"><Icon name="bot" size={9} /></span>}
            </button>
          );
        })}
        {draft && <span className="rv-mark-draft" style={{ left: `${pct(draft.t)}%` }} aria-hidden="true">+</span>}
      </div>
      <div className="rv-tl-line">
        <span className="rv-tl-fill" style={{ width: `${pct(now)}%` }} />
        {sorted.map((c) => c.anchor.t_end !== undefined && (
          <span
            key={`span-${c.id}`}
            className={`rv-tl-span ${c.status === 'resolved' ? 'resolved' : ''} ${focus === c.id || current === c.id ? 'on' : ''}`}
            style={{ left: `${pct(c.anchor.t)}%`, width: `${Math.max(0.6, pct(c.anchor.t_end) - pct(c.anchor.t))}%` }}
          />
        ))}
        {draft?.t_end !== undefined && (
          <span className="rv-tl-span draft" style={{ left: `${pct(draft.t)}%`, width: `${Math.max(0.6, pct(draft.t_end) - pct(draft.t))}%` }} />
        )}
        <span className="rv-tl-knob" style={{ left: `${pct(now)}%` }} />
      </div>
      {hover !== null && !tipped && width > 0 && (
        <span className={`rv-tl-hover ${edge(pct(hover))}`} style={{ left: `${pct(hover)}%` }} aria-hidden="true">{timecode(hover)}</span>
      )}
      {tipped && (
        <span className={`rv-tip ${edge(pct(tipped.anchor.t))}`} style={{ left: `${pct(tipped.anchor.t)}%` }} role="tooltip">
          <span className="rv-tip-h">
            <Avatar name={shortName(tipped.author)} size={18} title="" />
            <b>{shortName(tipped.author)}</b>
            <span className="tc">{tipped.anchor.t_end !== undefined ? `${shortTimecode(tipped.anchor.t)}–${shortTimecode(tipped.anchor.t_end)}` : shortTimecode(tipped.anchor.t)}</span>
            {numbers.get(tipped.id) !== undefined && <span className="rv-tip-n">#{numbers.get(tipped.id)}</span>}
          </span>
          <span className="rv-tip-b">{firstLine(tipped.body)}</span>
        </span>
      )}
    </div>
  );
}

// ───────────────────────────── video player ─────────────────────────────

const SPEEDS = [1, 1.5, 2, 0.5];

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
  draw?: DrawProps;
  onShape: (s: Shape) => void;
}

/**
 * The video with its own controls. Clicking the picture plays or pauses it; the timeline carries every comment as its author's
 * mark; the comment box follows the playhead, so writing is commenting on the moment on screen. With a drawing tool chosen the
 * video stops and the pointer draws on the frame. The keyboard works from anywhere on the page: Space, the arrows (a frame; a
 * second with Shift), C, D, F and Esc.
 */
function VideoPlayer({ asset, poster, threads, numbers, firstVideoPosition, draft, onDraft, canAnnotate, focus, onFocus, jump, safeZone, tools, draw, onShape }: VideoProps) {
  const ref = useRef<HTMLVideoElement>(null);
  const player = useRef<HTMLDivElement>(null);
  const [now, setNow] = useState(0);
  const [dur, setDur] = useState(asset.duration_ms ? Number(asset.duration_ms) / 1000 : 0);
  const [playing, setPlaying] = useState(false);
  const [muted, setMuted] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [help, setHelp] = useState(false);
  // Full screen takes the player with its controls and timeline, so reviewing goes on there.
  const fs = useFullscreen(player);
  const fps = asset.fps || 30;
  const tool = draw?.tool ?? null;

  useEffect(() => {
    liveVideo.position = asset.position;
  }, [asset.position]);

  useEffect(() => {
    const v = ref.current;
    if (!v) return;
    let raf: number | null = null;
    const rvfc = 'requestVideoFrameCallback' in v;
    const tick = () => {
      setNow(v.currentTime);
      if (rvfc) raf = (v as HTMLVideoElement & { requestVideoFrameCallback: (cb: () => void) => number }).requestVideoFrameCallback(tick);
    };
    const meta = () => v.duration && Number.isFinite(v.duration) && setDur(v.duration);
    const sync = () => setNow(v.currentTime);
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
    setNow(v.currentTime);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jump?.nonce]);

  // Drawing happens on a still frame.
  useEffect(() => { if (tool) ref.current?.pause(); }, [tool]);
  useEffect(() => { if (ref.current) ref.current.playbackRate = speed; }, [speed]);

  const step = useCallback((d: number) => {
    const v = ref.current;
    if (!v) return;
    v.pause();
    const frame = Math.floor(v.currentTime * fps + 1e-3);
    // Land in the middle of the target frame so rounding never shows the neighbour.
    v.currentTime = clamp((frame + d + 0.5) / fps, 0, v.duration || dur);
    setNow(v.currentTime);
  }, [fps, dur]);

  const toggle = () => {
    const v = ref.current;
    if (!v) return;
    if (v.paused) {
      if (tool) draw?.onTool(null);
      void v.play().catch(() => {});
    } else v.pause();
  };
  const seekTo = (s: number) => {
    const v = ref.current;
    if (!v || !dur) return;
    v.currentTime = clamp(s, 0, dur);
    setNow(v.currentTime);
  };
  const dropAt = (s: number) => onDraft({ type: 'time', t: round2(s), position: asset.position });
  const commentNow = () => {
    const v = ref.current;
    if (!v || !canAnnotate) return;
    v.pause();
    dropAt(v.currentTime);
  };

  useStageKeys((e, onControl) => {
    switch (e.key) {
      case ' ':
      case 'k':
        if (onControl) return false;
        toggle();
        return true;
      case 'ArrowLeft':
      case 'ArrowRight': {
        if ((e.target as HTMLElement).closest?.('[role="tab"], [role="menuitem"], [role="menuitemradio"]')) return false;
        const d = e.key === 'ArrowLeft' ? -1 : 1;
        if (e.shiftKey) { ref.current?.pause(); seekTo((ref.current?.currentTime ?? 0) + d); }
        else step(d);
        return true;
      }
      case ',': step(-1); return true;
      case '.': step(1); return true;
      case 'c':
      case 'C':
        if (!canAnnotate) return false;
        commentNow();
        return true;
      case 'f':
      case 'F':
        fs.toggle();
        return true;
      case 'Escape':
        if (help) { setHelp(false); return true; }
        if (tool) return false;
        if (!draft) return false;
        onDraft(null);
        return true;
      case '?':
        setHelp((h) => !h);
        return true;
      default:
        return false;
    }
  });

  // The subtitle list and the comment list follow the video.
  useEffect(() => { playhead.set(now); }, [now]);

  const mine = threads.filter((c): c is TimeThread => c.anchor?.type === 'time' && (c.anchor.position ?? firstVideoPosition) === asset.position);
  const draftHere = draft?.type === 'time' && (draft.position ?? firstVideoPosition) === asset.position ? draft : null;
  const current = threadAt(mine, now);
  // The drawings of the comments on screen: those whose moment holds the playhead (a second and a half, or their span).
  const shown = mine
    .filter((c) => c.anchor.drawing?.length && c.anchor.t - 0.05 <= now && now < (c.anchor.t_end ?? c.anchor.t + 1.5) + (focus === c.id && !playing ? 0.05 : 0))
    .map((c) => ({ id: c.id, shapes: c.anchor.drawing!, label: inkLabel(c), dim: c.status === 'resolved' }));
  const speedLabel = `${speed}×`;

  return (
    <div ref={player} className={`rv-player ${fs.on ? 'is-full' : ''}`}>
      <div className="rv-media">
        <div className="stage-inner">
          <video
            ref={ref}
            src={asset.url}
            poster={poster}
            playsInline
            preload="metadata"
            onClick={toggle}
            title={playing ? t('review.video.pause') : t('review.video.play')}
          />
          <SafeZoneOverlay zone={safeZone} />
          {draw && <DrawLayer tool={tool} colour={draw.colour} sketch={draw.sketch} onShape={onShape} shown={shown} />}
          {!draw && shown.length > 0 && <DrawLayer tool={null} colour="yellow" sketch={[]} onShape={() => {}} shown={shown} />}
        </div>
        {draw && canAnnotate && (
          <DrawTools tool={tool} onTool={draw.onTool} colour={draw.colour} onColour={draw.onColour} count={draw.sketch.length} onUndo={draw.onUndo} onClear={draw.onClear} />
        )}
      </div>

      <div className="rv-bar">
        <Timeline
          now={now}
          dur={dur}
          marks={mine}
          numbers={numbers}
          focus={focus}
          current={current}
          draft={draftHere}
          onSeek={seekTo}
          onScrub={(s) => { if (s) ref.current?.pause(); }}
          onMark={(c) => {
            onFocus(c.id);
            const v = ref.current;
            if (v) { v.pause(); v.currentTime = c.anchor.t; setNow(c.anchor.t); }
          }}
        />
        <div className="rv-ctl">
          <button type="button" className="rv-ic rv-play" onClick={toggle} aria-label={playing ? t('review.video.pause') : t('review.video.play')} title={`${playing ? t('review.video.pause') : t('review.video.play')} (${t('review.keys.space')})`}>
            {playing ? <IconPause /> : <IconPlay />}
          </button>
          <button type="button" className="rv-ic" onClick={() => { const v = ref.current; if (v) v.muted = !v.muted; }} aria-label={muted ? t('review.video.unmute') : t('review.video.mute')} title={muted ? t('review.video.unmute') : t('review.video.mute')}>
            <Icon name={muted ? 'volumeOff' : 'volume'} size={17} />
          </button>
          <span className="rv-tc" aria-live="off" title={t('review.video.frameHint', { fps, n: Math.floor(now * fps + 1e-3) })}>
            <b>{timecode(now)}</b><span className="rv-tc-of"> / {timecode(dur)}</span>
          </span>
          <span className="grow" />
          {canAnnotate && draftHere && (
            <button type="button" className="rv-chipbtn" disabled={now <= draftHere.t} onClick={() => onDraft({ ...draftHere, t_end: round2(now) })} title={t('review.video.setEndHint')}>
              {t('review.video.setEnd')}
            </button>
          )}
          {canAnnotate && (
            <button type="button" className="rv-ic rv-ic-comment" onClick={commentNow} aria-label={t('review.video.commentHere')} title={t('review.video.commentHereHint')}>
              <Icon name="commentAdd" size={17} />
            </button>
          )}
          {draw && canAnnotate && (
            <button type="button" className={`rv-ic rv-ic-draw ${tool ? 'on' : ''}`} aria-pressed={!!tool} onClick={() => draw.onTool(tool ? null : 'pen')} aria-label={t('review.draw.toggle')} title={`${t('review.draw.toggle')} (D)`}>
              <Icon name="pen" size={16} />
            </button>
          )}
          {tools}
          <button type="button" className="rv-chipbtn rv-speed" onClick={() => setSpeed((s) => SPEEDS[(SPEEDS.indexOf(s) + 1) % SPEEDS.length]!)} aria-label={t('review.video.speed', { speed: speedLabel })} title={t('review.video.speedHint')}>
            {speedLabel}
          </button>
          <FullscreenButton fs={fs} />
          <ShortcutHelp open={help} onToggle={() => setHelp((h) => !h)} rows={videoKeys(!!draw && canAnnotate)} />
        </div>
      </div>
    </div>
  );
}

// ───────────────────────────── pages of a carousel or a PDF ─────────────────────────────

function Pager({ unit, page, count, onPage, thumbs, counts, tools, fs, help, draw }: {
  unit: 'page' | 'item';
  page: number;
  count: number;
  onPage: (n: number) => void;
  thumbs: (string | undefined)[];
  counts: number[];
  tools?: ReactNode;
  fs?: ReturnType<typeof useFullscreen>;
  help?: { open: boolean; onToggle: () => void; draw: boolean };
  draw?: { tool: Tool | null; onTool: (t: Tool | null) => void };
}) {
  if (count <= 1 && !tools && !fs?.supported && !draw) return null;
  return (
    <div className="rv-bar rv-pager">
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
      <div className="rv-ctl">
        {count > 1 && (
          <div className="rv-pages" role="group" aria-label={unit === 'page' ? t('review.pager.pdfGroup') : t('review.pager.itemGroup')}>
            <button type="button" className="rv-ic" disabled={page <= 1} onClick={() => onPage(page - 1)} aria-label={t('review.pager.prev')} title={`${t('review.pager.prev')} (←)`}><Icon name="chevronLeft" size={17} /></button>
            <span className="rv-tc" aria-live="polite">{unit === 'page' ? t('review.pager.page', { n: page, count }) : t('review.pager.item', { n: page, count })}</span>
            <button type="button" className="rv-ic" disabled={page >= count} onClick={() => onPage(page + 1)} aria-label={t('review.pager.next')} title={`${t('review.pager.next')} (→)`}><Icon name="chevronRight" size={17} /></button>
          </div>
        )}
        <span className="grow" />
        {draw && (
          <button type="button" className={`rv-ic rv-ic-draw ${draw.tool ? 'on' : ''}`} aria-pressed={!!draw.tool} onClick={() => draw.onTool(draw.tool ? null : 'pen')} aria-label={t('review.draw.toggle')} title={`${t('review.draw.toggle')} (D)`}>
            <Icon name="pen" size={16} />
          </button>
        )}
        {tools}
        {fs && <FullscreenButton fs={fs} />}
        {help && <ShortcutHelp open={help.open} onToggle={help.onToggle} rows={pageKeys(help.draw)} />}
      </div>
    </div>
  );
}

// ───────────────────────────── the stage ─────────────────────────────

export interface StageProps {
  assets: Asset[];
  threads: CommentThread[];
  /** The number each thread carries in the list, shown on its mark. */
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
  /** Drawing on the frame or the page, when one can comment. */
  draw?: DrawProps;
}

/** Shows a version's pages one at a time: a video, an image, a carousel item or a PDF page, with its comments on top. */
export function Stage(p: StageProps) {
  const primaries = useMemo(() => primariesOf(p.assets), [p.assets]);
  const pdf = p.assets.find((a) => a.kind === 'pdf');
  const cover = p.assets.find((a) => a.kind === 'cover');
  const firstVideoPosition = primaries.find((a) => a.kind === 'video')?.position ?? 0;
  const [page, setPage] = useState(1);
  const [pdfPages, setPdfPages] = useState(0);
  const [help, setHelp] = useState(false);
  const stage = useRef<HTMLDivElement>(null);
  const fs = useFullscreen(stage);
  const count = pdf ? pdfPages : primaries.length;
  const draw = p.canAnnotate ? p.draw : undefined;

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
  const isVideo = !pdf && current?.kind === 'video';
  const go = (n: number) => setPage(clamp(n, 1, Math.max(count, 1)));

  // A new shape goes with the moment on screen (a video) or with the page and the box the whole drawing covers.
  const onShape = (s: Shape) => {
    if (!draw) return;
    const shapes = [...draw.sketch, s];
    const base: Anchor = isVideo
      ? { type: 'time', t: round2(playhead.t), position: current!.position }
      : { type: 'region', page, ...bboxOf(shapes) };
    draw.onSketch(shapes, base);
  };

  // Pages: the arrows turn them (a video page keeps the arrows for its frames). D draws, Esc puts the pen down, then drops the
  // mark being made.
  useStageKeys((e) => {
    if ((e.key === 'd' || e.key === 'D') && draw) { draw.onTool(draw.tool ? null : 'pen'); return true; }
    if (e.key === 'Escape' && draw?.tool) { draw.onTool(null); return true; }
    if (isVideo) return false;
    if ((e.target as HTMLElement).closest?.('[role="tab"], [role="menuitem"], [role="menuitemradio"]')) return false;
    if (e.key === 'ArrowLeft' && count > 1) { go(page - 1); return true; }
    if (e.key === 'ArrowRight' && count > 1) { go(page + 1); return true; }
    if (e.key === 'f' || e.key === 'F') { fs.toggle(); return true; }
    if (e.key === 'Escape') {
      if (help) { setHelp(false); return true; }
      if (p.draft) { p.onDraft(null); return true; }
    }
    if (e.key === '?') { setHelp((h) => !h); return true; }
    return false;
  });

  // Undo the last stroke: Ctrl/⌘ + Z, when the keys are not typing somewhere.
  useEffect(() => {
    if (!draw?.sketch.length) return;
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== 'z' || e.shiftKey) return;
      if ((e.target as HTMLElement | null)?.closest?.('input, textarea, select, [contenteditable="true"]')) return;
      e.preventDefault();
      draw.onUndo();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [draw]);

  // Open comments per page, for the badges on the strip.
  const counts = Array.from({ length: count }, (_, i) => p.threads.filter((c) => {
    if (c.status !== 'open' || !c.anchor) return false;
    if (c.anchor.type === 'region') return c.anchor.page === i + 1;
    const item = primaries[i];
    return !pdf && item?.kind === 'video' && (c.anchor.position ?? firstVideoPosition) === item.position;
  }).length);
  const thumbs = pdf ? [] : primaries.map((a) => (a.kind === 'image' ? a.url : cover?.url));
  const unit = pdf ? 'page' : 'item';
  const helpProps = { open: help, onToggle: () => setHelp((h) => !h), draw: !!draw };

  // On a page, the drawing of the comment in focus is shown over it.
  const focused = p.threads.find((c) => c.id === p.focus);
  const shownOnPage = focused?.anchor?.type === 'region' && focused.anchor.page === page && focused.anchor.drawing?.length
    ? [{ id: focused.id, shapes: focused.anchor.drawing, label: '', dim: focused.status === 'resolved' }]
    : [];
  const pageLayers = (
    <>
      <RegionLayer page={page} threads={p.threads} numbers={p.numbers} draft={p.draft} onDraft={p.onDraft} canAnnotate={p.canAnnotate && !draw?.tool} focus={p.focus} onFocus={p.onFocus} hideDraft={!!draw?.sketch.length} />
      {(draw || shownOnPage.length > 0) && (
        <DrawLayer tool={draw?.tool ?? null} colour={draw?.colour ?? 'yellow'} sketch={draw?.sketch ?? []} onShape={onShape} shown={shownOnPage} />
      )}
    </>
  );
  const drawTools = draw && (
    <DrawTools tool={draw.tool} onTool={draw.onTool} colour={draw.colour} onColour={draw.onColour} count={draw.sketch.length} onUndo={draw.onUndo} onClear={draw.onClear} />
  );

  return (
    <div ref={stage} className={`rv-stage ${fs.on ? 'is-full' : ''}`}>
      {pdf ? (
        <>
          <div className="rv-media rv-paper">
            <div className="stage-inner">
              <PdfCanvas url={pdf.url} page={page} onPages={setPdfPages} />
              {pageLayers}
            </div>
            {drawTools}
          </div>
          <Pager unit="page" page={page} count={count} onPage={go} thumbs={[]} counts={counts} fs={fs} help={helpProps} draw={draw} />
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
            draw={draw}
            onShape={onShape}
          />
          {count > 1 && <Pager unit={unit} page={page} count={count} onPage={go} thumbs={thumbs} counts={counts} />}
        </>
      ) : current ? (
        <>
          <div className="rv-media">
            <div className="stage-inner">
              <img src={current.url} alt={current.name} draggable={false} />
              <SafeZoneOverlay zone={p.safeZone} />
              {pageLayers}
            </div>
            {drawTools}
          </div>
          <Pager unit={unit} page={page} count={count} onPage={go} thumbs={thumbs} counts={counts} tools={p.tools} fs={fs} help={helpProps} draw={draw} />
        </>
      ) : (
        <div className="rv-media rv-nothing">{t('review.stage.empty')}</div>
      )}
    </div>
  );
}

// ───────────────────────────── compare two versions ─────────────────────────────

export type CompareMode = 'side' | 'wipe' | 'flip';

/**
 * Two versions, side by side or one over the other with a curtain (a divider to drag across the picture). Videos play in sync
 * from one control bar, with the sound of the version under review; images can also be flipped; PDFs share the page number.
 */
export function CompareStage({ left, right, leftLabel, rightLabel }: { left: Asset[]; right: Asset[]; leftLabel: string; rightLabel: string }) {
  const lp = primariesOf(left), rp = primariesOf(right);
  const lpdf = left.find((a) => a.kind === 'pdf'), rpdf = right.find((a) => a.kind === 'pdf');
  const [page, setPage] = useState(1);
  const [pages, setPages] = useState(0);
  const [mode, setMode] = useState<CompareMode>(() => {
    try { return (localStorage.getItem('studio.review.compare') as CompareMode) || 'side'; } catch { return 'side'; }
  });
  const [showRight, setShowRight] = useState(true);
  const [cut, setCut] = useState(50);
  // The version under review leads (and is heard); the other follows it, muted.
  const lead = useRef<HTMLVideoElement>(null), follow = useRef<HTMLVideoElement>(null);
  const [now, setNow] = useState(0);
  const [playing, setPlaying] = useState(false);
  const frame = useRef<HTMLDivElement>(null);
  const cutDrag = useRef<number | null>(null);

  const la = lpdf ? undefined : lp[page - 1], ra = rpdf ? undefined : rp[page - 1];
  const count = lpdf || rpdf ? pages : Math.max(lp.length, rp.length);
  const bothVideo = la?.kind === 'video' && ra?.kind === 'video';
  const fps = ra?.fps || 30;
  const [dur, setDur] = useState(0);
  const shownMode: CompareMode = mode === 'flip' && bothVideo ? 'side' : mode;
  const pick = (m: CompareMode) => { setMode(m); try { localStorage.setItem('studio.review.compare', m); } catch { /* not kept */ } };

  useEffect(() => {
    const va = lead.current, vb = follow.current;
    if (!bothVideo || !va || !vb) return;
    vb.muted = true;
    const meta = () => setDur(Math.max(va.duration || 0, ra?.duration_ms ? Number(ra.duration_ms) / 1000 : 0));
    const onTime = () => {
      setNow(va.currentTime);
      if (!va.paused && Math.abs(vb.currentTime - va.currentTime) > 0.12) vb.currentTime = va.currentTime;
    };
    const onPlay = () => { setPlaying(true); vb.currentTime = va.currentTime; void vb.play().catch(() => {}); };
    const onPause = () => { setPlaying(false); vb.pause(); vb.currentTime = va.currentTime; };
    meta();
    va.addEventListener('loadedmetadata', meta);
    va.addEventListener('timeupdate', onTime);
    va.addEventListener('seeked', onTime);
    va.addEventListener('play', onPlay);
    va.addEventListener('pause', onPause);
    return () => {
      va.removeEventListener('loadedmetadata', meta);
      va.removeEventListener('timeupdate', onTime);
      va.removeEventListener('seeked', onTime);
      va.removeEventListener('play', onPlay);
      va.removeEventListener('pause', onPause);
    };
  }, [bothVideo, la?.id, ra?.id, ra?.duration_ms, shownMode]);

  const toggle = () => {
    const va = lead.current;
    if (!va) return;
    if (va.paused) void va.play().catch(() => {});
    else va.pause();
  };
  const seek = (s: number) => {
    const va = lead.current, vb = follow.current;
    if (!va) return;
    va.currentTime = s;
    if (vb) vb.currentTime = s;
    setNow(s);
  };
  const stepFrame = (d: number) => {
    const va = lead.current;
    if (!va) return;
    va.pause();
    seek(clamp((Math.floor(va.currentTime * fps + 1e-3) + d + 0.5) / fps, 0, va.duration || dur));
  };

  useStageKeys((e, onControl) => {
    if (shownMode === 'wipe' && (e.key === '[' || e.key === ']')) { setCut((c) => clamp(c + (e.key === '[' ? -5 : 5), 0, 100)); return true; }
    if (bothVideo) {
      if ((e.key === ' ' || e.key === 'k') && !onControl) { toggle(); return true; }
      if (e.key === 'ArrowLeft' || e.key === ',') { stepFrame(-1); return true; }
      if (e.key === 'ArrowRight' || e.key === '.') { stepFrame(1); return true; }
      return false;
    }
    if (e.key === 'ArrowLeft' && page > 1) { setPage(page - 1); return true; }
    if (e.key === 'ArrowRight' && page < count) { setPage(page + 1); return true; }
    return false;
  });

  const media = (asset: Asset | undefined, pdf: Asset | undefined, ref: RefObject<HTMLVideoElement | null> | null, label: string) =>
    pdf ? <PdfCanvas url={pdf.url} page={page} onPages={(n) => setPages((p) => Math.max(p, n))} />
      : asset?.kind === 'video' ? <video ref={ref} src={asset.url} playsInline preload="auto" muted={ref === follow} onClick={toggle} />
      : asset ? <img src={asset.url} alt={t('review.compare.imageAlt', { label, name: asset.name })} draggable={false} />
      : <div className="rv-nothing">{t('review.compare.nothing')}</div>;

  const pane = (asset: Asset | undefined, pdf: Asset | undefined, ref: RefObject<HTMLVideoElement | null> | null, label: string, side: 'left' | 'right') => (
    <figure className={`rv-cmp-pane ${side}`}>
      <div className={`rv-media ${pdf ? 'rv-paper' : ''}`}>
        <div className="stage-inner">{media(asset, pdf, ref, label)}</div>
        <span className={`rv-cmp-tag ${side === 'right' ? 'now' : ''}`}>{label}</span>
      </div>
    </figure>
  );

  // The curtain: the earlier version on the left of the divider, the one under review on the right.
  const cutTo = (clientX: number) => {
    const r = frame.current?.getBoundingClientRect();
    if (r && r.width) setCut(clamp(((clientX - r.left) / r.width) * 100, 0, 100));
  };
  const wipe = (
    <div className="rv-media rv-wipe-box">
      <div
        ref={frame}
        className="rv-wipe"
        style={{ '--cut': `${cut}%` } as CSSProperties}
        onPointerDown={(e) => {
          if (e.button !== 0) return;
          e.currentTarget.setPointerCapture(e.pointerId);
          cutDrag.current = e.pointerId;
          cutTo(e.clientX);
        }}
        onPointerMove={(e) => { if (cutDrag.current === e.pointerId) cutTo(e.clientX); }}
        onPointerUp={(e) => {
          cutDrag.current = null;
          if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
        }}
        onPointerCancel={() => { cutDrag.current = null; }}
      >
        <div className="rv-wipe-layer base">{media(ra, rpdf, lead, rightLabel)}</div>
        <div className="rv-wipe-layer over">{media(la, lpdf, follow, leftLabel)}</div>
        <div
          className="rv-wipe-bar"
          role="slider"
          tabIndex={0}
          aria-label={t('review.compare.curtain')}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(cut)}
          onKeyDown={(e) => {
            if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
              e.preventDefault();
              e.stopPropagation();
              setCut((c) => clamp(c + (e.key === 'ArrowLeft' ? -2 : 2) * (e.shiftKey ? 5 : 1), 0, 100));
            }
          }}
        >
          <span className="rv-wipe-grip" aria-hidden="true"><Icon name="wipe" size={14} /></span>
        </div>
        <span className="rv-cmp-tag left">{leftLabel}</span>
        <span className="rv-cmp-tag now right">{rightLabel}</span>
      </div>
    </div>
  );

  const modes: [CompareMode, string][] = [['side', t('review.compare.side')], ['wipe', t('review.compare.wipe')], ...(!bothVideo ? [['flip', t('review.compare.flip')] as [CompareMode, string]] : [])];
  const pct = (s: number) => (dur ? clamp((s / dur) * 100, 0, 100) : 0);

  return (
    <div className={`rv-stage rv-compare mode-${shownMode}`}>
      {shownMode === 'wipe' ? (
        <div className="compare wipe">{wipe}</div>
      ) : shownMode === 'flip' ? (
        <div className="compare flip">{showRight ? pane(ra, rpdf, lead, rightLabel, 'right') : pane(la, lpdf, follow, leftLabel, 'left')}</div>
      ) : (
        <div className="compare">
          {pane(la, lpdf, follow, leftLabel, 'left')}
          {pane(ra, rpdf, lead, rightLabel, 'right')}
        </div>
      )}
      <div className="rv-bar">
        {bothVideo && (
          <div
            className="rv-tl rv-tl-plain"
            role="slider"
            tabIndex={0}
            aria-label={t('review.compare.position')}
            aria-valuemin={0}
            aria-valuemax={Math.round(dur)}
            aria-valuenow={Math.round(now)}
            aria-valuetext={timecode(now)}
            onPointerDown={(e) => {
              if (e.button !== 0 || !dur) return;
              e.currentTarget.setPointerCapture(e.pointerId);
              const r = e.currentTarget.getBoundingClientRect();
              lead.current?.pause();
              seek(clamp((e.clientX - r.left) / r.width, 0, 1) * dur);
            }}
            onPointerMove={(e) => {
              if (!e.currentTarget.hasPointerCapture(e.pointerId) || !dur) return;
              const r = e.currentTarget.getBoundingClientRect();
              seek(clamp((e.clientX - r.left) / r.width, 0, 1) * dur);
            }}
          >
            <div className="rv-tl-line">
              <span className="rv-tl-fill" style={{ width: `${pct(now)}%` }} />
              <span className="rv-tl-knob" style={{ left: `${pct(now)}%` }} />
            </div>
          </div>
        )}
        <div className="rv-ctl">
          {count > 1 && (
            <div className="rv-pages" role="group" aria-label={lpdf || rpdf ? t('review.pager.pdfGroup') : t('review.pager.itemGroup')}>
              <button type="button" className="rv-ic" disabled={page <= 1} onClick={() => setPage(page - 1)} aria-label={t('review.pager.prev')}><Icon name="chevronLeft" size={17} /></button>
              <span className="rv-tc">{lpdf || rpdf ? t('review.pager.page', { n: page, count }) : t('review.pager.item', { n: page, count })}</span>
              <button type="button" className="rv-ic" disabled={page >= count} onClick={() => setPage(page + 1)} aria-label={t('review.pager.next')}><Icon name="chevronRight" size={17} /></button>
            </div>
          )}
          {bothVideo && (
            <>
              <button type="button" className="rv-ic rv-play" onClick={toggle} aria-label={playing ? t('review.compare.pauseBoth') : t('review.compare.playBoth')} title={playing ? t('review.compare.pauseBoth') : t('review.compare.playBoth')}>
                {playing ? <IconPause /> : <IconPlay />}
              </button>
              <button type="button" className="rv-ic" onClick={() => stepFrame(-1)} aria-label={t('review.video.prevFrame')} title={t('review.video.prevFrameHint')}><Icon name="chevronLeft" size={17} /></button>
              <button type="button" className="rv-ic" onClick={() => stepFrame(1)} aria-label={t('review.video.nextFrame')} title={t('review.video.nextFrameHint')}><Icon name="chevronRight" size={17} /></button>
              <span className="rv-tc"><b>{timecode(now)}</b><span className="rv-tc-of"> / {timecode(dur)}</span></span>
            </>
          )}
          <span className="grow" />
          {shownMode === 'flip' && (
            <button type="button" className="rv-chipbtn" onClick={() => setShowRight((s) => !s)}>{t('review.compare.showing', { label: showRight ? rightLabel : leftLabel })}</button>
          )}
          <Segmented label={t('review.compare.modeGroup')} value={shownMode} options={modes.map(([m, label]) => ({ value: m, label }))} onChange={pick} />
        </div>
      </div>
    </div>
  );
}
