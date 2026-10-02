import { createHash, randomBytes } from 'node:crypto';
import type { Actor, Env } from './helpers.js';

/** An assistant's side of the OAuth dance and of MCP calls, through the app itself (no network). */

export const REDIRECT = 'http://localhost:7777/callback';
export const RESOURCE = 'http://app.test/api/mcp';

export const pkce = () => {
  const verifier = randomBytes(32).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
};

/** A different address per call, so the per-address rate limits of the OAuth endpoints do not trip over the test's own volume. */
export const someone = () => `10.${(Math.random() * 250) | 0}.${(Math.random() * 250) | 0}.${1 + ((Math.random() * 250) | 0)}`;

export const formBody = (o: Record<string, string | undefined>) =>
  new URLSearchParams(Object.entries(o).filter(([, v]) => v !== undefined) as [string, string][]).toString();

export async function register(env: Env, body: Record<string, unknown> = {}) {
  const r = await env.app.inject({
    method: 'POST', url: '/api/mcp/oauth/register', remoteAddress: someone(),
    payload: { redirect_uris: [REDIRECT], client_name: 'Claude', token_endpoint_auth_method: 'none', ...body },
  });
  return { status: r.statusCode, body: JSON.parse(r.body) };
}

export async function authorizeUrl(env: Env, params: Record<string, string | undefined>) {
  const r = await env.app.inject({ method: 'GET', url: `/api/mcp/oauth/authorize?${formBody(params)}`, remoteAddress: someone() });
  return { status: r.statusCode, location: r.headers.location as string | undefined };
}

export async function token(env: Env, params: Record<string, string | undefined>, headers: Record<string, string> = {}) {
  const r = await env.app.inject({
    method: 'POST', url: '/api/mcp/oauth/token', remoteAddress: someone(),
    headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers }, payload: formBody(params),
  });
  return { status: r.statusCode, body: JSON.parse(r.body), headers: r.headers };
}

/** A call on a person's session, from an address of its own (the consent answer is rate limited per address). */
export async function asPerson(env: Env, user: Actor, method: string, url: string, body?: unknown) {
  const r = await env.app.inject({
    method: method as 'GET', url, remoteAddress: someone(),
    headers: { cookie: user.cookie!, 'x-requested-by': 'studio', 'accept-language': 'en' }, payload: body as object | undefined,
  });
  return { status: r.statusCode, body: r.body ? JSON.parse(r.body) : null };
}

export interface Connection {
  clientId: string;
  access: string;
  refresh: string;
  grantId: string;
}

/** Registers a client, has `user` say yes for `brandIds` (all of theirs in the test brand by default) and gets the first tokens. */
export async function connect(env: Env, user: Actor, o: { brandIds?: string[]; clientName?: string } = {}): Promise<Connection> {
  const reg = await register(env, { client_name: o.clientName ?? 'Claude' });
  if (reg.status !== 201) throw new Error(`register: ${JSON.stringify(reg.body)}`);
  const { verifier, challenge } = pkce();
  const auth = await authorizeUrl(env, {
    response_type: 'code', client_id: reg.body.client_id, redirect_uri: REDIRECT, code_challenge: challenge, code_challenge_method: 'S256',
    state: 'st-1', resource: RESOURCE,
  });
  const requestId = new URL(auth.location!).searchParams.get('request');
  if (!requestId) throw new Error(`authorize: ${auth.location}`);
  const details = await asPerson(env, user, 'GET', `/api/oauth-consent/${requestId}`);
  if (details.status !== 200) throw new Error(`consent: ${JSON.stringify(details.body)}`);
  const answer = await asPerson(env, user, 'POST', `/api/oauth-consent/${requestId}`, { allow: true, brandIds: o.brandIds ?? [env.brandId], nonce: details.body.nonce });
  if (answer.status !== 200) throw new Error(`answer: ${JSON.stringify(answer.body)}`);
  const code = new URL(answer.body.redirect).searchParams.get('code')!;
  const t = await token(env, { grant_type: 'authorization_code', code, code_verifier: verifier, client_id: reg.body.client_id, redirect_uri: REDIRECT, resource: RESOURCE });
  if (t.status !== 200) throw new Error(`token: ${JSON.stringify(t.body)}`);
  const grant = await env.db.one<{ id: string }>('select g.id from mcp_grant g join mcp_client c on c.id = g.client_id where c.client_id = $1', [reg.body.client_id]);
  return { clientId: reg.body.client_id, access: t.body.access_token, refresh: t.body.refresh_token, grantId: grant!.id };
}

let seq = 0;

/** A raw JSON-RPC request to the MCP endpoint. */
export async function rpc(env: Env, access: string | null, method: string, params: unknown = {}) {
  const r = await env.app.inject({
    method: 'POST', url: '/api/mcp',
    headers: {
      ...(access ? { authorization: `Bearer ${access}` } : {}),
      'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-11-25',
    },
    payload: { jsonrpc: '2.0', id: ++seq, method, params },
  });
  let body: any = null;
  try { body = r.body ? JSON.parse(r.body) : null; } catch { body = r.body; }
  return { status: r.statusCode, body, headers: r.headers };
}

/** Calls a tool and reads its answer: `{ ok: true, data }` or `{ ok: false, error: { code, message } }`. */
export async function tool(env: Env, access: string, name: string, args: Record<string, unknown> = {}) {
  const r = await rpc(env, access, 'tools/call', { name, arguments: args });
  if (r.status !== 200) throw new Error(`tools/call ${name}: HTTP ${r.status} ${JSON.stringify(r.body)}`);
  if (r.body.error) throw new Error(`tools/call ${name}: ${JSON.stringify(r.body.error)}`);
  const result = r.body.result;
  let parsed: any;
  try { parsed = JSON.parse(result.content[0].text); } catch { parsed = { error: { code: 'invalid_arguments', message: result.content[0].text } }; }
  return result.isError ? { ok: false as const, error: parsed.error as { code: string; message: string; details?: any }, data: null as any } : { ok: true as const, data: parsed as any, error: null as any };
}
