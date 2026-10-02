import { useMutation } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { api, type Enrollment } from '../api';
import { t } from '../i18n';
import { CopyButton, ErrorBox, Field } from './ui';

/** The secret to type into an authenticator app, in groups of four so it can be read out and checked. */
const grouped = (s: string) => s.replace(/(.{4})/g, '$1 ').trim();

/** Ten one-time codes for a lost phone, shown once: the person is asked to keep them before going on. */
export function RecoveryCodes({ codes, onDone, doneLabel }: { codes: string[]; onDone: () => void; doneLabel?: string }) {
  const [saved, setSaved] = useState(false);
  const text = codes.join('\n');
  const download = () => {
    const url = URL.createObjectURL(new Blob([`${t('account.recovery.fileTitle')}\n${t('account.recovery.fileNote')}\n\n${text}\n`], { type: 'text/plain' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = t('account.recovery.fileName');
    a.click();
    URL.revokeObjectURL(url);
  };
  return (
    <div className="stack" data-testid="recovery-codes">
      <h2>{t('account.recovery.title')}</h2>
      <p className="muted" style={{ margin: 0 }}>{t('account.recovery.hint')}</p>
      <pre className="acct-codes">{text}</pre>
      <div className="row">
        <CopyButton text={text} label={t('account.recovery.copyAll')} />
        <button type="button" className="btn btn-small" onClick={download}>{t('common.download')}</button>
      </div>
      <label className="check">
        <input type="checkbox" checked={saved} onChange={(e) => setSaved(e.target.checked)} />
        <span>{t('account.recovery.saved')}</span>
      </label>
      <div><button className="btn btn-primary" disabled={!saved} onClick={onDone}>{doneLabel ?? t('account.recovery.done')}</button></div>
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
  if (codes) return <RecoveryCodes codes={codes} onDone={onDone} doneLabel={t('account.enroll.continue')} />;
  if (!e) {
    return (
      <div className="stack">
        <p className="muted" style={{ margin: 0 }}>{intro ?? t('account.enroll.intro')}</p>
        {start.error && <ErrorBox error={start.error} />}
        <div><button className="btn btn-primary" onClick={() => start.mutate()} disabled={start.isPending}>{t('account.enroll.start')}</button></div>
      </div>
    );
  }
  const submit = (ev: FormEvent) => { ev.preventDefault(); confirm.mutate(); };
  return (
    <form className="stack" onSubmit={submit}>
      <ol className="acct-steps">
        <li>
          {t('account.enroll.step1')}
          <div className="acct-key" data-testid="secret">{grouped(e.secret)}</div>
          <div className="row"><CopyButton text={e.secret} label={t('account.enroll.copyKey')} /><a className="btn btn-small" href={e.otpauthUrl}>{t('account.enroll.openApp')}</a></div>
        </li>
        <li>{t('account.enroll.step2')}</li>
      </ol>
      <Field label={t('account.enroll.codeLabel')}>
        <input className="acct-code-input" type="text" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9 ]*" maxLength={8} required autoFocus value={code} onChange={(ev) => setCode(ev.target.value.replace(/\s/g, ''))} />
      </Field>
      {confirm.error && <ErrorBox error={confirm.error} />}
      <div><button className="btn btn-primary" disabled={confirm.isPending || code.length !== 6}>{t('account.enroll.check')}</button></div>
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
      <Field label={recovery ? t('account.verify.recoveryLabel') : t('account.verify.codeLabel')} hint={recovery ? t('account.verify.recoveryHint') : undefined}>
        <input
          className="acct-code-input" style={{ maxWidth: 'none' }}
          type="text" required autoFocus autoComplete="one-time-code" value={code} onChange={(ev) => setCode(ev.target.value)}
          inputMode={recovery ? 'text' : 'numeric'} maxLength={recovery ? 16 : 8}
        />
      </Field>
      {verify.error && <ErrorBox error={verify.error} />}
      <button className="btn btn-primary" disabled={verify.isPending || !code}>{t('account.verify.continue')}</button>
      <button type="button" className="btn btn-ghost btn-small" onClick={() => { setRecovery(!recovery); setCode(''); }}>
        {recovery ? t('account.verify.useApp') : t('account.verify.useRecovery')}
      </button>
    </form>
  );
}
