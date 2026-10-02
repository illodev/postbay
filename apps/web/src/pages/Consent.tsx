import { useMutation, useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { api, ApiError, type Role } from '../api';
import { ErrorBox, Spinner } from '../components/ui';
import { t } from '../i18n';
import { ROLE_LABEL } from '../lib/format';
import { rememberNext } from '../lib/next';
import { AuthBrand, AuthFrame } from './Login';
import '../styles/settings.css';
import '../styles/assistants.css';

interface ConsentDetails {
  request: string;
  nonce: string;
  expires_at: string;
  client: { name: string; uri: string | null; redirect_host: string; local: boolean; registered_at: string };
  brands: { id: string; name: string; workspace: string; role: Role; can_approve: boolean }[];
}

/**
 * Where an AI assistant sends the person to connect it (OAuth's authorization step). The person signs in as on any other page, then
 * sees which assistant asks, where it will send the answer (the one thing a client cannot fake), and picks the brands it may act in.
 */
export function ConsentPage() {
  const [search] = useSearchParams();
  const navigate = useNavigate();
  const requestId = search.get('request');
  const problem = search.get('error');
  const { data, error } = useQuery({
    queryKey: ['oauth-consent', requestId],
    enabled: !!requestId && !problem,
    queryFn: () => api.get<ConsentDetails>(`/api/oauth-consent/${requestId}`),
    retry: false,
    staleTime: Infinity,
    refetchOnWindowFocus: false,
  });
  const [chosen, setChosen] = useState<Set<string> | null>(null);
  const [leaving, setLeaving] = useState(false);
  // With one brand there is nothing to choose; with several, the person ticks the ones the assistant may use.
  const only = data && data.brands.length === 1 ? data.brands[0]!.id : null;
  const picked = chosen ?? new Set(only ? [only] : []);

  // Signed out, or owing the second step: through the usual sign-in, and back here after it.
  const here = `/oauth/consent?request=${encodeURIComponent(requestId ?? '')}`;
  useEffect(() => {
    if (!(error instanceof ApiError) || error.status !== 401) return;
    rememberNext(here);
    navigate(error.code === 'second_factor_required' ? '/second-factor' : '/login', { replace: true });
  }, [error, here, navigate]);

  const answer = useMutation({
    mutationFn: (allow: boolean) =>
      api.post<{ redirect: string }>(`/api/oauth-consent/${requestId}`, { allow, brandIds: allow ? [...picked] : [], nonce: data!.nonce }),
    onSuccess: (r) => {
      setLeaving(true);
      window.location.assign(r.redirect);
    },
  });

  if (problem || !requestId) {
    const text = problem === 'invalid_client' ? t('consent.error.invalid_client') : problem === 'invalid_redirect_uri' ? t('consent.error.invalid_redirect_uri') : t('consent.error.missing');
    return (
      <AuthFrame>
        <AuthBrand />
        <div className="auth-head"><h1>{t('consent.failed')}</h1></div>
        <div className="notice notice-bad" role="alert" style={{ margin: 0 }}>{text}</div>
      </AuthFrame>
    );
  }
  if (error && !(error instanceof ApiError && error.status === 401)) {
    return (
      <AuthFrame>
        <AuthBrand />
        <div className="auth-head"><h1>{t('consent.failed')}</h1></div>
        <ErrorBox error={error} />
      </AuthFrame>
    );
  }
  if (!data) return <AuthFrame><AuthBrand /><Spinner /></AuthFrame>;

  const flip = (id: string) => {
    const next = new Set(picked);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setChosen(next);
  };
  const client = data.client.name;

  if (leaving) return <AuthFrame><AuthBrand /><Spinner label={t('consent.back', { client })} /></AuthFrame>;

  return (
    <AuthFrame className="auth-wide" testId="consent">
      <AuthBrand />
      <div className="auth-head">
        <h1>{t('consent.title', { client })}</h1>
        <p>{t('consent.lead')}</p>
        <p className="consent-to">{t('consent.answersTo')} <span className="consent-host">{data.client.redirect_host}</span></p>
      </div>
      {data.client.local && <div className="notice notice-warn" role="note" style={{ margin: 0 }}>{t('consent.local')}</div>}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          answer.mutate(true);
        }}
      >
        <fieldset className="set-fieldset">
          <legend className="set-legend">{t('consent.brands')}</legend>
          <ul className="consent-brands">
            {data.brands.map((b) => {
              const body = (
                <>
                  <span className="brand-mark acct-brand-mark" aria-hidden="true">{b.name.charAt(0).toUpperCase()}</span>
                  <span className="grow">
                    <span>{b.name}</span>
                    <span>{ROLE_LABEL[b.role] ?? b.role}{b.can_approve && ` · ${t('consent.canApprove')}`}</span>
                  </span>
                </>
              );
              return (
                <li key={b.id}>
                  {only ? <div>{body}</div> : <label><input type="checkbox" checked={picked.has(b.id)} onChange={() => flip(b.id)} />{body}</label>}
                </li>
              );
            })}
          </ul>
        </fieldset>
        <p className="set-hint">{t('consent.acts', { client })}</p>
        {answer.error && <ErrorBox error={answer.error} />}
        <div className="consent-actions">
          <button type="button" className="btn" disabled={answer.isPending} onClick={() => answer.mutate(false)}>{t('consent.deny')}</button>
          <button type="submit" className="btn btn-primary" disabled={answer.isPending || picked.size === 0} data-testid="consent-allow">{t('consent.allow')}</button>
        </div>
      </form>
      <p className="auth-foot">{t('consent.later')}</p>
    </AuthFrame>
  );
}
