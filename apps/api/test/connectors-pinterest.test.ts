import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createConnectorSet } from '../src/connectors/registry.js';
import { FakePinterest } from './fakes/pinterest.js';
import { account, configFor, env, expectError, image, input, media, prepareUntilDone, redirect } from './connector-helpers.js';

const fake = new FakePinterest();
let set: ReturnType<typeof createConnectorSet>;
const pin = () => set.connector('pinterest')!;
const acc = (audited = false) => account('pinterest', { externalId: 'b1', displayName: 'lumencoffee · Spring menu', providerData: { boardId: 'b1', username: 'lumencoffee', audited } });
const files = { 'k/reel.mp4': Buffer.alloc(8000, 3) };
const cover = () => media({ kind: 'cover', name: 'cover.jpg', mime: 'image/jpeg', key: 'k/cover.jpg', url: 'https://media.test/cover.jpg?sig=1', width: 1080, height: 1920, durationMs: null });

beforeAll(async () => {
  await fake.start();
  set = createConnectorSet(configFor({ PINTEREST_APP_ID: fake.clientId, PINTEREST_APP_SECRET: fake.clientSecret, PINTEREST_OAUTH_URL: `${fake.url}/oauth/`, PINTEREST_API_URL: fake.url }));
});
afterAll(() => fake.stop());
beforeEach(() => {
  fake.reset();
  fake.accessTokens = new Set(['tok']);
  fake.revoked = false;
  fake.pins.clear();
  fake.media.clear();
  fake.pageSize = 100;
  fake.videoPolls = 1;
  fake.failVideo = false;
  fake.loseNextPinAnswer = false;
  fake.boards = [{ id: 'b1', name: 'Spring menu', privacy: 'PUBLIC' }, { id: 'b2', name: 'Behind the bar', privacy: 'PUBLIC' }];
});

describe('Pinterest: signing in', () => {
  it('asks for the board and pin permissions', () => {
    const u = new URL(set.provider('pinterest')!.authorizeUrl!('s1', redirect));
    expect(u.searchParams.get('scope')).toBe('boards:read,pins:read,pins:write,user_accounts:read');
    expect(u.searchParams.get('client_id')).toBe('pid');
  });

  it('offers each board as an account, across pages, all starting as not yet approved by Pinterest', async () => {
    fake.boards = Array.from({ length: 5 }, (_, i) => ({ id: `b${i}`, name: `Board ${i}`, privacy: 'PUBLIC' }));
    fake.pageSize = 2;
    const found = await set.provider('pinterest')!.exchange!('good', redirect, 's');
    expect(found.map((c) => c.externalId)).toEqual(['b0', 'b1', 'b2', 'b3', 'b4']);
    expect(found[0]).toMatchObject({ network: 'pinterest', displayName: 'lumencoffee · Board 0', providerData: { boardId: 'b0', username: 'lumencoffee', audited: false } });
    expect(fake.callsTo('/v5/boards')).toHaveLength(3);
    const basic = fake.callsTo('/v5/oauth/token')[0]!.headers.authorization;
    expect(basic).toMatch(/^Basic /);
  });

  it('says what to do when there is no board', async () => {
    fake.boards = [];
    await expectError(set.provider('pinterest')!.exchange!('good', redirect, 's'), 'auth');
  });

  it('renews the token three days ahead, and asks to reconnect when the renewal is refused', async () => {
    const p = set.provider('pinterest')!;
    expect(p.refreshWindowSec).toBe(3 * 86_400);
    const near = { accessToken: 'tok', refreshToken: 'pref-1', expiresAt: new Date(Date.now() + 2 * 86_400_000).toISOString() };
    expect((await p.refresh!(near)).accessToken).toMatch(/^tok-/);
    fake.revoked = true;
    await expectError(p.refresh!({ ...near, expiresAt: new Date(Date.now() + 3_600_000).toISOString() }), 'auth');
  });
});

