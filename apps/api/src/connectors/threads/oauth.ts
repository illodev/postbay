import { ConnectorError, type OAuthProvider, type TokenSet } from '../types.js';
import type { ThreadsClient } from './client.js';

/**
 * Posting, reading how posts did, and replying to one's own post. Threads signs in with its own app and its own token, not the
 * Instagram one: the token lasts 60 days and is renewed with a refresh call (which needs it to be at least a day old).
 */
export const THREADS_SCOPES = ['threads_basic', 'threads_content_publish', 'threads_manage_insights', 'threads_manage_replies'];

const DAY = 86_400_000;

export function createThreadsOAuth(client: ThreadsClient, now: () => Date = () => new Date()): OAuthProvider {
  const cfg = client.cfg;
  const toToken = (b: { access_token: string; expires_in?: number }, scopes?: string[]): TokenSet => ({
    accessToken: b.access_token,
    expiresAt: b.expires_in ? new Date(now().getTime() + b.expires_in * 1000).toISOString() : undefined,
    scopes,
  });

  return {
    id: 'threads',
    label: 'Threads',
    networks: ['threads'],
    // Renewed a week ahead: a 60-day token that was not renewed in time means signing in again.
    refreshWindowSec: 7 * 86_400,

    authorizeUrl(state, redirectUri) {
      const u = new URL(cfg.oauthUrl);
      u.searchParams.set('client_id', cfg.appId);
      u.searchParams.set('redirect_uri', redirectUri);
      u.searchParams.set('scope', THREADS_SCOPES.join(','));
      u.searchParams.set('response_type', 'code');
      u.searchParams.set('state', state);
      return u.toString();
    },

    async exchange(code, redirectUri) {
      const short = await client.oauth<{ access_token: string; user_id: string | number }>('oauth/access_token', {
        method: 'POST',
        form: { client_id: cfg.appId, client_secret: cfg.appSecret, grant_type: 'authorization_code', redirect_uri: redirectUri, code },
      });
      // The short-lived token (an hour) becomes a long-lived one (60 days).
      const long = await client.oauth<{ access_token: string; expires_in: number }>('access_token', {
        query: { grant_type: 'th_exchange_token', client_secret: cfg.appSecret, access_token: short.access_token },
      });
      const token = toToken(long, THREADS_SCOPES);
      const me = await client.get<{ id: string; username?: string; name?: string }>('me', token.accessToken, { fields: 'id,username,name' });
      const id = String(me.id ?? short.user_id);
      return [{
        key: `threads:${id}`,
        network: 'threads',
        externalId: id,
        displayName: me.username ? `@${me.username}` : (me.name ?? id),
        token,
        providerData: { username: me.username },
      }];
    },

    async refresh(previous) {
      const r = await client.oauth<{ access_token: string; expires_in: number }>('refresh_access_token', {
        query: { grant_type: 'th_refresh_token', access_token: previous.accessToken },
      }).catch((err) => {
        // Too early (under a day old) is not a lost connection; anything else the network refuses is.
        if (err instanceof ConnectorError && err.errorClass === 'file_rejected' && previous.expiresAt && new Date(previous.expiresAt).getTime() - now().getTime() > DAY) return null;
        throw err;
      });
      return r ? toToken(r, previous.scopes) : previous;
    },
  };
}
