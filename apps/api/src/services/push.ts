import { hkdfSync } from 'node:crypto';
import { z } from 'zod';
import type { Ctx } from '../context.js';
import { TokenVault } from '../crypto.js';
import { badRequest } from '../errors.js';
import { checkUrl, type NetPolicy } from '../net.js';
import { requestLocale, tr, type Locale } from '../i18n/index.js';
import { KIND_LIST, KINDS, chosenLocale, describeNotification, kindLabel, recipientLocale, type NotifyKind } from './notify.js';
import { newVapidKeys, sendPush, type PushSubscription, type VapidKeys } from './webpush.js';

/**
 * Push messages to people's browsers, and what each person wants to be told by email and by push.
 *
 * The deployment signs its pushes with a key it makes for itself the first time one is needed, kept sealed in the database (with a key
 * made from SECRET, so nothing has to be set up). A browser gives the app an address on its push service plus two keys; the message
 * is encrypted for that browser alone (see webpush.ts).
 */
const BACKOFF_SECONDS = [60, 300, 900, 3600];
/** A push that could not be sent for a day is not worth sending any more. */
const STALE_MS = 24 * 3_600_000;

const policyOf = (ctx: Ctx): NetPolicy => ({ allowPrivate: ctx.config.webhookAllowPrivate, httpsForPublic: ctx.config.isProd });
const vault = (ctx: Ctx) => new TokenVault(Buffer.from(hkdfSync('sha256', ctx.config.SECRET, 'content-studio', 'app-secret-v1', 32)));

/** Who is sending, as the push services ask to be told: an email address or a web address to reach the operator. */
function subject(ctx: Ctx): string {
  const mail = /<([^>]+@[^>]+)>/.exec(ctx.config.MAIL_FROM)?.[1] ?? (/^\S+@\S+$/.test(ctx.config.MAIL_FROM) ? ctx.config.MAIL_FROM : null);
  return mail && !mail.endsWith('@localhost') ? `mailto:${mail}` : ctx.config.APP_URL;
}

/** The deployment's signing key: read, or made once. Two processes starting at once end up with the same key. */
export async function vapidKeys(ctx: Ctx): Promise<VapidKeys> {
  const read = async () => {
    const row = await ctx.db.one<{ value_sealed: Buffer }>(`select value_sealed from app_secret where name = 'vapid'`);
    return row ? vault(ctx).open<VapidKeys>(row.value_sealed, 'app_secret:vapid') : null;
  };
  const have = await read();
  if (have) return have;
  await ctx.db.query(`insert into app_secret (name, value_sealed) values ('vapid', $1) on conflict (name) do nothing`, [vault(ctx).seal(newVapidKeys(), 'app_secret:vapid')]);
  return (await read())!;
}

// ───────────────────────────── what each person wants ─────────────────────────────

export interface Preferences {
  /** Every kind there is, with what to call it (in the language of the request). */
  kinds: { kind: NotifyKind; label: string }[];
  emailKinds: NotifyKind[];
  pushKinds: NotifyKind[];
  pushDevices: number;
  /**
   * The language emails, Slack-free notices and pushes are written to this person in: `es`, `en`, or null to follow each brand's
   * language (Spanish when a brand has none).
   */
  locale: Locale | null;
}

interface Stored { emailOff?: string[]; pushOn?: string[]; locale?: string }

export async function getPreferences(ctx: Ctx, userId: string): Promise<Preferences> {
  const u = await ctx.db.one<{ notify_prefs: Stored }>('select notify_prefs from app_user where id = $1', [userId]);
  const p = u?.notify_prefs ?? {};
  const off = new Set(p.emailOff ?? []);
  const pushOn = p.pushOn ? new Set(p.pushOn) : new Set(KIND_LIST.filter((k) => KINDS[k].push));
  const devices = await ctx.db.one<{ n: number }>('select count(*)::int as n from push_subscription where user_id = $1', [userId]);
  return {
    kinds: KIND_LIST.map((kind) => ({ kind, label: kindLabel(requestLocale(), kind) })),
    emailKinds: KIND_LIST.filter((k) => !off.has(k)),
    pushKinds: KIND_LIST.filter((k) => pushOn.has(k)),
    pushDevices: devices?.n ?? 0,
    locale: chosenLocale(p),
  };
}

