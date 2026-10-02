import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api, type BrandMetrics, type CommonMetrics, type MetricAge, type MetricSnapshot, type MetricsRow } from '../api';
import { Icon } from '../components/icons';
import { PageBar } from '../components/PageBar';
import { Chip, Dialog, ErrorBox, NetMark, Skeleton } from '../components/ui';
import { getLocale, t, type Key } from '../i18n';
import { fmtDateTime, NETWORK_LABEL } from '../lib/format';
import { useSession } from '../lib/session';
import { Thumb } from './Calendar';
import '../styles/ops.css';

const METRICS: (keyof CommonMetrics)[] = ['views', 'reach', 'likes', 'comments', 'shares', 'saves', 'avgWatchSeconds', 'watchMinutes'];
/** Each reading's state as one of the app's state colours. */
const STATUS_CHIP: Record<MetricSnapshot['status'], string> = { pending: 'scheduled', ok: 'approved', unavailable: 'draft', failed: 'failed', expired: 'on_hold' };

const metricLabel = (k: keyof CommonMetrics) => t(`results.metric.${k}` as Key);
const ageLabel = (a: MetricAge) => t(`results.age.${a}` as Key);
const ageShort = (a: MetricAge) => t(`results.ageShort.${a}` as Key);
const statusLabel = (s: MetricSnapshot['status']) => t(`results.status.${s}` as Key);

