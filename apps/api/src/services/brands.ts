import { z } from 'zod';
import { authorize, type Principal } from '../auth/principal.js';
import type { Ctx } from '../context.js';
import { isValidZone } from '../domain/time.js';
import { forbidden, notFound } from '../errors.js';
import { audit } from './audit.js';

/**
 * Creating a brand from the app. Until now only the first one could be made, from the command line. An admin of a
 * brand may create another in the same workspace, and becomes its admin; nobody else is added.
 */

export const newBrandInput = z.object({
  /** The brand the person is working in: the new one goes into its workspace, and its admins are the ones allowed. */
  fromBrandId: z.string().uuid(),
  name: z.string().trim().min(1).max(200),
  timezone: z.string().refine(isValidZone, 'Not a valid IANA time zone'),
  locale: z.enum(['es', 'en']).default('es'),
});

export async function createBrand(ctx: Ctx, p: Principal, raw: unknown) {
  if (p.kind !== 'user') throw forbidden('A brand is created by a person, not a token');
  const input = newBrandInput.parse(raw);
  return ctx.db.tx(async (db) => {
    await authorize(db, p, input.fromBrandId, 'brand.manage');
    const from = await db.one<{ workspace_id: string }>('select workspace_id from brand where id = $1', [input.fromBrandId]);
    if (!from) throw notFound('Brand');
    const brand = (await db.one<{ id: string; name: string; timezone: string; locale: string; paused: boolean }>(
      'insert into brand (workspace_id, name, timezone, locale) values ($1,$2,$3,$4) returning id, name, timezone, locale, paused',
      [from.workspace_id, input.name, input.timezone, input.locale],
    ))!;
    await db.query(`insert into member (user_id, brand_id, role) values ($1,$2,'admin')`, [p.userId, brand.id]);
    await audit(db, p, brand.id, 'brand.created', 'brand', brand.id, null, { name: input.name, from: input.fromBrandId });
    await audit(db, p, input.fromBrandId, 'brand.created_sibling', 'brand', brand.id, null, { name: input.name });
    return { ...brand, role: 'admin' as const };
  });
}
