import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TokenSet } from '../src/connectors/types.js';
import { accountToken, checkHealth } from '../src/services/connectors.js';
import { FakeBluesky } from './fakes/bluesky.js';
import { FakeLinkedIn } from './fakes/linkedin.js';
import { FakePinterest } from './fakes/pinterest.js';
import { FakeThreads } from './fakes/threads.js';
import { FakeTikTok } from './fakes/tiktok.js';
import { FakeX } from './fakes/x.js';
import { createEnv, type Env } from './helpers.js';

const threads = new FakeThreads();
const tiktok = new FakeTikTok();
const linkedin = new FakeLinkedIn();
const x = new FakeX();
const pinterest = new FakePinterest();
const bluesky = new FakeBluesky();
let env: Env;

beforeAll(async () => {
  for (const f of [threads, tiktok, linkedin, x, pinterest, bluesky]) await f.start();
  env = await createEnv({
    TOKEN_KEY: Buffer.alloc(32, 9).toString('base64'),
    THREADS_APP_ID: 'tid', THREADS_APP_SECRET: 'tsecret', THREADS_OAUTH_URL: `${threads.url}/oauth/authorize`, THREADS_GRAPH_URL: threads.url,
    TIKTOK_CLIENT_KEY: tiktok.clientKey, TIKTOK_CLIENT_SECRET: tiktok.clientSecret, TIKTOK_OAUTH_URL: `${tiktok.url}/authorize/`, TIKTOK_API_URL: tiktok.url,
    LINKEDIN_CLIENT_ID: 'lid', LINKEDIN_CLIENT_SECRET: 'lsecret', LINKEDIN_OAUTH_URL: `${linkedin.url}/authorize`, LINKEDIN_TOKEN_URL: `${linkedin.url}/oauth/token`, LINKEDIN_API_URL: linkedin.url,
    X_CLIENT_ID: x.clientId, X_CLIENT_SECRET: x.clientSecret, X_OAUTH_URL: `${x.url}/authorize`, X_API_URL: x.url,
    PINTEREST_APP_ID: pinterest.clientId, PINTEREST_APP_SECRET: pinterest.clientSecret, PINTEREST_OAUTH_URL: `${pinterest.url}/oauth/`, PINTEREST_API_URL: pinterest.url,
    BLUESKY_PDS_URL: bluesky.url, BLUESKY_VIDEO_URL: `${bluesky.url}/video`,
  });
});
afterAll(async () => {
  await env.close();
  for (const f of [threads, tiktok, linkedin, x, pinterest, bluesky]) await f.stop();
});

const brandUrl = (p: string) => `/api/brands/${env.brandId}${p}`;

/** The browser dance with a provider that has a sign-in page. */
async function signIn(provider: string, code = 'good', as = env.users.admin) {
  const start = await env.call(as, 'POST', brandUrl(`/connections/${provider}`), {});
  expect(start.status, JSON.stringify(start.body)).toBe(200);
  const authorize = new URL(start.body.url);
  const state = authorize.searchParams.get('state')!;
  const back = await env.app.inject({ method: 'GET', url: `/api/oauth/callback?code=${code}&state=${state}`, headers: { cookie: as.cookie! } });
  const location = new URL(back.headers.location as string, 'http://app.test');
  return { authorize, location, pendingId: location.searchParams.get('connection')!, error: location.searchParams.get('connect_error') };
}
const choose = (pid: string, keys: string[]) => env.call(env.users.admin, 'POST', brandUrl(`/connections/${pid}/select`), { keys });
const row = async (id: string) => (await env.db.one('select * from social_account where id = $1', [id]))!;
const tokenOf = (r: { token_encrypted: Buffer; id: string }) => env.ctx.vault!.open<TokenSet>(r.token_encrypted, `account:${r.id}`);
/** Gives an account a token that runs out at a chosen moment, as if time had passed. */
async function setToken(id: string, t: TokenSet) {
  await env.db.query('update social_account set token_encrypted = $2, token_expires_at = $3, status = $4 where id = $1', [id, env.ctx.vault!.seal(t, `account:${id}`), t.expiresAt ?? null, 'active']);
}
const inDays = (d: number) => new Date(Date.now() + d * 86_400_000).toISOString();

