import { createHash, randomBytes } from 'node:crypto';
import type { Ctx } from '../context.js';
import type { Principal } from '../auth/principal.js';
import { forbidden, unauthorized } from '../errors.js';
import { hashToken, myInvitations } from './brand.js';

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const SESSION_DAYS = 14;
const LINK_MINUTES = 15;

export const normalizeEmail = (e: string) => e.trim().toLowerCase();

/** Sign-in links still being sent, per context, so a test (or anything else that must) can wait for them. */
const sending = new WeakMap<Ctx, Set<Promise<void>>>();

/**
 * Asks for a sign-in link for an email. Nothing about the answer depends on whether the person exists: it does not wait
 * for the database or the mail server (only people who exist get a link, and only they would make the answer slower), and
 * a mail server that refuses or times out is the server's problem, logged here, not an error the asker sees.
 */
export function requestMagicLink(ctx: Ctx, rawEmail: string): void {
  if (!ctx.config.emailLinkLogin) return; // everyone signs in with single sign-on: no link is sent, and it answers the same way
  const job = sendMagicLink(ctx, normalizeEmail(rawEmail)).catch((err) => {
    ctx.log.error({ err: String(err) }, 'could not send a sign-in link');
  });
  let set = sending.get(ctx);
  if (!set) sending.set(ctx, (set = new Set()));
  set.add(job);
  void job.finally(() => set!.delete(job));
}

/** Waits until every sign-in link asked for so far has been sent (or has failed). */
export async function magicLinksSettled(ctx: Ctx): Promise<void> {
  await Promise.all([...(sending.get(ctx) ?? [])]);
}

