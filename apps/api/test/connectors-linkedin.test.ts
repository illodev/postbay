import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { escapeCommentary } from '../src/connectors/linkedin/linkedin.js';
import { createConnectorSet } from '../src/connectors/registry.js';
import { FakeLinkedIn } from './fakes/linkedin.js';
import { account, configFor, env, expectError, image, input, media, prepareUntilDone, redirect } from './connector-helpers.js';

const fake = new FakeLinkedIn();
let set: ReturnType<typeof createConnectorSet>;
const li = () => set.connector('linkedin')!;
const acc = account('linkedin', { externalId: '5001', displayName: 'Lumen Coffee', providerData: { organizationId: '5001', urn: 'urn:li:organization:5001' } });
const files = { 'k/photo.jpg': Buffer.alloc(3000, 1), 'k/photo2.jpg': Buffer.alloc(2000, 2), 'k/reel.mp4': Buffer.alloc(10_000, 3), 'k/menu.pdf': Buffer.alloc(5000, 4) };
const pdf = () => media({ kind: 'pdf', name: 'menu.pdf', mime: 'application/pdf', key: 'k/menu.pdf', bytes: 5000, width: null, height: null, durationMs: null });

beforeAll(async () => {
  await fake.start();
  set = createConnectorSet(configFor({
    LINKEDIN_CLIENT_ID: 'lid', LINKEDIN_CLIENT_SECRET: 'lsecret', LINKEDIN_OAUTH_URL: `${fake.url}/authorize`, LINKEDIN_TOKEN_URL: `${fake.url}/oauth/token`,
    LINKEDIN_API_URL: fake.url, LINKEDIN_VERSION: '202604',
  }));
});
afterAll(() => fake.stop());
beforeEach(() => {
  fake.reset();
  fake.uploads.clear();
  fake.posts.clear();
  fake.comments.length = 0;
  fake.etags.length = 0;
  fake.accessTokens = new Set(['tok']);
  fake.revoked = false;
  fake.partner = false;
  fake.videoPolls = 1;
  fake.failVideoProcessing = false;
  fake.loseNextPostAnswer = false;
  fake.orgs = [{ id: '5001', localizedName: 'Lumen Coffee', vanityName: 'lumen-coffee' }];
});

describe('LinkedIn: signing in', () => {
  it('asks for the page permissions', () => {
    const u = new URL(set.provider('linkedin')!.authorizeUrl!('s1', redirect));
    expect(u.searchParams.get('scope')).toBe('w_organization_social r_organization_social rw_organization_admin');
    expect(u.searchParams.get('state')).toBe('s1');
  });

  it('finds the company pages the person administers, one account each', async () => {
    fake.orgs = [{ id: '5001', localizedName: 'Lumen Coffee', vanityName: 'lumen-coffee' }, { id: '5002', localizedName: 'Lumen Roasters', vanityName: 'lumen-roasters' }];
    const found = await set.provider('linkedin')!.exchange!('good', redirect, 's');
    expect(found.map((c) => [c.key, c.displayName])).toEqual([['linkedin:5001', 'Lumen Coffee'], ['linkedin:5002', 'Lumen Roasters']]);
    expect(found[0]!.providerData).toMatchObject({ organizationId: '5001', urn: 'urn:li:organization:5001' });
    // The app sends the versioned headers on every API call.
    expect(fake.callsTo('/rest/organizationAcls')[0]!.headers['linkedin-version']).toBe('202604');
  });

  it('says what to check when the person administers no page', async () => {
    fake.orgs = [];
    const err = await expectError(set.provider('linkedin')!.exchange!('good', redirect, 's'), 'auth');
    expect(err.message).toContain('administrator');
  });

  it('only renews a token where LinkedIn gave a renewal token, and otherwise keeps the one it has until it runs out', async () => {
    const p = set.provider('linkedin')!;
    const soon = new Date(Date.now() + 3 * 86_400_000).toISOString();
    expect(await p.refresh!({ accessToken: 'tok', expiresAt: soon })).toMatchObject({ accessToken: 'tok' });
    const partner = await p.refresh!({ accessToken: 'tok', refreshToken: 'lref-0', expiresAt: soon });
    expect(partner.accessToken).toMatch(/^tok-/);
    expect(partner.refreshToken).toMatch(/^lref-/);
  });

  it('warns about the expiry of a token that cannot be renewed, through the daily check', async () => {
    const expiresAt = new Date(Date.now() + 4 * 86_400_000).toISOString();
    expect(await li().health!(acc, env('tok', {}, () => new Date(), { expiresAt }))).toEqual({ valid: true, expiresAt });
  });
});

