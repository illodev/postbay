import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { localizeOptions, localizePlacements, placementLabel } from '../src/connectors/labels.js';
import { createConnectorSet } from '../src/connectors/registry.js';
import type { Issue, Network, OptionField } from '../src/connectors/types.js';
import { issueText } from '../src/connectors/validate.js';
import { render, withLocale } from '../src/i18n/index.js';
import { MESSAGES } from '../src/i18n/messages/index.js';
import { FakeTikTok } from './fakes/tiktok.js';
import { account, configFor, env as cenv, image, input, media } from './connector-helpers.js';
import { createEnv, type Env } from './helpers.js';

/**
 * What scheduling says about a post, and the names of the placements and settings the schedule dialog shows, in Spanish (the default)
 * and in English: the same codes and values in both, the English exactly as it always read.
 */
const tiktok = new FakeTikTok();
let set: ReturnType<typeof createConnectorSet>;
const c = (n: Network) => set.connector(n)!;
const byCode = (issues: Issue[], code: string) => issues.find((i) => i.code === code)!;

beforeAll(async () => {
  await tiktok.start();
  set = createConnectorSet(configFor({
    META_APP_ID: 'app', META_APP_SECRET: 'secret', GOOGLE_CLIENT_ID: 'gid', GOOGLE_CLIENT_SECRET: 'gsecret',
    X_CLIENT_ID: 'xid', X_CLIENT_SECRET: 'xsecret', LINKEDIN_CLIENT_ID: 'lid', LINKEDIN_CLIENT_SECRET: 'lsecret',
    PINTEREST_APP_ID: 'pid', PINTEREST_APP_SECRET: 'psecret', THREADS_APP_ID: 'tid', THREADS_APP_SECRET: 'tsecret',
    TIKTOK_CLIENT_KEY: tiktok.clientKey, TIKTOK_CLIENT_SECRET: tiktok.clientSecret, TIKTOK_OAUTH_URL: `${tiktok.url}/authorize/`, TIKTOK_API_URL: tiktok.url,
  }));
});
afterAll(() => tiktok.stop());

