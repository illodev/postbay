import { createHash, randomBytes } from 'node:crypto';
import { z } from 'zod';
import { authorize, roleIn, type Principal } from '../auth/principal.js';
import type { Ctx } from '../context.js';
import { ROLES } from '../domain/roles.js';
import { isValidZone } from '../domain/time.js';
import { badRequest, conflict, forbidden, notFound } from '../errors.js';
import { audit } from './audit.js';
import { loadBrand, rulesOf } from './loaders.js';

export const NETWORKS = ['instagram', 'facebook', 'youtube', 'tiktok', 'linkedin', 'x', 'threads', 'pinterest', 'bluesky'] as const;

const rulesInput = z.object({
  required_approvals: z.number().int().min(1).max(5),
  reapprove_on_move: z.boolean(),
  checklist: z.array(z.string().trim().min(1).max(200)).max(20),
});

export const brandPatch = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  timezone: z.string().refine(isValidZone, 'Not a valid IANA time zone').optional(),
  locale: z.string().trim().min(2).max(10).optional(),
  rules: rulesInput.partial().optional(),
});

export async function getBrand(ctx: Ctx, p: Principal, brandId: string) {
  const role = await authorize(ctx.db, p, brandId, 'brand.view');
  const b = await loadBrand(ctx.db, brandId);
  return { id: b.id, name: b.name, timezone: b.timezone, locale: b.locale, paused: b.paused, rules: rulesOf(b), role };
}

export async function updateBrand(ctx: Ctx, p: Principal, brandId: string, raw: unknown) {
  const input = brandPatch.parse(raw);
  return ctx.db.tx(async (db) => {
    await authorize(db, p, brandId, 'brand.manage');
    const before = await loadBrand(db, brandId);
    const rules = { ...rulesOf(before), ...(input.rules ?? {}) };
    await db.query(
      'update brand set name = coalesce($2, name), timezone = coalesce($3, timezone), locale = coalesce($4, locale), approval_rules = $5 where id = $1',
      [brandId, input.name ?? null, input.timezone ?? null, input.locale ?? null, JSON.stringify(rules)],
    );
    const after = await loadBrand(db, brandId);
    await audit(db, p, brandId, 'brand.updated', 'brand', brandId,
      { name: before.name, timezone: before.timezone, rules: rulesOf(before) },
      { name: after.name, timezone: after.timezone, rules: rulesOf(after) });
    return { id: after.id, name: after.name, timezone: after.timezone, locale: after.locale, paused: after.paused, rules: rulesOf(after) };
  });
}

/** Crisis button: freezes everything scheduled without losing the dates. */
export async function setPaused(ctx: Ctx, p: Principal, brandId: string, paused: boolean) {
  return ctx.db.tx(async (db) => {
    await authorize(db, p, brandId, 'brand.pause');
    const before = await loadBrand(db, brandId);
    await db.query('update brand set paused = $2, paused_at = case when $2 then now() else null end where id = $1', [brandId, paused]);
    await audit(db, p, brandId, paused ? 'brand.paused' : 'brand.resumed', 'brand', brandId, { paused: before.paused }, { paused });
    return { paused };
  });
}

// ───────────────────────────── members ─────────────────────────────

export const memberInput = z.object({
  email: z.string().trim().toLowerCase().email().max(200),
  name: z.string().trim().max(120).optional(),
  role: z.enum(ROLES),
});

export async function listMembers(ctx: Ctx, p: Principal, brandId: string) {
  await authorize(ctx.db, p, brandId, 'brand.manage');
  return ctx.db.query(
    `select m.id, m.role, u.id as user_id, u.email, u.name from member m join app_user u on u.id = m.user_id
     where m.brand_id = $1 order by u.email`,
    [brandId],
  );
}

