import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { acceptLanguage, english, localeOf, msg, render, renderStored, t, withLocale, tr } from '../src/i18n/index.js';
import { AREA_LIST, MESSAGES } from '../src/i18n/messages/index.js';
import { expireRuns } from '../src/services/agent.js';
import { createEnv, type Env } from './helpers.js';

/**
 * The API in two languages: one dictionary with both side by side, the request's language for what is said while answering, and texts
 * kept as codes for what is said later, put into words in the language of whoever reads them.
 */
describe('the dictionary', () => {
  const placeholders = (m: unknown) => [...new Set(JSON.stringify(m).match(/\{(\w+)\}/g) ?? [])].sort();

  it('says the same things in both languages, with the same placeholders, and no key twice', () => {
    let keys = 0;
    for (const area of AREA_LIST) {
      const es = area.es as Record<string, unknown>;
      const en = area.en as Record<string, unknown>;
      expect(Object.keys(en).sort()).toEqual(Object.keys(es).sort());
      for (const k of Object.keys(es)) {
        expect(placeholders(en[k]), k).toEqual(placeholders(es[k]));
        expect(String(JSON.stringify(es[k])).trim(), k).not.toBe('""');
        keys++;
      }
    }
    expect(Object.keys(MESSAGES.es)).toHaveLength(keys); // merging would have thrown on a key defined twice
    expect(keys).toBeGreaterThan(300);
  });

  it('fills placeholders, plural forms and texts inside texts, and formats numbers the way each language writes them', () => {
    const nested = msg('pub.needsPerson', { message: msg('pub.freeze.missed', { at: 'X', reason: msg('pub.freeze.blockedWhy', { day: '2026-12-24', reason: 'Nochebuena' }) }) });
    expect(render('es', nested)).toBe('Tenía que salir el X, pero el 2026-12-24 estaba bloqueado (Nochebuena), así que la app no la ha publicado. Ahora le toca a una persona: publícala a mano o cancélala.');
    expect(english(nested)).toBe('It was due X, while 2026-12-24 is blocked (Nochebuena), so the app did not publish it. It now needs a person: publish it by hand or cancel it.');
    expect(t('es', 'pub.failedTimes', { message: 'Error', count: 1234.5 })).toBe('Error (ha fallado 1234,5 veces seguidas)');
    expect(t('en', 'pub.failedTimes', { message: 'Error', count: 1234.5 })).toBe('Error (failed 1,234.5 times in a row)');
    // A list of texts reads one after the other; a code this version does not know keeps the English kept beside it.
    expect(render('es', [msg('pub.hold.newVersion'), msg('pub.hold.approvalLapsed')])).toBe('Hay una versión nueva esperando aprobación La aprobación de esta publicación ya no vale');
    expect(render('es', { code: 'from.a.newer.version' }, 'Kept English')).toBe('Kept English');
  });

  it('takes the language from Accept-Language: English for en and its variants, Spanish for anything else or nothing', () => {
    expect(acceptLanguage('es')).toBe('es');
    expect(acceptLanguage('en')).toBe('en');
    expect(acceptLanguage('en-GB,en;q=0.9,es;q=0.8')).toBe('en');
    expect(acceptLanguage('es-ES,es;q=0.9,en;q=0.8')).toBe('es');
    expect(acceptLanguage('fr-FR')).toBe('es');
    expect(acceptLanguage(undefined)).toBe('es');
    expect(acceptLanguage('english')).toBe('es');
    expect(localeOf('en_GB.UTF-8')).toBe('en');
    expect(localeOf('es-ES')).toBe('es');
    expect(withLocale('en', () => tr('error.forbidden'))).toBe('You do not have permission to do this');
    expect(tr('error.forbidden')).toBe('No tienes permiso para hacer esto'); // outside a request: Spanish
  });

  it('puts kept texts into words on their way out, at any depth, and leaves English rows as they were', () => {
    const payload = {
      publications: [
        { id: 'a', hold_reason: 'A new version is awaiting approval', hold_reason_i18n: { code: 'pub.hold.newVersion' } },
        { id: 'b', hold_reason: 'Written before codes existed' },
        { id: 'c', last_error: 'Kept English', last_error_i18n: { code: 'from.a.newer.version' } },
      ],
      attempts: [{ detail: { message: 'x', message_i18n: [msg('pub.said', { text: 'Meta said no' }), msg('pub.hold.filesChanged')] } }],
      when: new Date(0),
    };
    renderStored('es', payload);
    expect(payload.publications).toEqual([
      { id: 'a', hold_reason: 'Hay una versión nueva esperando aprobación' },
      { id: 'b', hold_reason: 'Written before codes existed' },
      { id: 'c', last_error: 'Kept English' },
    ]);
    expect(payload.attempts[0]!.detail).toEqual({ message: 'Meta said no Los archivos guardados ya no coinciden con los aprobados' });
    expect(payload.when).toEqual(new Date(0));
  });
});

