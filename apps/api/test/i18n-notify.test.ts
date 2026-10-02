import { createHash, randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sendPendingEmails } from '../src/background.js';
import { msg } from '../src/i18n/index.js';
import { magicLinksSettled } from '../src/services/auth.js';
import { describeNotification, notifyRoles, type NotifyKind } from '../src/services/notify.js';
import { sendPendingPush } from '../src/services/push.js';
import { resetByEmail } from '../src/services/secondfactor.js';
import { sendPendingSlack } from '../src/services/slack.js';
import { FakePushService } from './fakes/push.js';
import { FakeSlack } from './fakes/slack.js';
import { createEnv, type Env } from './helpers.js';

/**
 * Emails, Slack and push in two languages: Spanish unless the brand publishes in English, or the person chose a language for
 * themselves. The test brand publishes in English (see helpers.ts); each test here sets the language it is about.
 */
const slack = new FakeSlack();
const push = new FakePushService();
let env: Env;
let pieceId: string;
let pieceTitle: string;
beforeAll(async () => {
  await slack.start();
  await push.start();
  env = await createEnv({ TOKEN_KEY: Buffer.alloc(32, 5).toString('base64'), SLACK_HOOK_HOST: new URL(slack.url).host });
  const p = await env.makePiece(env.users.producer);
  pieceId = p.pieceId;
  pieceTitle = (await env.db.one<{ title: string }>('select title from piece where id = $1', [pieceId]))!.title;
});
afterAll(async () => { await env.close(); await slack.stop(); await push.stop(); });

const brandLocale = (locale: string) => env.db.query('update brand set locale = $2 where id = $1', [env.brandId, locale]);
const brandUrl = (p: string) => `/api/brands/${env.brandId}${p}`;
const mailsTo = (to: string) => env.mails.filter((m) => m.to === to);
const drain = async () => { while ((await sendPendingEmails(env.ctx)) > 0); };

beforeEach(async () => {
  await env.db.query('delete from notification');
  await env.db.query('delete from slack_hook');
  await env.db.query('delete from push_subscription');
  await env.db.query(`update app_user set notify_prefs = '{}'`);
  await brandLocale('es');
  env.mails.length = 0;
  slack.posts.length = 0;
  push.received.length = 0;
});

