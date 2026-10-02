import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api, type BrandMetrics, type CommonMetrics, type MetricAge, type MetricSnapshot, type MetricsRow } from '../api';
import { Dialog, Empty, ErrorBox, Field, Spinner } from '../components/ui';
import { fmtDateTime, NETWORK_LABEL } from '../lib/format';
import { useSession } from '../lib/session';

const AGE_LABEL: Record<MetricAge, string> = { '1h': '1 hour', '6h': '6 hours', '22h': '22 hours', '1d': '1 day', '7d': '7 days', '28d': '28 days' };
const STATUS_LABEL: Record<MetricSnapshot['status'], string> = { pending: 'Waiting', ok: 'Read', unavailable: 'Not available', failed: 'Failed', expired: 'Missed' };
const STATUS_CLASS: Record<MetricSnapshot['status'], string> = { pending: 'chip-scheduled', ok: 'chip-approved', unavailable: '', failed: 'chip-failed', expired: 'chip-on_hold' };

const COLUMNS: { key: keyof CommonMetrics; label: string }[] = [
  { key: 'views', label: 'Views' },
  { key: 'reach', label: 'Reach' },
  { key: 'likes', label: 'Likes' },
  { key: 'comments', label: 'Comments' },
  { key: 'shares', label: 'Shares' },
  { key: 'saves', label: 'Saves' },
  { key: 'avgWatchSeconds', label: 'Avg watch' },
];

const cell = (key: keyof CommonMetrics, v: number | undefined) =>
  v === undefined ? '—' : key === 'avgWatchSeconds' ? `${v.toFixed(1)} s` : v.toLocaleString();

function Readings({ snapshots }: { snapshots: MetricSnapshot[] }) {
  return (
    <div className="row" style={{ gap: '.25rem' }}>
      {snapshots.map((s) => (
        <span key={s.age} className={`chip ${STATUS_CLASS[s.status]}`} title={`${AGE_LABEL[s.age]}: ${STATUS_LABEL[s.status]}${s.note ? ` · ${s.note}` : ''}`}>{s.age}</span>
      ))}
    </div>
  );
}

