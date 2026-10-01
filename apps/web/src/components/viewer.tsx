// The legacy build carries the polyfills that older browsers need (Map.getOrInsertComputed, for one).
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import workerUrl from 'pdfjs-dist/legacy/build/pdf.worker.min.mjs?url';
import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as RPointerEvent } from 'react';
import type { Anchor, Asset, CommentThread } from '../api';
import { fmtTime } from '../lib/format';

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));
const round2 = (n: number) => Math.round(n * 100) / 100;

/** A request from outside the stage to show a place: a page and/or a moment of a video. The nonce makes repeats count. */
export interface Jump {
  nonce: number;
  page?: number;
  t?: number;
  position?: number;
}

const primariesOf = (assets: Asset[]) =>
  assets.filter((a) => a.kind === 'video' || a.kind === 'image').sort((a, b) => a.position - b.position);

// ───────────────────────────── region layer (images and PDF pages) ─────────────────────────────

interface RegionProps {
  page: number;
  threads: CommentThread[];
  draft: Anchor | null;
  onDraft: (a: Anchor | null) => void;
  canAnnotate: boolean;
  focus: string | null;
  onFocus: (id: string) => void;
}

/**
 * Transparent layer over a page: drag to mark a rectangle, click to drop a point, click an existing mark to open its thread.
 * Everything is stored as fractions of the page, so it survives any screen size.
 */
function RegionLayer({ page, threads, draft, onDraft, canAnnotate, focus, onFocus }: RegionProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null);
  const marks = threads.filter((t): t is CommentThread & { anchor: Extract<Anchor, { type: 'region' }> } => t.anchor?.type === 'region' && t.anchor.page === page);

  const rel = (e: RPointerEvent) => {
    const r = ref.current!.getBoundingClientRect();
    return { x: clamp((e.clientX - r.left) / r.width, 0, 1), y: clamp((e.clientY - r.top) / r.height, 0, 1) };
  };

  const down = (e: RPointerEvent) => {
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
      // A click: open the mark under it, or drop a point.
      const hit = marks.find((m) => {
        const a = m.anchor;
        return a.w === 0 && a.h === 0 ? Math.hypot(a.x - p.x, a.y - p.y) < 0.03 : p.x >= a.x && p.x <= a.x + a.w && p.y >= a.y && p.y <= a.y + a.h;
      });
      if (hit) onFocus(hit.id);
      else if (canAnnotate) onDraft({ type: 'region', page, x: round2(p.x), y: round2(p.y), w: 0, h: 0 });
      return;
    }
    if (canAnnotate) onDraft({ type: 'region', page, x: round2(x), y: round2(y), w: round2(w), h: round2(h) });
  };

  const box = (a: { x: number; y: number; w: number; h: number }, cls: string, key: string, label?: string) => {
    const point = a.w === 0 && a.h === 0;
    return (
      <div
        key={key}
        className={`region-box ${cls}`}
        style={point
          ? { left: `${a.x * 100}%`, top: `${a.y * 100}%`, width: 16, height: 16, marginLeft: -8, marginTop: -8, borderRadius: '50%' }
          : { left: `${a.x * 100}%`, top: `${a.y * 100}%`, width: `${a.w * 100}%`, height: `${a.h * 100}%` }}
      >
        {label && <span className="region-tag">{label}</span>}
      </div>
    );
  };

  const live = drag && { x: Math.min(drag.x0, drag.x1), y: Math.min(drag.y0, drag.y1), w: Math.abs(drag.x1 - drag.x0), h: Math.abs(drag.y1 - drag.y0) };
  return (
    <div ref={ref} className="region-layer" onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={() => setDrag(null)} style={{ cursor: canAnnotate ? 'crosshair' : 'default' }}>
      {marks.map((m) => box(m.anchor, `${m.status === 'resolved' ? 'resolved' : ''} ${focus === m.id ? 'focus' : ''}`, m.id, m.author.split(' ')[0]))}
      {draft?.type === 'region' && draft.page === page && box(draft, 'draft', 'draft')}
      {live && box(live, 'draft', 'live')}
    </div>
  );
}

// ───────────────────────────── PDF page ─────────────────────────────

