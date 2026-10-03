import { z } from 'zod';

const bool = z
  .enum(['true', 'false', '1', '0', ''])
  .default('false')
  .transform((v) => v === 'true' || v === '1');

/** An empty value (`KEY=` in an env file) means "not set", so the default applies. */
const emptyIsUnset = (v: unknown) => (v === '' ? undefined : v);

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().default(3000),
  HOST: z.string().default('0.0.0.0'),
  DATABASE_URL: z.string().default('postgres://estudio:estudio@localhost:5432/estudio'),
  APP_URL: z.string().default('http://localhost:5173'),
  MEDIA_URL: z.string().default('http://localhost:3000'),
  SECRET: z.string().min(32, 'SECRET must be at least 32 characters'),
  STORAGE_DRIVER: z.enum(['local', 's3']).default('local'),
  STORAGE_LOCAL_DIR: z.string().default('.data/media'),
  // Where the pieces of a resumable upload wait until the whole file has arrived (see services/resumable.ts). Needs room for the largest upload in progress.
  STAGING_DIR: z.string().default('.data/staging'),
  /** How much a brand may have declared in unfinished resumable uploads waiting on that disk, in GB. Past it a new big upload is refused. */
  STAGING_MAX_GB_PER_BRAND: z.preprocess(emptyIsUnset, z.coerce.number().positive('STAGING_MAX_GB_PER_BRAND must be a positive number of GB').default(20)),
  S3_ENDPOINT: z.string().optional(),
  // Address browsers use for signed URLs when it differs from the one the app uses inside its network.
  S3_PUBLIC_ENDPOINT: z.string().optional(),
  S3_REGION: z.string().default('auto'),
  S3_BUCKET: z.string().optional(),
  S3_ACCESS_KEY_ID: z.string().optional(),
  S3_SECRET_ACCESS_KEY: z.string().optional(),
  S3_FORCE_PATH_STYLE: bool,
  SMTP_URL: z.string().optional(),
  MAIL_FROM: z.string().default('Postbay <no-reply@localhost>'),
  AUTH_DEV_LOGIN: bool,
  WEB_DIST: z.string().optional(),
  /** The host Slack incoming webhook addresses are on. Only that host is accepted; this is changed only to point tests at a stand-in. */
  SLACK_HOOK_HOST: z.string().default('hooks.slack.com'),

  // Signing in: the second factor and single sign-on
  /** A second factor (an authenticator app) for admins and approvers. On in production unless set to false; in development it is off unless set to true. */
  SECOND_FACTOR_REQUIRED: z.enum(['true', 'false', '1', '0', '']).optional(),
  /**
   * Whether people can still sign in with an emailed link. Set false when everyone signs in with single sign-on. Default: on, except
   * with OIDC_SECOND_FACTOR=idp, where a link would be a way round the provider's second step.
   */
  EMAIL_LINK_LOGIN: z.enum(['true', 'false', '1', '0', '']).optional(),
  /** Single sign-on with any OpenID Connect provider: Google Workspace (https://accounts.google.com) or Microsoft Entra (https://login.microsoftonline.com/<tenant>/v2.0). */
  OIDC_ISSUER: z.string().optional(),
  OIDC_CLIENT_ID: z.string().optional(),
  OIDC_CLIENT_SECRET: z.string().optional(),
  /** What the button says: "Google Workspace", "Microsoft"… */
  OIDC_LABEL: z.string().default('single sign-on'),
  /** Email domains that may sign in this way, comma separated. Required: a provider that is open to anyone must not be open to everyone. */
  OIDC_ALLOWED_DOMAINS: z.string().optional(),
  /** "app": admins and approvers also give an authenticator code after signing in. "idp": the provider's own second step is trusted (you attest it is enforced there). */
  OIDC_SECOND_FACTOR: z.enum(['app', 'idp']).default('app'),
  /** Accept an email the provider does not say is verified (Microsoft Entra does not send the claim). Only for a single-tenant issuer whose admin controls the addresses. */
  OIDC_TRUST_EMAIL: bool,

  // Connected accounts: Meta (Facebook, Instagram) and Google (YouTube)
  /** Master key for the stored network tokens, 32 bytes in base64: openssl rand -base64 32 */
  TOKEN_KEY: z.string().optional(),
  META_APP_ID: z.string().optional(),
  META_APP_SECRET: z.string().optional(),
  META_GRAPH_VERSION: z.string().default('v23.0'),
  META_GRAPH_URL: z.string().default('https://graph.facebook.com'),
  META_OAUTH_URL: z.string().default('https://www.facebook.com'),
  /**
   * Facebook Login for Business: the id of the login configuration the sign-in dialog uses instead of a list of permissions, and
   * the one for brands with prizes (it adds the messaging permissions; without it the first is used for every brand).
   */
  META_LOGIN_CONFIG_ID: z.preprocess(emptyIsUnset, z.string().optional()),
  META_LOGIN_CONFIG_ID_PRIZES: z.preprocess(emptyIsUnset, z.string().optional()),
  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),
  GOOGLE_OAUTH_URL: z.string().default('https://accounts.google.com/o/oauth2/v2/auth'),
  GOOGLE_TOKEN_URL: z.string().default('https://oauth2.googleapis.com/token'),
  YOUTUBE_API_URL: z.string().default('https://www.googleapis.com'),
  YOUTUBE_ANALYTICS_URL: z.string().default('https://youtubeanalytics.googleapis.com'),
  /** Also ask for the YouTube Analytics permission, so watch time can be read. Google treats it as a sensitive scope: it needs the OAuth app to be verified. */
  GOOGLE_ANALYTICS: z.enum(['true', 'false', '1', '0', '']).default('false').transform((v) => v === 'true' || v === '1'),
  /** How long the files handed to a network by URL stay downloadable. */
  PUBLIC_MEDIA_TTL_SECONDS: z.coerce.number().int().min(300).default(6 * 3600),
  // Workers
  /** Run the queue workers inside the API process. Turn off when a separate worker process runs them. */
  RUN_WORKERS: z.enum(['true', 'false', '1', '0', '']).default('true').transform((v) => v !== 'false' && v !== '0'),
  /** How often the worker looks for publications that need attention. */
  WORKER_SWEEP_SECONDS: z.coerce.number().int().min(1).default(15),
  /** How often notifications are sent by email, Slack and push, in seconds. */
  NOTIFY_SECONDS: z.coerce.number().int().min(1).default(30),
  // Extra origins the browser may load media from or upload to (space separated), e.g. a bucket host.
  MEDIA_ORIGINS: z.string().default(''),
  // Webhooks
  /**
   * Whether webhooks may be sent to addresses on a private network (a runner on the same machine or LAN). Addresses used by
   * cloud metadata services are never allowed. Default: allowed in development, refused in production.
   */
  WEBHOOK_ALLOW_PRIVATE_NETWORKS: z.enum(['true', 'false', '1', '0', '']).optional(),

  // The other networks. Each is on when its credentials are set; Bluesky needs none (a person gives an app password).
  THREADS_APP_ID: z.string().optional(),
  THREADS_APP_SECRET: z.string().optional(),
  THREADS_OAUTH_URL: z.string().default('https://threads.net/oauth/authorize'),
  THREADS_GRAPH_URL: z.string().default('https://graph.threads.net'),
  TIKTOK_CLIENT_KEY: z.string().optional(),
  TIKTOK_CLIENT_SECRET: z.string().optional(),
  TIKTOK_OAUTH_URL: z.string().default('https://www.tiktok.com/v2/auth/authorize/'),
  TIKTOK_API_URL: z.string().default('https://open.tiktokapis.com'),
  LINKEDIN_CLIENT_ID: z.string().optional(),
  LINKEDIN_CLIENT_SECRET: z.string().optional(),
  LINKEDIN_OAUTH_URL: z.string().default('https://www.linkedin.com/oauth/v2/authorization'),
  LINKEDIN_TOKEN_URL: z.string().default('https://www.linkedin.com/oauth/v2/accessToken'),
  LINKEDIN_API_URL: z.string().default('https://api.linkedin.com'),
  /** Every LinkedIn API version lives about a year and goes in a monthly header (YYYYMM): this has to be moved forward by hand. */
  LINKEDIN_VERSION: z.string().regex(/^\d{6}$/, 'LINKEDIN_VERSION is YYYYMM').default('202604'),
  X_CLIENT_ID: z.string().optional(),
  X_CLIENT_SECRET: z.string().optional(),
  X_OAUTH_URL: z.string().default('https://x.com/i/oauth2/authorize'),
  X_API_URL: z.string().default('https://api.x.com'),
  PINTEREST_APP_ID: z.string().optional(),
  PINTEREST_APP_SECRET: z.string().optional(),
  PINTEREST_OAUTH_URL: z.string().default('https://www.pinterest.com/oauth/'),
  PINTEREST_API_URL: z.string().default('https://api.pinterest.com'),
  BLUESKY_PDS_URL: z.string().default('https://bsky.social'),
  BLUESKY_VIDEO_URL: z.string().default('https://video.bsky.app'),

  // Metrics and prizes
  /** Token Meta sends back when the comment webhook is set up in the app dashboard. Without it the webhook endpoint stays closed. */
  META_WEBHOOK_VERIFY_TOKEN: z.string().optional(),
  /** How often the worker looks for metric snapshots that are due. */
  METRICS_SWEEP_SECONDS: z.coerce.number().int().min(1).default(120),
  /** How often the comments of posts with a prize are read, for the networks that do not push them (and while Meta has not reviewed the app). */
  PRIZE_POLL_SECONDS: z.coerce.number().int().min(1).default(180),
  /** How often the people whose retention period ended are deleted. */
  PRIZE_PURGE_SECONDS: z.coerce.number().int().min(1).default(3600),

  /** How often approved versions are put into free slots, for the brands that ask for it (rules.auto_fill_slots). */
  FILL_SLOTS_SECONDS: z.coerce.number().int().min(1).default(300),
});

