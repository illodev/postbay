import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { createDb } from './db.js';
import { migrate } from './migrate.js';
import { startWorker, type Worker } from './worker.js';

const config = loadConfig();
const db = createDb(config.DATABASE_URL);
const applied = await migrate(db);
const { app, ctx } = await buildApp({ config, db });
if (applied.length) app.log.info({ applied }, 'migrations applied');

// Unless a separate worker process runs the queue, it runs here.
const worker: Worker | null = config.RUN_WORKERS ? await startWorker(ctx) : null;
await app.listen({ port: config.PORT, host: config.HOST });

const shutdown = async () => {
  await worker?.stop();
  await app.close();
  await db.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
