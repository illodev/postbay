import { createHash } from 'node:crypto';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Ctx } from '../context.js';
import { forbidden } from '../errors.js';
import { requirePrincipal } from '../http.js';
import { msg } from '../i18n/index.js';
import * as oauth from '../mcp/oauth.js';
import { mcpOf } from '../mcp/settings.js';
import { buildMcpServer } from '../mcp/tools.js';
import { loadBrand } from '../services/loaders.js';
import { personLocale } from '../services/notify.js';
import { authorize } from '../auth/principal.js';

/**
 * The MCP endpoint and everything around it (src/mcp/):
 *
 *  - discovery: `/.well-known/oauth-protected-resource[/api/mcp]` (RFC 9728) and `/.well-known/oauth-authorization-server` (RFC 8414);
 *  - the OAuth endpoints a client calls: register, authorize (a browser is sent there), token and revoke, under /api/mcp/oauth;
 *  - the MCP endpoint itself, `POST /api/mcp` (Streamable HTTP, stateless: every request carries its bearer token);
 *  - for the web: the consent page's API and the lists of connected assistants, on the person's session like any other page.
 *
 * What a client calls is open to any origin (CORS without credentials): browser-based MCP clients need it, and nothing there is reached
 * by a cookie, only by a token the client holds. The web's own API, its cookies and its CSP are unchanged.
 */
