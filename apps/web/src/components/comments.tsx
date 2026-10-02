import { useMutation, useQueryClient } from '@tanstack/react-query';
import { DateTime } from 'luxon';
import { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { api, type Anchor, type CommentThread, type Shape } from '../api';
import { t } from '../i18n';
import { playhead } from '../lib/playhead';
import { Avatar } from './Avatar';
import type { Tool } from './Drawing';
import { Icon } from './icons';
import { Dialog, ErrorBox, errorMessage, Popover, Select, Tip, useToast } from './ui';
import { agentInThread, liveVideo, round2, shortName, shortTimecode, threadAt, timecode } from './viewer';

export function anchorLabel(a: Anchor | null, drawn = false): string {
  if (!a) return t('review.anchor.general');
  // A place marked by a drawing is just its page: the drawing says where on it.
  if (a.type === 'region' && (drawn || a.drawing?.length)) return t('review.anchor.page', { page: a.page });
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
 * The number each thread carries, #1, #2…, on its card and on its pin over the picture: by moment and by when it was written,
 * the way the list shows them, open or resolved, so a number never changes when a thread is resolved.
 */
export function numberThreads(threads: CommentThread[]): Map<string, number> {
  const m = new Map<string, number>();
  const ordered = [...threads].sort((a, b) => {
    const ta = a.anchor?.type === 'time' ? a.anchor.t : a.anchor?.type === 'region' ? a.anchor.page * 1000 : Infinity;
    const tb = b.anchor?.type === 'time' ? b.anchor.t : b.anchor?.type === 'region' ? b.anchor.page * 1000 : Infinity;
    return a.version_number - b.version_number || ta - tb || a.created_at.localeCompare(b.created_at);
  });
  for (const c of ordered) m.set(c.id, m.size + 1);
  return m;
}

const REPLY_KINDS = ['fixed', 'cannot_do', 'needs_human'] as const;
const replyKindLabel = (k: (typeof REPLY_KINDS)[number]) =>
  k === 'fixed' ? t('review.reply.kind.fixed') : k === 'cannot_do' ? t('review.reply.kind.cannotDo') : t('review.reply.kind.needsHuman');

/** Lower case and without accents, for a search that finds "Álvaro" when "alvaro" is typed. */
const fold = (s: string) => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();

const ResolveMark = () => (
  <svg viewBox="0 0 20 20" width="20" height="20" aria-hidden="true">
    <circle cx="10" cy="10" r="8.25" className="rv-res-ring" />
    <path d="M6.4 10.3l2.4 2.4 4.8-5" className="rv-res-check" />
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
  const drawn = !!c.anchor?.drawing?.length;
  const resolveLabel = open ? t('review.thread.resolve') : t('review.thread.reopen');

  return (
    <article
      ref={el}
      data-thread={c.id}
      className={`thread rv-thread ${c.status} ${focus === c.id ? 'focus' : ''} ${playing ? 'now' : ''}`}
      onClick={() => onJump(c)}
    >
      <header className="rv-th-h">
        <Avatar name={shortName(c.author)} size={24} />
        <strong className="rv-th-name" title={c.author}>{shortName(c.author)}</strong>
        <time className="rv-th-when" dateTime={c.created_at} title={fullDate(c.created_at)}>{ago(c.created_at)}</time>
        <span className="grow" />
        {canMark && (
          <Tip label={`${peopleLabel}. ${t('review.thread.peopleOnlyHint')}`}>
            <button
              type="button"
              className={`rv-th-act ${c.people_only ? 'on' : ''}`}
              onClick={(e) => { e.stopPropagation(); mark.mutate(); }}
              disabled={mark.isPending}
              aria-label={peopleLabel}
            >
              <Icon name="users" size={15} />
            </button>
          </Tip>
        )}
        <Tip label={canToggle ? resolveLabel : open ? t('review.thread.openState') : t('review.thread.resolved')}>
          <button
            type="button"
            className={`rv-resolve ${open ? '' : 'done'} ${canToggle ? '' : 'locked'}`}
            onClick={(e) => { e.stopPropagation(); if (canToggle && !toggle.isPending) toggle.mutate(); }}
            aria-disabled={!canToggle}
            aria-label={resolveLabel}
            aria-pressed={!open}
          >
            <ResolveMark />
          </button>
        </Tip>
      </header>
      <p className="rv-th-body">
        {c.anchor ? (
          <button type="button" className="tc rv-th-tc" onClick={(e) => { e.stopPropagation(); onJump(c); }} title={t('review.thread.goTo')}>
            {anchorLabel(c.anchor)}
          </button>
        ) : null}
        {drawn && <span className="rv-th-ink" title={t('review.thread.drawn')} aria-label={t('review.thread.drawn')}><Icon name="pen" size={11} /></span>}
        {c.body}
      </p>
      <CueQuote anchor={c.anchor} />
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
      {c.carried && open && c.frame_url && (
        <button type="button" className="rv-th-frame" onClick={(e) => { e.stopPropagation(); setZoom(true); }} title={t('review.thread.frameZoom')}>
          <img className="frame-thumb" src={c.frame_url} alt={t('review.thread.frameAlt')} loading="lazy" />
          <span>{t('review.thread.frameOf', { n: c.version_number })}</span>
        </button>
      )}
      {c.replies.map((r) => (
        <div key={r.id} className={`reply rv-reply ${r.by_agent ? 'agent' : ''}`}>
          <div className="rv-reply-h">
            {r.by_agent ? <Avatar agent size={18} /> : <Avatar name={shortName(r.author)} size={18} />}
            <span className="who" title={`${r.author} · ${fullDate(r.created_at)}`}>{r.by_agent ? t('review.thread.agent') : shortName(r.author)}</span>
            <time className="rv-th-when" dateTime={r.created_at}>{ago(r.created_at)}</time>
            {r.reply_kind && <span className={`chip ${r.reply_kind === 'fixed' ? 'chip-approved' : 'chip-changes_requested'}`}>{replyKindLabel(r.reply_kind)}</span>}
          </div>
          <p className="rv-reply-body">{r.body}</p>
        </div>
      ))}
      {replying && canAnswer ? (
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
            onKeyDown={(e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setReplying(false); } }}
          />
          <div className="rv-reply-row">
            <Select
              className="rv-kind"
              label={t('review.reply.typeLabel')}
              value={kind || 'plain'}
              onChange={(k) => setKind(k === 'plain' ? '' : k)}
              options={[{ value: 'plain', label: t('review.reply.kind.plain') }, ...REPLY_KINDS.map((k) => ({ value: k, label: replyKindLabel(k) }))]}
            />
            <span className="grow" />
            <button type="button" className="btn btn-ghost btn-small" onClick={() => setReplying(false)}>{t('common.cancel')}</button>
            <button className="btn btn-primary btn-small" disabled={!reply.trim() || send.isPending}>{t('review.reply.send')}</button>
          </div>
        </form>
      ) : (
        <footer className="rv-th-foot">
          {canAnswer && <button type="button" className="rv-th-reply" onClick={(e) => { e.stopPropagation(); setReplying(true); }}>{t('review.thread.reply')}</button>}
          <span className="grow" />
          {n !== undefined && <span className="rv-th-n" aria-label={t('review.thread.number', { n })}>#{n}</span>}
        </footer>
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

/** Which comments the list shows: by state, and narrowed by whatever else is ticked (all must hold) and the search. */
export interface CommentFilter {
  status: 'all' | 'open' | 'resolved';
  mine: boolean;
  drawn: boolean;
  agent: boolean;
  people: string[];
  q: string;
}
export const NO_FILTER: CommentFilter = { status: 'all', mine: false, drawn: false, agent: false, people: [], q: '' };

/** The filter menu, Frame.io style: the state as a choice, then what to narrow by, then people. */
function FilterMenu({ filter, onFilter, threads, isMine, count }: {
  filter: CommentFilter;
  onFilter: (f: CommentFilter) => void;
  threads: CommentThread[];
  isMine: (c: CommentThread) => boolean;
  count: number;
}) {
  const [open, setOpen] = useState(false);
  const people = useMemo(() => {
    const m = new Map<string, number>();
    for (const c of threads) m.set(c.author, (m.get(c.author) ?? 0) + 1);
    return [...m].sort((a, b) => b[1] - a[1]);
  }, [threads]);
  const statuses: [CommentFilter['status'], string, number][] = [
    ['all', t('review.filter.all'), threads.length],
    ['open', t('review.filter.open'), threads.filter((c) => c.status === 'open').length],
    ['resolved', t('review.filter.resolved'), threads.filter((c) => c.status === 'resolved').length],
  ];
  const narrows: ['mine' | 'drawn' | 'agent', string, number][] = [
    ['mine', t('review.filter.mine'), threads.filter(isMine).length],
    ['drawn', t('review.filter.drawn'), threads.filter((c) => c.anchor?.drawing?.length).length],
    ['agent', t('review.filter.agent'), threads.filter(agentInThread).length],
  ];
  const extra = (filter.mine ? 1 : 0) + (filter.drawn ? 1 : 0) + (filter.agent ? 1 : 0) + filter.people.length;
  const label = filter.status === 'open' ? t('review.filter.open') : filter.status === 'resolved' ? t('review.filter.resolved') : t('review.filter.allComments');
  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      width={270}
      label={t('review.filter.label')}
      className="rv-fmenu-pop"
      trigger={
        <button type="button" className="rv-fmenu-btn" aria-haspopup="dialog" aria-label={t('review.filter.label')}>
          <span className="rv-fmenu-l">{label}</span>
          <span className="rv-fmenu-n">({count})</span>
          {extra > 0 && <span className="rv-fmenu-x">+{extra}</span>}
          <Icon name="chevronDown" size={14} />
        </button>
      }
    >
      <div role="radiogroup" aria-label={t('review.filter.show')}>
        <div className="rv-pop-h">{t('review.filter.show')}</div>
        {statuses.map(([st, l, n]) => (
          <button key={st} type="button" role="radio" aria-checked={filter.status === st} className="rv-pop-item" onClick={() => onFilter({ ...filter, status: st })}>
            <span className={`rv-radio ${filter.status === st ? 'on' : ''}`} aria-hidden="true" />
            <span className="grow">{l}</span>
            <span className="rv-pop-n">{n}</span>
          </button>
        ))}
      </div>
      <div className="rv-pop-sep" />
      <div role="group" aria-label={t('review.filter.narrow')}>
        <div className="rv-pop-h">{t('review.filter.narrow')}</div>
        {narrows.map(([k, l, n]) => (
          <button key={k} type="button" role="checkbox" aria-checked={filter[k]} className="rv-pop-item" onClick={() => onFilter({ ...filter, [k]: !filter[k] })}>
            <Icon name={k === 'mine' ? 'user' : k === 'drawn' ? 'pen' : 'bot'} size={15} />
            <span className="grow">{l}</span>
            <span className="rv-pop-n">{n}</span>
            <span className={`rv-box ${filter[k] ? 'on' : ''}`} aria-hidden="true" />
          </button>
        ))}
      </div>
      {people.length > 1 && (
        <>
          <div className="rv-pop-sep" />
          <div role="group" aria-label={t('review.filter.people')}>
            <div className="rv-pop-h">{t('review.filter.people')}</div>
            {people.map(([name, n]) => {
              const on = filter.people.includes(name);
              return (
                <button
                  key={name}
                  type="button"
                  role="checkbox"
                  aria-checked={on}
                  className="rv-pop-item"
                  onClick={() => onFilter({ ...filter, people: on ? filter.people.filter((x) => x !== name) : [...filter.people, name] })}
                >
                  <Avatar name={shortName(name)} size={20} title="" />
                  <span className="grow rv-pop-name">{shortName(name)}</span>
                  <span className="rv-pop-n">{n}</span>
                  <span className={`rv-box ${on ? 'on' : ''}`} aria-hidden="true" />
                </button>
              );
            })}
          </div>
        </>
      )}
      {(extra > 0 || filter.status !== 'all') && (
        <>
          <div className="rv-pop-sep" />
          <button type="button" className="rv-pop-item rv-pop-clear" onClick={() => { onFilter({ ...NO_FILTER, q: filter.q }); setOpen(false); }}>
            {t('review.filter.clear')}
          </button>
        </>
      )}
    </Popover>
  );
}

/**
 * The comment threads of a version and the box to start a new one: the filters and the search, the list (which scrolls) and the
 * box (pinned under it). While a video plays, the thread at the playhead lights up and comes into view; the box follows the
 * playhead, so writing is commenting on the moment on screen unless it is made general.
 */
export function CommentsPanel({ versionId, threads, numbers, me, draft, onDraft, onClearDraft, onHold, canComment, canReply, canResolve, canReopen, focus, onJump, commentable, hint, filter, onFilter, sketch, tool, onTool, onPosted }: {
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
  filter: CommentFilter;
  onFilter: (f: CommentFilter) => void;
  /** The drawing that goes with the comment being written, and the tool drawing it. */
  sketch: Shape[];
  tool: Tool | null;
  onTool?: (t: Tool | null) => void;
  /** A comment was posted: it becomes the one in focus. */
  onPosted: (id?: string) => void;
}) {
  const qc = useQueryClient();
  const toast = useToast();
  const [body, setBody] = useState('');
  const [peopleOnly, setPeopleOnly] = useState(false);
  const [showResolved, setShowResolved] = useState(false);
  // With nothing open, the resolved threads are what there is to see: they start unfolded (once, when the list arrives).
  const unfolded = useRef(false);
  useEffect(() => {
    if (unfolded.current || !threads.length) return;
    unfolded.current = true;
    if (threads.every((c) => c.status === 'resolved')) setShowResolved(true);
  }, [threads]);
  const [searching, setSearching] = useState(!!filter.q);
  // On a video, a new comment goes to the current moment unless it is made general.
  const [anchorMode, setAnchorMode] = useState<'moment' | 'general'>('moment');
  const box = useRef<HTMLTextAreaElement>(null);
  const video = hint === 'video';
  const now = useSyncExternalStore(playhead.subscribe, () => (video ? Math.round(playhead.t * 10) / 10 : 0));
  const atMoment = !draft && video && anchorMode === 'moment';

  const post = useMutation({
    mutationFn: (anchor: Anchor | null) => api.post<{ id: string }>(`/api/versions/${versionId}/comments`, { body, anchor, peopleOnly }),
    onSuccess: (row) => {
      setBody('');
      setPeopleOnly(false);
      onClearDraft();
      onPosted(row?.id);
      qc.invalidateQueries({ queryKey: ['comments', versionId] });
      qc.invalidateQueries({ queryKey: ['version', versionId] });
      qc.invalidateQueries({ queryKey: ['piece'] });
    },
  });

  const isMine = (c: CommentThread) => c.author === me;
  const q = fold(filter.q.trim());
  const matches = (c: CommentThread) =>
    (!filter.mine || isMine(c))
    && (!filter.drawn || !!c.anchor?.drawing?.length)
    && (!filter.agent || agentInThread(c))
    && (!filter.people.length || filter.people.includes(c.author))
    && (!q || fold([c.body, c.author, ...c.replies.map((r) => `${r.body} ${r.author}`)].join(' ')).includes(q));
  const narrowed = threads.filter(matches);
  const { open, resolved } = orderThreads(narrowed);
  const count = filter.status === 'open' ? open.length : filter.status === 'resolved' ? resolved.length : narrowed.length;
  const listed = filter.status === 'resolved' ? resolved : filter.status === 'open' ? open : [...open, ...(showResolved || q ? resolved : [])];
  const current = useSyncExternalStore(playhead.subscribe, () => (video ? threadAt(listed, playhead.t) : null));

  // A new place to comment on puts the cursor in the box, ready to write. (The box is always in view: nothing scrolls.)
  const hadDraft = useRef(false);
  useEffect(() => {
    if (draft && !hadDraft.current) box.current?.focus({ preventScroll: true });
    hadDraft.current = !!draft;
  }, [draft]);

  // A thread chosen on the picture is always shown, whatever the filter.
  useEffect(() => {
    if (!focus) return;
    const c = threads.find((x) => x.id === focus);
    if (!c) return;
    const wrongState = (c.status === 'resolved' && filter.status === 'open') || (c.status === 'open' && filter.status === 'resolved');
    if (wrongState || !matches(c)) onFilter({ ...NO_FILTER });
    if (c.status === 'resolved') setShowResolved(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focus]);

  // The box grows with what is written, up to a few lines.
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  }, [body]);

  const card = (c: CommentThread) => (
    <Thread key={c.id} c={c} n={numbers.get(c.id)} focus={focus} playing={current === c.id} canReply={canReply} canResolve={canResolve} canReopen={canReopen} onJump={onJump} versionId={versionId} />
  );
  const placeholder = draft
    ? t('review.compose.placeholderAnchored')
    : atMoment ? t('review.compose.placeholderMoment')
    : video ? t('review.compose.placeholderGeneral')
    : hint === 'image' ? t('review.compose.placeholderImage')
    : hint === 'pdf' ? t('review.compose.placeholderPdf')
    : t('review.compose.placeholderGeneral');
  const submit = () => {
    if (!body.trim() || post.isPending) return;
    if (post.error) toast(t('review.compose.retrying'));
    const base: Anchor | null = draft ?? (atMoment ? { type: 'time', t: round2(playhead.t), position: liveVideo.position } : null);
    post.mutate(base && sketch.length ? { ...base, drawing: sketch } : base);
  };
  const empty = filter.status === 'open' ? t('review.list.nothingOpen')
    : filter.status === 'resolved' ? t('review.list.nothingResolved')
    : filter.mine && !filter.drawn && !filter.agent && !filter.people.length && !q ? t('review.list.nothingMine')
    : narrowed.length < threads.length || q ? t('review.list.nothingMatches')
    : t('review.list.nothing');
  const filtered = filter.mine || filter.drawn || filter.agent || filter.people.length > 0 || !!q;

  return (
    <>
      <div className="rv-filterbar">
        <FilterMenu filter={filter} onFilter={onFilter} threads={threads} isMine={isMine} count={count} />
        <span className="grow" />
        {filtered && (
          <button type="button" className="rv-ic rv-ic-sm" onClick={() => { onFilter({ ...NO_FILTER, status: filter.status }); setSearching(false); }} aria-label={t('review.filter.clear')} title={t('review.filter.clear')}>
            <Icon name="x" size={15} />
          </button>
        )}
        <button type="button" className={`rv-ic rv-ic-sm ${searching ? 'on' : ''}`} aria-pressed={searching} onClick={() => { if (searching) onFilter({ ...filter, q: '' }); setSearching((s) => !s); }} aria-label={t('review.filter.search')} title={t('review.filter.search')}>
          <Icon name="search" size={15} />
        </button>
      </div>
      {searching && (
        <div className="rv-search">
          <Icon name="search" size={14} />
          <input
            type="search"
            autoFocus
            aria-label={t('review.filter.search')}
            placeholder={t('review.filter.searchPlaceholder')}
            value={filter.q}
            onChange={(e) => onFilter({ ...filter, q: e.target.value })}
            onKeyDown={(e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onFilter({ ...filter, q: '' }); setSearching(false); } }}
          />
        </div>
      )}
      <div className="rv-scroll rv-threads">
        {filter.status === 'resolved'
          ? (resolved.length ? resolved.map(card) : <p className="rv-none">{empty}</p>)
          : (
            <>
              {open.length ? open.map(card) : <p className="rv-none">{resolved.length && filter.status !== 'open' ? t('review.list.nothingOpen') : empty}</p>}
              {filter.status === 'all' && resolved.length > 0 && (
                q ? resolved.map(card) : (
                  <details className="rv-resolved" open={showResolved} onToggle={(e) => setShowResolved(e.currentTarget.open)}>
                    <summary><Icon name="chevronRight" size={14} />{t('review.list.resolved', { count: resolved.length })}</summary>
                    <div className="rv-resolved-list">{resolved.map(card)}</div>
                  </details>
                )
              )}
            </>
          )}
      </div>
      {canComment && commentable && (
        <form className={`rv-compose ${body.trim() || draft || sketch.length ? 'active' : ''}`} onSubmit={(e) => { e.preventDefault(); submit(); }}>
          <div className="rv-compose-in">
            {draft ? (
              <span className="rv-anchor">
                <span className="tc">{anchorLabel(draft, sketch.length > 0)}</span>
                <button type="button" className="rv-x" onClick={onClearDraft} aria-label={t('review.compose.removeAnchor')} title={t('review.compose.removeAnchor')}><Icon name="x" size={12} /></button>
              </span>
            ) : atMoment ? (
              <button type="button" className="tc rv-tc-live" onClick={() => setAnchorMode('general')} title={t('review.compose.momentHint')}>{timecode(now, false)}</button>
            ) : null}
            {sketch.length > 0 && (
              <span className="rv-anchor rv-ink-chip" title={t('review.compose.drawingHint')}>
                <Icon name="pen" size={11} />{t('review.compose.drawing', { count: sketch.length })}
              </span>
            )}
            <textarea
              ref={box}
              aria-label={t('review.compose.label')}
              value={body}
              rows={1}
              onChange={(e) => setBody(e.target.value)}
              onFocus={() => { if (atMoment) onHold(); }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); submit(); }
                if (e.key === 'Escape') { e.preventDefault(); if (draft) onClearDraft(); else e.currentTarget.blur(); }
              }}
              placeholder={placeholder}
            />
          </div>
          <CueQuote anchor={draft} />
          <div className="rv-compose-bar">
            {video && (
              <Tip label={atMoment || draft ? t('review.compose.makeGeneral') : t('review.compose.toMoment')}>
                <button
                  type="button"
                  className={`rv-cb ${atMoment || draft?.type === 'time' ? 'on' : ''}`}
                  aria-pressed={atMoment || draft?.type === 'time'}
                  onClick={() => {
                    if (draft) { onClearDraft(); setAnchorMode('general'); return; }
                    setAnchorMode((m) => (m === 'moment' ? 'general' : 'moment'));
                  }}
                  aria-label={atMoment || draft ? t('review.compose.makeGeneral') : t('review.compose.toMoment')}
                >
                  <Icon name="clock" size={16} />
                </button>
              </Tip>
            )}
            {onTool && (
              <Tip label={t('review.draw.toggle')} shortcut="D">
                <button type="button" className="rv-cb rv-cb-pen" aria-pressed={!!tool} onClick={() => onTool(tool ? null : 'pen')} aria-label={t('review.draw.toggle')}>
                  <Icon name="pen" size={16} />
                </button>
              </Tip>
            )}
            <Tip label={`${t('review.compose.peopleOnly')} ${t('review.compose.peopleOnlyHint')}`}>
              <label className={`rv-cb rv-cb-check ${peopleOnly ? 'on warn' : ''}`}>
                <input type="checkbox" className="sr-only" checked={peopleOnly} onChange={(e) => setPeopleOnly(e.target.checked)} aria-label={`${t('review.compose.peopleOnly')} ${t('review.compose.peopleOnlyHint')}`} />
                <Icon name="users" size={16} />
              </label>
            </Tip>
            {peopleOnly && <span className="rv-cb-say">{t('review.compose.peopleOnly')}</span>}
            <span className="grow" />
            <Tip label={t('review.compose.post')} shortcut={t('review.keys.enter')}>
              <button className="rv-send" disabled={!body.trim() || post.isPending} aria-label={t('review.compose.post')}>
                <Icon name="send" size={15} />
              </button>
            </Tip>
          </div>
          {post.error && <ErrorBox error={post.error} />}
        </form>
      )}
      {canComment && !commentable && <p className="rv-compose rv-closed">{t('review.compose.closed')}</p>}
    </>
  );
}
