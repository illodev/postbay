import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyInstance } from 'fastify';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { ZodError } from 'zod';
import type { Config } from './config.js';
import type { Ctx } from './context.js';
import type { Db } from './db.js';
import { AppError, forbidden } from './errors.js';
import { acceptLanguage, localeHooks, render, renderStored, t, type Key } from './i18n/index.js';
import { CSRF_HEADER, SESSION_COOKIE } from './http.js';
import type { ConnectorSet } from './connectors/types.js';
import type { Mailer } from './mailer.js';
import type { Media } from './media/ffmpeg.js';
import { registerRoutes } from './routes/index.js';
import { mediaRoutes } from './routes/media.js';
import { isMcpClientPath, mcpRoutes } from './routes/mcp.js';
import * as authSvc from './services/auth.js';
import { createContext } from './runtime.js';
import type { Storage } from './storage/index.js';

export interface AppDeps {
  config: Config;
  db: Db;
  storage?: Storage;
  mailer?: Mailer;
  media?: Media;
  connectors?: ConnectorSet;
  now?: () => Date;
  logger?: boolean;
  /** Where the log goes instead of standard output (tests read it back). */
  logStream?: NodeJS.WritableStream;
}

/**
 * Paths whose last part is itself a secret: a prize's link (the page and the API behind it) and Meta's data-deletion
 * confirmation code. The first group is kept, the secret is not.
 */
