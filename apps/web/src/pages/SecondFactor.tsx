import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Navigate, useNavigate } from 'react-router-dom';
import { api, type AuthState } from '../api';
import { EnrollFlow, VerifyForm } from '../components/SecondFactor';
import { ErrorBox, Spinner } from '../components/ui';
import { t } from '../i18n';
import { AuthBrand, AuthFrame } from './Login';
import '../styles/settings.css';

const ShieldIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><path d="M12 3 4.5 6v5.5c0 4.6 3.2 8.3 7.5 9.5 4.3-1.2 7.5-4.9 7.5-9.5V6z" /><path d="m9 12 2 2 4-4" /></svg>
);

/** The second step of signing in: a code from the authenticator app, or setting one up first. Outside the signed-in pages on purpose. */
export function SecondFactorPage() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { data, error } = useQuery({ queryKey: ['auth-state'], staleTime: 0, queryFn: () => api.get<AuthState>('/api/auth/state') });
  const done = async () => {
    await qc.invalidateQueries({ queryKey: ['me'] });
    navigate('/', { replace: true });
  };
  const signOut = async () => {
    await api.post('/api/auth/logout').catch(() => {});
    qc.clear();
    navigate('/login');
  };
  if (error) return <AuthFrame><AuthBrand /><ErrorBox error={error} /></AuthFrame>;
  if (!data) return <AuthFrame><AuthBrand /><Spinner /></AuthFrame>;
  if (!data.signedIn) return <Navigate to="/login" replace />;
  if (data.secondFactor === 'none') return <Navigate to="/" replace />;
  const enroll = data.secondFactor === 'enroll';
  return (
    <AuthFrame testId="second-factor" step={data.secondFactor} className={enroll ? 'auth-wide' : ''}>
      <AuthBrand />
      <div className="row" style={{ gap: '.85rem', flexWrap: 'nowrap', alignItems: 'flex-start' }}>
        <span className="auth-icon"><ShieldIcon /></span>
        <div className="auth-head">
          <h1>{enroll ? t('account.second.enrollTitle') : t('account.second.verifyTitle')}</h1>
          <p>{enroll ? t('account.second.enrollHint') : t('account.second.verifyHint')}</p>
        </div>
      </div>
      {enroll ? <EnrollFlow onDone={done} /> : <VerifyForm onDone={done} />}
      <p className="auth-foot">
        {t('account.second.notYou')}{' '}
        <button className="btn btn-ghost btn-small" onClick={signOut}>{t('account.second.signOut')}</button>
      </p>
    </AuthFrame>
  );
}
