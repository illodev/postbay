import { AsyncLocalStorage, AsyncResource } from 'node:async_hooks';
import { MESSAGES, type Key } from './messages/index.js';
import type { Message } from './messages/define.js';

/**
 * What the API says to people, in Spanish (the default) or English. Every text a person reads goes through here; the messages
 * live in `messages/<area>.ts`, one file per area, with both languages side by side and the same keys on both (the compiler checks
 * it, the way the web's own messages are checked).
 *
 * Which language:
 *  - a text made while answering a request (a check's result, a scheduling issue, an error) follows the request: the web sends
 *    `Accept-Language: es` or `en` on every call, and anything else means Spanish (see `requestLocale`);
 *  - a text kept to be read later (why a post is on hold, why it failed) is kept as a code and its values (`Localized`), next to the
 *    English text, and is put into words when someone reads it, in their language (see `renderStored`);
 *  - an email, a Slack message or a push goes in the language of whoever receives it: their own choice if they made one, otherwise
 *    the brand's (see services/notify.ts).
 */

export type Locale = 'es' | 'en';
export const LOCALES: Locale[] = ['es', 'en'];
export type { Key };

export type { Message };

/** A text kept as its code and the values that fill it, put into words only when it is read. Values may be texts of their own. */
export interface Localized {
  code: string;
  params?: Params;
}
export type Param = string | number | boolean | null | undefined | Localized | Localized[];
export type Params = Record<string, Param>;

/** A text to keep: checked against the dictionary when it is written, put into words when it is read. */
export function msg(code: Key, params?: Params): Localized {
  return params ? { code, params } : { code };
}

export const isLocalized = (v: unknown): v is Localized =>
  !!v && typeof v === 'object' && !Array.isArray(v) && typeof (v as Localized).code === 'string';

const known = (code: string): code is Key => Object.prototype.hasOwnProperty.call(MESSAGES.es, code);

/** Whether this code is in the dictionary (a stored one may come from a newer or an older version). */
export const isKnown = (code: string) => known(code);

/** Turns any language tag into one of ours: English for `en`, `en-GB`…, Spanish for everything else, and when there is none. */
export function localeOf(tag: string | null | undefined): Locale {
  return /^\s*en(?:[-_]|\s*$)/i.test(tag ?? '') ? 'en' : 'es';
}

/** The language an `Accept-Language` header asks for: its first entry (the web sends just `es` or `en`). */
export function acceptLanguage(header: string | string[] | undefined): Locale {
  const raw = Array.isArray(header) ? header[0] : header;
  return localeOf((raw ?? '').split(',')[0]?.split(';')[0]);
}

function fmt(locale: Locale, v: Param): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'number') return new Intl.NumberFormat(locale === 'es' ? 'es-ES' : 'en-GB', { maximumFractionDigits: 2 }).format(v);
  if (typeof v === 'boolean') return String(v);
  if (Array.isArray(v)) return v.map((x) => render(locale, x)).filter(Boolean).join(' ');
  if (isLocalized(v)) return render(locale, v);
  return String(v);
}

/** The text for a key in a language, with its placeholders filled. */
export function t(locale: Locale, key: Key, params?: Params): string {
  const m: Message = MESSAGES[locale][key] ?? MESSAGES.es[key];
  let text: string;
  if (typeof m === 'string') text = m;
  else {
    const n = Number(params?.count ?? 0);
    text = n === 0 && m.zero !== undefined ? m.zero : new Intl.PluralRules(locale).select(n) === 'one' ? m.one : m.other;
  }
  return params ? text.replace(/\{(\w+)\}/g, (whole, name: string) => (name in params ? fmt(locale, params[name]) : whole)) : text;
}

/**
 * A kept text in a language. A code this version does not know (written by another version) gives `fallback`, which is the English
 * text kept beside it, or the code itself.
 */
export function render(locale: Locale, value: Localized | Localized[] | null | undefined, fallback?: string | null): string {
  if (!value) return fallback ?? '';
  if (Array.isArray(value)) return value.every((v) => isLocalized(v) && known(v.code)) ? value.map((v) => render(locale, v)).join(' ') : (fallback ?? '');
  if (!known(value.code)) return fallback ?? value.code;
  return t(locale, value.code, value.params);
}

/** The English words of a kept text: what goes in the English column beside it, in webhooks and in logs. */
export const english = (value: Localized | Localized[]) => render('en', value);

// ───────────────────────────── the request's language ─────────────────────────────

const store = new AsyncLocalStorage<{ locale: Locale }>();

/** The language of the request being answered; Spanish outside one (the worker, the command line, tests that call services). */
export function requestLocale(): Locale {
  return store.getStore()?.locale ?? 'es';
}

/** Runs `fn` with `locale` as the request's language (the command line, a test). */
export function withLocale<T>(locale: Locale, fn: () => T): T {
  return store.run({ locale }, fn);
}

/** The text for a key in the request's language. */
export const tr = (key: Key, params?: Params) => t(requestLocale(), key, params);

const resource = Symbol('i18n.resource');

/**
 * Fastify hooks that make the request's language what `requestLocale` answers for everything done while answering it. The context
 * is entered on the request and entered again once the body has been read, because reading it can lose it (the same way
 * @fastify/request-context does it).
 */
export const localeHooks = {
  onRequest(req: { headers: Record<string, string | string[] | undefined> } & Record<symbol, unknown>, _reply: unknown, done: () => void) {
    store.run({ locale: acceptLanguage(req.headers['accept-language']) }, () => {
      req[resource] = new AsyncResource('i18n-request');
      done();
    });
  },
  preValidation(req: Record<symbol, unknown>, _reply: unknown, done: () => void) {
    const r = req[resource] as AsyncResource | undefined;
    if (r) r.runInAsyncScope(done);
    else done();
  },
};

// ───────────────────────────── kept texts, on their way out ─────────────────────────────

const SUFFIX = '_i18n';

/**
 * Puts every kept text in an answer into words, in the request's language: any field `x_i18n` holding a code (or a list of them) is
 * rendered into its sibling `x`, and removed. A code this version does not know leaves the English `x` as it was. Rows written before
 * texts were kept as codes have no `x_i18n`, and show their English text as they always did.
 */
export function renderStored(locale: Locale, value: unknown, depth = 0): void {
  if (!value || typeof value !== 'object' || depth > 12) return;
  if (Array.isArray(value)) {
    for (const v of value) renderStored(locale, v, depth + 1);
    return;
  }
  if (value instanceof Date || Buffer.isBuffer(value)) return;
  const o = value as Record<string, unknown>;
  for (const key of Object.keys(o)) {
    if (key.endsWith(SUFFIX)) {
      const stored = o[key];
      const all = Array.isArray(stored) ? stored : [stored];
      if (all.length && all.every((v) => isLocalized(v) && known(v.code))) o[key.slice(0, -SUFFIX.length)] = render(locale, stored as Localized | Localized[]);
      delete o[key];
      continue;
    }
    renderStored(locale, o[key], depth + 1);
  }
}
