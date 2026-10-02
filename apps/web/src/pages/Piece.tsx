import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, type PieceDetail, type PublicationRow, type Variant, type BrandSettings } from '../api';
import { PrizeDialog } from '../components/PrizeDialog';
import { AttemptsDialog, MarkPublishedDialog, MoveDialog, PackDialog, PublicationBadges, PublicationNote, RescheduleDialog, RetryDialog } from '../components/publications';
import { PieceAgentCard } from '../components/PieceAgentCard';
import { UploadDialog } from '../components/UploadDialog';
import { Chip, Dialog, Empty, ErrorBox, Field, Spinner, useToast, errorMessage } from '../components/ui';
import { fmtDateTime, fmtDay, fmtShort, NETWORK_LABEL } from '../lib/format';
import { useSession } from '../lib/session';

const FORMATS = [
  { value: '9:16', label: '9:16 · vertical (Reels, Shorts, TikTok, Stories)' },
  { value: '4:5', label: '4:5 · portrait feed' },
  { value: '1:1', label: '1:1 · square' },
  { value: '16:9', label: '16:9 · landscape' },
  { value: 'carousel', label: 'Carousel' },
  { value: 'document', label: 'Document (PDF)' },
];

function AddVariant({ pieceId, kind, onClose }: { pieceId: string; kind: string; onClose: () => void }) {
  const qc = useQueryClient();
  const defaultFormat = kind === 'carousel' ? 'carousel' : kind === 'pdf' ? 'document' : '9:16';
  const [format, setFormat] = useState(defaultFormat);
  const [style, setStyle] = useState('');
  const add = useMutation({
    mutationFn: () => api.post(`/api/pieces/${pieceId}/variants`, { format, style }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['piece', pieceId] });
      onClose();
    },
  });
  return (
    <Dialog title="Add a variant" onClose={onClose}>
      <form className="stack" onSubmit={(e) => { e.preventDefault(); add.mutate(); }}>
        <p className="muted">One piece can go out in several shapes: the same video as a 9:16 Reel and a 1:1 post, for example. Each variant is reviewed on its own.</p>
        <Field label="Format">
          <select value={format} onChange={(e) => setFormat(e.target.value)}>
            {FORMATS.map((f) => <option key={f.value} value={f.value}>{f.label}</option>)}
          </select>
        </Field>
        <Field label="Style (optional)" hint="For example “subtitled” or “no music”.">
          <input type="text" maxLength={80} value={style} onChange={(e) => setStyle(e.target.value)} />
        </Field>
        {add.error && <ErrorBox error={add.error} />}
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" disabled={add.isPending}>Add variant</button>
        </div>
      </form>
    </Dialog>
  );
}

function EditPiece({ piece, onClose }: { piece: PieceDetail; onClose: () => void }) {
  const qc = useQueryClient();
  const [form, setForm] = useState({ title: piece.title, brief: piece.brief, targetDate: piece.target_date ?? '', aiGenerated: piece.ai_generated });
  const save = useMutation({
    mutationFn: () => api.patch(`/api/pieces/${piece.id}`, { title: form.title, brief: form.brief, targetDate: form.targetDate || null, aiGenerated: form.aiGenerated }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['piece', piece.id] });
      qc.invalidateQueries({ queryKey: ['pieces'] });
      onClose();
    },
  });
  return (
    <Dialog title="Edit piece" onClose={onClose}>
      <form className="stack" onSubmit={(e) => { e.preventDefault(); save.mutate(); }}>
        <Field label="Title"><input type="text" required maxLength={200} value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} /></Field>
        <Field label="Brief"><textarea value={form.brief} onChange={(e) => setForm({ ...form, brief: e.target.value })} /></Field>
        <Field label="Target date"><input type="date" value={form.targetDate} onChange={(e) => setForm({ ...form, targetDate: e.target.value })} /></Field>
        <label className="check"><input type="checkbox" checked={form.aiGenerated} onChange={(e) => setForm({ ...form, aiGenerated: e.target.checked })} /><span>Generated with AI</span></label>
        {save.error && <ErrorBox error={save.error} />}
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" disabled={save.isPending || !form.title.trim()}>Save</button>
        </div>
      </form>
    </Dialog>
  );
}

function VariantCard({ variant, canUpload, onUpload }: { variant: Variant; canUpload: boolean; onUpload: () => void }) {
  const versions = [...variant.versions].reverse();
  return (
    <section className="card" aria-label={`Variant ${variant.format}`}>
      <div className="card-head">
        <h2>{variant.format}{variant.style && <span className="muted"> · {variant.style}</span>}</h2>
        {canUpload && <button className="btn" onClick={onUpload}>{versions.length ? 'Upload new version' : 'Upload first version'}</button>}
      </div>
      {versions.length === 0 && <p className="muted">No versions yet.</p>}
      {versions.map((v) => (
        <div key={v.id} className="version-row">
          <strong>v{v.number}</strong>
          <Chip state={v.review_state} />
          {v.open_comments > 0 && v.review_state !== 'superseded' && <span className="badge-count">{v.open_comments} open</span>}
          <span className="muted small grow">{v.author}{v.by_agent && <span className="chip" style={{ marginLeft: 6 }} title="Uploaded by an agent, not a person">agent</span>} · {fmtShort(v.created_at)}{v.notes && <> · “{v.notes.slice(0, 80)}{v.notes.length > 80 ? '…' : ''}”</>}</span>
          <Link className="btn btn-small" to={`/review/${v.id}`}>{v.review_state === 'in_review' ? 'Review' : 'Open'}</Link>
        </div>
      ))}
    </section>
  );
}

