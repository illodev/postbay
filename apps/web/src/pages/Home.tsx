import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api, type PieceSummary } from '../api';
import { PageBar } from '../components/PageBar';
import { Chip, Empty, Spinner } from '../components/ui';
import { t } from '../i18n';
import { useSession } from '../lib/session';

/** "For you": what is waiting for this person, first thing. */
export function HomePage() {
  const { me, brand } = useSession();
  const { data, isLoading } = useQuery({
    queryKey: ['pieces', brand.id, 'in_review', ''],
    queryFn: () => api.get<PieceSummary[]>(`/api/brands/${brand.id}/pieces?state=in_review`),
  });
  const hour = new Date().getHours();
  const greet = hour < 14 ? 'home.morning' : hour < 21 ? 'home.afternoon' : 'home.evening';
  return (
    <>
      <PageBar crumbs={[{ label: t('layout.nav.home') }]} />
      <div className="page-head">
        <div>
          <h1>{t(greet, { name: (me.user.name ?? me.user.email.split('@')[0]!).split(' ')[0]! })}</h1>
          <p className="muted">{t('home.waiting', { count: data?.length ?? 0 })}</p>
        </div>
      </div>
      {isLoading && <Spinner />}
      {data?.length === 0 && <Empty title={t('home.nothing')} />}
      <div className="piece-grid">
        {data?.map((p) => (
          <Link key={p.id} to={`/pieces/${p.id}`} className="pcard">
            <div className="pcard-thumb"><img src={`/api/pieces/${p.id}/thumb?w=480`} alt="" loading="lazy" /></div>
            <div className="pcard-meta"><h3>{p.title}</h3><div className="pcard-line"><Chip state={p.review_state} /></div></div>
          </Link>
        ))}
      </div>
    </>
  );
}
