import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api';
import { t } from '../i18n';
import { fmtShort } from '../lib/format';
import { useSession } from '../lib/session';
import { Avatar, displayName } from './Avatar';
import { Icon } from './icons';
import { CopyButton, ErrorBox, errorMessage, MoreMenu, Skeleton, Switch, Tip, Tipped, useConfirm, useToast } from './ui';
import '../styles/settings.css';
import '../styles/assistants.css';

/**
 * Using Postbay from an AI assistant (MCP): the address to paste into Claude, the brand's switch for deciding from one, and who has
 * connected one. People never handle a key: each connects with their own account (OAuth), and can disconnect from Your account.
 */

interface BrandConnection {
  id: string;
  client_name: string;
  redirect_host: string | null;
  connected_at: string;
  last_used_at: string | null;
  user_id: string;
  user_name: string | null;
  user_email: string;
  other_brands: number;
}

interface MyConnection {
  id: string;
  client_name: string;
  redirect_host: string | null;
  connected_at: string;
  last_used_at: string | null;
  brands: { id: string; name: string }[];
}

/** The MCP server's address, and the line for Claude Code, each with its copy button. */
export function ServerAddress({ url, heading = 'h3' }: { url: string; heading?: 'h2' | 'h3' }) {
  const H = heading;
  const command = `claude mcp add --transport http postbay ${url}`;
  return (
    <div className="stack">
      <div className="set-card-top">
        <Tip label={t('assistants.server.hint')}><H>{t('assistants.server.title')}</H></Tip>
      </div>
      <div className="asst-addr">
        <pre className="set-secret" data-testid="mcp-url">{url}</pre>
        <CopyButton text={url} />
      </div>
      <div className="asst-sub">
        <span className="set-legend">{t('assistants.server.code')}</span>
        <div className="asst-addr">
          <pre className="set-secret">{command}</pre>
          <CopyButton text={command} />
        </div>
      </div>
    </div>
  );
}

const ListSkeleton = () => (
  <div className="stack" style={{ marginTop: 8 }}>
    {[0, 1].map((i) => <Skeleton key={i} height={32} />)}
  </div>
);

