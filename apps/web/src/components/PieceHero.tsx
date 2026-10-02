import { useMutation, useQueryClient } from '@tanstack/react-query';
import { DateTime } from 'luxon';
import { useEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { api, type Asset, type PieceSlot, type VersionDetail, type VersionSummary } from '../api';
import { SlotLine } from './Scheduling';
import { t, tMaybe } from '../i18n';
import { fmtDateTime, fmtDay, STATE_LABEL } from '../lib/format';
import { useStableUrls } from '../lib/stableUrls';
import { Avatar, displayName } from './Avatar';
import { Icon, type IconName } from './icons';
import { Chip, errorMessage, Select, Tip, useToast } from './ui';
import '../styles/piece.css';

// ───────────────────────────── small shared helpers ─────────────────────────────

/** The Select's value for "no campaign" (a Select value may not be empty). */
const NO_CAMPAIGN = 'none';

/** The format as a short tag: the ratio itself, or a word for the carousel and the document. */
export const formatName = (format: string) => tMaybe(`piece.formatName.${format}`, format);
/** What a variant is called when it has no style of its own. */
export const formatHint = (format: string) => tMaybe(`piece.formatHint.${format}`, format);
/** "9:16 · Montaje final": how a variant is named wherever it has to be told apart from the others. */
export const variantName = (v: { format: string; style: string }) => `${formatName(v.format)} · ${v.style || formatHint(v.format)}`;

/** "hace 4 min", short, for lists; the exact moment goes in the tooltip. */
export const ago = (iso: string) => DateTime.fromISO(iso).toRelative({ style: 'short' }) ?? '';

/** Who made a version, as shown: the agent's versions say so, a person's say their short name. */
export const authorName = (v: { author: string | null; by_agent?: boolean }) =>
  v.by_agent ? t('common.agent') : v.author ? displayName(v.author.includes('@') ? null : v.author, v.author.includes('@') ? v.author : null) : t('piece.unknownAuthor');

export interface HeroVariant {
  id: string;
  format: string;
  style: string;
  versions: VersionSummary[];
}

/** An ⓘ beside a field's name that explains it, in the app's tooltip. */
export function InfoTip({ text, label }: { text: string; label: string }) {
  return (
    <Tip label={<span className="pc-tip-text">{text}</span>}>
      <button type="button" className="pc-tip-btn" aria-label={label}>
        <Icon name="info" />
      </button>
    </Tip>
  );
}

// ───────────────────────────── the stage: the version itself ─────────────────────────────

const byPosition = (a: Asset, b: Asset) => a.position - b.position;
const thumbUrl = (versionId: string, w: 240 | 480 | 960) => `/api/versions/${versionId}/thumb?w=${w}`;

function StageVideo({ src, poster, label }: { src: string; poster: string; label: string }) {
  const ref = useRef<HTMLVideoElement>(null);
  const [started, setStarted] = useState(false);
  return (
    <div className="pc-media pc-media-video">
      <video
        ref={ref}
        src={src}
        poster={poster}
        preload="metadata"
        playsInline
        controls={started}
        aria-label={label}
        onPlay={() => setStarted(true)}
      />
      {!started && (
        <button
          type="button"
          className="pc-play"
          aria-label={t('piece.hero.play')}
          onClick={() => {
            setStarted(true);
            void ref.current?.play().catch(() => {});
          }}
        >
          <Icon name="play" />
        </button>
      )}
    </div>
  );
}

/** Slides side by side at the stage's height: the carousel as it will be swiped, the PDF as its pages. */
function Strip({ count, label, children }: { count: number; label: string; children: ReactNode }) {
  const box = useRef<HTMLDivElement>(null);
  const [edge, setEdge] = useState({ start: true, end: count <= 1 });
  const update = () => {
    const b = box.current;
    if (!b) return;
    setEdge({ start: b.scrollLeft < 4, end: b.scrollLeft + b.clientWidth >= b.scrollWidth - 4 });
  };
  useEffect(update, [count]);
  const go = (d: 1 | -1) => box.current?.scrollBy({ left: d * Math.max(200, box.current.clientWidth * 0.7), behavior: 'smooth' });
  return (
    <div className="pc-strip-wrap">
      <div ref={box} className="pc-strip" tabIndex={0} role="group" aria-label={label} onScroll={update}>
        {children}
      </div>
      {!edge.start && (
        <button type="button" className="pc-strip-nav is-prev" aria-label={t('piece.hero.prev')} onClick={() => go(-1)}>
          <Icon name="chevronLeft" />
        </button>
      )}
      {!edge.end && (
        <button type="button" className="pc-strip-nav is-next" aria-label={t('piece.hero.next')} onClick={() => go(1)}>
          <Icon name="chevronRight" />
        </button>
      )}
    </div>
  );
}

function SlideStrip({ items, cover }: { items: { id: string; url: string; kind: string; ar: string }[]; cover?: string }) {
  return (
    <Strip count={items.length} label={t('piece.hero.slides', { count: items.length })}>
      {items.map((a, i) => (
        <figure key={a.id} className="pc-slide">
          <span className="pc-slide-media" style={{ '--ar': a.ar } as CSSProperties}>
            {a.kind === 'video' ? <video src={a.url} poster={cover} preload="metadata" muted playsInline /> : <img src={a.url} alt="" loading={i > 3 ? 'lazy' : undefined} />}
            {a.kind === 'video' && <span className="pc-slide-play" aria-hidden="true"><Icon name="play" /></span>}
          </span>
          <figcaption className="pc-slide-n">{i + 1}</figcaption>
        </figure>
      ))}
    </Strip>
  );
}

/**
 * pdf.js fetches the file, so it needs the page's own origin where an <img> would not: a file the API serves under /media is
 * asked for through this origin (the same address in production; through the dev server's proxy in development).
 */
function sameOriginMedia(url: string): string {
  try {
    const u = new URL(url, window.location.href);
    return u.origin !== window.location.origin && u.pathname.startsWith('/media/') ? `${u.pathname}${u.search}` : url;
  } catch {
    return url;
  }
}

// pdf.js is big: it is loaded the first time a PDF is shown.
type PdfDoc = { numPages: number; getPage: (n: number) => Promise<any>; destroy: () => Promise<void> };
const MAX_PAGES = 12;

function PdfPage({ doc, n }: { doc: PdfDoc; n: number }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [ready, setReady] = useState(false);
  useEffect(() => {
    let cancelled = false;
    let task: { promise: Promise<void>; cancel: () => void } | null = null;
    doc.getPage(n).then((p: any) => {
      const c = canvas.current;
      if (cancelled || !c) return;
      const box = c.parentElement as HTMLElement;
      const h = box.clientHeight || 420;
      const base = p.getViewport({ scale: 1 });
      box.style.setProperty('--ar', `${base.width} / ${base.height}`);
      const ratio = window.devicePixelRatio || 1;
      const viewport = p.getViewport({ scale: (h / base.height) * ratio });
      c.width = Math.floor(viewport.width);
      c.height = Math.floor(viewport.height);
      task = p.render({ canvas: c, viewport });
      task!.promise.then(() => !cancelled && setReady(true), () => {});
    });
    return () => {
      cancelled = true;
      task?.cancel();
    };
  }, [doc, n]);
  return (
    <figure className={`pc-slide pc-page ${ready ? 'is-ready' : ''}`}>
      <span className="pc-slide-media"><canvas ref={canvas} aria-label={t('piece.hero.page', { n })} /></span>
      <figcaption className="pc-slide-n">{n}</figcaption>
    </figure>
  );
}

function PdfStrip({ url, poster, reviewTo, onPages }: { url: string; poster: string; reviewTo: string; onPages: (n: number) => void }) {
  const [doc, setDoc] = useState<PdfDoc | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let alive = true;
    let task: { promise: Promise<PdfDoc>; destroy: () => void } | null = null;
    (async () => {
      const [pdfjs, worker] = await Promise.all([import('pdfjs-dist/legacy/build/pdf.mjs'), import('pdfjs-dist/legacy/build/pdf.worker.min.mjs?url')]);
      if (!pdfjs.GlobalWorkerOptions.workerSrc) pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
      task = pdfjs.getDocument({ url: sameOriginMedia(url) }) as unknown as typeof task;
      const d = await task!.promise;
      if (alive) {
        setDoc(d);
        onPages(d.numPages);
      }
    })().catch(() => alive && setFailed(true));
    return () => {
      alive = false;
      task?.destroy();
    };
  }, [url]);
  if (failed || !doc) {
    return (
      <div className="pc-media">
        <img className="pc-media-img pc-media-paper" src={poster} alt="" onError={(e) => ((e.target as HTMLImageElement).style.visibility = 'hidden')} />
      </div>
    );
  }
  const pages = Math.min(doc.numPages, MAX_PAGES);
  return (
    <Strip count={pages} label={t('piece.hero.pages', { count: doc.numPages })}>
      {Array.from({ length: pages }, (_, i) => <PdfPage key={i} doc={doc} n={i + 1} />)}
      {doc.numPages > pages && (
        <figure className="pc-slide">
          <Link to={reviewTo} className="pc-slide-media pc-slide-more">{t('piece.hero.morePages', { count: doc.numPages - pages })}</Link>
          <figcaption className="pc-slide-n">&nbsp;</figcaption>
        </figure>
      )}
    </Strip>
  );
}