describe('the API in the request\'s language', () => {
  let env: Env;
  let ig: string;
  beforeAll(async () => {
    env = await createEnv({}, { fakes: true });
    ig = await env.connect('instagram');
  });
  afterAll(async () => { await env.close(); });
  const MIN = 60_000;

  async function scheduled() {
    const { variantId, pieceId } = await env.makePiece(env.users.producer, 'post', '4:5');
    const v = await env.newVersion(env.users.producer, variantId, [{ name: 'photo.png', mime: 'image/png', kind: 'image', data: Buffer.from(`p-${Math.random()}`) }]);
    expect((await env.approve(env.users.approver, v.body.id, [ig])).body.review_state).toBe('approved');
    const r = await env.call(env.users.approver, 'POST', `/api/versions/${v.body.id}/publications`, {
      accountId: ig, scheduledAt: new Date(env.clock.now().getTime() + 2 * 60 * MIN).toISOString(), text: 'Spring menu',
    });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    return { pub: r.body, variantId, pieceId, versionId: v.body.id as string };
  }

  it('answers errors in the language asked for, after reading a body too', async () => {
    const missing = '00000000-0000-4000-8000-000000000000';
    expect((await env.callIn('es', env.users.producer, 'GET', `/api/pieces/${missing}`)).body.error).toEqual({ code: 'not_found', message: 'No se ha encontrado la pieza' });
    expect((await env.callIn('en', env.users.producer, 'GET', `/api/pieces/${missing}`)).body.error).toEqual({ code: 'not_found', message: 'Piece not found' });
    expect((await env.callIn(null, env.users.producer, 'GET', `/api/pieces/${missing}`)).body.error.message).toBe('No se ha encontrado la pieza');
    // A POST whose body was read: the language is still the request's.
    const posted = await env.callIn('es', env.users.producer, 'POST', `/api/pieces/${missing}/variants`, { format: '1:1' });
    expect(posted.body.error.message).toBe('No se ha encontrado la pieza');
    expect((await env.callIn('es', null, 'GET', '/api/me')).body.error.message).toBe('Tienes que entrar primero');
    expect((await env.callIn('es', null, 'GET', '/api/no-such-thing')).body.error.message).toBe('No existe o ya no está disponible');
  });

  it('says why a post is planned by hand in the language asked for', async () => {
    const { variantId } = await env.makePiece(env.users.producer, 'post', '4:5');
    const v = await env.newVersion(env.users.producer, variantId, [{ name: 'p.png', mime: 'image/png', kind: 'image', data: Buffer.from('manual') }]);
    await env.approve(env.users.approver, v.body.id, [ig]);
    const body = { accountId: ig, scheduledAt: new Date(env.clock.now().getTime() + 3 * 60 * MIN).toISOString(), text: 'x', mode: 'manual' };
    expect((await env.callIn('es', env.users.approver, 'POST', `/api/versions/${v.body.id}/publications/validate`, body)).body.manualReason).toBe('Se ha elegido publicarla a mano');
    expect((await env.callIn('en', env.users.approver, 'POST', `/api/versions/${v.body.id}/publications/validate`, body)).body.manualReason).toBe('Chosen to be published by hand');
  });

  it('shows why a post is on hold and why it failed in the reader\'s language, on the piece, the calendar and the history', async () => {
    const held = await scheduled();
    expect((await env.newVersion(env.users.producer, held.variantId, [{ name: 'v2.png', mime: 'image/png', kind: 'image', data: Buffer.from(`v2-${Math.random()}`) }])).status).toBe(201);
    const failed = await scheduled();
    env.clock.set(new Date(new Date(failed.pub.scheduled_at).getTime() + 30 * MIN)); // nothing got to it in time
    await env.settle();

    const pubOf = async (locale: string | null, pieceId: string) => (await env.callIn(locale, env.users.reader, 'GET', `/api/pieces/${pieceId}`)).body.publications[0];
    expect((await pubOf('es', held.pieceId)).hold_reason).toBe('Hay una versión nueva esperando aprobación');
    expect((await pubOf('en', held.pieceId)).hold_reason).toBe('A new version is awaiting approval');
    expect(await pubOf('es', held.pieceId)).not.toHaveProperty('hold_reason_i18n');
    const es = await pubOf(null, failed.pieceId);
    expect(es).toMatchObject({ status: 'failed', last_error_class: 'missed_window' });
    expect(es.last_error).toBe(`Tenía que salir el ${new Date(failed.pub.scheduled_at).toISOString()} y no se pudo preparar a tiempo, así que no se ha publicado tarde.`);
    expect((await pubOf('en', failed.pieceId)).last_error).toBe(`It was due ${new Date(failed.pub.scheduled_at).toISOString()} and could not be prepared in time, so it was not published late.`);

    const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Madrid' }).format(new Date(failed.pub.scheduled_at));
    const cal = await env.callIn('es', env.users.reader, 'GET', `/api/brands/${env.brandId}/calendar?from=${day}&to=${day}`);
    expect(cal.body.publications.find((p: any) => p.id === failed.pub.id).last_error).toMatch(/^Tenía que salir el /);
    expect(cal.body.publications.find((p: any) => p.id === held.pub.id).hold_reason).toBe('Hay una versión nueva esperando aprobación');

    // The English stays in the database, for webhooks and older readers.
    expect((await env.db.one('select last_error from publication where id = $1', [failed.pub.id]))!.last_error).toMatch(/^It was due /);
    // A writer that changes the English without a code drops the translation: everyone reads the new English.
    await env.db.query(`update publication set hold_reason = 'Held by hand' where id = $1`, [held.pub.id]);
    expect((await pubOf('es', held.pieceId)).hold_reason).toBe('Held by hand');
  });

  it('shows the studio\'s note on an agent run it closed in the reader\'s language, and tells people with a kind of its own', async () => {
    const { pieceId } = await env.makePiece(env.users.producer);
    const tok = (await env.call(env.users.admin, 'POST', `/api/brands/${env.brandId}/tokens`, { name: 'agent' })).body.token as string;
    await env.call(env.users.admin, 'PATCH', `/api/brands/${env.brandId}`, { agent: { enabled: true, max_cost_per_piece: 5, max_cost_per_month: 50 } });
    const started = await env.app.inject({ method: 'POST', url: `/api/pieces/${pieceId}/agent-runs`, headers: { authorization: `Bearer ${tok}` }, payload: { trigger: 'manual' } });
    expect(started.statusCode, started.body).toBe(201);
    env.clock.advance(6 * 3600_000);
    expect(await expireRuns(env.ctx)).toBe(1);
    const runs = async (locale: string) => (await env.callIn(locale, env.users.reader, 'GET', `/api/pieces/${pieceId}/agent`)).body.runs;
    expect((await runs('es'))[0]).toMatchObject({ outcome: 'timeout', notes: 'El runner dejó de informar o se pasó del tiempo máximo de una ejecución, así que el estudio la cerró' });
    expect((await runs('en'))[0].notes).toBe('The runner stopped reporting, or ran past the longest run, so the studio closed the run');
    const told = await env.db.query(`select kind from notification where payload->>'pieceId' = $1`, [pieceId]);
    expect(told.map((n) => n.kind)).toContain('agent.timed_out');
    expect(told.map((n) => n.kind)).not.toContain('agent.failed');
  });
});
