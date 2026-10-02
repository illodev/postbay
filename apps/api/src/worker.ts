import { PgBoss } from 'pg-boss';
import { startBackground } from './background.js';
import type { Ctx } from './context.js';
import { accountsDueForHealth, checkHealth } from './services/connectors.js';
import { scanMetrics } from './services/metrics.js';
import { pollComments, purgePrizeData, scanPrizeDeliveries } from './services/prizes.js';
import { scanSlotAlerts } from './services/slots.js';
import { fillFreeSlots } from './services/scheduling.js';
import { deliver, dueDeliveries, purgeOldEvents } from './services/webhooks.js';
import { expireRuns } from './services/agent.js';
import { advance, dueForAttention, TIMING, wakeFrozen, wakeOrphans } from './services/publisher.js';

export const QUEUE = { advance: 'publication.advance', health: 'account.health', deliver: 'webhook.deliver' } as const;

export interface Worker {
  /** Looks for work and hands it to the queue. Returns how many publications needed a look. */
  sweep(): Promise<number>;
  stop(): Promise<void>;
}

/**
 * The queue worker. The queue (pg-boss, in the same PostgreSQL) only delivers wake-ups: "look at this publication". What
 * is true about a publication lives in its row, so a lost, repeated or late wake-up is harmless. A sweep every few seconds
 * finds whatever is due and enqueues it, one pending wake-up per publication.
 */
export async function startWorker(ctx: Ctx): Promise<Worker> {
  const boss = new PgBoss({ connectionString: ctx.config.DATABASE_URL, application_name: 'estudio-worker', max: 6 });
  boss.on('error', (err) => ctx.log.error({ err: String(err) }, 'queue error'));
  await boss.start();

  const make = async (name: string, retryLimit: number, expireInSeconds: number) => {
    if (await boss.getQueue(name)) return;
    // "short": one queued job per key, so a publication that is already waiting is not queued twice.
    await boss.createQueue(name, { policy: 'short', retryLimit, retryDelay: 30, retryBackoff: true, expireInSeconds, retentionSeconds: 6 * 3600, deleteAfterSeconds: 3600 });
  };
  await make(QUEUE.advance, 3, TIMING.jobExpireSeconds);
  await make(QUEUE.health, 1, 300);
  await make(QUEUE.deliver, 2, 180);

  await boss.work<{ id: string }>(QUEUE.advance, { pollingIntervalSeconds: 1, localConcurrency: 2 }, async (jobs) => {
    for (const job of jobs) {
      const outcome = await advance(ctx, job.data.id);
      if (outcome !== 'skipped') ctx.log.info({ publicationId: job.data.id, outcome }, 'publication advanced');
    }
  });
  await boss.work<{ id: string }>(QUEUE.health, { pollingIntervalSeconds: 5 }, async (jobs) => {
    for (const job of jobs) await checkHealth(ctx, job.data.id);
  });

  await boss.work<{ id: string }>(QUEUE.deliver, { pollingIntervalSeconds: 1, localConcurrency: 4 }, async (jobs) => {
    for (const job of jobs) {
      const outcome = await deliver(ctx, job.data.id);
      if (outcome !== 'skipped') ctx.log.info({ deliveryId: job.data.id, outcome }, 'webhook delivery attempted');
    }
  });

  let lastMetrics = 0;
  let lastPoll = 0;
  let lastPrizePurge = 0;
  let lastPurge = 0;
  let lastSlotScan = 0;
  let lastFill = 0;
  let sweeping = false;
  const sweep = async (): Promise<number> => {
    if (sweeping) return 0;
    sweeping = true;
    try {
      // What a pause, a blocked date or a dependency that will not go out has caught is looked at now, not at its hour.
      await wakeFrozen(ctx);
      await wakeOrphans(ctx);
      // Agent runs whose runner stopped reporting, or that went past the longest run, are closed by the studio itself.
      await expireRuns(ctx);
      const due = await dueForAttention(ctx);
      for (const d of due) await boss.send(QUEUE.advance, { id: d.id }, { singletonKey: d.id });
      for (const id of await accountsDueForHealth(ctx)) await boss.send(QUEUE.health, { id }, { singletonKey: id });
      for (const id of await dueDeliveries(ctx)) await boss.send(QUEUE.deliver, { id }, { singletonKey: id });
      if (Date.now() - lastMetrics > ctx.config.METRICS_SWEEP_SECONDS * 1000) {
        lastMetrics = Date.now();
        await scanMetrics(ctx);
      }
      // Prizes: read the comments of posts that carry a rule, then send what is due. Sending is checked every sweep so a prize goes out within seconds.
      if (Date.now() - lastPoll > ctx.config.PRIZE_POLL_SECONDS * 1000) {
        lastPoll = Date.now();
        await pollComments(ctx);
      }
      await scanPrizeDeliveries(ctx);
      if (Date.now() - lastPrizePurge > ctx.config.PRIZE_PURGE_SECONDS * 1000) {
        lastPrizePurge = Date.now();
        await purgePrizeData(ctx);
      }
      if (Date.now() - lastSlotScan > 300_000) {
        lastSlotScan = Date.now();
        await scanSlotAlerts(ctx);
      }
      // Brands that fill their free slots: approved versions that were never scheduled go into the next free ones.
      if (Date.now() - lastFill > ctx.config.FILL_SLOTS_SECONDS * 1000) {
        lastFill = Date.now();
        await fillFreeSlots(ctx);
      }
      if (Date.now() - lastPurge > 6 * 3600_000) {
        lastPurge = Date.now();
        await purgeOldEvents(ctx);
      }
      await ctx.db.query(`delete from oauth_pending where expires_at < now() - interval '1 day'`);
      return due.length;
    } catch (err) {
      ctx.log.error({ err: String(err) }, 'sweep failed');
      return 0;
    } finally {
      sweeping = false;
    }
  };
  const timer = setInterval(() => void sweep(), ctx.config.WORKER_SWEEP_SECONDS * 1000);
  timer.unref();
  void sweep();
  const stopBackground = startBackground(ctx, ctx.config.NOTIFY_SECONDS * 1000);

  return {
    sweep,
    async stop() {
      clearInterval(timer);
      stopBackground();
      await boss.stop({ graceful: true, timeout: 10_000 });
    },
  };
}
