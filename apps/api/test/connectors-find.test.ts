import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { createConnectorSet } from '../src/connectors/registry.js';
import { FakeLinkedIn } from './fakes/linkedin.js';
import { FakeMeta } from './fakes/meta.js';
import { FakePinterest } from './fakes/pinterest.js';
import { FakeThreads } from './fakes/threads.js';
import { FakeX } from './fakes/x.js';
import { account, configFor, env, expectError, image, input, media, prepareUntilDone, redirect } from './connector-helpers.js';

/**
 * The lookup-only step (`find`): after a crash or a lost answer, each network that can be asked says whether the post an earlier try
 * may have made is there, from what that try saved, without sending anything. The publisher sends again only when it is not there
 * (and only within the tolerance), so a post is never made twice.
 */
const meta = new FakeMeta();
const threadsFake = new FakeThreads();
const xFake = new FakeX();
const liFake = new FakeLinkedIn();
const pinFake = new FakePinterest();
let set: ReturnType<typeof createConnectorSet>;
let xToken = '';

beforeAll(async () => {
  await Promise.all([meta.start(), threadsFake.start(), xFake.start(), liFake.start(), pinFake.start()]);
  set = createConnectorSet(configFor({
    META_APP_ID: 'app', META_APP_SECRET: 'secret', META_GRAPH_URL: meta.url, META_OAUTH_URL: meta.url,
    THREADS_APP_ID: 'tid', THREADS_APP_SECRET: 'tsecret', THREADS_OAUTH_URL: `${threadsFake.url}/oauth/authorize`, THREADS_GRAPH_URL: threadsFake.url,
    X_CLIENT_ID: xFake.clientId, X_CLIENT_SECRET: xFake.clientSecret, X_OAUTH_URL: `${xFake.url}/authorize`, X_API_URL: xFake.url,
    LINKEDIN_CLIENT_ID: 'lid', LINKEDIN_CLIENT_SECRET: 'lsecret', LINKEDIN_OAUTH_URL: `${liFake.url}/authorize`, LINKEDIN_TOKEN_URL: `${liFake.url}/oauth/token`,
    LINKEDIN_API_URL: liFake.url, LINKEDIN_VERSION: '202604',
    PINTEREST_APP_ID: pinFake.clientId, PINTEREST_APP_SECRET: pinFake.clientSecret, PINTEREST_OAUTH_URL: `${pinFake.url}/oauth/`, PINTEREST_API_URL: pinFake.url,
  }));
  void loadConfig;
});
afterAll(async () => {
  await Promise.all([meta.stop(), threadsFake.stop(), xFake.stop(), liFake.stop(), pinFake.stop()]);
});

