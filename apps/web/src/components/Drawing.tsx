import { useEffect, useRef, useState, type PointerEvent as RPointerEvent, type RefObject } from 'react';
import type { DrawColour, Shape } from '../api';
import { t } from '../i18n';
import { Icon } from './icons';
import { Popover, Tip } from './ui';

/** What the pointer draws with, while drawing on the frame or the page. */
export type Tool = 'pen' | 'rect' | 'arrow';

/** The colours a reviewer draws with: yellow (review marks) first, then a few that stand out on any picture. */
export const DRAW_COLOURS: { id: DrawColour; hex: string }[] = [
  { id: 'yellow', hex: '#f2c94c' },
  { id: 'red', hex: '#ff5a5f' },
  { id: 'green', hex: '#3ecf8e' },
  { id: 'blue', hex: '#5b9dff' },
  { id: 'white', hex: '#ffffff' },
];
export const colourHex = (c: DrawColour | undefined) => DRAW_COLOURS.find((x) => x.id === c)?.hex ?? DRAW_COLOURS[0]!.hex;
/** Whether text on this colour reads better dark (yellow, green, white) than white (red, blue). */
const darkInk = (c: DrawColour | undefined) => c !== 'red' && c !== 'blue';

const clamp01 = (n: number) => Math.min(1, Math.max(0, n));
const r3 = (n: number) => Math.round(n * 1000) / 1000;

/** The smallest box that holds every shape, in fractions of the frame. */
export function bboxOf(shapes: Shape[]): { x: number; y: number; w: number; h: number } {
  let x0 = 1, y0 = 1, x1 = 0, y1 = 0;
  const take = (x: number, y: number) => { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); };
  for (const s of shapes) {
    if (s.type === 'path') for (const [x, y] of s.points) take(x, y);
    else if (s.type === 'rect') { take(s.x, s.y); take(s.x + s.w, s.y + s.h); }
    else { take(s.x1, s.y1); take(s.x2, s.y2); }
  }
  if (x1 < x0) return { x: 0, y: 0, w: 0, h: 0 };
  const x = Math.round(x0 * 100) / 100, y = Math.round(y0 * 100) / 100;
  return { x, y, w: Math.min(1 - x, Math.round((x1 - x) * 100) / 100), h: Math.min(1 - y, Math.round((y1 - y) * 100) / 100) };
}

/** Thins a freehand stroke: drops points closer than ~3 px to the last kept one, and keeps at most 400. */
function thin(points: [number, number][], w: number, h: number): [number, number][] {
  const out: [number, number][] = [];
  for (const p of points) {
    const last = out[out.length - 1];
    if (!last || Math.hypot((p[0] - last[0]) * w, (p[1] - last[1]) * h) >= 3) out.push([r3(p[0]), r3(p[1])]);
  }
  const end = points[points.length - 1];
  if (end && out.length > 1) out[out.length - 1] = [r3(end[0]), r3(end[1])];
  if (out.length <= 400) return out;
  const step = out.length / 400;
  return Array.from({ length: 400 }, (_, i) => out[Math.min(out.length - 1, Math.round(i * step))]!);
}

export function useSize(ref: RefObject<HTMLElement | null>) {
  const [size, setSize] = useState({ w: 0, h: 0 });
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return size;
}

/** One shape, drawn in pixels over a box of w × h: a dark halo under a bright stroke, so it reads on any picture. */
function ShapeMark({ s, w, h }: { s: Shape; w: number; h: number }) {
  const stroke = colourHex(s.color);
  const both = (d: string) => (
    <>
      <path d={d} className="rv-ink-halo" />
      <path d={d} className="rv-ink" style={{ stroke }} />
    </>
  );
  if (s.type === 'path') return both(s.points.map(([x, y], i) => `${i ? 'L' : 'M'}${(x * w).toFixed(1)} ${(y * h).toFixed(1)}`).join(''));
  if (s.type === 'rect') {
    const x = s.x * w, y = s.y * h, rw = s.w * w, rh = s.h * h;
    return both(`M${x} ${y}h${rw}v${rh}h${-rw}z`);
  }
  const x1 = s.x1 * w, y1 = s.y1 * h, x2 = s.x2 * w, y2 = s.y2 * h;
  const a = Math.atan2(y2 - y1, x2 - x1), len = Math.min(16, Math.hypot(x2 - x1, y2 - y1) * 0.6), wing = 0.5;
  const head = (d: number) => `${(x2 - len * Math.cos(a + d)).toFixed(1)} ${(y2 - len * Math.sin(a + d)).toFixed(1)}`;
  return both(`M${x1} ${y1}L${x2} ${y2}M${head(wing)}L${x2} ${y2}L${head(-wing)}`);
}