describe('the checks every network shares', () => {
  const ig = account('instagram', { externalId: '222' });
  const long = input({ placement: 'reel', text: `${'x'.repeat(2300)} ${Array.from({ length: 31 }, (_, i) => `#t${i}`).join(' ')}` });

  it('are said in Spanish outside a request, and in English when English is asked for, with the same codes and values', () => {
    const es = c('instagram').validate(long, ig);
    const en = withLocale('en', () => c('instagram').validate(long, ig));
    expect(es.map((i) => i.code)).toEqual(en.map((i) => i.code));
    expect(es.map((i) => i.params)).toEqual(en.map((i) => i.params));
    const n = String(long.text.length);
    expect(byCode(es, 'text.length').message).toBe(`El texto tiene ${n} caracteres; Instagram admite 2200`);
    expect(byCode(en, 'text.length').message).toBe(`The text has ${n} characters; Instagram allows 2200`);
    expect(byCode(es, 'text.hashtags').message).toBe('El texto tiene 31 hashtags; Instagram admite 30');
    expect(byCode(en, 'text.hashtags').message).toBe('The text has 31 hashtags; Instagram allows 30');
  });

  it('name the placement in the reader\'s language, and write numbers as they always were', () => {
    const one = input({ placement: 'carousel', media: [image()] });
    expect(byCode(c('instagram').validate(one, ig), 'media.count').message).toBe('«Carrusel» lleva de 2 a 10 archivos; esta versión tiene 1');
    expect(byCode(withLocale('en', () => c('instagram').validate(one, ig)), 'media.count').message).toBe('Carousel takes 2 to 10 files; this version has 1');

    const tall = input({ placement: 'feed_image', media: [image({ width: 1080, height: 1920 })] });
    expect(byCode(c('instagram').validate(tall, ig), 'media.aspect').message)
      .toBe('photo.jpg mide 1080×1920; «Foto del feed» necesita una proporción de ancho a alto entre 0.80 y 1.91');
    expect(byCode(withLocale('en', () => c('instagram').validate(tall, ig)), 'media.aspect').message)
      .toBe('photo.jpg is 1080×1920; Feed photo needs a width-to-height ratio between 0.80 and 1.91');

    const empty = input({ placement: 'reel', media: [] });
    expect(withLocale('en', () => c('instagram').validate(empty, ig)).map((i) => i.message)).toContain('Reel takes exactly 1 file; this version has 0');
    expect(c('instagram').validate(empty, ig).map((i) => i.message)).toContain('«Reel» lleva exactamente 1 archivo; esta versión tiene 0');
    const picture = input({ placement: 'reel', media: [image()] });
    expect(c('instagram').validate(picture, ig).map((i) => i.message)).toContain('«Reel» no admite imágenes (photo.jpg)');
    expect(withLocale('en', () => c('instagram').validate(picture, ig)).map((i) => i.message)).toContain('Reel does not take images (photo.jpg)');
  });

  it('keep an issue as a code that can be said again later in either language', () => {
    const kept = issueText(byCode(c('instagram').validate(long, ig), 'text.length'));
    expect(kept.code).toBe('issue.text.length');
    expect(render('en', kept)).toMatch(/^The text has \d+ characters; Instagram allows 2200$/);
    expect(render('es', kept)).toMatch(/^El texto tiene \d+ caracteres; Instagram admite 2200$/);
  });
});

describe('what each network adds', () => {
  it('X words the length its own way, under the same code, kept with its own wording', () => {
    const x = account('x', { externalId: '4242' });
    const over = input({ placement: 'images', media: [image()], text: 'y'.repeat(300) });
    const es = byCode(c('x').validate(over, x), 'text.length');
    expect(es.message).toBe('X cuenta este texto como 300 de 280 (una dirección cuenta 23, y algunos caracteres, entre ellos los emojis, cuentan dos)');
    expect(byCode(withLocale('en', () => c('x').validate(over, x)), 'text.length').message)
      .toBe('X counts this text as 300 of 280 (an address counts 23, and some characters, emoji among them, count two)');
    expect(render('en', issueText(es))).toBe('X counts this text as 300 of 280 (an address counts 23, and some characters, emoji among them, count two)');
  });

  it('LinkedIn says what a document needs', () => {
    const li = account('linkedin', { externalId: '5001' });
    const none = input({ placement: 'document', media: [image()] });
    expect(c('linkedin').validate(none, li).map((i) => i.message)).toEqual(expect.arrayContaining([
      'Un documento de LinkedIn necesita exactamente un PDF en esta versión',
      'Las imágenes y los vídeos de esta versión no se envían: solo se publica el PDF como documento',
    ]));
    expect(withLocale('en', () => c('linkedin').validate(none, li)).map((i) => i.message)).toContain('A LinkedIn document needs exactly one PDF in this version');
  });

  it('TikTok keeps its agreement word for word inside a Spanish sentence, and names the privacy choices in the reader\'s language', () => {
    const tt = account('tiktok', { externalId: 'open-1', providerData: { audited: true, creatorInfo: { privacyLevelOptions: ['SELF_ONLY', 'FOLLOWER_OF_CREATOR'] } } });
    const post = input({ placement: 'video', options: { privacy: 'PUBLIC_TO_EVERYONE' } });
    const es = c('tiktok').validate(post, tt);
    expect(byCode(es, 'tiktok.consent').message).toBe("TikTok pide esta conformidad antes de publicar: «By posting, you agree to TikTok's Music Usage Confirmation.»");
    expect(byCode(es, 'tiktok.privacy.unavailable').message).toBe('TikTok no ofrece «Todos» para esta cuenta. Elige una de estas: Solo yo, Seguidores.');
    const en = withLocale('en', () => c('tiktok').validate(post, tt));
    expect(byCode(en, 'tiktok.privacy.unavailable').message).toBe('TikTok does not offer "Everyone" for this account. Choose one of: Only me, Followers.');
    expect(byCode(en, 'tiktok.consent').message).toBe("TikTok needs this agreement before posting: \"By posting, you agree to TikTok's Music Usage Confirmation.\"");
  });

  it('YouTube, Pinterest and Bluesky have their own words too', () => {
    const yt = account('youtube', { externalId: 'UC-1', providerData: { audited: true } });
    const video = input({ placement: 'short', media: [media({ durationMs: 30_000 })], text: 'a < b' });
    expect(c('youtube').validate(video, yt).map((i) => i.message)).toEqual(expect.arrayContaining([
      'YouTube no admite < ni > en una descripción: se enviarán como ‹ y ›.',
      expect.stringContaining('Nadie ha dicho si este vídeo es para niños'),
    ]));
    const pin = account('pinterest', { externalId: 'board-1', providerData: { audited: true } });
    const badLink = input({ placement: 'image_pin', media: [image()], options: { link: 'ftp://nope' } });
    expect(byCode(c('pinterest').validate(badLink, pin), 'link.invalid').message).toBe('«ftp://nope» no es una dirección web que Pinterest pueda usar como enlace del pin');
    expect(byCode(withLocale('en', () => c('pinterest').validate(badLink, pin)), 'link.invalid').message).toBe('"ftp://nope" is not a web address Pinterest can use as the pin\'s link');
  });
});

describe('the names the schedule dialog shows', () => {
  it('names placements in the reader\'s language, and keeps a name it does not know', () => {
    expect(placementLabel('instagram', 'feed_image', 'Feed photo', 'es')).toBe('Foto del feed');
    expect(placementLabel('instagram', 'feed_image', 'Feed photo', 'en')).toBe('Feed photo');
    expect(placementLabel('instagram', 'something_new', 'Something new', 'es')).toBe('Something new');
    expect(localizePlacements('pinterest', [{ id: 'video_pin', label: 'Video pin' }], 'es')).toEqual([{ id: 'video_pin', label: 'Pin de vídeo' }]);
    // Every placement every connector declares has its name in both languages, and the English one is the connector's own.
    for (const n of set.networks()) {
      for (const p of c(n).capabilities().placements) {
        expect(placementLabel(n, p.id, '(missing)', 'en'), `${n}/${p.id}`).toBe(p.label);
        expect(placementLabel(n, p.id, '(missing)', 'es'), `${n}/${p.id}`).not.toBe('(missing)');
      }
    }
  });

  it('leaves every network\'s settings exactly as they are in English, and translates them all into Spanish', () => {
    for (const n of set.networks()) {
      const fields = c(n).capabilities(account(n, { providerData: { madeForKids: false } })).options ?? [];
      expect(localizeOptions(n, fields, 'en'), n).toEqual(fields);
      const es = localizeOptions(n, fields, 'es');
      es.forEach((f, i) => {
        const was = fields[i]!;
        if (was.type !== 'info' || n === 'tiktok') expect(f.label, `${n}/${f.key}`).not.toBe(was.label);
        if (was.help) expect(f.help, `${n}/${f.key} help`).not.toBe(was.help);
        expect(f.notice).toBe(was.notice); // TikTok's agreements stay word for word
        expect(f.default).toEqual(was.default);
      });
    }
    const yt = localizeOptions('youtube', c('youtube').capabilities(account('youtube', { providerData: { madeForKids: true } })).options!, 'es')[0]!;
    expect(yt).toMatchObject({ key: 'madeForKids', label: '¿Este vídeo es para niños?', default: 'yes' });
    expect(yt.choices).toEqual([{ value: 'no', label: 'No, no es para niños' }, { value: 'yes', label: 'Sí, es para niños' }]);
  });

  it('translates what TikTok said about this creator, and what the creator switched off, keeping the values', async () => {
    tiktok.accessTokens = new Set(['tok']);
    tiktok.creator = { commentDisabled: true, duetDisabled: false, stitchDisabled: false };
    tiktok.maxDurationSec = 180;
    tiktok.privacyOptions = ['SELF_ONLY', 'FOLLOWER_OF_CREATOR', 'SOMETHING_NEW'];
    const tt = account('tiktok', { externalId: 'open-1', providerData: { username: 'lumencoffee', audited: true } });
    const fields: OptionField[] = (await c('tiktok').accountOptions!(tt, cenv('tok'))).fields;
    expect(localizeOptions('tiktok', fields, 'en')).toEqual(fields);
    const es = Object.fromEntries(localizeOptions('tiktok', fields, 'es').map((f) => [f.key, f]));
    expect(es.creator!.label).toBe('Se publica en TikTok como Lumen Coffee (@lumencoffee)');
    expect(es.maxDuration!.label).toBe('Esta cuenta puede publicar vídeos de hasta 180 segundos.');
    expect(es.allowComment).toMatchObject({ label: 'Permitir comentarios', disabled: true, help: 'Los comentarios están desactivados para esta cuenta en los ajustes de TikTok.' });
    expect(es.privacy!.choices).toEqual([
      { value: 'SELF_ONLY', label: 'Solo yo', disabledWhen: 'brandedContent' }, { value: 'FOLLOWER_OF_CREATOR', label: 'Seguidores' }, { value: 'SOMETHING_NEW', label: 'SOMETHING_NEW' },
    ]);
    expect(es.consent!.label).toBe('Acepto');
    expect(es.consent!.notice).toBe("By posting, you agree to TikTok's Music Usage Confirmation.");
  });
});

describe('the dictionary of issues and labels', () => {
  it('has every entry in both languages, with the same placeholders', () => {
    const holes = (m: unknown) => [...JSON.stringify(m).matchAll(/\{(\w+)\}/g)].map((x) => x[1]).sort();
    const mine = Object.keys(MESSAGES.es).filter((k) => /^(issue|placement|option)\./.test(k));
    expect(mine.length).toBeGreaterThan(100);
    for (const k of mine) expect(holes((MESSAGES.en as Record<string, unknown>)[k]), k).toEqual(holes((MESSAGES.es as Record<string, unknown>)[k]));
  });
});

describe('through the API', () => {
  let env: Env;
  let ig: string;
  beforeAll(async () => {
    env = await createEnv({}, { fakes: true });
    ig = await env.connect('instagram');
  });
  afterAll(async () => { await env.close(); });

  it('answers the dry run and the refusal in the language the request asks for, Spanish when it asks for none', async () => {
    const { users, makePiece, newVersion, approve } = env;
    const { variantId } = await makePiece(users.producer, 'video', '9:16');
    const v = await newVersion(users.producer, variantId);
    await approve(users.approver, v.body.id, [ig]);
    const body = { accountId: ig, text: 'x'.repeat(2300) };
    const dry = (locale: string | null) => env.callIn(locale, users.approver, 'POST', `/api/versions/${v.body.id}/publications/validate`, body);
    const said = async (locale: string | null) => (await dry(locale)).body.issues.find((i: Issue) => i.code === 'text.length').message;
    expect(await said('es')).toBe('El texto tiene 2300 caracteres; Instagram admite 2200');
    expect(await said(null)).toBe('El texto tiene 2300 caracteres; Instagram admite 2200');
    expect(await said('en')).toBe('The text has 2300 characters; Instagram allows 2200');
    expect(await said('en-GB,en;q=0.9')).toBe('The text has 2300 characters; Instagram allows 2200');

    const refused = await env.callIn('es', users.approver, 'POST', `/api/versions/${v.body.id}/publications`, { ...body, scheduledAt: new Date(Date.now() + 86_400_000).toISOString() });
    expect(refused.status).toBe(400);
    expect(refused.body.error.code).toBe('validation_failed');
    expect(refused.body.error.message).toContain('El texto tiene 2300 caracteres');
  });
});
