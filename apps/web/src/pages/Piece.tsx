import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, type BrandSettings, type PieceDetail, type PublicationRow, type Variant, type VersionSummary } from '../api';
import { PieceAgentCard } from '../components/PieceAgentCard';
import { PrizeDialog } from '../components/PrizeDialog';
import { AttemptsDialog, MarkPublishedDialog, MoveDialog, PackDialog, PublicationBadges, PublicationNote, RescheduleDialog, RetryDialog } from '../components/publications';
import { UploadDialog } from '../components/UploadDialog';
import { Chip, Dialog, Empty, ErrorBox, Field, Spinner, errorMessage, useToast } from '../components/ui';
import { t, tMaybe, type Key } from '../i18n';
import { fmtDateTime, fmtDay, fmtShort, NETWORK_LABEL, STATE_LABEL } from '../lib/format';
import { useSession } from '../lib/session';
import '../styles/piece.css';

const FORMATS = ['9:16', '4:5', '1:1', '16:9', 'carousel', 'document'] as const;

/** The format as a short tag: the ratio itself, or a word for the carousel and the document. */
const formatName = (format: string) => tMaybe(`piece.formatName.${format}`, format);
/** What a variant is called when it has no style of its own. */
const formatHint = (format: string) => tMaybe(`piece.formatHint.${format}`, format);

/** The API sends the campaign's id with the piece; the type shared with the rest of the app does not list it. */
type WithCampaign = PieceDetail & { campaign_id?: string | null };

/** Publications that are still going to happen, and so are cancelled if the piece is discarded. */
const PENDING = ['scheduled', 'awaiting_reapproval', 'on_hold', 'preparing', 'ready'];

/** Two-letter marks for the networks, beside the account name; the full name is said next to it. */
const NET_MARK: Record<string, string> = {
  instagram: 'IG', facebook: 'FB', youtube: 'YT', tiktok: 'TT', linkedin: 'LI', x: 'X', threads: 'TH', pinterest: 'PI', bluesky: 'BS',
};

function Icon({ d }: { d: string }) {
  return (
    <svg className="pc-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={d} />
    </svg>
  );
}
const ICON = {
  calendar: 'M7 3v3M17 3v3M4 9h16M5 5h14a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1z',
  flag: 'M5 21V4M5 4h11l-2 4 2 4H5',
  upload: 'M12 16V4M7 9l5-5 5 5M5 20h14',
  comment: 'M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z',
  arrow: 'M5 12h14M13 6l6 6-6 6',
  pdf: 'M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8zM14 3v5h5M9 13h6M9 17h4',
  image: 'M4 5h16v14H4zM4 15l4-4 4 4 3-3 5 5',
  link: 'M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5',
};

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
        <p className="muted">{t('piece.addVariant.intro')}</p>
        <Field label={t('piece.addVariant.format')}>
          <select value={format} onChange={(e) => setFormat(e.target.value)}>
            {FORMATS.map((f) => <option key={f} value={f}>{t(`piece.formatOption.${f}` as Key)}</option>)}
          </select>
        </Field>
        <Field label={t('piece.addVariant.style')} hint={t('piece.addVariant.styleHint')}>
          <input type="text" maxLength={80} value={style} onChange={(e) => setStyle(e.target.value)} />
        </Field>
        {add.error && <ErrorBox error={add.error} />}
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <button type="button" className="btn" onClick={onClose}>{t('common.cancel')}</button>
          <button className="btn btn-primary" disabled={add.isPending}>{t('piece.addVariant.submit')}</button>
        </div>
      </form>
    </Dialog>
  );
}

