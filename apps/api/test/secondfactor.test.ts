import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { base32Decode, hotp, stepAt } from '../src/auth/totp.js';
import { loadConfig } from '../src/config.js';
import { startSession } from '../src/services/auth.js';
import { createEnv, type Env } from './helpers.js';

let env: Env;
beforeAll(async () => { env = await createEnv({ SECOND_FACTOR_REQUIRED: 'true' }); });
afterAll(async () => { await env.close(); });

// Every request comes from its own address, so the per-address rate limits do not count one test against another.
let ipCounter = 0;
const nextIp = () => `10.${(++ipCounter >> 8) & 255}.${ipCounter & 255}.7`;
interface Reply { status: number; body: any; headers: Record<string, unknown> }
async function req(cookie: string | null, method: string, url: string, body?: unknown, ip = nextIp()): Promise<Reply> {
  const headers: Record<string, string> = { 'x-forwarded-for': ip };
  if (cookie) { headers.cookie = cookie; headers['x-requested-by'] = 'studio'; }
  const res = await env.app.inject({ method: method as 'GET', url, headers, payload: body === undefined ? undefined : (body as object) });
  let parsed: any = null;
  try { parsed = res.body ? JSON.parse(res.body) : null; } catch { parsed = res.body; }
  return { status: res.statusCode, body: parsed, headers: res.headers };
}

/** A browser session as it is right after the first step of signing in (a link or single sign-on): the second step not done yet. */
async function firstStep(email: string): Promise<string> {
  const u = (await env.db.one<{ id: string }>('select id from app_user where lower(email) = $1', [email]))!;
  const s = await startSession(env.ctx, u.id, 'link');
  return `sid=${s.token}`;
}
const userId = async (email: string) => (await env.db.one<{ id: string }>('select id from app_user where lower(email) = $1', [email]))!.id;
const codeFor = (secret: string, steps = 0) => hotp(base32Decode(secret), stepAt(new Date()) + steps);
/** Codes work once; tests that sign in many times start each time as if no code had been used. */
const forgetUsedCodes = (id: string) => env.db.query('update user_totp set last_step = 0, failures = 0, locked_until = null where user_id = $1', [id]);

/** Signs in, sets an authenticator up and gives its first code: what an admin does on their first day. Returns what a later sign-in needs. */
async function enrol(email: string) {
  const cookie = await firstStep(email);
  const start = await req(cookie, 'POST', '/api/auth/2fa/enroll');
  expect(start.status, JSON.stringify(start.body)).toBe(200);
  const confirm = await req(cookie, 'POST', '/api/auth/2fa/enroll/confirm', { code: codeFor(start.body.secret) });
  expect(confirm.status, JSON.stringify(confirm.body)).toBe(200);
  return { cookie, secret: start.body.secret as string, recoveryCodes: confirm.body.recoveryCodes as string[] };
}

beforeEach(async () => {
  await env.db.query('delete from user_totp');
  await env.db.query('delete from recovery_code');
  (env.ctx.config as { secondFactorRequired: boolean }).secondFactorRequired = true;
  (env.ctx.config as { emailLinkLogin: boolean }).emailLinkLogin = true;
});

