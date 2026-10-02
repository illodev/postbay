import type { Ctx } from '../context.js';
import { ConnectorError, type Account, type ConnectorEnv, type EventSubscription, type Handle, type Network, type TokenSet } from '../connectors/types.js';
import { english, msg, type Localized } from '../i18n/index.js';
import { audit } from './audit.js';
import { notifyRoles } from './notify.js';

/** The account as a connector sees it: no tokens, only what identifies it. */
export async function loadConnectorAccount(ctx: Ctx, accountId: string): Promise<Account | null> {
  const row = await ctx.db.one('select id, network, external_id, display_name, provider_data from social_account where id = $1', [accountId]);
  if (!row) return null;
  return { id: row.id, network: row.network as Network, externalId: row.external_id, displayName: row.display_name, providerData: row.provider_data ?? {} };
}

/**
 * The credentials for an account, refreshed first if they are about to run out. A refresh the network refuses means the
 * person has to connect again, which is recorded and told to the admins before the error goes on.
 */
export async function accountToken(ctx: Ctx, accountId: string): Promise<TokenSet> {
  if (!ctx.vault) throw new ConnectorError('unsupported', english(msg('connect.noTokenKey')), { text: msg('connect.noTokenKey') });
  const row = await ctx.db.one('select network, status, token_encrypted from social_account where id = $1', [accountId]);
  if (!row?.token_encrypted) throw new ConnectorError('auth', english(msg('connect.notConnected')), { text: msg('connect.notConnected') });
  if (row.status === 'reconnect_required') throw new ConnectorError('auth', english(msg('connect.mustReconnect')), { text: msg('connect.mustReconnect') });
  const token = ctx.vault.open<TokenSet>(row.token_encrypted, `account:${accountId}`);
  const provider = ctx.connectors.providerOf(row.network);
  const windowMs = (provider?.refreshWindowSec ?? 120) * 1000;
  const soon = token.expiresAt && new Date(token.expiresAt).getTime() - ctx.now().getTime() < windowMs;
  if (!soon) return token;
  if (!provider?.refresh) return token;

  try {
    return await ctx.db.tx(async (db) => {
      // Someone else may have refreshed it while we waited for the lock.
      const locked = (await db.one('select token_encrypted from social_account where id = $1 for update', [accountId]))!;
      const current = ctx.vault!.open<TokenSet>(locked.token_encrypted, `account:${accountId}`);
      if (current.expiresAt && new Date(current.expiresAt).getTime() - ctx.now().getTime() >= windowMs) return current;
      const fresh = await provider.refresh!(current);
      await db.query('update social_account set token_encrypted = $2, token_expires_at = $3 where id = $1', [
        accountId, ctx.vault!.seal(fresh, `account:${accountId}`), fresh.expiresAt ?? null,
      ]);
      return fresh;
    });
  } catch (err) {
    if (err instanceof ConnectorError && err.errorClass === 'auth') await markReconnectRequired(ctx, accountId, err.message, err.text);
    throw err;
  }
}

/**
 * The account's credentials stopped working: say so once, to the people who can fix it. `text` is the message kept as a code, when it
 * is the studio's own words (the notification then reads in each person's language); the account keeps the English.
 */
export async function markReconnectRequired(ctx: Ctx, accountId: string, message: string, text?: Localized | Localized[]): Promise<void> {
  await ctx.db.tx(async (db) => {
    const row = await db.one(
      `update social_account set status = 'reconnect_required', last_error = $2 where id = $1 and status = 'active' returning brand_id, display_name, network`,
      [accountId, message.slice(0, 500)],
    );
    if (!row) return;
    await audit(db, null, row.brand_id, 'account.reconnect_required', 'social_account', accountId, { status: 'active' }, { status: 'reconnect_required', reason: message.slice(0, 200) });
    await notifyRoles(db, row.brand_id, ['admin'], 'account.reconnect', {
      accountId, name: row.display_name, network: row.network, message: message.slice(0, 200), ...(text ? { message_i18n: text } : {}),
    }, null);
  });
}

/** What a connector is given to work with for one account. `persist` saves the handle somewhere the caller chooses. */
export function connectorEnv(ctx: Ctx, accountId: string, persist: (h: Handle) => Promise<void> = async () => {}): ConnectorEnv {
  return {
    token: () => accountToken(ctx, accountId),
    now: ctx.now,
    log: ctx.log,
    open: (key, start) => ctx.storage.open(key, start),
    persist,
  };
}

/**
 * Asks the network whether the connection still works, and when it will stop. Done daily: it catches a revoked grant
 * before a post is due, and keeps refresh tokens in use (Google drops one that sits unused for six months).
 */
