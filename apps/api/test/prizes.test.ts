import { createHash, createHmac, randomBytes } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { handleComment, matches, normalize, pollComments, purgePrizeData, scanPrizeDeliveries } from '../src/services/prizes.js';
import { createEnv, type Env } from './helpers.js';

const SECRET = 'secret'; // META_APP_SECRET of the test server
let env: Env;
let ig: string, fb: string, yt: string;
let prizeId: string;

beforeAll(async () => {
  env = await createEnv({ META_WEBHOOK_VERIFY_TOKEN: 'verify-me', PRIZE_POLL_SECONDS: '1' }, { fakes: true });
  ig = await env.connect('instagram');
  fb = await env.connect('facebook');
  yt = await env.connect('youtube');
  // Connected with prizes on: the permissions to message people were granted.
  await env.db.query(`update social_account set granted_permissions = $2 where id = $1`, [ig, JSON.stringify(['instagram_basic', 'instagram_manage_messages'])]);
  await env.db.query(`update social_account set granted_permissions = $2 where id = $1`, [fb, JSON.stringify(['pages_show_list', 'pages_messaging'])]);
});
afterAll(async () => { await env.close(); });

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const at = (ms: number) => new Date(env.clock.now().getTime() + ms);
const sha = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');
const brandUrl = (p: string) => `/api/brands/${env.brandId}${p}`;
const admin = () => env.users.admin;
const rowOf = async (id: string) => (await env.db.one('select * from prize_delivery where id = $1', [id]))!;
const deliveries = async (pubId?: string) => await env.db.query(`select * from prize_delivery ${pubId ? 'where publication_id = $1' : ''} order by comment_at, id`, pubId ? [pubId] : []);

beforeEach(async () => {
  // Each test starts without the rules of the ones before it (their deliveries and poll marks go with them).
  await env.db.query('delete from prize_rule');
  env.meta.failures.length = 0;
  env.meta.calls.length = 0;
  env.meta.messages.length = 0;
  env.meta.commentFeed = {};
  env.meta.commentPageSize = 50;
  env.meta.messagingPermission = true;
  env.google.audited = false;
  // Prizes on, with the default retention, unless a test says otherwise.
  await env.call(admin(), 'PATCH', brandUrl(''), { prizes: { enabled: true, retention_days: 30, auto_notice: 'This is an automatic message.' } });
});

let n = 0;
/** A post that is live on an account, with its network id. */
async function published(account: string, o: { kind?: string; format?: string; files?: { name: string; mime: string; kind: string }[] } = {}) {
  const { users, call, makePiece, newVersion, approve } = env;
  const { variantId } = await makePiece(users.producer, o.kind ?? 'video', o.format ?? '9:16');
  const v = await newVersion(users.producer, variantId, o.files ?? [{ name: 'reel.mp4', mime: 'video/mp4', kind: 'video' }]);
  await approve(users.approver, v.body.id, [account]);
  const r = await call(users.approver, 'POST', `/api/versions/${v.body.id}/publications`, { accountId: account, scheduledAt: at(2 * HOUR).toISOString(), text: 'Win our spring recipe book. Comment RECIPE. Replies are automatic.' });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  env.clock.set(new Date(r.body.prepare_at));
  await env.settle();
  env.clock.advance(11_000);
  await env.settle();
  env.clock.set(new Date(r.body.scheduled_at));
  await env.settle();
  env.clock.advance(60_000);
  await env.settle();
  const p = (await env.db.one('select * from publication where id = $1', [r.body.id]))!;
  expect(p.status).toBe('published');
  // An hour on, so there is room for comments after the post and before now.
  env.clock.advance(HOUR);
  return { id: r.body.id as string, externalId: p.external_id as string };
}

async function linkPrize(name = 'Recipe book') {
  const r = await env.call(admin(), 'POST', brandUrl('/prizes'), { kind: 'link', name, url: 'https://lumen.example/recipes.pdf' });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body.prize.id as string;
}

const RULE = { keyword: 'Recipe', message: 'Hi {{name}}! Here is your {{prize}}: {{link}} (it works for {{hours}} hours).', linkHours: 72, noticeConfirmed: true, active: true };
async function ruleOn(pubId: string, over: Record<string, unknown> = {}) {
  prizeId ??= await linkPrize();
  const r = await env.call(admin(), 'PUT', `/api/publications/${pubId}/prize`, { prizeId, ...RULE, ...over });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return r.body;
}

let cid = 0;
function comment(post: string, o: Partial<{ id: string; text: string; at: number; personId: string; username: string; parent_id: string }> = {}) {
  const c = { id: o.id ?? `cm-${++cid}`, text: 'I want the recipe!', at: env.clock.now().getTime() - MIN, personId: 'user-ana', username: 'ana_lopez', ...o };
  (env.meta.commentFeed[post] ??= []).push(c);
  return c;
}

describe('what counts as the keyword', () => {
  it('ignores case, accents and marks, and wants the whole word', () => {
    expect(normalize('  Récétá   ÑANDÚ ')).toBe('receta nandu');
    const k = normalize('Receta');
    for (const t of ['receta', 'RECETA!', 'Quiero la récétá', 'la receta, por favor', '🔥receta🔥', 'Receta']) expect(matches(t, k), t).toBe(true);
    for (const t of ['recetas', 'prereceta', 'rece ta', 'nothing', '']) expect(matches(t, k), t).toBe(false);
    expect(matches('Send me the SPRING recipe', normalize('spring recipe'))).toBe(true);
    expect(matches('a.b', normalize('a.b'))).toBe(true); // characters that mean something in a pattern are plain text
    expect(matches('a-b', normalize('a.b'))).toBe(false);
  });
});

