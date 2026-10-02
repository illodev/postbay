import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api, type NotificationPreferences } from '../api';
import { t, tMaybe } from '../i18n';
import { currentSubscription, disablePush, enablePush, pushSupported } from '../lib/push';
import { Chip, ErrorBox, errorMessage, Spinner, useToast } from './ui';

/** What each person is told, and where: by email, and by push in the browsers they have turned it on in. */
export function NotificationPrefs() {
  const qc = useQueryClient();
  const toast = useToast();
  const { data, error } = useQuery({ queryKey: ['notification-prefs'], queryFn: () => api.get<NotificationPreferences>('/api/notifications/preferences') });
  const { data: here, refetch: refetchHere } = useQuery({ queryKey: ['push-here'], queryFn: currentSubscription });
  const [edit, setEdit] = useState<{ email: Set<string>; push: Set<string> } | null>(null);
  const refresh = () => { qc.invalidateQueries({ queryKey: ['notification-prefs'] }); void refetchHere(); };

  const save = useMutation({
    mutationFn: () => api.put<NotificationPreferences>('/api/notifications/preferences', { emailKinds: [...edit!.email], pushKinds: [...edit!.push] }),
    onSuccess: () => { setEdit(null); refresh(); toast(t('settings.saved')); },
  });
  const toggle = useMutation({
    mutationFn: async () => { if (here) await disablePush(); else await enablePush(); },
    onSuccess: () => { refresh(); toast(here ? t('account.push.offToast') : t('account.push.onToast')); },
    onError: (e) => toast(errorMessage(e), 'error'),
  });
  const test = useMutation({
    mutationFn: () => api.post<{ devices: number; reached: number }>('/api/push/test'),
    onSuccess: (r) => toast(r.reached ? t('account.push.sentTo', { count: r.reached }) : r.devices ? t('account.push.notTaken') : t('account.push.noBrowser'), r.reached ? 'ok' : 'error'),
    onError: (e) => toast(errorMessage(e), 'error'),
  });

  if (error) return <ErrorBox error={error} />;
  if (!data) return <Spinner />;
  const email = edit?.email ?? new Set(data.emailKinds);
  const push = edit?.push ?? new Set(data.pushKinds);
  const flip = (which: 'email' | 'push', kind: string) => {
    const next = { email: new Set(email), push: new Set(push) };
    if (next[which].has(kind)) next[which].delete(kind); else next[which].add(kind);
    setEdit(next);
  };
  const supported = pushSupported();
  return (
    <section className="card stack acct-full" aria-label={t('account.notify.title')}>
      <div className="set-card-head">
        <h2 title={t('account.notify.hint')}>{t('account.notify.title')}</h2>
      </div>

      <div className="acct-push" data-testid="push-here">
        <div>
          <div className="row" style={{ gap: '.6rem' }}>
            <strong style={{ fontWeight: 500 }}>{t('account.push.here')}</strong>
            {!supported ? <Chip state="draft" label={t('account.push.unsupportedChip')} /> : here ? <Chip state="approved" label={t('account.push.on')} /> : <Chip state="draft" label={t('account.push.off')} />}
          </div>
          <div className="muted small">
            {!supported ? t('account.push.unsupported') : here ? t('account.push.onHint') : t('account.push.offHint')}
            {data.pushDevices > 0 && ` ${t('account.push.devices', { count: data.pushDevices })}`}
          </div>
        </div>
        <div className="row">
          {supported && <button className="btn" onClick={() => toggle.mutate()} disabled={toggle.isPending}>{here ? t('account.push.turnOff') : t('account.push.turnOn')}</button>}
          {data.pushDevices > 0 && <button className="btn" onClick={() => test.mutate()} disabled={test.isPending}>{t('account.push.test')}</button>}
        </div>
      </div>

      <div className="table-wrap">
        <table className="acct-prefs">
          <thead><tr><th>{t('account.notify.when')}</th><th>{t('account.notify.email')}</th><th>{t('account.notify.push')}</th></tr></thead>
          <tbody>
            {data.kinds.map((k) => {
              const label = tMaybe(`account.kind.${k.kind}`, k.label);
              return (
                <tr key={k.kind}>
                  <td>{label}</td>
                  <td><input type="checkbox" aria-label={t('account.notify.emailFor', { what: label })} checked={email.has(k.kind)} onChange={() => flip('email', k.kind)} /></td>
                  <td><input type="checkbox" aria-label={t('account.notify.pushFor', { what: label })} checked={push.has(k.kind)} onChange={() => flip('push', k.kind)} /></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {save.error && <ErrorBox error={save.error} />}
      <div className="set-savebar">
        <button className="btn btn-primary" disabled={!edit || save.isPending} onClick={() => save.mutate()}>{t('common.save')}</button>
        {edit && <button className="btn btn-ghost" onClick={() => setEdit(null)}>{t('settings.discard')}</button>}
        {edit && <span className="muted small">{t('settings.unsaved')}</span>}
      </div>
    </section>
  );
}
