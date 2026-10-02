import { DateTime } from 'luxon';
import type { PieceSlot } from '../api';
import { getLocale, t } from '../i18n';
import { Icon } from './icons';
import { NetMark, Tip } from './ui';
import '../styles/features.css';

/** "mar 6 oct, 19:00": a slot's occurrence in the brand's zone. */
export const slotWhen = (at: string, zone: string) => DateTime.fromISO(at, { zone }).setLocale(getLocale()).toFormat("ccc d LLL, HH:mm");

/**
 * Who put a publication on the calendar, when it was not a person: the studio filling a free slot, or the agent. A person's is the
 * usual case and is not marked.
 */
export function ScheduledBy({ by, name, compact }: { by?: string | null; name?: string | null; compact?: boolean }) {
  if (by !== 'auto' && by !== 'agent') return null;
  const agent = by === 'agent';
  const label = agent ? (name ? t('fx.by.agentNamed', { name }) : t('fx.by.agent')) : t('fx.by.auto');
  return (
    <Tip label={label}>
      <span className={`fx-by ${agent ? 'fx-by-agent' : ''}`} role="img" aria-label={label} tabIndex={0}>
        <Icon name={agent ? 'bot' : 'calendar'} />
        {!compact && (agent ? t('fx.by.agentShort') : t('fx.by.autoShort'))}
      </span>
    </Tip>
  );
}

/** The slot a piece was made for: its name, when, and on which account; or that it no longer exists. */
export function SlotLine({ slot, zone }: { slot: PieceSlot; zone: string }) {
  if (slot.removed || !slot.account) return <span className="fx-slot fx-slot-gone">{t('fx.slot.removed')}</span>;
  return (
    <span className="fx-slot fx-slot-two">
      <NetMark network={slot.account.network} size="xs" />
      <span className="fx-slot-text">
        <span className="fx-slot-name">{slot.label || t('fx.slot.unnamed')}{!slot.active && <span className="muted"> · {t('fx.slot.inactive')}</span>}</span>
        <span>{slotWhen(slot.at, zone)} · {slot.account.display_name}</span>
      </span>
    </span>
  );
}
