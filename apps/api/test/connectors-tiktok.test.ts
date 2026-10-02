import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createConnectorSet } from '../src/connectors/registry.js';
import { TikTokClient } from '../src/connectors/tiktok/client.js';
import { createTikTok } from '../src/connectors/tiktok/tiktok.js';
import { FakeTikTok } from './fakes/tiktok.js';
import { account, configFor, env, expectError, image, input, media, prepareUntilDone, redirect } from './connector-helpers.js';

const fake = new FakeTikTok();
let set: ReturnType<typeof createConnectorSet>;
const tt = () => set.connector('tiktok')!;
const acc = (audited = false) => account('tiktok', { externalId: 'open-1', displayName: '@lumencoffee', providerData: { username: 'lumencoffee', audited } });
const files = { 'k/reel.mp4': Buffer.alloc(10_000, 3) };
/** What a person has to fill in for TikTok: who sees it, and the agreement. Nothing else is needed. */
const filled = (over: Record<string, unknown> = {}) => ({ privacy: 'PUBLIC_TO_EVERYONE', consent: true, ...over });
const errors = (issues: { severity: string }[]) => issues.filter((i) => i.severity === 'error');

beforeAll(async () => {
  await fake.start();
  set = createConnectorSet(configFor({ TIKTOK_CLIENT_KEY: fake.clientKey, TIKTOK_CLIENT_SECRET: fake.clientSecret, TIKTOK_OAUTH_URL: `${fake.url}/authorize/`, TIKTOK_API_URL: fake.url }));
});
afterAll(() => fake.stop());
beforeEach(() => {
  fake.reset();
  fake.accessTokens = new Set(['tok']);
  fake.refreshTokens.clear();
  fake.revoked = false;
  fake.audited = false;
  fake.privacyOptions = ['SELF_ONLY', 'MUTUAL_FOLLOW_FRIENDS', 'FOLLOWER_OF_CREATOR', 'PUBLIC_TO_EVERYONE'];
  fake.maxDurationSec = 600;
  fake.posts.clear();
  fake.statusPolls = 1;
  fake.failWith = null;
  fake.uploadUrlExpired = false;
  fake.videos = {};
  fake.creator = { commentDisabled: false, duetDisabled: false, stitchDisabled: false };
  fake.grantedScopes = ['user.info.basic', 'video.publish', 'video.upload', 'video.list'];
});

describe('TikTok: signing in', () => {
  it('asks for posting and reading permissions with the app key, comma separated', () => {
    const u = new URL(set.provider('tiktok')!.authorizeUrl!('s1', redirect));
    expect(u.searchParams.get('client_key')).toBe('tkey');
    expect(u.searchParams.get('scope')).toBe('user.info.basic,video.publish,video.upload,video.list');
    expect(u.searchParams.get('state')).toBe('s1');
  });

  it('finds the account and starts it as not audited, so every post is private', async () => {
    const found = await set.provider('tiktok')!.exchange!('good', redirect, 's');
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ network: 'tiktok', externalId: 'open-1', displayName: '@lumencoffee', providerData: { username: 'lumencoffee', displayName: 'Lumen Coffee', audited: false } });
    expect(found[0]!.token.refreshToken).toBeTruthy();
    expect(JSON.stringify(found[0]!.providerData)).not.toContain(found[0]!.token.accessToken);
  });

  it('asks for the account only with the fields user.info.basic grants, so sign-in is not refused with scope_not_authorized', async () => {
    await set.provider('tiktok')!.exchange!('good', redirect, 's');
    expect(fake.callsTo('/v2/user/info/')[0]!.query.fields).toBe('open_id,union_id,avatar_url,display_name');
    // The @username comes from creator_info; without it (no video.publish), the account still connects, under its display name.
    fake.grantedScopes = ['user.info.basic'];
    const found = await set.provider('tiktok')!.exchange!('good', redirect, 's');
    expect(found[0]).toMatchObject({ externalId: 'open-1', displayName: 'Lumen Coffee' });
    expect(found[0]!.providerData.username).toBeUndefined();
  });

  it('says so when TikTok refuses the code', async () => {
    await expectError(set.provider('tiktok')!.exchange!('bad', redirect, 's'), 'auth');
  });

  it('renews the token an hour ahead and keeps the new renewal token each time', async () => {
    const p = set.provider('tiktok')!;
    expect(p.refreshWindowSec).toBe(3600);
    const first = (await p.exchange!('good', redirect, 's'))[0]!.token;
    const second = await p.refresh!(first);
    expect(second.refreshToken).not.toBe(first.refreshToken);
    await expectError(p.refresh!(first), 'auth'); // the old one is used up
    expect(await p.refresh!(second)).toBeTruthy();
  });
});