export async function addMember(ctx: Ctx, p: Principal, brandId: string, raw: unknown) {
  const input = memberInput.parse(raw);
  return ctx.db.tx(async (db) => {
    await authorize(db, p, brandId, 'brand.manage');
    const user =
      (await db.one('select id from app_user where lower(email) = $1', [input.email])) ??
      (await db.one('insert into app_user (email, name) values ($1,$2) returning id', [input.email, input.name ?? null]))!;
    const exists = await db.one('select 1 from member where user_id = $1 and brand_id = $2', [user.id, brandId]);
    if (exists) throw conflict('already_member', 'That person is already a member of this brand');
    const m = (await db.one('insert into member (user_id, brand_id, role) values ($1,$2,$3) returning *', [user.id, brandId, input.role]))!;
    await audit(db, p, brandId, 'member.added', 'member', m.id, null, { email: input.email, role: input.role });
    return m;
  });
}

async function assertNotLastAdmin(db: Parameters<Parameters<Ctx['db']['tx']>[0]>[0], brandId: string, memberId: string) {
  const other = await db.one(`select 1 from member where brand_id = $1 and role = 'admin' and id <> $2`, [brandId, memberId]);
  if (!other) throw conflict('last_admin', 'A brand needs at least one admin');
}

export async function changeMemberRole(ctx: Ctx, p: Principal, brandId: string, memberId: string, role: unknown) {
  const next = z.enum(ROLES).parse(role);
  return ctx.db.tx(async (db) => {
    await authorize(db, p, brandId, 'brand.manage');
    const m = await db.one('select * from member where id = $1 and brand_id = $2 for update', [memberId, brandId]);
    if (!m) throw notFound('Member');
    if (m.role === 'admin' && next !== 'admin') await assertNotLastAdmin(db, brandId, memberId);
    await db.query('update member set role = $2 where id = $1', [memberId, next]);
    await audit(db, p, brandId, 'member.role_changed', 'member', memberId, { role: m.role }, { role: next });
    return { id: memberId, role: next };
  });
}

export async function removeMember(ctx: Ctx, p: Principal, brandId: string, memberId: string) {
  return ctx.db.tx(async (db) => {
    await authorize(db, p, brandId, 'brand.manage');
    const m = await db.one('select * from member where id = $1 and brand_id = $2 for update', [memberId, brandId]);
    if (!m) throw notFound('Member');
    if (m.role === 'admin') await assertNotLastAdmin(db, brandId, memberId);
    await db.query('delete from member where id = $1', [memberId]);
    await audit(db, p, brandId, 'member.removed', 'member', memberId, { role: m.role }, null);
    return { id: memberId };
  });
}

// ──────────────────────── social accounts (manual in phase 1) ────────────────────────

export const accountInput = z.object({
  network: z.enum(NETWORKS),
  externalId: z.string().trim().min(1).max(200),
  displayName: z.string().trim().min(1).max(200),
});

export async function listAccounts(ctx: Ctx, p: Principal, brandId: string) {
  await authorize(ctx.db, p, brandId, 'brand.view');
  return ctx.db.query(
    'select id, network, external_id, display_name, status, created_at from social_account where brand_id = $1 order by network, display_name',
    [brandId],
  );
}

export async function addAccount(ctx: Ctx, p: Principal, brandId: string, raw: unknown) {
  const input = accountInput.parse(raw);
  return ctx.db.tx(async (db) => {
    await authorize(db, p, brandId, 'brand.manage');
    const dup = await db.one('select 1 from social_account where brand_id = $1 and network = $2 and external_id = $3', [brandId, input.network, input.externalId]);
    if (dup) throw conflict('account_exists', 'That account is already registered');
    const row = (await db.one(
      `insert into social_account (brand_id, network, external_id, display_name, status) values ($1,$2,$3,$4,'manual')
       returning id, network, external_id, display_name, status, created_at`,
      [brandId, input.network, input.externalId, input.displayName],
    ))!;
    await audit(db, p, brandId, 'account.added', 'social_account', row.id, null, { network: input.network, display_name: input.displayName });
    return row;
  });
}

