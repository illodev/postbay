import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api, type SlackSettings } from '../api';
import { fmtShort } from '../lib/format';
import { ErrorBox, errorMessage, Field, Spinner, useToast } from './ui';

/** Posts chosen events to a Slack channel, through that channel's incoming webhook. The address is a secret: it is never shown again. */
export function SlackSettingsCard({ brandId }: { brandId: string }) {
  const qc = useQueryClient();
  const toast = useToast();
  const { data, error } = useQuery({ queryKey: ['slack', brandId], queryFn: () => api.get<SlackSettings>(`/api/brands/${brandId}/slack`) });
  const [url, setUrl] = useState('');
  const [kinds, setKinds] = useState<Set<string> | null>(null);
  const refresh = () => qc.invalidateQueries({ queryKey: ['slack', brandId] });

  const save = useMutation({
    mutationFn: () => api.put<SlackSettings>(`/api/brands/${brandId}/slack`, { ...(url.trim() ? { url: url.trim() } : {}), kinds: [...(kinds ?? new Set(data!.kinds))] }),
    onSuccess: () => { setUrl(''); setKinds(null); refresh(); toast('Saved'); },
  });
  const test = useMutation({
    mutationFn: () => api.post<{ ok: true } | { ok: false; message: string }>(`/api/brands/${brandId}/slack/test`),
    onSuccess: (r) => { refresh(); toast(r.ok ? 'Sent: look in the channel' : `Slack said no: ${r.message}`, r.ok ? 'ok' : 'error'); },
    onError: (e) => toast(errorMessage(e), 'error'),
  });
  const remove = useMutation({
    mutationFn: () => api.del(`/api/brands/${brandId}/slack`),
    onSuccess: () => { setKinds(null); refresh(); toast('Slack removed'); },
  });

  if (error) return <ErrorBox error={error} />;
  if (!data) return <Spinner />;
  const chosen = kinds ?? new Set(data.kinds);
  const flip = (k: string) => { const n = new Set(chosen); if (n.has(k)) n.delete(k); else n.add(k); setKinds(n); };
  return (
    <form className="card stack" onSubmit={(e) => { e.preventDefault(); save.mutate(); }} aria-label="Slack">
      <div className="row-between">
        <h3>Slack</h3>
        {data.configured && !data.disabledReason && <span className="chip chip-approved">On · {data.hint}</span>}
        {data.disabledReason && <span className="chip chip-failed">Stopped</span>}
      </div>
      <p className="muted" style={{ margin: 0 }}>
        Posts to a channel, once for the team. In Slack, make an <em>incoming webhook</em> for the channel and paste its address here. The address is a secret:
        it is kept sealed and cannot be read back, only replaced.
      </p>
      {!data.available && <div className="notice notice-warn">The server has no TOKEN_KEY, which seals the address, so Slack cannot be set up yet.</div>}
      {data.disabledReason && <div className="notice notice-bad" role="alert">Slack stopped taking messages ({data.disabledReason}). Paste a new webhook address to start again.</div>}
      {!data.disabledReason && data.lastError && <div className="notice notice-warn">The last post failed: {data.lastError}</div>}
      <Field label={data.configured ? 'Replace the webhook address (optional)' : 'Webhook address'} hint="Starts with https://hooks.slack.com/services/">
        <input type="url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://hooks.slack.com/services/…" autoComplete="off" required={!data.configured} disabled={!data.available} />
      </Field>
      <fieldset className="stack" style={{ border: 'none', padding: 0, margin: 0 }}>
        <legend className="field-label">Post when…</legend>
        {data.allKinds.map((k) => (
          <label key={k.kind} className="check">
            <input type="checkbox" checked={chosen.has(k.kind)} onChange={() => flip(k.kind)} disabled={!data.available} />
            <span>{k.label}</span>
          </label>
        ))}
      </fieldset>
      {save.error && <ErrorBox error={save.error} />}
      <div className="row">
        <button className="btn btn-primary" disabled={!data.available || save.isPending || chosen.size === 0 || (!data.configured && !url.trim())}>Save</button>
        {data.configured && <button type="button" className="btn" onClick={() => test.mutate()} disabled={test.isPending}>Send a test message</button>}
        {data.configured && <button type="button" className="btn btn-danger" onClick={() => confirm('Stop posting to Slack?') && remove.mutate()}>Remove</button>}
      </div>
      {data.lastOkAt && <p className="muted small" style={{ margin: 0 }}>Last message posted {fmtShort(data.lastOkAt)}.</p>}
    </form>
  );
}
