import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState, type ReactNode } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, type BrandSettings, type PieceDetail, type PublicationRow, type Variant, type VersionDetail, type VersionSummary } from '../api';
import { Avatar } from '../components/Avatar';
import { Icon } from '../components/icons';
import { MoreMenu, type MenuEntry } from '../components/MoreMenu';
import { PageBar } from '../components/PageBar';
import { PieceActivity } from '../components/PieceActivity';
import { PieceAgentCard } from '../components/PieceAgentCard';
import { ago, authorName, formatHint, formatName, PieceHero, variantName } from '../components/PieceHero';
import { PublicationList } from '../components/publications';
import { UploadDialog } from '../components/UploadDialog';
import { Chip, Dialog, Empty, ErrorBox, Field, Skeleton, SkeletonText, useToast } from '../components/ui';
import { t, type Key } from '../i18n';
import { fmtDateTime, fmtShort, STATE_LABEL } from '../lib/format';
import { useSession } from '../lib/session';
import '../styles/piece.css';

const FORMATS = ['9:16', '4:5', '1:1', '16:9', 'carousel', 'document'] as const;

/** What the API sends with a piece beyond the type shared with the rest of the app. */
type FullPiece = PieceDetail & {
  campaign_id?: string | null;
  source?: string | null;
  publications: (PublicationRow & { published_at?: string | null })[];
};

/** Publications that are still going to happen, and so are cancelled if the piece is discarded. */
const PENDING = ['scheduled', 'awaiting_reapproval', 'on_hold', 'preparing', 'ready'];

// ───────────────────────────── dialogs ─────────────────────────────

function AddVariant({ pieceId, kind, onClose }: { pieceId: string; kind: string; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const defaultFormat = kind === 'carousel' ? 'carousel' : kind === 'pdf' ? 'document' : '9:16';
  const [format, setFormat] = useState<string>(defaultFormat);
  const [style, setStyle] = useState('');
  const add = useMutation({
    mutationFn: () => api.post(`/api/pieces/${pieceId}/variants`, { format, style }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['piece', pieceId] });
      toast(t('piece.addVariant.done'));
      onClose();
    },
  });
  return (
    <Dialog title={t('piece.addVariant.title')} onClose={onClose}>
      <form className="stack" onSubmit={(e) => { e.preventDefault(); add.mutate(); }}>
        <p className="muted pc-lead">{t('piece.addVariant.intro')}</p>
        <fieldset className="pc-formats">
          <legend className="field-label">{t('piece.addVariant.format')}</legend>
          <div className="pc-format-grid">
            {FORMATS.map((f) => (
              <label key={f} className="pc-format" data-on={format === f || undefined}>
                <input type="radio" className="sr-only" name="pc-format" value={f} checked={format === f} onChange={() => setFormat(f)} />
                <span className={`pc-format-shape is-${f.replace(':', 'x')}`} aria-hidden="true" />
                <span className="pc-format-name">{formatName(f)}</span>
                <span className="pc-format-hint">{t(`piece.formatUse.${f}` as Key)}</span>
              </label>
            ))}
          </div>
        </fieldset>
        <Field label={t('piece.addVariant.style')} hint={t('piece.addVariant.styleHint')}>
          <input type="text" maxLength={80} value={style} placeholder={t('piece.addVariant.stylePlaceholder')} onChange={(e) => setStyle(e.target.value)} />
        </Field>
        {add.error && <ErrorBox error={add.error} />}
        <div className="row pc-dialog-foot">
          <button type="button" className="btn" onClick={onClose}>{t('common.cancel')}</button>
          <button className="btn btn-primary" disabled={add.isPending}>{t('piece.addVariant.submit')}</button>
        </div>
      </form>
    </Dialog>
  );
}

