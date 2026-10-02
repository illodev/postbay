import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { createConnectorSet } from '../src/connectors/registry.js';
import { FakeGoogle } from './fakes/google.js';
import { FakeMeta } from './fakes/meta.js';
import { account, env, expectError } from './connector-helpers.js';

const meta = new FakeMeta();
const google = new FakeGoogle();
let set: ReturnType<typeof createConnectorSet>;
const post = (placement: string) => ({ publishedAt: new Date(), placement });
const ig = account('instagram', { externalId: '222', providerData: { igUserId: '222', pageId: '111' } });
const fb = account('facebook', { externalId: '111', providerData: { pageId: '111' } });
const yt = account('youtube', { externalId: 'UC-lumen', providerData: { channelId: 'UC-lumen', audited: true } });

beforeAll(async () => {
  await meta.start();
  await google.start();
  set = createConnectorSet(loadConfig({
    NODE_ENV: 'test', SECRET: 'x'.repeat(40), TOKEN_KEY: randomBytes(32).toString('base64'),
    META_APP_ID: 'app', META_APP_SECRET: 'secret', META_GRAPH_URL: meta.url, META_OAUTH_URL: meta.url,
    GOOGLE_CLIENT_ID: 'gid', GOOGLE_CLIENT_SECRET: 'gsecret', GOOGLE_OAUTH_URL: `${google.url}/auth`, GOOGLE_TOKEN_URL: `${google.url}/token`, YOUTUBE_API_URL: google.url,
  }));
  google.accessTokens.add('tok');
});
afterAll(async () => {
  await meta.stop();
  await google.stop();
});
beforeEach(() => {
  meta.calls.length = 0;
  google.calls.length = 0;
  meta.insightsPermission = true;
  meta.media.clear();
  meta.posts.clear();
  google.videos.clear();
});

const igMedia = (id: string, media_type: string) => meta.media.set(id, { params: { media_type }, comments: [], kind: 'ig' });

describe('Instagram numbers', () => {
  it('asks a Reel for its own set and converts the watch time to seconds', async () => {
    igMedia('m-1', 'REELS');
    const m = await set.connector('instagram')!.fetchMetrics!(ig, 'm-1', {}, env('page-token-111'), post('reel'));
    expect(meta.callsTo(/m-1\/insights/)[0]!.query.metric).toBe('views,reach,likes,comments,saved,shares,ig_reels_avg_watch_time');
    expect(m.common).toEqual({ views: 2000, reach: 1500, likes: 120, comments: 14, shares: 22, saves: 30, avgWatchSeconds: 6.5 });
    expect(m.note).toContain('48 hours');
  });

  it("asks a story for the story set, counts its replies as comments, and says it can only be read for a day", async () => {
    igMedia('m-2', 'STORIES');
    const m = await set.connector('instagram')!.fetchMetrics!(ig, 'm-2', {}, env('page-token-111'), post('story'));
    expect(meta.callsTo(/m-2\/insights/)[0]!.query.metric).toBe('views,reach,replies,shares,navigation');
    expect(m.common).toEqual({ views: 2000, reach: 1500, comments: 5, shares: 22 });
    expect(m.common.likes).toBeUndefined(); // a story has no likes: nothing is made up
    expect(m.note).toContain('24 hours');
  });

  it('asks a photo or a carousel for the figures they have, without watch time', async () => {
    igMedia('m-3', 'IMAGE');
    const m = await set.connector('instagram')!.fetchMetrics!(ig, 'm-3', {}, env('page-token-111'), post('feed_image'));
    expect(meta.callsTo(/m-3\/insights/)[0]!.query.metric).toBe('views,reach,likes,comments,saved,shares');
    expect('avgWatchSeconds' in m.common).toBe(false);
  });

  it('reports a connection made before insights were asked for as an auth failure, so the service can say so', async () => {
    igMedia('m-4', 'REELS');
    meta.insightsPermission = false;
    await expectError(set.connector('instagram')!.fetchMetrics!(ig, 'm-4', {}, env('page-token-111'), post('reel')), 'auth');
  });
});

describe('Facebook numbers', () => {
  it('reads reactions, comments and shares of a post, and the views of its media', async () => {
    meta.posts.set('111_5', { page: '111', kind: 'post', params: { published: 'true' }, comments: [] });
    const m = await set.connector('facebook')!.fetchMetrics!(fb, '111_5', { objectType: 'post' }, env('page-token-111'), post('photo'));
    expect(meta.callsTo(/111_5\/insights/)[0]!.query.metric).toBe('post_media_view');
    expect(m.common).toEqual({ views: 900, likes: 41, comments: 6, shares: 3 });
  });

  it('asks about a video or a Reel as a video, and converts its average watch time', async () => {
    meta.posts.set('v-9', { page: '111', kind: 'video', params: { published: 'true' }, comments: [] });
    const m = await set.connector('facebook')!.fetchMetrics!(fb, 'v-9', { objectType: 'video' }, env('page-token-111'), post('reel'));
    expect(meta.callsTo(/v-9\/video_insights/)[0]!.query.metric).toBe('total_video_views,total_video_avg_time_watched');
    expect(m.common).toEqual({ views: 700, likes: 41, comments: 6, shares: 3, avgWatchSeconds: 8.2 });
  });
});

describe('YouTube numbers', () => {
  it('reads the counts, which YouTube sends as text, as numbers', async () => {
    google.videos.set('vid-1', { id: 'vid-1', snippet: {}, status: {}, bytes: 1, uploaded: true });
    const m = await set.connector('youtube')!.fetchMetrics!(yt, 'vid-1', {}, env('tok'), post('video'));
    expect(m.common).toEqual({ views: 1234, likes: 56, comments: 7 });
    expect(m.note).toContain('Analytics API');
  });

  it('says a video that is gone is gone', async () => {
    await expectError(set.connector('youtube')!.fetchMetrics!(yt, 'nope', {}, env('tok'), post('video')), 'file_rejected');
  });
});
