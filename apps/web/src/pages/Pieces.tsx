import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { api, type PieceSummary } from '../api';
import { PageBar } from '../components/PageBar';
import { Chip, Dialog, Empty, ErrorBox, Field, Spinner, useToast } from '../components/ui';
import { t, tMaybe, type Key } from '../i18n';
import { fmtDay, fmtShort } from '../lib/format';
import { useSession } from '../lib/session';

const FILTERS = ['', 'in_review', 'changes_requested', 'approved', 'draft'] as const;
const KINDS = ['video', 'carousel', 'post', 'story', 'pdf'] as const;

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
      toast(t('pieces.created'));
      navigate(`/pieces/${p.id}`);
    },
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    create.mutate();
  };
  return (
    <Dialog title={t('pieces.newTitle')} onClose={onClose}>
      <form className="stack" onSubmit={submit}>
        <Field label={t('pieces.field.title')}>
          <input type="text" required autoFocus maxLength={200} value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} />
        </Field>
        <Field label={t('pieces.field.kind')}>
          <select value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value })}>
            {KINDS.map((k) => <option key={k} value={k}>{t(`pieces.kindOption.${k}` as Key)}</option>)}
          </select>
        </Field>
        <Field label={t('pieces.field.brief')} hint={t('pieces.field.briefHint')}>
          <textarea value={form.brief} onChange={(e) => setForm({ ...form, brief: e.target.value })} />
        </Field>
        <Field label={t('pieces.field.target')}>
          <input type="date" value={form.targetDate} onChange={(e) => setForm({ ...form, targetDate: e.target.value })} />
        </Field>
        <label className="check">
          <input type="checkbox" checked={form.aiGenerated} onChange={(e) => setForm({ ...form, aiGenerated: e.target.checked })} />
          <span>{t('pieces.field.ai')}<br /><span className="muted small">{t('pieces.field.aiHint')}</span></span>
        </label>
        {create.error && <ErrorBox error={create.error} />}
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <button type="button" className="btn" onClick={onClose}>{t('common.cancel')}</button>
          <button className="btn btn-primary" disabled={create.isPending || !form.title.trim()}>{t('pieces.create')}</button>
        </div>
      </form>
    </Dialog>
  );
}

/** The piece's preview, or a placeholder when it has nothing to draw yet (no version, or a PDF). */
function Thumb({ piece }: { piece: PieceSummary }) {
  const [failed, setFailed] = useState(false);
  if (failed || piece.variant_count === 0) {
    return (
      <span className="ph">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
          {piece.kind === 'pdf' ? (
            <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8zM14 3v5h5M9 13h6M9 17h4" />
          ) : (
            <path d="M4 5h16v14H4zM4 15l4-4 4 4 3-3 5 5" />
          )}
        </svg>
        {t('pieces.noPreview')}
      </span>
    );
  }
  return <img src={`/api/pieces/${piece.id}/thumb?w=480`} alt="" loading="lazy" onError={() => setFailed(true)} />;
}

function PieceCard({ p }: { p: PieceSummary }) {
  return (
    <Link to={`/pieces/${p.id}`} className="pcard">
      <div className="pcard-thumb">
        <Thumb piece={p} />
        <span className="ov ov-l">{tMaybe(`kind.${p.kind}`, p.kind)}</span>
        {p.variant_count > 1 && <span className="ov ov-r">{t('common.variants', { count: p.variant_count })}</span>}
      </div>
      <div className="pcard-meta">
        <h3 title={p.title}>{p.title}</h3>
        <div className="pcard-line">
          <Chip state={p.review_state} />
          <span className="sp" />
          {p.ai_generated && <span className="tag">{t('common.ai')}</span>}
        </div>
        <div className="pcard-line">
          {p.open_comments > 0 && <span style={{ color: 'var(--accent)' }}>{t('common.openComments', { count: p.open_comments })}</span>}
          <span className="sp" />
          <span className="shrink">{p.target_date ? t('pieces.target', { date: fmtDay(p.target_date) }) : fmtShort(p.created_at)}</span>
        </div>
      </div>
    </Link>
  );
}

export function PiecesPage() {
  const { brand, can } = useSession();
  const [params, setParams] = useSearchParams();
  // The sidebar's folders and collections arrive as query parameters.
  const state = params.get('state') ?? '';
  const campaign = params.get('campaign');
  const byAgent = params.get('by') === 'agent';
  const [q, setQ] = useState('');
  const creating = params.get('new') === '1';
  const setCreating = (open: boolean) => {
    const next = new URLSearchParams(params);
    if (open) next.set('new', '1');
    else next.delete('new');
    setParams(next, { replace: true });
  };
  const setState = (s: string) => {
    const next = new URLSearchParams(params);
    if (s) next.set('state', s);
    else next.delete('state');
    setParams(next);
  };
  const { data: all, error, isLoading } = useQuery({
    queryKey: ['pieces', brand.id, state, q],
    queryFn: () => api.get<PieceSummary[]>(`/api/brands/${brand.id}/pieces?${new URLSearchParams({ ...(state ? { state } : {}), ...(q ? { q } : {}) })}`),
  });
  const { data: campaigns } = useQuery({ queryKey: ['campaigns', brand.id], queryFn: () => api.get<{ id: string; name: string }[]>(`/api/brands/${brand.id}/campaigns`) });
  const data = all?.filter((p) => (!campaign || p.campaign_id === campaign) && (!byAgent || p.latest_by_agent));
  const where = campaign ? campaigns?.find((c) => c.id === campaign)?.name : byAgent ? t('layout.collection.agent') : state ? t(`layout.collection.${state}` as Key) : null;
  return (
    <>
      <PageBar
        crumbs={[{ label: t('pieces.title'), to: '/pieces' }, ...(where ? [{ label: where }] : [])]}
        actions={can('createPiece') && <button className="btn btn-primary btn-small" onClick={() => setCreating(true)}>{t('pieces.new')}</button>}
      />
      <div className="page-head">
        <div>
          <h1>{t('pieces.title')}</h1>
          <p className="muted">{t('pieces.subtitle', { brand: brand.name })}</p>
        </div>
      </div>
      <div className="toolbar">
        <div className="search-input">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></svg>
          <input type="search" aria-label={t('pieces.searchLabel')} placeholder={t('pieces.search')} value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <div className="filters" role="group" aria-label={t('pieces.filterLabel')}>
          {FILTERS.map((f) => (
            <button key={f || 'all'} className="pill" aria-pressed={state === f} onClick={() => setState(f)}>
              {t(`pieces.filter.${f || 'all'}` as Key)}
            </button>
          ))}
        </div>
      </div>
      {isLoading && <Spinner />}
      {error && <ErrorBox error={error} />}
      {data && data.length === 0 && <Empty title={t('pieces.empty')}>{can('createPiece') ? t('pieces.emptyCreate') : t('pieces.emptyWait')}</Empty>}
      <div className="piece-grid">
        {data?.map((p) => <PieceCard key={p.id} p={p} />)}
      </div>
      {creating && <NewPiece onClose={() => setCreating(false)} />}
    </>
  );
}
