import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { DateTime } from 'luxon';
import { Fragment, useState, type KeyboardEvent, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { api, type ActivityItem, type AttentionItem, type AwaitingItem, type Overview, type PublicationRow, type TodayItem } from '../api';
import { Avatar } from '../components/Avatar';
import { Icon, type IconName } from '../components/icons';
import { NetMark } from '../components/NetworkOptions';
import { PageBar } from '../components/PageBar';
import { RetryDialog } from '../components/publications';
import { Chip, ErrorBox, errorMessage, useToast } from '../components/ui';
import { getLocale, t, tMaybe, type Key } from '../i18n';
import { BLOCK_REASON_LABEL, ERROR_CLASS_LABEL, NETWORK_LABEL } from '../lib/format';
import { useSession } from '../lib/session';
import '../styles/home.css';

// ───────────────────────────── small helpers ─────────────────────────────

/** "Lucía (Marketing)" → Lucía, "ana@x.es" → ana. */
const firstName = (name: string | null | undefined) => (name ?? '').trim().split(/[\s@(]/)[0] || '?';

/** A long title cut to fit inside a sentence. */
const clip = (s: string | null, max = 46) => (!s ? '' : s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s);

/** 0:12, 1:04 — minutes and seconds. */
const tc = (seconds: number) => {
  const s = Math.max(0, Math.floor(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

/** How long ago, said the way a feed says it: "hace 4 min", "ayer", then the date. */
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

/** The same, in as few characters as possible, for a narrow column: "4 min", "3 h", "ayer", "2 oct". */
function agoShort(iso: string): string {
  const then = DateTime.fromISO(iso);
  const mins = Math.floor(-then.diffNow('minutes').minutes);
  if (mins < 1) return t('home.ago.now');
  if (mins < 60) return `${mins} min`;
  if (then.hasSame(DateTime.now(), 'day')) return `${Math.floor(mins / 60)} h`;
  if (then.hasSame(DateTime.now().minus({ days: 1 }), 'day')) return t('home.ago.yesterday');
  return then.toFormat('d LLL');
}

const fullDate = (iso: string) => DateTime.fromISO(iso).toFormat('ccc d LLL yyyy, HH:mm');
const netName = (n: string | null) => (n ? (NETWORK_LABEL[n] ?? n) : '');
const list = (items: string[]) => new Intl.ListFormat(getLocale(), { style: 'long', type: 'conjunction' }).format(items);

/** A translated sentence whose {placeholders} are filled with elements (a bold name, a link) instead of text. */
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
      {src && !broken ? <img src={src} alt="" loading="lazy" onError={() => setBroken(true)} /> : <Icon name="square" />}
    </span>
  );
}

function SectionHead({ id, title, count, to, linkLabel, hint }: { id: string; title: string; count?: number; to?: string; linkLabel?: string; hint?: string }) {
  return (
    <div className="home-sec-head">
      <h2 id={id}>{title}</h2>
      {count !== undefined && count > 0 && <span className="home-count">{count}</span>}
      {hint && <span className="home-sec-hint">{hint}</span>}
      {to && linkLabel && (
        <Link className="home-all" to={to}>
          {linkLabel}
          <Icon name="chevronRight" />
        </Link>
      )}
    </div>
  );
}

function EmptyBlock({ icon, title, hint }: { icon: IconName; title: string; hint: string }) {
  return (
    <div className="home-empty">
      <span className="home-empty-icon" aria-hidden="true"><Icon name={icon} /></span>
      <div>
        <strong>{title}</strong>
        <p>{hint}</p>
      </div>
    </div>
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

function Progress({ a }: { a: AwaitingItem }) {
  if (a.earlier_comments > 0) {
    const pct = Math.round((a.resolves / a.earlier_comments) * 100);
    return (
      <div className="hw-progress">
        <span>{t('home.awaiting.resolves', { n: a.resolves, count: a.earlier_comments })}</span>
        <span className="hw-bar" role="progressbar" aria-valuemin={0} aria-valuemax={a.earlier_comments} aria-valuenow={a.resolves}>
          <i style={{ width: `${pct}%` }} />
        </span>
      </div>
    );
  }
  if (a.version_number === 1) return <div className="hw-progress"><span>{t('home.awaiting.first')}</span></div>;
  return <div className="hw-progress"><span>{a.open_comments > 0 ? t('home.awaiting.open', { count: a.open_comments }) : t('home.awaiting.clear')}</span></div>;
}

function AwaitingCard({ a, more, mode }: { a: AwaitingItem; more: number; mode: Overview['awaiting_mode'] }) {
  const to = `/review/${a.version_id}`;
  return (
    <article className="hw-card">
      <Link to={to} className="hw-thumb" tabIndex={-1} aria-hidden="true">
        <Thumb src={`/api/versions/${a.version_id}/thumb?w=480`} className="hw-img" />
        <span className="hw-ov hw-ov-v" title={t('home.awaiting.version', { n: a.version_number })}>V{a.version_number}</span>
        {a.open_comments > 0 && (
          <span className="hw-ov hw-ov-c" title={t('home.awaiting.open', { count: a.open_comments })}>
            <Icon name="bubble" />{a.open_comments}
          </span>
        )}
      </Link>
      <div className="hw-body">
        <h3 className="hw-title"><Link to={to} title={a.piece_title}>{a.piece_title}</Link></h3>
        <div className="hw-by">
          {a.by_agent ? (
            <span className="tag tag-agent hw-agent" title={a.author ?? undefined}><Icon name="bot" />{t('common.agent')}</span>
          ) : (
            <span className="hw-author"><Avatar name={a.author} size={18} /><span>{firstName(a.author)}</span></span>
          )}
          <time className="hw-when" dateTime={a.created_at} title={fullDate(a.created_at)}>{ago(a.created_at)}</time>
          {more > 0 && <span className="hw-more">{t('home.awaiting.moreVariants', { count: more })}</span>}
        </div>
        <Progress a={a} />
        <Link to={to} data-nav className={`btn btn-small hw-cta ${mode === 'approve' ? 'btn-primary' : ''}`}>
          {t(`home.awaiting.cta.${mode}` as Key)}
        </Link>
      </div>
    </article>
  );
}

function Awaiting({ data }: { data: Overview }) {
  const groups = groupByPiece(data.awaiting);
  const mode = data.awaiting_mode;
  const shown = groups.slice(0, 6);
  return (
    <section className="home-sec home-sec-wait" aria-labelledby="home-awaiting">
      <SectionHead
        id="home-awaiting"
        title={t(`home.awaiting.${mode}` as Key)}
        count={groups.length}
        hint={mode === 'comment' ? t('home.awaiting.commentHint') : mode === 'view' ? t('home.awaiting.viewHint') : undefined}
        to={groups.length ? '/pieces?state=in_review' : undefined}
        linkLabel={t('home.seeAll')}
      />
      {shown.length === 0 ? (
        <EmptyBlock icon="check" title={mode === 'approve' ? t('home.awaiting.empty') : t('home.awaiting.emptyReview')} hint={t('home.awaiting.emptyHint')} />
      ) : (
        <div className="home-wait" onKeyDown={arrowNav}>
          {shown.map((g) => <AwaitingCard key={g.item.piece_id} a={g.item} more={g.more} mode={mode} />)}
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
      <span className="hl-time" title={fullDate(p.scheduled_at)}>{p.time}</span>
      <span className="hl-mark" title={`${netName(p.network)} · ${p.account_name}`}><NetMark network={p.network} /></span>
      <Thumb src={p.thumb} className="hl-thumb" />
      <div className="hl-text">
        <Link to={`/pieces/${p.piece_id}`} className="hl-title" data-nav title={p.piece_title}>{p.piece_title}</Link>
        <span className="hl-sub">
          {tMaybe(`kind.${p.piece_kind}`, p.piece_kind)} · {p.account_name} · {p.manual ? t('home.today.manual') : t('home.today.auto')}
        </span>
      </div>
      <div className="hl-end">
        {p.url && (
          <a className="hl-icon-link" href={p.url} target="_blank" rel="noreferrer" title={t('home.today.openPost', { network: netName(p.network) })} aria-label={t('home.today.openPost', { network: netName(p.network) })}>
            <Icon name="external" />
          </a>
        )}
        {prepare ? (
          <Link to="/today" className={`btn btn-small ${p.due ? 'btn-primary' : ''}`}>{t('home.today.prepare')}</Link>
        ) : (
          <Chip state={p.status} />
        )}
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
        <EmptyBlock icon="calendar" title={t('home.today.empty')} hint={t('home.today.emptyHint')} />
      ) : (
        <ul className="home-list" onKeyDown={arrowNav}>
          {data.today.map((p) => <TodayRow key={p.id} p={p} canPrepare={can('schedule')} />)}
        </ul>
      )}
    </section>
  );
}

// ───────────────────────────── needs attention ─────────────────────────────

function attentionText(a: AttentionItem): { title: string; line: string; detail: string | null } {
  const network = netName(a.network);
  const account = a.account_name ?? '';
  switch (a.kind) {
    case 'publication_failed': {
      const cls = a.reason ? (ERROR_CLASS_LABEL[a.reason] ?? a.reason) : null;
      return { title: a.piece_title ?? '', line: `${t('home.attention.failed', { network, account })}${cls ? ` · ${cls}` : ''}`, detail: a.detail };
    }
    case 'publication_on_hold':
      return { title: a.piece_title ?? '', line: a.reason === 'new_version' ? t('home.attention.heldNew', { network }) : t('home.attention.held', { network, account }), detail: a.detail };
    case 'publication_awaiting_confirmation':
      return { title: a.piece_title ?? '', line: a.reason === 'moved_by_you' ? t('home.attention.movedByYou', { network }) : t('home.attention.moved', { network }), detail: null };
    case 'account_reconnect':
      return { title: account, line: t('home.attention.reconnect', { network }), detail: a.detail };
    case 'webhook_failing': {
      let host = a.piece_title ?? '';
      try { host = new URL(host).host; } catch { /* not a full address: shown as it is */ }
      return { title: host, line: a.reason === 'disabled' ? t('home.attention.webhookDisabled') : t('home.attention.webhookFailing'), detail: a.detail };
    }
    case 'agent_needs_person':
      return {
        title: a.piece_title ?? '',
        line: a.reason === 'agent_declined' ? t('home.attention.agentDeclined') : t('home.attention.agentBlocked', { reason: BLOCK_REASON_LABEL[a.reason ?? ''] ?? a.reason ?? '' }),
        detail: a.reason === 'agent_declined' ? a.detail : null,
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
  const icon = ATTENTION_ICON[a.kind];
  const act = a.action;
  // A publication that failed for its connection is fixed by connecting the account again, and then retried.
  const reconnectToo = a.kind === 'publication_failed' && a.reason === 'auth' && can('manage');
  return (
    <li className="hl-row ha-row">
      <span className="hl-time hl-when" title={fullDate(a.at)}>{agoShort(a.at)}</span>
      {/* Where (the network) and what (the piece, or the kind of thing when there is no piece), in the same columns as "today". */}
      <span className="hl-mark">{a.network && <NetMark network={a.network} />}</span>
      {a.thumb ? (
        <Thumb src={a.thumb} className="hl-thumb" />
      ) : (
        <span className={`hl-thumb ha-tile ${a.kind === 'agent_needs_person' ? 'ha-tile-agent' : ''}`} aria-hidden="true"><Icon name={icon} /></span>
      )}
      <div className="hl-text">
        {a.piece_id ? (
          <Link to={`/pieces/${a.piece_id}`} className="hl-title" data-nav title={text.title}>{text.title}</Link>
        ) : (
          <span className="hl-title" title={text.title}>{text.title}</span>
        )}
        <span className="hl-sub ha-sub" title={text.detail ?? undefined}>{text.line}</span>
        {text.detail && a.kind === 'agent_needs_person' && <q className="ha-quote">{text.detail.split('\n')[0]}</q>}
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
  );
}

function Attention({ data }: { data: Overview }) {
  const qc = useQueryClient();
  const [retrying, setRetrying] = useState<AttentionItem | null>(null);
  return (
    <section className="home-sec" aria-labelledby="home-attention">
      <SectionHead id="home-attention" title={t('home.attention.title')} count={data.attention.length} />
      {data.attention.length === 0 ? (
        <EmptyBlock icon="check" title={t('home.attention.empty')} hint={t('home.attention.emptyHint')} />
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
  if (e.by_agent) return <Avatar agent size={28} title={e.actor ?? undefined} />;
  if (!e.actor) return <span className="avatar hf-studio" style={{ width: 28, height: 28 }} aria-hidden="true"><Icon name="send" /></span>;
  return <Avatar name={e.actor} size={28} />;
}

function ActivityEvent({ e }: { e: ActivityItem }) {
  const who = <b title={e.actor ?? undefined}>{e.by_agent ? t('home.activity.agent') : firstName(e.actor)}</b>;
  const pieceTo = e.version_id && (e.kind === 'comment' || e.kind === 'version' || e.kind === 'changes_requested') ? `/review/${e.version_id}` : `/pieces/${e.piece_id}`;
  const piece = e.piece_id ? <Link to={pieceTo} className="hf-piece" title={e.piece_title ?? undefined}>{clip(e.piece_title)}</Link> : <b>{clip(e.piece_title)}</b>;
  const networks = list(e.networks.map((n) => netName(n)));
  let line: ReactNode;
  switch (e.kind) {
    case 'comment': line = rich(t('home.activity.comment'), { who, piece }); break;
    case 'version': line = rich(t('home.activity.version', { n: e.version_number ?? 1 }), { who, piece }); break;
    case 'approved': line = e.networks.length ? rich(t('home.activity.approved', { networks }), { who, piece }) : rich(t('home.activity.approvedPlain'), { who, piece }); break;
    case 'rejected': line = rich(t('home.activity.rejected', { n: e.version_number ?? 1 }), { who, piece }); break;
    case 'changes_requested': line = rich(t('home.activity.changes'), { who, piece }); break;
    case 'published': line = e.actor ? rich(t('home.activity.publishedBy', { network: networks }), { who, piece }) : rich(t('home.activity.published', { network: networks }), { piece }); break;
    case 'agent_handed': line = rich(t('home.activity.handed'), { who, piece }); break;
  }
  const mark = e.t !== null ? (e.t_end !== null ? `${tc(e.t)}–${tc(e.t_end)}` : tc(e.t)) : e.page !== null ? t('home.activity.page', { n: e.page }) : null;
  const quoted = e.text && (e.kind === 'comment' || e.kind === 'rejected' || e.kind === 'agent_handed');
  return (
    <li className="hf-ev">
      <ActorMark e={e} />
      <div className="hf-body">
        <p className="hf-line">{line}</p>
        {quoted && (
          <p className={`hf-quote ${e.kind === 'agent_handed' ? 'hf-quote-agent' : ''}`}>
            {mark && <span className={e.t !== null ? 'tc' : 'tag hf-page'}>{mark}</span>}
            {e.kind === 'agent_handed' ? `«${e.text}»` : e.text}
          </p>
        )}
        <p className="hf-meta">
          <time dateTime={e.at} title={fullDate(e.at)}>{ago(e.at)}</time>
          {e.kind === 'version' && (e.resolves ?? 0) > 0 && <> · {t('home.activity.resolved', { count: e.resolves! })}</>}
          {e.kind === 'published' && e.account_name && <> · {e.account_name}</>}
        </p>
      </div>
    </li>
  );
}

function Activity({ data }: { data: Overview }) {
  const [all, setAll] = useState(false);
  return (
    <aside className="home-feed" aria-labelledby="home-feed-title">
      <h2 id="home-feed-title">{t('home.activity.title')}</h2>
      {data.activity.length === 0 ? (
        <EmptyBlock icon="clock" title={t('home.activity.empty')} hint={t('home.activity.emptyHint')} />
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

function Skeleton() {
  return (
    <div className="home" aria-busy="true" aria-label={t('common.loading')}>
      <div className="home-main">
        <div className="home-hello">
          <span className="sk" style={{ width: 280, height: 26 }} />
          <span className="sk" style={{ width: 360, height: 14, marginTop: 10 }} />
        </div>
        <div className="home-sec">
          <span className="sk" style={{ width: 170, height: 14, marginBottom: 14 }} />
          <div className="home-wait">
            {[0, 1, 2].map((i) => (
              <div key={i} className="hw-card sk-card">
                <span className="sk sk-thumb" />
                <div className="hw-body">
                  <span className="sk" style={{ width: '85%', height: 13 }} />
                  <span className="sk" style={{ width: '55%', height: 13 }} />
                  <span className="sk" style={{ width: 64, height: 18, borderRadius: 99, marginTop: 4 }} />
                  <span className="sk" style={{ width: '70%', height: 11 }} />
                  <span className="sk" style={{ width: '100%', height: 30, marginTop: 'auto', borderRadius: 8 }} />
                </div>
              </div>
            ))}
          </div>
        </div>
        <div className="home-sec">
          <span className="sk" style={{ width: 130, height: 14, marginBottom: 14 }} />
          <div className="home-list sk-list">
            {[0, 1].map((i) => (
              <div key={i} className="hl-row">
                <span className="sk" style={{ width: 40, height: 12 }} />
                <span className="sk" style={{ width: 22, height: 22 }} />
                <span className="sk" style={{ width: 34, height: 42 }} />
                <span className="sk" style={{ flex: 1, height: 12, maxWidth: 260 }} />
              </div>
            ))}
          </div>
        </div>
      </div>
      <div className="home-feed">
        <span className="sk" style={{ width: 80, height: 14, marginBottom: 18 }} />
        {[0, 1, 2, 3, 4].map((i) => (
          <div key={i} className="sk-ev">
            <span className="sk" style={{ width: 28, height: 28, borderRadius: '50%' }} />
            <div style={{ flex: 1 }}>
              <span className="sk" style={{ width: '90%', height: 12 }} />
              <span className="sk" style={{ width: '40%', height: 10, marginTop: 8 }} />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ───────────────────────────── the page ─────────────────────────────

function summary(data: Overview): string {
  const pieces = new Set(data.awaiting.map((a) => a.piece_id)).size;
  const parts: string[] = [];
  if (pieces) parts.push(t(data.awaiting_mode === 'approve' ? 'home.summary.waiting' : 'home.summary.inReview', { count: pieces }));
  if (data.today.length) parts.push(t('home.summary.today', { count: data.today.length }));
  if (data.attention.length) parts.push(t('home.summary.attention', { count: data.attention.length }));
  if (!parts.length) return t('home.summary.calm');
  const text = list(parts);
  return `${text.charAt(0).toUpperCase()}${text.slice(1)}.`;
}

/** "For you": what is waiting for this person, what goes out today, what needs a hand, and what just happened. */
export function HomePage() {
  const { me, brand } = useSession();
  const { data, error, isLoading } = useQuery({
    queryKey: ['overview', brand.id],
    queryFn: () => api.get<Overview>(`/api/brands/${brand.id}/overview`),
    refetchInterval: 60_000,
  });
  const hour = new Date().getHours();
  const greet = hour < 14 ? 'home.morning' : hour < 21 ? 'home.afternoon' : 'home.evening';
  const name = firstName(me.user.name ?? me.user.email);
  return (
    <>
      <PageBar crumbs={[{ label: t('layout.nav.home') }]} />
      {isLoading && <Skeleton />}
      {error && <ErrorBox error={error} />}
      {data && (
        <div className="home">
          <div className="home-main">
            <header className="home-hello">
              <h1>{t(greet, { name })}</h1>
              <p>{summary(data)}</p>
            </header>
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
