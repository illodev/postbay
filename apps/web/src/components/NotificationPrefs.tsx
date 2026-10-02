import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api, type NotificationPreferences } from '../api';
import { currentSubscription, disablePush, enablePush, pushSupported } from '../lib/push';
import { ErrorBox, errorMessage, Spinner, useToast } from './ui';

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
    onSuccess: () => { setEdit(null); refresh(); toast('Saved'); },
  });
  const toggle = useMutation({
    mutationFn: async () => { if (here) await disablePush(); else await enablePush(); },
    onSuccess: () => { refresh(); toast(here ? 'Push is off in this browser' : 'Push is on in this browser'); },
    onError: (e) => toast(errorMessage(e), 'error'),
  });
  const test = useMutation({
    mutationFn: () => api.post<{ devices: number; reached: number }>('/api/push/test'),
    onSuccess: (r) => toast(r.reached ? `Sent to ${r.reached} browser${r.reached === 1 ? '' : 's'}` : r.devices ? 'The push service did not take it: try again in a moment' : 'No browser has push turned on', r.reached ? 'ok' : 'error'),
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
  return (
    <section className="card stack" aria-label="Notifications">
      <h2>Notifications</h2>
      <p className="muted" style={{ margin: 0 }}>The bell always shows everything. Choose what also comes to you by email, and by push to this and your other browsers.</p>

      <div className="row-between" data-testid="push-here">
        <div>
          <strong>Push in this browser</strong>
          <div className="muted small">
            {!pushSupported() ? 'This browser cannot receive push messages.' : here ? 'On.' : 'Off.'}
            {data.pushDevices > 0 && ` You have push on in ${data.pushDevices} browser${data.pushDevices === 1 ? '' : 's'}.`}
          </div>
        </div>
        <div className="row">
          {pushSupported() && <button className="btn" onClick={() => toggle.mutate()} disabled={toggle.isPending}>{here ? 'Turn off here' : 'Turn on here'}</button>}
          {data.pushDevices > 0 && <button className="btn" onClick={() => test.mutate()} disabled={test.isPending}>Send a test</button>}
        </div>
      </div>

      <div className="table-wrap">
        <table>
          <thead><tr><th>Tell me when…</th><th style={{ width: 80 }}>Email</th><th style={{ width: 80 }}>Push</th></tr></thead>
          <tbody>
            {data.kinds.map((k) => (
              <tr key={k.kind}>
                <td>{k.label}</td>
                <td><input type="checkbox" aria-label={`Email: ${k.label}`} checked={email.has(k.kind)} onChange={() => flip('email', k.kind)} /></td>
                <td><input type="checkbox" aria-label={`Push: ${k.label}`} checked={push.has(k.kind)} onChange={() => flip('push', k.kind)} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {save.error && <ErrorBox error={save.error} />}
      <div className="row">
        <button className="btn btn-primary" disabled={!edit || save.isPending} onClick={() => save.mutate()}>Save</button>
        {edit && <button className="btn" onClick={() => setEdit(null)}>Discard changes</button>}
      </div>
    </section>
  );
}
