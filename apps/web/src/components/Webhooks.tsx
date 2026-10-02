import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api, type Webhook, type WebhookDelivery, type WebhookDeliveryDetail, type WebhookEventType } from '../api';
import { EVENT_LABEL, fmtDateTime, fmtShort } from '../lib/format';
import { CopyButton, Dialog, Empty, ErrorBox, errorMessage, Field, Spinner, useToast } from './ui';

interface List {
  items: Webhook[];
  eventTypes: WebhookEventType[];
}

function SecretDialog({ secret, title, onClose }: { secret: string; title: string; onClose: () => void }) {
  return (
    <Dialog title={title} onClose={onClose}>
      <div className="stack">
        <p className="muted" style={{ margin: 0 }}>
          This is the only time the secret is shown. The receiver uses it to check that a delivery really comes from here: it computes an
          HMAC-SHA256 of <span className="mono">timestamp.body</span> with this secret and compares it with the signature header.
        </p>
        <pre className="card mono" style={{ wordBreak: 'break-all', whiteSpace: 'pre-wrap', margin: 0 }}>{secret}</pre>
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <CopyButton text={secret} label="Copy secret" />
          <button className="btn btn-primary" onClick={onClose}>Done</button>
        </div>
      </div>
    </Dialog>
  );
}

function WebhookDialog({ brandId, eventTypes, hook, onClose, onSecret }: {
  brandId: string;
  eventTypes: WebhookEventType[];
  hook: Webhook | null;
  onClose: () => void;
  onSecret: (secret: string) => void;
}) {
  const qc = useQueryClient();
  const [url, setUrl] = useState(hook?.url ?? '');
  const [description, setDescription] = useState(hook?.description ?? '');
  const [events, setEvents] = useState<Set<string>>(new Set(hook?.events ?? ['version.changes_requested']));
  const save = useMutation({
    mutationFn: () =>
      hook
        ? api.patch<Webhook>(`/api/webhooks/${hook.id}`, { url, description, events: [...events] })
        : api.post<Webhook & { secret: string }>(`/api/brands/${brandId}/webhooks`, { url, description, events: [...events] }),
    onSuccess: (r) => {
      qc.invalidateQueries({ queryKey: ['webhooks', brandId] });
      onClose();
      if ('secret' in r) onSecret((r as { secret: string }).secret);
    },
  });
  const toggle = (type: string) => {
    const n = new Set(events);
    if (n.has(type)) n.delete(type); else n.add(type);
    setEvents(n);
  };
  return (
    <Dialog title={hook ? 'Edit webhook' : 'Add a webhook'} onClose={onClose} wide>
      <form className="stack" onSubmit={(e) => { e.preventDefault(); save.mutate(); }}>
        <Field label="Address" hint="Where the events are sent, for example the runner: https://runner.example.com/webhooks/lumen">
          <input type="url" required placeholder="https://" value={url} onChange={(e) => setUrl(e.target.value)} />
        </Field>
        <Field label="Description (optional)">
          <input type="text" maxLength={200} value={description} onChange={(e) => setDescription(e.target.value)} />
        </Field>
        <fieldset className="stack" style={{ border: 0, padding: 0, margin: 0 }}>
          <legend className="field-label">Events</legend>
          {eventTypes.map((t) => (
            <label key={t.type} className="check">
              <input type="checkbox" checked={events.has(t.type)} onChange={() => toggle(t.type)} />
              <span><strong>{EVENT_LABEL[t.type] ?? t.type}</strong> <span className="mono muted small">{t.type}</span><br /><span className="muted small">{t.description}</span></span>
            </label>
          ))}
        </fieldset>
        {save.error && <ErrorBox error={save.error} />}
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" disabled={save.isPending || events.size === 0 || !url}>{hook ? 'Save' : 'Add webhook'}</button>
        </div>
      </form>
    </Dialog>
  );
}

const STATUS_CHIP = { delivered: 'chip-approved', pending: 'chip-scheduled', failed: 'chip-failed' } as const;
const STATUS_TEXT = { delivered: 'Delivered', pending: 'Waiting', failed: 'Failed' } as const;