function EditPiece({ piece, campaigns, onClose }: { piece: FullPiece; campaigns: { id: string; name: string }[] | undefined; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [form, setForm] = useState({
    title: piece.title, brief: piece.brief, targetDate: piece.target_date ?? '', aiGenerated: piece.ai_generated,
    campaignId: piece.campaign_id ?? '', source: piece.source ?? '',
  });
  const save = useMutation({
    mutationFn: () =>
      api.patch(`/api/pieces/${piece.id}`, {
        title: form.title, brief: form.brief, targetDate: form.targetDate || null, aiGenerated: form.aiGenerated,
        campaignId: form.campaignId || null, source: form.source.trim() || null,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['piece', piece.id] });
      qc.invalidateQueries({ queryKey: ['pieces'] });
      toast(t('piece.edit.done'));
      onClose();
    },
  });
  return (
    <Dialog title={t('piece.edit.title')} onClose={onClose} wide>
      <form className="pc-edit" onSubmit={(e) => { e.preventDefault(); save.mutate(); }}>
        <Field label={t('piece.edit.fieldTitle')}>
          <input type="text" required maxLength={200} value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} />
        </Field>
        <Field label={t('piece.edit.brief')} hint={t('piece.edit.briefHint')}>
          <textarea rows={9} value={form.brief} onChange={(e) => setForm({ ...form, brief: e.target.value })} />
        </Field>
        <div className="pc-edit-row">
          <Field label={t('piece.fields.campaign')}>
            <select value={form.campaignId} onChange={(e) => setForm({ ...form, campaignId: e.target.value })}>
              <option value="">{t('piece.fields.noCampaign')}</option>
              {campaigns?.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </Field>
          <Field label={t('piece.edit.target')}>
            <input type="date" value={form.targetDate} onChange={(e) => setForm({ ...form, targetDate: e.target.value })} />
          </Field>
        </div>
        <Field label={t('piece.fields.source')} hint={t('piece.edit.sourceHint')}>
          <input type="text" className="pc-mono-input" maxLength={500} value={form.source} placeholder={t('piece.fields.sourcePlaceholder')} onChange={(e) => setForm({ ...form, source: e.target.value })} />
        </Field>
        <label className="check">
          <input type="checkbox" checked={form.aiGenerated} onChange={(e) => setForm({ ...form, aiGenerated: e.target.checked })} />
          <span>{t('piece.edit.ai')}<br /><span className="muted small">{t('piece.edit.aiHint')}</span></span>
        </label>
        {save.error && <ErrorBox error={save.error} />}
        <div className="row pc-dialog-foot">
          <button type="button" className="btn" onClick={onClose}>{t('common.cancel')}</button>
          <button className="btn btn-primary" disabled={save.isPending || !form.title.trim()}>{save.isPending ? t('common.saving') : t('common.save')}</button>
        </div>
      </form>
    </Dialog>
  );
}

function MoveToCampaign({ piece, campaigns, onClose }: { piece: FullPiece; campaigns: { id: string; name: string }[] | undefined; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [chosen, setChosen] = useState(piece.campaign_id ?? '');
  const move = useMutation({
    mutationFn: () => api.patch(`/api/pieces/${piece.id}`, { campaignId: chosen || null }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['piece', piece.id] });
      qc.invalidateQueries({ queryKey: ['pieces'] });
      const name = campaigns?.find((c) => c.id === chosen)?.name;
      toast(name ? t('piece.move.done', { name }) : t('piece.move.doneNone'));
      onClose();
    },
  });
  const options = [{ id: '', name: t('piece.fields.noCampaign') }, ...(campaigns ?? [])];
  return (
    <Dialog title={t('piece.move.title')} onClose={onClose}>
      <form className="stack" onSubmit={(e) => { e.preventDefault(); move.mutate(); }}>
        <p className="muted pc-lead">{t('piece.move.intro', { title: piece.title })}</p>
        <div className="pc-choices" role="radiogroup" aria-label={t('piece.fields.campaign')}>
          {options.map((c) => (
            <label key={c.id || 'none'} className="pc-choice" data-on={chosen === c.id || undefined}>
              <input type="radio" name="pc-campaign" className="sr-only" checked={chosen === c.id} onChange={() => setChosen(c.id)} />
              <Icon name={c.id ? 'folder' : 'x'} />
              <span className="grow">{c.name}</span>
              {piece.campaign_id === c.id && c.id && <span className="pc-choice-now">{t('piece.move.now')}</span>}
              {chosen === c.id && <Icon name="check" className="pc-choice-check" />}
            </label>
          ))}
        </div>
        {move.error && <ErrorBox error={move.error} />}
        <div className="row pc-dialog-foot">
          <button type="button" className="btn" onClick={onClose}>{t('common.cancel')}</button>
          <button className="btn btn-primary" disabled={move.isPending || chosen === (piece.campaign_id ?? '')}>{t('piece.move.submit')}</button>
        </div>
      </form>
    </Dialog>
  );
}

