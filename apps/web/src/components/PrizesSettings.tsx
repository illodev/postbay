import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import { DateTime } from 'luxon';
import { api, type BrandSettings, type PieceSummary, type Prize } from '../api';
import { t } from '../i18n';
import { fmtBytes } from '../lib/format';
import { uploadPrizeFile, type Progress } from '../lib/upload';
import { Chip, CopyButton, Empty, ErrorBox, errorMessage, Field, Segmented, Select, Spinner, Switch, useConfirm, useToast } from './ui';
import { Icon } from './icons';
import '../styles/features.css';

/** A piece's picture, small: its latest version's thumbnail, or its kind's icon. */
function PieceThumb({ versionId }: { versionId?: string | null }) {
  return (
    <span className="fx-thumb" aria-hidden="true">
      {versionId ? <img src={`/api/versions/${versionId}/thumb?w=120`} alt="" onError={(e) => ((e.target as HTMLImageElement).style.display = 'none')} /> : <Icon name="image" />}
    </span>
  );
}

/** What a piece prize hands out now: its version and file, or that it has no approved version. */
function PiecePrize({ p }: { p: Prize }) {
  return (
    <div className="fx-prize-piece">
      <PieceThumb versionId={p.version?.id} />
      <div className="grow">
        <div className="small" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.piece?.title ?? t('fx.prizes.kindPiece')}</div>
        {p.version ? (
          <div className="fx-prize-meta">{t('fx.prizes.handsOut', { n: p.version.number, file: p.version.file_name, date: DateTime.fromISO(p.version.approved_at).toFormat('d LLL') })}</div>
        ) : (
          <div className="fx-prize-off">{p.unavailable_reason ?? t('fx.prizes.noApproved')}</div>
        )}
      </div>
    </div>
  );
}

function Settings({ brand }: { brand: BrandSettings }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [form, setForm] = useState<null | BrandSettings['prizes']>(null);
  const f = form ?? brand.prizes;
  const save = useMutation({
    mutationFn: () => api.patch(`/api/brands/${brand.id}`, { prizes: f }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['brand'] }); setForm(null); toast(t('settings.saved')); },
  });
  return (
    <form className="card stack" onSubmit={(e) => { e.preventDefault(); save.mutate(); }}>
      <div className="set-card-head">
        <h3>{t('prizes.settings.title')}</h3>
        {brand.prizes.enabled ? <Chip state="approved" label={t('prizes.settings.on')} /> : <Chip state="draft" label={t('prizes.settings.off')} />}
      </div>
      <Switch label={t('prizes.settings.enable')} hint={t('prizes.settings.enableHint')} checked={f.enabled} onChange={(v) => setForm({ ...f, enabled: v })} />
      <div className="set-fields">
        <Field label={t('prizes.settings.retention')} hint={t('prizes.settings.retentionHint')}>
          <input className="set-num-input" type="number" min={8} max={365} value={f.retention_days} onChange={(e) => setForm({ ...f, retention_days: Number(e.target.value) })} />
        </Field>
        <Field label={t('prizes.settings.notice')} hint={t('prizes.settings.noticeHint')}>
          <input type="text" required maxLength={200} value={f.auto_notice} onChange={(e) => setForm({ ...f, auto_notice: e.target.value })} />
        </Field>
      </div>
      {save.error && <ErrorBox error={save.error} />}
      <div className="set-savebar">
        <button className="btn btn-primary" disabled={save.isPending || form === null}>{t('common.save')}</button>
        {form && <span className="muted small">{t('settings.unsaved')}</span>}
      </div>
    </form>
  );
}

function PrizeState({ p }: { p: Prize }) {
  if (p.archived) return <Chip state="draft" label={t('prizes.state.archived')} />;
  if (!p.usable && p.kind === 'piece') return <Chip state="on_hold" label={p.unavailable_reason ?? t('fx.prizes.noApproved')} />;
  if (!p.usable) return <Chip state="failed" label={t('prizes.state.missing')} />;
  return <Chip state="approved" label={t('prizes.state.ready')} />;
}

