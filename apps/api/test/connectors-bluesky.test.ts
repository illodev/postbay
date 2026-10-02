import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { tidFor } from '../src/connectors/bluesky/client.js';
import { call } from '../src/connectors/http.js';
import { facetsFor, graphemes } from '../src/connectors/bluesky/richtext.js';
import { createConnectorSet } from '../src/connectors/registry.js';
import type { Candidate } from '../src/connectors/types.js';
import { FakeBluesky } from './fakes/bluesky.js';
import { account, configFor, env, expectError, image, input, media, prepareUntilDone } from './connector-helpers.js';

const fake = new FakeBluesky();
let set: ReturnType<typeof createConnectorSet>;
const bsky = () => set.connector('bluesky')!;
const provider = () => set.provider('bluesky')!;
let signedIn: Candidate;
let acc = account('bluesky', { externalId: 'did:plc:lumen', displayName: '@lumen.bsky.social', providerData: { handle: 'lumen.bsky.social', pds: '', pdsEndpoint: 'https://morel.us-east.host.bsky.network', emailConfirmed: true } });
const JPEG = Buffer.alloc(5000, 1);
const files = { 'k/photo.jpg': JPEG, 'k/photo2.jpg': Buffer.alloc(4000, 2), 'k/reel.mp4': Buffer.alloc(9000, 3) };

beforeAll(async () => {
  await fake.start();
  acc = { ...acc, providerData: { ...acc.providerData, pds: fake.url } };
  set = createConnectorSet(configFor({ BLUESKY_PDS_URL: fake.url, BLUESKY_VIDEO_URL: `${fake.url}/video` }));
});
afterAll(() => fake.stop());
beforeEach(async () => {
  fake.reset();
  fake.accessTokens.clear();
  fake.refreshTokens.clear();
  fake.records.clear();
  fake.blobs.length = 0;
  fake.jobs.clear();
  fake.serviceTokens.length = 0;
  fake.refreshExpired = false;
  fake.revoked = false;
  fake.emailConfirmed = true;
  fake.canUploadVideo = true;
  fake.rejectVideoWith = null;
  fake.videoPolls = 1;
  fake.accessLifetimeSec = 7200;
  signedIn = (await provider().credentials!.connect({ handle: '@lumen.bsky.social', appPassword: fake.password }))[0]!;
  fake.calls.length = 0;
});

const token = () => signedIn.token.accessToken;

