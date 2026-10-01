import { call, redact } from '../http.js';
import { ConnectorError, type Candidate, type OAuthProvider } from '../types.js';
import { classifyMeta, type MetaConfig } from './client.js';

/**
 * Everything publishing needs on a Page and its Instagram account. Insights, comment replies and messages (phase 4)
 * will need more, and asking for them then is better than asking for them now: a brand only grants what is in use.
 */
export const META_SCOPES = [
  'pages_show_list',
  'pages_read_engagement',
  'pages_manage_posts',
  'instagram_basic',
  'instagram_content_publish',
  'instagram_manage_comments',
  'business_management',
];

export function createMetaOAuth(cfg: MetaConfig): OAuthProvider {
  const graph = (path: string) => `${cfg.graphUrl}/${cfg.version}/${path}`;

  return {
    id: 'meta',
    label: 'Facebook and Instagram',
    networks: ['facebook', 'instagram'],

    authorizeUrl(state, redirectUri) {
      const u = new URL(`${cfg.oauthUrl}/${cfg.version}/dialog/oauth`);
      u.searchParams.set('client_id', cfg.appId);
      u.searchParams.set('redirect_uri', redirectUri);
      u.searchParams.set('state', state);
      u.searchParams.set('response_type', 'code');
      u.searchParams.set('scope', META_SCOPES.join(','));
      return u.toString();
    },

    async exchange(code, redirectUri) {
      const ok = (r: Awaited<ReturnType<typeof call>>) => {
        const err = classifyMeta(r);
        if (err) throw err;
        return r.body;
      };

      // 1. The code becomes a short-lived user token, and that becomes a long-lived one (about 60 days).
      const short = ok(await call(graph('oauth/access_token'), {
        query: { client_id: cfg.appId, client_secret: cfg.appSecret, redirect_uri: redirectUri, code },
      }));
      const long = ok(await call(graph('oauth/access_token'), {
        query: { grant_type: 'fb_exchange_token', client_id: cfg.appId, client_secret: cfg.appSecret, fb_exchange_token: short.access_token },
      }));
      const userToken: string = long.access_token;

      // 2. What the person actually granted, and when Meta's data access for it lapses (they must sign in again by then).
      let granted: string[] = [];
      let dataAccessExpiresAt: string | undefined;
      try {
        const dbg = ok(await call(graph('debug_token'), { query: { input_token: userToken, access_token: `${cfg.appId}|${cfg.appSecret}` } }));
        granted = dbg.data?.scopes ?? [];
        if (dbg.data?.data_access_expires_at) dataAccessExpiresAt = new Date(dbg.data.data_access_expires_at * 1000).toISOString();
      } catch {
        // Not fatal: the accounts are still usable, we just cannot tell what was granted.
      }

      // 3. The Pages this person manages. A Page token taken with a long-lived user token does not expire.
      const out: Candidate[] = [];
      let next: string | undefined = `${graph('me/accounts')}?${new URLSearchParams({
        fields: 'id,name,access_token,tasks,instagram_business_account{id,username,name}',
        limit: '100',
        access_token: userToken,
      })}`;
      for (let page = 0; next && page < 10; page++) {
        const body = ok(await call(next));
        for (const p of body.data ?? []) {
          if (!p.access_token) continue; // no publishing rights on this Page
          const missing = ['pages_manage_posts', 'pages_read_engagement'].filter((s) => granted.length && !granted.includes(s));
          out.push({
            key: `facebook:${p.id}`,
            network: 'facebook',
            externalId: p.id,
            displayName: p.name,
            token: { accessToken: p.access_token, scopes: granted },
            providerData: { pageId: p.id, tasks: p.tasks ?? [], dataAccessExpiresAt, missingScopes: missing },
          });
          const ig = p.instagram_business_account;
          if (ig?.id) {
            const missingIg = ['instagram_content_publish', 'instagram_basic'].filter((s) => granted.length && !granted.includes(s));
            out.push({
              key: `instagram:${ig.id}`,
              network: 'instagram',
              externalId: ig.id,
              displayName: ig.username ? `@${ig.username}` : (ig.name ?? ig.id),
              token: { accessToken: p.access_token, scopes: granted },
              providerData: { pageId: p.id, igUserId: ig.id, username: ig.username, dataAccessExpiresAt, missingScopes: missingIg },
            });
          }
        }
        next = body.paging?.next;
      }
      if (out.length === 0) {
        throw new ConnectorError('auth', 'Meta did not share any Page this person can publish for. Check that they have a role on the Page and tick it in the permission dialog.', { detail: redact({ granted }) });
      }
      return out;
    },
  };
}
