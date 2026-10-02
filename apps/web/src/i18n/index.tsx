import { Settings } from 'luxon';
import { Fragment, createContext, useContext, useState, type ReactNode } from 'react';
import { MESSAGES, type Key } from './messages';

export type { Key };

/**
 * Two languages, Spanish by default. Every text the interface shows goes through `t()`; the messages live in
 * `messages/<area>.ts`, one file per area of the app, each with its Spanish and English side by side.
 *
 * `t()` is a plain function, so it works in components, helpers and labels alike. Changing the language remounts the
 * app under the new one (see I18nProvider), which is what makes every `t()` call read it again.
 */

export type Locale = 'es' | 'en';
export const LOCALES: { value: Locale; label: string }[] = [
  { value: 'es', label: 'Español' },
  { value: 'en', label: 'English' },
];

/** A message is a text with `{placeholders}`, or plural forms chosen by `count`. */
export type Message = string | { zero?: string; one: string; other: string };
export type Vars = Record<string, string | number>;

const STORAGE_KEY = 'studio.locale';

function stored(): Locale | null {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    return v === 'es' || v === 'en' ? v : null;
  } catch {
    return null;
  }
}

let current: Locale = stored() ?? 'es';
apply(current);

function apply(locale: Locale) {
  Settings.defaultLocale = locale;
  if (typeof document !== 'undefined') document.documentElement.lang = locale;
}

export function getLocale(): Locale {
  return current;
}

/** The text for a key, with its placeholders filled. A key missing in English falls back to Spanish, then to the key. */
export function t(key: Key, vars?: Vars): string {
  const msg: Message | undefined = MESSAGES[current][key] ?? MESSAGES.es[key];
  if (msg === undefined) return key;
  let text: string;
  if (typeof msg === 'string') text = msg;
  else {
    const n = Number(vars?.count ?? 0);
    text = n === 0 && msg.zero !== undefined ? msg.zero : new Intl.PluralRules(current).select(n) === 'one' ? msg.one : msg.other;
  }
  return vars ? text.replace(/\{(\w+)\}/g, (m, name: string) => (vars[name] !== undefined ? fmtVar(vars[name]!) : m)) : text;
}

/** For keys built at run time (a state, a network): the text if the key exists, otherwise the fallback. */
export function tMaybe(key: string, fallback: string, vars?: Vars): string {
  return key in MESSAGES.es ? t(key as Key, vars) : fallback;
}

function fmtVar(v: string | number): string {
  return typeof v === 'number' ? new Intl.NumberFormat(current).format(v) : v;
}

const LocaleCtx = createContext<{ locale: Locale; setLocale: (l: Locale) => void }>({ locale: current, setLocale: () => {} });
export const useLocale = () => useContext(LocaleCtx);

export function I18nProvider({ children }: { children: ReactNode }) {
  const [locale, setState] = useState<Locale>(current);
  const setLocale = (l: Locale) => {
    current = l;
    apply(l);
    try {
      localStorage.setItem(STORAGE_KEY, l);
    } catch {
      // Without storage the choice lasts until the page is reloaded.
    }
    setState(l);
  };
  return (
    <LocaleCtx.Provider value={{ locale, setLocale }}>
      <Fragment key={locale}>{children}</Fragment>
    </LocaleCtx.Provider>
  );
}
