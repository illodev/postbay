import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { authorize, type Principal } from '../auth/principal.js';
import { ConnectorError } from '../connectors/types.js';
import type { Ctx } from '../context.js';
import { sha256Hex } from '../crypto.js';
import type { Row } from '../db.js';
import { AppError, badRequest, conflict, forbidden, notFound } from '../errors.js';
import { audit } from './audit.js';
import { connectorEnv, loadConnectorAccount, subscribeEvents } from './connectors.js';

/**
 * Prizes for commenting. A post carries a rule: whoever comments the keyword gets the prize, as a private message with a link
 * to a download page that expires. It works on Instagram and Facebook, the only networks with an official way to message
 * someone who commented. Everywhere else a rule only gives a public page, for a pinned comment a person places.
 *
 * The people involved are not users of this app, so what is kept about them is kept as little and as briefly as possible:
 * their id on the network and the name they show, until the brand's retention period ends, then deleted. Prizes also need
 * the post's own text to say the reply is automatic, which a person confirms, and every message carries a note saying so.
 */
export const DEFAULT_PRIZES = { enabled: false, retention_days: 30, auto_notice: 'This is an automatic message.' };
export const prizeSettings = z.object({
  /** Whether signing in with Meta asks for the permissions to message people. Off: a brand that does not use prizes is never asked. */
  enabled: z.boolean(),
  /** How long the people who commented are kept. At least a little over Meta's 7-day window for answering. */
  retention_days: z.number().int().min(8).max(365),
  /** Added to every private message, as the law may require where an automatic reply has to say so. It cannot be removed. */
  auto_notice: z.string().trim().min(1).max(200),
});
export const prizesOf = (b: Row) => ({ ...DEFAULT_PRIZES, ...((b.prizes as object | null) ?? {}) }) as z.infer<typeof prizeSettings>;

/** Meta lets a private reply go out within 7 days of the comment. */
const WINDOW_MS = 7 * 86_400_000;
/** Below Instagram's 750 private replies an hour per account. */
const MAX_PER_HOUR = 700;
const MAX_DOWNLOADS = 5;
const BACKOFF = [60, 300, 900, 3600, 6 * 3600];
const LEASE_MS = 5 * 60_000;
const MAX_FILE = 200 * 1024 * 1024;
const UPLOAD_TTL_SEC = 3600;
const POLL_LEASE_MS = 5 * 60_000;
/** A post is no longer worth reading comments on once its prize window has long passed. */
const POLL_UNTIL_MS = 8 * 86_400_000;

/** The permission each network needs before it may send a private reply. */
const MESSAGING_SCOPE: Record<string, string> = { instagram: 'instagram_manage_messages', facebook: 'pages_messaging' };
export const modeFor = (network: string, manual: boolean) => (!manual && network in MESSAGING_SCOPE ? 'private_reply' : 'public_link');

// ───────────────────────────── matching ─────────────────────────────

/** Lower case, without accents or marks, single spaces: what a keyword and a comment are compared as. */
export const normalize = (s: string) => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/\s+/g, ' ').trim();

