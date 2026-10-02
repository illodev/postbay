import { createHmac, randomBytes } from 'node:crypto';
import { z } from 'zod';
import { authorize, type Principal } from '../auth/principal.js';
import type { Ctx } from '../context.js';
import type { Queryable } from '../db.js';
import { badRequest, conflict, forbidden, notFound } from '../errors.js';
import { checkUrl, PolicyError, post, type NetPolicy } from '../net.js';
import { audit } from './audit.js';
import { EVENT_DESCRIPTIONS, EVENT_TYPES, emit, materialize } from './events.js';
import { notifyRoles } from './notify.js';

/**
 * Seconds to wait after the nth failed attempt. The first attempt is immediate, so a delivery is tried 11 times over about
 * 21.7 hours and given up on at 24 hours at the latest.
 */
export const BACKOFF_SECONDS = [10, 30, 120, 600, 1800, 3600, 7200, 14400, 21600, 28800];
export const DELIVERY_WINDOW_HOURS = 24;
const LEASE_SECONDS = 90;
const MAX_RETRY_AFTER_SECONDS = 3600;

export const webhookInput = z.object({
  url: z.string().trim().min(8).max(2000),
  description: z.string().trim().max(200).default(''),
  events: z.array(z.enum(EVENT_TYPES)).min(1).max(EVENT_TYPES.length).transform((e) => [...new Set(e)]),
});
export const webhookPatch = z.object({
  url: z.string().trim().min(8).max(2000).optional(),
  description: z.string().trim().max(200).optional(),
  events: z.array(z.enum(EVENT_TYPES)).min(1).transform((e) => [...new Set(e)]).optional(),
  active: z.boolean().optional(),
});

const policyOf = (ctx: Ctx): NetPolicy => ({ allowPrivate: ctx.config.webhookAllowPrivate, httpsForPublic: ctx.config.isProd });
const addSeconds = (d: Date, s: number) => new Date(d.getTime() + s * 1000);

/** The signature a receiver recomputes: HMAC-SHA256 over "<timestamp>.<body>", hex, with the subscription's secret. */
export const signBody = (secret: string, timestamp: number | string, body: string) =>
  createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');

function requireVault(ctx: Ctx) {
  if (!ctx.vault) throw conflict('token_key_missing', 'Webhooks keep their secrets sealed, so the server needs TOKEN_KEY (openssl rand -base64 32)');
  return ctx.vault;
}

async function loadWebhook(db: Queryable, id: string) {
  const w = await db.one('select * from webhook where id = $1', [id]);
  if (!w) throw notFound('Webhook');
  return w;
}

const view = (w: Record<string, any>) => ({
  id: w.id, url: w.url, description: w.description, events: w.events, active: w.active, disabled_reason: w.disabled_reason,
  secret_hint: w.secret_hint, created_at: w.created_at, last_success_at: w.last_success_at, last_failure_at: w.last_failure_at,
});

const newSecret = () => `whsec_${randomBytes(32).toString('base64url')}`;

function urlOrThrow(ctx: Ctx, raw: string): string {
  const r = checkUrl(raw, policyOf(ctx));
  if ('error' in r) throw badRequest('invalid_url', r.error);
  return r.url.toString();
}

// ───────────────────────────── subscriptions ─────────────────────────────

export async function listWebhooks(ctx: Ctx, p: Principal, brandId: string) {
  await authorize(ctx.db, p, brandId, 'brand.manage');
  const rows = await ctx.db.query(
    `select w.*,
       (select count(*)::int from webhook_delivery d where d.webhook_id = w.id and d.status = 'pending') as pending,
       (select count(*)::int from webhook_delivery d where d.webhook_id = w.id and d.status = 'failed' and d.created_at > now() - interval '24 hours') as failed_24h
     from webhook w where w.brand_id = $1 order by w.created_at`,
    [brandId],
  );
  return {
    items: rows.map((w) => ({ ...view(w), pending: w.pending, failed_24h: w.failed_24h })),
    eventTypes: EVENT_TYPES.map((type) => ({ type, description: EVENT_DESCRIPTIONS[type] })),
  };
}

