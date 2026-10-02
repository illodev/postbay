import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createConnectorSet } from '../src/connectors/registry.js';
import { XClient } from '../src/connectors/x/client.js';
import { createX } from '../src/connectors/x/x.js';
import { weightedLength } from '../src/connectors/x/text.js';
import type { Candidate } from '../src/connectors/types.js';
import { FakeX } from './fakes/x.js';
import { account, configFor, env, expectError, image, input, media, prepareUntilDone, redirect } from './connector-helpers.js';

const fake = new FakeX();
let set: ReturnType<typeof createConnectorSet>;
const x = () => set.connector('x')!;
const acc = account('x', { externalId: '4242', displayName: '@lumencoffee', providerData: { username: 'lumencoffee' } });
const files = { 'k/photo.jpg': Buffer.alloc(3000, 1), 'k/photo2.jpg': Buffer.alloc(2000, 2), 'k/reel.mp4': Buffer.alloc(10_000, 3) };
let signedIn: Candidate;

beforeAll(async () => {
  await fake.start();
  set = createConnectorSet(configFor({ X_CLIENT_ID: fake.clientId, X_CLIENT_SECRET: fake.clientSecret, X_OAUTH_URL: `${fake.url}/authorize`, X_API_URL: fake.url }));
});
afterAll(() => fake.stop());
beforeEach(async () => {
  fake.reset();
  fake.accessTokens.clear();
  fake.refreshTokens.clear();
  fake.posts.clear();
  fake.media.clear();
  fake.altTexts = {};
  fake.revoked = false;
  fake.expectChallenge = null;
  fake.videoPolls = 1;
  fake.rejectVideoWith = null;
  fake.loseNextPostAnswer = false;
  signedIn = (await set.provider('x')!.exchange!('good', redirect, 'state-0'))[0]!;
  fake.calls.length = 0;
});
const token = () => signedIn.token.accessToken;

describe('X: signing in', () => {
  it('sends a PKCE challenge, and finishes with the matching verifier made from the same state', async () => {
    const p = set.provider('x')!;
    const u = new URL(p.authorizeUrl!('state-77', redirect));
    expect(u.searchParams.get('code_challenge_method')).toBe('S256');
    expect(u.searchParams.get('scope')).toBe('tweet.read tweet.write users.read offline.access media.write');
    fake.expectChallenge = u.searchParams.get('code_challenge');
    const found = await p.exchange!('good', redirect, 'state-77');
    expect(found[0]).toMatchObject({ network: 'x', externalId: '4242', displayName: '@lumencoffee', providerData: { username: 'lumencoffee' } });
    // The same sign-in finished with another state could not have produced that challenge: X refuses it.
    await expectError(p.exchange!('good', redirect, 'state-78'), 'auth');
  });

  it('identifies the app on the token call and never puts the secret in the address', async () => {
    await set.provider('x')!.exchange!('good', redirect, 's');
    const t = fake.callsTo('/2/oauth2/token')[0]!;
    expect(t.headers.authorization).toMatch(/^Basic /);
    expect(JSON.stringify(t.query)).not.toContain(fake.clientSecret);
  });

  it('renews the session and keeps the new renewal token, because the old one stops working', async () => {
    const p = set.provider('x')!;
    const fresh = await p.refresh!(signedIn.token);
    expect(fresh.accessToken).not.toBe(signedIn.token.accessToken);
    expect(fresh.refreshToken).not.toBe(signedIn.token.refreshToken);
    await expectError(p.refresh!(signedIn.token), 'auth'); // the old renewal token was used up
    expect(await p.refresh!(fresh)).toBeTruthy();
  });

  it('reports a refused code as an auth failure', async () => {
    await expectError(set.provider('x')!.exchange!('bad', redirect, 's'), 'auth');
  });
});

describe('X: what it accepts', () => {
  it('weighs text the way X does: an address is 23, emoji and CJK count twice', () => {
    expect(weightedLength('hello')).toBe(5);
    expect(weightedLength('see https://lumen.example/a/very/long/path/that/goes/on')).toBe(4 + 23);
    expect(weightedLength('😀')).toBe(2);
    expect(weightedLength('春のメニュー')).toBe(12);
    expect(weightedLength('café')).toBe(4);
  });

  it('refuses text over 280 by that weight, though it is shorter in characters', () => {
    const errors = (text: string) => x().validate(input({ placement: 'images', media: [image()], text }), acc).filter((i) => i.severity === 'error');
    expect(errors('a'.repeat(280))).toEqual([]);
    expect(errors('a'.repeat(281))).toHaveLength(1);
    expect(errors('😀'.repeat(141))).toHaveLength(1); // 141 characters, weighing 282
    expect(errors('😀'.repeat(140))).toEqual([]);
  });

  it('warns that a link costs 13 times more and says what to do instead', () => {
    const issues = x().validate(input({ placement: 'images', media: [image()], text: 'Menu at https://lumen.example' }), acc);
    const w = issues.find((i) => i.code === 'x.link.cost')!;
    expect(w.severity).toBe('warning');
    expect(w.message).toContain('0.20 USD');
    expect(w.message).toContain('0.015 USD');
    expect(w.message).toContain('first comment');
    expect(x().validate(input({ placement: 'images', media: [image()], text: 'Menu in the bio' }), acc).some((i) => i.code === 'x.link.cost')).toBe(false);
  });

  it('takes up to four pictures, or one video of up to 140 seconds', () => {
    const five = Array.from({ length: 5 }, (_, i) => image({ position: i }));
    expect(x().validate(input({ placement: 'images', media: five }), acc)).toContainEqual(expect.objectContaining({ code: 'media.count' }));
    expect(x().validate(input({ placement: 'video', media: [media({ durationMs: 141_000 })] }), acc)).toContainEqual(expect.objectContaining({ code: 'media.duration' }));
  });
});

