import type { Queryable } from '../db.js';
import type { Role } from '../domain/roles.js';

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
  | 'publication.private'
  | 'account.reconnect'
  | 'account.expiring'
  | 'webhook.failing'
  | 'slack.failing'
  | 'agent.needs_person'
  | 'agent.failed';

/** What each kind says, to a person: the email subject and push title, the name in settings, and where it is sent unless chosen otherwise. */
export const KINDS: Record<NotifyKind, { subject: string; label: string; push: boolean; slack: boolean }> = {
  'version.uploaded': { subject: 'A new version is ready for review', label: 'A new version is ready for review', push: true, slack: true },
  'comment.created': { subject: 'New comment on a piece', label: 'Someone comments on a piece', push: true, slack: false },
  'version.changes_requested': { subject: 'Changes were requested on a version', label: 'Changes are requested on a version', push: true, slack: true },
  'version.approved': { subject: 'A version was approved', label: 'A version is approved', push: false, slack: true },
  'publication.due': { subject: 'A publication is due: it needs to go out now', label: 'A publication you publish by hand is due', push: true, slack: true },
  'publication.reapproval': { subject: 'A change to a scheduled publication needs your confirmation', label: 'A change to something scheduled needs confirming', push: true, slack: true },
  'publication.on_hold': { subject: 'Scheduled publications were put on hold by a new version', label: 'Scheduled publications are put on hold', push: false, slack: true },
  'publication.published': { subject: 'A post went out', label: 'A post goes out', push: false, slack: true },
  'publication.failed': { subject: 'A post could not be published', label: 'A post fails to publish', push: true, slack: true },
  'publication.private': { subject: 'A video was uploaded but is private: a person has to make it public', label: 'A post is uploaded but private', push: true, slack: true },
  'account.reconnect': { subject: 'An account needs to be reconnected', label: 'An account has to be connected again', push: true, slack: true },
  'account.expiring': { subject: 'An account connection is about to expire', label: 'An account connection is about to expire', push: false, slack: true },
  'webhook.failing': { subject: 'A webhook is failing: events are not reaching its receiver', label: 'A webhook is failing', push: false, slack: true },
  'slack.failing': { subject: 'Slack is not taking messages any more: the webhook address needs replacing', label: 'Slack stops taking messages', push: true, slack: false },
  'agent.needs_person': { subject: 'The agent has handed a piece back to a person', label: 'The agent hands a piece back to a person', push: true, slack: true },
  'agent.failed': { subject: 'An agent run failed', label: 'An agent run fails', push: false, slack: true },
};
export const KIND_LIST = Object.keys(KINDS) as NotifyKind[];

/** The words and the place for one notification, the same on every channel. `brand` and `pieceTitle` come from the rows around it. */
export function describeNotification(
  appUrl: string, kind: string, payload: Record<string, any>, brand: string, pieceTitle: string | null,
): { subject: string; title: string; body: string; url: string } {
  const subject = KINDS[kind as NotifyKind]?.subject ?? kind;
  const base = appUrl.replace(/\/$/, '');
  let path = '/';
  if (payload.pieceId) path = `/pieces/${payload.pieceId}`;
  else if (kind.startsWith('account.')) path = '/settings?tab=accounts';
  else if (kind === 'webhook.failing') path = '/settings?tab=webhooks';
  else if (kind === 'slack.failing') path = '/settings?tab=notifications';
  return { subject, title: `[${brand}] ${subject}`, body: pieceTitle ? `Piece: ${pieceTitle}` : '', url: `${base}${path}` };
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