/** The keyword as a whole word (or words) of the comment, so "recipe" is not found inside "recipes". */
export function matches(text: string, keywordNorm: string): boolean {
  if (!keywordNorm) return false;
  const escaped = keywordNorm.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^\\p{L}\\p{N}])${escaped}($|[^\\p{L}\\p{N}])`, 'u').test(normalize(text));
}

export function render(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{\s*(name|link|prize|hours)\s*\}\}/g, (_m, k: string) => vars[k] ?? '');
}

const token = () => randomBytes(24).toString('base64url');

// ───────────────────────────── the library ─────────────────────────────

const safeName = (n: string) => n.replace(/[^\w.-]+/g, '_').slice(0, 120) || 'file';

const createInput = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('link'),
    name: z.string().trim().min(1).max(120),
    url: z.string().trim().url().max(2000).refine((u) => /^https?:\/\//i.test(u), 'The link has to be a web address'),
  }),
  z.object({
    kind: z.literal('file'),
    name: z.string().trim().min(1).max(120),
    file: z.object({
      name: z.string().trim().min(1).max(200),
      mime: z.string().trim().min(3).max(100),
      bytes: z.number().int().min(1).max(MAX_FILE),
      sha256: z.string().regex(/^[0-9a-f]{64}$/),
    }),
  }),
]);

const prizeView = (r: Row) => ({
  id: r.id, name: r.name, kind: r.kind, file_name: r.file_name, file_bytes: r.file_bytes === null ? null : Number(r.file_bytes), url: r.kind === 'link' ? r.url : null,
  usable: r.kind === 'link' || r.uploaded_at !== null, archived: r.archived_at !== null, created_at: r.created_at,
});

export async function createPrize(ctx: Ctx, p: Principal, brandId: string, raw: unknown) {
  const input = createInput.parse(raw);
  return ctx.db.tx(async (db) => {
    await authorize(db, p, brandId, 'publication.schedule');
    const id = randomUUID();
    const userId = p.kind === 'user' ? p.userId : null;
    if (input.kind === 'link') {
      const row = (await db.one(`insert into prize (id, brand_id, name, kind, url, created_by) values ($1,$2,$3,'link',$4,$5) returning *`, [id, brandId, input.name, input.url, userId]))!;
      await audit(db, p, brandId, 'prize.created', 'prize', id, null, { name: input.name, kind: 'link' });
      return { prize: prizeView(row) };
    }
    const key = `brands/${brandId}/prizes/${id}/${safeName(input.file.name)}`;
    const row = (await db.one(
      `insert into prize (id, brand_id, name, kind, file_key, file_name, file_mime, file_bytes, file_sha256, created_by) values ($1,$2,$3,'file',$4,$5,$6,$7,$8,$9) returning *`,
      [id, brandId, input.name, key, input.file.name, input.file.mime, input.file.bytes, input.file.sha256, userId],
    ))!;
    await audit(db, p, brandId, 'prize.created', 'prize', id, null, { name: input.name, kind: 'file', file: input.file.name, bytes: input.file.bytes });
    const upload = await ctx.storage.presignPut(key, { mime: input.file.mime, bytes: input.file.bytes, sha256: input.file.sha256, expiresSec: UPLOAD_TTL_SEC });
    return { prize: prizeView(row), upload };
  });
}

/** The file has been uploaded: check that what is stored is what was declared, and only then can the prize be used. */
export async function completePrize(ctx: Ctx, p: Principal, prizeId: string) {
  const row = await ctx.db.one('select * from prize where id = $1', [prizeId]);
  if (!row) throw notFound('Prize');
  await authorize(ctx.db, p, row.brand_id, 'publication.schedule');
  if (row.kind !== 'file') throw badRequest('not_a_file', 'Only a file prize is uploaded');
  const stored = await ctx.storage.stat(row.file_key);
  if (!stored) throw conflict('not_uploaded', 'The file has not arrived yet');
  if (stored.bytes !== Number(row.file_bytes) || stored.sha256 !== row.file_sha256) {
    throw conflict('file_mismatch', 'What was stored is not the file that was declared. Upload it again.');
  }
  const done = (await ctx.db.one('update prize set uploaded_at = coalesce(uploaded_at, $2) where id = $1 returning *', [prizeId, ctx.now()]))!;
  return prizeView(done);
}

export async function listPrizes(ctx: Ctx, p: Principal, brandId: string) {
  await authorize(ctx.db, p, brandId, 'publication.schedule');
  const rows = await ctx.db.query(
    `select pr.*, (select count(*)::int from prize_rule r where r.prize_id = pr.id and r.active) as active_rules
     from prize pr where pr.brand_id = $1 order by pr.archived_at nulls first, pr.created_at desc`,
    [brandId],
  );
  return rows.map((r) => ({ ...prizeView(r), active_rules: r.active_rules }));
}

export async function archivePrize(ctx: Ctx, p: Principal, prizeId: string) {
  return ctx.db.tx(async (db) => {
    const row = await db.one('select * from prize where id = $1 for update', [prizeId]);
    if (!row) throw notFound('Prize');
    await authorize(db, p, row.brand_id, 'publication.schedule');
    await db.query('update prize set archived_at = coalesce(archived_at, $2) where id = $1', [prizeId, ctx.now()]);
    await audit(db, p, row.brand_id, 'prize.archived', 'prize', prizeId, { archived: false }, { archived: true });
    return { id: prizeId };
  });
}

// ───────────────────────────── the rule a post carries ─────────────────────────────

export const ruleInput = z.object({
  prizeId: z.string().uuid(),
  keyword: z.string().trim().min(1).max(60),
  // Room is left for the link and for the note that the message is automatic: a private message holds 1000 characters.
  message: z.string().trim().min(1).max(700),
  linkHours: z.number().int().min(1).max(720).default(72),
  publicDays: z.number().int().min(1).max(365).default(30),
  noticeConfirmed: z.boolean().default(false),
  active: z.boolean().default(true),
});

const LIVE = ['scheduled', 'preparing', 'ready', 'publishing', 'published', 'awaiting_reapproval', 'on_hold'];

async function ruleView(ctx: Ctx, rule: Row, network: string, manual: boolean) {
  const prize = await ctx.db.one('select * from prize where id = $1', [rule.prize_id]);
  const counts = await ctx.db.query('select status, count(*)::int as n from prize_delivery where rule_id = $1 group by status', [rule.id]);
  return {
    id: rule.id, publication_id: rule.publication_id, mode: modeFor(network, manual), active: rule.active, keyword: rule.keyword, message: rule.message,
    link_hours: rule.link_hours, notice_confirmed: rule.notice_confirmed,
    prize: prize ? prizeView(prize) : null,
    public_url: rule.public_token ? `${ctx.config.APP_URL}/prize/${rule.public_token}` : null, public_expires_at: rule.public_expires_at,
    deliveries: Object.fromEntries(['pending', 'sent', 'skipped', 'failed'].map((s) => [s, counts.find((c) => c.status === s)?.n ?? 0])),
  };
}

async function loadPublication(db: Pick<Ctx['db'], 'one'>, publicationId: string) {
  const pub = await db.one(
    `select p.*, a.brand_id, a.network, a.status as account_status, a.granted_permissions, a.display_name as account_name
     from publication p join social_account a on a.id = p.social_account_id where p.id = $1`,
    [publicationId],
  );
  if (!pub) throw notFound('Publication');
  return pub;
}

export async function getRule(ctx: Ctx, p: Principal, publicationId: string) {
  const pub = await loadPublication(ctx.db, publicationId);
  await authorize(ctx.db, p, pub.brand_id, 'publication.schedule');
  const rule = await ctx.db.one('select * from prize_rule where publication_id = $1', [publicationId]);
  const settings = prizesOf((await ctx.db.one('select prizes from brand where id = $1', [pub.brand_id]))!);
  return {
    rule: rule ? await ruleView(ctx, rule, pub.network, pub.manual) : null,
    mode: modeFor(pub.network, pub.manual),
    prizes_enabled: settings.enabled,
    auto_notice: settings.auto_notice,
    // Whether the connection may send private messages. Where it may not, the account has to be connected again with prizes on.
    can_message: modeFor(pub.network, pub.manual) === 'private_reply' ? hasMessaging(pub) : null,
  };
}

const hasMessaging = (pub: Row) => ((pub.granted_permissions as string[] | null) ?? []).includes(MESSAGING_SCOPE[pub.network] ?? '\0');

export async function setRule(ctx: Ctx, p: Principal, publicationId: string, raw: unknown) {
  const input = ruleInput.parse(raw);
  const view = await saveRule(ctx, p, publicationId, input);
  // A running rule that answers by private message relies on Meta pushing the comments: make sure the app is subscribed to the
  // account's events (the worker still reads them every few minutes, so this is best effort).
  if (input.active && view.mode === 'private_reply') {
    const acc = await ctx.db.one(
      `select a.id, a.provider_data from publication p join social_account a on a.id = p.social_account_id where p.id = $1`, [publicationId]);
    if (acc && acc.provider_data?.events?.subscribed !== true) await subscribeEvents(ctx, acc.id);
  }
  return view;
}

async function saveRule(ctx: Ctx, p: Principal, publicationId: string, input: z.infer<typeof ruleInput>) {
  return ctx.db.tx(async (db) => {
    await db.query('select 1 from publication where id = $1 for update', [publicationId]);
    const pub = await loadPublication(db, publicationId);
    await authorize(db, p, pub.brand_id, 'publication.schedule');
    if (!LIVE.includes(pub.status)) throw conflict('publication_closed', 'A cancelled or failed publication cannot carry a prize');
    const prize = await db.one('select * from prize where id = $1 and brand_id = $2', [input.prizeId, pub.brand_id]);
    if (!prize) throw badRequest('unknown_prize', 'That prize does not belong to this brand');
    const before = await db.one('select * from prize_rule where publication_id = $1', [publicationId]);
    if (prize.archived_at && before?.prize_id !== prize.id) throw badRequest('prize_archived', 'That prize has been archived');
    if (!(prize.kind === 'link' || prize.uploaded_at)) throw badRequest('prize_not_ready', 'That prize has no file yet');
    const keywordNorm = normalize(input.keyword);
    if (!keywordNorm) throw badRequest('invalid_keyword', 'The keyword needs at least one letter or digit');
    if (!/\{\{\s*link\s*\}\}/.test(input.message)) throw badRequest('link_missing', 'The message has to contain {{link}}, where the link to the prize goes');

    const mode = modeFor(pub.network, pub.manual);
    if (input.active) {
      const settings = prizesOf((await db.one('select prizes from brand where id = $1', [pub.brand_id]))!);
      if (!settings.enabled) throw conflict('prizes_off', 'Prizes are switched off for this brand. An admin can switch them on in Settings.');
      if (!input.noticeConfirmed) {
        throw conflict('notice_required', "Confirm that the post's own text tells people the reply is automatic and what is done with their data. A prize does not run without it.");
      }
      if (mode === 'private_reply') {
        if (pub.account_status !== 'active') throw conflict('needs_reconnect', 'This account has to be connected again before it can send messages');
        if (!hasMessaging(pub)) {
          throw conflict('needs_reconnect', 'This account was connected without the permission to send messages. Connect it again, with prizes switched on, to grant it.');
        }
      }
    }
    const publicToken = before?.public_token ?? token();
    const publicExpires = new Date(ctx.now().getTime() + input.publicDays * 86_400_000);
    const row = (await db.one(
      `insert into prize_rule (brand_id, publication_id, prize_id, keyword, keyword_norm, message, link_hours, notice_confirmed, active, public_token, public_expires_at, created_by)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       on conflict (publication_id) do update set prize_id = excluded.prize_id, keyword = excluded.keyword, keyword_norm = excluded.keyword_norm, message = excluded.message,
         link_hours = excluded.link_hours, notice_confirmed = excluded.notice_confirmed, active = excluded.active, public_expires_at = excluded.public_expires_at, updated_at = $13
       returning *`,
      [pub.brand_id, publicationId, input.prizeId, input.keyword, keywordNorm, input.message, input.linkHours, input.noticeConfirmed, input.active, publicToken, publicExpires, p.kind === 'user' ? p.userId : null, ctx.now()],
    ))!;
    await audit(db, p, pub.brand_id, before ? 'prize.rule_changed' : 'prize.rule_set', 'prize_rule', row.id,
      before ? { keyword: before.keyword, prize_id: before.prize_id, active: before.active } : null,
      { keyword: row.keyword, prize_id: row.prize_id, active: row.active, mode, publication_id: publicationId });
    return ruleView({ ...ctx, db } as Ctx, row, pub.network, pub.manual);
  });
}

export async function listDeliveries(ctx: Ctx, p: Principal, publicationId: string) {
  const pub = await loadPublication(ctx.db, publicationId);
  await authorize(ctx.db, p, pub.brand_id, 'publication.schedule');
  const rows = await ctx.db.query('select * from prize_delivery where publication_id = $1 order by comment_at desc limit 200', [publicationId]);
  // The network's id for each person is never shown: only the name they show, and what happened.
  return rows.map((r) => ({
    id: r.id, person: r.person_name || 'Someone', status: r.status, reason: r.reason, comment_at: r.comment_at, sent_at: r.sent_at,
    downloads: r.downloads, expires_at: r.expires_at, purge_after: r.purge_after,
  }));
}

// ───────────────────────────── a comment arrives ─────────────────────────────

export interface IncomingComment {
  network: 'instagram' | 'facebook';
  /** The id of the post on the network. */
  postId: string;
  commentId: string;
  personId: string;
  personName: string;
  text: string;
  createdAt: Date;
  /** A reply to somebody's comment is not a comment on the post, and is left alone. */
  topLevel: boolean;
  /** The id of the account the comment was made on, when the network says (a webhook does). */
  ownerId?: string;
}

/**
 * A comment on a post. If the post has a running rule and the comment says its keyword, the person is written down for a
 * prize. Idempotent: the same comment arriving by webhook and by polling is one comment.
 */
export async function handleComment(ctx: Ctx, c: IncomingComment): Promise<'queued' | 'skipped' | 'ignored'> {
  if (!c.topLevel) return 'ignored';
  const pub = await ctx.db.one(
    `select p.id, p.social_account_id, p.manual, a.brand_id, a.network, a.external_id as owner_external, a.provider_data, r.id as rule_id, r.prize_id, r.keyword_norm, r.active, r.notice_confirmed
     from publication p join social_account a on a.id = p.social_account_id join prize_rule r on r.publication_id = p.id
     where a.network = $1 and p.status = 'published' and (p.external_id = $2 or ($1 = 'facebook' and $2 like '%\\_' || p.external_id))`,
    [c.network, c.postId],
  );
  if (!pub || !pub.active || !pub.notice_confirmed || pub.manual) return 'ignored';
  // The account's own comments (its first comment, its replies) are not entries.
  const own = [pub.owner_external, pub.provider_data?.igUserId, pub.provider_data?.pageId].filter(Boolean);
  if (own.includes(c.personId) || (c.ownerId && c.personId === c.ownerId)) return 'ignored';
  if (!matches(c.text, pub.keyword_norm)) return 'ignored';

  const retention = prizesOf((await ctx.db.one('select prizes from brand where id = $1', [pub.brand_id]))!).retention_days;
  const now = ctx.now();
  const purgeAfter = new Date(now.getTime() + retention * 86_400_000);
  const base = [pub.rule_id, pub.prize_id, pub.brand_id, pub.id, pub.social_account_id, c.network, c.commentId, c.personId, c.personName.slice(0, 120), c.createdAt, purgeAfter];
  const insert = (status: 'pending' | 'skipped', reason: string | null) =>
    ctx.db.one(
      `insert into prize_delivery (rule_id, prize_id, brand_id, publication_id, account_id, network, comment_id, person_id, person_name, comment_at, purge_after, status, reason, next_attempt_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) on conflict (rule_id, comment_id) do nothing returning id`,
      [...base, status, reason, status === 'pending' ? now : null],
    );

  // Too late for Meta to take a private reply.
  if (now.getTime() - c.createdAt.getTime() > WINDOW_MS) return (await insert('skipped', 'too_old')) ? 'skipped' : 'ignored';
  // The same person gets the same prize once, whichever post they commented on.
  const already = await ctx.db.one(`select 1 from prize_delivery where prize_id = $1 and person_id = $2 and status in ('pending','sent')`, [pub.prize_id, c.personId]);
  if (already) return (await insert('skipped', 'already_received')) ? 'skipped' : 'ignored';
  try {
    return (await insert('pending', null)) ? 'queued' : 'ignored';
  } catch (err) {
    // Two comments from one person arriving at once: the database lets one of them through.
    if ((err as { code?: string }).code === '23505' && /prize_delivery_once/.test(String((err as { constraint?: string }).constraint ?? (err as Error).message))) {
      return (await insert('skipped', 'already_received')) ? 'skipped' : 'ignored';
    }
    throw err;
  }
}

// ───────────────────────────── reading comments, for the networks that do not push them ─────────────────────────────

/**
 * Reads the comments of posts with a running rule, every few minutes. Meta only pushes comments to an app it has reviewed, so
 * until then this is how they are found; afterwards it is the safety net for a webhook that was lost.
 */
export async function pollComments(ctx: Ctx, limit = 20): Promise<number> {
  const now = ctx.now();
  const every = ctx.config.PRIZE_POLL_SECONDS * 1000;
  const due = await ctx.db.query(
    `select p.id as publication_id, p.external_id, p.handle, p.published_at, a.id as account_id, a.network, pp.last_comment_at
     from prize_rule r join publication p on p.id = r.publication_id join social_account a on a.id = p.social_account_id left join prize_poll pp on pp.publication_id = p.id
     where r.active and r.notice_confirmed and p.status = 'published' and p.manual = false and p.external_id is not null and a.status = 'active'
       and a.network in ('instagram','facebook') and p.published_at > $1
       and (pp.last_polled_at is null or pp.last_polled_at < $2) and (pp.lease_until is null or pp.lease_until < $3)
     order by pp.last_polled_at nulls first limit $4`,
    [new Date(now.getTime() - POLL_UNTIL_MS), new Date(now.getTime() - every), now, limit],
  );
  let read = 0;
  for (const d of due) {
    const lease = await ctx.db.one(
      `insert into prize_poll (publication_id, lease_until) values ($1,$2)
       on conflict (publication_id) do update set lease_until = $2 where prize_poll.lease_until is null or prize_poll.lease_until < $3 returning publication_id`,
      [d.publication_id, new Date(now.getTime() + POLL_LEASE_MS), now],
    );
    if (!lease) continue; // another worker has it
    let latest: Date | null = d.last_comment_at ? new Date(d.last_comment_at) : null;
    try {
      const connector = ctx.connectors.connector(d.network);
      const account = await loadConnectorAccount(ctx, d.account_id);
      if (connector?.listComments && account) {
        // A second back, so two comments in the same second are not lost; each is recorded once whatever happens.
        const since = new Date((latest ?? new Date(d.published_at)).getTime() - 1000);
        const found = await connector.listComments(account, d.external_id, d.handle ?? {}, connectorEnv(ctx, d.account_id), since);
        for (const n of found) {
          const at = new Date(n.createdAt);
          await handleComment(ctx, { network: d.network, postId: d.external_id, commentId: n.id, personId: n.authorId, personName: n.authorName, text: n.text, createdAt: at, topLevel: true });
          if (!latest || at > latest) latest = at;
          read++;
        }
      }
    } catch (err) {
      // A limit or a hiccup: the next round tries again from where this one was.
      if (!(err instanceof ConnectorError)) ctx.log.warn({ err: String(err), publication: d.publication_id }, 'reading comments failed');
    } finally {
      await ctx.db.query('update prize_poll set last_polled_at = $2, last_comment_at = $3, lease_until = null where publication_id = $1', [d.publication_id, now, latest]);
    }
  }
  return read;
}

// ───────────────────────────── sending the prize ─────────────────────────────

async function finish(ctx: Ctx, id: string, patch: { status: 'sent' | 'skipped' | 'failed' | 'pending'; reason?: string | null; next?: Date | null; tokenHash?: string; expires?: Date }) {
  await ctx.db.query(
    `update prize_delivery set status = $2, reason = $3, next_attempt_at = $4, lease_until = null, token_hash = coalesce($5, token_hash), expires_at = coalesce($6, expires_at),
       sent_at = case when $2 = 'sent' then $7::timestamptz else sent_at end where id = $1`,
    [id, patch.status, patch.reason ?? null, patch.next ?? null, patch.tokenHash ?? null, patch.expires ?? null, ctx.now()],
  );
}

async function sendOne(ctx: Ctx, d: Row): Promise<string> {
  const now = ctx.now();
  const row = await ctx.db.one(
    `select r.active, r.notice_confirmed, r.message, r.link_hours, pr.name as prize_name, pr.archived_at, a.status as account_status, a.network, a.brand_id, b.prizes
     from prize_rule r join prize pr on pr.id = r.prize_id join social_account a on a.id = $2 join brand b on b.id = a.brand_id where r.id = $1`,
    [d.rule_id, d.account_id],
  );
  if (!row || !row.active || !row.notice_confirmed) {
    await finish(ctx, d.id, { status: 'skipped', reason: 'rule_off' });
    return 'skipped';
  }
  if (now.getTime() - new Date(d.comment_at).getTime() > WINDOW_MS) {
    await finish(ctx, d.id, { status: 'skipped', reason: 'too_old' });
    return 'skipped';
  }
  const later = (s: number) => new Date(now.getTime() + s * 1000);
  const retry = async (reason: string, seconds: number, count = true): Promise<string> => {
    if (count && d.attempts >= BACKOFF.length) {
      await finish(ctx, d.id, { status: 'failed', reason });
      return 'failed';
    }
    // Waiting past the end of Meta's window is a failure, said plainly, not a message that cannot be sent.
    if (new Date(d.comment_at).getTime() + WINDOW_MS < later(seconds).getTime()) {
      await finish(ctx, d.id, { status: 'failed', reason: `${reason} (and the 7 days Meta allows for a reply ran out)` });
      return 'failed';
    }
    if (!count) await ctx.db.query('update prize_delivery set attempts = attempts - 1 where id = $1', [d.id]);
    await finish(ctx, d.id, { status: 'pending', reason, next: later(seconds) });
    return 'retry';
  };
  if (row.account_status !== 'active') return retry('The account has to be connected again before it can send messages', 3600);

  // Meta allows 750 private replies an hour for an account: stay under it, and when it is reached wait for the oldest to leave the hour.
  const sentLastHour = await ctx.db.query(`select sent_at from prize_delivery where account_id = $1 and status = 'sent' and sent_at > $2 order by sent_at`, [d.account_id, new Date(now.getTime() - 3_600_000)]);
  if (sentLastHour.length >= MAX_PER_HOUR) {
    const oldest = new Date(sentLastHour[0]!.sent_at).getTime();
    return retry('The hourly limit of private messages for this account was reached', Math.max(60, Math.ceil((oldest + 3_600_000 - now.getTime()) / 1000)), false);
  }

  const connector = ctx.connectors.connector(row.network);
  const account = await loadConnectorAccount(ctx, d.account_id);
  if (!connector?.privateReply || !account) {
    await finish(ctx, d.id, { status: 'failed', reason: `The app cannot send private messages on ${row.network} here` });
    return 'failed';
  }
  const settings = prizesOf({ prizes: row.prizes });
  const secret = token();
  const expires = new Date(now.getTime() + row.link_hours * 3_600_000);
  const text = `${render(row.message, { name: d.person_name || '', link: `${ctx.config.APP_URL}/prize/${secret}`, prize: row.prize_name, hours: String(row.link_hours) })}\n\n${settings.auto_notice}`;
  try {
    await connector.privateReply(account, d.comment_id, text, connectorEnv(ctx, d.account_id));
    await finish(ctx, d.id, { status: 'sent', tokenHash: sha256Hex(secret), expires });
    return 'sent';
  } catch (err) {
    if (!(err instanceof ConnectorError)) throw err;
    const wait = BACKOFF[Math.min(d.attempts - 1, BACKOFF.length - 1)]!;
    switch (err.errorClass) {
      case 'rate_limit': return retry(`${err.message} (the network's limit)`, Math.min(Math.max(60, err.retryAfterSec ?? 900), 6 * 3600), false);
      case 'auth': return retry(`The connection is not allowed to send messages: ${err.message}`, wait);
      case 'file_rejected':
      case 'unsupported':
        // Already answered, outside the window, the person cannot be messaged: nothing to try again.
        await finish(ctx, d.id, { status: 'failed', reason: err.message.slice(0, 400) });
        return 'failed';
      default: return retry(err.message.slice(0, 400), wait);
    }
  }
}