describe('LinkedIn: what it accepts', () => {
  it('picks a placement from the content', () => {
    const c = li();
    expect(c.defaultPlacement({ pieceKind: 'pdf', format: 'document', media: [{ kind: 'pdf' }] })).toBe('document');
    expect(c.defaultPlacement({ pieceKind: 'video', format: '16:9', media: [{ kind: 'video' }] })).toBe('video');
    expect(c.defaultPlacement({ pieceKind: 'post', format: 'carousel', media: [{ kind: 'image' }, { kind: 'image' }] })).toBe('images');
    expect(c.defaultPlacement({ pieceKind: 'post', format: '1:1', media: [{ kind: 'image' }] })).toBe('image');
  });

  it('asks for exactly one PDF for a document, within 100 MB', () => {
    const none = li().validate(input({ placement: 'document', media: [] }), acc);
    expect(none).toContainEqual(expect.objectContaining({ severity: 'error', code: 'media.count' }));
    const big = li().validate(input({ placement: 'document', media: [{ ...pdf(), bytes: 101 * 1024 * 1024 }] }), acc);
    expect(big).toContainEqual(expect.objectContaining({ severity: 'error', code: 'media.size' }));
    expect(li().validate(input({ placement: 'document', media: [pdf()] }), acc).filter((i) => i.severity === 'error')).toEqual([]);
  });

  it('takes up to 3000 characters, videos of 3 seconds to 30 minutes, and 2 to 20 pictures', () => {
    expect(li().validate(input({ placement: 'image', media: [image()], text: 'x'.repeat(3001) }), acc)).toContainEqual(expect.objectContaining({ code: 'text.length' }));
    expect(li().validate(input({ placement: 'video', media: [media({ durationMs: 2000 })] }), acc)).toContainEqual(expect.objectContaining({ code: 'media.duration' }));
    expect(li().validate(input({ placement: 'images', media: [image()] }), acc)).toContainEqual(expect.objectContaining({ code: 'media.count' }));
  });

  it('escapes the characters LinkedIn reads as markup, and leaves hashtags alone', () => {
    expect(escapeCommentary('Fresh (today) #bread @everyone | 50% off *now*')).toBe('Fresh \\(today\\) #bread \\@everyone \\| 50% off \\*now\\*');
    expect(escapeCommentary('a_b ~c~ [d] {e} <f> \\')).toBe('a\\_b \\~c\\~ \\[d\\] \\{e\\} \\<f\\> \\\\');
  });
});