function AttemptsDialog({ id, onClose }: { id: string; onClose: () => void }) {
  const { data, error } = useQuery({ queryKey: ['delivery', id], queryFn: () => api.get<WebhookDeliveryDetail>(`/api/webhook-deliveries/${id}`) });
  return (
    <Dialog title="Attempts" onClose={onClose}>
      {error && <ErrorBox error={error} />}
      {!data && !error && <Spinner />}
      {data && (
        <div className="table-wrap">
          <table>
            <thead><tr><th>When</th><th>Answer</th><th>Time</th></tr></thead>
            <tbody>
              {data.attempts.map((a, i) => (
                <tr key={i}>
                  <td className="small">{fmtDateTime(a.at, 'UTC')} UTC</td>
                  <td>{a.http_status ? <span className={`chip ${a.http_status < 300 ? 'chip-approved' : 'chip-failed'}`}>{a.http_status}</span> : <span className="chip chip-failed">no answer</span>}{a.error && <div className="small muted">{a.error}</div>}</td>
                  <td className="small">{a.duration_ms !== null ? `${a.duration_ms} ms` : ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Dialog>
  );
}

function DeliveriesDialog({ hook, onClose }: { hook: Webhook; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [detail, setDetail] = useState<string | null>(null);
  const { data, error } = useQuery({
    queryKey: ['deliveries', hook.id],
    queryFn: () => api.get<WebhookDelivery[]>(`/api/webhooks/${hook.id}/deliveries`),
    refetchInterval: (q) => (q.state.data?.some((d) => d.status === 'pending') ? 2000 : false),
  });
  const again = useMutation({
    mutationFn: (id: string) => api.post(`/api/webhook-deliveries/${id}/redeliver`),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['deliveries', hook.id] }); toast('Queued to be sent again'); },
    onError: (e) => toast(errorMessage(e), 'error'),
  });
  return (
    <Dialog title="Deliveries" onClose={onClose} wide>
      <p className="muted small" style={{ marginTop: 0 }}>{hook.url}. A failed delivery is retried with growing waits for up to 24 hours, then given up on.</p>
      {error && <ErrorBox error={error} />}
      {!data && !error && <Spinner />}
      {data?.length === 0 && <Empty title="Nothing sent yet">Use “Send a test” to check the receiver.</Empty>}
      {data && data.length > 0 && (
        <div className="table-wrap">
          <table>
            <thead><tr><th>When</th><th>Event</th><th>Result</th><th /></tr></thead>
            <tbody>
              {data.map((d) => (
                <tr key={d.id}>
                  <td className="small">{fmtShort(d.created_at)}</td>
                  <td>{EVENT_LABEL[d.type] ?? d.type}</td>
                  <td>
                    <span className={`chip ${STATUS_CHIP[d.status]}`}>{STATUS_TEXT[d.status]}</span>
                    <span className="muted small"> · {d.attempts} attempt{d.attempts === 1 ? '' : 's'}{d.last_status ? ` · ${d.last_status}` : ''}</span>
                    {d.status === 'pending' && d.next_attempt_at && d.attempts > 0 && <div className="muted small">Next try {fmtShort(d.next_attempt_at)}</div>}
                    {d.status !== 'delivered' && d.last_error && <div className="small" style={{ color: 'var(--bad)' }}>{d.last_error}</div>}
                  </td>
                  <td>
                    <div className="row">
                      {d.attempts > 0 && <button className="btn btn-small" onClick={() => setDetail(d.id)}>Attempts</button>}
                      {d.status !== 'pending' && <button className="btn btn-small" onClick={() => again.mutate(d.id)}>Send again</button>}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {detail && <AttemptsDialog id={detail} onClose={() => setDetail(null)} />}
    </Dialog>
  );
}

export function Webhooks({ brandId }: { brandId: string }) {
  const qc = useQueryClient();
  const toast = useToast();
  const { data, error } = useQuery({ queryKey: ['webhooks', brandId], queryFn: () => api.get<List>(`/api/brands/${brandId}/webhooks`) });
  const [editing, setEditing] = useState<Webhook | 'new' | null>(null);
  const [deliveries, setDeliveries] = useState<Webhook | null>(null);
  const [secret, setSecret] = useState<{ secret: string; title: string } | null>(null);
  const refresh = () => qc.invalidateQueries({ queryKey: ['webhooks', brandId] });
  const patch = useMutation({
    mutationFn: ({ id, body }: { id: string; body: Record<string, unknown> }) => api.patch(`/api/webhooks/${id}`, body),
    onSuccess: refresh,
    onError: (e) => toast(errorMessage(e), 'error'),
  });
  const remove = useMutation({ mutationFn: (id: string) => api.del(`/api/webhooks/${id}`), onSuccess: refresh, onError: (e) => toast(errorMessage(e), 'error') });
  const rotate = useMutation({
    mutationFn: (id: string) => api.post<{ secret: string }>(`/api/webhooks/${id}/rotate-secret`),
    onSuccess: (r) => { refresh(); setSecret({ secret: r.secret, title: 'New secret' }); },
    onError: (e) => toast(errorMessage(e), 'error'),
  });
  const test = useMutation({
    mutationFn: (h: Webhook) => api.post(`/api/webhooks/${h.id}/test`).then(() => h),
    onSuccess: (h) => { toast('Test event sent'); setDeliveries(h); },
    onError: (e) => toast(errorMessage(e), 'error'),
  });

  return (
    <div className="stack">
      <div className="notice notice-info">
        Webhooks tell other systems what happens here: for example a runner that starts an agent when changes are requested, or a script that posts to chat.
        Every delivery is signed with the webhook&rsquo;s secret.
      </div>
      {error && <ErrorBox error={error} />}
      <div className="card">
        <div className="card-head"><h2>Webhooks</h2><button className="btn btn-primary" onClick={() => setEditing('new')}>Add a webhook</button></div>
        {!data && !error && <Spinner />}
        {data?.items.length === 0 && <Empty title="No webhooks yet">Add one to let a runner or a script react to what happens here.</Empty>}
        {data && data.items.length > 0 && (
          <div className="table-wrap">
            <table>
              <thead><tr><th>Address</th><th>Events</th><th>State</th><th /></tr></thead>
              <tbody>
                {data.items.map((h) => (
                  <tr key={h.id}>
                    <td style={{ maxWidth: 320, overflowWrap: 'anywhere' }}>
                      {h.url}
                      {h.description && <div className="muted small">{h.description}</div>}
                      <div className="muted small">Secret ending {h.secret_hint}</div>
                    </td>
                    <td className="small">{h.events.map((e) => EVENT_LABEL[e] ?? e).join(', ')}</td>
                    <td>
                      {h.active ? <span className="chip chip-approved">Active</span> : <span className="chip chip-on_hold">Disabled</span>}
                      {h.disabled_reason && <div className="small muted">{h.disabled_reason}</div>}
                      {h.failed_24h > 0 && <div className="small" style={{ color: 'var(--bad)' }}>{h.failed_24h} failed in the last day</div>}
                      {h.pending > 0 && <div className="small muted">{h.pending} waiting</div>}
                      {h.last_success_at && <div className="small muted">Last delivered {fmtShort(h.last_success_at)}</div>}
                    </td>
                    <td>
                      <div className="row">
                        <button className="btn btn-small" disabled={!h.active || test.isPending} onClick={() => test.mutate(h)}>Send a test</button>
                        <button className="btn btn-small" onClick={() => setDeliveries(h)}>Deliveries</button>
                        <button className="btn btn-small" onClick={() => setEditing(h)}>Edit</button>
                        <button className="btn btn-small" onClick={() => patch.mutate({ id: h.id, body: { active: !h.active } })}>{h.active ? 'Disable' : 'Enable'}</button>
                        <button className="btn btn-small" onClick={() => confirm('Make a new secret? The old one stops working at once: update the receiver straight away.') && rotate.mutate(h.id)}>New secret</button>
                        <button className="btn btn-small btn-danger" onClick={() => confirm(`Delete this webhook and its delivery history?\n${h.url}`) && remove.mutate(h.id)}>Delete</button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      {editing && data && (
        <WebhookDialog brandId={brandId} eventTypes={data.eventTypes} hook={editing === 'new' ? null : editing} onClose={() => setEditing(null)} onSecret={(s) => setSecret({ secret: s, title: 'Copy the secret now' })} />
      )}
      {deliveries && <DeliveriesDialog hook={deliveries} onClose={() => setDeliveries(null)} />}
      {secret && <SecretDialog secret={secret.secret} title={secret.title} onClose={() => setSecret(null)} />}
    </div>
  );
}