describe('Bluesky: signing in with an app password', () => {
  it('asks for a handle, an app password and, optionally, a server', () => {
    expect(provider().credentials!.fields.map((f) => [f.key, f.type, f.required !== false])).toEqual([['handle', 'text', true], ['appPassword', 'password', true], ['server', 'text', false]]);
    expect(provider().authorizeUrl).toBeUndefined();
  });

  it('starts a session and finds the account, keeping what is needed to start another one', () => {
    expect(signedIn).toMatchObject({
      network: 'bluesky', externalId: 'did:plc:lumen', displayName: '@lumen.bsky.social',
      // The server the repository really lives on, from the DID document: the video service is told it.
      providerData: { handle: 'lumen.bsky.social', emailConfirmed: true, pdsEndpoint: 'https://morel.us-east.host.bsky.network' },
    });
    expect(signedIn.token.extra).toMatchObject({ appPassword: fake.password, identifier: 'lumen.bsky.social', server: fake.url });
    const hours = (new Date(signedIn.token.expiresAt!).getTime() - Date.now()) / 3_600_000;
    expect(hours).toBeGreaterThan(1.9);
    expect(hours).toBeLessThan(2.1);
    // The password is in the sealed token, never in what is shown to the person choosing.
    expect(JSON.stringify(signedIn.providerData)).not.toContain(fake.password);
  });

  it('says plainly that the handle or the app password was wrong', async () => {
    const err = await expectError(provider().credentials!.connect({ handle: 'lumen.bsky.social', appPassword: 'not-it' }), 'auth');
    expect(err.message).toContain('app password');
  });

  it('renews the session with the renewal token', async () => {
    const fresh = await provider().refresh!(signedIn.token);
    expect(fresh.accessToken).not.toBe(signedIn.token.accessToken);
    expect(fresh.extra!.appPassword).toBe(fake.password);
    expect(fake.callsTo('/xrpc/com.atproto.server.refreshSession')).toHaveLength(1);
    expect(fake.callsTo('/xrpc/com.atproto.server.createSession')).toHaveLength(0);
  });

  it('starts a new session with the app password when the renewal token has lapsed', async () => {
    fake.refreshExpired = true;
    const fresh = await provider().refresh!(signedIn.token);
    expect(fresh.accessToken).toBeTruthy();
    expect(fake.callsTo('/xrpc/com.atproto.server.createSession')).toHaveLength(1);
  });

  it('takes a server a person types only as the address of a server, and only where the webhooks may go', async () => {
    const strict = createConnectorSet(configFor({ BLUESKY_PDS_URL: fake.url, BLUESKY_VIDEO_URL: `${fake.url}/video`, WEBHOOK_ALLOW_PRIVATE_NETWORKS: 'false' })).provider('bluesky')!;
    const connect = (server: string) => strict.credentials!.connect({ handle: 'lumen.bsky.social', appPassword: fake.password, server });
    for (const server of ['http://pds.example.com', 'http://127.0.0.1:9', 'https://169.254.169.254', 'https://localhost', 'https://user:pw@pds.example.com', 'https://pds.example.com/xrpc?x=1', 'ftp://pds.example.com']) {
      await expectError(connect(server), 'auth');
    }
    expect(fake.callsTo('/xrpc/com.atproto.server.createSession')).toHaveLength(0);
  });

  it('talks to a server a person typed through the guarded client: no redirects, and the address checked when connecting', async () => {
    // Same stand-in under another name, so it is not the configured server: private addresses are allowed outside production.
    const typed = fake.url.replace('127.0.0.1', 'localhost');
    const c = (await provider().credentials!.connect({ handle: 'lumen.bsky.social', appPassword: fake.password, server: typed }))[0]!;
    expect(c.providerData.pds).toBe(typed);
    expect(fake.callsTo('/xrpc/com.atproto.server.createSession')).toHaveLength(1);
    // A server that sends the call somewhere else is not followed.
    fake.fail((x) => x.path === '/xrpc/com.atproto.server.createSession', '', 302, 1, { location: 'http://169.254.169.254/latest/meta-data/' });
    const err = await expectError(provider().credentials!.connect({ handle: 'lumen.bsky.social', appPassword: fake.password, server: typed }), 'unsupported');
    expect(err.message).toContain('redirect');
    // With private networks refused, a name is refused once it has been resolved, when connecting, before anything is sent.
    fake.calls.length = 0;
    const refused = await expectError(call(`${typed}/xrpc/com.atproto.server.createSession`, { method: 'POST', json: {}, guard: { allowPrivate: false, httpsForPublic: true } }), 'unsupported');
    expect(refused.message).toMatch(/resolves to/);
    expect(fake.calls).toHaveLength(0);
  });

  it('asks to reconnect when the app password was revoked', async () => {
    fake.refreshExpired = true;
    fake.revoked = true;
    await expectError(provider().refresh!(signedIn.token), 'auth');
  });
});

describe('Bluesky: what it accepts', () => {
  it('counts graphemes, so a family emoji is one character and 300 of them fit', () => {
    expect(graphemes('👨‍👩‍👧‍👦')).toBe(1);
    expect(graphemes('é')).toBe(1);
    const ok = bsky().validate(input({ placement: 'images', media: [image()], text: '👨‍👩‍👧‍👦'.repeat(300) }), acc);
    expect(ok.filter((i) => i.severity === 'error')).toEqual([]);
    const over = bsky().validate(input({ placement: 'images', media: [image()], text: 'a'.repeat(301) }), acc);
    expect(over).toContainEqual(expect.objectContaining({ severity: 'error', code: 'text.length' }));
  });

  it('takes up to four pictures, or one video of up to three minutes', () => {
    const five = Array.from({ length: 5 }, (_, i) => image({ position: i }));
    expect(bsky().validate(input({ placement: 'images', media: five }), acc)).toContainEqual(expect.objectContaining({ code: 'media.count' }));
    expect(bsky().validate(input({ placement: 'video', media: [media({ durationMs: 181_000 })] }), acc)).toContainEqual(expect.objectContaining({ code: 'media.duration' }));
    expect(bsky().validate(input({ placement: 'video', media: [media({ durationMs: 179_000 })] }), acc).filter((i) => i.severity === 'error')).toEqual([]);
  });

  it('refuses video from an account whose email is not confirmed', () => {
    const unconfirmed = { ...acc, providerData: { ...acc.providerData, emailConfirmed: false } };
    expect(bsky().validate(input({ placement: 'video' }), unconfirmed)).toContainEqual(expect.objectContaining({ severity: 'error', code: 'bluesky.email' }));
    expect(bsky().validate(input({ placement: 'images', media: [image()] }), unconfirmed).filter((i) => i.severity === 'error')).toEqual([]);
  });

  it('offers an alt-text field for pictures only, and says its text is counted in graphemes', () => {
    const caps = bsky().capabilities();
    expect(caps.text.unit).toBe('graphemes');
    expect(caps.options).toContainEqual(expect.objectContaining({ key: 'altText', placements: ['images'] }));
  });
});

