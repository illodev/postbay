import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TokenVault } from '../src/crypto.js';
import { accountsDueForHealth, checkHealth } from '../src/services/connectors.js';
import { createEnv, type Env } from './helpers.js';

let env: Env;
beforeAll(async () => { env = await createEnv({}, { fakes: true }); });
afterAll(async () => { await env.close(); });

const brandUrl = (p: string) => `/api/brands/${env.brandId}${p}`;

/** Runs the whole browser dance with a provider: start, come back from the network, return what was found. */
async function signIn(provider: 'meta' | 'google', code = 'good', as = env.users.admin, reconnectAccountId?: string) {
  const start = await env.call(as, 'POST', brandUrl(`/connections/${provider}`), reconnectAccountId ? { reconnectAccountId } : {});
  expect(start.status, JSON.stringify(start.body)).toBe(200);
  const state = new URL(start.body.url).searchParams.get('state')!;
  const back = await env.app.inject({ method: 'GET', url: `/api/oauth/callback?code=${code}&state=${state}`, headers: { cookie: as.cookie! } });
  return { start, state, back, location: new URL(back.headers.location as string, 'http://app.test') };
}

const pendingId = (loc: URL) => loc.searchParams.get('connection')!;
const accountRow = async (id: string) => (await env.db.one('select * from social_account where id = $1', [id]))!;

