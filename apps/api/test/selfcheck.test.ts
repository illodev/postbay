import { spawn } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { call, setTap, type Exchange } from '../src/connectors/http.js';
import type { Ctx } from '../src/context.js';
import {
  TEST_TEXT, checkAccount, checkServer, formatChecks, publishTest, runChecks, versionAgeMonths, type CheckResult,
} from '../src/services/selfcheck.js';
import { createEnv, type Env } from './helpers.js';

let env: Env;
let ig: string, fb: string, yt: string;
beforeAll(async () => {
  env = await createEnv({}, { fakes: true });
  ig = await env.connect('instagram');
  fb = await env.connect('facebook');
  yt = await env.connect('youtube');
});
afterAll(async () => { await env.close(); });
beforeEach(async () => {
  env.meta.failures.length = 0;
  env.google.failures.length = 0;
  env.meta.calls.length = 0;
  await env.db.query(`update brand set prizes = '{"enabled":false,"retention_days":30}'`);
  await env.db.query(`update social_account set status = 'active', last_error = null, granted_permissions = '[]' where id = any($1)`, [[ig, fb, yt]]);
  setTap(null);
});

const MIN = 60_000;
const DAY = 24 * 60 * MIN;
const pick = (rs: CheckResult[], id: string) => {
  const r = rs.find((x) => x.id === id);
  if (!r) throw new Error(`no "${id}" check among ${rs.map((x) => x.id).join(', ')}`);
  return r;
};
const withConfig = (patch: Record<string, unknown>): Ctx => ({ ...env.ctx, config: { ...env.ctx.config, ...patch } }) as Ctx;
const noWait = async () => {};
/** What the stand-in holds now that it did not before: tests share it, so they count what is new instead of clearing it. */
const snapshot = () => ({ media: new Set(env.meta.media.keys()), posts: new Set(env.meta.posts.keys()) });
const fresh = (before: ReturnType<typeof snapshot>) => ({
  media: [...env.meta.media.entries()].filter(([id]) => !before.media.has(id)).map(([, v]) => v),
  posts: [...env.meta.posts.entries()].filter(([id]) => !before.posts.has(id)).map(([, v]) => v),
});

