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
  // Extra origins the browser may load media from or upload to (space separated), e.g. a bucket host.
  MEDIA_ORIGINS: z.string().default(''),
});

export type Config = z.infer<typeof schema> & { devLogin: boolean; isProd: boolean };

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
  return { ...c, isProd, devLogin: c.AUTH_DEV_LOGIN && !isProd };
}