describe('Instagram: a container that says it was published', () => {
  const ig = () => set.connector('instagram')!;
  const acc = account('instagram', { externalId: '222', displayName: '@lumen.coffee', providerData: { igUserId: '222', pageId: '111' } });
  beforeEach(() => {
    meta.calls.length = 0;
    meta.failures.length = 0;
    meta.processingPolls = 0;
    meta.loseNextPublishAnswer = false;
  });

  it('finds the post a lost answer made, finishes the send from it, and says there is none while the container is unpublished', async () => {
    const e = env('page-token-111');
    const inp = input({ placement: 'reel', text: 'Spring is here', firstComment: 'Menu in bio' });
    const prep = await prepareUntilDone(ig(), inp, acc, e);
    expect(await ig().find!(inp, acc, prep.handle, e)).toBeNull(); // the container is FINISHED: nothing went out

    meta.loseNextPublishAnswer = true;
    await expectError(ig().publish(inp, acc, prep.handle, e), 'transient');
    const saved = e.saved.at(-1)!;
    expect(saved.publishAttemptedAt).toBeTruthy(); // written down before the call
    expect(saved.mediaId).toBeUndefined();

    const found = (await ig().find!(inp, acc, saved, e))!;
    expect(found).toMatchObject({ mediaId: expect.stringMatching(/^m-/), recovered: true, permalink: expect.stringContaining(found.mediaId) });
    expect(meta.callsTo(/^222\/media$/, 'GET')[0]!.query.fields).toContain('timestamp');
    const out = await ig().publish(inp, acc, found, e);
    expect(out.externalId).toBe(found.mediaId);
    expect(meta.callsTo(/media_publish$/)).toHaveLength(1);
    expect(meta.media.get(found.mediaId)!.comments).toEqual(['Menu in bio']);
  });

  it('looks for a story among the stories, and a feed photo among the posts, each by its own kind', async () => {
    const e = env('page-token-111');
    const story = input({ placement: 'story', text: '', media: [image({ width: 1080, height: 1920 })] });
    const prepStory = await prepareUntilDone(ig(), story, acc, e);
    meta.loseNextPublishAnswer = true;
    await expectError(ig().publish(story, acc, prepStory.handle, e), 'transient');
    const foundStory = (await ig().find!(story, acc, e.saved.at(-1)!, e))!;
    expect(meta.media.get(foundStory.mediaId)!.params.media_type).toBe('STORIES');
    expect(meta.callsTo(/^222\/stories$/, 'GET')).toHaveLength(1);

    const photo = input({ placement: 'feed_image', text: 'Fresh bread', media: [image()] });
    const prepPhoto = await prepareUntilDone(ig(), photo, acc, e);
    meta.loseNextPublishAnswer = true;
    await expectError(ig().publish(photo, acc, prepPhoto.handle, e), 'transient');
    const foundPhoto = (await ig().find!(photo, acc, e.saved.at(-1)!, e))!;
    expect(foundPhoto.mediaId).not.toBe(foundStory.mediaId);
    expect(meta.media.get(foundPhoto.mediaId)!.params.caption).toBe('Fresh bread');
  });

  it('will not say "send it again" when the container is published but the post cannot be told apart: it cannot tell, so it throws', async () => {
    const e = env('page-token-111');
    const inp = input({ placement: 'reel', text: 'Autumn menu' });
    const prep = await prepareUntilDone(ig(), inp, acc, e);
    meta.loseNextPublishAnswer = true;
    await expectError(ig().publish(inp, acc, prep.handle, e), 'transient');
    // Someone edited the caption on Instagram in the meantime.
    for (const m of meta.media.values()) if (m.params.caption === 'Autumn menu') m.params = { ...m.params, caption: 'Autumn menu (edited)' };
    const err = await expectError(ig().find!(inp, acc, e.saved.at(-1)!, e), 'unknown');
    expect(err.text).toMatchObject({ code: 'connector.ig.publishedNotFound' });
  });
});

describe('Threads: a container that says it was published', () => {
  const th = () => set.connector('threads')!;
  const acc = account('threads', { externalId: '90001', displayName: '@lumen.coffee' });
  beforeEach(() => {
    threadsFake.reset();
    threadsFake.tokens.clear();
    threadsFake.tokens.add('tok');
    threadsFake.containers.clear();
    threadsFake.posts.clear();
    threadsFake.processingPolls = 0;
    threadsFake.loseNextPublishAnswer = false;
  });

  it('finds the post a lost answer made, and says there is none before', async () => {
    const e = env('tok');
    const inp = input({ placement: 'image', text: 'Our new roast', media: [image()] });
    const prep = await prepareUntilDone(th(), inp, acc, e);
    expect(await th().find!(inp, acc, prep.handle, e)).toBeNull();
    threadsFake.loseNextPublishAnswer = true;
    await expectError(th().publish(inp, acc, prep.handle, e), 'transient');
    const found = (await th().find!(inp, acc, e.saved.at(-1)!, e))!;
    expect(found).toMatchObject({ mediaId: [...threadsFake.posts.keys()][0], recovered: true });
    await th().publish(inp, acc, found, e);
    expect(threadsFake.posts.size).toBe(1);
  });
});