function fmtMetric(key: keyof CommonMetrics, v: number | undefined): string {
  if (v === undefined) return '—';
  if (key === 'avgWatchSeconds') return t('results.seconds', { n: new Intl.NumberFormat(getLocale(), { minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(v) });
  return new Intl.NumberFormat(getLocale()).format(v);
}

/** The ages at which a post is read, each a small mark in the colour of how that reading went. */
function Readings({ snapshots }: { snapshots: MetricSnapshot[] }) {
  return (
    <span className="rs-reads">
      {snapshots.map((s) => (
        <span key={s.age} className={`rs-read ${s.status}`} title={`${t('results.readingTitle', { age: ageLabel(s.age), status: statusLabel(s.status) })}${s.note ? ` · ${s.note}` : ''}`}>
          {ageShort(s.age)}
        </span>
      ))}
    </span>
  );
}

function Detail({ row, zone, onClose }: { row: MetricsRow; zone: string; onClose: () => void }) {
  const shown = METRICS.filter((k) => row.snapshots.some((s) => s.metrics[k] !== undefined));
  const pub = row.publication;
  return (
    <Dialog title={pub.piece} onClose={onClose} wide>
      <div className="stack">
        <p className="muted" style={{ margin: 0 }}>
          {NETWORK_LABEL[pub.network] ?? pub.network} · {pub.account} · {t('results.published', { date: fmtDateTime(pub.published_at, zone) })}
          {pub.url && <> · <a href={pub.url} target="_blank" rel="noreferrer">{t('results.openPost')}</a></>}
        </p>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>{t('results.col.after')}</th>
                <th>{t('results.col.state')}</th>
                {shown.map((k) => <th key={k} className="num">{metricLabel(k)}</th>)}
              </tr>
            </thead>
            <tbody>
              {row.snapshots.map((s) => (
                <tr key={s.age}>
                  <td style={{ whiteSpace: 'nowrap' }}>{ageLabel(s.age)}</td>
                  <td>
                    <Chip state={STATUS_CHIP[s.status]} label={statusLabel(s.status)} />
                    {s.status === 'ok' && s.taken_at && <div className="muted small">{t('results.readAt', { date: fmtDateTime(s.taken_at, zone) })}</div>}
                    {s.status === 'pending' && <div className="muted small">{t('results.dueAt', { date: fmtDateTime(s.due_at, zone) })}</div>}
                    {s.note && <div className="muted small">{s.note}</div>}
                  </td>
                  {shown.map((k) => <td key={k} className="num">{s.status === 'ok' ? fmtMetric(k, s.metrics[k]) : '—'}</td>)}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="muted small" style={{ margin: 0 }}>{t('results.detailNote')}</p>
      </div>
    </Dialog>
  );
}

function NetworkSection({ summary, rows, zone, onOpen }: {
  summary: BrandMetrics['networks'][number];
  rows: MetricsRow[];
  zone: string;
  onOpen: (r: MetricsRow) => void;
}) {
  const name = NETWORK_LABEL[summary.network] ?? summary.network;
  // Only the numbers this network gave, so a network without saves does not show a column of dashes.
  const shown = METRICS.filter((k) => rows.some((r) => r.latest?.metrics[k] !== undefined));
  // The longest bar in each column is the best post of this network on that number; one post alone gets no bars.
  const max = Object.fromEntries(shown.map((k) => [k, Math.max(0, ...rows.map((r) => r.latest?.metrics[k] ?? 0))])) as Record<string, number>;
  const bars = rows.length > 1;
  // Six numbers or more make a table that needs the whole width: it turns into blocks sooner (see ops.css).
  const headId = `rs-${summary.network}`;
  return (
    <section className="rs-net" aria-labelledby={headId}>
      <header className="rs-net-head">
        <h2 id={headId}><NetMark network={summary.network} />{name}</h2>
        <span className="rs-net-meta">{t('results.posts', { count: summary.posts })} · {t('results.read', { count: summary.read })}</span>
      </header>
      {shown.some((k) => k !== 'avgWatchSeconds') && (
        <div className="rs-kpis" role="group" aria-label={t('results.totals', { network: name })}>
          {shown
            .filter((k) => k !== 'avgWatchSeconds')
            .map((k) => (
              <div key={k} className="rs-kpi">
                <div className="rs-kpi-label">{metricLabel(k)}</div>
                <div className="rs-kpi-value">{fmtMetric(k, summary.totals[k] ?? 0)}</div>
              </div>
            ))}
        </div>
      )}
      <div className="table-wrap">
        <table className={`rs-table ${shown.length >= 6 ? 'rs-wide' : ''}`}>
          <thead>
            <tr>
              <th>{t('results.col.post')}</th>
              <th>{t('results.col.reading')}</th>
              {shown.map((k) => <th key={k} className="num">{metricLabel(k)}</th>)}
              <th><span className="sr-only">{t('results.readings')}</span></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const pub = r.publication;
              return (
                <tr key={pub.id}>
                  <td className="rs-post">
                    <div className="rs-post-in">
                      <Thumb pieceId={pub.piece_id} />
                      <div className="rs-post-text">
                        <Link to={`/pieces/${pub.piece_id}`}>{pub.piece}</Link>
                        <div className="rs-post-meta">{[pub.account, pub.placement, fmtDateTime(pub.published_at, zone)].filter(Boolean).join(' · ')}</div>
                        {pub.visibility === 'private' && <div className="rs-private">{t('results.private')}</div>}
                      </div>
                    </div>
                  </td>
                  <td className="rs-reading">
                    {r.latest ? <span className="rs-latest">{t('results.after', { age: ageLabel(r.latest.age) })}</span> : <span className="muted small">{t('results.notRead')}</span>}
                    <Readings snapshots={r.snapshots} />
                  </td>
                  {shown.map((k) => {
                    const v = r.latest?.metrics[k];
                    return (
                      <td key={k} className="num" data-label={metricLabel(k)}>
                        <span className="rs-cell">
                          {fmtMetric(k, v)}
                          {bars && v !== undefined && max[k]! > 0 && <span className="rs-bar" aria-hidden="true"><i style={{ width: `${Math.max(2, (v / max[k]!) * 100)}%` }} /></span>}
                        </span>
                      </td>
                    );
                  })}
                  <td className="rs-actions">
                    <button className="btn btn-small btn-ghost" onClick={() => onOpen(r)} aria-label={t('results.readingsOf', { title: pub.piece })}>
                      <Icon name="chart" />
                      <span>{t('results.readings')}</span>
                    </button>
                  </td>
                </tr>
              );
            })}
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
  const filtered = !!(network || from || to);
  return (
    <div className="ops rs">
      <PageBar crumbs={[{ label: t('results.title') }]} />
      <div className="rs-filters" role="group" aria-label={t('results.filters')}>
        <select className="ops-select" aria-label={t('results.network')} value={network} onChange={(e) => setNetwork(e.target.value)}>
          <option value="">{t('results.allNetworks')}</option>
          {Object.keys(NETWORK_LABEL).map((k) => <option key={k} value={k}>{NETWORK_LABEL[k]}</option>)}
        </select>
        <div className="rs-range">
          <label>
            <span>{t('results.from')}</span>
            <input type="date" value={from} max={to || undefined} onChange={(e) => setFrom(e.target.value)} />
          </label>
          <span className="rs-range-sep" aria-hidden="true">–</span>
          <label>
            <span>{t('results.to')}</span>
            <input type="date" value={to} min={from || undefined} onChange={(e) => setTo(e.target.value)} />
          </label>
        </div>
        {filtered ? (
          <button className="btn btn-small btn-ghost" onClick={() => { setNetwork(''); setFrom(''); setTo(''); }}>
            <Icon name="x" />
            <span>{t('results.clear')}</span>
          </button>
        ) : (
          <span className="rs-default">{t('results.defaultRange')}</span>
        )}
      </div>
      {error && <ErrorBox error={error} />}
      {!data && !error && (
        <div className="rs-nets" aria-busy="true">
          {[0, 1].map((i) => (
            <section key={i} className="rs-net">
              <header className="rs-net-head"><Skeleton width={160} height={18} /></header>
              <div className="rs-kpis">{[0, 1, 2, 3].map((k) => <div key={k} className="rs-kpi"><Skeleton width={70} height={10} /><Skeleton width={90} height={22} style={{ marginTop: 8 }} /></div>)}</div>
              <div style={{ padding: 16 }}><Skeleton height={40} /></div>
            </section>
          ))}
        </div>
      )}
      {data && data.networks.length === 0 && (
        <div className="rs-empty">
          <span className="rs-empty-icon"><Icon name="chart" /></span>
          <strong>{t('results.empty')}</strong>
          <p>{t('results.emptyHint')}</p>
        </div>
      )}
      {data && data.networks.length > 0 && (
        <>
          <div className="rs-nets">
            {data.networks.map((n) => (
              <NetworkSection key={n.network} summary={n} rows={data.rows.filter((r) => r.publication.network === n.network)} zone={brand.timezone} onOpen={setOpen} />
            ))}
          </div>
          <p className="rs-note"><Icon name="globe" />{t('results.note')}</p>
        </>
      )}
      {open && <Detail row={open} zone={brand.timezone} onClose={() => setOpen(null)} />}
    </div>
  );
}