describe('emails', () => {
  it('sends the sign-in link in Spanish for a Spanish brand, and in English for whoever chose English', async () => {
    const ask = () => env.app.inject({ method: 'POST', url: '/api/auth/magic-link', payload: { email: 'approver@example.com' } });
    await ask();
    await magicLinksSettled(env.ctx);
    const [es] = mailsTo('approver@example.com');
    expect(es!.subject).toBe('Tu enlace para entrar');
    expect(es!.text).toMatch(/^Usa este enlace para entrar \(vale 15 minutos y solo funciona una vez\):\n\nhttp:\/\/app\.test\/auth\/callback\?token=/);

    expect((await env.callIn('es', env.users.approver, 'PUT', '/api/notifications/locale', { locale: 'en' })).status).toBe(200);
    env.mails.length = 0;
    await ask();
    await magicLinksSettled(env.ctx);
    expect(mailsTo('approver@example.com')[0]!.subject).toBe('Your sign-in link');
    expect(mailsTo('approver@example.com')[0]!.text).toMatch(/^Use this link to sign in \(valid for 15 minutes, works once\)/);
  });

  it('writes the sign-in link in English only when every brand of the person publishes in English', async () => {
    await brandLocale('en-GB');
    await env.app.inject({ method: 'POST', url: '/api/auth/magic-link', payload: { email: 'reviewer@example.com' } });
    await magicLinksSettled(env.ctx);
    expect(mailsTo('reviewer@example.com')[0]!.subject).toBe('Your sign-in link');
    // A second brand in Spanish: Spanish, the default.
    const other = (await env.db.one<{ id: string }>(`insert into brand (workspace_id, name, timezone) values ($1,'Otra marca','Europe/Madrid') returning id`, [env.workspaceId]))!;
    await env.db.query(`insert into member (user_id, brand_id, role) values ($1,$2,'reader')`, [env.users.reviewer.id, other.id]);
    env.mails.length = 0;
    await env.app.inject({ method: 'POST', url: '/api/auth/magic-link', payload: { email: 'reviewer@example.com' } });
    await magicLinksSettled(env.ctx);
    expect(mailsTo('reviewer@example.com')[0]!.subject).toBe('Tu enlace para entrar');
    await env.db.query('delete from member where brand_id = $1', [other.id]);
  });

  it('invites someone from another workspace in the language of the brand that invites them', async () => {
    const ws = (await env.db.one<{ id: string }>(`insert into workspace (name) values ('Elsewhere') returning id`))!;
    const theirs = (await env.db.one<{ id: string }>(`insert into brand (workspace_id, name, timezone, locale) values ($1,'Theirs','UTC','en') returning id`, [ws.id]))!;
    for (const [email, locale] of [['lead@elsewhere.test', 'es'], ['boss@elsewhere.test', 'en']] as const) {
      await brandLocale(locale);
      const u = (await env.db.one<{ id: string }>('insert into app_user (email) values ($1) returning id', [email]))!;
      await env.db.query(`insert into member (user_id, brand_id, role) values ($1,$2,'admin')`, [u.id, theirs.id]);
      const r = await env.call(env.users.admin, 'POST', brandUrl('/members'), { email, role: 'approver' });
      expect(r.status).toBe(202);
    }
    for (let i = 0; i < 100 && mailsTo('boss@elsewhere.test').length === 0; i++) await new Promise((r) => setTimeout(r, 10)); // sent after the answer
    const [es] = mailsTo('lead@elsewhere.test');
    expect(es!.subject).toBe('Invitación a Test brand');
    expect(es!.text).toContain('admin@example.com te ha invitado a Test brand (Test workspace) como aprobador.');
    expect(es!.text).toContain('«Tu cuenta» (vale 14 días)');
    const [en] = mailsTo('boss@elsewhere.test');
    expect(en!.subject).toBe('Invitation to Test brand');
    expect(en!.text).toContain('admin@example.com invited you to Test brand (Test workspace) as approver.');
  });

  it('tells about a failed post in Spanish, with the reason kept as a code, and in English to whoever chose English', async () => {
    const at = '2026-10-02T17:00:00.000Z';
    const why = msg('pub.notSentLate', { at, minutes: 15 });
    await notifyRoles(env.db, env.brandId, ['approver'], 'publication.failed', { pieceId, errorClass: 'missed_window', message: 'English kept beside it', message_i18n: why }, null);
    await env.db.query(`update app_user set notify_prefs = '{"locale":"en"}' where email = 'approver2@example.com'`);
    await drain();
    const [es] = mailsTo('approver@example.com');
    expect(es!.subject).toBe('[Test brand] No se ha podido publicar una publicación');
    expect(es!.text).toBe(`No se ha podido publicar una publicación\n\nPieza: ${pieceTitle}\nTenía que salir el ${at} y la app no pudo publicarla en los 15 minutos de margen, así que no se ha enviado tarde.\n\nhttp://app.test/pieces/${pieceId}\n`);
    const [en] = mailsTo('approver2@example.com');
    expect(en!.subject).toBe('[Test brand] A post could not be published');
    expect(en!.text).toContain(`It was due ${at} and the app was not able to publish it within 15 minutes, so it was not sent late.`);
  });

  it('tells the author changes were requested, in the brand\'s language', async () => {
    const { variantId } = await env.makePiece(env.users.producer);
    const v = await env.newVersion(env.users.producer, variantId);
    expect((await env.call(env.users.reviewer, 'POST', `/api/versions/${v.body.id}/request-changes`, { note: 'Más luz en la portada' })).status).toBe(200);
    await drain();
    const [es] = mailsTo('producer@example.com').filter((m) => m.subject.includes('cambios'));
    expect(es!.subject).toBe('[Test brand] Se han pedido cambios en una versión');
    expect(es!.text).toMatch(/^Se han pedido cambios en una versión\n\nPieza: /);

    await brandLocale('en');
    env.mails.length = 0;
    const v2 = await env.newVersion(env.users.producer, variantId);
    expect((await env.call(env.users.reviewer, 'POST', `/api/versions/${v2.body.id}/request-changes`, { note: 'More light' })).status).toBe(200);
    await drain();
    expect(mailsTo('producer@example.com').map((m) => m.subject)).toContain('[Test brand] Changes were requested on a version');
  });

  it('tells a person their authenticator was reset in their language, and waits for it when the command line does it', async () => {
    expect(await resetByEmail(env.ctx, 'approver2@example.com')).toBe(true);
    const [es] = mailsTo('approver2@example.com'); // already sent: the command line waits for it before it closes the database
    expect(es!.subject).toBe('Se ha quitado tu autenticador');
    expect(es!.text).toMatch(/^Quien gestiona el servidor ha quitado la app de autenticación de tu cuenta y ha cerrado tu sesión en todas partes\./);
    await brandLocale('en');
    env.mails.length = 0;
    await resetByEmail(env.ctx, 'approver2@example.com');
    expect(mailsTo('approver2@example.com')[0]!.text).toMatch(/^Whoever runs the server reset the authenticator app of your account/);
    // The reset ended the session of the test user: give it a new one for the tests after this.
    const token = randomBytes(24).toString('base64url');
    await env.db.query(`insert into session (token_hash, user_id, expires_at) values ($1,$2, now() + interval '1 day')`, [createHash('sha256').update(token).digest('hex'), env.users.approver2.id]);
    env.users.approver2.cookie = `sid=${token}`;
  });
});

