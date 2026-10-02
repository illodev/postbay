import type { Message } from '../index';
import { account } from './account';
import { calendar } from './calendar';
import { common } from './common';
import { errors } from './errors';
import { labels } from './labels';
import { layout } from './layout';
import { piece } from './piece';
import { pieces } from './pieces';
import { prizes } from './prizes';
import { publish } from './publish';
import { publications } from './publications';
import { results } from './results';
import { review } from './review';
import { settings } from './settings';

// One entry per area. A new area file is added here and to the Key type below.
const AREAS = [common, labels, errors, layout, pieces, piece, review, calendar, publish, publications, results, settings, account, prizes];

type All = typeof common.es &
  typeof labels.es &
  typeof errors.es &
  typeof layout.es &
  typeof pieces.es &
  typeof piece.es &
  typeof review.es &
  typeof calendar.es &
  typeof publish.es &
  typeof publications.es &
  typeof results.es &
  typeof settings.es &
  typeof account.es &
  typeof prizes.es;

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