describe('X: publishing', () => {
  it('uploads the pictures once each, sets the alt text, and posts them', async () => {
    const e = env(token(), files);
    const inp = input({ placement: 'images', media: [image(), image({ position: 1, key: 'k/photo2.jpg' })], text: 'Fresh bread', options: { altText: 'A loaf' } });
    const prep = await prepareUntilDone(x(), inp, acc, e);
    expect(fake.callsTo('/2/media/upload', 'POST')).toHaveLength(2);
    expect([...fake.media.values()].every((m) => m.category === 'tweet_image')).toBe(true);
    expect(Object.values(fake.altTexts)).toEqual(['A loaf', 'A loaf']);
    const pub = await x().publish(inp, acc, prep.handle, e);
    expect(pub.url).toBe(`https://x.com/lumencoffee/status/${pub.externalId}`);
    const post = fake.posts.get(pub.externalId)!;
    expect(post.text).toBe('Fresh bread');
    expect(post.media).toHaveLength(2);
    expect((await x().verify(acc, pub.externalId, {}, e)).visibility).toBe('public');
  });

  it('does not upload a picture twice when a later one failed', async () => {
    const e = env(token(), files);
    const inp = input({ placement: 'images', media: [image(), image({ position: 1, key: 'k/photo2.jpg' })] });
    fake.fail((c) => c.path === '/2/media/upload' && c.method === 'POST' && fake.media.size === 1, { title: 'Service Unavailable', detail: 'try later', status: 503 }, 503);
    await expectError(x().prepare(inp, acc, {}, e), 'transient');
    await prepareUntilDone(x(), inp, acc, e, e.saved.at(-1)!);
    expect(fake.media.size).toBe(2);
  });

  it('uploads a video in pieces, in order, then waits for X to process it', async () => {
    const small = createX(new XClient({ clientId: fake.clientId, clientSecret: fake.clientSecret, oauthUrl: '', apiUrl: fake.url }), { chunkBytes: 4000 });
    const e = env(token(), files);
    const inp = input({ placement: 'video', media: [media({ bytes: 10_000 })] });
    const prep = await prepareUntilDone(small, inp, acc, e);
    const [video] = [...fake.media.values()];
    expect(video!.segments).toEqual([0, 1, 2]); // 4000 + 4000 + 2000
    expect(video!.bytes).toBeGreaterThanOrEqual(10_000);
    expect(prep.looks).toBeGreaterThan(1);
    expect(fake.callsTo('/2/media/upload/initialize')).toHaveLength(1);
    const pub = await small.publish(inp, acc, prep.handle, e);
    expect(fake.posts.get(pub.externalId)!.media).toEqual([prep.handle.mediaId]);
  });

  it('resumes a video upload from the first piece not yet sent', async () => {
    const small = createX(new XClient({ clientId: fake.clientId, clientSecret: fake.clientSecret, oauthUrl: '', apiUrl: fake.url }), { chunkBytes: 4000 });
    const e = env(token(), files);
    const inp = input({ placement: 'video', media: [media({ bytes: 10_000 })] });
    fake.fail((c) => /\/append$/.test(c.path) && fake.media.get([...fake.media.keys()][0]!)!.segments.length === 1, { title: 'Service Unavailable', detail: 'try later', status: 503 }, 503);
    await expectError(small.prepare(inp, acc, {}, e), 'transient');
    expect((e.saved.at(-1)!.upload as { next: number }).next).toBe(1);
    await prepareUntilDone(small, inp, acc, e, e.saved.at(-1)!);
    expect(fake.callsTo('/2/media/upload/initialize')).toHaveLength(1);
    expect([...fake.media.values()][0]!.segments).toEqual([0, 1, 2]);
  });

  it('turns a video X cannot process into a rejection with its reason', async () => {
    fake.rejectVideoWith = 'InvalidMedia: unsupported codec';
    const err = await expectError(prepareUntilDone(x(), input({ placement: 'video', media: [media({ bytes: 10_000 })] }), acc, env(token(), files)), 'file_rejected');
    expect(err.message).toContain('unsupported codec');
  });

  it('posts the first comment as a reply of its own', async () => {
    const e = env(token(), files);
    const inp = input({ placement: 'images', media: [image()], firstComment: 'Menu: https://lumen.example' });
    const prep = await prepareUntilDone(x(), inp, acc, e);
    const pub = await x().publish(inp, acc, prep.handle, e);
    const reply = [...fake.posts.values()].find((p) => p.reply_to)!;
    expect(reply).toMatchObject({ text: 'Menu: https://lumen.example', reply_to: pub.externalId });
  });

  it('never posts twice when a step is repeated after a crash', async () => {
    const e = env(token(), files);
    const inp = input({ placement: 'images', media: [image()] });
    const prep = await prepareUntilDone(x(), inp, acc, e);
    const first = await x().publish(inp, acc, prep.handle, e);
    const again = await x().publish(inp, acc, e.saved.at(-1)!, e);
    expect(again.externalId).toBe(first.externalId);
    expect(fake.posts.size).toBe(1);
  });

  it('finds its own post again when the answer to "create" was lost, instead of failing or posting twice', async () => {
    const e = env(token(), files);
    const inp = input({ placement: 'images', media: [image()], text: 'We open at nine' });
    const prep = await prepareUntilDone(x(), inp, acc, e);
    fake.loseNextPostAnswer = true;
    await expectError(x().publish(inp, acc, prep.handle, e), 'transient'); // the post exists on X, but we never heard
    const handleAfter = e.saved.at(-1)!;
    expect(handleAfter.attemptedAt).toBeTruthy(); // written down before the call
    expect(handleAfter.postId).toBeUndefined();
    const retry = await x().publish(inp, acc, handleAfter, e);
    expect(fake.posts.size).toBe(1);
    expect(retry.externalId).toBe([...fake.posts.keys()][0]);
    expect(e.saved.at(-1)!.recovered).toBe(true);
  });

  it('still fails, telling the person why, when the text duplicates an older post that is not ours from this attempt', async () => {
    const e = env(token(), files);
    fake.posts.set('900', { id: '900', text: 'We open at nine', media: [], created_at: new Date(Date.now() - 5 * 86_400_000).toISOString() });
    const inp = input({ placement: 'images', media: [image()], text: 'We open at nine' });
    const prep = await prepareUntilDone(x(), inp, acc, e);
    const err = await expectError(x().publish(inp, acc, prep.handle, e), 'file_rejected');
    expect(err.message).toContain('duplicate');
  });

  it('explains an empty balance as something a person must top up, not as a lost connection', async () => {
    fake.fail((c) => c.path === '/2/tweets', { title: 'CreditsDepleted', detail: 'Your enrolled account does not have any credits to fulfill this request.', status: 402 }, 402);
    const e = env(token(), files);
    const inp = input({ placement: 'images', media: [image()] });
    const prep = await prepareUntilDone(x(), inp, acc, e);
    const err = await expectError(x().publish(inp, acc, prep.handle, e), 'unsupported');
    expect(err.message).toContain('Top up');
  });

  it('waits until X says the rate limit resets', async () => {
    fake.fail((c) => c.path === '/2/tweets', { title: 'Too Many Requests', detail: 'Too Many Requests', status: 429 }, 429, 1, { 'x-rate-limit-reset': String(Math.floor(Date.now() / 1000) + 600) });
    const e = env(token(), files);
    const inp = input({ placement: 'images', media: [image()] });
    const prep = await prepareUntilDone(x(), inp, acc, e);
    const err = await expectError(x().publish(inp, acc, prep.handle, e), 'rate_limit');
    expect(err.retryAfterSec).toBeGreaterThan(570);
    expect(err.retryAfterSec).toBeLessThanOrEqual(600);
  });

  it('reports a revoked session as a lost connection', async () => {
    fake.revoked = true;
    await expectError(x().prepare(input({ placement: 'images', media: [image()] }), acc, {}, env(token(), files)), 'auth');
  });
});

describe('X: after publishing', () => {
  it('reads impressions as views and adds reposts and quotes into shares', async () => {
    const e = env(token(), files);
    const inp = input({ placement: 'images', media: [image()] });
    const prep = await prepareUntilDone(x(), inp, acc, e);
    const pub = await x().publish(inp, acc, prep.handle, e);
    const m = await x().fetchMetrics!(acc, pub.externalId, {}, e, { publishedAt: new Date(), placement: 'images' });
    expect(m.common).toEqual({ views: 1000, likes: 31, comments: 4, shares: 4, saves: 5 });
    expect(m.note).toContain('0.001 USD');
    // Without the owner-only figures it falls back to the public ones.
    fake.organic = null;
    const m2 = await x().fetchMetrics!(acc, pub.externalId, {}, e, { publishedAt: new Date(), placement: 'images' });
    expect(m2.common.views).toBe(900);
  });

  it('says a deleted post is gone, and checks the session', async () => {
    expect((await x().verify(acc, '99999', {}, env(token()))).visibility).toBe('unknown');
    expect(await x().health!(acc, env(token()))).toEqual({ valid: true });
    fake.revoked = true;
    await expectError(x().health!(acc, env(token())), 'auth');
  });
});
