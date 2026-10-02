import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { DateTime } from 'luxon';
import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { api, type CalendarData, type PieceDetail } from '../api';
import { AttemptsDialog, PublicationBadges, PublicationNote, RetryDialog } from '../components/publications';
import { Chip, CopyButton, Empty, ErrorBox, errorMessage, Field, Spinner, useToast } from '../components/ui';
import { t, tMaybe } from '../i18n';
import { fmtBytes, fmtShort, NETWORK_LABEL } from '../lib/format';
import { useSession } from '../lib/session';
import { hourIn, netShort, stateClass } from './Calendar';
import '../styles/ops.css';

interface Due {
  id: string;
  scheduled_at: string;
  text: string;
  piece_id: string;
  piece_title: string;
  network: string;
  account_name: string;
  waiting_for_dependency: boolean;
}

/** What a person needs to publish by hand: the text, the first comment and the files, with download links. */
interface Pack {
  id: string;
  status: string;
  text: string;
  first_comment: string;
  files: { kind: string; position: number; name: string; mime: string; bytes: number; url: string }[];
}

/** Everything a publication changes on screen once it moves. */
const KEYS = ['calendar', 'due', 'due-count', 'piece', 'pieces'];

/** A day and an hour in the brand's zone, short enough for a monospaced column. */
const whenIn = (iso: string, zone: string) => DateTime.fromISO(iso, { zone }).toFormat('ccc d LLL · HH:mm');

function fileLabel(kind: string, position: number): string {
  if (kind === 'image') return t('publish.file.image', { n: position + 1 });
  return tMaybe(`publish.file.${kind}`, kind);
}

/** The preview of the exact version being published; while the piece loads, nothing, and if that fails, the piece's latest. */
function Preview({ pieceId, pubId }: { pieceId: string; pubId: string }) {
  const piece = useQuery({ queryKey: ['piece', pieceId], queryFn: () => api.get<PieceDetail>(`/api/pieces/${pieceId}`) });
  const [failed, setFailed] = useState(false);
  const pub = piece.data?.publications.find((p) => p.id === pubId);
  const format = piece.data?.variants.find((v) => v.id === pub?.variant_id)?.format;
  const src = pub ? `/api/versions/${pub.version_id}/thumb?w=480` : piece.isFetched ? `/api/pieces/${pieceId}/thumb?w=480` : null;
  return (
    <div className="pt-media">
      {src && !failed ? (
        <img src={src} alt={t('publish.preview')} loading="lazy" onError={() => setFailed(true)} />
      ) : (
        <span className="ph">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><path d="M4 5h16v14H4zM4 15l4-4 4 4 3-3 5 5" /></svg>
          {failed || piece.isFetched ? t('publish.noPreview') : t('common.loading')}
        </span>
      )}
      {format && <span className="ov ov-l ov-top">{format}</span>}
    </div>
  );
}

