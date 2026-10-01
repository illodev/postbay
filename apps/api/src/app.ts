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
import { CSRF_HEADER, SESSION_COOKIE } from './http.js';
import { createMailer, type Mailer } from './mailer.js';
import { createMedia, type Media } from './media/ffmpeg.js';
import { registerRoutes } from './routes/index.js';
import { mediaRoutes } from './routes/media.js';
import * as authSvc from './services/auth.js';
import { createStorage, type Storage } from './storage/index.js';

export interface AppDeps {
  config: Config;
  db: Db;
  storage?: Storage;
  mailer?: Mailer;
  media?: Media;
  logger?: boolean;
}

export async function buildApp(deps: AppDeps): Promise<{ app: FastifyInstance; ctx: Ctx }> {
  const { config, db } = deps;
  const app = Fastify({ logger: deps.logger ?? config.NODE_ENV !== 'test', trustProxy: true });
  const ctx: Ctx = {
    db,
    config,
    storage: deps.storage ?? createStorage(config),
    mailer: deps.mailer ?? createMailer(config, app.log),
    media: deps.media ?? createMedia(app.log),
    log: app.log,
  };

  await app.register(cookie);
  await app.register(rateLimit, { global: false });

  app.decorateRequest('principal', null);
  app.decorateRequest('viaCookie', false);

  // Who is asking: a producer token (Authorization: Bearer) or a browser session (cookie).
  app.addHook('preHandler', async (req) => {
    if (!req.url.startsWith('/api/')) return;
    const bearer = /^Bearer\s+(\S+)$/i.exec(req.headers.authorization ?? '')?.[1];
    if (bearer) {
      req.principal = await authSvc.principalFromApiToken(ctx, bearer);
      return;
    }
    const sid = req.cookies[SESSION_COOKIE];
    if (sid) {
      req.principal = await authSvc.principalFromSession(ctx, sid);
      req.viaCookie = req.principal !== null;
    }
    // Cookie-authenticated writes must come from our own front end: browsers cannot add this header cross-site.
    if (req.viaCookie && !['GET', 'HEAD', 'OPTIONS'].includes(req.method) && !req.headers[CSRF_HEADER]) {
      throw forbidden(`Missing ${CSRF_HEADER} header`);
    }
  });

  app.setErrorHandler((err: unknown, req, reply) => {
    if (err instanceof AppError) {
      return reply.code(err.status).send({ error: { code: err.code, message: err.message, details: err.details } });
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
    if (e.code === '22P02') return reply.code(404).send({ error: { code: 'not_found', message: 'Not found' } });
    if (e.code === 'P0001') return reply.code(409).send({ error: { code: 'invariant', message: e.message } });
    if (e.code === '23505') return reply.code(409).send({ error: { code: 'conflict', message: 'That already exists' } });
    if (e.statusCode && e.statusCode < 500) {
      return reply.code(e.statusCode).send({ error: { code: 'bad_request', message: e.message } });
    }
    req.log.error({ err }, 'unhandled error');
    return reply.code(500).send({ error: { code: 'internal', message: 'Something went wrong' } });
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

  // In production the API also serves the built front end.
  const dist = config.WEB_DIST ? path.resolve(config.WEB_DIST) : null;
  if (dist && existsSync(dist)) {
    await app.register(fastifyStatic, { root: dist, wildcard: false });
    app.setNotFoundHandler((req, reply) => {
      if (req.method === 'GET' && !req.url.startsWith('/api/') && !req.url.startsWith('/media/')) return reply.sendFile('index.html');
      return reply.code(404).send({ error: { code: 'not_found', message: 'Not found' } });
    });
  }
  return { app, ctx };
}