describe('the server', () => {
  it('needs the token key, and says how to make one', async () => {
    expect(pick(await checkServer(env.ctx), 'token_key').status).toBe('pass');
    const r = pick(await checkServer({ ...env.ctx, vault: null } as Ctx), 'token_key');
    expect(r.status).toBe('fail');
    expect(r.hint).toMatch(/openssl rand -base64 32/);
  });

  it('tells a public https address (with the redirect address to register) from one that is local, or not https', async () => {
    const good = pick(await checkServer(withConfig({ APP_URL: 'https://studio.example.com' })), 'app_url');
    expect(good.status).toBe('pass');
    expect(good.detail).toContain('https://studio.example.com/api/oauth/callback');
    expect(pick(await checkServer(withConfig({ APP_URL: 'http://studio.example.com' })), 'app_url').status).toBe('warn');
    expect(pick(await checkServer(withConfig({ APP_URL: 'http://localhost:3000' })), 'app_url').status).toBe('warn'); // fine in development…
    expect(pick(await checkServer(withConfig({ APP_URL: 'http://localhost:3000', NODE_ENV: 'production' })), 'app_url').status).toBe('fail'); // …not in production
    expect(pick(await checkServer(withConfig({ APP_URL: 'http://192.168.1.20' , NODE_ENV: 'production' })), 'app_url').status).toBe('fail');
  });

  it('fails a media address no network could download from, because Instagram and others fetch the files from it', async () => {
    expect(pick(await checkServer(withConfig({ MEDIA_URL: 'http://127.0.0.1:3000' })), 'media_url').status).toBe('fail');
    expect(pick(await checkServer(withConfig({ MEDIA_URL: 'http://10.0.0.5' })), 'media_url').status).toBe('fail');
    expect(pick(await checkServer(withConfig({ MEDIA_URL: 'http://media.example.com' })), 'media_url').status).toBe('warn');
    const good = pick(await checkServer(withConfig({ MEDIA_URL: 'https://media.example.com' })), 'media_url');
    expect(good.status).toBe('pass');
    expect(good.detail).toMatch(/TikTok photo posts also need this domain verified/);
  });

  it('warns about LinkedIn\'s API version before it is retired, and fails it after', async () => {
    const now = env.ctx.now();
    const ym = (monthsAgo: number) => { const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - monthsAgo, 1)); return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}`; };
    const enabled = { ...env.ctx.config.enabled, linkedin: true };
    const status = async (months: number) => pick(await checkServer(withConfig({ enabled, LINKEDIN_VERSION: ym(months) })), 'linkedin_version').status;
    expect(await status(2)).toBe('pass');
    expect(await status(9)).toBe('pass');
    expect(await status(10)).toBe('warn');
    expect(await status(11)).toBe('warn');
    expect(await status(12)).toBe('fail');
    expect(await status(30)).toBe('fail');
    expect(versionAgeMonths('202401', new Date(Date.UTC(2025, 0, 15)))).toBe(12);
    // Not asked about at all when LinkedIn is not set up.
    expect((await checkServer(env.ctx)).some((r) => r.id === 'linkedin_version')).toBe(false);
  });

  it('checks that ffmpeg is installed, and about the Meta webhook only when Meta is set up', async () => {
    const rs = await checkServer(env.ctx);
    expect(pick(rs, 'ffmpeg').status).toBe('pass');
    expect(pick(rs, 'meta_webhook').status).toBe('warn'); // the verify token is not set here
    expect(pick(await checkServer(withConfig({ META_WEBHOOK_VERIFY_TOKEN: 'x' })), 'meta_webhook').status).toBe('pass');
    const noMeta = await checkServer(withConfig({ metaEnabled: false }));
    expect(noMeta.some((r) => r.id === 'meta_webhook')).toBe(false);
  });
});

describe('an account, read-only', () => {
  it('says plainly that an account nobody connected is published by hand', async () => {
    const r = await checkAccount(env.ctx, env.accounts.instagram);
    expect(r.ok).toBe(true);
    expect(r.results).toHaveLength(1);
    expect(r.results[0]).toMatchObject({ id: 'connected', status: 'skip' });
  });

  it('fails an account the network stopped accepting, with what the network said', async () => {
    await env.db.query(`update social_account set status = 'reconnect_required', last_error = 'Session has expired' where id = $1`, [ig]);
    const r = await checkAccount(env.ctx, ig);
    expect(r.ok).toBe(false);
    expect(pick(r.results, 'connected')).toMatchObject({ status: 'fail' });
    expect(pick(r.results, 'connected').detail).toContain('Session has expired');
    expect(pick(r.results, 'connected').hint).toMatch(/Connect the account again/);
  });

  it('passes a healthy account, asks the network a live question, and skips what it has no post to read for', async () => {
    const r = await checkAccount(env.ctx, ig);
    expect(r.ok).toBe(true);
    expect(pick(r.results, 'connected').status).toBe('pass');
    expect(pick(r.results, 'health')).toMatchObject({ status: 'pass' });
    expect(env.meta.calls.length).toBeGreaterThan(0); // a real call was made, not a guess from the database
    expect(pick(r.results, 'metrics').status).toBe('skip');
    expect(pick(r.results, 'comments').status).toBe('skip');
  });

  it('cannot open a token sealed with another key, and says the account has to be connected again', async () => {
    await env.db.query(`update social_account set token_encrypted = $2 where id = $1`, [fb, Buffer.from('not a sealed token at all, just bytes')]);
    const r = await checkAccount(env.ctx, fb);
    expect(pick(r.results, 'token')).toMatchObject({ status: 'fail' });
    expect(pick(r.results, 'token').detail).toMatch(/TOKEN_KEY/);
    expect(r.results.some((x) => x.id === 'health')).toBe(false); // nothing is asked of the network with a token that cannot be read
    // put it back for the other tests
    await env.db.query(`update social_account set token_encrypted = $2 where id = $1`, [fb, env.ctx.vault!.seal({ accessToken: 'page-token-111' }, `account:${fb}`)]);
  });

  it('warns when a token that cannot be renewed is about to run out, fails it when it has, and is calm about one that renews itself', async () => {
    const seal = async (id: string, t: Record<string, unknown>) =>
      env.db.query('update social_account set token_encrypted = $2, token_expires_at = $3 where id = $1', [id, env.ctx.vault!.seal(t, `account:${id}`), (t.expiresAt as string) ?? null]);
    const soon = new Date(Date.now() + 3 * DAY).toISOString();
    await seal(ig, { accessToken: 'page-token-111', expiresAt: soon });
    expect(pick((await checkAccount(env.ctx, ig)).results, 'token')).toMatchObject({ status: 'warn' });
    await seal(ig, { accessToken: 'page-token-111', expiresAt: new Date(Date.now() - DAY).toISOString() });
    expect(pick((await checkAccount(env.ctx, ig)).results, 'token')).toMatchObject({ status: 'fail' });
    await seal(ig, { accessToken: 'page-token-111', expiresAt: new Date(Date.now() + 40 * DAY).toISOString() });
    const calm = pick((await checkAccount(env.ctx, ig)).results, 'token');
    expect(calm.status).toBe('pass');
    expect(calm.detail).toMatch(/40 more days/);
    await seal(ig, { accessToken: 'page-token-111' });
    // YouTube's token renews by itself, so a short life is not a warning.
    const tok = (await env.db.one('select token_encrypted from social_account where id = $1', [yt]))!;
    const open = env.ctx.vault!.open<Record<string, unknown>>(tok.token_encrypted, `account:${yt}`);
    await seal(yt, { ...open, expiresAt: new Date(Date.now() + 2 * DAY).toISOString() });
    const renews = pick((await checkAccount(env.ctx, yt)).results, 'token');
    expect(renews.status).toBe('pass');
    expect(renews.detail).toMatch(/renews it by itself/);
  });

  it('compares what was granted with what the app needs, and asks for the messaging permissions only when prizes are on', async () => {
    await env.db.query(`update social_account set granted_permissions = $2 where id = $1`, [ig, JSON.stringify(['instagram_basic', 'instagram_content_publish'])]);
    const partial = pick((await checkAccount(env.ctx, ig)).results, 'scopes');
    expect(partial.status).toBe('warn');
    expect(partial.detail).toMatch(/Not granted: .*pages_manage_posts/);
    expect(partial.detail).not.toMatch(/instagram_manage_messages/);

    const { META_SCOPES, META_PRIZE_SCOPES } = await import('../src/connectors/meta/oauth.js');
    await env.db.query(`update social_account set granted_permissions = $2 where id = $1`, [ig, JSON.stringify([...META_SCOPES])]);
    expect(pick((await checkAccount(env.ctx, ig)).results, 'scopes').status).toBe('pass');

    await env.db.query(`update brand set prizes = '{"enabled":true,"retention_days":30}'`);
    const prizes = pick((await checkAccount(env.ctx, ig)).results, 'scopes');
    expect(prizes.status).toBe('warn');
    expect(prizes.detail).toContain('instagram_manage_messages');
    await env.db.query(`update social_account set granted_permissions = $2 where id = $1`, [ig, JSON.stringify([...META_SCOPES, ...META_PRIZE_SCOPES])]);
    expect(pick((await checkAccount(env.ctx, ig)).results, 'scopes').status).toBe('pass');
  });

  it('asks YouTube for the Analytics permission only when the deployment turned it on', async () => {
    const { GOOGLE_SCOPES, ANALYTICS_SCOPE } = await import('../src/connectors/google/oauth.js');
    await env.db.query(`update social_account set granted_permissions = $2 where id = $1`, [yt, JSON.stringify([...GOOGLE_SCOPES])]);
    expect(pick((await checkAccount(env.ctx, yt)).results, 'scopes').status).toBe('pass');

    const on = withConfig({ GOOGLE_ANALYTICS: true });
    const missing = pick((await checkAccount(on, yt)).results, 'scopes');
    expect(missing.status).toBe('warn');
    expect(missing.detail).toContain(ANALYTICS_SCOPE);
    await env.db.query(`update social_account set granted_permissions = $2 where id = $1`, [yt, JSON.stringify([...GOOGLE_SCOPES, ANALYTICS_SCOPE])]);
    expect(pick((await checkAccount(on, yt)).results, 'scopes').status).toBe('pass');
  });

  it('puts the network\'s own refusal in words a person can act on, by kind of failure', async () => {
    // The stand-in's paths have no version in front: the Instagram account itself is "222".
    const onHealth = (re: RegExp) => (c: { path: string }) => re.test(c.path);
    env.meta.fail(onHealth(/^222$/), env.meta.err(190, 'Error validating access token: Session has expired'), 401);
    const auth = pick((await checkAccount(env.ctx, ig)).results, 'health');
    expect(auth.status).toBe('fail');
    expect(auth.hint).toMatch(/connect the account again/i);

    env.meta.failures.length = 0;
    env.meta.fail(onHealth(/^222$/), env.meta.err(4, 'Application request limit reached'), 400);
    const limited = pick((await checkAccount(env.ctx, ig)).results, 'health');
    expect(limited.status).toBe('warn');
    expect(limited.hint).toMatch(/limiting this app/);

    env.meta.failures.length = 0;
    env.meta.fail(onHealth(/^222$/), { error: { message: 'Something went wrong', code: 2 } }, 500);
    const transient = pick((await checkAccount(env.ctx, ig)).results, 'health');
    expect(transient.status).toBe('warn');
    expect(transient.hint).toMatch(/outbound firewall|reach it/);

    env.meta.failures.length = 0;
    env.meta.fail(onHealth(/^222$/), env.meta.err(100, '(#100) Unsupported get request'), 400);
    const refused = pick((await checkAccount(env.ctx, ig)).results, 'health');
    expect(refused.status).toBe('fail');
    expect(refused.hint).toMatch(/transcript/);
  });
});

/** A post made by the worker, so there is something to read. (The same steps as metrics.test.ts.) */
async function published(account: string) {
  const { users, call: api, makePiece, newVersion, approve } = env;
  const { variantId } = await makePiece(users.producer, 'video', '9:16');
  const v = await newVersion(users.producer, variantId, [{ name: 'reel.mp4', mime: 'video/mp4', kind: 'video' }]);
  await approve(users.approver, v.body.id, [account]);
  const r = await api(users.approver, 'POST', `/api/versions/${v.body.id}/publications`, { accountId: account, scheduledAt: new Date(env.clock.now().getTime() + 2 * 60 * MIN).toISOString(), text: 'Our spring menu' });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  env.clock.set(new Date(r.body.prepare_at));
  await env.settle();
  env.clock.advance(11_000);
  await env.settle();
  env.clock.set(new Date(r.body.scheduled_at));
  await env.settle();
  env.clock.advance(60_000);
  await env.settle();
  return r.body.id as string;
}

describe('an account with a published post', () => {
  it('reads the post\'s numbers, and reads its comments only when prizes are on', async () => {
    const id = await published(ig);
    expect((await env.db.one('select status, visibility from publication where id = $1', [id]))).toMatchObject({ status: 'published', visibility: 'public' });
    const r = await checkAccount(env.ctx, ig);
    const m = pick(r.results, 'metrics');
    expect(m.status).toBe('pass');
    expect(m.detail).toMatch(/views 2000/);
    expect(m.hint).toMatch(/Compare these with what the network shows/);
    expect(pick(r.results, 'comments')).toMatchObject({ status: 'skip' });

    await env.db.query(`update brand set prizes = '{"enabled":true,"retention_days":30}'`);
    expect(pick((await checkAccount(env.ctx, ig)).results, 'comments')).toMatchObject({ status: 'pass', detail: '0 comments in the last 7 days.' });
    env.meta.commentFeed[(await env.db.one('select external_id from publication where id = $1', [id]))!.external_id] = [{ id: 'c1', text: 'hi', at: env.clock.now().getTime() - 1000, personId: 'u1', username: 'ana' }];
    expect(pick((await checkAccount(env.ctx, ig)).results, 'comments').detail).toBe('1 comment in the last 7 days.');
  });

  it('warns when the network answers with no numbers at all, and fails when it refuses to answer', async () => {
    // A connector whose network gives nothing back for the post.
    const real = env.ctx.connectors.connector('instagram')!;
    const quiet = { ...real, fetchMetrics: async () => ({ common: {}, raw: {}, note: 'Nothing yet.' }) };
    const ctx = { ...env.ctx, connectors: { ...env.ctx.connectors, connector: (n: string) => (n === 'instagram' ? quiet : env.ctx.connectors.connector(n as never)) } } as unknown as Ctx;
    const empty = pick((await checkAccount(ctx, ig)).results, 'metrics');
    expect(empty.status).toBe('warn');
    expect(empty.detail).toContain('Nothing yet.');
    expect(empty.hint).toMatch(/permission or a product/);

    env.meta.fail((c) => /insights/.test(c.path), env.meta.err(10, '(#10) Application does not have permission for this action'), 403);
    const refused = pick((await checkAccount(env.ctx, ig)).results, 'metrics');
    expect(refused.status).toBe('fail');
    expect(refused.detail).toMatch(/permission/);

    // A post that is gone from the network is not a disagreement about how to ask, and the hint says so.
    env.meta.failures.length = 0;
    env.meta.fail((c) => /insights/.test(c.path), env.meta.err(100, 'Object does not exist'), 400);
    const gone = pick((await checkAccount(env.ctx, ig)).results, 'metrics');
    expect(gone.status).toBe('fail');
    expect(gone.hint).toMatch(/deleted on the network/);
  });
});

describe('a real test post', () => {
  it('goes through the same steps the app uses, and reports each, and says the post has to be deleted by hand', async () => {
    const before = snapshot();
    const rs = await publishTest(env.ctx, ig, { pause: noWait });
    expect(rs.map((r) => [r.id, r.status])).toEqual([
      ['publish.input', 'pass'], ['publish.prepare', 'pass'], ['publish.publish', 'pass'], ['publish.verify', 'pass'], ['publish.cleanup', 'warn'],
    ]);
    expect(pick(rs, 'publish.cleanup').hint).toMatch(/delete it on the network yourself/);
    expect(pick(rs, 'publish.cleanup').detail).toMatch(/instagram/);
    const posted = fresh(before).media;
    expect(posted).toHaveLength(1);
    expect(posted[0]!.params.caption).toBe(TEST_TEXT);
    expect(posted[0]!.params.image_url).toMatch(/^http:\/\/media\.test\//); // fetched from the media address, which the server check vouches for
  });

  it('posts a picture to Facebook, and a video to YouTube (which takes no picture), and says a private upload is private', async () => {
    const before = snapshot();
    const f = await publishTest(env.ctx, fb, { pause: noWait });
    expect(pick(f, 'publish.publish').status).toBe('pass');
    expect(fresh(before).posts).toHaveLength(1);

    env.google.videos.clear();
    const y = await publishTest(env.ctx, yt, { pause: noWait });
    expect(pick(y, 'publish.input').detail).toMatch(/video/);
    expect(pick(y, 'publish.publish').status).toBe('pass');
    expect(env.google.videos.size).toBe(1);
    const v = pick(y, 'publish.verify');
    expect(v.status).toBe('warn'); // the project is not audited: private, which is expected and said so
    expect(v.detail).toMatch(/private/);
    expect(v.hint).toMatch(/approval flag/);
  });

  it('stops at the first failure and says what the network answered, never going on to the next step', async () => {
    const before = snapshot();
    env.meta.fail((c) => /\/media$/.test(c.path), env.meta.err(100, '(#100) Invalid parameter'), 400, 1);
    const rs = await publishTest(env.ctx, ig, { pause: noWait });
    const step = rs.find((r) => r.status === 'fail')!;
    expect(step.id).toBe('publish.prepare');
    expect(step.detail).toContain('Invalid parameter');
    expect(step.hint).toMatch(/transcript/);
    expect(rs.some((r) => r.id === 'publish.publish')).toBe(false);
    expect(rs.some((r) => r.id === 'publish.cleanup')).toBe(false); // nothing was posted, so nothing to delete
    expect(fresh(before).media).toHaveLength(0);
  });

  it('gives up waiting for a network that stays busy, instead of waiting for ever', async () => {
    const processing = env.meta.processingPolls;
    env.meta.processingPolls = 1_000_000;
    let t = env.clock.now().getTime();
    const rs = await publishTest({ ...env.ctx, now: () => new Date((t += 10_000)) } as Ctx, ig, { pause: noWait, waitSeconds: 60 });
    env.meta.processingPolls = processing;
    const r = pick(rs, 'publish.prepare');
    expect(r.status).toBe('fail');
    expect(r.detail).toMatch(/Still not ready after 60 seconds/);
  });
});

describe('the whole run', () => {
  it('checks the server and every connected account of a brand, by name or by id, and one network if asked', async () => {
    const byName = await runChecks(env.ctx, { brand: 'test brand' });
    expect(byName.brand.name).toBe('Test brand');
    expect(byName.server.length).toBeGreaterThan(3);
    expect(byName.accounts.map((a) => a.account.network).sort()).toEqual(['facebook', 'instagram', 'youtube']);
    const byId = await runChecks(env.ctx, { brand: byName.brand.id, network: 'youtube' });
    expect(byId.accounts.map((a) => a.account.network)).toEqual(['youtube']);
    await expect(runChecks(env.ctx, { brand: 'No such brand' })).rejects.toThrow(/not found/i);
  });

  it('does not post anything unless it is asked to, and posts to each account when it is', async () => {
    const before = snapshot();
    await runChecks(env.ctx, { brand: 'Test brand' });
    expect(fresh(before).media.length + fresh(before).posts.length).toBe(0);
    const labels: string[] = [];
    const run = await runChecks(env.ctx, { brand: 'Test brand', network: 'instagram', publish: true, onAccount: (l) => labels.push(l), publishOptions: { pause: noWait } });
    expect(labels).toEqual(['instagram: @lumen.coffee']);
    expect(fresh(before).media, JSON.stringify(run.accounts[0]!.results, null, 1)).toHaveLength(1);
    expect(run.accounts[0]!.results.some((r) => r.id === 'publish.cleanup')).toBe(true);
  });

  it('does not post to an account whose read-only checks failed', async () => {
    const before = snapshot();
    await env.db.query(`update social_account set status = 'reconnect_required' where id = $1`, [ig]);
    const run = await runChecks(env.ctx, { brand: 'Test brand', network: 'instagram', publish: true, publishOptions: { pause: noWait } });
    expect(run.ok).toBe(false);
    expect(run.accounts[0]!.results.some((r) => r.id.startsWith('publish.'))).toBe(false);
    expect(fresh(before).media).toHaveLength(0);
  });

  it('formats a report a person can read in a terminal, with the way out under each problem', async () => {
    const text = formatChecks([
      { id: 'a', status: 'pass', title: 'Fine', detail: 'All good.' },
      { id: 'b', status: 'fail', title: 'Broken', detail: 'It broke.', hint: 'Do this.' },
      { id: 'c', status: 'skip', title: 'Skipped', detail: 'Nothing to do.' },
    ]);
    expect(text).toBe('  ✔ Fine: All good.\n  ✖ Broken: It broke.\n      → Do this.\n  – Skipped: Nothing to do.');
  });
});

describe('what a run records for a bug report', () => {
  it('writes every call it made, with tokens, secrets and signed query strings removed', async () => {
    const seen: Exchange[] = [];
    setTap((e) => seen.push(e));
    await checkAccount(env.ctx, ig);
    await publishTest(env.ctx, ig, { pause: noWait });
    setTap(null);
    expect(seen.length).toBeGreaterThan(3);
    expect(seen.every((e) => typeof e.status === 'number' && e.ms >= 0 && e.method && e.url)).toBe(true);
    const all = JSON.stringify(seen);
    expect(all).not.toContain('page-token-111');
    expect(all).toContain('access_token=[removed]');
    // The request bodies and answers are there to compare with the stand-ins, so they have to be readable.
    expect(seen.some((e) => e.method === 'POST' && /media$/.test(e.url) && JSON.stringify(e.request).includes('caption'))).toBe(true);
    expect(seen.some((e) => e.response && JSON.stringify(e.response).includes('"id"'))).toBe(true);
  });

  it('leaves out query strings of addresses inside an answer (where a signature lives) and any secret by name, and cuts long bodies', async () => {
    const server: Server = createServer((req, res) => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({
        upload_url: 'https://upload.example.com/v2/abc?signature=SEKRET-SIG&expires=9', refresh_token: 'refresh-secret', plain: 'https://example.com/a',
        nested: { access_token: 'tok', list: ['https://x.example.com/p?sig=1'] }, long: 'x'.repeat(10_000),
      }));
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as { port: number }).port;
    const seen: Exchange[] = [];
    setTap((e) => seen.push(e));
    try {
      await call(`http://127.0.0.1:${port}/path`, { method: 'POST', json: { client_secret: 'shh', caption: 'hello' }, query: { access_token: 'URLTOKEN' } });
      await call(`http://127.0.0.1:${port}/file`, { method: 'PUT', body: Buffer.from('binary') as unknown as BodyInit });
    } finally {
      setTap(null);
      server.close();
    }
    const text = JSON.stringify(seen);
    for (const secret of ['SEKRET-SIG', 'refresh-secret', 'URLTOKEN', 'shh', '"tok"']) expect(text).not.toContain(secret);
    expect(text).toContain('upload.example.com/v2/abc?[query removed]');
    expect(text).toContain('https://example.com/a');
    expect(text).toContain('caption');
    expect(seen[0]!.response).toBeTruthy();
    expect(JSON.stringify(seen[0]!.response).length).toBeLessThan(7000);
    expect(seen[1]!.request).toBe('[a file or a stream]');
  });

  it('records a call that never got an answer, and records nothing once the tap is removed', async () => {
    const seen: Exchange[] = [];
    setTap((e) => seen.push(e));
    await expect(call('http://127.0.0.1:1/never', { timeoutMs: 2000 })).rejects.toThrow();
    setTap(null);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ status: null });
    expect(seen[0]!.error).toMatch(/could not connect|timed out/);
    await call('http://127.0.0.1:1/never', { timeoutMs: 1000 }).catch(() => {});
    expect(seen).toHaveLength(1);
  });
});

