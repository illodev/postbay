import type { Config } from '../config.js';
import { createFacebook } from './meta/facebook.js';
import { createInstagram } from './meta/instagram.js';
import { MetaClient, type MetaConfig } from './meta/client.js';
import { createMetaOAuth } from './meta/oauth.js';
import { GoogleClient, type GoogleConfig } from './google/client.js';
import { createGoogleOAuth } from './google/oauth.js';
import { createYouTube } from './google/youtube.js';
import { BlueskyClient } from './bluesky/client.js';
import { createBluesky } from './bluesky/bluesky.js';
import { createBlueskyOAuth } from './bluesky/oauth.js';
import { LinkedInClient } from './linkedin/client.js';
import { createLinkedInOAuth } from './linkedin/oauth.js';
import { createLinkedIn } from './linkedin/linkedin.js';
import { PinterestClient } from './pinterest/client.js';
import { createPinterestOAuth } from './pinterest/oauth.js';
import { createPinterest } from './pinterest/pinterest.js';
import { TikTokClient } from './tiktok/client.js';
import { createTikTokOAuth } from './tiktok/oauth.js';
import { createTikTok } from './tiktok/tiktok.js';
import { XClient } from './x/client.js';
import { createXOAuth } from './x/oauth.js';
import { createX } from './x/x.js';
import { ThreadsClient } from './threads/client.js';
import { createThreadsOAuth } from './threads/oauth.js';
import { createThreads } from './threads/threads.js';
import type { Connector, ConnectorSet, Network, OAuthProvider, ProviderId } from './types.js';

/**
 * The connectors this deployment has credentials for. A network whose provider is not configured has no connector,
 * so accounts on it stay manual (a person publishes them) exactly as in phase 1.
 */
export function createConnectorSet(config: Config, now: () => Date = () => new Date()): ConnectorSet {
  const connectors = new Map<Network, Connector>();
  const providers = new Map<ProviderId, OAuthProvider>();

  if (config.metaEnabled) {
    // META_LOGIN_CONFIG_ID(_PRIZES) are read from the environment until config.ts declares them (they are optional there).
    const extra = config as Config & { META_LOGIN_CONFIG_ID?: string; META_LOGIN_CONFIG_ID_PRIZES?: string };
    const cfg: MetaConfig = {
      graphUrl: config.META_GRAPH_URL, oauthUrl: config.META_OAUTH_URL, version: config.META_GRAPH_VERSION,
      appId: config.META_APP_ID!, appSecret: config.META_APP_SECRET!,
      loginConfigId: extra.META_LOGIN_CONFIG_ID ?? process.env.META_LOGIN_CONFIG_ID ?? undefined,
      loginConfigIdPrizes: extra.META_LOGIN_CONFIG_ID_PRIZES ?? process.env.META_LOGIN_CONFIG_ID_PRIZES ?? undefined,
    };
    const client = new MetaClient(cfg);
    providers.set('meta', createMetaOAuth(cfg));
    connectors.set('instagram', createInstagram(client));
    connectors.set('facebook', createFacebook(client));
  }
  if (config.googleEnabled) {
    const cfg: GoogleConfig = {
      clientId: config.GOOGLE_CLIENT_ID!, clientSecret: config.GOOGLE_CLIENT_SECRET!, oauthUrl: config.GOOGLE_OAUTH_URL,
      tokenUrl: config.GOOGLE_TOKEN_URL, apiUrl: config.YOUTUBE_API_URL, analyticsUrl: config.YOUTUBE_ANALYTICS_URL, analytics: config.GOOGLE_ANALYTICS,
    };
    const client = new GoogleClient(cfg);
    providers.set('google', createGoogleOAuth(cfg, now));
    connectors.set('youtube', createYouTube(client, (path) => `${cfg.apiUrl}${path}`));
  }

  if (config.enabled.threads) {
    const client = new ThreadsClient({ appId: config.THREADS_APP_ID!, appSecret: config.THREADS_APP_SECRET!, oauthUrl: config.THREADS_OAUTH_URL, graphUrl: config.THREADS_GRAPH_URL });
    providers.set('threads', createThreadsOAuth(client, now));
    connectors.set('threads', createThreads(client));
  }

  if (config.enabled.linkedin) {
    const client = new LinkedInClient({
      clientId: config.LINKEDIN_CLIENT_ID!, clientSecret: config.LINKEDIN_CLIENT_SECRET!, oauthUrl: config.LINKEDIN_OAUTH_URL,
      tokenUrl: config.LINKEDIN_TOKEN_URL, apiUrl: config.LINKEDIN_API_URL, version: config.LINKEDIN_VERSION,
    });
    providers.set('linkedin', createLinkedInOAuth(client, now));
    connectors.set('linkedin', createLinkedIn(client));
  }
  if (config.enabled.pinterest) {
    const client = new PinterestClient({ appId: config.PINTEREST_APP_ID!, appSecret: config.PINTEREST_APP_SECRET!, oauthUrl: config.PINTEREST_OAUTH_URL, apiUrl: config.PINTEREST_API_URL });
    providers.set('pinterest', createPinterestOAuth(client, now));
    connectors.set('pinterest', createPinterest(client));
  }
  if (config.enabled.tiktok) {
    const client = new TikTokClient({ clientKey: config.TIKTOK_CLIENT_KEY!, clientSecret: config.TIKTOK_CLIENT_SECRET!, oauthUrl: config.TIKTOK_OAUTH_URL, apiUrl: config.TIKTOK_API_URL });
    providers.set('tiktok', createTikTokOAuth(client, now));
    connectors.set('tiktok', createTikTok(client));
  }
  if (config.enabled.x) {
    const client = new XClient({ clientId: config.X_CLIENT_ID!, clientSecret: config.X_CLIENT_SECRET!, oauthUrl: config.X_OAUTH_URL, apiUrl: config.X_API_URL });
    providers.set('x', createXOAuth(client, config.SECRET, now));
    connectors.set('x', createX(client));
  }
  if (config.enabled.bluesky) {
    // A server a person types is held to the webhooks' rules: https, no redirects, and no private address unless those are allowed.
    const client = new BlueskyClient({ pdsUrl: config.BLUESKY_PDS_URL, videoUrl: config.BLUESKY_VIDEO_URL, policy: { allowPrivate: config.webhookAllowPrivate, httpsForPublic: true } });
    providers.set('bluesky', createBlueskyOAuth(client));
    connectors.set('bluesky', createBluesky(client));
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
  const set = createConnectorSet({
    ...config, metaEnabled: true, googleEnabled: true, META_APP_ID: 'x', META_APP_SECRET: 'x', GOOGLE_CLIENT_ID: 'x', GOOGLE_CLIENT_SECRET: 'x',
    THREADS_APP_ID: 'x', THREADS_APP_SECRET: 'x', X_CLIENT_ID: 'x', X_CLIENT_SECRET: 'x', LINKEDIN_CLIENT_ID: 'x', LINKEDIN_CLIENT_SECRET: 'x', PINTEREST_APP_ID: 'x', PINTEREST_APP_SECRET: 'x', TIKTOK_CLIENT_KEY: 'x', TIKTOK_CLIENT_SECRET: 'x',
    enabled: { meta: true, google: true, threads: true, tiktok: true, linkedin: true, x: true, pinterest: true, bluesky: true },
  });
  return Object.fromEntries(set.networks().map((n) => [n, set.connector(n)!.capabilities()]));
}
