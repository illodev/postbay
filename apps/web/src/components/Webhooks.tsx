import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api, type Webhook, type WebhookDelivery, type WebhookDeliveryDetail, type WebhookEventType } from '../api';
import { t, tMaybe } from '../i18n';
import { EVENT_LABEL, fmtDateTime, fmtShort } from '../lib/format';
import { Chip, CopyButton, Dialog, Empty, ErrorBox, errorMessage, Field, MoreMenu, Spinner, useConfirm, useToast } from './ui';

interface List {
  items: Webhook[];
  eventTypes: WebhookEventType[];
}

const eventHelp = (e: WebhookEventType) => tMaybe(`settings.webhooks.eventHelp.${e.type}`, e.description);

function SecretDialog({ secret, title, onClose }: { secret: string; title: string; onClose: () => void }) {
  return (
    <Dialog title={title} onClose={onClose}>
      <div className="stack">
        <p className="muted" style={{ margin: 0 }}>{t('settings.webhooks.secretHint')}</p>
        <pre className="set-secret">{secret}</pre>
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <CopyButton text={secret} label={t('settings.webhooks.copySecret')} />
          <button className="btn btn-primary" onClick={onClose}>{t('settings.done')}</button>
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
    <Dialog title={hook ? t('settings.webhooks.editTitle') : t('settings.webhooks.add')} onClose={onClose} wide>
      <form className="stack" onSubmit={(e) => { e.preventDefault(); save.mutate(); }}>
        <Field label={t('settings.webhooks.address')} hint={t('settings.webhooks.addressHint')}>
          <input type="url" required placeholder="https://" value={url} onChange={(e) => setUrl(e.target.value)} />
        </Field>
        <Field label={`${t('settings.webhooks.description')} ${t('common.optional')}`}>
          <input type="text" maxLength={200} value={description} onChange={(e) => setDescription(e.target.value)} />
        </Field>
        <fieldset className="set-fieldset">
          <legend className="set-legend">{t('settings.webhooks.events')}</legend>
          {eventTypes.map((e) => (
            <label key={e.type} className="check">
              <input type="checkbox" checked={events.has(e.type)} onChange={() => toggle(e.type)} />
              <span><strong style={{ fontWeight: 500 }}>{EVENT_LABEL[e.type] ?? e.type}</strong> <span className="mono muted">{e.type}</span><br /><span className="muted small">{eventHelp(e)}</span></span>
            </label>
          ))}
        </fieldset>
        {save.error && <ErrorBox error={save.error} />}
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <button type="button" className="btn" onClick={onClose}>{t('common.cancel')}</button>
          <button className="btn btn-primary" disabled={save.isPending || events.size === 0 || !url}>{hook ? t('common.save') : t('settings.webhooks.addShort')}</button>
        </div>
      </form>
    </Dialog>
  );
}

const STATUS_CHIP = { delivered: 'approved', pending: 'scheduled', failed: 'failed' } as const;
const statusText = (s: WebhookDelivery['status']) => t(`settings.webhooks.status.${s}`);