describe('TikTok: the controls it obliges the app to show', () => {
  it('declares them, with nothing chosen for the person', () => {
    const opts = tt().capabilities().options!;
    const byKey = Object.fromEntries(opts.map((o) => [o.key, o]));
    expect(byKey.privacy).toMatchObject({ type: 'select', required: true });
    expect(byKey.privacy!.default).toBeUndefined(); // no default privacy
    for (const k of ['allowComment', 'allowDuet', 'allowStitch', 'commercial']) expect(byKey[k]!.default).toBe(false); // all unticked
    expect(byKey.consent!.notice).toBe("By posting, you agree to TikTok's Music Usage Confirmation.");
    expect(byKey.consentBranded!.notice).toBe("By posting, you agree to TikTok's Branded Content Policy and Music Usage Confirmation.");
    expect(byKey.consentBranded!.showWhen).toBe('brandedContent');
    expect(byKey.consent!.hideWhen).toBe('brandedContent'); // one agreement at a time
    expect(byKey.yourBrand!.showWhen).toBe('commercial');
    expect(byKey.yourBrand!.help).toContain("'Promotional content'");
    expect(byKey.brandedContent!.help).toContain("'Paid partnership'");
    expect(byKey.processing).toMatchObject({ type: 'info', label: expect.stringContaining('few minutes') });
  });

  it("builds them, while the post is written, from what TikTok says this creator may do", async () => {
    fake.privacyOptions = ['FOLLOWER_OF_CREATOR', 'SELF_ONLY'];
    fake.creator = { commentDisabled: true, duetDisabled: false, stitchDisabled: true };
    fake.maxDurationSec = 180;
    const r = await tt().accountOptions!(acc(true), env('tok'));
    const byKey = Object.fromEntries(r.fields.map((o) => [o.key, o]));
    expect(byKey.creator).toMatchObject({ type: 'info', label: 'Posting to TikTok as Lumen Coffee (@lumencoffee)' });
    // Only what TikTok offers, nothing chosen, and "Only me" not available for branded content.
    expect(byKey.privacy!.choices).toEqual([{ value: 'SELF_ONLY', label: 'Only me', disabledWhen: 'brandedContent' }, { value: 'FOLLOWER_OF_CREATOR', label: 'Followers' }]);
    expect(byKey.privacy!.default).toBeUndefined();
    expect(byKey.allowComment).toMatchObject({ disabled: true, default: false });
    expect(byKey.allowDuet!.disabled).toBeUndefined();
    expect(byKey.allowStitch!.disabled).toBe(true);
    expect(byKey.maxDuration!.label).toContain('180 seconds');
    expect(r.remember).toMatchObject({ username: 'lumencoffee', creatorInfo: { privacyLevelOptions: ['FOLLOWER_OF_CREATOR', 'SELF_ONLY'], commentDisabled: true, stitchDisabled: true, maxVideoPostDurationSec: 180, nickname: 'Lumen Coffee' } });
    // Until TikTok audits the app, only "Only me" is offered, and it says the TikTok account itself must be private.
    const unaudited = (await tt().accountOptions!(acc(false), env('tok'))).fields.find((f) => f.key === 'privacy')!;
    expect(unaudited.choices!.map((c) => c.value)).toEqual(['SELF_ONLY']);
    expect(unaudited.help).toContain('set to private');
  });

  it('checks a post against what TikTok said when it was written', () => {
    const known = (info: Record<string, unknown>) => account('tiktok', { externalId: 'open-1', providerData: { username: 'lumencoffee', audited: true, creatorInfo: { privacyLevelOptions: ['SELF_ONLY', 'FOLLOWER_OF_CREATOR'], ...info } } });
    const codes = (o: Record<string, unknown>, info: Record<string, unknown> = {}, m = media()) => tt().validate(input({ placement: 'video', media: [m], options: filled(o) }), known(info)).filter((i) => i.severity === 'error').map((i) => i.code);
    expect(codes({ privacy: 'PUBLIC_TO_EVERYONE' })).toEqual(['tiktok.privacy.unavailable']);
    expect(codes({ privacy: 'FOLLOWER_OF_CREATOR' })).toEqual([]);
    expect(codes({ privacy: 'FOLLOWER_OF_CREATOR', allowComment: true }, { commentDisabled: true })).toEqual(['tiktok.allowComment.disabled']);
    expect(codes({ privacy: 'FOLLOWER_OF_CREATOR', allowDuet: true, allowStitch: true }, { duetDisabled: true, stitchDisabled: true })).toEqual(['tiktok.allowDuet.disabled', 'tiktok.allowStitch.disabled']);
    expect(codes({ privacy: 'FOLLOWER_OF_CREATOR' }, { maxVideoPostDurationSec: 15 })).toEqual(['tiktok.duration']);
  });

  it('will not post until who can see it is chosen, and the agreement is ticked', () => {
    const none = tt().validate(input({ placement: 'video', options: {} }), acc(true));
    expect(none.map((i) => i.code)).toEqual(expect.arrayContaining(['tiktok.privacy', 'tiktok.consent']));
    expect(errors(tt().validate(input({ placement: 'video', options: filled() }), acc(true)))).toEqual([]);
    expect(tt().validate(input({ placement: 'video', options: filled({ privacy: 'EVERYONE' }) }), acc(true))).toContainEqual(expect.objectContaining({ code: 'tiktok.privacy.unavailable' }));
  });

  it('wants to know which kind of commercial content it is, and the stronger agreement for branded content', () => {
    const vague = tt().validate(input({ placement: 'video', options: filled({ commercial: true }) }), acc(true));
    expect(vague).toContainEqual(expect.objectContaining({ code: 'tiktok.commercial' }));
    const branded = tt().validate(input({ placement: 'video', options: filled({ commercial: true, brandedContent: true }) }), acc(true));
    expect(branded).toContainEqual(expect.objectContaining({ code: 'tiktok.consent.branded' }));
    const full = tt().validate(input({ placement: 'video', options: filled({ commercial: true, brandedContent: true, consentBranded: true }) }), acc(true));
    expect(errors(full)).toEqual([]);
    // The branded agreement replaces the plain one: it is the only one shown, and the only one needed.
    const onlyBranded = tt().validate(input({ placement: 'video', options: { privacy: 'PUBLIC_TO_EVERYONE', commercial: true, brandedContent: true, consentBranded: true } }), acc(true));
    expect(errors(onlyBranded)).toEqual([]);
    const own = tt().validate(input({ placement: 'video', options: filled({ commercial: true, yourBrand: true }) }), acc(true));
    expect(errors(own)).toEqual([]);
  });

  it('refuses branded content that is private', () => {
    const issues = tt().validate(input({ placement: 'video', options: filled({ privacy: 'SELF_ONLY', commercial: true, brandedContent: true, consentBranded: true }) }), acc(true));
    expect(issues).toContainEqual(expect.objectContaining({ code: 'tiktok.branded.private' }));
  });

  it('warns that every post is private until TikTok audits the app, and that photos need a verified domain', () => {
    expect(tt().validate(input({ placement: 'video', options: filled() }), acc(false))).toContainEqual(expect.objectContaining({ severity: 'warning', code: 'tiktok.unaudited', message: expect.stringContaining('TikTok account itself is set to private') }));
    expect(tt().validate(input({ placement: 'video', options: filled() }), acc(true)).some((i) => i.code === 'tiktok.unaudited')).toBe(false);
    expect(tt().validate(input({ placement: 'photo', media: [image()], options: filled() }), acc(true))).toContainEqual(expect.objectContaining({ code: 'tiktok.photo.domain' }));
  });

  it('takes 2200 characters, videos of 3 seconds to 10 minutes and up to 35 photos', () => {
    expect(tt().validate(input({ placement: 'video', text: 'x'.repeat(2201), options: filled() }), acc(true))).toContainEqual(expect.objectContaining({ code: 'text.length' }));
    expect(tt().validate(input({ placement: 'video', media: [media({ durationMs: 601_000 })], options: filled() }), acc(true))).toContainEqual(expect.objectContaining({ code: 'media.duration' }));
    const many = Array.from({ length: 36 }, (_, i) => image({ position: i }));
    expect(tt().validate(input({ placement: 'photo', media: many, options: filled() }), acc(true))).toContainEqual(expect.objectContaining({ code: 'media.count' }));
  });
});

