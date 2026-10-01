import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { api, type Account, type PublicationRow, type VersionDetail } from '../api';
import { fmtBytes, fmtDateTime, isoToZonedInput, NETWORK_LABEL, zonedToIso } from '../lib/format';
import { Chip, CopyButton, Dialog, ErrorBox, Field } from './ui';
import { useToast } from './ui';

/** Accounts a version is approved for right now: the ones every counted approver agreed on. */
export function approvedAccountIds(v: VersionDetail): string[] {
  const rows = v.approvals.filter((a) => a.decision === 'approve' && a.matches_fingerprint);
  if (!rows.length) return [];
  return rows.map((r) => r.account_ids).reduce((acc, ids) => acc.filter((x) => ids.includes(x)));
}

function useInvalidate() {
  const qc = useQueryClient();
  return () => {
    for (const key of ['piece', 'version', 'calendar', 'due', 'pieces']) qc.invalidateQueries({ queryKey: [key] });
  };
}

// ───────────────────────────── schedule ─────────────────────────────

export function ScheduleDialog({ version, brandId, zone, onClose }: { version: VersionDetail; brandId: string; zone: string; onClose: () => void }) {
  const invalidate = useInvalidate();
  const toast = useToast();
  const { data: accounts } = useQuery({ queryKey: ['accounts', brandId], queryFn: () => api.get<Account[]>(`/api/brands/${brandId}/accounts`) });
  const allowed = approvedAccountIds(version);
  const options = (accounts ?? []).filter((a) => allowed.includes(a.id));
  const [accountId, setAccountId] = useState('');
  const [when, setWhen] = useState('');
  const [text, setText] = useState('');
  const [firstComment, setFirstComment] = useState('');
  const [formError, setFormError] = useState<string | null>(null);
  const chosen = accountId || options[0]?.id || '';
  const create = useMutation({
    mutationFn: () => api.post(`/api/versions/${version.id}/publications`, { accountId: chosen, scheduledAt: zonedToIso(when, zone), text, firstComment }),
    onSuccess: () => {
      invalidate();
      toast('Scheduled');
      onClose();
    },
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    setFormError(null);
    try {
      zonedToIso(when, zone);
    } catch (err) {
      setFormError((err as Error).message);
      return;
    }
    create.mutate();
  };
  return (
    <Dialog title="Schedule a publication" onClose={onClose}>
      <form className="stack" onSubmit={submit}>
        <p className="muted small">Only the accounts this version was approved for are listed.</p>
        <Field label="Account">
          <select value={chosen} onChange={(e) => setAccountId(e.target.value)} required>
            {options.map((a) => <option key={a.id} value={a.id}>{NETWORK_LABEL[a.network] ?? a.network} · {a.display_name}</option>)}
          </select>
        </Field>
        <Field label={`Date and time (${zone})`}>
          <input type="datetime-local" required value={when} onChange={(e) => setWhen(e.target.value)} />
        </Field>
        <Field label="Text" hint="The caption or description for this account.">
          <textarea value={text} onChange={(e) => setText(e.target.value)} />
        </Field>
        <Field label="First comment (optional)">
          <textarea value={firstComment} onChange={(e) => setFirstComment(e.target.value)} style={{ minHeight: 56 }} />
        </Field>
        {formError && <div className="notice notice-bad" role="alert">{formError}</div>}
        {create.error && <ErrorBox error={create.error} />}
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" disabled={create.isPending || !chosen || !when}>Schedule</button>
        </div>
      </form>
    </Dialog>
  );
}

// ───────────────────────────── move / edit ─────────────────────────────

export function MoveDialog({ pub, zone, needsConfirmation, onClose }: { pub: { id: string; scheduled_at: string; text: string }; zone: string; needsConfirmation: boolean; onClose: () => void }) {
  const invalidate = useInvalidate();
  const toast = useToast();
  const [when, setWhen] = useState(isoToZonedInput(pub.scheduled_at, zone));
  const [text, setText] = useState(pub.text);
  const save = useMutation({
    mutationFn: () => api.patch(`/api/publications/${pub.id}`, { scheduledAt: zonedToIso(when, zone), text }),
    onSuccess: () => {
      invalidate();
      toast(needsConfirmation ? 'Saved: another approver has to confirm it' : 'Saved');
      onClose();
    },
  });
  return (
    <Dialog title="Move or edit" onClose={onClose}>
      <form className="stack" onSubmit={(e) => { e.preventDefault(); save.mutate(); }}>
        {needsConfirmation && <div className="notice notice-info">This brand needs a second approver to confirm any change to something already scheduled.</div>}
        <Field label={`Date and time (${zone})`}>
          <input type="datetime-local" required value={when} onChange={(e) => setWhen(e.target.value)} />
        </Field>
        <Field label="Text">
          <textarea value={text} onChange={(e) => setText(e.target.value)} />
        </Field>
        {save.error && <ErrorBox error={save.error} />}
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" disabled={save.isPending || !when}>Save</button>
        </div>
      </form>
    </Dialog>
  );
}

export function MarkPublishedDialog({ pubId, onClose }: { pubId: string; onClose: () => void }) {
  const invalidate = useInvalidate();
  const toast = useToast();
  const [url, setUrl] = useState('');
  const mark = useMutation({
    mutationFn: () => api.post(`/api/publications/${pubId}/mark-published`, url ? { url } : {}),
    onSuccess: () => {
      invalidate();
      toast('Marked as published');
      onClose();
    },
  });
  return (
    <Dialog title="Mark as published" onClose={onClose}>
      <form className="stack" onSubmit={(e) => { e.preventDefault(); mark.mutate(); }}>
        <p className="muted">Confirm it is live on the network. Paste the link if you have it, so it stays on record.</p>
        <Field label="Link to the post (optional)">
          <input type="url" placeholder="https://" value={url} onChange={(e) => setUrl(e.target.value)} />
        </Field>
        {mark.error && <ErrorBox error={mark.error} />}
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" disabled={mark.isPending}>Mark as published</button>
        </div>
      </form>
    </Dialog>
  );
}

// ───────────────────────────── reschedule a held publication ─────────────────────────────

export function RescheduleDialog({ pub, approvedVersions, zone, onClose }: {
  pub: PublicationRow;
  approvedVersions: { id: string; number: number }[];
  zone: string;
  onClose: () => void;
}) {
  const invalidate = useInvalidate();
  const toast = useToast();
  const [versionId, setVersionId] = useState(approvedVersions[0]?.id ?? '');
  const [when, setWhen] = useState(isoToZonedInput(pub.scheduled_at, zone));
  const go = useMutation({
    mutationFn: () => api.post(`/api/publications/${pub.id}/reschedule`, { versionId, scheduledAt: zonedToIso(when, zone) }),
    onSuccess: () => {
      invalidate();
      toast('Back on the calendar');
      onClose();
    },
  });
  return (
    <Dialog title="Put back on the calendar" onClose={onClose}>
      <form className="stack" onSubmit={(e) => { e.preventDefault(); go.mutate(); }}>
        <p className="muted">A new version replaced the one this was scheduled with. Pick the approved version to publish.</p>
        {approvedVersions.length === 0 ? (
          <div className="notice notice-warn">No version of this variant is approved yet. Approve the new one first.</div>
        ) : (
          <Field label="Version">
            <select value={versionId} onChange={(e) => setVersionId(e.target.value)}>
              {approvedVersions.map((v) => <option key={v.id} value={v.id}>Version {v.number}</option>)}
            </select>
          </Field>
        )}
        <Field label={`Date and time (${zone})`}>
          <input type="datetime-local" required value={when} onChange={(e) => setWhen(e.target.value)} />
        </Field>
        {go.error && <ErrorBox error={go.error} />}
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" disabled={go.isPending || !versionId}>Reschedule</button>
        </div>
      </form>
    </Dialog>
  );
}

// ───────────────────────────── the pack for publishing by hand ─────────────────────────────

interface Pack {
  id: string;
  status: string;
  scheduled_at: string;
  text: string;
  first_comment: string;
  account: { network: string; display_name: string };
  piece: { id: string; title: string };
  files: { kind: string; position: number; name: string; mime: string; bytes: number; url: string }[];
}

export function PackDialog({ pubId, zone, onClose, onPublished }: { pubId: string; zone: string; onClose: () => void; onPublished: () => void }) {
  const { data, error } = useQuery({ queryKey: ['pack', pubId], queryFn: () => api.get<Pack>(`/api/publications/${pubId}/pack`) });
  return (
    <Dialog title="Publish by hand" onClose={onClose} wide>
      {error && <ErrorBox error={error} />}
      {data && (
        <div className="stack">
          <div className="row">
            <strong>{NETWORK_LABEL[data.account.network] ?? data.account.network} · {data.account.display_name}</strong>
            <Chip state={data.status} />
            <span className="muted">{fmtDateTime(data.scheduled_at, zone)}</span>
          </div>
          <div>
            <h3>Files</h3>
            <div className="stack" style={{ marginTop: '.4rem' }}>
              {data.files.map((f) => (
                <div key={`${f.kind}-${f.position}`} className="row-between">
                  <span>{f.kind} {f.kind === 'video' || f.kind === 'image' ? f.position + 1 : ''} · {f.name} <span className="muted small">({fmtBytes(f.bytes)})</span></span>
                  <a className="btn btn-small" href={f.url} download={f.name}>Download</a>
                </div>
              ))}
            </div>
          </div>
          <div>
            <div className="row-between"><h3>Text</h3><CopyButton text={data.text} /></div>
            <pre className="card mono" style={{ whiteSpace: 'pre-wrap', margin: '.4rem 0 0' }}>{data.text || '—'}</pre>
          </div>
          {data.first_comment && (
            <div>
              <div className="row-between"><h3>First comment</h3><CopyButton text={data.first_comment} /></div>
              <pre className="card mono" style={{ whiteSpace: 'pre-wrap', margin: '.4rem 0 0' }}>{data.first_comment}</pre>
            </div>
          )}
          <div className="row" style={{ justifyContent: 'flex-end' }}>
            <button className="btn" onClick={onClose}>Close</button>
            {data.status === 'scheduled' && <button className="btn btn-primary" onClick={onPublished}>I published it…</button>}
          </div>
        </div>
      )}
    </Dialog>
  );
}