describe('the library of prizes', () => {
  it('keeps a link, or a file once its bytes have arrived and match what was declared', async () => {
    const data = randomBytes(2000);
    const r = await env.call(admin(), 'POST', brandUrl('/prizes'), { kind: 'file', name: 'Menu PDF', file: { name: 'menu spring.pdf', mime: 'application/pdf', bytes: data.length, sha256: sha(data) } });
    expect(r.status).toBe(201);
    expect(r.body.prize).toMatchObject({ kind: 'file', usable: false, file_name: 'menu spring.pdf' });
    // Not usable until it has been uploaded.
    const early = await env.call(admin(), 'POST', `/api/prizes/${r.body.prize.id}/complete`);
    expect(early.status).toBe(409);
    expect(early.body.error.code).toBe('not_uploaded');
    const url = new URL(r.body.upload.url);
    const put = await env.app.inject({ method: 'PUT', url: url.pathname + url.search, headers: r.body.upload.headers, payload: data });
    expect(put.statusCode).toBe(200);
    const done = await env.call(admin(), 'POST', `/api/prizes/${r.body.prize.id}/complete`);
    expect(done.body).toMatchObject({ usable: true });
    const pub = await published(ig);
    const asRule = await env.call(admin(), 'PUT', `/api/publications/${pub.id}/prize`, { prizeId: r.body.prize.id, ...RULE });
    expect(asRule.status).toBe(200);
  });

  it('refuses a prize that is not usable yet, and one that does not belong to the brand', async () => {
    const data = randomBytes(100);
    const r = await env.call(admin(), 'POST', brandUrl('/prizes'), { kind: 'file', name: 'Pending', file: { name: 'a.pdf', mime: 'application/pdf', bytes: 100, sha256: sha(data) } });
    const pub = await published(ig);
    const early = await env.call(admin(), 'PUT', `/api/publications/${pub.id}/prize`, { prizeId: r.body.prize.id, ...RULE });
    expect(early.body.error.code).toBe('prize_not_ready');
    const other = await env.call(admin(), 'PUT', `/api/publications/${pub.id}/prize`, { prizeId: '00000000-0000-0000-0000-000000000000', ...RULE });
    expect(other.body.error.code).toBe('unknown_prize');
  });

  it('rejects a file whose content is not the one declared', async () => {
    const data = randomBytes(300);
    const r = await env.call(admin(), 'POST', brandUrl('/prizes'), { kind: 'file', name: 'Liar', file: { name: 'a.zip', mime: 'application/zip', bytes: data.length, sha256: sha(Buffer.from('something else')) } });
    const url = new URL(r.body.upload.url);
    const put = await env.app.inject({ method: 'PUT', url: url.pathname + url.search, headers: r.body.upload.headers, payload: data });
    expect(put.statusCode).toBeGreaterThanOrEqual(400); // storage itself refuses what does not match
    expect((await env.call(admin(), 'POST', `/api/prizes/${r.body.prize.id}/complete`)).status).toBe(409);
  });

  it('only takes web addresses and files of a sensible size', async () => {
    expect((await env.call(admin(), 'POST', brandUrl('/prizes'), { kind: 'link', name: 'x', url: 'javascript:alert(1)' })).status).toBe(400);
    expect((await env.call(admin(), 'POST', brandUrl('/prizes'), { kind: 'file', name: 'x', file: { name: 'a.bin', mime: 'application/octet-stream', bytes: 300 * 1024 * 1024, sha256: sha('x') } })).status).toBe(400);
  });

  it('is for approvers and admins; others cannot even look', async () => {
    expect((await env.call(env.users.approver, 'POST', brandUrl('/prizes'), { kind: 'link', name: 'By approver', url: 'https://x.example/a' })).status).toBe(201);
    for (const u of [env.users.reviewer, env.users.producer, env.users.reader]) {
      expect((await env.call(u, 'POST', brandUrl('/prizes'), { kind: 'link', name: 'x', url: 'https://x.example/a' })).status).toBe(403);
      expect((await env.call(u, 'GET', brandUrl('/prizes'))).status).toBe(403);
    }
    const list = await env.call(admin(), 'GET', brandUrl('/prizes'));
    expect(list.body.map((p: any) => p.name)).toContain('By approver');
  });

  it('can archive a prize, which then cannot be put on a new post but keeps working where it is', async () => {
    const pid = await linkPrize('Old book');
    const a = await published(ig);
    await env.call(admin(), 'PUT', `/api/publications/${a.id}/prize`, { prizeId: pid, ...RULE });
    expect((await env.call(admin(), 'POST', `/api/prizes/${pid}/archive`)).status).toBe(200);
    const b = await published(ig);
    expect((await env.call(admin(), 'PUT', `/api/publications/${b.id}/prize`, { prizeId: pid, ...RULE })).body.error.code).toBe('prize_archived');
    expect((await env.call(admin(), 'PUT', `/api/publications/${a.id}/prize`, { prizeId: pid, ...RULE, keyword: 'book' })).status).toBe(200); // the post that already had it
  });
});