describe('Slack and push', () => {
  it('posts to the channel in the brand\'s language, with the reason, and sends the test message the same way', async () => {
    const hook = `${slack.url}/services/T0001/B0001/abcdEFGH`;
    expect((await env.call(env.users.admin, 'PUT', brandUrl('/slack'), { url: hook, kinds: ['publication.handed_over'] })).status).toBe(200);
    const why = msg('pub.needsPerson', { message: msg('pub.freeze.missed', { at: '2026-10-02T17:00:00.000Z', reason: msg('pub.freeze.paused') }) });
    await notifyRoles(env.db, env.brandId, ['approver', 'admin'], 'publication.handed_over', { pieceId, handedOver: true, message: 'English', message_i18n: why }, null);
    expect(await sendPendingSlack(env.ctx)).toBe(1);
    expect(slack.posts[0]!.text).toBe(
      `*Test brand* · Una publicación ha pasado a publicarse a mano\nTenía que salir el 2026-10-02T17:00:00.000Z, pero la marca estaba en pausa, así que la app no la ha publicado. Ahora le toca a una persona: publícala a mano o cancélala.\n<http://app.test/pieces/${pieceId}|${pieceTitle}>`,
    );
    expect((await env.callIn('en', env.users.admin, 'POST', brandUrl('/slack/test'))).body).toEqual({ ok: true });
    expect(slack.posts[1]!.text).toBe('*Test brand* · Esto es un mensaje de prueba del estudio de contenidos. Si lo lees, Slack está bien configurado.');
  });

  it('pushes in the person\'s language', async () => {
    const browser = push.browser();
    expect((await env.call(env.users.approver, 'POST', '/api/push/subscriptions', { ...browser.subscription, userAgent: 'test' })).status).toBe(200);
    await notifyRoles(env.db, env.brandId, ['approver'], 'version.uploaded', { pieceId }, null);
    await sendPendingPush(env.ctx);
    expect(push.messagesFor(browser)[0]).toMatchObject({ title: '[Test brand] Hay una versión nueva para revisar', body: `Pieza: ${pieceTitle}` });
    await env.db.query(`update app_user set notify_prefs = '{"locale":"en"}' where email = 'approver@example.com'`);
    await notifyRoles(env.db, env.brandId, ['approver'], 'comment.created', { pieceId }, null);
    await sendPendingPush(env.ctx);
    expect(push.messagesFor(browser)[1]).toMatchObject({ title: '[Test brand] New comment on a piece', body: `Piece: ${pieceTitle}` });
  });
});

