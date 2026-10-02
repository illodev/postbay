import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState, type FormEvent } from 'react';
import { api, type Account, type AccountOptionsReply, type Attempt, type Capabilities, type Integrations, type Issue, type Plan, type PublicationRow, type VersionDetail } from '../api';
import { countHashtags, countLength, countMentions, truncatePreview } from '../lib/text';
import { ERROR_CLASS_LABEL, fmtBytes, fmtDateTime, isoToZonedInput, NETWORK_LABEL, STEP_LABEL, VISIBILITY_LABEL, zonedToIso } from '../lib/format';
import { Chip, CopyButton, Dialog, ErrorBox, Field } from './ui';
import { defaultValues, NetworkOptions, sendableOptions, type OptionValues } from './NetworkOptions';
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

// ───────────────────────────── per-network text ─────────────────────────────

function Counter({ label, value, max }: { label: string; value: number; max?: number }) {
  const over = max !== undefined && value > max;
  return (
    <span className="counter" data-over={over || undefined} aria-label={`${label}: ${value}${max !== undefined ? ` of ${max}` : ''}`}>
      {label} {value}{max !== undefined ? ` / ${max}` : ''}
    </span>
  );
}

/** The text box for one network: its limits next to what has been typed, and what a feed shows before "more". */
export function NetworkText({ caps, label, hint, value, onChange }: { caps: Capabilities | undefined; label: string; hint?: string; value: string; onChange: (v: string) => void }) {
  const t = caps?.text;
  const cut = t?.previewCutoff ? truncatePreview(value, t.previewCutoff) : null;
  return (
    <div className="stack" style={{ gap: '.35rem' }}>
      <Field label={label} hint={hint}>
        <textarea value={value} onChange={(e) => onChange(e.target.value)} />
      </Field>
      {t && (
        <div className="row counters">
          <Counter label={t.unit === 'graphemes' ? 'Characters (as seen)' : 'Characters'} value={countLength(value, t.unit)} max={t.maxChars} />
          {t.maxHashtags !== undefined && <Counter label="Hashtags" value={countHashtags(value)} max={t.maxHashtags} />}
          {t.maxMentions !== undefined && <Counter label="Mentions" value={countMentions(value)} max={t.maxMentions} />}
        </div>
      )}
      {t?.previewCutoff !== undefined && value && (
        <div className="preview-text" aria-label="How the feed shows it">
          <span className="muted small">In the feed</span>
          <div>
            {cut ? <>{cut.shown}<span className="preview-more">… more</span></> : value}
          </div>
          {cut && <span className="muted small">Readers see the first {t.previewCutoff} characters before tapping “more”. Put the point there.</span>}
        </div>
      )}
    </div>
  );
}

// ───────────────────────────── schedule ─────────────────────────────

function IssueList({ issues }: { issues: Issue[] }) {
  if (!issues.length) return null;
  return (
    <ul className="issues">
      {issues.map((i, n) => (
        <li key={`${i.code}-${n}`} className={i.severity === 'error' ? 'issue-error' : 'issue-warn'}>
          <strong>{i.severity === 'error' ? 'Blocks publishing' : 'Heads up'}</strong> · {i.message}
        </li>
      ))}
    </ul>
  );
}

/** The value a moment after it stopped changing. Compared by content: a new object with the same fields is not a change. */
function useDebounced<T>(value: T, ms: number): T {
  const key = JSON.stringify(value);
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(JSON.parse(key) as T), ms);
    return () => clearTimeout(t);
  }, [key, ms]);
  return v;
}