/** The secret is returned once, here, and never again: only its sealed copy is kept, to sign deliveries. */
export async function createWebhook(ctx: Ctx, p: Principal, brandId: string, raw: unknown) {
  const input = webhookInput.parse(raw);
  const vault = requireVault(ctx);
  const url = urlOrThrow(ctx, input.url);
  return ctx.db.tx(async (db) => {
    await authorize(db, p, brandId, 'brand.manage');
    if (p.kind !== 'user') throw forbidden();
    const count = (await db.one<{ n: number }>('select count(*)::int as n from webhook where brand_id = $1', [brandId]))!.n;
    if (count >= 20) throw conflict('too_many_webhooks', 'A brand can have at most 20 webhooks');
    const secret = newSecret();
    const id = (await db.one<{ id: string }>('select gen_random_uuid() as id'))!.id;
    const row = (await db.one(
      `insert into webhook (id, brand_id, url, description, events, secret_encrypted, secret_hint, created_by)
       values ($1,$2,$3,$4,$5,$6,$7,$8) returning *`,
      [id, brandId, url, input.description, input.events, vault.seal({ secret }, `webhook:${id}`), secret.slice(-4), p.userId],
    ))!;
    await audit(db, p, brandId, 'webhook.created', 'webhook', id, null, { url, events: input.events });
    return { ...view(row), secret };
  });
}

export async function updateWebhook(ctx: Ctx, p: Principal, webhookId: string, raw: unknown) {
  const input = webhookPatch.parse(raw);
  const url = input.url !== undefined ? urlOrThrow(ctx, input.url) : undefined;
  return ctx.db.tx(async (db) => {
    const before = await loadWebhook(db, webhookId);
    await authorize(db, p, before.brand_id, 'brand.manage');
    const row = (await db.one(
      `update webhook set url = coalesce($2, url), description = coalesce($3, description), events = coalesce($4, events),
         active = coalesce($5, active),
         disabled_reason = case when $5::boolean is true then null else disabled_reason end
       where id = $1 returning *`,
      [webhookId, url ?? null, input.description ?? null, input.events ?? null, input.active ?? null],
    ))!;
    await audit(db, p, before.brand_id, 'webhook.updated', 'webhook', webhookId,
      { url: before.url, events: before.events, active: before.active }, { url: row.url, events: row.events, active: row.active });
    return view(row);
  });
}

export async function rotateSecret(ctx: Ctx, p: Principal, webhookId: string) {
  const vault = requireVault(ctx);
  return ctx.db.tx(async (db) => {
    const w = await loadWebhook(db, webhookId);
    await authorize(db, p, w.brand_id, 'brand.manage');
    const secret = newSecret();
    await db.query('update webhook set secret_encrypted = $2, secret_hint = $3 where id = $1', [webhookId, vault.seal({ secret }, `webhook:${webhookId}`), secret.slice(-4)]);
    await audit(db, p, w.brand_id, 'webhook.secret_rotated', 'webhook', webhookId, { hint: w.secret_hint }, { hint: secret.slice(-4) });
    return { id: webhookId, secret, secret_hint: secret.slice(-4) };
  });
}

export async function deleteWebhook(ctx: Ctx, p: Principal, webhookId: string) {
  return ctx.db.tx(async (db) => {
    const w = await loadWebhook(db, webhookId);
    await authorize(db, p, w.brand_id, 'brand.manage');
    await db.query('delete from webhook where id = $1', [webhookId]);
    await audit(db, p, w.brand_id, 'webhook.deleted', 'webhook', webhookId, { url: w.url }, null);
    return { id: webhookId };
  });
}

/** Sends a `ping` event to this webhook only, so a receiver can be checked before anything real depends on it. */
export async function testWebhook(ctx: Ctx, p: Principal, webhookId: string) {
  return ctx.db.tx(async (db) => {
    const w = await loadWebhook(db, webhookId);
    await authorize(db, p, w.brand_id, 'brand.manage');
    if (!w.active) throw conflict('webhook_disabled', 'This webhook is disabled: enable it first');
    const eventId = await emit(ctx, db, w.brand_id, 'ping', { message: 'This is a test from Studio. If you can read it, the webhook works.', webhook_id: webhookId }, { webhookId });
    const d = (await db.one<{ id: string }>('select id from webhook_delivery where webhook_id = $1 and event_id = $2', [webhookId, eventId]))!;
    return { deliveryId: d.id };
  });
}

// ───────────────────────────── deliveries ─────────────────────────────

export async function listDeliveries(ctx: Ctx, p: Principal, webhookId: string, f: { status?: string }) {
  const w = await loadWebhook(ctx.db, webhookId);
  await authorize(ctx.db, p, w.brand_id, 'brand.manage');
  return ctx.db.query(
    `select d.id, d.status, d.attempts, d.next_attempt_at, d.expires_at, d.last_status, d.last_error, d.delivered_at, d.created_at,
       e.id as event_id, e.type
     from webhook_delivery d join event e on e.id = d.event_id
     where d.webhook_id = $1 and ($2::text is null or d.status = $2) order by d.created_at desc limit 100`,
    [webhookId, f.status ?? null],
  );
}

