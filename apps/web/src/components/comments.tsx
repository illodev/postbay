import { useMutation, useQueryClient } from '@tanstack/react-query';
import { DateTime } from 'luxon';
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { api, type Anchor, type CommentThread } from '../api';
import { t } from '../i18n';
import { playhead } from '../lib/playhead';
import { Dialog, ErrorBox, errorMessage, useToast } from './ui';
import { liveVideo, round2, shortName, shortTimecode, timecode } from './viewer';

export function anchorLabel(a: Anchor | null): string {
  if (!a) return t('review.anchor.general');
  if (a.type === 'time' && a.cue !== undefined) return t('review.anchor.cue', { n: a.cue + 1, time: shortTimecode(a.t) });
  if (a.type === 'time') return a.t_end !== undefined ? `${shortTimecode(a.t)}–${shortTimecode(a.t_end)}` : shortTimecode(a.t);
  return a.w === 0 && a.h === 0 ? t('review.anchor.point', { page: a.page }) : t('review.anchor.area', { page: a.page });
}

/** How long ago, as short as it can be said: "3 min", "2 h", "4 d", then the date. */
export function ago(iso: string): string {
  const then = DateTime.fromISO(iso);
  const mins = Math.floor(-then.diffNow('minutes').minutes);
  if (mins < 1) return t('review.ago.now');
  if (mins < 60) return t('review.ago.min', { n: mins });
  if (mins < 24 * 60) return t('review.ago.h', { n: Math.floor(mins / 60) });
  if (mins < 7 * 24 * 60) return t('review.ago.d', { n: Math.floor(mins / 1440) });
  return then.toFormat('d LLL');
}
const fullDate = (iso: string) => DateTime.fromISO(iso).toFormat('ccc d LLL yyyy, HH:mm');

/** The words of the subtitle line a comment is about, quoted, so the comment reads on its own. */
export function CueQuote({ anchor }: { anchor: Anchor | null }) {
  if (anchor?.type !== 'time' || anchor.cue === undefined || !anchor.cue_text) return null;
  return <blockquote className="cue-quote" data-testid="cue-quote">“{anchor.cue_text}”</blockquote>;
}

/** Threads in the order the list shows them: earlier versions first, then by moment, then by when they were written. */
export function orderThreads(threads: CommentThread[]) {
  const ordered = [...threads].sort((a, b) => {
    const ta = a.anchor?.type === 'time' ? a.anchor.t : Infinity;
    const tb = b.anchor?.type === 'time' ? b.anchor.t : Infinity;
    return a.version_number - b.version_number || ta - tb || a.created_at.localeCompare(b.created_at);
  });
  return { open: ordered.filter((c) => c.status === 'open'), resolved: ordered.filter((c) => c.status === 'resolved') };
}

/**
 * The number each open thread with a place carries, on its card and on its mark over the picture or the timeline. Numbers are
 * for what still needs doing, in the order of the list; resolved threads keep their mark, dimmed and without a number.
 */
export function numberThreads(threads: CommentThread[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const c of orderThreads(threads).open) if (c.anchor) m.set(c.id, m.size + 1);
  return m;
}

/** The thread being said right now: the latest whose moment (or span) holds the playhead. */
function threadAt(threads: CommentThread[], now: number): string | null {
  let best: CommentThread | null = null;
  for (const c of threads) {
    const a = c.anchor;
    if (a?.type !== 'time') continue;
    const end = a.t_end ?? a.t + 2.5;
    if (a.t <= now + 0.05 && now < end && (!best || (best.anchor as { t: number }).t <= a.t)) best = c;
  }
  return best?.id ?? null;
}

const REPLY_KINDS = ['fixed', 'cannot_do', 'needs_human'] as const;
const replyKindLabel = (k: (typeof REPLY_KINDS)[number]) =>
  k === 'fixed' ? t('review.reply.kind.fixed') : k === 'cannot_do' ? t('review.reply.kind.cannotDo') : t('review.reply.kind.needsHuman');

const IconPeople = () => (
  <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <circle cx="9" cy="8" r="3.5" /><path d="M2.5 20a6.5 6.5 0 0 1 13 0M16 4.5a3.5 3.5 0 0 1 0 7M18 14a6.5 6.5 0 0 1 3.5 6" />
  </svg>
);

