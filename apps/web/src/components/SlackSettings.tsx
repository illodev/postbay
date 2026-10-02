import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api, type SlackSettings } from '../api';
import { t, tMaybe } from '../i18n';
import { fmtShort } from '../lib/format';
import { Chip, ErrorBox, errorMessage, Field, Spinner, Switch, useConfirm, useToast } from './ui';

/** Posts chosen events to a Slack channel, through that channel's incoming webhook. The address is a secret: it is never shown again. */
export function SlackSettingsCard({ brandId }: { brandId: string }) {
  const qc = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();
  const { data, error } = useQuery({ queryKey: ['slack', brandId], queryFn: () => api.get<SlackSettings>(`/api/brands/${brandId}/slack`) });
  const [url, setUrl] = useState('');
  const [kinds, setKinds] = useState<Set<string> | null>(null);
  const refresh = () => qc.invalidateQueries({ queryKey: ['slack', brandId] });

  const save = useMutation({
    mutationFn: () => api.put<SlackSettings>(`/api/brands/${brandId}/slack`, { ...(url.trim() ? { url: url.trim() } : {}), kinds: [...(kinds ?? new Set(data!.kinds))] }),
    onSuccess: () => { setUrl(''); setKinds(null); refresh(); toast(t('settings.saved')); },
  });
  const test = useMutation({
    mutationFn: () => api.post<{ ok: true } | { ok: false; message: string }>(`/api/brands/${brandId}/slack/test`),
    onSuccess: (r) => { refresh(); toast(r.ok ? t('settings.slack.testOk') : t('settings.slack.testRefused', { message: r.message }), r.ok ? 'ok' : 'error'); },
    onError: (e) => toast(errorMessage(e), 'error'),
  });
  const remove = useMutation({
    mutationFn: () => api.del(`/api/brands/${brandId}/slack`),
    onSuccess: () => { setKinds(null); refresh(); toast(t('settings.slack.removed')); },
    onError: (e) => toast(errorMessage(e), 'error'),
  });

  if (error) return <ErrorBox error={error} />;
  if (!data) return <Spinner />;
  const chosen = kinds ?? new Set(data.kinds);
  const flip = (k: string) => { const n = new Set(chosen); if (n.has(k)) n.delete(k); else n.add(k); setKinds(n); };
  return (
    <>
      <form className="card stack" onSubmit={(e) => { e.preventDefault(); save.mutate(); }} aria-label={t('settings.slack.title')}>
        <div className="set-card-head">
          <h3 title={t('settings.slack.hint')}>{t('settings.slack.channel')}</h3>
          {data.configured && !data.disabledReason && <Chip state="approved" label={data.hint ? t('settings.slack.onHint', { hint: data.hint }) : t('settings.slack.on')} />}
          {data.disabledReason && <Chip state="failed" label={t('settings.slack.stopped')} />}
          {!data.configured && !data.disabledReason && <Chip state="draft" label={t('settings.slack.off')} />}
        </div>
        {!data.available && <div className="notice notice-warn" style={{ margin: 0 }}>{t('settings.slack.unavailable')}</div>}
        {data.disabledReason && <div className="notice notice-bad" role="alert" style={{ margin: 0 }}>{t('settings.slack.disabled', { reason: data.disabledReason })}</div>}
        {!data.disabledReason && data.lastError && <div className="notice notice-warn" style={{ margin: 0 }}>{t('settings.slack.lastError', { error: data.lastError })}</div>}
        <Field label={data.configured ? t('settings.slack.replace') : t('settings.slack.address')} hint={t('settings.slack.addressHint')}>
          <input type="url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://hooks.slack.com/services/…" autoComplete="off" required={!data.configured} disabled={!data.available} />
        </Field>
        <fieldset className="set-fieldset set-checks-2">
          <legend className="set-legend">{t('settings.slack.postWhen')}</legend>
          {data.allKinds.map((k) => (
            <Switch key={k.kind} label={tMaybe(`account.kind.${k.kind}`, k.label)} checked={chosen.has(k.kind)} onChange={() => flip(k.kind)} disabled={!data.available} />
          ))}
        </fieldset>
        {save.error && <ErrorBox error={save.error} />}
        <div className="set-savebar">
          <button className="btn btn-primary" disabled={!data.available || save.isPending || chosen.size === 0 || (!data.configured && !url.trim())}>{t('common.save')}</button>
          {data.configured && <button type="button" className="btn" onClick={() => test.mutate()} disabled={test.isPending}>{t('settings.slack.test')}</button>}
          {data.lastOkAt && <span className="muted small">{t('settings.slack.lastOk', { when: fmtShort(data.lastOkAt) })}</span>}
        </div>
      </form>
      {data.configured && (
        <section className="card set-danger">
          <h3>{t('settings.slack.dangerTitle')}</h3>
          <div className="set-danger-row">
            <div>
              <strong>{t('settings.slack.removeTitle')}</strong>
              <p>{t('settings.slack.removeHint')}</p>
            </div>
            <button
              type="button"
              className="btn btn-danger"
              disabled={remove.isPending}
              onClick={async () => {
                if (await confirm({ title: t('settings.slack.removeAsk'), text: t('settings.slack.removeConfirm'), confirmLabel: t('settings.slack.remove'), danger: true })) remove.mutate();
              }}
            >
              {t('settings.slack.remove')}
            </button>
          </div>
        </section>
      )}
    </>
  );
}
