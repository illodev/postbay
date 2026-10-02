import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { OidcClient, OidcError } from '../auth/oidc.js';
import type { Ctx } from '../context.js';
import { audit } from './audit.js';
import { startSession } from './auth.js';

/**
 * Single sign-on. It signs in people who already exist (an admin adds them under *People* first): it never makes accounts, so being
 * able to sign in at the identity provider is not enough to get in. The first sign-in links the provider's id for the person to
 * their account, and after that they are known by that id and not by an email that can change hands.
 */
const ATTEMPT_MINUTES = 10;
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
export const SSO_COOKIE = 'sso';
export const ssoRedirectUri = (ctx: Ctx) => `${ctx.config.APP_URL.replace(/\/$/, '')}/api/auth/sso/callback`;

const clients = new WeakMap<object, OidcClient>();
function client(ctx: Ctx): OidcClient {
  const cfg = ctx.config.sso;
  if (!cfg) throw new OidcError('provider', 'Single sign-on is not set up on this server');
  let c = clients.get(ctx.config);
  if (!c) {
    c = new OidcClient({ ...cfg, requireHostedDomain: cfg.issuer === 'https://accounts.google.com' }, ctx.config.SECRET, ctx.now);
    clients.set(ctx.config, c);
  }
  return c;
}

/** What the sign-in page needs to know. */
export const ssoInfo = (ctx: Ctx) => (ctx.config.sso ? { label: ctx.config.sso.label } : null);

/** Starts a sign-in: remembers it, and says where to send the browser and what to hold on to until it comes back. */
export async function startSso(ctx: Ctx): Promise<{ url: string; state: string }> {
  const oidc = client(ctx);
  const state = randomBytes(24).toString('base64url');
  const url = await oidc.authorizeUrl(state, ssoRedirectUri(ctx));
  await ctx.db.query('insert into sso_attempt (state_hash, expires_at) values ($1, $2)', [sha(state), new Date(ctx.now().getTime() + ATTEMPT_MINUTES * 60_000)]);
  return { url, state };
}

export type SsoFailure = 'cancelled' | 'state' | 'provider' | 'token' | 'claims' | 'domain' | 'no_account' | 'identity_conflict';

const sameText = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

/**
 * The browser is back from the provider. `held` is what start asked the browser to hold on to (a cookie): without it, anyone could
 * make a person finish a sign-in that somebody else started and so sign in as the somebody else.
 */
export async function finishSso(
  ctx: Ctx, q: { code?: string; state?: string; error?: string }, held: string | undefined,
): Promise<{ session: { token: string; expiresAt: Date } } | { failure: SsoFailure }> {
  if (!q.state || !held || !sameText(q.state, held)) return { failure: 'state' };
  const attempt = await ctx.db.one(
    'update sso_attempt set used_at = $2 where state_hash = $1 and used_at is null and expires_at > $2 returning state_hash',
    [sha(q.state), ctx.now()],
  );
  if (!attempt) return { failure: 'state' };
  if (q.error || !q.code) return { failure: 'cancelled' };

  let claims;
  try {
    claims = await client(ctx).exchange(q.code, q.state, ssoRedirectUri(ctx));
  } catch (err) {
    if (err instanceof OidcError) {
      ctx.log.warn({ code: err.code, reason: err.message }, 'single sign-on refused');
      return { failure: err.code };
    }
    ctx.log.warn({ err: String(err) }, 'single sign-on failed');
    return { failure: 'provider' };
  }

  const known = await ctx.db.one<{ user_id: string }>('select user_id from user_identity where issuer = $1 and subject = $2', [claims.issuer, claims.subject]);
  let userId = known?.user_id;
  if (!userId) {
    const byEmail = await ctx.db.one<{ id: string }>('select id from app_user where lower(email) = $1', [claims.email]);
    if (!byEmail) return { failure: 'no_account' };
    // Someone who already signs in here with another account at this provider is not made to share: the email may have changed hands.
    const other = await ctx.db.one('select 1 from user_identity where user_id = $1 and issuer = $2', [byEmail.id, claims.issuer]);
    if (other) {
      await audit(ctx.db, null, null, 'auth.sso_refused', 'app_user', byEmail.id, null, { reason: 'another identity is linked' });
      return { failure: 'identity_conflict' };
    }
    await ctx.db.query('insert into user_identity (user_id, issuer, subject, email) values ($1,$2,$3,$4)', [byEmail.id, claims.issuer, claims.subject, claims.email]);
    await audit(ctx.db, null, null, 'auth.sso_linked', 'app_user', byEmail.id, null, { issuer: claims.issuer });
    userId = byEmail.id;
  } else {
    await ctx.db.query('update user_identity set email = $3 where issuer = $1 and subject = $2', [claims.issuer, claims.subject, claims.email]);
  }
  // The provider's own second step counts only if the deployment says it is enforced there.
  const session = await startSession(ctx, userId, 'sso', ctx.config.sso!.secondFactor === 'idp');
  await audit(ctx.db, null, null, 'auth.sso_login', 'app_user', userId, null, { issuer: claims.issuer });
  return { session };
}
