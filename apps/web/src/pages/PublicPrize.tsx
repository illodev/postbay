import { useMutation, useQuery } from '@tanstack/react-query';
import { useEffect } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import { api, ApiError } from '../api';
import { Spinner } from '../components/ui';
import { t, tMaybe } from '../i18n';
import { fmtDateTime, fmtDay } from '../lib/format';
import { AuthFrame } from './Login';
import '../styles/settings.css';

/** Pages that anyone can open must not be listed by search engines. */
function useNoIndex() {
  useEffect(() => {
    const m = document.createElement('meta');
    m.name = 'robots';
    m.content = 'noindex, nofollow';
    document.head.appendChild(m);
    return () => { m.remove(); };
  }, []);
}

/** The tab says what the page is, in the visitor's language. */
function useTitle(title: string) {
  useEffect(() => {
    const before = document.title;
    document.title = title;
    return () => { document.title = before; };
  }, [title]);
}

interface PublicPrizeData {
  prize: { name: string; kind: 'file' | 'link'; file_name: string | null };
  brand: string;
  expires_at: string;
  /** False when the prize has nothing to hand out right now (a piece with no approved version), with why, in the visitor's language. */
  available?: boolean;
  unavailable_reason?: string | null;
}

/** Why a link does not work, in words for someone who only clicked it. */
const linkProblem = (e: unknown) => (e instanceof ApiError ? tMaybe(`prizes.public.error.${e.code}`, t('prizes.public.error.other')) : t('prizes.public.error.network'));

const GiftIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true">
    <rect x="3.5" y="8" width="17" height="4" rx="1" /><path d="M5 12v8h14v-8M12 8v12" />
    <path d="M12 8c-1.5-3-5-3.6-5.6-1.6C5.9 8 9 8 12 8zm0 0c1.5-3 5-3.6 5.6-1.6C18.1 8 15 8 12 8z" />
  </svg>
);
const LinkOffIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true">
    <path d="M9 15l6-6M10.5 6.5l1.2-1.2a4 4 0 0 1 5.7 5.7l-1.2 1.2M13.5 17.5l-1.2 1.2a4 4 0 0 1-5.7-5.7l1.2-1.2M4 4l16 16" />
  </svg>
);
const FileIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8zM14 3v5h5" /></svg>
);
const ShieldIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true"><path d="M12 3 4.5 6v5.5c0 4.6 3.2 8.3 7.5 9.5 4.3-1.2 7.5-4.9 7.5-9.5V6z" /></svg>
);

/** The page a prize message links to: what it is, who it is from, and a button. No sign-in, nothing about who else got it. */
export function PublicPrizePage() {
  useNoIndex();
  const { token = '' } = useParams();
  const { data, error } = useQuery({ queryKey: ['public-prize', token], retry: false, queryFn: () => api.get<PublicPrizeData>(`/api/public/prizes/${encodeURIComponent(token)}`) });
  useTitle(data ? t('prizes.public.tabTitle', { name: data.prize.name }) : t('prizes.public.tabTitleEmpty'));
  const go = useMutation({
    mutationFn: () => api.post<{ url: string }>(`/api/public/prizes/${encodeURIComponent(token)}/download`),
    onSuccess: (r) => { window.location.href = r.url; },
  });
  return (
    <AuthFrame className="pp" testId="public-prize">
      {!data && !error && <Spinner />}
      {error && (
        <>
          <span className="auth-icon"><LinkOffIcon /></span>
          <h1>{t('prizes.public.errorTitle')}</h1>
          <p className="muted" style={{ margin: 0 }}>{linkProblem(error)}</p>
          <p className="pp-note">{t('prizes.public.errorHint')}</p>
        </>
      )}
      {data && (
        <>
          <span className="auth-icon"><GiftIcon /></span>
          <p className="pp-from">{t('prizes.public.from', { brand: data.brand })}</p>
          <h1>{data.prize.name}</h1>
          {data.prize.file_name && <span className="pp-file"><FileIcon />{data.prize.file_name}</span>}
          {data.available === false ? (
            <p className="muted" role="status" style={{ margin: 0 }}>{data.unavailable_reason ?? t('fx.prizes.unavailable')}</p>
          ) : (
            <button className="btn btn-primary" onClick={() => go.mutate()} disabled={go.isPending}>
              {go.isPending ? t('prizes.public.opening') : data.prize.kind === 'file' ? t('prizes.public.download') : t('prizes.public.open')}
            </button>
          )}
          {go.error && <div className="notice notice-bad" role="alert" style={{ margin: 0, width: '100%' }}>{linkProblem(go.error)}</div>}
          <p className="pp-note">{t('prizes.public.until', { date: fmtDateTime(data.expires_at, 'local') })}</p>
        </>
      )}
    </AuthFrame>
  );
}

/**
 * Where Meta's data-deletion callback sends a person, and the instructions its review asks for. With ?code= it says
 * that request was handled; without it, how to have what is kept about you deleted.
 */
export function DataDeletionPage() {
  useNoIndex();
  useTitle(t('prizes.deletion.title'));
  const [params] = useSearchParams();
  const code = params.get('code');
  const { data, error } = useQuery({
    queryKey: ['deletion', code], enabled: !!code, retry: false,
    queryFn: () => api.get<{ status: string; requested_at: string; deleted: number }>(`/api/public/data-deletion/${encodeURIComponent(code ?? '')}`),
  });
  return (
    <AuthFrame className="pp" testId="data-deletion">
      <span className="auth-icon"><ShieldIcon /></span>
      <h1>{t('prizes.deletion.title')}</h1>
      {code && !data && !error && <Spinner />}
      {code && error && (
        <div className="notice notice-bad" role="alert" style={{ margin: 0, width: '100%', textAlign: 'left' }}>
          {error instanceof ApiError && error.code === 'not_found' ? t('prizes.deletion.unknown', { code }) : linkProblem(error)}
        </div>
      )}
      {data && (
        <div className="notice notice-good" role="status" style={{ margin: 0, width: '100%', textAlign: 'left' }}>
          {t('prizes.deletion.handled', { code: code ?? '', date: fmtDay(data.requested_at) })}{' '}
          {data.deleted > 0 ? t('prizes.deletion.deleted', { count: data.deleted }) : t('prizes.deletion.nothing')}
        </div>
      )}
      <div className="pp-text">
        <p>{t('prizes.deletion.what')}</p>
        <p>{t('prizes.deletion.sooner')}</p>
        <ol className="pp-steps">
          <li>{t('prizes.deletion.step1')}</li>
          <li>{t('prizes.deletion.step2')} <span className="pp-path">{t('prizes.deletion.path')}</span></li>
          <li>{t('prizes.deletion.step3')}</li>
        </ol>
        <p className="muted small">{t('prizes.deletion.other')}</p>
      </div>
    </AuthFrame>
  );
}