describe('X: a post whose answer was lost', () => {
  const x = () => set.connector('x')!;
  const acc = account('x', { externalId: '4242', displayName: '@lumencoffee', providerData: { username: 'lumencoffee' } });
  const files = { 'k/photo.jpg': Buffer.alloc(3000, 1) };
  beforeEach(async () => {
    xFake.reset();
    xFake.accessTokens.clear();
    xFake.refreshTokens.clear();
    xFake.posts.clear();
    xFake.media.clear();
    xFake.loseNextPostAnswer = false;
    xToken = (await set.provider('x')!.exchange!('good', redirect, 'state-0'))[0]!.token.accessToken;
  });

  it('is found among the account\'s posts since the attempt; one that was never made is not', async () => {
    const e = env(xToken, files);
    const inp = input({ placement: 'images', media: [image()], text: 'Open at nine' });
    const prep = await prepareUntilDone(x(), inp, acc, e);
    expect(await x().find!(inp, acc, prep.handle, e)).toBeNull(); // nothing was attempted
    xFake.fail((c) => c.path === '/2/tweets', { title: 'Service Unavailable', detail: 'Service Unavailable', status: 503 }, 503);
    await expectError(x().publish(inp, acc, prep.handle, e), 'transient');
    expect(await x().find!(inp, acc, e.saved.at(-1)!, e)).toBeNull(); // refused before anything was made: safe to send
    xFake.loseNextPostAnswer = true;
    await expectError(x().publish(inp, acc, e.saved.at(-1)!, e), 'transient');
    const found = (await x().find!(inp, acc, e.saved.at(-1)!, e))!;
    expect(found).toMatchObject({ postId: [...xFake.posts.keys()][0], recovered: true });
    expect(xFake.callsTo('/2/tweets', 'POST')).toHaveLength(2); // the refused one and the one whose answer was lost: no third
  });
});

describe('LinkedIn: a post whose answer was lost', () => {
  const li = () => set.connector('linkedin')!;
  const acc = account('linkedin', { externalId: '5001', displayName: 'Lumen Coffee', providerData: { organizationId: '5001', urn: 'urn:li:organization:5001' } });
  const files = { 'k/photo.jpg': Buffer.alloc(3000, 1) };
  beforeEach(() => {
    liFake.reset();
    liFake.uploads.clear();
    liFake.posts.clear();
    liFake.accessTokens = new Set(['tok']);
    liFake.loseNextPostAnswer = false;
  });

  it('is found among the page\'s posts by the picture it carries, without posting again; one never made is not', async () => {
    const e = env('tok', files);
    const inp = input({ placement: 'image', media: [image()], text: 'Spring menu' });
    const prep = await prepareUntilDone(li(), inp, acc, e);
    expect(await li().find!(inp, acc, prep.handle, e)).toBeNull();
    liFake.fail((c) => c.path === '/rest/posts' && c.method === 'POST', { status: 503, message: 'Service unavailable' }, 503);
    await expectError(li().publish(inp, acc, prep.handle, e), 'transient');
    expect(await li().find!(inp, acc, e.saved.at(-1)!, e)).toBeNull();
    liFake.loseNextPostAnswer = true;
    await expectError(li().publish(inp, acc, e.saved.at(-1)!, e), 'transient');
    const found = (await li().find!(inp, acc, e.saved.at(-1)!, e))!;
    expect(found).toMatchObject({ postUrn: [...liFake.posts.keys()][0], recovered: true });
    const lookup = liFake.callsTo('/rest/posts', 'GET')[0]!;
    expect(lookup.query).toMatchObject({ q: 'author', author: 'urn:li:organization:5001' });
    expect(liFake.callsTo('/rest/posts', 'POST')).toHaveLength(2);
  });
});

describe('Pinterest: a pin whose answer was lost', () => {
  const pin = () => set.connector('pinterest')!;
  const acc = account('pinterest', { externalId: 'b1', displayName: 'lumencoffee · Spring menu', providerData: { boardId: 'b1', username: 'lumencoffee' } });
  beforeEach(() => {
    pinFake.reset();
    pinFake.accessTokens = new Set(['tok']);
    pinFake.pins.clear();
    pinFake.loseNextPinAnswer = false;
  });

  it('is found on the board, without making another; one never made is not', async () => {
    const e = env('tok');
    const inp = input({ placement: 'image_pin', media: [image()], title: 'Spring menu', text: 'Seasonal coffee' });
    const prep = await prepareUntilDone(pin(), inp, acc, e);
    expect(await pin().find!(inp, acc, prep.handle, e)).toBeNull();
    pinFake.loseNextPinAnswer = true;
    await expectError(pin().publish(inp, acc, prep.handle, e), 'transient');
    const found = (await pin().find!(inp, acc, e.saved.at(-1)!, e))!;
    expect(found).toMatchObject({ pinId: [...pinFake.pins.keys()][0], recovered: true });
    expect(pinFake.pins.size).toBe(1);
  });
});

void media;
