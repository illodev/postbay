import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Principal } from './auth/principal.js';
import type { Ctx } from './context.js';
import { unauthorized } from './errors.js';

export const SESSION_COOKIE = 'sid';
export const CSRF_HEADER = 'x-requested-by';

declare module 'fastify' {
  interface FastifyRequest {
    principal: Principal | null;
    viaCookie: boolean;
  }
}

export function requirePrincipal(req: FastifyRequest): Principal {
  if (!req.principal) throw unauthorized();
  return req.principal;
}

export function setSessionCookie(ctx: Ctx, reply: FastifyReply, token: string, expiresAt: Date) {
  reply.setCookie(SESSION_COOKIE, token, {
    path: '/',
    httpOnly: true,
    sameSite: 'lax',
    secure: ctx.config.isProd,
    expires: expiresAt,
  });
}