export async function mcpRoutes(app: FastifyInstance, ctx: Ctx) {
  const e = oauth.endpoints(ctx);

  // OAuth clients send their requests as forms.
  app.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string', bodyLimit: 64 * 1024 }, (_req, body, done) => {
    done(null, Object.fromEntries(new URLSearchParams(body as string)));
  });

  const cors = (reply: FastifyReply) =>
    reply
      .header('access-control-allow-origin', '*')
      .header('access-control-allow-methods', 'GET, POST, DELETE, OPTIONS')
      .header('access-control-allow-headers', 'authorization, content-type, accept, mcp-protocol-version, mcp-session-id, last-event-id')
      .header('access-control-expose-headers', 'www-authenticate, mcp-session-id, mcp-protocol-version')
      .header('access-control-max-age', '600');

  const open = [
    '/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/api/mcp', '/.well-known/oauth-authorization-server',
    '/api/mcp/oauth/register', '/api/mcp/oauth/token', '/api/mcp/oauth/revoke', '/api/mcp',
  ];
  for (const path of open) app.options(path, async (_req, reply) => cors(reply).code(204).send());
  // Set before anything else runs, so an answer that never reaches a handler (a rate limit, a body that does not parse) carries them too.
  const openPaths = new Set(open);
  app.addHook('onRequest', async (req, reply) => {
    if (openPaths.has(req.url.split('?')[0]!)) cors(reply);
  });

  // ───────────────────────────── discovery ─────────────────────────────

  const resourceMetadata = async (_req: FastifyRequest, reply: FastifyReply) =>
    cors(reply).header('cache-control', 'public, max-age=300').send(oauth.protectedResourceMetadata(ctx));
  app.get('/.well-known/oauth-protected-resource/api/mcp', resourceMetadata);
  app.get('/.well-known/oauth-protected-resource', resourceMetadata);
  app.get('/.well-known/oauth-authorization-server', async (_req, reply) =>
    cors(reply).header('cache-control', 'public, max-age=300').send(oauth.authorizationServerMetadata(ctx)));

  // ───────────────────────────── the OAuth endpoints ─────────────────────────────

  const oauthFail = (reply: FastifyReply, err: unknown) => {
    if (!(err instanceof oauth.OAuthError)) throw err;
    if (err.status === 401) reply.header('www-authenticate', 'Basic realm="postbay"');
    return reply.code(err.status).header('cache-control', 'no-store').send({ error: err.error, error_description: err.description });
  };
  const form = (req: FastifyRequest) => (req.body && typeof req.body === 'object' ? (req.body as Record<string, unknown>) : {});

  app.post('/api/mcp/oauth/register', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req, reply) => {
    cors(reply);
    try {
      return reply.code(201).header('cache-control', 'no-store').send(await oauth.registerClient(ctx, req.body));
    } catch (err) {
      return oauthFail(reply, err);
    }
  });

  // A browser is sent here by the assistant; it goes on to the consent page (or back to the assistant with an error).
  app.get('/api/mcp/oauth/authorize', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (req, reply) =>
    reply.header('cache-control', 'no-store').redirect(await oauth.startAuthorization(ctx, (req.query ?? {}) as Record<string, unknown>)));

  app.post('/api/mcp/oauth/token', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (req, reply) => {
    cors(reply).header('cache-control', 'no-store').header('pragma', 'no-cache');
    try {
      return reply.send(await oauth.token(ctx, form(req), req.headers.authorization));
    } catch (err) {
      return oauthFail(reply, err);
    }
  });

  app.post('/api/mcp/oauth/revoke', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (req, reply) => {
    cors(reply).header('cache-control', 'no-store');
    try {
      await oauth.revokeByClient(ctx, form(req), req.headers.authorization);
      return reply.code(200).send({});
    } catch (err) {
      return oauthFail(reply, err);
    }
  });

  // ───────────────────────────── the MCP endpoint ─────────────────────────────

  const bearerOf = (req: FastifyRequest) => /^Bearer\s+(\S+)$/i.exec(req.headers.authorization ?? '')?.[1];
  const challenge = (reply: FastifyReply, invalid: boolean) => {
    const parts = [`resource_metadata="${e.resourceMetadata}"`];
    if (invalid) parts.push('error="invalid_token"', 'error_description="The access token is missing, expired or revoked"');
    return reply.code(401).header('www-authenticate', `Bearer ${parts.join(', ')}`)
      .send({ error: { code: 'unauthorized', message: 'Sign in through your assistant to use Postbay (OAuth)' } });
  };
  // One limit per connection rather than per address: many people's assistants may call from the same few servers.
  const perToken = { max: 240, timeWindow: '1 minute', keyGenerator: (req: FastifyRequest) => {
    const b = bearerOf(req);
    return b ? `mcp:${createHash('sha256').update(b).digest('hex')}` : `mcp-ip:${req.ip}`;
  } };

  app.post('/api/mcp', { config: { rateLimit: perToken } }, async (req, reply) => {
    cors(reply);
    const bearer = bearerOf(req);
    const caller = bearer ? await oauth.callerOf(ctx, bearer) : null;
    if (!bearer || !caller) return challenge(reply, !!bearer);
    const locale = await personLocale(ctx.db, caller.principal.userId);
    const server = buildMcpServer(ctx, caller, locale);
    // Stateless: a new transport per request, answering in JSON. Nothing is kept between requests but the token.
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    await server.connect(transport);
    try {
      const headers = new Headers();
      for (const [k, v] of Object.entries(req.headers)) {
        if (v === undefined) continue;
        for (const one of Array.isArray(v) ? v : [v]) headers.append(k, one);
      }
      const res = await transport.handleRequest(new Request(`${e.issuer}${req.url}`, { method: 'POST', headers }), {
        parsedBody: req.body,
        authInfo: { token: bearer, clientId: caller.principal.via.clientId, scopes: [], expiresAt: Math.floor(caller.expiresAt.getTime() / 1000) },
      });
      reply.code(res.status);
      res.headers.forEach((value, key) => {
        if (key !== 'content-length') reply.header(key, value);
      });
      const text = await res.text();
      return reply.send(text);
    } finally {
      await transport.close().catch(() => {});
      await server.close().catch(() => {});
    }
  });

  // No server-sent stream and no sessions: GET and DELETE are not offered (once the token is good, so discovery still works).
  const notOffered = async (req: FastifyRequest, reply: FastifyReply) => {
    cors(reply);
    const bearer = bearerOf(req);
    if (!bearer || !(await oauth.callerOf(ctx, bearer))) return challenge(reply, !!bearer);
    return reply.code(405).header('allow', 'POST').send({ error: { code: 'method_not_allowed', message: 'This server answers POST only (no stream, no sessions)' } });
  };
  app.get('/api/mcp', { config: { rateLimit: perToken } }, notOffered);
  app.delete('/api/mcp', { config: { rateLimit: perToken } }, notOffered);

  // ───────────────────────────── for the web, on the person's session ─────────────────────────────

  /** A person in the browser: an assistant's token never reaches these (they are not under /api/mcp, and take a cookie). */
  const person = (req: FastifyRequest) => {
    const p = requirePrincipal(req);
    if (p.kind !== 'user' || p.via) throw forbidden(msg('error.signedInOnly'));
    return p;
  };
  const uuid = (req: FastifyRequest, name: string) => z.string().uuid().parse((req.params as Record<string, string>)[name]);

  app.get('/api/oauth-consent/:id', async (req, reply) =>
    reply.header('cache-control', 'no-store').send(await oauth.consentDetails(ctx, person(req).userId, uuid(req, 'id'))));
  app.post('/api/oauth-consent/:id', { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (req, reply) =>
    reply.header('cache-control', 'no-store').send(await oauth.answerConsent(ctx, person(req), uuid(req, 'id'), req.body)));

  app.get('/api/me/assistants', async (req) => ({ server_url: e.resource, connections: await oauth.myConnections(ctx, person(req).userId) }));
  app.delete('/api/me/assistants/:grantId', async (req) => oauth.disconnectMine(ctx, person(req), uuid(req, 'grantId')));

  app.get('/api/brands/:brandId/assistants', async (req) => {
    const p = person(req);
    const brandId = uuid(req, 'brandId');
    await authorize(ctx.db, p, brandId, 'brand.manage');
    return { server_url: e.resource, settings: mcpOf(await loadBrand(ctx.db, brandId)), connections: await oauth.brandConnections(ctx, p, brandId) };
  });
  app.delete('/api/brands/:brandId/assistants/:grantId', async (req) =>
    oauth.disconnectInBrand(ctx, person(req), uuid(req, 'brandId'), uuid(req, 'grantId')));
}

/** Paths a client calls with its own credentials (a token, or none): the session cookie is never read for them. */
export const isMcpClientPath = (url: string) => {
  const path = url.split('?')[0]!;
  return path === '/api/mcp' || path.startsWith('/api/mcp/');
};
