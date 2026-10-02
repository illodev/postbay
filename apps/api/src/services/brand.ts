import { createHash, randomBytes } from 'node:crypto';
import { z } from 'zod';
import { authorize, roleIn, type Principal } from '../auth/principal.js';
import type { Ctx } from '../context.js';
import { ROLES } from '../domain/roles.js';
import { isValidZone } from '../domain/time.js';
import { badRequest, conflict, forbidden, notFound } from '../errors.js';
import { DateTime } from 'luxon';
import { audit } from './audit.js';
import { agentOf, agentSettings } from './agent.js';
import { prizeSettings, prizesOf } from './prizes.js';
import { loadBrand, rulesOf } from './loaders.js';

export const NETWORKS = ['instagram', 'facebook', 'youtube', 'tiktok', 'linkedin', 'x', 'threads', 'pinterest', 'bluesky'] as const;

const rulesInput = z.object({
  required_approvals: z.number().int().min(1).max(5),
  reapprove_on_move: z.boolean(),
  checklist: z.array(z.string().trim().min(1).max(200)).max(20),
});

/** When publishing starts before the hour, and how late the app will still publish by itself. */
const publishingInput = z.object({
  prepare_lead_minutes: z.number().int().min(12).max(1440),
  late_tolerance_minutes: z.number().int().min(0).max(240),
});

const publishingOf = (brand: { publishing?: Record<string, number> }) => ({ prepare_lead_minutes: 30, late_tolerance_minutes: 15, ...(brand.publishing ?? {}) });

export const brandPatch = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  timezone: z.string().refine(isValidZone, 'Not a valid IANA time zone').optional(),
  locale: z.string().trim().min(2).max(10).optional(),
  rules: rulesInput.partial().optional(),
  publishing: publishingInput.partial().optional(),
  agent: agentSettings.partial().optional(),
  prizes: prizeSettings.partial().optional(),
});

export async function getBrand(ctx: Ctx, p: Principal, brandId: string) {
  const role = await authorize(ctx.db, p, brandId, 'brand.view');
  const b = await loadBrand(ctx.db, brandId);
  return { id: b.id, name: b.name, timezone: b.timezone, locale: b.locale, paused: b.paused, rules: rulesOf(b), publishing: publishingOf(b as never), agent: agentOf(b), prizes: prizesOf(b), role };
}

