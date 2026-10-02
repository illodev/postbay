import { call, redact } from '../http.js';
import { ConnectorError, type Candidate, type OAuthProvider } from '../types.js';
import { classifyMeta, type MetaConfig } from './client.js';

/**
 * What publishing and reading the numbers need on a Page and its Instagram account. A brand only grants what is in use:
 * the permissions to message people and to read the comments on a Page's posts are asked for only if the brand has prizes on.
 * pages_manage_engagement is what commenting as the Page (the first comment) needs.
 */
export const META_SCOPES = [
  'pages_show_list',
  'pages_read_engagement',
  'pages_manage_posts',
  'pages_manage_engagement',
  'instagram_basic',
  'instagram_content_publish',
  'instagram_manage_comments',
  'instagram_manage_insights',
  'read_insights',
  'business_management',
];

/**
 * What sending the prize as a private reply, and hearing about the comments, need. These are the permissions Meta reviews the app for.
 * pages_manage_metadata is also what subscribing the app to a Page's webhooks needs (see webhooks.ts).
 */
export const META_PRIZE_SCOPES = ['instagram_manage_messages', 'pages_messaging', 'pages_manage_metadata', 'pages_read_user_content'];

export function createMetaOAuth(cfg: MetaConfig): OAuthProvider {
  const graph = (path: string) => `${cfg.graphUrl}/${cfg.version}/${path}`;

  return {
    id: 'meta',
    label: 'Facebook and Instagram',
    networks: ['facebook', 'instagram'],

    authorizeUrl(state, redirectUri, features) {
      const u = new URL(`${cfg.oauthUrl}/${cfg.version}/dialog/oauth`);
      u.searchParams.set('client_id', cfg.appId);
      u.searchParams.set('redirect_uri', redirectUri);
      u.searchParams.set('state', state);
      u.searchParams.set('response_type', 'code');
      // Facebook Login for Business signs in with a configuration (which holds the permissions and the kind of token); plain
      // Facebook Login with the list of permissions.
      const configId = features?.prizes ? (cfg.loginConfigIdPrizes || cfg.loginConfigId) : cfg.loginConfigId;
      if (configId) u.searchParams.set('config_id', configId);
      else u.searchParams.set('scope', [...META_SCOPES, ...(features?.prizes ? META_PRIZE_SCOPES : [])].join(','));
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
          const missing = ['pages_manage_posts', 'pages_read_engagement', 'pages_manage_engagement'].filter((s) => granted.length && !granted.includes(s));
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
        throw new ConnectorError('auth', `Meta did not share any Page this person can publish for. Check that they have a role on the Page and tick it in the permission dialog${cfg.loginConfigId ? '' : ". If the app uses Facebook Login for Business, set META_LOGIN_CONFIG_ID to its login configuration: without it the dialog may not offer the Pages at all"}.`, { detail: redact({ granted }) });
      }
      return out;
    },
  };
}
