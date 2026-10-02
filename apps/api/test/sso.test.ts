import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { OidcClient, OidcError } from '../src/auth/oidc.js';
import { base32Decode, hotp, stepAt } from '../src/auth/totp.js';
import { loadConfig } from '../src/config.js';
import { startSession } from '../src/services/auth.js';
import { FakeOidc } from './fakes/oidc.js';
import { createEnv, type Env } from './helpers.js';

const idp = new FakeOidc();
let env: Env;
beforeAll(async () => {
  await idp.start();
  env = await createEnv({
    OIDC_ISSUER: idp.url, OIDC_CLIENT_ID: idp.clientId, OIDC_CLIENT_SECRET: idp.clientSecret, OIDC_ALLOWED_DOMAINS: 'example.com, @Partner.org',
    OIDC_LABEL: 'Acme Workspace', SECOND_FACTOR_REQUIRED: 'false',
  });
});
afterAll(async () => { await env.close(); await idp.stop(); });

let n = 0;
const ip = () => `10.1.${(++n >> 8) & 255}.${n & 255}`;
const SSO = (c: string | undefined) => (c ? `sso=${c}` : '');
const cookiesOf = (res: { headers: Record<string, unknown> }) => [res.headers['set-cookie']].flat().filter(Boolean).map(String);
const pick = (cookies: string[], name: string) => new RegExp(`${name}=([^;]*)`).exec(cookies.join(';'))?.[1];

beforeEach(async () => {
  idp.claims = {};
  idp.tamper = {};
  await env.db.query('delete from user_identity');
  await env.db.query('delete from sso_attempt');
  await env.db.query(`delete from user_totp`);
  (env.ctx.config as { secondFactorRequired: boolean }).secondFactorRequired = false;
  (env.ctx.config.sso as { secondFactor: string }).secondFactor = 'app';
});

/** A person at their browser: starts at our page, goes to the provider, comes back. `mutate` lets a test interfere on the way. */
async function signIn(o: { mutate?: (cb: URL, held: string) => { cb: URL; held: string | undefined }; claims?: Record<string, unknown> } = {}) {
  const start = await env.app.inject({ method: 'GET', url: '/api/auth/sso/start', headers: { 'x-forwarded-for': ip() } });
  expect(start.statusCode).toBe(302);
  const held = pick(cookiesOf(start), 'sso')!;
  const authorize = new URL(start.headers.location as string);
  if (o.claims) idp.claims = o.claims;
  const atProvider = await fetch(authorize, { redirect: 'manual' });
  expect(atProvider.status).toBe(302);
  let back = new URL(atProvider.headers.get('location')!);
  let heldBack: string | undefined = held;
  if (o.mutate) ({ cb: back, held: heldBack } = o.mutate(back, held));
  const cb = await env.app.inject({ method: 'GET', url: back.pathname + back.search, headers: { cookie: SSO(heldBack), 'x-forwarded-for': ip() } });
  const location = String(cb.headers.location ?? '');
  const cookies = cookiesOf(cb);
  return { authorize, start, cb, callbackUrl: back.pathname + back.search, held, location, error: new URL(location, 'http://app.test').searchParams.get('error'), sid: pick(cookies, 'sid'), cookies };
}

const me = (sid: string) => env.app.inject({ method: 'GET', url: '/api/me', headers: { cookie: `sid=${sid}`, 'x-forwarded-for': ip() } });
const makeUser = async (email: string, role = 'reviewer') => {
  const u = (await env.db.one<{ id: string }>('insert into app_user (email, name) values ($1,$1) on conflict do nothing returning id', [email])) ?? (await env.db.one<{ id: string }>('select id from app_user where email = $1', [email]))!;
  await env.db.query('insert into member (user_id, brand_id, role) values ($1,$2,$3) on conflict do nothing', [u.id, env.brandId, role]);
  return u.id;
};