describe('Pinterest: what it accepts', () => {
  it('needs a title, a usable link and, for a video, a cover', () => {
    const noTitle = pin().validate(input({ placement: 'image_pin', media: [image()], title: '' }), acc(true));
    expect(noTitle).toContainEqual(expect.objectContaining({ severity: 'error', code: 'title.missing' }));
    const badLink = pin().validate(input({ placement: 'image_pin', media: [image()], options: { link: 'javascript:alert(1)' } }), acc(true));
    expect(badLink).toContainEqual(expect.objectContaining({ severity: 'error', code: 'link.invalid' }));
    const noCover = pin().validate(input({ placement: 'video_pin' }), acc(true));
    expect(noCover).toContainEqual(expect.objectContaining({ severity: 'error', code: 'cover.missing' }));
    expect(pin().validate(input({ placement: 'video_pin', media: [media(), cover()] }), acc(true)).filter((i) => i.severity === 'error')).toEqual([]);
  });

  it('warns that Trial access shows the pin only to its creator, until the account is marked approved', () => {
    const trial = pin().validate(input({ placement: 'image_pin', media: [image()] }), acc(false));
    expect(trial).toContainEqual(expect.objectContaining({ severity: 'warning', code: 'pinterest.trial' }));
    expect(pin().validate(input({ placement: 'image_pin', media: [image()] }), acc(true)).some((i) => i.code === 'pinterest.trial')).toBe(false);
  });

  it('takes 800 characters of description, a video of 4 seconds to 15 minutes, and 2 to 5 pictures in a carousel', () => {
    expect(pin().validate(input({ placement: 'image_pin', media: [image()], text: 'x'.repeat(801) }), acc(true))).toContainEqual(expect.objectContaining({ code: 'text.length' }));
    expect(pin().validate(input({ placement: 'video_pin', media: [media({ durationMs: 3000 }), cover()] }), acc(true))).toContainEqual(expect.objectContaining({ code: 'media.duration' }));
    const six = Array.from({ length: 6 }, (_, i) => image({ position: i }));
    expect(pin().validate(input({ placement: 'carousel_pin', media: six }), acc(true))).toContainEqual(expect.objectContaining({ code: 'media.count' }));
  });
});

describe('Pinterest: publishing', () => {
  it('pins a picture from its address on the chosen board, with its link and alt text', async () => {
    const e = env('tok');
    const inp = input({ placement: 'image_pin', media: [image()], title: 'Spring menu', text: 'Fresh and green', options: { link: 'https://lumen.example/menu', altText: 'The menu' } });
    const prep = await prepareUntilDone(pin(), inp, acc(true), e);
    expect(prep.looks).toBe(1); // nothing to upload
    const pub = await pin().publish(inp, acc(true), prep.handle, e);
    const made = fake.pins.get(pub.externalId)!;
    expect(made).toMatchObject({ board_id: 'b1', title: 'Spring menu', description: 'Fresh and green', link: 'https://lumen.example/menu', alt_text: 'The menu' });
    expect(made.media_source).toEqual({ source_type: 'image_url', url: 'https://media.test/photo.jpg?sig=1' });
    expect(pub.url).toBe(`https://www.pinterest.com/pin/${pub.externalId}/`);
  });

  it('pins a carousel of pictures', async () => {
    const e = env('tok');
    const inp = input({ placement: 'carousel_pin', media: [image(), image({ position: 1, url: 'https://media.test/b.jpg' })], options: { link: 'https://lumen.example' } });
    const prep = await prepareUntilDone(pin(), inp, acc(true), e);
    const pub = await pin().publish(inp, acc(true), prep.handle, e);
    const src = fake.pins.get(pub.externalId)!.media_source;
    expect(src.source_type).toBe('multiple_image_urls');
    expect(src.items.map((i: any) => i.url)).toEqual(['https://media.test/photo.jpg?sig=1', 'https://media.test/b.jpg']);
  });

  it('uploads a video to the address Pinterest gave with its parameters first, waits for processing, and pins it with its cover', async () => {
    const e = env('tok', files);
    const inp = input({ placement: 'video_pin', media: [media({ bytes: 8000 }), cover()] });
    const prep = await prepareUntilDone(pin(), inp, acc(true), e);
    expect(prep.looks).toBeGreaterThan(1);
    expect(fake.callsTo('/v5/media', 'POST')).toHaveLength(1);
    expect([...fake.media.values()][0]!.fieldsBeforeFile).toBe(true);
    const pub = await pin().publish(inp, acc(true), prep.handle, e);
    expect(fake.pins.get(pub.externalId)!.media_source).toMatchObject({ source_type: 'video_id', cover_image_url: 'https://media.test/cover.jpg?sig=1' });
  });

  it('turns a video Pinterest cannot process into a rejection', async () => {
    fake.failVideo = true;
    await expectError(prepareUntilDone(pin(), input({ placement: 'video_pin', media: [media({ bytes: 8000 }), cover()] }), acc(true), env('tok', files)), 'file_rejected');
  });

  it('never makes a second pin when a step is repeated after a crash', async () => {
    const e = env('tok');
    const inp = input({ placement: 'image_pin', media: [image()] });
    const prep = await prepareUntilDone(pin(), inp, acc(true), e);
    const first = await pin().publish(inp, acc(true), prep.handle, e);
    const again = await pin().publish(inp, acc(true), e.saved.at(-1)!, e);
    expect(again.externalId).toBe(first.externalId);
    expect(fake.pins.size).toBe(1);
  });

  it('looks for its pin on the board when the answer was lost, before making another', async () => {
    const e = env('tok');
    const inp = input({ placement: 'image_pin', media: [image()], title: 'Opening hours' });
    const prep = await prepareUntilDone(pin(), inp, acc(true), e);
    fake.loseNextPinAnswer = true;
    await expectError(pin().publish(inp, acc(true), prep.handle, e), 'transient');
    expect(fake.pins.size).toBe(1);
    const retry = await pin().publish(inp, acc(true), e.saved.at(-1)!, e);
    expect(fake.pins.size).toBe(1);
    expect(retry.externalId).toBe([...fake.pins.keys()][0]);
    expect(e.saved.at(-1)!.recovered).toBe(true);
  });

  it('does not mistake an old pin with the same title for its own', async () => {
    const e = env('tok');
    fake.pins.set('4000', { id: '4000', board_id: 'b1', title: 'Opening hours', created_at: new Date(Date.now() - 5 * 86_400_000).toISOString() });
    const inp = input({ placement: 'image_pin', media: [image()], title: 'Opening hours' });
    const prep = await prepareUntilDone(pin(), inp, acc(true), e);
    await pin().publish(inp, acc(true), { ...prep.handle, attemptedAt: new Date().toISOString() }, e);
    expect(fake.pins.size).toBe(2); // the old one stayed, a new one was made
  });

  it('reports a missing board as a rejection and a revoked token as a lost connection', async () => {
    const e = env('tok');
    const inp = input({ placement: 'image_pin', media: [image()] });
    const gone = { ...acc(true), externalId: 'nope' };
    await expectError(pin().publish(inp, gone, {}, e), 'file_rejected');
    fake.revoked = true;
    await expectError(pin().publish(inp, acc(true), {}, e), 'auth');
  });

  it('waits for as long as Pinterest says when the rate limit is hit', async () => {
    fake.fail((c) => c.path === '/v5/pins', { code: 8, message: 'Too many requests' }, 429, 1, { 'retry-after': '120' });
    const err = await expectError(pin().publish(input({ placement: 'image_pin', media: [image()] }), acc(true), {}, env('tok')), 'rate_limit');
    expect(err.retryAfterSec).toBe(120);
  });
});

