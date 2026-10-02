import { useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import { DateTime, Info } from 'luxon';
import { useEffect, useMemo, useState, type DragEvent, type ReactNode } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api, type Account, type CalendarData, type PieceDetail, type PieceSummary, type VersionDetail } from '../api';
import { Icon } from '../components/icons';
import { PageBar } from '../components/PageBar';
import { PublicationBadges, ScheduleDialog } from '../components/publications';
import { Chip, Dialog, ErrorBox, errorMessage, Field, NetMark, Segmented, Skeleton, useToast } from '../components/ui';
import { t, tMaybe, type Key } from '../i18n';
import { NETWORK_LABEL, STATE_LABEL } from '../lib/format';
import { useSession } from '../lib/session';
import '../styles/ops.css';

type View = 'month' | 'week' | 'list';
type Pub = CalendarData['publications'][number];
type Slot = CalendarData['slots'][number];
type Entry = { kind: 'pub'; at: string; pub: Pub } | { kind: 'slot'; at: string; slot: Slot };

const VIEWS: View[] = ['month', 'week', 'list'];
/** How many entries a month cell shows before it offers "+N more". */
const CELL_MAX = 3;
/** What a drag carries: a publication to move, or an approved version to schedule. */
const DRAG_PUB = 'application/x-studio-publication';
const DRAG_VERSION = 'application/x-studio-version';

// ───────────────────────────── helpers shared with Publish and Results ─────────────────────────────

/** The network's short name for the monospaced tags: IG, TT, YT… */
export const netShort = (network: string) => tMaybe(`calendar.net.${network}`, network.slice(0, 2).toUpperCase());

/** The colour family of a publication: its state, except a post that went out but is not public, which needs a look. */
export function stateClass(p: Pick<Pub, 'status' | 'visibility' | 'manual'>): string {
  if (p.status === 'published' && !p.manual && p.visibility && p.visibility !== 'public') return 'st-attention';
  return `st-${p.status}`;
}

/** A wall-clock hour in the brand's zone. */
export const hourIn = (iso: string, zone: string) => DateTime.fromISO(iso, { zone }).toFormat('HH:mm');