export async function removeAccount(ctx: Ctx, p: Principal, brandId: string, accountId: string) {
  return ctx.db.tx(async (db) => {
    await authorize(db, p, brandId, 'brand.manage');
    const acc = await db.one('select * from social_account where id = $1 and brand_id = $2', [accountId, brandId]);
    if (!acc) throw notFound('Account');
    const used = await db.one('select 1 from publication where social_account_id = $1 limit 1', [accountId]);
    if (used) throw conflict('account_in_use', 'This account has publications and cannot be removed');
    await db.query('delete from slot where social_account_id = $1', [accountId]);
    await db.query('delete from social_account where id = $1', [accountId]);
    await audit(db, p, brandId, 'account.removed', 'social_account', accountId, { network: acc.network, display_name: acc.display_name }, null);
    return { id: accountId };
  });
}

// ───────────────────────────── API tokens ─────────────────────────────

export const tokenInput = z.object({
  name: z.string().trim().min(1).max(120),
  expiresInDays: z.number().int().min(1).max(365).default(90),
});

export const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');

export async function listTokens(ctx: Ctx, p: Principal, brandId: string) {
  await authorize(ctx.db, p, brandId, 'brand.manage');
  return ctx.db.query(
    'select id, name, created_at, expires_at, revoked_at, last_used_at from api_token where brand_id = $1 order by created_at desc',
    [brandId],
  );
}

/** The plaintext token is returned once, here. Only its hash is stored. */
export async function createToken(ctx: Ctx, p: Principal, brandId: string, raw: unknown) {
  const input = tokenInput.parse(raw);
  return ctx.db.tx(async (db) => {
    await authorize(db, p, brandId, 'brand.manage');
    if (p.kind !== 'user') throw forbidden();
    const token = `est_${randomBytes(32).toString('base64url')}`;
    const row = (await db.one(
      `insert into api_token (brand_id, name, token_hash, created_by, expires_at)
       values ($1,$2,$3,$4, now() + make_interval(days => $5)) returning id, name, created_at, expires_at`,
      [brandId, input.name, hashToken(token), p.userId, input.expiresInDays],
    ))!;
    await audit(db, p, brandId, 'token.created', 'api_token', row.id, null, { name: input.name, expires_at: row.expires_at });
    return { ...row, token };
  });
}

export async function revokeToken(ctx: Ctx, p: Principal, brandId: string, tokenId: string) {
  return ctx.db.tx(async (db) => {
    await authorize(db, p, brandId, 'brand.manage');
    const row = await db.one('update api_token set revoked_at = now() where id = $1 and brand_id = $2 and revoked_at is null returning id', [tokenId, brandId]);
    if (!row) throw notFound('Token');
    await audit(db, p, brandId, 'token.revoked', 'api_token', tokenId, null, null);
    return { id: tokenId };
  });
}

// ─────────────────────── campaigns, slots, blocked dates ───────────────────────

export const campaignInput = z.object({
  name: z.string().trim().min(1).max(200),
  startsOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullish(),
  endsOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullish(),
  objective: z.string().max(2000).nullish(),
});

export async function listCampaigns(ctx: Ctx, p: Principal, brandId: string) {
  await authorize(ctx.db, p, brandId, 'brand.view');
  return ctx.db.query('select * from campaign where brand_id = $1 order by created_at desc', [brandId]);
}

export async function createCampaign(ctx: Ctx, p: Principal, brandId: string, raw: unknown) {
  const input = campaignInput.parse(raw);
  return ctx.db.tx(async (db) => {
    await authorize(db, p, brandId, 'piece.create');
    const row = (await db.one(
      'insert into campaign (brand_id, name, starts_on, ends_on, objective) values ($1,$2,$3,$4,$5) returning *',
      [brandId, input.name, input.startsOn ?? null, input.endsOn ?? null, input.objective ?? null],
    ))!;
    await audit(db, p, brandId, 'campaign.created', 'campaign', row.id, null, { name: input.name });
    return row;
  });
}

export const slotInput = z.object({
  accountId: z.string().uuid(),
  weekday: z.number().int().min(1).max(7),
  localTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
  label: z.string().max(120).default(''),
});