describe('connecting Facebook and Instagram', () => {
  it('sends the person to Meta, takes them back, lets them choose, and keeps the token sealed', async () => {
    const s = await signIn('meta');
    expect(s.start.body.url).toContain('/dialog/oauth');
    expect(s.back.statusCode).toBe(302);
    expect(s.location.pathname).toBe('/settings');
    expect(s.location.searchParams.get('tab')).toBe('accounts');
    const pid = pendingId(s.location);

    const pending = await env.call(env.users.admin, 'GET', brandUrl(`/connections/${pid}`));
    expect(pending.body.candidates.map((c: any) => [c.key, c.existing])).toEqual([['facebook:111', null], ['instagram:222', null]]);
    expect(JSON.stringify(pending.body)).not.toContain('page-token'); // the browser never sees tokens

    const chosen = await env.call(env.users.admin, 'POST', brandUrl(`/connections/${pid}/select`), { keys: ['instagram:222'] });
    expect(chosen.status).toBe(200);
    const id = chosen.body[0].id as string;
    const acc = await accountRow(id);
    expect(acc).toMatchObject({ network: 'instagram', external_id: '222', display_name: '@lumen.coffee', status: 'active', connected_by: env.users.admin.id });
    expect(acc.provider_data).toMatchObject({ igUserId: '222', pageId: '111' });

    // Sealed: the bytes in the database do not contain the token, and only the right account can open them.
    expect(Buffer.from(acc.token_encrypted).toString('latin1')).not.toContain('page-token-111');
    const vault = env.ctx.vault!;
    expect(vault.open<{ accessToken: string }>(acc.token_encrypted, `account:${id}`).accessToken).toBe('page-token-111');
    expect(() => vault.open(acc.token_encrypted, `account:${env.accounts.instagram}`)).toThrow();
    const wrongKey = new TokenVault(randomBytes(32));
    expect(() => wrongKey.open(acc.token_encrypted, `account:${id}`)).toThrow();

    // The attempt cannot be used twice.
    expect((await env.call(env.users.admin, 'POST', brandUrl(`/connections/${pid}/select`), { keys: ['facebook:111'] })).status).toBe(404);
    const again = await env.app.inject({ method: 'GET', url: `/api/oauth/callback?code=good&state=${s.state}`, headers: { cookie: env.users.admin.cookie! } });
    expect(again.statusCode).toBe(400);

    // The account list says it is connected and automatic, and shows nothing secret.
    const list = await env.call(env.users.reader, 'GET', brandUrl('/accounts'));
    const mine = list.body.find((a: any) => a.id === id);
    expect(mine).toMatchObject({ connected: true, automated: true, status: 'active' });
    expect(JSON.stringify(list.body)).not.toContain('page-token');
    expect(JSON.stringify(list.body)).not.toContain('token_encrypted');
  });

  it('can connect the Page and its Instagram account together, and updates them when they are chosen again', async () => {
    env.meta.pages = [{ id: '555', name: 'Second Page', token: 'page-token-555', ig: { id: '666', username: 'second.page' } }];
    try {
      const s = await signIn('meta');
      const both = await env.call(env.users.admin, 'POST', brandUrl(`/connections/${pendingId(s.location)}/select`), { keys: ['facebook:555', 'instagram:666'] });
      expect(both.body.map((a: any) => a.network).sort()).toEqual(['facebook', 'instagram']);
      // Doing it again recognises the accounts and refreshes them instead of duplicating them.
      const s2 = await signIn('meta');
      const pending = await env.call(env.users.admin, 'GET', brandUrl(`/connections/${pendingId(s2.location)}`));
      expect(pending.body.candidates.every((c: any) => c.existing?.status === 'active')).toBe(true);
      await env.call(env.users.admin, 'POST', brandUrl(`/connections/${pendingId(s2.location)}/select`), { keys: ['facebook:555'] });
      const rows = await env.db.query(`select id from social_account where brand_id = $1 and external_id = '555'`, [env.brandId]);
      expect(rows).toHaveLength(1);
    } finally {
      env.meta.pages = [{ id: '111', name: 'Lumen Coffee', token: 'page-token-111', ig: { id: '222', username: 'lumen.coffee' } }];
    }
  });

  it('only lets admins start, and binds the attempt to the person who started it', async () => {
    expect((await env.call(env.users.approver, 'POST', brandUrl('/connections/meta'), {})).status).toBe(403);
    expect((await env.call(env.users.reader, 'POST', brandUrl('/connections/meta'), {})).status).toBe(403);
    const s = await signIn('meta');
    // Another admin cannot finish somebody else's attempt.
    const other = await env.db.one(`select id from app_user where email = 'approver@example.com'`);
    await env.db.query(`update member set role = 'admin' where user_id = $1`, [other!.id]);
    try {
      const hijack = await env.app.inject({ method: 'GET', url: `/api/oauth/callback?code=good&state=${new URL(s.start.body.url).searchParams.get('state')}`, headers: { cookie: env.users.approver.cookie! } });
      expect(hijack.statusCode).toBe(403);
    } finally {
      await env.db.query(`update member set role = 'approver' where user_id = $1`, [other!.id]);
    }
    // A browser without a session goes to sign in.
    const anon = await env.app.inject({ method: 'GET', url: `/api/oauth/callback?code=good&state=whatever` });
    expect(anon.statusCode).toBe(302);
    expect(anon.headers.location).toBe('/login');
  });

  it('reports a cancelled or failed sign-in on the settings page, without keeping anything', async () => {
    const start = await env.call(env.users.admin, 'POST', brandUrl('/connections/meta'), {});
    const state = new URL(start.body.url).searchParams.get('state')!;
    const denied = await env.app.inject({ method: 'GET', url: `/api/oauth/callback?error=access_denied&error_description=The+user+denied+access&state=${state}`, headers: { cookie: env.users.admin.cookie! } });
    const loc = new URL(denied.headers.location as string, 'http://app.test');
    expect(loc.searchParams.get('connect_error')).toBe('The user denied access');
    expect(loc.searchParams.get('connection')).toBeNull();

    const bad = await signIn('meta', 'bad');
    expect(bad.location.searchParams.get('connect_error')).toMatch(/verification code/);
    const none = env.meta.pages;
    env.meta.pages = [];
    try {
      const empty = await signIn('meta');
      expect(empty.location.searchParams.get('connect_error')).toMatch(/Page/);
    } finally {
      env.meta.pages = none;
    }
  });

  it('refuses an attempt that has expired', async () => {
    const start = await env.call(env.users.admin, 'POST', brandUrl('/connections/meta'), {});
    const state = new URL(start.body.url).searchParams.get('state')!;
    env.clock.set(new Date(Date.now() + 30 * 60_000));
    try {
      const late = await env.app.inject({ method: 'GET', url: `/api/oauth/callback?code=good&state=${state}`, headers: { cookie: env.users.admin.cookie! } });
      expect(late.statusCode).toBe(400);
    } finally {
      env.clock.set(new Date());
    }
  });
});