describe('which providers the server offers', () => {
  it('lists all eight, with how each signs in', async () => {
    const r = await env.call(env.users.reader, 'GET', brandUrl('/integrations'));
    const by = Object.fromEntries(r.body.providers.map((p: any) => [p.id, p]));
    expect(Object.keys(by).sort()).toEqual(['bluesky', 'google', 'linkedin', 'meta', 'pinterest', 'threads', 'tiktok', 'x']);
    expect(by.bluesky.signIn).toBe('credentials');
    for (const id of ['threads', 'tiktok', 'linkedin', 'x', 'pinterest']) expect(by[id]).toMatchObject({ configured: true, signIn: 'redirect' });
    expect(by.x.label).toBe('X');
  });
});

describe('connecting Threads, X, LinkedIn, Pinterest and TikTok', () => {
  it('Threads: one account, with a token that lasts 60 days, sealed', async () => {
    const s = await signIn('threads');
    expect(s.location.searchParams.get('tab')).toBe('accounts');
    const done = await choose(s.pendingId, ['threads:90001']);
    expect(done.status).toBe(200);
    const acc = await row(done.body[0].id);
    expect(acc).toMatchObject({ network: 'threads', external_id: '90001', display_name: '@lumen.coffee', status: 'active' });
    expect(Buffer.from(acc.token_encrypted).toString('latin1')).not.toContain('long-');
    const days = (new Date(tokenOf(acc as any).expiresAt!).getTime() - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(59);
  });

  it('X: the sign-in carries a PKCE challenge, and the callback finishes with the verifier made from the same state', async () => {
    const start = await env.call(env.users.admin, 'POST', brandUrl('/connections/x'), {});
    const authorize = new URL(start.body.url);
    x.expectChallenge = authorize.searchParams.get('code_challenge');
    const state = authorize.searchParams.get('state')!;
    const back = await env.app.inject({ method: 'GET', url: `/api/oauth/callback?code=good&state=${state}`, headers: { cookie: env.users.admin.cookie! } });
    const pid = new URL(back.headers.location as string, 'http://app.test').searchParams.get('connection')!;
    expect(pid).toBeTruthy(); // X accepted the verifier
    const done = await choose(pid, ['x:4242']);
    expect(done.status).toBe(200);
    expect(await row(done.body[0].id)).toMatchObject({ network: 'x', display_name: '@lumencoffee' });
    x.expectChallenge = null;
  });

  it('Pinterest: each board can be chosen as an account, and the ones chosen share the sign-in', async () => {
    const s = await signIn('pinterest');
    const pending = await env.call(env.users.admin, 'GET', brandUrl(`/connections/${s.pendingId}`));
    expect(pending.body.candidates.map((c: any) => c.key)).toEqual(['pinterest:b1', 'pinterest:b2']);
    const done = await choose(s.pendingId, ['pinterest:b1', 'pinterest:b2']);
    expect(done.body).toHaveLength(2);
    const [a, b] = await Promise.all(done.body.map((d: any) => row(d.id)));
    expect(a!.provider_data).toMatchObject({ boardId: 'b1', audited: false });
    expect(tokenOf(a as any).accessToken).toBe(tokenOf(b as any).accessToken);
  });

  it('LinkedIn: the pages the person administers are the accounts', async () => {
    linkedin.orgs = [{ id: '5001', localizedName: 'Lumen Coffee', vanityName: 'lumen-coffee' }, { id: '5002', localizedName: 'Lumen Roasters', vanityName: 'lumen-roasters' }];
    const s = await signIn('linkedin');
    const pending = await env.call(env.users.admin, 'GET', brandUrl(`/connections/${s.pendingId}`));
    expect(pending.body.candidates.map((c: any) => c.key)).toEqual(['linkedin:5001', 'linkedin:5002']);
    const done = await choose(s.pendingId, ['linkedin:5002']);
    expect(await row(done.body[0].id)).toMatchObject({ network: 'linkedin', display_name: 'Lumen Roasters' });
  });

  it('LinkedIn: a person who administers no page is told what to check, and nothing is kept', async () => {
    linkedin.orgs = [];
    const s = await signIn('linkedin');
    expect(s.pendingId).toBeNull();
    expect(s.error).toContain('administrator');
  });

  it('TikTok: connects as not audited, and an admin can say when TikTok has audited the app', async () => {
    const s = await signIn('tiktok');
    const done = await choose(s.pendingId, ['tiktok:open-1']);
    const id = done.body[0].id as string;
    expect((await row(id)).provider_data.audited).toBe(false);
    const flip = await env.call(env.users.admin, 'PATCH', brandUrl(`/accounts/${id}`), { audited: true });
    expect(flip.status).toBe(200);
    expect((await row(id)).provider_data.audited).toBe(true);
    // The same flag exists for Pinterest, and for nobody else.
    const ig = await env.call(env.users.admin, 'PATCH', brandUrl(`/accounts/${env.accounts.instagram}`), { audited: true });
    expect(ig.status).toBe(400);
    expect(ig.body.error.message).toContain('YouTube, TikTok and Pinterest');
  });

  it('TikTok: asks TikTok what the account may do while a post is written, keeps it, and schedules against it', async () => {
    const s = await signIn('tiktok');
    const id = (await choose(s.pendingId, ['tiktok:open-1'])).body[0].id as string;
    tiktok.privacyOptions = ['SELF_ONLY', 'FOLLOWER_OF_CREATOR'];
    tiktok.creator = { commentDisabled: true, duetDisabled: false, stitchDisabled: false };
    // Whoever may schedule may ask; a reader may not.
    expect((await env.call(env.users.reader, 'GET', brandUrl(`/accounts/${id}/options`))).status).toBe(403);
    const before = tiktok.callsTo('/v2/post/publish/creator_info/query/').length;
    const r = await env.call(env.users.approver, 'GET', brandUrl(`/accounts/${id}/options`));
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.live).toBe(true);
    expect(tiktok.callsTo('/v2/post/publish/creator_info/query/').length).toBe(before + 1);
    const privacy = r.body.fields.find((f: any) => f.key === 'privacy');
    expect(privacy.choices.map((c: any) => c.value)).toEqual(['SELF_ONLY']); // not audited: only "Only me"
    expect(r.body.fields.find((f: any) => f.key === 'allowComment').disabled).toBe(true);
    expect((await row(id)).provider_data.creatorInfo).toMatchObject({ privacyLevelOptions: ['SELF_ONLY', 'FOLLOWER_OF_CREATOR'], commentDisabled: true });
    // An account TikTok has stopped answering for is reported as such, not as a broken page.
    tiktok.fail((c) => c.path === '/v2/post/publish/creator_info/query/', { data: {}, error: { code: 'spam_risk_too_many_posts', message: 'Daily post limit reached' } }, 429);
    const refused = await env.call(env.users.approver, 'GET', brandUrl(`/accounts/${id}/options`));
    expect(refused.status).toBe(502);
    expect(refused.body.error.message).toContain('Daily post limit reached');
    tiktok.privacyOptions = ['SELF_ONLY', 'MUTUAL_FOLLOW_FRIENDS', 'FOLLOWER_OF_CREATOR', 'PUBLIC_TO_EVERYONE'];
    tiktok.creator = { commentDisabled: false, duetDisabled: false, stitchDisabled: false };
  });

  it('a refused code is reported on the settings page, with the network\'s reason', async () => {
    const s = await signIn('threads', 'bad');
    expect(s.pendingId).toBeNull();
    expect(s.error).toContain('Invalid authorization code');
  });

  it('only admins can start any of them', async () => {
    for (const p of ['threads', 'tiktok', 'linkedin', 'x', 'pinterest']) {
      expect((await env.call(env.users.approver, 'POST', brandUrl(`/connections/${p}`), {})).status, p).toBe(403);
    }
  });
});