export function PdfCanvas({ url, page, onPages }: { url: string; page: number; onPages?: (n: number) => void }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [doc, setDoc] = useState<pdfjs.PDFDocumentProxy | null>(null);
  const [error, setError] = useState<string | null>(null);

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

  useEffect(() => {
    if (!doc || !canvas.current) return;
    let cancelled = false;
    let renderTask: pdfjs.RenderTask | null = null;
    doc.getPage(clamp(page, 1, doc.numPages)).then((p) => {
      if (cancelled || !canvas.current) return;
      const base = p.getViewport({ scale: 1 });
      const cssWidth = Math.min(900, canvas.current.parentElement?.parentElement?.clientWidth ?? 800);
      const scale = (cssWidth / base.width) * (window.devicePixelRatio || 1);
      const viewport = p.getViewport({ scale });
      const c = canvas.current;
      c.width = Math.floor(viewport.width);
      c.height = Math.floor(viewport.height);
      c.style.width = `${Math.floor(viewport.width / (window.devicePixelRatio || 1))}px`;
      c.style.height = `${Math.floor(viewport.height / (window.devicePixelRatio || 1))}px`;
      renderTask = p.render({ canvas: c, viewport });
      renderTask.promise.catch(() => {});
    });
    return () => {
      cancelled = true;
      renderTask?.cancel();
    };
  }, [doc, page]);

  if (error) return <div className="notice notice-bad" style={{ margin: 12 }}>Could not open the PDF: {error}</div>;
  return <canvas ref={canvas} aria-label={`PDF page ${page}`} style={{ background: '#fff' }} />;
}

// ───────────────────────────── video player ─────────────────────────────

interface VideoProps {
  asset: Asset;
  poster?: string;
  threads: CommentThread[];
  firstVideoPosition: number;
  draft: Anchor | null;
  onDraft: (a: Anchor | null) => void;
  canAnnotate: boolean;
  focus: string | null;
  onFocus: (id: string) => void;
  jump: Jump | null;
}

