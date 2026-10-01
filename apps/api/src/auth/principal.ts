import type { Queryable } from '../db.js';
import { forbidden, notFound } from '../errors.js';
import { can, type Permission, type Role } from '../domain/roles.js';

/** Who makes the request: a signed-in person or a producer token (an agent, a script). */
export type Principal =
  | { kind: 'user'; userId: string; email: string }
  | { kind: 'token'; tokenId: string; brandId: string; createdBy: string };

export const actorCols = (p: Principal) =>
  p.kind === 'user' ? { user: p.userId, token: null } : { user: null, token: p.tokenId };

export interface BrandAccess {
  brandId: string;
  role: Role;
}

/** The principal's role in a brand, or null if it has no access. A token is valid for one brand only and is always a producer. */
export async function roleIn(db: Queryable, p: Principal, brandId: string): Promise<Role | null> {
  if (p.kind === 'token') return p.brandId === brandId ? 'producer' : null;
  const row = await db.one<{ role: Role }>('select role from member where user_id = $1 and brand_id = $2', [p.userId, brandId]);
  return row?.role ?? null;
}

/**
 * Checks the permission in the brand. With no access at all it answers "not found", so brands that exist are not
 * revealed; with access but without the permission, "forbidden".
 */
export async function authorize(db: Queryable, p: Principal, brandId: string, permission: Permission): Promise<Role> {
  const role = await roleIn(db, p, brandId);
  if (!role) throw notFound('Brand');
  if (!can(role, permission)) throw forbidden(`Your role (${role}) cannot do this`);
  return role;
}
