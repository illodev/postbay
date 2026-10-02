import { useMutation, useQuery } from '@tanstack/react-query';
import { useEffect } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import { api } from '../api';
import { ErrorBox, Spinner } from '../components/ui';

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

interface PublicPrizeData {
  prize: { name: string; kind: 'file' | 'link'; file_name: string | null };
  brand: string;
  expires_at: string;
}

/** The page a prize message links to: what it is, who it is from, and a button. No sign-in, nothing about who else got it. */
export function PublicPrizePage() {
  useNoIndex();
  const { token = '' } = useParams();
  const { data, error } = useQuery({ queryKey: ['public-prize', token], retry: false, queryFn: () => api.get<PublicPrizeData>(`/api/public/prizes/${encodeURIComponent(token)}`) });
  const go = useMutation({
    mutationFn: () => api.post<{ url: string }>(`/api/public/prizes/${encodeURIComponent(token)}/download`),
    onSuccess: (r) => { window.location.href = r.url; },
  });
  return (
    <div className="auth">
      <div className="card stack" data-testid="public-prize">
        {!data && !error && <Spinner />}
        {error && (
          <>
            <h1>Prize</h1>
            <ErrorBox error={error} />
            <p className="muted small">If you were sent this link by a brand, ask them for a new one.</p>
          </>
        )}
        {data && (
          <>
            <p className="muted" style={{ margin: 0 }}>From {data.brand}</p>
            <h1>{data.prize.name}</h1>
            {data.prize.file_name && <p className="muted" style={{ margin: 0 }}>{data.prize.file_name}</p>}
            <button className="btn btn-primary" onClick={() => go.mutate()} disabled={go.isPending}>{data.prize.kind === 'file' ? 'Download' : 'Open'}</button>
            {go.error && <ErrorBox error={go.error} />}
            <p className="muted small" style={{ margin: 0 }}>This link works until {new Date(data.expires_at).toLocaleString()}. It cannot be used more than a few times.</p>
          </>
        )}
      </div>
    </div>
  );
}

/**
 * Where Meta's data-deletion callback sends a person, and the instructions its review asks for. With ?code= it says
 * that request was handled; without it, how to have what is kept about you deleted.
 */
export function DataDeletionPage() {
  useNoIndex();
  const [params] = useSearchParams();
  const code = params.get('code');
  const { data, error } = useQuery({
    queryKey: ['deletion', code], enabled: !!code, retry: false,
    queryFn: () => api.get<{ status: string; requested_at: string; deleted: number }>(`/api/public/data-deletion/${encodeURIComponent(code ?? '')}`),
  });
  return (
    <div className="auth">
      <div className="card stack" data-testid="data-deletion">
        <h1>Deleting your data</h1>
        {code && !data && !error && <Spinner />}
        {code && error && <ErrorBox error={error} />}
        {data && (
          <div className="notice notice-good" role="status">
            Your request ({code}) was handled on {new Date(data.requested_at).toLocaleDateString()}. {data.deleted > 0 ? `We deleted ${data.deleted} entr${data.deleted === 1 ? 'y' : 'ies'} about you.` : 'We were not keeping anything about you.'}
          </div>
        )}
        <p>
          If you commented on a post to get a prize, we kept only your id on the network and the name you show there, so we could send it to you.
          That is deleted automatically after a few weeks.
        </p>
        <p>To have it deleted sooner, remove the app from your Facebook or Instagram account (Settings → Apps and websites, or Business integrations). The network tells us, and we delete what we kept about you straight away. You can also ask the account you commented on to erase you.</p>
      </div>
    </div>
  );
}
