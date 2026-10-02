import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { authorize, roleIn, type Principal, type Via } from '../auth/principal.js';
import type { Ctx } from '../context.js';
import type { Queryable } from '../db.js';
import { can, type Role } from '../domain/roles.js';
import { AppError, badRequest, conflict } from '../errors.js';
import { msg } from '../i18n/index.js';
import { audit } from '../services/audit.js';
import { mcpOf } from './settings.js';

/**
 * The studio as an OAuth 2.1 authorization server for AI assistants (the MCP authorization spec, 2025-11-25): protected-resource and
 * authorization-server metadata, dynamic client registration (RFC 7591), the authorization code flow with PKCE (S256 only), refresh
 * tokens that rotate, and revocation (RFC 7009). People never handle a key: an assistant registers itself, the person signs in with their
 * own account and says yes on the consent page, and the assistant gets tokens that act as that person in the brands they chose.
 *
 *  - Every secret (client secrets, codes, access and refresh tokens) is stored as its sha256; none can be read back.
 *  - Access tokens live ACCESS_TOKEN_SECONDS. A refresh token is used once: a used one presented again revokes the whole grant.
 *  - A grant names its audience (the MCP endpoint): a token is accepted only there, and only while the grant stands.
 *  - What a token may do is decided on each call by the person's role in the brand (`authorize`), within the brands of the grant.
 */

export const ACCESS_TOKEN_SECONDS = 30 * 60;
export const REFRESH_TOKEN_DAYS = 30;
const CODE_SECONDS = 120;
const REQUEST_MINUTES = 10;

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const random = (bytes = 32) => randomBytes(bytes).toString('base64url');
const sameText = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

/** An answer of the OAuth endpoints in the shape RFC 6749 §5.2 and RFC 7591 §3.2.2 give: `{ error, error_description }`. */
export class OAuthError extends Error {
  constructor(public status: number, public error: string, public description: string) {
    super(description);
  }
}

/** Where everything is, from the app's public address. The MCP endpoint is the protected resource; the app itself is the issuer. */
export function endpoints(ctx: Ctx) {
  const base = ctx.config.APP_URL.replace(/\/+$/, '');
  return {
    issuer: base,
    resource: `${base}/api/mcp`,
    resourceMetadata: `${base}/.well-known/oauth-protected-resource/api/mcp`,
    authorize: `${base}/api/mcp/oauth/authorize`,
    token: `${base}/api/mcp/oauth/token`,
    register: `${base}/api/mcp/oauth/register`,
    revoke: `${base}/api/mcp/oauth/revoke`,
    consentPage: `${base}/oauth/consent`,
  };
}

/** RFC 9728: what the MCP endpoint is and who issues tokens for it. */
export function protectedResourceMetadata(ctx: Ctx) {
  const e = endpoints(ctx);
  return {
    resource: e.resource,
    authorization_servers: [e.issuer],
    bearer_methods_supported: ['header'],
    resource_name: 'Postbay',
    resource_documentation: `${e.issuer}/settings?tab=assistants`,
  };
}