function Library({ brandId }: { brandId: string }) {
  const confirm = useConfirm();
  const qc = useQueryClient();
  const toast = useToast();
  const { data, error } = useQuery({ queryKey: ['prizes', brandId], queryFn: () => api.get<Prize[]>(`/api/brands/${brandId}/prizes`) });
  // A piece of the studio is the recommended kind: what people get follows the approvals.
  const [kind, setKind] = useState<'piece' | 'link' | 'file'>('piece');
  const [pieceId, setPieceId] = useState<string | undefined>(undefined);
  // Starts the piece picker afresh after a prize is added (a Select left without a value would keep showing the last one).
  const [round, setRound] = useState(0);
  const pieces = useQuery({ queryKey: ['pieces', brandId, '', ''], queryFn: () => api.get<PieceSummary[]>(`/api/brands/${brandId}/pieces`), enabled: kind === 'piece' });
  // Approved ones first: a piece hands out its latest approved version, so one with none cannot be a prize (the studio says so).
  const choosable = (pieces.data ?? [])
    .filter((p) => p.review_state !== 'discarded')
    .sort((a, b) => Number(b.review_state === 'approved') - Number(a.review_state === 'approved'));
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [progress, setProgress] = useState<Progress | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const refresh = () => qc.invalidateQueries({ queryKey: ['prizes'] });
  const reset = () => { setName(''); setUrl(''); setFile(null); if (input.current) input.current.value = ''; };

  const add = useMutation({
    mutationFn: async () => {
      if (kind === 'piece') return api.post(`/api/brands/${brandId}/prizes`, { kind: 'piece', name, pieceId });
      if (kind === 'link') return api.post(`/api/brands/${brandId}/prizes`, { kind: 'link', name, url });
      if (!file) throw new Error(t('prizes.add.chooseFile'));
      return uploadPrizeFile(brandId, name, file, setProgress);
    },
    onSuccess: () => { refresh(); reset(); setPieceId(undefined); setRound((n) => n + 1); toast(t('prizes.add.done')); },
    onSettled: () => setProgress(null),
  });
  const archive = useMutation({
    mutationFn: (id: string) => api.post(`/api/prizes/${id}/archive`),
    onSuccess: refresh,
    onError: (e) => toast(errorMessage(e), 'error'),
  });
  const label = progress
    ? progress.step === 'hashing' ? t('prizes.add.hashing') : progress.step === 'uploading' ? t('prizes.add.uploading', { pct: Math.round(progress.fraction * 100) }) : t('prizes.add.finishing')
    : null;

  const nameField = (
    <Field label={t('prizes.add.name')} hint={t('prizes.add.nameHint')}>
      <input type="text" required maxLength={120} value={name} onChange={(e) => setName(e.target.value)} />
    </Field>
  );

  return (
    <>
      <section className="card">
        <div className="card-head"><h3>{data && data.length > 0 ? t('prizes.library.count', { count: data.length }) : t('prizes.library.title')}</h3></div>
        {error && <ErrorBox error={error} />}
        {!data && !error && <Spinner />}
        {data?.length === 0 && <Empty title={t('prizes.library.empty')}>{t('prizes.library.emptyHint')}</Empty>}
        {data && data.length > 0 && (
          <div className="table-wrap">
            <table className="set-table">
              <thead>
                <tr>
                  <th>{t('prizes.library.name')}</th>
                  <th>{t('prizes.library.what')}</th>
                  <th>{t('prizes.library.state')}</th>
                  <th className="set-actions"><span className="sr-only">{t('settings.actions')}</span></th>
                </tr>
              </thead>
              <tbody>
                {data.map((p) => (
                  <tr key={p.id}>
                    <td><strong style={{ fontWeight: 500 }}>{p.name}</strong></td>
                    <td data-label={t('prizes.library.what')}>
                      <div style={{ minWidth: 0 }}>
                        {p.kind === 'piece' ? <PiecePrize p={p} /> : <><span className="tag">{p.kind === 'file' ? t('prizes.kind.file') : t('prizes.kind.link')}</span>{' '}</>}
                        {p.kind === 'piece' ? null : p.kind === 'file'
                          ? <span className="small">{p.file_name} <span className="muted mono">{fmtBytes(p.file_bytes ?? 0)}</span></span>
                          : <a className="small" href={p.url ?? '#'} target="_blank" rel="noreferrer" style={{ overflowWrap: 'anywhere' }}>{p.url}</a>}
                      </div>
                    </td>
                    <td data-label={t('prizes.library.state')}>
                      <div>
                        <PrizeState p={p} />
                        {!p.archived && !!p.active_rules && <div className="muted small">{t('prizes.library.running', { count: p.active_rules })}</div>}
                      </div>
                    </td>
                    <td className="set-actions">
                      <div className="row">
                        {!p.archived && (
                          <button
                            className="btn btn-small"
                            onClick={async () => {
                              if (await confirm({ title: t('prizes.library.archiveTitle', { name: p.name }), text: t('prizes.library.archiveConfirm'), confirmLabel: t('prizes.library.archive') })) archive.mutate(p.id);
                            }}
                          >
                            {t('prizes.library.archive')}
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <form className="card stack" onSubmit={(e) => { e.preventDefault(); add.mutate(); }}>
        <h3>{t('prizes.add.title')}</h3>
        <div className="fx-kind">
        <Segmented
          label={t('prizes.add.kind')}
          value={kind}
          onChange={setKind}
          options={[
            { value: 'piece', label: t('fx.prizes.addPiece') },
            { value: 'link', label: t('prizes.add.link') },
            { value: 'file', label: t('prizes.add.file') },
          ]}
        />
        </div>
        {/* For a piece, the piece comes first: its title is where the name starts from. */}
        <div className="set-fields">
          {kind !== 'piece' && nameField}
          {kind === 'piece' ? (
            <Field label={t('fx.prizes.piece')} hint={t('fx.prizes.pieceHint')}>
              <Select
                key={round}
                label={t('fx.prizes.piece')}
                value={pieceId}
                onChange={(id) => {
                  setPieceId(id);
                  // The piece's title is a good name to start from.
                  if (!name.trim()) setName(choosable.find((p) => p.id === id)?.title.slice(0, 120) ?? '');
                }}
                placeholder={pieces.isLoading ? t('common.loading') : choosable.length ? t('fx.prizes.choosePiece') : t('fx.prizes.noPieces')}
                disabled={!choosable.length}
                options={choosable.map((p) => ({
                  value: p.id,
                  icon: <PieceThumb versionId={p.latest_version?.id} />,
                  label: p.review_state === 'approved' ? p.title : <>{p.title} <span className="muted">· {t('fx.prizes.notApprovedYet')}</span></>,
                }))}
              />
            </Field>
          ) : kind === 'link' ? (
            <Field label={t('prizes.add.url')} hint={t('prizes.add.urlHint')}>
              <input type="url" required placeholder="https://" value={url} onChange={(e) => setUrl(e.target.value)} />
            </Field>
          ) : (
            <Field label={t('prizes.add.fileLabel')} hint={t('prizes.add.fileHint')}>
              <input ref={input} type="file" required onChange={(e) => setFile(e.target.files?.[0] ?? null)} aria-label={t('prizes.add.fileAria')} />
            </Field>
          )}
          {kind === 'piece' && nameField}
        </div>
        {add.error && <ErrorBox error={add.error} />}
        {label && <div className="notice notice-info" role="status" style={{ margin: 0 }}>{label}</div>}
        <div><button className="btn btn-primary" disabled={add.isPending || (kind === 'piece' && !pieceId)}>{t('prizes.add.submit')}</button></div>
      </form>
    </>
  );
}

function Erase({ brandId }: { brandId: string }) {
  const toast = useToast();
  const confirm = useConfirm();
  const [who, setWho] = useState('');
  const [by, setBy] = useState<'name' | 'personId'>('name');
  const erase = useMutation({
    mutationFn: () => api.post<{ deleted: number }>(`/api/brands/${brandId}/prizes/erase`, { [by]: who }),
    onSuccess: (r) => { toast(r.deleted ? t('prizes.erase.deleted', { count: r.deleted }) : t('prizes.erase.nothing')); setWho(''); },
  });
  return (
    <form
      className="card set-danger stack"
      onSubmit={async (e) => {
        e.preventDefault();
        if (await confirm({ title: t('prizes.erase.ask', { who }), text: t('prizes.erase.confirm'), confirmLabel: t('prizes.erase.submit'), danger: true })) erase.mutate();
      }}
    >
      <h3>{t('prizes.erase.title')}</h3>
      <p className="set-hint">{t('prizes.erase.hint')}</p>
      <div className="set-fields">
        <Field label={t('prizes.erase.by')}>
          <Select label={t('prizes.erase.by')} value={by} onChange={setBy} options={[{ value: 'name', label: t('prizes.erase.byName') }, { value: 'personId', label: t('prizes.erase.byId') }]} />
        </Field>
        <Field label={by === 'name' ? t('prizes.erase.name') : t('prizes.erase.id')}>
          <input type="text" required maxLength={200} value={who} onChange={(e) => setWho(e.target.value)} />
        </Field>
      </div>
      {erase.error && <ErrorBox error={erase.error} />}
      <div><button className="btn btn-danger" disabled={erase.isPending || !who.trim()}>{t('prizes.erase.submit')}</button></div>
    </form>
  );
}

function MetaSetup() {
  const base = window.location.origin;
  const rows: [string, string, string][] = [
    [t('prizes.meta.webhook'), `${base}/api/meta/webhook`, t('prizes.meta.webhookHint')],
    [t('prizes.meta.deletion'), `${base}/api/meta/data-deletion`, t('prizes.meta.deletionHint')],
    [t('prizes.meta.instructions'), `${base}/data-deletion`, t('prizes.meta.instructionsHint')],
  ];
  return (
    <section className="card">
      <div className="set-card-head" style={{ marginBottom: '.5rem' }}>
        <div>
          <h3>{t('prizes.meta.title')}</h3>
          <p className="set-hint">{t('prizes.meta.hint')}</p>
        </div>
      </div>
      {rows.map(([label, value, help]) => (
        <div key={value} className="set-copy">
          <div style={{ minWidth: 0 }}>
            <div className="small" style={{ fontWeight: 500, marginBottom: '.25rem' }}>{label}</div>
            <code>{value}</code>
          </div>
          <CopyButton text={value} />
          <p className="set-hint">{help}</p>
        </div>
      ))}
    </section>
  );
}

export function PrizesSettings({ brandId }: { brandId: string }) {
  const { data: brand, error } = useQuery({ queryKey: ['brand', brandId], queryFn: () => api.get<BrandSettings>(`/api/brands/${brandId}`) });
  if (error) return <ErrorBox error={error} />;
  if (!brand) return <Spinner />;
  return (
    <>
      <Settings brand={brand} />
      <Library brandId={brandId} />
      <MetaSetup />
      <Erase brandId={brandId} />
    </>
  );
}
