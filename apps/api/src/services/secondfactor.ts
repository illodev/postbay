import { createHash, hkdfSync } from 'node:crypto';
import { newRecoveryCode, looksLikeRecoveryCode, newSecret, normalizeRecoveryCode, otpauthUrl, verifyCode } from '../auth/totp.js';
import { authorize, type Principal } from '../auth/principal.js';
import type { Ctx } from '../context.js';
import { TokenVault } from '../crypto.js';
import { AppError, conflict, forbidden, notFound, unauthorized } from '../errors.js';
import { audit } from './audit.js';

/**
 * The second step of signing in: a code from an authenticator app, with one-time recovery codes for a lost phone.
 *
 * Who needs it is decided on every request, not when a session starts (see sessionState in auth.ts): an admin or approver, once
 * SECOND_FACTOR_REQUIRED is on, and anyone who has set an authenticator up. So a person made an approver this morning is asked at their
 * next click, and a session that began before is not trusted for it.
 *
 * The authenticator's secret is sealed with a key made from SECRET, so this works whether or not network tokens are enabled. Changing
 * SECRET makes the stored secrets unreadable: people use a recovery code, or an admin resets them.
 */
const MAX_FAILURES = 5;
const LOCK_MINUTES = 15;
const RECOVERY_CODES = 10;
const ISSUER = 'Content Studio';

const vault = (ctx: Ctx) => new TokenVault(Buffer.from(hkdfSync('sha256', ctx.config.SECRET, 'content-studio', 'totp-secret-v1', 32)));
const aad = (userId: string) => `totp:${userId}`;
const hashCode = (code: string) => createHash('sha256').update(normalizeRecoveryCode(code)).digest('hex');

interface TotpRow { user_id: string; secret_sealed: Buffer; confirmed_at: Date | null; last_step: string; failures: number; locked_until: Date | null }

/** Whether this person must give a code, and whether they have an authenticator yet. */
export async function requirement(ctx: Ctx, userId: string): Promise<{ required: boolean; enrolled: boolean; byRole: boolean }> {
  const r = await ctx.db.one<{ enrolled: boolean; privileged: boolean }>(
    `select exists(select 1 from user_totp where user_id = $1 and confirmed_at is not null) as enrolled,
            exists(select 1 from member where user_id = $1 and role in ('admin','approver')) as privileged`,
    [userId],
  );
  const byRole = ctx.config.secondFactorRequired && !!r?.privileged;
  return { required: !!r?.enrolled || byRole, enrolled: !!r?.enrolled, byRole };
}

export async function status(ctx: Ctx, userId: string) {
  const req = await requirement(ctx, userId);
  const left = await ctx.db.one<{ n: number }>('select count(*)::int as n from recovery_code where user_id = $1 and used_at is null', [userId]);
  return { enrolled: req.enrolled, required: req.required, requiredByRole: req.byRole, recoveryCodesLeft: left?.n ?? 0 };
}

/** Makes a secret for the person to put in their authenticator app. It counts only once a code from it has been confirmed. */
export async function startEnrollment(ctx: Ctx, userId: string, email: string) {
  const existing = await ctx.db.one<TotpRow>('select * from user_totp where user_id = $1', [userId]);
  if (existing?.confirmed_at) throw conflict('already_enrolled', 'An authenticator is already set up. Remove it first to set up another.');
  const secret = newSecret();
  await ctx.db.query(
    `insert into user_totp (user_id, secret_sealed) values ($1,$2)
     on conflict (user_id) do update set secret_sealed = excluded.secret_sealed, failures = 0, locked_until = null, last_step = 0, created_at = now()`,
    [userId, vault(ctx).seal(secret, aad(userId))],
  );
  return { secret, otpauthUrl: otpauthUrl(email, ISSUER, secret) };
}