describe('who is asked for a second factor', () => {
  it('admins and approvers, on their first sign-in: they can do nothing until they set an authenticator up', async () => {
    for (const email of ['admin@example.com', 'approver@example.com']) {
      const cookie = await firstStep(email);
      const me = await req(cookie, 'GET', '/api/me');
      expect(me.status).toBe(401);
      expect(me.body.error).toMatchObject({ code: 'second_factor_required', details: { step: 'enroll' } });
      expect((await req(cookie, 'GET', `/api/brands/${env.brandId}`)).status).toBe(401);
      expect((await req(cookie, 'GET', '/api/auth/state')).body).toEqual({ signedIn: true, secondFactor: 'enroll' });
    }
  });

  it('nobody else, unless they chose to', async () => {
    for (const email of ['reviewer@example.com', 'producer@example.com', 'reader@example.com']) {
      const cookie = await firstStep(email);
      expect((await req(cookie, 'GET', '/api/me')).status).toBe(200);
      expect((await req(cookie, 'GET', '/api/auth/state')).body).toEqual({ signedIn: true, secondFactor: 'none' });
    }
  });

  it('is off where the deployment does not require it (and nobody has enrolled)', async () => {
    (env.ctx.config as { secondFactorRequired: boolean }).secondFactorRequired = false;
    expect((await req(await firstStep('admin@example.com'), 'GET', '/api/me')).status).toBe(200);
  });

  it('is decided on every request: someone made an approver this morning is asked at their next click', async () => {
    const cookie = await firstStep('reviewer@example.com');
    expect((await req(cookie, 'GET', '/api/me')).status).toBe(200);
    await env.db.query(`update member set role = 'approver' where user_id = $1`, [await userId('reviewer@example.com')]);
    const after = await req(cookie, 'GET', '/api/me');
    expect(after.status).toBe(401);
    expect(after.body.error.code).toBe('second_factor_required');
    await env.db.query(`update member set role = 'reviewer' where user_id = $1`, [await userId('reviewer@example.com')]);
  });

  it('never applies to a producer token, which is not a person', async () => {
    const { cookie } = await enrol('admin@example.com');
    const t = await req(cookie, 'POST', `/api/brands/${env.brandId}/tokens`, { name: 'agent', expiresInDays: 30 });
    expect([200, 201], JSON.stringify(t.body)).toContain(t.status);
    const bearer = t.body.token as string;
    const r = await env.app.inject({ method: 'GET', url: '/api/token', headers: { authorization: `Bearer ${bearer}`, 'x-forwarded-for': nextIp() } });
    expect(r.statusCode).toBe(200);
  });
});

describe('setting an authenticator up', () => {
  it('shows the secret and an otpauth address once, and counts only after a right code', async () => {
    const cookie = await firstStep('admin@example.com');
    const start = await req(cookie, 'POST', '/api/auth/2fa/enroll');
    expect(start.status).toBe(200);
    expect(start.body.secret).toMatch(/^[A-Z2-7]{32}$/);
    expect(start.body.otpauthUrl).toContain(`secret=${start.body.secret}`);
    expect(start.body.otpauthUrl).toContain('admin%40example.com');
    // Not enrolled yet: still asked to enrol, not to verify.
    expect((await req(cookie, 'GET', '/api/auth/state')).body.secondFactor).toBe('enroll');

    const wrong = await req(cookie, 'POST', '/api/auth/2fa/enroll/confirm', { code: '000000' });
    expect(wrong.status).toBe(401);
    expect((await req(cookie, 'GET', '/api/me')).status).toBe(401);

    const ok = await req(cookie, 'POST', '/api/auth/2fa/enroll/confirm', { code: codeFor(start.body.secret) });
    expect(ok.status).toBe(200);
    expect(ok.body.recoveryCodes).toHaveLength(10);
    expect(new Set(ok.body.recoveryCodes).size).toBe(10);
    for (const c of ok.body.recoveryCodes) expect(c).toMatch(/^[A-Z2-7]{5}-[A-Z2-7]{5}$/);
    expect((await req(cookie, 'GET', '/api/me')).status).toBe(200); // proving the authenticator is the second step for this session
  });

  it('keeps the secret sealed, shows it to nobody afterwards, and keeps only the hashes of the recovery codes', async () => {
    const { secret, recoveryCodes, cookie } = await enrol('admin@example.com');
    const row = (await env.db.one<{ secret_sealed: Buffer }>('select secret_sealed from user_totp where user_id = $1', [await userId('admin@example.com')]))!;
    expect(row.secret_sealed.toString('latin1')).not.toContain(secret);
    expect(row.secret_sealed.toString('hex')).not.toContain(Buffer.from(secret).toString('hex'));
    const stored = (await env.db.query<{ code_hash: string }>('select code_hash from recovery_code')).map((r) => r.code_hash).join(' ');
    for (const c of recoveryCodes) expect(stored).not.toContain(c.replace('-', ''));
    // What the API says about it afterwards has no secret and no code.
    const status = await req(cookie, 'GET', '/api/auth/2fa');
    expect(status.body).toEqual({ enrolled: true, required: true, requiredByRole: true, recoveryCodesLeft: 10 });
    expect(JSON.stringify([status.body, (await req(cookie, 'GET', '/api/me')).body])).not.toContain(secret);
    // And the setup cannot be started again over a working one.
    expect((await req(cookie, 'POST', '/api/auth/2fa/enroll')).status).toBe(409);
  });

  it('opens with the person\'s own session or not at all', async () => {
    expect((await req(null, 'POST', '/api/auth/2fa/enroll')).status).toBe(401);
    expect((await req(null, 'POST', '/api/auth/2fa/verify', { code: '123456' })).status).toBe(401);
    // And a write from a browser session needs the header that only our own pages add.
    const cookie = await firstStep('admin@example.com');
    const res = await env.app.inject({ method: 'POST', url: '/api/auth/2fa/enroll', headers: { cookie, 'x-forwarded-for': nextIp() } });
    expect(res.statusCode).toBe(403);
  });
});

