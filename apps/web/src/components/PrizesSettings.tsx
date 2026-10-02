import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import { api, type BrandSettings, type Prize } from '../api';
import { fmtBytes } from '../lib/format';
import { uploadPrizeFile, type Progress } from '../lib/upload';
import { CopyButton, Empty, ErrorBox, errorMessage, Field, Spinner, useToast } from './ui';

function Settings({ brand }: { brand: BrandSettings }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [form, setForm] = useState<null | BrandSettings['prizes']>(null);
  const f = form ?? brand.prizes;
  const save = useMutation({
    mutationFn: () => api.patch(`/api/brands/${brand.id}`, { prizes: f }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['brand'] }); setForm(null); toast('Saved'); },
  });
  return (
    <form className="card stack" onSubmit={(e) => { e.preventDefault(); save.mutate(); }}>
      <h3>Prizes for commenting</h3>
      <p className="muted" style={{ margin: 0 }}>
        A post can carry a prize: whoever comments a keyword gets a file or a link by private message, sent by the app. It works on Instagram and Facebook;
        the other networks get a public page to link from a pinned comment.
      </p>
      <label className="check">
        <input type="checkbox" checked={f.enabled} onChange={(e) => setForm({ ...f, enabled: e.target.checked })} />
        <span>
          Use prizes in this brand
          <span className="muted small" style={{ display: 'block' }}>
            Switching it on makes the next Meta sign-in ask for the permission to send messages. Accounts connected before have to be connected again
            (Accounts → Renew) to grant it; Meta may also need to review the app for it.
          </span>
        </span>
      </label>
      <div className="row">
        <div style={{ flex: '0 1 220px' }}>
          <Field label="Keep people for (days)" hint="Who commented is deleted after this. At least 8: Meta allows 7 days to answer a comment.">
            <input type="number" min={8} max={365} value={f.retention_days} onChange={(e) => setForm({ ...f, retention_days: Number(e.target.value) })} />
          </Field>
        </div>
        <div style={{ flex: '1 1 260px' }}>
          <Field label="Note added to every message" hint="Says the message is automatic. It cannot be left out.">
            <input type="text" required maxLength={200} value={f.auto_notice} onChange={(e) => setForm({ ...f, auto_notice: e.target.value })} />
          </Field>
        </div>
      </div>
      {save.error && <ErrorBox error={save.error} />}
      <div><button className="btn btn-primary" disabled={save.isPending || form === null}>Save</button></div>
    </form>
  );
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
      if (!file) throw new Error('Choose the file to give');
      return uploadPrizeFile(brandId, name, file, setProgress);
    },
    onSuccess: () => { refresh(); reset(); toast('Prize added'); },
    onSettled: () => setProgress(null),
  });
  const archive = useMutation({
    mutationFn: (id: string) => api.post(`/api/prizes/${id}/archive`),
    onSuccess: refresh,
    onError: (e) => toast(errorMessage(e), 'error'),
  });
  const label = progress
    ? progress.step === 'hashing' ? 'Checking the file…' : progress.step === 'uploading' ? `Uploading… ${Math.round(progress.fraction * 100)}%` : 'Finishing…'
    : null;

  return (
    <div className="stack">
      <div className="card">
        <div className="card-head"><h3>Prizes</h3></div>
        {error && <ErrorBox error={error} />}
        {!data && !error && <Spinner />}
        {data?.length === 0 && <Empty title="No prizes yet">Add a file to give out, or a link to somewhere else.</Empty>}
        {data && data.length > 0 && (
          <div className="table-wrap">
            <table>
              <thead><tr><th>Name</th><th>What</th><th>State</th><th /></tr></thead>
              <tbody>
                {data.map((p) => (
                  <tr key={p.id}>
                    <td><strong>{p.name}</strong></td>
                    <td>
                      {p.kind === 'file' ? <>File · {p.file_name} <span className="muted small">({fmtBytes(p.file_bytes ?? 0)})</span></> : <>Link · <a href={p.url ?? '#'} target="_blank" rel="noreferrer">{p.url}</a></>}
                    </td>
                    <td>
                      {p.archived ? <span className="chip">Archived</span> : p.usable ? <span className="chip chip-approved">Ready</span> : <span className="chip chip-failed">File missing</span>}
                      {!p.archived && !!p.active_rules && <div className="muted small">Running on {p.active_rules} post{p.active_rules === 1 ? '' : 's'}</div>}
                    </td>
                    <td>
                      {!p.archived && <button className="btn btn-small" onClick={() => confirm(`Archive “${p.name}”? Posts already running it keep working; it cannot be chosen for new ones.`) && archive.mutate(p.id)}>Archive</button>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <form className="card stack" onSubmit={(e) => { e.preventDefault(); add.mutate(); }}>
        <h3>Add a prize</h3>
        <div className="row">
          <label className="check"><input type="radio" name="prize-kind" checked={kind === 'link'} onChange={() => setKind('link')} /><span>A link</span></label>
          <label className="check"><input type="radio" name="prize-kind" checked={kind === 'file'} onChange={() => setKind('file')} /><span>A file kept here</span></label>
        </div>
        <Field label="Name" hint="What people see on the page and in the message.">
          <input type="text" required maxLength={120} value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        {kind === 'link' ? (
          <Field label="Link" hint="Where the person is sent. Anyone who gets the message can open it, so do not link to anything private.">
            <input type="url" required placeholder="https://" value={url} onChange={(e) => setUrl(e.target.value)} />
          </Field>
        ) : (
          <Field label="File" hint="Up to 200 MB. People get a download link that works for a short time and a few downloads.">
            <input ref={input} type="file" required onChange={(e) => setFile(e.target.files?.[0] ?? null)} aria-label="Prize file" />
          </Field>
        )}
        {add.error && <ErrorBox error={add.error} />}
        {label && <div className="notice notice-info" role="status">{label}</div>}
        <div><button className="btn btn-primary" disabled={add.isPending}>Add prize</button></div>
      </form>
    </div>
  );
}

function Erase({ brandId }: { brandId: string }) {
  const toast = useToast();
  const [who, setWho] = useState('');
  const [by, setBy] = useState<'name' | 'personId'>('name');
  const erase = useMutation({
    mutationFn: () => api.post<{ deleted: number }>(`/api/brands/${brandId}/prizes/erase`, { [by]: who }),
    onSuccess: (r) => { toast(r.deleted ? `Deleted ${r.deleted} entr${r.deleted === 1 ? 'y' : 'ies'}` : 'Nothing was kept about that person'); setWho(''); },
  });
  return (
    <form className="card stack" onSubmit={(e) => { e.preventDefault(); if (confirm('Delete everything kept about this person from prizes? This cannot be undone.')) erase.mutate(); }}>
      <h3>Erase a person</h3>
      <p className="muted" style={{ margin: 0 }}>If someone asks to be forgotten, delete what prizes kept about them. People are also deleted automatically when the retention period ends.</p>
      <div className="row">
        <div><Field label="By"><select value={by} onChange={(e) => setBy(e.target.value as 'name' | 'personId')}><option value="name">The name they show</option><option value="personId">Their id on the network</option></select></Field></div>
        <div className="grow"><Field label={by === 'name' ? 'Name' : 'Id'}><input type="text" required maxLength={200} value={who} onChange={(e) => setWho(e.target.value)} /></Field></div>
      </div>
      {erase.error && <ErrorBox error={erase.error} />}
      <div><button className="btn btn-danger" disabled={erase.isPending}>Erase</button></div>
    </form>
  );
}

function MetaSetup() {
  const base = window.location.origin;
  const rows = [
    ['Webhook callback URL', `${base}/api/meta/webhook`, 'Meta → your app → Webhooks. Subscribe the Instagram and Page objects to comments. The verify token is META_WEBHOOK_VERIFY_TOKEN on the server.'],
    ['Data deletion callback URL', `${base}/api/meta/data-deletion`, 'Meta → your app → Settings → Basic. Meta calls it when someone removes the app from their account.'],
    ['Data deletion instructions URL', `${base}/data-deletion`, 'The public page that tells people how to have their data deleted.'],
  ];
  return (
    <div className="card stack">
      <h3>Meta app setup</h3>
      <p className="muted" style={{ margin: 0 }}>
        Meta only pushes comments to an app it has reviewed, and only reviewed apps may send private messages to people outside the team.
        Until then the app reads the comments of posts with a running prize every few minutes instead.
      </p>
      {rows.map(([label, value, help]) => (
        <div key={label} className="stack" style={{ gap: '.25rem' }}>
          <div className="row-between"><strong>{label}</strong><CopyButton text={value!} /></div>
          <code className="mono small" style={{ overflowWrap: 'anywhere' }}>{value}</code>
          <span className="muted small">{help}</span>
        </div>
      ))}
    </div>
  );
}

export function PrizesSettings({ brandId }: { brandId: string }) {
  const { data: brand } = useQuery({ queryKey: ['brand', brandId], queryFn: () => api.get<BrandSettings>(`/api/brands/${brandId}`) });
  if (!brand) return <Spinner />;
  return (
    <div className="stack">
      <Settings brand={brand} />
      <Library brandId={brandId} />
      <MetaSetup />
      <Erase brandId={brandId} />
    </div>
  );
}