describe('LinkedIn: publishing', () => {
  it('uploads a picture, posts it as the page, and gives its address', async () => {
    const e = env('tok', files);
    const inp = input({ placement: 'image', media: [image()], text: 'Fresh bread (daily) #bakery', options: { altText: 'A loaf' } });
    const prep = await prepareUntilDone(li(), inp, acc, e);
    const pub = await li().publish(inp, acc, prep.handle, e);
    const post = fake.posts.get(pub.externalId)!;
    expect(post.commentary).toBe('Fresh bread \\(daily\\) #bakery');
    expect(post.content.media).toMatchObject({ altText: 'A loaf' });
    expect(fake.callsTo('/rest/posts', 'POST')[0]!.body.author).toBe('urn:li:organization:5001');
    expect(pub.url).toBe(`https://www.linkedin.com/feed/update/${pub.externalId}/`);
    expect((await li().verify(acc, pub.externalId, {}, e)).visibility).toBe('public');
  });

  it('posts several pictures as one post, uploaded once each', async () => {
    const e = env('tok', files);
    const inp = input({ placement: 'images', media: [image(), image({ position: 1, key: 'k/photo2.jpg' })] });
    const prep = await prepareUntilDone(li(), inp, acc, e);
    expect(fake.callsTo('/rest/images', 'POST')).toHaveLength(2);
    const pub = await li().publish(inp, acc, prep.handle, e);
    expect(fake.posts.get(pub.externalId)!.content.multiImage.images).toHaveLength(2);
  });

  it('uploads a document and waits until LinkedIn has it', async () => {
    const e = env('tok', files);
    const inp = input({ placement: 'document', media: [pdf()], title: 'Spring menu', options: { title: 'The spring menu' } });
    const prep = await prepareUntilDone(li(), inp, acc, e);
    const pub = await li().publish(inp, acc, prep.handle, e);
    expect(fake.posts.get(pub.externalId)!.content.media.title).toBe('The spring menu');
  });

  it('uploads a video in the parts LinkedIn asks for, names them when finishing, and waits for processing', async () => {
    const e = env('tok', files);
    const inp = input({ placement: 'video', media: [media({ bytes: 10_000 })] });
    const prep = await prepareUntilDone(li(), inp, acc, e);
    expect(fake.etags).toHaveLength(3); // 4000 + 4000 + 2000
    expect(prep.looks).toBeGreaterThan(1);
    expect(fake.callsTo('/rest/videos', 'POST').filter((c) => c.query.action === 'finalizeUpload')).toHaveLength(1);
    const pub = await li().publish(inp, acc, prep.handle, e);
    expect(fake.posts.get(pub.externalId)!.content.media.id).toMatch(/^urn:li:video:/);
  });

  it('resumes a video upload from the first part not yet sent, and finishes only once', async () => {
    const e = env('tok', files);
    const inp = input({ placement: 'video', media: [media({ bytes: 10_000 })] });
    fake.fail((c) => c.method === 'PUT' && fake.etags.length === 1, { status: 503, message: 'busy' }, 503);
    await expectError(li().prepare(inp, acc, {}, e), 'transient');
    expect((e.saved.at(-1)!.video as { etags: string[] }).etags).toHaveLength(1);
    await prepareUntilDone(li(), inp, acc, e, e.saved.at(-1)!);
    expect(fake.etags).toHaveLength(3 + 0 + 0 + 0); // three accepted parts; the refused attempt was not counted
    expect(fake.callsTo('/rest/videos', 'POST').filter((c) => c.query.action === 'initializeUpload')).toHaveLength(1);
  });

  it('turns a video LinkedIn cannot process into a rejection', async () => {
    fake.failVideoProcessing = true;
    await expectError(prepareUntilDone(li(), input({ placement: 'video', media: [media({ bytes: 10_000 })] }), acc, env('tok', files)), 'file_rejected');
  });

  it('posts the first comment as the page', async () => {
    const e = env('tok', files);
    const inp = input({ placement: 'image', media: [image()], firstComment: 'More on our site' });
    const prep = await prepareUntilDone(li(), inp, acc, e);
    const pub = await li().publish(inp, acc, prep.handle, e);
    expect(fake.comments).toEqual([{ post: pub.externalId, text: 'More on our site' }]);
    const sent = fake.callsTo(/\/rest\/socialActions\//)[0]!.body;
    expect(sent).toMatchObject({ actor: 'urn:li:organization:5001', object: pub.externalId, message: { text: 'More on our site' } });
    expect(e.saved.at(-1)!.firstCommentError).toBeUndefined();
  });

  it("tells a missing permission from a lost connection: only a token LinkedIn no longer takes asks for a reconnection", async () => {
    fake.fail((c) => c.path === '/rest/posts', { status: 403, serviceErrorCode: 100, code: 'ACCESS_DENIED', message: 'Not enough permissions to access: partnerApiPostsExternal.CREATE.20260401' }, 403);
    const e = env('tok', files);
    const inp = input({ placement: 'image', media: [image()] });
    const prep = await prepareUntilDone(li(), inp, acc, e);
    const err = await expectError(li().publish(inp, acc, prep.handle, e), 'unsupported');
    expect(err.message).toContain('still one of its admins');
  });

  it('never posts twice when a step is repeated after a crash', async () => {
    const e = env('tok', files);
    const inp = input({ placement: 'image', media: [image()] });
    const prep = await prepareUntilDone(li(), inp, acc, e);
    const first = await li().publish(inp, acc, prep.handle, e);
    const again = await li().publish(inp, acc, e.saved.at(-1)!, e);
    expect(again.externalId).toBe(first.externalId);
    expect(fake.posts.size).toBe(1);
  });

  it('finds its own post when the answer was lost, using the original that LinkedIn names in its refusal', async () => {
    const e = env('tok', files);
    const inp = input({ placement: 'image', media: [image()], text: 'We open at nine' });
    const prep = await prepareUntilDone(li(), inp, acc, e);
    fake.loseNextPostAnswer = true;
    await expectError(li().publish(inp, acc, prep.handle, e), 'transient');
    expect(e.saved.at(-1)!.postUrn).toBeUndefined();
    const retry = await li().publish(inp, acc, e.saved.at(-1)!, e);
    expect(fake.posts.size).toBe(1);
    expect(retry.externalId).toBe([...fake.posts.keys()][0]);
    expect(e.saved.at(-1)!.recovered).toBe(true);
  });

  it('still fails when the repeated post is an older one, which is not this attempt', async () => {
    const e = env('tok', files);
    fake.posts.set('urn:li:share:1', { id: 'urn:li:share:1', commentary: 'We open at nine', content: {}, createdAt: Date.now() - 5 * 86_400_000, lifecycleState: 'PUBLISHED' });
    const inp = input({ placement: 'image', media: [image()], text: 'We open at nine' });
    const prep = await prepareUntilDone(li(), inp, acc, e);
    const err = await expectError(li().publish(inp, acc, prep.handle, e), 'file_rejected');
    expect(err.message).toContain('duplicate');
  });

  it('hands the post to a person, naming the setting to change, when LinkedIn has retired the API version', async () => {
    fake.version = '202701';
    try {
      const err = await expectError(li().prepare(input({ placement: 'document', media: [pdf()] }), acc, {}, env('tok', files)), 'unsupported');
      expect(err.message).toContain('202604');
      expect(err.message).toContain('LINKEDIN_VERSION');
    } finally {
      fake.version = '202604';
    }
  });

  it('reports a revoked token as a lost connection, and a daily limit as a wait until the day turns', async () => {
    fake.revoked = true;
    await expectError(li().prepare(input({ placement: 'image', media: [image()] }), acc, {}, env('tok', files)), 'auth');
    fake.revoked = false;
    fake.fail((c) => c.path === '/rest/images', { status: 429, message: 'Resource level throttle limit for calls to this resource is reached' }, 429);
    const err = await expectError(li().prepare(input({ placement: 'image', media: [image()] }), acc, {}, env('tok', files)), 'rate_limit');
    expect(err.retryAfterSec).toBeGreaterThan(300);
    expect(err.retryAfterSec).toBeLessThanOrEqual(86_400 + 60);
  });
});

describe('LinkedIn: after publishing', () => {
  it('reads impressions as views, unique impressions as reach, and notes it is a running total', async () => {
    const e = env('tok', files);
    const inp = input({ placement: 'image', media: [image()] });
    const prep = await prepareUntilDone(li(), inp, acc, e);
    const pub = await li().publish(inp, acc, prep.handle, e);
    const m = await li().fetchMetrics!(acc, pub.externalId, {}, e, { publishedAt: new Date(), placement: 'image' });
    expect(m.common).toEqual({ views: 1500, reach: 1100, likes: 55, comments: 6, shares: 3 });
    expect(m.note).toContain('running total');
    await expectError(li().fetchMetrics!(acc, 'urn:li:share:99999', {}, e, { publishedAt: new Date(), placement: 'image' }), 'file_rejected');
  });

  it('reports a post that is gone as unknown', async () => {
    expect((await li().verify(acc, 'urn:li:share:99999', {}, env('tok'))).visibility).toBe('unknown');
  });
});