describe('the rule on a post', () => {
  it('will not run while prizes are off for the brand', async () => {
    await env.call(admin(), 'PATCH', brandUrl(''), { prizes: { enabled: false } });
    const pub = await published(ig);
    prizeId ??= await linkPrize();
    const r = await env.call(admin(), 'PUT', `/api/publications/${pub.id}/prize`, { prizeId, ...RULE });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('prizes_off');
    // It can be saved switched off, to be started later.
    expect((await env.call(admin(), 'PUT', `/api/publications/${pub.id}/prize`, { prizeId, ...RULE, active: false, noticeConfirmed: false })).status).toBe(200);
  });

  it("will not run until a person confirms the post's text tells people the reply is automatic", async () => {
    const pub = await published(ig);
    prizeId ??= await linkPrize();
    const r = await env.call(admin(), 'PUT', `/api/publications/${pub.id}/prize`, { prizeId, ...RULE, noticeConfirmed: false });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('notice_required');
    expect(r.body.error.message).toContain('automatic');
  });

  it('wants the link in the message, and a keyword with something in it', async () => {
    const pub = await published(ig);
    prizeId ??= await linkPrize();
    expect((await env.call(admin(), 'PUT', `/api/publications/${pub.id}/prize`, { prizeId, ...RULE, message: 'Thanks for commenting!' })).body.error.code).toBe('link_missing');
    expect((await env.call(admin(), 'PUT', `/api/publications/${pub.id}/prize`, { prizeId, ...RULE, keyword: '  ¡¿ ' })).status).toBe(200); // punctuation is still a keyword here
    expect((await env.call(admin(), 'PUT', `/api/publications/${pub.id}/prize`, { prizeId, ...RULE, keyword: '' })).status).toBe(400);
    expect((await env.call(admin(), 'PUT', `/api/publications/${pub.id}/prize`, { prizeId, ...RULE, message: 'x'.repeat(701) + '{{link}}' })).status).toBe(400);
  });

  it('says to connect the account again when it was connected without the permission to message people', async () => {
    await env.db.query(`update social_account set granted_permissions = '[]' where id = $1`, [ig]);
    try {
      const pub = await published(ig);
      prizeId ??= await linkPrize();
      const r = await env.call(admin(), 'PUT', `/api/publications/${pub.id}/prize`, { prizeId, ...RULE });
      expect(r.body.error.code).toBe('needs_reconnect');
      expect(r.body.error.message).toContain('Connect it again');
      const view = await env.call(admin(), 'GET', `/api/publications/${pub.id}/prize`);
      expect(view.body).toMatchObject({ mode: 'private_reply', can_message: false, prizes_enabled: true });
    } finally {
      await env.db.query(`update social_account set granted_permissions = $2 where id = $1`, [ig, JSON.stringify(['instagram_basic', 'instagram_manage_messages'])]);
    }
  });

  it('stores the keyword as it is compared, keeps it editable, and records who changed what', async () => {
    const pub = await published(ig);
    const v1 = await ruleOn(pub.id, { keyword: 'RÉCIPE' });
    expect(v1).toMatchObject({ mode: 'private_reply', active: true, keyword: 'RÉCIPE', prize: { name: 'Recipe book' } });
    expect((await env.db.one('select keyword_norm from prize_rule where publication_id = $1', [pub.id]))!.keyword_norm).toBe('recipe');
    await ruleOn(pub.id, { keyword: 'book' });
    expect((await env.db.query('select 1 from prize_rule where publication_id = $1', [pub.id]))).toHaveLength(1);
    const log = await env.db.query(`select action, before, after from audit_event where entity = 'prize_rule' order by id`);
    expect(log.map((l) => l.action).slice(-2)).toEqual(['prize.rule_set', 'prize.rule_changed']);
    expect(log.at(-1)!.before.keyword).toBe('RÉCIPE');
    expect(log.at(-1)!.after.keyword).toBe('book');
  });

  it('on a network that cannot message people, only gives a public page, with no permission needed', async () => {
    const pub = await published(yt);
    const r = await ruleOn(pub.id, { active: true });
    expect(r.mode).toBe('public_link');
    expect(r.public_url).toMatch(/\/prize\/[\w-]{20,}$/);
    // Nothing reads comments or sends anything there.
    expect(await pollComments(env.ctx)).toBe(0);
  });

  it('is for approvers and admins, and a cancelled post cannot carry one', async () => {
    const pub = await published(ig);
    prizeId ??= await linkPrize();
    for (const u of [env.users.reviewer, env.users.producer, env.users.reader]) {
      expect((await env.call(u, 'PUT', `/api/publications/${pub.id}/prize`, { prizeId, ...RULE })).status).toBe(403);
      expect((await env.call(u, 'GET', `/api/publications/${pub.id}/prize`)).status).toBe(403);
    }
    await env.db.query(`update publication set status = 'cancelled' where id = $1`, [pub.id]);
    expect((await env.call(admin(), 'PUT', `/api/publications/${pub.id}/prize`, { prizeId, ...RULE })).body.error.code).toBe('publication_closed');
  });
});