/** True while the screen is narrower than the query: a phone gets an agenda instead of a grid. */
export function useNarrow(query = '(max-width: 640px)') {
  const [narrow, setNarrow] = useState(() => typeof window !== 'undefined' && window.matchMedia(query).matches);
  useEffect(() => {
    const mq = window.matchMedia(query);
    const on = () => setNarrow(mq.matches);
    on();
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, [query]);
  return narrow;
}

/**
 * The picture of what goes out: the exact version when there is one, else the piece's latest, else a quiet placeholder.
 * Decorative (the title is always beside it).
 */
export function Thumb({ versionId, pieceId, w = 240, className = '' }: { versionId?: string | null; pieceId?: string | null; w?: number; className?: string }) {
  const sources = [versionId && `/api/versions/${versionId}/thumb?w=${w}`, pieceId && `/api/pieces/${pieceId}/thumb?w=${w}`].filter(Boolean) as string[];
  const [failed, setFailed] = useState(0);
  const src = sources[failed];
  return (
    <span className={`ops-thumb ${className}`.trim()} aria-hidden="true">
      {src ? <img src={src} alt="" loading="lazy" draggable={false} onError={() => setFailed((n) => n + 1)} /> : <Icon name="image" />}
    </span>
  );
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
/** "viernes, 2 de octubre" / "Friday, October 2": the language's own way of saying a day. */
const longDay = (d: DateTime) => d.toLocaleString({ weekday: 'long', day: 'numeric', month: 'long' });

function rangeFor(view: View, anchor: DateTime): { from: DateTime; to: DateTime } {
  if (view === 'week') return { from: anchor.startOf('week'), to: anchor.endOf('week').startOf('day') };
  if (view === 'list') return { from: anchor.startOf('day'), to: anchor.plus({ days: 29 }).startOf('day') };
  return { from: anchor.startOf('month').startOf('week'), to: anchor.endOf('month').endOf('week').startOf('day') };
}

function periodTitle(view: View, anchor: DateTime, from: DateTime, to: DateTime): string {
  if (view === 'month') return cap(anchor.toLocaleString({ month: 'long', year: 'numeric' }));
  if (from.year !== to.year) return `${from.toFormat('d LLL yyyy')} – ${to.toFormat('d LLL yyyy')}`;
  if (from.month === to.month) return `${from.toFormat('d')} – ${to.toFormat('d LLL yyyy')}`;
  return `${from.toFormat('d LLL')} – ${to.toFormat('d LLL yyyy')}`;
}

function pubTitle(p: Pub): string {
  return [
    p.piece_title,
    `${NETWORK_LABEL[p.network] ?? p.network} · ${p.account_name}`,
    STATE_LABEL[p.status] ?? p.status,
    p.manual ? t('calendar.byHand') : t('calendar.automatic'),
    p.hold_reason,
    p.last_error,
  ]
    .filter(Boolean)
    .join(' · ');
}

// ───────────────────────────── block a date ─────────────────────────────

function BlockDialog({ brandId, onClose }: { brandId: string; onClose: () => void }) {
  const qc = useQueryClient();
  const [day, setDay] = useState('');
  const [reason, setReason] = useState('');
  const save = useMutation({
    mutationFn: () => api.post(`/api/brands/${brandId}/blocked-dates`, { day, reason }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['calendar'] });
      onClose();
    },
  });
  return (
    <Dialog title={t('calendar.block')} onClose={onClose}>
      <form className="stack" onSubmit={(e) => { e.preventDefault(); save.mutate(); }}>
        <p className="muted" style={{ margin: 0 }}>{t('calendar.blockHint')}</p>
        <Field label={t('calendar.blockDay')}><input type="date" required value={day} onChange={(e) => setDay(e.target.value)} /></Field>
        <Field label={t('calendar.blockReason')}><input type="text" maxLength={200} value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
        {save.error && <ErrorBox error={save.error} />}
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <button type="button" className="btn" onClick={onClose}>{t('common.cancel')}</button>
          <button className="btn btn-primary" disabled={!day || save.isPending}>{t('calendar.blockSubmit')}</button>
        </div>
      </form>
    </Dialog>
  );
}

// ───────────────────────────── approved, not scheduled ─────────────────────────────

interface Ready {
  pieceId: string;
  title: string;
  /** The version a drop schedules: the latest approved one of the piece's formats. */
  versionId: string;
  number: number;
  /** Every format with an approved version, the scheduled one first. */
  formats: string[];
  approvedAt: string;
}

/** Statuses that mean a piece already has a date: everything but a cancelled publication. */
const DATED = ['scheduled', 'awaiting_reapproval', 'on_hold', 'preparing', 'ready', 'publishing', 'published', 'failed'];

/**
 * The approved pieces with nothing on the calendar: for each of their formats, the latest approved version. Read from the piece
 * pages the app loads anyway (one request per approved piece, cached under the same key the piece page uses).
 */
function useUnscheduled(brandId: string, enabled: boolean) {
  const list = useQuery({
    queryKey: ['pieces', brandId, 'approved'],
    enabled,
    queryFn: () => api.get<PieceSummary[]>(`/api/brands/${brandId}/pieces?state=approved`),
  });
  const details = useQueries({
    queries: (list.data ?? []).map((p) => ({ queryKey: ['piece', p.id], queryFn: () => api.get<PieceDetail>(`/api/pieces/${p.id}`) })),
  });
  const loading = list.isLoading || details.some((d) => d.isLoading);
  const items: Ready[] = [];
  for (const d of details) {
    const piece = d.data;
    if (!piece || piece.review_state !== 'approved') continue;
    if (piece.publications.some((p) => DATED.includes(p.status))) continue;
    // One card per piece: once any of its formats has a date, the piece has left the tray.
    const approved = piece.variants
      .map((v) => ({ format: v.format, version: v.versions.filter((x) => x.review_state === 'approved').sort((a, b) => b.number - a.number)[0] }))
      .filter((x) => x.version)
      .sort((a, b) => b.version!.created_at.localeCompare(a.version!.created_at));
    const first = approved[0];
    if (first) {
      items.push({
        pieceId: piece.id, title: piece.title, versionId: first.version!.id, number: first.version!.number,
        formats: [...new Set(approved.map((x) => x.format))], approvedAt: first.version!.created_at,
      });
    }
  }
  items.sort((a, b) => b.approvedAt.localeCompare(a.approvedAt));
  return { items, loading, error: list.error };
}