const SECRET_PATHS = [/^(\/api\/public\/prizes\/)[^/?#]+/, /^(\/prize\/)[^/?#]+/, /^(\/api\/public\/data-deletion\/)[^/?#]+/];

/**
 * A URL as it may be written to the log: the value of every query parameter replaced (sign-in link tokens, OAuth and
 * single sign-on codes and states, signed media URLs, Meta's verify token), and the secret part of the paths above.
 * Names of parameters are kept, so a log still says what kind of request it was.
 */
export function redactUrl(url: string): string {
  const q = url.indexOf('?');
  let pathPart = q === -1 ? url : url.slice(0, q);
  for (const re of SECRET_PATHS) pathPart = pathPart.replace(re, '$1[redacted]');
  if (q === -1) return pathPart;
  const query = url
    .slice(q + 1)
    .split('&')
    .filter(Boolean)
    .map((kv) => {
      // A part with no "=" may be a value on its own (a bare token): only something that reads like a name is kept.
      const eq = kv.indexOf('=');
      return eq > 0 && /^[\w.\-[\]%]{1,40}$/.test(kv.slice(0, eq)) ? `${kv.slice(0, eq)}=[redacted]` : '[redacted]';
    })
    .join('&');
  return `${pathPart}?${query}`;
}

/** Fastify's own request serializer, with the URL as redactUrl leaves it. */
const logOptions = (stream?: NodeJS.WritableStream) => ({
  ...(stream ? { stream } : {}),
  serializers: {
    req(req: { method?: string; url?: string; host?: string; ip?: string; socket?: { remotePort?: number } }) {
      return { method: req.method, url: redactUrl(req.url ?? ''), host: req.host, remoteAddress: req.ip, remotePort: req.socket?.remotePort };
    },
  },
});

export async function buildApp(deps: AppDeps): Promise<{ app: FastifyInstance; ctx: Ctx }> {
  const { config, db } = deps;
  const logging = deps.logger ?? (config.NODE_ENV !== 'test' || !!deps.logStream);
  const app = Fastify({ logger: logging ? logOptions(deps.logStream) : false, trustProxy: true });
  const ctx: Ctx = createContext(config, db, app.log, {
    storage: deps.storage, mailer: deps.mailer, media: deps.media, connectors: deps.connectors, now: deps.now,
  });

  await app.register(cookie);
  await app.register(rateLimit, { global: false });

  // The language of the answer: what the request asks for (the web sends Accept-Language: es or en), Spanish otherwise. Texts made
  // while answering follow it (requestLocale), and texts kept as codes are put into words in it on their way out.
  app.addHook('onRequest', localeHooks.onRequest as never);
  app.addHook('preValidation', localeHooks.preValidation as never);
  app.addHook('preSerialization', async (req, _reply, payload) => {
    if (payload && typeof payload === 'object') renderStored(acceptLanguage(req.headers['accept-language']), payload);
    return payload;
  });

  app.decorateRequest('principal', null);
  app.decorateRequest('viaCookie', false);
  app.decorateRequest('secondFactor', null);

  // Who is asking: a producer token (Authorization: Bearer) or a browser session (cookie).
  app.addHook('preHandler', async (req) => {
    if (!req.url.startsWith('/api/')) return;
    // An AI assistant's endpoints (MCP and its OAuth) take the assistant's own token or nothing: never a producer token, never a cookie.
    if (isMcpClientPath(req.url)) return;
    const bearer = /^Bearer\s+(\S+)$/i.exec(req.headers.authorization ?? '')?.[1];
    if (bearer) {
      req.principal = await authSvc.principalFromApiToken(ctx, bearer);
      return;
    }
    const sid = req.cookies[SESSION_COOKIE];
    if (sid) {
      const state = await authSvc.sessionState(ctx, sid);
      if (state) {
        // A session that owes the second step is still a browser session (so it needs the CSRF header) but is nobody yet.
        req.viaCookie = true;
        if (state.pending === 'none') req.principal = { kind: 'user', userId: state.userId, email: state.email };
        else req.secondFactor = { userId: state.userId, email: state.email, pending: state.pending };
      }
    }
    // Cookie-authenticated writes must come from our own front end: browsers cannot add this header cross-site.
    if (req.viaCookie && !['GET', 'HEAD', 'OPTIONS'].includes(req.method) && !req.headers[CSRF_HEADER]) {
      throw forbidden(`Missing ${CSRF_HEADER} header`);
    }
  });

  app.setErrorHandler((err: unknown, req, reply) => {
    if (err instanceof AppError) {
      const message = err.text ? render(acceptLanguage(req.headers['accept-language']), err.text, err.message) : err.message;
      return reply.code(err.status).send({ error: { code: err.code, message, details: err.details } });
    }
    if (err instanceof ZodError) {
      return reply.code(400).send({
        error: {
          code: 'validation_error',
          message: err.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; '),
          details: err.issues,
        },
      });
    }
    const e = err as { code?: string; statusCode?: number; message?: string };
    const say = (code: Key) => t(acceptLanguage(req.headers['accept-language']), code);
    if (e.code === '22P02') return reply.code(404).send({ error: { code: 'not_found', message: say('error.notFoundGeneric') } });
    if (e.code === 'P0001') return reply.code(409).send({ error: { code: 'invariant', message: e.message } });
    if (e.code === '23505') return reply.code(409).send({ error: { code: 'conflict', message: say('error.alreadyExists') } });
    if (e.statusCode && e.statusCode < 500) {
      return reply.code(e.statusCode).send({ error: { code: 'bad_request', message: e.message } });
    }
    req.log.error({ err }, 'unhandled error');
    return reply.code(500).send({ error: { code: 'internal', message: say('error.internal') } });
  });

  // Headers every response carries, plus a Content-Security-Policy on the HTML shell: scripts only from our own origin.
  const origins = [config.MEDIA_URL, config.S3_PUBLIC_ENDPOINT ?? config.S3_ENDPOINT, ...config.MEDIA_ORIGINS.split(/\s+/)]
    .filter((o): o is string => !!o)
    .map((o) => { try { return new URL(o).origin; } catch { return o; } });
  const media = [...new Set(origins)].join(' ');
  const csp = [
    "default-src 'self'",
    // 'wasm-unsafe-eval' lets the browser compile WebAssembly (the file hashing and the PDF viewer) without allowing eval().
    "script-src 'self' 'wasm-unsafe-eval'",
    "style-src 'self' 'unsafe-inline'",
    `img-src 'self' data: blob: ${media}`,
    `media-src 'self' blob: ${media}`,
    `connect-src 'self' ${media}`,
    "worker-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; ');
  app.addHook('onSend', async (_req, reply, payload) => {
    reply.header('x-content-type-options', 'nosniff');
    reply.header('referrer-policy', 'same-origin');
    reply.header('x-frame-options', 'DENY');
    if (String(reply.getHeader('content-type') ?? '').startsWith('text/html')) reply.header('content-security-policy', csp);
    return payload;
  });

  app.get('/api/health', async () => ({ ok: true }));

  await app.register(async (media) => mediaRoutes(media, ctx));
  await app.register(async (api) => registerRoutes(api, ctx));
  // Using the studio from an AI assistant: the MCP endpoint, its OAuth server and their discovery documents (src/mcp/).
  await app.register(async (mcp) => mcpRoutes(mcp, ctx));

  // In production the API also serves the built front end.
  const dist = config.WEB_DIST ? path.resolve(config.WEB_DIST) : null;
  const serveShell = !!dist && existsSync(dist);
  if (serveShell) await app.register(fastifyStatic, { root: dist, wildcard: false });
  // Always our own: Fastify's default handler writes "Route GET:<the whole URL> not found" to the log, query and all.
  app.setNotFoundHandler((req, reply) => {
    if (serveShell && req.method === 'GET' && !req.url.startsWith('/api/') && !req.url.startsWith('/media/')) return reply.sendFile('index.html');
    return reply.code(404).send({ error: { code: 'not_found', message: t(acceptLanguage(req.headers['accept-language']), 'error.notFoundGeneric') } });
  });
  return { app, ctx };
}