describe('TikTok: before sending anything', () => {
  it('asks nothing ahead of the hour, and asks TikTok again right before sending, refusing a setting it no longer offers', async () => {
    fake.audited = true;
    const e = env('tok', files);
    const inp = input({ placement: 'video', options: filled() });
    const prep = await tt().prepare(inp, acc(true), {}, e);
    expect(prep.done).toBe(true);
    expect(fake.calls).toHaveLength(0);
    fake.privacyOptions = ['SELF_ONLY'];
    const err = await expectError(tt().publish(inp, acc(true), prep.handle, env('tok', files)), 'file_rejected');
    expect(err.message).toContain('Everyone');
    expect(fake.callsTo('/v2/post/publish/creator_info/query/')).toHaveLength(1);
    expect(fake.callsTo('/v2/post/publish/video/init/')).toHaveLength(0);
  });

  it('keeps off what the creator has switched off since the post was written', async () => {
    fake.audited = true;
    fake.creator = { commentDisabled: true, duetDisabled: true, stitchDisabled: false };
    const e = env('tok', files);
    const inp = input({ placement: 'video', media: [media({ bytes: 10_000 })], options: filled({ allowComment: true, allowDuet: true, allowStitch: true }) });
    const pub = await tt().publish(inp, acc(true), {}, e);
    expect(fake.posts.get(pub.externalId)!.info).toMatchObject({ disable_comment: true, disable_duet: true, disable_stitch: false });
  });

  it("refuses a video longer than this account may post, and waits when TikTok says it has posted too much", async () => {
    fake.maxDurationSec = 15;
    await expectError(tt().publish(input({ placement: 'video', options: filled() }), acc(true), {}, env('tok', files)), 'file_rejected');
    fake.maxDurationSec = 600;
    fake.fail((c) => c.path === '/v2/post/publish/creator_info/query/', { data: {}, error: { code: 'spam_risk_too_many_posts', message: 'Daily post limit reached' } }, 429);
    const err = await expectError(tt().publish(input({ placement: 'video', options: filled() }), acc(true), {}, env('tok', files)), 'rate_limit');
    expect(err.retryAfterSec).toBeGreaterThanOrEqual(3600);
  });
});

