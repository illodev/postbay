import { randomBytes } from 'node:crypto';
import { Readable } from 'node:stream';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { createMetaOAuth } from '../src/connectors/meta/oauth.js';
import { createConnectorSet } from '../src/connectors/registry.js';
import { ConnectorError, type Account, type Connector, type ConnectorEnv, type Handle, type MediaItem, type PublishInput } from '../src/connectors/types.js';
import { FakeGoogle } from './fakes/google.js';
import { FakeMeta } from './fakes/meta.js';

const meta = new FakeMeta();
const google = new FakeGoogle();
let set: ReturnType<typeof createConnectorSet>;
const redirect = 'http://app.test/api/oauth/callback';

beforeAll(async () => {
  await meta.start();
  await google.start();
  set = createConnectorSet(
    loadConfig({
      NODE_ENV: 'test', SECRET: 'x'.repeat(40), TOKEN_KEY: randomBytes(32).toString('base64'),
      META_APP_ID: 'app', META_APP_SECRET: 'secret', META_GRAPH_URL: meta.url, META_OAUTH_URL: meta.url,
      GOOGLE_CLIENT_ID: 'gid', GOOGLE_CLIENT_SECRET: 'gsecret', GOOGLE_OAUTH_URL: `${google.url}/auth`, GOOGLE_TOKEN_URL: `${google.url}/token`, YOUTUBE_API_URL: google.url,
    }),
  );
});
afterAll(async () => {
  await meta.stop();
  await google.stop();
});
beforeEach(() => {
  meta.calls.length = 0;
  google.calls.length = 0;
  meta.processingPolls = 1;
  meta.igQuota = { usage: 0, total: 50 };
  meta.now = () => Date.now();
  google.now = () => Date.now();
  google.audited = false;
  google.videos.clear();
  google.rejection = null;
  google.publishDelayMs = 0;
});

// ───────────────────────────── helpers ─────────────────────────────

function media(over: Partial<MediaItem> = {}): MediaItem {
  return { kind: 'video', position: 0, name: 'reel.mp4', mime: 'video/mp4', bytes: 1000, width: 1080, height: 1920, durationMs: 20_000, key: 'k/reel.mp4', url: 'https://media.test/reel.mp4?sig=1', ...over };
}
function input(over: Partial<PublishInput> = {}): PublishInput {
  return { publicationId: 'pub-1', placement: 'reel', title: 'Spring menu', text: 'Our spring menu is here', firstComment: '', options: {}, scheduledAt: new Date(Date.now() + 3600_000), aiGenerated: false, media: [media()], ...over };
}
const igAccount: Account = { id: 'a1', network: 'instagram', externalId: '222', displayName: '@lumen.coffee', providerData: { igUserId: '222', pageId: '111' } };
const fbAccount: Account = { id: 'a2', network: 'facebook', externalId: '111', displayName: 'Lumen Coffee', providerData: { pageId: '111' } };
const ytAccount = (audited = false): Account => ({ id: 'a3', network: 'youtube', externalId: 'UC-lumen', displayName: 'Lumen Coffee TV', providerData: { channelId: 'UC-lumen', audited } });

function env(token: string, files: Record<string, Buffer> = {}, now = () => new Date()): ConnectorEnv & { saved: Handle[] } {
  const saved: Handle[] = [];
  return {
    saved,
    token: async () => ({ accessToken: token }),
    now,
    log: { info: () => {}, warn: () => {} },
    open: async (key, start = 0) => {
      const buf = files[key] ?? Buffer.alloc(0);
      return { stream: Readable.from(buf.subarray(start)), size: buf.length };
    },
    persist: async (h) => { saved.push(h); },
  };
}

const get = (n: 'instagram' | 'facebook' | 'youtube'): Connector => set.connector(n)!;

async function expectError(p: Promise<unknown>, cls: string): Promise<ConnectorError> {
  try {
    await p;
  } catch (err) {
    expect(err).toBeInstanceOf(ConnectorError);
    expect((err as ConnectorError).errorClass).toBe(cls);
    return err as ConnectorError;
  }
  throw new Error(`expected a ${cls} error, but nothing was thrown`);
}

// ───────────────────────────── Meta sign-in ─────────────────────────────

