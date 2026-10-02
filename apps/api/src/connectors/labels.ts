import { isKnown, requestLocale, t, type Key, type Locale } from '../i18n/index.js';
import type { Network, OptionField } from './types.js';

/**
 * The names the schedule dialog shows for a network's placements and its own settings, in the reader's language. Connectors declare
 * them in English (their capabilities are built once, outside any request); these put them into words on the way out, looking each one
 * up by what it is (the network, the placement's id, the setting's key and a choice's value), never by its English words. Whatever the
 * dictionary does not have (a choice TikTok added that this app does not know) is shown as the connector gave it.
 *
 * TikTok's agreements (`notice`) are TikTok's own sentences, which it requires to be shown word for word: they are never translated.
 */

const say = (locale: Locale, key: string, params?: Record<string, string>): string | undefined =>
  isKnown(key) ? t(locale, key as Key, params) : undefined;

/** A placement's name ("Reel", "Feed photo"…). */
export function placementLabel(network: Network, placementId: string, fallback: string, locale: Locale = requestLocale()): string {
  return say(locale, `placement.${network}.${placementId}`) ?? fallback;
}

/** The same, for each of a list of placements as planning gives them ({ id, label }). */
export function localizePlacements<P extends { id: string; label: string }>(network: Network, placements: P[], locale: Locale = requestLocale()): P[] {
  return placements.map((p) => ({ ...p, label: placementLabel(network, p.id, p.label, locale) }));
}

/** The settings several networks share, and the words they share. */
const ALT_TEXT_HELP_EVERY = 'Read aloud to people who cannot see the picture. It is used for every picture of the post.';
const TITLE_FALLBACK_HELP = 'The title of the piece is used if this is empty.';

/** The label of one setting: its own entry, the shared alt text one, or (TikTok) one with the values read from the English it came with. */
function labelOf(locale: Locale, network: Network, f: OptionField): string | undefined {
  if (f.key === 'altText') return say(locale, 'option.altText.label');
  if (network === 'tiktok' && f.key === 'creator') {
    const name = /^Posting to TikTok as (.+)$/.exec(f.label)?.[1];
    return name ? say(locale, 'option.tiktok.creator.label', { name }) : undefined;
  }
  if (network === 'tiktok' && f.key === 'maxDuration') {
    const seconds = /up to (\d+) seconds/.exec(f.label)?.[1];
    return seconds ? say(locale, 'option.tiktok.maxDuration.label', { seconds }) : undefined;
  }
  return say(locale, `option.${network}.${f.key}.label`);
}

/** The help line of one setting, when it has one. */
function helpOf(locale: Locale, network: Network, f: OptionField): string | undefined {
  if (!f.help) return undefined;
  // TikTok: a setting the creator switched off says so instead of its usual help.
  if (network === 'tiktok' && f.disabled) return say(locale, `option.tiktok.${f.key}.off`);
  if (network === 'tiktok' && f.key === 'privacy') return say(locale, f.help === 'TikTok asks that nobody is chosen for you.' ? 'option.tiktok.privacy.help' : 'option.tiktok.privacy.helpUnaudited');
  if (f.key === 'altText') return say(locale, f.help === ALT_TEXT_HELP_EVERY ? 'option.altText.helpEvery' : 'option.altText.help');
  if (f.help === TITLE_FALLBACK_HELP) return say(locale, 'option.titleFallback.help');
  return say(locale, `option.${network}.${f.key}.help`);
}

/**
 * A network's settings for the schedule dialog, in the reader's language: each label, help line and choice that the dictionary has.
 * Everything else about a field (its key, type, defaults, what it depends on, a disabled state, TikTok's notice) is kept as it was.
 */
export function localizeOptions(network: Network, fields: OptionField[], locale: Locale = requestLocale()): OptionField[] {
  return fields.map((f) => {
    const label = labelOf(locale, network, f) ?? f.label;
    const help = helpOf(locale, network, f) ?? f.help;
    const choices = f.choices?.map((c) => ({ ...c, label: say(locale, `option.${network}.${f.key}.choice.${c.value}`) ?? c.label }));
    return { ...f, label, ...(help !== undefined ? { help } : {}), ...(choices ? { choices } : {}) };
  });
}
