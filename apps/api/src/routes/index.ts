import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { requirePrincipal, setSessionCookie, SESSION_COOKIE } from '../http.js';
import type { Ctx } from '../context.js';
import { badRequest, forbidden, unauthorized } from '../errors.js';
import * as approvals from '../services/approvals.js';
import * as authSvc from '../services/auth.js';
import * as brand from '../services/brand.js';
import * as comments from '../services/comments.js';
import * as connections from '../services/connections.js';
import * as pieces from '../services/pieces.js';
import * as pubs from '../services/publications.js';
import * as versions from '../services/versions.js';

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export async function registerRoutes(app: FastifyInstance, ctx: Ctx) {
  const P = (req: FastifyRequest) => requirePrincipal(req);
  const params = <T extends string>(req: FastifyRequest, ...names: T[]) =>
    Object.fromEntries(names.map((n) => [n, z.string().uuid().parse((req.params as Record<string, string>)[n])])) as Record<T, string>;
  const userOnly = (req: FastifyRequest) => {
    const p = P(req);
    if (p.kind !== 'user') throw forbidden('This is only available to signed-in people');
    return p;
  };

  // ───────────────────────────── authentication ─────────────────────────────

  app.get('/api/config', async () => ({ devLogin: ctx.config.devLogin }));

  app.post('/api/auth/magic-link', { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } }, async (req, reply) => {
    const { email } = z.object({ email: z.string().email().max(200) }).parse(req.body);
    await authSvc.requestMagicLink(ctx, email);
    return reply.code(202).send({ ok: true });
  });

  app.post('/api/auth/verify', { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (req, reply) => {
    const { token } = z.object({ token: z.string().min(10).max(200) }).parse(req.body);
    const s = await authSvc.verifyMagicLink(ctx, token);
    if (!s) throw unauthorized('That link is invalid or has expired');
    setSessionCookie(ctx, reply, s.token, s.expiresAt);
    return { ok: true };
  });

  app.post('/api/auth/dev-login', { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (req, reply) => {
    if (!ctx.config.devLogin) return reply.code(404).send({ error: { code: 'not_found', message: 'Not found' } });
    const { email } = z.object({ email: z.string().email() }).parse(req.body);
    const s = await authSvc.devLogin(ctx, email);
    if (!s) throw unauthorized('Unknown user');
    setSessionCookie(ctx, reply, s.token, s.expiresAt);
    return { ok: true };
  });

  app.post('/api/auth/logout', async (req, reply) => {
    const sid = req.cookies[SESSION_COOKIE];
    if (sid) await authSvc.endSession(ctx, sid);
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return { ok: true };
  });

  app.get('/api/me', async (req) => authSvc.me(ctx, userOnly(req).userId));

  // ───────────────────────────── brand settings ─────────────────────────────

  app.get('/api/brands/:brandId', async (req) => brand.getBrand(ctx, P(req), params(req, 'brandId').brandId));
  app.patch('/api/brands/:brandId', async (req) => brand.updateBrand(ctx, P(req), params(req, 'brandId').brandId, req.body));
  app.post('/api/brands/:brandId/pause', async (req) => {
    const { paused } = z.object({ paused: z.boolean() }).parse(req.body);
    return brand.setPaused(ctx, P(req), params(req, 'brandId').brandId, paused);
  });

  app.get('/api/brands/:brandId/members', async (req) => brand.listMembers(ctx, P(req), params(req, 'brandId').brandId));
  app.post('/api/brands/:brandId/members', async (req, reply) =>
    reply.code(201).send(await brand.addMember(ctx, P(req), params(req, 'brandId').brandId, req.body)));
  app.patch('/api/brands/:brandId/members/:memberId', async (req) => {
    const { brandId, memberId } = params(req, 'brandId', 'memberId');
    return brand.changeMemberRole(ctx, P(req), brandId, memberId, (req.body as { role?: unknown })?.role);
  });
  app.delete('/api/brands/:brandId/members/:memberId', async (req) => {
    const { brandId, memberId } = params(req, 'brandId', 'memberId');
    return brand.removeMember(ctx, P(req), brandId, memberId);
  });

  app.get('/api/brands/:brandId/accounts', async (req) => brand.listAccounts(ctx, P(req), params(req, 'brandId').brandId));
  app.post('/api/brands/:brandId/accounts', async (req, reply) =>
    reply.code(201).send(await brand.addAccount(ctx, P(req), params(req, 'brandId').brandId, req.body)));
  app.delete('/api/brands/:brandId/accounts/:accountId', async (req) => {
    const { brandId, accountId } = params(req, 'brandId', 'accountId');
    return brand.removeAccount(ctx, P(req), brandId, accountId);
  });

  // ───────────────────────────── connecting accounts ─────────────────────────────

  app.get('/api/brands/:brandId/integrations', async (req) => connections.integrations(ctx, P(req), params(req, 'brandId').brandId));
  app.post('/api/brands/:brandId/connections/:provider', async (req) => {
    const { brandId } = params(req, 'brandId');
    const provider = z.enum(['meta', 'google']).parse((req.params as { provider: string }).provider);
    const { reconnectAccountId } = z.object({ reconnectAccountId: z.string().uuid().optional() }).parse(req.body ?? {});
    return connections.startConnection(ctx, P(req), brandId, provider, reconnectAccountId);
  });
  app.get('/api/brands/:brandId/connections/:pendingId', async (req) => {
    const { brandId, pendingId } = params(req, 'brandId', 'pendingId');
    return connections.getPending(ctx, P(req), brandId, pendingId);
  });
  app.post('/api/brands/:brandId/connections/:pendingId/select', async (req) => {
    const { brandId, pendingId } = params(req, 'brandId', 'pendingId');
    return connections.selectCandidates(ctx, P(req), brandId, pendingId, req.body);
  });
  app.post('/api/brands/:brandId/accounts/:accountId/disconnect', async (req) => {
    const { brandId, accountId } = params(req, 'brandId', 'accountId');
    return connections.disconnectAccount(ctx, P(req), brandId, accountId);
  });
  app.patch('/api/brands/:brandId/accounts/:accountId', async (req) => {
    const { brandId, accountId } = params(req, 'brandId', 'accountId');
    return connections.updateAccountSettings(ctx, P(req), brandId, accountId, req.body);
  });

  // The network sends the browser here after the person has signed in there. The session cookie identifies who is back.
  app.get('/api/oauth/callback', async (req, reply) => {
    const q = z
      .object({ code: z.string().optional(), state: z.string().optional(), error: z.string().optional(), error_description: z.string().optional() })
      .parse(req.query);
    // A browser coming back from the network without a session goes to sign in, not to a JSON error.
    if (req.principal?.kind !== 'user') return reply.redirect('/login');
    const out = await connections.finishOAuth(ctx, req.principal.userId, q);
    const to = new URL('/settings', ctx.config.APP_URL);
    to.searchParams.set('tab', 'accounts');
    if (out.pendingId) to.searchParams.set('connection', out.pendingId);
    if (out.error) to.searchParams.set('connect_error', out.error);
    return reply.redirect(to.toString());
  });

  app.get('/api/brands/:brandId/tokens', async (req) => brand.listTokens(ctx, P(req), params(req, 'brandId').brandId));
  app.post('/api/brands/:brandId/tokens', async (req, reply) =>
    reply.code(201).send(await brand.createToken(ctx, P(req), params(req, 'brandId').brandId, req.body)));
  app.delete('/api/brands/:brandId/tokens/:tokenId', async (req) => {
    const { brandId, tokenId } = params(req, 'brandId', 'tokenId');
    return brand.revokeToken(ctx, P(req), brandId, tokenId);
  });

  app.get('/api/brands/:brandId/campaigns', async (req) => brand.listCampaigns(ctx, P(req), params(req, 'brandId').brandId));
  app.post('/api/brands/:brandId/campaigns', async (req, reply) =>
    reply.code(201).send(await brand.createCampaign(ctx, P(req), params(req, 'brandId').brandId, req.body)));

  app.get('/api/brands/:brandId/slots', async (req) => {
    const { brandId } = params(req, 'brandId');
    const q = z.object({ status: z.enum(['empty']).optional(), from: date.optional(), to: date.optional() }).parse(req.query);
    if (q.status === 'empty') {
      if (!q.from || !q.to) throw badRequest('invalid_range', 'status=empty needs from and to');
      return pubs.emptySlots(ctx, P(req), brandId, q.from, q.to);
    }
    return brand.listSlots(ctx, P(req), brandId);
  });
  app.post('/api/brands/:brandId/slots', async (req, reply) =>
    reply.code(201).send(await brand.addSlot(ctx, P(req), params(req, 'brandId').brandId, req.body)));
  app.delete('/api/brands/:brandId/slots/:slotId', async (req) => {
    const { brandId, slotId } = params(req, 'brandId', 'slotId');
    return brand.removeSlot(ctx, P(req), brandId, slotId);
  });

  app.get('/api/brands/:brandId/blocked-dates', async (req) => brand.listBlocked(ctx, P(req), params(req, 'brandId').brandId));
  app.post('/api/brands/:brandId/blocked-dates', async (req, reply) =>
    reply.code(201).send(await brand.blockDate(ctx, P(req), params(req, 'brandId').brandId, req.body)));
  app.delete('/api/brands/:brandId/blocked-dates/:day', async (req) => {
    const { brandId } = params(req, 'brandId');
    return brand.unblockDate(ctx, P(req), brandId, date.parse((req.params as { day: string }).day));
  });

  app.get('/api/brands/:brandId/audit', async (req) => {
    const q = z.object({ entity: z.string().optional(), entityId: z.string().uuid().optional(), limit: z.coerce.number().int().min(1).max(500).optional() }).parse(req.query);
    return brand.listAudit(ctx, P(req), params(req, 'brandId').brandId, q);
  });

  // ───────────────────────────── pieces and variants ─────────────────────────────

  app.get('/api/brands/:brandId/pieces', async (req) => {
    const q = z.object({ state: z.string().optional(), q: z.string().max(200).optional() }).parse(req.query);
    return pieces.listPieces(ctx, P(req), params(req, 'brandId').brandId, q);
  });
  app.post('/api/brands/:brandId/pieces', async (req, reply) =>
    reply.code(201).send(await pieces.createPiece(ctx, P(req), params(req, 'brandId').brandId, req.body)));
  app.get('/api/pieces/:id', async (req) => pieces.getPiece(ctx, P(req), params(req, 'id').id));
  app.patch('/api/pieces/:id', async (req) => pieces.updatePiece(ctx, P(req), params(req, 'id').id, req.body));
  app.post('/api/pieces/:id/discard', async (req) => pieces.discardPiece(ctx, P(req), params(req, 'id').id));
  app.post('/api/pieces/:id/variants', async (req, reply) =>
    reply.code(201).send(await pieces.addVariant(ctx, P(req), params(req, 'id').id, req.body)));

  app.post('/api/variants/:id/uploads', async (req) => ({ uploads: await versions.requestUploads(ctx, P(req), params(req, 'id').id, req.body) }));
  app.post('/api/variants/:id/versions', async (req, reply) =>
    reply.code(201).send(await versions.closeVersion(ctx, P(req), params(req, 'id').id, req.body)));

  // ───────────────────────────── versions, comments, approvals ─────────────────────────────

  app.get('/api/versions/:id', async (req) => versions.getVersion(ctx, P(req), params(req, 'id').id));
  app.get('/api/versions/:id/comments', async (req) => {
    const q = z
      .object({
        status: z.enum(['open', 'resolved']).optional(),
        carried: z.enum(['true', 'false']).optional().transform((v) => v === 'true'),
      })
      .parse(req.query);
    return comments.listComments(ctx, P(req), params(req, 'id').id, q);
  });
  app.post('/api/versions/:id/comments', async (req, reply) =>
    reply.code(201).send(await comments.createComment(ctx, P(req), params(req, 'id').id, req.body)));
  app.post('/api/versions/:id/request-changes', async (req) => approvals.requestChanges(ctx, P(req), params(req, 'id').id, req.body ?? {}));
  app.post('/api/versions/:id/approvals', async (req, reply) =>
    reply.code(201).send(await approvals.decide(ctx, P(req), params(req, 'id').id, req.body)));
  app.post('/api/versions/:id/publications', async (req, reply) =>
    reply.code(201).send(await pubs.schedule(ctx, P(req), params(req, 'id').id, req.body)));

  app.post('/api/comments/:id/replies', async (req, reply) =>
    reply.code(201).send(await comments.replyToComment(ctx, P(req), params(req, 'id').id, req.body)));
  app.post('/api/comments/:id/resolve', async (req) => comments.resolveComment(ctx, P(req), params(req, 'id').id));
  app.post('/api/comments/:id/reopen', async (req) => comments.reopenComment(ctx, P(req), params(req, 'id').id));

  // ───────────────────────────── publications and calendar ─────────────────────────────

  app.patch('/api/publications/:id', async (req) => pubs.patchPublication(ctx, P(req), params(req, 'id').id, req.body));
  app.post('/api/publications/:id/confirm', async (req) => pubs.confirmPublication(ctx, P(req), params(req, 'id').id));
  app.post('/api/publications/:id/cancel', async (req) => pubs.cancelPublication(ctx, P(req), params(req, 'id').id));
  app.post('/api/publications/:id/reschedule', async (req) => pubs.reschedulePublication(ctx, P(req), params(req, 'id').id, req.body));
  app.post('/api/versions/:id/publications/validate', async (req) => pubs.validatePublication(ctx, P(req), params(req, 'id').id, req.body));
  app.post('/api/publications/:id/retry', async (req) => pubs.retryPublication(ctx, P(req), params(req, 'id').id, req.body));
  app.post('/api/publications/:id/hand-over', async (req) => pubs.handOverPublication(ctx, P(req), params(req, 'id').id));
  app.post('/api/publications/:id/recheck', async (req) => pubs.recheckPublication(ctx, P(req), params(req, 'id').id));
  app.get('/api/publications/:id/attempts', async (req) => pubs.listAttempts(ctx, P(req), params(req, 'id').id));
  app.post('/api/publications/:id/mark-published', async (req) => pubs.markPublished(ctx, P(req), params(req, 'id').id, req.body ?? {}));
  app.get('/api/publications/:id/pack', async (req) => pubs.publicationPack(ctx, P(req), params(req, 'id').id));

  app.get('/api/brands/:brandId/calendar', async (req) => {
    const q = z.object({ from: date, to: date }).parse(req.query);
    return pubs.calendar(ctx, P(req), params(req, 'brandId').brandId, q.from, q.to);
  });
  app.get('/api/brands/:brandId/publications/due', async (req) => pubs.duePublications(ctx, P(req), params(req, 'brandId').brandId));

  // ───────────────────────────── notifications ─────────────────────────────

  app.get('/api/notifications', async (req) => {
    const p = userOnly(req);
    const items = await ctx.db.query(
      `select n.id, n.kind, n.payload, n.read_at, n.created_at, b.id as brand_id, b.name as brand, pc.title as piece_title
       from notification n join brand b on b.id = n.brand_id
       left join piece pc on pc.id = nullif(n.payload->>'pieceId', '')::uuid
       where n.user_id = $1 order by n.created_at desc limit 50`,
      [p.userId],
    );
    return { items, unread: items.filter((i) => !i.read_at).length };
  });
  app.post('/api/notifications/read', async (req) => {
    const p = userOnly(req);
    const { ids } = z.object({ ids: z.array(z.string().uuid()).max(100).optional() }).parse(req.body ?? {});
    await ctx.db.query(
      `update notification set read_at = now() where user_id = $1 and read_at is null and ($2::uuid[] is null or id = any($2))`,
      [p.userId, ids ?? null],
    );
    return { ok: true };
  });
}
