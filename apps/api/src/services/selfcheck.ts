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
import { audit } from './audit.js';
import { connectorEnv, loadConnectorAccount } from './connectors.js';
import { prizesOf } from './prizes.js';

/**
 * Checks that say whether this server and each connected account are ready for real use, and what to do about what is not.
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
    ? result('token_key', 'pass', 'Token key', 'TOKEN_KEY is set, so network tokens are kept sealed.')
    : result('token_key', 'fail', 'Token key', 'TOKEN_KEY is not set: no account can be connected.', 'Generate one with `openssl rand -base64 32`, keep a copy somewhere safe, and restart.'));

  const app = new URL(c.APP_URL);
  const redirect = `${c.APP_URL.replace(/\/$/, '')}/api/oauth/callback`;
  if (isPrivateHost(app.hostname)) {
    out.push(result('app_url', c.NODE_ENV === 'production' ? 'fail' : 'warn', 'Public address', `APP_URL is ${c.APP_URL}, which only this machine can reach.`, 'Networks send the browser back to the address you register, so for a real run it has to be a public https address.'));
  } else if (app.protocol !== 'https:') {
    out.push(result('app_url', 'warn', 'Public address', `APP_URL is ${c.APP_URL}, which is not https.`, 'Most networks refuse an http redirect address, and sign-in cookies should only travel over https.'));
  } else {
    out.push(result('app_url', 'pass', 'Public address', `Register this redirect address with every network: ${redirect}`));
  }

  const media = new URL(c.MEDIA_URL);
  if (isPrivateHost(media.hostname)) {
    out.push(result('media_url', 'fail', 'Media address', `MEDIA_URL is ${c.MEDIA_URL}: the networks cannot reach it, and Instagram, Threads, Pinterest and TikTok photos download the files from it.`, 'Point MEDIA_URL at a public https domain that serves the signed media addresses.'));
  } else if (media.protocol !== 'https:') {
    out.push(result('media_url', 'warn', 'Media address', `MEDIA_URL is ${c.MEDIA_URL}, which is not https.`, 'Some networks refuse to download from an http address.'));
  } else {
    out.push(result('media_url', 'pass', 'Media address', `Networks will download files from ${c.MEDIA_URL}. TikTok photo posts also need this domain verified in TikTok's developer portal.`));
  }

  out.push(c.STORAGE_DRIVER === 'local' && c.NODE_ENV === 'production'
    ? result('storage', 'warn', 'Storage', 'Files are kept on this machine\'s disk.', 'Use the s3 driver so files survive a rebuilt machine and can be served from the media domain.')
    : result('storage', 'pass', 'Storage', `Driver: ${c.STORAGE_DRIVER}.`));

  const [ffmpeg, ffprobe] = await Promise.all([tool('ffmpeg'), tool('ffprobe')]);
  out.push(ffmpeg && ffprobe
    ? result('ffmpeg', 'pass', 'ffmpeg', ffmpeg)
    : result('ffmpeg', 'fail', 'ffmpeg', `${!ffmpeg ? 'ffmpeg' : 'ffprobe'} is not installed on this machine.`, 'Videos and pictures are converted for each network with it: install ffmpeg (it includes ffprobe).'));

  if (c.NODE_ENV === 'production' && !c.SMTP_URL) {
    out.push(result('email', 'warn', 'Email', 'SMTP_URL is not set: sign-in links are only written to the server log.', 'Set SMTP_URL so people can sign in.'));
  }

  const enabled = Object.entries(c.enabled).filter(([, on]) => on).map(([k]) => k);
  out.push(enabled.length
    ? result('networks', 'pass', 'Networks switched on', enabled.join(', '))
    : result('networks', 'warn', 'Networks switched on', 'No network has credentials: every account stays manual.', 'Set a network\'s credentials (see .env.example) and restart.'));

  if (c.enabled.linkedin) {
    const age = versionAgeMonths(c.LINKEDIN_VERSION, ctx.now());
    out.push(age >= 12
      ? result('linkedin_version', 'fail', 'LinkedIn API version', `LINKEDIN_VERSION=${c.LINKEDIN_VERSION} is ${age} months old, and LinkedIn retires a version after about a year.`, 'Raise LINKEDIN_VERSION to the latest month in LinkedIn\'s changelog, and check the post still works.')
      : age >= 10
        ? result('linkedin_version', 'warn', 'LinkedIn API version', `LINKEDIN_VERSION=${c.LINKEDIN_VERSION} is ${age} months old and will soon be retired.`, 'Plan to raise it.')
        : result('linkedin_version', 'pass', 'LinkedIn API version', `LINKEDIN_VERSION=${c.LINKEDIN_VERSION} (${Math.max(age, 0)} months old).`));
  }

  if (c.metaEnabled) {
    out.push(c.META_WEBHOOK_VERIFY_TOKEN
      ? result('meta_webhook', 'pass', 'Meta webhook', `Register ${c.APP_URL.replace(/\/$/, '')}/api/meta/webhook in the Meta app (Instagram and Page objects, comments) with the verify token you set.`)
      : result('meta_webhook', 'warn', 'Meta webhook', 'META_WEBHOOK_VERIFY_TOKEN is not set.', 'Only needed for prizes. Without it comments are found by polling every few minutes instead of arriving at once.'));
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

/** A network's own failure, said as what the person can do about it. */
function describe(err: unknown, about: 'account' | 'post' = 'account'): { status: CheckStatus; detail: string; hint: string } {
  if (!(err instanceof ConnectorError)) return { status: 'fail', detail: (err as Error).message, hint: 'This is not an answer from the network: look at the server log.' };
  const where = err.httpStatus ? ` (HTTP ${err.httpStatus})` : '';
  switch (err.errorClass) {
    case 'auth': return { status: 'fail', detail: `${err.message}${where}`, hint: 'The network no longer accepts this connection: connect the account again in Settings → Accounts.' };
    case 'rate_limit': return { status: 'warn', detail: `${err.message}${where}`, hint: 'The network is limiting this app right now. Try again later; nothing is wrong with the connection.' };
    case 'transient': return { status: 'warn', detail: `${err.message}${where}`, hint: 'The network did not answer properly. If this repeats, check that this server can reach it (outbound firewall, proxy, DNS).' };
    case 'unsupported': return { status: 'fail', detail: `${err.message}${where}`, hint: 'The network says it cannot do this. The message above says why.' };
    case 'file_rejected': return {
      status: 'fail', detail: `${err.message}${where}`,
      hint: about === 'post'
        ? 'The network refused the question about this post. If the post was deleted on the network, that is why. Otherwise this app and the network disagree about how to ask: send the transcript (see docs/phase-5.md) so it can be fixed.'
        : 'The network refused the request itself, which usually means this app and the network disagree about how to ask. Send the transcript (see docs/phase-5.md) so it can be fixed.',
    };
    default: return { status: 'fail', detail: `${err.message}${where}`, hint: 'An answer the app does not know how to read. Send the transcript (see docs/phase-5.md) so it can be fixed.' };
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

/** How long a token has left, in the unit a person would say it in: an hour-long token is not "0.0 days". */
export function lifetimeOf(ms: number): string {
  const minutes = ms / 60_000;
  if (minutes < 90) return `${Math.max(1, Math.round(minutes))} minute${Math.round(minutes) === 1 ? '' : 's'}`;
  const hours = minutes / 60;
  if (hours < 48) return `${Math.round(hours)} hours`;
  const days = hours / 24;
  return `${days.toFixed(days < 10 ? 1 : 0)} days`;
}

const fmtMs = (ms: number) => (ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`);

/** The checks that only read. Safe to run from the screen at any time. */
export async function checkAccount(ctx: Ctx, accountId: string): Promise<AccountReport> {
  const row = await ctx.db.one<Row>('select * from social_account where id = $1', [accountId]);
  if (!row) throw notFound('Account');
  const header = { id: row.id, network: row.network, display_name: row.display_name };
  const results: CheckResult[] = [];
  const done = (): AccountReport => ({ account: header, results, ok: ok(results) });

  if (!row.token_encrypted) {
    results.push(result('connected', 'skip', 'Connection', 'This account is not connected: a person publishes to it by hand.', 'Connect it in Settings → Accounts to let the app publish.'));
    return done();
  }
  if (row.status === 'reconnect_required') {
    results.push(result('connected', 'fail', 'Connection', `The network stopped accepting this connection${row.last_error ? `: ${row.last_error}` : ''}.`, 'Connect the account again in Settings → Accounts.'));
    return done();
  }
  results.push(result('connected', 'pass', 'Connection', 'Connected, and nothing has told the app otherwise.'));

  const connector = ctx.connectors.connector(row.network as Account['network']);
  const provider = ctx.connectors.providerOf(row.network as Account['network']);
  const account = (await loadConnectorAccount(ctx, accountId))!;
  if (!connector || !provider || !ctx.vault) {
    results.push(result('server', 'fail', 'This server', `The app is not set up to publish to ${row.network} on this server.`, 'Set the network\'s credentials and TOKEN_KEY (see .env.example), and restart.'));
    return done();
  }

  // The token, as it is kept: when it runs out and whether the app renews it by itself.
  let token: TokenSet | null = null;
  try {
    token = ctx.vault.open<TokenSet>(row.token_encrypted, `account:${accountId}`);
  } catch {
    results.push(result('token', 'fail', 'Stored token', 'The stored token cannot be opened with this server\'s TOKEN_KEY.', 'TOKEN_KEY changed since the account was connected. Connect the account again.'));
    return done();
  }
  const expires = token.expiresAt ? new Date(token.expiresAt).getTime() : null;
  if (expires === null) {
    results.push(result('token', 'pass', 'Token lifetime', 'The network gave no end date for this token.'));
  } else {
    const days = (expires - ctx.now().getTime()) / 86_400_000;
    const renews = !!provider.refresh;
    if (days < 0) results.push(result('token', 'fail', 'Token lifetime', 'The token has expired.', 'Connect the account again.'));
    else if (days <= 7 && !renews) results.push(result('token', 'warn', 'Token lifetime', `The token runs out in ${days.toFixed(1)} days and this network gives no way to renew it.`, 'Connect the account again before then.'));
    else results.push(result('token', 'pass', 'Token lifetime', `Valid for another ${lifetimeOf(expires - ctx.now().getTime())}${renews ? ', and the app renews it by itself before it ends' : ''}.`));
  }

  // What was granted, against what the app needs for what this brand uses.
  const brand = await ctx.db.one('select prizes from brand where id = $1', [row.brand_id]);
  const prizes = prizesOf((brand ?? {}) as never).enabled;
  const needed = requiredScopes(provider.id, prizes, ctx.config.GOOGLE_ANALYTICS);
  const granted = (row.granted_permissions && row.granted_permissions.length ? row.granted_permissions : token.scopes) ?? null;
  if (!needed.length) {
    results.push(result('scopes', 'skip', 'Permissions', 'This network has no list of permissions to compare.'));
  } else if (!granted) {
    results.push(result('scopes', 'skip', 'Permissions', 'The network did not say which permissions it granted.'));
  } else {
    const missing = needed.filter((s) => !granted.includes(s));
    results.push(missing.length
      ? result('scopes', 'warn', 'Permissions', `Not granted: ${missing.join(', ')}.`, `Anything that needs them will fail. Connect the account again and accept every permission${prizes ? '' : ' (prizes are off, so the messaging ones are not asked for)'}.`)
      : result('scopes', 'pass', 'Permissions', `All ${needed.length} permissions the app asks for were granted.`));
  }

  // A live question to the network: is the connection accepted right now?
  if (connector.health) {
    const t0 = Date.now();
    try {
      const h = await connector.health(account, connectorEnv(ctx, accountId));
      results.push(h.valid
        ? result('health', 'pass', 'Network accepts the connection', `Answered in ${fmtMs(Date.now() - t0)}${h.expiresAt ? `; access ends ${h.expiresAt.slice(0, 10)}` : ''}.`)
        : result('health', 'fail', 'Network accepts the connection', h.note ?? 'The network says this connection is no longer valid.', 'Connect the account again.'));
    } catch (err) {
      results.push({ id: 'health', title: 'Network accepts the connection', ...describe(err) });
    }
  } else {
    results.push(result('health', 'skip', 'Network accepts the connection', 'This connector has no light question to ask.'));
  }

  // Numbers and comments of the latest public post: read-only, and only if there is one.
  const post = await latestPost(ctx, accountId);
  if (!post) {
    for (const [id, title] of [['metrics', 'Reading a post\'s numbers'], ['comments', 'Reading a post\'s comments']] as const) {
      results.push(result(id, 'skip', title, 'No post has been published to this account by the app yet.', 'Publish one (or run the check with --publish from the command line) and check again.'));
    }
    return done();
  }
  const env = connectorEnv(ctx, accountId);
  if (connector.fetchMetrics) {
    try {
      const m = await connector.fetchMetrics(account, post.external_id, post.handle ?? {}, env, { publishedAt: new Date(post.published_at), placement: post.placement });
      const shown = Object.entries(m.common).map(([k, v]) => `${k} ${v}`).join(', ');
      results.push(shown
        ? result('metrics', 'pass', 'Reading a post\'s numbers', `${shown}.${m.note ? ` ${m.note}` : ''}`, 'Compare these with what the network shows for the same post.')
        : result('metrics', 'warn', 'Reading a post\'s numbers', `The network answered but gave no numbers.${m.note ? ` ${m.note}` : ''}`, 'A new post may have none yet. If it stays empty, a permission or a product on the network\'s side is probably missing.'));
    } catch (err) {
      results.push({ id: 'metrics', title: 'Reading a post\'s numbers', ...describe(err, 'post') });
    }
  } else {
    results.push(result('metrics', 'skip', 'Reading a post\'s numbers', 'This connector does not read numbers.'));
  }
  if (connector.listComments && prizes) {
    try {
      const cs = await connector.listComments(account, post.external_id, post.handle ?? {}, env, new Date(ctx.now().getTime() - 7 * 86_400_000));
      results.push(result('comments', 'pass', 'Reading a post\'s comments', `${cs.length} comment${cs.length === 1 ? '' : 's'} in the last 7 days.`));
    } catch (err) {
      results.push({ id: 'comments', title: 'Reading a post\'s comments', ...describe(err, 'post') });
    }
  } else {
    results.push(result('comments', 'skip', 'Reading a post\'s comments', connector.listComments ? 'Prizes are off for this brand, so comments are not read.' : 'This connector does not read comments.'));
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
  if (!connector) return [result('publish', 'fail', 'Test post', `The app is not set up to publish to ${account.network} on this server.`)];

  const image = { kind: 'image' as const };
  const kind: 'image' | 'video' | null = connector.defaultPlacement({ pieceKind: 'image', format: '4:5', media: [image] })
    ? 'image'
    : connector.defaultPlacement({ pieceKind: 'video', format: '9:16', media: [{ kind: 'video' }] }) ? 'video' : null;
  if (!kind) return [result('publish', 'skip', 'Test post', 'This network takes neither a single picture nor a single video from the app.')];
  const placement = connector.defaultPlacement({ pieceKind: kind, format: kind === 'image' ? '4:5' : '9:16', media: [{ kind }] })!;

  let media: MediaItem;
  try {
    media = await testMedia(ctx, kind);
  } catch (err) {
    return [result('publish', 'fail', 'Test post', `Could not make a test ${kind}: ${(err as Error).message}`, 'ffmpeg has to be installed on this machine.')];
  }
  const input: PublishInput = {
    publicationId: randomUUID(), placement, title: 'Connection test', text: TEST_TEXT, firstComment: '', options: TEST_OPTIONS[account.network] ?? {},
    scheduledAt: ctx.now(), aiGenerated: false, media: [media],
  };
  out.push(result('publish.input', 'pass', 'Test post', `A ${kind} for the "${placement}" kind of post, with options ${JSON.stringify(input.options)}.`));

  const issues = connector.validate(input, account).filter((i) => i.severity === 'error');
  if (issues.length) {
    out.push(result('publish.validate', 'fail', 'The app\'s own checks', issues.map((i) => i.message).join(' '), 'The test post is not made when the app itself would refuse it.'));
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
        out.push(result(id, 'fail', title, `Still not ready after ${o.waitSeconds ?? 180} seconds.`, 'The network may just be slow: look at the account itself, and run the check again.'));
        return false;
      }
    }
  };

  const prepared = await stage('publish.prepare', 'The network accepts the files', async () => {
    const r = await connector.prepare(input, account, handle, env);
    handle = r.handle;
    if (!r.done) { await pause(Math.min((r.retryAfterSec ?? 5) * 1000, 30_000)); return null; }
    return result('publish.prepare', 'pass', 'The network accepts the files', r.nativeScheduled ? 'Accepted, and the network holds it itself.' : 'Accepted.');
  });
  if (!prepared) return out;

  let published: { externalId: string; url?: string } | null = null;
  const posted = await stage('publish.publish', 'The post is made', async () => {
    published = await connector.publish(input, account, handle, env);
    return result('publish.publish', 'pass', 'The post is made', `The network's id for it: ${published.externalId}${published.url ? `, at ${published.url}` : ''}.`);
  });
  if (!posted || !published) return out;
  const live = published as { externalId: string; url?: string };

  await stage('publish.verify', 'The post can be found again', async () => {
    const v = await connector.verify(account, live.externalId, handle, env);
    if (v.visibility === 'processing' || v.visibility === 'scheduled') { await pause(10_000); return null; }
    const where = v.url ?? live.url ?? 'the account\'s own page';
    if (v.visibility === 'public') return result('publish.verify', 'pass', 'The post can be found again', `It is public: ${where}`);
    if (v.visibility === 'private') return result('publish.verify', 'warn', 'The post can be found again', `It is there, but private${v.note ? `: ${v.note}` : ''}.`, 'That is what is expected until the network approves the app. Flip the account\'s approval flag once it has.');
    return result('publish.verify', 'fail', 'The post can be found again', `The network no longer shows it${v.note ? `: ${v.note}` : ''}.`, 'Look at the account itself.');
  });

  out.push(result('publish.cleanup', 'warn', 'Delete the test post', `A real post was made on ${account.displayName} (${account.network}), id ${live.externalId}${live.url ? `, ${live.url}` : ''}.`, 'The app cannot take it down: delete it on the network yourself.'));
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
