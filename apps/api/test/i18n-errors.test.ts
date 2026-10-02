import { createHash, randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { render } from '../src/i18n/index.js';
import { scanPrizeDeliveries } from '../src/services/prizes.js';
import { createEnv, type Env } from './helpers.js';

/**
 * The errors a person reads, in their language: Spanish by default (no Accept-Language, or anything but English), English when asked.
 * One sample of each area, and the reasons a prize could not be sent, which are kept as codes and said in the reader's language later.
 */
let env: Env;
beforeAll(async () => { env = await createEnv(); });
afterAll(async () => { await env.close(); });

const sha = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');
const brandUrl = (p: string) => `/api/brands/${env.brandId}${p}`;

/** The same request in Spanish (asked, and by default) and in English: the code and the status never change, only the words. */
async function both(as: Parameters<Env['callIn']>[1], method: string, url: string, body?: unknown) {
  const es = await env.callIn('es', as, method, url, body);
  const none = await env.callIn(null, as, method, url, body);
  const en = await env.callIn('en', as, method, url, body);
  expect(none.status).toBe(es.status);
  expect(none.body.error.code).toBe(es.body.error.code);
  expect(none.body.error.message).toBe(es.body.error.message); // Spanish is the default
  expect(en.status).toBe(es.status);
  expect(en.body.error.code).toBe(es.body.error.code);
  return { status: es.status, code: es.body.error.code as string, es: es.body.error.message as string, en: en.body.error.message as string };
}

async function approvedVersion() {
  const { variantId, pieceId } = await env.makePiece(env.users.producer);
  const v = await env.newVersion(env.users.producer, variantId);
  expect((await env.approve(env.users.approver, v.body.id, [env.accounts.instagram])).body.review_state).toBe('approved');
  return { versionId: v.body.id as string, variantId, pieceId };
}

describe('scheduling', () => {
  it('a date in the past, and a state named as a word in each language', async () => {
    const { versionId } = await approvedVersion();
    const past = await both(env.users.approver, 'POST', `/api/versions/${versionId}/publications`, {
      accountId: env.accounts.instagram, scheduledAt: new Date(Date.now() - 3600_000).toISOString(), text: 'x', mode: 'manual',
    });
    expect(past).toMatchObject({ status: 400, code: 'past_date', es: 'La fecha tiene que ser futura', en: 'The date must be in the future' });

    const pub = await env.call(env.users.approver, 'POST', `/api/versions/${versionId}/publications`, {
      accountId: env.accounts.instagram, scheduledAt: new Date(Date.now() + 3 * 3600_000).toISOString(), text: 'x', mode: 'manual',
    });
    expect(pub.status, JSON.stringify(pub.body)).toBe(201);
    expect((await env.call(env.users.approver, 'POST', `/api/publications/${pub.body.id}/cancel`)).status).toBe(200);
    const again = await both(env.users.approver, 'POST', `/api/publications/${pub.body.id}/cancel`);
    expect(again).toMatchObject({ status: 409, code: 'invalid_state', es: 'No se puede cancelar una publicación cancelada', en: 'A cancelled publication cannot be cancelled' });
  });
});

describe('approving and commenting', () => {
  it('one\'s own upload, and a comment that does not fit the version (with a plural)', async () => {
    const { variantId } = await env.makePiece(env.users.approver);
    const v = await env.newVersion(env.users.approver, variantId);
    const own = await both(env.users.approver, 'POST', `/api/versions/${v.body.id}/approvals`, { decision: 'approve', accountIds: [env.accounts.instagram] });
    expect(own).toMatchObject({ status: 403, es: 'No puedes aprobar una versión que has subido tú', en: 'You cannot approve a version you uploaded yourself' });

    const late = await both(env.users.reviewer, 'POST', `/api/versions/${v.body.id}/comments`, { body: 'x', anchor: { type: 'time', t: 99 } });
    expect(late).toMatchObject({ code: 'invalid_anchor', es: 'Ese momento es posterior al final del vídeo', en: 'The moment is after the end of the video' });
    const page = await both(env.users.reviewer, 'POST', `/api/versions/${v.body.id}/comments`, { body: 'x', anchor: { type: 'region', page: 3, x: 0, y: 0 } });
    expect(page).toMatchObject({ es: 'La versión solo tiene 1 página', en: 'The version only has 1 page(s)' });
    expect(render('es', { code: 'error.approval.openComments', params: { count: 2 } })).toBe('Hay 2 comentarios abiertos: resuélvelos antes de aprobar');
    expect(render('en', { code: 'error.approval.openComments', params: { count: 2 } })).toBe('There are 2 open comment(s): resolve them before approving');
  });
});

describe('uploading', () => {
  it('a version whose files do not fit its variant, and an upload that was not made to be resumed', async () => {
    const { variantId } = await env.makePiece(env.users.producer);
    const ids = await env.upload(env.users.producer, variantId, [
      { name: 'a.mp4', mime: 'video/mp4' }, { name: 'c1.jpg', mime: 'image/jpeg', data: randomBytes(40) }, { name: 'c2.jpg', mime: 'image/jpeg', data: randomBytes(41) },
    ]);
    const files = [{ uploadId: ids[0], kind: 'video', position: 0 }, { uploadId: ids[1], kind: 'cover', position: 1 }, { uploadId: ids[2], kind: 'cover', position: 2 }];
    const covers = await env.callIn('es', env.users.producer, 'POST', `/api/variants/${variantId}/versions`, { files });
    expect(covers.body.error).toMatchObject({ code: 'invalid_files', message: 'Solo puede haber una portada' });
    const coversEn = await env.call(env.users.producer, 'POST', `/api/variants/${variantId}/versions`, { files });
    expect(coversEn.body.error.message).toBe('There can be only one cover');

    const data = randomBytes(100);
    const direct = await env.call(env.users.producer, 'POST', `/api/variants/${variantId}/uploads`, { files: [{ name: 'd.mp4', mime: 'video/mp4', bytes: data.length, sha256: sha(data) }] });
    const notResumable = await both(env.users.producer, 'GET', `/api/uploads/${direct.body.uploads[0].uploadId}/resumable`);
    expect(notResumable).toMatchObject({ code: 'not_resumable', es: 'Esta subida no se hizo para enviarse por partes', en: 'This upload was not made to be sent in pieces' });
  });
});

describe('settings, people and access', () => {
  it('webhooks and Slack without the key, a member twice, a role that cannot, a stale sign-in link and an authenticator that is not there', async () => {
    const hook = await both(env.users.admin, 'POST', brandUrl('/webhooks'), { url: 'https://receiver.example/hook', events: ['version.approved'] });
    expect(hook).toMatchObject({ code: 'token_key_missing', es: expect.stringMatching(/^Los webhooks guardan sus secretos cifrados/), en: expect.stringMatching(/^Webhooks keep their secrets sealed/) });
    const slack = await both(env.users.admin, 'PUT', brandUrl('/slack'), { url: 'https://hooks.slack.com/services/T/B/x', kinds: ['version.uploaded'] });
    expect(slack).toMatchObject({ code: 'no_token_key', es: 'Slack necesita TOKEN_KEY en el servidor: cifra la dirección del webhook' });

    const twice = await both(env.users.admin, 'POST', brandUrl('/members'), { email: env.users.reviewer.email, role: 'reviewer' });
    expect(twice).toMatchObject({ status: 409, es: 'Esa persona ya es miembro de esta marca', en: 'That person is already a member of this brand' });

    const role = await both(env.users.reader, 'PATCH', brandUrl(''), { name: 'Renamed' });
    expect(role).toMatchObject({ status: 403, es: 'Tu rol (lector) no puede hacer esto', en: 'Your role (reader) cannot do this' });

    const link = await both(null, 'POST', '/api/auth/verify', { token: 'not-a-real-token-at-all' });
    expect(link).toMatchObject({ status: 401, es: 'El enlace no es válido o ha caducado', en: 'That link is invalid or has expired' });

    const none = await both(env.users.reviewer, 'POST', '/api/auth/2fa/disable', { code: '123456' });
    expect(none).toMatchObject({ code: 'not_enrolled', es: 'No hay ningún autenticador configurado.', en: 'No authenticator is set up.' });
  });
});

describe('prizes', () => {
  it('says why a prize could not be sent in the reader\'s language, kept as a code; and the person\'s link page too', async () => {
    const { versionId } = await approvedVersion();
    const pub = await env.call(env.users.approver, 'POST', `/api/versions/${versionId}/publications`, {
      accountId: env.accounts.instagram, scheduledAt: new Date(Date.now() + 3 * 3600_000).toISOString(), text: 'Comment RECIPE', mode: 'manual',
    });
    expect(pub.status, JSON.stringify(pub.body)).toBe(201);
    const prize = (await env.db.one(`insert into prize (brand_id, name, kind, url) values ($1, 'Recipes', 'link', 'https://lumen.example/r.pdf') returning id`, [env.brandId]))!;
    const rule = (await env.db.one(
      `insert into prize_rule (brand_id, publication_id, prize_id, keyword, keyword_norm, message, notice_confirmed, active)
       values ($1,$2,$3,'Recipe','recipe','Here: {{link}}', true, true) returning id`,
      [env.brandId, pub.body.id, prize.id],
    ))!;
    const delivery = async (person: string, commentAgoMs: number, extra = '') => (await env.db.one(
      `insert into prize_delivery (rule_id, prize_id, brand_id, publication_id, account_id, network, comment_id, person_id, person_name, comment_at, purge_after, next_attempt_at${extra ? ', token_hash' : ''})
       values ($1,$2,$3,$4,$5,'instagram',$6,$7,$7, now() - make_interval(secs => $8), now() + interval '30 days', now()${extra ? ', $9' : ''}) returning id`,
      [rule.id, prize.id, env.brandId, pub.body.id, env.accounts.instagram, `c-${person}`, person, commentAgoMs / 1000, ...(extra ? [extra] : [])],
    ))!.id as string;
    // The account is not connected (it is published by hand), so nothing can be sent: one waits, one has run out of Meta's 7 days.
    const waiting = await delivery('ana', 60_000);
    const late = await delivery('bea', 7 * 86_400_000 - 30 * 60_000);
    expect(await scanPrizeDeliveries(env.ctx)).toBe(2);

    const row = (await env.db.one('select reason, reason_i18n from prize_delivery where id = $1', [waiting]))!;
    expect(row.reason).toBe('The account has to be connected again before it can send messages'); // the English, as before
    expect(row.reason_i18n).toEqual({ code: 'prize.reason.reconnect' });

    const listed = async (locale: string) => (await env.callIn(locale, env.users.approver, 'GET', `/api/publications/${pub.body.id}/prize/deliveries`)).body as any[];
    const es = await listed('es');
    expect(es.find((d) => d.id === waiting)).toMatchObject({ status: 'pending', reason: 'Hay que volver a conectar la cuenta para que pueda enviar mensajes' });
    expect(es.find((d) => d.id === late)).toMatchObject({
      status: 'failed', reason: 'Hay que volver a conectar la cuenta para que pueda enviar mensajes (y se acabaron los 7 días que da Meta para responder)',
    });
    expect(es[0]).not.toHaveProperty('reason_i18n');
    const en = await listed('en');
    expect(en.find((d) => d.id === late)!.reason).toBe('The account has to be connected again before it can send messages (and the 7 days Meta allows for a reply ran out)');

    // A link that was never sent, opened by the person: the page answers in their browser's language.
    const secret = randomBytes(24).toString('base64url');
    await env.db.query('update prize_delivery set token_hash = $2 where id = $1', [waiting, sha(secret)]);
    const page = await both(null, 'GET', `/api/public/prizes/${secret}`);
    expect(page).toMatchObject({ status: 410, code: 'expired', es: 'Este enlace ha caducado.', en: 'This link has expired.' });
  });
});
