import { z } from 'zod';
import { authorize, type Principal } from '../auth/principal.js';
import type { Ctx } from '../context.js';
import { badRequest, conflict } from '../errors.js';
import { checkUrl, post, type NetPolicy } from '../net.js';
import { audit } from './audit.js';
import { localeOf, msg, requestLocale, t, type Locale, type Localized } from '../i18n/index.js';
import { KIND_LIST, KINDS, describeNotification, kindLabel, notifyRoles, type NotifyKind } from './notify.js';

/**
 * Slack. A brand gives the address of a Slack *incoming webhook* (a channel's private URL, made in Slack), and chosen kinds of
 * notification are posted there, once for the team and not once per person. The address is a secret, so it is sealed and the
 * screen only ever shows its end. Only Slack's own host is accepted: this is not a way to make the server post to anywhere.
 */
const BACKOFF_SECONDS = [60, 300, 900, 3600, 6 * 3600];
const policyOf = (ctx: Ctx): NetPolicy => ({ allowPrivate: ctx.config.webhookAllowPrivate, httpsForPublic: ctx.config.isProd });

/** Whether an address is one Slack makes: its host, and the path it uses for incoming webhooks and workflow triggers. */
export function slackAddressError(ctx: Ctx, raw: string): string | Localized | null {
  const checked = checkUrl(raw, policyOf(ctx));
  if ('error' in checked) return checked.error;
  const u = checked.url;
  if (u.host.toLowerCase() !== ctx.config.SLACK_HOOK_HOST.toLowerCase()) return msg('error.slack.notSlack', { host: ctx.config.SLACK_HOOK_HOST });
  if (ctx.config.isProd && u.protocol !== 'https:') return msg('error.slack.https');
  if (!/^\/(services|triggers|workflows)\/[A-Za-z0-9_/-]+$/.test(u.pathname)) return msg('error.slack.notIncoming');
  return null;
}

/** Slack reads &, < and > in text as its own markup. */
const escapeSlack = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export interface SlackMessage { text: string }

/** One notification as the brand's channel reads it, in the brand's language: the subject, why (when there is a why), and a link. */
export function slackMessage(locale: Locale, appUrl: string, kind: string, payload: Record<string, any>, brand: string, pieceTitle: string | null): SlackMessage {
  const d = describeNotification(locale, appUrl, kind, payload, brand, pieceTitle);
  const link = `<${d.url}|${escapeSlack(pieceTitle ?? t(locale, 'notify.open'))}>`;
  // The piece's title is already the link: the other lines of the body (the account, the reason, the post) go above it.
  const detail = d.body.split('\n').filter((l) => l && !(pieceTitle && l === t(locale, 'notify.piece', { title: pieceTitle })));
  return { text: [`*${escapeSlack(brand)}* · ${escapeSlack(d.subject)}`, ...detail.map(escapeSlack), link].join('\n') };
}

type Outcome = { ok: true } | { ok: false; gone: boolean; retryAfterSec?: number; message: string };

async function postTo(ctx: Ctx, url: string, message: SlackMessage): Promise<Outcome> {
  const checked = checkUrl(url, policyOf(ctx));
  if ('error' in checked) return { ok: false, gone: true, message: checked.error };
  let r;
  try {
    r = await post(checked.url, { 'content-type': 'application/json' }, JSON.stringify(message), policyOf(ctx), 15_000);
  } catch (err) {
    return { ok: false, gone: false, message: (err as Error).message };
  }
  if (r.status >= 200 && r.status < 300) return { ok: true };
  // Slack words these as plain text: no_service (the address was removed), invalid_token, channel_is_archived, channel_not_found, action_prohibited.
  if ([403, 404, 410].includes(r.status)) return { ok: false, gone: true, message: `Slack answered ${r.status}${r.text ? `: ${r.text.trim().slice(0, 100)}` : ''}` };
  const retry = Number(r.headers['retry-after']);
  return { ok: false, gone: false, ...(retry > 0 ? { retryAfterSec: retry } : {}), message: `Slack answered ${r.status}${r.text ? `: ${r.text.trim().slice(0, 100)}` : ''}` };
}

// ───────────────────────────── setting it up ─────────────────────────────

const kindList = z.array(z.enum(KIND_LIST as [NotifyKind, ...NotifyKind[]])).min(1, 'Choose at least one kind of message').max(KIND_LIST.length);
export const slackInput = z.object({ url: z.string().trim().max(500).optional(), kinds: kindList });

