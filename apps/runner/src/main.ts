import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { Studio } from './api.js';
import { loadConfig } from './config.js';
import { consoleLogger } from './log.js';
import { Queue } from './queue.js';
import { secretsInEnvironment } from './secrets.js';
import { startRunner } from './runner.js';
import { createServer } from './server.js';

// The runner: listens to the studio's webhooks and runs an agent for each request for changes.
//   node dist/main.js [config.json]        (or RUNNER_CONFIG=config.json)
const log = consoleLogger();
const file = process.argv[2] ?? process.env.RUNNER_CONFIG ?? 'runner.config.json';

let config;
try {
  config = loadConfig(path.resolve(file));
} catch (err) {
  console.error((err as Error).message);
  process.exit(1);
}

// What is allowed but unsafe is said once, at the top of the log.
for (const warning of config.warnings) log.warn({ warning }, 'unsafe configuration');
// A secret in this process's environment can be read by anything running as the same user for as long as it runs (Linux: /proc/<pid>/environ).
try {
  const exposed = secretsInEnvironment(config.secrets, readFileSync('/proc/self/environ'));
  if (exposed.length) log.warn({ secrets: exposed }, "these secrets are in the runner's environment, where an agent running as the same user can read them: start the runner without them (tokenFile, webhookSecretFile, { \"file\": … } in agent.env)");
} catch {
  /* not Linux: nothing to read */
}

for (const tool of [config.ffmpeg, config.ffprobe]) {
  if (spawnSync(tool, ['-version'], { stdio: 'ignore' }).status !== 0) log.warn({ tool }, 'cannot run this tool: the automatic checks need it');
}

const queue = new Queue(config.stateDir);
let runner: ReturnType<typeof startRunner>;
try {
  runner = startRunner(config, queue, log);
} catch (err) {
  console.error((err as Error).message);
  process.exit(1);
}
const server = createServer({ config, queue, log, wake: () => runner.wake() });
server.listen(config.listen.port, config.listen.host, () => log.info({ port: config.listen.port, brands: Object.keys(config.brands) }, 'runner listening'));

// Tell the people setting this up straight away if a token or an address is wrong, rather than at the first event.
for (const [key, b] of Object.entries(config.brands)) {
  new Studio(b.api, b.token, fetch, config.secrets).tokenInfo().then(
    (me) => log.info({ brand: key, studioBrand: me.brand.name, token: me.token.name }, 'connected to the studio'),
    (err) => log.error({ brand: key, err: String(err) }, 'cannot sign in to the studio with this token'),
  );
}

const shutdown = async (signal: string) => {
  log.info({ signal }, 'shutting down');
  server.close();
  await runner.stop();
  process.exit(0);
};
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