/** Sends the prizes that are due. Each is claimed with a lease first, so several workers never send one twice. */
export async function scanPrizeDeliveries(ctx: Ctx, limit = 20): Promise<number> {
  const now = ctx.now();
  const claimed = await ctx.db.query(
    `update prize_delivery d set lease_until = $2, attempts = d.attempts + 1
     where d.id in (
       select id from prize_delivery where status = 'pending' and next_attempt_at <= $1 and (lease_until is null or lease_until < $1)
       order by next_attempt_at limit $3 for update skip locked)
     returning d.*`,
    [now, new Date(now.getTime() + LEASE_MS), limit],
  );
  for (const d of claimed) {
    try {
      await sendOne(ctx, d);
    } catch (err) {
      ctx.log.error({ err: String(err), delivery: d.id }, 'sending a prize failed');
      await ctx.db.query('update prize_delivery set lease_until = null, next_attempt_at = $2 where id = $1', [d.id, new Date(ctx.now().getTime() + 300_000)]);
    }
  }
  return claimed.length;
}

// ───────────────────────────── the page the person opens ─────────────────────────────

interface Resolved {
  /** Whether the secret is a person's own link (limited, expires) or a rule's public page. */
  source: 'delivery' | 'public';
  id: string;
  expires_at: Date | string;
  name: string;
  /** The kind of prize: a file kept here, or a link. */
  kind: 'file' | 'link';
  file_key: string | null;
  file_name: string | null;
  url: string | null;
  brand: string;
}