const sealer = (ctx: Ctx) => {
  if (!ctx.vault) throw conflict('no_token_key', msg('error.slack.tokenKey'));
  return ctx.vault;
};
const aad = (brandId: string) => `slack:${brandId}`;
const hintOf = (url: string) => `…${url.slice(-4)}`;

export async function getSlack(ctx: Ctx, p: Principal, brandId: string) {
  await authorize(ctx.db, p, brandId, 'brand.manage');
  const h = await ctx.db.one('select hint, kinds, created_at, last_ok_at, last_error, last_error_at, disabled_reason from slack_hook where brand_id = $1', [brandId]);
  return {
    available: !!ctx.vault,
    allKinds: KIND_LIST.map((kind) => ({ kind, label: kindLabel(requestLocale(), kind), default: KINDS[kind].slack })),
    configured: !!h,
    hint: h?.hint ?? null,
    kinds: (h?.kinds as string[] | undefined) ?? KIND_LIST.filter((k) => KINDS[k].slack),
    lastOkAt: h?.last_ok_at ?? null,
    lastError: h?.last_error ?? null,
    disabledReason: h?.disabled_reason ?? null,
  };
}

/** Sets the address and the kinds, or only the kinds when no address is given. A new address replaces the old and wakes a disabled one. */
export async function setSlack(ctx: Ctx, p: Principal, brandId: string, raw: unknown) {
  const input = slackInput.parse(raw);
  const userId = p.kind === 'user' ? p.userId : null;
  await authorize(ctx.db, p, brandId, 'brand.manage');
  const vault = sealer(ctx);
  const existing = await ctx.db.one('select 1 from slack_hook where brand_id = $1', [brandId]);
  if (input.url) {
    const why = slackAddressError(ctx, input.url);
    if (why) throw badRequest('invalid_slack_address', why);
    await ctx.db.query(
      `insert into slack_hook (brand_id, url_sealed, hint, kinds, created_by) values ($1,$2,$3,$4,$5)
       on conflict (brand_id) do update set url_sealed = excluded.url_sealed, hint = excluded.hint, kinds = excluded.kinds, created_by = excluded.created_by,
         created_at = now(), last_error = null, last_error_at = null, disabled_reason = null`,
      [brandId, vault.seal(input.url, aad(brandId)), hintOf(input.url), input.kinds, userId],
    );
    await audit(ctx.db, p, brandId, existing ? 'slack.address_changed' : 'slack.configured', 'brand', brandId, null, { kinds: input.kinds.length });
  } else {
    if (!existing) throw badRequest('missing_address', msg('error.slack.pasteAddress'));
    await ctx.db.query('update slack_hook set kinds = $2 where brand_id = $1', [brandId, input.kinds]);
    await audit(ctx.db, p, brandId, 'slack.kinds_changed', 'brand', brandId, null, { kinds: input.kinds.length });
  }
  return getSlack(ctx, p, brandId);
}

export async function removeSlack(ctx: Ctx, p: Principal, brandId: string) {
  await authorize(ctx.db, p, brandId, 'brand.manage');
  const gone = await ctx.db.one('delete from slack_hook where brand_id = $1 returning brand_id', [brandId]);
  if (gone) await audit(ctx.db, p, brandId, 'slack.removed', 'brand', brandId);
  return { ok: true };
}

/** A message to the channel now, so the address can be checked when it is pasted. */
export async function testSlack(ctx: Ctx, p: Principal, brandId: string) {
  await authorize(ctx.db, p, brandId, 'brand.manage');
  const h = await ctx.db.one<{ url_sealed: Buffer }>('select url_sealed from slack_hook where brand_id = $1', [brandId]);
  if (!h) throw badRequest('missing_address', msg('error.slack.pasteAddressFirst'));
  const brand = (await ctx.db.one<{ name: string; locale: string }>('select name, locale from brand where id = $1', [brandId]))!;
  const url = sealer(ctx).open<string>(h.url_sealed, aad(brandId));
  // In the brand's language, like everything posted to its channel.
  const r = await postTo(ctx, url, { text: `*${escapeSlack(brand.name)}* · ${escapeSlack(t(localeOf(brand.locale), 'notify.slackTest'))}` });
  if (r.ok) {
    await ctx.db.query('update slack_hook set last_ok_at = $2, last_error = null, last_error_at = null, disabled_reason = null where brand_id = $1', [brandId, ctx.now()]);
    return { ok: true as const };
  }
  await ctx.db.query('update slack_hook set last_error = $2, last_error_at = $3 where brand_id = $1', [brandId, r.message.slice(0, 300), ctx.now()]);
  return { ok: false as const, message: r.message };
}

