import { z } from 'zod';

const bool = z
  .enum(['true', 'false', '1', '0', ''])
  .default('false')
  .transform((v) => v === 'true' || v === '1');

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
  S3_ENDPOINT: z.string().optional(),
  // Address browsers use for signed URLs when it differs from the one the app uses inside its network.
  S3_PUBLIC_ENDPOINT: z.string().optional(),
  S3_REGION: z.string().default('auto'),
  S3_BUCKET: z.string().optional(),
  S3_ACCESS_KEY_ID: z.string().optional(),
  S3_SECRET_ACCESS_KEY: z.string().optional(),
  S3_FORCE_PATH_STYLE: bool,
  SMTP_URL: z.string().optional(),
  MAIL_FROM: z.string().default('Estudio <no-reply@localhost>'),
  AUTH_DEV_LOGIN: bool,
  WEB_DIST: z.string().optional(),

  // Connected accounts (phase 2)
  /** Master key for the stored network tokens, 32 bytes in base64: openssl rand -base64 32 */
  TOKEN_KEY: z.string().optional(),
  META_APP_ID: z.string().optional(),
  META_APP_SECRET: z.string().optional(),
  META_GRAPH_VERSION: z.string().default('v23.0'),
  META_GRAPH_URL: z.string().default('https://graph.facebook.com'),
  META_OAUTH_URL: z.string().default('https://www.facebook.com'),
  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),
  GOOGLE_OAUTH_URL: z.string().default('https://accounts.google.com/o/oauth2/v2/auth'),
  GOOGLE_TOKEN_URL: z.string().default('https://oauth2.googleapis.com/token'),
  YOUTUBE_API_URL: z.string().default('https://www.googleapis.com'),
  /** How long the files handed to a network by URL stay downloadable. */
  PUBLIC_MEDIA_TTL_SECONDS: z.coerce.number().int().min(300).default(6 * 3600),
  // Workers (phase 2)
  /** Run the queue workers inside the API process. Turn off when a separate worker process runs them. */
  RUN_WORKERS: z.enum(['true', 'false', '1', '0', '']).default('true').transform((v) => v !== 'false' && v !== '0'),
  /** How often the worker looks for publications that need attention. */
  WORKER_SWEEP_SECONDS: z.coerce.number().int().min(1).default(15),
  // Extra origins the browser may load media from or upload to (space separated), e.g. a bucket host.
  MEDIA_ORIGINS: z.string().default(''),
  // Webhooks (phase 3)
  /**
   * Whether webhooks may be sent to addresses on a private network (a runner on the same machine or LAN). Addresses used by
   * cloud metadata services are never allowed. Default: allowed in development, refused in production.
   */
  WEBHOOK_ALLOW_PRIVATE_NETWORKS: z.enum(['true', 'false', '1', '0', '']).optional(),
});

export type Config = z.infer<typeof schema> & {
  devLogin: boolean;
  isProd: boolean;
  metaEnabled: boolean;
  googleEnabled: boolean;
  /** Resolved from WEBHOOK_ALLOW_PRIVATE_NETWORKS and the environment. */
  webhookAllowPrivate: boolean;
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
  if ((metaEnabled || googleEnabled) && !c.TOKEN_KEY) {
    throw new Error('Invalid configuration: connecting accounts needs TOKEN_KEY, the key that seals their tokens');
  }
  const webhookAllowPrivate = c.WEBHOOK_ALLOW_PRIVATE_NETWORKS ? ['true', '1'].includes(c.WEBHOOK_ALLOW_PRIVATE_NETWORKS) : !isProd;
  return { ...c, isProd, devLogin: c.AUTH_DEV_LOGIN && !isProd, metaEnabled, googleEnabled, webhookAllowPrivate };
}