async function resolveToken(ctx: Ctx, secret: string): Promise<Resolved> {
  if (!/^[A-Za-z0-9_-]{16,80}$/.test(secret)) throw notFound('Prize');
  const now = ctx.now();
  const delivery = await ctx.db.one(
    `select d.id, d.expires_at, d.downloads, d.status, pr.name, pr.kind, pr.file_key, pr.file_name, pr.url, b.name as brand
     from prize_delivery d join prize pr on pr.id = d.prize_id join brand b on b.id = d.brand_id where d.token_hash = $1`,
    [sha256Hex(secret)],
  );
  if (delivery) {
    if (delivery.status !== 'sent' || !delivery.expires_at || new Date(delivery.expires_at) <= now) throw new AppError(410, 'expired', 'This link has expired.');
    if (delivery.downloads >= MAX_DOWNLOADS) throw new AppError(410, 'used_up', 'This link has been used the most times it allows.');
    return { ...(delivery as unknown as Resolved), source: 'delivery' };
  }
  const rule = await ctx.db.one(
    `select r.id, r.public_expires_at as expires_at, r.active, pr.name, pr.kind, pr.file_key, pr.file_name, pr.url, b.name as brand
     from prize_rule r join prize pr on pr.id = r.prize_id join brand b on b.id = r.brand_id where r.public_token = $1`,
    [secret],
  );
  if (!rule) throw notFound('Prize');
  if (!rule.active || !rule.expires_at || new Date(rule.expires_at) <= now) throw new AppError(410, 'expired', 'This page has expired.');
  return { ...(rule as unknown as Resolved), source: 'public' };
}