export async function updateBrand(ctx: Ctx, p: Principal, brandId: string, raw: unknown) {
  const input = brandPatch.parse(raw);
  return ctx.db.tx(async (db) => {
    await authorize(db, p, brandId, 'brand.manage');
    const before = await loadBrand(db, brandId);
    const rules = { ...rulesOf(before), ...(input.rules ?? {}) };
    const publishing = { ...publishingOf(before as never), ...(input.publishing ?? {}) };
    const agent = { ...agentOf(before), ...(input.agent ?? {}) };
    const prizes = { ...prizesOf(before), ...(input.prizes ?? {}) };
    await db.query(
      'update brand set name = coalesce($2, name), timezone = coalesce($3, timezone), locale = coalesce($4, locale), approval_rules = $5, publishing = $6, agent = $7, prizes = $8 where id = $1',
      [brandId, input.name ?? null, input.timezone ?? null, input.locale ?? null, JSON.stringify(rules), JSON.stringify(publishing), JSON.stringify(agent), JSON.stringify(prizes)],
    );
    const after = await loadBrand(db, brandId);
    await audit(db, p, brandId, 'brand.updated', 'brand', brandId,
      { name: before.name, timezone: before.timezone, rules: rulesOf(before), publishing: publishingOf(before as never), agent: agentOf(before), prizes: prizesOf(before) },
      { name: after.name, timezone: after.timezone, rules: rulesOf(after), publishing: publishingOf(after as never), agent: agentOf(after), prizes: prizesOf(after) });
    return { id: after.id, name: after.name, timezone: after.timezone, locale: after.locale, paused: after.paused, rules: rulesOf(after), publishing: publishingOf(after as never), agent: agentOf(after), prizes: prizesOf(after) };
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

/**
 * The brand's people. `can_reset_second_factor` says whether the person asking may reset that member's authenticator: only an
 * admin of every brand the member belongs to may, and nobody their own (see resetForMember in services/secondfactor.ts).
 */
export async function listMembers(ctx: Ctx, p: Principal, brandId: string) {
  await authorize(ctx.db, p, brandId, 'brand.manage');
  return ctx.db.query(
    `select m.id, m.role, u.id as user_id, u.email, u.name,
            exists(select 1 from user_totp t where t.user_id = u.id and t.confirmed_at is not null) as second_factor,
            (u.id <> $2 and not exists(select 1 from member o where o.user_id = u.id and not exists(
              select 1 from member a where a.brand_id = o.brand_id and a.user_id = $2 and a.role = 'admin'))) as can_reset_second_factor
     from member m join app_user u on u.id = m.user_id
     where m.brand_id = $1 order by u.email`,
    [brandId, p.kind === 'user' ? p.userId : null],
  );
}

const INVITATION_DAYS = 14;

/**
 * Adds a person to the brand. Someone new gets an account, and someone already in this workspace is added straight away, as before.
 * Someone who already belongs to **another workspace** is invited instead (202, `invited: true`): they are emailed, and become a
 * member only when they accept, signed in as themselves. Otherwise an admin anywhere could make any user of the server a member of
 * their brand, without their knowing, and act on their account from there.
 */
export async function addMember(ctx: Ctx, p: Principal, brandId: string, raw: unknown) {
  const input = memberInput.parse(raw);
  const out = await ctx.db.tx(async (db) => {
    await authorize(db, p, brandId, 'brand.manage');
    const existing = await db.one<{ id: string }>('select id from app_user where lower(email) = $1', [input.email]);
    if (existing) {
      const exists = await db.one('select 1 from member where user_id = $1 and brand_id = $2', [existing.id, brandId]);
      if (exists) throw conflict('already_member', 'That person is already a member of this brand');
      const elsewhere = await db.one(
        `select 1 from member m join brand b on b.id = m.brand_id
         where m.user_id = $1 and b.workspace_id <> (select workspace_id from brand where id = $2) limit 1`,
        [existing.id, brandId],
      );
      if (elsewhere) return { invitation: await invite(db, p, brandId, existing.id, input) };
    }
    const user = existing ?? (await db.one('insert into app_user (email, name) values ($1,$2) returning id', [input.email, input.name ?? null]))!;
    const m = (await db.one('insert into member (user_id, brand_id, role) values ($1,$2,$3) returning *', [user.id, brandId, input.role]))!;
    await audit(db, p, brandId, 'member.added', 'member', m.id, null, { email: input.email, role: input.role });
    return { member: m };
  });
  if ('member' in out) return { ...out.member, invited: false as const };
  void sendInvitation(ctx, p, brandId, input.email, input.role).catch((err) => ctx.log.error({ err: String(err) }, 'could not email an invitation'));
  return { invited: true as const, invitation: out.invitation };
}

async function invite(db: Tx, p: Principal, brandId: string, userId: string, input: { email: string; role: string }) {
  // An invitation nobody answered in time no longer stands in the way of a new one.
  await db.query(
    `update member_invitation set answered_at = now(), answer = 'expired' where brand_id = $1 and user_id = $2 and answered_at is null and expires_at <= now()`,
    [brandId, userId],
  );
  const open = await db.one('select 1 from member_invitation where brand_id = $1 and user_id = $2 and answered_at is null', [brandId, userId]);
  if (open) throw conflict('already_invited', 'That person has been invited to this brand already and has not answered yet');
  const row = (await db.one<{ id: string; role: string; expires_at: Date }>(
    `insert into member_invitation (brand_id, user_id, role, invited_by, expires_at) values ($1,$2,$3,$4, now() + make_interval(days => $5))
     returning id, role, expires_at`,
    [brandId, userId, input.role, p.kind === 'user' ? p.userId : null, INVITATION_DAYS],
  ))!;
  await audit(db, p, brandId, 'member.invited', 'member_invitation', row.id, null, { email: input.email, role: input.role });
  return { id: row.id, email: input.email, role: row.role, expires_at: row.expires_at };
}

async function sendInvitation(ctx: Ctx, p: Principal, brandId: string, email: string, role: string) {
  const b = await ctx.db.one<{ brand: string; workspace: string }>(
    'select b.name as brand, w.name as workspace from brand b join workspace w on w.id = b.workspace_id where b.id = $1',
    [brandId],
  );
  const by = p.kind === 'user' ? p.email : 'An admin';
  await ctx.mailer.send(
    email,
    `Invitation to ${b?.brand ?? 'a brand'}`,
    `${by} invited you to ${b?.brand} (${b?.workspace}) as ${role}.\n\nNothing changes until you accept. Sign in to accept or decline it, under Your account (valid for ${INVITATION_DAYS} days):\n\n${ctx.config.APP_URL}/\n\nIf you do not know who this is, decline it.\n`,
  );
}

/** Invitations of this brand that are still waiting for an answer. */
export async function listInvitations(ctx: Ctx, p: Principal, brandId: string) {
  await authorize(ctx.db, p, brandId, 'brand.manage');
  return ctx.db.query(
    `select i.id, i.role, i.created_at, i.expires_at, u.email, by_.email as invited_by
     from member_invitation i join app_user u on u.id = i.user_id left join app_user by_ on by_.id = i.invited_by
     where i.brand_id = $1 and i.answered_at is null and i.expires_at > now() order by i.created_at desc`,
    [brandId],
  );
}

export async function cancelInvitation(ctx: Ctx, p: Principal, brandId: string, invitationId: string) {
  return ctx.db.tx(async (db) => {
    await authorize(db, p, brandId, 'brand.manage');
    const row = await db.one(
      `update member_invitation set answered_at = now(), answer = 'cancelled' where id = $1 and brand_id = $2 and answered_at is null returning id`,
      [invitationId, brandId],
    );
    if (!row) throw notFound('Invitation');
    await audit(db, p, brandId, 'member.invitation_cancelled', 'member_invitation', invitationId, null, null);
    return { id: invitationId };
  });
}

/** The invitations waiting for this person's answer. */
export async function myInvitations(ctx: Ctx, userId: string) {
  return ctx.db.query(
    `select i.id, i.role, i.created_at, i.expires_at, b.id as brand_id, b.name as brand, w.name as workspace, by_.email as invited_by
     from member_invitation i join brand b on b.id = i.brand_id join workspace w on w.id = b.workspace_id
     left join app_user by_ on by_.id = i.invited_by
     where i.user_id = $1 and i.answered_at is null and i.expires_at > now() order by i.created_at`,
    [userId],
  );
}

/** The invited person, signed in as themselves, accepts (and becomes a member with the role they were offered) or declines. */
export async function answerInvitation(ctx: Ctx, p: Principal, invitationId: string, accept: boolean) {
  if (p.kind !== 'user') throw forbidden('Only the person invited can answer an invitation');
  return ctx.db.tx(async (db) => {
    const inv = await db.one<{ id: string; brand_id: string; role: string }>(
      `select id, brand_id, role from member_invitation where id = $1 and user_id = $2 and answered_at is null and expires_at > now() for update`,
      [invitationId, p.userId],
    );
    if (!inv) throw notFound('Invitation');
    const answer = accept ? 'accepted' : 'declined';
    await db.query('update member_invitation set answered_at = now(), answer = $2 where id = $1', [inv.id, answer]);
    if (accept) {
      const m = await db.one<{ id: string }>(
        'insert into member (user_id, brand_id, role) values ($1,$2,$3) on conflict (user_id, brand_id) do nothing returning id',
        [p.userId, inv.brand_id, inv.role],
      );
      await audit(db, p, inv.brand_id, 'member.added', 'member', m?.id ?? null, null, { email: p.email, role: inv.role, via: 'invitation' });
    } else {
      await audit(db, p, inv.brand_id, 'member.invitation_declined', 'member_invitation', inv.id, null, null);
    }
    return { id: inv.id, answer, brandId: inv.brand_id, role: inv.role };
  });
}

type Tx = Parameters<Parameters<Ctx['db']['tx']>[0]>[0];

/**
 * Revokes the producer tokens a person made for a brand, when they stop being able to make them (they leave the brand, or are no
 * longer its admin). An agent running on one of them stops at its next call; the brand's admins make it a new one.
 */
async function revokeTokensOf(db: Tx, p: Principal, brandId: string, userId: string, reason: 'member_removed' | 'no_longer_admin') {
  const rows = await db.query<{ id: string; name: string }>(
    'update api_token set revoked_at = now() where brand_id = $1 and created_by = $2 and revoked_at is null returning id, name',
    [brandId, userId],
  );
  for (const t of rows) await audit(db, p, brandId, 'token.revoked', 'api_token', t.id, null, { name: t.name, reason });
  return rows.length;
}

async function assertNotLastAdmin(db: Tx, brandId: string, memberId: string) {
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
    const tokensRevoked = m.role === 'admin' && next !== 'admin' ? await revokeTokensOf(db, p, brandId, m.user_id, 'no_longer_admin') : 0;
    return { id: memberId, role: next, tokensRevoked };
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
    const tokensRevoked = await revokeTokensOf(db, p, brandId, m.user_id, 'member_removed');
    return { id: memberId, tokensRevoked };
  });
}

// ──────────────────────── social accounts (manual in phase 1) ────────────────────────

export const accountInput = z.object({
  network: z.enum(NETWORKS),
  externalId: z.string().trim().min(1).max(200),
  displayName: z.string().trim().min(1).max(200),
});

const SHOWN_DATA = ['audited', 'username', 'pageId', 'channelId', 'missingScopes', 'dataAccessExpiresAt'];

export async function listAccounts(ctx: Ctx, p: Principal, brandId: string) {
  await authorize(ctx.db, p, brandId, 'brand.view');
  const rows = await ctx.db.query(
    `select id, network, external_id, display_name, status, created_at, (token_encrypted is not null) as connected,
       last_error, last_health_at, provider_data
     from social_account where brand_id = $1 order by network, display_name`,
    [brandId],
  );
  return rows.map(({ provider_data, ...a }) => ({
    ...a,
    // Whether publishing to it needs no person: connected, in good standing, and this server has the connector.
    automated: a.connected && a.status === 'active' && ctx.connectors.connector(a.network) !== null,
    details: Object.fromEntries(Object.entries(provider_data ?? {}).filter(([k]) => SHOWN_DATA.includes(k))),
  }));
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
  // Who made each one matters: a token stops working when its maker leaves the brand or stops being its admin.
  return ctx.db.query(
    `select t.id, t.name, t.created_at, t.expires_at, t.revoked_at, t.last_used_at, u.email as created_by_email
     from api_token t join app_user u on u.id = t.created_by where t.brand_id = $1 order by t.created_at desc`,
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

/** The range a calendar query uses when none is given: today (in the brand's zone) to 30 days ahead. */
export async function defaultRange(ctx: Ctx, brandId: string, from?: string, to?: string) {
  if (from && to) return { from, to };
  const b = await loadBrand(ctx.db, brandId);
  const today = DateTime.fromJSDate(ctx.now(), { zone: b.timezone as string });
  return { from: from ?? today.toISODate()!, to: to ?? today.plus({ days: 30 }).toISODate()! };
}

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