function DiscardPiece({ piece, onClose }: { piece: FullPiece; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const navigate = useNavigate();
  const pending = piece.publications.filter((p) => PENDING.includes(p.status)).length;
  const discard = useMutation({
    mutationFn: () => api.post(`/api/pieces/${piece.id}/discard`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['pieces'] });
      qc.invalidateQueries({ queryKey: ['piece', piece.id] });
      toast(t('piece.discard.done'));
      navigate('/pieces');
    },
  });
  return (
    <Dialog title={t('piece.discard.title')} onClose={onClose}>
      <div className="stack">
        <p>{t('piece.discard.body', { title: piece.title })}</p>
        {pending > 0 && <div className="notice notice-warn">{t('piece.discard.cancels', { count: pending })}</div>}
        <p className="muted small">{t('piece.discard.final')}</p>
        {discard.error && <ErrorBox error={discard.error} />}
        <div className="row pc-dialog-foot">
          <button type="button" className="btn" onClick={onClose}>{t('common.cancel')}</button>
          <button type="button" className="btn btn-danger" disabled={discard.isPending} onClick={() => discard.mutate()}>{t('piece.discard.submit')}</button>
        </div>
      </div>
    </Dialog>
  );
}

// ───────────────────────────── brief ─────────────────────────────

/** Bold and code inside a line of the brief. */
function inline(text: string, key: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /\*\*([^*]+)\*\*|`([^`]+)`/g;
  let last = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (m.index > last) out.push(text.slice(last, m.index));
    out.push(m[1] !== undefined ? <strong key={`${key}-${m.index}`}>{m[1]}</strong> : <code key={`${key}-${m.index}`}>{m[2]}</code>);
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

/**
 * Briefs are often written in Markdown. Without a library, the few marks they use are shown for what they mean (headings,
 * bold, code, quoted blocks and tables) instead of as symbols; everything else stays exactly as written.
 */
function BriefText({ text }: { text: string }) {
  const blocks: ReactNode[] = [];
  let para: string[] = [];
  let table: string[][] = [];
  let fence: string[] | null = null;
  const flushPara = () => {
    if (!para.length) return;
    const k = `p${blocks.length}`;
    blocks.push(<p key={k}>{para.flatMap((l, i) => (i ? [<br key={`${k}-br${i}`} />, ...inline(l, `${k}-${i}`)] : inline(l, `${k}-${i}`)))}</p>);
    para = [];
  };
  const flushTable = () => {
    if (!table.length) return;
    const k = `t${blocks.length}`;
    const [head, ...rows] = table;
    blocks.push(
      <div key={k} className="pc-md-table">
        <table>
          <thead><tr>{head!.map((c, i) => <th key={i}>{inline(c, `${k}-h${i}`)}</th>)}</tr></thead>
          <tbody>{rows.map((r, j) => <tr key={j}>{r.map((c, i) => <td key={i}>{inline(c, `${k}-${j}-${i}`)}</td>)}</tr>)}</tbody>
        </table>
      </div>,
    );
    table = [];
  };
  for (const line of text.replace(/\r\n/g, '\n').split('\n')) {
    const tr = line.trim();
    if (tr.startsWith('```')) {
      if (fence) {
        blocks.push(<pre key={`f${blocks.length}`} className="pc-md-quote">{fence.join('\n')}</pre>);
        fence = null;
      } else {
        flushPara();
        flushTable();
        fence = [];
      }
      continue;
    }
    if (fence) {
      fence.push(line);
      continue;
    }
    if (/^\|.*\|$/.test(tr)) {
      flushPara();
      if (!/^\|[\s:|-]+\|$/.test(tr)) table.push(tr.slice(1, -1).split('|').map((c) => c.trim()));
      continue;
    }
    flushTable();
    if (!tr) {
      flushPara();
      continue;
    }
    const h = /^#{1,6}\s+(.*)$/.exec(tr);
    if (h) {
      flushPara();
      blocks.push(<p key={`h${blocks.length}`} className="pc-md-h">{inline(h[1]!, `h${blocks.length}`)}</p>);
      continue;
    }
    // A long line cut mid-sentence was wrapped by whoever wrote it, not meant as a break: it joins the next one.
    const prev = para.at(-1);
    if (prev !== undefined && prev.trim().length >= 50 && !/[.!?:»"”]$/.test(prev.trim()) && !/^([-*·•]|\d+[.)])\s/.test(tr)) para[para.length - 1] = `${prev.trimEnd()} ${tr}`;
    else para.push(line);
  }
  if (fence) blocks.push(<pre key={`f${blocks.length}`} className="pc-md-quote">{fence.join('\n')}</pre>);
  flushPara();
  flushTable();
  return <>{blocks}</>;
}