function Tray({ items, loading, canDrag, touch, onSchedule }: {
  items: Ready[];
  loading: boolean;
  canDrag: boolean;
  touch: boolean;
  onSchedule: (r: Ready) => void;
}) {
  return (
    <aside className="oc-tray" aria-labelledby="oc-tray-title">
      <header className="oc-tray-head" title={canDrag && !touch ? t('calendar.tray.hint') : t('calendar.tray.hintTap')}>
        <h2 id="oc-tray-title">{t('calendar.tray.title')}</h2>
        {!loading && items.length > 0 && <span className="ops-count">{items.length}</span>}
      </header>
      {loading && (
        <div className="oc-tray-list">
          {[0, 1].map((i) => (
            <div key={i} className="oc-ready oc-ready-skel"><Skeleton width={40} height={50} radius={6} /><span className="grow stack" style={{ gap: 6 }}><Skeleton width="85%" /><Skeleton width="40%" height={10} /></span></div>
          ))}
        </div>
      )}
      {!loading && items.length === 0 && <p className="oc-tray-empty">{t('calendar.tray.empty')}</p>}
      {!loading && items.length > 0 && (
        <ul className="oc-tray-list">
          {items.map((r) => (
            <li key={r.versionId}>
              <button
                type="button"
                className={`oc-ready ${canDrag ? 'movable' : ''}`}
                draggable={canDrag && !touch}
                onDragStart={(e) => {
                  e.dataTransfer.setData(DRAG_VERSION, r.versionId);
                  e.dataTransfer.setData('text/plain', r.title);
                  e.dataTransfer.effectAllowed = 'copy';
                }}
                onClick={() => onSchedule(r)}
                aria-label={t('calendar.tray.scheduleLabel', { title: r.title })}
                title={canDrag && !touch ? t('calendar.tray.hint') : t('calendar.tray.hintTap')}
              >
                <Thumb versionId={r.versionId} pieceId={r.pieceId} className="oc-ready-thumb" />
                <span className="oc-ready-text">
                  <span className="oc-ready-title">{r.title}</span>
                  <span className="oc-ready-meta">
                    <span>V{r.number}</span>
                    <span aria-hidden="true">·</span>
                    <span className="oc-ready-formats">{r.formats.length > 2 ? `${r.formats.slice(0, 2).join(' · ')} +${r.formats.length - 2}` : r.formats.join(' · ')}</span>
                  </span>
                </span>
                {canDrag && <span className="oc-ready-go" aria-hidden="true"><Icon name="calendar" /></span>}
              </button>
            </li>
          ))}
        </ul>
      )}
    </aside>
  );
}

/** Opens the schedule dialog for a version once it has loaded; `day` is the day it was dropped on, if any. */
function ScheduleFor({ versionId, brandId, zone, when, onClose }: { versionId: string; brandId: string; zone: string; when?: string; onClose: () => void }) {
  const v = useQuery({ queryKey: ['version', versionId], queryFn: () => api.get<VersionDetail>(`/api/versions/${versionId}`) });
  if (v.error) {
    return (
      <Dialog title={t('calendar.tray.title')} onClose={onClose}>
        <ErrorBox error={v.error} />
      </Dialog>
    );
  }
  if (!v.data) return null;
  // `initialWhen` presets the day and hour the piece was dropped on (an optional prop of ScheduleDialog; passed through a
  // spread so this compiles before and after it exists).
  const preset = when ? ({ initialWhen: when } as object) : {};
  return <ScheduleDialog version={v.data} brandId={brandId} zone={zone} onClose={onClose} {...preset} />;
}

// ───────────────────────────── the page ─────────────────────────────