describe('offering it', () => {
  it('shows the button with the provider\'s name, and is not there when it is not set up', async () => {
    const r = await env.call(null, 'GET', '/api/config');
    expect(r.body.sso).toEqual({ label: 'Acme Workspace' });
    expect(r.body.emailLinkLogin).toBe(true);
    expect(r.body.devLogin).toBe(false);
  });

  it('sends the browser to the provider with state, a nonce and a PKCE challenge, and holds the state in a cookie that script cannot read', async () => {
    const start = await env.app.inject({ method: 'GET', url: '/api/auth/sso/start' });
    const url = new URL(start.headers.location as string);
    expect(url.origin + url.pathname).toBe(`${idp.url}/authorize`);
    const q = url.searchParams;
    expect(q.get('response_type')).toBe('code');
    expect(q.get('client_id')).toBe(idp.clientId);
    expect(q.get('redirect_uri')).toBe('http://app.test/api/auth/sso/callback');
    expect(q.get('scope')).toBe('openid email profile');
    expect(q.get('code_challenge_method')).toBe('S256');
    expect(q.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(q.get('nonce')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(q.get('state')!.length).toBeGreaterThan(20);
    const cookie = cookiesOf(start).find((c) => c.startsWith('sso='))!;
    expect(cookie).toContain(q.get('state')!);
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Lax/i);
    expect(cookie).toMatch(/Path=\/api\/auth\/sso/);
    // The challenge is not the verifier: the verifier is never sent anywhere but the token request.
    expect(q.get('code_challenge')).not.toBe(q.get('state'));
  });

  it('makes a new state each time, and none of them is derivable from another', async () => {
    const a = new URL((await env.app.inject({ method: 'GET', url: '/api/auth/sso/start' })).headers.location as string).searchParams;
    const b = new URL((await env.app.inject({ method: 'GET', url: '/api/auth/sso/start' })).headers.location as string).searchParams;
    for (const k of ['state', 'nonce', 'code_challenge']) expect(a.get(k)).not.toBe(b.get(k));
  });
});

describe('signing in', () => {
  it('signs in someone who exists, links their provider id to them, and sets a session', async () => {
    const id = await makeUser('ana@example.com');
    const r = await signIn();
    expect(r.error).toBeNull();
    expect(r.location).toBe('/');
    expect(r.sid).toBeTruthy();
    const who = await me(r.sid!);
    expect(who.statusCode).toBe(200);
    expect(JSON.parse(who.body).user.email).toBe('ana@example.com');
    const link = await env.db.one('select * from user_identity where user_id = $1', [id]);
    expect(link).toMatchObject({ issuer: idp.url, subject: 'sub-ana', email: 'ana@example.com' });
    const session = await env.db.one('select via, second_factor_at from session s join app_user u on u.id = s.user_id where u.id = $1 and via = $2 order by s.created_at desc limit 1', [id, 'sso']);
    expect(session!.via).toBe('sso');
    expect(session!.second_factor_at).toBeNull();
    const events = (await env.db.query<{ action: string }>(`select action from audit_event where entity_id = $1 and action like 'auth.sso%' order by id`, [id])).map((e) => e.action);
    expect(events).toEqual(['auth.sso_linked', 'auth.sso_login']);
  });

  it('forgets the cookie it was holding, and cannot be run again with the same address', async () => {
    await makeUser('ana@example.com');
    const r = await signIn();
    expect(r.cookies.find((c) => c.startsWith('sso='))).toMatch(/sso=;|Max-Age=0|Expires=/i);
    // The same callback, replayed: the state was used.
    const replay = await env.app.inject({ method: 'GET', url: r.callbackUrl, headers: { cookie: SSO(r.held), 'x-forwarded-for': ip() } });
    expect(new URL(String(replay.headers.location), 'http://app.test').searchParams.get('error')).toBe('state');
    expect(pick(cookiesOf(replay), 'sid')).toBeUndefined();
  });

  it('recognises the person by the provider\'s id afterwards, even if their email there has changed', async () => {
    const id = await makeUser('ana@example.com');
    expect((await signIn()).sid).toBeTruthy();
    const second = await signIn({ claims: { email: 'ana.renamed@example.com' } });
    expect(second.error).toBeNull();
    expect(JSON.parse((await me(second.sid!)).body).user.email).toBe('ana@example.com');
    expect(await env.db.one('select email from user_identity where user_id = $1', [id])).toMatchObject({ email: 'ana.renamed@example.com' });
  });

  it('does not make accounts: someone the provider knows but this app does not is refused', async () => {
    const before = (await env.db.one<{ n: number }>('select count(*)::int as n from app_user'))!.n;
    const r = await signIn({ claims: { email: 'stranger@example.com', sub: 'sub-stranger' } });
    expect(r.error).toBe('no_account');
    expect(r.sid).toBeUndefined();
    expect((await env.db.one<{ n: number }>('select count(*)::int as n from app_user'))!.n).toBe(before);
    expect(await env.db.one('select 1 from user_identity')).toBeNull();
  });

  it('refuses a domain that is not on the list, and takes the ones that are (in any case, with or without the @)', async () => {
    await makeUser('ana@example.com');
    await makeUser('pat@partner.org');
    await makeUser('eve@evil.example.net');
    expect((await signIn({ claims: { email: 'eve@evil.example.net', sub: 'sub-eve' } })).error).toBe('domain');
    expect((await signIn({ claims: { email: 'Pat@PARTNER.org', sub: 'sub-pat' } })).error).toBeNull();
    expect((await signIn()).error).toBeNull();
  });

  it('refuses an email the provider does not say is verified', async () => {
    await makeUser('ana@example.com');
    expect((await signIn({ claims: { email_verified: false } })).error).toBe('claims');
    expect((await signIn({ claims: { email_verified: undefined } })).error).toBe('claims');
    expect((await signIn({ claims: { email_verified: 'true' } })).error).toBeNull(); // some providers send the word
  });

  it('refuses a second provider account claiming an email that is already linked to another', async () => {
    const id = await makeUser('ana@example.com');
    expect((await signIn()).error).toBeNull();
    const imposter = await signIn({ claims: { sub: 'sub-someone-else' } });
    expect(imposter.error).toBe('identity_conflict');
    expect(imposter.sid).toBeUndefined();
    expect((await env.db.query('select subject from user_identity where user_id = $1', [id])).map((r) => r.subject)).toEqual(['sub-ana']);
    const ev = await env.db.one(`select action from audit_event where action = 'auth.sso_refused' and entity_id = $1`, [id]);
    expect(ev).not.toBeNull();
  });

  it('says it was cancelled when the person said no at the provider', async () => {
    const start = await env.app.inject({ method: 'GET', url: '/api/auth/sso/start' });
    const state = new URL(start.headers.location as string).searchParams.get('state')!;
    const cb = await env.app.inject({ method: 'GET', url: `/api/auth/sso/callback?error=access_denied&state=${state}`, headers: { cookie: SSO(pick(cookiesOf(start), 'sso')) } });
    expect(new URL(String(cb.headers.location), 'http://app.test').searchParams.get('error')).toBe('cancelled');
  });
});

describe('what the callback refuses', () => {
  it('a callback the browser did not start (no cookie, or the cookie of another sign-in): nobody can be made to finish somebody else\'s', async () => {
    await makeUser('ana@example.com');
    const noCookie = await signIn({ mutate: (cb) => ({ cb, held: undefined }) });
    expect(noCookie.error).toBe('state');
    expect(noCookie.sid).toBeUndefined();
    const other = await env.app.inject({ method: 'GET', url: '/api/auth/sso/start' });
    const wrong = await signIn({ mutate: (cb) => ({ cb, held: pick(cookiesOf(other), 'sso') }) });
    expect(wrong.error).toBe('state');
    expect(wrong.sid).toBeUndefined();
  });

  it('a state nobody made, or one that has expired', async () => {
    const forged = 'x'.repeat(32);
    const f = await env.app.inject({ method: 'GET', url: `/api/auth/sso/callback?code=abc&state=${forged}`, headers: { cookie: SSO(forged) } });
    expect(new URL(String(f.headers.location), 'http://app.test').searchParams.get('error')).toBe('state');

    await makeUser('ana@example.com');
    const start = await env.app.inject({ method: 'GET', url: '/api/auth/sso/start' });
    const back = new URL((await fetch(new URL(start.headers.location as string), { redirect: 'manual' })).headers.get('location')!);
    // The person took too long at the provider.
    await env.db.query(`update sso_attempt set expires_at = now() - interval '1 second'`);
    const late = await env.app.inject({ method: 'GET', url: back.pathname + back.search, headers: { cookie: SSO(pick(cookiesOf(start), 'sso')) } });
    expect(new URL(String(late.headers.location), 'http://app.test').searchParams.get('error')).toBe('state');
    expect(pick(cookiesOf(late), 'sid')).toBeUndefined();
  });

  it('an ID token the provider did not sign with a key it publishes, or signed with something weaker', async () => {
    await makeUser('ana@example.com');
    for (const [name, tamper, expected] of [
      ['a key it does not publish', { wrongKey: true }, 'token'],
      ['an unknown key id', { kid: 'nobody' }, 'token'],
      ['no signature at all', { noSignature: true }, 'token'],
      ['"none"', { alg: 'none', noSignature: true }, 'token'],
      ['HS256 (the public key used as a secret is the classic attack)', { alg: 'HS256' }, 'token'],
      ['a payload edited after signing', { breakPayload: true }, 'token'],
    ] as const) {
      idp.tamper = { ...tamper };
      const r = await signIn();
      expect(r.error, name).toBe(expected);
      expect(r.sid, name).toBeUndefined();
    }
    expect(await env.db.one('select 1 from user_identity')).toBeNull();
  });

  it('an ID token that is for another issuer, another application, another sign-in, or is out of date', async () => {
    await makeUser('ana@example.com');
    for (const [name, tamper] of [
      ['another issuer', { issuer: 'https://evil.example.org' }],
      ['another application', { audience: 'someone-else' }],
      ['several audiences without our authorisation', { audience: [idp.clientId, 'someone-else'] }],
      ['another sign-in (nonce)', { nonce: 'not-the-nonce' }],
      ['an expired token', { expiresInSeconds: -3600 }],
      ['one from the future', { issuedAtOffsetSeconds: 3600 }],
      ['one with no subject', { withoutSub: true }],
    ] as const) {
      idp.tamper = { ...tamper };
      const r = await signIn();
      expect(r.error, name).toBe('claims');
      expect(r.sid, name).toBeUndefined();
    }
    // Several audiences are fine when the token says it was meant for us.
    idp.tamper = { audience: [idp.clientId, 'another-api'], azp: idp.clientId };
    expect((await signIn()).error).toBeNull();
  });

  it('a provider whose discovery document names another issuer than the one configured', async () => {
    idp.tamper = { discoveryIssuer: 'https://evil.example.org' };
    // The client caches discovery for an hour, so this is checked on a fresh one.
    const c = new OidcClient({ issuer: idp.url, clientId: idp.clientId, clientSecret: idp.clientSecret, allowedDomains: ['example.com'], trustEmail: false }, 'secret'.repeat(8));
    await expect(c.authorizeUrl('s', 'http://app.test/cb')).rejects.toThrow(/not "http/);
    await expect(c.authorizeUrl('s', 'http://app.test/cb')).rejects.toBeInstanceOf(OidcError);
  });

  it('a code the provider will not exchange (wrong secret, used twice)', async () => {
    const c = new OidcClient({ issuer: idp.url, clientId: idp.clientId, clientSecret: 'wrong', allowedDomains: ['example.com'], trustEmail: false }, 'secret'.repeat(8));
    const url = new URL(await c.authorizeUrl('state-1', 'http://app.test/cb'));
    const back = new URL((await fetch(url, { redirect: 'manual' })).headers.get('location')!);
    await expect(c.exchange(back.searchParams.get('code')!, 'state-1', 'http://app.test/cb')).rejects.toMatchObject({ code: 'token' });
  });
});

describe('the identity provider\'s own checks, one at a time', () => {
  const secret = 'secret'.repeat(8);
  const client = (o: Partial<ConstructorParameters<typeof OidcClient>[0]> = {}) =>
    new OidcClient({ issuer: idp.url, clientId: idp.clientId, clientSecret: idp.clientSecret, allowedDomains: ['example.com'], trustEmail: false, ...o }, secret);
  const claimsFor = async (c: OidcClient, state = 'st') => {
    const url = new URL(await c.authorizeUrl(state, 'http://app.test/cb'));
    const back = new URL((await fetch(url, { redirect: 'manual' })).headers.get('location')!);
    return c.exchange(back.searchParams.get('code')!, state, 'http://app.test/cb');
  };

  it('returns who the person is, lower-cased, when everything is in order', async () => {
    idp.claims = { email: 'Ana@Example.com', name: 'Ana A' };
    expect(await claimsFor(client())).toEqual({ issuer: idp.url, subject: 'sub-ana', email: 'ana@example.com', name: 'Ana A' });
  });

  it('wants the Workspace domain in `hd` when asked to (a personal Google account using an address there has none)', async () => {
    await expect(claimsFor(client({ requireHostedDomain: true }))).rejects.toMatchObject({ code: 'domain' });
    idp.claims = { hd: 'other.com' };
    await expect(claimsFor(client({ requireHostedDomain: true }))).rejects.toMatchObject({ code: 'domain' });
    idp.claims = { hd: 'example.com' };
    expect((await claimsFor(client({ requireHostedDomain: true }))).email).toBe('ana@example.com');
  });

  it('can trust an email the provider does not vouch for (Microsoft Entra), and then falls back to the user principal name', async () => {
    idp.claims = { email_verified: undefined };
    await expect(claimsFor(client())).rejects.toMatchObject({ code: 'claims' });
    expect((await claimsFor(client({ trustEmail: true }))).email).toBe('ana@example.com');
    idp.claims = { email: undefined, email_verified: undefined, preferred_username: 'Ana@example.com' };
    expect((await claimsFor(client({ trustEmail: true }))).email).toBe('ana@example.com');
    await expect(claimsFor(client())).rejects.toMatchObject({ code: 'claims' });
  });

  it('makes the nonce and the PKCE verifier from the state, differently, and neither is the state', () => {
    const c = client();
    expect(c.nonceFor('abc')).toBe(c.nonceFor('abc'));
    expect(c.nonceFor('abc')).not.toBe(c.nonceFor('abd'));
    expect(c.nonceFor('abc')).not.toBe(c.verifierFor('abc'));
    expect(client().nonceFor('abc')).toBe(c.nonceFor('abc'));
    expect(new OidcClient({ issuer: idp.url, clientId: 'x', clientSecret: 'y', allowedDomains: [], trustEmail: false }, 'another secret entirely, 40 chars long!').nonceFor('abc')).not.toBe(c.nonceFor('abc'));
  });
});

describe('together with the second factor', () => {
  it('still asks an admin for the authenticator after signing in this way, unless the provider\'s own step is trusted', async () => {
    (env.ctx.config as { secondFactorRequired: boolean }).secondFactorRequired = true;
    const id = await makeUser('ana@example.com');
    await env.db.query(`update member set role = 'admin' where user_id = $1`, [id]); // she may already be here as something else
    const r = await signIn();
    expect(r.error).toBeNull();
    const pending = await me(r.sid!);
    expect(pending.statusCode).toBe(401);
    expect(JSON.parse(pending.body).error.code).toBe('second_factor_required');

    (env.ctx.config.sso as { secondFactor: string }).secondFactor = 'idp';
    const trusted = await signIn();
    expect((await me(trusted.sid!)).statusCode).toBe(200);
    const row = await env.db.one(`select second_factor_at from session s join user_identity i on i.user_id = s.user_id order by s.created_at desc limit 1`);
    expect(row!.second_factor_at).not.toBeNull();
    await env.db.query(`update member set role = 'reviewer' where user_id = $1`, [id]);
  });
});

describe('the emailed link, when the provider\'s second step is trusted', () => {
  const as = (sid: string, method: 'GET' | 'POST', url: string, payload?: object) =>
    env.app.inject({ method, url, payload, headers: { cookie: `sid=${sid}`, 'x-requested-by': 'studio', 'x-forwarded-for': ip() } });

  it('does not get round it: a link session owes the app\'s own step, whatever the role, and cannot set one up', async () => {
    (env.ctx.config.sso as { secondFactor: string }).secondFactor = 'idp';
    const id = await makeUser('bea@example.com'); // a reviewer: the app asks nothing of her role
    const link = await startSession(env.ctx, id, 'link');
    const blocked = await me(link.token);
    expect(blocked.statusCode).toBe(401);
    expect(JSON.parse(blocked.body).error).toMatchObject({ code: 'second_factor_required', details: { step: 'enroll' } });
    // Whoever holds the link cannot put their own phone on the account.
    const enrol = await as(link.token, 'POST', '/api/auth/2fa/enroll');
    expect(enrol.statusCode).toBe(403);
    expect(JSON.parse(enrol.body).error.message).toContain('Acme Workspace');
    expect(await env.db.one('select 1 from user_totp where user_id = $1', [id])).toBeNull();

    // A single sign-on session (the provider's step done) sets one up; after that the link works, with a code.
    const sso = await startSession(env.ctx, id, 'sso', true);
    const started = await as(sso.token, 'POST', '/api/auth/2fa/enroll');
    expect(started.statusCode).toBe(200);
    const secret = JSON.parse(started.body).secret as string;
    const code = (steps = 0) => hotp(base32Decode(secret), stepAt(new Date()) + steps);
    expect((await as(sso.token, 'POST', '/api/auth/2fa/enroll/confirm', { code: code() })).statusCode).toBe(200);
    expect(JSON.parse((await me(link.token)).body).error.details.step).toBe('verify');
    expect((await as(link.token, 'POST', '/api/auth/2fa/verify', { code: code(1) })).statusCode).toBe(200);
    expect((await me(link.token)).statusCode).toBe(200);
  });

  it('leaves a link session alone where the app asks for its own step anyway', async () => {
    const id = await makeUser('cai@example.com');
    const link = await startSession(env.ctx, id, 'link');
    expect((await me(link.token)).statusCode).toBe(200); // OIDC_SECOND_FACTOR=app: a reviewer was never asked
  });
});

describe('what the deployment has to say about it', () => {
  const base = { NODE_ENV: 'test', SECRET: 'x'.repeat(40) };
  const sso = { OIDC_ISSUER: 'https://accounts.google.com', OIDC_CLIENT_ID: 'id', OIDC_CLIENT_SECRET: 'secret', OIDC_ALLOWED_DOMAINS: 'example.com' };

  it('has no single sign-on unless it is all set, and says what is missing', () => {
    expect(loadConfig(base).sso).toBeNull();
    expect(() => loadConfig({ ...base, OIDC_ISSUER: sso.OIDC_ISSUER })).toThrow(/OIDC_ISSUER, OIDC_CLIENT_ID and OIDC_CLIENT_SECRET together/);
    expect(() => loadConfig({ ...base, ...sso, OIDC_ALLOWED_DOMAINS: '' })).toThrow(/OIDC_ALLOWED_DOMAINS/);
    expect(() => loadConfig({ ...base, ...sso, OIDC_ALLOWED_DOMAINS: undefined })).toThrow(/OIDC_ALLOWED_DOMAINS/);
  });

  it('reads the domains and settings', () => {
    const c = loadConfig({ ...base, ...sso, OIDC_ALLOWED_DOMAINS: ' Example.com , @partner.org,', OIDC_LABEL: 'Google Workspace', OIDC_SECOND_FACTOR: 'idp', OIDC_TRUST_EMAIL: 'true' });
    expect(c.sso).toEqual({
      issuer: 'https://accounts.google.com', clientId: 'id', clientSecret: 'secret', label: 'Google Workspace',
      allowedDomains: ['example.com', 'partner.org'], secondFactor: 'idp', trustEmail: true,
    });
    expect(loadConfig({ ...base, ...sso, OIDC_ISSUER: 'https://accounts.google.com/' }).sso!.issuer).toBe('https://accounts.google.com');
    expect(loadConfig({ ...base, ...sso }).sso).toMatchObject({ label: 'single sign-on', secondFactor: 'app', trustEmail: false });
  });

  it('turns the emailed link off by default when the provider\'s second step is trusted, unless asked for', () => {
    expect(loadConfig({ ...base, ...sso }).emailLinkLogin).toBe(true);
    expect(loadConfig({ ...base, ...sso, OIDC_SECOND_FACTOR: 'idp' }).emailLinkLogin).toBe(false);
    expect(loadConfig({ ...base, ...sso, OIDC_SECOND_FACTOR: 'idp', EMAIL_LINK_LOGIN: '' }).emailLinkLogin).toBe(false);
    expect(loadConfig({ ...base, ...sso, OIDC_SECOND_FACTOR: 'idp', EMAIL_LINK_LOGIN: 'true' }).emailLinkLogin).toBe(true);
    // In production it then needs no mail server for signing in.
    expect(loadConfig({ ...base, ...sso, NODE_ENV: 'production', OIDC_SECOND_FACTOR: 'idp' }).emailLinkLogin).toBe(false);
  });

  it('refuses an http provider in production, and a sign-in with no way in', () => {
    expect(() => loadConfig({ ...base, NODE_ENV: 'production', ...sso, OIDC_ISSUER: 'http://idp.example.com' })).toThrow(/https/);
    expect(() => loadConfig({ ...base, EMAIL_LINK_LOGIN: 'false' })).toThrow(/no way to sign in/);
    expect(loadConfig({ ...base, EMAIL_LINK_LOGIN: 'false', ...sso }).emailLinkLogin).toBe(false);
    expect(loadConfig({ ...base, EMAIL_LINK_LOGIN: 'false', AUTH_DEV_LOGIN: 'true' }).emailLinkLogin).toBe(false);
    expect(loadConfig(base).emailLinkLogin).toBe(true);
  });
});