export async function getDelivery(ctx: Ctx, p: Principal, deliveryId: string) {
  const d = await ctx.db.one(
    `select d.*, w.brand_id, e.type, e.data from webhook_delivery d join webhook w on w.id = d.webhook_id join event e on e.id = d.event_id where d.id = $1`,
    [deliveryId],
  );
  if (!d) throw notFound('Delivery');
  await authorize(ctx.db, p, d.brand_id, 'brand.manage');
  const attempts = await ctx.db.query('select at, http_status, error, duration_ms from webhook_attempt where delivery_id = $1 order by id', [deliveryId]);
  return { id: d.id, status: d.status, type: d.type, event_id: d.event_id, attempts_made: d.attempts, next_attempt_at: d.next_attempt_at, expires_at: d.expires_at, attempts };
}

/** Puts a finished delivery back in the queue, with a fresh 24 hours. */
export async function redeliver(ctx: Ctx, p: Principal, deliveryId: string) {
  return ctx.db.tx(async (db) => {
    const d = await db.one(`select d.*, w.brand_id, w.active from webhook_delivery d join webhook w on w.id = d.webhook_id where d.id = $1 for update of d`, [deliveryId]);
    if (!d) throw notFound('Delivery');
    await authorize(db, p, d.brand_id, 'brand.manage');
    if (d.status === 'pending') throw conflict('already_pending', 'This delivery is already waiting to be sent');
    if (!d.active) throw conflict('webhook_disabled', 'This webhook is disabled: enable it first');
    const now = ctx.now();
    await db.query(
      `update webhook_delivery set status = 'pending', attempts = 0, next_attempt_at = $2, expires_at = $3, lease_until = null, last_error = null, delivered_at = null where id = $1`,
      [deliveryId, now, addSeconds(now, DELIVERY_WINDOW_HOURS * 3600)],
    );
    await audit(db, p, d.brand_id, 'webhook.redelivered', 'webhook_delivery', deliveryId, { status: d.status }, { status: 'pending' });
    return { id: deliveryId, status: 'pending' };
  });
}

/** What the worker should look at now. */
export async function dueDeliveries(ctx: Ctx, limit = 100): Promise<string[]> {
  const now = ctx.now();
  const rows = await ctx.db.query<{ id: string }>(
    `select id from webhook_delivery where status = 'pending' and next_attempt_at <= $1 and (lease_until is null or lease_until < $1)
     order by next_attempt_at limit $2`,
    [now, limit],
  );
  return rows.map((r) => r.id);
}

export type DeliveryOutcome = 'delivered' | 'retry' | 'failed' | 'skipped';

/**
 * Makes one attempt to deliver one event. Everything about the delivery lives in its row, so this is safe to call at any
 * time and more than once: it takes a short lease, and does nothing if the delivery is not due.
 */
export async function deliver(ctx: Ctx, deliveryId: string): Promise<DeliveryOutcome> {
  const now = ctx.now();
  const claimed = await ctx.db.one(
    `update webhook_delivery set lease_until = $2
     where id = $1 and status = 'pending' and next_attempt_at <= $3 and (lease_until is null or lease_until < $3) returning id`,
    [deliveryId, addSeconds(now, LEASE_SECONDS), now],
  );
  if (!claimed) return 'skipped';
  try {
    const d = await ctx.db.one(
      `select d.*, w.url, w.active, w.secret_encrypted, w.brand_id, e.type, e.data, e.created_at as event_created_at, b.name as brand_name
       from webhook_delivery d join webhook w on w.id = d.webhook_id join event e on e.id = d.event_id join brand b on b.id = w.brand_id
       where d.id = $1`,
      [deliveryId],
    );
    if (!d) return 'skipped';
    if (!d.active) return finish(ctx, d, { ok: false, final: true, error: 'The webhook is disabled' });
    if (!ctx.vault) return finish(ctx, d, { ok: false, final: true, error: 'The server has no TOKEN_KEY, so the secret cannot be opened' });

    const secret = ctx.vault.open<{ secret: string }>(d.secret_encrypted, `webhook:${d.webhook_id}`).secret;
    const body = JSON.stringify({
      id: d.event_id, type: d.type, created_at: new Date(d.event_created_at).toISOString(),
      brand: { id: d.brand_id, name: d.brand_name }, data: await materialize(ctx, d.data),
    });
    // Signed again on every attempt, so a receiver that rejects old timestamps (it should) accepts a late retry.
    const timestamp = Math.floor(now.getTime() / 1000);
    const headers = {
      'content-type': 'application/json',
      'user-agent': 'Studio-Webhooks/1',
      'x-studio-event': d.type,
      'x-studio-event-id': d.event_id,
      'x-studio-delivery': d.id,
      'x-studio-timestamp': String(timestamp),
      'x-studio-signature': `v1=${signBody(secret, timestamp, body)}`,
    };

    const started = Date.now();
    let status: number | null = null;
    let text = '';
    let retryAfter: number | null = null;
    let error: string | null = null;
    let policy = false;
    try {
      const url = new URL(d.url);
      const res = await post(url, headers, body, policyOf(ctx));
      status = res.status;
      text = res.text;
      const ra = Number(res.headers['retry-after']);
      if (Number.isFinite(ra) && ra > 0) retryAfter = Math.min(ra, MAX_RETRY_AFTER_SECONDS);
    } catch (err) {
      error = (err as Error).message || String(err);
      policy = err instanceof PolicyError;
    }
    const ms = Date.now() - started;
    const ok = status !== null && status >= 200 && status < 300;
    const why = ok ? null : error ?? (status !== null && status >= 300 && status < 400 ? `The receiver answered ${status}: redirects are not followed` : `The receiver answered ${status}${text ? `: ${text.replace(/\s+/g, ' ').slice(0, 200)}` : ''}`);
    await ctx.db.query('insert into webhook_attempt (delivery_id, at, http_status, error, duration_ms) values ($1,$2,$3,$4,$5)', [deliveryId, now, status, why, ms]);
    return finish(ctx, d, { ok, status, error: why, final: policy || status === 410, disable: status === 410, retryAfter });
  } finally {
    await ctx.db.query('update webhook_delivery set lease_until = null where id = $1', [deliveryId]);
  }
}

