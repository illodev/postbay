import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, type Account, type Anchor, type CommentThread, type VersionDetail } from '../api';
import { CommentsPanel } from '../components/comments';
import { approvedAccountIds, ScheduleDialog } from '../components/publications';
import { Chip, CopyButton, Dialog, ErrorBox, Field, Spinner, useToast } from '../components/ui';
import { CompareStage, Stage, type Jump } from '../components/viewer';
import { fmtBytes, fmtDateTime, NETWORK_LABEL } from '../lib/format';
import { useSession } from '../lib/session';
import { useStableUrls } from '../lib/stableUrls';

const LIVE = ['in_review', 'changes_requested', 'approved'];

function DecisionDialog({ version, decision, openCount, onClose, onSeeComments }: {
  version: VersionDetail;
  decision: 'approve' | 'reject';
  openCount: number;
  onClose: () => void;
  onSeeComments: () => void;
}) {
  const qc = useQueryClient();
  const toast = useToast();
  const { brand } = useSession();
  const rules = version.brand.approval_rules;
  const { data: accounts } = useQuery({ queryKey: ['accounts', brand.id], queryFn: () => api.get<Account[]>(`/api/brands/${brand.id}/accounts`) });
  const usable = (accounts ?? []).filter((a) => a.status !== 'reconnect_required');
  const [picked, setPicked] = useState<Set<string> | null>(null);
  const chosen = picked ?? new Set(usable.length === 1 ? [usable[0]!.id] : []);
  const [checks, setChecks] = useState<Record<string, boolean>>({});
  const [note, setNote] = useState('');
  const approving = decision === 'approve';
  const send = useMutation({
    mutationFn: () => api.post(`/api/versions/${version.id}/approvals`, { decision, accountIds: [...chosen], checklist: checks, note }),
    onSuccess: () => {
      for (const k of ['version', 'comments', 'piece', 'pieces']) qc.invalidateQueries({ queryKey: [k] });
      toast(approving ? 'Approved' : 'Rejected: the producer has been asked for changes');
      onClose();
    },
  });
  const toggle = (id: string) => {
    const n = new Set(chosen);
    if (n.has(id)) n.delete(id); else n.add(id);
    setPicked(n);
  };
  const allChecked = rules.checklist.every((c) => checks[c]);
  const ready = approving ? chosen.size > 0 && allChecked && openCount === 0 : note.trim().length > 0;

  return (
    <Dialog title={approving ? `Approve version ${version.number}` : `Reject version ${version.number}`} onClose={onClose}>
      <form className="stack" onSubmit={(e) => { e.preventDefault(); send.mutate(); }}>
        {approving ? (
          <>
            <p className="muted">
              Your approval is tied to these exact files (fingerprint <span className="mono">{version.fingerprint.slice(0, 12)}</span>). If anything changes, it stops counting.
              {rules.required_approvals > 1 && <> This brand needs {rules.required_approvals} approvers.</>}
            </p>
            {openCount > 0 && (
              <div className="notice notice-warn" role="alert">
                {openCount} comment{openCount === 1 ? ' is' : 's are'} still open. Resolve {openCount === 1 ? 'it' : 'them'} before approving.{' '}
                <button type="button" className="btn btn-small" onClick={() => { onClose(); onSeeComments(); }}>See comments</button>
              </div>
            )}
            <fieldset style={{ border: '1px solid var(--border)', borderRadius: 8 }}>
              <legend className="field-label">Approve for these accounts</legend>
              <div className="stack">
                {usable.length === 0 && <span className="muted">No accounts yet. An admin adds them in Settings.</span>}
                {usable.map((a) => (
                  <label key={a.id} className="check">
                    <input type="checkbox" checked={chosen.has(a.id)} onChange={() => toggle(a.id)} />
                    <span>{NETWORK_LABEL[a.network] ?? a.network} · {a.display_name}</span>
                  </label>
                ))}
              </div>
            </fieldset>
            {rules.checklist.length > 0 && (
              <fieldset style={{ border: '1px solid var(--border)', borderRadius: 8 }}>
                <legend className="field-label">Checklist</legend>
                <div className="stack">
                  {rules.checklist.map((item) => (
                    <label key={item} className="check">
                      <input type="checkbox" checked={!!checks[item]} onChange={(e) => setChecks({ ...checks, [item]: e.target.checked })} />
                      <span>{item}</span>
                    </label>
                  ))}
                </div>
              </fieldset>
            )}
            <Field label="Note (optional)"><textarea value={note} onChange={(e) => setNote(e.target.value)} style={{ minHeight: 56 }} /></Field>
          </>
        ) : (
          <>
            <p className="muted">The producer gets this version back for changes. Say why.</p>
            <Field label="Reason"><textarea required autoFocus value={note} onChange={(e) => setNote(e.target.value)} /></Field>
          </>
        )}
        {send.error && <ErrorBox error={send.error} />}
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button className={`btn ${approving ? 'btn-primary' : 'btn-danger'}`} disabled={!ready || send.isPending}>{approving ? 'Approve' : 'Reject'}</button>
        </div>
      </form>
    </Dialog>
  );
}

