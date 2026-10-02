import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { createConnectorSet } from '../src/connectors/registry.js';
import { FakeGoogle } from './fakes/google.js';
import { FakeMeta } from './fakes/meta.js';
import { account, env, expectError, redirect } from './connector-helpers.js';

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

  it("asks a video for a video's figures, without the shares a Video node does not have", async () => {
    meta.posts.set('v-9', { page: '111', kind: 'video', params: { published: 'true' }, comments: [] });
    const m = await set.connector('facebook')!.fetchMetrics!(fb, 'v-9', { objectType: 'video' }, env('page-token-111'), post('video'));
    expect(meta.callsTo(/v-9\/video_insights/)[0]!.query.metric).toBe('total_video_views,total_video_impressions_unique,total_video_avg_time_watched');
    expect(meta.callsTo(/^v-9$/)[0]!.query.fields).not.toMatch(/shares|reactions/);
    expect(m.common).toEqual({ views: 700, reach: 650, likes: 30, comments: 6, avgWatchSeconds: 8.2 });
  });

  it("asks a Reel for a Reel's own figures: plays, people reached, average watch, and shares from its social actions", async () => {
    meta.posts.set('v-10', { page: '111', kind: 'video', params: { published: 'true' }, comments: [] });
    meta.reels.set('v-10', { page: '111', processingPolls: 0 });
    const m = await set.connector('facebook')!.fetchMetrics!(fb, 'v-10', { objectType: 'video' }, env('page-token-111'), post('reel'));
    expect(meta.callsTo(/v-10\/video_insights/)[0]!.query.metric).toBe('fb_reels_total_plays,post_impressions_unique,post_video_avg_time_watched,post_video_social_actions');
    expect(m.common).toEqual({ views: 1500, reach: 1100, likes: 30, comments: 6, shares: 9, avgWatchSeconds: 5.4 });
    // The way it was asked before (a video's metrics of a Reel, and shares on the Video node) is what Meta refuses.
    const asked = async (path: string) => (await fetch(`${meta.url}/v23.0/${path}&access_token=page-token-111`)).json() as Promise<{ error?: { message: string } }>;
    expect((await asked('v-10/video_insights?metric=total_video_views')).error?.message).toContain('valid insights metric');
    expect((await asked('v-10?fields=shares')).error?.message).toContain('nonexisting field (shares)');
  });
});

describe('YouTube numbers', () => {
  it('reads the counts, which YouTube sends as text, as numbers', async () => {
    google.videos.set('vid-1', { id: 'vid-1', snippet: {}, status: {}, bytes: 1, uploaded: true });
    const m = await set.connector('youtube')!.fetchMetrics!(yt, 'vid-1', {}, env('tok'), post('video'));
    expect(m.common).toEqual({ views: 1234, likes: 56, comments: 7 });
    expect(m.note).toContain('Analytics API');
    expect(m.note).toContain('GOOGLE_ANALYTICS');
    // Without the permission switched on, Analytics is never asked.
    expect(google.calls.filter((c) => c.path === '/v2/reports')).toEqual([]);
  });

  it('says a video that is gone is gone', async () => {
    await expectError(set.connector('youtube')!.fetchMetrics!(yt, 'nope', {}, env('tok'), post('video')), 'file_rejected');
  });
});

