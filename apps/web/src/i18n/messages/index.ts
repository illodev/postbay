import type { Message } from '../index';
import { account } from './account';
import { assistants } from './assistants';
import { calendar } from './calendar';
import { common } from './common';
import { errors } from './errors';
import { features } from './features';
import { home } from './home';
import { labels } from './labels';
import { layout } from './layout';
import { piece } from './piece';
import { pieces } from './pieces';
import { prizes } from './prizes';
import { publications } from './publications';
import { publish } from './publish';
import { results } from './results';
import { review } from './review';
import { settings } from './settings';

// One entry per area. A new area file is added here and to the Key type below.
const AREAS = [common, labels, errors, home, layout, pieces, piece, review, calendar, publish, results, settings, account, prizes, publications, features, assistants];

type All = typeof common.es &
  typeof labels.es &
  typeof errors.es &
  typeof home.es &
  typeof layout.es &
  typeof pieces.es &
  typeof piece.es &
  typeof review.es &
  typeof calendar.es &
  typeof publish.es &
  typeof results.es &
  typeof settings.es &
  typeof account.es &
  typeof prizes.es &
  typeof publications.es &
  typeof features.es &
  typeof assistants.es;

export type Key = Extract<keyof All, string>;

function merge(side: 'es' | 'en'): Record<Key, Message> {
  const out: Record<string, Message> = {};
  for (const area of AREAS) {
    for (const [k, v] of Object.entries(area[side] as Record<string, Message>)) {
      if (import.meta.env.DEV && k in out) console.warn(`[i18n] duplicated key ${k}`);
      out[k] = v;
    }
  }
  return out as Record<Key, Message>;
}

export const MESSAGES: Record<'es' | 'en', Record<Key, Message>> = { es: merge('es'), en: merge('en') };