function RequestChangesDialog({ version, openCount, onClose }: { version: VersionDetail; openCount: number; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [note, setNote] = useState('');
  const send = useMutation({
    mutationFn: () => api.post(`/api/versions/${version.id}/request-changes`, { note }),
    onSuccess: () => {
      for (const k of ['version', 'comments', 'piece', 'pieces']) qc.invalidateQueries({ queryKey: [k] });
      toast('Changes requested');
      onClose();
    },
  });
  return (
    <Dialog title="Request changes" onClose={onClose}>
      <form className="stack" onSubmit={(e) => { e.preventDefault(); send.mutate(); }}>
        <p className="muted">
          {openCount > 0
            ? `${openCount} open comment${openCount === 1 ? '' : 's'} will go back to the producer with the version.`
            : 'There are no open comments yet: write one here, or close this and comment on the exact place.'}
        </p>
        <Field label={openCount > 0 ? 'Add a general note (optional)' : 'What should change?'}>
          <textarea value={note} onChange={(e) => setNote(e.target.value)} />
        </Field>
        {send.error && <ErrorBox error={send.error} />}
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" disabled={send.isPending || (openCount === 0 && !note.trim())}>Request changes</button>
        </div>
      </form>
    </Dialog>
  );
}

export function ReviewPage() {
  const { versionId = '' } = useParams();
  const navigate = useNavigate();
  const { me, brand, can } = useSession();
  const [draft, setDraft] = useState<Anchor | null>(null);
  const [focus, setFocus] = useState<string | null>(null);
  const [jump, setJump] = useState<Jump | null>(null);
  const [tab, setTab] = useState<'comments' | 'details'>('comments');
  const [compareId, setCompareId] = useState('');
  const [dialog, setDialog] = useState<null | 'approve' | 'reject' | 'changes' | 'schedule'>(null);
  const stable = useStableUrls();

  const { data: v, error, isLoading } = useQuery({ queryKey: ['version', versionId], queryFn: () => api.get<VersionDetail>(`/api/versions/${versionId}`) });
  const { data: threads = [] } = useQuery({
    queryKey: ['comments', versionId],
    queryFn: () => api.get<CommentThread[]>(`/api/versions/${versionId}/comments?carried=true`),
  });
  const { data: other } = useQuery({
    queryKey: ['version', compareId],
    enabled: !!compareId,
    queryFn: () => api.get<VersionDetail>(`/api/versions/${compareId}`),
  });

  if (isLoading) return <Spinner />;
  if (error) return <ErrorBox error={error} />;
  if (!v) return null;

  const assets = v.assets.map((a) => ({ ...a, url: stable(a.id, a.url) }));
  const otherAssets = other?.assets.map((a) => ({ ...a, url: stable(a.id, a.url) }));
  const stableThreads = threads.map((t) => (t.frame_url ? { ...t, frame_url: stable(t.id, t.frame_url) } : t));
  const live = LIVE.includes(v.review_state);
  const openCount = stableThreads.filter((t) => t.status === 'open').length;
  const mine = v.approvals.find((a) => a.approver === (me.user.name ?? me.user.email) || a.approver === me.user.email);
  const isAuthor = v.author_user_id === me.user.id;
  const validApprovals = v.approvals.filter((a) => a.decision === 'approve' && a.matches_fingerprint).length;
  const required = v.brand.approval_rules.required_approvals;
  const jumpTo = (c: CommentThread) => {
    setFocus(c.id);
    if (c.version_id !== v.id) return;
    const a = c.anchor;
    if (a?.type === 'time') setJump({ nonce: Date.now(), t: a.t, position: a.position });
    else if (a?.type === 'region') setJump({ nonce: Date.now(), page: a.page });
  };

  return (
    <>
      <p className="small"><Link to={`/pieces/${v.piece.id}`}>← {v.piece.title}</Link></p>
      <div className="page-head">
        <div>
          <div className="row">
            <h1>{v.piece.title}</h1>
            <Chip state={v.review_state} />
          </div>
          <p className="muted small">
            {v.variant.format}{v.variant.style && ` · ${v.variant.style}`} · uploaded by {v.author ?? 'unknown'} · {fmtDateTime(v.created_at, v.brand.timezone)}
            {v.piece.ai_generated && ' · generated with AI'}
          </p>
        </div>
        <div className="row">
          <label className="row">
            <span className="small muted">Version</span>
            <select value={v.id} onChange={(e) => navigate(`/review/${e.target.value}`)} style={{ width: 'auto' }} aria-label="Version">
              {v.versions.map((x) => <option key={x.id} value={x.id}>v{x.number}{x.id === v.id ? ' (this one)' : ''}</option>)}
            </select>
          </label>
          {v.versions.length > 1 && (
            <label className="row">
              <span className="small muted">Compare with</span>
              <select value={compareId} onChange={(e) => setCompareId(e.target.value)} style={{ width: 'auto' }} aria-label="Compare with">
                <option value="">—</option>
                {v.versions.filter((x) => x.id !== v.id).map((x) => <option key={x.id} value={x.id}>v{x.number}</option>)}
              </select>
            </label>
          )}
        </div>
      </div>

      <div className="review">
        <div className="stack">
          {compareId && other && otherAssets ? (
            <CompareStage left={otherAssets} right={assets} leftLabel={`v${other.number}`} rightLabel={`v${v.number} (this one)`} />
          ) : (
            <Stage
              assets={assets}
              threads={stableThreads}
              draft={draft}
              onDraft={(a) => { setDraft(a); if (a) setTab('comments'); }}
              canAnnotate={can('comment') && live}
              focus={focus}
              onFocus={(id) => { setFocus(id); setTab('comments'); }}
              jump={jump}
            />
          )}
          {v.notes && <div className="card"><h3>What changed</h3><p style={{ whiteSpace: 'pre-wrap', margin: '.25rem 0 0' }}>{v.notes}</p></div>}
        </div>

        <div className="side">
          <div className="card stack">
            <div className="row-between">
              <strong>Decision</strong>
              {required > 1 && v.review_state === 'in_review' && <span className="muted small">{validApprovals} of {required} approvals</span>}
            </div>
            {v.review_state === 'in_review' && (
              <>
                {openCount > 0 && can('approve') && <div className="notice notice-warn" style={{ margin: 0 }}>{openCount} open comment{openCount === 1 ? '' : 's'} must be resolved before approving.</div>}
                <div className="row">
                  {can('requestChanges') && <button className="btn" onClick={() => setDialog('changes')}>Request changes</button>}
                  {can('approve') && (
                    <>
                      <button className="btn btn-primary" onClick={() => setDialog('approve')} disabled={isAuthor || !!mine}>Approve…</button>
                      <button className="btn btn-danger" onClick={() => setDialog('reject')} disabled={isAuthor || !!mine}>Reject…</button>
                    </>
                  )}
                </div>
                {can('approve') && isAuthor && <p className="muted small" style={{ margin: 0 }}>You uploaded this version, so someone else has to approve it.</p>}
                {can('approve') && mine && <p className="muted small" style={{ margin: 0 }}>You already {mine.decision === 'approve' ? 'approved' : 'rejected'} this version.</p>}
                {!can('requestChanges') && !can('approve') && <p className="muted small" style={{ margin: 0 }}>Waiting for the reviewers.</p>}
              </>
            )}
            {v.review_state === 'changes_requested' && <p className="muted" style={{ margin: 0 }}>Changes were requested. {can('upload') ? 'Upload a new version from the piece page.' : 'The producer will upload a new version.'}</p>}
            {v.review_state === 'approved' && (
              <>
                <p style={{ margin: 0 }}>Approved for {approvedAccountIds(v).length} account{approvedAccountIds(v).length === 1 ? '' : 's'}.</p>
                {can('schedule') && <button className="btn btn-primary" onClick={() => setDialog('schedule')}>Schedule…</button>}
                {!can('schedule') && <p className="muted small" style={{ margin: 0 }}>An approver schedules it.</p>}
              </>
            )}
            {v.review_state === 'superseded' && <p className="muted" style={{ margin: 0 }}>A newer version replaced this one. Its approval no longer counts.</p>}
            {v.review_state === 'discarded' && <p className="muted" style={{ margin: 0 }}>This piece was discarded.</p>}
          </div>

          <div>
            <div className="tabs" role="tablist">
              <button role="tab" aria-selected={tab === 'comments'} onClick={() => setTab('comments')}>Comments{openCount > 0 && <> <span className="badge-count">{openCount}</span></>}</button>
              <button role="tab" aria-selected={tab === 'details'} onClick={() => setTab('details')}>Details</button>
            </div>
            {tab === 'comments' ? (
              <CommentsPanel
                versionId={v.id}
                threads={stableThreads}
                draft={draft}
                onClearDraft={() => setDraft(null)}
                canComment={can('comment')}
                canReply={can('reply')}
                canResolve={can('resolve')}
                canReopen={can('comment')}
                focus={focus}
                onFocus={setFocus}
                onJump={jumpTo}
                commentable={live}
              />
            ) : (
              <div className="stack">
                <div className="card stack">
                  <h3>Approvals</h3>
                  {v.approvals.length === 0 && <p className="muted" style={{ margin: 0 }}>No decisions yet.</p>}
                  {v.approvals.map((a) => (
                    <div key={a.id}>
                      <strong>{a.approver}</strong> {a.decision === 'approve' ? 'approved' : 'rejected'}{' '}
                      <span className="muted small">{fmtDateTime(a.created_at, v.brand.timezone)}</span>
                      {!a.matches_fingerprint && <span className="chip chip-failed" style={{ marginLeft: 6 }}>files changed since</span>}
                      {a.note && <div className="muted small">“{a.note}”</div>}
                    </div>
                  ))}
                </div>
                <div className="card stack">
                  <div className="row-between"><h3>Fingerprint</h3><CopyButton text={v.fingerprint} /></div>
                  <span className="mono" style={{ wordBreak: 'break-all' }}>{v.fingerprint}</span>
                  <p className="muted small" style={{ margin: 0 }}>A hash of every file in this version. Approvals are tied to it: change a single byte and they stop counting.</p>
                </div>
                <div className="card stack">
                  <h3>Files</h3>
                  {v.assets.map((a) => (
                    <div key={a.id} className="row-between">
                      <span>{a.kind} · {a.name}<br /><span className="muted small">{fmtBytes(a.bytes)}{a.width && a.height ? ` · ${a.width}×${a.height}` : ''}{a.duration_ms ? ` · ${(a.duration_ms / 1000).toFixed(1)} s` : ''} · <span className="mono">{a.sha256.slice(0, 10)}</span></span></span>
                      <a className="btn btn-small" href={a.url} download={a.name}>Download</a>
                    </div>
                  ))}
                </div>
                {v.piece.brief && <div className="card"><h3>Brief</h3><p style={{ whiteSpace: 'pre-wrap', margin: '.25rem 0 0' }}>{v.piece.brief}</p></div>}
              </div>
            )}
          </div>
        </div>
      </div>

      {(dialog === 'approve' || dialog === 'reject') && (
        <DecisionDialog version={v} decision={dialog} openCount={openCount} onClose={() => setDialog(null)} onSeeComments={() => setTab('comments')} />
      )}
      {dialog === 'changes' && <RequestChangesDialog version={v} openCount={openCount} onClose={() => setDialog(null)} />}
      {dialog === 'schedule' && <ScheduleDialog version={v} brandId={brand.id} zone={v.brand.timezone} onClose={() => setDialog(null)} />}
    </>
  );
}