describe('reconnecting', () => {
  it('brings an account back, only as the same account', async () => {
    const id = await env.connect('instagram', { externalId: '222x', name: '@old-handle', token: 'revoked-token' });
    await env.db.query(`update social_account set status = 'reconnect_required', last_error = 'expired' where id = $1`, [id]);
    // Signing in as a different account is refused.
    env.meta.pages = [{ id: '777', name: 'Other', token: 'page-token-777', ig: { id: '888', username: 'someone.else' } }];
    try {
      const wrong = await signIn('meta', 'good', env.users.admin, id);
      const refused = await env.call(env.users.admin, 'POST', brandUrl(`/connections/${pendingId(wrong.location)}/select`), { keys: ['instagram:888'] });
      expect(refused.status).toBe(400);
      expect(refused.body.error.code).toBe('wrong_account');
    } finally {
      env.meta.pages = [{ id: '111', name: 'Lumen Coffee', token: 'page-token-111', ig: { id: '222', username: 'lumen.coffee' } }];
    }
    // Signing in as the same one works.
    env.meta.pages = [{ id: '111x', name: 'Old Page', token: 'page-token-111x', ig: { id: '222x', username: 'old.handle' } }];
    try {
      const right = await signIn('meta', 'good', env.users.admin, id);
      const ok = await env.call(env.users.admin, 'POST', brandUrl(`/connections/${pendingId(right.location)}/select`), { keys: ['instagram:222x'] });
      expect(ok.status).toBe(200);
      expect(await accountRow(id)).toMatchObject({ status: 'active', last_error: null, display_name: '@old.handle' });
      expect(ok.body[0].id).toBe(id); // same account, so its history and publications stay with it
    } finally {
      env.meta.pages = [{ id: '111', name: 'Lumen Coffee', token: 'page-token-111', ig: { id: '222', username: 'lumen.coffee' } }];
    }
  });

  it('lets a manual account from phase 1 take on its real identity when it is connected', async () => {
    const manual = env.accounts.facebook; // registered by hand with a made-up id
    const s = await signIn('meta', 'good', env.users.admin, manual);
    const done = await env.call(env.users.admin, 'POST', brandUrl(`/connections/${pendingId(s.location)}/select`), { keys: ['facebook:111'] });
    expect(done.status).toBe(200);
    expect(done.body[0].id).toBe(manual);
    expect(await accountRow(manual)).toMatchObject({ status: 'active', external_id: '111', display_name: 'Lumen Coffee' });
    expect((await accountRow(manual)).token_encrypted).not.toBeNull();
  });
});

