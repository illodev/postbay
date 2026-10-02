import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, type SecondFactorStatus } from '../api';
import { EnrollFlow, RecoveryCodes } from '../components/SecondFactor';
import { NotificationPrefs } from '../components/NotificationPrefs';
import { Chip, ErrorBox, errorMessage, Field, Spinner, useToast } from '../components/ui';
import { LOCALES, t, useLocale, type Locale } from '../i18n';
import { ROLE_LABEL } from '../lib/format';
import { useSession } from '../lib/session';
import '../styles/settings.css';

const initials = (s: string) =>
  s.split(/[\s@.]+/).filter(Boolean).slice(0, 2).map((w) => w[0]!.toUpperCase()).join('');

/** Asks for a current code before doing something that would otherwise let anyone at an unlocked laptop weaken the account. */
function CodeAction({ label, hint, danger, run, onDone }: { label: string; hint: string; danger?: boolean; run: (code: string) => Promise<unknown>; onDone: (r: unknown) => void }) {
  const [open, setOpen] = useState(false);
  const [code, setCode] = useState('');
  const go = useMutation({ mutationFn: () => run(code), onSuccess: (r) => { setOpen(false); setCode(''); onDone(r); } });
  if (!open) return <button className={`btn ${danger ? 'btn-danger' : ''}`} onClick={() => setOpen(true)}>{label}</button>;
  const submit = (e: FormEvent) => { e.preventDefault(); go.mutate(); };
  return (
    <form className="stack card" style={{ background: 'var(--surface-2)', flex: '1 1 100%' }} onSubmit={submit}>
      <Field label={t('account.code.label')} hint={hint}>
        <input className="acct-code-input" type="text" inputMode="numeric" autoComplete="one-time-code" required autoFocus maxLength={8} value={code} onChange={(e) => setCode(e.target.value.replace(/\s/g, ''))} />
      </Field>
      {go.error && <ErrorBox error={go.error} />}
      <div className="row">
        <button type="button" className="btn" onClick={() => setOpen(false)}>{t('common.cancel')}</button>
        <button className={`btn ${danger ? 'btn-danger' : 'btn-primary'}`} disabled={go.isPending || code.length !== 6}>{label}</button>
      </div>
    </form>
  );
}

function Profile() {
  const { me } = useSession();
  const qc = useQueryClient();
  const toast = useToast();
  const navigate = useNavigate();
  const name = me.user.name ?? me.user.email;
  const signOut = async () => {
    try {
      await api.post('/api/auth/logout');
      qc.clear();
      navigate('/login');
    } catch (e) {
      toast(errorMessage(e), 'error');
    }
  };
  return (
    <section className="card stack" aria-labelledby="acct-profile">
      <h2 id="acct-profile">{t('account.profile.title')}</h2>
      <div className="acct-who">
        <span className="avatar" aria-hidden="true">{initials(name)}</span>
        <div style={{ minWidth: 0 }}>
          <strong>{name}</strong>
          {me.user.name && <div className="muted small">{me.user.email}</div>}
        </div>
      </div>
      <div>
        <div className="set-legend" style={{ marginBottom: '.25rem' }}>{t('account.profile.brands', { count: me.brands.length })}</div>
        <ul className="acct-brands">
          {me.brands.map((b) => (
            <li key={b.id}>
              <span>{b.name}{b.paused && <> <Chip state="on_hold" label={t('account.profile.paused')} /></>}</span>
              <span className="muted">{ROLE_LABEL[b.role]}</span>
            </li>
          ))}
        </ul>
      </div>
      <p className="set-hint">{t('account.profile.nameHint')}</p>
      <div><button className="btn btn-small" onClick={signOut}>{t('account.profile.signOut')}</button></div>
    </section>
  );
}

function Language() {
  const { locale, setLocale } = useLocale();
  return (
    <section className="card stack" aria-labelledby="acct-lang">
      <h2 id="acct-lang">{t('account.language.title')}</h2>
      <p className="set-hint">{t('account.language.hint')}</p>
      <div className="acct-lang" role="radiogroup" aria-labelledby="acct-lang">
        {LOCALES.map((l) => (
          <label key={l.value} lang={l.value}>
            <input type="radio" name="locale" value={l.value} checked={locale === l.value} onChange={() => setLocale(l.value as Locale)} />
            {l.label}
          </label>
        ))}
      </div>
      <p className="set-hint">{t('account.language.note')}</p>
    </section>
  );
}

function Authenticator() {
  const qc = useQueryClient();
  const toast = useToast();
  const { data, error } = useQuery({ queryKey: ['second-factor'], queryFn: () => api.get<SecondFactorStatus>('/api/auth/2fa') });
  const [fresh, setFresh] = useState<string[] | null>(null);
  const refresh = () => qc.invalidateQueries({ queryKey: ['second-factor'] });
  if (error) return <section className="card acct-full"><ErrorBox error={error} /></section>;
  if (!data) return <section className="card acct-full"><Spinner /></section>;
  if (fresh) return <section className="card acct-full"><RecoveryCodes codes={fresh} onDone={() => { setFresh(null); refresh(); }} /></section>;
  const left = data.recoveryCodesLeft;
  return (
    <section className="card stack acct-full" aria-labelledby="acct-2fa">
      <div className="set-card-head">
        <div>
          <h2 id="acct-2fa">{t('account.twofa.title')}</h2>
          <p className="set-hint">{t('account.twofa.hint')}</p>
        </div>
        {data.enrolled ? <Chip state="approved" label={t('account.twofa.on')} /> : <Chip state="draft" label={t('account.twofa.off')} />}
      </div>
      {data.required && data.requiredByRole && <div className="notice notice-info" style={{ margin: 0 }}>{t('account.twofa.required')}</div>}
      {!data.enrolled && (
        <EnrollFlow onDone={() => { toast(t('account.twofa.setUp')); refresh(); }} intro={t('account.twofa.introShort')} />
      )}
      {data.enrolled && (
        <div className="stack">
          <p style={{ margin: 0 }} className={left <= 3 ? 'set-warn' : 'muted'}>
            {t('account.twofa.codesLeft', { count: left })}{left <= 3 && ` ${t('account.twofa.codesLow')}`}
          </p>
          <div className="row" style={{ alignItems: 'flex-start' }}>
            <CodeAction
              label={t('account.twofa.newCodes')} hint={t('account.twofa.newCodesHint')}
              run={(code) => api.post<{ recoveryCodes: string[] }>('/api/auth/2fa/recovery-codes', { code })}
              onDone={(r) => setFresh((r as { recoveryCodes: string[] }).recoveryCodes)}
            />
            {!data.requiredByRole && (
              <CodeAction
                label={t('account.twofa.turnOff')} danger hint={t('account.twofa.turnOffHint')}
                run={(code) => api.post('/api/auth/2fa/disable', { code })}
                onDone={() => { toast(t('account.twofa.removed')); refresh(); }}
              />
            )}
          </div>
        </div>
      )}
    </section>
  );
}

/** The person's own page: who they are, the language, how they prove it is them, and what they are told about. */
export function SecurityPage() {
  return (
    <>
      <div className="page-head">
        <div>
          <h1>{t('account.title')}</h1>
          <p className="muted">{t('account.subtitle')}</p>
        </div>
      </div>
      <div className="acct">
        <Profile />
        <Language />
        <Authenticator />
        <NotificationPrefs />
      </div>
    </>
  );
}
