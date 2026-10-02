import { english, msg } from '../../i18n/index.js';
import { ConnectorError, type Candidate, type OAuthProvider, type TokenSet } from '../types.js';
import type { LinkedInClient } from './client.js';

/**
 * Posting as a company page, reading its posts' numbers, and finding which pages the person administers. This is the
 * Community Management API: it needs an app that LinkedIn has approved for it, made for the purpose (an app that already
 * has other products cannot be given it), and a super administrator of the page to verify the app.
 */
export const LINKEDIN_SCOPES = ['w_organization_social', 'r_organization_social', 'rw_organization_admin'];

const DAY = 86_400_000;

export function createLinkedInOAuth(client: LinkedInClient, now: () => Date = () => new Date()): OAuthProvider {
  const cfg = client.cfg;
  const toToken = (b: { access_token: string; refresh_token?: string; expires_in?: number; scope?: string }, previous?: TokenSet): TokenSet => ({
    accessToken: b.access_token,
    refreshToken: b.refresh_token ?? previous?.refreshToken,
    expiresAt: b.expires_in ? new Date(now().getTime() + b.expires_in * 1000).toISOString() : undefined,
    scopes: b.scope ? b.scope.split(/[ ,]/) : previous?.scopes,
  });

  return {
    id: 'linkedin',
    label: 'LinkedIn',
    networks: ['linkedin'],
    // A token lasts 60 days. Where the app may renew it, that happens a week ahead; where it may not, the person is warned a week ahead.
    refreshWindowSec: 7 * 86_400,

    authorizeUrl(state, redirectUri) {
      const u = new URL(cfg.oauthUrl);
      u.searchParams.set('response_type', 'code');
      u.searchParams.set('client_id', cfg.clientId);
      u.searchParams.set('redirect_uri', redirectUri);
      u.searchParams.set('state', state);
      u.searchParams.set('scope', LINKEDIN_SCOPES.join(' '));
      return u.toString();
    },

    async exchange(code, redirectUri) {
      const t = toToken(await client.token({ grant_type: 'authorization_code', code, redirect_uri: redirectUri }));
      const acls = (await client.request('/rest/organizationAcls?q=roleAssignee&role=ADMINISTRATOR&state=APPROVED', t.accessToken)).body;
      const out: Candidate[] = [];
      for (const el of (acls?.elements ?? []) as { organization?: string }[]) {
        const id = /urn:li:organization:(\d+)/.exec(el.organization ?? '')?.[1];
        if (!id) continue;
        let name = `Organization ${id}`;
        let vanity: string | undefined;
        try {
          const o = (await client.request(`/rest/organizations/${id}`, t.accessToken)).body;
          name = o?.localizedName ?? name;
          vanity = o?.vanityName;
        } catch {
          // The page is usable without its name.
        }
        out.push({
          key: `linkedin:${id}`, network: 'linkedin', externalId: id, displayName: name, token: t,
          providerData: { organizationId: id, urn: `urn:li:organization:${id}`, vanityName: vanity },
        });
      }
      if (out.length === 0) {
        throw new ConnectorError('auth', english(msg('connect.linkedin.noPages')), { text: msg('connect.linkedin.noPages') });
      }
      return out;
    },

    async refresh(previous) {
      // Only approved partners are given a renewal token. Without one the token simply runs out, which the daily check
      // warns about a week ahead; until then the one we have still works.
      if (!previous.refreshToken) return previous;
      const b = await client.token({ grant_type: 'refresh_token', refresh_token: previous.refreshToken }).catch((err) => {
        if (err instanceof ConnectorError && err.errorClass === 'auth' && previous.expiresAt && new Date(previous.expiresAt).getTime() - now().getTime() > DAY) return null;
        throw err;
      });
      return b ? toToken(b, previous) : previous;
    },
  };
}