function Thread({ c, n, focus, playing, canReply, canResolve, canReopen, onJump, versionId }: {
  c: CommentThread;
  n: number | undefined;
  focus: string | null;
  /** The thread whose moment the video is at. */
  playing: boolean;
  canReply: boolean;
  canResolve: boolean;
  canReopen: boolean;
  onJump: (c: CommentThread) => void;
  versionId: string;
}) {
  const qc = useQueryClient();
  const toast = useToast();
  const el = useRef<HTMLElement>(null);
  const [replying, setReplying] = useState(false);
  const [reply, setReply] = useState('');
  const [kind, setKind] = useState('');
  const [zoom, setZoom] = useState(false);
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['comments', versionId] });
    qc.invalidateQueries({ queryKey: ['version', versionId] });
    qc.invalidateQueries({ queryKey: ['piece'] });
  };
  const send = useMutation({
    mutationFn: () => api.post(`/api/comments/${c.id}/replies`, { body: reply, ...(kind ? { kind } : {}) }),
    onSuccess: () => { setReply(''); setKind(''); setReplying(false); refresh(); },
    onError: (e) => toast(errorMessage(e), 'error'),
  });
  const mark = useMutation({
    mutationFn: () => api.post(`/api/comments/${c.id}/people-only`, { value: !c.people_only }),
    onSuccess: refresh,
    onError: (e) => toast(errorMessage(e), 'error'),
  });
  const toggle = useMutation({
    mutationFn: () => api.post(`/api/comments/${c.id}/${c.status === 'open' ? 'resolve' : 'reopen'}`),
    onSuccess: refresh,
    onError: (e) => toast(errorMessage(e), 'error'),
  });
  useEffect(() => {
    if (focus === c.id || playing) el.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [focus, playing, c.id]);

  const open = c.status === 'open';
  const canToggle = (open && canResolve) || (!open && canReopen);
  const canMark = open && canReopen;
  const canAnswer = canReply && open;
  const peopleLabel = c.people_only ? t('review.thread.letAgent') : t('review.thread.makePeopleOnly');

  return (
    <article
      ref={el}
      data-thread={c.id}
      className={`thread rv-thread ${c.status} ${focus === c.id ? 'focus' : ''} ${playing ? 'now' : ''}`}
      onClick={() => onJump(c)}
    >
      <header className="thread-head">
        {n !== undefined && <span className="rv-num" aria-label={t('review.thread.number', { n })}>{n}</span>}
        {c.anchor ? (
          <button type="button" className="anchor-chip" onClick={(e) => { e.stopPropagation(); onJump(c); }} title={t('review.thread.goTo')}>{anchorLabel(c.anchor)}</button>
        ) : (
          <span className="tag">{t('review.anchor.general')}</span>
        )}
        <strong className="rv-author" title={c.author}>{shortName(c.author)}</strong>
        <span className="rv-ver mono">v{c.version_number}</span>
        <span className="grow" />
        <time className="rv-when" dateTime={c.created_at} title={fullDate(c.created_at)}>{ago(c.created_at)}</time>
      </header>
      {(canAnswer || canToggle || canMark) && (
        <div className="rv-actions" onClick={(e) => e.stopPropagation()}>
          {canAnswer && <button type="button" className="rv-act" onClick={() => setReplying(true)}>{t('review.thread.reply')}</button>}
          {canToggle && (
            <button type="button" className="rv-act" onClick={() => toggle.mutate()} disabled={toggle.isPending}>
              {open ? t('review.thread.resolve') : t('review.thread.reopen')}
            </button>
          )}
          {canMark && (
            <button type="button" className={`rv-act rv-act-ic ${c.people_only ? 'on' : ''}`} onClick={() => mark.mutate()} disabled={mark.isPending} aria-label={peopleLabel} title={`${peopleLabel}. ${t('review.thread.peopleOnlyHint')}`}>
              <IconPeople />
            </button>
          )}
        </div>
      )}
      {(c.people_only || (c.carried && open) || !open) && (
        <div className="rv-flags">
          {c.people_only && <span className="chip chip-on_hold" title={t('review.thread.peopleOnlyHint')}>{t('review.thread.peopleOnly')}</span>}
          {c.carried && open && <span className="chip chip-changes_requested" title={t('review.thread.carriedHint')}>{t('review.thread.carried', { n: c.version_number })}</span>}
          {!open && (
            <span className="chip chip-approved">
              {c.resolved_in_number ? t('review.thread.resolvedIn', { n: c.resolved_in_number }) : c.resolved_by ? t('review.thread.resolvedBy', { name: shortName(c.resolved_by) }) : t('review.thread.resolved')}
            </span>
          )}
        </div>
      )}
      <CueQuote anchor={c.anchor} />
      <div className="rv-body-row">
        <p className="rv-body">{c.body}</p>
        {c.frame_url && (
          <img
            className="frame-thumb"
            src={c.frame_url}
            alt={t('review.thread.frameAlt')}
            title={t('review.thread.frameZoom')}
            loading="lazy"
            onClick={(e) => { e.stopPropagation(); setZoom(true); }}
          />
        )}
      </div>
      {c.replies.map((r) => (
        <p key={r.id} className={`reply ${r.by_agent ? 'agent' : ''}`}>
          <span className="who" title={`${r.author} · ${fullDate(r.created_at)}`}>{shortName(r.author)}</span>
          {r.by_agent && <span className="sr-only"> {t('review.thread.agentSuffix')}</span>}
          {r.reply_kind && <> <span className={`chip ${r.reply_kind === 'fixed' ? 'chip-approved' : 'chip-changes_requested'}`}>{replyKindLabel(r.reply_kind)}</span></>}
          <span className="rv-sep" aria-hidden="true"> · </span>
          <span className="rv-reply-body">{r.body}</span>
        </p>
      ))}
      {replying && canAnswer && (
        <form
          className="rv-reply-form"
          onClick={(e) => e.stopPropagation()}
          onSubmit={(e) => { e.preventDefault(); if (reply.trim()) send.mutate(); }}
        >
          <input
            type="text"
            className="rv-reply-input"
            autoFocus
            aria-label={t('review.reply.label')}
            placeholder={t('review.reply.placeholder')}
            value={reply}
            onChange={(e) => setReply(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Escape') { e.preventDefault(); setReplying(false); } }}
          />
          <div className="rv-reply-row">
            <select className="rv-select" aria-label={t('review.reply.typeLabel')} value={kind} onChange={(e) => setKind(e.target.value)}>
              <option value="">{t('review.reply.kind.plain')}</option>
              {REPLY_KINDS.map((k) => <option key={k} value={k}>{replyKindLabel(k)}</option>)}
            </select>
            <span className="grow" />
            <button type="button" className="btn btn-ghost btn-small" onClick={() => setReplying(false)}>{t('common.cancel')}</button>
            <button className="btn btn-primary btn-small" disabled={!reply.trim() || send.isPending}>{t('review.reply.send')}</button>
          </div>
        </form>
      )}
      {zoom && c.frame_url && (
        <Dialog title={t('review.thread.frameTitle')} onClose={() => setZoom(false)} wide>
          <img src={c.frame_url} alt={t('review.thread.frameAlt')} className="rv-frame-big" />
        </Dialog>
      )}
    </article>
  );
}

/** What the comment box suggests, by what is on the stage. */
export type ComposeHint = 'video' | 'image' | 'pdf' | 'none';
type Filter = 'all' | 'open' | 'resolved' | 'mine';

/**
 * The comment threads of a version and the box to start a new one. It renders three blocks — the filters, the list (which
 * scrolls) and the box (which the review page pins under it) — so the page decides where each goes. While a video plays, the
 * thread at the playhead lights up and comes into view.
 */
export function CommentsPanel({ versionId, threads, numbers, me, draft, onDraft, onClearDraft, onHold, canComment, canReply, canResolve, canReopen, focus, onJump, commentable, hint }: {
  versionId: string;
  threads: CommentThread[];
  numbers: Map<string, number>;
  /** How the signed-in person appears as an author, for "mine". */
  me: string;
  draft: Anchor | null;
  onDraft: (a: Anchor) => void;
  onClearDraft: () => void;
  /** Stops the video where it is, when someone starts writing about the current moment. */
  onHold: () => void;
  canComment: boolean;
  canReply: boolean;
  canResolve: boolean;
  canReopen: boolean;
  focus: string | null;
  onJump: (c: CommentThread) => void;
  /** False once the version is superseded: it no longer takes new comments. */
  commentable: boolean;
  hint: ComposeHint;
}) {
  const qc = useQueryClient();
  const toast = useToast();
  const [body, setBody] = useState('');
  const [peopleOnly, setPeopleOnly] = useState(false);
  const [filter, setFilter] = useState<Filter>('all');
  const [showResolved, setShowResolved] = useState(false);
  // On a video, a new comment goes to the current moment unless it is made general.
  const [anchorMode, setAnchorMode] = useState<'moment' | 'general'>('moment');
  const box = useRef<HTMLTextAreaElement>(null);
  const video = hint === 'video';
  const now = useSyncExternalStore(playhead.subscribe, () => (video ? Math.round(playhead.t * 10) / 10 : 0));
  const atMoment = !draft && video && anchorMode === 'moment' && now > 0;

  const post = useMutation({
    mutationFn: (anchor: Anchor | null) => api.post(`/api/versions/${versionId}/comments`, { body, anchor, peopleOnly }),
    onSuccess: () => {
      setBody('');
      setPeopleOnly(false);
      onClearDraft();
      qc.invalidateQueries({ queryKey: ['comments', versionId] });
      qc.invalidateQueries({ queryKey: ['version', versionId] });
      qc.invalidateQueries({ queryKey: ['piece'] });
    },
  });

  const isMine = (c: CommentThread) => c.author === me;
  const { open, resolved } = orderThreads(filter === 'mine' ? threads.filter(isMine) : threads);
  const counts = {
    open: threads.filter((c) => c.status === 'open').length,
    resolved: threads.filter((c) => c.status === 'resolved').length,
    all: threads.length,
    mine: threads.filter(isMine).length,
  };
  const listed = filter === 'resolved' ? resolved : filter === 'open' ? open : [...open, ...(showResolved ? resolved : [])];
  const current = useSyncExternalStore(playhead.subscribe, () => (video ? threadAt(listed, playhead.t) : null));

  // A new place to comment on puts the cursor in the box, ready to write.
  const hadDraft = useRef(false);
  useEffect(() => {
    if (draft && !hadDraft.current) {
      box.current?.focus({ preventScroll: true });
      box.current?.closest('form')?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
    hadDraft.current = !!draft;
  }, [draft]);

  // A thread chosen on the picture is always shown, whatever the filter.
  useEffect(() => {
    if (!focus) return;
    const c = threads.find((x) => x.id === focus);
    if (!c) return;
    if (c.status === 'resolved' && filter === 'open') setFilter('all');
    if (c.status === 'open' && filter === 'resolved') setFilter('all');
    if (filter === 'mine' && !isMine(c)) setFilter('all');
    if (c.status === 'resolved') setShowResolved(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focus]);

  const card = (c: CommentThread) => (
    <Thread key={c.id} c={c} n={numbers.get(c.id)} focus={focus} playing={current === c.id} canReply={canReply} canResolve={canResolve} canReopen={canReopen} onJump={onJump} versionId={versionId} />
  );
  const placeholder = draft || atMoment
    ? t('review.compose.placeholderAnchored')
    : video ? t('review.compose.placeholderVideo')
    : hint === 'image' ? t('review.compose.placeholderImage')
    : hint === 'pdf' ? t('review.compose.placeholderPdf')
    : t('review.compose.placeholderGeneral');
  const submit = () => {
    if (!body.trim() || post.isPending) return;
    if (post.error) toast(t('review.compose.retrying'));
    post.mutate(draft ?? (atMoment ? { type: 'time', t: round2(playhead.t), position: liveVideo.position } : null));
  };
  const chips: [Filter, string, number][] = [
    ['all', t('review.filter.all'), counts.all],
    ['open', t('review.filter.open'), counts.open],
    ['resolved', t('review.filter.resolved'), counts.resolved],
    ['mine', t('review.filter.mine'), counts.mine],
  ];
  const empty = filter === 'open' ? t('review.list.nothingOpen')
    : filter === 'resolved' ? t('review.list.nothingResolved')
    : filter === 'mine' ? t('review.list.nothingMine')
    : t('review.list.nothing');

  return (
    <>
      <div className="rv-filters" role="group" aria-label={t('review.filter.label')}>
        {chips.map(([f, label, count]) => (
          <button key={f} type="button" className="rv-filter" aria-pressed={filter === f} onClick={() => setFilter(f)}>
            {label} <span className="rv-filter-n">{count}</span>
          </button>
        ))}
      </div>
      <div className="rv-scroll rv-threads">
        {filter === 'resolved'
          ? (resolved.length ? resolved.map(card) : <p className="muted rv-none">{empty}</p>)
          : (
            <>
              {open.length ? open.map(card) : <p className="muted rv-none">{resolved.length && filter !== 'open' ? t('review.list.nothingOpen') : empty}</p>}
              {filter !== 'open' && resolved.length > 0 && (
                <details className="rv-resolved" open={showResolved} onToggle={(e) => setShowResolved(e.currentTarget.open)}>
                  <summary>{t('review.list.resolved', { count: resolved.length })}</summary>
                  <div className="rv-resolved-list">{resolved.map(card)}</div>
                </details>
              )}
            </>
          )}
      </div>
      {canComment && commentable && (
        <form className={`rv-compose ${body.trim() || draft ? 'active' : ''}`} onSubmit={(e) => { e.preventDefault(); submit(); }}>
          <div className="rv-anchor-row">
            {draft ? (
              <>
                <span className="anchor-chip static">{anchorLabel(draft)}</span>
                <button type="button" className="rv-x" onClick={onClearDraft} aria-label={t('review.compose.removeAnchor')} title={t('review.compose.removeAnchor')}>×</button>
              </>
            ) : atMoment ? (
              <>
                <button type="button" className="anchor-chip live" onClick={() => setAnchorMode('general')} title={t('review.compose.momentHint')}>{timecode(now)}</button>
                <button type="button" className="rv-x" onClick={() => setAnchorMode('general')} aria-label={t('review.compose.makeGeneral')} title={t('review.compose.makeGeneral')}>×</button>
              </>
            ) : video ? (
              <button
                type="button"
                className="tag rv-general"
                onClick={() => {
                  setAnchorMode('moment');
                  if (now === 0) onDraft({ type: 'time', t: 0, position: liveVideo.position });
                }}
                title={t('review.compose.toMoment')}
              >
                {t('review.anchor.general')}
              </button>
            ) : (
              <span className="tag">{t('review.anchor.general')}</span>
            )}
            {(draft || atMoment) && <span className="rv-anchor-say">{t('review.compose.anchored')}</span>}
            <span className="grow" />
            <span className="rv-keyhint">{t('review.compose.keys')}</span>
          </div>
          <CueQuote anchor={draft} />
          <textarea
            ref={box}
            aria-label={t('review.compose.label')}
            value={body}
            rows={2}
            onChange={(e) => setBody(e.target.value)}
            onFocus={() => { if (atMoment) onHold(); }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); submit(); }
              if (e.key === 'Escape') { e.preventDefault(); if (draft) onClearDraft(); else e.currentTarget.blur(); }
            }}
            placeholder={placeholder}
          />
          <div className="rv-compose-extra">
            <label className="check small">
              <input type="checkbox" checked={peopleOnly} onChange={(e) => setPeopleOnly(e.target.checked)} />
              <span>{t('review.compose.peopleOnly')} <span className="muted">{t('review.compose.peopleOnlyHint')}</span></span>
            </label>
            <button className="btn btn-primary btn-small" disabled={!body.trim() || post.isPending}>{t('review.compose.post')}</button>
          </div>
          {post.error && <ErrorBox error={post.error} />}
        </form>
      )}
      {canComment && !commentable && <p className="rv-compose rv-closed muted small">{t('review.compose.closed')}</p>}
    </>
  );
}
