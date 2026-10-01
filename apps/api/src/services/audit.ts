import type { Queryable } from '../db.js';
import { actorCols, type Principal } from '../auth/principal.js';

/** Audit log: append-only, never edited. Written in the same transaction as the change it records. */
export async function audit(
  db: Queryable,
  actor: Principal | null,
  brandId: string | null,
  action: string,
  entity: string,
  entityId: string | null,
  before: unknown = null,
  after: unknown = null,
) {
  const a = actor ? actorCols(actor) : { user: null, token: null };
  await db.query(
    `insert into audit_event (brand_id, actor_user_id, actor_token_id, action, entity, entity_id, before, after)
     values ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [brandId, a.user, a.token, action, entity, entityId, before === null ? null : JSON.stringify(before), after === null ? null : JSON.stringify(after)],
  );
}