async function sendMagicLink(ctx: Ctx, email: string): Promise<void> {
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

/**
 * Starts a session. It begins without the second step done (unless the identity provider's own is trusted, see `secondFactorDone`);
 * whether that step is asked for is decided on each request by sessionState, not here.
 */
export async function startSession(ctx: Ctx, userId: string, via: 'link' | 'sso' | 'dev', secondFactorDone = false): Promise<{ token: string; expiresAt: Date }> {
  const token = randomBytes(32).toString('base64url');
  const row = await ctx.db.one<{ expires_at: Date }>(
    `insert into session (token_hash, user_id, expires_at, via, second_factor_at)
     values ($1,$2, now() + make_interval(days => $3), $4, case when $5::boolean then now() else null end) returning expires_at`,
    [sha(token), userId, SESSION_DAYS, via, secondFactorDone],
  );
  return { token, expiresAt: row!.expires_at };
}

/** Exchanges a link token for a session. A link works once. */
export async function verifyMagicLink(ctx: Ctx, token: string) {
  if (!ctx.config.emailLinkLogin) return null;
  const row = await ctx.db.one<{ email: string }>(
    `update login_token set used_at = now() where token_hash = $1 and used_at is null and expires_at > now() returning email`,
    [sha(token)],
  );
  if (!row) return null;
  const user = await ctx.db.one<{ id: string }>('select id from app_user where lower(email) = $1', [row.email]);
  return user ? startSession(ctx, user.id, 'link') : null;
}

/** Development only (AUTH_DEV_LOGIN): sign in as an existing user without a link. */
export async function devLogin(ctx: Ctx, rawEmail: string) {
  if (!ctx.config.devLogin) return null;
  const user = await ctx.db.one<{ id: string }>('select id from app_user where lower(email) = $1', [normalizeEmail(rawEmail)]);
  return user ? startSession(ctx, user.id, 'dev') : null;
}

export async function endSession(ctx: Ctx, token: string) {
  await ctx.db.query('delete from session where token_hash = $1', [sha(token)]);
}

/** Where a browser session stands: signed in, or still owing the second step (and whether it has an authenticator to give it from). */
export interface SessionState {
  userId: string;
  email: string;
  /** none: signed in. verify: has an authenticator, owes a code. enroll: must set one up first. */
  pending: 'none' | 'verify' | 'enroll';
}

/**
 * Whether a session began with an emailed link on a server that trusts the identity provider's second step (OIDC_SECOND_FACTOR=idp).
 * Such a session would get round the provider's step, so it owes the app's own, whatever the person's role.
 */
const linkPastIdp = (ctx: Ctx, via: string) => via === 'link' && ctx.config.sso?.secondFactor === 'idp';

export async function sessionState(ctx: Ctx, token: string): Promise<SessionState | null> {
  const row = await ctx.db.one<{ id: string; email: string; via: string; second_factor_at: Date | null; enrolled: boolean; privileged: boolean }>(
    `select u.id, u.email, s.via, s.second_factor_at,
            exists(select 1 from user_totp t where t.user_id = u.id and t.confirmed_at is not null) as enrolled,
            exists(select 1 from member m where m.user_id = u.id and m.role in ('admin','approver')) as privileged
     from session s join app_user u on u.id = s.user_id where s.token_hash = $1 and s.expires_at > now()`,
    [sha(token)],
  );
  if (!row) return null;
  // Asked of anyone who set an authenticator up, and of admins and approvers once the deployment requires it.
  const needed = row.enrolled || linkPastIdp(ctx, row.via) || (ctx.config.secondFactorRequired && row.privileged);
  const pending = !needed || row.second_factor_at ? 'none' : row.enrolled ? 'verify' : 'enroll';
  return { userId: row.id, email: row.email, pending };
}

export async function principalFromSession(ctx: Ctx, token: string): Promise<Principal | null> {
  const s = await sessionState(ctx, token);
  return s && s.pending === 'none' ? { kind: 'user', userId: s.userId, email: s.email } : null;
}

/**
 * Whether this session may set up an authenticator. Not one that began with an emailed link where the provider's second step is
 * trusted: whoever holds a stolen link would set up their own phone and be in. Those people set one up after signing in with
 * single sign-on, and use the link only once they have it.
 */
export async function assertMayEnroll(ctx: Ctx, token: string): Promise<void> {
  const s = await ctx.db.one<{ via: string }>('select via from session where token_hash = $1', [sha(token)]);
  if (s && linkPastIdp(ctx, s.via)) {
    throw forbidden(`An authenticator cannot be set up from an emailed link on this server. Sign in with ${ctx.config.sso!.label} and set it up under Your account.`);
  }
}

/** The person has given the second step in this session. */
export async function markSecondFactor(ctx: Ctx, token: string): Promise<void> {
  await ctx.db.query('update session set second_factor_at = now() where token_hash = $1', [sha(token)]);
}

/**
 * A producer token works while it is not revoked or expired, and while whoever made it is still an admin of its brand: someone
 * who leaves the brand, or stops managing it, does not keep a way in through a token they made (their tokens are revoked then too,
 * see services/brand.ts; this holds even for a change made straight in the database).
 */
export async function principalFromApiToken(ctx: Ctx, token: string): Promise<Principal | null> {
  const row = await ctx.db.one<{ id: string; brand_id: string; created_by: string }>(
    `update api_token t set last_used_at = now()
     where t.token_hash = $1 and t.revoked_at is null and t.expires_at > now()
       and exists (select 1 from member m where m.user_id = t.created_by and m.brand_id = t.brand_id and m.role = 'admin')
     returning t.id, t.brand_id, t.created_by`,
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
  // Brands of other workspaces that asked this person to join: nothing changes until they accept (POST /api/invitations/:id/accept).
  return { user, brands, invitations: await myInvitations(ctx, userId) };
}

/** For a producer token: which brand it belongs to, so a script needs nothing but the address and the token. */
export async function tokenInfo(ctx: Ctx, p: Principal) {
  if (p.kind !== 'token') throw forbidden('This is for producer tokens: signed-in people use /api/me');
  const row = await ctx.db.one(
    `select t.id, t.name, t.expires_at, b.id as brand_id, b.name as brand_name, b.timezone, w.name as workspace
     from api_token t join brand b on b.id = t.brand_id join workspace w on w.id = b.workspace_id where t.id = $1`,
    [p.tokenId],
  );
  if (!row) throw unauthorized();
  return {
    token: { id: row.id, name: row.name, expires_at: row.expires_at },
    brand: { id: row.brand_id, name: row.brand_name, timezone: row.timezone, workspace: row.workspace },
  };
}