export async function checkHealth(ctx: Ctx, accountId: string): Promise<{ valid: boolean } | null> {
  const account = await loadConnectorAccount(ctx, accountId);
  if (!account) return null;
  const connector = ctx.connectors.connector(account.network);
  if (!connector?.health) return null;
  try {
    const res = await connector.health(account, connectorEnv(ctx, accountId));
    await ctx.db.query('update social_account set last_health_at = $2, last_error = null where id = $1', [accountId, ctx.now()]);
    if (!res.valid) {
      if (res.note) await markReconnectRequired(ctx, accountId, res.note);
      else await markReconnectRequired(ctx, accountId, english(msg('connect.noLongerValid')), msg('connect.noLongerValid'));
      return { valid: false };
    }
    if (res.expiresAt) {
      const days = (new Date(res.expiresAt).getTime() - ctx.now().getTime()) / 86_400_000;
      if (days <= 7) await warnExpiring(ctx, accountId, res.expiresAt);
    }
    return { valid: true };
  } catch (err) {
    if (err instanceof ConnectorError && err.errorClass === 'auth') {
      await markReconnectRequired(ctx, accountId, err.message, err.text);
      return { valid: false };
    }
    ctx.log.warn({ err: String(err), accountId }, 'account health check failed');
    return null;
  }
}

/** One warning a day at most, so an account that is about to lapse does not fill the inbox. */
async function warnExpiring(ctx: Ctx, accountId: string, expiresAt: string) {
  await ctx.db.tx(async (db) => {
    const row = await db.one(
      `update social_account set provider_data = provider_data || jsonb_build_object('expiryNotifiedAt', $2::text)
       where id = $1 and coalesce((provider_data->>'expiryNotifiedAt')::timestamptz, 'epoch') < $3 returning brand_id, display_name, network`,
      [accountId, ctx.now().toISOString(), new Date(ctx.now().getTime() - 86_400_000)],
    );
    if (row) await notifyRoles(db, row.brand_id, ['admin'], 'account.expiring', { accountId, name: row.display_name, network: row.network, expiresAt }, null);
  });
}

/** Accounts whose daily check is due. */
export async function accountsDueForHealth(ctx: Ctx, limit = 20): Promise<string[]> {
  const rows = await ctx.db.query(
    `select id from social_account where status = 'active' and token_encrypted is not null
       and (last_health_at is null or last_health_at < $1) order by last_health_at nulls first limit $2`,
    [new Date(ctx.now().getTime() - 86_400_000), limit],
  );
  return rows.map((r) => r.id);
}

/**
 * Asks the network to push this account's events (comments) to the app's webhook, where it has to be asked (Meta), and keeps what
 * came of it on the account (provider_data.events) for the account check. Best effort: it never fails what called it, because
 * reading the comments every few minutes still works without it.
 */
export async function subscribeEvents(ctx: Ctx, accountId: string): Promise<EventSubscription | null> {
  const account = await loadConnectorAccount(ctx, accountId);
  const connector = account ? ctx.connectors.connector(account.network) : null;
  if (!account || !connector?.subscribeEvents) return null;
  let state: EventSubscription;
  try {
    state = await connector.subscribeEvents(account, connectorEnv(ctx, accountId));
  } catch (err) {
    ctx.log.warn({ err: String(err), accountId }, 'could not subscribe to the account\'s events');
    const noteText = msg('connect.events.refused', { error: err instanceof ConnectorError && err.text ? err.text : (err as Error).message });
    state = { subscribed: false, fields: [], note: english(noteText), noteText };
  }
  // The note in English, and kept as a code beside it (note_i18n), which the account list answers in the reader's language.
  const { noteText, ...kept } = state;
  await ctx.db.query(`update social_account set provider_data = provider_data || jsonb_build_object('events', $2::jsonb) where id = $1`, [
    accountId, JSON.stringify({ ...kept, ...(noteText ? { note_i18n: noteText } : {}), at: ctx.now().toISOString() }),
  ]);
  return state;
}

/**
 * When an account is disconnected, takes away the subscription to its events, keeping what another connected account on the same
 * Page still needs. `token` is the account's last token, read before it was forgotten. Best effort, like subscribing.
 */
export async function unsubscribeEvents(ctx: Ctx, account: Account, token: TokenSet): Promise<void> {
  const connector = ctx.connectors.connector(account.network);
  if (!connector?.unsubscribeEvents || account.providerData.events?.subscribed !== true) return;
  const page = String(account.network === 'facebook' ? account.externalId : (account.providerData.pageId ?? ''));
  try {
    const others = page
      ? await ctx.db.query(
        `select network from social_account where id <> $1 and status = 'active' and token_encrypted is not null
           and coalesce((provider_data->'events'->>'subscribed')::boolean, false) and (provider_data->>'pageId' = $2 or (network = 'facebook' and external_id = $2))`,
        [account.id, page],
      )
      : [];
    const keep = others.flatMap((o) => ctx.connectors.connector(o.network as Network)?.eventFields ?? []);
    const env: ConnectorEnv = { token: async () => token, now: ctx.now, log: ctx.log, open: (key, start) => ctx.storage.open(key, start), persist: async () => {} };
    await connector.unsubscribeEvents(account, env, keep);
  } catch (err) {
    ctx.log.warn({ err: String(err), accountId: account.id }, 'could not unsubscribe from the account\'s events');
  }
}
