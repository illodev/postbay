import { DateTime } from 'luxon';
import { getLocale, t, tMaybe } from '../i18n';

/**
 * A label map that translates on read: `STATE_LABEL[code]` gives the text for the current language, falling back to
 * the English text kept here (and then to the code) for anything the messages do not have yet.
 */
function labelMap(prefix: string, fallback: Record<string, string>): Record<string, string> {
  return new Proxy(fallback, {
    get: (target, key) => (typeof key === 'string' ? tMaybe(`${prefix}.${key}`, target[key] ?? key) : undefined),
    has: (target, key) => typeof key === 'string' && (key in target || tMaybe(`${prefix}.${key}`, '') !== ''),
  });
}

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
  if (!dt.isValid) throw new Error(t('common.invalidDate'));
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

export const STATE_LABEL: Record<string, string> = labelMap('state', {
  draft: 'Draft',
  in_review: 'In review',
  changes_requested: 'Changes requested',
  approved: 'Approved',
  discarded: 'Discarded',
  superseded: 'Superseded',
  scheduled: 'Scheduled',
  preparing: 'Preparing',
  ready: 'Ready',
  publishing: 'Publishing',
  awaiting_reapproval: 'Awaiting confirmation',
  on_hold: 'On hold',
  published: 'Published',
  cancelled: 'Cancelled',
  failed: 'Failed',
});

export const NETWORK_LABEL: Record<string, string> = labelMap('network', {
  instagram: 'Instagram',
  facebook: 'Facebook',
  youtube: 'YouTube',
  tiktok: 'TikTok',
  linkedin: 'LinkedIn',
  x: 'X',
  threads: 'Threads',
  pinterest: 'Pinterest',
  bluesky: 'Bluesky',
});

export const ROLE_LABEL: Record<string, string> = labelMap('role', {
  admin: 'Admin',
  approver: 'Approver',
  reviewer: 'Reviewer',
  producer: 'Producer',
  reader: 'Reader',
});

export const VISIBILITY_LABEL: Record<string, string> = labelMap('visibility', {
  public: 'Live',
  private: 'Private',
  processing: 'Processing',
  scheduled: 'Held by the network',
  unknown: 'Not found',
});

export const STEP_LABEL: Record<string, string> = labelMap('step', {
  prepare: 'Prepare',
  publish: 'Publish',
  verify: 'Check it is live',
  discard: 'Take down',
});

export const ERROR_CLASS_LABEL: Record<string, string> = labelMap('errorClass', {
  auth: 'Connection problem',
  rate_limit: 'Network limit',
  file_rejected: 'Refused by the network',
  transient: 'Temporary failure',
  unsupported: 'Not supported',
  missed_window: 'Missed its hour',
  unknown: 'Unknown error',
});

export const OUTCOME_LABEL: Record<string, string> = labelMap('outcome', {
  uploaded: 'Sent a new version',
  needs_people: 'Left it to people',
  failed: 'Failed',
  checks_failed: 'Did not pass the checks',
  timeout: 'Ran out of time',
  aborted: 'Stopped',
  blocked: 'Not started',
});

export const BLOCK_REASON_LABEL: Record<string, string> = labelMap('blockReason', {
  budget_not_set: 'No budget set',
  rounds_exhausted: 'Rounds used up',
  piece_budget_reached: 'Piece budget reached',
  monthly_budget_reached: 'Monthly budget reached',
});

export const TRIGGER_LABEL: Record<string, string> = labelMap('trigger', {
  'version.changes_requested': 'Changes requested',
  'slot.needs_content': 'Empty slot',
});

export const EVENT_LABEL: Record<string, string> = labelMap('event', {
  'version.changes_requested': 'Changes requested',
  'version.approved': 'Version approved',
  'version.rejected': 'Version rejected',
  'comment.created': 'Comment',
  'slot.needs_content': 'Slot needs content',
  'publication.published': 'Post published',
  'publication.failed': 'Post failed',
  ping: 'Test',
});

export function fmtMoney(n: number, currency: string): string {
  const amount = new Intl.NumberFormat(getLocale(), { minimumFractionDigits: 0, maximumFractionDigits: 2 }).format(n);
  return `${amount} ${currency}`;
}