/** How long a video lasts, as the overlays say it: 0:47. */
const duration = (ms: number) => {
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

/** What the stage shows, and the line its corner says about it ("0:47", "6 imágenes", "PDF · 12 págs."). */
function useStage(version: VersionSummary, detail: VersionDetail | undefined, format: string, reviewTo: string): { node: ReactNode; corner: string | null; timecode?: boolean } {
  const stable = useStableUrls();
  const [pages, setPages] = useState<{ id: string; n: number } | null>(null);
  const poster = thumbUrl(version.id, 960);
  if (!detail || detail.id !== version.id) {
    return { node: <div className="pc-media"><img className="pc-media-img is-loading" src={poster} alt="" onError={(e) => ((e.target as HTMLImageElement).style.visibility = 'hidden')} /></div>, corner: null };
  }
  const assets = detail.assets;
  const pdf = assets.find((a) => a.kind === 'pdf');
  if (pdf) {
    const n = pages?.id === pdf.id ? pages.n : null;
    return {
      node: <PdfStrip url={stable(pdf.id, pdf.url)} poster={poster} reviewTo={reviewTo} onPages={(count) => setPages({ id: pdf.id, n: count })} />,
      corner: n ? t('piece.hero.pdfPages', { count: n }) : t('piece.hero.pdf'),
    };
  }
  const primaries = assets.filter((a) => a.kind === 'video' || a.kind === 'image').sort(byPosition);
  const cover = assets.find((a) => a.kind === 'cover');
  if (primaries.length > 1 || format === 'carousel') {
    return {
      node: <SlideStrip items={primaries.map((a) => ({ id: a.id, url: stable(a.id, a.url), kind: a.kind, ar: a.width && a.height ? `${a.width} / ${a.height}` : '4 / 5' }))} cover={cover ? stable(cover.id, cover.url) : undefined} />,
      corner: t('piece.hero.slides', { count: primaries.length }),
    };
  }
  const one = primaries[0];
  if (!one) return { node: <div className="pc-media pc-media-empty"><Icon name="image" /><span>{t('piece.noPreview')}</span></div>, corner: null };
  if (one.kind === 'video') {
    return {
      node: <StageVideo key={version.id} src={stable(one.id, one.url)} poster={cover ? stable(cover.id, cover.url) : poster} label={t('piece.hero.videoOf', { n: version.number })} />,
      corner: one.duration_ms ? duration(one.duration_ms) : null,
      timecode: true,
    };
  }
  return { node: <div className="pc-media"><img className="pc-media-img" src={stable(one.id, one.url)} alt="" /></div>, corner: null };
}

// ───────────────────────────── the version filmstrip ─────────────────────────────

function FilmThumb({ version }: { version: VersionSummary }) {
  const [failed, setFailed] = useState(false);
  if (failed) return <span className="pc-film-ph"><Icon name="file" /></span>;
  return <img src={thumbUrl(version.id, 240)} alt="" loading="lazy" onError={() => setFailed(true)} />;
}

function Filmstrip({ variant, selected, onSelect }: { variant: HeroVariant; selected: string; onSelect: (id: string) => void }) {
  const refs = useRef<Record<string, HTMLButtonElement | null>>({});
  const versions = variant.versions;
  const onKey = (e: KeyboardEvent) => {
    const i = versions.findIndex((v) => v.id === selected);
    const next = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? i + 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? i - 1 : e.key === 'Home' ? 0 : e.key === 'End' ? versions.length - 1 : null;
    if (next === null) return;
    e.preventDefault();
    const v = versions[Math.max(0, Math.min(versions.length - 1, next))];
    if (v) {
      onSelect(v.id);
      refs.current[v.id]?.focus();
    }
  };
  return (
    <div className="pc-film" role="radiogroup" aria-label={t('piece.hero.versionsOf', { variant: variantName(variant) })} onKeyDown={onKey}>
      {versions.map((v, i) => {
        const on = v.id === selected;
        const title = t('piece.versionTitle', { n: v.number, state: STATE_LABEL[v.review_state] ?? v.review_state, who: authorName(v), when: ago(v.created_at) });
        return (
          <button
            key={v.id}
            ref={(el) => { refs.current[v.id] = el; }}
            type="button"
            role="radio"
            aria-checked={on}
            tabIndex={on ? 0 : -1}
            className={`pc-film-item ${v.by_agent ? 'is-agent' : ''} ${['superseded', 'discarded'].includes(v.review_state) ? 'is-old' : ''}`}
            title={title}
            aria-label={title}
            onClick={() => onSelect(v.id)}
          >
            <span className="pc-film-thumb"><FilmThumb version={v} />{i === versions.length - 1 && versions.length > 1 && <span className="pc-film-latest">{t('piece.hero.latest')}</span>}</span>
            <span className="pc-film-label">
              <span className={`pc-film-dot chip-${v.review_state}`} aria-hidden="true" />
              <span className="pc-film-n">V{v.number}</span>
              {v.by_agent && <Icon name="bot" className="pc-film-bot" />}
            </span>
          </button>
        );
      })}
    </div>
  );
}

// ───────────────────────────── editing the piece's facts in place ─────────────────────────────

export interface Patch { title?: string; targetDate?: string | null; campaignId?: string | null; source?: string | null }

export function usePatchPiece(pieceId: string) {
  const qc = useQueryClient();
  const toast = useToast();
  return useMutation({
    mutationFn: (body: Patch) => api.patch(`/api/pieces/${pieceId}`, body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['piece', pieceId] });
      qc.invalidateQueries({ queryKey: ['pieces'] });
      toast(t('piece.saved'));
    },
    onError: (e) => toast(errorMessage(e), 'error'),
  });
}

