import type { Config } from './config.js';
import type { ConnectorSet } from './connectors/types.js';
import type { TokenVault } from './crypto.js';
import type { Db } from './db.js';
import type { Mailer } from './mailer.js';
import type { Media } from './media/ffmpeg.js';
import { LocalStorage, type Storage } from './storage/index.js';

export interface Logger {
  info: (o: object, m?: string) => void;
  warn: (o: object, m?: string) => void;
  error: (o: object, m?: string) => void;
}

export interface Ctx {
  db: Db;
  config: Config;
  storage: Storage;
  mailer: Mailer;
  media: Media;
  log: Logger;
  /** The networks this deployment can publish to directly. */
  connectors: ConnectorSet;
  /** Seals and opens network tokens. Null when no TOKEN_KEY is configured, in which case nothing can be connected. */
  vault: TokenVault | null;
  /** The clock. Tests move it to walk a publication through its whole timeline. */
  now: () => Date;
}

/** Source ffmpeg reads from: the disk path with local storage, or a short-lived signed URL with S3. */
export async function mediaSource(ctx: Ctx, key: string): Promise<string> {
  if (ctx.storage instanceof LocalStorage) return ctx.storage.localPath(key);
  return ctx.storage.presignGet(key, { expiresSec: 300 });
}
