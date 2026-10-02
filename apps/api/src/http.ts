import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Principal } from './auth/principal.js';
import type { Ctx } from './context.js';
import { AppError, unauthorized } from './errors.js';

export const SESSION_COOKIE = 'sid';
export const CSRF_HEADER = 'x-requested-by';

declare module 'fastify' {
  interface FastifyRequest {
    principal: Principal | null;
    viaCookie: boolean;
    /** A signed-in browser session that still owes the second step: it can do nothing but give it. */
    secondFactor: { userId: string; email: string; pending: 'verify' | 'enroll' } | null;
  }
}

export function requirePrincipal(req: FastifyRequest): Principal {
  if (!req.principal) {
    if (req.secondFactor) {
      throw new AppError(401, 'second_factor_required', { code: 'error.secondFactorRequired' }, { step: req.secondFactor.pending });
    }
    throw unauthorized();
  }
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
