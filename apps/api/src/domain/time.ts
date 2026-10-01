import { DateTime } from 'luxon';

export function isValidZone(zone: string): boolean {
  return DateTime.local().setZone(zone).isValid;
}

/** 'YYYY-MM-DD' date in the brand's zone for a UTC instant. */
export function localDay(instant: Date, zone: string): string {
  return DateTime.fromJSDate(instant, { zone }).toISODate()!;
}

/**
 * UTC instant for a brand-local wall-clock time ("19:00 in Europe/Madrid").
 * UTC is stored together with the brand's IANA zone, so "19:00" is still 19:00 after a clock change.
 * If the time does not exist that day (spring-forward gap), luxon moves it forward; if it repeats (autumn), the first one wins.
 */
export function zonedInstant(day: string, time: string, zone: string): Date {
  const [h = '0', m = '0'] = time.split(':');
  const dt = DateTime.fromISO(day, { zone }).set({ hour: Number(h), minute: Number(m), second: 0, millisecond: 0 });
  if (!dt.isValid) throw new Error(`Invalid date or time: ${day} ${time} (${zone})`);
  return dt.toJSDate();
}

/** Moves an instant to another day, keeping the brand's local wall-clock time. */
export function moveToDay(instant: Date, newDay: string, zone: string): Date {
  const local = DateTime.fromJSDate(instant, { zone });
  return zonedInstant(newDay, local.toFormat('HH:mm'), zone);
}

/** 'YYYY-MM-DD' days between two local dates, both inclusive. */
export function daysBetween(from: string, to: string): string[] {
  const out: string[] = [];
  let d = DateTime.fromISO(from, { zone: 'utc' });
  const end = DateTime.fromISO(to, { zone: 'utc' });
  while (d <= end && out.length < 400) {
    out.push(d.toISODate()!);
    d = d.plus({ days: 1 });
  }
  return out;
}

export function isoWeekday(day: string): number {
  return DateTime.fromISO(day, { zone: 'utc' }).weekday;
}