describe('giving the second factor at a later sign-in', () => {
  it('asks for the code, refuses a wrong one, and lets the right one through', async () => {
    const { secret } = await enrol('admin@example.com');
    const id = await userId('admin@example.com');
    await forgetUsedCodes(id);
    const cookie = await firstStep('admin@example.com');
    expect((await req(cookie, 'GET', '/api/auth/state')).body).toEqual({ signedIn: true, secondFactor: 'verify' });
    expect((await req(cookie, 'GET', '/api/me')).body.error.details).toEqual({ step: 'verify' });

    expect((await req(cookie, 'POST', '/api/auth/2fa/verify', { code: '123456' })).status).toBe(401);
    expect((await req(cookie, 'GET', '/api/me')).status).toBe(401);
    const ok = await req(cookie, 'POST', '/api/auth/2fa/verify', { code: codeFor(secret) });
    expect(ok.status).toBe(200);
    expect((await req(cookie, 'GET', '/api/me')).status).toBe(200);
    // Once a session has done it, it is not asked again; and a code is not asked of a session that is already through.
    expect((await req(cookie, 'POST', '/api/auth/2fa/verify', { code: codeFor(secret) })).status).toBe(409);
  });

  it('accepts a code once: the same one is refused in another session, even inside its half-minute', async () => {
    const { secret } = await enrol('admin@example.com');
    const id = await userId('admin@example.com');
    await forgetUsedCodes(id);
    const first = await firstStep('admin@example.com');
    const code = codeFor(secret);
    expect((await req(first, 'POST', '/api/auth/2fa/verify', { code })).status).toBe(200);
    const second = await firstStep('admin@example.com');
    const replay = await req(second, 'POST', '/api/auth/2fa/verify', { code });
    expect(replay.status).toBe(401);
    expect((await req(second, 'GET', '/api/me')).status).toBe(401);
    // The code for the next step (a phone whose clock runs ahead) is fine.
    expect((await req(second, 'POST', '/api/auth/2fa/verify', { code: codeFor(secret, 1) })).status).toBe(200);
  });

  it('does not let two requests spend one code at once', async () => {
    const { secret } = await enrol('admin@example.com');
    const id = await userId('admin@example.com');
    await forgetUsedCodes(id);
    const sessions = await Promise.all([firstStep('admin@example.com'), firstStep('admin@example.com'), firstStep('admin@example.com')]);
    const code = codeFor(secret);
    const results = await Promise.all(sessions.map((c) => req(c, 'POST', '/api/auth/2fa/verify', { code })));
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
  });

  it('holds when many checks of one code race inside the server: the database lets exactly one through', async () => {
    const { secret } = await enrol('admin@example.com');
    const id = await userId('admin@example.com');
    const { verifySecondFactor } = await import('../src/services/secondfactor.js');
    for (let round = 0; round < 3; round++) {
      await forgetUsedCodes(id);
      const code = codeFor(secret);
      const results = await Promise.allSettled(Array.from({ length: 12 }, () => verifySecondFactor(env.ctx, id, code)));
      expect(results.filter((r) => r.status === 'fulfilled'), `round ${round}`).toHaveLength(1);
    }
  });

  it('takes a recovery code in place of the app, once, and says how many are left', async () => {
    const { recoveryCodes } = await enrol('admin@example.com');
    const cookie = await firstStep('admin@example.com');
    const ok = await req(cookie, 'POST', '/api/auth/2fa/verify', { code: recoveryCodes[0]!.toLowerCase().replace('-', ' ') });
    expect(ok.status).toBe(200);
    expect((await req(cookie, 'GET', '/api/auth/2fa')).body.recoveryCodesLeft).toBe(9);
    const again = await req(await firstStep('admin@example.com'), 'POST', '/api/auth/2fa/verify', { code: recoveryCodes[0] });
    expect(again.status).toBe(401);
    const audit = await env.db.one(`select after from audit_event where action = 'auth.recovery_code_used' order by id desc limit 1`);
    expect(audit!.after).toEqual({ left: 9 });
  });

  it('waits for ever so long after too many wrong codes, whatever kind it tries next, and then lets the right one in', async () => {
    const { secret, recoveryCodes } = await enrol('approver@example.com');
    const id = await userId('approver@example.com');
    await forgetUsedCodes(id);
    const cookie = await firstStep('approver@example.com');
    for (let i = 0; i < 5; i++) expect((await req(cookie, 'POST', '/api/auth/2fa/verify', { code: '000000' })).status).toBe(401);
    const locked = await req(cookie, 'POST', '/api/auth/2fa/verify', { code: codeFor(secret) });
    expect(locked.status).toBe(429);
    expect(locked.body.error.code).toBe('second_factor_locked');
    expect(locked.body.error.message).toMatch(/Try again in \d+ minutes?/);
    expect((await req(cookie, 'POST', '/api/auth/2fa/verify', { code: recoveryCodes[1] })).status).toBe(429); // a recovery code does not get round it
    await env.db.query(`update user_totp set locked_until = now() - interval '1 minute' where user_id = $1`, [id]);
    expect((await req(cookie, 'POST', '/api/auth/2fa/verify', { code: codeFor(secret) })).status).toBe(200);
  });

  it('counts failures across sessions, so a second browser does not get five more tries', async () => {
    await enrol('approver@example.com');
    const id = await userId('approver@example.com');
    await forgetUsedCodes(id);
    for (let i = 0; i < 5; i++) await req(await firstStep('approver@example.com'), 'POST', '/api/auth/2fa/verify', { code: '111111' });
    const locked = await req(await firstStep('approver@example.com'), 'POST', '/api/auth/2fa/verify', { code: '222222' });
    expect(locked.status).toBe(429);
  });

  it('limits how fast one address can try, apart from the lockout', async () => {
    await enrol('admin@example.com');
    const cookie = await firstStep('admin@example.com');
    const statuses: number[] = [];
    for (let i = 0; i < 12; i++) statuses.push((await req(cookie, 'POST', '/api/auth/2fa/verify', { code: '123456' }, '203.0.113.9')).status);
    expect(statuses).toContain(429);
    expect(statuses.slice(0, 3)).toEqual([401, 401, 401]);
  });
});