describe('finding the comments by asking for them', () => {
  it('queues each person who said the keyword on a top-level comment, once, and nobody else', async () => {
    const pub = await published(ig);
    await ruleOn(pub.id);
    comment(pub.externalId, { id: 'c-ana', personId: 'u-ana', username: 'ana', text: 'I WANT THE RECIPE', at: env.clock.now().getTime() - 9 * MIN });
    comment(pub.externalId, { id: 'c-bea', personId: 'u-bea', username: 'bea', text: 'recipe pleeease', at: env.clock.now().getTime() - 8 * MIN });
    comment(pub.externalId, { id: 'c-none', personId: 'u-carl', username: 'carl', text: 'Looks great!' });
    comment(pub.externalId, { id: 'c-part', personId: 'u-dan', username: 'dan', text: 'I love recipes' }); // not the word
    comment(pub.externalId, { id: 'c-reply', personId: 'u-eve', username: 'eve', text: 'recipe', parent_id: 'c-none' }); // a reply to somebody
    comment(pub.externalId, { id: 'c-own', personId: '222', username: 'lumen.coffee', text: 'Comment RECIPE to get it' }); // the account itself
    expect(await pollComments(env.ctx)).toBe(5); // the reply is not read as a comment on the post
    const rows = await deliveries(pub.id);
    expect(rows.map((r) => [r.person_name, r.status])).toEqual([['ana', 'pending'], ['bea', 'pending']]);
    expect(rows.map((r) => r.comment_id)).toEqual(['c-ana', 'c-bea']);
  });

  it('reads on from where it stopped, and the same comment seen twice is one entry', async () => {
    const pub = await published(ig);
    await ruleOn(pub.id);
    comment(pub.externalId, { id: 'c-1', personId: 'u1', username: 'one', at: env.clock.now().getTime() - 5 * MIN });
    await pollComments(env.ctx);
    expect(await deliveries(pub.id)).toHaveLength(1);
    // Nothing is read again until the poll interval has passed.
    expect(await pollComments(env.ctx)).toBe(0);
    env.clock.advance(5000);
    comment(pub.externalId, { id: 'c-2', personId: 'u2', username: 'two', at: env.clock.now().getTime() - 1000 });
    await pollComments(env.ctx);
    expect((await deliveries(pub.id)).map((r) => r.comment_id)).toEqual(['c-1', 'c-2']);
    // The poll asked for what is newer than the last comment it saw (a second earlier, for comments in the same second).
    const asked = env.meta.callsTo(/comments$/, 'GET').at(-1)!.query;
    expect(asked.fields).toContain('from');
    // A second look at the whole thing, by hand, creates nothing new.
    await env.db.query(`update prize_poll set last_comment_at = null, last_polled_at = null`);
    await pollComments(env.ctx);
    expect(await deliveries(pub.id)).toHaveLength(2);
  });

  it('follows the pages of comments Meta gives, newest first', async () => {
    const pub = await published(ig);
    await ruleOn(pub.id);
    env.meta.commentPageSize = 2;
    for (let i = 0; i < 5; i++) comment(pub.externalId, { id: `c-${i}`, personId: `u${i}`, username: `user${i}`, at: env.clock.now().getTime() - (10 - i) * MIN });
    await pollComments(env.ctx);
    expect((await deliveries(pub.id)).map((r) => r.comment_id)).toEqual(['c-0', 'c-1', 'c-2', 'c-3', 'c-4']);
  });

  it('gives the same person the same prize once, however many comments or posts', async () => {
    const a = await published(ig);
    const b = await published(ig);
    await ruleOn(a.id);
    await ruleOn(b.id);
    comment(a.externalId, { id: 'a-1', personId: 'u-ana', username: 'ana', at: env.clock.now().getTime() - 5 * MIN });
    comment(a.externalId, { id: 'a-2', personId: 'u-ana', username: 'ana', text: 'recipe recipe', at: env.clock.now().getTime() - 4 * MIN });
    comment(b.externalId, { id: 'b-1', personId: 'u-ana', username: 'ana', at: env.clock.now().getTime() - 3 * MIN });
    await pollComments(env.ctx);
    const rows = await deliveries();
    expect(rows.map((r) => [r.comment_id, r.status, r.reason])).toEqual([['a-1', 'pending', null], ['a-2', 'skipped', 'already_received'], ['b-1', 'skipped', 'already_received']]);
  });

  it('lets one of two comments by the same person, arriving at the same instant, through: the database backs the check up', async () => {
    const pub = await published(ig);
    await ruleOn(pub.id);
    const base = { network: 'instagram' as const, postId: pub.externalId, personId: 'u-race', personName: 'racer', text: 'recipe', topLevel: true, createdAt: at(-5 * MIN) };
    const results = await Promise.all([1, 2, 3, 4].map((i) => handleComment(env.ctx, { ...base, commentId: `race-${i}` })));
    expect(results.filter((r) => r === 'queued')).toHaveLength(1);
    expect(results.filter((r) => r === 'skipped')).toHaveLength(3);
    const rows = await deliveries(pub.id);
    expect(rows.filter((r) => r.status === 'pending')).toHaveLength(1);
    expect(rows.filter((r) => r.reason === 'already_received')).toHaveLength(3);
  });

  it('writes a late comment down as too old instead of promising a message Meta would refuse', async () => {
    const pub = await published(ig);
    await ruleOn(pub.id);
    // The worker was down for days: the first look at this post finds a comment already past Meta's 7 days.
    comment(pub.externalId, { id: 'c-old', personId: 'u-old', username: 'late', at: env.clock.now().getTime() - 7.2 * DAY });
    await env.db.query(`update publication set published_at = $2 where id = $1`, [pub.id, at(-7.5 * DAY)]);
    await pollComments(env.ctx);
    expect((await deliveries(pub.id)).map((r) => [r.status, r.reason])).toEqual([['skipped', 'too_old']]);
  });

  it('does not read the comments of a post whose rule is off, or whose prize window is long over', async () => {
    const off = await published(ig);
    await ruleOn(off.id, { active: false, noticeConfirmed: false });
    comment(off.externalId, { id: 'c-off', personId: 'u-off', username: 'off' });
    const stale = await published(ig);
    await ruleOn(stale.id);
    await env.db.query(`update publication set published_at = $2 where id = $1`, [stale.id, at(-9 * DAY)]);
    comment(stale.externalId, { id: 'c-stale', personId: 'u-stale', username: 'stale' });
    expect(await pollComments(env.ctx)).toBe(0);
    expect(env.meta.callsTo(/comments$/, 'GET')).toHaveLength(0);
  });

  it('never has two workers read the same post at once', async () => {
    const pub = await published(ig);
    await ruleOn(pub.id);
    comment(pub.externalId, { id: 'c-1', personId: 'u1', username: 'one' });
    const [a, b] = await Promise.all([pollComments(env.ctx), pollComments(env.ctx)]);
    expect(a + b).toBe(1);
    expect(env.meta.callsTo(/comments$/, 'GET')).toHaveLength(1);
  });
});