async function finish(
  ctx: Ctx,
  d: Record<string, any>,
  r: { ok: boolean; status?: number | null; error?: string | null; final?: boolean; disable?: boolean; retryAfter?: number | null },
): Promise<DeliveryOutcome> {
  const now = ctx.now();
  if (r.ok) {
    await ctx.db.query(
      `update webhook_delivery set status = 'delivered', attempts = attempts + 1, delivered_at = $2, last_status = $3, last_error = null, next_attempt_at = null where id = $1`,
      [d.id, now, r.status ?? null],
    );
    await ctx.db.query('update webhook set last_success_at = $2 where id = $1', [d.webhook_id, now]);
    return 'delivered';
  }
  const attempts = d.attempts + 1;
  const wait = Math.max(BACKOFF_SECONDS[attempts - 1] ?? Infinity, r.retryAfter ?? 0);
  const next = addSeconds(now, wait);
  const giveUp = r.final || !Number.isFinite(wait) || next > new Date(d.expires_at);
  if (!giveUp) {
    await ctx.db.query(
      `update webhook_delivery set attempts = $2, next_attempt_at = $3, last_status = $4, last_error = $5 where id = $1`,
      [d.id, attempts, next, r.status ?? null, r.error ?? null],
    );
    return 'retry';
  }
  const reason = r.final ? r.error : `${r.error ?? 'Not delivered'} (gave up after ${attempts} attempt${attempts === 1 ? '' : 's'})`;
  await ctx.db.tx(async (db) => {
    await db.query(
      `update webhook_delivery set status = 'failed', attempts = $2, next_attempt_at = null, last_status = $3, last_error = $4 where id = $1`,
      [d.id, attempts, r.status ?? null, reason],
    );
    if (r.disable) {
      await db.query(`update webhook set active = false, disabled_reason = 'The receiver answered 410 Gone' where id = $1`, [d.webhook_id]);
      await audit(db, null, d.brand_id, 'webhook.disabled', 'webhook', d.webhook_id, { active: true }, { active: false, reason: '410 Gone' });
    }
    // One warning per webhook per day, not one per lost event.
    const first = await db.one(
      `update webhook set last_failure_at = $2, failing_notified_at = $2
       where id = $1 and (failing_notified_at is null or failing_notified_at < $2::timestamptz - interval '24 hours') returning id, url`,
      [d.webhook_id, now],
    );
    if (first) await notifyRoles(db, d.brand_id, ['admin'], 'webhook.failing', { webhookId: d.webhook_id, url: first.url, error: reason }, null);
    else await db.query('update webhook set last_failure_at = $2 where id = $1', [d.webhook_id, now]);
  });
  return 'failed';
}

/** Old events and their deliveries are dropped after 30 days. */
export async function purgeOldEvents(ctx: Ctx): Promise<void> {
  const cutoff = new Date(ctx.now().getTime() - 30 * 86_400_000);
  await ctx.db.query(`delete from webhook_delivery where status <> 'pending' and created_at < $1`, [cutoff]);
  await ctx.db.query(
    `delete from event e where e.created_at < $1 and not exists (select 1 from webhook_delivery d where d.event_id = e.id)`,
    [cutoff],
  );
}
