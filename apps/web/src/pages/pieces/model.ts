import { DateTime } from 'luxon';
import { useCallback, useState } from 'react';
import type { PieceSummary } from '../../api';
import { t } from '../../i18n';

/**
 * Where a piece stands, as the board shows it. The review decides the first four; an approved piece then moves on by
 * itself as it is scheduled and goes out (and back to "approved" if what was scheduled is cancelled).
 */
export type Stage = 'draft' | 'in_review' | 'changes_requested' | 'approved' | 'scheduled' | 'published' | 'discarded';
export const BOARD: Stage[] = ['draft', 'in_review', 'changes_requested', 'approved', 'scheduled', 'published'];
/** The state filter: the review states, plus the two stages after approval, plus what was discarded. */
export const STATE_FILTERS = ['', 'draft', 'in_review', 'changes_requested', 'approved', 'scheduled', 'published', 'discarded'] as const;

export function stageOf(p: PieceSummary): Stage {
  if (p.review_state === 'discarded') return 'discarded';
  if (p.review_state !== 'approved') return p.review_state;
  if (p.next_publication) return 'scheduled';
  if (p.last_published_at) return 'published';
  return 'approved';
}

/** Whether a piece is in the state filter. "Approved" is every approved piece, as the sidebar counts them. */
export function inState(p: PieceSummary, state: string): boolean {
  if (!state) return p.review_state !== 'discarded';
  if (state === 'scheduled' || state === 'published') return stageOf(p) === state;
  return p.review_state === state;
}

// ───────────────────────────── sorting ─────────────────────────────

export type SortKey = 'updated' | 'target' | 'title' | 'campaign' | 'state' | 'version' | 'author' | 'comments' | 'next';
export interface Sort {
  key: SortKey;
  dir: 'asc' | 'desc';
}
export const MENU_SORTS: SortKey[] = ['updated', 'target', 'title'];
/** Which way a column sorts first: the newest and the busiest on top, names from A. */
export const FIRST_DIR: Record<SortKey, 'asc' | 'desc'> = {
  updated: 'desc', target: 'asc', title: 'asc', campaign: 'asc', state: 'asc', version: 'desc', author: 'asc', comments: 'desc', next: 'asc',
};

const collator = () => new Intl.Collator(undefined, { sensitivity: 'base', numeric: true });

/** Sorts a copy. Pieces without the value (no target date, nothing scheduled) always go last, whichever the direction. */
export function sortPieces(list: PieceSummary[], sort: Sort): PieceSummary[] {
  const c = collator();
  const value = (p: PieceSummary): string | number | null => {
    switch (sort.key) {
      case 'updated': return Date.parse(p.updated_at);
      case 'target': return p.target_date;
      case 'title': return p.title;
      case 'campaign': return p.campaign_name;
      case 'state': return BOARD.indexOf(stageOf(p));
      case 'version': return p.latest_version?.number ?? null;
      case 'author': return p.latest_version ? (p.latest_version.by_agent ? '\u0000' : p.latest_version.author ?? '') : null;
      case 'comments': return p.open_comments;
      case 'next': return p.next_publication ? Date.parse(p.next_publication.scheduled_at) : null;
    }
  };
  const sign = sort.dir === 'asc' ? 1 : -1;
  return [...list].sort((a, b) => {
    const x = value(a);
    const y = value(b);
    if (x === null || y === null) return x === y ? 0 : x === null ? 1 : -1;
    const d = typeof x === 'number' && typeof y === 'number' ? x - y : c.compare(String(x), String(y));
    return d * sign || Date.parse(b.updated_at) - Date.parse(a.updated_at);
  });
}

// ───────────────────────────── remembered choices ─────────────────────────────

export type View = 'grid' | 'board' | 'list';
export const VIEWS: View[] = ['grid', 'board', 'list'];

export interface Look {
  size: 'S' | 'M' | 'L';
  aspect: '4:5' | '1:1' | '16:9';
  fit: 'fit' | 'fill';
  info: boolean;
}
export const DEFAULT_LOOK: Look = { size: 'M', aspect: '4:5', fit: 'fill', info: true };
export const DEFAULT_SORT: Sort = { key: 'updated', dir: 'desc' };

/** A choice this browser remembers (the cards' appearance, the order, the last view). Without storage it lasts the visit. */
export function useStored<T>(key: string, fallback: T, valid: (v: unknown) => boolean): [T, (v: T) => void] {
  const [value, setValue] = useState<T>(() => {
    try {
      const raw = localStorage.getItem(key);
      const parsed: unknown = raw ? JSON.parse(raw) : null;
      return parsed !== null && valid(parsed) ? (parsed as T) : fallback;
    } catch {
      return fallback;
    }
  });
  const set = useCallback(
    (v: T) => {
      setValue(v);
      try {
        localStorage.setItem(key, JSON.stringify(v));
      } catch {
        // Private mode: the choice just will not stick.
      }
    },
    [key],
  );
  return [value, set];
}

export const isLook = (v: unknown): boolean => {
  const l = v as Partial<Look>;
  return !!l && ['S', 'M', 'L'].includes(l.size!) && ['4:5', '1:1', '16:9'].includes(l.aspect!) && ['fit', 'fill'].includes(l.fit!) && typeof l.info === 'boolean';
};
export const isSort = (v: unknown): boolean => {
  const s = v as Partial<Sort>;
  return !!s && s.key! in FIRST_DIR && (s.dir === 'asc' || s.dir === 'desc');
};
export const isView = (v: unknown): v is View => VIEWS.includes(v as View);

// ───────────────────────────── what the overlays say ─────────────────────────────

/** 47 320 ms → 0:47; an hour or more → 1:02:05. */
export function fmtDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

/** The corner chip about the files: a video's length, how many pictures, a PDF, or a single picture's shape. */
export function mediaLabel(p: PieceSummary): string | null {
  const v = p.latest_version;
  if (!v?.media) return null;
  if (v.media === 'video') return v.duration_ms ? fmtDuration(v.duration_ms) : t('pieces.card.video');
  if (v.media === 'pdf') return v.files > 1 ? t('pieces.card.pdfFiles', { count: v.files }) : t('pieces.card.pdf');
  if (v.files > 1) return t('pieces.card.images', { count: v.files });
  return v.format === 'carousel' || v.format === 'document' ? t('pieces.card.image') : v.format;
}

/** "4 min ago" for the last week, then the day ("24 Sep", with the year when it is not this one). */
export function ago(iso: string): string {
  const d = DateTime.fromISO(iso);
  const now = DateTime.now();
  if (now.diff(d, 'days').days < 6) {
    if (now.diff(d, 'seconds').seconds < 60) return t('pieces.when.now');
    return d.toRelative({ base: now, style: 'short' }) ?? '';
  }
  return d.toFormat(d.year === now.year ? 'd LLL' : 'd LLL yyyy');
}

/** When something is going out, in the brand's time zone: "today, 12:30", "tomorrow, 9:00", "Sat 12:30", "3 Oct, 12:30". */
export function when(iso: string, zone: string): string {
  const d = DateTime.fromISO(iso, { zone });
  const today = DateTime.now().setZone(zone).startOf('day');
  const days = Math.floor(d.startOf('day').diff(today, 'days').days);
  const time = d.toFormat('H:mm');
  if (days === 0) return t('pieces.when.today', { time });
  if (days === 1) return t('pieces.when.tomorrow', { time });
  if (days > 1 && days < 7) return `${d.toFormat('ccc')} ${time}`;
  return `${d.toFormat(d.year === today.year ? 'd LLL' : 'd LLL yyyy')}, ${time}`;
}