describe('Meta sign-in', () => {
  it('builds the Facebook Login address with the scopes publishing needs and the state it was given', () => {
    const u = new URL(set.provider('meta')!.authorizeUrl!('state-123', redirect));
    expect(u.searchParams.get('client_id')).toBe('app');
    expect(u.searchParams.get('state')).toBe('state-123');
    expect(u.searchParams.get('redirect_uri')).toBe(redirect);
    expect(u.searchParams.get('scope')).toContain('instagram_content_publish');
    expect(u.searchParams.get('scope')).toContain('pages_manage_posts');
    // Reading the numbers is always asked for; messaging people only when the brand has prizes on.
    expect(u.searchParams.get('scope')).toContain('instagram_manage_insights');
    expect(u.searchParams.get('scope')).not.toContain('messages');
    const withPrizes = new URL(set.provider('meta')!.authorizeUrl!('state-xyz', redirect, { prizes: true }));
    expect(withPrizes.searchParams.get('scope')).toContain('instagram_manage_messages');
    expect(withPrizes.searchParams.get('scope')).toContain('pages_messaging');
  });

  it('signs in with a Facebook Login for Business configuration when one is set, instead of a list of permissions', () => {
    const oauth = createMetaOAuth({ graphUrl: meta.url, oauthUrl: meta.url, version: 'v23.0', appId: 'app', appSecret: 'secret', loginConfigId: 'cfg-1', loginConfigIdPrizes: 'cfg-2' });
    const u = new URL(oauth.authorizeUrl!('st', redirect));
    expect(u.searchParams.get('config_id')).toBe('cfg-1');
    expect(u.searchParams.get('scope')).toBeNull();
    expect(u.searchParams.get('response_type')).toBe('code');
    expect(new URL(oauth.authorizeUrl!('st', redirect, { prizes: true })).searchParams.get('config_id')).toBe('cfg-2');
    const one = createMetaOAuth({ graphUrl: meta.url, oauthUrl: meta.url, version: 'v23.0', appId: 'app', appSecret: 'secret', loginConfigId: 'cfg-1' });
    expect(new URL(one.authorizeUrl!('st', redirect, { prizes: true })).searchParams.get('config_id')).toBe('cfg-1');
    // Without one, the permissions are listed, the Page's comment permission among them.
    expect(new URL(set.provider('meta')!.authorizeUrl!('st', redirect)).searchParams.get('scope')).toContain('pages_manage_engagement');
  });

  it('turns one sign-in into a Facebook Page and its Instagram account, with a token that does not expire', async () => {
    const found = await set.provider('meta')!.exchange!('code-1', redirect);
    expect(found.map((c) => [c.network, c.externalId, c.displayName])).toEqual([
      ['facebook', '111', 'Lumen Coffee'],
      ['instagram', '222', '@lumen.coffee'],
    ]);
    expect(found[0]!.token.accessToken).toBe('page-token-111');
    expect(found[0]!.token.expiresAt).toBeUndefined();
    expect(found[1]!.providerData.pageId).toBe('111');
    // The user token was swapped for a long-lived one before Pages were listed.
    expect(meta.callsTo(/^me\/accounts$/)[0]!.query.access_token).toBe('long-user');
    expect(found[0]!.providerData.dataAccessExpiresAt).toMatch(/^\d{4}-/);
  });

  it('flags the permissions the person did not grant', async () => {
    meta.grantedScopes = ['pages_show_list', 'pages_read_engagement', 'instagram_basic'];
    try {
      const found = await set.provider('meta')!.exchange!('code-2', redirect);
      // pages_manage_engagement is what the Page's first comment needs.
      expect(found[0]!.providerData.missingScopes).toEqual(['pages_manage_posts', 'pages_manage_engagement']);
      expect(found[1]!.providerData.missingScopes).toEqual(['instagram_content_publish']);
    } finally {
      meta.grantedScopes = ['pages_show_list', 'pages_read_engagement', 'pages_manage_posts', 'pages_manage_engagement', 'instagram_basic', 'instagram_content_publish'];
    }
  });

  it('says so plainly when the code is refused or no Page can be published to', async () => {
    await expectError(set.provider('meta')!.exchange!('bad', redirect), 'file_rejected');
    const saved = meta.pages;
    meta.pages = [];
    try {
      const e = await expectError(set.provider('meta')!.exchange!('code-3', redirect), 'auth');
      expect(e.message).toMatch(/Page/);
    } finally {
      meta.pages = saved;
    }
  });
});

// ───────────────────────────── Instagram ─────────────────────────────

