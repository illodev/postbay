import { useQuery } from '@tanstack/react-query';
import { lazy, Suspense, useEffect } from 'react';
import { Navigate, Route, Routes, useNavigate } from 'react-router-dom';
import { ApiError, type PublicConfig } from './api';
import { Layout } from './components/Layout';
import { Empty, ErrorBox, Spinner } from './components/ui';
import { t } from './i18n';
import { takeNext } from './lib/next';
import { SessionProvider, useMe } from './lib/session';
import { ConsentPage } from './pages/Consent';
import { CalendarPage } from './pages/Calendar';
import { HomePage } from './pages/Home';
import { Login, AuthCallback } from './pages/Login';
import { SecondFactorPage } from './pages/SecondFactor';
import { SecurityPage } from './pages/Security';
import { PiecePage } from './pages/Piece';
import { PiecesPage } from './pages/Pieces';
import { DataDeletionPage, PublicPrizePage } from './pages/PublicPrize';
import { ResultsPage } from './pages/Results';
import { PublishPage } from './pages/Publish';
import { SettingsPage } from './pages/Settings';

// The review page carries the PDF engine, so it loads on demand instead of weighing down every other page.
const ReviewPage = lazy(() => import('./pages/Review').then((m) => ({ default: m.ReviewPage })));

function Authed() {
  const { data: me, error, isLoading } = useMe();
  const navigate = useNavigate();
  // Signed in on the way to connecting an assistant: back to its consent page.
  useEffect(() => {
    if (!me) return;
    const next = takeNext();
    if (next) navigate(next, { replace: true });
  }, [me, navigate]);
  if (isLoading) return <Spinner />;
  // A session that has done the first step of signing in but owes the second is sent to give it.
  if (error instanceof ApiError && error.code === 'second_factor_required') return <Navigate to="/second-factor" replace />;
  if (error instanceof ApiError && error.status === 401) return <Navigate to="/login" replace />;
  if (error) return <div className="page"><ErrorBox error={error} /></div>;
  if (!me) return null;
  if (me.brands.length === 0) {
    return (
      <div className="page">
        <Empty title={t('layout.noBrands')}>{t('layout.noBrandsHint', { email: me.user.email })}</Empty>
      </div>
    );
  }
  return (
    <SessionProvider me={me}>
      <Routes>
        <Route element={<Layout />}>
          <Route index element={<HomePage />} />
          <Route path="pieces" element={<PiecesPage />} />
          <Route path="pieces/:pieceId" element={<PiecePage />} />
          <Route path="review/:versionId" element={<Suspense fallback={<Spinner />}><ReviewPage /></Suspense>} />
          <Route path="calendar" element={<CalendarPage />} />
          <Route path="today" element={<PublishPage />} />
          <Route path="results" element={<ResultsPage />} />
          <Route path="settings" element={<SettingsPage />} />
          <Route path="security" element={<SecurityPage />} />
          <Route path="*" element={<Empty title={t('common.notFound')} />} />
        </Route>
      </Routes>
    </SessionProvider>
  );
}

export function App() {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route path="/auth/callback" element={<AuthCallback />} />
      <Route path="/second-factor" element={<SecondFactorPage />} />
      <Route path="/oauth/consent" element={<ConsentPage />} />
      <Route path="/prize/:token" element={<PublicPrizePage />} />
      <Route path="/data-deletion" element={<DataDeletionPage />} />
      <Route path="/*" element={<Authed />} />
    </Routes>
  );
}

// Re-exported so pages can share one query for the public config.
export function useConfig() {
  return useQuery({ queryKey: ['config'], queryFn: () => fetch('/api/config').then((r) => r.json() as Promise<PublicConfig>) });
}
