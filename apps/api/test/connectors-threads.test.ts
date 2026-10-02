import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createConnectorSet } from '../src/connectors/registry.js';
import { FakeThreads } from './fakes/threads.js';
import { account, configFor, env, expectError, image, input, media, prepareUntilDone, redirect } from './connector-helpers.js';

const fake = new FakeThreads();
let set: ReturnType<typeof createConnectorSet>;
const threads = () => set.connector('threads')!;
const acc = account('threads', { externalId: '90001', displayName: '@lumen.coffee' });

beforeAll(async () => {
  await fake.start();
  set = createConnectorSet(configFor({ THREADS_APP_ID: 'tid', THREADS_APP_SECRET: 'tsecret', THREADS_OAUTH_URL: `${fake.url}/oauth/authorize`, THREADS_GRAPH_URL: fake.url }));
});
afterAll(() => fake.stop());
beforeEach(() => {
  fake.reset();
  fake.tokens.clear();
  fake.tokens.add('tok');
  fake.containers.clear();
  fake.posts.clear();
  fake.processingPolls = 1;
  fake.quota = { usage: 0, total: 250 };
  fake.rejectVideoWith = null;
  fake.revoked = false;
});

describe('Threads: signing in', () => {
  it('sends the person to Threads with its own scopes and the state', () => {
    const u = new URL(set.provider('threads')!.authorizeUrl!('state-1', redirect));
    expect(u.origin + u.pathname).toBe(`${fake.url}/oauth/authorize`);
    expect(u.searchParams.get('client_id')).toBe('tid');
    expect(u.searchParams.get('state')).toBe('state-1');
    expect(u.searchParams.get('redirect_uri')).toBe(redirect);
    expect(u.searchParams.get('scope')).toBe('threads_basic,threads_content_publish,threads_manage_insights,threads_manage_replies');
  });

  it('trades the code for a long-lived token and names the account', async () => {
    const found = await set.provider('threads')!.exchange!('good', redirect, 's');
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ network: 'threads', externalId: '90001', displayName: '@lumen.coffee', providerData: { username: 'lumen.coffee' } });
    expect(found[0]!.token.accessToken).toMatch(/^long-/);
    const days = (new Date(found[0]!.token.expiresAt!).getTime() - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(59);
    expect(days).toBeLessThan(61);
    // The short token went to the exchange call and the app secret was in the query of that call, not the form of the first.
    expect(fake.callsTo('/access_token')[0]!.query).toMatchObject({ grant_type: 'th_exchange_token', client_secret: 'tsecret' });
  });

  it('says so when Threads refuses the code', async () => {
    await expect(set.provider('threads')!.exchange!('bad', redirect, 's')).rejects.toMatchObject({ errorClass: 'file_rejected' });
  });

  it('renews a token a week ahead, and treats a refusal as a lost connection', async () => {
    const p = set.provider('threads')!;
    expect(p.refreshWindowSec).toBe(7 * 86_400);
    const fresh = await p.refresh!({ accessToken: 'tok', expiresAt: new Date(Date.now() + 3 * 86_400_000).toISOString() });
    expect(fresh.accessToken).toMatch(/^long-/);
    fake.revoked = true;
    await expectError(p.refresh!({ accessToken: 'tok', expiresAt: new Date(Date.now() + 3 * 86_400_000).toISOString() }), 'auth');
  });
});

describe('Threads: what it accepts', () => {
  it('picks a placement from the content', () => {
    const c = threads();
    expect(c.defaultPlacement({ pieceKind: 'video', format: '9:16', media: [{ kind: 'video' }] })).toBe('video');
    expect(c.defaultPlacement({ pieceKind: 'post', format: '1:1', media: [{ kind: 'image' }] })).toBe('image');
    expect(c.defaultPlacement({ pieceKind: 'post', format: 'carousel', media: [{ kind: 'image' }, { kind: 'image' }] })).toBe('carousel');
    expect(c.defaultPlacement({ pieceKind: 'document', format: 'document', media: [{ kind: 'pdf' }] })).toBeNull();
  });

  it('refuses text over 500 characters, and videos over five minutes, as errors', () => {
    const c = threads();
    const long = c.validate(input({ text: 'x'.repeat(501) }), acc);
    expect(long).toContainEqual(expect.objectContaining({ severity: 'error', code: 'text.length' }));
    const tooLong = c.validate(input({ media: [media({ durationMs: 301_000 })] }), acc);
    expect(tooLong).toContainEqual(expect.objectContaining({ severity: 'error', code: 'media.duration' }));
    expect(c.validate(input({ text: 'x'.repeat(500) }), acc).filter((i) => i.severity === 'error')).toEqual([]);
  });

  it('takes a carousel of 2 to 20 items and nothing else', () => {
    const c = threads();
    const one = c.validate(input({ placement: 'carousel', media: [image()] }), acc);
    expect(one).toContainEqual(expect.objectContaining({ code: 'media.count' }));
    const ok = c.validate(input({ placement: 'carousel', media: [image(), image({ position: 1 })] }), acc);
    expect(ok.filter((i) => i.severity === 'error')).toEqual([]);
  });
});