// ───────────────────────────── posting ─────────────────────────────

/**
 * Posts the notifications nobody has posted yet. Each event is posted once for the brand (it was written once per person who should see
 * it), to the brands that have an address and chose that kind; the rest are marked done. A post Slack could not take is tried again
 * with growing waits; one it says is gone for good stops the brand's posting and tells its admins.
 */
export async function sendPendingSlack(ctx: Ctx, limit = 200): Promise<number> {
  if (!ctx.vault) return 0;
  await ctx.db.query(
    `update notification n set slack_at = now() where n.slack_at is null and not exists
       (select 1 from slack_hook h where h.brand_id = n.brand_id and h.disabled_reason is null and n.kind = any(h.kinds))`,
  );
  return ctx.db.tx(async (db) => {
    const rows = await db.query(
      `select n.id, n.brand_id, n.kind, n.payload, n.slack_tries, b.name as brand, b.locale as brand_locale, p.title as piece_title
       from notification n join brand b on b.id = n.brand_id
       left join piece p on p.id = nullif(n.payload->>'pieceId', '')::uuid
       where n.slack_at is null and (n.slack_next_at is null or n.slack_next_at <= $2)
       order by n.created_at limit $1 for update of n skip locked`,
      [limit, ctx.now()],
    );
    const groups = new Map<string, typeof rows>();
    for (const r of rows) {
      const key = `${r.brand_id}|${r.kind}|${JSON.stringify(r.payload)}`;
      groups.set(key, [...(groups.get(key) ?? []), r]);
    }
    let posted = 0;
    for (const group of groups.values()) {
      const first = group[0]!;
      const ids = group.map((r) => r.id);
      const hook = await db.one<{ url_sealed: Buffer }>('select url_sealed from slack_hook where brand_id = $1 and disabled_reason is null', [first.brand_id]);
      if (!hook) {
        await db.query('update notification set slack_at = $2 where id = any($1)', [ids, ctx.now()]);
        continue;
      }
      const msg = slackMessage(localeOf(first.brand_locale), ctx.config.APP_URL, first.kind, first.payload, first.brand, first.piece_title);
      const r = await postTo(ctx, ctx.vault!.open<string>(hook.url_sealed, aad(first.brand_id)), msg);
      if (r.ok) {
        posted++;
        await db.query('update notification set slack_at = $2 where id = any($1)', [ids, ctx.now()]);
        await db.query('update slack_hook set last_ok_at = $2, last_error = null, last_error_at = null where brand_id = $1', [first.brand_id, ctx.now()]);
        continue;
      }
      await db.query('update slack_hook set last_error = $2, last_error_at = $3 where brand_id = $1', [first.brand_id, r.message.slice(0, 300), ctx.now()]);
      if (r.gone) {
        // Slack will not take anything more at this address: stop, and say so once to the people who can fix it.
        const was = await db.one(`update slack_hook set disabled_reason = $2 where brand_id = $1 and disabled_reason is null returning brand_id`, [first.brand_id, r.message.slice(0, 300)]);
        await db.query('update notification set slack_at = $2 where id = any($1)', [ids, ctx.now()]);
        if (was) await notifyRoles(db, first.brand_id, ['admin'], 'slack.failing', { message: r.message.slice(0, 200) }, null);
        continue;
      }
      const tries = first.slack_tries + 1;
      if (tries > BACKOFF_SECONDS.length) {
        await db.query('update notification set slack_at = $2, slack_tries = slack_tries + 1 where id = any($1)', [ids, ctx.now()]);
      } else {
        const wait = Math.max(BACKOFF_SECONDS[tries - 1]!, r.retryAfterSec ?? 0);
        await db.query('update notification set slack_tries = slack_tries + 1, slack_next_at = $2 where id = any($1)', [ids, new Date(ctx.now().getTime() + wait * 1000)]);
      }
    }
    return posted;
  });
}
