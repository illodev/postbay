import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { authorize, type Principal } from '../auth/principal.js';
import { sleep } from '../connectors/http.js';
import { ANALYTICS_SCOPE, GOOGLE_SCOPES } from '../connectors/google/oauth.js';
import { LINKEDIN_SCOPES } from '../connectors/linkedin/oauth.js';
import { META_PRIZE_SCOPES, META_SCOPES } from '../connectors/meta/oauth.js';
import { PINTEREST_SCOPES } from '../connectors/pinterest/oauth.js';
import { THREADS_SCOPES } from '../connectors/threads/oauth.js';
import { TIKTOK_SCOPES } from '../connectors/tiktok/oauth.js';
import { X_SCOPES } from '../connectors/x/oauth.js';
import {
  ConnectorError,
  type Account, type Connector, type Handle, type MediaItem, type PublishInput, type TokenSet,
} from '../connectors/types.js';
import type { Ctx } from '../context.js';
import { notFound } from '../errors.js';
import { render, requestLocale, tr, type Locale } from '../i18n/index.js';
import { audit } from './audit.js';
import { connectorEnv, loadConnectorAccount } from './connectors.js';
import { prizesOf } from './prizes.js';

/**
 * Checks that say whether this server and each connected account are ready for real use, and what to do about what is not. Every
 * title, detail and hint is in the language of the request (the command line: the one its environment's LANG names).
 *
 * Everything in the tests and the browser runs was proven against stand-ins for the networks. This is how the first real run is
 * made short: it looks at the connection, asks each network a few harmless questions and says in plain words what failed and what
 * to try. The checks that only read run from the screen. The one that posts (`publishTest`) only runs from the command line, when
 * a person asks for it by name and confirms, because it leaves a real post on a real account.
 */
export type CheckStatus = 'pass' | 'warn' | 'fail' | 'skip';

export interface CheckResult {
  id: string;
  status: CheckStatus;
  title: string;
  detail: string;
  /** What to do about it, when it is not a pass. */
  hint?: string;
}

export interface AccountReport {
  account: { id: string; network: string; display_name: string };
  results: CheckResult[];
  /** True when nothing failed. Warnings do not make a report fail. */
  ok: boolean;
}

const result = (id: string, status: CheckStatus, title: string, detail: string, hint?: string): CheckResult => ({ id, status, title, detail, ...(hint ? { hint } : {}) });
const ok = (results: CheckResult[]) => !results.some((r) => r.status === 'fail');
const run = promisify(execFile);

// ───────────────────────────── the server ─────────────────────────────

const isPrivateHost = (host: string) =>
  host === 'localhost' || host.endsWith('.localhost') || /^127\./.test(host) || /^10\./.test(host) || /^192\.168\./.test(host) || /^172\.(1[6-9]|2\d|3[01])\./.test(host) || host === '[::1]' || host === '0.0.0.0';

async function tool(name: string): Promise<string | null> {
  try {
    const { stdout } = await run(name, ['-version'], { timeout: 10_000 });
    return stdout.split('\n')[0] ?? name;
  } catch {
    return null;
  }
}

/** Months between the API version a LinkedIn header names (YYYYMM) and now. LinkedIn retires a version after about a year. */
export function versionAgeMonths(version: string, now: Date): number {
  const y = Number(version.slice(0, 4));
  const m = Number(version.slice(4, 6));
  return (now.getUTCFullYear() - y) * 12 + (now.getUTCMonth() + 1 - m);
}

