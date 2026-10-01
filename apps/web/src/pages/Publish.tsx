import { useQuery } from '@tanstack/react-query';
import { DateTime } from 'luxon';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api, type CalendarData } from '../api';
import { MarkPublishedDialog, PackDialog } from '../components/publications';
import { Chip, Empty, ErrorBox, Spinner } from '../components/ui';
import { fmtDateTime, NETWORK_LABEL } from '../lib/format';
import { useSession } from '../lib/session';

interface Due {
  id: string;
  scheduled_at: string;
  piece_id: string;
  piece_title: string;
  network: string;
  account_name: string;
  waiting_for_dependency: boolean;
}

export function PublishPage() {
  const { brand, can } = useSession();
  const zone = brand.timezone;
  const [pack, setPack] = useState<string | null>(null);
  const [mark, setMark] = useState<string | null>(null);
  const from = DateTime.now().setZone(zone).toISODate()!;
  const to = DateTime.now().setZone(zone).plus({ days: 14 }).toISODate()!;
  const due = useQuery({ queryKey: ['due', brand.id], queryFn: () => api.get<Due[]>(`/api/brands/${brand.id}/publications/due`), refetchInterval: 60_000 });
  const cal = useQuery({ queryKey: ['calendar', brand.id, from, to], queryFn: () => api.get<CalendarData>(`/api/brands/${brand.id}/calendar?from=${from}&to=${to}`) });
  const upcoming = (cal.data?.publications ?? []).filter((p) => ['scheduled', 'awaiting_reapproval', 'on_hold'].includes(p.status) && new Date(p.scheduled_at) > new Date());
  const empty = (cal.data?.slots ?? []).filter((s) => !s.filled && !s.past && !s.blocked);

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Publish</h1>
          <p className="muted">For now a person posts to each network and records it here. The app has everything ready: files, text and first comment.</p>
        </div>
      </div>

      <section className="card" aria-label="Due now">
        <div className="card-head"><h2>Due now</h2></div>
        {due.isLoading && <Spinner />}
        {due.error && <ErrorBox error={due.error} />}
        {brand.paused && <div className="notice notice-warn">This brand is paused, so nothing is listed as due.</div>}
        {due.data && due.data.length === 0 && !brand.paused && <Empty title="Nothing to publish right now" />}
        {due.data?.map((d) => (
          <div key={d.id} className="version-row">
            <strong className="mono">{DateTime.fromISO(d.scheduled_at, { zone }).toFormat('ccc d LLL HH:mm')}</strong>
            <Link to={`/pieces/${d.piece_id}`} className="grow">{d.piece_title}</Link>
            <span className="muted small">{NETWORK_LABEL[d.network] ?? d.network} · {d.account_name}</span>
            {d.waiting_for_dependency && <span className="chip chip-on_hold">waits for another post</span>}
            {can('schedule') && <button className="btn btn-primary btn-small" disabled={d.waiting_for_dependency} onClick={() => setPack(d.id)}>Publish…</button>}
          </div>
        ))}
      </section>

      <section className="card" aria-label="Coming up">
        <div className="card-head"><h2>Coming up · next 14 days</h2></div>
        {cal.isLoading && <Spinner />}
        {cal.data && upcoming.length === 0 && <p className="muted">Nothing scheduled.</p>}
        {upcoming.map((p) => (
          <div key={p.id} className="version-row">
            <span className="mono">{fmtDateTime(p.scheduled_at, zone)}</span>
            <Link to={`/pieces/${p.piece_id}`} className="grow">{p.piece_title}</Link>
            <span className="muted small">{NETWORK_LABEL[p.network] ?? p.network} · {p.account_name}</span>
            <Chip state={p.status} />
          </div>
        ))}
      </section>

      {empty.length > 0 && (
        <section className="card" aria-label="Slots that need content">
          <div className="card-head"><h2>Slots that need content</h2></div>
          {empty.map((s) => (
            <div key={s.id + s.at} className="version-row">
              <span className="mono">{fmtDateTime(s.at, zone)}</span>
              <span className="grow">{s.label || 'Open slot'}</span>
              <span className="muted small">{NETWORK_LABEL[s.network] ?? s.network} · {s.account_name}</span>
            </div>
          ))}
        </section>
      )}

      {pack && <PackDialog pubId={pack} zone={zone} onClose={() => setPack(null)} onPublished={() => { setMark(pack); setPack(null); }} />}
      {mark && <MarkPublishedDialog pubId={mark} onClose={() => setMark(null)} />}
    </>
  );
}
