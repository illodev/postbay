import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Connector } from '../src/connectors/types.js';
import { ConnectorError } from '../src/connectors/types.js';
import { advance, TIMING, wakeFrozen, wakeOrphans } from '../src/services/publisher.js';
import { createEnv, type Env } from './helpers.js';

/**
 * What must stop an automatic post, and what must never post twice: a paused brand, a blocked date, a cancel while a video is
 * still processing, a worker that dies or hangs mid-publish, a dependency that does not go out.
 */
let env: Env;
let ig: string, fb: string;
beforeAll(async () => {
  env = await createEnv({}, { fakes: true });
  ig = await env.connect('instagram');
  fb = await env.connect('facebook');
});
afterAll(async () => { await env.close(); });
beforeEach(async () => {
  env.meta.calls.length = 0;
  env.meta.igQuota = { usage: 0, total: 50 };
  env.meta.processingPolls = 0;
  await env.db.query('update brand set paused = false where id = $1', [env.brandId]);
  await env.db.query('delete from blocked_date where brand_id = $1', [env.brandId]);
});
afterEach(() => { env.meta.failures.length = 0; env.meta.loseNextPublishAnswer = false; });

const MIN = 60_000;
const at = (ms: number) => new Date(env.clock.now().getTime() + ms);
const row = async (id: string) => (await env.db.one('select * from publication where id = $1', [id]))!;
const IMAGE = [{ name: 'photo.png', mime: 'image/png', kind: 'image' }];
const VIDEO = [{ name: 'reel.mp4', mime: 'video/mp4', kind: 'video' }];
const pause = (paused: boolean) => env.call(env.users.approver, 'POST', `/api/brands/${env.brandId}/pause`, { paused });

let seq = 0;
async function scheduled(o: { account: string; kind?: string; format?: string; files?: typeof IMAGE; leadMs?: number; body?: Record<string, unknown> }) {
  const { users, call, makePiece, newVersion, approve } = env;
  const { variantId, pieceId } = await makePiece(users.producer, o.kind ?? 'post', o.format ?? '4:5');
  const v = await newVersion(users.producer, variantId, (o.files ?? IMAGE).map((f) => ({ ...f, data: Buffer.from(`file-${++seq}-${f.name}`) })));
  expect(v.status, JSON.stringify(v.body)).toBe(201);
  expect((await approve(users.approver, v.body.id, [o.account])).body.review_state).toBe('approved');
  const r = await call(users.approver, 'POST', `/api/versions/${v.body.id}/publications`, {
    accountId: o.account, scheduledAt: at(o.leadMs ?? 2 * 60 * MIN).toISOString(), text: 'Spring menu', ...(o.body ?? {}),
  });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return { pub: r.body, versionId: v.body.id as string, variantId, pieceId };
}

/** Lets a connector be swapped for one that misbehaves, for one test. */
async function withConnector<T>(network: string, wrap: (real: Connector) => Connector, fn: () => Promise<T>): Promise<T> {
  const saved = env.ctx.connectors;
  env.ctx.connectors = { ...saved, connector: (n) => (n === network ? wrap(saved.connector(n)!) : saved.connector(n)) } as typeof saved;
  try {
    return await fn();
  } finally {
    env.ctx.connectors = saved;
  }
}