describe('managing it', () => {
  it('lets someone whose role does not require it set one up, be asked for it from then on, and remove it with a code', async () => {
    const cookie = await firstStep('reviewer@example.com');
    const start = await req(cookie, 'POST', '/api/auth/2fa/enroll');
    expect((await req(cookie, 'POST', '/api/auth/2fa/enroll/confirm', { code: codeFor(start.body.secret) })).status).toBe(200);
    const id = await userId('reviewer@example.com');
    expect((await req(cookie, 'GET', '/api/auth/2fa')).body).toMatchObject({ enrolled: true, required: true, requiredByRole: false });

    await forgetUsedCodes(id);
    const later = await firstStep('reviewer@example.com');
    expect((await req(later, 'GET', '/api/me')).body.error.details.step).toBe('verify'); // asked, though a reviewer
    expect((await req(cookie, 'POST', '/api/auth/2fa/disable', { code: '000000' })).status).toBe(401);
    expect((await req(cookie, 'POST', '/api/auth/2fa/disable', { code: codeFor(start.body.secret, 1) })).status).toBe(200);
    expect(await env.db.one('select 1 from user_totp where user_id = $1', [id])).toBeNull();
    expect(await env.db.one('select 1 from recovery_code where user_id = $1', [id])).toBeNull();
    expect((await req(await firstStep('reviewer@example.com'), 'GET', '/api/me')).status).toBe(200); // no longer asked
  });

  it('does not let anyone whose role requires one remove it', async () => {
    const { secret, cookie } = await enrol('admin@example.com');
    const r = await req(cookie, 'POST', '/api/auth/2fa/disable', { code: codeFor(secret, 1) });
    expect(r.status).toBe(403);
    expect(r.body.error.message).toMatch(/role requires a second factor/);
    expect(await env.db.one('select 1 from user_totp where user_id = $1', [await userId('admin@example.com')])).not.toBeNull();
  });

  it('makes new recovery codes with a code from the app, and the old ones stop working', async () => {
    const { secret, cookie, recoveryCodes } = await enrol('admin@example.com');
    const id = await userId('admin@example.com');
    expect((await req(cookie, 'POST', '/api/auth/2fa/recovery-codes', { code: recoveryCodes[0] })).status).toBe(401); // not with a recovery code
    await forgetUsedCodes(id);
    const fresh = await req(cookie, 'POST', '/api/auth/2fa/recovery-codes', { code: codeFor(secret) });
    expect(fresh.status).toBe(200);
    expect(fresh.body.recoveryCodes).toHaveLength(10);
    expect(fresh.body.recoveryCodes.some((c: string) => recoveryCodes.includes(c))).toBe(false);
    expect((await req(await firstStep('admin@example.com'), 'POST', '/api/auth/2fa/verify', { code: recoveryCodes[2] })).status).toBe(401);
    expect((await req(await firstStep('admin@example.com'), 'POST', '/api/auth/2fa/verify', { code: fresh.body.recoveryCodes[2] })).status).toBe(200);
  });

  it('lets an admin reset a member who lost their phone: they enrol again, and sessions they had are asked again', async () => {
    const mine = await enrol('approver@example.com');
    const id = await userId('approver@example.com');
    expect((await req(mine.cookie, 'GET', '/api/me')).status).toBe(200);
    const member = (await env.db.one<{ id: string }>('select id from member where user_id = $1 and brand_id = $2', [id, env.brandId]))!;
    const adminCookie = (await enrol('admin@example.com')).cookie;

    for (const who of ['reviewer@example.com', 'producer@example.com']) {
      const c = await firstStep(who);
      expect((await req(c, 'POST', `/api/brands/${env.brandId}/members/${member.id}/reset-2fa`)).status).toBe(403);
    }
    expect((await req(mine.cookie, 'POST', `/api/brands/${env.brandId}/members/${member.id}/reset-2fa`)).status).toBe(403); // an approver cannot either
    const done = await req(adminCookie, 'POST', `/api/brands/${env.brandId}/members/${member.id}/reset-2fa`);
    expect(done.status).toBe(200);
    expect(await env.db.one('select 1 from user_totp where user_id = $1', [id])).toBeNull();
    // The session they had is not trusted for the second step any more, and must enrol anew.
    const after = await req(mine.cookie, 'GET', '/api/me');
    expect(after.status).toBe(401);
    expect(after.body.error.details.step).toBe('enroll');
    const ev = await env.db.one(`select after, entity_id from audit_event where action = 'user.second_factor_reset' order by id desc limit 1`);
    expect(ev!.entity_id).toBe(id);
    expect(JSON.stringify(ev!.after)).not.toContain(mine.secret);
  });

  it('does not reset a member of another brand', async () => {
    const other = (await env.db.one<{ id: string }>(`insert into brand (workspace_id, name, timezone) values ($1,'Elsewhere','Europe/Madrid') returning id`, [env.workspaceId]))!;
    const stranger = (await env.db.one<{ id: string }>(`insert into app_user (email) values ('stranger@example.com') returning id`))!;
    const m = (await env.db.one<{ id: string }>(`insert into member (user_id, brand_id, role) values ($1,$2,'reviewer') returning id`, [stranger.id, other.id]))!;
    const adminCookie = (await enrol('admin@example.com')).cookie;
    expect((await req(adminCookie, 'POST', `/api/brands/${env.brandId}/members/${m.id}/reset-2fa`)).status).toBe(404);
  });

  it('can be reset from the command line, for the admin who lost both', async () => {
    const { cookie } = await enrol('admin@example.com');
    const { resetByEmail } = await import('../src/services/secondfactor.js');
    expect(await resetByEmail(env.ctx, 'Admin@Example.com')).toBe(true);
    expect(await resetByEmail(env.ctx, 'nobody@example.com')).toBe(false);
    expect((await req(cookie, 'GET', '/api/me')).body.error.details.step).toBe('enroll');
  });
});