export function ScheduleDialog({ version, brandId, zone, onClose }: { version: VersionDetail; brandId: string; zone: string; onClose: () => void }) {
  const invalidate = useInvalidate();
  const toast = useToast();
  const { data: accounts } = useQuery({ queryKey: ['accounts', brandId], queryFn: () => api.get<Account[]>(`/api/brands/${brandId}/accounts`) });
  const { data: integ } = useQuery({ queryKey: ['integrations', brandId], queryFn: () => api.get<Integrations>(`/api/brands/${brandId}/integrations`) });
  const allowed = approvedAccountIds(version);
  const options = (accounts ?? []).filter((a) => allowed.includes(a.id));
  const [accountId, setAccountId] = useState('');
  const [when, setWhen] = useState('');
  const [text, setText] = useState('');
  const [firstComment, setFirstComment] = useState('');
  const [placement, setPlacement] = useState('');
  const [byHand, setByHand] = useState(false);
  const [typed, setTyped] = useState<OptionValues>({});
  const [formError, setFormError] = useState<string | null>(null);
  const chosen = accountId || options[0]?.id || '';
  const account = options.find((a) => a.id === chosen);
  const caps = account ? integ?.capabilities[account.network] : undefined;
  const mode = byHand ? 'manual' : undefined;
  // The settings for this account, asked when the account is chosen: TikTok has to be asked, as the post is written, what this
  // creator may do, and only that is offered.
  const accountOpts = useQuery({
    queryKey: ['account-options', brandId, chosen],
    enabled: !!account?.automated && !byHand,
    staleTime: 0,
    queryFn: () => api.get<AccountOptionsReply>(`/api/brands/${brandId}/accounts/${chosen}/options`),
  });
  const fields = account?.automated && !byHand ? accountOpts.data?.fields : undefined;
  // What the network asks for, with its defaults under whatever the person has changed. Only what is showing is sent.
  const values: OptionValues = { ...defaultValues(fields), ...typed };

  // The server decides how it would go out and what would stop it. Asked again a moment after typing stops.
  const probe = useDebounced({ chosen, text, firstComment, placement, mode, when, options: sendableOptions(fields, placement || undefined, values) }, 350);
  const plan = useQuery({
    queryKey: ['plan', version.id, probe],
    enabled: !!probe.chosen,
    placeholderData: keepPreviousData,
    queryFn: () => {
      let scheduledAt: string | undefined;
      try { scheduledAt = probe.when ? zonedToIso(probe.when, zone) : undefined; } catch { scheduledAt = undefined; }
      return api.post<Plan>(`/api/versions/${version.id}/publications/validate`, {
        accountId: probe.chosen, text: probe.text, firstComment: probe.firstComment, placement: probe.placement || undefined, mode: probe.mode, scheduledAt, options: probe.options,
      });
    },
  });
  const p = plan.data;
  const errors = (p?.issues ?? []).filter((i) => i.severity === 'error');
  const blocked = !!p?.automated && errors.length > 0;

  const create = useMutation({
    mutationFn: () => api.post(`/api/versions/${version.id}/publications`, {
      accountId: chosen, scheduledAt: zonedToIso(when, zone), text, firstComment, placement: placement || undefined, mode,
      options: sendableOptions(fields, p?.placement ?? (placement || undefined), values),
    }),
    onSuccess: () => {
      invalidate();
      toast(p?.automated ? 'Scheduled: the app will publish it' : 'Scheduled: someone has to publish it');
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
  const canComment = caps ? caps.text.firstComment : true;
  const placementLabel = p?.placements.find((x) => x.id === p.placement)?.label;
  return (
    <Dialog title="Schedule a publication" onClose={onClose} wide>
      <form className="stack" onSubmit={submit}>
        <p className="muted small">Only the accounts this version was approved for are listed.</p>
        <div className="row">
          <div className="grow">
            <Field label="Account">
              <select value={chosen} onChange={(e) => { setAccountId(e.target.value); setPlacement(''); setTyped({}); }} required>
                {options.map((a) => <option key={a.id} value={a.id}>{NETWORK_LABEL[a.network] ?? a.network} · {a.display_name}</option>)}
              </select>
            </Field>
          </div>
          <div className="grow">
            <Field label={`Date and time (${zone})`}>
              <input type="datetime-local" required value={when} onChange={(e) => setWhen(e.target.value)} />
            </Field>
          </div>
        </div>

        {p && (
          <div className={`notice ${p.automated ? 'notice-good' : 'notice-info'}`} data-testid="plan">
            {p.automated ? (
              <><strong>The app will publish this</strong>{placementLabel ? ` as ${placementLabel}` : ''}. It prepares the files shortly before the time and checks the post afterwards.</>
            ) : (
              <><strong>A person publishes this.</strong> {p.manualReason}. It shows up on the Publish page at the time, with the files and text ready to copy.</>
            )}
          </div>
        )}

        {p?.automated && p.placements.length > 1 && (
          <Field label="Kind of post">
            <select value={placement} onChange={(e) => setPlacement(e.target.value)}>
              <option value="">Pick from the content{placementLabel ? ` (${placementLabel})` : ''}</option>
              {p.placements.map((x) => <option key={x.id} value={x.id}>{x.label}</option>)}
            </select>
          </Field>
        )}
        {p && (p.automated || byHand) && account?.automated && (
          <label className="check">
            <input type="checkbox" checked={byHand} onChange={(e) => setByHand(e.target.checked)} />
            <span>I will publish this one by hand <span className="muted small">(the app will not touch the network)</span></span>
          </label>
        )}

        <NetworkText caps={caps} label="Text" hint="The caption or description for this account." value={text} onChange={setText} />
        {account && !byHand && accountOpts.isLoading && <p className="muted small" style={{ margin: 0 }}>Asking {NETWORK_LABEL[account.network] ?? account.network} what this account can post…</p>}
        {account && !byHand && accountOpts.error && <ErrorBox error={accountOpts.error} />}
        {account && !byHand && (
          <NetworkOptions network={account.network} fields={fields} placement={p?.placement ?? (placement || undefined)} values={values} onChange={(k, v) => setTyped((t) => ({ ...t, [k]: v }))} />
        )}
        {canComment && (
          <div className="stack" style={{ gap: '.35rem' }}>
            <Field label="First comment (optional)">
              <textarea value={firstComment} onChange={(e) => setFirstComment(e.target.value)} style={{ minHeight: 56 }} />
            </Field>
            {caps?.text.firstCommentMaxChars !== undefined && (
              <div className="row counters"><Counter label="Characters" value={countLength(firstComment, caps.text.unit)} max={caps.text.firstCommentMaxChars} /></div>
            )}
          </div>
        )}
        {account && integ && !canComment && <p className="muted small" style={{ margin: 0 }}>{NETWORK_LABEL[account.network]} has no first comment.</p>}

        {p && <IssueList issues={p.issues} />}
        {formError && <div className="notice notice-bad" role="alert">{formError}</div>}
        {create.error && <ErrorBox error={create.error} />}
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" disabled={create.isPending || !chosen || !when || blocked} title={blocked ? 'Fix what blocks publishing, or choose to publish by hand' : ''}>Schedule</button>
        </div>
      </form>
    </Dialog>
  );
}

// ───────────────────────────── move / edit ─────────────────────────────

export function MoveDialog({ pub, brandId, zone, needsConfirmation, onClose }: { pub: { id: string; scheduled_at: string; text: string; network: string }; brandId: string; zone: string; needsConfirmation: boolean; onClose: () => void }) {
  const invalidate = useInvalidate();
  const toast = useToast();
  const [when, setWhen] = useState(isoToZonedInput(pub.scheduled_at, zone));
  const [text, setText] = useState(pub.text);
  const { data: integ } = useQuery({ queryKey: ['integrations', brandId], queryFn: () => api.get<Integrations>(`/api/brands/${brandId}/integrations`) });
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
        <NetworkText caps={integ?.capabilities[pub.network]} label="Text" value={text} onChange={setText} />
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

// ───────────────────────────── automatic publications: how they are going ─────────────────────────────

/** Why a post a network accepted is still hidden from other people, in that network's own terms. */
const PRIVATE_NOTE: Record<string, string> = {
  youtube: 'Uploaded as private: Google keeps new uploads private until the project passes its audit',
  tiktok: "Posted as private: TikTok keeps an app's posts private until it audits the app. Someone can make it public in TikTok",
  pinterest: 'Pinned, but not visible to others until Pinterest grants the app Standard access',
};

/** Where an automatic publication stands, in a few words a person can act on. */
export function PublicationNote({ pub }: { pub: Pick<PublicationRow, 'status' | 'manual' | 'visibility' | 'last_error' | 'last_error_class' | 'native_scheduled' | 'url' | 'network'> }) {
  if (pub.manual) return null;
  return (
    <>
      {pub.native_scheduled && ['scheduled', 'ready'].includes(pub.status) && <div className="muted small">Already with the network, which holds it until the hour</div>}
      {pub.status === 'published' && pub.visibility === 'private' && (
        <div className="small" style={{ color: 'var(--warn)' }}>{PRIVATE_NOTE[pub.network] ?? 'Posted as private: only the account can see it'}</div>
      )}
      {pub.status === 'published' && pub.visibility === 'processing' && <div className="muted small">The network is still processing it</div>}
      {pub.status === 'published' && pub.visibility === 'unknown' && <div className="small" style={{ color: 'var(--warn)' }}>The network no longer shows this post</div>}
      {pub.last_error && ['scheduled', 'preparing', 'ready', 'publishing', 'failed'].includes(pub.status) && (
        <div className="small" style={{ color: pub.status === 'failed' ? 'var(--bad)' : 'var(--warn)' }}>
          {pub.last_error_class && <strong>{ERROR_CLASS_LABEL[pub.last_error_class] ?? pub.last_error_class}: </strong>}{pub.last_error}
        </div>
      )}
    </>
  );
}

export function PublicationBadges({ pub }: { pub: Pick<PublicationRow, 'manual' | 'visibility' | 'status'> }) {
  return (
    <>
      <span className="chip" title={pub.manual ? 'A person publishes this' : 'The app publishes this'}>{pub.manual ? 'By hand' : 'Automatic'}</span>
      {!pub.manual && pub.status === 'published' && pub.visibility && pub.visibility !== 'public' && <span className="chip chip-on_hold">{VISIBILITY_LABEL[pub.visibility]}</span>}
    </>
  );
}

export function AttemptsDialog({ pubId, zone, onClose }: { pubId: string; zone: string; onClose: () => void }) {
  const { data, error } = useQuery({ queryKey: ['attempts', pubId], queryFn: () => api.get<Attempt[]>(`/api/publications/${pubId}/attempts`) });
  return (
    <Dialog title="What the app did" onClose={onClose} wide>
      {error && <ErrorBox error={error} />}
      {data && data.length === 0 && <p className="muted">Nothing yet: it starts preparing shortly before the scheduled time.</p>}
      {data && data.length > 0 && (
        <div className="table-wrap">
          <table>
            <thead><tr><th>When</th><th>Step</th><th>Result</th><th>Detail</th></tr></thead>
            <tbody>
              {data.map((a) => (
                <tr key={a.id}>
                  <td>{fmtDateTime(a.started_at, zone)}</td>
                  <td>{STEP_LABEL[a.step] ?? a.step}{a.attempt > 1 && <span className="muted small"> · try {a.attempt}</span>}</td>
                  <td>
                    <span className={`chip ${a.outcome === 'ok' ? 'chip-approved' : a.outcome === 'pending' ? 'chip-scheduled' : 'chip-failed'}`}>
                      {a.outcome === 'ok' ? 'Done' : a.outcome === 'pending' ? 'Waiting' : 'Failed'}
                    </span>
                    {a.error_class && <div className="muted small">{ERROR_CLASS_LABEL[a.error_class] ?? a.error_class}{a.http_status ? ` · HTTP ${a.http_status}` : ''}</div>}
                  </td>
                  <td className="small">
                    {a.detail.message}
                    {a.detail.visibility && <div className="muted">Visibility: {VISIBILITY_LABEL[a.detail.visibility] ?? a.detail.visibility}</div>}
                    {a.detail.note && <div className="muted">{a.detail.note}</div>}
                    {a.detail.retryAfterSec !== undefined && <div className="muted">Retrying in {Math.ceil(a.detail.retryAfterSec / 60)} min</div>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="muted small">Every try is kept for the record, with what the network answered. Tokens are never stored here.</p>
    </Dialog>
  );
}

export function RetryDialog({ pub, zone, onClose }: { pub: PublicationRow; zone: string; onClose: () => void }) {
  const invalidate = useInvalidate();
  const toast = useToast();
  const [when, setWhen] = useState('');
  const go = useMutation({
    mutationFn: () => api.post(`/api/publications/${pub.id}/retry`, when ? { scheduledAt: zonedToIso(when, zone) } : {}),
    onSuccess: () => {
      invalidate();
      toast('Scheduled again');
      onClose();
    },
  });
  return (
    <Dialog title="Try again" onClose={onClose}>
      <form className="stack" onSubmit={(e) => { e.preventDefault(); go.mutate(); }}>
        {pub.last_error && <div className="notice notice-bad">{pub.last_error}</div>}
        <p className="muted">The app starts over with the same approved version. If the time has passed, it goes out in a couple of minutes.</p>
        <Field label={`New time (${zone}, optional)`} hint="Leave it empty to keep the original time, or the soonest possible if that has passed.">
          <input type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} />
        </Field>
        {go.error && <ErrorBox error={go.error} />}
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" disabled={go.isPending}>Try again</button>
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