describe('a paused brand publishes nothing', () => {
  it('does not send a prepared post at its hour, and prepares it again on resume within the tolerance', async () => {
    const { pub } = await scheduled({ account: ig });
    env.clock.set(new Date(pub.prepare_at));
    await env.settle();
    expect((await row(pub.id)).status).toBe('ready');

    expect((await pause(true)).status).toBe(200);
    env.clock.set(new Date(pub.scheduled_at));
    await env.settle();
    expect(env.meta.callsTo(/media_publish/)).toHaveLength(0);
    const held = await row(pub.id);
    expect(held).toMatchObject({ status: 'scheduled', manual: false });
    expect(held.frozen_at).not.toBeNull();

    // Resumed five minutes after the hour: inside the tolerance, so it goes out now.
    env.clock.set(new Date(new Date(pub.scheduled_at).getTime() + 5 * MIN));
    await pause(false);
    await env.settle();
    expect(await row(pub.id)).toMatchObject({ status: 'published', frozen_at: null });
    expect(env.meta.callsTo(/media_publish/)).toHaveLength(1);
  });

  it('takes down a post Facebook is holding, and holds it there again on resume', async () => {
    const { pub } = await scheduled({ account: fb });
    env.clock.set(new Date(pub.prepare_at));
    await env.settle();
    const first = (await row(pub.id)).handle.objectId as string;
    expect(env.meta.posts.has(first)).toBe(true);

    await pause(true); // the crisis button, twenty-something minutes before the hour
    await env.settle();
    expect(env.meta.posts.has(first)).toBe(false); // gone from the Page: it cannot go out by itself any more
    expect(await row(pub.id)).toMatchObject({ status: 'scheduled', native_scheduled: false, held_on_network: false, handle: {} });
    const audited = await env.db.query(`select action from audit_event where entity_id = $1 and action in ('publication.discarded','publication.frozen')`, [pub.id]);
    expect(audited.map((a) => a.action).sort()).toEqual(['publication.discarded', 'publication.frozen']);

    env.clock.advance(MIN);
    await pause(false);
    await env.settle();
    const again = await row(pub.id);
    expect(again).toMatchObject({ status: 'ready', native_scheduled: true });
    expect(again.handle.objectId).not.toBe(first);
    expect(env.meta.posts.has(again.handle.objectId)).toBe(true);
  });

  it('hands a post whose hour passed while paused to a person, who sees it once the brand resumes', async () => {
    const { pub } = await scheduled({ account: ig });
    await pause(true);
    env.clock.set(new Date(pub.prepare_at));
    await env.settle();
    env.clock.set(new Date(new Date(pub.scheduled_at).getTime() + 20 * MIN));
    await env.settle();
    expect(env.meta.callsTo(/\/media/)).toHaveLength(0);
    const r = await row(pub.id);
    expect(r).toMatchObject({ status: 'scheduled', manual: true, last_error_class: 'missed_window' });
    expect(r.last_error).toMatch(/paused/);
    // Told with a kind of its own, in the person's language when they read it (the English is kept beside the code).
    const told = await env.db.query(`select payload from notification where kind = 'publication.handed_over' and payload->>'publicationId' = $1`, [pub.id]);
    expect(told[0]!.payload).toMatchObject({ handedOver: true, message_i18n: { code: 'pub.needsPerson' } });
    expect(told[0]!.payload.message).toMatch(/while the brand was paused, so the app did not publish it\. It now needs a person/);
    expect(await env.db.query(`select 1 from notification where kind = 'publication.failed' and payload->>'publicationId' = $1`, [pub.id])).toHaveLength(0);

    await pause(false);
    const due = await env.call(env.users.approver, 'GET', `/api/brands/${env.brandId}/publications/due`);
    expect(due.body.map((d: any) => d.id)).toContain(pub.id);
  });

  it('does not publish on a date blocked after scheduling, and takes down what the network holds for it', async () => {
    const { pub } = await scheduled({ account: fb, leadMs: 3 * 60 * MIN });
    env.clock.set(new Date(pub.prepare_at));
    await env.settle();
    const objectId = (await row(pub.id)).handle.objectId as string;
    const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Madrid' }).format(new Date(pub.scheduled_at));
    expect((await env.call(env.users.approver, 'POST', `/api/brands/${env.brandId}/blocked-dates`, { day, reason: 'Mourning' })).status).toBe(201);
    // Blocking the day wakes it at once: no sweep is needed for the network's copy to come down.
    expect(new Date((await row(pub.id)).next_run_at).getTime()).toBeLessThanOrEqual(env.clock.now().getTime());
    await env.settle();
    expect(env.meta.posts.has(objectId)).toBe(false);
    expect((await row(pub.id)).status).toBe('scheduled');
    expect(await wakeFrozen(env.ctx)).toBe(0); // and the sweep has nothing left to catch

    // Unblocked: it is prepared and held by the network again at once, not at its next look minutes later.
    await env.call(env.users.approver, 'DELETE', `/api/brands/${env.brandId}/blocked-dates/${day}`);
    await env.settle();
    expect(await row(pub.id)).toMatchObject({ status: 'ready', native_scheduled: true, frozen_at: null });
    const audited = await env.db.query(`select action, after from audit_event where brand_id = $1 and action in ('date.blocked','date.unblocked') order by id`, [env.brandId]);
    expect(audited.map((a) => [a.action, a.after.publications])).toEqual([['date.blocked', 1], ['date.unblocked', 1]]);
  });

  it('wakes only the publications of the day that was blocked, and does nothing for a day that was not blocked', async () => {
    const a = await scheduled({ account: fb, leadMs: 3 * 60 * MIN });
    const b = await scheduled({ account: fb, leadMs: 3 * 60 * MIN + 26 * 60 * MIN }); // the next day
    env.clock.set(new Date(a.pub.prepare_at));
    await env.settle();
    expect((await row(a.pub.id)).status).toBe('ready');
    const fmt = (d: string) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Madrid' }).format(new Date(d));
    expect(fmt(a.pub.scheduled_at)).not.toBe(fmt(b.pub.scheduled_at));
    const later = (await row(b.pub.id)).next_run_at;
    expect((await env.call(env.users.approver, 'POST', `/api/brands/${env.brandId}/blocked-dates`, { day: fmt(a.pub.scheduled_at), reason: '' })).status).toBe(201);
    expect((await row(b.pub.id)).next_run_at).toEqual(later);
    await env.settle();
    expect((await row(a.pub.id)).status).toBe('scheduled');
    expect((await row(b.pub.id)).status).toBe('scheduled');
    // Removing a block that is not there wakes nothing.
    const other = new Date(new Date(b.pub.scheduled_at).getTime() + 3 * 86_400_000).toISOString().slice(0, 10);
    expect((await env.call(env.users.approver, 'DELETE', `/api/brands/${env.brandId}/blocked-dates/${other}`)).status).toBe(200);
    expect((await row(b.pub.id)).next_run_at).toEqual(later);
  });
});