describe('connecting Bluesky with an app password', () => {
  const connect = (values: Record<string, string>, as = env.users.admin) => env.call(as, 'POST', brandUrl('/connections/bluesky/credentials'), { values });

  it('takes a handle and an app password, shows the account to choose, and keeps the password sealed with the session', async () => {
    const r = await connect({ handle: '@lumen.bsky.social', appPassword: bluesky.password });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(JSON.stringify(r.body)).not.toContain(bluesky.password);
    const pending = await env.call(env.users.admin, 'GET', brandUrl(`/connections/${r.body.pendingId}`));
    expect(pending.body.candidates).toEqual([expect.objectContaining({ key: 'bluesky:did:plc:lumen', displayName: '@lumen.bsky.social', network: 'bluesky' })]);
    expect(JSON.stringify(pending.body)).not.toContain(bluesky.password);
    const done = await choose(r.body.pendingId, ['bluesky:did:plc:lumen']);
    const acc = await row(done.body[0].id);
    expect(acc).toMatchObject({ network: 'bluesky', external_id: 'did:plc:lumen', display_name: '@lumen.bsky.social', status: 'active' });
    expect(acc.provider_data).toMatchObject({ handle: 'lumen.bsky.social', pds: bluesky.url, emailConfirmed: true });
    // In the database the password is only inside the sealed bytes.
    expect(Buffer.from(acc.token_encrypted).toString('latin1')).not.toContain(bluesky.password);
    expect(JSON.stringify(acc.provider_data)).not.toContain(bluesky.password);
    expect(tokenOf(acc as any).extra!.appPassword).toBe(bluesky.password);
  });

  it('says the app password was wrong, in words, and keeps nothing', async () => {
    const before = (await env.db.one('select count(*)::int as n from oauth_pending'))!.n;
    const r = await connect({ handle: 'lumen.bsky.social', appPassword: 'nope' });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('sign_in_failed');
    expect(r.body.error.message).toContain('app password');
    expect((await env.db.one('select count(*)::int as n from oauth_pending'))!.n).toBe(before);
  });

  it('needs both fields, and only admins may use it', async () => {
    const missing = await connect({ handle: 'lumen.bsky.social' });
    expect(missing.status).toBe(400);
    expect(missing.body.error.code).toBe('missing_field');
    expect((await connect({ handle: 'a', appPassword: 'b' }, env.users.approver)).status).toBe(403);
  });

  it('is not the way to connect a network that has a sign-in page, and the other way is not for Bluesky', async () => {
    const a = await env.call(env.users.admin, 'POST', brandUrl('/connections/threads/credentials'), { values: { handle: 'x' } });
    expect(a.body.error.code).toBe('redirect_required');
    const b = await env.call(env.users.admin, 'POST', brandUrl('/connections/bluesky'), {});
    expect(b.body.error.code).toBe('credentials_required');
  });

  it('can reconnect an account with a new app password, but only the same account', async () => {
    const first = await connect({ handle: 'lumen.bsky.social', appPassword: bluesky.password });
    const done = await choose(first.body.pendingId, ['bluesky:did:plc:lumen']);
    const id = done.body[0].id as string;
    await env.db.query(`update social_account set status = 'reconnect_required' where id = $1`, [id]);
    const again = await env.call(env.users.admin, 'POST', brandUrl('/connections/bluesky/credentials'), { values: { handle: 'lumen.bsky.social', appPassword: bluesky.password }, reconnectAccountId: id });
    const re = await choose(again.body.pendingId, ['bluesky:did:plc:lumen']);
    expect(re.status).toBe(200);
    expect((await row(id)).status).toBe('active');
    expect((await env.db.query(`select id from social_account where external_id = 'did:plc:lumen'`))).toHaveLength(1);
  });
});