/** What about this deployment would stop a network from working, or is a good idea to fix first. */
export async function checkServer(ctx: Ctx): Promise<CheckResult[]> {
  const c = ctx.config;
  const out: CheckResult[] = [];

  out.push(ctx.vault
    ? result('token_key', 'pass', tr('check.tokenKey.title'), tr('check.tokenKey.pass'))
    : result('token_key', 'fail', tr('check.tokenKey.title'), tr('check.tokenKey.fail'), tr('check.tokenKey.failHint')));

  const app = new URL(c.APP_URL);
  const redirect = `${c.APP_URL.replace(/\/$/, '')}/api/oauth/callback`;
  if (isPrivateHost(app.hostname)) {
    out.push(result('app_url', c.NODE_ENV === 'production' ? 'fail' : 'warn', tr('check.appUrl.title'), tr('check.appUrl.private', { url: c.APP_URL }), tr('check.appUrl.privateHint')));
  } else if (app.protocol !== 'https:') {
    out.push(result('app_url', 'warn', tr('check.appUrl.title'), tr('check.appUrl.http', { url: c.APP_URL }), tr('check.appUrl.httpHint')));
  } else {
    out.push(result('app_url', 'pass', tr('check.appUrl.title'), tr('check.appUrl.pass', { redirect })));
  }

  // The address the networks download files from: this app's own media route, or, with S3, the bucket's (signed) public address.
  const s3Media = c.STORAGE_DRIVER === 's3' ? (c.S3_PUBLIC_ENDPOINT || c.S3_ENDPOINT || `https://${c.S3_BUCKET}.s3.${c.S3_REGION === 'auto' ? 'us-east-1' : c.S3_REGION}.amazonaws.com`) : null;
  const mediaName = s3Media ? (c.S3_PUBLIC_ENDPOINT ? 'S3_PUBLIC_ENDPOINT' : c.S3_ENDPOINT ? 'S3_ENDPOINT' : tr('check.media.bucket')) : 'MEDIA_URL';
  const mediaUrl = s3Media ?? c.MEDIA_URL;
  const media = new URL(mediaUrl);
  if (isPrivateHost(media.hostname)) {
    out.push(result('media_url', 'fail', tr('check.media.title'), tr('check.media.private', { name: mediaName, url: mediaUrl }), tr('check.media.privateHint', { variable: s3Media ? 'S3_PUBLIC_ENDPOINT' : 'MEDIA_URL' })));
  } else if (media.protocol !== 'https:') {
    out.push(result('media_url', 'warn', tr('check.media.title'), tr('check.media.http', { name: mediaName, url: mediaUrl }), tr('check.media.httpHint')));
  } else {
    out.push(result('media_url', 'pass', tr('check.media.title'), tr('check.media.pass', { host: media.host, where: s3Media ? tr('check.media.s3Where', { name: mediaName }) : '' })));
  }

  out.push(c.STORAGE_DRIVER === 'local' && c.NODE_ENV === 'production'
    ? result('storage', 'warn', tr('check.storage.title'), tr('check.storage.local'), tr('check.storage.localHint'))
    : result('storage', 'pass', tr('check.storage.title'), tr('check.storage.pass', { driver: c.STORAGE_DRIVER })));

  const [ffmpeg, ffprobe] = await Promise.all([tool('ffmpeg'), tool('ffprobe')]);
  out.push(ffmpeg && ffprobe
    ? result('ffmpeg', 'pass', 'ffmpeg', ffmpeg)
    : result('ffmpeg', 'fail', 'ffmpeg', tr('check.ffmpeg.missing', { tool: !ffmpeg ? 'ffmpeg' : 'ffprobe' }), tr('check.ffmpeg.missingHint')));

  if (c.NODE_ENV === 'production' && !c.SMTP_URL) {
    out.push(result('email', 'warn', tr('check.email.title'), tr('check.email.noSmtp'), tr('check.email.noSmtpHint')));
  }

  const enabled = Object.entries(c.enabled).filter(([, on]) => on).map(([k]) => k);
  out.push(enabled.length
    ? result('networks', 'pass', tr('check.networks.title'), enabled.join(', '))
    : result('networks', 'warn', tr('check.networks.title'), tr('check.networks.none'), tr('check.networks.noneHint')));

  if (c.enabled.linkedin) {
    const age = versionAgeMonths(c.LINKEDIN_VERSION, ctx.now());
    out.push(age >= 12
      ? result('linkedin_version', 'fail', tr('check.linkedin.title'), tr('check.linkedin.retired', { version: c.LINKEDIN_VERSION, months: age }), tr('check.linkedin.retiredHint'))
      : age >= 10
        ? result('linkedin_version', 'warn', tr('check.linkedin.title'), tr('check.linkedin.old', { version: c.LINKEDIN_VERSION, months: age }), tr('check.linkedin.oldHint'))
        : result('linkedin_version', 'pass', tr('check.linkedin.title'), tr('check.linkedin.pass', { version: c.LINKEDIN_VERSION, count: Math.max(age, 0) })));
  }

  if (c.metaEnabled) {
    out.push(c.META_WEBHOOK_VERIFY_TOKEN
      ? result('meta_webhook', 'pass', tr('check.metaWebhook.title'), tr('check.metaWebhook.pass', { url: `${c.APP_URL.replace(/\/$/, '')}/api/meta/webhook` }))
      : result('meta_webhook', 'warn', tr('check.metaWebhook.title'), tr('check.metaWebhook.missing'), tr('check.metaWebhook.missingHint')));
  }
  return out;
}

