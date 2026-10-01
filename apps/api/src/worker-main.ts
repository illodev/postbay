import { loadConfig } from './config.js';
import { createDb } from './db.js';
import { migrate } from './migrate.js';
import { consoleLogger, createContext } from './runtime.js';
import { startWorker } from './worker.js';

// The worker as a process of its own: what runs the queue in a deployment where the web server has RUN_WORKERS=false.
const config = loadConfig();
const db = createDb(config.DATABASE_URL);
await migrate(db);
const log = consoleLogger();
const worker = await startWorker(createContext(config, db, log));
log.info({}, 'worker started');

const shutdown = async () => {
  await worker.stop();
  await db.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
