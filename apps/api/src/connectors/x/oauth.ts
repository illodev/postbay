import { createHash, createHmac } from 'node:crypto';
import type { OAuthProvider, TokenSet } from '../types.js';
import type { XClient } from './client.js';

/**
 * Posting, reading the account and one's own posts, renewing the session (offline.access) and uploading media.
 * X signs in with OAuth 2.0 and PKCE: the browser carries a challenge, and the matching secret (the "verifier") is needed
 * to finish. It is not stored: it is made from the sign-in's state with the server's secret, so only this server can
 * make it again when the person comes back.
 */
export const X_SCOPES = ['tweet.read', 'tweet.write', 'users.read', 'offline.access', 'media.write'];

export const verifierFor = (secret: string, state: string) => createHmac('sha256', secret).update(`x-pkce:${state}`).digest('base64url');
const challengeFor = (verifier: string) => createHash('sha256').update(verifier).digest('base64url');

export function createXOAuth(client: XClient, pkceSecret: string, now: () => Date = () => new Date()): OAuthProvider {
  const cfg = client.cfg;
  const toToken = (b: { access_token: string; refresh_token?: string; expires_in?: number; scope?: string }, previous?: TokenSet): TokenSet => ({
    accessToken: b.access_token,
    // X rotates the renewal token: the new one is kept, the old one stops working.
    refreshToken: b.refresh_token ?? previous?.refreshToken,
    expiresAt: b.expires_in ? new Date(now().getTime() + b.expires_in * 1000).toISOString() : undefined,
    scopes: b.scope ? b.scope.split(' ') : previous?.scopes,
  });

  return {
    id: 'x',
    label: 'X',
    networks: ['x'],
    // The access token lasts two hours: renewed five minutes ahead.
    refreshWindowSec: 300,

    authorizeUrl(state, redirectUri) {
      const u = new URL(cfg.oauthUrl);
      u.searchParams.set('response_type', 'code');
      u.searchParams.set('client_id', cfg.clientId);
      u.searchParams.set('redirect_uri', redirectUri);
      u.searchParams.set('scope', X_SCOPES.join(' '));
      u.searchParams.set('state', state);
      u.searchParams.set('code_challenge', challengeFor(verifierFor(pkceSecret, state)));
      u.searchParams.set('code_challenge_method', 'S256');
      return u.toString();
    },

    async exchange(code, redirectUri, state = '') {
      const b = await client.token({ grant_type: 'authorization_code', code, redirect_uri: redirectUri, code_verifier: verifierFor(pkceSecret, state), client_id: cfg.clientId });
      const token = toToken(b);
      const me = await client.request<{ data: { id: string; username: string; name?: string } }>('/2/users/me', token.accessToken, { query: { 'user.fields': 'username,name' } });
      return [{
        key: `x:${me.data.id}`,
        network: 'x',
        externalId: me.data.id,
        displayName: `@${me.data.username}`,
        token,
        providerData: { username: me.data.username },
      }];
    },

    async refresh(previous) {
      const b = await client.token({ grant_type: 'refresh_token', refresh_token: previous.refreshToken ?? '', client_id: cfg.clientId });
      return toToken(b, previous);
    },
  };
}