describe('a person\'s own language and the names of the kinds', () => {
  it('names the kinds in the request\'s language, keeps the chosen language when the kinds are saved, and forgets it on request', async () => {
    const es = await env.callIn('es', env.users.approver, 'GET', '/api/notifications/preferences');
    expect(es.body.kinds.find((k: any) => k.kind === 'publication.handed_over').label).toBe('Una publicación pasa a publicarse a mano');
    expect(es.body.locale).toBeNull();
    const en = await env.callIn('en', env.users.approver, 'GET', '/api/notifications/preferences');
    expect(en.body.kinds.find((k: any) => k.kind === 'agent.timed_out').label).toBe('An agent run runs out of time');

    expect((await env.call(env.users.approver, 'PUT', '/api/notifications/locale', { locale: 'en' })).body.locale).toBe('en');
    // The web saves the kinds without the language: the language stays.
    const kinds = await env.call(env.users.approver, 'PUT', '/api/notifications/preferences', { emailKinds: ['publication.failed'], pushKinds: [] });
    expect(kinds.body).toMatchObject({ locale: 'en', emailKinds: ['publication.failed'] });
    expect((await env.call(env.users.approver, 'PUT', '/api/notifications/preferences', { emailKinds: [], pushKinds: [], locale: 'es' })).body.locale).toBe('es');
    expect((await env.call(env.users.approver, 'PUT', '/api/notifications/locale', { locale: null })).body.locale).toBeNull();
    expect((await env.call(env.users.approver, 'PUT', '/api/notifications/locale', { locale: 'fr' })).status).toBe(400);
  });

  it('still describes notifications of the old shapes, in either language', () => {
    const old = describeNotification('es', 'http://app.test', 'publication.failed', { pieceId: 'p1', handedOver: true, message: 'It was due 2026-01-01T10:00:00.000Z, while the brand was paused, so the app did not publish it. It now needs a person: publish it by hand or cancel it.' }, 'Marca', 'Pieza uno');
    expect(old.subject).toBe('No se ha podido publicar una publicación');
    expect(old.body).toContain('Pieza: Pieza uno\nIt was due 2026-01-01T10:00:00.000Z'); // its English, as it was kept
    expect(describeNotification('en', 'http://app.test', 'agent.failed', { pieceId: 'p1', message: 'The runner stopped reporting' }, 'Brand', null).subject).toBe('An agent run failed');
    expect(describeNotification('es', 'http://app.test', 'no.such.kind', {}, 'Marca', null).subject).toBe('no.such.kind');
  });

  it('gives whoever chose the old kinds the new ones too, so they keep getting the same messages', async () => {
    await env.db.query(`insert into slack_hook (brand_id, url_sealed, hint, kinds) values ($1, '\\x00', '…x', $2)`, [env.brandId, ['publication.failed', 'agent.failed', 'version.uploaded']]);
    await env.db.query(`update app_user set notify_prefs = '{"pushOn":["publication.failed"],"emailOff":["agent.failed"]}' where email = 'admin@example.com'`);
    // What migration 012 does to what was there before it.
    const sql = await readFile(path.join(path.dirname(fileURLToPath(import.meta.url)), '../src/migrations/012_followups.sql'), 'utf8');
    const statements = sql.replace(/^\s*--.*$/gm, '').split(';').map((x) => x.trim());
    for (const stmt of statements.filter((x) => /^update (slack_hook|app_user)/.test(x))) await env.db.query(stmt);
    const hook = (await env.db.one<{ kinds: string[] }>('select kinds from slack_hook where brand_id = $1', [env.brandId]))!;
    expect(hook.kinds).toEqual(['publication.failed', 'agent.failed', 'version.uploaded', 'publication.handed_over', 'agent.timed_out']);
    const prefs = (await env.db.one<{ notify_prefs: any }>(`select notify_prefs from app_user where email = 'admin@example.com'`))!.notify_prefs;
    expect(prefs.pushOn).toEqual(['publication.failed', 'publication.handed_over']);
    expect(prefs.emailOff).toEqual(['agent.failed', 'agent.timed_out']);
  });
});

void ({} as NotifyKind);