export function CalendarPage() {
  const { brand, can } = useSession();
  const qc = useQueryClient();
  const toast = useToast();
  const narrow = useNarrow();
  const touch = useNarrow('(hover: none)');
  const zone = brand.timezone;
  // The view and the date live in the address, so a week or a month can be bookmarked and shared.
  const [params, setParams] = useSearchParams();
  const view: View = VIEWS.find((v) => v === params.get('view')) ?? 'month';
  const asked = params.get('date') ? DateTime.fromISO(params.get('date')!, { zone }) : null;
  const anchor = asked?.isValid ? asked : DateTime.now().setZone(zone);
  const go = (next: { view?: View; anchor?: DateTime }) => {
    const p = new URLSearchParams(params);
    const v = next.view ?? view;
    const a = next.anchor ?? anchor;
    if (v === 'month') p.delete('view');
    else p.set('view', v);
    if (a.toISODate() === DateTime.now().setZone(zone).toISODate()) p.delete('date');
    else p.set('date', a.toISODate()!);
    setParams(p, { replace: true });
  };
  const setView = (v: View) => go({ view: v });
  const setAnchor = (a: DateTime) => go({ anchor: a });
  const [network, setNetwork] = useState('');
  const [dropDay, setDropDay] = useState<string | null>(null);
  const [blocking, setBlocking] = useState(false);
  const [scheduling, setScheduling] = useState<{ versionId: string; when?: string } | null>(null);
  const [trayOpen, setTrayOpen] = useState(() => {
    try { return localStorage.getItem('studio.calendar.tray') !== '0'; } catch { return true; }
  });
  const toggleTray = () => {
    setTrayOpen((o) => {
      try { localStorage.setItem('studio.calendar.tray', o ? '0' : '1'); } catch { /* the choice just will not stick */ }
      return !o;
    });
  };
  const { from, to } = rangeFor(view, anchor);
  const fromS = from.toISODate()!;
  const toS = to.toISODate()!;

  const { data, error, isLoading } = useQuery({
    queryKey: ['calendar', brand.id, fromS, toS],
    queryFn: () => api.get<CalendarData>(`/api/brands/${brand.id}/calendar?from=${fromS}&to=${toS}`),
  });
  const { data: accounts } = useQuery({ queryKey: ['accounts', brand.id], queryFn: () => api.get<Account[]>(`/api/brands/${brand.id}/accounts`) });
  const networks = [...new Set((accounts ?? []).map((a) => a.network))];
  const paused = data?.paused ?? brand.paused;
  const canMove = can('schedule') && !paused;
  const ready = useUnscheduled(brand.id, can('schedule'));

  const move = useMutation({
    mutationFn: ({ id, scheduledAt }: { id: string; scheduledAt: string; day: string }) => api.patch(`/api/publications/${id}`, { scheduledAt }),
    onSuccess: (_r, v) => {
      qc.invalidateQueries({ queryKey: ['calendar'] });
      qc.invalidateQueries({ queryKey: ['piece'] });
      toast(t('calendar.moved', { day: longDay(DateTime.fromISO(v.day)) }));
    },
    onError: (e) => toast(errorMessage(e), 'error'),
  });
  const unblock = useMutation({
    mutationFn: (day: string) => api.del(`/api/brands/${brand.id}/blocked-dates/${day}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['calendar'] });
      toast(t('calendar.unblocked'));
    },
    onError: (e) => toast(errorMessage(e), 'error'),
  });

  const days = useMemo(() => {
    const out: DateTime[] = [];
    for (let d = from; d <= to; d = d.plus({ days: 1 })) out.push(d);
    return out;
  }, [fromS, toS]); // eslint-disable-line react-hooks/exhaustive-deps

  const pubs = (data?.publications ?? []).filter((p) => !network || p.network === network);
  const allSlots = (data?.slots ?? []).filter((s) => !s.filled && !s.past && !s.blocked);
  const slots = allSlots.filter((s) => !network || s.network === network);
  const blocked = new Map((data?.blocked ?? []).map((b) => [b.day, b.reason]));
  const dayOf = (iso: string) => DateTime.fromISO(iso, { zone }).toISODate()!;
  const now = DateTime.now().setZone(zone);
  const today = now.toISODate()!;

  // Everything on a day, publications and empty slots together, in the order of the clock.
  const byDay = useMemo(() => {
    const m = new Map<string, Entry[]>();
    const add = (day: string, e: Entry) => m.set(day, [...(m.get(day) ?? []), e]);
    for (const p of pubs) add(dayOf(p.scheduled_at), { kind: 'pub', at: p.scheduled_at, pub: p });
    for (const s of slots) add(s.day, { kind: 'slot', at: s.at, slot: s });
    for (const list of m.values()) list.sort((a, b) => a.at.localeCompare(b.at));
    return m;
  }, [data, network]); // eslint-disable-line react-hooks/exhaustive-deps

  const movePub = (day: string, id: string) => {
    const p = data?.publications.find((x) => x.id === id);
    if (!p || dayOf(p.scheduled_at) === day) return;
    const local = DateTime.fromISO(p.scheduled_at, { zone });
    const next = DateTime.fromISO(day, { zone }).set({ hour: local.hour, minute: local.minute });
    move.mutate({ id, scheduledAt: next.toUTC().toISO()!, day });
  };
  /** An approved piece dropped on a day: the dialog opens on that day, at its first free slot or at ten. */
  const scheduleOn = (day: string, versionId: string) => {
    const slot = allSlots.find((s) => s.day === day);
    const time = slot ? hourIn(slot.at, zone) : '10:00';
    setScheduling({ versionId, when: `${day}T${time}` });
    toast(t('calendar.tray.dropped', { day: longDay(DateTime.fromISO(day, { zone })) }));
  };

  const step = (dir: -1 | 1) => setAnchor(anchor.plus(view === 'month' ? { months: dir } : view === 'week' ? { weeks: dir } : { days: 30 * dir }));
  const title = periodTitle(view, anchor, from, to);
  // On a phone the grid would be unreadable: the same range becomes an agenda (the month only, without its edges).
  const agenda = view === 'list' || narrow;
  const agendaDays = view === 'month' ? days.filter((d) => d.month === anchor.month) : days;
  const inRange = (agenda ? agendaDays : days).map((d) => d.toISODate()!);
  const pubCount = inRange.reduce((n, d) => n + (byDay.get(d)?.filter((e) => e.kind === 'pub').length ?? 0), 0);
  const slotCount = inRange.reduce((n, d) => n + (byDay.get(d)?.filter((e) => e.kind === 'slot').length ?? 0), 0);
  const showTray = can('schedule') && trayOpen;

  // ── one publication or slot inside a grid cell ──
  const item = (e: Entry, tall: boolean) => {
    if (e.kind === 'slot') {
      const s = e.slot;
      return (
        <div
          key={`s-${s.id}-${s.at}`}
          className="oc-item oc-slot"
          title={t('calendar.slotTitle', { label: s.label || t('calendar.slot'), account: `${NETWORK_LABEL[s.network] ?? s.network} · ${s.account_name}` })}
        >
          <span className="oc-time">{hourIn(s.at, zone)}</span>
          <NetMark network={s.network} size="xs" />
          <span className="oc-name">{s.label || t('calendar.slot')}</span>
        </div>
      );
    }
    const p = e.pub;
    const draggable = canMove && (p.status === 'scheduled' || p.status === 'awaiting_reapproval');
    return (
      <Link
        key={p.id}
        to={`/pieces/${p.piece_id}`}
        className={`oc-item oc-pub ${stateClass(p)} ${draggable ? 'movable' : ''} ${tall ? 'tall' : ''}`}
        draggable={draggable}
        onDragStart={(ev) => {
          ev.dataTransfer.setData(DRAG_PUB, p.id);
          ev.dataTransfer.setData('text/plain', p.piece_title);
          ev.dataTransfer.effectAllowed = 'move';
        }}
        title={pubTitle(p)}
      >
        <Thumb versionId={p.version_id} pieceId={p.piece_id} className="oc-thumb" />
        <span className="oc-item-text">
          <span className="oc-item-top">
            <span className="oc-time">{hourIn(p.scheduled_at, zone)}</span>
            <NetMark network={p.network} size="xs" />
          </span>
          <span className="oc-name">{p.piece_title}</span>
          {tall && <span className="oc-sub">{STATE_LABEL[p.status] ?? p.status} · {p.manual ? t('calendar.byHand') : t('calendar.automatic')}</span>}
        </span>
      </Link>
    );
  };

  const dropProps = (day: string, isBlocked: boolean) =>
    canMove && !isBlocked
      ? {
          onDragOver: (e: DragEvent) => {
            const types = e.dataTransfer.types;
            if (!types.includes(DRAG_PUB) && !types.includes(DRAG_VERSION)) return;
            e.preventDefault();
            e.dataTransfer.dropEffect = types.includes(DRAG_PUB) ? 'move' : 'copy';
            if (dropDay !== day) setDropDay(day);
          },
          onDragLeave: (e: DragEvent) => {
            if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDropDay((x) => (x === day ? null : x));
          },
          onDrop: (e: DragEvent) => {
            e.preventDefault();
            setDropDay(null);
            const pub = e.dataTransfer.getData(DRAG_PUB);
            const version = e.dataTransfer.getData(DRAG_VERSION);
            if (pub) movePub(day, pub);
            else if (version) scheduleOn(day, version);
          },
        }
      : {};

  const blockedNote = (day: string) => (
    <span className="oc-blocked" title={blocked.get(day) || t('calendar.blocked')}>
      <Icon name="ban" />
      <span className="oc-blocked-text">{blocked.get(day) || t('calendar.blocked')}</span>
      {can('schedule') && (
        <button className="oc-unblock" aria-label={t('calendar.unblock', { day: DateTime.fromISO(day).toLocaleString({ day: 'numeric', month: 'long' }) })} onClick={() => unblock.mutate(day)}>
          <Icon name="x" />
        </button>
      )}
    </span>
  );

  // ── a day in the month or week grid ──
  const cell = (d: DateTime) => {
    const day = d.toISODate()!;
    const entries = byDay.get(day) ?? [];
    const isBlocked = blocked.has(day);
    const week = view === 'week';
    const shown = week ? entries : entries.slice(0, entries.length > CELL_MAX ? CELL_MAX - 1 : CELL_MAX);
    const hidden = entries.length - shown.length;
    const label = longDay(d);
    return (
      <div
        key={day}
        role="gridcell"
        className={['oc-day', view === 'month' && d.month !== anchor.month ? 'out' : '', day === today ? 'today' : '', day < today ? 'past' : '', isBlocked ? 'blocked' : '', dropDay === day ? 'drop' : '']
          .filter(Boolean)
          .join(' ')}
        aria-label={isBlocked ? t('calendar.dayBlocked', { day: label }) : label}
        {...dropProps(day, isBlocked)}
      >
        <div className="oc-day-head">
          <span className="oc-num">{week ? <><span className="oc-num-dow">{d.toFormat('ccc')}</span>{d.day}</> : d.day}</span>
          {isBlocked && blockedNote(day)}
        </div>
        <div className="oc-items">
          {shown.map((e) => item(e, week))}
          {hidden > 0 && (
            <button className="oc-more" aria-label={t('calendar.moreLabel', { count: hidden })} onClick={() => go({ view: 'week', anchor: d })}>
              {t('calendar.more', { count: hidden })}
            </button>
          )}
        </div>
        {dropDay === day && <span className="oc-drop-hint" aria-hidden="true">{t('calendar.dropHere')}</span>}
      </div>
    );
  };

  // ── the agenda: days with something on them, one row per publication or slot ──
  const agendaView = () => {
    const shownDays = agendaDays.filter((d) => {
      const day = d.toISODate()!;
      return byDay.has(day) || blocked.has(day) || day === today;
    });
    if (!pubCount && !slotCount && !agendaDays.some((d) => blocked.has(d.toISODate()!))) {
      return <p className="ops-quiet">{t('calendar.empty')}</p>;
    }
    return (
      <div className="oc-agenda">
        {shownDays.map((d) => {
          const day = d.toISODate()!;
          const entries = byDay.get(day) ?? [];
          const isBlocked = blocked.has(day);
          return (
            <section key={day} className={`oc-aday ${day === today ? 'today' : ''} ${isBlocked ? 'blocked' : ''} ${dropDay === day ? 'drop' : ''}`} aria-label={longDay(d)} {...dropProps(day, isBlocked)}>
              <header className="oc-aday-head">
                <span className="oc-aday-num">{d.toFormat('d')}</span>
                <h3>{cap(longDay(d))}</h3>
                {day === today && <span className="oc-today-tag">{t('calendar.today')}</span>}
                {isBlocked && blockedNote(day)}
              </header>
              {entries.length > 0 ? (
                <ul className="ops-rows">
                  {entries.map((e) =>
                    e.kind === 'slot' ? (
                      <li key={`s-${e.slot.id}-${e.at}`} className="ops-row ops-row-slot">
                        <span className="ops-row-time">{hourIn(e.at, zone)}</span>
                        <span className="ops-thumb ops-thumb-slot" aria-hidden="true"><Icon name="plus" /></span>
                        <div className="ops-row-main">
                          <span className="ops-row-title">{e.slot.label || t('calendar.slot')}</span>
                          <span className="ops-row-sub"><NetMark network={e.slot.network} size="xs" />{NETWORK_LABEL[e.slot.network] ?? e.slot.network} · {e.slot.account_name}</span>
                        </div>
                        <div className="ops-row-side"><span className="ops-slot-chip">{t('calendar.legend.slot')}</span></div>
                      </li>
                    ) : (
                      <li
                        key={e.pub.id}
                        className={`ops-row ${stateClass(e.pub)}`}
                        draggable={canMove && !narrow && (e.pub.status === 'scheduled' || e.pub.status === 'awaiting_reapproval')}
                        onDragStart={(ev) => ev.dataTransfer.setData(DRAG_PUB, e.pub.id)}
                      >
                        <span className="ops-row-time">{hourIn(e.at, zone)}</span>
                        <Thumb versionId={e.pub.version_id} pieceId={e.pub.piece_id} />
                        <div className="ops-row-main">
                          <Link to={`/pieces/${e.pub.piece_id}`} className="ops-row-title">{e.pub.piece_title}</Link>
                          <span className="ops-row-sub">
                            <NetMark network={e.pub.network} size="xs" />
                            {NETWORK_LABEL[e.pub.network] ?? e.pub.network} · {e.pub.account_name}
                            {e.pub.hold_reason ? ` · ${e.pub.hold_reason}` : ''}
                          </span>
                        </div>
                        <div className="ops-row-side">
                          <Chip state={e.pub.status} />
                          <PublicationBadges pub={e.pub} />
                        </div>
                      </li>
                    ),
                  )}
                </ul>
              ) : (
                day === today && !isBlocked && <p className="oc-aday-empty">{t('calendar.todayEmpty')}</p>
              )}
            </section>
          );
        })}
      </div>
    );
  };

  const viewSwitch = <Segmented label={t('calendar.viewLabel')} value={view} onChange={setView} options={VIEWS.map((v) => ({ value: v, label: t(`calendar.view.${v}` as Key) }))} />;

  let body: ReactNode = null;
  if (isLoading) {
    body = (
      <div className="oc-grid month" aria-busy="true">
        {Array.from({ length: 5 }, (_, w) => (
          <div key={w} className="oc-week">
            {Array.from({ length: 7 }, (_, i) => <div key={i} className="oc-day"><Skeleton width={18} height={12} /><Skeleton height={30} style={{ marginTop: 6, opacity: (w + i) % 3 ? 0 : 1 }} /></div>)}
          </div>
        ))}
      </div>
    );
  } else if (data && !agenda) {
    const todayDow = days.some((d) => d.toISODate() === today) ? now.weekday : 0;
    body = (
      <div className={`oc-grid ${view === 'week' ? 'week' : 'month'} ${paused ? 'paused' : ''}`} role="grid" aria-label={t('calendar.gridLabel', { period: title })}>
        {view === 'month' && (
          <div className="oc-week oc-dows" role="row">
            {Info.weekdays('short').map((d, i) => <div key={d} className={`oc-dow-head ${todayDow === i + 1 ? 'today' : ''}`} role="columnheader">{d}</div>)}
          </div>
        )}
        {Array.from({ length: Math.ceil(days.length / 7) }, (_, w) => (
          <div key={w} className="oc-week" role="row">{days.slice(w * 7, w * 7 + 7).map(cell)}</div>
        ))}
      </div>
    );
  } else if (data) {
    body = agendaView();
  }

  return (
    <div className="ops">
      <PageBar
        crumbs={[{ label: t('calendar.title') }]}
        actions={
          <>
            {!narrow && viewSwitch}
            {can('schedule') && (
              <button className="btn btn-ghost" onClick={() => setBlocking(true)}>
                <Icon name="ban" />
                <span>{t('calendar.block')}</span>
              </button>
            )}
          </>
        }
      />

      <div className="oc-toolbar">
        <div className="oc-nav">
          <button className="btn btn-ghost ops-iconbtn" onClick={() => step(-1)} aria-label={t('calendar.prev')} title={t('calendar.prev')}><Icon name="chevronLeft" /></button>
          <button className="btn btn-ghost ops-iconbtn" onClick={() => step(1)} aria-label={t('calendar.next')} title={t('calendar.next')}><Icon name="chevronRight" /></button>
          <button className="btn" onClick={() => setAnchor(DateTime.now().setZone(zone))}>{t('calendar.today')}</button>
          <h2 className="oc-period" aria-live="polite">{title}</h2>
          {paused && <Chip state="on_hold" label={t('calendar.paused')} />}
        </div>
        <div className="oc-tools">
          {data && (
            <span className="oc-meta">
              {t('calendar.pubs', { count: pubCount })}
              {slotCount > 0 && <> · {t('calendar.freeSlots', { count: slotCount })}</>}
              <span title={t('calendar.zoneHint', { brand: brand.name })}> · {zone}</span>
            </span>
          )}
          {networks.length > 1 && (
            <select className="ops-select" aria-label={t('calendar.network')} value={network} onChange={(e) => setNetwork(e.target.value)}>
              <option value="">{t('calendar.allNetworks')}</option>
              {networks.map((n) => <option key={n} value={n}>{NETWORK_LABEL[n] ?? n}</option>)}
            </select>
          )}
          {narrow && viewSwitch}
          {can('schedule') && !narrow && (
            <button className="btn btn-ghost oc-tray-toggle" aria-pressed={trayOpen} onClick={toggleTray} title={trayOpen ? t('calendar.tray.hide') : t('calendar.tray.show')}>
              <Icon name="inbox" />
              <span>{t('calendar.tray.title')}</span>
              {ready.items.length > 0 && <span className="ops-count">{ready.items.length}</span>}
            </button>
          )}
        </div>
      </div>

      {error && <ErrorBox error={error} />}

      <div className="oc-body">
        <div className={`oc-layout ${showTray || narrow ? 'with-tray' : ''}`}>
          <div className="oc-main">
            {body}
            {data && (pubCount > 0 || slotCount > 0) && (
              <div className="oc-legend" aria-label={t('calendar.legend')}>
                <span className="oc-key st-scheduled">{STATE_LABEL.scheduled}</span>
                <span className="oc-key st-published">{STATE_LABEL.published}</span>
                <span className="oc-key st-on_hold">{STATE_LABEL.on_hold}</span>
                <span className="oc-key st-failed">{STATE_LABEL.failed}</span>
                <span className="oc-key oc-key-slot">{t('calendar.legend.slot')}</span>
                <span className="oc-key oc-key-blocked">{t('calendar.legend.blocked')}</span>
                {canMove && !agenda && <span className="oc-hint">{t('calendar.dragHint')}</span>}
              </div>
            )}
          </div>
          {can('schedule') && (showTray || narrow) && (
            <Tray
              items={ready.items}
              loading={ready.loading}
              canDrag={canMove}
              touch={touch || narrow}
              onSchedule={(r) => (paused ? toast(t('calendar.tray.paused'), 'error') : setScheduling({ versionId: r.versionId }))}
            />
          )}
        </div>
      </div>

      {data && (
        <p className="sr-only" aria-live="polite">
          {t('calendar.live', { count: pubCount, from: from.toLocaleString({ day: 'numeric', month: 'long' }), to: to.toLocaleString(DateTime.DATE_FULL) })}
        </p>
      )}
      {blocking && <BlockDialog brandId={brand.id} onClose={() => setBlocking(false)} />}
      {scheduling && <ScheduleFor versionId={scheduling.versionId} when={scheduling.when} brandId={brand.id} zone={zone} onClose={() => setScheduling(null)} />}
    </div>
  );
}