describe('Bluesky: links, hashtags and mentions', () => {
  it('points at links and hashtags by UTF-8 bytes, even after an emoji', () => {
    const text = '🎉 Menu: https://lumen.example/menu. #spring';
    const facets = facetsFor(text);
    const bytes = Buffer.from(text);
    const link = facets.find((f) => f.features[0]!.$type === 'app.bsky.richtext.facet#link')!;
    expect(bytes.subarray(link.index.byteStart, link.index.byteEnd).toString()).toBe('https://lumen.example/menu'); // the full stop is not part of it
    expect(link.features[0]).toMatchObject({ uri: 'https://lumen.example/menu' });
    const tag = facets.find((f) => f.features[0]!.$type === 'app.bsky.richtext.facet#tag')!;
    expect(bytes.subarray(tag.index.byteStart, tag.index.byteEnd).toString()).toBe('#spring');
    expect(tag.features[0]).toMatchObject({ tag: 'spring' });
  });

  it('mentions only the handles that resolve', () => {
    const text = 'Thanks @bob.bsky.social and @ghost.bsky.social';
    const facets = facetsFor(text, { 'bob.bsky.social': 'did:plc:bob' });
    expect(facets).toHaveLength(1);
    expect(facets[0]!.features[0]).toMatchObject({ did: 'did:plc:bob' });
  });
});