function VideoPlayer({ asset, poster, threads, firstVideoPosition, draft, onDraft, canAnnotate, focus, onFocus, jump }: VideoProps) {
  const ref = useRef<HTMLVideoElement>(null);
  const [t, setT] = useState(0);
  const [dur, setDur] = useState(asset.duration_ms ? asset.duration_ms / 1000 : 0);
  const fps = asset.fps || 30;

  useEffect(() => {
    const v = ref.current;
    if (!v) return;
    let raf: number | null = null;
    const tick = () => {
      setT(v.currentTime);
      if ('requestVideoFrameCallback' in v) raf = (v as HTMLVideoElement & { requestVideoFrameCallback: (cb: () => void) => number }).requestVideoFrameCallback(tick);
    };
    const meta = () => v.duration && Number.isFinite(v.duration) && setDur(v.duration);
    const sync = () => setT(v.currentTime);
    v.addEventListener('loadedmetadata', meta);
    v.addEventListener('timeupdate', sync);
    v.addEventListener('seeked', sync);
    if ('requestVideoFrameCallback' in v) raf = (v as HTMLVideoElement & { requestVideoFrameCallback: (cb: () => void) => number }).requestVideoFrameCallback(tick);
    return () => {
      v.removeEventListener('loadedmetadata', meta);
      v.removeEventListener('timeupdate', sync);
      v.removeEventListener('seeked', sync);
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

  const seek = (clientX: number, el: HTMLElement) => {
    const v = ref.current;
    if (!v || !dur) return;
    const r = el.getBoundingClientRect();
    v.currentTime = clamp((clientX - r.left) / r.width, 0, 1) * dur;
    setT(v.currentTime);
  };

  const mine = threads.filter((c): c is CommentThread & { anchor: Extract<Anchor, { type: 'time' }> } =>
    c.anchor?.type === 'time' && (c.anchor.position ?? firstVideoPosition) === asset.position);
  const draftHere = draft?.type === 'time' && (draft.position ?? firstVideoPosition) === asset.position ? draft : null;
  const pct = (s: number) => (dur ? clamp((s / dur) * 100, 0, 100) : 0);

  return (
    <div
      style={{ width: '100%' }}
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === ',') { e.preventDefault(); step(-1); }
        if (e.key === '.') { e.preventDefault(); step(1); }
      }}
      aria-label="Video player. Press comma and full stop to step one frame."
    >
      <div className="stage-media">
        <video ref={ref} src={asset.url} poster={poster} controls playsInline preload="metadata" />
      </div>
      <div
        className="timeline"
        role="slider"
        aria-label="Timeline"
        aria-valuemin={0}
        aria-valuemax={Math.round(dur)}
        aria-valuenow={Math.round(t)}
        onPointerDown={(e) => { e.currentTarget.setPointerCapture(e.pointerId); seek(e.clientX, e.currentTarget); }}
        onPointerMove={(e) => e.buttons === 1 && seek(e.clientX, e.currentTarget)}
      >
        <div className="timeline-fill" style={{ width: `${pct(t)}%` }} />
        {mine.map((c) => (
          <button
            key={c.id}
            className={`marker ${c.status === 'resolved' ? 'resolved' : ''} ${c.anchor.t_end !== undefined ? 'span' : ''}`}
            style={c.anchor.t_end !== undefined
              ? { left: `${pct(c.anchor.t)}%`, width: `${Math.max(1, pct(c.anchor.t_end) - pct(c.anchor.t))}%`, marginLeft: 0 }
              : { left: `${pct(c.anchor.t)}%` }}
            aria-label={`Comment at ${fmtTime(c.anchor.t)}`}
            onPointerDown={(e) => e.stopPropagation()}
            onClick={() => {
              onFocus(c.id);
              if (ref.current) { ref.current.pause(); ref.current.currentTime = c.anchor.t; setT(c.anchor.t); }
            }}
          />
        ))}
        {draftHere && (
          <div className="marker" style={{ left: `${pct(draftHere.t)}%`, background: '#7c9bff', width: draftHere.t_end !== undefined ? `${Math.max(1, pct(draftHere.t_end) - pct(draftHere.t))}%` : 8, marginLeft: draftHere.t_end !== undefined ? 0 : -4, pointerEvents: 'none' }} />
        )}
        <div className="timeline-head" style={{ left: `${pct(t)}%` }} />
        {focus && mine.some((c) => c.id === focus) && null}
      </div>
      <div className="stage-controls">
        <button className="btn" onClick={() => step(-1)} aria-label="Previous frame" title="Previous frame ( , )">◂ frame</button>
        <button className="btn" onClick={() => step(1)} aria-label="Next frame" title="Next frame ( . )">frame ▸</button>
        <span className="timecode" aria-live="off">{fmtTime(t)}</span>
        <span className="muted small" style={{ color: '#9aa3b0' }}>f{Math.floor(t * fps + 1e-3)} · {fps}fps</span>
        <span className="grow" />
        {canAnnotate && (
          <>
            <button className="btn" onClick={() => onDraft({ type: 'time', t: round2(t), position: asset.position })}>Comment here</button>
            {draftHere && (
              <button className="btn" disabled={t < draftHere.t} onClick={() => onDraft({ ...draftHere, t_end: round2(t) })} title="Turn the comment into a span ending at the current time">Set end here</button>
            )}
          </>
        )}
      </div>
    </div>
  );
}

// ───────────────────────────── the stage ─────────────────────────────

export interface StageProps {
  assets: Asset[];
  threads: CommentThread[];
  draft: Anchor | null;
  onDraft: (a: Anchor | null) => void;
  canAnnotate: boolean;
  focus: string | null;
  onFocus: (id: string) => void;
  jump: Jump | null;
}

