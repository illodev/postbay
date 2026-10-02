import type { Queryable } from '../db.js';
import { actorCols, type Principal } from '../auth/principal.js';

/**
 * Audit log: append-only, never edited. Written in the same transaction as the change it records. A change a person made through an AI
 * assistant (MCP) is theirs, with `via` naming the assistant.
 */
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
  // Done by a person through an assistant: the entry says so, and which assistant (the name it registered with).
  const via = actor?.kind === 'user' && actor.via ? { channel: actor.via.channel, client_id: actor.via.clientId, client_name: actor.via.clientName } : null;
  await db.query(
    `insert into audit_event (brand_id, actor_user_id, actor_token_id, action, entity, entity_id, before, after, via)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [brandId, a.user, a.token, action, entity, entityId, before === null ? null : JSON.stringify(before), after === null ? null : JSON.stringify(after),
      via === null ? null : JSON.stringify(via)],
  );
}