describe('connecting YouTube', () => {
  it('asks for offline access, finds the channel and stores the refresh token sealed', async () => {
    const s = await signIn('google');
    expect(new URL(s.start.body.url).searchParams.get('access_type')).toBe('offline');
    const pending = await env.call(env.users.admin, 'GET', brandUrl(`/connections/${pendingId(s.location)}`));
    expect(pending.body.candidates[0]).toMatchObject({ key: 'youtube:UC-lumen', displayName: 'Lumen Coffee TV' });
    const done = await env.call(env.users.admin, 'POST', brandUrl(`/connections/${pendingId(s.location)}/select`), { keys: ['youtube:UC-lumen'] });
    const id = done.body[0].id as string;
    const acc = await accountRow(id);
    const sealed = env.ctx.vault!.open<{ accessToken: string; refreshToken: string }>(acc.token_encrypted, `account:${id}`);
    expect(sealed.refreshToken).toBe('refresh-1');
    expect(acc.token_expires_at).not.toBeNull();
    expect(acc.provider_data.audited).toBe(false);
  });

  it('says what went wrong when Google gives no refresh token', async () => {
    const s = await signIn('google', 'norefresh');
    expect(s.location.searchParams.get('connect_error')).toMatch(/refresh token/);
  });

  it('records, by an admin only, that Google has audited the project', async () => {
    const id = (await env.db.one(`select id from social_account where network = 'youtube' and external_id = 'UC-lumen' and token_encrypted is not null`))!.id;
    expect((await env.call(env.users.approver, 'PATCH', brandUrl(`/accounts/${id}`), { audited: true })).status).toBe(403);
    expect((await env.call(env.users.admin, 'PATCH', brandUrl(`/accounts/${env.accounts.instagram}`), { audited: true })).status).toBe(400);
    expect((await env.call(env.users.admin, 'PATCH', brandUrl(`/accounts/${id}`), { audited: true })).status).toBe(200);
    const list = await env.call(env.users.reader, 'GET', brandUrl('/accounts'));
    expect(list.body.find((a: any) => a.id === id).details.audited).toBe(true);
  });
});

describe('disconnecting', () => {
  it('is refused while posts are still waiting to go out through the account, and then forgets the token', async () => {
    const id = await env.connect('instagram', { externalId: '999', name: '@leaving' });
    const { users, call, makePiece, newVersion, approve } = env;
    const { variantId } = await makePiece(users.producer, 'post', '4:5');
    const v = await newVersion(users.producer, variantId, [{ name: 'p.png', mime: 'image/png', kind: 'image' }]);
    await approve(users.approver, v.body.id, [id]);
    const pub = await call(users.approver, 'POST', `/api/versions/${v.body.id}/publications`, { accountId: id, scheduledAt: new Date(Date.now() + 3 * 3600_000).toISOString(), text: 'x' });
    expect(pub.body.manual).toBe(false);

    const blocked = await call(users.admin, 'POST', brandUrl(`/accounts/${id}/disconnect`));
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.code).toBe('account_in_use');
    expect((await call(users.approver, 'POST', brandUrl(`/accounts/${id}/disconnect`))).status).toBe(403);

    await call(users.approver, 'POST', `/api/publications/${pub.body.id}/cancel`);
    const ok = await call(users.admin, 'POST', brandUrl(`/accounts/${id}/disconnect`));
    expect(ok.status).toBe(200);
    expect(await accountRow(id)).toMatchObject({ status: 'manual', token_encrypted: null });
  });
});

describe('integrations', () => {
  it('lists what this server can connect to and what each network accepts', async () => {
    const r = await env.call(env.users.reader, 'GET', brandUrl('/integrations'));
    const by = Object.fromEntries(r.body.providers.map((p: any) => [p.id, p]));
    expect(by.meta).toMatchObject({ label: 'Facebook and Instagram', networks: ['facebook', 'instagram'], configured: true, signIn: 'redirect' });
    expect(by.google).toMatchObject({ label: 'YouTube', networks: ['youtube'], configured: true, signIn: 'redirect' });
    // The others need credentials this test server does not have; Bluesky needs none, only the key that seals its password.
    for (const id of ['threads', 'tiktok', 'linkedin', 'x', 'pinterest']) expect(by[id].configured, id).toBe(false);
    expect(by.bluesky).toMatchObject({ configured: true, signIn: 'credentials' });
    expect(by.bluesky.fields.map((f: any) => f.key)).toEqual(['handle', 'appPassword', 'server']);
    expect(Object.keys(r.body.capabilities).sort()).toEqual(['bluesky', 'facebook', 'instagram', 'linkedin', 'pinterest', 'threads', 'tiktok', 'x', 'youtube']);
    expect(r.body.capabilities.instagram.text.maxChars).toBe(2200);
    expect(r.body.capabilities.instagram.placements.find((p: any) => p.id === 'reel').safeZones).toBeDefined();
  });

  it('says plainly when a provider is not set up on this server', async () => {
    const bare = await createEnv();
    try {
      const r = await bare.call(bare.users.admin, 'POST', `/api/brands/${bare.brandId}/connections/meta`, {});
      expect(r.status).toBe(503);
      expect(r.body.error.code).toBe('provider_not_configured');
      const i = await bare.call(bare.users.reader, 'GET', `/api/brands/${bare.brandId}/integrations`);
      expect(i.body.providers.every((p: any) => p.configured === false)).toBe(true);
    } finally {
      await bare.close();
    }
  });
});