describe('keeping the connections alive', () => {
  async function connectOne(provider: string, key: string, setup?: () => void) {
    setup?.();
    const s = await signIn(provider);
    const done = await choose(s.pendingId, [key]);
    return done.body[0].id as string;
  }

  it('renews a Threads token a week before it ends, not before', async () => {
    const id = await connectOne('threads', 'threads:90001');
    const t = tokenOf(await row(id) as any);
    await setToken(id, { ...t, expiresAt: inDays(20) });
    expect((await accountToken(env.ctx, id)).accessToken).toBe(t.accessToken); // 20 days left: left alone
    await setToken(id, { ...t, expiresAt: inDays(5) });
    const fresh = await accountToken(env.ctx, id);
    expect(fresh.accessToken).not.toBe(t.accessToken);
    expect(tokenOf(await row(id) as any).accessToken).toBe(fresh.accessToken); // and stored, sealed
    expect(new Date((await row(id)).token_expires_at).getTime()).toBeGreaterThan(Date.now() + 50 * 86_400_000);
  });

  it('renews an X token minutes before it ends and keeps the rotated renewal token', async () => {
    const id = await connectOne('x', 'x:4242');
    const t = tokenOf(await row(id) as any);
    await setToken(id, { ...t, expiresAt: new Date(Date.now() + 3 * 60_000).toISOString() });
    const fresh = await accountToken(env.ctx, id);
    expect(fresh.accessToken).not.toBe(t.accessToken);
    expect(fresh.refreshToken).not.toBe(t.refreshToken);
    // The next renewal uses the rotated one: it would be refused if the old one were kept.
    await setToken(id, { ...fresh, expiresAt: new Date(Date.now() + 3 * 60_000).toISOString() });
    expect((await accountToken(env.ctx, id)).accessToken).not.toBe(fresh.accessToken);
  });

  it('starts a new Bluesky session when the old one has lapsed, from the sealed app password', async () => {
    const r = await env.call(env.users.admin, 'POST', brandUrl('/connections/bluesky/credentials'), { values: { handle: 'lumen.bsky.social', appPassword: bluesky.password } });
    const id = (await choose(r.body.pendingId, ['bluesky:did:plc:lumen'])).body[0].id as string;
    const t = tokenOf(await row(id) as any);
    bluesky.refreshExpired = true;
    await setToken(id, { ...t, expiresAt: new Date(Date.now() + 2 * 60_000).toISOString() });
    const fresh = await accountToken(env.ctx, id);
    expect(fresh.accessToken).not.toBe(t.accessToken);
    expect(bluesky.callsTo('/xrpc/com.atproto.server.createSession').length).toBeGreaterThan(1);
    bluesky.refreshExpired = false;
  });

  it('asks for a reconnection, once, when a renewal is refused for good', async () => {
    const id = await connectOne('pinterest', 'pinterest:b1');
    const t = tokenOf(await row(id) as any);
    pinterest.revoked = true;
    try {
      await setToken(id, { ...t, expiresAt: new Date(Date.now() + 3_600_000).toISOString() });
      await expect(accountToken(env.ctx, id)).rejects.toMatchObject({ errorClass: 'auth' });
      expect((await row(id)).status).toBe('reconnect_required');
      const told = await env.db.query(`select user_id from notification where kind = 'account.reconnect' and payload->>'accountId' = $1`, [id]);
      expect(told.length).toBeGreaterThan(0);
    } finally {
      pinterest.revoked = false;
    }
  });

  it('keeps a LinkedIn token that cannot be renewed until it ends, and warns the admin a week ahead instead', async () => {
    linkedin.orgs = [{ id: '5001', localizedName: 'Lumen Coffee', vanityName: 'lumen-coffee' }];
    linkedin.partner = false;
    const id = await connectOne('linkedin', 'linkedin:5001');
    const t = tokenOf(await row(id) as any);
    await setToken(id, { ...t, accessToken: 'tok', expiresAt: inDays(4) });
    expect((await accountToken(env.ctx, id)).accessToken).toBe('tok'); // no renewal token: the one we have still works
    expect((await row(id)).status).toBe('active');
    await env.db.query('update social_account set last_health_at = null where id = $1', [id]);
    expect(await checkHealth(env.ctx, id)).toEqual({ valid: true });
    const warned = await env.db.query(`select 1 from notification where kind = 'account.expiring' and payload->>'accountId' = $1`, [id]);
    expect(warned.length).toBeGreaterThan(0);
  });
});
