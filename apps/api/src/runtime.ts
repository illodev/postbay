import type { Config } from './config.js';
import { createConnectorSet } from './connectors/registry.js';
import type { ConnectorSet } from './connectors/types.js';
import type { Ctx, Logger } from './context.js';
import { TokenVault } from './crypto.js';
import type { Db } from './db.js';
import { createMailer, type Mailer } from './mailer.js';
import { createMedia, type Media } from './media/ffmpeg.js';
import { createStorage, type Storage } from './storage/index.js';

/** A JSON-lines logger for processes that are not the web server (the worker). */
export function consoleLogger(): Logger {
  const write = (level: string) => (o: object, m?: string) => console.log(JSON.stringify({ level, time: Date.now(), msg: m, ...o }));
  return { info: write('info'), warn: write('warn'), error: write('error') };
}

export interface ContextOverrides {
  storage?: Storage;
  mailer?: Mailer;
  media?: Media;
  connectors?: ConnectorSet;
  now?: () => Date;
}

/** Everything a service needs, built from the configuration. The web server and the worker both start from this. */
export function createContext(config: Config, db: Db, log: Logger, o: ContextOverrides = {}): Ctx {
  const now = o.now ?? (() => new Date());
  return {
    db,
    config,
    log,
    storage: o.storage ?? createStorage(config),
    mailer: o.mailer ?? createMailer(config, log),
    media: o.media ?? createMedia(log),
    connectors: o.connectors ?? createConnectorSet(config, now),
    vault: config.TOKEN_KEY ? TokenVault.fromBase64(config.TOKEN_KEY) : null,
    now,
  };
}
