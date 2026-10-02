import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { api, type SecondFactorStatus } from '../api';
import { EnrollFlow, RecoveryCodes } from '../components/SecondFactor';
import { NotificationPrefs } from '../components/NotificationPrefs';
import { ErrorBox, Field, Spinner, useToast } from '../components/ui';

/** Asks for a current code before doing something that would otherwise let anyone at an unlocked laptop weaken the account. */
function CodeAction({ label, hint, danger, run, onDone }: { label: string; hint: string; danger?: boolean; run: (code: string) => Promise<unknown>; onDone: (r: unknown) => void }) {
  const [open, setOpen] = useState(false);
  const [code, setCode] = useState('');
  const go = useMutation({ mutationFn: () => run(code), onSuccess: (r) => { setOpen(false); setCode(''); onDone(r); } });
  if (!open) return <button className={`btn ${danger ? 'btn-danger' : ''}`} onClick={() => setOpen(true)}>{label}</button>;
  const submit = (e: FormEvent) => { e.preventDefault(); go.mutate(); };
  return (
    <form className="stack card" onSubmit={submit}>
      <Field label="Code from your app" hint={hint}>
        <input type="text" inputMode="numeric" autoComplete="one-time-code" required autoFocus maxLength={8} value={code} onChange={(e) => setCode(e.target.value.replace(/\s/g, ''))} style={{ maxWidth: 160 }} />
      </Field>
      {go.error && <ErrorBox error={go.error} />}
      <div className="row">
        <button type="button" className="btn" onClick={() => setOpen(false)}>Cancel</button>
        <button className={`btn ${danger ? 'btn-danger' : 'btn-primary'}`} disabled={go.isPending || code.length !== 6}>{label}</button>
      </div>
    </form>
  );
}

/** How this person signs in: their authenticator and recovery codes. */
export function SecurityPage() {
  const qc = useQueryClient();
  const toast = useToast();
  const { data, error } = useQuery({ queryKey: ['second-factor'], queryFn: () => api.get<SecondFactorStatus>('/api/auth/2fa') });
  const [fresh, setFresh] = useState<string[] | null>(null);
  const refresh = () => qc.invalidateQueries({ queryKey: ['second-factor'] });
  return (
    <>
      <div className="page-head"><div><h1>Your account</h1><p className="muted">How you are told about things, and how you prove it is you.</p></div></div>
      <div className="stack">
      <NotificationPrefs />
      {error && <ErrorBox error={error} />}
      {!data && !error && <Spinner />}
      {data && fresh && <div className="card"><RecoveryCodes codes={fresh} onDone={() => { setFresh(null); refresh(); }} /></div>}
      {data && !fresh && (
        <section className="card stack" aria-label="Authenticator">
          <div className="row-between">
            <h2>Authenticator app</h2>
            {data.enrolled ? <span className="chip chip-approved">On</span> : <span className="chip">Off</span>}
          </div>
          {data.required && data.requiredByRole && <div className="notice notice-info">Your role needs a second factor, so it cannot be turned off. If you lose your phone, an admin can reset it.</div>}
          {!data.enrolled && (
            <EnrollFlow onDone={() => { toast('Authenticator set up'); refresh(); }} intro="Adds a code from an app on your phone to signing in. Admins and approvers need one; for everyone else it is optional." />
          )}
          {data.enrolled && (
            <div className="stack">
              <p className="muted" style={{ margin: 0 }}>You have {data.recoveryCodesLeft} recovery code{data.recoveryCodesLeft === 1 ? '' : 's'} left.{data.recoveryCodesLeft <= 3 && ' Make new ones before they run out.'}</p>
              <div className="row">
                <CodeAction
                  label="Make new recovery codes" hint="The old ones stop working."
                  run={(code) => api.post<{ recoveryCodes: string[] }>('/api/auth/2fa/recovery-codes', { code })}
                  onDone={(r) => setFresh((r as { recoveryCodes: string[] }).recoveryCodes)}
                />
                {!data.requiredByRole && (
                  <CodeAction
                    label="Turn off" danger hint="You will be asked for no code when you sign in."
                    run={(code) => api.post('/api/auth/2fa/disable', { code })}
                    onDone={() => { toast('Authenticator removed'); refresh(); }}
                  />
                )}
              </div>
            </div>
          )}
        </section>
      )}
      </div>
    </>
  );
}