/** A drawing over the frame, and the label of who made it (and when), above its top-left corner. */
export function Drawing({ shapes, w, h, label, dim }: { shapes: Shape[]; w: number; h: number; label?: string; dim?: boolean }) {
  if (!w || !h || !shapes.length) return null;
  const box = bboxOf(shapes);
  const colour = colourHex(shapes[0]!.color);
  return (
    <>
      <svg className={`rv-ink-svg ${dim ? 'dim' : ''}`} width={w} height={h} viewBox={`0 0 ${w} ${h}`} aria-hidden="true">
        {shapes.map((s, i) => <ShapeMark key={i} s={s} w={w} h={h} />)}
      </svg>
      {label && (
        <span
          className={`rv-ink-label ${box.y < 0.06 ? 'below' : ''}`}
          style={{ left: Math.min(box.x * w, w - 8), top: box.y < 0.06 ? (box.y + box.h) * h + 6 : box.y * h - 6, background: colour, color: darkInk(shapes[0]!.color) ? '#15161f' : '#fff' }}
        >
          {label}
        </span>
      )}
    </>
  );
}

/**
 * The layer that holds drawings over the frame or the page. It shows the drawings of the comments in view and the one being
 * made; with a tool chosen, it takes the pointer and draws: a freehand stroke, a rectangle or an arrow.
 */
export function DrawLayer({ tool, colour, sketch, onShape, shown }: {
  tool: Tool | null;
  colour: DrawColour;
  /** The drawing of the comment being written. */
  sketch: Shape[];
  onShape: (s: Shape) => void;
  /** Saved drawings to show: those of the comment in focus, or at the playhead. */
  shown: { id: string; shapes: Shape[]; label?: string; dim?: boolean }[];
}) {
  const ref = useRef<HTMLDivElement>(null);
  const { w, h } = useSize(ref);
  const gesture = useRef<{ id: number; x: number; y: number; points: [number, number][]; rect: DOMRect } | null>(null);
  const [live, setLive] = useState<Shape | null>(null);

  const at = (e: RPointerEvent, r: DOMRect): [number, number] => [clamp01((e.clientX - r.left) / r.width), clamp01((e.clientY - r.top) / r.height)];
  const shapeFor = (g: NonNullable<typeof gesture.current>, p: [number, number]): Shape => {
    if (tool === 'rect') return { type: 'rect', x: Math.min(g.x, p[0]), y: Math.min(g.y, p[1]), w: Math.abs(p[0] - g.x), h: Math.abs(p[1] - g.y), color: colour };
    if (tool === 'arrow') return { type: 'arrow', x1: g.x, y1: g.y, x2: p[0], y2: p[1], color: colour };
    return { type: 'path', points: g.points, color: colour };
  };

  const down = (e: RPointerEvent<HTMLDivElement>) => {
    if (!tool || e.button !== 0 || !e.isPrimary) return;
    e.preventDefault();
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    const rect = e.currentTarget.getBoundingClientRect();
    const p = at(e, rect);
    gesture.current = { id: e.pointerId, x: p[0], y: p[1], points: [p], rect };
    setLive(null);
  };
  const move = (e: RPointerEvent<HTMLDivElement>) => {
    const g = gesture.current;
    if (!g || g.id !== e.pointerId) return;
    const p = at(e, g.rect);
    if (tool === 'pen') g.points = [...g.points, p];
    setLive(shapeFor(g, p));
  };
  const end = (e: RPointerEvent<HTMLDivElement>, keep: boolean) => {
    const g = gesture.current;
    if (!g || g.id !== e.pointerId) return;
    gesture.current = null;
    setLive(null);
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
    if (!keep) return;
    const p = at(e, g.rect);
    const pw = g.rect.width, ph = g.rect.height;
    if (tool === 'pen') {
      const points = thin([...g.points, p], pw, ph);
      // A tap leaves a dot: a stroke of two points a pixel apart.
      if (points.length < 2) points.push([r3(clamp01(p[0] + 2 / pw)), r3(p[1])]);
      onShape({ type: 'path', points, color: colour });
      return;
    }
    const s = shapeFor(g, p);
    if (s.type === 'rect' && s.w * pw >= 6 && s.h * ph >= 6) onShape({ ...s, x: r3(s.x), y: r3(s.y), w: r3(s.w), h: r3(s.h) });
    if (s.type === 'arrow' && Math.hypot((s.x2 - s.x1) * pw, (s.y2 - s.y1) * ph) >= 10) onShape({ ...s, x1: r3(s.x1), y1: r3(s.y1), x2: r3(s.x2), y2: r3(s.y2) });
  };

  return (
    <div
      ref={ref}
      className={`rv-ink-layer ${tool ? `drawing tool-${tool}` : ''}`}
      onPointerDown={down}
      onPointerMove={move}
      onPointerUp={(e) => end(e, true)}
      onPointerCancel={(e) => end(e, false)}
      onLostPointerCapture={() => { gesture.current = null; setLive(null); }}
    >
      {shown.map((d) => <Drawing key={d.id} shapes={d.shapes} w={w} h={h} label={d.label || undefined} dim={d.dim} />)}
      <Drawing shapes={live ? [...sketch, live] : sketch} w={w} h={h} />
    </div>
  );
}