// ───────────────────────────── one account ─────────────────────────────

/** What a sign-in has to have been granted for the app to do all it does on that provider. */
function requiredScopes(provider: string, prizes: boolean, analytics: boolean): string[] {
  switch (provider) {
    case 'meta': return prizes ? [...META_SCOPES, ...META_PRIZE_SCOPES] : [...META_SCOPES];
    case 'google': return analytics ? [...GOOGLE_SCOPES, ANALYTICS_SCOPE] : [...GOOGLE_SCOPES];
    case 'threads': return THREADS_SCOPES;
    case 'tiktok': return TIKTOK_SCOPES;
    case 'linkedin': return LINKEDIN_SCOPES;
    case 'x': return X_SCOPES;
    case 'pinterest': return PINTEREST_SCOPES;
    default: return [];
  }
}

/** A network's own failure, said as what the person can do about it. The network's message stays in its own words. */
function describe(err: unknown, about: 'account' | 'post' = 'account'): { status: CheckStatus; detail: string; hint: string } {
  if (!(err instanceof ConnectorError)) return { status: 'fail', detail: (err as Error).message, hint: tr('check.why.notNetwork') };
  const where = err.httpStatus ? ` (HTTP ${err.httpStatus})` : '';
  const detail = `${err.text ? render(requestLocale(), err.text, err.message) : err.message}${where}`;
  switch (err.errorClass) {
    case 'auth': return { status: 'fail', detail, hint: tr('check.why.auth') };
    case 'rate_limit': return { status: 'warn', detail, hint: tr('check.why.rateLimit') };
    case 'transient': return { status: 'warn', detail, hint: tr('check.why.transient') };
    case 'unsupported': return { status: 'fail', detail, hint: tr('check.why.unsupported') };
    case 'file_rejected': return { status: 'fail', detail, hint: tr(about === 'post' ? 'check.why.refusedPost' : 'check.why.refused') };
    default: return { status: 'fail', detail, hint: tr('check.why.unknown') };
  }
}

interface Row {
  id: string; brand_id: string; network: string; display_name: string; status: string; last_error: string | null;
  token_encrypted: Buffer | null; token_expires_at: Date | null; granted_permissions: string[] | null; provider_data: Record<string, any> | null;
}

async function latestPost(ctx: Ctx, accountId: string) {
  return ctx.db.one(
    `select id, external_id, handle, placement, published_at from publication
     where social_account_id = $1 and status = 'published' and visibility = 'public' and manual = false and external_id is not null
     order by published_at desc limit 1`,
    [accountId],
  );
}

/** A number with a fixed count of decimals, written the way the language writes it (3.0 days, 3,0 días). */
const fixed = (n: number, digits: number, locale: Locale) => (locale === 'es' ? n.toFixed(digits).replace('.', ',') : n.toFixed(digits));

/** How long a token has left, in the unit a person would say it in: an hour-long token is not "0.0 days". */
export function lifetimeOf(ms: number, locale: Locale = requestLocale()): string {
  const say = (key: 'check.minutes' | 'check.hours' | 'check.days', count: string | number) => render(locale, { code: key, params: { count } });
  const minutes = ms / 60_000;
  if (minutes < 90) return say('check.minutes', Math.max(1, Math.round(minutes)));
  const hours = minutes / 60;
  if (hours < 48) return say('check.hours', Math.round(hours));
  const days = hours / 24;
  return say('check.days', fixed(days, days < 10 ? 1 : 0, locale));
}

const METRIC_NAMES = ['views', 'reach', 'likes', 'comments', 'shares', 'saves', 'avgWatchSeconds', 'watchMinutes'] as const;
const isKnownMetric = (k: string): k is (typeof METRIC_NAMES)[number] => (METRIC_NAMES as readonly string[]).includes(k);

const fmtMs = (ms: number) => (ms < 1000 ? tr('check.ms', { n: ms }) : tr('check.seconds', { n: fixed(ms / 1000, 1, requestLocale()) }));