export type Config = z.infer<typeof schema> & {
  devLogin: boolean;
  isProd: boolean;
  metaEnabled: boolean;
  googleEnabled: boolean;
  /** Which sign-in providers this deployment has credentials for. */
  enabled: Record<'meta' | 'google' | 'threads' | 'tiktok' | 'linkedin' | 'x' | 'pinterest' | 'bluesky', boolean>;
  /** Resolved from WEBHOOK_ALLOW_PRIVATE_NETWORKS and the environment. */
  webhookAllowPrivate: boolean;
  secondFactorRequired: boolean;
  emailLinkLogin: boolean;
  /** Single sign-on, when OIDC_ISSUER and the client are set. */
  sso: null | { issuer: string; clientId: string; clientSecret: string; label: string; allowedDomains: string[]; secondFactor: 'app' | 'idp'; trustEmail: boolean };
};

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const msg = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid configuration: ${msg}`);
  }
  const c = parsed.data;
  const isProd = c.NODE_ENV === 'production';
  if (c.STORAGE_DRIVER === 's3' && !(c.S3_BUCKET && c.S3_ACCESS_KEY_ID && c.S3_SECRET_ACCESS_KEY)) {
    throw new Error('Invalid configuration: STORAGE_DRIVER=s3 requires S3_BUCKET, S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY');
  }
  // Development sign-in never applies in production, even if someone turns it on.
  if (c.TOKEN_KEY && Buffer.from(c.TOKEN_KEY, 'base64').length !== 32) {
    throw new Error('Invalid configuration: TOKEN_KEY must be 32 bytes in base64 (openssl rand -base64 32)');
  }
  const metaEnabled = !!(c.META_APP_ID && c.META_APP_SECRET);
  const googleEnabled = !!(c.GOOGLE_CLIENT_ID && c.GOOGLE_CLIENT_SECRET);
  const enabled = {
    meta: metaEnabled,
    google: googleEnabled,
    threads: !!(c.THREADS_APP_ID && c.THREADS_APP_SECRET),
    tiktok: !!(c.TIKTOK_CLIENT_KEY && c.TIKTOK_CLIENT_SECRET),
    linkedin: !!(c.LINKEDIN_CLIENT_ID && c.LINKEDIN_CLIENT_SECRET),
    x: !!(c.X_CLIENT_ID && c.X_CLIENT_SECRET),
    pinterest: !!(c.PINTEREST_APP_ID && c.PINTEREST_APP_SECRET),
    // No developer app to register: a person gives an app password. It still needs the key that seals it.
    bluesky: !!c.TOKEN_KEY,
  };
  const anyCredentials = Object.entries(enabled).some(([k, v]) => v && k !== 'bluesky');
  if (anyCredentials && !c.TOKEN_KEY) {
    throw new Error('Invalid configuration: connecting accounts needs TOKEN_KEY, the key that seals their tokens');
  }
  if (c.META_WEBHOOK_VERIFY_TOKEN && !metaEnabled) {
    throw new Error('Invalid configuration: META_WEBHOOK_VERIFY_TOKEN needs META_APP_ID and META_APP_SECRET (the webhook is signed with the app secret)');
  }
  const flag = (v: string | undefined, fallback: boolean) => (v === undefined || v === '' ? fallback : v === 'true' || v === '1');
  let sso: Config['sso'] = null;
  if (c.OIDC_ISSUER || c.OIDC_CLIENT_ID || c.OIDC_CLIENT_SECRET) {
    if (!(c.OIDC_ISSUER && c.OIDC_CLIENT_ID && c.OIDC_CLIENT_SECRET)) {
      throw new Error('Invalid configuration: single sign-on needs OIDC_ISSUER, OIDC_CLIENT_ID and OIDC_CLIENT_SECRET together');
    }
    const allowedDomains = (c.OIDC_ALLOWED_DOMAINS ?? '').split(',').map((d) => d.trim().toLowerCase().replace(/^@/, '')).filter(Boolean);
    if (!allowedDomains.length) {
      throw new Error('Invalid configuration: set OIDC_ALLOWED_DOMAINS to the email domains that may sign in with single sign-on (for example example.com)');
    }
    if (isProd && !c.OIDC_ISSUER.startsWith('https://')) throw new Error('Invalid configuration: OIDC_ISSUER must be an https address in production');
    sso = {
      issuer: c.OIDC_ISSUER.replace(/\/$/, ''), clientId: c.OIDC_CLIENT_ID, clientSecret: c.OIDC_CLIENT_SECRET, label: c.OIDC_LABEL,
      allowedDomains, secondFactor: c.OIDC_SECOND_FACTOR, trustEmail: c.OIDC_TRUST_EMAIL,
    };
  }
  const secondFactorRequired = flag(c.SECOND_FACTOR_REQUIRED, isProd);
  // With the provider's second step trusted (idp), an emailed link is a way in that skips it: off unless asked for. When it is asked
  // for, a session begun with a link owes the app's own second step, for every role (see sessionState in services/auth.ts).
  const emailLinkLogin = flag(c.EMAIL_LINK_LOGIN, sso?.secondFactor !== 'idp');
  if (!emailLinkLogin && !sso && !c.AUTH_DEV_LOGIN) {
    throw new Error('Invalid configuration: EMAIL_LINK_LOGIN=false leaves no way to sign in unless single sign-on is set up (OIDC_*)');
  }
  // Without a mail server the link would go to the log, and a link signs in whoever has it: anyone who can read the log.
  if (isProd && emailLinkLogin && !c.SMTP_URL) {
    throw new Error(
      'Invalid configuration: in production, sign-in links have to be emailed. Set SMTP_URL, or EMAIL_LINK_LOGIN=false when everyone signs in with single sign-on (OIDC_*)',
    );
  }
  const webhookAllowPrivate = c.WEBHOOK_ALLOW_PRIVATE_NETWORKS ? ['true', '1'].includes(c.WEBHOOK_ALLOW_PRIVATE_NETWORKS) : !isProd;
  return { ...c, isProd, devLogin: c.AUTH_DEV_LOGIN && !isProd, metaEnabled, googleEnabled, enabled, webhookAllowPrivate, secondFactorRequired, emailLinkLogin, sso };
}