describe('Instagram', () => {
  const ig = () => get('instagram');
  const e = () => env('page-token-111');

  it('publishes a Reel: checks the cap, makes a container, waits for it, publishes, and posts the first comment', async () => {
    const en = e();
    const inp = input({ firstComment: 'Link in bio', aiGenerated: true, media: [media(), media({ kind: 'cover', name: 'c.jpg', mime: 'image/jpeg', url: 'https://media.test/cover.jpg' })] });
    let r = await ig().prepare(inp, igAccount, {}, en);
    expect(r.done).toBe(false); // the container is still processing
    expect(r.retryAfterSec).toBe(60); // Meta: ask about a container no more than once a minute
    r = await ig().prepare(inp, igAccount, r.handle, en);
    expect(r.done).toBe(true);

    const create = meta.callsTo(/^222\/media$/, 'POST')[0]!;
    expect(create.body).toMatchObject({ media_type: 'REELS', video_url: 'https://media.test/reel.mp4?sig=1', caption: 'Our spring menu is here', share_to_feed: 'true', is_ai_generated: 'true', cover_url: 'https://media.test/cover.jpg' });
    expect(meta.callsTo(/content_publishing_limit/)).toHaveLength(1); // read once, not on every poll
    expect(meta.callsTo(/^222\/media$/, 'POST')).toHaveLength(1); // the container is not created again on the second call

    const pub = await ig().publish(inp, igAccount, r.handle, en);
    expect(pub.externalId).toMatch(/^m-/);
    expect(pub.url).toContain('instagram.com');
    expect(meta.media.get(pub.externalId)!.comments).toEqual(['Link in bio']);
  });

  it('never publishes twice if asked to publish again', async () => {
    const en = e();
    const inp = input();
    let h: Handle = {};
    for (;;) {
      const r = await ig().prepare(inp, igAccount, h, en);
      h = r.handle;
      if (r.done) break;
    }
    const first = await ig().publish(inp, igAccount, h, en);
    const handleAfter = en.saved.at(-1)!;
    expect(handleAfter.mediaId).toBe(first.externalId);
    const again = await ig().publish(inp, igAccount, handleAfter, en);
    expect(again.externalId).toBe(first.externalId);
    expect(meta.callsTo(/media_publish/)).toHaveLength(1);
  });

  it('does not let a refused first comment undo a post that is already live', async () => {
    const en = e();
    const inp = input({ firstComment: 'Hello' });
    let h: Handle = {};
    for (;;) { const r = await ig().prepare(inp, igAccount, h, en); h = r.handle; if (r.done) break; }
    meta.fail((c) => /\/comments$/.test(c.path), meta.err(10, 'Permission denied'), 400);
    const pub = await ig().publish(inp, igAccount, h, en);
    expect(pub.externalId).toMatch(/^m-/);
    expect(en.saved.at(-1)!.firstCommentError).toMatch(/Permission denied/);
  });

  it('builds a carousel from one container per item', async () => {
    const en = e();
    const inp = input({
      placement: 'carousel',
      media: [media({ kind: 'image', position: 0, url: 'https://media.test/1.jpg', mime: 'image/jpeg' }), media({ kind: 'video', position: 1, url: 'https://media.test/2.mp4' }), media({ kind: 'image', position: 2, url: 'https://media.test/3.jpg', mime: 'image/jpeg' })],
    });
    let h: Handle = {};
    for (let i = 0; i < 6; i++) { const r = await ig().prepare(inp, igAccount, h, en); h = r.handle; if (r.done) break; }
    const creates = meta.callsTo(/^222\/media$/, 'POST');
    expect(creates).toHaveLength(4);
    expect(creates.slice(0, 3).every((c) => c.body.is_carousel_item === 'true')).toBe(true);
    expect(creates[1]!.body.media_type).toBe('VIDEO');
    expect(creates[3]!.body).toMatchObject({ media_type: 'CAROUSEL' });
    expect(creates[3]!.body.children!.split(',')).toHaveLength(3);
  });

  it('asks about a container once a minute for five looks, then every five minutes', async () => {
    const en = e();
    meta.processingPolls = 8;
    let h: Handle = {};
    const waits: number[] = [];
    for (let i = 0; i < 10; i++) {
      const r = await ig().prepare(input(), igAccount, h, en);
      h = r.handle;
      if (r.done) break;
      waits.push(r.retryAfterSec!);
    }
    expect(waits).toEqual([60, 60, 60, 60, 60, 300, 300, 300]);
    expect(meta.callsTo(/^c-\d+$/)).toHaveLength(9); // one look per call, never a burst
  });

  it('discloses AI use on the carousel itself, never on its items', async () => {
    const en = e();
    const inp = input({ placement: 'carousel', aiGenerated: true, media: [media({ kind: 'image', position: 0, mime: 'image/jpeg' }), media({ kind: 'image', position: 1, mime: 'image/jpeg' })] });
    let h: Handle = {};
    for (let i = 0; i < 6; i++) { const r = await ig().prepare(inp, igAccount, h, en); h = r.handle; if (r.done) break; }
    const creates = meta.callsTo(/^222\/media$/, 'POST');
    expect(creates.slice(0, 2).every((c) => c.body.is_ai_generated === undefined)).toBe(true);
    expect(creates[2]!.body).toMatchObject({ media_type: 'CAROUSEL', is_ai_generated: 'true' });
  });

  it('refuses before sending anything when the account has used its publishing cap', async () => {
    meta.igQuota = { usage: 50, total: 50 };
    const err = await expectError(ig().prepare(input(), igAccount, {}, e()), 'rate_limit');
    expect(err.message).toMatch(/50 of 50/);
    expect(err.retryAfterSec).toBe(86400);
    expect(meta.callsTo(/^222\/media$/, 'POST')).toHaveLength(0);
  });

  it('classifies what Meta answers', async () => {
    await expectError(ig().prepare(input(), igAccount, {}, env('revoked-token')), 'auth');
    meta.fail((c) => /content_publishing_limit/.test(c.path), meta.err(1, 'An unknown error occurred'), 500);
    await expectError(ig().prepare(input(), igAccount, {}, e()), 'transient');
    meta.fail((c) => /content_publishing_limit/.test(c.path), meta.err(4, 'Application request limit reached'), 400, 1, { 'x-business-use-case-usage': JSON.stringify({ '222': [{ estimated_time_to_regain_access: 7 }] }) });
    const rl = await expectError(ig().prepare(input(), igAccount, {}, e()), 'rate_limit');
    expect(rl.retryAfterSec).toBe(420);
    meta.fail((c) => /^222\/media$/.test(c.path), meta.err(100, 'Invalid parameter', { error_subcode: 2207026, error_user_msg: 'The video format is not supported' }), 400);
    const fr = await expectError(ig().prepare(input(), igAccount, {}, e()), 'file_rejected');
    expect(fr.message).toBe('The video format is not supported');
    // Tokens never end up in the details kept on an error.
    expect(JSON.stringify(fr.detail)).not.toContain('page-token');
  });

  it('fails a container Meta could not process, without retrying it', async () => {
    const en = e();
    const r = await ig().prepare(input(), igAccount, {}, en);
    const cid = (r.handle.containerId as string);
    meta.containers.get(cid)!.state = 'ERROR';
    await expectError(ig().prepare(input(), igAccount, r.handle, en), 'file_rejected');
  });

  it('starts over when a container has expired', async () => {
    const en = e();
    const r = await ig().prepare(input(), igAccount, {}, en);
    meta.containers.get(r.handle.containerId as string)!.state = 'EXPIRED';
    const again = await ig().prepare(input(), igAccount, r.handle, en);
    expect(again.done).toBe(false);
    expect(again.handle.containerId).toBeUndefined();
  });

  it('verifies a post is there, and says "unknown" if Meta no longer has it', async () => {
    const en = e();
    let h: Handle = {};
    for (;;) { const r = await ig().prepare(input(), igAccount, h, en); h = r.handle; if (r.done) break; }
    const pub = await ig().publish(input(), igAccount, h, en);
    expect((await ig().verify(igAccount, pub.externalId, h, en)).visibility).toBe('public');
    expect((await ig().verify(igAccount, 'm-9999', h, en)).visibility).toBe('unknown');
  });

  it('checks a publication against what Instagram allows', () => {
    const codes = (i: PublishInput) => ig().validate(i, igAccount).map((x) => `${x.severity}:${x.code}`);
    expect(codes(input())).toEqual([]);
    expect(codes(input({ text: 'x'.repeat(2201) }))).toContain('error:text.length');
    expect(codes(input({ text: Array.from({ length: 31 }, (_, i) => `#tag${i}`).join(' ') }))).toContain('error:text.hashtags');
    expect(codes(input({ text: Array.from({ length: 21 }, (_, i) => `@user${i}`).join(' ') }))).toContain('error:text.mentions');
    expect(codes(input({ media: [media({ width: 1920, height: 1080 })] }))).toContain('warning:media.aspect.recommended');
    expect(codes(input({ media: [media({ durationMs: 1000 })] }))).toContain('error:media.duration');
    expect(codes(input({ placement: 'story', text: 'caption' }))).toContain('warning:story.text');
    // A story video runs 3 to 60 seconds; a video in a carousel is held to a Reel's length, with a warning past a minute.
    expect(codes(input({ placement: 'story', text: '', media: [media({ durationMs: 2000 })] }))).toContain('error:media.duration');
    expect(codes(input({ placement: 'story', text: '', media: [media({ durationMs: 3000 })] }))).toEqual([]);
    const carousel = (ms: number) => input({ placement: 'carousel', media: [media({ kind: 'image', width: 1080, height: 1080 }), media({ position: 1, width: 1080, height: 1080, durationMs: ms })] });
    expect(codes(carousel(2000))).toContain('error:media.duration');
    expect(codes(carousel(30_000))).toEqual([]);
    expect(codes(carousel(90_000))).toEqual(['warning:carousel.video.length']);
    expect(codes(carousel(16 * 60_000))).toContain('error:media.duration');
    expect(codes(input({ placement: 'feed_image', media: [media({ kind: 'image', width: 1080, height: 1920 })] }))).toContain('error:media.aspect');
    expect(codes(input({ placement: 'carousel', media: [media({ kind: 'image', width: 1000, height: 1000 })] }))).toContain('error:media.count');
    expect(codes(input({ placement: 'nope' }))).toContain('error:placement.unknown');
  });

  it('picks a sensible placement by default', () => {
    const p = (pieceKind: string, format: string, kinds: ('video' | 'image' | 'pdf')[]) => ig().defaultPlacement({ pieceKind, format, media: kinds.map((kind) => ({ kind })) });
    expect(p('video', '9:16', ['video'])).toBe('reel');
    expect(p('post', '4:5', ['image'])).toBe('feed_image');
    expect(p('carousel', 'carousel', ['image', 'image'])).toBe('carousel');
    expect(p('story', '9:16', ['image'])).toBe('story');
    expect(p('pdf', 'document', ['pdf'])).toBeNull();
  });
});

