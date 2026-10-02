import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { api, ApiError } from '../api';
import { useConfig } from '../App';
import { errorMessage, ErrorBox, Field, Spinner } from '../components/ui';
import { LOCALES, t, tMaybe, useLocale, type Locale } from '../i18n';
import '../styles/settings.css';

/** The studio's mark and name, as in the sidebar. */
export function AuthBrand() {
  return (
    <div className="auth-brand">
      <span className="logo-mark" aria-hidden="true">
        <svg viewBox="0 0 16 16"><path d="M4 2.5v11l9-5.5z" fill="currentColor" style={{ color: 'var(--accent-contrast)' }} /></svg>
      </span>
      <span>{t('layout.appName')}</span>
    </div>
  );
}

/** Two words to switch language, for pages seen before signing in (and by people outside the team). */
export function AuthLanguage() {
  const { locale, setLocale } = useLocale();
  return (
    <div className="auth-lang" role="group" aria-label={t('account.language.title')}>
      {LOCALES.map((l) => (
        <button key={l.value} type="button" lang={l.value} aria-pressed={locale === l.value} onClick={() => setLocale(l.value as Locale)}>{l.label}</button>
      ))}
    </div>
  );
}

/** The frame of every page outside the app: the card on the dark background, and the language below it. */
export function AuthFrame({ children, className = '', testId, step }: { children: ReactNode; className?: string; testId?: string; step?: string }) {
  return (
    <div className="auth">
      <div className="auth-wrap">
        <main className={`card auth-card ${className}`} data-testid={testId} data-step={step}>{children}</main>
        <div className="auth-below"><AuthLanguage /></div>
      </div>
    </div>
  );
}

const MailIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><rect x="3" y="5" width="18" height="14" rx="2" /><path d="m3.5 6.5 8.5 6 8.5-6" /></svg>
);

export function Login() {
  const [search] = useSearchParams();
  const ssoError = search.get('error');
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const { data: config } = useConfig();
  const qc = useQueryClient();
  const navigate = useNavigate();

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (config && !config.emailLinkLogin) return devLogin();
    setBusy(true);
    setError(null);
    try {
      await api.post('/api/auth/magic-link', { email });
      setSent(true);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  const devLogin = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.post('/api/auth/dev-login', { email });
      await qc.invalidateQueries({ queryKey: ['me'] });
      navigate('/');
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  const emailLink = config?.emailLinkLogin !== false;
  const showForm = !config || config.emailLinkLogin || config.devLogin;

  if (sent) {
    return (
      <AuthFrame>
        <AuthBrand />
        <div className="auth-sent" role="status">
          <span className="auth-icon auth-icon-good"><MailIcon /></span>
          <h1>{t('account.login.sentTitle')}</h1>
          <p>{t('account.login.sent', { email })}</p>
        </div>
        <button className="btn btn-ghost" onClick={() => { setSent(false); setError(null); }}>{t('account.login.otherEmail')}</button>
      </AuthFrame>
    );
  }

  return (
    <AuthFrame>
      <AuthBrand />
      <div className="auth-head">
        <h1>{t('account.login.title')}</h1>
        <p>{emailLink ? t('account.login.subtitle') : t('account.login.subtitleNoEmail')}</p>
      </div>
      {ssoError && <div className="notice notice-bad" role="alert" style={{ margin: 0 }}>{tMaybe(`account.sso.${ssoError}`, t('account.sso.other'))}</div>}
      {config?.sso && (
        // A plain link, not a request: the browser has to be sent to the provider's page and back.
        <a className="btn btn-primary" href="/api/auth/sso/start">{t('account.login.sso', { provider: config.sso.label })}</a>
      )}
      {config?.sso && showForm && <div className="auth-or">{t('account.login.or')}</div>}
      {showForm && (
        <form onSubmit={submit}>
          <Field label={t('account.login.email')}>
            <input type="email" required autoFocus={!config?.sso} autoComplete="email" placeholder={t('account.login.emailPlaceholder')} value={email} onChange={(e) => setEmail(e.target.value)} />
          </Field>
          {error != null && <ErrorBox error={error} />}
          {emailLink && <button className={`btn ${config?.sso ? '' : 'btn-primary'}`} disabled={busy}>{busy ? t('account.login.sending') : t('account.login.send')}</button>}
          {config?.devLogin && (
            <div className="auth-dev">
              <button type="button" className="btn" disabled={busy || !email} onClick={devLogin}>
                {t('account.login.dev')}
              </button>
              <p>{t('account.login.devHint')}</p>
            </div>
          )}
        </form>
      )}
      <p className="auth-foot">{t('account.login.noAccess')}</p>
    </AuthFrame>
  );
}

export function AuthCallback() {
  const [params] = useSearchParams();
  const [error, setError] = useState<string | null>(null);
  const navigate = useNavigate();
  const qc = useQueryClient();
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return; // React StrictMode runs effects twice; a link works once
    started.current = true;
    const token = params.get('token');
    if (!token) {
      setError(t('account.callback.incomplete'));
      return;
    }
    api
      .post('/api/auth/verify', { token })
      .then(async () => {
        await qc.invalidateQueries({ queryKey: ['me'] });
        navigate('/', { replace: true });
      })
      // A used, expired or mangled link all come back as a refusal: say it in the reader's words, not the validator's.
      .catch((e) => setError(e instanceof ApiError && e.code !== 'rate_limited' ? t('account.callback.invalid') : errorMessage(e)));
  }, [params, navigate, qc]);

  return (
    <AuthFrame>
      <AuthBrand />
      {error ? (
        <>
          <div className="auth-head">
            <h1>{t('account.callback.failed')}</h1>
            <p>{t('account.callback.failedHint')}</p>
          </div>
          <div className="notice notice-bad" role="alert" style={{ margin: 0 }}>{error}</div>
          <a className="btn btn-primary" href="/login">{t('account.callback.back')}</a>
        </>
      ) : (
        <>
          <h1>{t('account.callback.title')}</h1>
          <Spinner label={t('account.callback.wait')} />
        </>
      )}
    </AuthFrame>
  );
}