function EditPiece({ piece, onClose }: { piece: PieceDetail; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [form, setForm] = useState({ title: piece.title, brief: piece.brief, targetDate: piece.target_date ?? '', aiGenerated: piece.ai_generated });
  const save = useMutation({
    mutationFn: () => api.patch(`/api/pieces/${piece.id}`, { title: form.title, brief: form.brief, targetDate: form.targetDate || null, aiGenerated: form.aiGenerated }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['piece', piece.id] });
      qc.invalidateQueries({ queryKey: ['pieces'] });
      toast(t('piece.edit.done'));
      onClose();
    },
  });
  return (
    <Dialog title={t('piece.edit.title')} onClose={onClose}>
      <form className="stack" onSubmit={(e) => { e.preventDefault(); save.mutate(); }}>
        <Field label={t('piece.edit.fieldTitle')}>
          <input type="text" required maxLength={200} value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} />
        </Field>
        <Field label={t('piece.edit.brief')} hint={t('piece.edit.briefHint')}>
          <textarea rows={8} value={form.brief} onChange={(e) => setForm({ ...form, brief: e.target.value })} />
        </Field>
        <Field label={t('piece.edit.target')}>
          <input type="date" value={form.targetDate} onChange={(e) => setForm({ ...form, targetDate: e.target.value })} />
        </Field>
        <label className="check">
          <input type="checkbox" checked={form.aiGenerated} onChange={(e) => setForm({ ...form, aiGenerated: e.target.checked })} />
          <span>{t('piece.edit.ai')}<br /><span className="muted small">{t('piece.edit.aiHint')}</span></span>
        </label>
        {save.error && <ErrorBox error={save.error} />}
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <button type="button" className="btn" onClick={onClose}>{t('common.cancel')}</button>
          <button className="btn btn-primary" disabled={save.isPending || !form.title.trim()}>{t('common.save')}</button>
        </div>
      </form>
    </Dialog>
  );
}

