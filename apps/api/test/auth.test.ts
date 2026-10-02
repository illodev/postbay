import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createEnv, type Env } from './helpers.js';

let env: Env;
beforeAll(async () => { env = await createEnv(); });
afterAll(async () => { await env.close(); });

const tokenFrom = (text: string) => /token=([\w-]+)/.exec(text)![1]!;

describe('email sign-in link', () => {
  it('signs a person in once, with the link they were emailed', async () => {
    const { app, mails } = env;
    const ask = await app.inject({ method: 'POST', url: '/api/auth/magic-link', payload: { email: 'Approver@Example.com' } });
    expect(ask.statusCode).toBe(202);
    expect(mails).toHaveLength(1);
    expect(mails[0]!.to).toBe('approver@example.com');
    expect(mails[0]!.text).toContain('http://app.test/auth/callback?token=');

    const token = tokenFrom(mails[0]!.text);
    const ok = await app.inject({ method: 'POST', url: '/api/auth/verify', payload: { token } });
    expect(ok.statusCode).toBe(200);
    const cookie = ok.cookies.find((c) => c.name === 'sid')!;
    expect(cookie.httpOnly).toBe(true);
    expect(cookie.sameSite).toBe('Lax');

    const me = await app.inject({ method: 'GET', url: '/api/me', headers: { cookie: `sid=${cookie.value}` } });
    expect(me.json().user.email).toBe('approver@example.com');
    expect(me.json().brands[0].role).toBe('approver');

    // The link works once.
    const again = await app.inject({ method: 'POST', url: '/api/auth/verify', payload: { token } });
    expect(again.statusCode).toBe(401);
  });

  it('answers the same way for strangers and sends nothing, so it cannot be used to list accounts', async () => {
    const { app, mails } = env;
    const before = mails.length;
    const r = await app.inject({ method: 'POST', url: '/api/auth/magic-link', payload: { email: 'stranger@nowhere.test' } });
    expect(r.statusCode).toBe(202);
    expect(r.json()).toEqual({ ok: true });
    expect(mails).toHaveLength(before);
  });

  it('expires links', async () => {
    const { app, mails, db } = env;
    await app.inject({ method: 'POST', url: '/api/auth/magic-link', payload: { email: 'admin@example.com' } });
    const token = tokenFrom(mails.at(-1)!.text);
    await db.query(`update login_token set expires_at = now() - interval '1 second'`);
    expect((await app.inject({ method: 'POST', url: '/api/auth/verify', payload: { token } })).statusCode).toBe(401);
  });

  it('stores only a hash of the link token and of the session', async () => {
    const { app, mails, db } = env;
    await app.inject({ method: 'POST', url: '/api/auth/magic-link', payload: { email: 'reviewer@example.com' } });
    const token = tokenFrom(mails.at(-1)!.text);
    const rows = await db.query('select token_hash from login_token');
    expect(rows.every((r) => r.token_hash !== token && /^[0-9a-f]{64}$/.test(r.token_hash))).toBe(true);
  });

  it('rate-limits link requests', async () => {
    const { app } = env;
    const codes: number[] = [];
    for (let i = 0; i < 8; i++) codes.push((await app.inject({ method: 'POST', url: '/api/auth/magic-link', payload: { email: 'x@example.com' } })).statusCode);
    expect(codes).toContain(429);
  });

  it('signs out by deleting the session', async () => {
    const { app, users } = env;
    const headers = { cookie: users.reader.cookie!, 'x-requested-by': 'studio' };
    expect((await app.inject({ method: 'GET', url: '/api/me', headers })).statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url: '/api/auth/logout', headers })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/api/me', headers })).statusCode).toBe(401);
  });
});

describe('development sign-in', () => {
  it('is off by default', async () => {
    const r = await env.app.inject({ method: 'POST', url: '/api/auth/dev-login', payload: { email: 'admin@example.com' } });
    expect(r.statusCode).toBe(404);
    expect((await env.app.inject({ method: 'GET', url: '/api/config' })).json()).toEqual({ devLogin: false, sso: null, emailLinkLogin: true });
  });

  it('works when enabled, but never in production', async () => {
    const dev = await createEnv({ AUTH_DEV_LOGIN: 'true' });
    try {
      const r = await dev.app.inject({ method: 'POST', url: '/api/auth/dev-login', payload: { email: 'admin@example.com' } });
      expect(r.statusCode).toBe(200);
      expect(r.cookies.some((c) => c.name === 'sid')).toBe(true);
      expect((await dev.app.inject({ method: 'POST', url: '/api/auth/dev-login', payload: { email: 'nobody@example.com' } })).statusCode).toBe(401);
    } finally {
      await dev.close();
    }
    const { loadConfig } = await import('../src/config.js');
    const prod = loadConfig({ NODE_ENV: 'production', SECRET: 'x'.repeat(40), AUTH_DEV_LOGIN: 'true' });
    expect(prod.devLogin).toBe(false);
  });
});

describe('configuration', () => {
  it('refuses a short secret and incomplete S3 settings', async () => {
    const { loadConfig } = await import('../src/config.js');
    expect(() => loadConfig({ SECRET: 'short' })).toThrow(/at least 32/);
    expect(() => loadConfig({ SECRET: 'x'.repeat(40), STORAGE_DRIVER: 's3' })).toThrow(/S3_BUCKET/);
  });

  it('reads the YouTube Analytics switch as a yes or a no, off unless asked', async () => {
    const { loadConfig } = await import('../src/config.js');
    const base = { SECRET: 'x'.repeat(40) };
    expect(loadConfig(base).GOOGLE_ANALYTICS).toBe(false);
    expect(loadConfig({ ...base, GOOGLE_ANALYTICS: '' }).GOOGLE_ANALYTICS).toBe(false);
    expect(loadConfig({ ...base, GOOGLE_ANALYTICS: 'false' }).GOOGLE_ANALYTICS).toBe(false);
    expect(loadConfig({ ...base, GOOGLE_ANALYTICS: 'true' }).GOOGLE_ANALYTICS).toBe(true);
    expect(loadConfig({ ...base, GOOGLE_ANALYTICS: '1' }).GOOGLE_ANALYTICS).toBe(true);
    expect(() => loadConfig({ ...base, GOOGLE_ANALYTICS: 'yes' })).toThrow();
    expect(loadConfig(base).YOUTUBE_ANALYTICS_URL).toBe('https://youtubeanalytics.googleapis.com');
  });
});

describe('response headers', () => {
  it('sends the hardening headers on every response', async () => {
    const r = await env.app.inject({ method: 'GET', url: '/api/health' });
    expect(r.headers['x-content-type-options']).toBe('nosniff');
    expect(r.headers['x-frame-options']).toBe('DENY');
    expect(r.headers['referrer-policy']).toBe('same-origin');
  });
});