describe('what the network already holds is taken down, even before preparation finishes', () => {
  it('takes down a Facebook Reel still processing when the publication is cancelled', async () => {
    const { pub } = await scheduled({ account: fb, kind: 'video', format: '9:16', files: VIDEO });
    env.clock.set(new Date(pub.prepare_at));
    await env.settle();
    const r = await row(pub.id);
    expect(r).toMatchObject({ status: 'preparing', native_scheduled: false, held_on_network: true }); // Facebook is still processing it
    const reel = r.handle.objectId as string;
    expect(env.meta.posts.get(reel)!.params.video_state).toBe('SCHEDULED'); // and it is already set to go out at the hour

    expect((await env.call(env.users.approver, 'POST', `/api/publications/${pub.id}/cancel`)).body.status).toBe('cancelled');
    await env.settle();
    expect(env.meta.posts.has(reel)).toBe(false);
    expect(await row(pub.id)).toMatchObject({ held_on_network: false, next_run_at: null, handle: {} });
  });

  it('takes it down when a new version puts the publication on hold', async () => {
    const s = await scheduled({ account: fb, kind: 'video', format: '9:16', files: VIDEO });
    env.clock.set(new Date(s.pub.prepare_at));
    await env.settle();
    const reel = (await row(s.pub.id)).handle.objectId as string;
    expect((await env.newVersion(env.users.producer, s.variantId, [{ name: 'v2.mp4', mime: 'video/mp4', kind: 'video', data: Buffer.from('second take') }])).status).toBe(201);
    expect((await row(s.pub.id)).status).toBe('on_hold');
    await env.settle();
    expect(env.meta.posts.has(reel)).toBe(false);
  });

  it('takes it down when the post fails while Facebook is processing it', async () => {
    const { pub } = await scheduled({ account: fb, kind: 'video', format: '9:16', files: VIDEO, leadMs: 40 * MIN });
    env.clock.set(new Date(pub.prepare_at));
    await env.settle();
    const reel = (await row(pub.id)).handle.objectId as string;
    // Facebook takes its time, and the app only looks again after the hour plus the tolerance: the post fails as missed, and what
    // Facebook holds must not go out by itself.
    env.meta.reels.get(reel)!.processingPolls = 99;
    env.clock.set(new Date(new Date(pub.scheduled_at).getTime() + 16 * MIN));
    await env.settle();
    expect((await row(pub.id)).status).toBe('failed');
    expect(env.meta.posts.has(reel)).toBe(false);
  });
});

