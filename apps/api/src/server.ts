import { buildApp } from './app.js';
import { startBackground } from './background.js';
import { loadConfig } from './config.js';
import { createDb } from './db.js';
import { migrate } from './migrate.js';

const config = loadConfig();
const db = createDb(config.DATABASE_URL);
const applied = await migrate(db);
const { app, ctx } = await buildApp({ config, db });
if (applied.length) app.log.info({ applied }, 'migrations applied');

const stop = startBackground(ctx);
await app.listen({ port: config.PORT, host: config.HOST });

const shutdown = async () => {
  stop();
  await app.close();
  await db.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