/** A person who has failed too often waits, whichever kind of code they try next. */
function assertNotLocked(ctx: Ctx, row: TotpRow) {
  if (row.locked_until && new Date(row.locked_until) > ctx.now()) {
    const mins = Math.ceil((new Date(row.locked_until).getTime() - ctx.now().getTime()) / 60_000);
    throw new AppError(429, 'second_factor_locked', `Too many wrong codes. Try again in ${mins} minute${mins === 1 ? '' : 's'}.`, { retryAfterMinutes: mins });
  }
}

async function recordFailure(ctx: Ctx, userId: string) {
  await ctx.db.query(
    `update user_totp set
       locked_until = case when failures + 1 >= $2 then $3::timestamptz else locked_until end,
       failures = case when failures + 1 >= $2 then 0 else failures + 1 end
     where user_id = $1`,
    [userId, MAX_FAILURES, new Date(ctx.now().getTime() + LOCK_MINUTES * 60_000)],
  );
}

/** A code from the authenticator, accepted once. The step is claimed in the same statement that checks it, so two requests cannot both use it. */
async function acceptTotp(ctx: Ctx, row: TotpRow, code: string): Promise<boolean> {
  const secret = vault(ctx).open<string>(row.secret_sealed, aad(row.user_id));
  const step = verifyCode(secret, code, ctx.now(), Number(row.last_step));
  if (step === null) return false;
  const claimed = await ctx.db.one(
    'update user_totp set last_step = $2, failures = 0, locked_until = null where user_id = $1 and last_step < $2 returning user_id',
    [row.user_id, step],
  );
  return !!claimed;
}

function generateRecoveryCodes(): string[] {
  return Array.from({ length: RECOVERY_CODES }, newRecoveryCode);
}

async function replaceRecoveryCodes(ctx: Ctx, userId: string): Promise<string[]> {
  const codes = generateRecoveryCodes();
  await ctx.db.tx(async (db) => {
    await db.query('delete from recovery_code where user_id = $1', [userId]);
    for (const c of codes) await db.query('insert into recovery_code (user_id, code_hash) values ($1,$2)', [userId, hashCode(c)]);
  });
  return codes;
}

/** The first code from a new authenticator: proof that the person's app has the secret. Returns the recovery codes, once. */
export async function confirmEnrollment(ctx: Ctx, userId: string, code: string) {
  const row = await ctx.db.one<TotpRow>('select * from user_totp where user_id = $1', [userId]);
  if (!row) throw conflict('not_started', 'Start setting up the authenticator first.');
  if (row.confirmed_at) throw conflict('already_enrolled', 'The authenticator is already set up.');
  assertNotLocked(ctx, row);
  if (!(await acceptTotp(ctx, row, code.trim()))) {
    await recordFailure(ctx, userId);
    throw unauthorized('That code is not right. Check that the app shows the code for this account, and that your phone\'s clock is correct.');
  }
  await ctx.db.query('update user_totp set confirmed_at = $2 where user_id = $1', [userId, ctx.now()]);
  const recoveryCodes = await replaceRecoveryCodes(ctx, userId);
  await audit(ctx.db, null, null, 'auth.second_factor_enrolled', 'app_user', userId, null, { enrolled: true });
  return { recoveryCodes };
}

/** Checks a code from the authenticator or a recovery code. A recovery code is spent by it. */
export async function verifySecondFactor(ctx: Ctx, userId: string, rawCode: string): Promise<{ method: 'totp' | 'recovery'; recoveryCodesLeft: number }> {
  const row = await ctx.db.one<TotpRow>('select * from user_totp where user_id = $1 and confirmed_at is not null', [userId]);
  if (!row) throw conflict('not_enrolled', 'No authenticator is set up for this account.');
  assertNotLocked(ctx, row);
  const code = rawCode.trim();
  let method: 'totp' | 'recovery' | null = null;
  if (looksLikeRecoveryCode(code)) {
    const spent = await ctx.db.one('update recovery_code set used_at = $3 where user_id = $1 and code_hash = $2 and used_at is null returning id', [userId, hashCode(code), ctx.now()]);
    if (spent) method = 'recovery';
  } else if (await acceptTotp(ctx, row, code)) {
    method = 'totp';
  }
  if (!method) {
    await recordFailure(ctx, userId);
    throw unauthorized('That code is not right.');
  }
  await ctx.db.query('update user_totp set failures = 0, locked_until = null where user_id = $1', [userId]);
  const left = await ctx.db.one<{ n: number }>('select count(*)::int as n from recovery_code where user_id = $1 and used_at is null', [userId]);
  if (method === 'recovery') await audit(ctx.db, null, null, 'auth.recovery_code_used', 'app_user', userId, null, { left: left?.n ?? 0 });
  return { method, recoveryCodesLeft: left?.n ?? 0 };
}