/** Long briefs start folded, so what follows stays in sight; one click shows the rest. */
function Brief({ text, canEdit, onEdit, className }: { text: string; canEdit: boolean; onEdit: () => void; className?: string }) {
  const long = text.length > 520 || text.split('\n').length > 9;
  const [open, setOpen] = useState(false);
  return (
    <section className={`pc-section pc-brief ${className ?? ''}`} aria-labelledby="pc-brief-h">
      <header className="pc-section-head">
        <h2 id="pc-brief-h">{t('piece.brief')}</h2>
        {canEdit && (
          <button type="button" className="pc-icon-btn" onClick={onEdit} title={t('piece.briefEdit')} aria-label={t('piece.briefEdit')}>
            <Icon name="pen" />
          </button>
        )}
      </header>
      <div className="pc-brief-card">
        {text ? (
          <>
            <div id="pc-brief-text" className={`pc-brief-text ${long && !open ? 'is-folded' : ''}`}><BriefText text={text} /></div>
            {long && (
              <button type="button" className="pc-brief-toggle" aria-expanded={open} aria-controls="pc-brief-text" onClick={() => setOpen(!open)}>
                {open ? t('piece.briefLess') : t('piece.briefMore')}
                <Icon name="chevronDown" className={open ? 'is-up' : undefined} />
              </button>
            )}
          </>
        ) : (
          <p className="pc-side-empty">{canEdit ? t('piece.briefEmptyEdit') : t('piece.briefEmpty')}</p>
        )}
      </div>
    </section>
  );
}

// ───────────────────────────── variants ─────────────────────────────

function VariantThumb({ version, format }: { version: VersionSummary | undefined; format: string }) {
  const [failed, setFailed] = useState(false);
  if (!version || failed) {
    return <span className="pc-vthumb-ph"><Icon name={!version ? 'plus' : format === 'document' ? 'file' : 'image'} /></span>;
  }
  const src = (w: number) => `/api/versions/${version.id}/thumb?w=${w}`;
  return <img src={src(240)} srcSet={`${src(240)} 1x, ${src(480)} 2x`} alt="" loading="lazy" onError={() => setFailed(true)} />;
}