function PublicationsTable({ piece, brand, zone }: { piece: PieceDetail; brand: BrandSettings | undefined; zone: string }) {
  const { me, can } = useSession();
  const qc = useQueryClient();
  const toast = useToast();
  const [move, setMove] = useState<PublicationRow | null>(null);
  const [resched, setResched] = useState<PublicationRow | null>(null);
  const [mark, setMark] = useState<string | null>(null);
  const [pack, setPack] = useState<string | null>(null);
  const [attempts, setAttempts] = useState<string | null>(null);
  const [retry, setRetry] = useState<PublicationRow | null>(null);
  const [prize, setPrize] = useState<PublicationRow | null>(null);
  const act = useMutation({
    mutationFn: ({ id, action }: { id: string; action: 'cancel' | 'confirm' | 'hand-over' | 'recheck' }) => api.post(`/api/publications/${id}/${action}`),
    onSuccess: (_r, v) => {
      qc.invalidateQueries({ queryKey: ['piece', piece.id] });
      if (v.action === 'hand-over') toast('Handed over: it is on the Publish page at the time');
      if (v.action === 'recheck') toast('Checking again');
    },
    onError: (e) => toast(errorMessage(e), 'error'),
  });
  if (piece.publications.length === 0) return null;
  return (
    <section className="card" aria-label="Publications">
      <div className="card-head"><h2>Publications</h2></div>
      <div className="table-wrap">
        <table>
          <thead><tr><th>Account</th><th>When</th><th>Version</th><th>Status</th><th /></tr></thead>
          <tbody>
            {piece.publications.map((p) => {
              const variant = piece.variants.find((v) => v.id === p.variant_id);
              const approved = (variant?.versions ?? []).filter((v) => v.review_state === 'approved');
              return (
                <tr key={p.id}>
                  <td>{NETWORK_LABEL[p.network] ?? p.network}<br /><span className="muted small">{p.account_name}</span></td>
                  <td>{fmtDateTime(p.scheduled_at, zone)}</td>
                  <td>v{p.version_number}</td>
                  <td>
                    <div className="row" style={{ gap: '.3rem' }}>
                      <Chip state={p.status} />
                      <PublicationBadges pub={p} />
                    </div>
                    {p.hold_reason && <div className="muted small">{p.hold_reason}</div>}
                    <PublicationNote pub={p} />
                    {p.url && <div><a href={p.url} target="_blank" rel="noreferrer">Open post</a></div>}
                  </td>
                  <td>
                    <div className="row">
                      {!p.manual && <button className="btn btn-small" onClick={() => setAttempts(p.id)}>History</button>}
                      {brand?.prizes?.enabled && can('schedule') && ['scheduled', 'preparing', 'ready', 'publishing', 'published', 'awaiting_reapproval', 'on_hold'].includes(p.status) && (
                        <button className="btn btn-small" onClick={() => setPrize(p)}>Prize…</button>
                      )}
                      {can('schedule') && (
                        <>
                          {p.status === 'scheduled' && p.manual && <button className="btn btn-small" onClick={() => setPack(p.id)}>Publish…</button>}
                          {p.status === 'scheduled' && <button className="btn btn-small" onClick={() => setMove(p)}>Move</button>}
                          {p.status === 'failed' && !p.manual && <button className="btn btn-small btn-primary" onClick={() => setRetry(p)}>Try again…</button>}
                          {p.status === 'published' && !p.manual && p.visibility === 'private' && (
                            <button className="btn btn-small" onClick={() => act.mutate({ id: p.id, action: 'recheck' })} title="Look at the post again, for example after the project passed its audit and you made it public">Check again</button>
                          )}
                          {!p.manual && (p.status === 'failed' || (p.status === 'scheduled' && !p.native_scheduled)) && (
                            <button className="btn btn-small" onClick={() => confirm('Publish this one by hand instead? The app will stop trying.') && act.mutate({ id: p.id, action: 'hand-over' })}>I'll do it by hand</button>
                          )}
                          {p.status === 'awaiting_reapproval' && <button className="btn btn-small" onClick={() => act.mutate({ id: p.id, action: 'confirm' })} title={`Someone other than you has to confirm it (you are ${me.user.email})`}>Confirm</button>}
                          {p.status === 'on_hold' && <button className="btn btn-small" onClick={() => setResched(p)}>Reschedule…</button>}
                          {['scheduled', 'awaiting_reapproval', 'on_hold', 'preparing', 'ready', 'failed'].includes(p.status) && (
                            <button className="btn btn-small btn-danger" onClick={() => confirm(p.native_scheduled ? 'Cancel this publication? It is taken down from the network too.' : 'Cancel this publication?') && act.mutate({ id: p.id, action: 'cancel' })}>Cancel</button>
                          )}
                        </>
                      )}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {move && <MoveDialog pub={move} brandId={piece.brand_id} zone={zone} needsConfirmation={!!brand?.rules.reapprove_on_move} onClose={() => setMove(null)} />}
      {resched && (
        <RescheduleDialog
          pub={resched}
          zone={zone}
          approvedVersions={(piece.variants.find((v) => v.id === resched.variant_id)?.versions ?? []).filter((v) => v.review_state === 'approved').map((v) => ({ id: v.id, number: v.number }))}
          onClose={() => setResched(null)}
        />
      )}
      {pack && <PackDialog pubId={pack} zone={zone} onClose={() => setPack(null)} onPublished={() => { setMark(pack); setPack(null); }} />}
      {mark && <MarkPublishedDialog pubId={mark} onClose={() => setMark(null)} />}
      {attempts && <AttemptsDialog pubId={attempts} zone={zone} onClose={() => setAttempts(null)} />}
      {retry && <RetryDialog pub={retry} zone={zone} onClose={() => setRetry(null)} />}
      {prize && <PrizeDialog pub={prize} brandId={piece.brand_id} zone={zone} onClose={() => setPrize(null)} />}
    </section>
  );
}

export function PiecePage() {
  const { pieceId } = useParams();
  const { brand, can } = useSession();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState(false);
  const [uploadFor, setUploadFor] = useState<Variant | null>(null);
  const { data: piece, error, isLoading } = useQuery({ queryKey: ['piece', pieceId], queryFn: () => api.get<PieceDetail>(`/api/pieces/${pieceId}`) });
  const { data: settings } = useQuery({ queryKey: ['brand', brand.id], queryFn: () => api.get<BrandSettings>(`/api/brands/${brand.id}`) });
  const discard = useMutation({
    mutationFn: () => api.post(`/api/pieces/${pieceId}/discard`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['pieces'] });
      toast('Piece discarded');
      navigate('/pieces');
    },
    onError: (e) => toast(errorMessage(e), 'error'),
  });
  if (isLoading) return <Spinner />;
  if (error) return <ErrorBox error={error} />;
  if (!piece) return null;
  const live = !piece.discarded_at;
  return (
    <>
      <p className="small"><Link to="/pieces">← All pieces</Link></p>
      <div className="page-head">
        <div>
          <div className="row"><h1>{piece.title}</h1><Chip state={piece.review_state} /></div>
          <p className="muted small">
            {piece.kind}{piece.target_date && <> · target {fmtDay(piece.target_date)}</>}{piece.ai_generated && <> · generated with AI</>}
          </p>
        </div>
        {live && (
          <div className="row">
            {can('createPiece') && <button className="btn" onClick={() => setEditing(true)}>Edit</button>}
            {can('upload') && <button className="btn" onClick={() => setAdding(true)}>Add variant</button>}
            {can('createPiece') && <button className="btn btn-danger" onClick={() => confirm('Discard this piece? Anything scheduled for it is cancelled.') && discard.mutate()}>Discard</button>}
          </div>
        )}
      </div>
      {piece.brief && <div className="card" style={{ marginBottom: '1rem' }}><h3>Brief</h3><p style={{ whiteSpace: 'pre-wrap', marginTop: '.25rem' }}>{piece.brief}</p></div>}
      {piece.variants.length === 0 ? (
        <Empty title="No variants yet">{can('upload') ? 'Add a variant to choose the format, then upload the first version.' : 'Whoever produces this piece will add the formats.'}</Empty>
      ) : (
        <div className="stack">
          {piece.variants.map((v) => (
            <VariantCard key={v.id} variant={v} canUpload={live && can('upload')} onUpload={() => setUploadFor(v)} />
          ))}
        </div>
      )}
      <div style={{ marginTop: '1rem' }}>
        <PieceAgentCard pieceId={piece.id} />
      </div>
      <div style={{ marginTop: '1rem' }}>
        <PublicationsTable piece={piece} brand={settings} zone={settings?.timezone ?? brand.timezone} />
      </div>
      {adding && <AddVariant pieceId={piece.id} kind={piece.kind} onClose={() => setAdding(false)} />}
      {editing && <EditPiece piece={piece} onClose={() => setEditing(false)} />}
      {uploadFor && (
        <UploadDialog
          variant={uploadFor}
          latestVersionId={uploadFor.versions.at(-1)?.id ?? null}
          onClose={() => setUploadFor(null)}
        />
      )}
    </>
  );
}
