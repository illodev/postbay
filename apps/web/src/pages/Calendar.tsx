import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { DateTime } from 'luxon';
import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, type Account, type CalendarData } from '../api';
import { PublicationBadges } from '../components/publications';
import { Chip, Dialog, ErrorBox, errorMessage, Field, Spinner, useToast } from '../components/ui';
import { fmtDateTime, NETWORK_LABEL } from '../lib/format';
import { useSession } from '../lib/session';

type View = 'month' | 'week' | 'list';
const DOW = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

function rangeFor(view: View, anchor: DateTime): { from: DateTime; to: DateTime } {
  if (view === 'week') return { from: anchor.startOf('week'), to: anchor.endOf('week') };
  if (view === 'list') return { from: anchor.startOf('day'), to: anchor.plus({ days: 29 }).startOf('day') };
  return { from: anchor.startOf('month').startOf('week'), to: anchor.endOf('month').endOf('week') };
}

function BlockDialog({ brandId, onClose }: { brandId: string; onClose: () => void }) {
  const qc = useQueryClient();
  const [day, setDay] = useState('');
  const [reason, setReason] = useState('');
  const save = useMutation({
    mutationFn: () => api.post(`/api/brands/${brandId}/blocked-dates`, { day, reason }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['calendar'] }); onClose(); },
  });
  return (
    <Dialog title="Block a date" onClose={onClose}>
      <form className="stack" onSubmit={(e) => { e.preventDefault(); save.mutate(); }}>
        <p className="muted">Nothing can be scheduled on a blocked date (a bank holiday, a crisis, a quiet day).</p>
        <Field label="Date"><input type="date" required value={day} onChange={(e) => setDay(e.target.value)} /></Field>
        <Field label="Reason (optional)"><input type="text" maxLength={200} value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
        {save.error && <ErrorBox error={save.error} />}
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" disabled={!day || save.isPending}>Block date</button>
        </div>
      </form>
    </Dialog>
  );
}