describe('YouTube watch time, when the Analytics permission is on', () => {
  let withAnalytics: ReturnType<typeof createConnectorSet>;
  const ANALYTICS = 'https://www.googleapis.com/auth/yt-analytics.readonly';
  const UPLOAD = 'https://www.googleapis.com/auth/youtube.upload';
  beforeAll(() => {
    withAnalytics = createConnectorSet(loadConfig({
      NODE_ENV: 'test', SECRET: 'x'.repeat(40), TOKEN_KEY: randomBytes(32).toString('base64'),
      GOOGLE_CLIENT_ID: 'gid', GOOGLE_CLIENT_SECRET: 'gsecret', GOOGLE_OAUTH_URL: `${google.url}/auth`, GOOGLE_TOKEN_URL: `${google.url}/token`,
      YOUTUBE_API_URL: google.url, YOUTUBE_ANALYTICS_URL: google.url, GOOGLE_ANALYTICS: 'true',
    }));
  });
  beforeEach(() => {
    google.analyticsAllowed = true;
    google.analytics.clear();
    google.videos.set('vid-1', { id: 'vid-1', snippet: {}, status: {}, bytes: 1, uploaded: true });
  });
  const read = (scopes?: string[], now = () => new Date('2026-09-10T12:00:00Z')) => {
    const e = env('tok', {}, now);
    if (scopes) e.token = async () => ({ accessToken: 'tok', scopes });
    return withAnalytics.connector('youtube')!.fetchMetrics!(yt, 'vid-1', {}, e, post('video'));
  };

  it('asks for the permission when signing in, and only then', () => {
    const asked = (set: ReturnType<typeof createConnectorSet>) => new URL(set.provider('google')!.authorizeUrl!('s', redirect)).searchParams.get('scope')!.split(' ');
    expect(asked(withAnalytics)).toContain(ANALYTICS);
    expect(asked(withAnalytics)).toContain(UPLOAD);
    expect(asked(set)).not.toContain(ANALYTICS);
  });

  it('adds watch time and the average to the counts, from the day the video went up to today', async () => {
    google.analytics.set('vid-1', { estimatedMinutesWatched: 321, averageViewDuration: 47.5, views: 1200 });
    const m = await read([UPLOAD, ANALYTICS]);
    // Views, likes and comments stay the Data API's; Analytics is a few days behind and says 1200.
    expect(m.common).toEqual({ views: 1234, likes: 56, comments: 7, watchMinutes: 321, avgWatchSeconds: 47.5 });
    expect(m.note).toBeUndefined();
    const q = google.calls.find((c) => c.path === '/v2/reports')!.query;
    expect(q).toMatchObject({ ids: 'channel==MINE', filters: 'video==vid-1', dimensions: 'video', startDate: '2026-09-01', endDate: '2026-09-10' });
    expect(google.calls.find((c) => c.path === '/v2/reports')!.headers.authorization).toBe('Bearer tok');
    expect((m.raw as { analytics: unknown }).analytics).toMatchObject({ rows: [['vid-1', 321, 47.5, 1200]] });
  });

  it('asks when the grant is not known, and reads the answer', async () => {
    google.analytics.set('vid-1', { estimatedMinutesWatched: 10, averageViewDuration: 5, views: 3 });
    expect((await read()).common.watchMinutes).toBe(10);
  });

  it('says so, and does not ask Analytics, for a connection made without the permission', async () => {
    google.analytics.set('vid-1', { estimatedMinutesWatched: 10, averageViewDuration: 5, views: 3 });
    const m = await read([UPLOAD]);
    expect(m.common).toEqual({ views: 1234, likes: 56, comments: 7 });
    expect(m.note).toMatch(/connect the channel again/i);
    expect(google.calls.filter((c) => c.path === '/v2/reports')).toEqual([]);
  });

  it('keeps the counts and says why when Google refuses the permission after all', async () => {
    google.analyticsAllowed = false;
    const m = await read([UPLOAD, ANALYTICS]);
    expect(m.common).toEqual({ views: 1234, likes: 56, comments: 7 });
    expect(m.note).toMatch(/Watch time is missing/);
    expect(m.note).toMatch(/connect the channel again/i);
  });

  it('keeps the counts and says why when Google refuses the question', async () => {
    google.fail((p) => p === '/v2/reports', { error: { code: 400, message: 'Unknown identifier (x)', errors: [{ reason: 'badRequest' }] } }, 400);
    const m = await read([UPLOAD, ANALYTICS]);
    expect(m.common).toEqual({ views: 1234, likes: 56, comments: 7 });
    expect(m.note).toMatch(/Watch time is missing.*Unknown identifier/);
  });

  it('says it is too early when Analytics has no row for the video yet', async () => {
    const m = await read([UPLOAD, ANALYTICS]);
    expect(m.common).toEqual({ views: 1234, likes: 56, comments: 7 });
    expect(m.note).toMatch(/no figures for this video yet/);
  });

  it('does not take a reading for a busy or failing Analytics API: it is tried again later', async () => {
    google.fail((p) => p === '/v2/reports', { error: { code: 503, message: 'Backend Error', errors: [{ reason: 'backendError' }] } }, 503);
    await expectError(read([UPLOAD, ANALYTICS]), 'transient');
    google.fail((p) => p === '/v2/reports', google.quotaError(), 403);
    await expectError(read([UPLOAD, ANALYTICS]), 'rate_limit');
  });

  it('keeps the counts, and says so, when Analytics answers in a shape nobody expected', async () => {
    google.fail((p) => p === '/v2/reports', { columnHeaders: 'none', rows: [['vid-1', 1]] }, 200);
    const m = await read([UPLOAD, ANALYTICS]);
    expect(m.common).toEqual({ views: 1234, likes: 56, comments: 7 });
    expect(m.note).toMatch(/Watch time is missing.*does not understand/);
  });

  it('reads a video that went up today (the first and last day are the same)', async () => {
    google.publishedAt = '2026-09-10T08:00:00Z';
    google.analytics.set('vid-1', { estimatedMinutesWatched: 2, averageViewDuration: 30, views: 4 });
    try {
      expect((await read([UPLOAD, ANALYTICS])).common.watchMinutes).toBe(2);
    } finally {
      google.publishedAt = '2026-09-01T10:00:00Z';
    }
  });

  it('reads watch time from the columns by name, wherever they are', async () => {
    google.analytics.set('vid-1', { estimatedMinutesWatched: 5, averageViewDuration: 6, views: 7 });
    // The same numbers with the columns in another order and an extra one: reading by position would swap them.
    google.fail((p) => p === '/v2/reports', {
      columnHeaders: [{ name: 'video' }, { name: 'subscribersGained' }, { name: 'averageViewDuration' }, { name: 'estimatedMinutesWatched' }],
      rows: [['vid-1', 9, 61, 777]],
    }, 200);
    const m = await read([UPLOAD, ANALYTICS]);
    expect(m.common.watchMinutes).toBe(777);
    expect(m.common.avgWatchSeconds).toBe(61);
  });
});