const kindList = z.array(z.enum(KIND_LIST as [NotifyKind, ...NotifyKind[]])).max(KIND_LIST.length);
/** `locale` may be left out (the language stays as it was), or null to follow each brand's language again. */
export const preferencesInput = z.object({ emailKinds: kindList, pushKinds: kindList, locale: z.enum(['es', 'en']).nullable().optional() });

export async function setPreferences(ctx: Ctx, userId: string, raw: unknown): Promise<Preferences> {
  const input = preferencesInput.parse(raw);
  const before = await ctx.db.one<{ notify_prefs: Stored }>('select notify_prefs from app_user where id = $1', [userId]);
  const locale = input.locale === undefined ? chosenLocale(before?.notify_prefs) : input.locale;
  const stored: Stored = {
    emailOff: KIND_LIST.filter((k) => !input.emailKinds.includes(k)), pushOn: [...new Set(input.pushKinds)], ...(locale ? { locale } : {}),
  };
  await ctx.db.query('update app_user set notify_prefs = $2 where id = $1', [userId, JSON.stringify(stored)]);
  return getPreferences(ctx, userId);
}

/** Only the language a person is written to in (see Preferences.locale): what the web sends when someone picks a language. */
export const localeInput = z.object({ locale: z.enum(['es', 'en']).nullable() });

export async function setLocale(ctx: Ctx, userId: string, raw: unknown): Promise<Preferences> {
  const { locale } = localeInput.parse(raw);
  await ctx.db.query(
    `update app_user set notify_prefs = case when $2::text is null then notify_prefs - 'locale' else notify_prefs || jsonb_build_object('locale', $2::text) end where id = $1`,
    [userId, locale],
  );
  return getPreferences(ctx, userId);
}

// ───────────────────────────── browsers ─────────────────────────────

const b64uLength = (s: string) => Buffer.from(s, 'base64url').length;
export const subscriptionInput = z.object({
  endpoint: z.string().url().max(1500),
  keys: z.object({ p256dh: z.string().max(200), auth: z.string().max(100) }),
  userAgent: z.string().max(300).optional(),
});

/** Remembers a browser, or moves it to this person if the same browser was given to someone else on this computer before. */
export async function subscribe(ctx: Ctx, userId: string, raw: unknown) {
  const input = subscriptionInput.parse(raw);
  const key = Buffer.from(input.keys.p256dh, 'base64url');
  if (key.length !== 65 || key[0] !== 0x04) throw badRequest('invalid_subscription', 'The browser\'s key is not a P-256 public key');
  if (b64uLength(input.keys.auth) !== 16) throw badRequest('invalid_subscription', 'The browser\'s authentication secret is not 16 bytes');
  const checked = checkUrl(input.endpoint, policyOf(ctx));
  if ('error' in checked) throw badRequest('invalid_endpoint', checked.error);
  await ctx.db.query(
    `insert into push_subscription (user_id, endpoint, p256dh, auth, user_agent) values ($1,$2,$3,$4,$5)
     on conflict (endpoint) do update set user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth, user_agent = excluded.user_agent, last_error = null`,
    [userId, input.endpoint, input.keys.p256dh, input.keys.auth, input.userAgent ?? ''],
  );
  return { ok: true };
}

export async function unsubscribe(ctx: Ctx, userId: string, endpoint: string) {
  await ctx.db.query('delete from push_subscription where user_id = $1 and endpoint = $2', [userId, endpoint]);
  return { ok: true };
}

interface SubRow { id: string; endpoint: string; p256dh: string; auth: string }