function AttemptsDialog({ id, onClose }: { id: string; onClose: () => void }) {
  const { data, error } = useQuery({ queryKey: ['delivery', id], queryFn: () => api.get<WebhookDeliveryDetail>(`/api/webhook-deliveries/${id}`) });
  return (
    <Dialog title={t('settings.webhooks.attempts')} onClose={onClose}>
      {error && <ErrorBox error={error} />}
      {!data && !error && <Spinner />}
      {data && (
        <div className="table-wrap">
          <table className="set-table">
            <thead><tr><th>{t('settings.webhooks.when')}</th><th>{t('settings.webhooks.answer')}</th><th className="num">{t('settings.webhooks.time')}</th></tr></thead>
            <tbody>
              {data.attempts.map((a, i) => (
                <tr key={i}>
                  <td className="mono" style={{ whiteSpace: 'nowrap' }}>{fmtDateTime(a.at, 'UTC')} UTC</td>
                  <td data-label={t('settings.webhooks.answer')}>
                    <div>
                      {a.http_status ? <Chip state={a.http_status < 300 ? 'approved' : 'failed'} label={String(a.http_status)} /> : <Chip state="failed" label={t('settings.webhooks.noAnswer')} />}
                      {a.error && <div className="small muted" style={{ overflowWrap: 'anywhere' }}>{a.error}</div>}
                    </div>
                  </td>
                  <td className="num" data-label={t('settings.webhooks.time')}>{a.duration_ms !== null ? `${a.duration_ms} ms` : ''}</td>
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
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['deliveries', hook.id] }); toast(t('settings.webhooks.queued')); },
    onError: (e) => toast(errorMessage(e), 'error'),
  });
  return (
    <Dialog title={t('settings.webhooks.deliveries')} onClose={onClose} wide>
      <p className="muted small" style={{ margin: 0 }}><span className="mono" style={{ overflowWrap: 'anywhere' }}>{hook.url}</span> · {t('settings.webhooks.retryHint')}</p>
      {error && <ErrorBox error={error} />}
      {!data && !error && <Spinner />}
      {data?.length === 0 && <Empty title={t('settings.webhooks.nothingSent')}>{t('settings.webhooks.nothingSentHint')}</Empty>}
      {data && data.length > 0 && (
        <div className="table-wrap">
          <table className="set-table">
            <thead>
              <tr>
                <th>{t('settings.webhooks.when')}</th>
                <th>{t('settings.webhooks.event')}</th>
                <th>{t('settings.webhooks.result')}</th>
                <th className="set-actions"><span className="sr-only">{t('settings.actions')}</span></th>
              </tr>
            </thead>
            <tbody>
              {data.map((d) => (
                <tr key={d.id}>
                  <td className="small" style={{ whiteSpace: 'nowrap' }}>{fmtShort(d.created_at)}</td>
                  <td data-label={t('settings.webhooks.event')}>{EVENT_LABEL[d.type] ?? d.type}</td>
                  <td data-label={t('settings.webhooks.result')}>
                    <div>
                      <span className="row" style={{ gap: '.4rem' }}>
                        <Chip state={STATUS_CHIP[d.status]} label={statusText(d.status)} />
                        <span className="muted small mono">{t('settings.webhooks.attemptsN', { count: d.attempts })}{d.last_status ? ` · ${d.last_status}` : ''}</span>
                      </span>
                      {d.status === 'pending' && d.next_attempt_at && d.attempts > 0 && <div className="muted small">{t('settings.webhooks.nextTry', { when: fmtShort(d.next_attempt_at) })}</div>}
                      {d.status !== 'delivered' && d.last_error && <div className="small set-bad" style={{ overflowWrap: 'anywhere' }}>{d.last_error}</div>}
                    </div>
                  </td>
                  <td className="set-actions">
                    <div className="row">
                      {d.attempts > 0 && <button className="btn btn-small" onClick={() => setDetail(d.id)}>{t('settings.webhooks.attempts')}</button>}
                      {d.status !== 'pending' && <button className="btn btn-small" onClick={() => again.mutate(d.id)}>{t('settings.webhooks.sendAgain')}</button>}
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

function HookState({ h }: { h: Webhook }) {
  if (!h.active) return <Chip state="on_hold" label={t('settings.webhooks.disabled')} />;
  if (h.failed_24h > 0) return <Chip state="failed" label={t('settings.webhooks.failing')} />;
  return <Chip state="approved" label={t('settings.webhooks.active')} />;
}

export function Webhooks({ brandId }: { brandId: string }) {
  const qc = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();
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
    onSuccess: (r) => { refresh(); setSecret({ secret: r.secret, title: t('settings.webhooks.newSecretTitle') }); },
    onError: (e) => toast(errorMessage(e), 'error'),
  });
  const test = useMutation({
    mutationFn: (h: Webhook) => api.post(`/api/webhooks/${h.id}/test`).then(() => h),
    onSuccess: (h) => { toast(t('settings.webhooks.testSent')); setDeliveries(h); },
    onError: (e) => toast(errorMessage(e), 'error'),
  });

  return (
    <>
      {error && <ErrorBox error={error} />}
      <section className="card">
        <div className="card-head">
          <h3>{data && data.items.length > 0 ? t('settings.webhooks.count', { count: data.items.length }) : t('settings.webhooks.title')}</h3>
          <button className="btn btn-primary" onClick={() => setEditing('new')} disabled={!data}>{t('settings.webhooks.add')}</button>
        </div>
        {!data && !error && <Spinner />}
        {data?.items.length === 0 && <Empty title={t('settings.webhooks.empty')}>{t('settings.webhooks.emptyHint')}</Empty>}
        {data && data.items.length > 0 && (
          <ul className="ent-list">
            {data.items.map((h) => (
              <li key={h.id} className="ent ent-wide">
                <div className="ent-main">
                  <div className="ent-title"><span className="mono" style={{ fontSize: '.875rem' }}>{h.url}</span></div>
                  {h.description && <div className="ent-sub">{h.description}</div>}
                  <div className="ent-tags">{h.events.map((e) => <span key={e} className="tag">{EVENT_LABEL[e] ?? e}</span>)}</div>
                </div>
                <div className="ent-side"><HookState h={h} /></div>
                <div className="ent-notes">
                  <span className="muted">
                    {t('settings.webhooks.secretEnding', { hint: h.secret_hint })}
                    {h.last_success_at && <> · {t('settings.webhooks.lastDelivered', { when: fmtShort(h.last_success_at) })}</>}
                    {h.pending > 0 && <> · {t('settings.webhooks.waiting', { count: h.pending })}</>}
                  </span>
                  {h.failed_24h > 0 && <span className="set-bad">{t('settings.webhooks.failedDay', { count: h.failed_24h })}</span>}
                  {h.disabled_reason && <span className="set-warn">{h.disabled_reason}</span>}
                </div>
                <div className="ent-bar">
                  <div className="ent-actions" style={{ justifyContent: 'flex-start' }}>
                    <button className="btn btn-small" disabled={!h.active || test.isPending} onClick={() => test.mutate(h)}>{t('settings.webhooks.test')}</button>
                    <button className="btn btn-small" onClick={() => setDeliveries(h)}>{t('settings.webhooks.deliveries')}</button>
                    <button className="btn btn-small" onClick={() => setEditing(h)}>{t('common.edit')}</button>
                  </div>
                  <div className="ent-actions">
                    <MoreMenu
                      label={t('settings.webhooks.actions')}
                      items={[
                        { label: h.active ? t('settings.webhooks.disable') : t('settings.webhooks.enable'), icon: h.active ? 'ban' : 'check', onSelect: () => patch.mutate({ id: h.id, body: { active: !h.active } }) },
                        {
                          label: t('settings.webhooks.rotate'), icon: 'key',
                          onSelect: async () => {
                            if (await confirm({ title: t('settings.webhooks.rotateTitle'), text: t('settings.webhooks.rotateConfirm'), confirmLabel: t('settings.webhooks.rotate') })) rotate.mutate(h.id);
                          },
                        },
                        {
                          label: t('common.delete'), icon: 'trash', danger: true,
                          onSelect: async () => {
                            const text = <><p>{t('settings.webhooks.deleteConfirm')}</p><p><code>{h.url}</code></p></>;
                            if (await confirm({ title: t('settings.webhooks.deleteTitle'), text, confirmLabel: t('common.delete'), danger: true })) remove.mutate(h.id);
                          },
                        },
                      ]}
                    />
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
      {editing && data && (
        <WebhookDialog brandId={brandId} eventTypes={data.eventTypes} hook={editing === 'new' ? null : editing} onClose={() => setEditing(null)} onSecret={(s) => setSecret({ secret: s, title: t('settings.webhooks.copySecretTitle') })} />
      )}
      {deliveries && <DeliveriesDialog hook={deliveries} onClose={() => setDeliveries(null)} />}
      {secret && <SecretDialog secret={secret.secret} title={secret.title} onClose={() => setSecret(null)} />}
    </>
  );
}