describe('what Meta pushes', () => {
  const sign = (body: string) => `sha256=${createHmac('sha256', SECRET).update(body).digest('hex')}`;
  const post = (payload: unknown, signature?: string) => {
    const body = JSON.stringify(payload);
    return env.app.inject({ method: 'POST', url: '/api/meta/webhook', headers: { 'content-type': 'application/json', 'x-hub-signature-256': signature ?? sign(body) }, payload: body });
  };
  const igPush = (media: string, c: Record<string, unknown>) => ({
    object: 'instagram', entry: [{ id: '222', time: Math.floor(env.clock.now().getTime() / 1000), changes: [{ field: 'comments', value: { media: { id: media, media_product_type: 'REELS' }, ...c } }] }],
  });

  it('answers the check Meta makes once, only with the token that was set', async () => {
    const ok = await env.app.inject({ method: 'GET', url: '/api/meta/webhook?hub.mode=subscribe&hub.verify_token=verify-me&hub.challenge=12345' });
    expect(ok.statusCode).toBe(200);
    expect(ok.body).toBe('12345');
    expect((await env.app.inject({ method: 'GET', url: '/api/meta/webhook?hub.mode=subscribe&hub.verify_token=nope&hub.challenge=12345' })).statusCode).toBe(403);
    expect((await env.app.inject({ method: 'GET', url: '/api/meta/webhook?hub.mode=subscribe&hub.challenge=12345' })).statusCode).toBe(403);
  });

  it('takes an Instagram comment as soon as it is made, when the push is signed with the app secret', async () => {
    const pub = await published(ig);
    await ruleOn(pub.id);
    const r = await post(igPush(pub.externalId, { id: 'push-1', text: 'Recipe please', from: { id: 'u-ana', username: 'ana' } }));
    expect(r.statusCode).toBe(200);
    expect((await deliveries(pub.id)).map((d) => [d.comment_id, d.person_name, d.status])).toEqual([['push-1', 'ana', 'pending']]);
  });

  it('refuses a push that is not signed, or signed with something else, and does nothing with it', async () => {
    const pub = await published(ig);
    await ruleOn(pub.id);
    const body = igPush(pub.externalId, { id: 'push-x', text: 'recipe', from: { id: 'u-mal', username: 'mal' } });
    expect((await post(body, 'sha256=' + 'a'.repeat(64))).statusCode).toBe(403);
    expect((await post(body, 'nothing')).statusCode).toBe(403);
    const raw = JSON.stringify(body);
    expect((await env.app.inject({ method: 'POST', url: '/api/meta/webhook', headers: { 'content-type': 'application/json' }, payload: raw })).statusCode).toBe(403);
    // Signed over a different body than the one sent.
    expect((await post(body, sign(JSON.stringify({ ...body, entry: [] })))).statusCode).toBe(403);
    expect(await deliveries(pub.id)).toHaveLength(0);
  });

  it('takes a Page comment, and leaves replies, the account itself, and posts with no rule alone', async () => {
    const pub = await published(fb);
    await ruleOn(pub.id);
    const feed = (v: Record<string, unknown>) => ({ object: 'page', entry: [{ id: '111', time: Math.floor(env.clock.now().getTime() / 1000), changes: [{ field: 'feed', value: { item: 'comment', verb: 'add', post_id: pub.externalId, created_time: Math.floor(env.clock.now().getTime() / 1000), ...v } }] }] });
    expect((await post(feed({ comment_id: 'fb-1', message: 'RECIPE!', from: { id: 'f-ana', name: 'Ana López' }, parent_id: pub.externalId }))).statusCode).toBe(200);
    await post(feed({ comment_id: 'fb-2', message: 'recipe', from: { id: 'f-bea', name: 'Bea' }, parent_id: 'fb-1' })); // a reply to a comment
    await post(feed({ comment_id: 'fb-3', message: 'recipe', from: { id: '111', name: 'Lumen Coffee' }, parent_id: pub.externalId })); // the Page itself
    await post({ ...feed({ comment_id: 'fb-4', message: 'recipe', from: { id: 'f-c', name: 'C' } }), entry: [{ id: '111', time: 1, changes: [{ field: 'feed', value: { item: 'like', verb: 'add' } }] }] });
    const other = await published(fb);
    await post({ ...feed({ comment_id: 'fb-5', message: 'recipe', from: { id: 'f-d', name: 'D' }, parent_id: other.externalId }), entry: [{ id: '111', time: 1, changes: [{ field: 'feed', value: { item: 'comment', verb: 'add', post_id: other.externalId, comment_id: 'fb-5', message: 'recipe', from: { id: 'f-d', name: 'D' }, created_time: 1 } }] }] });
    expect((await deliveries()).map((d) => [d.comment_id, d.person_name, d.status])).toEqual([['fb-1', 'Ana López', 'pending']]);
  });

  it('counts a comment that arrives by push and again by polling as one', async () => {
    const pub = await published(ig);
    await ruleOn(pub.id);
    await post(igPush(pub.externalId, { id: 'both-1', text: 'recipe', from: { id: 'u-ana', username: 'ana' } }));
    comment(pub.externalId, { id: 'both-1', personId: 'u-ana', username: 'ana', text: 'recipe' });
    await pollComments(env.ctx);
    expect(await deliveries(pub.id)).toHaveLength(1);
  });
});