describe('the sign-in itself', () => {
  it('goes through the emailed link and then the code, end to end', async () => {
    const { secret } = await enrol('admin@example.com');
    await forgetUsedCodes(await userId('admin@example.com'));
    env.mails.length = 0;
    expect((await req(null, 'POST', '/api/auth/magic-link', { email: 'admin@example.com' })).status).toBe(202);
    const token = /token=([\w-]+)/.exec(env.mails.at(-1)!.text)![1]!;
    const verified = await env.app.inject({ method: 'POST', url: '/api/auth/verify', payload: { token }, headers: { 'x-forwarded-for': nextIp() } });
    expect(verified.statusCode).toBe(200);
    const cookie = /sid=[^;]+/.exec([verified.headers['set-cookie']].flat().join(';'))![0];
    expect((await req(cookie, 'GET', '/api/me')).status).toBe(401);
    expect((await req(cookie, 'POST', '/api/auth/2fa/verify', { code: codeFor(secret) })).status).toBe(200);
    expect((await req(cookie, 'GET', '/api/me')).body.user.email).toBe('admin@example.com');
  });

  it('can be switched off for everyone who signs in with single sign-on: no link is sent, and an old one does nothing', async () => {
    env.mails.length = 0;
    await req(null, 'POST', '/api/auth/magic-link', { email: 'reader@example.com' });
    const token = /token=([\w-]+)/.exec(env.mails.at(-1)!.text)![1]!;
    (env.ctx.config as { emailLinkLogin: boolean }).emailLinkLogin = false;
    env.mails.length = 0;
    expect((await req(null, 'POST', '/api/auth/magic-link', { email: 'reader@example.com' })).status).toBe(202); // answers the same
    expect(env.mails).toHaveLength(0);
    const v = await env.app.inject({ method: 'POST', url: '/api/auth/verify', payload: { token }, headers: { 'x-forwarded-for': nextIp() } });
    expect(v.statusCode).toBe(401);
  });

  it('can sign out while the second step is owed', async () => {
    await enrol('admin@example.com');
    const cookie = await firstStep('admin@example.com');
    expect((await req(cookie, 'POST', '/api/auth/logout')).status).toBe(200);
    expect((await req(cookie, 'GET', '/api/auth/state')).body.signedIn).toBe(false);
  });
});

describe('what the deployment has to say about it', () => {
  const base = { NODE_ENV: 'test', SECRET: 'x'.repeat(40) };
  it('requires the second factor in production unless told otherwise, and not in development', () => {
    expect(loadConfig({ ...base, NODE_ENV: 'production' }).secondFactorRequired).toBe(true);
    expect(loadConfig({ ...base, NODE_ENV: 'production', SECOND_FACTOR_REQUIRED: 'false' }).secondFactorRequired).toBe(false);
    expect(loadConfig({ ...base, NODE_ENV: 'development' }).secondFactorRequired).toBe(false);
    expect(loadConfig({ ...base, NODE_ENV: 'development', SECOND_FACTOR_REQUIRED: 'true' }).secondFactorRequired).toBe(true);
    expect(loadConfig({ ...base, SECOND_FACTOR_REQUIRED: '' }).secondFactorRequired).toBe(false);
  });
});
