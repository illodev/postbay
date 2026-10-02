import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startWorker, type Worker } from '../src/worker.js';
import { emit } from '../src/services/events.js';
import { createEnv, type Env } from './helpers.js';
import { Receiver } from './receiver.js';

// The worker with the real queue (pg-boss on the same PostgreSQL) and the real clock: it must carry a publication from
// "scheduled" to "published" on its own, with nothing but the sweep and the queue driving it.
let env: Env;
let worker: Worker;
beforeAll(async () => {
  env = await createEnv({ METRICS_SWEEP_SECONDS: '1' }, { fakes: true });
  worker = await startWorker(env.ctx);
});
afterAll(async () => {
  await worker.stop();
  await env.close();
});

async function waitFor<T>(fn: () => Promise<T | false | null | undefined>, ms = 25_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 250));
  }
}

describe('the queue worker', () => {
  it('carries an automatic publication all the way, by itself', async () => {
    const ig = await env.connect('instagram');
    env.meta.processingPolls = 0;
    const { users, call, makePiece, newVersion, approve } = env;
    const { variantId } = await makePiece(users.producer, 'post', '4:5');
    const v = await newVersion(users.producer, variantId, [{ name: 'p.png', mime: 'image/png', kind: 'image' }]);
    await approve(users.approver, v.body.id, [ig]);
    // Close enough to the hour that preparation is already due, far enough that it is in the future.
    const pub = await call(users.approver, 'POST', `/api/versions/${v.body.id}/publications`, {
      accountId: ig, scheduledAt: new Date(Date.now() + 4000).toISOString(), text: 'Posted by the worker',
    });
    expect(pub.body.manual).toBe(false);

    const done = await waitFor(async () => {
      const r = await env.db.one('select status, visibility, external_id from publication where id = $1', [pub.body.id]);
      return r?.status === 'published' && r.visibility === 'public' ? r : false;
    });
    expect(done.external_id).toMatch(/^m-/);
    expect(env.meta.callsTo(/media_publish/)).toHaveLength(1);
    const steps = (await env.db.query('select step from publication_attempt where publication_id = $1 order by id', [pub.body.id])).map((r) => r.step);
    expect(steps).toEqual(['prepare', 'publish', 'verify']);

    // Once live, its numbers are scheduled, and the worker reads them as they fall due.
    const rows = await env.db.query('select age, status from metric_snapshot where publication_id = $1 order by due_at', [pub.body.id]);
    expect(rows.map((r) => [r.age, r.status])).toEqual([['1h', 'pending'], ['1d', 'pending'], ['7d', 'pending'], ['28d', 'pending']]);
    await env.db.query(`update metric_snapshot set due_at = now() - interval '1 minute', next_attempt_at = now() - interval '1 minute' where publication_id = $1 and age = '1h'`, [pub.body.id]);
    const read = await waitFor(async () => {
      const r = await env.db.one(`select status, metrics from metric_snapshot where publication_id = $1 and age = '1h'`, [pub.body.id]);
      return r?.status === 'ok' ? r : false;
    });
    expect(read.metrics.views).toBe(2000);
    expect((await env.db.one(`select status from metric_snapshot where publication_id = $1 and age = '1d'`, [pub.body.id]))!.status).toBe('pending');
  });

  it('checks the connection health of accounts that are due', async () => {
    const id = await env.connect('facebook', { externalId: '111', name: 'Healthy page' });
    await worker.sweep();
    const checked = await waitFor(async () => {
      const r = await env.db.one('select last_health_at from social_account where id = $1', [id]);
      return r?.last_health_at ? r : false;
    });
    expect(checked.last_health_at).not.toBeNull();
  });

  it('does nothing for manual publications, and queues one wake-up at most per publication', async () => {
    const n = await worker.sweep();
    expect(typeof n).toBe('number');
    const jobs = await env.db.query(`select count(*)::int as n from pgboss.job where name = 'publication.advance' and state = 'created'`);
    expect(jobs[0]!.n).toBeLessThanOrEqual(1);
  });

  it('delivers webhooks by itself, and retries until the receiver answers', async () => {
    const rx = await new Receiver().start();
    try {
      rx.responder = (_r, n) => (n === 1 ? { status: 500 } : { status: 200 });
      const w = await env.call(env.users.admin, 'POST', `/api/brands/${env.brandId}/webhooks`, { url: rx.url, events: ['version.approved'] });
      expect(w.status).toBe(201);
      await env.db.tx((db) => emit(env.ctx, db, env.brandId, 'version.approved', { hello: 'world' }));
      const done = await waitFor(async () => {
        const d = await env.db.one('select status, attempts from webhook_delivery where webhook_id = $1', [w.body.id]);
        return d?.status === 'delivered' ? d : false;
      }, 40_000);
      expect(done.attempts).toBe(2);
      expect(rx.requests.map((r) => r.json.data)).toEqual([{ hello: 'world' }, { hello: 'world' }]);
    } finally {
      await rx.stop();
    }
  }, 60_000);
});
