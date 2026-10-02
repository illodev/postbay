import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { requirePrincipal, setSessionCookie, SESSION_COOKIE } from '../http.js';
import type { Ctx } from '../context.js';
import { badRequest, conflict, forbidden, notFound, unauthorized } from '../errors.js';
import * as agent from '../services/agent.js';
import * as metrics from '../services/metrics.js';
import * as prizes from '../services/prizes.js';
import * as push from '../services/push.js';
import * as selfcheck from '../services/selfcheck.js';
import * as slack from '../services/slack.js';
import * as subtitles from '../services/subtitles.js';
import * as thumbs from '../services/thumbs.js';
import * as secondFactor from '../services/secondfactor.js';
import * as sso from '../services/sso.js';
import * as approvals from '../services/approvals.js';
import * as authSvc from '../services/auth.js';
import * as brand from '../services/brand.js';
import * as comments from '../services/comments.js';
import * as connections from '../services/connections.js';
import * as overview from '../services/overview.js';
import * as pieces from '../services/pieces.js';
import * as resumable from '../services/resumable.js';
import * as pubs from '../services/publications.js';
import * as versions from '../services/versions.js';
import * as webhooks from '../services/webhooks.js';

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

const providerParam = z.enum(['meta', 'google', 'threads', 'tiktok', 'linkedin', 'x', 'pinterest', 'bluesky']);

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

  app.get('/api/config', async () => ({ devLogin: ctx.config.devLogin, sso: sso.ssoInfo(ctx), emailLinkLogin: ctx.config.emailLinkLogin }));

  app.post('/api/auth/magic-link', { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } }, async (req, reply) => {
    const { email } = z.object({ email: z.string().email().max(200) }).parse(req.body);
    authSvc.requestMagicLink(ctx, email); // not awaited: the answer must not say, by its timing or by an error, who has an account
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

  // ───────────────────────────── single sign-on ─────────────────────────────

  const ssoCookie = { path: '/api/auth/sso', httpOnly: true, sameSite: 'lax' as const, secure: ctx.config.isProd };
  app.get('/api/auth/sso/start', { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (req, reply) => {
    if (!ctx.config.sso) return reply.code(404).send({ error: { code: 'not_found', message: 'Not found' } });
    try {
      const { url, state } = await sso.startSso(ctx);
      reply.setCookie(sso.SSO_COOKIE, state, { ...ssoCookie, maxAge: 600 });
      return reply.redirect(url);
    } catch (err) {
      ctx.log.warn({ err: String(err) }, 'single sign-on could not start');
      return reply.redirect('/login?error=provider');
    }
  });
  app.get('/api/auth/sso/callback', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (req, reply) => {
    if (!ctx.config.sso) return reply.code(404).send({ error: { code: 'not_found', message: 'Not found' } });
    const q = z.object({ code: z.string().max(4000).optional(), state: z.string().max(200).optional(), error: z.string().max(200).optional() }).parse(req.query ?? {});
    const r = await sso.finishSso(ctx, q, req.cookies[sso.SSO_COOKIE]);
    reply.clearCookie(sso.SSO_COOKIE, { path: ssoCookie.path });
    if ('failure' in r) return reply.redirect(`/login?error=${r.failure}`);
    setSessionCookie(ctx, reply, r.session.token, r.session.expiresAt);
    return reply.redirect('/');
  });

  // ───────────────────────────── second factor ─────────────────────────────

  // Who may use these: a person signed in, or one who owes the second step (that is what these are for).
  const actor = (req: FastifyRequest) => {
    if (req.principal?.kind === 'user') return { userId: req.principal.userId, email: req.principal.email, pending: 'none' as const };
    if (req.secondFactor) return req.secondFactor;
    throw unauthorized();
  };
  const code = z.object({ code: z.string().trim().min(6).max(20) });
  const codeLimit = { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } };

  // Not an error when nobody is signed in: the sign-in screens ask this to know which step to show.
  app.get('/api/auth/state', async (req) => ({
    signedIn: !!req.principal || !!req.secondFactor,
    secondFactor: req.secondFactor?.pending ?? 'none',
  }));
  app.get('/api/auth/2fa', async (req) => secondFactor.status(ctx, userOnly(req).userId));
  app.post('/api/auth/2fa/verify', codeLimit, async (req) => {
    const a = actor(req);
    if (a.pending !== 'verify') throw conflict('not_pending', 'There is no code to give right now.');
    await secondFactor.verifySecondFactor(ctx, a.userId, code.parse(req.body).code);
    await authSvc.markSecondFactor(ctx, req.cookies[SESSION_COOKIE]!);
    return { ok: true };
  });
  app.post('/api/auth/2fa/enroll', codeLimit, async (req) => {
    const a = actor(req);
    if (a.pending === 'verify') throw conflict('already_enrolled', 'An authenticator is already set up: give its code.');
    await authSvc.assertMayEnroll(ctx, req.cookies[SESSION_COOKIE]!);
    return secondFactor.startEnrollment(ctx, a.userId, a.email);
  });
  app.post('/api/auth/2fa/enroll/confirm', codeLimit, async (req) => {
    const a = actor(req);
    await authSvc.assertMayEnroll(ctx, req.cookies[SESSION_COOKIE]!);
    const r = await secondFactor.confirmEnrollment(ctx, a.userId, code.parse(req.body).code);
    // Whoever has just proved they hold the authenticator has given the second step.
    await authSvc.markSecondFactor(ctx, req.cookies[SESSION_COOKIE]!);
    return r;
  });
  app.post('/api/auth/2fa/disable', codeLimit, async (req) => {
    await secondFactor.disable(ctx, userOnly(req).userId, code.parse(req.body).code);
    return { ok: true };
  });
  app.post('/api/auth/2fa/recovery-codes', codeLimit, async (req) => secondFactor.regenerateRecoveryCodes(ctx, userOnly(req).userId, code.parse(req.body).code));
  app.post('/api/brands/:brandId/members/:memberId/reset-2fa', async (req) => {
    const { brandId, memberId } = params(req, 'brandId', 'memberId');
    return secondFactor.resetForMember(ctx, P(req), brandId, memberId);
  });

  app.get('/api/versions/:versionId/subtitles', async (req) => subtitles.getSubtitles(ctx, P(req), params(req, 'versionId').versionId));
  app.get('/api/me', async (req) => authSvc.me(ctx, userOnly(req).userId));
  // What a producer token needs to find its way: which brand it belongs to.
  app.get('/api/token', async (req) => authSvc.tokenInfo(ctx, P(req)));

  // ───────────────────────────── notifications: preferences, push, Slack ─────────────────────────────

  app.get('/api/notifications/preferences', async (req) => push.getPreferences(ctx, userOnly(req).userId));
  app.put('/api/notifications/preferences', async (req) => push.setPreferences(ctx, userOnly(req).userId, req.body));
  // The key a browser needs to subscribe with: the deployment's public signing key.
  app.get('/api/push/key', async (req) => { userOnly(req); return { publicKey: (await push.vapidKeys(ctx)).publicKey }; });
  app.post('/api/push/subscriptions', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (req) => push.subscribe(ctx, userOnly(req).userId, req.body));
  app.post('/api/push/unsubscribe', async (req) => push.unsubscribe(ctx, userOnly(req).userId, z.object({ endpoint: z.string().max(1500) }).parse(req.body).endpoint));
  app.post('/api/push/test', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req) => push.sendTest(ctx, userOnly(req).userId));

  app.get('/api/brands/:brandId/slack', async (req) => slack.getSlack(ctx, P(req), params(req, 'brandId').brandId));
  app.put('/api/brands/:brandId/slack', async (req) => slack.setSlack(ctx, P(req), params(req, 'brandId').brandId, req.body));
  app.delete('/api/brands/:brandId/slack', async (req) => slack.removeSlack(ctx, P(req), params(req, 'brandId').brandId));
  app.post('/api/brands/:brandId/slack/test', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req) => slack.testSlack(ctx, P(req), params(req, 'brandId').brandId));

  // ───────────────────────────── brand settings ─────────────────────────────

  app.get('/api/brands/:brandId', async (req) => brand.getBrand(ctx, P(req), params(req, 'brandId').brandId));
  app.patch('/api/brands/:brandId', async (req) => brand.updateBrand(ctx, P(req), params(req, 'brandId').brandId, req.body));
  app.post('/api/brands/:brandId/pause', async (req) => {
    const { paused } = z.object({ paused: z.boolean() }).parse(req.body);
    return brand.setPaused(ctx, P(req), params(req, 'brandId').brandId, paused);
  });

  app.get('/api/brands/:brandId/members', async (req) => brand.listMembers(ctx, P(req), params(req, 'brandId').brandId));
  // 201 with the member; 202 with an invitation when the person already belongs to another workspace and has to accept first.
  app.post('/api/brands/:brandId/members', async (req, reply) => {
    const r = await brand.addMember(ctx, P(req), params(req, 'brandId').brandId, req.body);
    return reply.code(r.invited ? 202 : 201).send(r);
  });
  app.get('/api/brands/:brandId/invitations', async (req) => brand.listInvitations(ctx, P(req), params(req, 'brandId').brandId));
  app.delete('/api/brands/:brandId/invitations/:invitationId', async (req) => {
    const { brandId, invitationId } = params(req, 'brandId', 'invitationId');
    return brand.cancelInvitation(ctx, P(req), brandId, invitationId);
  });
  // The invited person, signed in as themselves.
  app.get('/api/invitations', async (req) => brand.myInvitations(ctx, userOnly(req).userId));
  app.post('/api/invitations/:invitationId/accept', async (req) => brand.answerInvitation(ctx, userOnly(req), params(req, 'invitationId').invitationId, true));
  app.post('/api/invitations/:invitationId/decline', async (req) => brand.answerInvitation(ctx, userOnly(req), params(req, 'invitationId').invitationId, false));
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
    const provider = providerParam.parse((req.params as { provider: string }).provider);
    const { reconnectAccountId } = z.object({ reconnectAccountId: z.string().uuid().optional() }).parse(req.body ?? {});
    return connections.startConnection(ctx, P(req), brandId, provider, reconnectAccountId);
  });
  // Sign-in by credentials the person types (Bluesky's app password): ends in the same picker as the sign-in pages.
  app.post('/api/brands/:brandId/connections/:provider/credentials', async (req) => {
    const { brandId } = params(req, 'brandId');
    const provider = providerParam.parse((req.params as { provider: string }).provider);
    return connections.connectWithCredentials(ctx, P(req), brandId, provider, req.body);
  });
  app.get('/api/brands/:brandId/connections/:pendingId', async (req) => {
    const { brandId, pendingId } = params(req, 'brandId', 'pendingId');
    return connections.getPending(ctx, P(req), brandId, pendingId);
  });
  app.post('/api/brands/:brandId/connections/:pendingId/select', async (req) => {
    const { brandId, pendingId } = params(req, 'brandId', 'pendingId');
    return connections.selectCandidates(ctx, P(req), brandId, pendingId, req.body);
  });
  // Read-only checks that say whether this server and an account are ready for real use (docs/phase-5.md). Each asks the network a few questions.
  app.get('/api/brands/:brandId/server-check', { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (req) =>
    selfcheck.checkServerFor(ctx, P(req), params(req, 'brandId').brandId));
  app.post('/api/brands/:brandId/accounts/:accountId/check', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req) => {
    const { brandId, accountId } = params(req, 'brandId', 'accountId');
    return selfcheck.checkAccountFor(ctx, P(req), brandId, accountId);
  });
  app.post('/api/brands/:brandId/accounts/:accountId/disconnect', async (req) => {
    const { brandId, accountId } = params(req, 'brandId', 'accountId');
    return connections.disconnectAccount(ctx, P(req), brandId, accountId);
  });
  app.patch('/api/brands/:brandId/accounts/:accountId', async (req) => {
    const { brandId, accountId } = params(req, 'brandId', 'accountId');
    return connections.updateAccountSettings(ctx, P(req), brandId, accountId, req.body);
  });
  // The settings to ask for while a post for this account is written. For TikTok this asks TikTok (creator info), as it requires.
  app.get('/api/brands/:brandId/accounts/:accountId/options', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (req) => {
    const { brandId, accountId } = params(req, 'brandId', 'accountId');
    return connections.accountOptions(ctx, P(req), brandId, accountId);
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

  // ───────────────────────────── what came of the posts ─────────────────────────────

  app.get('/api/brands/:brandId/metrics', async (req) => metrics.brandMetrics(ctx, P(req), params(req, 'brandId').brandId, req.query));
  app.get('/api/publications/:id/metrics', async (req) => metrics.publicationMetrics(ctx, P(req), params(req, 'id').id));

  // ───────────────────────────── prizes for commenting ─────────────────────────────

  app.get('/api/brands/:brandId/prizes', async (req) => prizes.listPrizes(ctx, P(req), params(req, 'brandId').brandId));
  app.post('/api/brands/:brandId/prizes', async (req, reply) =>
    reply.code(201).send(await prizes.createPrize(ctx, P(req), params(req, 'brandId').brandId, req.body)));
  app.post('/api/prizes/:id/complete', async (req) => prizes.completePrize(ctx, P(req), params(req, 'id').id));
  app.post('/api/prizes/:id/archive', async (req) => prizes.archivePrize(ctx, P(req), params(req, 'id').id));
  app.get('/api/publications/:id/prize', async (req) => prizes.getRule(ctx, P(req), params(req, 'id').id));
  app.put('/api/publications/:id/prize', async (req) => prizes.setRule(ctx, P(req), params(req, 'id').id, req.body));
  app.get('/api/publications/:id/prize/deliveries', async (req) => prizes.listDeliveries(ctx, P(req), params(req, 'id').id));
  app.post('/api/brands/:brandId/prizes/erase', async (req) => prizes.erasePerson(ctx, P(req), params(req, 'brandId').brandId, req.body));

  // What the person who commented opens. No sign-in: the link is the credential, and says nothing about who it was sent to.
  const secretParam = (req: FastifyRequest) => z.string().min(16).max(80).parse((req.params as { token: string }).token);
  app.get('/api/public/prizes/:token', { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async (req) => prizes.publicPrize(ctx, secretParam(req)));
  app.post('/api/public/prizes/:token/download', { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (req) => prizes.downloadPrize(ctx, secretParam(req)));
  app.get('/api/public/data-deletion/:code', async (req) => prizes.deletionStatus(ctx, z.string().min(8).max(60).parse((req.params as { code: string }).code)));

  // What Meta calls: its comment webhook (checked with the app secret on the raw body), and the data-deletion callback.
  await app.register(async (meta) => {
    meta.addContentTypeParser('application/json', { parseAs: 'buffer' }, (_req, body, done) => done(null, body));
    meta.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, (_req, body, done) => done(null, Object.fromEntries(new URLSearchParams(body as string))));
    meta.get('/api/meta/webhook', async (req, reply) => reply.type('text/plain').send(prizes.verifyMetaWebhook(ctx, req.query as Record<string, string>)));
    meta.post('/api/meta/webhook', async (req, reply) => {
      const raw = req.body as Buffer;
      if (!prizes.metaSignatureOk(ctx, raw, req.headers['x-hub-signature-256'] as string | undefined)) throw forbidden('The signature does not match');
      let payload: unknown;
      try { payload = JSON.parse(raw.toString('utf8')); } catch { throw badRequest('invalid_json', 'Not JSON'); }
      await prizes.receiveMetaWebhook(ctx, payload);
      return reply.send({ ok: true });
    });
    meta.post('/api/meta/data-deletion', async (req) => prizes.metaDataDeletion(ctx, z.string().min(10).max(4000).parse((req.body as { signed_request?: string })?.signed_request)));
  });

  // ───────────────────────────── the agent ─────────────────────────────

  app.get('/api/brands/:brandId/agent', async (req) => agent.brandAgent(ctx, P(req), params(req, 'brandId').brandId));
  app.get('/api/brands/:brandId/requirements', async (req) => agent.requirements(ctx, P(req), params(req, 'brandId').brandId));
  app.post('/api/brands/:brandId/agent-runs', async (req, reply) =>
    reply.code(201).send(await agent.startRun(ctx, P(req), { brandId: params(req, 'brandId').brandId }, req.body)));
  app.post('/api/pieces/:id/agent-runs', async (req, reply) =>
    reply.code(201).send(await agent.startRun(ctx, P(req), { pieceId: params(req, 'id').id }, req.body)));
  app.get('/api/pieces/:id/agent', async (req) => agent.pieceAgent(ctx, P(req), params(req, 'id').id));
  app.post('/api/pieces/:id/agent/reset', async (req) => agent.resetRounds(ctx, P(req), params(req, 'id').id));
  app.post('/api/agent-runs/:id/heartbeat', async (req) => agent.heartbeat(ctx, P(req), params(req, 'id').id));
  app.post('/api/agent-runs/:id/finish', async (req) => agent.finishRun(ctx, P(req), params(req, 'id').id, req.body));

  // ───────────────────────────── webhooks ─────────────────────────────

  app.get('/api/brands/:brandId/webhooks', async (req) => webhooks.listWebhooks(ctx, P(req), params(req, 'brandId').brandId));
  app.post('/api/brands/:brandId/webhooks', async (req, reply) =>
    reply.code(201).send(await webhooks.createWebhook(ctx, P(req), params(req, 'brandId').brandId, req.body)));
  app.patch('/api/webhooks/:id', async (req) => webhooks.updateWebhook(ctx, P(req), params(req, 'id').id, req.body));
  app.delete('/api/webhooks/:id', async (req) => webhooks.deleteWebhook(ctx, P(req), params(req, 'id').id));
  app.post('/api/webhooks/:id/rotate-secret', async (req) => webhooks.rotateSecret(ctx, P(req), params(req, 'id').id));
  app.post('/api/webhooks/:id/test', async (req) => webhooks.testWebhook(ctx, P(req), params(req, 'id').id));
  app.get('/api/webhooks/:id/deliveries', async (req) => {
    const q = z.object({ status: z.enum(['pending', 'delivered', 'failed']).optional() }).parse(req.query);
    return webhooks.listDeliveries(ctx, P(req), params(req, 'id').id, q);
  });
  app.get('/api/webhook-deliveries/:id', async (req) => webhooks.getDelivery(ctx, P(req), params(req, 'id').id));
  app.post('/api/webhook-deliveries/:id/redeliver', async (req) => webhooks.redeliver(ctx, P(req), params(req, 'id').id));

  app.get('/api/brands/:brandId/campaigns', async (req) => brand.listCampaigns(ctx, P(req), params(req, 'brandId').brandId));
  app.post('/api/brands/:brandId/campaigns', async (req, reply) =>
    reply.code(201).send(await brand.createCampaign(ctx, P(req), params(req, 'brandId').brandId, req.body)));

  app.get('/api/brands/:brandId/slots', async (req) => {
    const { brandId } = params(req, 'brandId');
    const q = z.object({ status: z.enum(['empty']).optional(), from: date.optional(), to: date.optional() }).parse(req.query);
    if (q.status === 'empty') {
      // Without a range: from today to a month ahead, which is what an agent looking for work wants.
      const range = await brand.defaultRange(ctx, brandId, q.from, q.to);
      return pubs.emptySlots(ctx, P(req), brandId, range.from, range.to);
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

  // "For you": what waits for this person, what goes out today, what needs a hand and what just happened.
  app.get('/api/brands/:brandId/overview', async (req) => overview.brandOverview(ctx, userOnly(req), params(req, 'brandId').brandId));
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

  // Sending a big file in pieces (services/resumable.ts). A piece is raw bytes, so this content type is read as they are and only here.
  await app.register(async (up) => {
    up.addContentTypeParser('application/offset+octet-stream', { parseAs: 'buffer', bodyLimit: resumable.MAX_CHUNK_BYTES }, (_req, body, done) => done(null, body));
    up.get('/api/uploads/:id/resumable', async (req, reply) => reply.header('cache-control', 'no-store').send(await resumable.uploadProgress(ctx, P(req), params(req, 'id').id)));
    up.patch('/api/uploads/:id/resumable', { bodyLimit: resumable.MAX_CHUNK_BYTES }, async (req, reply) => {
      // Digits only: Number() would read '' as 0 and '1e3' as 1000.
      const offset = Number(z.string().regex(/^\d{1,15}$/, 'Upload-Offset must be the number of bytes already sent').parse(req.headers['upload-offset']));
      if (!Buffer.isBuffer(req.body)) throw badRequest('invalid_piece', 'Send the bytes with the content type application/offset+octet-stream');
      return reply.header('cache-control', 'no-store').send(await resumable.appendPiece(ctx, P(req), params(req, 'id').id, offset, req.body));
    });
    up.post('/api/uploads/:id/resumable/finish', async (req) => resumable.finishUpload(ctx, P(req), params(req, 'id').id));
  });

  // ───────────────────────────── versions, comments, approvals ─────────────────────────────

  // Previews for the pieces list: the piece's address redirects to its latest version's, which never changes and is cached for good.
  const thumbWidth = (q: unknown) => {
    const w = Number((q as { w?: string } | null)?.w ?? 480);
    return (thumbs.THUMB_WIDTHS as readonly number[]).includes(w) ? (w as thumbs.ThumbWidth) : 480;
  };
  app.get('/api/pieces/:id/thumb', async (req, reply) => {
    const versionId = await thumbs.latestVersionId(ctx, P(req), params(req, 'id').id);
    if (!versionId) throw notFound('Preview');
    return reply.header('cache-control', 'private, max-age=30').redirect(`/api/versions/${versionId}/thumb?w=${thumbWidth(req.query)}`);
  });
  app.get('/api/versions/:id/thumb', async (req, reply) => {
    const jpg = await thumbs.versionThumb(ctx, P(req), params(req, 'id').id, thumbWidth(req.query));
    if (!jpg) throw notFound('Preview');
    return reply.header('content-type', 'image/jpeg').header('cache-control', 'private, max-age=31536000, immutable').send(jpg);
  });
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
  app.post('/api/comments/:id/people-only', async (req) =>
    comments.setPeopleOnly(ctx, P(req), params(req, 'id').id, (req.body as { value?: unknown } | null)?.value));

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