/** A value that turns into a field on click for whoever can change it: Enter or ✓ saves, Escape or × leaves it as it was. */
function InlineText({ value, canEdit, onSave, label, placeholder, mono, display, className, maxLength, emptyLabel }: {
  value: string;
  canEdit: boolean;
  onSave: (v: string) => Promise<unknown>;
  label: string;
  placeholder?: string;
  mono?: boolean;
  display?: ReactNode;
  className?: string;
  maxLength: number;
  emptyLabel?: string;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (editing) {
      input.current?.focus();
      input.current?.select();
    }
  }, [editing]);
  if (!canEdit) return <>{display ?? (value || <span className="pc-empty-val">{emptyLabel ?? '—'}</span>)}</>;
  if (!editing) {
    return (
      <button type="button" className={`pc-inline ${className ?? ''}`} onClick={() => { setDraft(value); setEditing(true); }} title={t('piece.inline.edit', { what: label })} aria-label={`${label}: ${value || emptyLabel || '—'}. ${t('piece.inline.edit', { what: label })}`}>
        <span className="pc-inline-val">{display ?? (value || <span className="pc-empty-val">{emptyLabel ?? '—'}</span>)}</span>
        <Icon name="pen" className="pc-inline-pen" />
      </button>
    );
  }
  const save = async () => {
    const next = draft.trim();
    if (next === value.trim()) return setEditing(false);
    setBusy(true);
    try {
      await onSave(next);
      setEditing(false);
    } catch {
      // The toast says why; the field stays open with what was typed.
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className={`pc-inline-form ${className ?? ''}`} onSubmit={(e) => { e.preventDefault(); void save(); }}>
      <input
        ref={input}
        type="text"
        className={mono ? 'pc-inline-input is-mono' : 'pc-inline-input'}
        value={draft}
        maxLength={maxLength}
        placeholder={placeholder}
        aria-label={label}
        disabled={busy}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.preventDefault();
            e.stopPropagation();
            setEditing(false);
          }
        }}
      />
      <Tip label={t('common.save')} shortcut="Enter">
        <button type="submit" className="pc-inline-ok" aria-label={t('common.save')} disabled={busy}><Icon name="check" /></button>
      </Tip>
      <Tip label={t('common.cancel')} shortcut="Esc">
        <button type="button" className="pc-inline-no" aria-label={t('common.cancel')} disabled={busy} onClick={() => setEditing(false)}><Icon name="x" /></button>
      </Tip>
    </form>
  );
}