/** The checks that only read. Safe to run from the screen at any time. */
export async function checkAccount(ctx: Ctx, accountId: string): Promise<AccountReport> {
  const row = await ctx.db.one<Row>('select * from social_account where id = $1', [accountId]);
  if (!row) throw notFound('Account');
  const header = { id: row.id, network: row.network, display_name: row.display_name };
  const results: CheckResult[] = [];
  const done = (): AccountReport => ({ account: header, results, ok: ok(results) });

  if (!row.token_encrypted) {
    results.push(result('connected', 'skip', tr('check.connected.title'), tr('check.connected.manual'), tr('check.connected.manualHint')));
    return done();
  }
  if (row.status === 'reconnect_required') {
    results.push(result('connected', 'fail', tr('check.connected.title'),
      row.last_error ? tr('check.connected.lostWhy', { error: row.last_error }) : tr('check.connected.lost'), tr('check.connected.lostHint')));
    return done();
  }
  results.push(result('connected', 'pass', tr('check.connected.title'), tr('check.connected.pass')));

  const connector = ctx.connectors.connector(row.network as Account['network']);
  const provider = ctx.connectors.providerOf(row.network as Account['network']);
  const account = (await loadConnectorAccount(ctx, accountId))!;
  if (!connector || !provider || !ctx.vault) {
    results.push(result('server', 'fail', tr('check.server.title'), tr('check.server.notSetUp', { network: row.network }), tr('check.server.notSetUpHint')));
    return done();
  }

  // The token, as it is kept: when it runs out and whether the app renews it by itself.
  let token: TokenSet | null = null;
  try {
    token = ctx.vault.open<TokenSet>(row.token_encrypted, `account:${accountId}`);
  } catch {
    results.push(result('token', 'fail', tr('check.token.storedTitle'), tr('check.token.unreadable'), tr('check.token.unreadableHint')));
    return done();
  }
  const expires = token.expiresAt ? new Date(token.expiresAt).getTime() : null;
  if (expires === null) {
    results.push(result('token', 'pass', tr('check.token.title'), tr('check.token.noEnd')));
  } else {
    const days = (expires - ctx.now().getTime()) / 86_400_000;
    const renews = !!provider.refresh;
    const title = tr('check.token.title');
    if (days < 0) results.push(result('token', 'fail', title, tr('check.token.expired'), tr('check.token.reconnect')));
    else if (days <= 7 && !renews) results.push(result('token', 'warn', title, tr('check.token.ending', { days: fixed(days, 1, requestLocale()) }), tr('check.token.endingHint')));
    else results.push(result('token', 'pass', title, tr('check.token.valid', { lifetime: lifetimeOf(expires - ctx.now().getTime()), renews: renews ? tr('check.token.renews') : '' })));
  }

  // What was granted, against what the app needs for what this brand uses.
  const brand = await ctx.db.one('select prizes from brand where id = $1', [row.brand_id]);
  const prizes = prizesOf((brand ?? {}) as never).enabled;
  const needed = requiredScopes(provider.id, prizes, ctx.config.GOOGLE_ANALYTICS);
  const granted = (row.granted_permissions && row.granted_permissions.length ? row.granted_permissions : token.scopes) ?? null;
  if (!needed.length) {
    results.push(result('scopes', 'skip', tr('check.scopes.title'), tr('check.scopes.noList')));
  } else if (!granted) {
    results.push(result('scopes', 'skip', tr('check.scopes.title'), tr('check.scopes.unknown')));
  } else {
    const missing = needed.filter((s) => !granted.includes(s));
    results.push(missing.length
      ? result('scopes', 'warn', tr('check.scopes.title'), tr('check.scopes.missing', { missing: missing.join(', ') }), tr('check.scopes.missingHint', { prizesOff: prizes ? '' : tr('check.scopes.prizesOff') }))
      : result('scopes', 'pass', tr('check.scopes.title'), tr('check.scopes.pass', { count: needed.length })));
  }

  // A live question to the network: is the connection accepted right now?
  if (connector.health) {
    const t0 = Date.now();
    try {
      const h = await connector.health(account, connectorEnv(ctx, accountId));
      results.push(h.valid
        ? result('health', 'pass', tr('check.health.title'), tr('check.health.answered', {
          time: fmtMs(Date.now() - t0), access: h.expiresAt ? tr('check.health.access', { date: h.expiresAt.slice(0, 10) }) : '', note: h.note ? ` ${h.note}` : '',
        }))
        : result('health', 'fail', tr('check.health.title'), h.note ?? tr('check.health.invalid'), tr('check.token.reconnect')));
    } catch (err) {
      results.push({ id: 'health', title: tr('check.health.title'), ...describe(err) });
    }
  } else {
    results.push(result('health', 'skip', tr('check.health.title'), tr('check.health.none')));
  }

  // Numbers and comments of the latest public post: read-only, and only if there is one.
  const post = await latestPost(ctx, accountId);
  if (!post) {
    for (const [id, title] of [['metrics', tr('check.metrics.title')], ['comments', tr('check.comments.title')]] as const) {
      results.push(result(id, 'skip', title, tr('check.post.none'), tr('check.post.noneHint')));
    }
    return done();
  }
  const env = connectorEnv(ctx, accountId);
  if (connector.fetchMetrics) {
    try {
      const m = await connector.fetchMetrics(account, post.external_id, post.handle ?? {}, env, { publishedAt: new Date(post.published_at), placement: post.placement });
      const metricName = (k: string) => (isKnownMetric(k) ? tr(`check.metric.${k}`) : k);
      const shown = Object.entries(m.common).map(([k, v]) => `${metricName(k)} ${v}`).join(', ');
      const note = m.note ? ` ${m.note}` : '';
      results.push(shown
        ? result('metrics', 'pass', tr('check.metrics.title'), tr('check.metrics.pass', { numbers: shown, note }), tr('check.metrics.passHint'))
        : result('metrics', 'warn', tr('check.metrics.title'), tr('check.metrics.empty', { note }), tr('check.metrics.emptyHint')));
    } catch (err) {
      results.push({ id: 'metrics', title: tr('check.metrics.title'), ...describe(err, 'post') });
    }
  } else {
    results.push(result('metrics', 'skip', tr('check.metrics.title'), tr('check.metrics.unsupported')));
  }
  if (connector.listComments && prizes) {
    try {
      const cs = await connector.listComments(account, post.external_id, post.handle ?? {}, env, new Date(ctx.now().getTime() - 7 * 86_400_000));
      results.push(result('comments', 'pass', tr('check.comments.title'), tr('check.comments.pass', { count: cs.length })));
    } catch (err) {
      results.push({ id: 'comments', title: tr('check.comments.title'), ...describe(err, 'post') });
    }
  } else {
    results.push(result('comments', 'skip', tr('check.comments.title'), tr(connector.listComments ? 'check.comments.prizesOff' : 'check.comments.unsupported')));
  }
  return done();
}

