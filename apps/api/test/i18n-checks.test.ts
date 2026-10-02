import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { lifetimeOf } from '../src/services/selfcheck.js';
import { createEnv, type Env } from './helpers.js';

/**
 * The readiness checks and connecting an account speak the language of whoever asks: the web sends Accept-Language (es or en), and
 * anything else, or nothing, means Spanish. What is kept on the account (why Meta does not push its comments) is kept as a code and
 * read in the reader's language.
 */
let env: Env;
let ig: string;
beforeAll(async () => {
  env = await createEnv({}, { fakes: true });
  ig = await env.connect('instagram');
});
afterAll(async () => { await env.close(); });

const brandUrl = (p: string) => `/api/brands/${env.brandId}${p}`;
const find = (results: { id: string }[], id: string) => results.find((r) => r.id === id) as { id: string; status: string; title: string; detail: string; hint?: string };

/** Starts a Meta sign-in and comes back from it as a browser that asks for `lang`. */
async function signIn(lang: string | null, code = 'good') {
  const start = await env.call(env.users.admin, 'POST', brandUrl('/connections/meta'), {});
  const state = new URL(start.body.url).searchParams.get('state')!;
  const back = await env.app.inject({
    method: 'GET', url: `/api/oauth/callback?code=${code}&state=${state}`, headers: { cookie: env.users.admin.cookie!, ...(lang ? { 'accept-language': lang } : {}) },
  });
  return new URL(back.headers.location as string, 'http://app.test');
}

describe('the server check', () => {
  it('is in Spanish when asked for it or when nothing is asked, and in English when asked', async () => {
    for (const lang of ['es', null, 'fr-FR']) {
      const r = await env.callIn(lang, env.users.admin, 'GET', brandUrl('/server-check'));
      expect(r.status).toBe(200);
      expect(find(r.body, 'token_key')).toMatchObject({ title: 'Clave de los tokens', detail: 'TOKEN_KEY está puesta, así que los tokens de las redes se guardan cifrados.' });
      expect(find(r.body, 'app_url')).toMatchObject({ title: 'Dirección pública', detail: 'APP_URL es http://app.test, que no es https.' });
    }
    const en = await env.callIn('en', env.users.admin, 'GET', brandUrl('/server-check'));
    expect(find(en.body, 'token_key')).toMatchObject({ title: 'Token key', detail: 'TOKEN_KEY is set, so network tokens are kept sealed.' });
    expect(find(en.body, 'app_url')).toMatchObject({ detail: 'APP_URL is http://app.test, which is not https.', hint: expect.stringMatching(/^Most networks refuse an http redirect/) });
  });
});

describe("an account's check", () => {
  it('says each result in the language asked for, the Meta subscription line included', async () => {
    const es = await env.callIn('es', env.users.admin, 'POST', brandUrl(`/accounts/${ig}/check`));
    expect(es.status).toBe(200);
    expect(find(es.body.results, 'connected')).toMatchObject({ title: 'Conexión', detail: 'Conectada, y nada le ha dicho a la app lo contrario.' });
    const health = find(es.body.results, 'health');
    expect(health.title).toBe('La red acepta la conexión');
    expect(health.detail).toMatch(/^Ha respondido en \d/);
    // Without pages_manage_metadata Meta does not say whether the app is subscribed: the line says so, and what the network said as it said it.
    expect(health.detail).toContain('No se ha podido saber si la app está suscrita a los eventos de la página ((#200) Requires pages_manage_metadata');
    expect(find(es.body.results, 'metrics')).toMatchObject({ status: 'skip', detail: 'La app todavía no ha publicado ningún post en esta cuenta.' });

    const en = await env.callIn('en', env.users.admin, 'POST', brandUrl(`/accounts/${ig}/check`));
    expect(find(en.body.results, 'connected')).toMatchObject({ title: 'Connection', detail: 'Connected, and nothing has told the app otherwise.' });
    expect(find(en.body.results, 'health').detail).toContain("Could not read whether the app is subscribed to the Page's events ((#200)");
  });

  it('says how long a token has left the way each language writes it', () => {
    expect(lifetimeOf(30_000, 'es')).toBe('1 minuto');
    expect(lifetimeOf(59 * 60_000, 'es')).toBe('59 minutos');
    expect(lifetimeOf(2 * 3600_000, 'es')).toBe('2 horas');
    expect(lifetimeOf(3 * 86_400_000, 'es')).toBe('3,0 días');
    expect(lifetimeOf(3 * 86_400_000, 'en')).toBe('3.0 days');
    expect(lifetimeOf(40 * 86_400_000, 'en')).toBe('40 days');
  });
});

