import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Navigate, useNavigate } from 'react-router-dom';
import { api, type AuthState } from '../api';
import { EnrollFlow, VerifyForm } from '../components/SecondFactor';
import { ErrorBox, Spinner } from '../components/ui';

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
  if (error) return <div className="auth"><div className="card"><ErrorBox error={error} /></div></div>;
  if (!data) return <div className="auth"><Spinner /></div>;
  if (!data.signedIn) return <Navigate to="/login" replace />;
  if (data.secondFactor === 'none') return <Navigate to="/" replace />;
  return (
    <div className="auth">
      <div className="card stack" data-testid="second-factor" data-step={data.secondFactor}>
        <h1>{data.secondFactor === 'enroll' ? 'Set up your second factor' : 'One more step'}</h1>
        {data.secondFactor === 'enroll' ? (
          <>
            <p className="muted" style={{ margin: 0 }}>Your role needs a second factor, so that a stolen sign-in link is not enough to approve or publish.</p>
            <EnrollFlow onDone={done} />
          </>
        ) : (
          <VerifyForm onDone={done} />
        )}
        <button className="btn btn-small" onClick={signOut}>Sign out</button>
      </div>
    </div>
  );
}