describe('connection health', () => {
  it('marks an account whose token the network rejects, and leaves a healthy one alone', async () => {
    const good = await env.connect('instagram', { externalId: '222h', name: '@healthy' });
    const bad = await env.connect('instagram', { externalId: '333h', name: '@revoked', token: 'revoked-token' });
    env.meta.pages = [...env.meta.pages];
    expect(await checkHealth(env.ctx, good)).toEqual({ valid: true });
    expect(await checkHealth(env.ctx, bad)).toEqual({ valid: false });
    expect((await accountRow(bad)).status).toBe('reconnect_required');
    expect((await accountRow(good)).last_health_at).not.toBeNull();
    // A checked account is not due again for a day.
    const due = await accountsDueForHealth(env.ctx, 200);
    expect(due).not.toContain(good);
    env.clock.set(new Date(Date.now() + 26 * 3600_000));
    try {
      expect(await accountsDueForHealth(env.ctx, 200)).toContain(good);
      expect(await accountsDueForHealth(env.ctx, 200)).not.toContain(bad); // needs reconnecting, not checking
    } finally {
      env.clock.set(new Date());
    }
  });

  it('warns the admins once a day when Meta access is about to lapse', async () => {
    env.meta.pages.push({ id: '4444', name: 'Expiring', token: 'page-token-4444' });
    const id = await env.connect('facebook', { externalId: '4444', name: 'Expiring', token: 'page-token-4444', providerData: { dataAccessExpiresAt: new Date(Date.now() + 3 * 86400_000).toISOString() } });
    await checkHealth(env.ctx, id);
    await env.db.query('update social_account set last_health_at = null where id = $1', [id]);
    await checkHealth(env.ctx, id); // the same day: no second warning
    const told = await env.db.query(`select user_id from notification where kind = 'account.expiring' and payload->>'accountId' = $1`, [id]);
    expect(told.map((t) => t.user_id)).toEqual([env.users.admin.id]);
    env.clock.set(new Date(Date.now() + 25 * 3600_000));
    try {
      await checkHealth(env.ctx, id);
    } finally {
      env.clock.set(new Date());
    }
    expect(await env.db.query(`select 1 from notification where kind = 'account.expiring' and payload->>'accountId' = $1`, [id])).toHaveLength(2);
  });
});

describe('the token vault', () => {
  const vault = new TokenVault(randomBytes(32));
  it('round-trips a value and uses a fresh IV every time', () => {
    const a = vault.seal({ accessToken: 'abc' }, 'x');
    const b = vault.seal({ accessToken: 'abc' }, 'x');
    expect(a.equals(b)).toBe(false);
    expect(vault.open(a, 'x')).toEqual({ accessToken: 'abc' });
  });
  it('refuses a different context, a tampered value and a key of the wrong size', () => {
    const sealed = vault.seal({ accessToken: 'abc' }, 'account:1');
    expect(() => vault.open(sealed, 'account:2')).toThrow();
    const tampered = Buffer.from(sealed);
    tampered[tampered.length - 1] = tampered[tampered.length - 1]! ^ 1;
    expect(() => vault.open(tampered, 'account:1')).toThrow();
    expect(() => new TokenVault(Buffer.alloc(16))).toThrow(/32 bytes/);
    expect(() => vault.open(Buffer.from('short'), 'x')).toThrow();
  });
});
