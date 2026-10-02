import { useQuery } from '@tanstack/react-query';
import { lazy, Suspense } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { ApiError } from './api';
import { Layout } from './components/Layout';
import { Empty, ErrorBox, Spinner } from './components/ui';
import { SessionProvider, useMe } from './lib/session';
import { CalendarPage } from './pages/Calendar';
import { Login, AuthCallback } from './pages/Login';
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
  if (isLoading) return <Spinner />;
  if (error instanceof ApiError && error.status === 401) return <Navigate to="/login" replace />;
  if (error) return <div className="page"><ErrorBox error={error} /></div>;
  if (!me) return null;
  if (me.brands.length === 0) {
    return (
      <div className="page">
        <Empty title="You are not a member of any brand yet">Ask an admin to add {me.user.email} to a brand.</Empty>
      </div>
    );
  }
  return (
    <SessionProvider me={me}>
      <Routes>
        <Route element={<Layout />}>
          <Route index element={<Navigate to="/pieces" replace />} />
          <Route path="pieces" element={<PiecesPage />} />
          <Route path="pieces/:pieceId" element={<PiecePage />} />
          <Route path="review/:versionId" element={<Suspense fallback={<Spinner />}><ReviewPage /></Suspense>} />
          <Route path="calendar" element={<CalendarPage />} />
          <Route path="today" element={<PublishPage />} />
          <Route path="results" element={<ResultsPage />} />
          <Route path="settings" element={<SettingsPage />} />
          <Route path="*" element={<Empty title="Page not found" />} />
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
      <Route path="/prize/:token" element={<PublicPrizePage />} />
      <Route path="/data-deletion" element={<DataDeletionPage />} />
      <Route path="/*" element={<Authed />} />
    </Routes>
  );
}

// Re-exported so pages can share one query for the public config.
export function useConfig() {
  return useQuery({ queryKey: ['config'], queryFn: () => fetch('/api/config').then((r) => r.json() as Promise<{ devLogin: boolean }>) });
}