/** The read-only checks for one account, for an admin pressing the button. */
export async function checkAccountFor(ctx: Ctx, p: Principal, brandId: string, accountId: string): Promise<AccountReport> {
  await authorize(ctx.db, p, brandId, 'brand.manage');
  const own = await ctx.db.one('select 1 from social_account where id = $1 and brand_id = $2', [accountId, brandId]);
  if (!own) throw notFound('Account');
  const report = await checkAccount(ctx, accountId);
  const count = (s: CheckStatus) => report.results.filter((r) => r.status === s).length;
  await audit(ctx.db, p, brandId, 'account.checked', 'social_account', accountId, null, { pass: count('pass'), warn: count('warn'), fail: count('fail') });
  return report;
}

export async function checkServerFor(ctx: Ctx, p: Principal, brandId: string): Promise<CheckResult[]> {
  await authorize(ctx.db, p, brandId, 'brand.manage');
  return checkServer(ctx);
}

// ───────────────────────────── a real post ─────────────────────────────

/** What each network needs to be told for a plain test post. TikTok's controls have no defaults, and a test must not be public. */
const TEST_OPTIONS: Record<string, Record<string, unknown>> = {
  tiktok: { privacy: 'SELF_ONLY', consent: true },
};
export const TEST_TEXT = 'Connection test from the content studio. This post is safe to delete.';

async function ffmpegTo(args: string[], dest: string) {
  await run('ffmpeg', ['-v', 'error', '-y', ...args, dest], { timeout: 60_000 });
}

