import { english, msg } from '../../i18n/index.js';
import { checkUrl } from '../../net.js';
import { ConnectorError, type OAuthProvider, type TokenSet } from '../types.js';
import { jwtExpiry, pdsEndpointOf, type BlueskyClient } from './client.js';

interface Session {
  accessJwt: string;
  refreshJwt: string;
  did: string;
  handle: string;
  emailConfirmed?: boolean;
  didDoc?: unknown;
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

  /**
   * The server a person typed, if any. It is a URL from outside, so only an https address of a server (no path, no credentials, no
   * address on this machine's networks unless the deployment allows those) is taken; the calls to it then follow the same rules.
   */
  const checkedServer = (raw: string | undefined): string => {
    const typed = raw?.trim();
    if (!typed || client.configured(typed)) return serverOf(typed, client.cfg.pdsUrl);
    const policy = client.cfg.policy ?? { allowPrivate: false, httpsForPublic: true };
    const checked = checkUrl(/^[a-z][a-z0-9+.-]*:\/\//i.test(typed) ? typed : `https://${typed}`, policy);
    if ('error' in checked) throw new ConnectorError('auth', english(msg('connect.bluesky.badServer', { error: checked.error })), { text: msg('connect.bluesky.badServer', { error: checked.error }) });
    const u = checked.url;
    if (u.protocol !== 'https:' && !policy.allowPrivate) throw new ConnectorError('auth', english(msg('connect.bluesky.httpsOnly')), { text: msg('connect.bluesky.httpsOnly') });
    if ((u.pathname !== '/' && u.pathname !== '') || u.search || u.hash) throw new ConnectorError('auth', english(msg('connect.bluesky.serverOnly')), { text: msg('connect.bluesky.serverOnly') });
    return u.origin;
  };

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
        const server = checkedServer(values.server);
        const identifier = cleanHandle(values.handle ?? '');
        if (!identifier || !values.appPassword) throw new ConnectorError('auth', english(msg('connect.bluesky.needed')), { text: msg('connect.bluesky.needed') });
        let s: Session;
        try {
          s = await startSession(server, identifier, values.appPassword);
        } catch (err) {
          if (err instanceof ConnectorError && err.errorClass === 'auth') {
            throw new ConnectorError('auth', english(msg('connect.bluesky.refused')), { text: msg('connect.bluesky.refused') });
          }
          throw err;
        }
        return [{
          key: `bluesky:${s.did}`,
          network: 'bluesky',
          externalId: s.did,
          displayName: `@${s.handle}`,
          token: toToken(s, { server, identifier, appPassword: values.appPassword }),
          // Where the repository really lives (bsky.social sends each account to a server of its own): the video service is told it.
          providerData: { handle: s.handle, pds: server, pdsEndpoint: pdsEndpointOf(s.didDoc), emailConfirmed: s.emailConfirmed ?? false },
        }];
      },
    },

    async refresh(previous) {
      const extra = previous.extra ?? {};
      const server = serverOf(extra.server, client.cfg.pdsUrl);
      try {
        if (!previous.refreshToken) throw new ConnectorError('auth', english(msg('connect.bluesky.noSession')), { text: msg('connect.bluesky.noSession') });
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