/** Removes the authenticator. Not for a person whose role requires one. */
export async function disable(ctx: Ctx, userId: string, code: string) {
  const req = await requirement(ctx, userId);
  if (!req.enrolled) throw conflict('not_enrolled', 'No authenticator is set up.');
  if (req.byRole) throw forbidden('Your role requires a second factor, so it cannot be removed. An admin can reset it if you lost your phone.');
  await verifySecondFactor(ctx, userId, code);
  await ctx.db.tx(async (db) => {
    await db.query('delete from user_totp where user_id = $1', [userId]);
    await db.query('delete from recovery_code where user_id = $1', [userId]);
  });
  await audit(ctx.db, null, null, 'auth.second_factor_removed', 'app_user', userId, { enrolled: true }, { enrolled: false });
}

/** Ten new recovery codes, replacing the old ones. Needs a current code from the app (a recovery code does not do). */
export async function regenerateRecoveryCodes(ctx: Ctx, userId: string, code: string) {
  const row = await ctx.db.one<TotpRow>('select * from user_totp where user_id = $1 and confirmed_at is not null', [userId]);
  if (!row) throw conflict('not_enrolled', 'No authenticator is set up.');
  assertNotLocked(ctx, row);
  if (!(await acceptTotp(ctx, row, code.trim()))) { // a recovery code is not six digits, so it never passes here
    await recordFailure(ctx, userId);
    throw unauthorized('That code is not right.');
  }
  const recoveryCodes = await replaceRecoveryCodes(ctx, userId);
  await audit(ctx.db, null, null, 'auth.recovery_codes_renewed', 'app_user', userId, null, { count: recoveryCodes.length });
  return { recoveryCodes };
}

/** What a reset does to a person: the authenticator and the recovery codes go, and every session of theirs has to do the second step again. */
async function wipe(ctx: Ctx, userId: string) {
  await ctx.db.tx(async (db) => {
    await db.query('delete from user_totp where user_id = $1', [userId]);
    await db.query('delete from recovery_code where user_id = $1', [userId]);
    await db.query('update session set second_factor_at = null where user_id = $1', [userId]);
  });
}

/** An admin resets a member's authenticator (a lost phone with no recovery codes). They enrol again at their next sign-in. */
export async function resetForMember(ctx: Ctx, p: Principal, brandId: string, memberId: string) {
  await authorize(ctx.db, p, brandId, 'brand.manage');
  const m = await ctx.db.one<{ user_id: string }>('select user_id from member where id = $1 and brand_id = $2', [memberId, brandId]);
  if (!m) throw notFound('Member');
  await wipe(ctx, m.user_id);
  await audit(ctx.db, p, brandId, 'user.second_factor_reset', 'app_user', m.user_id, { enrolled: true }, { enrolled: false });
  return { ok: true };
}

/** The same, from the command line, for an admin who has lost both their phone and their recovery codes. */
export async function resetByEmail(ctx: Ctx, email: string): Promise<boolean> {
  const u = await ctx.db.one<{ id: string }>('select id from app_user where lower(email) = $1', [email.trim().toLowerCase()]);
  if (!u) return false;
  await wipe(ctx, u.id);
  await audit(ctx.db, null, null, 'user.second_factor_reset', 'app_user', u.id, { enrolled: true }, { enrolled: false, by: 'command line' });
  return true;
}