describe('Pinterest: after publishing', () => {
  it('says the pin is private while the app is on Trial, and public once the account is marked approved', async () => {
    const e = env('tok');
    const inp = input({ placement: 'image_pin', media: [image()] });
    const prep = await prepareUntilDone(pin(), inp, acc(false), e);
    const pub = await pin().publish(inp, acc(false), prep.handle, e);
    const trial = await pin().verify(acc(false), pub.externalId, {}, e);
    expect(trial.visibility).toBe('private');
    expect(trial.note).toContain('Standard access');
    expect((await pin().verify(acc(true), pub.externalId, {}, e)).visibility).toBe('public');
    expect((await pin().verify(acc(true), '99999', {}, e)).visibility).toBe('unknown');
  });

  it('reads impressions as views and saves, converts the average watch time to seconds, and keeps clicks in the full answer', async () => {
    const e = env('tok');
    const inp = input({ placement: 'image_pin', media: [image()] });
    const prep = await prepareUntilDone(pin(), inp, acc(true), e);
    const pub = await pin().publish(inp, acc(true), prep.handle, e);
    const m = await pin().fetchMetrics!(acc(true), pub.externalId, {}, e, { publishedAt: new Date(Date.now() - 86_400_000), placement: 'image_pin' });
    expect(m.common).toEqual({ views: 800, saves: 33, avgWatchSeconds: 12.5 });
    expect((m.raw as any).all.lifetime_metrics.PIN_CLICK).toBe(20);
  });

  it('never asks for more than the 90 days Pinterest answers for, even for an old pin', async () => {
    const e = env('tok');
    const inp = input({ placement: 'image_pin', media: [image()] });
    const prep = await prepareUntilDone(pin(), inp, acc(true), e);
    const pub = await pin().publish(inp, acc(true), prep.handle, e);
    await pin().fetchMetrics!(acc(true), pub.externalId, {}, e, { publishedAt: new Date(Date.now() - 200 * 86_400_000), placement: 'image_pin' });
    const q = fake.callsTo(/analytics$/)[0]!.query;
    expect((Date.parse(q.end_date!) - Date.parse(q.start_date!)) / 86_400_000).toBeLessThanOrEqual(90);
  });

  it('checks the connection and reports when it ends', async () => {
    const expiresAt = new Date(Date.now() + 9 * 86_400_000).toISOString();
    expect(await pin().health!(acc(true), env('tok', {}, () => new Date(), { expiresAt }))).toEqual({ valid: true, expiresAt });
    fake.revoked = true;
    await expectError(pin().health!(acc(true), env('tok')), 'auth');
  });
});
