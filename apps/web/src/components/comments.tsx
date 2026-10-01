import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { api, type Anchor, type CommentThread } from '../api';
import { fmtShort, fmtTime } from '../lib/format';
import { Dialog, ErrorBox, errorMessage, useToast } from './ui';

export function anchorLabel(a: Anchor | null): string {
  if (!a) return 'General';
  if (a.type === 'time') return a.t_end !== undefined ? `${fmtTime(a.t)} – ${fmtTime(a.t_end)}` : fmtTime(a.t);
  return a.w === 0 && a.h === 0 ? `Page ${a.page} · point` : `Page ${a.page} · area`;
}

const REPLY_LABEL = { fixed: 'Fixed', cannot_do: 'Cannot do', needs_human: 'Needs a person' } as const;

function Thread({ c, focus, canReply, canResolve, canReopen, onJump, onFocus, versionId }: {
  c: CommentThread;
  focus: string | null;
  canReply: boolean;
  canResolve: boolean;
  canReopen: boolean;
  onJump: (c: CommentThread) => void;
  onFocus: (id: string | null) => void;
  versionId: string;
}) {
  const qc = useQueryClient();
  const toast = useToast();
  const el = useRef<HTMLDivElement>(null);
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
  const toggle = useMutation({
    mutationFn: () => api.post(`/api/comments/${c.id}/${c.status === 'open' ? 'resolve' : 'reopen'}`),
    onSuccess: refresh,
    onError: (e) => toast(errorMessage(e), 'error'),
  });
  useEffect(() => {
    if (focus === c.id) el.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [focus, c.id]);

  return (
    <div ref={el} className={`thread ${c.status} ${focus === c.id ? 'focus' : ''}`} onClick={() => onFocus(c.id)}>
      <div className="thread-head">
        {c.anchor ? (
          <button className="anchor-chip" onClick={(e) => { e.stopPropagation(); onJump(c); }} title="Go to this place">{anchorLabel(c.anchor)}</button>
        ) : (
          <span className="chip">General</span>
        )}
        <strong>{c.author}</strong>
        <span className="muted small">{fmtShort(c.created_at)}</span>
        {c.carried && c.status === 'open' && <span className="chip chip-changes_requested" title="Raised on an earlier version and still open">still open from v{c.version_number}</span>}
        {c.status === 'resolved' && (
          <span className="chip chip-approved">{c.resolved_in_number ? `resolved in v${c.resolved_in_number}` : `resolved${c.resolved_by ? ` by ${c.resolved_by}` : ''}`}</span>
        )}
      </div>
      {c.frame_url && <img className="frame-thumb" src={c.frame_url} alt="Frame this comment points at" loading="lazy" onClick={(e) => { e.stopPropagation(); setZoom(true); }} />}
      <p style={{ whiteSpace: 'pre-wrap', margin: 0 }}>{c.body}</p>
      {c.replies.map((r) => (
        <div key={r.id} className={`reply ${r.by_agent ? 'agent' : ''}`}>
          <div className="muted small">
            <strong>{r.author}</strong>{r.by_agent && ' (agent)'} · {fmtShort(r.created_at)}
            {r.reply_kind && <> · <span className={`chip ${r.reply_kind === 'fixed' ? 'chip-approved' : 'chip-changes_requested'}`}>{REPLY_LABEL[r.reply_kind]}</span></>}
          </div>
          <div style={{ whiteSpace: 'pre-wrap' }}>{r.body}</div>
        </div>
      ))}
      {(() => {
        const resolveBtn =
          (c.status === 'open' && canResolve) || (c.status === 'resolved' && canReopen) ? (
            <button type="button" className="btn btn-small" onClick={() => toggle.mutate()} disabled={toggle.isPending}>{c.status === 'open' ? 'Resolve' : 'Reopen'}</button>
          ) : null;
        if (canReply && c.status === 'open') {
          return (
            <form className="row" style={{ marginTop: '.5rem' }} onClick={(e) => e.stopPropagation()} onSubmit={(e) => { e.preventDefault(); if (reply.trim()) send.mutate(); }}>
              <input type="text" aria-label="Reply" placeholder="Reply…" value={reply} onChange={(e) => setReply(e.target.value)} style={{ flex: '1 1 100%' }} />
              <select aria-label="Reply type" value={kind} onChange={(e) => setKind(e.target.value)} style={{ width: 'auto', flex: '1 1 auto' }}>
                <option value="">Just a reply</option>
                <option value="fixed">Fixed</option>
                <option value="cannot_do">Cannot do</option>
                <option value="needs_human">Needs a person</option>
              </select>
              <button className="btn btn-small" disabled={!reply.trim() || send.isPending}>Send</button>
              {resolveBtn}
            </form>
          );
        }
        return resolveBtn && <div className="row" style={{ marginTop: '.5rem' }} onClick={(e) => e.stopPropagation()}>{resolveBtn}</div>;
      })()}
      {zoom && c.frame_url && (
        <Dialog title="Frame" onClose={() => setZoom(false)} wide>
          <img src={c.frame_url} alt="Frame this comment points at" style={{ width: '100%', borderRadius: 8 }} />
        </Dialog>
      )}
    </div>
  );
}

export function CommentsPanel({ versionId, threads, draft, onClearDraft, canComment, canReply, canResolve, canReopen, focus, onFocus, onJump, commentable }: {
  versionId: string;
  threads: CommentThread[];
  draft: Anchor | null;
  onClearDraft: () => void;
  canComment: boolean;
  canReply: boolean;
  canResolve: boolean;
  canReopen: boolean;
  focus: string | null;
  onFocus: (id: string | null) => void;
  onJump: (c: CommentThread) => void;
  /** False once the version is superseded: it no longer takes new comments. */
  commentable: boolean;
}) {
  const qc = useQueryClient();
  const toast = useToast();
  const [body, setBody] = useState('');
  const post = useMutation({
    mutationFn: () => api.post(`/api/versions/${versionId}/comments`, { body, anchor: draft }),
    onSuccess: () => {
      setBody('');
      onClearDraft();
      qc.invalidateQueries({ queryKey: ['comments', versionId] });
      qc.invalidateQueries({ queryKey: ['version', versionId] });
      qc.invalidateQueries({ queryKey: ['piece'] });
    },
  });
  const ordered = [...threads].sort((a, b) => {
    const ta = a.anchor?.type === 'time' ? a.anchor.t : Infinity;
    const tb = b.anchor?.type === 'time' ? b.anchor.t : Infinity;
    return a.version_number - b.version_number || ta - tb || a.created_at.localeCompare(b.created_at);
  });
  const open = ordered.filter((t) => t.status === 'open');
  const resolved = ordered.filter((t) => t.status === 'resolved');
  const card = (c: CommentThread) => (
    <Thread key={c.id} c={c} focus={focus} canReply={canReply} canResolve={canResolve} canReopen={canReopen} onJump={onJump} onFocus={onFocus} versionId={versionId} />
  );
  return (
    <div className="stack">
      {canComment && commentable && (
        <form className="stack" onSubmit={(e) => { e.preventDefault(); post.mutate(); }}>
          <div className="row">
            <span className="field-label">New comment</span>
            {draft ? (
              <>
                <span className="anchor-chip" style={{ cursor: 'default' }}>{anchorLabel(draft)}</span>
                <button type="button" className="btn btn-small" onClick={onClearDraft}>Remove anchor</button>
              </>
            ) : (
              <span className="muted small">General · or pick a moment or area on the left</span>
            )}
          </div>
          <textarea aria-label="Comment" value={body} onChange={(e) => setBody(e.target.value)} placeholder="What should change?" />
          {post.error && <ErrorBox error={post.error} />}
          <button className="btn btn-primary" disabled={!body.trim() || post.isPending} onClick={() => post.error && toast('Retrying…')}>Post comment</button>
        </form>
      )}
      <div>
        <h3>Open ({open.length})</h3>
        <div className="stack" style={{ marginTop: '.5rem' }}>
          {open.length === 0 ? <p className="muted">Nothing open.</p> : open.map(card)}
        </div>
      </div>
      {resolved.length > 0 && (
        <details>
          <summary style={{ cursor: 'pointer', fontWeight: 600 }}>Resolved ({resolved.length})</summary>
          <div className="stack" style={{ marginTop: '.5rem' }}>{resolved.map(card)}</div>
        </details>
      )}
    </div>
  );
}