// ───────────────────────────── Facebook ─────────────────────────────

describe('Facebook Page', () => {
  const fb = () => get('facebook');
  const e = (now = () => new Date()) => env('page-token-111', {}, now);

  it('holds a photo post natively for the scheduled time, and posts the first comment once it is live', async () => {
    const en = e();
    const when = new Date(Date.now() + 2 * 3600_000);
    const inp = input({ placement: 'photo', scheduledAt: when, firstComment: 'More at the link', media: [media({ kind: 'image', mime: 'image/jpeg', url: 'https://media.test/p.jpg' })] });
    const r = await fb().prepare(inp, fbAccount, {}, en);
    expect(r).toMatchObject({ done: true, nativeScheduled: true });
    const create = meta.callsTo(/^111\/photos$/, 'POST')[0]!;
    expect(create.body).toMatchObject({ url: 'https://media.test/p.jpg', caption: 'Our spring menu is here', published: 'false', scheduled_publish_time: String(Math.floor(when.getTime() / 1000)) });

    const pub = await fb().publish(inp, fbAccount, r.handle, en);
    expect(pub.externalId).toMatch(/^111_/);
    expect(pub.url).toMatch(/^https:\/\/www\.facebook\.com\//);
    expect(meta.callsTo(/\/photos$/, 'POST')).toHaveLength(1); // publishing a held post sends nothing

    expect((await fb().verify(fbAccount, pub.externalId, r.handle, en)).visibility).toBe('scheduled');
    meta.now = () => when.getTime() + 60_000;
    const live = await fb().verify(fbAccount, pub.externalId, r.handle, en);
    expect(live.visibility).toBe('public');
    expect(live.handle?.commentId).toBeDefined();
    expect(meta.posts.get(pub.externalId)!.comments).toEqual(['More at the link']);
    // Once the comment is in the handle, verifying again does not comment twice.
    await fb().verify(fbAccount, pub.externalId, live.handle!, en);
    expect(meta.posts.get(pub.externalId)!.comments).toHaveLength(1);
  });

  it('posts at once when too little time is left to hold it natively', async () => {
    const en = e();
    const inp = input({ placement: 'photo', scheduledAt: new Date(Date.now() + 3 * 60_000), media: [media({ kind: 'image', mime: 'image/jpeg', url: 'https://media.test/p.jpg' })] });
    const r = await fb().prepare(inp, fbAccount, {}, en);
    expect(r).toMatchObject({ done: true });
    expect(r.nativeScheduled).toBeUndefined();
    expect(meta.callsTo(/\/photos$/, 'POST')).toHaveLength(0);
    const pub = await fb().publish(inp, fbAccount, r.handle, en);
    expect(meta.callsTo(/\/photos$/, 'POST')[0]!.body.published).toBe('true');
    expect((await fb().verify(fbAccount, pub.externalId, r.handle, en)).visibility).toBe('public');
  });

  it('makes a multi-photo post from unpublished photos', async () => {
    const en = e();
    const inp = input({ placement: 'photos', scheduledAt: new Date(Date.now() + 3600_000), media: [0, 1, 2].map((i) => media({ kind: 'image', position: i, mime: 'image/jpeg', url: `https://media.test/${i}.jpg` })) });
    const r = await fb().prepare(inp, fbAccount, {}, en);
    expect(r.done).toBe(true);
    const photos = meta.callsTo(/\/photos$/, 'POST');
    expect(photos).toHaveLength(3);
    expect(photos.every((c) => c.body.published === 'false')).toBe(true);
    const feed = meta.callsTo(/^111\/feed$/, 'POST')[0]!;
    expect(feed.body['attached_media[0]']).toContain('media_fbid');
    expect(feed.body['attached_media[2]']).toContain('media_fbid');
    expect(feed.body.published).toBe('false');
    // Photos used in a scheduled post have to be temporary (Meta's Page Photos reference), and the post says it is scheduled.
    expect(photos.every((c) => c.body.temporary === 'true')).toBe(true);
    expect(feed.body.unpublished_content_type).toBe('SCHEDULED');
  });

  it('uploads the photos of an album that goes out at once as plain unpublished photos', async () => {
    const en = e();
    const inp = input({ placement: 'photos', scheduledAt: new Date(Date.now() + 3 * 60_000), media: [0, 1].map((i) => media({ kind: 'image', position: i, mime: 'image/jpeg', url: `https://media.test/${i}.jpg` })) });
    const r = await fb().prepare(inp, fbAccount, {}, en);
    await fb().publish(inp, fbAccount, r.handle, en);
    const photos = meta.callsTo(/\/photos$/, 'POST');
    expect(photos.every((c) => c.body.published === 'false' && c.body.temporary === undefined)).toBe(true);
    expect(meta.callsTo(/^111\/feed$/, 'POST')[0]!.body.published).toBe('true');
  });

  it('says in the history why the first comment was not posted when the Page may not comment', async () => {
    const en = e();
    const inp = input({ placement: 'photo', scheduledAt: new Date(Date.now() + 3 * 60_000), firstComment: 'Hello', media: [media({ kind: 'image', mime: 'image/jpeg', url: 'https://media.test/p.jpg' })] });
    const r = await fb().prepare(inp, fbAccount, {}, en);
    const pub = await fb().publish(inp, fbAccount, r.handle, en);
    const scopes = meta.grantedScopes;
    meta.grantedScopes = scopes.filter((x) => x !== 'pages_manage_engagement');
    try {
      const v = await fb().verify(fbAccount, pub.externalId, en.saved.at(-1)!, en);
      expect(v.visibility).toBe('public'); // the post is live all the same
      expect(v.note).toContain('pages_manage_engagement');
      expect(v.handle!.firstCommentError).toContain('Connect the Page again');
    } finally {
      meta.grantedScopes = scopes;
    }
  });

  it('uploads a Reel in three phases and waits for processing', async () => {
    const en = e();
    const when = new Date(Date.now() + 3600_000);
    const inp = input({ placement: 'reel', scheduledAt: when });
    let r = await fb().prepare(inp, fbAccount, {}, en);
    expect(r.done).toBe(false); // still processing on Facebook's side
    r = await fb().prepare(inp, fbAccount, r.handle, en);
    expect(r).toMatchObject({ done: true, nativeScheduled: true });
    const phases = meta.callsTo(/video_reels$/, 'POST').map((c) => c.body.upload_phase);
    expect(phases).toEqual(['start', 'finish']);
    const upload = meta.calls.find((c) => /^rupload/.test(c.path))!;
    expect(upload.headers.file_url).toBe('https://media.test/reel.mp4?sig=1');
    expect(upload.headers.authorization).toBe('OAuth page-token-111');
    expect(meta.callsTo(/video_reels$/, 'POST')[1]!.body).toMatchObject({ video_state: 'SCHEDULED', scheduled_publish_time: String(Math.floor(when.getTime() / 1000)) });
  });

  it('classifies failures', async () => {
    const photo = input({ placement: 'photo', media: [media({ kind: 'image', mime: 'image/jpeg' })] });
    await expectError(fb().prepare(photo, fbAccount, {}, env('revoked')), 'auth');
    meta.fail((c) => /photos$/.test(c.path), meta.err(190, 'Error validating access token'), 400);
    await expectError(fb().prepare(photo, fbAccount, {}, e()), 'auth');
    meta.fail((c) => /photos$/.test(c.path), meta.err(32, 'Page request limit reached'), 400);
    await expectError(fb().prepare(photo, fbAccount, {}, e()), 'rate_limit');
    meta.fail((c) => /photos$/.test(c.path), meta.err(100, 'Invalid image'), 400);
    await expectError(fb().prepare(photo, fbAccount, {}, e()), 'file_rejected');
    meta.fail((c) => /photos$/.test(c.path), { error: { message: 'Service unavailable' } }, 503);
    await expectError(fb().prepare(photo, fbAccount, {}, e()), 'transient');
  });

  it('leaves Stories and PDFs to a person', () => {
    const p = (pieceKind: string, format: string, kinds: ('video' | 'image' | 'pdf')[]) => fb().defaultPlacement({ pieceKind, format, media: kinds.map((kind) => ({ kind })) });
    expect(p('story', '9:16', ['video'])).toBeNull();
    expect(p('pdf', 'document', ['pdf'])).toBeNull();
    expect(p('video', '9:16', ['video'])).toBe('reel');
    expect(p('video', '16:9', ['video'])).toBe('video');
    expect(p('carousel', 'carousel', ['image', 'image'])).toBe('photos');
    expect(p('carousel', 'carousel', ['image', 'video'])).toBeNull();
  });

  it('holds Reels to 3–90 seconds', () => {
    const codes = (d: number) => fb().validate(input({ media: [media({ durationMs: d })] }), fbAccount).map((x) => x.code);
    expect(codes(120_000)).toContain('media.duration');
    expect(codes(2000)).toContain('media.duration');
    expect(codes(30_000)).toEqual([]);
  });
});

// ───────────────────────────── YouTube ─────────────────────────────

describe('Google sign-in', () => {
  it('asks for offline access and a forced consent screen so a refresh token comes back', () => {
    const u = new URL(set.provider('google')!.authorizeUrl!('s1', redirect));
    expect(u.searchParams.get('access_type')).toBe('offline');
    expect(u.searchParams.get('prompt')).toBe('consent');
    expect(u.searchParams.get('scope')).toContain('youtube.upload');
    expect(u.searchParams.get('state')).toBe('s1');
  });

  it('finds the channel and keeps both tokens', async () => {
    const found = await set.provider('google')!.exchange!('good', redirect);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ network: 'youtube', externalId: 'UC-lumen', displayName: 'Lumen Coffee TV' });
    expect(found[0]!.token.refreshToken).toBe('refresh-1');
    expect(found[0]!.token.expiresAt).toBeDefined();
    expect(found[0]!.providerData.audited).toBe(false);
  });

  it('refuses a sign-in without a refresh token, and a bad code', async () => {
    const e1 = await expectError(set.provider('google')!.exchange!('norefresh', redirect), 'auth');
    expect(e1.message).toMatch(/refresh token/);
    await expectError(set.provider('google')!.exchange!('bad', redirect), 'auth');
  });

  it('refreshes, and says reconnect when Google revoked the grant', async () => {
    const p = set.provider('google')!;
    const t = await p.refresh!({ accessToken: 'old', refreshToken: 'refresh-1' });
    expect(t.accessToken).toMatch(/^access-/);
    expect(t.refreshToken).toBe('refresh-1');
    google.revoked = true;
    try {
      await expectError(p.refresh!({ accessToken: 'old', refreshToken: 'refresh-1' }), 'auth');
    } finally {
      google.revoked = false;
    }
  });
});