describe('Threads: publishing', () => {
  it('publishes a picture: container, publish, permalink, verified', async () => {
    const c = threads();
    const e = env('tok');
    const inp = input({ placement: 'image', media: [image()], text: 'Fresh from the oven' });
    const prep = await prepareUntilDone(c, inp, acc, e);
    expect(prep.done).toBe(true);
    const created = fake.callsTo('/v1.0/90001/threads', 'POST')[0]!;
    expect(created.body).toMatchObject({ media_type: 'IMAGE', image_url: 'https://media.test/photo.jpg?sig=1', text: 'Fresh from the oven' });

    const pub = await c.publish(inp, acc, prep.handle, e);
    expect(pub.externalId).toMatch(/^post-/);
    expect(pub.url).toContain('threads.net/@lumen.coffee/post/');
    expect((await c.verify(acc, pub.externalId, {}, e)).visibility).toBe('public');
  });

  it('waits for a video to finish processing and asks again later', async () => {
    const c = threads();
    const e = env('tok');
    const prep = await prepareUntilDone(c, input({ placement: 'video' }), acc, e);
    expect(prep.looks).toBeGreaterThan(1);
    expect(fake.callsTo('/v1.0/90001/threads', 'POST')).toHaveLength(1); // one container, not one per look
  });

  it('turns a video Threads refuses into a rejection with its reason', async () => {
    fake.rejectVideoWith = 'Video is longer than the allowed duration';
    const e = env('tok');
    const err = await expectError(prepareUntilDone(threads(), input({ placement: 'video' }), acc, e), 'file_rejected');
    expect(err.message).toContain('longer than the allowed duration');
  });

  it('makes one container per item and then the carousel, with the text on the carousel only', async () => {
    const c = threads();
    const e = env('tok');
    const inp = input({ placement: 'carousel', media: [image(), image({ position: 1, url: 'https://media.test/b.jpg' }), media({ position: 2 })], text: 'Three things' });
    const prep = await prepareUntilDone(c, inp, acc, e);
    const posts = fake.callsTo('/v1.0/90001/threads', 'POST').map((x) => x.body);
    expect(posts).toHaveLength(4);
    expect(posts.slice(0, 3).every((b) => b.is_carousel_item === 'true' && b.text === undefined)).toBe(true);
    expect(posts[3]).toMatchObject({ media_type: 'CAROUSEL', text: 'Three things' });
    expect(String(posts[3].children).split(',')).toHaveLength(3);
    const pub = await c.publish(inp, acc, prep.handle, e);
    expect(fake.posts.get(pub.externalId)!.media_type).toBe('CAROUSEL');
  });

  it('posts the first comment as a reply to its own post, and does not fail the post if the reply is refused', async () => {
    const c = threads();
    const e = env('tok');
    const inp = input({ placement: 'image', media: [image()], firstComment: 'Link in bio' });
    const prep = await prepareUntilDone(c, inp, acc, e);
    const pub = await c.publish(inp, acc, prep.handle, e);
    const reply = [...fake.containers.values()].find((x) => x.reply_to_id)!;
    expect(reply).toMatchObject({ media_type: 'TEXT', text: 'Link in bio', reply_to_id: pub.externalId });

    // A refused reply leaves a note in the handle but the post stands.
    fake.reset();
    fake.fail((x) => x.method === 'POST' && x.path === '/v1.0/90001/threads' && x.body?.reply_to_id !== undefined, { error: { message: 'Replies are limited', code: 100 } }, 400);
    const e2 = env('tok');
    const prep2 = await prepareUntilDone(c, inp, acc, e2);
    const pub2 = await c.publish(inp, acc, prep2.handle, e2);
    expect(pub2.externalId).toMatch(/^post-/);
    expect(e2.saved.at(-1)!.firstCommentError).toContain('Replies are limited');
  });

  it('never publishes twice when a step is repeated after a crash', async () => {
    const c = threads();
    const e = env('tok');
    const inp = input({ placement: 'image', media: [image()] });
    const prep = await prepareUntilDone(c, inp, acc, e);
    const first = await c.publish(inp, acc, prep.handle, e);
    const again = await c.publish(inp, acc, e.saved.at(-1)!, e);
    expect(again.externalId).toBe(first.externalId);
    expect(fake.callsTo('/v1.0/90001/threads_publish', 'POST')).toHaveLength(1);
  });

  it('waits for the daily limit instead of failing when it is used up', async () => {
    fake.quota = { usage: 250, total: 250 };
    const err = await expectError(threads().prepare(input({ placement: 'image', media: [image()] }), acc, {}, env('tok')), 'rate_limit');
    expect(err.retryAfterSec).toBe(86_400);
    expect(fake.callsTo('/v1.0/90001/threads', 'POST')).toHaveLength(0);
  });

  it('reports a revoked token as an auth failure so the account asks to be reconnected', async () => {
    fake.revoked = true;
    await expectError(threads().prepare(input({ placement: 'image', media: [image()] }), acc, {}, env('tok')), 'auth');
  });
});

describe('Threads: after publishing', () => {
  it('reads the numbers under the common names, leaving reach out', async () => {
    const c = threads();
    const e = env('tok');
    const inp = input({ placement: 'image', media: [image()] });
    const prep = await prepareUntilDone(c, inp, acc, e);
    const pub = await c.publish(inp, acc, prep.handle, e);
    const m = await c.fetchMetrics!(acc, pub.externalId, {}, e, { publishedAt: new Date(), placement: 'image' });
    expect(m.common).toEqual({ views: 120, likes: 9, comments: 2, shares: 5 }); // 3 shares + 1 repost + 1 quote
    expect('reach' in m.common).toBe(false);
    expect(m.raw).toMatchObject({ data: expect.any(Array) });
  });

  it('reports when the token stops working, and until when it works', async () => {
    const expiresAt = new Date(Date.now() + 5 * 86_400_000).toISOString();
    const h = await threads().health!(acc, env('tok', {}, () => new Date(), { expiresAt }));
    expect(h).toEqual({ valid: true, expiresAt });
    fake.revoked = true;
    await expectError(threads().health!(acc, env('tok')), 'auth');
  });
});
