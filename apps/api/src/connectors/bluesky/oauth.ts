import { ConnectorError, type OAuthProvider, type TokenSet } from '../types.js';
import { jwtExpiry, type BlueskyClient } from './client.js';

interface Session {
  accessJwt: string;
  refreshJwt: string;
  did: string;
  handle: string;
  emailConfirmed?: boolean;
}

const cleanHandle = (s: string) => s.trim().replace(/^@/, '');
const serverOf = (s: string | undefined, fallback: string) => (s?.trim() ? s.trim().replace(/\/$/, '') : fallback);

/**
 * Bluesky has no app to register and no page to sign in on: a person makes an "app password" in their settings and gives it here.
 * It is kept sealed with the session, because when the session cannot be renewed (the renewal token lasts about two months)
 * a new one is started with it, and nobody has to do anything.
 */
export function createBlueskyOAuth(client: BlueskyClient): OAuthProvider {
  const startSession = async (server: string, identifier: string, password: string): Promise<Session> =>
    client.xrpc<Session>(server, 'com.atproto.server.createSession', { json: { identifier, password } });

  const toToken = (s: Session, extra: Record<string, string>): TokenSet => ({
    accessToken: s.accessJwt,
    refreshToken: s.refreshJwt,
    expiresAt: jwtExpiry(s.accessJwt),
    extra,
  });

  return {
    id: 'bluesky',
    label: 'Bluesky',
    networks: ['bluesky'],
    // The session token lasts about two hours; renewed ten minutes ahead.
    refreshWindowSec: 600,

    credentials: {
      fields: [
        { key: 'handle', label: 'Handle', type: 'text', help: 'For example lumen.bsky.social' },
        { key: 'appPassword', label: 'App password', type: 'password', help: 'Made in Bluesky under Settings → Privacy and security → App passwords. Not your account password.' },
        { key: 'server', label: 'Server', type: 'text', required: false, help: 'Only if the account is not on bsky.social' },
      ],
      async connect(values) {
        const server = serverOf(values.server, client.cfg.pdsUrl);
        const identifier = cleanHandle(values.handle ?? '');
        if (!identifier || !values.appPassword) throw new ConnectorError('auth', 'A handle and an app password are needed');
        let s: Session;
        try {
          s = await startSession(server, identifier, values.appPassword);
        } catch (err) {
          if (err instanceof ConnectorError && err.errorClass === 'auth') {
            throw new ConnectorError('auth', 'Bluesky did not accept that handle and app password. Check them, and that the password is an app password.');
          }
          throw err;
        }
        return [{
          key: `bluesky:${s.did}`,
          network: 'bluesky',
          externalId: s.did,
          displayName: `@${s.handle}`,
          token: toToken(s, { server, identifier, appPassword: values.appPassword }),
          providerData: { handle: s.handle, pds: server, emailConfirmed: s.emailConfirmed ?? false },
        }];
      },
    },

    async refresh(previous) {
      const extra = previous.extra ?? {};
      const server = serverOf(extra.server, client.cfg.pdsUrl);
      try {
        if (!previous.refreshToken) throw new ConnectorError('auth', 'There is no session to renew');
        const s = await client.xrpc<Session>(server, 'com.atproto.server.refreshSession', { token: previous.refreshToken, method: 'POST', body: '' });
        return toToken(s, extra);
      } catch (err) {
        // The renewal token is gone or refused: start over with the app password, which is what it is kept for.
        if (!(err instanceof ConnectorError) || !extra.appPassword) throw err;
        if (err.errorClass !== 'auth' && err.errorClass !== 'file_rejected' && err.errorClass !== 'transient') throw err;
        const s = await startSession(server, extra.identifier ?? '', extra.appPassword);
        return toToken(s, extra);
      }
    },
  };
}