/** What the page says. Nothing about who the prize was sent to, or which post it was. */
export async function publicPrize(ctx: Ctx, secret: string) {
  const r = await resolveToken(ctx, secret);
  return { prize: { name: r.name, kind: r.kind, file_name: r.kind === 'file' ? r.file_name : null }, brand: r.brand, expires_at: r.expires_at };
}

export async function downloadPrize(ctx: Ctx, secret: string) {
  const r = await resolveToken(ctx, secret);
  if (r.source === 'delivery') {
    // Counted and checked in one statement, so two clicks at once cannot both be the last one allowed.
    const counted = await ctx.db.one('update prize_delivery set downloads = downloads + 1 where id = $1 and downloads < $2 and expires_at > $3 returning id', [r.id, MAX_DOWNLOADS, ctx.now()]);
    if (!counted) throw new AppError(410, 'used_up', 'This link has been used the most times it allows.');
  }
  // A file is handed over by a link that works for five minutes; a link prize is simply the link.
  if (r.kind === 'file') return { url: await ctx.storage.presignGet(r.file_key!, { expiresSec: 300, filename: r.file_name ?? undefined }) };
  return { url: r.url! };
}

// ───────────────────────────── what is kept about people ─────────────────────────────

/** Deletes the people whose retention period is over. Done every hour, and the count (never who) goes in the audit log. */
export async function purgePrizeData(ctx: Ctx): Promise<number> {
  const rows = await ctx.db.query('delete from prize_delivery where purge_after <= $1 returning brand_id', [ctx.now()]);
  const per = new Map<string, number>();
  for (const r of rows) per.set(r.brand_id, (per.get(r.brand_id) ?? 0) + 1);
  for (const [brandId, n] of per) await audit(ctx.db, null, brandId, 'prize.purged', 'prize_delivery', null, null, { rows: n });
  return rows.length;
}

