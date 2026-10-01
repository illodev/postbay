import { createHash, randomBytes } from 'node:crypto';
import type { Ctx } from '../context.js';
import type { Principal } from '../auth/principal.js';
import { hashToken } from './brand.js';

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const SESSION_DAYS = 14;
const LINK_MINUTES = 15;

export const normalizeEmail = (e: string) => e.trim().toLowerCase();

/**
 * Sends a sign-in link to people who exist. It always answers the same way,
 * so the endpoint cannot be used to find out who has an account.
 */
export async function requestMagicLink(ctx: Ctx, rawEmail: string): Promise<void> {
  const email = normalizeEmail(rawEmail);
  const user = await ctx.db.one('select id from app_user where lower(email) = $1', [email]);
  if (!user) return;
  const token = randomBytes(32).toString('base64url');
  await ctx.db.query(
    `insert into login_token (token_hash, email, expires_at) values ($1,$2, now() + make_interval(mins => $3))`,
    [sha(token), email, LINK_MINUTES],
  );
  const link = `${ctx.config.APP_URL}/auth/callback?token=${token}`;
  await ctx.mailer.send(email, 'Your sign-in link', `Use this link to sign in (valid for ${LINK_MINUTES} minutes, works once):\n\n${link}\n`);
}

async function startSession(ctx: Ctx, userId: string): Promise<{ token: string; expiresAt: Date }> {
  const token = randomBytes(32).toString('base64url');
  const row = await ctx.db.one<{ expires_at: Date }>(
    `insert into session (token_hash, user_id, expires_at) values ($1,$2, now() + make_interval(days => $3)) returning expires_at`,
    [sha(token), userId, SESSION_DAYS],
  );
  return { token, expiresAt: row!.expires_at };
}

/** Exchanges a link token for a session. A link works once. */
export async function verifyMagicLink(ctx: Ctx, token: string) {
  const row = await ctx.db.one<{ email: string }>(
    `update login_token set used_at = now() where token_hash = $1 and used_at is null and expires_at > now() returning email`,
    [sha(token)],
  );
  if (!row) return null;
  const user = await ctx.db.one<{ id: string }>('select id from app_user where lower(email) = $1', [row.email]);
  return user ? startSession(ctx, user.id) : null;
}

/** Development only (AUTH_DEV_LOGIN): sign in as an existing user without a link. */
export async function devLogin(ctx: Ctx, rawEmail: string) {
  if (!ctx.config.devLogin) return null;
  const user = await ctx.db.one<{ id: string }>('select id from app_user where lower(email) = $1', [normalizeEmail(rawEmail)]);
  return user ? startSession(ctx, user.id) : null;
}

export async function endSession(ctx: Ctx, token: string) {
  await ctx.db.query('delete from session where token_hash = $1', [sha(token)]);
}

export async function principalFromSession(ctx: Ctx, token: string): Promise<Principal | null> {
  const row = await ctx.db.one<{ id: string; email: string }>(
    `select u.id, u.email from session s join app_user u on u.id = s.user_id where s.token_hash = $1 and s.expires_at > now()`,
    [sha(token)],
  );
  return row ? { kind: 'user', userId: row.id, email: row.email } : null;
}

export async function principalFromApiToken(ctx: Ctx, token: string): Promise<Principal | null> {
  const row = await ctx.db.one<{ id: string; brand_id: string; created_by: string }>(
    `update api_token set last_used_at = now()
     where token_hash = $1 and revoked_at is null and expires_at > now() returning id, brand_id, created_by`,
    [hashToken(token)],
  );
  return row ? { kind: 'token', tokenId: row.id, brandId: row.brand_id, createdBy: row.created_by } : null;
}

export async function me(ctx: Ctx, userId: string) {
  const user = await ctx.db.one('select id, email, name from app_user where id = $1', [userId]);
  const brands = await ctx.db.query(
    `select b.id, b.name, b.timezone, b.paused, m.role, w.name as workspace
     from member m join brand b on b.id = m.brand_id join workspace w on w.id = b.workspace_id
     where m.user_id = $1 order by w.name, b.name`,
    [userId],
  );
  return { user, brands };
}
