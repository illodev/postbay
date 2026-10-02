import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { api, type Anchor, type CommentThread } from '../api';
import { t } from '../i18n';
import { fmtShort } from '../lib/format';
import { Dialog, ErrorBox, errorMessage, useToast } from './ui';
import { shortTimecode } from './viewer';

export function anchorLabel(a: Anchor | null): string {
  if (!a) return t('review.anchor.general');
  if (a.type === 'time' && a.cue !== undefined) return t('review.anchor.cue', { n: a.cue + 1, time: shortTimecode(a.t) });
  if (a.type === 'time') return a.t_end !== undefined ? `${shortTimecode(a.t)}–${shortTimecode(a.t_end)}` : shortTimecode(a.t);
  return a.w === 0 && a.h === 0 ? t('review.anchor.point', { page: a.page }) : t('review.anchor.area', { page: a.page });
}

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

const REPLY_KINDS = ['fixed', 'cannot_do', 'needs_human'] as const;
const replyKindLabel = (k: (typeof REPLY_KINDS)[number]) =>
  k === 'fixed' ? t('review.reply.kind.fixed') : k === 'cannot_do' ? t('review.reply.kind.cannotDo') : t('review.reply.kind.needsHuman');

function Thread({ c, n, focus, canReply, canResolve, canReopen, onJump, versionId }: {
  c: CommentThread;
  n: number | undefined;
  focus: string | null;
  canReply: boolean;
  canResolve: boolean;
  canReopen: boolean;
  onJump: (c: CommentThread) => void;
  versionId: string;
}) {
  const qc = useQueryClient();
  const toast = useToast();
  const el = useRef<HTMLElement>(null);
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
    onSuccess: () => { setReply(''); setKind(''); refresh(); },
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
    if (focus === c.id) el.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [focus, c.id]);

  const open = c.status === 'open';
  const resolveBtn = (open && canResolve) || (!open && canReopen) ? (
    <button type="button" className="btn btn-ghost btn-small" onClick={() => toggle.mutate()} disabled={toggle.isPending}>
      {open ? t('review.thread.resolve') : t('review.thread.reopen')}
    </button>
  ) : null;
  const markBtn = open && canReopen ? (
    <button type="button" className="btn btn-ghost btn-small" onClick={() => mark.mutate()} disabled={mark.isPending} title={t('review.thread.peopleOnlyHint')}>
      {c.people_only ? t('review.thread.letAgent') : t('review.thread.makePeopleOnly')}
    </button>
  ) : null;
  const replying = canReply && open;

  return (
    <article ref={el} className={`thread rv-thread ${c.status} ${focus === c.id ? 'focus' : ''}`} onClick={() => onJump(c)}>
      <header className="thread-head">
        {n !== undefined && <span className="rv-num" aria-label={t('review.thread.number', { n })}>{n}</span>}
        {c.anchor ? (
          <button type="button" className="anchor-chip" onClick={(e) => { e.stopPropagation(); onJump(c); }} title={t('review.thread.goTo')}>{anchorLabel(c.anchor)}</button>
        ) : (
          <span className="tag">{t('review.anchor.general')}</span>
        )}
        <strong className="rv-author">{c.author}</strong>
        <span className="rv-ver mono">v{c.version_number}</span>
        <span className="grow" />
        <span className="rv-when">{fmtShort(c.created_at)}</span>
      </header>
      {(c.people_only || (c.carried && open) || !open) && (
        <div className="rv-flags">
          {c.people_only && <span className="chip chip-on_hold" title={t('review.thread.peopleOnlyHint')}>{t('review.thread.peopleOnly')}</span>}
          {c.carried && open && <span className="chip chip-changes_requested" title={t('review.thread.carriedHint')}>{t('review.thread.carried', { n: c.version_number })}</span>}
          {!open && (
            <span className="chip chip-approved">
              {c.resolved_in_number ? t('review.thread.resolvedIn', { n: c.resolved_in_number }) : c.resolved_by ? t('review.thread.resolvedBy', { name: c.resolved_by }) : t('review.thread.resolved')}
            </span>
          )}
        </div>
      )}
      <CueQuote anchor={c.anchor} />
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
      <p className="rv-body">{c.body}</p>
      {c.replies.map((r) => (
        <div key={r.id} className={`reply ${r.by_agent ? 'agent' : ''}`}>
          <div className="rv-reply-head">
            <span className="who">{r.author}</span>
            {r.by_agent && <span className="sr-only"> {t('review.thread.agentSuffix')}</span>}
            <span className="rv-when">{fmtShort(r.created_at)}</span>
            {r.reply_kind && <span className={`chip ${r.reply_kind === 'fixed' ? 'chip-approved' : 'chip-changes_requested'}`}>{replyKindLabel(r.reply_kind)}</span>}
          </div>
          <div className="rv-reply-body">{r.body}</div>
        </div>
      ))}
      {(replying || resolveBtn || markBtn) && (
        <form
          className="rv-thread-foot"
          onClick={(e) => e.stopPropagation()}
          onSubmit={(e) => { e.preventDefault(); if (reply.trim()) send.mutate(); }}
        >
          <div className="rv-foot-row">
            {replying ? (
              <input type="text" className="rv-reply-input" aria-label={t('review.reply.label')} placeholder={t('review.reply.placeholder')} value={reply} onChange={(e) => setReply(e.target.value)} />
            ) : <span className="grow" />}
            {resolveBtn}
            {markBtn}
          </div>
          {replying && reply.trim() && (
            <div className="rv-foot-row">
              <select className="rv-select" aria-label={t('review.reply.typeLabel')} value={kind} onChange={(e) => setKind(e.target.value)}>
                <option value="">{t('review.reply.kind.plain')}</option>
                {REPLY_KINDS.map((k) => <option key={k} value={k}>{replyKindLabel(k)}</option>)}
              </select>
              <span className="grow" />
              <button className="btn btn-primary btn-small" disabled={send.isPending}>{t('review.reply.send')}</button>
            </div>
          )}
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

/**
 * The comment threads of a version and the box to start a new one. It renders two blocks: the list (which scrolls) and the box
 * (which the review page pins under it), so the page decides where each goes.
 */
export function CommentsPanel({ versionId, threads, numbers, draft, onClearDraft, canComment, canReply, canResolve, canReopen, focus, onJump, commentable, hint }: {
  versionId: string;
  threads: CommentThread[];
  numbers: Map<string, number>;
  draft: Anchor | null;
  onClearDraft: () => void;
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
  const box = useRef<HTMLTextAreaElement>(null);
  const post = useMutation({
    mutationFn: () => api.post(`/api/versions/${versionId}/comments`, { body, anchor: draft, peopleOnly }),
    onSuccess: () => {
      setBody('');
      setPeopleOnly(false);
      onClearDraft();
      qc.invalidateQueries({ queryKey: ['comments', versionId] });
      qc.invalidateQueries({ queryKey: ['version', versionId] });
      qc.invalidateQueries({ queryKey: ['piece'] });
    },
  });
  const { open, resolved } = orderThreads(threads);
  const [showResolved, setShowResolved] = useState(false);

  // A new place to comment on puts the cursor in the box, ready to write.
  const hadDraft = useRef(false);
  useEffect(() => {
    if (draft && !hadDraft.current) {
      box.current?.focus({ preventScroll: true });
      box.current?.closest('form')?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
    hadDraft.current = !!draft;
  }, [draft]);

  // A resolved thread chosen on the picture opens the resolved list, so it can be seen.
  useEffect(() => {
    if (focus && resolved.some((c) => c.id === focus)) setShowResolved(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focus]);

  const card = (c: CommentThread) => (
    <Thread key={c.id} c={c} n={numbers.get(c.id)} focus={focus} canReply={canReply} canResolve={canResolve} canReopen={canReopen} onJump={onJump} versionId={versionId} />
  );
  const placeholder = draft
    ? t('review.compose.placeholderAnchored')
    : hint === 'video' ? t('review.compose.placeholderVideo')
    : hint === 'image' ? t('review.compose.placeholderImage')
    : hint === 'pdf' ? t('review.compose.placeholderPdf')
    : t('review.compose.placeholderGeneral');
  const submit = () => {
    if (!body.trim() || post.isPending) return;
    if (post.error) toast(t('review.compose.retrying'));
    post.mutate();
  };

  return (
    <>
      <div className="rv-scroll rv-threads">
        <h3 className="rv-list-h">{t('review.list.open', { count: open.length })}</h3>
        {open.length === 0 ? <p className="muted rv-none">{t('review.list.nothingOpen')}</p> : open.map(card)}
        {resolved.length > 0 && (
          <details className="rv-resolved" open={showResolved} onToggle={(e) => setShowResolved(e.currentTarget.open)}>
            <summary>{t('review.list.resolved', { count: resolved.length })}</summary>
            <div className="rv-resolved-list">{resolved.map(card)}</div>
          </details>
        )}
      </div>
      {canComment && commentable && (
        <form className={`rv-compose ${body.trim() || draft ? 'active' : ''}`} onSubmit={(e) => { e.preventDefault(); submit(); }}>
          {draft && (
            <div className="rv-draft">
              <span className="anchor-chip static">{anchorLabel(draft)}</span>
              <span className="muted small grow">{t('review.compose.anchored')}</span>
              <button type="button" className="btn btn-ghost btn-small" onClick={onClearDraft}>{t('review.compose.removeAnchor')}</button>
            </div>
          )}
          <CueQuote anchor={draft} />
          <textarea
            ref={box}
            aria-label={t('review.compose.label')}
            value={body}
            rows={2}
            onChange={(e) => setBody(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); submit(); } }}
            placeholder={placeholder}
          />
          <div className="rv-compose-extra">
            <label className="check small">
              <input type="checkbox" checked={peopleOnly} onChange={(e) => setPeopleOnly(e.target.checked)} />
              <span>{t('review.compose.peopleOnly')} <span className="muted">{t('review.compose.peopleOnlyHint')}</span></span>
            </label>
            <button className="btn btn-primary btn-small" disabled={!body.trim() || post.isPending} title={t('review.compose.postHint')}>{t('review.compose.post')}</button>
          </div>
          {post.error && <ErrorBox error={post.error} />}
        </form>
      )}
      {canComment && !commentable && <p className="rv-compose rv-closed muted small">{t('review.compose.closed')}</p>}
    </>
  );
}