export function CalendarPage() {
  const { brand, can } = useSession();
  const qc = useQueryClient();
  const toast = useToast();
  const [view, setView] = useState<View>('month');
  const [anchor, setAnchor] = useState(() => DateTime.now().setZone(brand.timezone));
  const [network, setNetwork] = useState('');
  const [dropDay, setDropDay] = useState<string | null>(null);
  const [blocking, setBlocking] = useState(false);
  const zone = brand.timezone;
  const { from, to } = rangeFor(view, anchor);
  const fromS = from.toISODate()!, toS = to.toISODate()!;

  const { data, error, isLoading } = useQuery({
    queryKey: ['calendar', brand.id, fromS, toS],
    queryFn: () => api.get<CalendarData>(`/api/brands/${brand.id}/calendar?from=${fromS}&to=${toS}`),
  });
  const { data: accounts } = useQuery({ queryKey: ['accounts', brand.id], queryFn: () => api.get<Account[]>(`/api/brands/${brand.id}/accounts`) });
  const networks = [...new Set((accounts ?? []).map((a) => a.network))];

  const move = useMutation({
    mutationFn: ({ id, scheduledAt }: { id: string; scheduledAt: string }) => api.patch(`/api/publications/${id}`, { scheduledAt }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['calendar'] }); qc.invalidateQueries({ queryKey: ['piece'] }); toast('Moved'); },
    onError: (e) => toast(errorMessage(e), 'error'),
  });
  const unblock = useMutation({
    mutationFn: (day: string) => api.del(`/api/brands/${brand.id}/blocked-dates/${day}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['calendar'] }),
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

  const drop = (day: string, id: string) => {
    const p = data?.publications.find((x) => x.id === id);
    setDropDay(null);
    if (!p || dayOf(p.scheduled_at) === day) return;
    const local = DateTime.fromISO(p.scheduled_at, { zone });
    const next = DateTime.fromISO(day, { zone }).set({ hour: local.hour, minute: local.minute });
    move.mutate({ id, scheduledAt: next.toUTC().toISO()! });
  };

  const step = (dir: -1 | 1) => setAnchor(anchor.plus(view === 'month' ? { months: dir } : view === 'week' ? { weeks: dir } : { days: 30 * dir }));
  const title = view === 'month' ? anchor.toFormat('LLLL yyyy') : `${from.toFormat('d LLL')} – ${to.toFormat('d LLL yyyy')}`;

  const cell = (d: DateTime) => {
    const day = d.toISODate()!;
    const dayPubs = pubs.filter((p) => dayOf(p.scheduled_at) === day);
    const daySlots = slots.filter((s) => s.day === day);
    const reason = blocked.get(day);
    const isBlocked = blocked.has(day);
    return (
      <div
        key={day}
        className={`cal-day ${view === 'month' && d.month !== anchor.month ? 'out' : ''} ${day === today ? 'today' : ''} ${isBlocked ? 'blocked' : ''} ${dropDay === day ? 'drop' : ''}`}
        onDragOver={(e) => { if (can('schedule') && !isBlocked) { e.preventDefault(); setDropDay(day); } }}
        onDragLeave={() => setDropDay((x) => (x === day ? null : x))}
        onDrop={(e) => { e.preventDefault(); drop(day, e.dataTransfer.getData('text/plain')); }}
        aria-label={`${d.toFormat('cccc d LLLL')}${isBlocked ? ', blocked' : ''}`}
      >
        <div className="row-between">
          <span className="cal-num">{d.day}</span>
          {isBlocked && (
            <span className="small muted" title={reason || 'Blocked'}>
              Blocked{can('schedule') && <button className="icon-btn" style={{ fontSize: '1rem', padding: 0 }} aria-label={`Unblock ${day}`} onClick={() => unblock.mutate(day)}>×</button>}
            </span>
          )}
        </div>
        {dayPubs.map((p) => {
          const draggable = can('schedule') && (p.status === 'scheduled' || p.status === 'awaiting_reapproval');
          return (
            <Link
              key={p.id}
              to={`/pieces/${p.piece_id}`}
              className={`cal-item ${p.status}`}
              draggable={draggable}
              onDragStart={(e) => e.dataTransfer.setData('text/plain', p.id)}
              title={`${p.piece_title} · ${NETWORK_LABEL[p.network] ?? p.network} · ${p.status}${p.manual ? ' · by hand' : ' · automatic'}${p.last_error ? ` · ${p.last_error}` : ''}`}
            >
              <span className="t">{DateTime.fromISO(p.scheduled_at, { zone }).toFormat('HH:mm')} </span>
              {!p.manual && <span className="auto-dot" aria-label="Automatic" title="Published by the app">⚙ </span>}
              {p.piece_title}
            </Link>
          );
        })}
        {daySlots.map((s) => (
          <div key={s.id + s.at} className="cal-slot" title={`Empty slot: ${s.label || s.account_name}`}>
            {DateTime.fromISO(s.at, { zone }).toFormat('HH:mm')} {s.label || NETWORK_LABEL[s.network]}
          </div>
        ))}
      </div>
    );
  };

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Calendar</h1>
          <p className="muted">Times are in {zone}, the time zone of {brand.name}.</p>
        </div>
        {can('schedule') && <button className="btn" onClick={() => setBlocking(true)}>Block a date</button>}
      </div>
      <div className="row-between" style={{ marginBottom: '.75rem' }}>
        <div className="row">
          <button className="btn" onClick={() => step(-1)} aria-label="Previous">‹</button>
          <button className="btn" onClick={() => setAnchor(DateTime.now().setZone(zone))}>Today</button>
          <button className="btn" onClick={() => step(1)} aria-label="Next">›</button>
          <strong style={{ marginLeft: '.5rem' }}>{title}</strong>
        </div>
        <div className="row">
          <select aria-label="Network" value={network} onChange={(e) => setNetwork(e.target.value)} style={{ width: 'auto' }}>
            <option value="">All networks</option>
            {networks.map((n) => <option key={n} value={n}>{NETWORK_LABEL[n] ?? n}</option>)}
          </select>
          {(['month', 'week', 'list'] as View[]).map((v) => (
            <button key={v} className="pill" aria-pressed={view === v} onClick={() => setView(v)}>{v[0]!.toUpperCase() + v.slice(1)}</button>
          ))}
        </div>
      </div>
      {isLoading && <Spinner />}
      {error && <ErrorBox error={error} />}
      {data && view !== 'list' && (
        <>
          <div className="cal-grid" role="grid" aria-label="Calendar">
            {DOW.map((d) => <div key={d} className="cal-dow">{d}</div>)}
            {days.map(cell)}
          </div>
          {can('schedule') && <p className="muted small" style={{ marginTop: '.5rem' }}>Drag a scheduled post to another day to move it; it keeps its local time. Dashed boxes are empty slots.</p>}
        </>
      )}
      {data && view === 'list' && (
        <div className="stack">
          {days.map((d) => {
            const day = d.toISODate()!;
            const dayPubs = pubs.filter((p) => dayOf(p.scheduled_at) === day);
            const daySlots = slots.filter((s) => s.day === day);
            if (!dayPubs.length && !daySlots.length && !blocked.has(day)) return null;
            return (
              <div key={day} className="card">
                <h3>{d.toFormat('cccc d LLLL')}{blocked.has(day) && <span className="muted"> · blocked {blocked.get(day) ? `(${blocked.get(day)})` : ''}</span>}</h3>
                {dayPubs.map((p) => (
                  <div key={p.id} className="version-row">
                    <span className="mono">{DateTime.fromISO(p.scheduled_at, { zone }).toFormat('HH:mm')}</span>
                    <Link to={`/pieces/${p.piece_id}`} className="grow">{p.piece_title}</Link>
                    <span className="muted small">{NETWORK_LABEL[p.network] ?? p.network} · {p.account_name}</span>
                    <Chip state={p.status} />
                    <PublicationBadges pub={p} />
                  </div>
                ))}
                {daySlots.map((s) => (
                  <div key={s.id + s.at} className="version-row muted">
                    <span className="mono">{DateTime.fromISO(s.at, { zone }).toFormat('HH:mm')}</span>
                    <span className="grow">Empty slot · {s.label || NETWORK_LABEL[s.network]}</span>
                    <span className="small">{s.account_name}</span>
                  </div>
                ))}
              </div>
            );
          })}
          {pubs.length === 0 && slots.length === 0 && <p className="muted">Nothing in the next 30 days.</p>}
        </div>
      )}
      {data && (
        <p className="sr-only" aria-live="polite">{pubs.length} publications between {fmtDateTime(from.toISO()!, zone)} and {fmtDateTime(to.toISO()!, zone)}</p>
      )}
      {blocking && <BlockDialog brandId={brand.id} onClose={() => setBlocking(false)} />}
    </>
  );
}
