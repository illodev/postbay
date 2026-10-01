import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api, type PieceSummary } from '../api';
import { Chip, Dialog, Empty, ErrorBox, Field, Spinner, useToast } from '../components/ui';
import { fmtDay } from '../lib/format';
import { useSession } from '../lib/session';

const FILTERS: { value: string; label: string }[] = [
  { value: '', label: 'All' },
  { value: 'in_review', label: 'In review' },
  { value: 'changes_requested', label: 'Changes requested' },
  { value: 'approved', label: 'Approved' },
  { value: 'draft', label: 'Drafts' },
];

const KINDS = [
  { value: 'video', label: 'Video (Reel, Short, TikTok)' },
  { value: 'carousel', label: 'Carousel' },
  { value: 'post', label: 'Post (single image)' },
  { value: 'story', label: 'Story' },
  { value: 'pdf', label: 'PDF document' },
];

function NewPiece({ onClose }: { onClose: () => void }) {
  const { brand } = useSession();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const toast = useToast();
  const [form, setForm] = useState({ title: '', kind: 'video', brief: '', targetDate: '', aiGenerated: false });
  const create = useMutation({
    mutationFn: () =>
      api.post<{ id: string }>(`/api/brands/${brand.id}/pieces`, {
        title: form.title,
        kind: form.kind,
        brief: form.brief,
        targetDate: form.targetDate || null,
        aiGenerated: form.aiGenerated,
      }),
    onSuccess: (p) => {
      qc.invalidateQueries({ queryKey: ['pieces'] });
      toast('Piece created');
      navigate(`/pieces/${p.id}`);
    },
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    create.mutate();
  };
  return (
    <Dialog title="New piece" onClose={onClose}>
      <form className="stack" onSubmit={submit}>
        <Field label="Title">
          <input type="text" required autoFocus maxLength={200} value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} />
        </Field>
        <Field label="Type">
          <select value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value })}>
            {KINDS.map((k) => <option key={k.value} value={k.value}>{k.label}</option>)}
          </select>
        </Field>
        <Field label="Brief" hint="What this piece is for. Whoever produces it reads this first.">
          <textarea value={form.brief} onChange={(e) => setForm({ ...form, brief: e.target.value })} />
        </Field>
        <Field label="Target date (optional)">
          <input type="date" value={form.targetDate} onChange={(e) => setForm({ ...form, targetDate: e.target.value })} />
        </Field>
        <label className="check">
          <input type="checkbox" checked={form.aiGenerated} onChange={(e) => setForm({ ...form, aiGenerated: e.target.checked })} />
          <span>Generated with AI<br /><span className="muted small">Used to label the post on networks that have an AI label.</span></span>
        </label>
        {create.error && <ErrorBox error={create.error} />}
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" disabled={create.isPending || !form.title.trim()}>Create piece</button>
        </div>
      </form>
    </Dialog>
  );
}

export function PiecesPage() {
  const { brand, can } = useSession();
  const [state, setState] = useState('');
  const [q, setQ] = useState('');
  const [creating, setCreating] = useState(false);
  const { data, error, isLoading } = useQuery({
    queryKey: ['pieces', brand.id, state, q],
    queryFn: () => api.get<PieceSummary[]>(`/api/brands/${brand.id}/pieces?${new URLSearchParams({ ...(state ? { state } : {}), ...(q ? { q } : {}) })}`),
  });
  return (
    <>
      <div className="page-head">
        <div>
          <h1>Pieces</h1>
          <p className="muted">Everything {brand.name} is making, and where it stands.</p>
        </div>
        {can('createPiece') && <button className="btn btn-primary" onClick={() => setCreating(true)}>New piece</button>}
      </div>
      <div className="row" style={{ marginBottom: '.75rem' }}>
        <input type="text" aria-label="Search pieces" placeholder="Search by title" value={q} onChange={(e) => setQ(e.target.value)} style={{ maxWidth: 320 }} />
      </div>
      <div className="filters" role="group" aria-label="Filter by state">
        {FILTERS.map((f) => (
          <button key={f.value} className="pill" aria-pressed={state === f.value} onClick={() => setState(f.value)}>{f.label}</button>
        ))}
      </div>
      {isLoading && <Spinner />}
      {error && <ErrorBox error={error} />}
      {data && data.length === 0 && (
        <Empty title="No pieces here yet">{can('createPiece') ? 'Create the first one with “New piece”.' : 'Pieces appear here when someone creates them.'}</Empty>
      )}
      <div className="piece-list">
        {data?.map((p) => (
          <Link key={p.id} to={`/pieces/${p.id}`} className="piece-card">
            <div className="row-between">
              <h3>{p.title}</h3>
              <Chip state={p.review_state} />
            </div>
            <div className="muted small row">
              <span>{KINDS.find((k) => k.value === p.kind)?.label.split(' (')[0] ?? p.kind}</span>
              <span>· {p.variant_count} variant{p.variant_count === 1 ? '' : 's'}</span>
              {p.target_date && <span>· target {fmtDay(p.target_date)}</span>}
              {p.ai_generated && <span>· AI</span>}
            </div>
            {p.open_comments > 0 && <p style={{ marginTop: '.5rem' }}><span className="badge-count">{p.open_comments} open comment{p.open_comments === 1 ? '' : 's'}</span></p>}
          </Link>
        ))}
      </div>
      {creating && <NewPiece onClose={() => setCreating(false)} />}
    </>
  );
}
