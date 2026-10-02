import { z } from 'zod';
import type { Queryable } from '../db.js';
import { isoWeekday, localDay, zonedInstant } from '../domain/time.js';
import { badRequest } from '../errors.js';
import { msg } from '../i18n/index.js';

/** The slot a piece is made for: the slot, and which of its weekly occurrences (the instant, as the calendar gives it). */
export const slotLink = z.object({ id: z.string().uuid(), at: z.iso.datetime({ offset: true }) });
export type SlotLink = z.infer<typeof slotLink>;

/**
 * Checks that a slot is the brand's and that `at` is one of its occurrences: on its weekday, at its time, in the brand's zone (so 19:00
 * stays 19:00 across a clock change). Returns the instant.
 */
export async function checkSlotOccurrence(db: Queryable, brandId: string, link: SlotLink): Promise<Date> {
  const s = await db.one<{ weekday: number; hhmm: string; timezone: string }>(
    `select s.weekday, to_char(s.local_time, 'HH24:MI') as hhmm, b.timezone from slot s join brand b on b.id = s.brand_id where s.id = $1 and s.brand_id = $2`,
    [link.id, brandId],
  );
  if (!s) throw badRequest('invalid_slot', msg('sched.slot.unknown'));
  const at = new Date(link.at);
  const day = localDay(at, s.timezone);
  if (isoWeekday(day) !== s.weekday || zonedInstant(day, s.hhmm, s.timezone).getTime() !== at.getTime()) {
    throw badRequest('invalid_slot', msg('sched.slot.notAnOccurrence'));
  }
  return at;
}

/**
 * The slot a producer token is making a piece for: the slot of the `slot.needs_content` event that started its run for the brand, when it
 * has exactly one such run going (with several, the runner names the slot itself). Null when there is none.
 */
export async function slotOfRun(db: Queryable, tokenId: string, brandId: string, now: Date): Promise<SlotLink | null> {
  const rows = await db.query<{ slot: { id?: string; at?: string } | null }>(
    `select distinct e.data->'slot' as slot from agent_run r join event e on e.id = r.trigger_event_id and e.brand_id = r.brand_id
     where r.token_id = $1 and r.brand_id = $2 and r.status = 'running' and r.piece_id is null and r.trigger = 'slot.needs_content'
       and e.type = 'slot.needs_content' and r.lease_until >= $3`,
    [tokenId, brandId, now],
  );
  const slots = rows.map((r) => r.slot).filter((s): s is { id: string; at: string } => !!s?.id && !!s?.at);
  return slots.length === 1 ? { id: slots[0]!.id, at: new Date(slots[0]!.at).toISOString() } : null;
}
