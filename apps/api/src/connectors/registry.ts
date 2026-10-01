import type { Config } from '../config.js';
import { createFacebook } from './meta/facebook.js';
import { createInstagram } from './meta/instagram.js';
import { MetaClient, type MetaConfig } from './meta/client.js';
import { createMetaOAuth } from './meta/oauth.js';
import { GoogleClient, type GoogleConfig } from './google/client.js';
import { createGoogleOAuth } from './google/oauth.js';
import { createYouTube } from './google/youtube.js';
import type { Connector, ConnectorSet, Network, OAuthProvider, ProviderId } from './types.js';

/**
 * The connectors this deployment has credentials for. A network whose provider is not configured has no connector,
 * so accounts on it stay manual (a person publishes them) exactly as in phase 1.
 */
export function createConnectorSet(config: Config, now: () => Date = () => new Date()): ConnectorSet {
  const connectors = new Map<Network, Connector>();
  const providers = new Map<ProviderId, OAuthProvider>();

  if (config.metaEnabled) {
    const cfg: MetaConfig = {
      graphUrl: config.META_GRAPH_URL, oauthUrl: config.META_OAUTH_URL, version: config.META_GRAPH_VERSION,
      appId: config.META_APP_ID!, appSecret: config.META_APP_SECRET!,
    };
    const client = new MetaClient(cfg);
    providers.set('meta', createMetaOAuth(cfg));
    connectors.set('instagram', createInstagram(client));
    connectors.set('facebook', createFacebook(client));
  }
  if (config.googleEnabled) {
    const cfg: GoogleConfig = {
      clientId: config.GOOGLE_CLIENT_ID!, clientSecret: config.GOOGLE_CLIENT_SECRET!, oauthUrl: config.GOOGLE_OAUTH_URL,
      tokenUrl: config.GOOGLE_TOKEN_URL, apiUrl: config.YOUTUBE_API_URL,
    };
    const client = new GoogleClient(cfg);
    providers.set('google', createGoogleOAuth(cfg, now));
    connectors.set('youtube', createYouTube(client, (path) => `${cfg.apiUrl}${path}`));
  }

  return {
    connector: (n) => connectors.get(n) ?? null,
    provider: (id) => providers.get(id) ?? null,
    providerOf: (n) => connectors.get(n) ? (providers.get(connectors.get(n)!.provider) ?? null) : null,
    networks: () => [...connectors.keys()],
  };
}

/** Capabilities of every network the app knows how to publish to, whether or not it is configured here: the editor needs them. */
export function allCapabilities(config: Config) {
  const set = createConnectorSet({ ...config, metaEnabled: true, googleEnabled: true, META_APP_ID: 'x', META_APP_SECRET: 'x', GOOGLE_CLIENT_ID: 'x', GOOGLE_CLIENT_SECRET: 'x' });
  return Object.fromEntries(set.networks().map((n) => [n, set.connector(n)!.capabilities()]));
}
