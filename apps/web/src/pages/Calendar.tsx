import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { DateTime, Info } from 'luxon';
import { useEffect, useMemo, useState, type DragEvent } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api, type Account, type CalendarData } from '../api';
import { PublicationBadges } from '../components/publications';
import { Chip, Dialog, Empty, ErrorBox, errorMessage, Field, Spinner, useToast } from '../components/ui';
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
const CELL_MAX = 4;

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
        <p className="muted">{t('calendar.blockHint')}</p>
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

// ───────────────────────────── the page ─────────────────────────────

export function CalendarPage() {
  const { brand, can } = useSession();
  const qc = useQueryClient();
  const toast = useToast();
  const narrow = useNarrow();
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
  const slots = (data?.slots ?? []).filter((s) => !s.filled && !s.past && !s.blocked && (!network || s.network === network));
  const blocked = new Map((data?.blocked ?? []).map((b) => [b.day, b.reason]));
  const dayOf = (iso: string) => DateTime.fromISO(iso, { zone }).toISODate()!;
  const today = DateTime.now().setZone(zone).toISODate()!;

  // Everything on a day, publications and empty slots together, in the order of the clock.
  const byDay = useMemo(() => {
    const m = new Map<string, Entry[]>();
    const add = (day: string, e: Entry) => m.set(day, [...(m.get(day) ?? []), e]);
    for (const p of pubs) add(dayOf(p.scheduled_at), { kind: 'pub', at: p.scheduled_at, pub: p });
    for (const s of slots) add(s.day, { kind: 'slot', at: s.at, slot: s });
    for (const list of m.values()) list.sort((a, b) => a.at.localeCompare(b.at));
    return m;
  }, [data, network]); // eslint-disable-line react-hooks/exhaustive-deps

  const drop = (day: string, id: string) => {
    const p = data?.publications.find((x) => x.id === id);
    setDropDay(null);
    if (!p || dayOf(p.scheduled_at) === day) return;
    const local = DateTime.fromISO(p.scheduled_at, { zone });
    const next = DateTime.fromISO(day, { zone }).set({ hour: local.hour, minute: local.minute });
    move.mutate({ id, scheduledAt: next.toUTC().toISO()!, day });
  };

  const step = (dir: -1 | 1) => setAnchor(anchor.plus(view === 'month' ? { months: dir } : view === 'week' ? { weeks: dir } : { days: 30 * dir }));
  const title = periodTitle(view, anchor, from, to);
  // On a phone the grid would be unreadable: the same range becomes an agenda (the month only, without its edges).
  const agenda = view === 'list' || narrow;
  const agendaDays = view === 'month' ? days.filter((d) => d.month === anchor.month) : days;
  const inRange = (agenda ? agendaDays : days).map((d) => d.toISODate()!);
  const pubCount = inRange.reduce((n, d) => n + (byDay.get(d)?.filter((e) => e.kind === 'pub').length ?? 0), 0);
  const slotCount = inRange.reduce((n, d) => n + (byDay.get(d)?.filter((e) => e.kind === 'slot').length ?? 0), 0);

  // ── one publication or slot, as a line inside a grid cell ──
  const item = (e: Entry, tall: boolean) => {
    if (e.kind === 'slot') {
      const s = e.slot;
      return (
        <div key={`s-${s.id}-${s.at}`} className="oc-item oc-slot" title={t('calendar.slotTitle', { label: s.label || t('calendar.slot'), account: `${NETWORK_LABEL[s.network] ?? s.network} · ${s.account_name}` })}>
          <span className="oc-time">{hourIn(s.at, zone)}</span>
          <span className="oc-net">{netShort(s.network)}</span>
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
        className={`oc-item ${stateClass(p)} ${draggable ? 'movable' : ''} ${tall ? 'tall' : ''}`}
        draggable={draggable}
        onDragStart={(ev) => {
          ev.dataTransfer.setData('text/plain', p.id);
          ev.dataTransfer.effectAllowed = 'move';
        }}
        title={pubTitle(p)}
      >
        <span className="oc-time">{hourIn(p.scheduled_at, zone)}</span>
        <span className="oc-net">{netShort(p.network)}</span>
        <span className="oc-name">{p.piece_title}</span>
        {tall && <span className="oc-sub">{STATE_LABEL[p.status] ?? p.status} · {p.manual ? t('calendar.byHand') : t('calendar.automatic')}</span>}
      </Link>
    );
  };

  const dropProps = (day: string, isBlocked: boolean) =>
    canMove && !isBlocked
      ? {
          onDragOver: (e: DragEvent) => {
            e.preventDefault();
            e.dataTransfer.dropEffect = 'move';
            if (dropDay !== day) setDropDay(day);
          },
          onDragLeave: (e: DragEvent) => {
            if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDropDay((x) => (x === day ? null : x));
          },
          onDrop: (e: DragEvent) => {
            e.preventDefault();
            drop(day, e.dataTransfer.getData('text/plain'));
          },
        }
      : {};

  const blockedNote = (day: string) => (
    <span className="oc-blocked" title={blocked.get(day) || t('calendar.blocked')}>
      <span className="oc-blocked-text">{blocked.get(day) || t('calendar.blocked')}</span>
      {can('schedule') && (
        <button className="oc-unblock" aria-label={t('calendar.unblock', { day: DateTime.fromISO(day).toLocaleString({ day: 'numeric', month: 'long' }) })} onClick={() => unblock.mutate(day)}>
          ×
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
          <span className="oc-num">{d.day}</span>
          {isBlocked && blockedNote(day)}
        </div>
        <div className="oc-items">
          {shown.map((e) => item(e, week))}
          {hidden > 0 && (
            <button
              className="oc-more"
              aria-label={t('calendar.moreLabel', { count: hidden })}
              onClick={() => {
                go({ view: 'week', anchor: d });
              }}
            >
              {t('calendar.more', { count: hidden })}
            </button>
          )}
        </div>
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
      return <Empty title={t('calendar.empty')}>{t('calendar.emptyHint')}</Empty>;
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
                <span className="oc-aday-num mono">{d.toFormat('dd')}</span>
                <h3>{cap(longDay(d))}</h3>
                {day === today && <span className="oc-today-tag">{t('calendar.today')}</span>}
                {isBlocked && blockedNote(day)}
              </header>
              {entries.length > 0 && (
                <ul className="ops-rows">
                  {entries.map((e) =>
                    e.kind === 'slot' ? (
                      <li key={`s-${e.slot.id}-${e.at}`} className="ops-row ops-row-slot">
                        <span className="ops-row-time">{hourIn(e.at, zone)}</span>
                        <span className="tag">{netShort(e.slot.network)}</span>
                        <div className="ops-row-main">
                          {e.slot.label && <span>{e.slot.label}</span>}
                          <span className={e.slot.label ? 'muted small' : ''}>{NETWORK_LABEL[e.slot.network] ?? e.slot.network} · {e.slot.account_name}</span>
                        </div>
                        <div className="ops-row-side"><span className="ops-slot-chip">{t('calendar.legend.slot')}</span></div>
                      </li>
                    ) : (
                      <li
                        key={e.pub.id}
                        className={`ops-row ${stateClass(e.pub)}`}
                        draggable={canMove && !narrow && (e.pub.status === 'scheduled' || e.pub.status === 'awaiting_reapproval')}
                        onDragStart={(ev) => ev.dataTransfer.setData('text/plain', e.pub.id)}
                      >
                        <span className="ops-row-time">{hourIn(e.at, zone)}</span>
                        <span className="tag">{netShort(e.pub.network)}</span>
                        <div className="ops-row-main">
                          <Link to={`/pieces/${e.pub.piece_id}`} className="ops-row-title">{e.pub.piece_title}</Link>
                          <span className="muted small">
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
              )}
            </section>
          );
        })}
      </div>
    );
  };

  return (
    <div className="ops">
      <div className="page-head">
        <div>
          <h1>{t('calendar.title')}</h1>
          <p className="muted">{t('calendar.subtitle', { zone, brand: brand.name })}</p>
        </div>
        {can('schedule') && <button className="btn" onClick={() => setBlocking(true)}>{t('calendar.block')}</button>}
      </div>

      <div className="oc-toolbar">
        <div className="oc-nav">
          <div className="ops-seg">
            <button onClick={() => step(-1)} aria-label={t('calendar.prev')}>
              <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M10 3 5 8l5 5" /></svg>
            </button>
            <button onClick={() => setAnchor(DateTime.now().setZone(zone))}>{t('calendar.today')}</button>
            <button onClick={() => step(1)} aria-label={t('calendar.next')}>
              <svg viewBox="0 0 16 16" aria-hidden="true"><path d="m6 3 5 5-5 5" /></svg>
            </button>
          </div>
          <div className="oc-period">
            <h2 aria-live="polite">{title}</h2>
            {data && (
              <span className="muted small">
                {t('calendar.pubs', { count: pubCount })}
                {slotCount > 0 && <> · {t('calendar.freeSlots', { count: slotCount })}</>}
              </span>
            )}
          </div>
          {paused && <span className="chip chip-on_hold oc-paused" title={t('calendar.pausedHint')}>{t('calendar.paused')}</span>}
        </div>
        <div className="oc-tools">
          {networks.length > 1 && (
            <select aria-label={t('calendar.network')} value={network} onChange={(e) => setNetwork(e.target.value)}>
              <option value="">{t('calendar.allNetworks')}</option>
              {networks.map((n) => <option key={n} value={n}>{NETWORK_LABEL[n] ?? n}</option>)}
            </select>
          )}
          <div className="ops-seg" role="group" aria-label={t('calendar.viewLabel')}>
            {VIEWS.map((v) => (
              <button key={v} aria-pressed={view === v} onClick={() => setView(v)}>{t(`calendar.view.${v}` as Key)}</button>
            ))}
          </div>
        </div>
      </div>

      {isLoading && <Spinner />}
      {error && <ErrorBox error={error} />}

      {data && !agenda && (
        <div className={`oc-grid ${view === 'week' ? 'week' : 'month'} ${paused ? 'paused' : ''}`} role="grid" aria-label={t('calendar.gridLabel', { period: title })}>
          <div className="oc-week oc-dows" role="row">
            {Info.weekdays('short').map((d) => <div key={d} className="oc-dow-head" role="columnheader">{d}</div>)}
          </div>
          {Array.from({ length: Math.ceil(days.length / 7) }, (_, w) => (
            <div key={w} className="oc-week" role="row">{days.slice(w * 7, w * 7 + 7).map(cell)}</div>
          ))}
        </div>
      )}
      {data && agenda && agendaView()}

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
      {data && (
        <p className="sr-only" aria-live="polite">
          {t('calendar.live', { count: pubCount, from: from.toLocaleString({ day: 'numeric', month: 'long' }), to: to.toLocaleString(DateTime.DATE_FULL) })}
        </p>
      )}
      {blocking && <BlockDialog brandId={brand.id} onClose={() => setBlocking(false)} />}
    </div>
  );
}