function DueCard({ due, zone, canMark }: { due: Due; zone: string; canMark: boolean }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [url, setUrl] = useState('');
  const pack = useQuery({ queryKey: ['pack', due.id], queryFn: () => api.get<Pack>(`/api/publications/${due.id}/pack`) });
  const mark = useMutation({
    mutationFn: () => api.post(`/api/publications/${due.id}/mark-published`, url.trim() ? { url: url.trim() } : {}),
    onSuccess: () => {
      for (const key of KEYS) qc.invalidateQueries({ queryKey: [key] });
      toast(t('publish.marked'));
    },
    onError: (e) => toast(errorMessage(e), 'error'),
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    mark.mutate();
  };
  const text = pack.data?.text ?? due.text;
  const titleId = `due-${due.id}`;
  return (
    <article className="pt-card" aria-labelledby={titleId}>
      <Preview pieceId={due.piece_id} pubId={due.id} />
      <div className="pt-body">
        <header className="pt-head">
          <div>
            <div className="pt-where">
              <span className="tag">{netShort(due.network)}</span>
              <span>{NETWORK_LABEL[due.network] ?? due.network} · {due.account_name}</span>
            </div>
            <h2 id={titleId}><Link to={`/pieces/${due.piece_id}`}>{due.piece_title}</Link></h2>
          </div>
          <div className="pt-when">
            <span className="mono">{hourIn(due.scheduled_at, zone)}</span>
            <span className="muted small">{fmtShort(due.scheduled_at)}</span>
          </div>
        </header>

        {due.waiting_for_dependency && <div className="notice notice-warn" style={{ margin: 0 }}>{t('publish.waits')}</div>}

        <section>
          <div className="pt-block-head">
            <h3>{t('publish.text')}</h3>
            {text && <CopyButton text={text} />}
          </div>
          <div className="pt-text">{text || <span className="muted">{t('publish.noText')}</span>}</div>
        </section>

        {pack.data?.first_comment && (
          <section>
            <div className="pt-block-head">
              <h3>{t('publish.firstComment')}</h3>
              <CopyButton text={pack.data.first_comment} />
            </div>
            <div className="pt-text">{pack.data.first_comment}</div>
          </section>
        )}

        <section>
          <div className="pt-block-head">
            <h3>{t('publish.files')}</h3>
            {pack.data && pack.data.files.length > 0 && <span className="tag">{pack.data.files.length}</span>}
          </div>
          {pack.isLoading && <p className="muted small">{t('publish.loadingPack')}</p>}
          {pack.error && <ErrorBox error={pack.error} />}
          {pack.data && pack.data.files.length === 0 && <p className="muted small">{t('publish.noFiles')}</p>}
          {pack.data && pack.data.files.length > 0 && (
            <ul className="pt-files">
              {pack.data.files.map((f) => (
                <li key={`${f.kind}-${f.position}`} className="pt-file">
                  <span className="pt-file-kind">{fileLabel(f.kind, f.position)}</span>
                  <span className="pt-file-name" title={f.name}>{f.name}</span>
                  <span className="pt-file-size">{fmtBytes(f.bytes)}</span>
                  <a className="btn btn-small" href={f.url} download={f.name} aria-label={t('publish.downloadFile', { name: f.name })}>{t('common.download')}</a>
                </li>
              ))}
            </ul>
          )}
        </section>

        {canMark ? (
          <form className="pt-mark" onSubmit={submit}>
            <Field label={t('publish.link')}>
              <input type="url" inputMode="url" placeholder={t('publish.linkPlaceholder')} value={url} onChange={(e) => setUrl(e.target.value)} />
            </Field>
            <button className="btn btn-primary" disabled={mark.isPending || due.waiting_for_dependency}>{t('publish.mark')}</button>
          </form>
        ) : (
          <p className="muted small pt-mark">{t('publish.noPermission')}</p>
        )}
      </div>
    </article>
  );
}

export function PublishPage() {
  const { brand, can } = useSession();
  const zone = brand.timezone;
  const [attempts, setAttempts] = useState<string | null>(null);
  const [retry, setRetry] = useState<CalendarData['publications'][number] | null>(null);
  const qc = useQueryClient();
  const toast = useToast();
  const from = DateTime.now().setZone(zone).minus({ days: 7 }).toISODate()!;
  const to = DateTime.now().setZone(zone).plus({ days: 14 }).toISODate()!;
  const due = useQuery({ queryKey: ['due', brand.id], queryFn: () => api.get<Due[]>(`/api/brands/${brand.id}/publications/due`), refetchInterval: 60_000 });
  const cal = useQuery({ queryKey: ['calendar', brand.id, from, to], queryFn: () => api.get<CalendarData>(`/api/brands/${brand.id}/calendar?from=${from}&to=${to}`) });
  const act = useMutation({
    mutationFn: ({ id, action }: { id: string; action: 'hand-over' | 'recheck' }) => api.post(`/api/publications/${id}/${action}`),
    onSuccess: (_r, v) => {
      for (const key of KEYS) qc.invalidateQueries({ queryKey: [key] });
      toast(v.action === 'hand-over' ? t('publish.handedOver') : t('publish.rechecking'));
    },
    onError: (e) => toast(errorMessage(e), 'error'),
  });
  const all = cal.data?.publications ?? [];
  // Posts the app sends by itself that went wrong, or that went out but are not public.
  const attention = all.filter((p) => !p.manual && (p.status === 'failed' || (p.status === 'published' && p.visibility !== null && p.visibility !== 'public')));
  const open = ['scheduled', 'awaiting_reapproval', 'on_hold', 'preparing', 'ready', 'publishing'];
  // A manual post whose hour has passed is in "Due now"; an automatic one is still the app's to send.
  const upcoming = all.filter((p) => open.includes(p.status) && (!p.manual || new Date(p.scheduled_at) > new Date()));
  const empty = (cal.data?.slots ?? []).filter((s) => !s.filled && !s.past && !s.blocked);

  return (
    <div className="ops">
      <div className="page-head">
        <div>
          <h1>{t('publish.title')}</h1>
          <p className="muted">{t('publish.subtitle')}</p>
        </div>
      </div>

      <section className="pt-section" aria-labelledby="pt-due">
        <div className="pt-section-head">
          <h2 id="pt-due">{t('publish.due')}</h2>
          {due.data && due.data.length > 0 && <span className="tag">{due.data.length}</span>}
          <p className="muted small">{t('publish.dueHint')}</p>
        </div>
        {due.isLoading && <Spinner />}
        {due.error && <ErrorBox error={due.error} />}
        {brand.paused && <div className="notice notice-warn">{t('publish.paused')}</div>}
        {due.data && due.data.length === 0 && !brand.paused && <Empty title={t('publish.dueEmpty')}>{t('publish.dueEmptyHint')}</Empty>}
        {due.data && due.data.length > 0 && (
          <div className="pt-due">
            {due.data.map((d) => <DueCard key={d.id} due={d} zone={zone} canMark={can('schedule')} />)}
          </div>
        )}
      </section>

      {attention.length > 0 && (
        <section className="pt-section pt-attn" aria-labelledby="pt-attn">
          <div className="pt-section-head">
            <h2 id="pt-attn">{t('publish.attention')}</h2>
            <span className="tag">{attention.length}</span>
            <p className="muted small">{t('publish.attentionHint')}</p>
          </div>
          <ul className="ops-rows pt-list">
            {attention.map((p) => (
              <li key={p.id} className={`ops-row ${stateClass(p)}`}>
                <span className="ops-row-time">{whenIn(p.scheduled_at, zone)}</span>
                <span className="tag">{netShort(p.network)}</span>
                <div className="ops-row-main">
                  <Link to={`/pieces/${p.piece_id}`} className="ops-row-title">{p.piece_title}</Link>
                  <span className="muted small">{NETWORK_LABEL[p.network] ?? p.network} · {p.account_name}</span>
                  <PublicationNote pub={p} />
                </div>
                <div className="ops-row-side">
                  <Chip state={p.status} />
                  <button className="btn btn-small" onClick={() => setAttempts(p.id)}>{t('publish.history')}</button>
                  {can('schedule') && p.status === 'failed' && (
                    <>
                      <button className="btn btn-small" onClick={() => confirm(t('publish.handOverConfirm')) && act.mutate({ id: p.id, action: 'hand-over' })}>{t('publish.handOver')}</button>
                      <button className="btn btn-small btn-primary" onClick={() => setRetry(p)}>{t('publish.retry')}</button>
                    </>
                  )}
                  {can('schedule') && p.status === 'published' && p.visibility === 'private' && (
                    <button className="btn btn-small" onClick={() => act.mutate({ id: p.id, action: 'recheck' })}>{t('publish.recheck')}</button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="pt-section pt-upcoming" aria-labelledby="pt-upcoming">
        <div className="pt-section-head">
          <h2 id="pt-upcoming">{t('publish.upcoming')}</h2>
          <p className="muted small">{t('publish.upcomingHint')}</p>
        </div>
        {cal.isLoading && <Spinner />}
        {cal.error && <ErrorBox error={cal.error} />}
        {cal.data && upcoming.length === 0 && <Empty title={t('publish.upcomingEmpty')} />}
        {upcoming.length > 0 && (
          <ul className="ops-rows pt-list">
            {upcoming.map((p) => (
              <li key={p.id} className={`ops-row ${stateClass(p)}`}>
                <span className="ops-row-time">{whenIn(p.scheduled_at, zone)}</span>
                <span className="tag">{netShort(p.network)}</span>
                <div className="ops-row-main">
                  <Link to={`/pieces/${p.piece_id}`} className="ops-row-title">{p.piece_title}</Link>
                  <span className="muted small">
                    {NETWORK_LABEL[p.network] ?? p.network} · {p.account_name}
                    {p.hold_reason ? ` · ${p.hold_reason}` : ''}
                  </span>
                </div>
                <div className="ops-row-side">
                  <Chip state={p.status} />
                  <PublicationBadges pub={p} />
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      {empty.length > 0 && (
        <section className="pt-section pt-upcoming" aria-labelledby="pt-slots">
          <div className="pt-section-head">
            <h2 id="pt-slots">{t('publish.slots')}</h2>
            <span className="tag">{empty.length}</span>
            <p className="muted small">{t('publish.slotsHint')}</p>
          </div>
          <ul className="ops-rows pt-list">
            {empty.map((s) => (
              <li key={s.id + s.at} className="ops-row ops-row-slot">
                <span className="ops-row-time">{whenIn(s.at, zone)}</span>
                <span className="tag">{netShort(s.network)}</span>
                <div className="ops-row-main">
                  {s.label && <span>{s.label}</span>}
                  <span className={s.label ? 'muted small' : ''}>{NETWORK_LABEL[s.network] ?? s.network} · {s.account_name}</span>
                </div>
                <div className="ops-row-side"><span className="ops-slot-chip">{t('publish.slot')}</span></div>
              </li>
            ))}
          </ul>
        </section>
      )}

      {attempts && <AttemptsDialog pubId={attempts} zone={zone} onClose={() => setAttempts(null)} />}
      {retry && <RetryDialog pub={retry} zone={zone} onClose={() => setRetry(null)} />}
    </div>
  );
}
