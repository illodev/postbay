import type { Queryable } from '../db.js';
import type { Role } from '../domain/roles.js';
import { localeOf, render, t, type Key, type Locale } from '../i18n/index.js';

export type NotifyKind =
  | 'version.uploaded'
  | 'comment.created'
  | 'version.changes_requested'
  | 'version.approved'
  | 'publication.due'
  | 'publication.reapproval'
  | 'publication.on_hold'
  | 'publication.published'
  | 'publication.failed'
  | 'publication.handed_over'
  | 'publication.private'
  | 'account.reconnect'
  | 'account.expiring'
  | 'webhook.failing'
  | 'slack.failing'
  | 'agent.needs_person'
  | 'agent.failed'
  | 'agent.timed_out';

/**
 * Where each kind is sent unless a person or a brand chose otherwise. What each says (the email subject and push title, and its name in
 * the settings) is in the dictionary, as `notify.<kind>.subject` and `notify.<kind>.label`.
 *
 * `publication.handed_over` (a post the app gave to a person, because its brand was paused or its date blocked past its hour, or the
 * network cannot take it) and `agent.timed_out` (a run the studio closed because it ran out of time) used to travel as
 * `publication.failed` (with `handedOver`) and `agent.failed`; notifications of those older shapes still read as they did.
 */
export const KINDS: Record<NotifyKind, { push: boolean; slack: boolean }> = {
  'version.uploaded': { push: true, slack: true },
  'comment.created': { push: true, slack: false },
  'version.changes_requested': { push: true, slack: true },
  'version.approved': { push: false, slack: true },
  'publication.due': { push: true, slack: true },
  'publication.reapproval': { push: true, slack: true },
  'publication.on_hold': { push: false, slack: true },
  'publication.published': { push: false, slack: true },
  'publication.failed': { push: true, slack: true },
  'publication.handed_over': { push: true, slack: true },
  'publication.private': { push: true, slack: true },
  'account.reconnect': { push: true, slack: true },
  'account.expiring': { push: false, slack: true },
  'webhook.failing': { push: false, slack: true },
  'slack.failing': { push: true, slack: false },
  'agent.needs_person': { push: true, slack: true },
  'agent.failed': { push: false, slack: true },
  'agent.timed_out': { push: false, slack: true },
};
export const KIND_LIST = Object.keys(KINDS) as NotifyKind[];

const isKind = (k: string): k is NotifyKind => k in KINDS;

/** The kind's subject (email subject, push title) in a language; an unknown kind is said as it is. */
export function kindSubject(locale: Locale, kind: string): string {
  return isKind(kind) ? t(locale, `notify.${kind}.subject` as Key) : kind;
}

/** The kind's name in the settings, in a language. */
export const kindLabel = (locale: Locale, kind: NotifyKind) => t(locale, `notify.${kind}.label` as Key);

/**
 * What a notification has to say beyond its subject, in a language: the account it is about, why (a message the studio kept as a code,
 * or one in a network's or a person's own words), and the post's address once it is out.
 */
function detailLines(locale: Locale, kind: string, payload: Record<string, any>): string[] {
  const lines: string[] = [];
  if (kind.startsWith('account.') && payload.name && payload.network) lines.push(t(locale, 'notify.account', { name: payload.name, network: payload.network }));
  const why = render(locale, payload.message_i18n ?? payload.reason_i18n, payload.message ?? payload.reason ?? null);
  if (why) lines.push(why);
  if (kind === 'publication.published' && payload.url) lines.push(t(locale, 'notify.post', { url: payload.url }));
  return lines;
}

/**
 * The words and the place for one notification, the same on every channel, in the language of whoever receives it. `brand` and
 * `pieceTitle` come from the rows around it.
 */
export function describeNotification(
  locale: Locale, appUrl: string, kind: string, payload: Record<string, any>, brand: string, pieceTitle: string | null,
): { subject: string; title: string; body: string; url: string } {
  const subject = kindSubject(locale, kind);
  const base = appUrl.replace(/\/$/, '');
  let path = '/';
  if (payload.pieceId) path = `/pieces/${payload.pieceId}`;
  else if (kind.startsWith('account.')) path = '/settings?tab=accounts';
  else if (kind === 'webhook.failing') path = '/settings?tab=webhooks';
  else if (kind === 'slack.failing') path = '/settings?tab=notifications';
  const body = [...(pieceTitle ? [t(locale, 'notify.piece', { title: pieceTitle })] : []), ...detailLines(locale, kind, payload)].join('\n');
  return { subject, title: `[${brand}] ${subject}`, body, url: `${base}${path}` };
}

// ───────────────────────────── whose language ─────────────────────────────

/** A person's own choice of language, kept with their notification preferences; null when they made none. */
export const chosenLocale = (prefs: { locale?: string } | null | undefined): Locale | null =>
  prefs?.locale === 'es' || prefs?.locale === 'en' ? prefs.locale : null;

/** The language to write to a person in about a brand: their own choice, or else the brand's language. */
export const recipientLocale = (prefs: { locale?: string } | null | undefined, brandLocale: string | null | undefined): Locale =>
  chosenLocale(prefs) ?? localeOf(brandLocale);

/**
 * The language to write to a person in when no brand is in question (a sign-in link, their authenticator): their own choice, or else
 * English only when every brand they belong to publishes in English; Spanish otherwise, and for someone with no brand.
 */
export async function personLocale(db: Queryable, userId: string): Promise<Locale> {
  const row = await db.one<{ notify_prefs: { locale?: string } | null; locales: string[] | null }>(
    `select u.notify_prefs, array(select b.locale from member m join brand b on b.id = m.brand_id where m.user_id = u.id) as locales
     from app_user u where u.id = $1`,
    [userId],
  );
  const chosen = chosenLocale(row?.notify_prefs);
  if (chosen) return chosen;
  const locales = row?.locales ?? [];
  return locales.length > 0 && locales.every((l) => localeOf(l) === 'en') ? 'en' : 'es';
}

/**
 * In-app notifications (and email if SMTP is configured, see background.ts).
 * Never notifies whoever triggered the event.
 */
export async function notifyRoles(
  db: Queryable,
  brandId: string,
  roles: Role[],
  kind: NotifyKind,
  payload: Record<string, unknown>,
  exceptUserId: string | null,
) {
  await db.query(
    `insert into notification (user_id, brand_id, kind, payload)
     select m.user_id, m.brand_id, $3, $4 from member m
     where m.brand_id = $1 and m.role = any($2) and m.user_id is distinct from $5`,
    [brandId, roles, kind, JSON.stringify(payload), exceptUserId],
  );
}

export async function notifyUsers(
  db: Queryable,
  brandId: string,
  userIds: (string | null)[],
  kind: NotifyKind,
  payload: Record<string, unknown>,
  exceptUserId: string | null,
) {
  const ids = [...new Set(userIds.filter((u): u is string => !!u && u !== exceptUserId))];
  for (const id of ids) {
    await db.query(
      `insert into notification (user_id, brand_id, kind, payload)
       select $1, $2, $3, $4 where exists (select 1 from member where user_id = $1 and brand_id = $2)`,
      [id, brandId, kind, JSON.stringify(payload)],
    );
  }
}