function VariantRow({ variant, current, canUpload, onUpload, onShow }: {
  variant: Variant;
  current: boolean;
  canUpload: boolean;
  onUpload: () => void;
  onShow: () => void;
}) {
  const versions = variant.versions;
  const latest = versions.at(-1);
  // Open comments travel with the variant from version to version and block approval wherever they were made.
  const open = versions.filter((v) => v.review_state !== 'discarded').reduce((n, v) => n + v.open_comments, 0);
  const name = variantName(variant);
  return (
    <li className={`pc-vrow ${current ? 'is-current' : ''}`}>
      <button type="button" className="pc-vthumb" onClick={onShow} title={t('piece.variant.show', { variant: name })} aria-label={t('piece.variant.show', { variant: name })} aria-pressed={current}>
        <VariantThumb key={latest?.id ?? 'none'} version={latest} format={variant.format} />
        {latest?.by_agent && <span className="pc-vthumb-agent" aria-hidden="true"><Icon name="bot" /></span>}
      </button>
      <div className="pc-vrow-name">
        <span className="pc-vrow-title">
          <span className="pc-ftag">{formatName(variant.format)}</span>
          <span className="pc-vrow-style" title={variant.style || formatHint(variant.format)}>{variant.style || formatHint(variant.format)}</span>
        </span>
        {latest ? (
          <span className="pc-vrow-by">
            <span className={`pc-vnum ${latest.by_agent ? 'is-agent' : ''}`}>v{latest.number}</span>
            {latest.by_agent ? <Avatar agent size={16} /> : <Avatar name={authorName(latest)} size={16} />}
            <span className={`pc-vrow-who ${latest.by_agent ? 'pc-agent-name' : ''}`}>{authorName(latest)}</span>
            <span className="pc-dot-sep" aria-hidden="true">·</span>
            <time dateTime={latest.created_at} title={fmtShort(latest.created_at)}>{ago(latest.created_at)}</time>
          </span>
        ) : (
          <span className="pc-vrow-by pc-empty-val">{canUpload ? t('piece.noVersionsUpload') : t('piece.noVersions')}</span>
        )}
      </div>
      <span className="pc-vrow-state">{latest ? <Chip state={latest.review_state} /> : <Chip state="draft" label={t('piece.variant.empty')} />}</span>
      <span className="pc-vrow-comments">
        {open > 0 && latest ? (
          <Link to={`/review/${latest.id}`} className="pc-ccount" title={t('piece.openComments', { count: open })} aria-label={t('piece.openComments', { count: open })}>
            <Icon name="bubble" />{open}
          </Link>
        ) : (
          <span className="pc-ccount is-zero" title={t('piece.noOpenComments')}><Icon name="bubble" />0</span>
        )}
      </span>
      <span className="pc-vrow-act">
        {latest ? (
          <Link className="btn btn-small" to={`/review/${latest.id}`} title={t('piece.reviewHint', { n: latest.number, variant: name })}>
            {t('piece.reviewN', { n: latest.number })}
          </Link>
        ) : canUpload ? (
          <button type="button" className="btn btn-small btn-primary" onClick={onUpload}>{t('piece.uploadFirst')}</button>
        ) : null}
        {canUpload && latest && (
          <button type="button" className="pc-icon-btn" onClick={onUpload} title={t('piece.variant.upload', { variant: name })} aria-label={t('piece.variant.upload', { variant: name })}>
            <Icon name="upload" />
          </button>
        )}
      </span>
    </li>
  );
}

// ───────────────────────────── the page ─────────────────────────────

/** The page's shape while it loads: the header, the stage and the facts beside it. */
function PieceSkeleton() {
  return (
    <div aria-busy="true" aria-label={t('common.loading')}>
      <div className="page-top"><Skeleton width={260} height={16} /></div>
      <div className="pc-hero">
        <div className="pc-hero-media">
          <Skeleton className="pc-stage" height="auto" radius={12} />
          <div className="pc-film">{[0, 1, 2].map((i) => <Skeleton key={i} width={60} height={60} radius={8} />)}</div>
        </div>
        <div className="pc-info">
          <Skeleton width={90} height={20} radius={99} />
          <Skeleton width="80%" height={22} />
          <SkeletonText lines={4} />
        </div>
      </div>
    </div>
  );
}

/** The variant a new upload most likely goes to: one with changes asked for, else one still empty, else the first. */
function suggestedVariant(variants: Variant[]): Variant | undefined {
  return (
    variants.find((v) => v.versions.at(-1)?.review_state === 'changes_requested') ??
    variants.find((v) => v.versions.length === 0) ??
    variants[0]
  );
}

/** Keys that work on the whole page, unless someone is typing or a dialog is open. */
function useShortcuts(map: Record<string, (() => void) | null>) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || e.defaultPrevented) return;
      const el = e.target as HTMLElement | null;
      if (el && (el.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName))) return;
      if (document.querySelector('dialog[open], .palette')) return;
      const fn = map[e.key.toLowerCase()];
      if (fn) {
        e.preventDefault();
        fn();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });
}

