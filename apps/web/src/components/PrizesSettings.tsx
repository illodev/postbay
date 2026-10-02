import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import { api, type BrandSettings, type Prize } from '../api';
import { t } from '../i18n';
import { fmtBytes } from '../lib/format';
import { uploadPrizeFile, type Progress } from '../lib/upload';
import { Chip, CopyButton, Empty, ErrorBox, errorMessage, Field, Spinner, useToast } from './ui';

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
        <div>
          <h3>{t('prizes.settings.title')}</h3>
          <p className="set-hint">{t('prizes.settings.hint')}</p>
        </div>
        {brand.prizes.enabled ? <Chip state="approved" label={t('prizes.settings.on')} /> : <Chip state="draft" label={t('prizes.settings.off')} />}
      </div>
      <label className="check">
        <input type="checkbox" checked={f.enabled} onChange={(e) => setForm({ ...f, enabled: e.target.checked })} />
        <span>
          {t('prizes.settings.enable')}
          <span className="muted small" style={{ display: 'block' }}>{t('prizes.settings.enableHint')}</span>
        </span>
      </label>
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
  if (!p.usable) return <Chip state="failed" label={t('prizes.state.missing')} />;
  return <Chip state="approved" label={t('prizes.state.ready')} />;
}

function Library({ brandId }: { brandId: string }) {
  const qc = useQueryClient();
  const toast = useToast();
  const { data, error } = useQuery({ queryKey: ['prizes', brandId], queryFn: () => api.get<Prize[]>(`/api/brands/${brandId}/prizes`) });
  const [kind, setKind] = useState<'link' | 'file'>('link');
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [progress, setProgress] = useState<Progress | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const refresh = () => qc.invalidateQueries({ queryKey: ['prizes'] });
  const reset = () => { setName(''); setUrl(''); setFile(null); if (input.current) input.current.value = ''; };

  const add = useMutation({
    mutationFn: async () => {
      if (kind === 'link') return api.post(`/api/brands/${brandId}/prizes`, { kind: 'link', name, url });
      if (!file) throw new Error(t('prizes.add.chooseFile'));
      return uploadPrizeFile(brandId, name, file, setProgress);
    },
    onSuccess: () => { refresh(); reset(); toast(t('prizes.add.done')); },
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
                        <span className="tag">{p.kind === 'file' ? t('prizes.kind.file') : t('prizes.kind.link')}</span>{' '}
                        {p.kind === 'file'
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
                        {!p.archived && <button className="btn btn-small" onClick={() => confirm(t('prizes.library.archiveConfirm', { name: p.name })) && archive.mutate(p.id)}>{t('prizes.library.archive')}</button>}
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
        <fieldset className="set-fieldset">
          <legend className="sr-only">{t('prizes.add.kind')}</legend>
          <div className="row" style={{ gap: '1.25rem' }}>
            <label className="check"><input type="radio" name="prize-kind" checked={kind === 'link'} onChange={() => setKind('link')} /><span>{t('prizes.add.link')}</span></label>
            <label className="check"><input type="radio" name="prize-kind" checked={kind === 'file'} onChange={() => setKind('file')} /><span>{t('prizes.add.file')}</span></label>
          </div>
        </fieldset>
        <div className="set-fields">
          <Field label={t('prizes.add.name')} hint={t('prizes.add.nameHint')}>
            <input type="text" required maxLength={120} value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
          {kind === 'link' ? (
            <Field label={t('prizes.add.url')} hint={t('prizes.add.urlHint')}>
              <input type="url" required placeholder="https://" value={url} onChange={(e) => setUrl(e.target.value)} />
            </Field>
          ) : (
            <Field label={t('prizes.add.fileLabel')} hint={t('prizes.add.fileHint')}>
              <input ref={input} type="file" required onChange={(e) => setFile(e.target.files?.[0] ?? null)} aria-label={t('prizes.add.fileAria')} />
            </Field>
          )}
        </div>
        {add.error && <ErrorBox error={add.error} />}
        {label && <div className="notice notice-info" role="status" style={{ margin: 0 }}>{label}</div>}
        <div><button className="btn btn-primary" disabled={add.isPending}>{t('prizes.add.submit')}</button></div>
      </form>
    </>
  );
}

function Erase({ brandId }: { brandId: string }) {
  const toast = useToast();
  const [who, setWho] = useState('');
  const [by, setBy] = useState<'name' | 'personId'>('name');
  const erase = useMutation({
    mutationFn: () => api.post<{ deleted: number }>(`/api/brands/${brandId}/prizes/erase`, { [by]: who }),
    onSuccess: (r) => { toast(r.deleted ? t('prizes.erase.deleted', { count: r.deleted }) : t('prizes.erase.nothing')); setWho(''); },
  });
  return (
    <form className="card set-danger stack" onSubmit={(e) => { e.preventDefault(); if (confirm(t('prizes.erase.confirm', { who }))) erase.mutate(); }}>
      <h3>{t('prizes.erase.title')}</h3>
      <p className="set-hint">{t('prizes.erase.hint')}</p>
      <div className="set-fields">
        <Field label={t('prizes.erase.by')}>
          <select value={by} onChange={(e) => setBy(e.target.value as 'name' | 'personId')}>
            <option value="name">{t('prizes.erase.byName')}</option>
            <option value="personId">{t('prizes.erase.byId')}</option>
          </select>
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