/** Shows a version's pages one at a time: a video, an image, a carousel item or a PDF page, with its comments on top. */
export function Stage(p: StageProps) {
  const primaries = useMemo(() => primariesOf(p.assets), [p.assets]);
  const pdf = p.assets.find((a) => a.kind === 'pdf');
  const cover = p.assets.find((a) => a.kind === 'cover');
  const firstVideoPosition = primaries.find((a) => a.kind === 'video')?.position ?? 0;
  const [page, setPage] = useState(1);
  const [pdfPages, setPdfPages] = useState(0);
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
  const regionProps = { page, threads: p.threads, draft: p.draft, onDraft: p.onDraft, canAnnotate: p.canAnnotate, focus: p.focus, onFocus: p.onFocus };

  return (
    <div className="stage">
      {count > 1 && (
        <div className="page-tabs" role="group" aria-label={pdf ? 'PDF pages' : 'Carousel items'}>
          <button className="btn btn-small" disabled={page <= 1} onClick={() => setPage(page - 1)} aria-label="Previous page">‹</button>
          <span aria-live="polite">{pdf ? 'Page' : 'Item'} {page} of {count}</span>
          <button className="btn btn-small" disabled={page >= count} onClick={() => setPage(page + 1)} aria-label="Next page">›</button>
        </div>
      )}
      {pdf ? (
        <div className="stage-media" style={{ background: '#2a2d33' }}>
          <div className="stage-inner">
            <PdfCanvas url={pdf.url} page={page} onPages={setPdfPages} />
            <RegionLayer {...regionProps} />
          </div>
        </div>
      ) : current?.kind === 'video' ? (
        <VideoPlayer
          key={current.id}
          asset={current}
          poster={cover?.url}
          threads={p.threads}
          firstVideoPosition={firstVideoPosition}
          draft={p.draft}
          onDraft={p.onDraft}
          canAnnotate={p.canAnnotate}
          focus={p.focus}
          onFocus={p.onFocus}
          jump={p.jump}
        />
      ) : current ? (
        <div className="stage-media">
          <div className="stage-inner">
            <img src={current.url} alt={current.name} draggable={false} />
            <RegionLayer {...regionProps} />
          </div>
        </div>
      ) : (
        <div className="pad" style={{ color: '#9aa3b0' }}>This version has nothing to show.</div>
      )}
      {p.canAnnotate && (pdf || current?.kind === 'image') && (
        <div className="stage-controls"><span className="small" style={{ color: '#9aa3b0' }}>Click to drop a point or drag to mark an area, then write your comment.</span></div>
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
  const [t, setT] = useState(0);
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
    if (va.paused) void va.play(); else va.pause();
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

  const view = (asset: Asset | undefined, pdf: Asset | undefined, ref: React.RefObject<HTMLVideoElement | null>, label: string) => (
    <div>
      <h3>{label}</h3>
      <div className="stage" style={{ marginTop: '.35rem' }}>
        <div className="stage-media" style={pdf ? { background: '#2a2d33' } : undefined}>
          {pdf ? <PdfCanvas url={pdf.url} page={page} onPages={(n) => setPages((p) => Math.max(p, n))} />
            : asset?.kind === 'video' ? <video ref={ref} src={asset.url} playsInline preload="auto" muted={ref === b} />
            : asset ? <img src={asset.url} alt={`${label}: ${asset.name}`} />
            : <div className="pad" style={{ color: '#9aa3b0' }}>Nothing at this position</div>}
        </div>
      </div>
    </div>
  );

  return (
    <div className="stack">
      <div className="row">
        {count > 1 && (
          <>
            <button className="btn btn-small" disabled={page <= 1} onClick={() => setPage(page - 1)} aria-label="Previous page">‹</button>
            <span>{lpdf || rpdf ? 'Page' : 'Item'} {page} of {count}</span>
            <button className="btn btn-small" disabled={page >= count} onClick={() => setPage(page + 1)} aria-label="Next page">›</button>
          </>
        )}
        {!bothVideo && (
          <>
            <span className="grow" />
            <button className="btn btn-small" aria-pressed={mode === 'side'} onClick={() => setMode('side')}>Side by side</button>
            <button className="btn btn-small" aria-pressed={mode === 'flip'} onClick={() => setMode('flip')}>Flip</button>
            {mode === 'flip' && <button className="btn btn-small" onClick={() => setShowRight((s) => !s)}>Showing {showRight ? rightLabel : leftLabel}</button>}
          </>
        )}
      </div>
      {mode === 'flip' && !bothVideo ? (
        showRight ? view(ra, rpdf, b, rightLabel) : view(la, lpdf, a, leftLabel)
      ) : (
        <div className="compare">
          {view(la, lpdf, a, leftLabel)}
          {view(ra, rpdf, b, rightLabel)}
        </div>
      )}
      {bothVideo && (
        <div className="stage-controls" style={{ borderRadius: 10 }}>
          <button className="btn" onClick={toggle}>{playing ? 'Pause both' : 'Play both'}</button>
          <button className="btn" onClick={() => stepFrame(-1)} aria-label="Previous frame">◂ frame</button>
          <button className="btn" onClick={() => stepFrame(1)} aria-label="Next frame">frame ▸</button>
          <input
            type="range" min={0} max={dur || 1} step={0.01} value={t} aria-label="Position"
            style={{ flex: 1, minWidth: 120, background: 'transparent', border: 0 }}
            onChange={(e) => { const v = Number(e.target.value); if (a.current && b.current) { a.current.currentTime = v; b.current.currentTime = v; setT(v); } }}
          />
          <span className="timecode">{fmtTime(t)}</span>
        </div>
      )}
    </div>
  );
}