describe('Bluesky: publishing', () => {
  it('uploads each picture once, then writes one post with them, their alt text and their shape', async () => {
    const e = env(token(), files);
    const inp = input({
      placement: 'images', media: [image(), image({ position: 1, key: 'k/photo2.jpg', width: 1000, height: 1000 })],
      text: 'Fresh bread https://lumen.example #bakery', options: { altText: 'A loaf on a table' },
    });
    const prep = await prepareUntilDone(bsky(), inp, acc, e);
    expect(fake.blobs).toHaveLength(2);
    const pub = await bsky().publish(inp, acc, prep.handle, e);
    const record = [...fake.records.values()][0]!.value;
    expect(record.embed.$type).toBe('app.bsky.embed.images');
    expect(record.embed.images).toHaveLength(2);
    expect(record.embed.images[0]).toMatchObject({ alt: 'A loaf on a table', aspectRatio: { width: 1080, height: 1350 } });
    expect(record.facets.map((f: any) => f.features[0].$type)).toEqual(['app.bsky.richtext.facet#link', 'app.bsky.richtext.facet#tag']);
    // The record key is a TID, as Bluesky expects for posts, and it is the one in the address.
    const rkey = pub.externalId.split('/').pop()!;
    expect(rkey).toMatch(/^[234567a-j][234567a-z]{12}$/);
    expect(pub.url).toBe(`https://bsky.app/profile/lumen.bsky.social/post/${rkey}`);
    expect((await bsky().verify(acc, pub.externalId, {}, e)).visibility).toBe('public');
  });

  it('does not upload again the pictures it already uploaded when a later one failed', async () => {
    const e = env(token(), files);
    const inp = input({ placement: 'images', media: [image(), image({ position: 1, key: 'k/photo2.jpg' })] });
    fake.fail((c) => c.path === '/xrpc/com.atproto.repo.uploadBlob' && fake.blobs.length === 1, { error: 'InternalServerError', message: 'boom' }, 500);
    await expectError(bsky().prepare(inp, acc, {}, e), 'transient');
    const kept = e.saved.at(-1)!;
    expect(kept.blobs).toHaveLength(1);
    await prepareUntilDone(bsky(), inp, acc, e, kept);
    expect(fake.blobs).toHaveLength(2); // one upload before the failure, one after: not three
  });

  it('writes the same single post when the step is repeated after the answer was lost', async () => {
    const e = env(token(), files);
    const inp = input({ placement: 'images', media: [image()] });
    const prep = await prepareUntilDone(bsky(), inp, acc, e);
    const first = await bsky().publish(inp, acc, prep.handle, e);
    // The first answer never reached us, so the handle knows nothing of it: the second try writes the same record key.
    const second = await bsky().publish(inp, acc, prep.handle, env(token(), files));
    expect(second.externalId).toBe(first.externalId);
    expect(fake.records.size).toBe(1);
  });

  it('makes record keys that are TIDs, the same for the same publication and different for another at the same minute', () => {
    const at = new Date('2026-10-02T10:00:00Z');
    const a = tidFor(at, 'pub-a');
    expect(a).toMatch(/^[234567a-j][234567a-z]{12}$/);
    expect(tidFor(at, 'pub-a')).toBe(a);
    expect(tidFor(at, 'pub-b')).not.toBe(a);
    // They sort by time, as TIDs do.
    expect(tidFor(new Date(at.getTime() + 2000), 'pub-a') > a).toBe(true);
  });

  it('posts the first comment as a reply that points at the post', async () => {
    const e = env(token(), files);
    const inp = input({ placement: 'images', media: [image()], firstComment: 'Recipe in the bio' });
    const prep = await prepareUntilDone(bsky(), inp, acc, e);
    const pub = await bsky().publish(inp, acc, prep.handle, e);
    const reply = [...fake.records.values()].find((r) => r.value.reply)!.value;
    expect(reply.text).toBe('Recipe in the bio');
    expect(reply.reply.root.uri).toBe(pub.externalId);
    expect(reply.reply.parent.uri).toBe(pub.externalId);
  });

  it('turns a picture Bluesky finds too large into a rejection that names the limit', async () => {
    const big = { 'k/photo.jpg': Buffer.alloc(1_200_000, 1) };
    const err = await expectError(bsky().prepare(input({ placement: 'images', media: [image()] }), acc, {}, env(token(), big)), 'file_rejected');
    expect(err.message).toContain('too large');
  });

  it('refuses a text Bluesky counts as too long, which our own check missed (so it never pretends)', async () => {
    const e = env(token(), files);
    const inp = input({ placement: 'images', media: [image()], text: 'a'.repeat(301) });
    const prep = await prepareUntilDone(bsky(), inp, acc, e);
    await expectError(bsky().publish(inp, acc, prep.handle, e), 'file_rejected');
  });

  it('waits when the rate limit is hit, for as long as Bluesky says', async () => {
    fake.fail((c) => c.path === '/xrpc/com.atproto.repo.uploadBlob', { error: 'RateLimitExceeded', message: 'Rate Limit Exceeded' }, 429, 1, { 'ratelimit-reset': String(Math.floor(Date.now() / 1000) + 900) });
    const err = await expectError(bsky().prepare(input({ placement: 'images', media: [image()] }), acc, {}, env(token(), files)), 'rate_limit');
    expect(err.retryAfterSec).toBeGreaterThan(880);
    expect(err.retryAfterSec).toBeLessThanOrEqual(900);
  });

  it('reports a rejected session as a lost connection', async () => {
    fake.revoked = true;
    await expectError(bsky().prepare(input({ placement: 'images', media: [image()] }), acc, {}, env(token(), files)), 'auth');
  });
});

