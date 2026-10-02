import { english, msg } from '../../i18n/index.js';
import { ConnectorError, type OAuthProvider, type TokenSet } from '../types.js';
import type { TikTokClient } from './client.js';

/**
 * Reading the account, posting directly, and reading how posts did. "video.upload" is asked for with "video.publish" because
 * a person who is sent to TikTok to sign in is shown both.
 *
 * user.info.basic gives open_id, union_id, avatar_url and display_name, and nothing else: a field outside it (username needs
 * user.info.profile) makes TikTok refuse the whole call with scope_not_authorized. The @username comes from creator_info, which
 * video.publish allows, and only to make links.
 */
export const TIKTOK_SCOPES = ['user.info.basic', 'video.publish', 'video.upload', 'video.list'];
export const TIKTOK_USER_FIELDS = 'open_id,union_id,avatar_url,display_name';

export function createTikTokOAuth(client: TikTokClient, now: () => Date = () => new Date()): OAuthProvider {
  const cfg = client.cfg;
  const toToken = (b: { access_token: string; refresh_token?: string; expires_in?: number; scope?: string }, previous?: TokenSet): TokenSet => ({
    accessToken: b.access_token,
    // The renewal token can change at each renewal: the new one is the one to keep.
    refreshToken: b.refresh_token ?? previous?.refreshToken,
    expiresAt: b.expires_in ? new Date(now().getTime() + b.expires_in * 1000).toISOString() : undefined,
    scopes: b.scope ? b.scope.split(',') : previous?.scopes,
  });

  return {
    id: 'tiktok',
    label: 'TikTok',
    networks: ['tiktok'],
    // The access token lasts a day: renewed an hour ahead.
    refreshWindowSec: 3600,

    authorizeUrl(state, redirectUri) {
      const u = new URL(cfg.oauthUrl);
      u.searchParams.set('client_key', cfg.clientKey);
      u.searchParams.set('scope', TIKTOK_SCOPES.join(','));
      u.searchParams.set('response_type', 'code');
      u.searchParams.set('redirect_uri', redirectUri);
      u.searchParams.set('state', state);
      return u.toString();
    },

    async exchange(code, redirectUri) {
      const b = await client.token({ grant_type: 'authorization_code', code, redirect_uri: redirectUri });
      const t = toToken(b);
      const me = await client.request<{ data?: { user?: { open_id?: string; union_id?: string; display_name?: string } } }>('/v2/user/info/', t.accessToken, { query: { fields: TIKTOK_USER_FIELDS } });
      const user = me.data?.user;
      const id = user?.open_id ?? b.open_id;
      if (!id) throw new ConnectorError('auth', english(msg('connect.tiktok.noAccount')), { text: msg('connect.tiktok.noAccount') });
      // The @username, for links to the profile and its posts. Best effort: an account is usable without it.
      let username: string | undefined;
      try {
        const info = await client.request<{ data?: { creator_username?: string } }>('/v2/post/publish/creator_info/query/', t.accessToken, { method: 'POST', json: {} });
        username = info.data?.creator_username || undefined;
      } catch {
        username = undefined;
      }
      return [{
        key: `tiktok:${id}`,
        network: 'tiktok',
        externalId: id,
        displayName: username ? `@${username}` : (user?.display_name ?? id),
        token: t,
        // Until TikTok audits the app every post is forced to private (see the TikTok connector).
        providerData: { username, displayName: user?.display_name, audited: false },
      }];
    },

    async refresh(previous) {
      if (!previous.refreshToken) throw new ConnectorError('auth', english(msg('connect.noRenewalToken')), { text: msg('connect.noRenewalToken') });
      return toToken(await client.token({ grant_type: 'refresh_token', refresh_token: previous.refreshToken }), previous);
    },
  };
}
