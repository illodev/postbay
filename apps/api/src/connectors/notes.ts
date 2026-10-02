import { english, msg, type Key, type Localized, type Params } from '../i18n/index.js';
import type { Network } from './types.js';

/**
 * A verify note in a connector's own words, kept as a code (`noteText`, put into words in each reader's language in the history and the
 * notification) with its English (`note`, for the record and webhooks).
 */
export function noteOf(key: Key, params?: Params): { note: string; noteText: Localized } {
  const text = msg(key, params);
  return { note: english(text), noteText: text };
}

/** A post (a pin, a video) the network no longer returns. */
export const goneNote = (network: Network, thing: 'post' | 'pin' | 'video') =>
  noteOf(`pub.note.gone.${thing}` as Key, { network: msg(`network.${network}` as Key) });