describe('from the screen', () => {
  const brandUrl = (p: string) => `/api/brands/${env.brandId}${p}`;
  it('lets an admin run an account\'s read-only checks and the server\'s, and no one else, and keeps a count of the result', async () => {
    const r = await env.call(env.users.admin, 'POST', brandUrl(`/accounts/${ig}/check`));
    expect(r.status).toBe(200);
    expect(r.body.account).toMatchObject({ id: ig, network: 'instagram' });
    expect(r.body.results.find((x: CheckResult) => x.id === 'health').status).toBe('pass');
    const server = await env.call(env.users.admin, 'GET', brandUrl('/server-check'));
    expect(server.status).toBe(200);
    expect(server.body.some((x: CheckResult) => x.id === 'token_key')).toBe(true);

    for (const who of [env.users.approver, env.users.producer, env.users.reader]) {
      expect((await env.call(who, 'POST', brandUrl(`/accounts/${ig}/check`))).status).toBe(403);
      expect((await env.call(who, 'GET', brandUrl('/server-check'))).status).toBe(403);
    }
    expect((await env.call(null, 'GET', brandUrl('/server-check'))).status).toBe(401);
    const ev = await env.db.one(`select after from audit_event where action = 'account.checked' and entity_id = $1 order by id desc limit 1`, [ig]);
    expect(Object.keys(ev!.after).sort()).toEqual(['fail', 'pass', 'warn']);
  });

  it('does not check an account of another brand', async () => {
    const w = (await env.db.one('select id from workspace limit 1'))!;
    const other = (await env.db.one(`insert into brand (workspace_id, name, timezone) values ($1,'Other brand','Europe/Madrid') returning id`, [w.id]))!;
    const acc = (await env.db.one(`insert into social_account (brand_id, network, external_id, display_name) values ($1,'instagram','x','x') returning id`, [other.id]))!;
    expect((await env.call(env.users.admin, 'POST', brandUrl(`/accounts/${acc.id}/check`))).status).toBe(404);
  });

  it('never posts: there is no way to ask for a test post from the screen', async () => {
    const before = snapshot();
    const r = await env.call(env.users.admin, 'POST', brandUrl(`/accounts/${ig}/check`), { publish: true, yes: true });
    expect(r.status).toBe(200);
    expect(r.body.results.some((x: CheckResult) => x.id.startsWith('publish.'))).toBe(false);
    expect(fresh(before).media).toHaveLength(0);
  });
});

