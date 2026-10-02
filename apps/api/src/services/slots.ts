import { DateTime } from 'luxon';
import type { Ctx } from '../context.js';
import { emit } from './events.js';
import { calendarData } from './publications.js';

/**
 * The slots that still ask for content a few days before their date: each one is announced once (as a
 * `slot.needs_content` event), with the campaigns that are running that day, so whoever produces can pick it up.
 * Brands set how many days ahead in their agent settings; 0 turns it off. Paused brands are left alone.
 */
export async function scanSlotAlerts(ctx: Ctx): Promise<number> {
  const brands = await ctx.db.query(`select id, timezone, agent from brand where not paused`);
  const now = ctx.now();
  let announced = 0;
  for (const b of brands) {
    const days = Number((b.agent as { slot_alert_days?: number } | null)?.slot_alert_days ?? 3);
    if (!days) continue;
    const today = DateTime.fromJSDate(now, { zone: b.timezone });
    const cal = await calendarData(ctx, b.id, today.toISODate()!, today.plus({ days }).toISODate()!);
    const horizon = now.getTime() + days * 86_400_000;
    for (const s of cal.slots) {
      const at = new Date(s.at);
      if (s.filled || s.past || s.blocked || at.getTime() > horizon) continue;
      announced += await ctx.db.tx(async (db) => {
        const fresh = await db.one('insert into slot_alert (slot_id, at) values ($1,$2) on conflict do nothing returning slot_id', [s.id, at]);
        if (!fresh) return 0;
        const campaigns = await db.query(
          `select id, name, objective from campaign where brand_id = $1 and (starts_on is null or starts_on <= $2::date) and (ends_on is null or ends_on >= $2::date) order by created_at`,
          [b.id, s.day],
        );
        await emit(ctx, db, b.id, 'slot.needs_content', {
          slot: { id: s.id, label: s.label, at: s.at, day: s.day },
          account: { id: s.account_id, network: s.network, display_name: s.account_name },
          days_ahead: Math.max(0, Math.ceil((at.getTime() - now.getTime()) / 86_400_000)),
          campaigns,
        });
        return 1;
      });
    }
  }
  return announced;
}