describe('YouTube', () => {
  const yt = () => get('youtube');
  let token: string;
  const bytes = randomBytes(300_000);
  beforeEach(async () => {
    token = (await set.provider('google')!.exchange!('good', redirect))[0]!.token.accessToken;
  });
  const files = { 'k/reel.mp4': bytes };
  const vid = (over: Partial<PublishInput> = {}) => input({ placement: 'video', media: [media({ bytes: bytes.length })], ...over });

  it('uploads privately with a publish time, and tells YouTube about AI content', async () => {
    const en = env(token, files);
    const when = new Date(Date.now() + 3600_000);
    const r = await yt().prepare(vid({ scheduledAt: when, aiGenerated: true, text: 'Spring menu #coffee' }), ytAccount(), {}, en);
    expect(r).toMatchObject({ done: true, nativeScheduled: true });
    const rec = google.videos.get(r.handle.videoId as string)!;
    expect(rec.bytes).toBe(bytes.length);
    expect(rec.snippet).toMatchObject({ title: 'Spring menu', description: 'Spring menu #coffee', categoryId: '22' });
    expect(rec.status).toMatchObject({ privacyStatus: 'private', publishAt: when.toISOString(), containsSyntheticMedia: true });
    // Nobody declared whether it is made for kids, so nothing is declared for them: YouTube applies the channel's own setting.
    expect(rec.status).not.toHaveProperty('selfDeclaredMadeForKids');
    const init = google.calls.find((c) => c.path === '/upload/youtube/v3/videos')!;
    expect(init.headers['x-upload-content-length']).toBe(String(bytes.length));
    // The session address was saved the moment YouTube handed it out, before any bytes were sent.
    expect(en.saved[0]!.sessionUrl).toMatch(/\/upload\/session\//);
  });

  it("sends the made-for-kids declaration a person made, or the channel's default", async () => {
    const en = env(token, files);
    const r1 = await yt().prepare(vid({ options: { madeForKids: 'yes' } }), ytAccount(), {}, en);
    expect(google.videos.get(r1.handle.videoId as string)!.status.selfDeclaredMadeForKids).toBe(true);
    const channelSaysNo = { ...ytAccount(), providerData: { ...ytAccount().providerData, madeForKids: false } };
    const r2 = await yt().prepare(vid(), channelSaysNo, {}, en);
    expect(google.videos.get(r2.handle.videoId as string)!.status.selfDeclaredMadeForKids).toBe(false);
    // The publication's own answer wins over the channel's.
    const r3 = await yt().prepare(vid({ options: { madeForKids: 'yes' } }), channelSaysNo, {}, en);
    expect(google.videos.get(r3.handle.videoId as string)!.status.selfDeclaredMadeForKids).toBe(true);
    // The dialog asks, with nothing chosen, unless the channel has a default.
    const field = (a: Account) => yt().capabilities(a).options!.find((o) => o.key === 'madeForKids')!;
    expect(field(ytAccount())).toMatchObject({ type: 'select', required: true });
    expect(field(ytAccount()).default).toBeUndefined();
    expect(field(channelSaysNo).default).toBe('no');
  });

  it('sends a description YouTube accepts: no < or >, and no more than 5,000 bytes', async () => {
    const en = env(token, files);
    const r = await yt().prepare(vid({ text: 'Prices <today> only: 2 > 1' }), ytAccount(), {}, en);
    expect(google.videos.get(r.handle.videoId as string)!.snippet.description).toBe('Prices ‹today› only: 2 › 1');
    // 2,000 characters of "é" are 4,000 bytes; 2,600 are 5,200, which YouTube refuses even though it is under 5,000 characters.
    const codes = (text: string) => yt().validate(vid({ text, options: { madeForKids: 'no' } }), ytAccount(true)).map((x) => `${x.severity}:${x.code}`);
    expect(codes('é'.repeat(2000))).toEqual([]);
    expect(codes('é'.repeat(2600))).toEqual(['error:text.bytes']);
    expect(codes('a < b')).toEqual(['warning:text.angle']);
    // Even if it got that far, what is sent is cut to whole characters under the limit, and the stand-in takes it.
    const long = await yt().prepare(vid({ text: '😀'.repeat(1300) }), ytAccount(), {}, en);
    const sent = google.videos.get(long.handle.videoId as string)!.snippet.description as string;
    expect(Buffer.byteLength(sent)).toBeLessThanOrEqual(5000);
    expect(sent).toBe('😀'.repeat(1250));
  });

  it('carries on from where it stopped when the connection drops mid-upload', async () => {
    const en = env(token, files);
    google.dropAfterBytes = 100_000;
    const r = await yt().prepare(vid(), ytAccount(), {}, en);
    expect(r.done).toBe(true);
    const rec = google.videos.get(r.handle.videoId as string)!;
    expect(rec.bytes).toBe(bytes.length); // every byte arrived exactly once
    const puts = google.calls.filter((c) => c.method === 'PUT' && c.path.startsWith('/upload/session/'));
    expect(puts.length).toBeGreaterThanOrEqual(3); // first try, "how far did you get", the rest
    expect(puts.some((c) => String(c.headers['content-range'] ?? '').startsWith('bytes */'))).toBe(true);
  });

  it('does not upload a second time when asked to prepare again', async () => {
    const en = env(token, files);
    const r = await yt().prepare(vid(), ytAccount(), {}, en);
    const again = await yt().prepare(vid(), ytAccount(), r.handle, en);
    expect(again.handle.videoId).toBe(r.handle.videoId);
    expect(google.videos.size).toBe(1);
  });

  it('makes the video public at once when there is no time left to hold it', async () => {
    const en = env(token, files);
    const r = await yt().prepare(vid({ scheduledAt: new Date(Date.now() + 30_000) }), ytAccount(), {}, en);
    expect(r.nativeScheduled).toBe(false);
    expect(google.videos.get(r.handle.videoId as string)!.status).toMatchObject({ privacyStatus: 'public' });
    expect(google.videos.get(r.handle.videoId as string)!.status.publishAt).toBeUndefined();
  });

  it('reports private until the audit passes, and public on time once it has', async () => {
    const en = env(token, files, () => new Date(google.now()));
    const when = new Date(Date.now() + 3600_000);
    const r = await yt().prepare(vid({ scheduledAt: when }), ytAccount(), {}, en);
    const id = r.handle.videoId as string;
    expect((await yt().verify(ytAccount(), id, r.handle, en)).visibility).toBe('scheduled');
    google.now = () => when.getTime() + 120_000;
    const unaudited = await yt().verify(ytAccount(), id, r.handle, en);
    expect(unaudited.visibility).toBe('private');
    expect(unaudited.note).toMatch(/YouTube Studio/);
    google.audited = true;
    expect((await yt().verify(ytAccount(true), id, r.handle, en)).visibility).toBe('public');
  });

  it('keeps looking for a while when YouTube has not yet made a scheduled video public, instead of calling it private', async () => {
    const en = env(token, files, () => new Date(google.now()));
    const when = new Date(Date.now() + 3600_000);
    const r = await yt().prepare(vid({ scheduledAt: when }), ytAccount(true), {}, en);
    const id = r.handle.videoId as string;
    google.audited = true;
    google.publishDelayMs = 4 * 60_000; // YouTube takes a few minutes past the time
    google.now = () => when.getTime() + 20_000; // the publisher's first look, 20 seconds after the hour
    const early = await yt().verify(ytAccount(true), id, r.handle, en);
    expect(early.visibility).toBe('processing');
    expect(early.note).toMatch(/not made it public yet/);
    google.now = () => when.getTime() + 5 * 60_000;
    expect((await yt().verify(ytAccount(true), id, r.handle, en)).visibility).toBe('public');
    // Held back for good: after 45 minutes it is called private, with words a person can act on.
    google.publishDelayMs = 10 * 3600_000;
    google.now = () => when.getTime() + 46 * 60_000;
    const late = await yt().verify(ytAccount(true), id, r.handle, en);
    expect(late.visibility).toBe('private');
    expect(late.note).toMatch(/45 minutes after its time/);
  });

  it('classifies failures: quota waits for the reset, a revoked grant needs a reconnection', async () => {
    const en = env(token, files);
    google.fail((p) => p === '/upload/youtube/v3/videos', google.quotaError(), 403);
    const q = await expectError(yt().prepare(vid(), ytAccount(), {}, en), 'rate_limit');
    expect(q.retryAfterSec).toBeGreaterThanOrEqual(60);
    expect(q.retryAfterSec).toBeLessThanOrEqual(86400 + 3600);
    await expectError(yt().prepare(vid(), ytAccount(), {}, env('expired-token', files)), 'auth');
    google.fail((p) => p === '/upload/youtube/v3/videos', { error: { code: 400, message: 'Invalid title', errors: [{ reason: 'invalidTitle' }] } }, 400);
    await expectError(yt().prepare(vid(), ytAccount(), {}, en), 'file_rejected');
    google.fail((p) => p === '/upload/youtube/v3/videos', { error: { code: 503, message: 'Backend error', errors: [{ reason: 'backendError' }] } }, 503);
    await expectError(yt().prepare(vid(), ytAccount(), {}, en), 'transient');
  });

  it('refuses a video YouTube rejected after upload', async () => {
    const en = env(token, files);
    const r = await yt().prepare(vid(), ytAccount(), {}, en);
    google.rejection = 'duplicate';
    try {
      const err = await expectError(yt().verify(ytAccount(), r.handle.videoId as string, r.handle, en), 'file_rejected');
      expect(err.message).toMatch(/duplicate/);
    } finally {
      google.rejection = null;
    }
  });

  it('checks a publication, warning about the unaudited project and refusing a long title', () => {
    const codes = (i: PublishInput, a = ytAccount()) => yt().validate({ ...i, options: { madeForKids: 'no', ...i.options } }, a).map((x) => `${x.severity}:${x.code}`);
    expect(codes(vid())).toEqual(['warning:youtube.unaudited']);
    expect(codes(vid(), ytAccount(true))).toEqual([]);
    expect(yt().validate(vid(), ytAccount(true)).map((x) => x.code)).toEqual(['youtube.made_for_kids']);
    expect(codes(vid({ title: 'x'.repeat(101) }), ytAccount(true))).toEqual(['error:title.length']);
    expect(codes(vid({ options: { title: 'A fine short title' }, title: 'x'.repeat(300) }), ytAccount(true))).toEqual([]);
    expect(codes(vid({ placement: 'short', media: [media({ width: 1920, height: 1080 })] }), ytAccount(true))).toContain('error:media.aspect');
    expect(codes(vid({ placement: 'short', media: [media({ durationMs: 200_000 })] }), ytAccount(true))).toContain('error:media.duration');
  });

  it('calls vertical and square videos Shorts by default', () => {
    const p = (format: string) => yt().defaultPlacement({ pieceKind: 'video', format, media: [{ kind: 'video' }] });
    expect(p('9:16')).toBe('short');
    expect(p('1:1')).toBe('short');
    expect(p('16:9')).toBe('video');
    expect(yt().defaultPlacement({ pieceKind: 'story', format: '9:16', media: [{ kind: 'video' }] })).toBeNull();
    expect(yt().defaultPlacement({ pieceKind: 'post', format: '4:5', media: [{ kind: 'image' }] })).toBeNull();
  });
});
