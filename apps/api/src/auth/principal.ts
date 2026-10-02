import type { Queryable } from '../db.js';
import { AppError, forbidden, notFound } from '../errors.js';
import { msg, type Key } from '../i18n/index.js';
import { can, type Permission, type Role } from '../domain/roles.js';

/**
 * A person acting through an AI assistant connected over MCP (src/mcp/): which assistant, and the brands the person let it act in. It
 * acts with the person's own role in each of those brands and nowhere else, and everything it changes is audited as theirs, via it.
 */
export interface Via {
  channel: 'mcp';
  /** The grant the assistant's token belongs to, and the assistant (its registered id and the name it gave). */
  grantId: string;
  clientId: string;
  clientName: string;
  brandIds: readonly string[];
}

/** Who makes the request: a signed-in person (in the browser, or through an assistant) or a producer token (an agent, a script). */
export type Principal =
  | { kind: 'user'; userId: string; email: string; via?: Via }
  | { kind: 'token'; tokenId: string; brandId: string; createdBy: string };

/** Whether a brand is out of what an assistant was allowed: to it, that brand is as if it did not exist. */
const outOfScope = (p: Principal, brandId: string) => p.kind === 'user' && !!p.via && !p.via.brandIds.includes(brandId);

export const actorCols = (p: Principal) =>
  p.kind === 'user' ? { user: p.userId, token: null } : { user: null, token: p.tokenId };

export interface BrandAccess {
  brandId: string;
  role: Role;
}

/**
 * The principal's role in a brand, or null if it has no access. A token is valid for one brand only and is always a producer. A member
 * who has been deactivated in the brand has no access: to everything that asks, they are not a member of it.
 */
export async function roleIn(db: Queryable, p: Principal, brandId: string): Promise<Role | null> {
  if (p.kind === 'token') return p.brandId === brandId ? 'producer' : null;
  if (outOfScope(p, brandId)) return null;
  const row = await db.one<{ role: Role }>('select role from member where user_id = $1 and brand_id = $2 and deactivated_at is null', [p.userId, brandId]);
  return row?.role ?? null;
}

/**
 * Checks the permission in the brand. With no access at all it answers "not found", so brands that exist are not
 * revealed (nor, to an assistant, the brands the person did not let it into); with access but without the permission, "forbidden". A person who was deactivated in the brand knows it exists, and is
 * told why they cannot open it (`member_deactivated`) rather than that it is not there.
 */
export async function authorize(db: Queryable, p: Principal, brandId: string, permission: Permission): Promise<Role> {
  const role = await roleIn(db, p, brandId);
  if (!role) {
    if (p.kind === 'user' && !outOfScope(p, brandId) && (await db.one('select 1 from member where user_id = $1 and brand_id = $2 and deactivated_at is not null', [p.userId, brandId]))) {
      throw new AppError(403, 'member_deactivated', msg('member.deactivated'));
    }
    throw notFound('Brand');
  }
  if (!can(role, permission)) throw forbidden(msg('error.role.cannot', { role: msg(`role.${role}` as Key) }));
  return role;
}
