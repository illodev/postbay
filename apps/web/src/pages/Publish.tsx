import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { DateTime } from 'luxon';
import { useState, type FormEvent, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { api, type CalendarData, type PieceDetail } from '../api';
import { Icon } from '../components/icons';
import { PageBar } from '../components/PageBar';
import { AttemptsDialog, PublicationBadges, PublicationNote, RetryDialog } from '../components/publications';
import { Chip, CopyButton, ErrorBox, errorMessage, NetMark, Skeleton, SkeletonText, useConfirm, useToast } from '../components/ui';
import { t, tMaybe } from '../i18n';
import { fmtBytes, NETWORK_LABEL } from '../lib/format';
import { useSession } from '../lib/session';
import { hourIn, stateClass, Thumb } from './Calendar';
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

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** The hour, and under it the day in words: "12:30 / sáb 3 oct", or "hoy" / "mañana". */
function When({ iso, zone }: { iso: string; zone: string }) {
  const d = DateTime.fromISO(iso, { zone });
  const today = DateTime.now().setZone(zone).startOf('day');
  const diff = Math.round(d.startOf('day').diff(today, 'days').days);
  const day = diff === 0 ? t('publish.today') : diff === 1 ? t('publish.tomorrow') : diff === -1 ? t('publish.yesterday') : d.toFormat('ccc d LLL');
  return (
    <span className="ops-row-when">
      <span className="ops-row-time">{d.toFormat('HH:mm')}</span>
      <span className="ops-row-day">{cap(day)}</span>
    </span>
  );
}

function fileLabel(kind: string, position: number): string {
  if (kind === 'image') return t('publish.file.image', { n: position + 1 });
  return tMaybe(`publish.file.${kind}`, kind);
}

/** The preview of the exact version being published; while the piece loads, the piece's latest. */
function Preview({ pieceId, pubId, network }: { pieceId: string; pubId: string; network: string }) {
  const piece = useQuery({ queryKey: ['piece', pieceId], queryFn: () => api.get<PieceDetail>(`/api/pieces/${pieceId}`) });
  const pub = piece.data?.publications.find((p) => p.id === pubId);
  const format = piece.data?.variants.find((v) => v.id === pub?.variant_id)?.format;
  return (
    <div className="pt-media">
      {piece.isLoading ? <Skeleton className="pt-media-skel" /> : <Thumb key={pub?.version_id ?? 'piece'} versionId={pub?.version_id} pieceId={pieceId} w={480} className="pt-media-img" />}
      <span className="ov ov-l ov-top"><NetMark network={network} size="sm" /></span>
      {format && <span className="ov ov-r ov-top">{format}</span>}
    </div>
  );
}

function Block({ title, side, children }: { title: string; side?: ReactNode; children: ReactNode }) {
  return (
    <section className="pt-block">
      <div className="pt-block-head">
        <h3>{title}</h3>
        {side}
      </div>
      {children}
    </section>
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
      <Preview pieceId={due.piece_id} pubId={due.id} network={due.network} />
      <div className="pt-body">
        <header className="pt-head">
          <div className="pt-head-main">
            <h2 id={titleId}><Link to={`/pieces/${due.piece_id}`}>{due.piece_title}</Link></h2>
            <div className="pt-where">
              <NetMark network={due.network} size="xs" />
              <span>{NETWORK_LABEL[due.network] ?? due.network} · {due.account_name}</span>
            </div>
          </div>
          <div className="pt-when">
            <span className="pt-when-time">{hourIn(due.scheduled_at, zone)}</span>
            <span className="pt-when-day">{cap(DateTime.fromISO(due.scheduled_at, { zone }).toFormat('cccc d LLL'))}</span>
          </div>
        </header>

        {due.waiting_for_dependency && <div className="notice notice-warn" style={{ margin: 0 }}>{t('publish.waits')}</div>}

        <Block title={t('publish.text')} side={text && <CopyButton text={text} />}>
          <div className="pt-text">{text || <span className="muted">{t('publish.noText')}</span>}</div>
        </Block>

        {pack.data?.first_comment && (
          <Block title={t('publish.firstComment')} side={<CopyButton text={pack.data.first_comment} />}>
            <div className="pt-text">{pack.data.first_comment}</div>
          </Block>
        )}

        <Block title={t('publish.files')} side={pack.data && pack.data.files.length > 0 && <span className="ops-count">{pack.data.files.length}</span>}>
          {pack.isLoading && <div className="pt-files pt-files-skel"><SkeletonText lines={2} /></div>}
          {pack.error && <ErrorBox error={pack.error} />}
          {pack.data && pack.data.files.length === 0 && <p className="pt-none">{t('publish.noFiles')}</p>}
          {pack.data && pack.data.files.length > 0 && (
            <ul className="pt-files">
              {pack.data.files.map((f) => (
                <li key={`${f.kind}-${f.position}`} className="pt-file">
                  <span className="pt-file-kind">{fileLabel(f.kind, f.position)}</span>
                  <span className="pt-file-name" title={f.name}>{f.name}</span>
                  <span className="pt-file-size">{fmtBytes(f.bytes)}</span>
                  <a className="btn btn-small" href={f.url} download={f.name} aria-label={t('publish.downloadFile', { name: f.name })}>
                    <Icon name="download" />
                    <span>{t('common.download')}</span>
                  </a>
                </li>
              ))}
            </ul>
          )}
        </Block>

        {canMark ? (
          <form className="pt-mark" onSubmit={submit}>
            <label className="pt-link">
              <span className="sr-only">{t('publish.link')}</span>
              <Icon name="link" />
              <input type="url" inputMode="url" placeholder={t('publish.linkPlaceholder')} value={url} onChange={(e) => setUrl(e.target.value)} />
            </label>
            <button className="btn btn-primary" disabled={mark.isPending || due.waiting_for_dependency}>
              <Icon name="check" />
              <span>{t('publish.mark')}</span>
            </button>
          </form>
        ) : (
          <p className="pt-none pt-mark">{t('publish.noPermission')}</p>
        )}
      </div>
    </article>
  );
}

function SectionHead({ id, title, count, hint }: { id: string; title: string; count?: number; hint?: string }) {
  return (
    <div className="ops-section-head" title={hint}>
      <h2 id={id}>{title}</h2>
      {count !== undefined && count > 0 && <span className="ops-count">{count}</span>}
    </div>
  );
}

function RowsSkeleton({ rows = 3 }: { rows?: number }) {
  return (
    <ul className="ops-rows pt-list" aria-hidden="true">
      {Array.from({ length: rows }, (_, i) => (
        <li key={i} className="ops-row">
          <Skeleton width={40} height={12} />
          <Skeleton width={32} height={40} radius={6} />
          <span className="stack" style={{ gap: 6 }}><Skeleton width="55%" /><Skeleton width="30%" height={10} /></span>
          <Skeleton width={80} height={20} radius={99} />
        </li>
      ))}
    </ul>
  );
}

export function PublishPage() {
  const { brand, can } = useSession();
  const zone = brand.timezone;
  const [attempts, setAttempts] = useState<string | null>(null);
  const [retry, setRetry] = useState<CalendarData['publications'][number] | null>(null);
  const qc = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();
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
  const handOver = async (id: string) => {
    if (await confirm({ title: t('publish.handOverTitle'), text: t('publish.handOverConfirm'), confirmLabel: t('publish.handOver') })) act.mutate({ id, action: 'hand-over' });
  };
  const all = cal.data?.publications ?? [];
  // Posts the app sends by itself that went wrong, or that went out but are not public.
  const attention = all.filter((p) => !p.manual && (p.status === 'failed' || (p.status === 'published' && p.visibility !== null && p.visibility !== 'public')));
  const open = ['scheduled', 'awaiting_reapproval', 'on_hold', 'preparing', 'ready', 'publishing'];
  // A manual post whose hour has passed is in "Due now"; an automatic one is still the app's to send.
  const upcoming = all.filter((p) => open.includes(p.status) && (!p.manual || new Date(p.scheduled_at) > new Date()));
  const empty = (cal.data?.slots ?? []).filter((s) => !s.filled && !s.past && !s.blocked);

  return (
    <div className="ops pt">
      <PageBar
        crumbs={[{ label: t('publish.title') }]}
        actions={
          <Link className="btn btn-ghost" to="/calendar">
            <Icon name="calendar" />
            <span>{t('publish.toCalendar')}</span>
          </Link>
        }
      />

      <section className="ops-section" aria-labelledby="pt-due">
        <SectionHead id="pt-due" title={t('publish.due')} count={due.data?.length} hint={t('publish.dueHint')} />
        {due.isLoading && <div className="pt-card pt-card-skel" aria-hidden="true"><Skeleton height="100%" radius={0} /><div className="pt-body"><Skeleton width="40%" height={18} /><SkeletonText lines={3} /></div></div>}
        {due.error && <ErrorBox error={due.error} />}
        {brand.paused && <div className="notice notice-warn">{t('publish.paused')}</div>}
        {due.data && due.data.length === 0 && !brand.paused && <p className="ops-quiet">{t('publish.dueEmpty')}</p>}
        {due.data && due.data.length > 0 && (
          <div className="pt-due">
            {due.data.map((d) => <DueCard key={d.id} due={d} zone={zone} canMark={can('schedule')} />)}
          </div>
        )}
      </section>

      {attention.length > 0 && (
        <section className="ops-section pt-attn" aria-labelledby="pt-attn">
          <SectionHead id="pt-attn" title={t('publish.attention')} count={attention.length} hint={t('publish.attentionHint')} />
          <ul className="ops-rows pt-list">
            {attention.map((p) => (
              <li key={p.id} className={`ops-row ${stateClass(p)}`}>
                <When iso={p.scheduled_at} zone={zone} />
                <Thumb versionId={p.version_id} pieceId={p.piece_id} />
                <div className="ops-row-main">
                  <Link to={`/pieces/${p.piece_id}`} className="ops-row-title">{p.piece_title}</Link>
                  <span className="ops-row-sub"><NetMark network={p.network} size="xs" />{NETWORK_LABEL[p.network] ?? p.network} · {p.account_name}</span>
                  <PublicationNote pub={p} />
                </div>
                <div className="ops-row-side">
                  <Chip state={p.status} />
                  <button className="btn btn-small btn-ghost" onClick={() => setAttempts(p.id)}>{t('publish.history')}</button>
                  {can('schedule') && p.status === 'failed' && (
                    <>
                      <button className="btn btn-small" onClick={() => handOver(p.id)}>{t('publish.handOver')}</button>
                      <button className="btn btn-small btn-primary" onClick={() => setRetry(p)}>{t('publish.retry')}</button>
                    </>
                  )}
                  {can('schedule') && p.status === 'published' && p.visibility === 'private' && (
                    <button className="btn btn-small" onClick={() => act.mutate({ id: p.id, action: 'recheck' })}>
                      <Icon name="refresh" />
                      <span>{t('publish.recheck')}</span>
                    </button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="ops-section" aria-labelledby="pt-upcoming">
        <SectionHead id="pt-upcoming" title={t('publish.upcoming')} count={upcoming.length} hint={t('publish.upcomingHint')} />
        {cal.isLoading && <RowsSkeleton />}
        {cal.error && <ErrorBox error={cal.error} />}
        {cal.data && upcoming.length === 0 && <p className="ops-quiet">{t('publish.upcomingEmpty')}</p>}
        {upcoming.length > 0 && (
          <ul className="ops-rows pt-list">
            {upcoming.map((p) => (
              <li key={p.id} className={`ops-row ${stateClass(p)}`}>
                <When iso={p.scheduled_at} zone={zone} />
                <Thumb versionId={p.version_id} pieceId={p.piece_id} />
                <div className="ops-row-main">
                  <Link to={`/pieces/${p.piece_id}`} className="ops-row-title">{p.piece_title}</Link>
                  <span className="ops-row-sub">
                    <NetMark network={p.network} size="xs" />
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
        <section className="ops-section" aria-labelledby="pt-slots">
          <SectionHead id="pt-slots" title={t('publish.slots')} count={empty.length} hint={t('publish.slotsHint')} />
          <ul className="ops-rows pt-list">
            {empty.map((s) => (
              <li key={s.id + s.at} className="ops-row ops-row-slot">
                <When iso={s.at} zone={zone} />
                <span className="ops-thumb ops-thumb-slot" aria-hidden="true"><Icon name="plus" /></span>
                <div className="ops-row-main">
                  <span className="ops-row-title">{s.label || t('publish.slotUnnamed')}</span>
                  <span className="ops-row-sub"><NetMark network={s.network} size="xs" />{NETWORK_LABEL[s.network] ?? s.network} · {s.account_name}</span>
                </div>
                <div className="ops-row-side">
                  <Link className="btn btn-small btn-ghost" to={`/calendar?view=week&date=${s.day}`}>{t('publish.slotWeek')}</Link>
                </div>
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
