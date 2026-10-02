import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { DateTime } from 'luxon';
import { Fragment, useState, type KeyboardEvent, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { api, type ActivityItem, type AttentionItem, type AwaitingItem, type Overview, type PublicationRow, type TodayItem } from '../api';
import { Avatar, displayName } from '../components/Avatar';
import { Icon, type IconName } from '../components/icons';
import { PageBar } from '../components/PageBar';
import { RetryDialog } from '../components/publications';
import { Chip, ErrorBox, errorMessage, NetMark, Skeleton, Tip, Tipped, useToast } from '../components/ui';
import { getLocale, t, type Key } from '../i18n';
import { BLOCK_REASON_LABEL, ERROR_CLASS_LABEL, NETWORK_LABEL } from '../lib/format';
import { useSession } from '../lib/session';
import '../styles/home.css';

// ───────────────────────────── small helpers ─────────────────────────────

/** A long title cut to fit inside a sentence. */
const clip = (s: string | null, max = 46) => (!s ? '' : s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s);

/** 0:12, 1:04 — minutes and seconds. */
const tc = (seconds: number) => {
  const s = Math.max(0, Math.floor(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

/** How long ago, as short as a meta line says it: "ahora", "4 min", "3 h", "ayer", "3 d", then the date. */
function ago(iso: string): string {
  const then = DateTime.fromISO(iso);
  const mins = Math.floor(-then.diffNow('minutes').minutes);
  if (mins < 1) return t('home.ago.now');
  if (mins < 60) return t('home.ago.min', { n: mins });
  if (then.hasSame(DateTime.now(), 'day')) return t('home.ago.h', { n: Math.max(1, Math.floor(mins / 60)) });
  if (then.hasSame(DateTime.now().minus({ days: 1 }), 'day')) return t('home.ago.yesterday');
  if (mins < 7 * 24 * 60) return t('home.ago.d', { n: Math.max(2, Math.round(mins / 1440)) });
  return then.toFormat('d LLL');
}

const fullDate = (iso: string) => DateTime.fromISO(iso).toFormat('ccc d LLL yyyy, HH:mm');
const netName = (n: string | null) => (n ? (NETWORK_LABEL[n] ?? n) : '');
const list = (items: string[]) => new Intl.ListFormat(getLocale(), { style: 'long', type: 'conjunction' }).format(items);
const who = (name: string | null) => displayName(name);

/** A translated sentence whose {placeholders} are filled with elements (a name, a link) instead of text. */
function rich(template: string, parts: Record<string, ReactNode>): ReactNode {
  return template.split(/(\{\w+\})/g).map((seg, i) => {
    const m = /^\{(\w+)\}$/.exec(seg);
    return <Fragment key={i}>{m && m[1]! in parts ? parts[m[1]!] : seg}</Fragment>;
  });
}

/** Up and down (and left and right) move between the rows of a list or the cards of a grid. */
function arrowNav(e: KeyboardEvent<HTMLElement>) {
  const keys = ['ArrowDown', 'ArrowUp', 'ArrowRight', 'ArrowLeft'];
  if (!keys.includes(e.key) || e.altKey || e.metaKey || e.ctrlKey) return;
  const items = [...e.currentTarget.querySelectorAll<HTMLElement>('[data-nav]')];
  const at = items.indexOf(document.activeElement as HTMLElement);
  if (at < 0) return;
  const next = items[at + (e.key === 'ArrowDown' || e.key === 'ArrowRight' ? 1 : -1)];
  if (next) {
    e.preventDefault();
    next.focus();
  }
}

function Thumb({ src, className }: { src: string | null; className: string }) {
  const [broken, setBroken] = useState(false);
  return (
    <span className={`home-thumb ${className}`} aria-hidden="true">
      {src && !broken ? <img src={src} alt="" loading="lazy" onError={() => setBroken(true)} /> : <Icon name="image" />}
    </span>
  );
}

/** A short noun and its count, and where to see all of it. */
function SectionHead({ id, title, count, to, linkLabel }: { id: string; title: string; count?: number; to?: string; linkLabel?: string }) {
  return (
    <div className="home-sec-head">
      <h2 id={id}>{title}</h2>
      {count !== undefined && count > 0 && <span className="home-count">{count}</span>}
      {to && linkLabel && (
        <Link className="home-all" to={to}>
          {linkLabel}
          <Icon name="chevronRight" />
        </Link>
      )}
    </div>
  );
}

/** An empty block: one muted line. */
const Empty = ({ text }: { text: string }) => <p className="home-empty">{text}</p>;

/** Who did something, in a meta line: their mark and name, or the agent's. */
function By({ agent, name }: { agent: boolean; name: string | null }) {
  return (
    <Tipped label={name ?? undefined}>
      <span className="home-by">
        {agent ? <Avatar agent size={16} title={name ?? undefined} /> : <Avatar name={name} size={16} />}
        <span className="home-by-name">{agent ? t('common.agent') : who(name)}</span>
      </span>
    </Tipped>
  );
}

// ───────────────────────────── waiting for a decision ─────────────────────────────

/** One card per piece: its newest version waiting, and how many other variants wait with it. */
function groupByPiece(items: AwaitingItem[]) {
  const groups = new Map<string, { item: AwaitingItem; more: number }>();
  for (const a of items) {
    const g = groups.get(a.piece_id);
    if (g) g.more++;
    else groups.set(a.piece_id, { item: a, more: 0 });
  }
  return [...groups.values()];
}

function AwaitingCard({ a, more, mode }: { a: AwaitingItem; more: number; mode: Overview['awaiting_mode'] }) {
  const to = `/review/${a.version_id}`;
  const resolving = a.earlier_comments > 0;
  return (
    <article className="hw-card">
      <Link to={to} className="hw-thumb" tabIndex={-1} aria-hidden="true">
        <Thumb src={`/api/versions/${a.version_id}/thumb?w=480`} className="hw-img" />
        <Tip label={t('home.awaiting.version', { n: a.version_number })}><span className="hw-ov hw-ov-tr">V{a.version_number}</span></Tip>
        {a.open_comments > 0 && (
          <Tip label={t('home.awaiting.open', { count: a.open_comments })}><span className="hw-ov hw-ov-bl"><Icon name="bubble" />{a.open_comments}</span></Tip>
        )}
        {more > 0 && (
          <Tip label={t('home.awaiting.moreVariants', { count: more })}><span className="hw-ov hw-ov-br"><Icon name="layers" />{more + 1}</span></Tip>
        )}
      </Link>
      <div className="hw-body">
        <h3 className="hw-title"><Tipped label={a.piece_title}><Link to={to}>{a.piece_title}</Link></Tipped></h3>
        <p className="home-meta">
          <By agent={a.by_agent} name={a.author} />
          <Tipped label={fullDate(a.created_at)}><time className="home-meta-when" dateTime={a.created_at}>{ago(a.created_at)}</time></Tipped>
        </p>
        {resolving && (
          <Tip label={t('home.awaiting.resolves', { n: a.resolves, count: a.earlier_comments })}>
            <div className="hw-progress">
              <span className="home-meta"><Icon name="check" />{t('home.awaiting.resolvesShort', { n: a.resolves, count: a.earlier_comments })}</span>
              <span className="hw-bar" role="progressbar" aria-label={t('home.awaiting.resolves', { n: a.resolves, count: a.earlier_comments })} aria-valuemin={0} aria-valuemax={a.earlier_comments} aria-valuenow={a.resolves}>
                <i style={{ width: `${Math.round((a.resolves / a.earlier_comments) * 100)}%` }} />
              </span>
            </div>
          </Tip>
        )}
        <Link to={to} data-nav className="btn btn-small hw-cta">{t(`home.awaiting.cta.${mode}` as Key)}</Link>
      </div>
    </article>
  );
}

function Awaiting({ data }: { data: Overview }) {
  const groups = groupByPiece(data.awaiting);
  const mode = data.awaiting_mode;
  return (
    <section className="home-sec home-sec-wait" aria-labelledby="home-awaiting">
      <SectionHead id="home-awaiting" title={t(`home.awaiting.${mode}` as Key)} count={groups.length} to={groups.length ? '/pieces?state=in_review' : undefined} linkLabel={t('home.seeAll')} />
      {groups.length === 0 ? (
        <Empty text={mode === 'approve' ? t('home.awaiting.empty') : t('home.awaiting.emptyReview')} />
      ) : (
        <div className="home-wait" onKeyDown={arrowNav}>
          {groups.slice(0, 6).map((g) => <AwaitingCard key={g.item.piece_id} a={g.item} more={g.more} mode={mode} />)}
        </div>
      )}
    </section>
  );
}

// ───────────────────────────── today ─────────────────────────────

function TodayRow({ p, canPrepare }: { p: TodayItem; canPrepare: boolean }) {
  const prepare = p.manual && p.status === 'scheduled' && canPrepare;
  return (
    <li className="hl-row">
      <Tipped label={fullDate(p.scheduled_at)}><span className="hl-time">{p.time}</span></Tipped>
      <span className="hl-mark"><NetMark network={p.network} size="sm" labelled /></span>
      <Thumb src={p.thumb} className="hl-thumb" />
      <div className="hl-text">
        <Tipped label={p.piece_title}><Link to={`/pieces/${p.piece_id}`} className="hl-title" data-nav>{p.piece_title}</Link></Tipped>
        <span className="home-meta">
          {p.account_name}
          <span className="dot" aria-hidden="true">·</span>
          {p.manual ? t('home.today.manual') : t('home.today.auto')}
        </span>
      </div>
      <div className="hl-end">
        {p.url && (
          <Tip label={t('home.today.openPost', { network: netName(p.network) })}>
            <a className="hl-icon-link" href={p.url} target="_blank" rel="noreferrer" aria-label={t('home.today.openPost', { network: netName(p.network) })}>
              <Icon name="external" />
            </a>
          </Tip>
        )}
        {prepare ? <Link to="/today" className={`btn btn-small ${p.due ? 'btn-primary' : ''}`}>{t('home.today.prepare')}</Link> : <Chip state={p.status} />}
      </div>
    </li>
  );
}

function Today({ data }: { data: Overview }) {
  const { can } = useSession();
  return (
    <section className="home-sec" aria-labelledby="home-today">
      <SectionHead id="home-today" title={t('home.today.title')} count={data.today.length} to="/calendar" linkLabel={t('home.today.calendar')} />
      {data.today.length === 0 ? (
        <Empty text={t('home.today.empty')} />
      ) : (
        <ul className="home-list" onKeyDown={arrowNav}>
          {data.today.map((p) => <TodayRow key={p.id} p={p} canPrepare={can('schedule')} />)}
        </ul>
      )}
    </section>
  );
}

// ───────────────────────────── needs attention ─────────────────────────────

/** The row's title, its state (a quiet chip) and one terse meta line; the detail goes in the tooltip. */
function attentionText(a: AttentionItem): { title: string; state: { code: string; label?: string } | null; meta: string[] } {
  const account = a.account_name ?? '';
  switch (a.kind) {
    case 'publication_failed':
      return { title: a.piece_title ?? '', state: { code: 'failed' }, meta: [account, a.reason ? (ERROR_CLASS_LABEL[a.reason] ?? a.reason) : ''] };
    case 'publication_on_hold':
      return { title: a.piece_title ?? '', state: { code: 'on_hold' }, meta: [account, a.reason === 'new_version' ? t('home.attention.newVersion') : ''] };
    case 'publication_awaiting_confirmation':
      return { title: a.piece_title ?? '', state: { code: 'awaiting_reapproval' }, meta: [account, a.reason === 'moved_by_you' ? t('home.attention.movedByYou') : ''] };
    case 'account_reconnect':
      return { title: account, state: { code: 'failed', label: t('home.attention.disconnected') }, meta: [netName(a.network)] };
    case 'webhook_failing': {
      let host = a.piece_title ?? '';
      try { host = new URL(host).host; } catch { /* not a full address: shown as it is */ }
      return { title: host, state: { code: 'failed', label: a.reason === 'disabled' ? t('home.attention.webhookOff') : t('home.attention.webhookFailing') }, meta: [t('home.attention.webhook')] };
    }
    case 'agent_needs_person':
      return {
        title: a.piece_title ?? '',
        state: { code: 'needs_person' },
        meta: [a.reason === 'agent_declined' ? t('home.attention.agentDeclined') : (BLOCK_REASON_LABEL[a.reason ?? ''] ?? a.reason ?? '')],
      };
  }
}

const ATTENTION_ICON: Record<AttentionItem['kind'], IconName> = {
  publication_failed: 'send', publication_on_hold: 'send', publication_awaiting_confirmation: 'calendar',
  account_reconnect: 'user', webhook_failing: 'globe', agent_needs_person: 'bot',
};

function AttentionRow({ a, onRetry }: { a: AttentionItem; onRetry: (a: AttentionItem) => void }) {
  const { can } = useSession();
  const qc = useQueryClient();
  const toast = useToast();
  const confirm = useMutation({
    mutationFn: (id: string) => api.post(`/api/publications/${id}/confirm`),
    onSuccess: () => {
      toast(t('home.attention.confirmed'));
      qc.invalidateQueries({ queryKey: ['overview'] });
      qc.invalidateQueries({ queryKey: ['calendar'] });
    },
    onError: (e) => toast(errorMessage(e), 'error'),
  });
  const text = attentionText(a);
  const act = a.action;
  // A publication that failed for its connection is fixed by connecting the account again, and then retried.
  const reconnectToo = a.kind === 'publication_failed' && a.reason === 'auth' && can('manage');
  const quote = a.kind === 'agent_needs_person' && a.reason === 'agent_declined' && a.detail ? a.detail.split('\n')[0] : null;
  return (
    <Tipped label={a.detail && !quote ? a.detail : undefined}>
      <li className="hl-row ha-row">
        <Tipped label={fullDate(a.at)}><span className="hl-time hl-when">{ago(a.at)}</span></Tipped>
        {/* Where (the network) and what (the piece, or the kind of thing when there is no piece), in the same columns as "today". */}
        <span className="hl-mark">{a.network && <NetMark network={a.network} size="sm" labelled />}</span>
        {a.thumb ? (
          <Thumb src={a.thumb} className="hl-thumb" />
        ) : (
          <span className={`hl-thumb ha-tile ${a.kind === 'agent_needs_person' ? 'ha-tile-agent' : ''}`} aria-hidden="true"><Icon name={ATTENTION_ICON[a.kind]} /></span>
        )}
        <div className="hl-text">
          {a.piece_id ? (
            <Tipped label={text.title}><Link to={`/pieces/${a.piece_id}`} className="hl-title" data-nav>{text.title}</Link></Tipped>
          ) : (
            <Tipped label={text.title}><span className="hl-title">{text.title}</span></Tipped>
          )}
          <span className="home-meta">
            {text.state && <Chip state={text.state.code} label={text.state.label} />}
            {/* each part carries its dot, so a wrapped line never ends on one */}
            {text.meta.filter(Boolean).map((m, i) => (
              <span key={i} className="home-meta-part"><span className="dot" aria-hidden="true">·</span><span className="home-meta-cut">{m}</span></span>
            ))}
          </span>
          {quote && <q className="ha-quote">{quote}</q>}
        </div>
        {act && (
          <div className="hl-end ha-actions">
            {reconnectToo && <Link to="/settings?tab=accounts" className="btn btn-small">{t('home.action.reconnect')}</Link>}
            {act.type === 'retry' && <button type="button" className="btn btn-small btn-primary" onClick={() => onRetry(a)}>{t('common.retry')}</button>}
            {act.type === 'confirm' && (
              <button type="button" className="btn btn-small btn-primary" disabled={confirm.isPending} onClick={() => confirm.mutate(act.publication_id)}>{t('common.confirm')}</button>
            )}
            {act.type === 'review' && <Link to={act.to} className="btn btn-small btn-primary">{t('home.action.review')}</Link>}
            {act.type === 'open' && <Link to={act.to} className="btn btn-small">{t('common.open')}</Link>}
            {act.type === 'reconnect' && <Link to={act.to} className="btn btn-small btn-primary">{t('home.action.reconnect')}</Link>}
            {act.type === 'webhooks' && <Link to={act.to} className="btn btn-small">{t('home.action.webhooks')}</Link>}
          </div>
        )}
      </li>
    </Tipped>
  );
}

function Attention({ data }: { data: Overview }) {
  const qc = useQueryClient();
  const [retrying, setRetrying] = useState<AttentionItem | null>(null);
  return (
    <section className="home-sec" aria-labelledby="home-attention">
      <SectionHead id="home-attention" title={t('home.attention.title')} count={data.attention.length} />
      {data.attention.length === 0 ? (
        <Empty text={t('home.attention.empty')} />
      ) : (
        <ul className="home-list" onKeyDown={arrowNav}>
          {data.attention.map((a) => <AttentionRow key={`${a.kind}-${a.id}`} a={a} onRetry={setRetrying} />)}
        </ul>
      )}
      {retrying && (
        <RetryDialog
          pub={{ id: retrying.id, network: retrying.network ?? '', account_name: retrying.account_name ?? '', last_error: retrying.detail, last_error_class: retrying.reason } as PublicationRow}
          zone={data.timezone}
          onClose={() => {
            setRetrying(null);
            qc.invalidateQueries({ queryKey: ['overview'] });
          }}
        />
      )}
    </section>
  );
}

// ───────────────────────────── activity ─────────────────────────────

function ActorMark({ e }: { e: ActivityItem }) {
  if (e.by_agent) return <Avatar agent size={24} title={e.actor ?? undefined} />;
  if (!e.actor) return <span className="avatar hf-studio" style={{ width: 24, height: 24 }} aria-hidden="true"><Icon name="send" /></span>;
  return <Avatar name={e.actor} size={24} />;
}

function ActivityEvent({ e }: { e: ActivityItem }) {
  const name = <Tipped label={e.actor ?? undefined}><b>{e.by_agent ? t('home.activity.agent') : who(e.actor)}</b></Tipped>;
  const pieceTo = e.version_id && (e.kind === 'comment' || e.kind === 'version' || e.kind === 'changes_requested') ? `/review/${e.version_id}` : `/pieces/${e.piece_id}`;
  const piece = e.piece_id ? <Tipped label={e.piece_title ?? undefined}><Link to={pieceTo} className="hf-piece">{clip(e.piece_title)}</Link></Tipped> : <b>{clip(e.piece_title)}</b>;
  const networks = list(e.networks.map((n) => netName(n)));
  const parts = { who: name, piece };
  let line: ReactNode;
  switch (e.kind) {
    case 'comment': line = rich(t('home.activity.comment'), parts); break;
    case 'version': line = rich(t('home.activity.version', { n: e.version_number ?? 1 }), parts); break;
    case 'approved': line = e.networks.length ? rich(t('home.activity.approved', { networks }), parts) : rich(t('home.activity.approvedPlain'), parts); break;
    case 'rejected': line = rich(t('home.activity.rejected', { n: e.version_number ?? 1 }), parts); break;
    case 'changes_requested': line = rich(t('home.activity.changes'), parts); break;
    case 'published': line = e.actor ? rich(t('home.activity.publishedBy', { network: networks }), parts) : rich(t('home.activity.published', { network: networks }), parts); break;
    case 'agent_handed': line = rich(t('home.activity.handed'), parts); break;
  }
  const mark = e.t !== null ? (e.t_end !== null ? `${tc(e.t)}–${tc(e.t_end)}` : tc(e.t)) : e.page !== null ? t('home.activity.page', { n: e.page }) : null;
  const quoted = e.text && (e.kind === 'comment' || e.kind === 'rejected' || e.kind === 'agent_handed');
  return (
    <li className="hf-ev">
      <ActorMark e={e} />
      <div className="hf-body">
        <p className="hf-line">
          {line}
          <Tipped label={fullDate(e.at)}><time className="hf-when" dateTime={e.at}>{ago(e.at)}</time></Tipped>
          {e.via && <span className="hf-when">· {t('home.activity.via', { client: e.via })}</span>}
        </p>
        {quoted && (
          <p className={`hf-quote ${e.kind === 'agent_handed' ? 'hf-quote-agent' : ''}`}>
            {mark && (e.t !== null ? <span className="tc">{mark}</span> : <span className="hf-page">{mark}</span>)}
            {e.text}
          </p>
        )}
        {e.kind === 'version' && (e.resolves ?? 0) > 0 && (
          <p className="home-meta hf-meta"><Icon name="check" />{t('home.activity.resolved', { count: e.resolves! })}</p>
        )}
      </div>
    </li>
  );
}

function Activity({ data }: { data: Overview }) {
  const [all, setAll] = useState(false);
  return (
    <aside className="home-feed" aria-labelledby="home-feed-title">
      <div className="home-sec-head"><h2 id="home-feed-title">{t('home.activity.title')}</h2></div>
      {data.activity.length === 0 ? (
        <Empty text={t('home.activity.empty')} />
      ) : (
        <>
          <ol className={`hf-list ${all ? 'all' : ''}`}>
            {data.activity.map((e) => <ActivityEvent key={`${e.kind}-${e.id}`} e={e} />)}
          </ol>
          {/* Only shown where the feed sits under the rest of the page (see home.css). */}
          {!all && data.activity.length > 8 && (
            <button type="button" className="btn btn-small btn-ghost hf-more" onClick={() => setAll(true)}>
              {t('home.activity.more', { count: data.activity.length - 8 })}
            </button>
          )}
        </>
      )}
    </aside>
  );
}

// ───────────────────────────── loading ─────────────────────────────

function HomeSkeleton() {
  return (
    <div className="home" aria-busy="true" aria-label={t('common.loading')}>
      <div className="home-main">
        <div className="home-sec">
          <Skeleton width={180} height={12} style={{ marginBottom: 14 }} />
          <div className="home-wait">
            {[0, 1, 2].map((i) => (
              <div key={i} className="hw-card sk-card">
                <Skeleton className="sk-thumb" width={96} height="auto" radius={0} />
                <div className="hw-body">
                  <Skeleton width="85%" height={12} />
                  <Skeleton width="50%" height={12} />
                  <Skeleton width="60%" height={10} style={{ marginTop: 4 }} />
                  <Skeleton width="100%" height={26} radius={6} style={{ marginTop: 'auto' }} />
                </div>
              </div>
            ))}
          </div>
        </div>
        <div className="home-sec">
          <Skeleton width={60} height={12} style={{ marginBottom: 14 }} />
          <div className="home-list sk-list">
            {[0, 1, 2].map((i) => (
              <div key={i} className="hl-row">
                <Skeleton width={36} height={11} />
                <Skeleton width={18} height={18} radius={5} />
                <Skeleton width={30} height={38} radius={5} />
                <Skeleton height={11} style={{ flex: 1, maxWidth: 280 }} />
              </div>
            ))}
          </div>
        </div>
      </div>
      <div className="home-feed">
        <Skeleton width={70} height={12} style={{ marginBottom: 18 }} />
        {[0, 1, 2, 3, 4].map((i) => (
          <div key={i} className="sk-ev">
            <Skeleton width={24} height={24} radius="50%" />
            <div style={{ flex: 1 }}>
              <Skeleton width="90%" height={11} />
              <Skeleton width="45%" height={11} style={{ marginTop: 8 }} />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ───────────────────────────── the page ─────────────────────────────

/** "For you": what waits for this person, what goes out today, what needs a hand, and what just happened. */
export function HomePage() {
  const { brand } = useSession();
  const { data, error, isLoading } = useQuery({
    queryKey: ['overview', brand.id],
    queryFn: () => api.get<Overview>(`/api/brands/${brand.id}/overview`),
    refetchInterval: 60_000,
  });
  return (
    <>
      <PageBar crumbs={[{ label: t('layout.nav.home') }]} />
      {isLoading && <HomeSkeleton />}
      {error && <ErrorBox error={error} />}
      {data && (
        <div className="home">
          <div className="home-main">
            <Awaiting data={data} />
            <Today data={data} />
            <Attention data={data} />
          </div>
          <Activity data={data} />
        </div>
      )}
    </>
  );
}
