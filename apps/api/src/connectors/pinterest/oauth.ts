import { ConnectorError, type Candidate, type OAuthProvider, type TokenSet } from '../types.js';
import type { PinterestClient } from './client.js';

/** Reading boards and the account, and creating pins. */
export const PINTEREST_SCOPES = ['boards:read', 'pins:read', 'pins:write', 'user_accounts:read'];

const DAY = 86_400_000;

export function createPinterestOAuth(client: PinterestClient, now: () => Date = () => new Date()): OAuthProvider {
  const cfg = client.cfg;
  const toToken = (b: { access_token: string; refresh_token?: string; expires_in?: number; scope?: string }, previous?: TokenSet): TokenSet => ({
    accessToken: b.access_token,
    refreshToken: b.refresh_token ?? previous?.refreshToken,
    expiresAt: b.expires_in ? new Date(now().getTime() + b.expires_in * 1000).toISOString() : undefined,
    scopes: b.scope ? b.scope.split(/[ ,]/) : previous?.scopes,
  });

  return {
    id: 'pinterest',
    label: 'Pinterest',
    networks: ['pinterest'],
    // An access token lasts 30 days and is renewed three days ahead.
    refreshWindowSec: 3 * 86_400,

    authorizeUrl(state, redirectUri) {
      const u = new URL(cfg.oauthUrl);
      u.searchParams.set('client_id', cfg.appId);
      u.searchParams.set('redirect_uri', redirectUri);
      u.searchParams.set('response_type', 'code');
      u.searchParams.set('scope', PINTEREST_SCOPES.join(','));
      u.searchParams.set('state', state);
      return u.toString();
    },

    async exchange(code, redirectUri) {
      const t = toToken(await client.token({ grant_type: 'authorization_code', code, redirect_uri: redirectUri }));
      const me = await client.request<{ username?: string }>('/v5/user_account', t.accessToken);
      // A pin is made on a board, so a board is the account: the person chooses the ones this brand pins to.
      const out: Candidate[] = [];
      let bookmark: string | undefined;
      for (let page = 0; page < 10; page++) {
        const r = await client.request<{ items?: { id: string; name: string; privacy?: string }[]; bookmark?: string | null }>('/v5/boards', t.accessToken, {
          query: { page_size: 100, ...(bookmark ? { bookmark } : {}) },
        });
        for (const b of r.items ?? []) {
          out.push({
            key: `pinterest:${b.id}`, network: 'pinterest', externalId: b.id, displayName: `${me.username ?? 'Pinterest'} · ${b.name}`, token: t,
            // Until Pinterest approves the app for Standard access, pins are visible only to whoever made them.
            providerData: { boardId: b.id, username: me.username, audited: false },
          });
        }
        bookmark = r.bookmark ?? undefined;
        if (!bookmark) break;
      }
      if (out.length === 0) throw new ConnectorError('auth', 'This Pinterest account has no board to pin to. Make a board on Pinterest first, then connect again.');
      return out;
    },

    async refresh(previous) {
      if (!previous.refreshToken) throw new ConnectorError('auth', 'There is no renewal token for this connection: connect it again');
      const b = await client.token({ grant_type: 'refresh_token', refresh_token: previous.refreshToken }).catch((err) => {
        if (err instanceof ConnectorError && err.errorClass === 'auth' && previous.expiresAt && new Date(previous.expiresAt).getTime() - now().getTime() > DAY) return null;
        throw err;
      });
      return b ? toToken(b, previous) : previous;
    },
  };
}