/** RFC 8414. `code_challenge_methods_supported` is what an MCP client checks before it goes on (only S256). */
export function authorizationServerMetadata(ctx: Ctx) {
  const e = endpoints(ctx);
  const auth = ['none', 'client_secret_post', 'client_secret_basic'];
  return {
    issuer: e.issuer,
    authorization_endpoint: e.authorize,
    token_endpoint: e.token,
    registration_endpoint: e.register,
    revocation_endpoint: e.revoke,
    response_types_supported: ['code'],
    response_modes_supported: ['query'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: auth,
    revocation_endpoint_auth_methods_supported: auth,
    authorization_response_iss_parameter_supported: true,
  };
}

/**
 * The resource a client names (RFC 8707), as the one this server issues tokens for: the MCP endpoint, or the app's own address, written
 * in any case for the scheme and host and with or without a trailing slash. Not naming one is taken as the MCP endpoint (older clients);
 * naming anything else is refused (null).
 */
export function resolveResource(ctx: Ctx, raw: string | undefined): string | null {
  const e = endpoints(ctx);
  if (raw === undefined || raw === '') return e.resource;
  const canon = (u: string) => {
    try {
      const x = new URL(u);
      if (x.hash || x.search) return null;
      return `${x.protocol}//${x.host}${x.pathname}`.toLowerCase().replace(/\/+$/, '');
    } catch {
      return null;
    }
  };
  const asked = canon(raw);
  if (!asked) return null;
  return asked === canon(e.resource) || asked === canon(e.issuer) ? e.resource : null;
}

// ───────────────────────────── registering a client (RFC 7591) ─────────────────────────────

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * Where an assistant may be sent back to: an https address, or http on this very machine (a desktop app or Claude Code listening on a
 * port), as the MCP spec requires. Never with a fragment or credentials in it.
 */
export function redirectAllowed(raw: string): boolean {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (u.hash || u.username || u.password || raw.length > 2000) return false;
  if (u.protocol === 'https:') return true;
  return u.protocol === 'http:' && LOOPBACK.has(u.hostname);
}

const cleanName = (s: unknown) => (typeof s === 'string' ? s.replace(/[\u0000-\u001f\u007f-\u009f]/g, '').trim().slice(0, 80) : '');

const registrationInput = z.object({
  redirect_uris: z.array(z.string()).min(1).max(10),
  client_name: z.string().max(500).optional(),
  client_uri: z.string().max(2000).optional(),
  token_endpoint_auth_method: z.string().max(40).optional(),
  grant_types: z.array(z.string().max(80)).max(10).optional(),
  response_types: z.array(z.string().max(40)).max(10).optional(),
  scope: z.string().max(500).optional(),
  software_id: z.string().max(200).optional(),
  software_version: z.string().max(80).optional(),
});

/** A client registers itself. Anyone can, as the protocol intends: the person's consent is what grants anything. */
export async function registerClient(ctx: Ctx, raw: unknown) {
  const parsed = registrationInput.safeParse(raw ?? {});
  if (!parsed.success) throw new OAuthError(400, 'invalid_client_metadata', parsed.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; '));
  const input = parsed.data;
  const bad = input.redirect_uris.find((u) => !redirectAllowed(u));
  if (bad) throw new OAuthError(400, 'invalid_redirect_uri', `Redirect URIs must be https, or http on localhost: ${bad.slice(0, 200)}`);
  const method = input.token_endpoint_auth_method ?? 'client_secret_basic';
  if (!['none', 'client_secret_post', 'client_secret_basic'].includes(method)) {
    throw new OAuthError(400, 'invalid_client_metadata', `Unsupported token_endpoint_auth_method: ${method}`);
  }
  const grants = input.grant_types ?? ['authorization_code', 'refresh_token'];
  if (grants.some((g) => !['authorization_code', 'refresh_token'].includes(g))) {
    throw new OAuthError(400, 'invalid_client_metadata', 'Only the authorization_code and refresh_token grant types are supported');
  }
  if ((input.response_types ?? ['code']).some((r) => r !== 'code')) throw new OAuthError(400, 'invalid_client_metadata', 'Only the code response type is supported');
  let clientUri: string | null = null;
  if (input.client_uri) {
    try {
      const u = new URL(input.client_uri);
      if (u.protocol === 'https:' || u.protocol === 'http:') clientUri = u.toString();
    } catch { /* not shown */ }
  }

  // Clients that registered and never got a person's consent are forgotten after a week.
  await ctx.db.query(`delete from mcp_client c where c.created_at < now() - interval '7 days' and not exists (select 1 from mcp_grant g where g.client_id = c.id)`);

  const clientId = `pbc_${random(18)}`;
  const secret = method === 'none' ? null : `pbs_${random(32)}`;
  const name = cleanName(input.client_name) || 'MCP client';
  const row = (await ctx.db.one<{ created_at: Date }>(
    `insert into mcp_client (client_id, secret_hash, auth_method, name, client_uri, redirect_uris, software_id, software_version)
     values ($1,$2,$3,$4,$5,$6,$7,$8) returning created_at`,
    [clientId, secret ? sha(secret) : null, method, name, clientUri, input.redirect_uris, cleanName(input.software_id) || null, cleanName(input.software_version) || null],
  ))!;
  return {
    client_id: clientId,
    ...(secret ? { client_secret: secret, client_secret_expires_at: 0 } : {}),
    client_id_issued_at: Math.floor(new Date(row.created_at).getTime() / 1000),
    client_name: name,
    ...(clientUri ? { client_uri: clientUri } : {}),
    redirect_uris: input.redirect_uris,
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    token_endpoint_auth_method: method,
  };
}

// ───────────────────────────── the authorization request ─────────────────────────────

/** An address with these query parameters added (the redirect URI may already carry its own). */
function withParams(base: string, params: Record<string, string | undefined | null>): string {
  const u = new URL(base);
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') u.searchParams.set(k, v);
  return u.toString();
}

/**
 * GET /authorize. Checks the client and its redirect URI first: if either is wrong nothing is sent to that address, and the person sees
 * why on the consent page. Then everything else, answered to the client at its redirect URI. A good request is kept for a few minutes
 * and the person is sent to the consent page with it, where they sign in (if they are not) and say yes or no.
 */
export async function startAuthorization(ctx: Ctx, q: Record<string, unknown>): Promise<string> {
  const e = endpoints(ctx);
  const str = (k: string) => (typeof q[k] === 'string' ? (q[k] as string) : undefined);
  const page = new URL(e.consentPage);
  const clientId = str('client_id');
  const client = clientId ? await ctx.db.one<{ id: string; redirect_uris: string[] }>('select id, redirect_uris from mcp_client where client_id = $1', [clientId]) : null;
  if (!client) {
    page.searchParams.set('error', 'invalid_client');
    return page.toString();
  }
  let redirectUri = str('redirect_uri');
  if (redirectUri === undefined && client.redirect_uris.length === 1) redirectUri = client.redirect_uris[0];
  // Exact match only: no prefix, no added path, no case folding.
  if (!redirectUri || !client.redirect_uris.includes(redirectUri)) {
    page.searchParams.set('error', 'invalid_redirect_uri');
    return page.toString();
  }
  const state = str('state');
  const back = (error: string, description: string) => withParams(redirectUri, { error, error_description: description, state, iss: e.issuer });
  if (str('response_type') !== 'code') return back('unsupported_response_type', 'Only response_type=code is supported');
  const challenge = str('code_challenge');
  if (!challenge || !/^[A-Za-z0-9_-]{43,128}$/.test(challenge)) return back('invalid_request', 'PKCE is required: send a code_challenge made with S256');
  if (str('code_challenge_method') !== 'S256') return back('invalid_request', 'Only the S256 code challenge method is supported');
  if (state !== undefined && state.length > 2000) return back('invalid_request', 'The state is too long');
  const resource = resolveResource(ctx, str('resource'));
  if (!resource) return back('invalid_target', `This server issues tokens only for ${e.resource}`);

  await ctx.db.query(`delete from mcp_authorization where expires_at < now() - interval '1 day'`);
  const row = (await ctx.db.one<{ id: string }>(
    `insert into mcp_authorization (client_id, redirect_uri, state, code_challenge, scope, resource, expires_at)
     values ($1,$2,$3,$4,$5,$6, now() + make_interval(mins => $7)) returning id`,
    [client.id, redirectUri, state ?? null, challenge, str('scope')?.slice(0, 500) ?? null, resource, REQUEST_MINUTES],
  ))!;
  page.searchParams.set('request', row.id);
  return page.toString();
}

/** The nonce the consent page sends back: made for this request and this person, with the server's secret. */
const consentNonce = (ctx: Ctx, requestId: string, userId: string) =>
  createHmac('sha256', ctx.config.SECRET).update(`mcp-consent\n${requestId}\n${userId}`).digest('base64url');

async function openRequest(db: Queryable, id: string, lock = false) {
  return db.one<{
    id: string; client_id: string; redirect_uri: string; state: string | null; code_challenge: string; scope: string | null; resource: string;
    user_id: string | null; expires_at: Date; client_name: string; client_uri: string | null; client_ref: string; registered_at: Date;
  }>(
    `select r.*, c.name as client_name, c.client_uri, c.client_id as client_ref, c.created_at as registered_at
     from mcp_authorization r join mcp_client c on c.id = r.client_id
     where r.id = $1 and r.answered_at is null and r.expires_at > now() ${lock ? 'for update of r' : ''}`,
    [id],
  );
}

/** The person's active brands, with their role and whether an assistant may approve there for them. */
async function brandsOf(db: Queryable, userId: string) {
  const rows = await db.query<{ id: string; name: string; workspace: string; role: Role; mcp: unknown }>(
    `select b.id, b.name, w.name as workspace, m.role, b.mcp
     from member m join brand b on b.id = m.brand_id join workspace w on w.id = b.workspace_id
     where m.user_id = $1 and m.deactivated_at is null order by w.name, b.name`,
    [userId],
  );
  return rows.map((b) => ({ id: b.id, name: b.name, workspace: b.workspace, role: b.role, can_approve: mcpOf(b).allow_approval && can(b.role, 'version.approve') }));
}

/**
 * What the consent page shows: which client asks (its name, and the host it will send the answer to, which a client cannot fake), and
 * the person's brands to choose from. The first person to open it owns it.
 */
export async function consentDetails(ctx: Ctx, userId: string, requestId: string) {
  const r = await openRequest(ctx.db, requestId);
  if (!r || (r.user_id && r.user_id !== userId)) throw new AppError(404, 'request_gone', msg('mcp.request.gone'));
  if (!r.user_id) {
    const taken = await ctx.db.one('update mcp_authorization set user_id = $2 where id = $1 and (user_id is null or user_id = $2) returning id', [requestId, userId]);
    if (!taken) throw new AppError(404, 'request_gone', msg('mcp.request.gone'));
  }
  const to = new URL(r.redirect_uri);
  return {
    request: r.id,
    nonce: consentNonce(ctx, r.id, userId),
    expires_at: r.expires_at,
    client: {
      name: r.client_name,
      uri: r.client_uri,
      redirect_host: to.host,
      // A desktop app or Claude Code answering on this machine: any program on it could claim such an address.
      local: to.protocol === 'http:',
      registered_at: r.registered_at,
    },
    brands: await brandsOf(ctx.db, userId),
  };
}

const answerInput = z.object({
  allow: z.boolean(),
  brandIds: z.array(z.string().uuid()).max(100).default([]),
  nonce: z.string().min(10).max(200),
});

/**
 * The person's answer. No: the client is told `access_denied`. Yes: a grant for the brands they chose (each one where they are an active
 * member), and a code for the client, single use and short-lived, bound to the redirect URI and the PKCE challenge. Either way the
 * request is spent. The answer is where the browser has to go next.
 */
export async function answerConsent(ctx: Ctx, p: Principal, requestId: string, raw: unknown): Promise<{ redirect: string }> {
  if (p.kind !== 'user' || p.via) throw new AppError(403, 'forbidden', msg('error.signedInOnly'));
  const input = answerInput.parse(raw);
  const e = endpoints(ctx);
  return ctx.db.tx(async (db) => {
    const r = await openRequest(db, requestId, true);
    if (!r || r.user_id !== p.userId) throw new AppError(404, 'request_gone', msg('mcp.request.gone'));
    if (!sameText(input.nonce, consentNonce(ctx, r.id, p.userId))) throw conflict('request_stale', msg('mcp.request.stale'));
    await db.query('update mcp_authorization set answered_at = now() where id = $1', [r.id]);
    if (!input.allow) {
      return { redirect: withParams(r.redirect_uri, { error: 'access_denied', error_description: 'The person did not allow access', state: r.state, iss: e.issuer }) };
    }
    const brandIds = [...new Set(input.brandIds)];
    if (brandIds.length === 0) throw badRequest('no_brands', msg('mcp.request.noBrands'));
    for (const b of brandIds) if (!(await roleIn(db, p, b))) throw badRequest('no_brands', msg('mcp.request.noBrands'));
    const grant = (await db.one<{ id: string }>(
      'insert into mcp_grant (user_id, client_id, brand_ids, scope, resource) values ($1,$2,$3,$4,$5) returning id',
      [p.userId, r.client_id, brandIds, r.scope, r.resource],
    ))!;
    const code = random(32);
    await db.query(
      `insert into mcp_code (code_hash, grant_id, redirect_uri, code_challenge, expires_at) values ($1,$2,$3,$4, now() + make_interval(secs => $5))`,
      [sha(code), grant.id, r.redirect_uri, r.code_challenge, CODE_SECONDS],
    );
    for (const b of brandIds) {
      await audit(db, p, b, 'mcp.authorized', 'mcp_grant', grant.id, null,
        { client_name: r.client_name, client_id: r.client_ref, redirect_host: new URL(r.redirect_uri).host, brands: brandIds.length });
    }
    return { redirect: withParams(r.redirect_uri, { code, state: r.state, iss: e.issuer }) };
  });
}

// ───────────────────────────── the token endpoint ─────────────────────────────

interface Client {
  id: string;
  client_id: string;
  name: string;
}

/**
 * Who is calling the token or revocation endpoint. A public client names itself (`client_id`); a confidential one also proves it with
 * its secret, in the body (`client_secret_post`) or in an `Authorization: Basic` header.
 */
async function authenticateClient(ctx: Ctx, body: Record<string, unknown>, authorization: string | undefined): Promise<Client> {
  let id = typeof body.client_id === 'string' ? body.client_id : undefined;
  let secret = typeof body.client_secret === 'string' ? body.client_secret : undefined;
  const basic = /^Basic\s+(\S+)$/i.exec(authorization ?? '')?.[1];
  if (basic) {
    const decoded = Buffer.from(basic, 'base64').toString('utf8');
    const colon = decoded.indexOf(':');
    if (colon < 0) throw new OAuthError(401, 'invalid_client', 'Malformed Basic credentials');
    const bid = decodeURIComponent(decoded.slice(0, colon));
    if (id && id !== bid) throw new OAuthError(401, 'invalid_client', 'Two different clients in one request');
    id = bid;
    secret = decodeURIComponent(decoded.slice(colon + 1));
  }
  if (!id) throw new OAuthError(401, 'invalid_client', 'client_id is required');
  const c = await ctx.db.one<Client & { secret_hash: string | null; auth_method: string }>('select id, client_id, name, secret_hash, auth_method from mcp_client where client_id = $1', [id]);
  if (!c) throw new OAuthError(401, 'invalid_client', 'Unknown client');
  if (c.secret_hash) {
    if (!secret || !sameText(sha(secret), c.secret_hash)) throw new OAuthError(401, 'invalid_client', 'Client authentication failed');
  }
  await ctx.db.query(`update mcp_client set last_used_at = now() where id = $1 and (last_used_at is null or last_used_at < now() - interval '1 minute')`, [c.id]);
  return { id: c.id, client_id: c.client_id, name: c.name };
}

async function issueTokens(db: Queryable, grantId: string, scope: string | null) {
  const access = `pba_${random(32)}`;
  const refresh = `pbr_${random(32)}`;
  await db.query(
    `insert into mcp_token (token_hash, grant_id, kind, expires_at) values
       ($1,$3,'access', now() + make_interval(secs => $4)), ($2,$3,'refresh', now() + make_interval(days => $5))`,
    [sha(access), sha(refresh), grantId, ACCESS_TOKEN_SECONDS, REFRESH_TOKEN_DAYS],
  );
  return {
    access_token: access,
    token_type: 'Bearer',
    expires_in: ACCESS_TOKEN_SECONDS,
    refresh_token: refresh,
    ...(scope ? { scope } : {}),
  };
}

/** Ends a grant and every token issued under it. */
async function revokeGrant(db: Queryable, grantId: string, by: string | null, reason: string): Promise<boolean> {
  const g = await db.one('update mcp_grant set revoked_at = now(), revoked_by = $2, revoked_reason = $3 where id = $1 and revoked_at is null returning id', [grantId, by, reason]);
  await db.query('update mcp_token set revoked_at = now() where grant_id = $1 and revoked_at is null', [grantId]);
  return !!g;
}

const pkceOk = (verifier: string, challenge: string) =>
  /^[A-Za-z0-9\-._~]{43,128}$/.test(verifier) && sameText(createHash('sha256').update(verifier).digest('base64url'), challenge);

/** POST /token: an authorization code for the first tokens, or a refresh token for new ones. */
export async function token(ctx: Ctx, body: Record<string, unknown>, authorization: string | undefined) {
  const client = await authenticateClient(ctx, body, authorization);
  const str = (k: string) => (typeof body[k] === 'string' ? (body[k] as string) : undefined);
  const resourceAsked = str('resource');
  if (resourceAsked !== undefined && !resolveResource(ctx, resourceAsked)) throw new OAuthError(400, 'invalid_target', `This server issues tokens only for ${endpoints(ctx).resource}`);
  const invalid = (why: string) => new OAuthError(400, 'invalid_grant', why);

  if (str('grant_type') === 'authorization_code') {
    const code = str('code');
    const verifier = str('code_verifier');
    if (!code) throw new OAuthError(400, 'invalid_request', 'code is required');
    if (!verifier) throw new OAuthError(400, 'invalid_request', 'code_verifier is required (PKCE)');
    const out = await ctx.db.tx(async (db) => {
      const row = await db.one<{ grant_id: string; redirect_uri: string; code_challenge: string; expires_at: Date; used_at: Date | null; client_id: string; user_id: string; scope: string | null; grant_revoked: Date | null; expired: boolean }>(
        `select c.grant_id, c.redirect_uri, c.code_challenge, c.expires_at, c.used_at, g.client_id, g.user_id, g.scope, g.revoked_at as grant_revoked,
                c.expires_at <= now() as expired
         from mcp_code c join mcp_grant g on g.id = c.grant_id where c.code_hash = $1 for update of c`,
        [sha(code)],
      );
      if (!row || row.client_id !== client.id) return invalid('Unknown authorization code');
      if (row.used_at) {
        // A code used twice was stolen or replayed: whatever it gave is taken back.
        await revokeGrant(db, row.grant_id, null, 'code_reused');
        return invalid('This authorization code was already used');
      }
      await db.query('update mcp_code set used_at = now() where code_hash = $1', [sha(code)]);
      if (row.expired) return invalid('The authorization code has expired');
      if (row.grant_revoked) return invalid('The grant was revoked');
      const redirect = str('redirect_uri');
      if (redirect !== undefined && redirect !== row.redirect_uri) return invalid('redirect_uri does not match the authorization request');
      if (!pkceOk(verifier, row.code_challenge)) return invalid('The code_verifier does not match the code_challenge');
      // The same assistant connected again by the same person replaces what it had: one connection per assistant and person.
      const old = await db.query<{ id: string }>(
        'select id from mcp_grant where user_id = $1 and client_id = $2 and id <> $3 and revoked_at is null', [row.user_id, client.id, row.grant_id],
      );
      for (const g of old) await revokeGrant(db, g.id, row.user_id, 'replaced');
      await db.query('update mcp_grant set connected_at = coalesce(connected_at, now()), last_used_at = now() where id = $1', [row.grant_id]);
      return issueTokens(db, row.grant_id, row.scope);
    });
    if (out instanceof OAuthError) throw out;
    return out;
  }

  if (str('grant_type') === 'refresh_token') {
    const refresh = str('refresh_token');
    if (!refresh) throw new OAuthError(400, 'invalid_request', 'refresh_token is required');
    const out = await ctx.db.tx(async (db) => {
      const row = await db.one<{ grant_id: string; used_at: Date | null; revoked_at: Date | null; expired: boolean; client_id: string; grant_revoked: Date | null; scope: string | null }>(
        `select t.grant_id, t.used_at, t.revoked_at, t.expires_at <= now() as expired, g.client_id, g.revoked_at as grant_revoked, g.scope
         from mcp_token t join mcp_grant g on g.id = t.grant_id where t.token_hash = $1 and t.kind = 'refresh' for update of t`,
        [sha(refresh)],
      );
      if (!row || row.client_id !== client.id) return invalid('Unknown refresh token');
      if (row.used_at && !row.revoked_at && !row.grant_revoked) {
        // Rotation: a refresh token already exchanged and presented again means two holders. The grant ends for both.
        await revokeGrant(db, row.grant_id, null, 'refresh_reused');
        return invalid('This refresh token was already used');
      }
      if (row.used_at || row.revoked_at || row.grant_revoked) return invalid('The refresh token was revoked');
      if (row.expired) return invalid('The refresh token has expired');
      await db.query('update mcp_token set used_at = now() where token_hash = $1', [sha(refresh)]);
      await db.query('update mcp_grant set last_used_at = now() where id = $1', [row.grant_id]);
      return issueTokens(db, row.grant_id, row.scope);
    });
    if (out instanceof OAuthError) throw out;
    return out;
  }

  throw new OAuthError(400, 'unsupported_grant_type', 'Supported grant types: authorization_code, refresh_token');
}

/**
 * POST /revoke (RFC 7009). A refresh token ends the whole connection; an access token, just itself. Unknown tokens, and tokens of
 * another client, are answered the same way, as the RFC asks.
 */
export async function revokeByClient(ctx: Ctx, body: Record<string, unknown>, authorization: string | undefined) {
  const client = await authenticateClient(ctx, body, authorization);
  const value = typeof body.token === 'string' ? body.token : '';
  if (!value) throw new OAuthError(400, 'invalid_request', 'token is required');
  await ctx.db.tx(async (db) => {
    const row = await db.one<{ grant_id: string; kind: string; client_id: string; user_id: string; brand_ids: string[]; client_name: string; client_ref: string; email: string }>(
      `select t.grant_id, t.kind, g.client_id, g.user_id, g.brand_ids, c.name as client_name, c.client_id as client_ref, u.email
       from mcp_token t join mcp_grant g on g.id = t.grant_id join mcp_client c on c.id = g.client_id join app_user u on u.id = g.user_id
       where t.token_hash = $1`,
      [sha(value)],
    );
    if (!row || row.client_id !== client.id) return;
    if (row.kind === 'access') {
      await db.query('update mcp_token set revoked_at = now() where token_hash = $1 and revoked_at is null', [sha(value)]);
      return;
    }
    if (await revokeGrant(db, row.grant_id, row.user_id, 'revoked_by_client')) {
      const p: Principal = { kind: 'user', userId: row.user_id, email: row.email, via: { channel: 'mcp', grantId: row.grant_id, clientId: row.client_ref, clientName: row.client_name, brandIds: row.brand_ids } };
      for (const b of row.brand_ids) await audit(db, p, b, 'mcp.disconnected', 'mcp_grant', row.grant_id, null, { client_name: row.client_name, reason: 'revoked_by_client' });
    }
  });
}

// ───────────────────────────── using a token ─────────────────────────────

/** A person acting through an assistant: always a user, always with the assistant and its brands. */
export type McpPrincipal = { kind: 'user'; userId: string; email: string; via: Via };

export interface McpCaller {
  principal: McpPrincipal;
  grantId: string;
  scope: string | null;
  expiresAt: Date;
}

/**
 * The person and assistant behind an access token at the MCP endpoint, or null: unknown, expired or revoked, its grant revoked, or issued
 * for another resource. The grant's brands bound everything it does; the person's role in each is checked on every call.
 */
export async function callerOf(ctx: Ctx, token: string): Promise<McpCaller | null> {
  const row = await ctx.db.one<{ grant_id: string; expires_at: Date; user_id: string; email: string; brand_ids: string[]; resource: string; scope: string | null; client_ref: string; client_name: string; stale: boolean }>(
    `select t.grant_id, t.expires_at, g.user_id, u.email, g.brand_ids, g.resource, g.scope, c.client_id as client_ref, c.name as client_name,
            (g.last_used_at is null or g.last_used_at < now() - interval '1 minute') as stale
     from mcp_token t join mcp_grant g on g.id = t.grant_id join mcp_client c on c.id = g.client_id join app_user u on u.id = g.user_id
     where t.token_hash = $1 and t.kind = 'access' and t.revoked_at is null and t.expires_at > now() and g.revoked_at is null`,
    [sha(token)],
  );
  if (!row || row.resource !== endpoints(ctx).resource) return null;
  if (row.stale) await ctx.db.query('update mcp_grant set last_used_at = now() where id = $1', [row.grant_id]);
  return {
    principal: {
      kind: 'user', userId: row.user_id, email: row.email,
      via: { channel: 'mcp', grantId: row.grant_id, clientId: row.client_ref, clientName: row.client_name, brandIds: row.brand_ids },
    },
    grantId: row.grant_id,
    scope: row.scope,
    expiresAt: new Date(row.expires_at),
  };
}

// ───────────────────────────── connections, as people see them ─────────────────────────────

/** A grant is a connection while it stands and still has a refresh token that can be used. */
const LIVE = `g.revoked_at is null and g.connected_at is not null
  and exists (select 1 from mcp_token t where t.grant_id = g.id and t.kind = 'refresh' and t.used_at is null and t.revoked_at is null and t.expires_at > now())`;

/** The assistants a person has connected, with the brands each may use (those where they are still an active member). */
export async function myConnections(ctx: Ctx, userId: string) {
  const rows = await ctx.db.query(
    `select g.id, g.connected_at, g.last_used_at, c.name as client_name, c.client_uri, c.redirect_uris,
       coalesce((select json_agg(json_build_object('id', b.id, 'name', b.name) order by b.name)
                 from brand b join member m on m.brand_id = b.id and m.user_id = g.user_id and m.deactivated_at is null
                 where b.id = any(g.brand_ids)), '[]'::json) as brands
     from mcp_grant g join mcp_client c on c.id = g.client_id
     where g.user_id = $1 and ${LIVE} order by g.connected_at desc`,
    [userId],
  );
  return rows.map(({ redirect_uris, ...r }) => ({ ...r, redirect_host: hostOf(redirect_uris[0]) }));
}

const hostOf = (u: string | undefined) => {
  try {
    return u ? new URL(u).host : null;
  } catch {
    return null;
  }
};

/** The assistants connected to a brand, by whom. For its admins. */
export async function brandConnections(ctx: Ctx, p: Principal, brandId: string) {
  await authorize(ctx.db, p, brandId, 'brand.manage');
  const rows = await ctx.db.query(
    `select g.id, g.connected_at, g.last_used_at, c.name as client_name, c.redirect_uris, u.id as user_id, u.name as user_name, u.email as user_email,
       cardinality(g.brand_ids) - 1 as other_brands
     from mcp_grant g join mcp_client c on c.id = g.client_id join app_user u on u.id = g.user_id
     where $1 = any(g.brand_ids) and ${LIVE} order by u.email, g.connected_at desc`,
    [brandId],
  );
  return rows.map(({ redirect_uris, ...r }) => ({ ...r, redirect_host: hostOf(redirect_uris[0]) }));
}

/** The person disconnects one of their assistants: every token of it stops working at once. */
export async function disconnectMine(ctx: Ctx, p: Principal, grantId: string) {
  if (p.kind !== 'user' || p.via) throw new AppError(403, 'forbidden', msg('error.signedInOnly'));
  return ctx.db.tx(async (db) => {
    const g = await db.one<{ brand_ids: string[]; client_name: string }>(
      `select g.brand_ids, c.name as client_name from mcp_grant g join mcp_client c on c.id = g.client_id
       where g.id = $1 and g.user_id = $2 and g.revoked_at is null for update of g`,
      [grantId, p.userId],
    );
    if (!g) throw notFoundConnection();
    await revokeGrant(db, grantId, p.userId, 'revoked_by_person');
    for (const b of g.brand_ids) await audit(db, p, b, 'mcp.disconnected', 'mcp_grant', grantId, null, { client_name: g.client_name, reason: 'revoked_by_person' });
    return { id: grantId };
  });
}

/**
 * An admin takes a brand away from someone's assistant. If that was the only brand it had, the connection ends; otherwise it keeps the
 * other brands (which this admin may not manage) and loses this one, at once.
 */
export async function disconnectInBrand(ctx: Ctx, p: Principal, brandId: string, grantId: string) {
  return ctx.db.tx(async (db) => {
    await authorize(db, p, brandId, 'brand.manage');
    const g = await db.one<{ brand_ids: string[]; client_name: string; user_id: string; email: string }>(
      `select g.brand_ids, c.name as client_name, g.user_id, u.email from mcp_grant g join mcp_client c on c.id = g.client_id join app_user u on u.id = g.user_id
       where g.id = $1 and $2 = any(g.brand_ids) and g.revoked_at is null for update of g`,
      [grantId, brandId],
    );
    if (!g) throw notFoundConnection();
    const by = p.kind === 'user' ? p.userId : null;
    const ended = g.brand_ids.length === 1;
    if (ended) await revokeGrant(db, grantId, by, 'revoked_by_admin');
    else await db.query('update mcp_grant set brand_ids = array_remove(brand_ids, $2::uuid) where id = $1', [grantId, brandId]);
    await audit(db, p, brandId, 'mcp.disconnected', 'mcp_grant', grantId, null, { client_name: g.client_name, person: g.email, reason: 'revoked_by_admin', ended });
    return { id: grantId, ended };
  });
}

const notFoundConnection = () => new AppError(404, 'not_found', msg('mcp.connection.notFound'));
