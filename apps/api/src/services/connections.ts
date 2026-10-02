import { randomBytes, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { authorize, type Principal } from '../auth/principal.js';
import { allCapabilities } from '../connectors/registry.js';
import { ConnectorError, type Candidate, type ProviderId } from '../connectors/types.js';
import type { Ctx } from '../context.js';
import { sha256Hex } from '../crypto.js';
import { AppError, badRequest, conflict, forbidden, notFound } from '../errors.js';
import { audit } from './audit.js';

const STATE_TTL_MINUTES = 15;
export const PROVIDER_INFO: Record<ProviderId, { label: string; networks: string[] }> = {
  meta: { label: 'Facebook and Instagram', networks: ['facebook', 'instagram'] },
  google: { label: 'YouTube', networks: ['youtube'] },
  threads: { label: 'Threads', networks: ['threads'] },
  tiktok: { label: 'TikTok', networks: ['tiktok'] },
  linkedin: { label: 'LinkedIn', networks: ['linkedin'] },
  x: { label: 'X', networks: ['x'] },
  pinterest: { label: 'Pinterest', networks: ['pinterest'] },
  bluesky: { label: 'Bluesky', networks: ['bluesky'] },
};
const PROVIDERS = Object.keys(PROVIDER_INFO) as ProviderId[];

export const redirectUri = (ctx: Ctx) => `${ctx.config.APP_URL}/api/oauth/callback`;

/** What the app can connect to here, and what each network accepts: the editor and the connect buttons read this. */
export async function integrations(ctx: Ctx, p: Principal, brandId: string) {
  await authorize(ctx.db, p, brandId, 'brand.view');
  return {
    providers: PROVIDERS.map((id) => {
      const provider = ctx.connectors.provider(id);
      // A provider that signs in by credentials shows a form instead of sending the person to the network.
      return { id, ...PROVIDER_INFO[id], configured: provider !== null, signIn: provider?.credentials ? 'credentials' : 'redirect', fields: provider?.credentials?.fields ?? [] };
    }),
    capabilities: allCapabilities(ctx.config),
  };
}

/** Starts a connection: remembers who is connecting what, and returns the address to send their browser to. */
export async function startConnection(ctx: Ctx, p: Principal, brandId: string, providerId: ProviderId, reconnectAccountId?: string) {
  const provider = ctx.connectors.provider(providerId);
  if (!provider || !ctx.vault) {
    throw new AppError(503, 'provider_not_configured', `${PROVIDER_INFO[providerId].label} is not set up on this server (see docs/phase-2.md and docs/phase-4.md)`);
  }
  if (!provider.authorizeUrl) throw badRequest('credentials_required', `${PROVIDER_INFO[providerId].label} is connected with an app password, not through a sign-in page`);
  if (p.kind !== 'user') throw forbidden('Only people can connect accounts');
  const state = randomBytes(24).toString('base64url');
  await ctx.db.tx(async (db) => {
    await authorize(db, p, brandId, 'brand.manage');
    if (reconnectAccountId) {
      const acc = await db.one('select network from social_account where id = $1 and brand_id = $2', [reconnectAccountId, brandId]);
      if (!acc) throw notFound('Account');
      if (!provider.networks.includes(acc.network)) throw badRequest('wrong_provider', 'That account is on a different network');
    }
    await db.query(
      `insert into oauth_pending (brand_id, user_id, provider, state_hash, reconnect_of, expires_at)
       values ($1,$2,$3,$4,$5, $6)`,
      [brandId, p.userId, providerId, sha256Hex(state), reconnectAccountId ?? null, new Date(ctx.now().getTime() + STATE_TTL_MINUTES * 60_000)],
    );
  });
  // Only what the brand uses is asked for: the permission to send private messages is asked only if prizes are on.
  const brand = await ctx.db.one('select prizes from brand where id = $1', [brandId]);
  return { url: provider.authorizeUrl(state, redirectUri(ctx), { prizes: brand?.prizes?.enabled === true }) };
}

/** Keys of provider data that are safe to show the person choosing; nothing that could be a secret. */
const SAFE_DATA = ['missingScopes', 'username', 'audited', 'pageId', 'channelId', 'boardId', 'organizationId', 'handle'];
const safe = (d: Record<string, unknown>) => Object.fromEntries(Object.entries(d).filter(([k]) => SAFE_DATA.includes(k)));

/**
 * The network sent the browser back. Swap the code for credentials and list what was found. The credentials wait here,
 * sealed, until the person chooses; the browser is only ever given the id of this attempt.
 */
export async function finishOAuth(
  ctx: Ctx,
  userId: string,
  q: { code?: string; state?: string; error?: string; error_description?: string },
): Promise<{ brandId: string; pendingId?: string; error?: string }> {
  if (!q.state) throw badRequest('invalid_state', 'The sign-in came back without its state');
  const pending = await ctx.db.one('select * from oauth_pending where state_hash = $1', [sha256Hex(q.state)]);
  if (!pending || pending.completed_at || new Date(pending.expires_at) < ctx.now()) {
    throw badRequest('invalid_state', 'This connection attempt expired or was already used. Start it again from Settings.');
  }
  if (pending.user_id !== userId) throw forbidden('This connection was started by someone else');
  const done = () => ctx.db.query('update oauth_pending set completed_at = now() where id = $1', [pending.id]);

  if (q.error || !q.code) {
    await done();
    return { brandId: pending.brand_id, error: q.error_description || q.error || 'The sign-in was cancelled' };
  }
  const provider = ctx.connectors.provider(pending.provider);
  if (!provider?.exchange || !ctx.vault) {
    await done();
    return { brandId: pending.brand_id, error: 'This network is not set up on the server' };
  }
  let candidates: Candidate[];
  try {
    candidates = await provider.exchange(q.code, redirectUri(ctx), q.state);
  } catch (err) {
    await done();
    if (err instanceof ConnectorError) return { brandId: pending.brand_id, error: err.message };
    ctx.log.error({ err: String(err) }, 'OAuth exchange failed');
    return { brandId: pending.brand_id, error: 'Could not complete the sign-in with the network' };
  }
  await ctx.db.query('update oauth_pending set candidates = $2, secrets_encrypted = $3 where id = $1', [
    pending.id,
    JSON.stringify(candidates.map((c) => ({ key: c.key, network: c.network, externalId: c.externalId, displayName: c.displayName, providerData: safe(c.providerData) }))),
    ctx.vault.seal(candidates, `pending:${pending.id}`),
  ]);
  return { brandId: pending.brand_id, pendingId: pending.id };
}

const credentialsInput = z.object({
  values: z.record(z.string(), z.string().max(500)),
  reconnectAccountId: z.string().uuid().optional(),
});

/**
 * Sign-in by credentials the person types, for a network with no sign-in page (Bluesky). It ends where the other flow does:
 * a pending attempt holding the accounts that were found, sealed, for the person to choose from.
 */
export async function connectWithCredentials(ctx: Ctx, p: Principal, brandId: string, providerId: ProviderId, raw: unknown) {
  const input = credentialsInput.parse(raw);
  const provider = ctx.connectors.provider(providerId);
  if (!provider || !ctx.vault) {
    throw new AppError(503, 'provider_not_configured', `${PROVIDER_INFO[providerId].label} is not set up on this server (see docs/phase-4.md)`);
  }
  if (!provider.credentials) throw badRequest('redirect_required', `${PROVIDER_INFO[providerId].label} is connected through a sign-in page`);
  if (p.kind !== 'user') throw forbidden('Only people can connect accounts');
  for (const f of provider.credentials.fields) {
    if (f.required !== false && !input.values[f.key]?.trim()) throw badRequest('missing_field', `${f.label} is needed`);
  }
  await authorize(ctx.db, p, brandId, 'brand.manage');
  if (input.reconnectAccountId) {
    const acc = await ctx.db.one('select network from social_account where id = $1 and brand_id = $2', [input.reconnectAccountId, brandId]);
    if (!acc) throw notFound('Account');
    if (!provider.networks.includes(acc.network)) throw badRequest('wrong_provider', 'That account is on a different network');
  }
  let candidates: Candidate[];
  try {
    candidates = await provider.credentials.connect(Object.fromEntries(Object.entries(input.values).map(([k, v]) => [k, v.trim()])));
  } catch (err) {
    if (err instanceof ConnectorError) throw badRequest('sign_in_failed', err.message);
    throw err;
  }
  const id = randomUUID();
  await ctx.db.query(
    `insert into oauth_pending (id, brand_id, user_id, provider, state_hash, reconnect_of, candidates, secrets_encrypted, expires_at)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [
      id, brandId, p.userId, providerId, sha256Hex(randomBytes(24).toString('base64url')), input.reconnectAccountId ?? null,
      JSON.stringify(candidates.map((c) => ({ key: c.key, network: c.network, externalId: c.externalId, displayName: c.displayName, providerData: safe(c.providerData) }))),
      ctx.vault.seal(candidates, `pending:${id}`), new Date(ctx.now().getTime() + STATE_TTL_MINUTES * 60_000),
    ],
  );
  return { pendingId: id };
}

export async function getPending(ctx: Ctx, p: Principal, brandId: string, pendingId: string) {
  await authorize(ctx.db, p, brandId, 'brand.manage');
  const row = await ctx.db.one('select * from oauth_pending where id = $1 and brand_id = $2', [pendingId, brandId]);
  if (!row || row.completed_at || new Date(row.expires_at) < ctx.now() || !row.secrets_encrypted) throw notFound('Connection attempt');
  if (p.kind === 'user' && row.user_id !== p.userId) throw notFound('Connection attempt');
  const existing = await ctx.db.query('select id, network, external_id, status from social_account where brand_id = $1', [brandId]);
  const candidates = (row.candidates as { key: string; network: string; externalId: string }[]).map((c) => {
    const have = existing.find((a) => a.network === c.network && a.external_id === c.externalId);
    return { ...c, existing: have ? { id: have.id, status: have.status } : null };
  });
  const target = row.reconnect_of
    ? await ctx.db.one('select id, network, display_name, status from social_account where id = $1', [row.reconnect_of])
    : null;
  return { id: row.id, provider: row.provider, candidates, reconnect: target };
}

export const selectInput = z.object({ keys: z.array(z.string()).min(1).max(50) });

/** The person chose which of the discovered accounts to connect. Their credentials move from the pending row onto the accounts. */
export async function selectCandidates(ctx: Ctx, p: Principal, brandId: string, pendingId: string, raw: unknown) {
  const input = selectInput.parse(raw);
  if (p.kind !== 'user') throw forbidden();
  return ctx.db.tx(async (db) => {
    await authorize(db, p, brandId, 'brand.manage');
    const row = await db.one('select * from oauth_pending where id = $1 and brand_id = $2 for update', [pendingId, brandId]);
    if (!row || row.completed_at || new Date(row.expires_at) < ctx.now() || !row.secrets_encrypted) throw notFound('Connection attempt');
    if (row.user_id !== p.userId) throw notFound('Connection attempt');
    const all = ctx.vault!.open<Candidate[]>(row.secrets_encrypted, `pending:${pendingId}`);
    const chosen = input.keys.map((k) => all.find((c) => c.key === k));
    if (chosen.some((c) => !c)) throw badRequest('unknown_candidate', 'One of the chosen accounts was not part of this sign-in');

    const target = row.reconnect_of ? await db.one('select * from social_account where id = $1 for update', [row.reconnect_of]) : null;
    if (target && (chosen.length !== 1 || chosen[0]!.network !== target.network)) {
      throw badRequest('wrong_account', `Choose exactly one ${target.network} account to reconnect ${target.display_name}`);
    }
    // A connected account must come back as the same account; a manual one (phase 1) simply adopts its real identity.
    if (target && target.status !== 'manual' && target.external_id !== chosen[0]!.externalId) {
      throw badRequest('wrong_account', `You signed in with ${chosen[0]!.displayName}, not ${target.display_name}. Sign in with the right account.`);
    }

    const out = [];
    for (const c of chosen as Candidate[]) {
      const existing =
        target ??
        (await db.one('select * from social_account where brand_id = $1 and network = $2 and external_id = $3 for update', [brandId, c.network, c.externalId]));
      const id = existing?.id ?? randomUUID();
      const sealed = ctx.vault!.seal(c.token, `account:${id}`);
      if (existing) {
        await db.query(
          `update social_account set external_id = $2, display_name = $3, token_encrypted = $4, token_expires_at = $5, granted_permissions = $6,
             provider_data = $7, status = 'active', last_error = null, last_health_at = null, connected_by = $8, connected_at = $9 where id = $1`,
          [id, c.externalId, c.displayName, sealed, c.token.expiresAt ?? null, JSON.stringify(c.token.scopes ?? []), JSON.stringify(c.providerData), p.userId, ctx.now()],
        );
      } else {
        await db.query(
          `insert into social_account (id, brand_id, network, external_id, display_name, token_encrypted, token_expires_at, granted_permissions, provider_data, status, connected_by, connected_at)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9,'active',$10,$11)`,
          [id, brandId, c.network, c.externalId, c.displayName, sealed, c.token.expiresAt ?? null, JSON.stringify(c.token.scopes ?? []), JSON.stringify(c.providerData), p.userId, ctx.now()],
        );
      }
      // Whatever was waiting for this account to be reconnected need not sit out its retry timer: the worker looks at it now.
      if (existing) {
        await db.query(
          `update publication set next_run_at = $2::timestamptz
           where social_account_id = $1 and manual = false and last_error_class = 'auth' and status in ('scheduled','preparing','ready','publishing')`,
          [id, ctx.now()],
        );
      }
      await audit(db, p, brandId, existing ? 'account.reconnected' : 'account.connected', 'social_account', id, existing ? { status: existing.status } : null,
        { network: c.network, name: c.displayName, scopes: c.token.scopes ?? [] });
      out.push({ id, network: c.network, display_name: c.displayName });
    }
    await db.query('update oauth_pending set completed_at = now(), secrets_encrypted = null where id = $1', [pendingId]);
    return out;
  });
}

/** Disconnecting would strand anything still waiting to go out through it, so that has to be dealt with first. */
export async function disconnectAccount(ctx: Ctx, p: Principal, brandId: string, accountId: string) {
  return ctx.db.tx(async (db) => {
    await authorize(db, p, brandId, 'brand.manage');
    const acc = await db.one('select * from social_account where id = $1 and brand_id = $2 for update', [accountId, brandId]);
    if (!acc) throw notFound('Account');
    const pending = await db.one(
      `select count(*)::int as n from publication where social_account_id = $1 and manual = false
         and status in ('scheduled','awaiting_reapproval','on_hold','preparing','ready','publishing')`,
      [accountId],
    );
    if ((pending?.n ?? 0) > 0) {
      throw conflict('account_in_use', `${pending!.n} publication(s) are still waiting to go out through this account: cancel them first`, { count: pending!.n });
    }
    await db.query(`update social_account set token_encrypted = null, token_expires_at = null, status = 'manual', last_error = null where id = $1`, [accountId]);
    await audit(db, p, brandId, 'account.disconnected', 'social_account', accountId, { status: acc.status }, { status: 'manual' });
    return { id: accountId };
  });
}

export const accountSettings = z.object({
  /** Whether the network has approved the app (Google's audit for YouTube, TikTok's audit, Pinterest's Standard access), so posts can be public. Set by an admin once it has. */
  audited: z.boolean().optional(),
});

export async function updateAccountSettings(ctx: Ctx, p: Principal, brandId: string, accountId: string, raw: unknown) {
  const input = accountSettings.parse(raw);
  return ctx.db.tx(async (db) => {
    await authorize(db, p, brandId, 'brand.manage');
    const acc = await db.one('select * from social_account where id = $1 and brand_id = $2 for update', [accountId, brandId]);
    if (!acc) throw notFound('Account');
    if (input.audited !== undefined) {
      if (!['youtube', 'tiktok', 'pinterest'].includes(acc.network)) throw badRequest('not_applicable', 'Only YouTube, TikTok and Pinterest accounts have an approval status');
      await db.query(`update social_account set provider_data = provider_data || jsonb_build_object('audited', $2::boolean) where id = $1`, [accountId, input.audited]);
      await audit(db, p, brandId, 'account.audit_status', 'social_account', accountId, { audited: acc.provider_data?.audited ?? false }, { audited: input.audited });
    }
    return { id: accountId };
  });
}