describe('a worker that dies or stalls in the middle of publishing', () => {
  it('finishes the send through the connector after a crash, past the tolerance, without posting twice', async () => {
    const { pub } = await scheduled({ account: ig });
    env.clock.set(new Date(pub.prepare_at));
    await env.settle();
    env.clock.set(new Date(pub.scheduled_at));
    // The network takes the post, and the worker dies before writing it down.
    let reached = false;
    await withConnector('instagram', (real) => ({
      ...real,
      async publish(input, account, handle, cenv) {
        await real.publish(input, account, handle, cenv);
        reached = true;
        return new Promise(() => {}); // never comes back
      },
    }), async () => {
      void advance(env.ctx, pub.id);
      for (let i = 0; i < 200 && !reached; i++) await new Promise((r) => setTimeout(r, 10));
    });
    expect(reached).toBe(true);
    expect((await row(pub.id)).status).toBe('publishing');

    // It is picked up again well after the hour plus the tolerance, once the dead worker's lease has run out.
    env.clock.set(new Date(new Date(pub.scheduled_at).getTime() + 50 * MIN));
    await env.settle();
    const r = await row(pub.id);
    expect(r).toMatchObject({ status: 'published' });
    expect(r.external_id).toMatch(/^m-/);
    expect(env.meta.callsTo(/media_publish/)).toHaveLength(1);
  });

  it('keeps what the connector recorded when a failed send is retried, so the post is not made twice', async () => {
    const { pub } = await scheduled({ account: ig });
    env.clock.set(new Date(pub.prepare_at));
    await env.settle();
    env.clock.set(new Date(pub.scheduled_at));
    // Instagram takes the post every time, but the step keeps failing after it (say, the answer is lost on the way back).
    await withConnector('instagram', (real) => ({
      ...real,
      async publish(input, account, handle, cenv) {
        await real.publish(input, account, handle, cenv);
        throw new ConnectorError('transient', 'connection reset');
      },
    }), async () => {
      for (let i = 0; i < 6; i++) {
        await env.settle();
        const r = await row(pub.id);
        if (r.status === 'failed') break;
        env.clock.set(new Date(r.next_run_at));
      }
    });
    const failed = await row(pub.id);
    expect(failed).toMatchObject({ status: 'failed', last_error_class: 'transient' });
    expect(failed.last_error).toMatch(/may already be on Instagram/);
    expect(env.meta.callsTo(/media_publish/)).toHaveLength(1);

    const retried = await env.call(env.users.approver, 'POST', `/api/publications/${pub.id}/retry`, {});
    expect(retried.status, JSON.stringify(retried.body)).toBe(200);
    expect(retried.body.status).toBe('ready'); // it goes straight to finishing the send, keeping the recorded post
    expect(retried.body.handle.mediaId).toBe(failed.handle.mediaId);
    env.clock.set(new Date(retried.body.scheduled_at));
    await env.settle();
    expect((await row(pub.id)).status).toBe('published');
    expect(env.meta.callsTo(/media_publish/)).toHaveLength(1);
  });

  it('finds a post Instagram made although its answer was lost, and never publishes it again, even past the tolerance', async () => {
    const { pub } = await scheduled({ account: ig, body: { firstComment: 'Menu in the bio' } });
    env.clock.set(new Date(pub.prepare_at));
    await env.settle();
    env.clock.set(new Date(pub.scheduled_at));
    env.meta.loseNextPublishAnswer = true; // Instagram publishes it, and the answer never reaches us
    await env.settle();
    const lost = await row(pub.id);
    expect(lost.status).toBe('publishing');
    expect(lost.handle.mediaId).toBeUndefined(); // the id was never saved
    expect(lost.handle.publishAttemptedAt).toBeTruthy(); // but the attempt was, before the call
    // The posts made from this publication's container.
    const fromContainer = () => [...env.meta.media.keys()].filter((id) => env.meta.media.get(id)!.params === env.meta.containers.get(lost.handle.containerId)!.params);
    const made = fromContainer();
    expect(made).toHaveLength(1);

    // Picked up again well past the hour and its tolerance: the post is found and the send finished, not repeated nor failed.
    env.clock.set(new Date(new Date(pub.scheduled_at).getTime() + 40 * MIN));
    await env.settle();
    const r = await row(pub.id);
    expect(r).toMatchObject({ status: 'published', external_id: made[0], visibility: 'public' });
    expect(env.meta.callsTo(/media_publish/)).toHaveLength(1);
    expect(fromContainer()).toEqual(made);
    expect(env.meta.media.get(made[0]!)!.comments).toEqual(['Menu in the bio']); // the steps after it were finished
    const attempts = await env.db.query(`select detail from publication_attempt where publication_id = $1 and step = 'publish' and outcome = 'ok'`, [pub.id]);
    expect(attempts[0]!.detail).toMatchObject({ found: true, recovered: true });
  });

  it('does not send late a post whose earlier try never reached Instagram, and says the network does not have it', async () => {
    const { pub } = await scheduled({ account: ig });
    env.clock.set(new Date(pub.prepare_at));
    await env.settle();
    env.clock.set(new Date(pub.scheduled_at));
    // Refused before anything was made: the container stays unpublished.
    env.meta.fail((c) => /media_publish$/.test(c.path), env.meta.err(2, 'An unexpected error has occurred. Please retry your request later.', { is_transient: true }), 500);
    await env.settle();
    expect((await row(pub.id)).status).toBe('publishing');
    expect(env.meta.callsTo(/media_publish/)).toHaveLength(1);

    // Next looked at past the tolerance: Instagram is asked, does not have it, and nothing is sent after its hour.
    env.clock.set(new Date(new Date(pub.scheduled_at).getTime() + 20 * MIN));
    await env.settle();
    const r = await row(pub.id);
    expect(r).toMatchObject({ status: 'failed', last_error_class: 'missed_window' });
    expect(r.last_error).toMatch(/Instagram does not have the post, so it was not sent late/);
    expect(r.last_error).not.toMatch(/may already be/);
    expect(r.last_error_i18n).toMatchObject({ code: 'pub.notFoundNotLate' });
    expect(env.meta.callsTo(/media_publish/)).toHaveLength(1);
  });

  it('sends it again within the tolerance when the earlier try never reached Instagram, once', async () => {
    const { pub } = await scheduled({ account: ig });
    env.clock.set(new Date(pub.prepare_at));
    await env.settle();
    env.clock.set(new Date(pub.scheduled_at));
    env.meta.fail((c) => /media_publish$/.test(c.path), env.meta.err(2, 'An unexpected error has occurred. Please retry your request later.', { is_transient: true }), 500);
    await env.settle();
    env.clock.set(new Date((await row(pub.id)).next_run_at));
    await env.settle();
    expect(await row(pub.id)).toMatchObject({ status: 'published', visibility: 'public' });
    expect(env.meta.callsTo(/media_publish/)).toHaveLength(2); // the refused one and the one that went out
    const container = env.meta.containers.get((await row(pub.id)).handle.containerId)!;
    expect([...env.meta.media.values()].filter((m) => m.params === container.params)).toHaveLength(1);
  });

  it('asks a connector that can look, before any repeated send, and does not send late when it finds nothing', async () => {
    const { pub } = await scheduled({ account: ig });
    env.clock.set(new Date(pub.prepare_at));
    await env.settle();
    env.clock.set(new Date(pub.scheduled_at));
    let looked = 0;
    let sent = 0;
    await withConnector('instagram', (real) => ({
      ...real,
      async find() { looked++; return null; },
      async publish(input, account, handle, cenv) {
        sent++;
        await cenv.persist({ ...handle, attemptedAt: cenv.now().toISOString() }); // a connector that records its attempt first (X, LinkedIn, Pinterest)
        throw new ConnectorError('transient', 'connection reset');
      },
    }), async () => {
      await env.settle();
      expect(looked).toBe(0); // the first send is not a repeat
      env.clock.set(new Date(new Date(pub.scheduled_at).getTime() + 30 * MIN));
      await env.settle();
    });
    expect(looked).toBe(1);
    expect(sent).toBe(1); // found nothing, past the tolerance: not sent late
    expect(await row(pub.id)).toMatchObject({ status: 'failed', last_error_class: 'missed_window' });
  });

  it('keeps the lease while a long step lasts, so no second worker starts the same post', async () => {
    const { pub } = await scheduled({ account: ig });
    env.clock.set(new Date(pub.prepare_at));
    await env.settle();
    env.clock.set(new Date(pub.scheduled_at));
    const saved = { ...TIMING };
    TIMING.renewEverySeconds = 0.02;
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let started = false;
    try {
      await withConnector('instagram', (real) => ({
        ...real,
        async publish(input, account, handle, cenv) {
          started = true;
          await gate; // a slow upload
          return real.publish(input, account, handle, cenv);
        },
      }), async () => {
        const first = advance(env.ctx, pub.id);
        for (let i = 0; i < 200 && !started; i++) await new Promise((r) => setTimeout(r, 10));
        env.clock.advance(50 * MIN); // longer than any fixed lease
        await new Promise((r) => setTimeout(r, 100)); // the first worker renews meanwhile
        expect(await advance(env.ctx, pub.id)).toBe('skipped');
        release();
        expect(await first).toBe('published');
      });
    } finally {
      Object.assign(TIMING, saved);
    }
    expect(env.meta.callsTo(/media_publish/)).toHaveLength(1);
  });

  it('writes nothing once its lease is taken over: the worker that took it decides', async () => {
    const { pub } = await scheduled({ account: ig });
    env.clock.set(new Date(pub.prepare_at));
    await env.settle();
    env.clock.set(new Date(pub.scheduled_at));
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let started = false;
    await withConnector('instagram', (real) => ({
      ...real,
      async publish(input, account, handle, cenv) {
        started = true;
        await gate;
        throw new ConnectorError('file_rejected', 'refused');
      },
    }), async () => {
      const first = advance(env.ctx, pub.id);
      for (let i = 0; i < 200 && !started; i++) await new Promise((r) => setTimeout(r, 10));
      // Another worker has taken the publication over (its lease ran out while this one was stopped).
      await env.db.query(`update publication set lease_token = gen_random_uuid() where id = $1`, [pub.id]);
      release();
      expect(await first).toBe('changed');
    });
    expect((await row(pub.id)).status).toBe('publishing'); // not failed by the worker that lost it
  });
});

