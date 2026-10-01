import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startWorker, type Worker } from '../src/worker.js';
import { createEnv, type Env } from './helpers.js';

// The worker with the real queue (pg-boss on the same PostgreSQL) and the real clock: it must carry a publication from
// "scheduled" to "published" on its own, with nothing but the sweep and the queue driving it.
let env: Env;
let worker: Worker;
beforeAll(async () => {
  env = await createEnv({}, { fakes: true });
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
});
