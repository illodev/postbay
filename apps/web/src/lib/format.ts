import { DateTime } from 'luxon';

export function fmtDateTime(iso: string, zone: string): string {
  return DateTime.fromISO(iso, { zone }).toFormat('ccc d LLL yyyy, HH:mm');
}

export function fmtDay(day: string): string {
  return DateTime.fromISO(day).toFormat('ccc d LLL yyyy');
}

export function fmtShort(iso: string): string {
  return DateTime.fromISO(iso).toRelative({ base: DateTime.now() }) ?? '';
}

/** A wall-clock time in the brand's zone ("2027-03-29T19:00") to the ISO instant the API expects. */
export function zonedToIso(local: string, zone: string): string {
  const dt = DateTime.fromISO(local, { zone });
  if (!dt.isValid) throw new Error('Pick a valid date and time');
  return dt.toUTC().toISO()!;
}

export function isoToZonedInput(iso: string, zone: string): string {
  return DateTime.fromISO(iso, { zone }).toFormat("yyyy-LL-dd'T'HH:mm");
}

export function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

/** 00:03.5 style timecode; with a frame rate it adds the frame, 00:03:12 → 3 s and 12 frames. */
export function fmtTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds - m * 60;
  return `${String(m).padStart(2, '0')}:${s.toFixed(1).padStart(4, '0')}`;
}

export const STATE_LABEL: Record<string, string> = {
  draft: 'Draft',
  in_review: 'In review',
  changes_requested: 'Changes requested',
  approved: 'Approved',
  discarded: 'Discarded',
  superseded: 'Superseded',
  scheduled: 'Scheduled',
  awaiting_reapproval: 'Awaiting confirmation',
  on_hold: 'On hold',
  published: 'Published',
  cancelled: 'Cancelled',
  failed: 'Failed',
};

export const NETWORK_LABEL: Record<string, string> = {
  instagram: 'Instagram',
  facebook: 'Facebook',
  youtube: 'YouTube',
  tiktok: 'TikTok',
  linkedin: 'LinkedIn',
  x: 'X',
  threads: 'Threads',
  pinterest: 'Pinterest',
  bluesky: 'Bluesky',
};

export const ROLE_LABEL: Record<string, string> = {
  admin: 'Admin',
  approver: 'Approver',
  reviewer: 'Reviewer',
  producer: 'Producer',
  reader: 'Reader',
};