describe('the command', () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const cli = path.join(here, '../src/cli.ts');
  const run = (args: string[]) => new Promise<{ code: number | null; out: string; err: string }>((resolve) => {
    const p = spawn(process.execPath, ['--import', 'tsx', cli, ...args], {
      cwd: path.join(here, '..'),
      env: {
        ...process.env, NODE_ENV: 'test', SECRET: env.ctx.config.SECRET, DATABASE_URL: env.ctx.config.DATABASE_URL, TOKEN_KEY: env.ctx.config.TOKEN_KEY!,
        APP_URL: 'https://studio.example.com', MEDIA_URL: 'https://media.example.com', STORAGE_LOCAL_DIR: env.ctx.config.STORAGE_LOCAL_DIR,
        META_APP_ID: 'app', META_APP_SECRET: 'secret', META_GRAPH_URL: env.meta.url, META_OAUTH_URL: env.meta.url,
      },
    });
    let out = '', err = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { err += d; });
    p.on('close', (code) => resolve({ code, out, err }));
  });

  it('prints the server and each account, exits 0 when nothing failed, and 1 when something did', async () => {
    const good = await run(['check', '--brand', 'Test brand', '--network', 'instagram']);
    expect(good.err).toBe('');
    expect(good.code).toBe(0);
    expect(good.out).toContain('Checking Test brand');
    expect(good.out).toContain('✔ Network accepts the connection');
    expect(good.out).toContain('Nothing failed.');
    await env.db.query(`update social_account set status = 'reconnect_required', last_error = 'Revoked' where id = $1`, [ig]);
    const bad = await run(['check', '--brand', 'Test brand', '--network', 'instagram']);
    expect(bad.code).toBe(1);
    expect(bad.out).toContain('✖ Connection');
    expect(bad.out).toMatch(/→ Connect the account again/);
  }, 60_000);

  it('prints a report as JSON, and refuses to post without --yes', async () => {
    const json = await run(['check', '--brand', 'Test brand', '--network', 'facebook', '--json']);
    const parsed = JSON.parse(json.out);
    expect(parsed.brand.name).toBe('Test brand');
    expect(parsed.accounts).toHaveLength(1);
    const before = snapshot();
    const refused = await run(['check', '--brand', 'Test brand', '--network', 'facebook', '--publish']);
    expect(refused.code).toBe(1);
    expect(refused.err).toMatch(/Add --yes to say you mean it/);
    expect(fresh(before).posts).toHaveLength(0);
  }, 60_000);
});