const eraseInput = z.object({ personId: z.string().trim().min(1).max(200).optional(), name: z.string().trim().min(1).max(200).optional() })
  .refine((v) => v.personId || v.name, 'Say who: their id on the network, or the name they show');

/** An admin erases a person on request: by their id on the network or the exact name they show. */
export async function erasePerson(ctx: Ctx, p: Principal, brandId: string, raw: unknown) {
  const input = eraseInput.parse(raw);
  return ctx.db.tx(async (db) => {
    await authorize(db, p, brandId, 'brand.manage');
    const rows = await db.query(
      `delete from prize_delivery where brand_id = $1 and (($2::text is not null and person_id = $2) or ($3::text is not null and lower(person_name) = lower($3))) returning id`,
      [brandId, input.personId ?? null, input.name ?? null],
    );
    await audit(db, p, brandId, 'prize.person_erased', 'prize_delivery', null, null, { rows: rows.length, by: input.personId ? 'id' : 'name' });
    return { deleted: rows.length };
  });
}

/**
 * Meta calls an address of ours when a person removes the app from their account, with a signed request naming them. Their
 * rows are deleted everywhere, and a code is returned that a status page answers for.
 */
export async function metaDataDeletion(ctx: Ctx, signedRequest: string): Promise<{ url: string; confirmation_code: string }> {
  const secret = ctx.config.META_APP_SECRET;
  if (!secret) throw forbidden('Meta is not set up here');
  const [sig, payload] = signedRequest.split('.');
  if (!sig || !payload) throw badRequest('invalid_request', 'Not a signed request');
  const expected = createHmac('sha256', secret).update(payload).digest();
  const given = Buffer.from(sig, 'base64url');
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) throw forbidden('The signature does not match');
  let userId: string | undefined;
  try {
    userId = String((JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { user_id?: string | number }).user_id ?? '');
  } catch {
    throw badRequest('invalid_request', 'The request could not be read');
  }
  if (!userId) throw badRequest('invalid_request', 'The request names nobody');
  const rows = await ctx.db.query('delete from prize_delivery where person_id = $1 returning brand_id', [userId]);
  const code = `del_${randomBytes(9).toString('base64url')}`;
  // The id itself is not kept: only enough to say that a request was made and handled.
  await ctx.db.query('insert into deletion_request (code, network, person_id, rows_deleted) values ($1,$2,$3,$4)', [code, 'meta', sha256Hex(userId), rows.length]);
  for (const brandId of new Set(rows.map((r) => r.brand_id))) await audit(ctx.db, null, brandId, 'prize.deletion_request', 'prize_delivery', null, null, { rows: rows.filter((r) => r.brand_id === brandId).length });
  return { url: `${ctx.config.APP_URL}/data-deletion?code=${code}`, confirmation_code: code };
}

