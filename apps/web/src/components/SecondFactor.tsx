import { useMutation } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { api, type Enrollment } from '../api';
import { CopyButton, ErrorBox, Field } from './ui';

/** The secret to type into an authenticator app, in groups of four so it can be read out and checked. */
const grouped = (s: string) => s.replace(/(.{4})/g, '$1 ').trim();

/** Ten one-time codes for a lost phone, shown once: the person is asked to keep them before going on. */
export function RecoveryCodes({ codes, onDone, doneLabel = 'I have saved them' }: { codes: string[]; onDone: () => void; doneLabel?: string }) {
  const [saved, setSaved] = useState(false);
  const text = codes.join('\n');
  const download = () => {
    const url = URL.createObjectURL(new Blob([`Content Studio recovery codes\nEach works once.\n\n${text}\n`], { type: 'text/plain' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = 'content-studio-recovery-codes.txt';
    a.click();
    URL.revokeObjectURL(url);
  };
  return (
    <div className="stack" data-testid="recovery-codes">
      <h2>Keep these recovery codes</h2>
      <p className="muted" style={{ margin: 0 }}>If you lose your phone, each of these lets you sign in once. They are shown now and never again.</p>
      <pre className="card mono" style={{ columns: 2, margin: 0 }}>{text}</pre>
      <div className="row">
        <CopyButton text={text} label="Copy all" />
        <button type="button" className="btn btn-small" onClick={download}>Download</button>
      </div>
      <label className="check">
        <input type="checkbox" checked={saved} onChange={(e) => setSaved(e.target.checked)} />
        <span>I have put them somewhere safe</span>
      </label>
      <div><button className="btn btn-primary" disabled={!saved} onClick={onDone}>{doneLabel}</button></div>
    </div>
  );
}

/** Setting an authenticator up: the secret to enter (or an address a phone opens by itself), then the first code to prove it works. */
export function EnrollFlow({ onDone, intro }: { onDone: () => void; intro?: string }) {
  const [code, setCode] = useState('');
  const [codes, setCodes] = useState<string[] | null>(null);
  const [e, setE] = useState<Enrollment | null>(null);
  const start = useMutation({ mutationFn: () => api.post<Enrollment>('/api/auth/2fa/enroll'), onSuccess: setE });
  const confirm = useMutation({
    mutationFn: () => api.post<{ recoveryCodes: string[] }>('/api/auth/2fa/enroll/confirm', { code }),
    onSuccess: (r) => setCodes(r.recoveryCodes),
  });
  if (codes) return <RecoveryCodes codes={codes} onDone={onDone} doneLabel="Continue" />;
  if (!e) {
    return (
      <div className="stack">
        <p className="muted" style={{ margin: 0 }}>{intro ?? 'An authenticator app (Google Authenticator, Microsoft Authenticator, 1Password, Authy…) gives you a new six-digit code every 30 seconds.'}</p>
        {start.error && <ErrorBox error={start.error} />}
        <div><button className="btn btn-primary" onClick={() => start.mutate()} disabled={start.isPending}>Set up an authenticator</button></div>
      </div>
    );
  }
  const submit = (ev: FormEvent) => { ev.preventDefault(); confirm.mutate(); };
  return (
    <form className="stack" onSubmit={submit}>
      <ol className="stack" style={{ margin: 0, paddingLeft: '1.2rem' }}>
        <li>
          In your authenticator app, add an account and choose <em>enter a setup key</em>, then type this key (spaces do not matter):
          <div className="card mono" style={{ margin: '.4rem 0', fontSize: '1.05rem', letterSpacing: '.05em' }} data-testid="secret">{grouped(e.secret)}</div>
          <div className="row"><CopyButton text={e.secret} label="Copy key" /><a className="btn btn-small" href={e.otpauthUrl}>Open in an app on this device</a></div>
        </li>
        <li>Type the six-digit code the app shows now.</li>
      </ol>
      <Field label="Code from the app">
        <input type="text" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9 ]*" maxLength={8} required autoFocus value={code} onChange={(ev) => setCode(ev.target.value.replace(/\s/g, ''))} style={{ maxWidth: 160, letterSpacing: '.2em' }} />
      </Field>
      {confirm.error && <ErrorBox error={confirm.error} />}
      <div><button className="btn btn-primary" disabled={confirm.isPending || code.length !== 6}>Check the code</button></div>
    </form>
  );
}

/** The code the person is asked for when they sign in: from the app, or one of their recovery codes. */
export function VerifyForm({ onDone }: { onDone: () => void }) {
  const [code, setCode] = useState('');
  const [recovery, setRecovery] = useState(false);
  const verify = useMutation({ mutationFn: () => api.post('/api/auth/2fa/verify', { code }), onSuccess: onDone });
  return (
    <form className="stack" onSubmit={(ev) => { ev.preventDefault(); verify.mutate(); }}>
      <Field label={recovery ? 'Recovery code' : 'Code from your authenticator app'} hint={recovery ? 'One of the ten you were given. Each works once.' : undefined}>
        <input
          type="text" required autoFocus autoComplete="one-time-code" value={code} onChange={(ev) => setCode(ev.target.value)}
          inputMode={recovery ? 'text' : 'numeric'} maxLength={recovery ? 16 : 8} style={{ letterSpacing: '.15em' }}
        />
      </Field>
      {verify.error && <ErrorBox error={verify.error} />}
      <button className="btn btn-primary" disabled={verify.isPending || !code}>Continue</button>
      <button type="button" className="btn btn-small" onClick={() => { setRecovery(!recovery); setCode(''); }}>
        {recovery ? 'Use the app instead' : 'I lost my phone: use a recovery code'}
      </button>
    </form>
  );
}