/** The drawing tools, floating beside the picture: pen, rectangle, arrow and the colour; undo and clear once something is drawn. */
export function DrawTools({ tool, onTool, colour, onColour, count, onUndo, onClear }: {
  tool: Tool | null;
  onTool: (t: Tool | null) => void;
  colour: DrawColour;
  onColour: (c: DrawColour) => void;
  count: number;
  onUndo: () => void;
  onClear: () => void;
}) {
  const [colours, setColours] = useState(false);
  const tools: [Tool, 'pen' | 'square' | 'arrow', string, string][] = [
    ['pen', 'pen', t('review.draw.pen'), 'D'],
    ['rect', 'square', t('review.draw.rect'), ''],
    ['arrow', 'arrow', t('review.draw.arrow'), ''],
  ];
  return (
    <div className={`rv-tools ${tool ? 'on' : ''}`} role="toolbar" aria-label={t('review.draw.label')} aria-orientation="vertical">
      {tools.map(([id, icon, label, key]) => (
        <Tip key={id} label={label} shortcut={key || undefined} side="right">
          <button type="button" className="rv-tool" aria-pressed={tool === id} aria-label={label} onClick={() => onTool(tool === id ? null : id)}>
            <Icon name={icon} size={16} />
          </button>
        </Tip>
      ))}
      <Popover
        open={colours}
        onOpenChange={setColours}
        side="right"
        align="center"
        width="auto"
        label={t('review.draw.colour')}
        className="rv-swatches"
        trigger={
          <button type="button" className="rv-tool" aria-label={t('review.draw.colour')}>
            <span className="rv-swatch" style={{ background: colourHex(colour) }} />
          </button>
        }
      >
        <div role="radiogroup" aria-label={t('review.draw.colour')} className="rv-swatch-row">
          {DRAW_COLOURS.map((c) => (
            <button
              key={c.id}
              type="button"
              role="radio"
              aria-checked={c.id === colour}
              aria-label={t(`review.draw.colour.${c.id}`)}
              className="rv-swatch-btn"
              onClick={() => { onColour(c.id); setColours(false); if (!tool) onTool('pen'); }}
            >
              <span className="rv-swatch" style={{ background: c.hex }} />
            </button>
          ))}
        </div>
      </Popover>
      {count > 0 && (
        <>
          <span className="rv-tools-sep" aria-hidden="true" />
          <Tip label={t('review.draw.undo')} shortcut="⌘Z" side="right">
            <button type="button" className="rv-tool" aria-label={t('review.draw.undo')} onClick={onUndo}>
              <Icon name="undo" size={16} />
            </button>
          </Tip>
          <Tip label={t('review.draw.clear')} side="right">
            <button type="button" className="rv-tool" aria-label={t('review.draw.clear')} onClick={onClear}>
              <Icon name="trash" size={16} />
            </button>
          </Tip>
        </>
      )}
    </div>
  );
}