function DiscardPiece({ piece, onClose }: { piece: PieceDetail; onClose: () => void }) {
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
        <div className="row" style={{ justifyContent: 'flex-end' }}>
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

/** Long briefs start folded, so the variants stay in sight; one click shows the rest. */
function Brief({ text, className }: { text: string; className: string }) {
  const long = text.length > 520 || text.split('\n').length > 9;
  const [open, setOpen] = useState(false);
  return (
    <section className={`card pc-brief ${className}`} aria-labelledby="pc-brief-h">
      <div className="card-head"><h2 id="pc-brief-h">{t('piece.brief')}</h2></div>
      <div id="pc-brief-text" className={`pc-brief-text ${long && !open ? 'is-folded' : ''}`}><BriefText text={text} /></div>
      {long && (
        <button type="button" className="btn btn-ghost btn-small pc-brief-toggle" aria-expanded={open} aria-controls="pc-brief-text" onClick={() => setOpen(!open)}>
          {open ? t('piece.briefLess') : t('piece.briefMore')}
        </button>
      )}
    </section>
  );
}

// ───────────────────────────── variants ─────────────────────────────

/** The latest version's preview. PDFs and versions without a preview get a quiet placeholder instead. */
function VersionThumb({ version, format }: { version: VersionSummary | undefined; format: string }) {
  const [failed, setFailed] = useState(false);
  if (!version || failed) {
    return (
      <span className="pc-ph">
        <Icon d={format === 'document' ? ICON.pdf : ICON.image} />
        <span>{version ? (format === 'document' ? t('piece.thumbPdf') : t('piece.noPreview')) : t('piece.noVersionYet')}</span>
      </span>
    );
  }
  const src = (w: number) => `/api/versions/${version.id}/thumb?w=${w}`;
  return <img src={src(240)} srcSet={`${src(240)} 1x, ${src(480)} 2x`} alt="" loading="lazy" onError={() => setFailed(true)} />;
}

function VersionChip({ v, latest }: { v: VersionSummary; latest: boolean }) {
  const title = t('piece.versionTitle', {
    n: v.number,
    state: STATE_LABEL[v.review_state] ?? v.review_state,
    who: v.by_agent ? t('piece.agentAuthor', { name: v.author ?? t('piece.unknownAuthor') }) : (v.author ?? t('piece.unknownAuthor')),
    when: fmtShort(v.created_at),
  });
  return (
    <Link
      role="listitem"
      to={`/review/${v.id}`}
      className={`pc-vchip ${v.by_agent ? 'is-agent' : ''} ${v.review_state === 'superseded' || v.review_state === 'discarded' ? 'is-old' : ''}`}
      aria-current={latest ? 'true' : undefined}
      title={title}
      aria-label={title}
    >
      <span className={`pc-vdot chip-${v.review_state}`} aria-hidden="true" />v{v.number}
    </Link>
  );
}

function VariantRow({ variant, canUpload, onUpload }: { variant: Variant; canUpload: boolean; onUpload: () => void }) {
  const versions = variant.versions;
  const latest = versions.at(-1);
  // Open comments travel with the variant from version to version and block approval wherever they were made.
  const open = versions.filter((v) => v.review_state !== 'discarded').reduce((n, v) => n + v.open_comments, 0);
  const thumb = (
    <>
      <VersionThumb key={latest?.id ?? 'none'} version={latest} format={variant.format} />
      {latest && <span className="ov ov-l">v{latest.number}</span>}
    </>
  );
  return (
    <article className="pc-variant">
      {latest ? (
        <Link to={`/review/${latest.id}`} className="pc-thumb" tabIndex={-1} aria-hidden="true">{thumb}</Link>
      ) : (
        <div className="pc-thumb">{thumb}</div>
      )}
      <div className="pc-variant-body">
        <div className="pc-variant-title">
          <h3><span className="tag">{formatName(variant.format)}</span> <span>{variant.style || formatHint(variant.format)}</span></h3>
          {latest && <Chip state={latest.review_state} />}
        </div>
        {latest ? (
          <p className="pc-byline">
            <span className="mono">v{latest.number}</span>
            <span aria-hidden="true">·</span>
            {latest.by_agent && <span className="tag tag-agent">{t('common.agent')}</span>}
            <span className="pc-author">{latest.author ?? t('piece.unknownAuthor')}</span>
            <span aria-hidden="true">·</span>
            <span>{fmtShort(latest.created_at)}</span>
          </p>
        ) : (
          <p className="pc-byline">{canUpload ? t('piece.noVersionsUpload') : t('piece.noVersions')}</p>
        )}
        {latest?.notes && <p className="pc-notes" title={latest.notes}>{latest.notes}</p>}
        {(versions.length > 1 || open > 0) && (
          <div className="pc-variant-foot">
            {versions.length > 1 && (
              <div className="pc-history">
                <span className="pc-history-label">{t('piece.versions')}</span>
                <div className="pc-history-list" role="list" aria-label={t('piece.versionsLabel', { count: versions.length })}>
                  {versions.map((v) => <VersionChip key={v.id} v={v} latest={v === latest} />)}
                </div>
              </div>
            )}
            {open > 0 && latest && (
              <Link to={`/review/${latest.id}`} className="pc-open"><Icon d={ICON.comment} />{t('piece.openComments', { count: open })}</Link>
            )}
          </div>
        )}
      </div>
      <div className="pc-variant-actions">
        {latest && (
          <Link className="btn" to={`/review/${latest.id}`} aria-label={t('piece.reviewLabel', { n: latest.number })}>
            {t('piece.review')}<Icon d={ICON.arrow} />
          </Link>
        )}
        {canUpload && (
          <button className={latest ? 'btn btn-ghost' : 'btn btn-primary'} onClick={onUpload}>
            <Icon d={ICON.upload} />{latest ? t('piece.uploadNew') : t('piece.uploadFirst')}
          </button>
        )}
      </div>
    </article>
  );
}

// ───────────────────────────── publications ─────────────────────────────

function Publications({ piece, brand, zone, className }: { piece: PieceDetail; brand: BrandSettings | undefined; zone: string; className: string }) {
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
      if (v.action === 'hand-over') toast(t('piece.pub.handedOver'));
      if (v.action === 'recheck') toast(t('piece.pub.rechecking'));
      if (v.action === 'cancel') toast(t('piece.pub.cancelled'));
      if (v.action === 'confirm') toast(t('piece.pub.confirmed'));
    },
    onError: (e) => toast(errorMessage(e), 'error'),
  });
  if (piece.publications.length === 0) return null;
  return (
    <section className={className} aria-labelledby="pc-pubs-h">
      <div className="pc-section-head">
        <h2 id="pc-pubs-h">{t('piece.pub.title')}<span className="pc-count">{piece.publications.length}</span></h2>
      </div>
      <ul className="pc-pubs">
        {piece.publications.map((p) => {
          const variant = piece.variants.find((v) => v.id === p.variant_id);
          const network = NETWORK_LABEL[p.network] ?? p.network;
          return (
            <li key={p.id} className="pc-pub">
              <div className="pc-pub-acct">
                <span className="net" aria-hidden="true">{NET_MARK[p.network] ?? p.network.slice(0, 2).toUpperCase()}</span>
                <span className="pc-pub-who">
                  <strong>{p.account_name}</strong>
                  <span className="muted small">{network}</span>
                </span>
              </div>
              <div className="pc-pub-when">
                <span>{fmtDateTime(p.scheduled_at, zone)}</span>
                <span className="pc-pub-what">
                  {variant && <span className="tag">{formatName(variant.format)}</span>}
                  {variant?.style && <span className="muted small">{variant.style}</span>}
                  <Link to={`/review/${p.version_id}`} className="pc-vchip">v{p.version_number}</Link>
                </span>
              </div>
              <div className="pc-pub-state">
                <div className="row" style={{ gap: '.35rem' }}>
                  <Chip state={p.status} />
                  <PublicationBadges pub={p} />
                </div>
                {p.hold_reason && <div className="muted small">{p.hold_reason}</div>}
                <PublicationNote pub={p} />
                {p.url && <a className="pc-pub-link small" href={p.url} target="_blank" rel="noreferrer"><Icon d={ICON.link} />{t('piece.pub.openPost')}</a>}
                <div className="pc-pub-actions">
                  {!p.manual && <button className="btn btn-small" onClick={() => setAttempts(p.id)}>{t('piece.pub.history')}</button>}
                  {brand?.prizes?.enabled && can('schedule') && ['scheduled', 'preparing', 'ready', 'publishing', 'published', 'awaiting_reapproval', 'on_hold'].includes(p.status) && (
                    <button className="btn btn-small" onClick={() => setPrize(p)}>{t('piece.pub.prize')}</button>
                  )}
                  {can('schedule') && (
                    <>
                      {p.status === 'scheduled' && p.manual && <button className="btn btn-small" onClick={() => setPack(p.id)}>{t('piece.pub.publish')}</button>}
                      {p.status === 'scheduled' && <button className="btn btn-small" onClick={() => setMove(p)}>{t('piece.pub.move')}</button>}
                      {p.status === 'failed' && !p.manual && <button className="btn btn-small btn-primary" onClick={() => setRetry(p)}>{t('piece.pub.retry')}</button>}
                      {p.status === 'published' && !p.manual && p.visibility === 'private' && (
                        <button className="btn btn-small" onClick={() => act.mutate({ id: p.id, action: 'recheck' })} title={t('piece.pub.recheckHint')}>{t('piece.pub.recheck')}</button>
                      )}
                      {!p.manual && (p.status === 'failed' || (p.status === 'scheduled' && !p.native_scheduled)) && (
                        <button className="btn btn-small" onClick={() => confirm(t('piece.pub.handOverConfirm')) && act.mutate({ id: p.id, action: 'hand-over' })}>{t('piece.pub.handOver')}</button>
                      )}
                      {p.status === 'awaiting_reapproval' && (
                        <button className="btn btn-small" onClick={() => act.mutate({ id: p.id, action: 'confirm' })} title={t('piece.pub.confirmHint', { email: me.user.email })}>{t('piece.pub.confirm')}</button>
                      )}
                      {p.status === 'on_hold' && <button className="btn btn-small" onClick={() => setResched(p)}>{t('piece.pub.reschedule')}</button>}
                      {['scheduled', 'awaiting_reapproval', 'on_hold', 'preparing', 'ready', 'failed'].includes(p.status) && (
                        <button
                          className="btn btn-small btn-danger"
                          onClick={() => confirm(p.native_scheduled ? t('piece.pub.cancelConfirmNative') : t('piece.pub.cancelConfirm')) && act.mutate({ id: p.id, action: 'cancel' })}
                        >
                          {t('piece.pub.cancel')}
                        </button>
                      )}
                    </>
                  )}
                </div>
              </div>
            </li>
          );
        })}
      </ul>
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

// ───────────────────────────── the page ─────────────────────────────

/** The variant a new upload most likely goes to: one with changes asked for, else one still empty, else the first. */
function suggestedVariant(variants: Variant[]): Variant | undefined {
  return (
    variants.find((v) => v.versions.at(-1)?.review_state === 'changes_requested') ??
    variants.find((v) => v.versions.length === 0) ??
    variants[0]
  );
}

export function PiecePage() {
  const { pieceId } = useParams();
  const { brand, can } = useSession();
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState(false);
  const [discarding, setDiscarding] = useState(false);
  const [uploadFor, setUploadFor] = useState<string | null>(null);
  const { data: piece, error, isLoading } = useQuery({ queryKey: ['piece', pieceId], queryFn: () => api.get<WithCampaign>(`/api/pieces/${pieceId}`) });
  const { data: settings } = useQuery({ queryKey: ['brand', brand.id], queryFn: () => api.get<BrandSettings>(`/api/brands/${brand.id}`) });
  const campaignId = piece?.campaign_id ?? null;
  const { data: campaigns } = useQuery({
    queryKey: ['campaigns', piece?.brand_id],
    enabled: !!campaignId,
    queryFn: () => api.get<{ id: string; name: string }[]>(`/api/brands/${piece!.brand_id}/campaigns`),
  });
  if (isLoading) return <Spinner />;
  if (error) return <ErrorBox error={error} />;
  if (!piece) return null;
  const live = !piece.discarded_at;
  const canUpload = live && can('upload');
  const campaign = campaigns?.find((c) => c.id === campaignId);
  const suggested = suggestedVariant(piece.variants);
  const uploading = piece.variants.find((v) => v.id === uploadFor);

  return (
    <>
      <nav className="crumbs pc-crumbs" aria-label={t('piece.crumbsLabel')}>
        <Link to="/pieces">{t('piece.crumbsPieces')}</Link>
        <span aria-hidden="true"> / </span>
        <span aria-current="page">{piece.title}</span>
      </nav>
      <header className="page-head pc-head">
        <div className="grow">
          <h1 className="pc-title">{piece.title}</h1>
          <div className="pc-facts">
            <Chip state={live ? piece.review_state : 'discarded'} />
            {piece.ai_generated && <span className="tag" title={t('piece.aiHint')}>{t('common.ai')}</span>}
            <span>{tMaybe(`kind.${piece.kind}`, piece.kind)}</span>
            {piece.target_date && <span className="pc-fact"><Icon d={ICON.calendar} />{t('piece.target', { date: fmtDay(piece.target_date) })}</span>}
            {campaign && <span className="pc-fact"><Icon d={ICON.flag} />{t('piece.campaign', { name: campaign.name })}</span>}
          </div>
        </div>
        {live && (
          <div className="pc-actions">
            {can('createPiece') && <button className="btn btn-ghost pc-discard" onClick={() => setDiscarding(true)}>{t('piece.discard.button')}</button>}
            {can('createPiece') && <button className="btn" onClick={() => setEditing(true)}>{t('common.edit')}</button>}
            {canUpload && suggested && (
              <button className="btn btn-primary" onClick={() => setUploadFor(suggested.id)}><Icon d={ICON.upload} />{t('piece.uploadVersion')}</button>
            )}
          </div>
        )}
      </header>
      {!live && <div className="notice notice-warn" role="status">{t('piece.discardedNotice', { when: fmtShort(piece.discarded_at!) })}</div>}

      <div className="pc-layout">
        <div className="pc-main">
          <section className="pc-o-variants" aria-labelledby="pc-variants-h">
            <div className="pc-section-head">
              <h2 id="pc-variants-h">{t('piece.variants')}<span className="pc-count">{piece.variants.length}</span></h2>
              {canUpload && piece.variants.length > 0 && <button className="btn btn-small" onClick={() => setAdding(true)}>{t('piece.addVariant.button')}</button>}
            </div>
            {piece.variants.length === 0 ? (
              <Empty title={t('piece.noVariants')}>
                {canUpload ? t('piece.noVariantsUpload') : t('piece.noVariantsWait')}
                {canUpload && <><br /><button className="btn btn-primary pc-empty-cta" onClick={() => setAdding(true)}>{t('piece.addVariant.button')}</button></>}
              </Empty>
            ) : (
              <div className="pc-variants">
                {piece.variants.map((v) => (
                  <VariantRow key={v.id} variant={v} canUpload={canUpload} onUpload={() => setUploadFor(v.id)} />
                ))}
              </div>
            )}
          </section>
          <Publications piece={piece} brand={settings} zone={settings?.timezone ?? brand.timezone} className="pc-o-pubs" />
        </div>
        <aside className="pc-side">
          {piece.brief && <Brief text={piece.brief} className="pc-o-brief" />}
          <PieceAgentCard pieceId={piece.id} className="pc-o-agent" />
        </aside>
      </div>

      {adding && <AddVariant pieceId={piece.id} kind={piece.kind} onClose={() => setAdding(false)} />}
      {editing && <EditPiece piece={piece} onClose={() => setEditing(false)} />}
      {discarding && <DiscardPiece piece={piece} onClose={() => setDiscarding(false)} />}
      {uploading && <UploadDialog variant={uploading} variants={piece.variants} onClose={() => setUploadFor(null)} />}
    </>
  );
}
