import type { Message } from './define.js';
import { agent } from './agent.js';
import { checks } from './checks.js';
import { common } from './common.js';
import { connect } from './connect.js';
import { connectors } from './connectors.js';
import { errors } from './errors.js';
import { issues } from './issues.js';
import { mcp } from './mcp.js';
import { members } from './members.js';
import { notify } from './notify.js';
import { prizes } from './prizes.js';
import { prizePieces } from './prize-pieces.js';
import { publishing } from './publishing.js';
import { scheduling } from './scheduling.js';

// One entry per area. A new area file is added here and to the All type below.
const AREAS = [common, notify, publishing, connectors, issues, checks, errors, connect, agent, prizes, members, prizePieces, scheduling, mcp];

type All = typeof common.es &
  typeof notify.es &
  typeof publishing.es &
  typeof connectors.es &
  typeof issues.es &
  typeof checks.es &
  typeof errors.es &
  typeof connect.es &
  typeof agent.es &
  typeof prizes.es &
  typeof members.es &
  typeof prizePieces.es &
  typeof scheduling.es &
  typeof mcp.es;

export type Key = Extract<keyof All, string>;

function merge(side: 'es' | 'en'): Record<Key, Message> {
  const out: Record<string, Message> = {};
  for (const area of AREAS) {
    for (const [k, v] of Object.entries(area[side] as Record<string, Message>)) {
      if (k in out) throw new Error(`[i18n] the key ${k} is defined twice`);
      out[k] = v;
    }
  }
  return out as Record<Key, Message>;
}

export const MESSAGES: Record<'es' | 'en', Record<Key, Message>> = { es: merge('es'), en: merge('en') };
/** Every area, for the test that checks both languages say the same things with the same placeholders. */
export const AREA_LIST = AREAS;
