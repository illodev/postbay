import type { Queryable } from '../db.js';
import type { Role } from '../domain/roles.js';

export type NotifyKind =
  | 'version.uploaded'
  | 'comment.created'
  | 'version.changes_requested'
  | 'version.approved'
  | 'publication.due'
  | 'publication.reapproval'
  | 'publication.on_hold';

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