describe('a post that depends on another', () => {
  it('waits for the one it depends on, and goes out once that one has', async () => {
    const a = await scheduled({ account: ig, body: { mode: 'manual' } });
    const b = await scheduled({ account: ig, leadMs: 2 * 60 * MIN + 10 * MIN, body: { dependsOn: a.pub.id } });
    env.clock.set(new Date(b.pub.prepare_at));
    await env.settle();
    expect((await row(b.pub.id)).status).toBe('scheduled'); // not prepared while the first is not out
    expect(env.meta.callsTo(/\/media$/)).toHaveLength(0);

    env.clock.set(new Date(a.pub.scheduled_at));
    expect((await env.call(env.users.approver, 'POST', `/api/publications/${a.pub.id}/mark-published`, {})).status).toBe(200);
    await env.settle();
    expect((await row(b.pub.id)).status).toBe('ready');
    env.clock.set(new Date(b.pub.scheduled_at));
    await env.settle();
    expect((await row(b.pub.id)).status).toBe('published');
  });

  it('is held, with the reason, when the one it depends on will not go out', async () => {
    const a = await scheduled({ account: ig, body: { mode: 'manual' } });
    const b = await scheduled({ account: ig, leadMs: 2 * 60 * MIN + 45 * MIN, body: { dependsOn: a.pub.id } });
    expect((await env.call(env.users.approver, 'POST', `/api/publications/${a.pub.id}/cancel`)).status).toBe(200);
    env.clock.set(new Date(b.pub.prepare_at));
    await env.settle();
    const r = await row(b.pub.id);
    expect(r.status).toBe('on_hold');
    expect(r.hold_reason).toMatch(/depends on is cancelled/);
    expect(env.meta.callsTo(/\/media$/)).toHaveLength(0);
  });

  it('takes down a dependent the network holds when its dependency fails after all', async () => {
    const a = await scheduled({ account: ig });
    const b = await scheduled({ account: fb, leadMs: 3 * 60 * MIN, body: { dependsOn: a.pub.id } });
    // The first goes out, the second is prepared and held by Facebook...
    env.clock.set(new Date(a.pub.prepare_at));
    await env.settle();
    env.clock.set(new Date(a.pub.scheduled_at));
    await env.settle();
    env.clock.set(new Date(b.pub.prepare_at));
    await env.settle();
    expect(await row(b.pub.id)).toMatchObject({ status: 'ready', native_scheduled: true });
    const held = (await row(b.pub.id)).handle.objectId as string;
    // ...then the first one is found to have failed.
    await env.db.query(`update publication set status = 'failed' where id = $1`, [a.pub.id]);
    expect(await wakeOrphans(env.ctx)).toBeGreaterThanOrEqual(1);
    await env.settle();
    expect((await row(b.pub.id)).status).toBe('on_hold');
    expect(env.meta.posts.has(held)).toBe(false);
  });

  it('cannot be overtaken by moving the one it depends on', async () => {
    const a = await scheduled({ account: ig, body: { mode: 'manual' } });
    const b = await scheduled({ account: ig, leadMs: 3 * 60 * MIN, body: { dependsOn: a.pub.id, mode: 'manual' } });
    const later = new Date(new Date(b.pub.scheduled_at).getTime() + 60 * MIN).toISOString();
    const moved = await env.call(env.users.approver, 'PATCH', `/api/publications/${a.pub.id}`, { scheduledAt: later });
    expect(moved.status).toBe(400);
    expect(moved.body.error.code).toBe('invalid_dependency');
    const early = await env.call(env.users.approver, 'PATCH', `/api/publications/${b.pub.id}`, { scheduledAt: at(MIN * 30).toISOString() });
    expect(early.body.error.code).toBe('invalid_dependency');
  });
});

describe('a change and the record of it', () => {
  it('fails a post and announces it in one transaction: no failure without its event', async () => {
    const { pub } = await scheduled({ account: ig });
    // Nothing can be written to the outbox for a moment.
    await env.db.query('alter table event rename to event_away');
    try {
      env.clock.set(new Date(new Date(pub.scheduled_at).getTime() + 20 * MIN));
      await expect(advance(env.ctx, pub.id)).rejects.toThrow();
    } finally {
      await env.db.query('alter table event_away rename to event');
    }
    expect((await row(pub.id)).status).toBe('preparing'); // the failure did not happen without its event
    expect(await advance(env.ctx, pub.id)).toBe('failed');
    expect(await env.db.query(`select 1 from event where type = 'publication.failed' and data->'publication'->>'id' = $1`, [pub.id])).toHaveLength(1);
  });
});