describe('TikTok: publishing a video', () => {
  it('forces the post to private until the app is audited, whatever was chosen, with every interaction off by default', async () => {
    const e = env('tok', files);
    const inp = input({ placement: 'video', text: 'Spring is here', media: [media({ bytes: 10_000 })], options: filled(), aiGenerated: true });
    const prep = await prepareUntilDone(tt(), inp, acc(false), e);
    const pub = await tt().publish(inp, acc(false), prep.handle, e);
    const post = fake.posts.get(pub.externalId)!;
    expect(post.info).toMatchObject({
      title: 'Spring is here', privacy_level: 'SELF_ONLY', disable_comment: true, disable_duet: true, disable_stitch: true,
      brand_content_toggle: false, brand_organic_toggle: false, is_aigc: true,
    });
  });

  it('uses the chosen privacy once the app is audited, and the interactions the person allowed', async () => {
    fake.audited = true;
    const e = env('tok', files);
    const inp = input({ placement: 'video', media: [media({ bytes: 10_000 })], options: filled({ allowComment: true, commercial: true, yourBrand: true }) });
    const prep = await prepareUntilDone(tt(), inp, acc(true), e);
    const pub = await tt().publish(inp, acc(true), prep.handle, e);
    expect(fake.posts.get(pub.externalId)!.info).toMatchObject({ privacy_level: 'PUBLIC_TO_EVERYONE', disable_comment: false, disable_duet: true, disable_stitch: true, brand_organic_toggle: true, brand_content_toggle: false, is_aigc: false });
  });

  it('uploads in pieces of the size it declared, in order, the last one taking what is left', async () => {
    const small = createTikTok(new TikTokClient({ clientKey: fake.clientKey, clientSecret: fake.clientSecret, oauthUrl: '', apiUrl: fake.url }), { chunkBytes: 4000 });
    const e = env('tok', files);
    const inp = input({ placement: 'video', media: [media({ bytes: 10_000 })], options: filled() });
    const prep = await prepareUntilDone(small, inp, acc(false), e);
    const pub = await small.publish(inp, acc(false), prep.handle, e);
    const post = fake.posts.get(pub.externalId)!;
    expect(post.received).toEqual([{ start: 0, end: 3999 }, { start: 4000, end: 9999 }]);
    expect(post.complete).toBe(true);
    expect(post.source).toMatchObject({ video_size: 10_000, chunk_size: 4000, total_chunk_count: 2 });
  });

  it('resumes from the first piece not yet accepted, without a second upload session', async () => {
    const small = createTikTok(new TikTokClient({ clientKey: fake.clientKey, clientSecret: fake.clientSecret, oauthUrl: '', apiUrl: fake.url }), { chunkBytes: 3000 });
    const e = env('tok', files);
    const inp = input({ placement: 'video', media: [media({ bytes: 10_000 })], options: filled() });
    const prep = await prepareUntilDone(small, inp, acc(false), e);
    fake.fail((c) => c.method === 'PUT' && c.path.startsWith('/upload/') && [...fake.posts.values()][0]!.received.length === 1, '', 503);
    await expectError(small.publish(inp, acc(false), prep.handle, e), 'transient');
    expect(e.saved.at(-1)!.chunksDone).toBe(1);
    const pub = await small.publish(inp, acc(false), e.saved.at(-1)!, e);
    expect(fake.callsTo('/v2/post/publish/video/init/')).toHaveLength(1);
    expect(fake.posts.get(pub.externalId)!.complete).toBe(true);
  });

  it('starts a fresh session when the upload address has expired', async () => {
    const e = env('tok', files);
    const inp = input({ placement: 'video', media: [media({ bytes: 10_000 })], options: filled() });
    const prep = await prepareUntilDone(tt(), inp, acc(false), e);
    fake.uploadUrlExpired = true;
    await expectError(tt().publish(inp, acc(false), prep.handle, e), 'transient');
    const kept = e.saved.at(-1)!;
    expect(kept.publishId).toBeUndefined();
    fake.uploadUrlExpired = false;
    const pub = await tt().publish(inp, acc(false), kept, e);
    expect(fake.callsTo('/v2/post/publish/video/init/')).toHaveLength(2);
    expect(fake.posts.get(pub.externalId)!.complete).toBe(true);
  });

  it('does not send the video again when a finished step is repeated', async () => {
    const e = env('tok', files);
    const inp = input({ placement: 'video', media: [media({ bytes: 10_000 })], options: filled() });
    const prep = await prepareUntilDone(tt(), inp, acc(false), e);
    const first = await tt().publish(inp, acc(false), prep.handle, e);
    const again = await tt().publish(inp, acc(false), e.saved.at(-1)!, e);
    expect(again.externalId).toBe(first.externalId);
    expect(fake.callsTo('/v2/post/publish/video/init/')).toHaveLength(1);
    expect(fake.callsTo(/^\/upload\//)).toHaveLength(1);
  });

  it('says the app is not audited, rather than failing, if TikTok refuses a non-private post', async () => {
    // The account is marked audited here but TikTok has not agreed: the refusal is a hand-over, not a retry.
    const e = env('tok', files);
    const inp = input({ placement: 'video', media: [media({ bytes: 10_000 })], options: filled() });
    const prep = await prepareUntilDone(tt(), inp, acc(true), e);
    const err = await expectError(tt().publish(inp, acc(true), prep.handle, e), 'unsupported');
    expect(err.message).toContain('audited');
    expect(err.message).toContain('set to private');
  });
});

describe('TikTok: publishing photos', () => {
  it('asks TikTok to pull the photos from their addresses, with a short title and the text as description', async () => {
    const e = env('tok');
    const long = 'T'.repeat(120);
    const inp = input({ placement: 'photo', media: [image(), image({ position: 1, url: 'https://media.test/b.jpg' })], title: long, text: 'Spring', options: filled() });
    const prep = await prepareUntilDone(tt(), inp, acc(false), e);
    const pub = await tt().publish(inp, acc(false), prep.handle, e);
    const post = fake.posts.get(pub.externalId)!;
    expect(post.info.title).toHaveLength(90);
    expect(post.info.description).toBe('Spring');
    expect(post.source.photo_images).toEqual(['https://media.test/photo.jpg?sig=1', 'https://media.test/b.jpg']);
  });

  it('hands the post to a person, naming the cause, when the media domain is not verified with TikTok', async () => {
    fake.verifiedDomain = 'https://somewhere-else.test';
    const e = env('tok');
    const inp = input({ placement: 'photo', media: [image()], options: filled() });
    const prep = await prepareUntilDone(tt(), inp, acc(false), e);
    const err = await expectError(tt().publish(inp, acc(false), prep.handle, e), 'unsupported');
    expect(err.message).toContain('domain verified');
    fake.verifiedDomain = 'https://media.test';
  });
});

describe('TikTok: after publishing', () => {
  async function posted(audited: boolean, privacy = 'PUBLIC_TO_EVERYONE') {
    fake.audited = audited;
    const e = env('tok', files);
    const inp = input({ placement: 'video', media: [media({ bytes: 10_000 })], options: filled({ privacy }) });
    const prep = await prepareUntilDone(tt(), inp, acc(audited), e);
    const pub = await tt().publish(inp, acc(audited), prep.handle, e);
    return { e, pub, handle: e.saved.at(-1)! };
  }

  it('says processing first, then private with the reason while the app is not audited', async () => {
    const { e, pub, handle } = await posted(false);
    expect((await tt().verify(acc(false), pub.externalId, handle, e)).visibility).toBe('processing');
    const done = await tt().verify(acc(false), pub.externalId, handle, e);
    expect(done.visibility).toBe('private');
    expect(done.note).toContain('not audited');
    expect(done.handle).toBeUndefined(); // a private post has no public id yet
  });

  it('says public, with the address and the id to read numbers by, once audited and public', async () => {
    const { e, pub, handle } = await posted(true);
    await tt().verify(acc(true), pub.externalId, handle, e);
    const done = await tt().verify(acc(true), pub.externalId, handle, e);
    expect(done.visibility).toBe('public');
    expect(done.url).toMatch(/^https:\/\/www\.tiktok\.com\/@lumencoffee\/video\/\d+$/);
    expect(done.handle!.postId).toMatch(/^\d+$/);
  });

  it('says private, as chosen, when the audited account chose Only me', async () => {
    const { e, pub, handle } = await posted(true, 'SELF_ONLY');
    await tt().verify(acc(true), pub.externalId, handle, e);
    const done = await tt().verify(acc(true), pub.externalId, handle, e);
    expect(done.visibility).toBe('private');
    expect(done.note).toContain('as chosen');
  });

  it('turns a post TikTok failed to publish into a rejection with its reason', async () => {
    const { e, pub, handle } = await posted(true);
    fake.failWith = 'video_format_check_failed';
    const err = await expectError(tt().verify(acc(true), pub.externalId, handle, e), 'file_rejected');
    expect(err.message).toContain('video_format_check_failed');
  });

  it('reads views, likes, comments and shares, and says there is nothing to read for a private post', async () => {
    const { e } = await posted(true);
    fake.videos['7700'] = { id: '7700', view_count: 4100, like_count: 310, comment_count: 22, share_count: 40 };
    const m = await tt().fetchMetrics!(acc(true), 'pub', { postId: '7700' }, e, { publishedAt: new Date(), placement: 'video' });
    expect(m.common).toEqual({ views: 4100, likes: 310, comments: 22, shares: 40 });
    expect(m.note).toContain('no reach');
    const none = await tt().fetchMetrics!(acc(true), 'pub', {}, e, { publishedAt: new Date(), placement: 'video' });
    expect(none.common).toEqual({});
    expect(none.note).toContain('private post');
  });

  it('checks the connection, and reports a revoked one as lost', async () => {
    expect(await tt().health!(acc(true), env('tok'))).toEqual({ valid: true });
    fake.revoked = true;
    await expectError(tt().health!(acc(true), env('tok')), 'auth');
  });
});