describe('sending the prize', () => {
  async function queued(o: { text?: string; person?: string; username?: string; network?: 'ig' | 'fb'; ruleOver?: Record<string, unknown> } = {}) {
    const pub = await published(o.network === 'fb' ? fb : ig);
    await ruleOn(pub.id, o.ruleOver ?? {});
    const c = comment(pub.externalId, { personId: o.person ?? 'u-ana', username: o.username ?? 'ana', text: o.text ?? 'recipe!' });
    await pollComments(env.ctx);
    const row = (await deliveries(pub.id))[0]!;
    return { pub, c, row };
  }

  it('sends one private message as a reply to the comment, with a link of its own and the note that it is automatic', async () => {
    const { row, c } = await queued({ username: 'ana' });
    expect(await scanPrizeDeliveries(env.ctx)).toBe(1);
    expect(env.meta.messages).toHaveLength(1);
    const m = env.meta.messages[0]!;
    expect(m.path).toBe('222/messages');
    expect(m.commentId).toBe(c.id);
    expect(m.text).toMatch(/^Hi ana! Here is your Recipe book: http:\/\/app\.test\/prize\/[\w-]{20,} \(it works for 72 hours\)\./);
    expect(m.text.endsWith('\n\nThis is an automatic message.')).toBe(true);
    const sent = await rowOf(row.id);
    expect(sent).toMatchObject({ status: 'sent', attempts: 1, lease_until: null });
    expect(new Date(sent.expires_at).getTime() - new Date(sent.sent_at).getTime()).toBe(72 * HOUR);
    // The link's secret is not kept: only what proves a link is ours.
    const secret = /\/prize\/([\w-]+)/.exec(m.text)![1]!;
    expect(sent.token_hash).toBe(sha(secret));
    expect(JSON.stringify(sent)).not.toContain(secret);
    // And it is sent once.
    expect(await scanPrizeDeliveries(env.ctx)).toBe(0);
  });

  it('uses the private reply of the network the post is on: a Page sends it as the Page', async () => {
    const { c } = await queued({ network: 'fb' });
    await scanPrizeDeliveries(env.ctx);
    expect(env.meta.messages[0]).toMatchObject({ path: '111/messages', commentId: c.id });
  });

  it('is a page the person can open, shows what the prize is and nothing else, and counts what is downloaded', async () => {
    await queued({ person: 'u-bea', username: 'bea' });
    await scanPrizeDeliveries(env.ctx);
    const secret = /\/prize\/([\w-]+)/.exec(env.meta.messages[0]!.text)![1]!;
    const page = await env.call(null, 'GET', `/api/public/prizes/${secret}`);
    expect(page.status).toBe(200);
    expect(page.body.prize).toEqual({ name: 'Recipe book', kind: 'link', file_name: null });
    expect(JSON.stringify(page.body)).not.toContain('bea');
    const dl = await env.call(null, 'POST', `/api/public/prizes/${secret}/download`);
    expect(dl.body).toEqual({ url: 'https://lumen.example/recipes.pdf' });
    expect((await env.db.one('select downloads from prize_delivery where token_hash = $1', [sha(secret)]))!.downloads).toBe(1);
    for (let i = 0; i < 4; i++) expect((await env.call(null, 'POST', `/api/public/prizes/${secret}/download`)).status).toBe(200);
    const sixth = await env.call(null, 'POST', `/api/public/prizes/${secret}/download`);
    expect(sixth.status).toBe(410);
    expect(sixth.body.error.code).toBe('used_up');
    expect((await env.call(null, 'GET', `/api/public/prizes/${secret}`)).status).toBe(410);
  });

  it('hands over a file by a link that works for five minutes', async () => {
    const data = randomBytes(500);
    const r = await env.call(admin(), 'POST', brandUrl('/prizes'), { kind: 'file', name: 'Menu', file: { name: 'menu.pdf', mime: 'application/pdf', bytes: 500, sha256: sha(data) } });
    const url = new URL(r.body.upload.url);
    await env.app.inject({ method: 'PUT', url: url.pathname + url.search, headers: r.body.upload.headers, payload: data });
    await env.call(admin(), 'POST', `/api/prizes/${r.body.prize.id}/complete`);
    const pub = await published(ig);
    await ruleOn(pub.id, { prizeId: r.body.prize.id });
    comment(pub.externalId);
    await pollComments(env.ctx);
    await scanPrizeDeliveries(env.ctx);
    const secret = /\/prize\/([\w-]+)/.exec(env.meta.messages[0]!.text)![1]!;
    const dl = await env.call(null, 'POST', `/api/public/prizes/${secret}/download`);
    expect(dl.status).toBe(200);
    const signed = new URL(dl.body.url, 'http://media.test');
    expect(signed.pathname).toContain('menu.pdf');
    const got = await env.app.inject({ method: 'GET', url: signed.pathname + signed.search });
    expect(got.statusCode).toBe(200);
    expect(Buffer.from(got.rawPayload).equals(data)).toBe(true);
  });

  it('stops working when its hours are over', async () => {
    await queued({ ruleOver: { linkHours: 2 } });
    await scanPrizeDeliveries(env.ctx);
    const secret = /\/prize\/([\w-]+)/.exec(env.meta.messages[0]!.text)![1]!;
    expect((await env.call(null, 'GET', `/api/public/prizes/${secret}`)).status).toBe(200);
    env.clock.advance(3 * HOUR);
    const late = await env.call(null, 'GET', `/api/public/prizes/${secret}`);
    expect(late.status).toBe(410);
    expect(late.body.error.code).toBe('expired');
    expect((await env.call(null, 'POST', `/api/public/prizes/${secret}/download`)).status).toBe(410);
  });

  it('answers 404, saying nothing, to a link that was never made', async () => {
    expect((await env.call(null, 'GET', '/api/public/prizes/' + 'a'.repeat(32))).status).toBe(404);
    expect((await env.call(null, 'GET', '/api/public/prizes/short')).status).toBe(400);
  });

  it('sends a private message only once per comment and person, even if the scan runs twice at once', async () => {
    await queued();
    const [a, b] = await Promise.all([scanPrizeDeliveries(env.ctx), scanPrizeDeliveries(env.ctx)]);
    expect(a + b).toBe(1);
    expect(env.meta.messages).toHaveLength(1);
  });

  it('does not send past the 7 days Meta allows, and says so', async () => {
    const { row } = await queued();
    env.clock.advance(7 * DAY + HOUR);
    await scanPrizeDeliveries(env.ctx);
    expect(await rowOf(row.id)).toMatchObject({ status: 'skipped', reason: 'too_old' });
    expect(env.meta.messages).toHaveLength(0);
  });

  it('stays under Meta\'s hourly limit of private replies, and sends the rest as the hour passes', async () => {
    const { pub, row } = await queued();
    // 700 prizes have gone out from this account in the last hour already.
    const first = at(-50 * MIN);
    await env.db.query(
      `insert into prize_delivery (rule_id, prize_id, brand_id, publication_id, account_id, network, comment_id, person_id, comment_at, status, sent_at, purge_after)
       select r.id, r.prize_id, r.brand_id, $1, $2, 'instagram', 'bulk-' || g, 'bulk-p-' || g, $3, 'sent', $3::timestamptz + (g || ' seconds')::interval, now() + interval '30 days'
       from prize_rule r, generate_series(1, 700) g where r.publication_id = $1`,
      [pub.id, ig, first],
    );
    expect(await scanPrizeDeliveries(env.ctx)).toBe(1);
    let now = await rowOf(row.id);
    expect(now).toMatchObject({ status: 'pending', attempts: 0 }); // waiting out a limit is not a failed try
    expect(now.reason).toContain('hourly limit');
    expect(env.meta.messages).toHaveLength(0);
    expect(new Date(now.next_attempt_at).getTime()).toBeGreaterThan(first.getTime() + HOUR - 5000);
    env.clock.advance(11 * MIN);
    await scanPrizeDeliveries(env.ctx);
    now = await rowOf(row.id);
    expect(now.status).toBe('sent');
  });

  it("waits for as long as Meta says when its own limit is hit, without counting a failed try", async () => {
    const { row } = await queued();
    env.meta.fail((c) => c.path.endsWith('/messages'), env.meta.err(4, '(#4) Application request limit reached'), 400, 1, { 'x-business-use-case-usage': JSON.stringify({ '222': [{ estimated_time_to_regain_access: 30 }] }) });
    await scanPrizeDeliveries(env.ctx);
    let now = await rowOf(row.id);
    expect(now).toMatchObject({ status: 'pending', attempts: 0 });
    expect(new Date(now.next_attempt_at).getTime()).toBeGreaterThanOrEqual(env.clock.now().getTime() + 30 * MIN - 1000);
    env.clock.advance(31 * MIN);
    await scanPrizeDeliveries(env.ctx);
    expect((await rowOf(row.id)).status).toBe('sent');
  });

  it('tries a temporary failure again with growing waits and gives up after five tries, with the reason', async () => {
    const { row } = await queued();
    env.meta.fail((c) => c.path.endsWith('/messages'), env.meta.err(2, 'An unexpected error has occurred', { is_transient: true }), 500, 20);
    const waits: number[] = [];
    for (let i = 0; i < 6; i++) {
      await scanPrizeDeliveries(env.ctx);
      const r = await rowOf(row.id);
      if (r.status !== 'pending') break;
      const w = new Date(r.next_attempt_at).getTime() - env.clock.now().getTime();
      waits.push(Math.round(w / MIN));
      env.clock.advance(w + 1000);
    }
    expect(waits).toEqual([1, 5, 15, 60]);
    expect(await rowOf(row.id)).toMatchObject({ status: 'failed', attempts: 5 });
    expect((await rowOf(row.id)).reason).toContain('unexpected error');
  });

  it('does not retry what Meta refuses for good: a comment already answered, or older than its window', async () => {
    const { row, c } = await queued();
    env.meta.messages.push({ path: '222/messages', commentId: c.id, text: 'already sent by somebody', at: env.clock.now().getTime() });
    await scanPrizeDeliveries(env.ctx);
    const r = await rowOf(row.id);
    expect(r.status).toBe('failed');
    expect(r.reason).toContain('already has a private reply');
    expect(r.attempts).toBe(1);
  });

  it('says a connection without the permission cannot send, and tries a few times in case it is only a hiccup', async () => {
    const { row } = await queued();
    env.meta.messagingPermission = false;
    for (let i = 0; i < 6; i++) {
      await scanPrizeDeliveries(env.ctx);
      const r = await rowOf(row.id);
      if (r.status !== 'pending') break;
      env.clock.advance(7 * HOUR);
    }
    const r = await rowOf(row.id);
    expect(r.status).toBe('failed');
    expect(r.reason).toContain('not allowed to send messages');
    expect((await env.db.one('select status from social_account where id = $1', [ig]))!.status).toBe('active'); // publishing is unaffected
  });

  it('does not send once the rule has been switched off, and postpones while the account has to be reconnected', async () => {
    const a = await queued();
    await env.call(admin(), 'PUT', `/api/publications/${a.pub.id}/prize`, { prizeId, ...RULE, active: false, noticeConfirmed: false });
    await scanPrizeDeliveries(env.ctx);
    expect(await rowOf(a.row.id)).toMatchObject({ status: 'skipped', reason: 'rule_off' });

    const b = await queued({ person: 'u-bea', username: 'bea' });
    await env.db.query(`update social_account set status = 'reconnect_required' where id = $1`, [ig]);
    await scanPrizeDeliveries(env.ctx);
    expect(await rowOf(b.row.id)).toMatchObject({ status: 'pending' });
    expect(env.meta.messages).toHaveLength(0);
    await env.db.query(`update social_account set status = 'active' where id = $1`, [ig]);
    env.clock.advance(2 * HOUR);
    await scanPrizeDeliveries(env.ctx);
    expect((await rowOf(b.row.id)).status).toBe('sent');
  });

  it("lets a person who runs the brand see who was sent what, never the network's id for them", async () => {
    const { pub } = await queued({ username: 'ana' });
    await scanPrizeDeliveries(env.ctx);
    const r = await env.call(env.users.approver, 'GET', `/api/publications/${pub.id}/prize/deliveries`);
    expect(r.body).toEqual([expect.objectContaining({ person: 'ana', status: 'sent', downloads: 0 })]);
    expect(JSON.stringify(r.body)).not.toContain('u-ana');
    expect((await env.call(env.users.reader, 'GET', `/api/publications/${pub.id}/prize/deliveries`)).status).toBe(403);
    const view = await env.call(admin(), 'GET', `/api/publications/${pub.id}/prize`);
    expect(view.body.rule.deliveries).toEqual({ pending: 0, sent: 1, skipped: 0, failed: 0 });
  });
});