export async function deletionStatus(ctx: Ctx, code: string) {
  const r = await ctx.db.one('select requested_at, rows_deleted from deletion_request where code = $1', [code]);
  if (!r) throw notFound('Request');
  return { status: 'completed', requested_at: r.requested_at, deleted: r.rows_deleted };
}

// ───────────────────────────── what Meta pushes ─────────────────────────────

/** The address Meta calls once to check it is ours: it echoes back the challenge only if the token is the one we set. */
export function verifyMetaWebhook(ctx: Ctx, q: Record<string, string | undefined>): string {
  const token = ctx.config.META_WEBHOOK_VERIFY_TOKEN;
  if (!token || q['hub.mode'] !== 'subscribe' || q['hub.verify_token'] !== token || !q['hub.challenge']) throw forbidden('Not accepted');
  return q['hub.challenge'];
}

/** Whether a push is from Meta: the body signed with the app's secret. */
export function metaSignatureOk(ctx: Ctx, raw: Buffer, header: string | undefined): boolean {
  const secret = ctx.config.META_APP_SECRET;
  if (!secret || !header?.startsWith('sha256=')) return false;
  const given = Buffer.from(header.slice(7), 'hex');
  const expected = createHmac('sha256', secret).update(raw).digest();
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/** Turns what Meta pushes (an Instagram comment, a Page feed comment) into comments, and hands each to the rule. */
export async function receiveMetaWebhook(ctx: Ctx, payload: any): Promise<number> {
  let n = 0;
  for (const entry of payload?.entry ?? []) {
    for (const ch of entry?.changes ?? []) {
      const v = ch?.value ?? {};
      let c: IncomingComment | null = null;
      if (payload.object === 'instagram' && ch.field === 'comments' && v.id && v.media?.id) {
        c = {
          network: 'instagram', postId: String(v.media.id), commentId: String(v.id), personId: String(v.from?.id ?? v.from?.username ?? ''), personName: String(v.from?.username ?? ''),
          text: String(v.text ?? ''), createdAt: new Date(((entry.time as number) ?? Date.now() / 1000) * 1000), topLevel: !v.parent_id, ownerId: entry.id ? String(entry.id) : undefined,
        };
      } else if (payload.object === 'page' && ch.field === 'feed' && v.item === 'comment' && v.verb === 'add' && v.comment_id && v.post_id) {
        c = {
          network: 'facebook', postId: String(v.post_id), commentId: String(v.comment_id), personId: String(v.from?.id ?? ''), personName: String(v.from?.name ?? ''),
          text: String(v.message ?? ''), createdAt: new Date(((v.created_time as number) ?? (entry.time as number) ?? Date.now() / 1000) * 1000),
          // On Facebook a reply to a comment has the comment as its parent; a comment on the post has the post.
          topLevel: !v.parent_id || String(v.parent_id) === String(v.post_id), ownerId: entry.id ? String(entry.id) : undefined,
        };
      }
      if (c && c.personId) {
        await handleComment(ctx, c);
        n++;
      }
    }
  }
  return n;
}