export async function listSlots(ctx: Ctx, p: Principal, brandId: string) {
  await authorize(ctx.db, p, brandId, 'brand.view');
  return ctx.db.query(
    `select s.id, s.weekday, to_char(s.local_time, 'HH24:MI') as local_time, s.label, s.social_account_id as account_id, sa.network, sa.display_name as account_name
     from slot s join social_account sa on sa.id = s.social_account_id where s.brand_id = $1 order by s.weekday, s.local_time`,
    [brandId],
  );
}

export async function addSlot(ctx: Ctx, p: Principal, brandId: string, raw: unknown) {
  const input = slotInput.parse(raw);
  return ctx.db.tx(async (db) => {
    await authorize(db, p, brandId, 'brand.manage');
    const acc = await db.one('select 1 from social_account where id = $1 and brand_id = $2', [input.accountId, brandId]);
    if (!acc) throw badRequest('invalid_account', 'The account does not belong to this brand');
    const row = (await db.one(
      'insert into slot (brand_id, social_account_id, weekday, local_time, label) values ($1,$2,$3,$4,$5) returning *',
      [brandId, input.accountId, input.weekday, input.localTime, input.label],
    ))!;
    await audit(db, p, brandId, 'slot.added', 'slot', row.id, null, input);
    return row;
  });
}

export async function removeSlot(ctx: Ctx, p: Principal, brandId: string, slotId: string) {
  return ctx.db.tx(async (db) => {
    await authorize(db, p, brandId, 'brand.manage');
    const row = await db.one('delete from slot where id = $1 and brand_id = $2 returning id', [slotId, brandId]);
    if (!row) throw notFound('Slot');
    await audit(db, p, brandId, 'slot.removed', 'slot', slotId, null, null);
    return { id: slotId };
  });
}

export const blockedInput = z.object({
  day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  reason: z.string().max(200).default(''),
});

export async function listBlocked(ctx: Ctx, p: Principal, brandId: string) {
  await authorize(ctx.db, p, brandId, 'brand.view');
  return ctx.db.query('select day, reason from blocked_date where brand_id = $1 order by day', [brandId]);
}

export async function blockDate(ctx: Ctx, p: Principal, brandId: string, raw: unknown) {
  const input = blockedInput.parse(raw);
  return ctx.db.tx(async (db) => {
    await authorize(db, p, brandId, 'publication.schedule');
    await db.query(
      'insert into blocked_date (brand_id, day, reason) values ($1,$2,$3) on conflict (brand_id, day) do update set reason = excluded.reason',
      [brandId, input.day, input.reason],
    );
    await audit(db, p, brandId, 'date.blocked', 'brand', brandId, null, input);
    return input;
  });
}

export async function unblockDate(ctx: Ctx, p: Principal, brandId: string, day: string) {
  return ctx.db.tx(async (db) => {
    await authorize(db, p, brandId, 'publication.schedule');
    await db.query('delete from blocked_date where brand_id = $1 and day = $2', [brandId, day]);
    await audit(db, p, brandId, 'date.unblocked', 'brand', brandId, { day }, null);
    return { day };
  });
}

export async function listAudit(ctx: Ctx, p: Principal, brandId: string, f: { entity?: string; entityId?: string; limit?: number }) {
  await authorize(ctx.db, p, brandId, 'audit.view');
  const params: unknown[] = [brandId];
  let where = 'a.brand_id = $1';
  if (f.entity) {
    params.push(f.entity);
    where += ` and a.entity = $${params.length}`;
  }
  if (f.entityId) {
    params.push(f.entityId);
    where += ` and a.entity_id = $${params.length}`;
  }
  params.push(Math.min(f.limit ?? 100, 500));
  return ctx.db.query(
    `select a.id, a.action, a.entity, a.entity_id, a.before, a.after, a.at, coalesce(u.name, u.email, t.name) as actor
     from audit_event a left join app_user u on u.id = a.actor_user_id left join api_token t on t.id = a.actor_token_id
     where ${where} order by a.id desc limit $${params.length}`,
    params,
  );
}

export { roleIn };