function Detail({ row, zone, onClose }: { row: MetricsRow; zone: string; onClose: () => void }) {
  const shown = COLUMNS.filter((c) => row.snapshots.some((s) => s.metrics[c.key] !== undefined));
  return (
    <Dialog title={row.publication.piece} onClose={onClose} wide>
      <div className="stack">
        <p className="muted" style={{ margin: 0 }}>
          {NETWORK_LABEL[row.publication.network] ?? row.publication.network} · {row.publication.account} · published {fmtDateTime(row.publication.published_at, zone)}
          {row.publication.url && <> · <a href={row.publication.url} target="_blank" rel="noreferrer">Open post</a></>}
        </p>
        <div className="table-wrap">
          <table>
            <thead><tr><th>After</th><th>State</th>{shown.map((c) => <th key={c.key} className="num">{c.label}</th>)}</tr></thead>
            <tbody>
              {row.snapshots.map((s) => (
                <tr key={s.age}>
                  <td>{AGE_LABEL[s.age]}</td>
                  <td>
                    <span className={`chip ${STATUS_CLASS[s.status]}`}>{STATUS_LABEL[s.status]}</span>
                    <div className="muted small">{s.status === 'ok' && s.taken_at ? `Read ${fmtDateTime(s.taken_at, zone)}` : s.status === 'pending' ? `Due ${fmtDateTime(s.due_at, zone)}` : ''}</div>
                    {s.note && <div className="muted small">{s.note}</div>}
                  </td>
                  {shown.map((c) => <td key={c.key} className="num">{s.status === 'ok' ? cell(c.key, s.metrics[c.key]) : '—'}</td>)}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="muted small">Each network counts things its own way, and some numbers are not offered for some kinds of post. A dash means the network gave no number.</p>
      </div>
    </Dialog>
  );
}

function NetworkSection({ network, summary, rows, zone, onOpen }: {
  network: string;
  summary: BrandMetrics['networks'][number];
  rows: MetricsRow[];
  zone: string;
  onOpen: (r: MetricsRow) => void;
}) {
  // Only the columns this network gave a number for, so a network without saves does not show a column of dashes.
  const shown = COLUMNS.filter((c) => rows.some((r) => r.latest?.metrics[c.key] !== undefined));
  return (
    <section className="card" aria-label={NETWORK_LABEL[network] ?? network}>
      <div className="card-head">
        <h2>{NETWORK_LABEL[network] ?? network}</h2>
        <span className="muted small">{summary.posts} post{summary.posts === 1 ? '' : 's'} · {summary.read} with a reading</span>
      </div>
      {shown.length > 0 && (
        <div className="row" style={{ gap: '1.25rem', marginBottom: '.75rem' }} aria-label="Totals">
          {shown.filter((c) => c.key !== 'avgWatchSeconds').map((c) => (
            <div key={c.key}>
              <div className="muted small">{c.label}</div>
              <div style={{ fontSize: '1.25rem', fontWeight: 650 }}>{cell(c.key, summary.totals[c.key] ?? 0)}</div>
            </div>
          ))}
        </div>
      )}
      <div className="table-wrap">
        <table>
          <thead>
            <tr><th>Post</th><th>Reading</th>{shown.map((c) => <th key={c.key} className="num">{c.label}</th>)}<th /></tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.publication.id}>
                <td>
                  <Link to={`/pieces/${r.publication.piece_id}`}>{r.publication.piece}</Link>
                  <div className="muted small">{r.publication.account}{r.publication.placement ? ` · ${r.publication.placement}` : ''} · {fmtDateTime(r.publication.published_at, zone)}</div>
                  {r.publication.visibility === 'private' && <div className="small" style={{ color: 'var(--warn)' }}>Private: numbers are for a post only the account can see</div>}
                </td>
                <td>
                  {r.latest ? <span className="chip chip-approved">After {AGE_LABEL[r.latest.age]}</span> : <span className="muted small">Not read yet</span>}
                  <div style={{ marginTop: 4 }}><Readings snapshots={r.snapshots} /></div>
                </td>
                {shown.map((c) => <td key={c.key} className="num">{cell(c.key, r.latest?.metrics[c.key])}</td>)}
                <td><button className="btn btn-small" onClick={() => onOpen(r)}>Readings</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

export function ResultsPage() {
  const { brand } = useSession();
  const [network, setNetwork] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [open, setOpen] = useState<MetricsRow | null>(null);
  const query = new URLSearchParams();
  if (network) query.set('network', network);
  if (from) query.set('from', from);
  if (to) query.set('to', to);
  const { data, error } = useQuery({
    queryKey: ['metrics', brand.id, network, from, to],
    placeholderData: keepPreviousData,
    queryFn: () => api.get<BrandMetrics>(`/api/brands/${brand.id}/metrics?${query.toString()}`),
  });
  const networks = data ? data.networks.map((n) => n.network) : [];
  return (
    <>
      <div className="page-head"><div><h1>Results</h1><p className="muted">How the posts the app published did, as each network reports it. Last 90 days unless you pick dates.</p></div></div>
      <div className="row card" style={{ alignItems: 'flex-start' }}>
        <div><Field label="Network"><select value={network} onChange={(e) => setNetwork(e.target.value)}><option value="">All networks</option>{Object.entries(NETWORK_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></Field></div>
        <div><Field label="From"><input type="date" value={from} max={to || undefined} onChange={(e) => setFrom(e.target.value)} /></Field></div>
        <div><Field label="To"><input type="date" value={to} min={from || undefined} onChange={(e) => setTo(e.target.value)} /></Field></div>
        {(network || from || to) && <button className="btn" onClick={() => { setNetwork(''); setFrom(''); setTo(''); }}>Clear</button>}
      </div>
      {error && <ErrorBox error={error} />}
      {!data && !error && <Spinner />}
      {data && networks.length === 0 && (
        <Empty title="Nothing to show for this period">
          Readings are taken 1 hour, 1 day, 7 days and 28 days after the app publishes a post (stories sooner, because their numbers disappear after a day). Posts published by hand have none.
        </Empty>
      )}
      {data && networks.length > 0 && (
        <div className="stack">
          <p className="muted small" style={{ margin: 0 }}>Totals are per network, from the latest reading of each post. Networks are never added together: a “view” does not mean the same on each.</p>
          {data.networks.map((n) => (
            <NetworkSection key={n.network} network={n.network} summary={n} rows={data.rows.filter((r) => r.publication.network === n.network)} zone={brand.timezone} onOpen={setOpen} />
          ))}
        </div>
      )}
      {open && <Detail row={open} zone={brand.timezone} onClose={() => setOpen(null)} />}
    </>
  );
}