describe('the page for networks that cannot message anyone', () => {
  it('is open to whoever has the link, until it expires or the rule is switched off', async () => {
    const pub = await published(yt);
    const rule = await ruleOn(pub.id, { publicDays: 10 });
    const secret = /\/prize\/([\w-]+)$/.exec(rule.public_url)![1]!;
    const page = await env.call(null, 'GET', `/api/public/prizes/${secret}`);
    expect(page.body.prize.name).toBe('Recipe book');
    expect((await env.call(null, 'POST', `/api/public/prizes/${secret}/download`)).body.url).toBe('https://lumen.example/recipes.pdf');
    await env.call(admin(), 'PUT', `/api/publications/${pub.id}/prize`, { prizeId, ...RULE, publicDays: 10 });
    env.clock.advance(11 * DAY);
    expect((await env.call(null, 'GET', `/api/public/prizes/${secret}`)).body.error.code).toBe('expired');
    env.clock.advance(-11 * DAY);
    await env.call(admin(), 'PUT', `/api/publications/${pub.id}/prize`, { prizeId, ...RULE, active: false, noticeConfirmed: false });
    expect((await env.call(null, 'GET', `/api/public/prizes/${secret}`)).status).toBe(410);
  });
});

describe('what is kept about people', () => {
  async function onePerson(username = 'ana', person = 'u-ana') {
    const pub = await published(ig);
    await ruleOn(pub.id);
    comment(pub.externalId, { personId: person, username });
    await pollComments(env.ctx);
    await scanPrizeDeliveries(env.ctx);
    return pub;
  }

  it('deletes them when the retention period is over, and says how many, never who', async () => {
    await onePerson('ana', 'u-ana');
    const row = (await deliveries())[0]!;
    expect(new Date(row.purge_after).getTime() - env.clock.now().getTime()).toBeGreaterThan(29 * DAY);
    expect(await purgePrizeData(env.ctx)).toBe(0);
    env.clock.advance(31 * DAY);
    expect(await purgePrizeData(env.ctx)).toBe(1);
    expect(await deliveries()).toEqual([]);
    const log = await env.db.query(`select after from audit_event where action = 'prize.purged' order by id desc limit 1`);
    expect(log[0]!.after).toEqual({ rows: 1 });
  });

  it('keeps people for the time the brand chose, from the moment they are written down', async () => {
    await env.call(admin(), 'PATCH', brandUrl(''), { prizes: { retention_days: 10 } });
    await onePerson('bea', 'u-bea');
    const row = (await deliveries())[0]!;
    const days = (new Date(row.purge_after).getTime() - env.clock.now().getTime()) / DAY;
    expect(days).toBeGreaterThan(9);
    expect(days).toBeLessThan(10.1);
    expect((await env.call(admin(), 'PATCH', brandUrl(''), { prizes: { retention_days: 3 } })).status).toBe(400); // less than Meta's own window makes no sense
  });

  it('is only settable by an admin, and the note on every message cannot be emptied', async () => {
    expect((await env.call(env.users.approver, 'PATCH', brandUrl(''), { prizes: { enabled: false } })).status).toBe(403);
    expect((await env.call(admin(), 'PATCH', brandUrl(''), { prizes: { auto_notice: '   ' } })).status).toBe(400);
    const b = await env.call(admin(), 'PATCH', brandUrl(''), { prizes: { auto_notice: 'Automatic message.' } });
    expect(b.body.prizes).toMatchObject({ enabled: true, retention_days: 30, auto_notice: 'Automatic message.' });
  });

  it('erases a person on request, by the name they show or their id, for an admin only', async () => {
    await onePerson('ana', 'u-ana');
    expect((await env.call(env.users.approver, 'POST', brandUrl('/prizes/erase'), { name: 'ana' })).status).toBe(403);
    expect((await env.call(admin(), 'POST', brandUrl('/prizes/erase'), {})).status).toBe(400);
    expect((await env.call(admin(), 'POST', brandUrl('/prizes/erase'), { name: 'nobody' })).body.deleted).toBe(0);
    expect((await env.call(admin(), 'POST', brandUrl('/prizes/erase'), { name: 'ANA' })).body.deleted).toBe(1);
    expect(await deliveries()).toEqual([]);
    await onePerson('bea', 'u-bea');
    expect((await env.call(admin(), 'POST', brandUrl('/prizes/erase'), { personId: 'u-bea' })).body.deleted).toBe(1);
  });

  it('deletes a person when Meta says they removed the app, and answers with a code a page can report on', async () => {
    await onePerson('cleo', 'meta-user-77');
    await onePerson('dan', 'meta-user-88');
    const payload = Buffer.from(JSON.stringify({ user_id: 'meta-user-77', algorithm: 'HMAC-SHA256', issued_at: 1 })).toString('base64url');
    const sig = createHmac('sha256', SECRET).update(payload).digest('base64url');
    const r = await env.app.inject({ method: 'POST', url: '/api/meta/data-deletion', headers: { 'content-type': 'application/x-www-form-urlencoded' }, payload: `signed_request=${sig}.${payload}` });
    expect(r.statusCode).toBe(200);
    const body = JSON.parse(r.body);
    expect(body.confirmation_code).toMatch(/^del_/);
    expect(body.url).toBe(`http://app.test/data-deletion?code=${body.confirmation_code}`);
    expect((await deliveries()).map((d) => d.person_name)).toEqual(['dan']);
    const status = await env.call(null, 'GET', `/api/public/data-deletion/${body.confirmation_code}`);
    expect(status.body).toMatchObject({ status: 'completed', deleted: 1 });
    // The id itself was not kept.
    const kept = await env.db.one('select * from deletion_request where code = $1', [body.confirmation_code]);
    expect(JSON.stringify(kept)).not.toContain('meta-user-77');
    expect((await env.call(null, 'GET', '/api/public/data-deletion/del_unknownunknown')).status).toBe(404);
  });

  it('refuses a deletion request that is not signed by Meta', async () => {
    await onePerson('eve', 'meta-user-99');
    const payload = Buffer.from(JSON.stringify({ user_id: 'meta-user-99' })).toString('base64url');
    const forged = createHmac('sha256', 'not-the-secret').update(payload).digest('base64url');
    const r = await env.app.inject({ method: 'POST', url: '/api/meta/data-deletion', headers: { 'content-type': 'application/x-www-form-urlencoded' }, payload: `signed_request=${forged}.${payload}` });
    expect(r.statusCode).toBe(403);
    expect(await deliveries()).toHaveLength(1);
  });

  it('keeps no person, id or name in the audit log, only counts', async () => {
    const pub = await onePerson('zelda_the_unique', 'u-zelda-12345');
    await env.call(admin(), 'POST', brandUrl('/prizes/erase'), { name: 'zelda_the_unique' });
    const log = JSON.stringify(await env.db.query('select * from audit_event'));
    expect(log).not.toContain('zelda_the_unique');
    expect(log).not.toContain('u-zelda-12345');
    expect(pub.id).toBeTruthy();
  });
});
