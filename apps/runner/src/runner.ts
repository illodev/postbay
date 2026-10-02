import { readFileSync } from 'node:fs';
import path from 'node:path';
import { Studio, StudioError } from './api.js';
import type { Config } from './config.js';
import type { Logger } from './log.js';
import { handle, type PipelineDeps } from './pipeline.js';
import type { Item, Queue } from './queue.js';
import { unknownVariables } from './template.js';

export interface Runner {
  /** Look at the queue now instead of at the next tick. */
  wake(): void;
  /** Stops taking work, tells running agents to stop, and waits for what is in flight. */
  stop(): Promise<void>;
}

const MAX_TRIES = 8;

/** Reads every brand's instruction templates, and refuses to start with a placeholder that means nothing. */
export function loadTemplates(config: Config): Map<string, string> {
  const out = new Map<string, string>();
  const problems: string[] = [];
  for (const [key, brand] of Object.entries(config.brands)) {
    for (const [type, file] of Object.entries(brand.templates)) {
      const full = path.resolve(config.baseDir, file);
      let text: string;
      try {
        text = readFileSync(full, 'utf8');
      } catch (err) {
        problems.push(`${key}: cannot read the ${type} template ${full}: ${(err as Error).message}`);
        continue;
      }
      const bad = unknownVariables(text);
      if (bad.length) problems.push(`${key}: the ${type} template uses {{${bad.join('}}, {{')}}}, which are not known`);
      out.set(`${key}:${type}`, text);
    }
  }
  if (problems.length) throw new Error(`Invalid templates:\n- ${problems.join('\n- ')}`);
  return out;
}

/**
 * Takes events from the queue and runs each through the pipeline, up to the configured number at once. An event that
 * cannot proceed yet (a busy piece, the studio unreachable) goes back to the queue for later; one that fails in an
 * unexpected way is tried a few more times, then closed so it does not hold a run open for ever.
 */
export function startRunner(config: Config, queue: Queue, log: Logger, o: { now?: () => number; studioFor?: (brand: string) => Studio; tickMs?: number } = {}): Runner {
  const now = o.now ?? Date.now;
  const studios = new Map<string, Studio>();
  const studioFor =
    o.studioFor ??
    ((key: string) => {
      let s = studios.get(key);
      if (!s) {
        const b = config.brands[key]!;
        s = new Studio(b.api, b.token);
        studios.set(key, s);
      }
      return s;
    });
  const abort = new AbortController();
  const deps: PipelineDeps = { config, studioFor, templates: loadTemplates(config), queue, log, now, signal: abort.signal };
  const running = new Set<Promise<void>>();
  let stopping = false;

  const process_ = async (item: Item) => {
    try {
      const out = await handle(deps, item);
      if ('retryAt' in out) {
        item.notBefore = out.retryAt;
        queue.save(item);
        log.info({ item: item.id, until: new Date(out.retryAt).toISOString(), reason: out.reason }, 'will try again later');
      }
    } catch (err) {
      item.tries++;
      log.error({ item: item.id, tries: item.tries, err: err instanceof StudioError ? `${err.code}: ${err.message}` : String(err) }, 'handling an event failed');
      if (item.tries >= MAX_TRIES) {
        log.error({ item: item.id }, 'giving up on this event');
        if (item.runId && item.stage !== 'queued') {
          await studioFor(item.brand).finishRun(item.runId, { outcome: 'failed', cost: item.work?.cost ?? 0, notes: 'The runner gave up after repeated errors.' }).catch(() => {});
        }
        queue.done(item);
      } else {
        item.notBefore = now() + Math.min(30_000 * item.tries ** 2, 600_000);
        queue.save(item);
      }
    } finally {
      queue.release(item.id);
    }
  };

  const tick = () => {
    if (stopping) return;
    while (running.size < config.maxConcurrentRuns) {
      const item = queue.take(now());
      if (!item) break;
      const p = process_(item).finally(() => {
        running.delete(p);
        tick();
      });
      running.add(p);
    }
  };
  const timer = setInterval(tick, o.tickMs ?? 1000);
  const tidy = setInterval(() => queue.tidy(), 6 * 3600_000);
  timer.unref();
  tidy.unref();
  tick();

  return {
    wake: tick,
    async stop() {
      stopping = true;
      clearInterval(timer);
      clearInterval(tidy);
      abort.abort();
      await Promise.allSettled([...running]);
    },
  };
}