export function PiecePage() {
  const { pieceId } = useParams();
  const navigate = useNavigate();
  const { brand, can, me } = useSession();
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState(false);
  const [moving, setMoving] = useState(false);
  const [discarding, setDiscarding] = useState(false);
  const [uploadFor, setUploadFor] = useState<string | null>(null);
  const [heroVariant, setHeroVariant] = useState<string | null>(null);
  const [heroVersion, setHeroVersion] = useState<string | null>(null);
  const { data: piece, error, isLoading } = useQuery({ queryKey: ['piece', pieceId], queryFn: () => api.get<FullPiece>(`/api/pieces/${pieceId}`) });
  const { data: settings } = useQuery({ queryKey: ['brand', brand.id], queryFn: () => api.get<BrandSettings>(`/api/brands/${brand.id}`) });
  const { data: campaigns } = useQuery({
    queryKey: ['campaigns', piece?.brand_id],
    enabled: !!piece,
    queryFn: () => api.get<{ id: string; name: string }[]>(`/api/brands/${piece!.brand_id}/campaigns`),
  });
  // The hero shows the main variant (the first) unless another is picked, and its latest version unless another is.
  const variant = piece?.variants.find((v) => v.id === heroVariant) ?? piece?.variants.find((v) => v.versions.length > 0) ?? piece?.variants[0];
  const version = variant?.versions.find((v) => v.id === heroVersion) ?? variant?.versions.at(-1);
  const { data: detail } = useQuery({
    queryKey: ['version', version?.id],
    enabled: !!version,
    queryFn: () => api.get<VersionDetail>(`/api/versions/${version!.id}`),
    staleTime: 60_000,
  });
  const latest = variant?.versions.at(-1);
  const live = !!piece && !piece.discarded_at;
  const canUpload = live && can('upload');
  const canEdit = live && can('createPiece');
  const suggested = piece ? suggestedVariant(piece.variants) : undefined;
  const upload = () => canUpload && (variant ?? suggested) && setUploadFor((variant ?? suggested)!.id);
  useShortcuts({
    u: canUpload ? upload : null,
    r: latest ? () => navigate(`/review/${latest.id}`) : null,
  });

  if (isLoading) return <PieceSkeleton />;
  if (error) return <ErrorBox error={error} />;
  if (!piece || !variant) {
    if (!piece) return null;
  }
  const zone = settings?.timezone ?? brand.timezone;
  const campaign = campaigns?.find((c) => c.id === piece.campaign_id);
  const uploading = piece.variants.find((v) => v.id === uploadFor);
  const openOnVariant = (variant?.versions ?? []).filter((v) => v.review_state !== 'discarded').reduce((n, v) => n + v.open_comments, 0);

  const menu: MenuEntry[] = canEdit
    ? [
        { label: t('piece.menu.edit'), icon: 'pen', hint: t('piece.menu.editHint'), onSelect: () => setEditing(true) },
        { label: t('piece.menu.move'), icon: 'folder', hint: t('piece.menu.moveHint'), onSelect: () => setMoving(true) },
        ...(canUpload ? [{ label: t('piece.addVariant.button'), icon: 'plus' as const, hint: t('piece.addVariant.hint'), onSelect: () => setAdding(true) }] : []),
        { sep: true },
        { label: t('piece.menu.discard'), icon: 'trash', danger: true, hint: t('piece.menu.discardHint'), onSelect: () => setDiscarding(true) },
      ]
    : [];

  return (
    <>
      <PageBar
        crumbs={[
          { label: t('piece.crumbsPieces'), to: '/pieces' },
          ...(campaign ? [{ label: campaign.name, to: `/pieces?campaign=${campaign.id}` }] : []),
          { label: piece.title },
        ]}
        actions={
          <span className="pc-pb">
            {latest && (
              <Link className="btn pc-pb-btn pc-pb-review" to={`/review/${latest.id}`} title={`${t('piece.reviewHint', { n: latest.number, variant: variantName(variant!) })} (R)`}>
                {t('piece.reviewN', { n: latest.number })}
              </Link>
            )}
            {canUpload && (
              <button type="button" className="btn btn-primary pc-pb-btn" onClick={upload} title={`${t('piece.uploadVersionHint')} (U)`} aria-label={t('piece.uploadVersion')}>
                <Icon name="upload" />
                <span className="pc-pb-label">{t('piece.uploadVersion')}</span>
              </button>
            )}
            {menu.length > 0 && <MoreMenu items={menu} label={t('piece.menu.label')} className="mm-trigger pc-pb-more" />}
          </span>
        }
      />
      {!live && (
        <div className="pc-discarded" role="status">
          <Icon name="alert" />
          {t('piece.discardedNotice', { when: fmtShort(piece.discarded_at!) })}
        </div>
      )}

      {variant ? (
        <PieceHero
          piece={piece}
          variants={piece.variants}
          variantId={variant.id}
          onVariant={(id) => { setHeroVariant(id); setHeroVersion(null); }}
          versionId={version?.id ?? null}
          onVersion={setHeroVersion}
          detail={detail}
          openComments={openOnVariant}
          campaigns={campaigns}
          canEdit={canEdit}
          zone={zone}
        />
      ) : (
        <div className="pc-hero-empty">
          <Empty title={t('piece.noVariants')}>
            {canUpload ? t('piece.noVariantsUpload') : t('piece.noVariantsWait')}
          </Empty>
          {canUpload && <button className="btn btn-primary" onClick={() => setAdding(true)}><Icon name="plus" />{t('piece.addVariant.button')}</button>}
        </div>
      )}

      <div className="pc-layout">
        <div className="pc-main">
          {piece.variants.length > 0 && (
            <section className="pc-section" aria-labelledby="pc-variants-h">
              <header className="pc-section-head">
                <h2 id="pc-variants-h">{t('piece.variants')}</h2>
                <span className="pc-count">{piece.variants.length}</span>
                {canUpload && (
                  <button type="button" className="btn btn-small btn-ghost pc-section-act" onClick={() => setAdding(true)} title={t('piece.addVariant.hint')}>
                    <Icon name="plus" />{t('piece.addVariant.button')}
                  </button>
                )}
              </header>
              <ul className="pc-vlist">
                {piece.variants.map((v) => (
                  <VariantRow
                    key={v.id}
                    variant={v}
                    current={v.id === variant?.id && piece.variants.length > 1}
                    canUpload={canUpload}
                    onUpload={() => setUploadFor(v.id)}
                    onShow={() => {
                      setHeroVariant(v.id);
                      setHeroVersion(null);
                      window.scrollTo({ top: 0, behavior: 'smooth' });
                    }}
                  />
                ))}
              </ul>
            </section>
          )}
          {piece.publications.length > 0 && (
            <section className="pc-section" aria-labelledby="pc-pubs-h">
              <header className="pc-section-head">
                <h2 id="pc-pubs-h">{t('piece.pubs')}</h2>
                <span className="pc-count">{piece.publications.length}</span>
              </header>
              <PublicationList
                pubs={piece.publications}
                variants={piece.variants}
                brandId={piece.brand_id}
                zone={zone}
                brand={settings}
                canSchedule={can('schedule')}
                me={me.user.email}
              />
            </section>
          )}
          <Brief text={piece.brief} canEdit={canEdit} onEdit={() => setEditing(true)} />
        </div>
        <aside className="pc-side">
          <PieceAgentCard pieceId={piece.id} zone={zone} />
          <PieceActivity piece={piece} zone={zone} />
        </aside>
      </div>

      {adding && <AddVariant pieceId={piece.id} kind={piece.kind} onClose={() => setAdding(false)} />}
      {editing && <EditPiece piece={piece} campaigns={campaigns} onClose={() => setEditing(false)} />}
      {moving && <MoveToCampaign piece={piece} campaigns={campaigns} onClose={() => setMoving(false)} />}
      {discarding && <DiscardPiece piece={piece} onClose={() => setDiscarding(false)} />}
      {uploading && <UploadDialog variant={uploading} variants={piece.variants} onClose={() => setUploadFor(null)} />}
    </>
  );
}