/** A small picture or video that every network's rules accept, put where the networks can download it. */
async function testMedia(ctx: Ctx, kind: 'image' | 'video'): Promise<MediaItem> {
  const dir = await mkdtemp(path.join(tmpdir(), 'selfcheck-'));
  try {
    const file = path.join(dir, kind === 'image' ? 'test.jpg' : 'test.mp4');
    if (kind === 'image') await ffmpegTo(['-f', 'lavfi', '-i', 'testsrc2=size=1080x1350', '-frames:v', '1', '-q:v', '3'], file);
    else await ffmpegTo(['-f', 'lavfi', '-i', 'testsrc2=size=1080x1920:rate=30', '-f', 'lavfi', '-i', 'sine=frequency=440', '-t', '4', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest'], file);
    const buf = await readFile(file);
    const mime = kind === 'image' ? 'image/jpeg' : 'video/mp4';
    const key = `selfcheck/${randomUUID()}/${path.basename(file)}`;
    await ctx.storage.put(key, buf, mime);
    return {
      kind, position: 0, name: path.basename(file), mime, bytes: buf.length, width: 1080, height: kind === 'image' ? 1350 : 1920,
      durationMs: kind === 'video' ? 4000 : null, key, url: await ctx.storage.presignGet(key, { expiresSec: ctx.config.PUBLIC_MEDIA_TTL_SECONDS }),
    };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export interface PublishTestOptions {
  /** How long to wait for a network that is still processing, per stage. */
  waitSeconds?: number;
  /** Waits between looks; replaced in tests. */
  pause?: (ms: number) => Promise<void>;
}

/**
 * Makes ONE real post on the account with a generated picture (or video), through the same connector calls the app uses to publish,
 * and reports what the network said at each step. It does not delete the post: no connector can, so the report says where it is
 * and that a person has to delete it. Only the command line runs this, and only with a confirmation.
 */
export async function publishTest(ctx: Ctx, accountId: string, o: PublishTestOptions = {}): Promise<CheckResult[]> {
  const out: CheckResult[] = [];
  const pause = o.pause ?? sleep;
  const deadline = ctx.now().getTime() + (o.waitSeconds ?? 180) * 1000;
  const account = await loadConnectorAccount(ctx, accountId);
  if (!account) throw notFound('Account');
  const connector: Connector | null = ctx.connectors.connector(account.network);
  if (!connector) return [result('publish', 'fail', tr('check.publish.title'), tr('check.server.notSetUp', { network: account.network }))];

  const image = { kind: 'image' as const };
  const kind: 'image' | 'video' | null = connector.defaultPlacement({ pieceKind: 'image', format: '4:5', media: [image] })
    ? 'image'
    : connector.defaultPlacement({ pieceKind: 'video', format: '9:16', media: [{ kind: 'video' }] }) ? 'video' : null;
  if (!kind) return [result('publish', 'skip', tr('check.publish.title'), tr('check.publish.nothing'))];
  const placement = connector.defaultPlacement({ pieceKind: kind, format: kind === 'image' ? '4:5' : '9:16', media: [{ kind }] })!;

  let media: MediaItem;
  try {
    media = await testMedia(ctx, kind);
  } catch (err) {
    return [result('publish', 'fail', tr('check.publish.title'), tr('check.publish.noMedia', { kind: tr(`check.publish.kind.${kind}`), error: (err as Error).message }), tr('check.publish.noMediaHint'))];
  }
  const input: PublishInput = {
    publicationId: randomUUID(), placement, title: 'Connection test', text: TEST_TEXT, firstComment: '', options: TEST_OPTIONS[account.network] ?? {},
    scheduledAt: ctx.now(), aiGenerated: false, media: [media],
  };
  out.push(result('publish.input', 'pass', tr('check.publish.title'), tr('check.publish.input', { kind: tr(`check.publish.kind.${kind}`), placement, options: JSON.stringify(input.options) })));

  const issues = connector.validate(input, account).filter((i) => i.severity === 'error');
  if (issues.length) {
    out.push(result('publish.validate', 'fail', tr('check.publish.validateTitle'), issues.map((i) => i.message).join(' '), tr('check.publish.validateHint')));
    return out;
  }

  let handle: Handle = {};
  const env = connectorEnv(ctx, accountId, async (h) => { handle = h; });
  const stage = async (id: string, title: string, fn: () => Promise<CheckResult | null>) => {
    for (;;) {
      try {
        const r = await fn();
        if (r) { out.push(r); return r.status !== 'fail'; }
      } catch (err) {
        out.push({ id, title, ...describe(err) });
        return false;
      }
      if (ctx.now().getTime() > deadline) {
        out.push(result(id, 'fail', title, tr('check.publish.notReady', { seconds: o.waitSeconds ?? 180 }), tr('check.publish.notReadyHint')));
        return false;
      }
    }
  };

  const prepared = await stage('publish.prepare', tr('check.publish.prepareTitle'), async () => {
    const r = await connector.prepare(input, account, handle, env);
    handle = r.handle;
    if (!r.done) { await pause(Math.min((r.retryAfterSec ?? 5) * 1000, 30_000)); return null; }
    return result('publish.prepare', 'pass', tr('check.publish.prepareTitle'), tr(r.nativeScheduled ? 'check.publish.preparedHeld' : 'check.publish.prepared'));
  });
  if (!prepared) return out;

  let published: { externalId: string; url?: string } | null = null;
  const posted = await stage('publish.publish', tr('check.publish.postTitle'), async () => {
    published = await connector.publish(input, account, handle, env);
    return result('publish.publish', 'pass', tr('check.publish.postTitle'), tr('check.publish.posted', {
      id: published.externalId, url: published.url ? tr('check.publish.postedAt', { url: published.url }) : '',
    }));
  });
  if (!posted || !published) return out;
  const live = published as { externalId: string; url?: string };

  await stage('publish.verify', tr('check.publish.verifyTitle'), async () => {
    const v = await connector.verify(account, live.externalId, handle, env);
    if (v.visibility === 'processing' || v.visibility === 'scheduled') { await pause(10_000); return null; }
    const title = tr('check.publish.verifyTitle');
    const where = v.url ?? live.url ?? tr('check.publish.ownPage');
    const said = v.noteText ? render(requestLocale(), v.noteText, v.note) : v.note;
    const note = said ? `: ${said}` : '';
    if (v.visibility === 'public') return result('publish.verify', 'pass', title, tr('check.publish.public', { where }));
    if (v.visibility === 'private') return result('publish.verify', 'warn', title, tr('check.publish.private', { note }), tr('check.publish.privateHint'));
    return result('publish.verify', 'fail', title, tr('check.publish.gone', { note }), tr('check.publish.goneHint'));
  });

  out.push(result('publish.cleanup', 'warn', tr('check.publish.cleanupTitle'), tr('check.publish.cleanup', {
    name: account.displayName, network: account.network, id: live.externalId, url: live.url ? `, ${live.url}` : '',
  }), tr('check.publish.cleanupHint')));
  return out;
}


// ───────────────────────────── the command line ─────────────────────────────

export interface RunOptions {
  /** A brand's id or its exact name. */
  brand: string;
  network?: string;
  /** Make one real post on each account too (see publishTest). */
  publish?: boolean;
  /** Called before each account's checks, so a recording can say whose calls follow. */
  onAccount?: (label: string) => void;
  publishOptions?: PublishTestOptions;
}

export interface RunReport {
  brand: { id: string; name: string };
  server: CheckResult[];
  accounts: AccountReport[];
  ok: boolean;
}

/** Every connected account of a brand (or one network of it), checked, with the server's own checks first. */
export async function runChecks(ctx: Ctx, o: RunOptions): Promise<RunReport> {
  const byId = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(o.brand);
  const brand = await ctx.db.one<{ id: string; name: string }>(
    byId ? 'select id, name from brand where id = $1' : 'select id, name from brand where lower(name) = lower($1)', [o.brand],
  );
  if (!brand) throw notFound('Brand');
  const rows = await ctx.db.query<{ id: string }>(
    `select id from social_account where brand_id = $1 and token_encrypted is not null and ($2::text is null or network = $2) order by network, display_name`,
    [brand.id, o.network ?? null],
  );
  const server = await checkServer(ctx);
  const accounts: AccountReport[] = [];
  for (const r of rows) {
    const meta = (await ctx.db.one<{ network: string; display_name: string }>('select network, display_name from social_account where id = $1', [r.id]))!;
    o.onAccount?.(`${meta.network}: ${meta.display_name}`);
    const report = await checkAccount(ctx, r.id);
    if (o.publish && report.ok) report.results.push(...(await publishTest(ctx, r.id, o.publishOptions)));
    report.ok = ok(report.results);
    accounts.push(report);
  }
  return { brand, server, accounts, ok: ok(server) && accounts.every((a) => a.ok) };
}

const MARK: Record<CheckStatus, string> = { pass: '✔', warn: '⚠', fail: '✖', skip: '–' };

/** A list of results as text a person can read in a terminal. */
export function formatChecks(results: CheckResult[], indent = '  '): string {
  return results.map((r) => `${indent}${MARK[r.status]} ${r.title}: ${r.detail}${r.hint ? `\n${indent}    → ${r.hint}` : ''}`).join('\n');
}