describe('connecting', () => {
  it('tells a failed sign-in in the language of the browser that comes back, and the network\'s own words as they came', async () => {
    const none = env.meta.pages;
    env.meta.pages = [];
    try {
      expect((await signIn('es-ES,es;q=0.9,en;q=0.8')).searchParams.get('connect_error')).toMatch(/^Meta no ha compartido ninguna página/);
      expect((await signIn(null)).searchParams.get('connect_error')).toMatch(/^Meta no ha compartido ninguna página/);
      expect((await signIn('en-US,en;q=0.9')).searchParams.get('connect_error')).toMatch(/^Meta did not share any Page/);
    } finally {
      env.meta.pages = none;
    }
    // A refusal worded by the network is passed on as it is, whatever the language.
    expect((await signIn('es', 'bad')).searchParams.get('connect_error')).toMatch(/verification code/);
  });

  it('answers the errors of connecting in the language asked for', async () => {
    const yt = await env.connect('youtube', { externalId: 'UC-i18n', name: 'Canal' });
    const es = await env.callIn('es', env.users.admin, 'POST', brandUrl('/connections/meta'), { reconnectAccountId: yt });
    expect(es.body.error).toMatchObject({ code: 'wrong_provider', message: 'Esa cuenta es de otra red' });
    const en = await env.callIn('en', env.users.admin, 'POST', brandUrl('/connections/meta'), { reconnectAccountId: yt });
    expect(en.body.error.message).toBe('That account is on a different network');

    const missing = await env.callIn(null, env.users.admin, 'POST', brandUrl('/connections/bluesky/credentials'), { values: {} });
    expect(missing.body.error).toMatchObject({ code: 'missing_field', message: 'Falta el usuario' });
    expect((await env.call(env.users.admin, 'POST', brandUrl('/connections/bluesky/credentials'), { values: {} })).body.error.message).toBe('Handle is needed');

    const list = await env.callIn('es', env.users.admin, 'GET', brandUrl('/integrations'));
    const meta = list.body.providers.find((p: any) => p.id === 'meta');
    expect(meta.label).toBe('Facebook e Instagram');
    const bluesky = list.body.providers.find((p: any) => p.id === 'bluesky');
    expect(bluesky.fields.map((f: any) => f.label)).toEqual(['Usuario', 'Contraseña de app', 'Servidor']);
    expect((await env.call(env.users.admin, 'GET', brandUrl('/integrations'))).body.providers.find((p: any) => p.id === 'meta').label).toBe('Facebook and Instagram');
  });

  it("keeps why Meta does not push an account's comments as a code, and the account list reads it in each language", async () => {
    env.meta.pages = [{ id: '901', name: 'Quiet Page', token: 'page-token-901' }];
    try {
      const start = await env.call(env.users.admin, 'POST', brandUrl('/connections/meta'), {});
      const state = new URL(start.body.url).searchParams.get('state')!;
      const back = await env.app.inject({ method: 'GET', url: `/api/oauth/callback?code=good&state=${state}`, headers: { cookie: env.users.admin.cookie! } });
      const pending = new URL(back.headers.location as string, 'http://app.test').searchParams.get('connection')!;
      const chosen = await env.call(env.users.admin, 'POST', brandUrl(`/connections/${pending}/select`), { keys: ['facebook:901'] });
      const id = chosen.body[0].id as string;
      // Kept: the English note, and the code beside it.
      const events = (await env.db.one('select provider_data from social_account where id = $1', [id]))!.provider_data.events;
      expect(events).toMatchObject({ subscribed: false, note: expect.stringContaining('pages_manage_metadata'), note_i18n: { code: 'connect.events.noPermission' } });

      const inEs = (await env.callIn('es', env.users.reader, 'GET', brandUrl('/accounts'))).body.find((a: any) => a.id === id);
      expect(inEs.details.events.note).toMatch(/^Sin suscripción a los eventos de la página: hace falta pages_manage_metadata/);
      expect(inEs.details.events).not.toHaveProperty('note_i18n');
      const inEn = (await env.call(env.users.reader, 'GET', brandUrl('/accounts'))).body.find((a: any) => a.id === id);
      expect(inEn.details.events.note).toMatch(/^Not subscribed to the Page's events/);
    } finally {
      env.meta.pages = [{ id: '111', name: 'Lumen Coffee', token: 'page-token-111', ig: { id: '222', username: 'lumen.coffee' } }];
    }
  });
});
