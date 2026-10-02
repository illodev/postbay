import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { api } from '../api';
import { useConfig } from '../App';
import { errorMessage, ErrorBox, Field } from '../components/ui';

const SSO_ERRORS: Record<string, string> = {
  cancelled: 'The sign-in was cancelled.',
  state: 'That sign-in did not start in this browser, or took too long. Start again.',
  provider: 'The sign-in service could not be reached, or is not set up properly. Try again, or ask an admin.',
  token: 'The sign-in service gave an answer this app could not accept. Try again, or ask an admin.',
  claims: 'The sign-in service gave an answer this app could not accept. Try again, or ask an admin.',
  domain: 'That account is not one of the accounts allowed to sign in here.',
  no_account: 'There is no account here for that email yet. Ask an admin to add you, then try again.',
  identity_conflict: 'Another account at the sign-in service is already linked to this person. Ask an admin.',
};

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

  return (
    <div className="auth">
      <div className="card stack">
        <h1>Sign in</h1>
        {ssoError && <div className="notice notice-bad" role="alert">{SSO_ERRORS[ssoError] ?? 'The sign-in did not work. Try again.'}</div>}
        {config?.sso && (
          // A plain link, not a request: the browser has to be sent to the provider's page and back.
          <a className="btn btn-primary" href="/api/auth/sso/start">Sign in with {config.sso.label}</a>
        )}
        {config?.sso && config.emailLinkLogin && <p className="muted small" style={{ margin: 0, textAlign: 'center' }}>or</p>}
        {sent ? (
          <div className="notice notice-good" role="status">
            If {email} belongs to someone in a brand, a sign-in link is on its way. It works once and expires in 15 minutes.
          </div>
        ) : (config && !config.emailLinkLogin && !config.devLogin) ? null : (
          <form className="stack" onSubmit={submit}>
            {config?.emailLinkLogin !== false && <p className="muted">We email you a link: there is no password to remember.</p>}
            <Field label="Email">
              <input type="email" required autoFocus autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} />
            </Field>
            {error != null && <ErrorBox error={error} />}
            {config?.emailLinkLogin !== false && <button className="btn btn-primary" disabled={busy || !email}>Email me a link</button>}
            {config?.devLogin && (
              <button type="button" className="btn" disabled={busy || !email} onClick={devLogin}>
                Development sign-in (no email)
              </button>
            )}
          </form>
        )}
      </div>
    </div>
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
      setError('This link is incomplete.');
      return;
    }
    api
      .post('/api/auth/verify', { token })
      .then(async () => {
        await qc.invalidateQueries({ queryKey: ['me'] });
        navigate('/', { replace: true });
      })
      .catch((e) => setError(errorMessage(e)));
  }, [params, navigate, qc]);

  return (
    <div className="auth">
      <div className="card stack">
        <h1>Signing you in…</h1>
        {error && (
          <>
            <div className="notice notice-bad" role="alert">{error}</div>
            <a className="btn" href="/login">Back to sign in</a>
          </>
        )}
      </div>
    </div>
  );
}