/** Settings → Assistants (MCP), for the brand's admins. */
export function AssistantsSettings({ brandId }: { brandId: string }) {
  const qc = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();
  const { data, error } = useQuery({
    queryKey: ['assistants', brandId],
    queryFn: () => api.get<{ server_url: string; settings: { allow_approval: boolean }; connections: BrandConnection[] }>(`/api/brands/${brandId}/assistants`),
  });
  const refresh = () => qc.invalidateQueries({ queryKey: ['assistants', brandId] });
  const toggle = useMutation({
    mutationFn: (on: boolean) => api.patch(`/api/brands/${brandId}`, { mcp: { allow_approval: on } }),
    onSuccess: (_r, on) => { refresh(); qc.invalidateQueries({ queryKey: ['brand', brandId] }); toast(on ? t('assistants.approve.on') : t('assistants.approve.off')); },
    onError: (e) => toast(errorMessage(e), 'error'),
  });
  const disconnect = useMutation({
    mutationFn: (id: string) => api.del(`/api/brands/${brandId}/assistants/${id}`),
    onSuccess: () => { refresh(); toast(t('assistants.disconnect.done')); },
    onError: (e) => toast(errorMessage(e), 'error'),
  });

  if (error) return <ErrorBox error={error} />;
  const on = toggle.isPending ? !!toggle.variables : !!data?.settings.allow_approval;
  return (
    <>
      <section className="card">{data ? <ServerAddress url={data.server_url} /> : <Skeleton height={80} />}</section>

      <section className="card stack" aria-label={t('assistants.approve.title')}>
        <h3>{t('assistants.approve.title')}</h3>
        <Switch label={t('assistants.approve.label')} hint={t('assistants.approve.hint')} checked={on} disabled={!data || toggle.isPending} onChange={(v) => toggle.mutate(v)} />
      </section>

      <section className="card set-card" aria-labelledby="asst-connections">
        <header className="set-card-top">
          <h3 id="asst-connections">{t('assistants.connections.title')}</h3>
          {data && data.connections.length > 0 && <span className="muted small">{data.connections.length}</span>}
        </header>
        {!data && <ListSkeleton />}
        {data?.connections.length === 0 && <p className="set-empty">{t('assistants.connections.empty')}</p>}
        {data && data.connections.length > 0 && (
          <ul className="ent-list">
            {data.connections.map((c) => {
              const person = displayName(c.user_name, c.user_email);
              return (
                <li key={c.id} className="ent">
                  <Avatar name={c.user_name || c.user_email} size={32} />
                  <div className="ent-main">
                    <div className="ent-title">
                      <Tipped label={c.user_email}><span>{person}</span></Tipped>
                      <span className="muted" style={{ fontWeight: 400 }}>· {c.client_name}</span>
                    </div>
                    <div className="ent-sub">
                      {t('assistants.connections.since', { when: fmtShort(c.connected_at) })}
                      {c.last_used_at && <> · {t('assistants.connections.used', { when: fmtShort(c.last_used_at) })}</>}
                      {c.redirect_host && <> · {t('assistants.connections.answersTo', { host: c.redirect_host })}</>}
                      {c.other_brands > 0 && <> · {t('assistants.connections.otherBrands', { count: c.other_brands })}</>}
                    </div>
                  </div>
                  <div className="ent-side">
                    <MoreMenu
                      label={t('assistants.actionsOf', { name: `${person} · ${c.client_name}` })}
                      items={[{
                        label: t('assistants.disconnect'), icon: 'ban', danger: true,
                        onSelect: async () => {
                          if (await confirm({
                            title: t('assistants.disconnect.title', { client: c.client_name, person }),
                            text: t('assistants.disconnect.text', { client: c.client_name, person }),
                            confirmLabel: t('assistants.disconnect'), danger: true,
                          })) disconnect.mutate(c.id);
                        },
                      }]}
                    />
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </>
  );
}

/** Your account → Assistants: the person's own connections, which they can cut at once. */
export function MyAssistants() {
  const qc = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();
  const { me } = useSession();
  const { data, error } = useQuery({
    queryKey: ['my-assistants', me.user.id],
    queryFn: () => api.get<{ server_url: string; connections: MyConnection[] }>('/api/me/assistants'),
  });
  const disconnect = useMutation({
    mutationFn: (id: string) => api.del(`/api/me/assistants/${id}`),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['my-assistants'] }); qc.invalidateQueries({ queryKey: ['assistants'] }); toast(t('assistants.disconnect.done')); },
    onError: (e) => toast(errorMessage(e), 'error'),
  });
  return (
    <section className="card stack acct-full" aria-labelledby="acct-assistants">
      <div className="set-card-top">
        <Tip label={t('assistants.mine.hint')}><h2 id="acct-assistants">{t('assistants.mine.title')}</h2></Tip>
      </div>
      {error && <ErrorBox error={error} />}
      {!data && !error && <ListSkeleton />}
      {data && (
        <>
          {data.connections.length === 0 ? (
            <p className="set-empty">{t('assistants.mine.empty')}</p>
          ) : (
            <ul className="ent-list" style={{ marginTop: 0 }}>
              {data.connections.map((c) => (
                <li key={c.id} className="ent">
                  <span className="asst-icon" aria-hidden="true"><Icon name="bolt" /></span>
                  <div className="ent-main">
                    <div className="ent-title">{c.client_name}</div>
                    <div className="ent-sub">
                      {c.brands.length ? t('assistants.mine.in', { brands: c.brands.map((b) => b.name).join(', ') }) : t('assistants.mine.noBrands')}
                      {' · '}{t('assistants.connections.since', { when: fmtShort(c.connected_at) })}
                      {c.last_used_at && <> · {t('assistants.connections.used', { when: fmtShort(c.last_used_at) })}</>}
                      {c.redirect_host && <> · {t('assistants.connections.answersTo', { host: c.redirect_host })}</>}
                    </div>
                  </div>
                  <div className="ent-side">
                    <button
                      type="button"
                      className="btn btn-small btn-ghost"
                      disabled={disconnect.isPending}
                      onClick={async () => {
                        if (await confirm({
                          title: t('assistants.mine.disconnectTitle', { client: c.client_name }),
                          text: t('assistants.mine.disconnectText', { client: c.client_name }),
                          confirmLabel: t('assistants.disconnect'), danger: true,
                        })) disconnect.mutate(c.id);
                      }}
                    >
                      {t('assistants.disconnect')}
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
          <ServerAddress url={data.server_url} />
        </>
      )}
    </section>
  );
}