/** One message to each of a person's browsers. A browser the push service says is gone is forgotten. Returns how many it reached. */
async function pushToUser(ctx: Ctx, userId: string, message: object): Promise<{ reached: number; retry: boolean; retryAfterSec?: number; subscriptions: number }> {
  const subs = await ctx.db.query<SubRow>('select id, endpoint, p256dh, auth from push_subscription where user_id = $1', [userId]);
  if (!subs.length) return { reached: 0, retry: false, subscriptions: 0 };
  const keys = await vapidKeys(ctx);
  let reached = 0;
  let retry = false;
  let retryAfterSec: number | undefined;
  for (const s of subs) {
    const r = await sendPush(s, message, keys, subject(ctx), ctx.now(), policyOf(ctx));
    if (r.ok) {
      reached++;
      await ctx.db.query('update push_subscription set last_ok_at = $2, last_error = null where id = $1', [s.id, ctx.now()]);
    } else if (r.gone) {
      await ctx.db.query('delete from push_subscription where id = $1', [s.id]);
    } else {
      retry = true;
      if (r.retryAfterSec) retryAfterSec = Math.max(retryAfterSec ?? 0, r.retryAfterSec);
      await ctx.db.query('update push_subscription set last_error = $2 where id = $1', [s.id, `${r.status ?? 'no answer'}: ${r.message}`.slice(0, 300)]);
    }
  }
  return { reached, retry, retryAfterSec, subscriptions: subs.length };
}

/** A message to this person's own browsers, so they can see it works before an event needs it to. */
export async function sendTest(ctx: Ctx, userId: string) {
  const r = await pushToUser(ctx, userId, { title: tr('notify.pushTestTitle'), body: tr('notify.pushTest'), url: ctx.config.APP_URL, tag: 'test' });
  return { devices: r.subscriptions, reached: r.reached };
}

/**
 * Pushes the notifications that have not been, to the people who have a browser subscribed and want that kind. Others are marked done
 * without sending, so they are not looked at again. A push that the service could not take is tried again with growing waits, and
 * dropped after a few tries or a day.
 */
export async function sendPendingPush(ctx: Ctx, limit = 100): Promise<number> {
  await ctx.db.query(`update notification set pushed_at = now() where pushed_at is null and created_at < $1`, [new Date(ctx.now().getTime() - STALE_MS)]);
  return ctx.db.tx(async (db) => {
    const rows = await db.query(
      `select n.id, n.user_id, n.kind, n.payload, n.push_tries, u.notify_prefs, b.name as brand, b.locale as brand_locale, p.title as piece_title
       from notification n join app_user u on u.id = n.user_id join brand b on b.id = n.brand_id
       left join piece p on p.id = nullif(n.payload->>'pieceId', '')::uuid
       where n.pushed_at is null and (n.push_next_at is null or n.push_next_at <= $2)
       order by n.created_at limit $1 for update of n skip locked`,
      [limit, ctx.now()],
    );
    let sent = 0;
    for (const n of rows) {
      const wanted: Stored = n.notify_prefs ?? {};
      const on = wanted.pushOn ? wanted.pushOn.includes(n.kind) : !!KINDS[n.kind as NotifyKind]?.push;
      if (!on) {
        await db.query('update notification set pushed_at = $2 where id = $1', [n.id, ctx.now()]);
        continue;
      }
      const d = describeNotification(recipientLocale(n.notify_prefs, n.brand_locale), ctx.config.APP_URL, n.kind, n.payload, n.brand, n.piece_title);
      // `tag` makes a second push about the same piece replace the first on the person's screen instead of piling up.
      const r = await pushToUser(ctx, n.user_id, { title: d.title, body: d.body, url: d.url, tag: `${n.kind}:${n.payload.pieceId ?? ''}` });
      if (r.reached > 0 || !r.retry) {
        await db.query('update notification set pushed_at = $2 where id = $1', [n.id, ctx.now()]);
        if (r.reached > 0) sent++;
      } else if (n.push_tries + 1 >= BACKOFF_SECONDS.length + 1) {
        await db.query('update notification set pushed_at = $2, push_tries = push_tries + 1 where id = $1', [n.id, ctx.now()]);
      } else {
        const wait = Math.max(BACKOFF_SECONDS[Math.min(n.push_tries, BACKOFF_SECONDS.length - 1)]!, r.retryAfterSec ?? 0);
        await db.query('update notification set push_tries = push_tries + 1, push_next_at = $2 where id = $1', [n.id, new Date(ctx.now().getTime() + wait * 1000)]);
      }
    }
    return sent;
  });
}
