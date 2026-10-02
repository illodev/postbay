import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createEnv, type Env } from './helpers.js';
import { authorizeUrl, connect, formBody, pkce, REDIRECT, register, RESOURCE, rpc, token, tool } from './mcp-helpers.js';

let env: Env;
beforeAll(async () => { env = await createEnv(); });
afterAll(async () => { await env.close(); });

const consentOf = (location: string | undefined) => new URL(location!, 'http://app.test');

describe('discovery', () => {
  it('serves the protected-resource and authorization-server metadata, open to any origin', async () => {
    for (const url of ['/.well-known/oauth-protected-resource/api/mcp', '/.well-known/oauth-protected-resource']) {
      const r = await env.app.inject({ method: 'GET', url });
      expect(r.statusCode).toBe(200);
      expect(r.headers['access-control-allow-origin']).toBe('*');
      expect(JSON.parse(r.body)).toMatchObject({ resource: RESOURCE, authorization_servers: ['http://app.test'], bearer_methods_supported: ['header'] });
    }
    const as = await env.app.inject({ method: 'GET', url: '/.well-known/oauth-authorization-server' });
    expect(JSON.parse(as.body)).toMatchObject({
      issuer: 'http://app.test',
      authorization_endpoint: 'http://app.test/api/mcp/oauth/authorize',
      token_endpoint: 'http://app.test/api/mcp/oauth/token',
      registration_endpoint: 'http://app.test/api/mcp/oauth/register',
      revocation_endpoint: 'http://app.test/api/mcp/oauth/revoke',
      code_challenge_methods_supported: ['S256'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      response_types_supported: ['code'],
    });
    const pre = await env.app.inject({ method: 'OPTIONS', url: '/api/mcp', headers: { origin: 'https://inspector.example', 'access-control-request-method': 'POST' } });
    expect(pre.statusCode).toBe(204);
    expect(pre.headers['access-control-allow-headers']).toContain('authorization');
    expect(pre.headers['access-control-expose-headers']).toContain('www-authenticate');
    expect(pre.headers['access-control-allow-credentials']).toBeUndefined();
  });

  it('answers the MCP endpoint without a token with 401 and where to find the metadata', async () => {
    const r = await rpc(env, null, 'tools/list');
    expect(r.status).toBe(401);
    expect(r.headers['www-authenticate']).toBe('Bearer resource_metadata="http://app.test/.well-known/oauth-protected-resource/api/mcp"');
    const bad = await rpc(env, 'pba_not-a-token', 'tools/list');
    expect(bad.status).toBe(401);
    expect(bad.headers['www-authenticate']).toContain('error="invalid_token"');
    // A producer token is not an assistant's token, and a browser session does not open it either.
    const tok = await env.call(env.users.admin, 'POST', `/api/brands/${env.brandId}/tokens`, { name: 'agent' });
    expect((await rpc(env, tok.body.token, 'tools/list')).status).toBe(401);
    const viaCookie = await env.app.inject({ method: 'POST', url: '/api/mcp', headers: { cookie: env.users.admin.cookie!, 'x-requested-by': 'studio', 'content-type': 'application/json' }, payload: { jsonrpc: '2.0', id: 1, method: 'tools/list' } });
    expect(viaCookie.statusCode).toBe(401);
  });
});

describe('registering a client', () => {
  it('takes https and localhost redirect URIs only, and gives a secret only to a confidential client', async () => {
    for (const uri of ['http://evil.example/cb', 'https://claude.ai/cb#frag', 'javascript:alert(1)', 'https://user:pw@claude.ai/cb', 'myapp://cb']) {
      const r = await register(env, { redirect_uris: [uri] });
      expect(r.status, uri).toBe(400);
      expect(r.body.error).toBe('invalid_redirect_uri');
    }
    const pub = await register(env, { redirect_uris: ['https://claude.ai/api/mcp/auth_callback', 'http://127.0.0.1:5555/cb'] });
    expect(pub.status).toBe(201);
    expect(pub.body).toMatchObject({ client_name: 'Claude', token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'] });
    expect(pub.body.client_secret).toBeUndefined();
    const conf = await register(env, { token_endpoint_auth_method: 'client_secret_basic' });
    expect(conf.body.client_secret).toMatch(/^pbs_/);
    expect((await register(env, { grant_types: ['client_credentials'] })).body.error).toBe('invalid_client_metadata');
    expect((await register(env, { redirect_uris: [] })).body.error).toBe('invalid_client_metadata');
    // Control characters do not reach the consent page.
    expect((await register(env, { client_name: 'Cla\u0000ude\n' })).body.client_name).toBe('Claude');
    // Only the hash of the secret is kept.
    const row = await env.db.one('select secret_hash from mcp_client where client_id = $1', [conf.body.client_id]);
    expect(row!.secret_hash).not.toContain(conf.body.client_secret);
    expect(row!.secret_hash).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('rate limits', () => {
  it('apply per address to registration and to the token endpoint', async () => {
    const from = '10.250.250.250';
    const codes: number[] = [];
    for (let i = 0; i < 11; i++) {
      codes.push((await env.app.inject({ method: 'POST', url: '/api/mcp/oauth/register', remoteAddress: from, payload: { redirect_uris: [REDIRECT], token_endpoint_auth_method: 'none' } })).statusCode);
    }
    expect(codes.slice(0, 10).every((c) => c === 201)).toBe(true);
    expect(codes[10]).toBe(429);
    const tokenCodes: number[] = [];
    for (let i = 0; i < 31; i++) {
      tokenCodes.push((await env.app.inject({ method: 'POST', url: '/api/mcp/oauth/token', remoteAddress: from, headers: { 'content-type': 'application/x-www-form-urlencoded' }, payload: 'grant_type=refresh_token' })).statusCode);
    }
    expect(tokenCodes[30]).toBe(429);
    // Another address is not held up by that one.
    expect((await register(env)).status).toBe(201);
  });
});

describe('the authorization request', () => {
  it('never sends anything to a redirect URI it does not know, and answers everything else to the client', async () => {
    const reg = await register(env);
    const { challenge } = pkce();
    const good = { response_type: 'code', client_id: reg.body.client_id, redirect_uri: REDIRECT, code_challenge: challenge, code_challenge_method: 'S256', state: 'xyz', resource: RESOURCE };

    const unknown = await authorizeUrl(env, { ...good, client_id: 'pbc_nope' });
    expect(consentOf(unknown.location).pathname).toBe('/oauth/consent');
    expect(consentOf(unknown.location).searchParams.get('error')).toBe('invalid_client');
    for (const redirect_uri of ['http://localhost:7777/callback/', 'http://localhost:7777/other', 'http://LOCALHOST:7777/callback']) {
      const r = await authorizeUrl(env, { ...good, redirect_uri });
      expect(consentOf(r.location).origin).toBe('http://app.test');
      expect(consentOf(r.location).searchParams.get('error')).toBe('invalid_redirect_uri');
    }

    const back = async (params: Record<string, string | undefined>) => new URL((await authorizeUrl(env, params)).location!);
    const noPkce = await back({ ...good, code_challenge: undefined });
    expect(noPkce.origin + noPkce.pathname).toBe(REDIRECT);
    expect(noPkce.searchParams.get('error')).toBe('invalid_request');
    expect(noPkce.searchParams.get('state')).toBe('xyz');
    expect(noPkce.searchParams.get('iss')).toBe('http://app.test');
    expect((await back({ ...good, code_challenge_method: 'plain' })).searchParams.get('error')).toBe('invalid_request');
    expect((await back({ ...good, code_challenge_method: undefined })).searchParams.get('error')).toBe('invalid_request');
    expect((await back({ ...good, response_type: 'token' })).searchParams.get('error')).toBe('unsupported_response_type');
    expect((await back({ ...good, resource: 'https://other.example/mcp' })).searchParams.get('error')).toBe('invalid_target');

    const ok = await authorizeUrl(env, good);
    expect(ok.status).toBe(302);
    expect(consentOf(ok.location).searchParams.get('request')).toMatch(/^[0-9a-f-]{36}$/);
  });
});

/** Up to the person's answer: the request id and the PKCE verifier. */
async function ask(state = 's') {
  const reg = await register(env);
  const { verifier, challenge } = pkce();
  const r = await authorizeUrl(env, { response_type: 'code', client_id: reg.body.client_id, redirect_uri: REDIRECT, code_challenge: challenge, code_challenge_method: 'S256', state, resource: RESOURCE });
  return { clientId: reg.body.client_id as string, verifier, requestId: consentOf(r.location).searchParams.get('request')! };
}

describe('the consent page', () => {
  it('needs the person signed in, shows the client and where it answers, and belongs to whoever opened it first', async () => {
    const { requestId } = await ask();
    expect((await env.call(null, 'GET', `/api/oauth-consent/${requestId}`)).status).toBe(401);
    const d = await env.call(env.users.reviewer, 'GET', `/api/oauth-consent/${requestId}`);
    expect(d.status).toBe(200);
    expect(d.body.client).toMatchObject({ name: 'Claude', redirect_host: 'localhost:7777', local: true });
    expect(d.body.brands).toEqual([expect.objectContaining({ id: env.brandId, role: 'reviewer', can_approve: false })]);
    // Someone else cannot open or answer it.
    expect((await env.call(env.users.approver, 'GET', `/api/oauth-consent/${requestId}`)).status).toBe(404);
    expect((await env.call(env.users.approver, 'POST', `/api/oauth-consent/${requestId}`, { allow: true, brandIds: [env.brandId], nonce: d.body.nonce })).status).toBe(404);
    // Without the page's nonce, or without the header that says it comes from the web, nothing happens.
    expect((await env.call(env.users.reviewer, 'POST', `/api/oauth-consent/${requestId}`, { allow: true, brandIds: [env.brandId], nonce: 'x'.repeat(43) })).body.error.code).toBe('request_stale');
    const csrf = await env.app.inject({ method: 'POST', url: `/api/oauth-consent/${requestId}`, headers: { cookie: env.users.reviewer.cookie! }, payload: { allow: true, brandIds: [env.brandId], nonce: d.body.nonce } });
    expect(csrf.statusCode).toBe(403);
    // Only brands the person is an active member of.
    const other = (await env.db.one<{ id: string }>(`insert into brand (workspace_id, name, timezone) values ($1,'Other','Europe/Madrid') returning id`, [env.workspaceId]))!.id;
    expect((await env.call(env.users.reviewer, 'POST', `/api/oauth-consent/${requestId}`, { allow: true, brandIds: [other], nonce: d.body.nonce })).body.error.code).toBe('no_brands');
    expect((await env.call(env.users.reviewer, 'POST', `/api/oauth-consent/${requestId}`, { allow: true, brandIds: [], nonce: d.body.nonce })).body.error.code).toBe('no_brands');
  });

  it('says no to the client with its state, and the request cannot be answered twice', async () => {
    const { requestId } = await ask('st-deny');
    const d = await env.call(env.users.reader, 'GET', `/api/oauth-consent/${requestId}`);
    const no = await env.call(env.users.reader, 'POST', `/api/oauth-consent/${requestId}`, { allow: false, nonce: d.body.nonce });
    const to = new URL(no.body.redirect);
    expect(to.origin + to.pathname).toBe(REDIRECT);
    expect(to.searchParams.get('error')).toBe('access_denied');
    expect(to.searchParams.get('state')).toBe('st-deny');
    expect(to.searchParams.get('code')).toBeNull();
    expect((await env.call(env.users.reader, 'POST', `/api/oauth-consent/${requestId}`, { allow: true, brandIds: [env.brandId], nonce: d.body.nonce })).status).toBe(404);
  });

  it('expires after a few minutes', async () => {
    const { requestId } = await ask();
    await env.db.query(`update mcp_authorization set expires_at = now() - interval '1 second' where id = $1`, [requestId]);
    expect((await env.call(env.users.reader, 'GET', `/api/oauth-consent/${requestId}`)).body.error.code).toBe('request_gone');
  });
});

describe('the token endpoint', () => {
  async function codeFor(user = env.users.reviewer, state = 's') {
    const a = await ask(state);
    const d = await env.call(user, 'GET', `/api/oauth-consent/${a.requestId}`);
    const yes = await env.call(user, 'POST', `/api/oauth-consent/${a.requestId}`, { allow: true, brandIds: [env.brandId], nonce: d.body.nonce });
    const to = new URL(yes.body.redirect);
    expect(to.searchParams.get('state')).toBe(state);
    expect(to.searchParams.get('iss')).toBe('http://app.test');
    return { ...a, code: to.searchParams.get('code')! };
  }

  it('gives tokens only for the right PKCE verifier and redirect URI, and a code only once', async () => {
    const c = await codeFor();
    const base = { grant_type: 'authorization_code', code: c.code, client_id: c.clientId, redirect_uri: REDIRECT, resource: RESOURCE };
    const wrong = await token(env, { ...base, code_verifier: pkce().verifier });
    expect(wrong.status).toBe(400);
    expect(wrong.body.error).toBe('invalid_grant');
    // A failed attempt spends the code: the right verifier afterwards is refused too.
    expect((await token(env, { ...base, code_verifier: c.verifier })).body.error).toBe('invalid_grant');

    const c2 = await codeFor();
    const base2 = { grant_type: 'authorization_code', code: c2.code, client_id: c2.clientId, code_verifier: c2.verifier, resource: RESOURCE };
    expect((await token(env, { ...base2, redirect_uri: 'http://localhost:7777/elsewhere' })).body.error).toBe('invalid_grant');

    const c3 = await codeFor();
    const base3 = { grant_type: 'authorization_code', code: c3.code, client_id: c3.clientId, code_verifier: c3.verifier, redirect_uri: REDIRECT, resource: RESOURCE };
    expect((await token(env, { ...base3, client_id: (await register(env)).body.client_id })).body.error).toBe('invalid_grant');
    expect((await token(env, { ...base3, resource: 'https://other.example/mcp' })).body.error).toBe('invalid_target');
    const ok = await token(env, base3);
    expect(ok.status).toBe(200);
    expect(ok.headers['cache-control']).toBe('no-store');
    expect(ok.body).toMatchObject({ token_type: 'Bearer', expires_in: 1800 });
    expect(ok.body.access_token).toMatch(/^pba_/);
    expect(ok.body.refresh_token).toMatch(/^pbr_/);
    expect((await tool(env, ok.body.access_token, 'list_brands')).data.brands).toHaveLength(1);

    // The same code again: refused, and what it gave is taken back.
    const again = await token(env, base3);
    expect(again.body.error).toBe('invalid_grant');
    expect((await rpc(env, ok.body.access_token, 'tools/list')).status).toBe(401);
  });

  it('expires codes after two minutes', async () => {
    const c = await codeFor();
    await env.db.query(`update mcp_code set expires_at = now() - interval '1 second'`);
    expect((await token(env, { grant_type: 'authorization_code', code: c.code, client_id: c.clientId, code_verifier: c.verifier, redirect_uri: REDIRECT })).body.error).toBe('invalid_grant');
  });

  it('rotates refresh tokens, and a reused one ends the whole connection', async () => {
    const conn = await connect(env, env.users.reviewer);
    const r1 = await token(env, { grant_type: 'refresh_token', refresh_token: conn.refresh, client_id: conn.clientId, resource: RESOURCE });
    expect(r1.status).toBe(200);
    expect(r1.body.refresh_token).not.toBe(conn.refresh);
    expect(r1.body.access_token).not.toBe(conn.access);
    expect((await tool(env, r1.body.access_token, 'list_brands')).ok).toBe(true);
    // Another client cannot use it.
    expect((await token(env, { grant_type: 'refresh_token', refresh_token: r1.body.refresh_token, client_id: (await register(env)).body.client_id })).body.error).toBe('invalid_grant');

    // The first refresh token, already exchanged, comes back: someone else has it. Everything of that grant stops.
    const replay = await token(env, { grant_type: 'refresh_token', refresh_token: conn.refresh, client_id: conn.clientId });
    expect(replay.body.error).toBe('invalid_grant');
    expect((await rpc(env, r1.body.access_token, 'tools/list')).status).toBe(401);
    expect((await rpc(env, conn.access, 'tools/list')).status).toBe(401);
    expect((await token(env, { grant_type: 'refresh_token', refresh_token: r1.body.refresh_token, client_id: conn.clientId })).body.error).toBe('invalid_grant');
    const g = await env.db.one('select revoked_reason from mcp_grant where id = $1', [conn.grantId]);
    expect(g!.revoked_reason).toBe('refresh_reused');
  });

  it('authenticates confidential clients with their secret, in the body or with Basic', async () => {
    const reg = await register(env, { token_endpoint_auth_method: 'client_secret_basic' });
    const { verifier, challenge } = pkce();
    const r = await authorizeUrl(env, { response_type: 'code', client_id: reg.body.client_id, redirect_uri: REDIRECT, code_challenge: challenge, code_challenge_method: 'S256', resource: RESOURCE });
    const requestId = consentOf(r.location).searchParams.get('request')!;
    const d = await env.call(env.users.reader, 'GET', `/api/oauth-consent/${requestId}`);
    const yes = await env.call(env.users.reader, 'POST', `/api/oauth-consent/${requestId}`, { allow: true, brandIds: [env.brandId], nonce: d.body.nonce });
    const code = new URL(yes.body.redirect).searchParams.get('code')!;
    const base = { grant_type: 'authorization_code', code, code_verifier: verifier, redirect_uri: REDIRECT };
    const noSecret = await token(env, { ...base, client_id: reg.body.client_id });
    expect(noSecret.status).toBe(401);
    expect(noSecret.body.error).toBe('invalid_client');
    expect((await token(env, { ...base, client_id: reg.body.client_id, client_secret: 'pbs_wrong' })).status).toBe(401);
    const basic = Buffer.from(`${encodeURIComponent(reg.body.client_id)}:${encodeURIComponent(reg.body.client_secret)}`).toString('base64');
    const ok = await token(env, base, { authorization: `Basic ${basic}` });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
  });

  it('refuses other grant types and keeps only hashes', async () => {
    const reg = await register(env);
    expect((await token(env, { grant_type: 'client_credentials', client_id: reg.body.client_id })).body.error).toBe('unsupported_grant_type');
    expect((await token(env, { grant_type: 'authorization_code', client_id: 'pbc_unknown', code: 'x', code_verifier: 'y' })).body.error).toBe('invalid_client');
    const conn = await connect(env, env.users.reader);
    const tokens = await env.db.query<{ token_hash: string }>('select token_hash from mcp_token where grant_id = $1', [conn.grantId]);
    expect(tokens.length).toBe(2);
    for (const t of tokens) {
      expect(t.token_hash).toMatch(/^[0-9a-f]{64}$/);
      expect([conn.access, conn.refresh]).not.toContain(t.token_hash);
    }
    const dump = JSON.stringify(await env.db.query('select * from mcp_token')) + JSON.stringify(await env.db.query('select * from mcp_code'));
    expect(dump).not.toContain(conn.access);
    expect(dump).not.toContain(conn.refresh);
  });
});

describe('access tokens', () => {
  it('are short-lived', async () => {
    const conn = await connect(env, env.users.reader);
    expect((await rpc(env, conn.access, 'tools/list')).status).toBe(200);
    await env.db.query(`update mcp_token set expires_at = now() - interval '1 second' where grant_id = $1 and kind = 'access'`, [conn.grantId]);
    const r = await rpc(env, conn.access, 'tools/list');
    expect(r.status).toBe(401);
    expect(r.headers['www-authenticate']).toContain('invalid_token');
  });

  it('are bound to this MCP endpoint: a grant for another resource is not accepted here', async () => {
    const conn = await connect(env, env.users.reader);
    await env.db.query(`update mcp_grant set resource = 'https://other.example/mcp' where id = $1`, [conn.grantId]);
    expect((await rpc(env, conn.access, 'tools/list')).status).toBe(401);
  });

  it('are not accepted anywhere else in the API', async () => {
    const conn = await connect(env, env.users.admin);
    expect((await env.call({ id: 'x', email: 'x', bearer: conn.access }, 'GET', `/api/brands/${env.brandId}`)).status).toBe(401);
    expect((await env.call({ id: 'x', email: 'x', bearer: conn.access }, 'GET', '/api/me')).status).toBe(401);
  });
});

describe('revoking', () => {
  it('by the client (RFC 7009): a refresh token ends the connection at once, an access token just itself', async () => {
    const conn = await connect(env, env.users.reviewer);
    const revoke = (t: string, clientId = conn.clientId) => env.app.inject({ method: 'POST', url: '/api/mcp/oauth/revoke', headers: { 'content-type': 'application/x-www-form-urlencoded' }, payload: formBody({ token: t, client_id: clientId }) });
    // Another client's revocation of it does nothing (and says nothing).
    expect((await revoke(conn.refresh, (await register(env)).body.client_id)).statusCode).toBe(200);
    expect((await rpc(env, conn.access, 'tools/list')).status).toBe(200);
    expect((await revoke(conn.access)).statusCode).toBe(200);
    expect((await rpc(env, conn.access, 'tools/list')).status).toBe(401);
    const fresh = await token(env, { grant_type: 'refresh_token', refresh_token: conn.refresh, client_id: conn.clientId });
    expect(fresh.status).toBe(200);
    expect((await revoke(fresh.body.refresh_token)).statusCode).toBe(200);
    expect((await rpc(env, fresh.body.access_token, 'tools/list')).status).toBe(401);
    expect((await revoke('pbr_unknown')).statusCode).toBe(200);
  });

  it('by the person, from their page: the assistant stops at once', async () => {
    const conn = await connect(env, env.users.producer, { clientName: 'Claude Desktop' });
    const mine = await env.call(env.users.producer, 'GET', '/api/me/assistants');
    expect(mine.body.server_url).toBe(RESOURCE);
    const row = mine.body.connections.find((c: any) => c.id === conn.grantId);
    expect(row).toMatchObject({ client_name: 'Claude Desktop', redirect_host: 'localhost:7777', brands: [{ id: env.brandId, name: 'Test brand' }] });
    // Nobody else can disconnect it from their own page.
    expect((await env.call(env.users.reader, 'DELETE', `/api/me/assistants/${conn.grantId}`)).status).toBe(404);
    expect((await env.call(env.users.producer, 'DELETE', `/api/me/assistants/${conn.grantId}`)).status).toBe(200);
    expect((await rpc(env, conn.access, 'tools/list')).status).toBe(401);
    expect((await token(env, { grant_type: 'refresh_token', refresh_token: conn.refresh, client_id: conn.clientId })).body.error).toBe('invalid_grant');
    expect((await env.call(env.users.producer, 'GET', '/api/me/assistants')).body.connections.some((c: any) => c.id === conn.grantId)).toBe(false);
    const trail = await env.db.query(`select action, actor_user_id, after from audit_event where entity = 'mcp_grant' and entity_id = $1 order by id`, [conn.grantId]);
    expect(trail.map((t) => t.action)).toEqual(['mcp.authorized', 'mcp.disconnected']);
    expect(trail[1]!.after).toMatchObject({ client_name: 'Claude Desktop', reason: 'revoked_by_person' });
  });

  it('by an admin, for their brand: listed with whose it is, and refused to anyone who does not manage the brand', async () => {
    const conn = await connect(env, env.users.approver);
    const list = await env.call(env.users.admin, 'GET', `/api/brands/${env.brandId}/assistants`);
    expect(list.body).toMatchObject({ server_url: RESOURCE, settings: { allow_approval: false } });
    expect(list.body.connections.find((c: any) => c.id === conn.grantId)).toMatchObject({ client_name: 'Claude', user_email: 'approver@example.com', other_brands: 0 });
    expect((await env.call(env.users.approver, 'GET', `/api/brands/${env.brandId}/assistants`)).status).toBe(403);
    expect((await env.call(env.users.approver, 'DELETE', `/api/brands/${env.brandId}/assistants/${conn.grantId}`)).status).toBe(403);
    const off = await env.call(env.users.admin, 'DELETE', `/api/brands/${env.brandId}/assistants/${conn.grantId}`);
    expect(off.body).toMatchObject({ ended: true });
    expect((await rpc(env, conn.access, 'tools/list')).status).toBe(401);
  });

  it('connecting the same assistant again replaces the previous connection', async () => {
    const first = await connect(env, env.users.approver2);
    const reg = await env.db.one<{ client_id: string }>('select c.client_id from mcp_client c join mcp_grant g on g.client_id = c.id where g.id = $1', [first.grantId]);
    // Same client, a second consent and code.
    const { verifier, challenge } = pkce();
    const r = await authorizeUrl(env, { response_type: 'code', client_id: reg!.client_id, redirect_uri: REDIRECT, code_challenge: challenge, code_challenge_method: 'S256', resource: RESOURCE });
    const requestId = consentOf(r.location).searchParams.get('request')!;
    const d = await env.call(env.users.approver2, 'GET', `/api/oauth-consent/${requestId}`);
    const yes = await env.call(env.users.approver2, 'POST', `/api/oauth-consent/${requestId}`, { allow: true, brandIds: [env.brandId], nonce: d.body.nonce });
    const code = new URL(yes.body.redirect).searchParams.get('code')!;
    const second = await token(env, { grant_type: 'authorization_code', code, code_verifier: verifier, client_id: reg!.client_id, redirect_uri: REDIRECT });
    expect(second.status).toBe(200);
    expect((await rpc(env, first.access, 'tools/list')).status).toBe(401);
    expect((await rpc(env, second.body.access_token, 'tools/list')).status).toBe(200);
    expect((await env.call(env.users.approver2, 'GET', '/api/me/assistants')).body.connections).toHaveLength(1);
  });
});

describe('a deactivated member', () => {
  it('loses the brand through the assistant at once, and gets it back on reactivation', async () => {
    const conn = await connect(env, env.users.reader);
    expect((await tool(env, conn.access, 'list_pieces')).ok).toBe(true);
    const memberId = (await env.db.one<{ id: string }>('select id from member where user_id = $1 and brand_id = $2', [env.users.reader.id, env.brandId]))!.id;
    expect((await env.call(env.users.admin, 'POST', `/api/brands/${env.brandId}/members/${memberId}/deactivate`)).status).toBe(200);
    const listed = await tool(env, conn.access, 'list_brands');
    expect(listed.data.brands).toEqual([]);
    const byName = await tool(env, conn.access, 'list_pieces');
    expect(byName.ok).toBe(false);
    expect(byName.error.code).toBe('no_brands');
    const byId = await tool(env, conn.access, 'list_pieces', { brand: env.brandId });
    expect(byId.error.code).toBe('member_deactivated');
    const { pieceId } = await env.makePiece(env.users.producer);
    expect((await tool(env, conn.access, 'get_piece', { piece_id: pieceId })).error.code).toBe('member_deactivated');
    expect((await env.call(env.users.admin, 'POST', `/api/brands/${env.brandId}/members/${memberId}/reactivate`)).status).toBe(200);
    expect((await tool(env, conn.access, 'get_piece', { piece_id: pieceId })).ok).toBe(true);
  });
});