describe('Bluesky: video', () => {
  it('asks for the daily allowance, sends the video to the video service with a token made for it, and waits for the job', async () => {
    const e = env(token(), files);
    const inp = input({ placement: 'video' });
    const prep = await prepareUntilDone(bsky(), inp, acc, e);
    expect(prep.looks).toBeGreaterThan(1);
    expect(fake.callsTo('/video/xrpc/app.bsky.video.getUploadLimits')).toHaveLength(1);
    expect(fake.callsTo('/video/xrpc/app.bsky.video.uploadVideo')).toHaveLength(1); // one upload however many looks
    // The upload's token is made out to the account's repository server, from its DID document, not to the server signed in to.
    const svc = fake.serviceTokens.find((t) => t.lxm === 'com.atproto.repo.uploadBlob')!;
    expect(svc.aud).toBe('did:web:morel.us-east.host.bsky.network');
    // The allowance question is addressed to the video service itself.
    const limits = fake.serviceTokens.find((t) => t.lxm === 'app.bsky.video.getUploadLimits')!;
    expect(limits.aud).toBe(`did:web:${new URL(fake.url).host.replace(':', '%3A')}`);
    const pub = await bsky().publish(inp, acc, prep.handle, e);
    expect([...fake.records.values()][0]!.value.embed.$type).toBe('app.bsky.embed.video');
    expect(pub.externalId).toMatch(/^at:\/\//);
  });

  it('finds the repository server from the session when the account was connected before it was kept', async () => {
    const older = { ...acc, providerData: { ...acc.providerData, pdsEndpoint: undefined } };
    await prepareUntilDone(bsky(), input({ placement: 'video' }), older, env(token(), files));
    expect(fake.callsTo('/xrpc/com.atproto.server.getSession')).toHaveLength(1);
    expect(fake.serviceTokens.find((t) => t.lxm === 'com.atproto.repo.uploadBlob')!.aud).toBe('did:web:morel.us-east.host.bsky.network');
  });

  it('does not ask for the account to be connected again when the video service refuses a token', async () => {
    fake.pdsEndpoint = 'https://elsewhere.host.bsky.network';
    try {
      const err = await expectError(prepareUntilDone(bsky(), input({ placement: 'video' }), acc, env(token(), files)), 'unsupported');
      expect(err.message).toContain('video service');
      expect(err.message).toContain("connection itself is fine");
    } finally {
      fake.pdsEndpoint = 'https://morel.us-east.host.bsky.network';
    }
    fake.fail((c) => c.path === '/video/xrpc/app.bsky.video.getUploadLimits', { error: 'AuthenticationRequired', message: 'Bad token' }, 401);
    await expectError(bsky().prepare(input({ placement: 'video' }), acc, {}, env(token(), files)), 'unsupported');
  });

  it('waits a while instead of failing when the daily allowance for video is used up', async () => {
    fake.canUploadVideo = false;
    const err = await expectError(bsky().prepare(input({ placement: 'video' }), acc, {}, env(token(), files)), 'rate_limit');
    expect(err.message).toContain('most videos allowed today');
    expect(fake.callsTo('/video/xrpc/app.bsky.video.uploadVideo')).toHaveLength(0);
  });

  it('turns a video Bluesky cannot process into a rejection with its reason', async () => {
    fake.rejectVideoWith = 'Video is too long';
    const err = await expectError(prepareUntilDone(bsky(), input({ placement: 'video' }), acc, env(token(), files)), 'file_rejected');
    expect(err.message).toContain('Video is too long');
  });
});

describe('Bluesky: after publishing', () => {
  it('reads likes, replies and what was passed on, and says there are no views', async () => {
    const e = env(token(), files);
    const inp = input({ placement: 'images', media: [image()] });
    const prep = await prepareUntilDone(bsky(), inp, acc, e);
    const pub = await bsky().publish(inp, acc, prep.handle, e);
    const m = await bsky().fetchMetrics!(acc, pub.externalId, {}, e, { publishedAt: new Date(), placement: 'images' });
    expect(m.common).toEqual({ likes: 7, comments: 2, shares: 2 });
    expect(m.note).toContain('no view');
  });

  it('reports a post that is gone as unknown, not as a failure', async () => {
    const r = await bsky().verify(acc, 'at://did:plc:lumen/app.bsky.feed.post/gone', {}, env(token()));
    expect(r.visibility).toBe('unknown');
  });

  it('checks the session still works', async () => {
    expect(await bsky().health!(acc, env(token()))).toEqual({ valid: true });
    fake.revoked = true;
    await expectError(bsky().health!(acc, env(token())), 'auth');
  });
});