function FieldRow({ label, icon, children, stacked }: { label: ReactNode; icon: IconName; children: ReactNode; stacked?: boolean }) {
  return (
    <div className={`pc-field ${stacked ? 'is-stacked' : ''}`}>
      <dt><Icon name={icon} />{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

// ───────────────────────────── the hero ─────────────────────────────

export interface HeroPiece {
  id: string;
  title: string;
  kind: string;
  review_state: string;
  ai_generated: boolean;
  target_date: string | null;
  campaign_id?: string | null;
  source?: string | null;
  discarded_at: string | null;
  /** The slot occurrence it was made for. */
  slot?: PieceSlot | null;
}

interface HeroProps {
  piece: HeroPiece;
  variants: HeroVariant[];
  variantId: string;
  onVariant: (id: string) => void;
  versionId: string | null;
  onVersion: (id: string) => void;
  detail: VersionDetail | undefined;
  /** Open comments on the variant on show, wherever they were made. */
  openComments: number;
  campaigns: { id: string; name: string }[] | undefined;
  canEdit: boolean;
  zone: string;
}

/** The variant on show, the version on show, and what the corners say about it. */
function shown(p: HeroProps) {
  const variant = p.variants.find((v) => v.id === p.variantId) ?? p.variants[0];
  const version = variant?.versions.find((v) => v.id === p.versionId) ?? variant?.versions.at(-1);
  const latest = variant?.versions.at(-1);
  const comments = version && latest && version.id === latest.id ? p.openComments : (version?.open_comments ?? 0);
  return { variant, version, latest, comments, reviewTo: version ? `/review/${version.id}` : '' };
}

/**
 * The top of a piece, left: its version on show large (a video plays where it is; a carousel and a PDF lie out as a strip), the
 * variants to switch between above it and the versions of that variant underneath, Frame.io's version stack.
 */
export function PieceStage(p: HeroProps) {
  const { variant, version, comments, reviewTo } = shown(p);
  const stage = useStage(version ?? ({ id: '', number: 0 } as VersionSummary), version ? p.detail : undefined, variant?.format ?? '', reviewTo);
  return (
    <section className="pc-hero-media" aria-label={t('piece.hero.label')}>
      {p.variants.length > 1 && (
        <div className="pc-vtabs" role="tablist" aria-label={t('piece.variants')}>
          {p.variants.map((v) => (
            <button key={v.id} type="button" role="tab" aria-selected={v.id === variant?.id} className="pc-vtab" onClick={() => p.onVariant(v.id)} title={variantName(v)}>
              <span className={`pc-vtab-format ${/^\d/.test(v.format) ? 'is-ratio' : ''}`}>{formatName(v.format)}</span>
              <span className="pc-vtab-style">{v.style || formatHint(v.format)}</span>
            </button>
          ))}
        </div>
      )}
      <div className={`pc-stage ${variant?.format === 'document' ? 'is-paper' : ''}`}>
        {version ? stage.node : (
          <div className="pc-media pc-media-empty">
            <Icon name="upload" />
            <span>{t('piece.hero.noVersion')}</span>
          </div>
        )}
        {version && (
          <>
            <span className={`pc-ov pc-ov-tl pc-ov-ver ${version.by_agent ? 'is-agent' : ''}`}>
              {version.by_agent && <Icon name="bot" />}V{version.number}
            </span>
            <Tip label={t('piece.hero.openReview', { n: version.number })} shortcut="R" side="left">
              <Link to={reviewTo} className="pc-ov pc-ov-tr pc-ov-open" aria-label={t('piece.hero.openReview', { n: version.number })}>
                <Icon name="expand" />
              </Link>
            </Tip>
            {comments > 0 && (
              <Link to={reviewTo} className="pc-ov pc-ov-bl pc-ov-comments" title={t('piece.openComments', { count: comments })}>
                <Icon name="bubble" />{comments}
              </Link>
            )}
            {stage.corner && <span className={`pc-ov pc-ov-br ${stage.timecode ? 'is-tc' : ''}`}>{stage.corner}</span>}
          </>
        )}
      </div>
      {variant && variant.versions.length > 1 && version && <Filmstrip variant={variant} selected={version.id} onSelect={p.onVersion} />}
    </section>
  );
}

/**
 * The top of a piece, right: its facts, editable in place by whoever can create pieces (title, campaign, target date, the
 * project it is made from), and what the version on show is: who made it, what changed, what is still open, who approved it.
 */
export function PieceFacts(p: HeroProps) {
  const { piece, variants, detail, campaigns, canEdit, zone } = p;
  const { variant, version, comments, reviewTo } = shown(p);
  const patch = usePatchPiece(piece.id);
  const campaign = campaigns?.find((c) => c.id === piece.campaign_id);
  const approvals = (detail && version && detail.id === version.id ? detail.approvals : []).filter((a) => a.decision === 'approve' && a.matches_fingerprint);
  const [editingDate, setEditingDate] = useState(false);
  const state = piece.discarded_at ? 'discarded' : piece.review_state;
  const approverNames = approvals.map((a) => displayName(a.approver.includes('@') ? null : a.approver, a.approver.includes('@') ? a.approver : null));
  return (
    <section className="pc-info" aria-label={t('piece.hero.facts')}>
      <div className="pc-info-top">
        <span className={`chip chip-solid chip-${state}`}>{STATE_LABEL[state] ?? state}</span>
        <span className="pc-meta">{tMaybe(`kind.${piece.kind}`, piece.kind)}</span>
        {piece.ai_generated && <span className="pc-meta" title={t('piece.aiHint')}><Icon name="sparkle" />{t('piece.aiLabel')}</span>}
      </div>
      <h1 className="pc-title">
        <InlineText
          value={piece.title}
          canEdit={canEdit}
          label={t('piece.fields.title')}
          maxLength={200}
          className="pc-inline-title"
          onSave={(title) => (title ? patch.mutateAsync({ title }) : Promise.reject(new Error('empty')))}
        />
      </h1>

      <dl className="pc-fields">
        <FieldRow label={t('piece.fields.campaign')} icon="folder">
          {canEdit ? (
            <Select
              className="pc-inline-select"
              label={t('piece.fields.campaign')}
              value={piece.campaign_id ?? NO_CAMPAIGN}
              disabled={patch.isPending || !campaigns}
              onChange={(v) => patch.mutate({ campaignId: v === NO_CAMPAIGN ? null : v })}
              options={[{ value: NO_CAMPAIGN, label: t('piece.fields.noCampaign') }, ...(campaigns ?? []).map((c) => ({ value: c.id, label: c.name }))]}
            />
          ) : campaign ? (
            <Link to={`/pieces?campaign=${campaign.id}`} className="pc-field-link">{campaign.name}</Link>
          ) : (
            <span className="pc-empty-val">{t('piece.fields.noCampaign')}</span>
          )}
        </FieldRow>
        <FieldRow label={t('piece.fields.target')} icon="calendar">
          {canEdit && editingDate ? (
            <input
              type="date"
              className="pc-inline-date"
              autoFocus
              aria-label={t('piece.fields.target')}
              defaultValue={piece.target_date ?? ''}
              onBlur={(e) => {
                setEditingDate(false);
                const v = e.target.value || null;
                if (v !== (piece.target_date ?? null)) patch.mutate({ targetDate: v });
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
                if (e.key === 'Escape') {
                  e.preventDefault();
                  e.stopPropagation();
                  setEditingDate(false);
                }
              }}
            />
          ) : canEdit ? (
            <button type="button" className="pc-inline" onClick={() => setEditingDate(true)} title={t('piece.inline.edit', { what: t('piece.fields.target') })}>
              <span className="pc-inline-val">{piece.target_date ? fmtDay(piece.target_date) : <span className="pc-empty-val">{t('piece.fields.noDate')}</span>}</span>
              <Icon name="pen" className="pc-inline-pen" />
            </button>
          ) : piece.target_date ? fmtDay(piece.target_date) : <span className="pc-empty-val">{t('piece.fields.noDate')}</span>}
        </FieldRow>
        {piece.slot && (
          <FieldRow label={t('fx.slot.field')} icon="clock">
            <SlotLine slot={piece.slot} zone={zone} />
          </FieldRow>
        )}
        <FieldRow stacked icon="branch" label={<>{t('piece.fields.source')}<InfoTip text={t('piece.fields.sourceHint')} label={t('piece.fields.sourceWhat')} /></>}>
          <InlineText
            value={piece.source ?? ''}
            canEdit={canEdit}
            mono
            label={t('piece.fields.source')}
            placeholder={t('piece.fields.sourcePlaceholder')}
            maxLength={500}
            emptyLabel={canEdit ? t('piece.fields.addSource') : t('piece.fields.noSource')}
            display={piece.source ? <code className="pc-source" title={piece.source}>{piece.source}</code> : undefined}
            onSave={(source) => patch.mutateAsync({ source: source || null })}
          />
        </FieldRow>
      </dl>

      {version && variant && (
        <div className="pc-ver">
          <div className="pc-ver-head">
            <span className={`pc-ver-n ${version.by_agent ? 'is-agent' : ''}`}>V{version.number}</span>
            <span className="pc-ver-variant" title={variantName(variant)}>{variantName(variant)}</span>
            <Chip state={version.review_state} />
          </div>
          <div className="pc-ver-meta">
            {version.by_agent ? <Avatar agent size={16} title={version.author ?? undefined} /> : <Avatar name={authorName(version)} size={16} />}
            <span className={version.by_agent ? 'pc-agent-name' : undefined} title={version.author ?? undefined}>{authorName(version)}</span>
            <span className="pc-dot-sep" aria-hidden="true">·</span>
            <time dateTime={version.created_at} title={fmtDateTime(version.created_at, zone)}>{ago(version.created_at)}</time>
            {comments > 0 && (
              <>
                <span className="pc-dot-sep" aria-hidden="true">·</span>
                <Link to={reviewTo} className="pc-meta-link" title={t('piece.openComments', { count: comments })}><Icon name="bubble" />{comments}</Link>
              </>
            )}
          </div>
          {version.notes && <p className="pc-ver-notes" title={version.notes}>{version.notes}</p>}
          {approvals.length > 0 && (
            <div className="pc-ver-meta" title={approverNames.join(', ')}>
              <span className="avatars">{approvals.slice(0, 3).map((a, i) => <Avatar key={a.id} name={approverNames[i]} size={16} />)}</span>
              <span>{t('piece.hero.approvedBy', { names: approverNames.join(', ') })}</span>
            </div>
          )}
          <Link to={reviewTo} className="btn btn-block pc-ver-review" title={t('piece.reviewHint', { n: version.number, variant: variantName(variant) })}>
            {t('piece.reviewN', { n: version.number })}
            <Icon name="arrowRight" />
          </Link>
        </div>
      )}
    </section>
  );
}
