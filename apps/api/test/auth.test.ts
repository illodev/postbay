import { Writable } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp, redactUrl } from '../src/app.js';
import { createMailer } from '../src/mailer.js';
import { magicLinksSettled } from '../src/services/auth.js';
import { createEnv, fakeMedia, type Env } from './helpers.js';

let env: Env;
beforeAll(async () => { env = await createEnv(); });
afterAll(async () => { await env.close(); });

const tokenFrom = (text: string) => /token=([\w-]+)/.exec(text)![1]!;

describe('email sign-in link', () => {
  it('signs a person in once, with the link they were emailed', async () => {
    const { app, mails } = env;
    const ask = await app.inject({ method: 'POST', url: '/api/auth/magic-link', payload: { email: 'Approver@Example.com' } });
    expect(ask.statusCode).toBe(202);
    await magicLinksSettled(env.ctx); // the link is sent after the answer
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
    await magicLinksSettled(env.ctx);
    expect(mails).toHaveLength(before);
  });

  it('expires links', async () => {
    const { app, mails, db } = env;
    await app.inject({ method: 'POST', url: '/api/auth/magic-link', payload: { email: 'admin@example.com' } });
    await magicLinksSettled(env.ctx);
    const token = tokenFrom(mails.at(-1)!.text);
    await db.query(`update login_token set expires_at = now() - interval '1 second'`);
    expect((await app.inject({ method: 'POST', url: '/api/auth/verify', payload: { token } })).statusCode).toBe(401);
  });

  it('stores only a hash of the link token and of the session', async () => {
    const { app, mails, db } = env;
    await app.inject({ method: 'POST', url: '/api/auth/magic-link', payload: { email: 'reviewer@example.com' } });
    await magicLinksSettled(env.ctx);
    const token = tokenFrom(mails.at(-1)!.text);
    const rows = await db.query('select token_hash from login_token');
    expect(rows.every((r) => r.token_hash !== token && /^[0-9a-f]{64}$/.test(r.token_hash))).toBe(true);
  });

  it('answers at once and the same way when the mail server is slow or refuses, so timing and errors say nothing about who exists', async () => {
    const { app } = env;
    const original = env.ctx.mailer;
    const ask = (email: string, ip: string) => app.inject({ method: 'POST', url: '/api/auth/magic-link', payload: { email }, headers: { 'x-forwarded-for': ip } });
    const within = <T>(p: Promise<T>, ms: number) => Promise.race([p, new Promise<'too slow'>((r) => setTimeout(() => r('too slow'), ms))]);
    try {
      // A mail server that takes its time: the person who exists gets the same answer, as soon, as the one who does not.
      let release!: () => void;
      const held = new Promise<void>((r) => { release = r; });
      env.ctx.mailer = { async send() { await held; } };
      const slow = await within(ask('admin@example.com', '10.77.0.1'), 2000);
      expect(slow === 'too slow' ? slow : slow.statusCode).toBe(202);
      release();
      // One that refuses: still 202 with the same body, and the failure goes to the server's log, not to the asker.
      env.ctx.mailer = { async send() { throw new Error('554 relay refused'); } };
      const refused = await ask('admin@example.com', '10.77.0.2');
      expect(refused.statusCode).toBe(202);
      expect(refused.json()).toEqual((await ask('stranger@nowhere.test', '10.77.0.3')).json());
      await magicLinksSettled(env.ctx);
    } finally {
      env.ctx.mailer = original;
    }
  });

  it('never writes a link to the log in production: it wants a mail server, and without one logs no text', async () => {
    const { loadConfig } = await import('../src/config.js');
    const prod = { NODE_ENV: 'production', SECRET: 'x'.repeat(40) };
    expect(() => loadConfig(prod)).toThrow(/SMTP_URL/);
    expect(loadConfig({ ...prod, SMTP_URL: 'smtp://mail.example.com:587' }).emailLinkLogin).toBe(true);
    // Single sign-on only: no link is sent, so no mail server is needed for signing in.
    const sso = { OIDC_ISSUER: 'https://idp.example.com', OIDC_CLIENT_ID: 'id', OIDC_CLIENT_SECRET: 'secret', OIDC_ALLOWED_DOMAINS: 'example.com' };
    const ssoOnly = loadConfig({ ...prod, ...sso, EMAIL_LINK_LOGIN: 'false' });
    const logged: object[] = [];
    const log = { info: (o: object) => logged.push(o), warn: (o: object) => logged.push(o) };
    await createMailer(ssoOnly, log).send('a@example.com', 'Your sign-in link', 'http://app.test/auth/callback?token=SECRET-LINK');
    expect(JSON.stringify(logged)).not.toContain('SECRET-LINK');
    expect(JSON.stringify(logged)).toContain('a@example.com');
    // Development keeps the link in the log, where it is the way to sign in without a mail server.
    logged.length = 0;
    await createMailer(loadConfig({ SECRET: 'x'.repeat(40) }), log).send('a@example.com', 'Your sign-in link', 'SECRET-LINK');
    expect(JSON.stringify(logged)).toContain('SECRET-LINK');
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
    const prod = loadConfig({ NODE_ENV: 'production', SECRET: 'x'.repeat(40), SMTP_URL: 'smtp://mail.example.com', AUTH_DEV_LOGIN: 'true' });
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

  it('reads the staging cap and the Meta login configurations from the configuration, checked, with an empty value meaning unset', async () => {
    const { loadConfig } = await import('../src/config.js');
    const { createConnectorSet } = await import('../src/connectors/registry.js');
    const base = { SECRET: 'x'.repeat(40) };
    expect(loadConfig(base).STAGING_MAX_GB_PER_BRAND).toBe(20);
    expect(loadConfig({ ...base, STAGING_MAX_GB_PER_BRAND: '' }).STAGING_MAX_GB_PER_BRAND).toBe(20);
    expect(loadConfig({ ...base, STAGING_MAX_GB_PER_BRAND: '2.5' }).STAGING_MAX_GB_PER_BRAND).toBe(2.5);
    expect(() => loadConfig({ ...base, STAGING_MAX_GB_PER_BRAND: 'lots' })).toThrow(/STAGING_MAX_GB_PER_BRAND/);
    expect(() => loadConfig({ ...base, STAGING_MAX_GB_PER_BRAND: '0' })).toThrow(/STAGING_MAX_GB_PER_BRAND/);

    // The ids reach the sign-in dialog from the configuration that was loaded, not from whatever the process environment holds.
    const meta = { ...base, TOKEN_KEY: Buffer.alloc(32, 1).toString('base64'), META_APP_ID: 'app', META_APP_SECRET: 'secret' };
    const before = process.env.META_LOGIN_CONFIG_ID;
    process.env.META_LOGIN_CONFIG_ID = 'from-the-process';
    try {
      const configured = createConnectorSet(loadConfig({ ...meta, META_LOGIN_CONFIG_ID: 'cfg-1', META_LOGIN_CONFIG_ID_PRIZES: 'cfg-2' })).provider('meta')!;
      expect(new URL(configured.authorizeUrl!('st', 'http://app.test/cb')).searchParams.get('config_id')).toBe('cfg-1');
      expect(new URL(configured.authorizeUrl!('st', 'http://app.test/cb', { prizes: true })).searchParams.get('config_id')).toBe('cfg-2');
      const unset = createConnectorSet(loadConfig({ ...meta, META_LOGIN_CONFIG_ID: '' })).provider('meta')!;
      expect(new URL(unset.authorizeUrl!('st', 'http://app.test/cb')).searchParams.get('config_id')).toBeNull();
    } finally {
      if (before === undefined) delete process.env.META_LOGIN_CONFIG_ID;
      else process.env.META_LOGIN_CONFIG_ID = before;
    }
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

describe('the request log', () => {
  it('keeps no secret that travels in a URL: sign-in links, OAuth and sign-on codes, prize links, signed media', async () => {
    const lines: string[] = [];
    const stream = new Writable({ write(chunk, _enc, done) { lines.push(String(chunk)); done(); } });
    const { app } = await buildApp({ config: env.ctx.config, db: env.db, media: fakeMedia, mailer: { async send() {} }, logStream: stream });
    await app.ready();
    const secret = 'S3cretValue0123456789abcdefXYZ';
    const urls = [
      `/auth/callback?token=${secret}`, `/api/auth/sso/callback?code=${secret}&state=${secret}`, `/api/oauth/callback?code=${secret}&state=${secret}`,
      `/api/public/prizes/${secret}`, `/api/public/prizes/${secret}/download`, `/prize/${secret}`, `/api/public/data-deletion/${secret}`,
      `/api/meta/webhook?hub.mode=subscribe&hub.verify_token=${secret}&hub.challenge=1`, `/media/a/b.mp4?exp=1&sig=${secret}`, `/nowhere?${secret}`,
    ];
    for (const url of urls) await app.inject({ method: url.includes('/download') ? 'POST' : 'GET', url });
    await app.close();
    const log = lines.join('');
    expect(log).toContain('"url":"/api/public/prizes/[redacted]"'); // the requests themselves are still there
    expect(log).toContain('"url":"/auth/callback?token=[redacted]"');
    expect(log).not.toContain(secret);
  });

  it('keeps the names of the parameters and the shape of the path', () => {
    expect(redactUrl('/api/auth/sso/callback?code=abc&state=def')).toBe('/api/auth/sso/callback?code=[redacted]&state=[redacted]');
    expect(redactUrl('/api/public/prizes/abc/download')).toBe('/api/public/prizes/[redacted]/download');
    expect(redactUrl('/api/brands/1/calendar')).toBe('/api/brands/1/calendar');
    expect(redactUrl('/x?bareValue&a=1')).toBe('/x?[redacted]&a=[redacted]');
  });
});
