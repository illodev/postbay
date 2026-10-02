import { call } from '../http.js';
import { ConnectorError, type Candidate, type OAuthProvider, type TokenSet } from '../types.js';
import { classifyGoogle, type GoogleConfig } from './client.js';

/**
 * Uploading videos, reading the channel and the state of what was uploaded, and removing a held video when its post is
 * cancelled or replaced (deleting needs youtube.force-ssl, which also covers reading).
 */
export const GOOGLE_SCOPES = [
  'https://www.googleapis.com/auth/youtube.upload',
  'https://www.googleapis.com/auth/youtube.force-ssl',
];

/** Read-only access to YouTube Analytics: watch time and subscribers gained. Asked for only when the deployment turns it on (GOOGLE_ANALYTICS). */
export const ANALYTICS_SCOPE = 'https://www.googleapis.com/auth/yt-analytics.readonly';

function toTokenSet(body: { access_token: string; refresh_token?: string; expires_in?: number; scope?: string }, now: Date, previous?: TokenSet): TokenSet {
  return {
    accessToken: body.access_token,
    refreshToken: body.refresh_token ?? previous?.refreshToken,
    expiresAt: body.expires_in ? new Date(now.getTime() + body.expires_in * 1000).toISOString() : undefined,
    scopes: body.scope ? body.scope.split(' ') : previous?.scopes,
  };
}

export function createGoogleOAuth(cfg: GoogleConfig, now: () => Date = () => new Date()): OAuthProvider {
  async function token(form: Record<string, string>): Promise<any> {
    const r = await call(cfg.tokenUrl, { method: 'POST', form: { client_id: cfg.clientId, client_secret: cfg.clientSecret, ...form } });
    const err = classifyGoogle(r);
    if (err) throw err;
    return r.body;
  }

  return {
    id: 'google',
    label: 'YouTube',
    networks: ['youtube'],

    authorizeUrl(state, redirectUri) {
      const u = new URL(cfg.oauthUrl);
      u.searchParams.set('client_id', cfg.clientId);
      u.searchParams.set('redirect_uri', redirectUri);
      u.searchParams.set('response_type', 'code');
      u.searchParams.set('scope', [...GOOGLE_SCOPES, ...(cfg.analytics ? [ANALYTICS_SCOPE] : [])].join(' '));
      u.searchParams.set('state', state);
      // Offline access and a forced consent screen: the refresh token only comes back when the person is asked again.
      u.searchParams.set('access_type', 'offline');
      u.searchParams.set('prompt', 'consent');
      u.searchParams.set('include_granted_scopes', 'true');
      return u.toString();
    },

    async exchange(code, redirectUri) {
      const t = await token({ grant_type: 'authorization_code', code, redirect_uri: redirectUri });
      if (!t.refresh_token) {
        throw new ConnectorError('auth', 'Google did not return a refresh token, so the connection would stop working within an hour. Remove this app from the Google account\'s third-party access and connect again.');
      }
      const tokens = toTokenSet(t, now());
      const r = await call(`${cfg.apiUrl}/youtube/v3/channels`, {
        query: { part: 'id,snippet', mine: true },
        headers: { authorization: `Bearer ${tokens.accessToken}` },
      });
      const err = classifyGoogle(r);
      if (err) throw err;
      const channels: { id: string; snippet?: { title?: string } }[] = r.body?.items ?? [];
      if (channels.length === 0) {
        throw new ConnectorError('auth', 'This Google account has no YouTube channel. Create one on YouTube first, then connect again.');
      }
      return channels.map<Candidate>((c) => ({
        key: `youtube:${c.id}`,
        network: 'youtube',
        externalId: c.id,
        displayName: c.snippet?.title ?? c.id,
        token: tokens,
        // Until Google's compliance audit passes, every upload is forced private (see the YouTube connector).
        providerData: { channelId: c.id, audited: false },
      }));
    },

    async refresh(previous) {
      if (!previous.refreshToken) throw new ConnectorError('auth', 'There is no refresh token for this connection: connect it again');
      const t = await token({ grant_type: 'refresh_token', refresh_token: previous.refreshToken });
      return toTokenSet(t, now(), previous);
    },
  };
}
