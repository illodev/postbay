// End-to-end check of phase 5 against FAKE services: the second factor, single sign-on, Slack, push messages, subtitle comments, big
// uploads that are interrupted and resumed, and the readiness checks, all through the real UI, with the real worker, real ffmpeg,
// real PostgreSQL and a real browser.
//
// What this proves: the app's own behaviour end to end. What it cannot prove: that a real identity provider, Slack, a real push service
// (Chrome's, Firefox's, Apple's) or a real network behave like the stand-ins in apps/api/test/fakes (written from their documentation;
// nothing here reaches a real service). In particular the browser's push API is REPLACED here by a recorder: Chromium cannot reach a real
// push service from this machine, so what is proven is that the studio asks for, stores and uses a subscription, and that what it sends
// decrypts with that subscription's keys. See docs/phase-5.md.
//
// Needs the API running against e2e/fakes.mts with FAKES_ACCESS=1 and SECOND_FACTOR_REQUIRED=true (e2e/phase5.sh does it all), on an EMPTY
// database that has only been bootstrapped. Environment: BASE_URL, FAKES_URL, ASSETS, SHOTS, DATABASE_URL (psql URI), STAGING_DIR, CHROMIUM,
// E2E_SLACK_URL.
import { chromium } from 'playwright-core';
import { createHmac } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const BASE = process.env.BASE_URL ?? 'http://localhost:3500';
const FAKES = process.env.FAKES_URL ?? 'http://127.0.0.1:4050';
const ASSETS = process.env.ASSETS ?? path.resolve('e2e/assets');
const SHOTS = process.env.SHOTS ?? path.resolve('e2e/shots-phase5');
const DB = process.env.DATABASE_URL ?? 'postgres://postgres@localhost:5433/estudio_e2e_phase5';
const STAGING = process.env.STAGING_DIR ?? '';
const SLACK_URL = process.env.E2E_SLACK_URL;
const CHUNK = 8 * 1024 * 1024;
mkdirSync(SHOTS, { recursive: true });

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM ?? '/opt/pw-browsers/chromium', args: ['--no-sandbox', '--disable-background-networking', '--no-first-run'] });
const problems = [];
let n = 0;

const watch = (page, label) => {
  page.on('pageerror', (e) => problems.push(`[${label}] page error: ${e.message}`));
  page.on('console', (m) => m.type() === 'error' && !/status of (4\d\d|5\d\d)|Failed to load resource|net::ERR/.test(m.text()) && problems.push(`[${label}] console error: ${m.text()}`));
};

async function context(label, { viewport = { width: 1280, height: 900 }, init, permissions } = {}) {
  const ctx = await browser.newContext({ baseURL: BASE, locale: 'en-US', viewport, acceptDownloads: true, permissions });
  if (init) await ctx.addInitScript(init.fn, init.arg);
  const page = await ctx.newPage();
  watch(page, label);
  return { context: ctx, page };
}

/** Signs in with the development sign-in. The page that follows is the list of pieces, or the second step if the person's role needs one. */
async function signIn(email, opts = {}) {
  const s = await context(email, opts);
  await s.page.goto('/login');
  await s.page.getByLabel('Email').fill(email);
  await s.page.getByRole('button', { name: /Development sign-in/ }).click();
  await s.page.waitForURL(/\/(pieces|second-factor)$/);
  return s;
}

const shot = (page, name) => page.screenshot({ path: path.join(SHOTS, `${String(++n).padStart(2, '0')}-${name}.png`) });

async function step(name, fn) {
  const t0 = Date.now();
  try {
    await fn();
    console.log(`ok   ${name} (${Date.now() - t0} ms)`);
  } catch (err) {
    console.log(`FAIL ${name}\n     ${err.message.split('\n').join('\n     ')}`);
    problems.push(`${name}: ${err.message}`);
  }
}

const assert = (cond, msg) => { if (!cond) throw new Error(msg); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sql = (q) => execFileSync('psql', [DB, '-tA', '-c', q], { stdio: 'pipe' }).toString().trim();
const fakes = {
  state: async () => (await fetch(`${FAKES}/__state`)).json(),
  control: async (body) => (await fetch(`${FAKES}/__control`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })).json(),
};

/** Polls until check() is true (or returns a truthy non-true value to say what it saw). */
async function until(what, check, timeoutMs = 60_000) {
  const t0 = Date.now();
  let last = '';
  while (Date.now() - t0 < timeoutMs) {
    try {
      const r = await check();
      if (r === true) return;
      last = String(r);
    } catch (e) { last = e.message; }
    await sleep(700);
  }
  throw new Error(`Timed out waiting for ${what}. Last seen: ${last}`);
}

// ───────────────────────────── an authenticator app, written here (not borrowed from the app) ─────────────────────────────
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function base32Decode(text) {
  let bits = '';
  for (const ch of text.replace(/\s|=/g, '').toUpperCase()) bits += B32.indexOf(ch).toString(2).padStart(5, '0');
  const bytes = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(bytes);
}
const stepNow = () => Math.floor(Date.now() / 30_000);
function codeFor(secret, step) {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const h = createHmac('sha1', base32Decode(secret)).update(counter).digest();
  const o = h[h.length - 1] & 0xf;
  const bin = ((h[o] & 0x7f) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3];
  return String(bin % 1_000_000).padStart(6, '0');
}
const authenticators = new Map(); // email -> { secret, last }
/** A code the server has not seen yet: the app never accepts a step twice, so the next one is used, and when it is not valid yet, we wait. */
async function freshCode(email) {
  const a = authenticators.get(email);
  for (;;) {
    const step = Math.max(a.last + 1, stepNow() - 1);
    if (step <= stepNow() + 1) { a.last = step; return codeFor(a.secret, step); }
    await sleep(1000);
  }
}

/** On the page that asks for a second factor to be set up: does it, and keeps the secret and the recovery codes. */
async function enrol(page, email) {
  const box = page.getByTestId('second-factor');
  await box.waitFor();
  assert((await box.getAttribute('data-step')) === 'enroll', `expected the enrolment step, got ${await box.getAttribute('data-step')}`);
  await page.getByRole('button', { name: 'Set up an authenticator' }).click();
  const secret = (await page.getByTestId('secret').innerText()).replace(/\s/g, '');
  const step = stepNow();
  authenticators.set(email, { secret, last: step });
  await shot(page, `enrol-${email.split('@')[0]}`);
  await page.getByLabel('Code from the app').fill(codeFor(secret, step));
  await page.getByRole('button', { name: 'Check the code' }).click();
  const codes = page.getByTestId('recovery-codes');
  await codes.waitFor();
  const list = (await codes.locator('pre').innerText()).split('\n').map((c) => c.trim()).filter(Boolean);
  assert(list.length === 10, `ten recovery codes expected, got ${list.length}`);
  assert((await page.getByRole('button', { name: 'Continue' }).isDisabled()), 'Continue must wait until the codes are confirmed as saved');
  await page.getByLabel('I have put them somewhere safe').check();
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.waitForURL(/\/pieces$/);
  return list;
}

async function asksForCode(page) {
  const box = page.getByTestId('second-factor');
  await box.waitFor();
  assert((await box.getAttribute('data-step')) === 'verify', `expected the code step, got ${await box.getAttribute('data-step')}`);
}
async function giveCode(page, code, { recovery = false } = {}) {
  if (recovery) await page.getByRole('button', { name: /I lost my phone/ }).click();
  await page.getByLabel(recovery ? 'Recovery code' : 'Code from your authenticator app').fill(code);
  await page.getByRole('button', { name: 'Continue' }).click();
}

const state = { recovery: {} };

// ───────────────────────────── seed ─────────────────────────────
// The first sign-in of the person bootstrapped as admin is also the first time a second factor is asked of anybody.
const admin = await signIn('admin@example.com');
const api = (method, url, data) => admin.context.request.fetch(url, { method, data, headers: { 'x-requested-by': 'studio', 'accept-language': 'en' } });

await step('seed: the fake services start blank, and the admin is made to set up a second factor before anything else', async () => {
  await fakes.control({ op: 'reset' });
  const p = admin.page;
  assert(/\/second-factor$/.test(p.url()), `an admin should be sent to set up a second factor, but is at ${p.url()}`);
  // Nothing else is reachable while it is pending.
  const blocked = await api('GET', '/api/me');
  assert(blocked.status() === 403 || blocked.status() === 401, `/api/me should refuse a session that has not done its second step, got ${blocked.status()}`);
  assert((await (await api('GET', '/api/auth/state')).json()).secondFactor === 'enroll', 'the state endpoint should say a second factor has to be set up');
});

await step('second factor: setting it up shows the key and ten recovery codes once, then lets the admin in', async () => {
  state.recovery.admin = await enrol(admin.page, 'admin@example.com');
  const me = await (await api('GET', '/api/me')).json();
  state.brandId = me.brands[0].id;
  await shot(admin.page, 'signed-in-after-enrolment');
  assert(sql(`select count(*) from user_totp where confirmed_at is not null`) === '1', 'the authenticator should be stored');
  assert(sql(`select count(*) from recovery_code where used_at is null`) === '10', 'ten unused recovery codes expected');
  const secretRow = sql(`select position(convert_to('${authenticators.get('admin@example.com').secret}', 'UTF8') in secret_sealed) from user_totp`);
  assert(secretRow === '0', 'the authenticator secret is stored in the clear');
  const codeRow = sql(`select count(*) from recovery_code where code_hash = '${state.recovery.admin[0]}'`);
  assert(codeRow === '0', 'a recovery code is stored in the clear');
});

for (const [email, name, role] of [['approver@example.com', 'Ana Approver', 'approver'], ['producer@example.com', 'Paula Producer', 'producer'], ['reviewer@example.com', 'Rita Reviewer', 'reviewer'], ['sso.person@example.com', 'Sol Sso', 'reviewer']]) {
  await step(`seed: ${email} joins as ${role}`, async () => {
    const r = await api('POST', `/api/brands/${state.brandId}/members`, { email, name, role });
    assert(r.ok(), `adding ${email}: ${r.status()}`);
  });
}

await step('second factor: a wrong code, then a code that was already used, are refused; the next code works', async () => {
  const s = await signIn('admin@example.com');
  await asksForCode(s.page);
  await giveCode(s.page, '000000');
  await s.page.getByText('That code is not right').waitFor();
  await shot(s.page, 'wrong-code');
  // The code the admin used to set it up a moment ago: right for this moment, but spent.
  const spent = codeFor(authenticators.get('admin@example.com').secret, authenticators.get('admin@example.com').last);
  await s.page.getByLabel('Code from your authenticator app').fill(spent);
  await s.page.getByRole('button', { name: 'Continue' }).click();
  await s.page.getByText('That code is not right').waitFor();
  assert(/\/second-factor$/.test(s.page.url()), 'a spent code must not sign anyone in');
  await s.page.getByLabel('Code from your authenticator app').fill(await freshCode('admin@example.com'));
  await s.page.getByRole('button', { name: 'Continue' }).click();
  await s.page.waitForURL(/\/pieces$/);
  await s.context.close();
});

await step('second factor: a recovery code signs in once, and the same code again does not', async () => {
  const code = state.recovery.admin[0];
  const s = await signIn('admin@example.com');
  await asksForCode(s.page);
  await giveCode(s.page, code, { recovery: true });
  await s.page.waitForURL(/\/pieces$/);
  assert(sql(`select count(*) from recovery_code where used_at is null`) === '9', 'a used recovery code should be spent');
  await s.context.close();
  const again = await signIn('admin@example.com');
  await asksForCode(again.page);
  await giveCode(again.page, code, { recovery: true });
  await again.page.getByText(/not right/).waitFor();
  assert(/\/second-factor$/.test(again.page.url()), 'a spent recovery code must not sign anyone in');
  await again.context.close();
});

await step('second factor: five wrong codes lock the approver out, an admin resets the authenticator, and the approver sets up a new one', async () => {
  // The code endpoints allow ten tries a minute per address, and the steps above used some: wait for the window to clear, or the lock is not
  // what is seen here (and, incidentally, that limit is what stops a script from guessing six digits).
  await sleep(62_000);
  const appr = await signIn('approver@example.com');
  state.approver = appr;
  state.recovery.approver = await enrol(appr.page, 'approver@example.com');
  await appr.context.close();
  const s = await signIn('approver@example.com');
  await asksForCode(s.page);
  for (let i = 0; i < 5; i++) {
    await giveCode(s.page, String(100000 + i));
    await s.page.getByText(/not right|Too many wrong codes/).first().waitFor();
  }
  // Even the right code is refused during the lock.
  await s.page.getByLabel('Code from your authenticator app').fill(await freshCode('approver@example.com'));
  await s.page.getByRole('button', { name: 'Continue' }).click();
  await s.page.getByText(/Too many wrong codes/).waitFor();
  await shot(s.page, 'locked-out');
  assert(/\/second-factor$/.test(s.page.url()), 'a locked-out person must not get in');

  const a = admin.page;
  await a.goto('/settings?tab=members');
  const row = a.locator('tr', { hasText: 'approver@example.com' });
  await row.waitFor();
  a.once('dialog', (d) => d.accept());
  await row.getByRole('button', { name: 'Reset authenticator' }).click();
  await until('the approver to have no authenticator', () => sql(`select count(*) from user_totp sf join app_user u on u.id = sf.user_id where u.email = 'approver@example.com'`) === '0');
  await a.reload();
  assert((await a.locator('tr', { hasText: 'approver@example.com' }).getByRole('button', { name: 'Reset authenticator' }).count()) === 0, 'nobody to reset any more');

  // A reset ends every session of the person (and voids any sign-in link not used yet): the session that was locked out is signed
  // out, and signing in again asks for a new authenticator to be set up.
  const me = await s.context.request.get('/api/me', { headers: { 'accept-language': 'en' } });
  assert(me.status() === 401, `the locked-out session should have been ended by the reset, got ${me.status()}`);
  await s.page.goto('/login');
  await s.page.getByLabel('Email').fill('approver@example.com');
  await s.page.getByRole('button', { name: /Development sign-in/ }).click();
  await s.page.waitForURL(/\/second-factor$/);
  const box = s.page.getByTestId('second-factor');
  await box.waitFor();
  assert((await box.getAttribute('data-step')) === 'enroll', 'after a reset the approver has to set up a new authenticator');
  authenticators.delete('approver@example.com');
  state.recovery.approver = await enrol(s.page, 'approver@example.com');
  state.approver = s;
  await shot(s.page, 'approver-after-reset');
  assert(sql(`select count(*) from audit_event where action = 'user.second_factor_reset'`) === '1', 'the reset should be in the audit log');
});

await step('your account: the authenticator is on, recovery codes are counted, and removing it needs a code', async () => {
  const p = admin.page;
  await p.goto('/security');
  await p.getByRole('heading', { name: 'Your account' }).waitFor();
  await p.getByRole('heading', { name: 'Authenticator app' }).waitFor();
  await p.getByText('You have 9 recovery codes left').waitFor();
  await p.getByText(/Your role needs a second factor, so it cannot be turned off/).waitFor();
  await shot(p, 'your-account');
  // Making new recovery codes asks for a current code and makes the old ones useless.
  await p.getByRole('button', { name: 'Make new recovery codes' }).click();
  await p.getByLabel('Code from your app').fill(await freshCode('admin@example.com'));
  await p.locator('form').getByRole('button', { name: 'Make new recovery codes' }).click();
  const codes = p.getByTestId('recovery-codes');
  await codes.waitFor();
  const fresh = (await codes.locator('pre').innerText()).split('\n').map((c) => c.trim()).filter(Boolean);
  assert(fresh.length === 10 && fresh.every((c) => !state.recovery.admin.includes(c)), 'ten new codes, none of the old ones');
  await p.getByLabel('I have put them somewhere safe').check();
  await p.getByRole('button', { name: 'I have saved them' }).click();
  await p.getByText('You have 10 recovery codes left').waitFor();
  state.recovery.admin = fresh;
});

// ───────────────────────────── single sign-on ─────────────────────────────
await step('single sign-on: the login page offers it, and a person who exists is signed in, with no account made for strangers', async () => {
  await fakes.control({ op: 'oidc.claims', claims: { sub: 'sub-sol', email: 'sso.person@example.com', name: 'Sol Sso' } });
  const s = await context('sso');
  await s.page.goto('/login');
  const button = s.page.getByRole('link', { name: 'Sign in with Test identity provider' });
  await button.waitFor();
  await shot(s.page, 'login-with-sso');
  await button.click();
  await s.page.waitForURL(/\/pieces$/, { timeout: 20_000 });
  const me = await (await s.context.request.get('/api/me')).json();
  assert(me.user.email === 'sso.person@example.com', `signed in as ${me.user.email}`);
  assert(sql(`select count(*) from user_identity where subject = 'sub-sol'`) === '1', 'the identity should be linked by issuer and subject');
  await s.context.close();
  // A person nobody added: refused, and no account is made.
  for (const [claims, error, text] of [
    [{ sub: 'sub-nobody', email: 'nobody@example.com', name: 'Nobody' }, 'no_account', /There is no account here for that email yet/],
    [{ sub: 'sub-evil', email: 'someone@evil.test', name: 'Evil' }, 'domain', /not one of the accounts allowed/],
  ]) {
    await fakes.control({ op: 'oidc.claims', claims });
    const t = await context('sso-refused');
    await t.page.goto('/login');
    await t.page.getByRole('link', { name: 'Sign in with Test identity provider' }).click();
    await t.page.waitForURL(new RegExp(`/login\\?error=${error}`));
    await t.page.getByText(text).waitFor();
    if (error === 'no_account') await shot(t.page, 'sso-no-account');
    await t.context.close();
  }
  assert(sql(`select count(*) from app_user where email in ('nobody@example.com', 'someone@evil.test')`) === '0', 'single sign-on must not create people');
});

await step('single sign-on: an admin who signs in this way is still asked for the authenticator; a tampered token is refused', async () => {
  await fakes.control({ op: 'oidc.claims', claims: { sub: 'sub-admin', email: 'admin@example.com', name: 'Admin' } });
  const s = await context('sso-admin');
  await s.page.goto('/login');
  await s.page.getByRole('link', { name: 'Sign in with Test identity provider' }).click();
  await s.page.waitForURL(/\/(second-factor|pieces|login\?error=.*)$/, { timeout: 20_000 });
  assert(/\/second-factor$/.test(s.page.url()), `an admin signing in with single sign-on should be asked for the authenticator, but is at ${s.page.url()}`);
  await asksForCode(s.page);
  await s.page.getByLabel('Code from your authenticator app').fill(await freshCode('admin@example.com'));
  await s.page.getByRole('button', { name: 'Continue' }).click();
  await s.page.waitForURL(/\/pieces$/);
  await s.context.close();

  await fakes.control({ op: 'oidc.claims', claims: { sub: 'sub-admin', email: 'admin@example.com' }, tamper: { audience: 'another-app' } });
  const t = await context('sso-tampered');
  await t.page.goto('/login');
  await t.page.getByRole('link', { name: 'Sign in with Test identity provider' }).click();
  await t.page.waitForURL(/\/login\?error=/);
  await t.page.getByText(/could not accept/).waitFor();
  assert((await t.context.request.get('/api/me')).status() === 401, 'a token for another app must not sign anyone in');
  await t.context.close();
  await fakes.control({ op: 'oidc.claims', claims: {}, tamper: {} });
});

// ───────────────────────────── producing, for what follows ─────────────────────────────
async function createPiece(page, title) {
  await page.goto('/pieces');
  await page.getByRole('button', { name: 'New piece' }).click();
  const d = page.getByRole('dialog');
  await d.getByLabel('Title').fill(title);
  await d.getByRole('button', { name: 'Create piece' }).click();
  await page.waitForURL(/\/pieces\/[0-9a-f-]{36}$/);
  const id = page.url().split('/').pop();
  await page.getByRole('button', { name: 'Add variant' }).first().click();
  await page.getByRole('dialog').getByRole('button', { name: 'Add variant' }).click();
  await page.getByRole('button', { name: /Upload (first|new) version/ }).waitFor();
  return id;
}
async function uploadVersion(page, files, { timeout = 60_000 } = {}) {
  await page.getByRole('button', { name: /Upload (first|new) version/ }).first().click();
  const d = page.getByRole('dialog');
  await d.locator('input[type=file]').setInputFiles(files.map((f) => path.join(ASSETS, f)));
  await d.getByRole('button', { name: 'Upload and send to review' }).click();
  await page.getByText('Version uploaded and sent to review').waitFor({ timeout });
}

const producer = await signIn('producer@example.com');
const reviewer = await signIn('reviewer@example.com');

// ───────────────────────────── Slack ─────────────────────────────
await step('slack: an address that is not Slack\'s is refused, and the right one is sealed and shown only by its end', async () => {
  const p = admin.page;
  await p.goto('/settings?tab=notifications');
  const card = p.getByRole('form', { name: 'Slack' });
  await card.waitFor();
  await card.getByLabel('Webhook address').fill('http://127.0.0.1:1/services/T1/B1/elsewhere');
  await card.getByRole('button', { name: 'Save' }).click();
  await card.getByText(/not a Slack webhook address/).waitFor();
  await card.getByLabel('Webhook address').fill(SLACK_URL);
  await card.getByRole('button', { name: 'Save' }).click();
  await card.getByText('On · …1234').waitFor();
  await shot(p, 'slack-settings');
  const text = await (await api('GET', `/api/brands/${state.brandId}/slack`)).text();
  assert(!text.includes('e2eSecretToken'), 'the webhook address must never be sent back to the browser');
  assert(sql(`select position(convert_to('e2eSecretToken', 'UTF8') in url_sealed) from slack_hook`) === '0', 'the webhook address is stored in the clear');
});

await step('slack: the test message arrives, and a new version is posted once for the team', async () => {
  const p = admin.page;
  await p.getByRole('button', { name: 'Send a test message' }).click();
  await p.getByText(/Sent: look in the channel/).waitFor();
  await until('the test message in Slack', async () => (await fakes.state()).slack.some((m) => /test message/.test(m.text)));
  state.pieceId = await createPiece(producer.page, 'Spring menu reel');
  await uploadVersion(producer.page, ['reel-v1.webm']);
  await until('the new version in Slack', async () => (await fakes.state()).slack.filter((m) => /new version is ready for review/i.test(m.text)).length >= 1, 40_000);
  await sleep(4000); // a few more ticks: it must not be posted again
  const posts = (await fakes.state()).slack.filter((m) => /new version is ready for review/i.test(m.text));
  assert(posts.length === 1, `one post for the team, not one per person: ${posts.length}`);
  assert(/Lumen|Brand|\*/.test(posts[0].text) && posts[0].text.includes(`${BASE}/pieces/${state.pieceId}`), `the post should name the brand and link to the piece: ${posts[0].text}`);
  assert(posts[0].path.endsWith('e2eSecretToken1234'), 'posted to the address that was given');
});

await step('slack: when Slack says the address is gone, posting stops and the admin is told', async () => {
  await fakes.control({ op: 'slack.gone', path: new URL(SLACK_URL).pathname });
  await uploadVersion(producer.page, ['reel-v2.webm']);
  const p = admin.page;
  await until('Slack to be stopped', () => sql(`select coalesce(disabled_reason, '') from slack_hook`) !== '', 40_000);
  await p.goto('/settings?tab=notifications');
  await p.getByRole('alert').filter({ hasText: 'Slack stopped taking messages' }).waitFor();
  await p.getByText('Stopped', { exact: true }).waitFor();
  await shot(p, 'slack-stopped');
  assert(sql(`select count(*) from notification n join app_user u on u.id = n.user_id where n.kind = 'slack.failing' and u.email = 'admin@example.com'`) === '1', 'the admin should be told once');
  // Nothing more is posted while it is stopped.
  const before = (await fakes.state()).slack.length;
  await sleep(5000);
  assert((await fakes.state()).slack.length === before, 'nothing is posted at a stopped address');
  // A new address starts it again.
  const card = p.getByRole('form', { name: 'Slack' });
  await card.getByLabel(/Replace the webhook address/).fill(SLACK_URL.replace('e2eSecretToken1234', 'newToken5678'));
  await card.getByRole('button', { name: 'Save' }).click();
  await card.getByText('On · …5678').waitFor();
  await card.getByRole('button', { name: 'Send a test message' }).click();
  await until('a message at the new address', async () => (await fakes.state()).slack.some((m) => m.path.endsWith('newToken5678')));
});

// ───────────────────────────── push ─────────────────────────────
const PUSH_STUB = {
  // Chromium here cannot reach a real push service, so the browser's own subscribe is replaced by one that hands out a subscription the
  // test controls (it knows its keys, so it can read what is sent). Everything else the page does is the real thing, service worker included.
  fn: (sub) => {
    const key = 'e2e.push';
    const make = () => ({
      endpoint: sub.endpoint,
      toJSON: () => ({ endpoint: sub.endpoint, expirationTime: null, keys: sub.keys }),
      unsubscribe: async () => { localStorage.removeItem(key); return true; },
    });
    PushManager.prototype.subscribe = async function () { localStorage.setItem(key, '1'); return make(); };
    PushManager.prototype.getSubscription = async function () { return localStorage.getItem(key) ? make() : null; };
  },
};
await step('push: a person turns it on in their browser, sends a test, and what arrives decrypts with that browser\'s own keys', async () => {
  const { subscription } = await fakes.control({ op: 'push.browser', name: 'admin-laptop' });
  const pushed = await signIn('admin@example.com', { init: { fn: PUSH_STUB.fn, arg: subscription }, permissions: ['notifications'] });
  state.pushSession = pushed;
  await asksForCode(pushed.page);
  await pushed.page.getByLabel('Code from your authenticator app').fill(await freshCode('admin@example.com'));
  await pushed.page.getByRole('button', { name: 'Continue' }).click();
  await pushed.page.waitForURL(/\/pieces$/);
  const p = pushed.page;
  await p.goto('/security');
  const here = p.getByTestId('push-here');
  await here.getByText('Off.').waitFor();
  await here.getByRole('button', { name: 'Turn on here' }).click();
  await p.getByText('Push is on in this browser').waitFor();
  await here.getByText(/On\./).waitFor();
  assert(sql(`select count(*) from push_subscription`) === '1', 'the subscription should be stored');
  assert(sql(`select endpoint from push_subscription`) === subscription.endpoint, 'the stored address is the browser\'s');
  await here.getByRole('button', { name: 'Send a test' }).click();
  await p.getByText(/Sent to 1 browser/).waitFor();
  await shot(p, 'push-on');
  const { messages } = await fakes.control({ op: 'push.messages', name: 'admin-laptop' });
  assert(messages.length === 1 && messages[0].title === 'Content Studio' && /Push messages work/.test(messages[0].body), `the test message: ${JSON.stringify(messages)}`);
  assert((await fakes.state()).push.problems.length === 0, `the push service refused something: ${(await fakes.state()).push.problems.join('; ')}`);
});

await step('push: a new version is pushed to a person who wants it, and not to one who turned that kind off', async () => {
  await uploadVersion(producer.page, ['reel-v1.webm']);
  await until('the push', async () => {
    const { messages } = await fakes.control({ op: 'push.messages', name: 'admin-laptop' });
    return messages.some((m) => /A new version is ready for review/.test(m.title)) || JSON.stringify(messages);
  }, 40_000);
  const { messages } = await fakes.control({ op: 'push.messages', name: 'admin-laptop' });
  const m = messages.find((x) => /A new version is ready for review/.test(x.title));
  assert(m.title.startsWith('[Lumen Coffee]') && m.url.includes('/pieces/'), `the pushed message: ${JSON.stringify(m)}`);

  const p = state.pushSession.page;
  await p.goto('/security');
  await p.getByLabel('Push: A new version is ready for review').uncheck();
  await p.getByRole('button', { name: 'Save' }).click();
  await p.getByText('Saved', { exact: true }).waitFor();
  const before = (await fakes.control({ op: 'push.messages', name: 'admin-laptop' })).messages.length;
  const bell = () => Number(sql(`select count(*) from notification n join app_user u on u.id = n.user_id where n.kind = 'version.uploaded' and u.email = 'admin@example.com'`));
  const inBell = bell();
  await uploadVersion(producer.page, ['reel-v2.webm']);
  await until('the bell to hold it', () => bell() === inBell + 1, 30_000);
  await sleep(6000);
  assert((await fakes.control({ op: 'push.messages', name: 'admin-laptop' })).messages.length === before, 'a kind that was turned off must not be pushed');
});

await step('push: turning it off in this browser forgets it, and a browser the push service says is gone is forgotten too', async () => {
  const p = state.pushSession.page;
  await p.goto('/security');
  const here = p.getByTestId('push-here');
  await here.getByRole('button', { name: 'Turn off here' }).click();
  await p.getByText('Push is off in this browser').waitFor();
  await until('the subscription to go', () => sql(`select count(*) from push_subscription`) === '0');
  await until('the test button to go', async () => (await here.getByRole('button', { name: 'Send a test' }).count()) === 0, 10_000);
  // Another browser, this time one that the push service has stopped knowing.
  const { subscription } = await fakes.control({ op: 'push.browser', name: 'old-phone' });
  const r = await api('POST', '/api/push/subscriptions', { ...subscription, userAgent: 'old phone' });
  assert(r.ok(), `subscribing a second browser: ${r.status()}`);
  await fakes.control({ op: 'push.gone', name: 'old-phone' });
  const test = await (await api('POST', '/api/push/test')).json();
  assert(test.devices === 1 && test.reached === 0, `the test should reach nobody: ${JSON.stringify(test)}`);
  assert(sql(`select count(*) from push_subscription`) === '0', 'a subscription the push service calls gone is deleted');
  await state.pushSession.context.close();
});

// ───────────────────────────── subtitles ─────────────────────────────
await step('subtitles: the lines sit beside the video, the one being said is marked, and a comment can be written on one', async () => {
  const pid = await createPiece(producer.page, 'Reel with captions');
  state.captionsPiece = pid;
  await uploadVersion(producer.page, ['reel-v1.webm', 'captions.vtt']);
  const p = reviewer.page;
  await p.goto(`/pieces/${pid}`);
  await p.getByRole('link', { name: 'Review', exact: true }).click();
  await p.waitForURL(/\/review\//);
  state.captionsReview = p.url();
  const panel = p.getByRole('region', { name: 'Subtitles' });
  await panel.waitFor();
  const lines = await panel.locator('[data-cue]').allInnerTexts();
  assert(lines.length === 3, `three lines expected, got ${lines.length}: ${lines.join(' | ')}`);
  assert(lines[0].includes('Welcome to the spring menu') && !lines[0].includes('<i>'), `markup should be gone: ${lines[0]}`);

  // A click on a line's time goes there in the video.
  await p.waitForFunction(() => document.querySelector('video')?.readyState >= 2, null, { timeout: 20_000 });
  await panel.locator('[data-cue="1"] .cue-time').click();
  await p.waitForFunction(() => Math.abs(document.querySelector('video').currentTime - 2.5) < 0.3, null, { timeout: 5000 });
  await until('the line being said to be marked', async () => (await panel.locator('.cue.now').count()) === 1 && /flat white/.test(await panel.locator('.cue.now').innerText()), 8000);
  await shot(p, 'subtitles-beside-video');

  await panel.getByRole('button', { name: 'Comment on line 2' }).click();
  const quote = p.getByTestId('cue-quote').first();
  await quote.waitFor();
  assert(/Our flat white is back/.test(await quote.innerText()), 'the draft should quote the line');
  await p.getByLabel('Comment', { exact: true }).fill('"Flat white" should be capitalised in the brand style');
  await p.getByRole('button', { name: 'Post comment' }).click();
  await p.getByText('should be capitalised in the brand style').waitFor();
  await panel.locator('[data-cue="1"] .chip').waitFor();
  assert((await panel.locator('[data-cue="1"] .chip').innerText()) === '1', 'the line should show its comment');
  await shot(p, 'subtitle-comment');
  // The server stored the file's own words and times.
  const anchor = JSON.parse(sql(`select anchor::text from comment where body like '%capitalised%'`));
  assert(anchor.t === 2.5 && anchor.t_end === 4 && anchor.cue === 1 && anchor.cue_text === 'Our flat white is back', `stored anchor: ${JSON.stringify(anchor)}`);
});

await step('subtitles: the producer sees the quoted line in the thread, and a forged line is refused by the server', async () => {
  const p = producer.page;
  await p.goto(state.captionsReview);
  await p.getByTestId('cue-quote').first().waitFor();
  assert(/Our flat white is back/.test(await p.getByTestId('cue-quote').first().innerText()), 'the thread should quote the line');
  const versionId = state.captionsReview.split('/').pop();
  const forged = await reviewer.context.request.post(`/api/versions/${versionId}/comments`, {
    data: { body: 'forged', anchor: { type: 'time', t: 1, cue: 99 } }, headers: { 'x-requested-by': 'studio' },
  });
  assert(forged.status() === 400, `a line that does not exist should be refused, got ${forged.status()}`);
});

// ───────────────────────────── resumable uploads ─────────────────────────────
const BIG_ON = { fn: () => localStorage.setItem('studio.resumableAbove', '0') };

await step('big files: a piece whose answer is lost is not sent twice, and the upload finishes', async () => {
  const s = await signIn('producer@example.com', { init: BIG_ON });
  const p = s.page;
  await createPiece(p, 'Big upload, answer lost');
  const offsets = [];
  let lost = false;
  await p.route('**/api/uploads/*/resumable', async (route) => {
    const req = route.request();
    if (req.method() !== 'PATCH') return route.continue();
    offsets.push(Number(req.headers()['upload-offset']));
    if (offsets.length === 2 && !lost) {
      // The server gets the piece, and the browser never hears: the case that makes a naive retry send it twice.
      lost = true;
      await route.fetch();
      return route.abort('connectionreset');
    }
    return route.continue();
  });
  await p.getByRole('button', { name: /Upload (first|new) version/ }).first().click();
  const d = p.getByRole('dialog');
  await d.locator('input[type=file]').setInputFiles(path.join(ASSETS, 'big.webm'));
  await d.getByRole('button', { name: 'Upload and send to review' }).click();
  await p.getByText('Version uploaded and sent to review').waitFor({ timeout: 90_000 });
  assert(lost, 'the answer should have been lost once');
  assert(JSON.stringify(offsets) === JSON.stringify([0, CHUNK, 2 * CHUNK]), `the browser should carry on after the piece that landed: ${JSON.stringify(offsets)}`);
  const size = statSync(path.join(ASSETS, 'big.webm')).size;
  assert(sql(`select count(*) from upload where resumable and completed_at is not null and consumed_at is not null and bytes = ${size}`) >= '1', 'the upload should be complete and used');
  assert(existsSync(STAGING) && readdirSync(STAGING).filter((f) => f.endsWith('.part')).length === 0, 'the staging file should be gone once the file is in storage');
  const asset = sql(`select a.bytes from asset a join version v on v.id = a.version_id join variant va on va.id = v.variant_id join piece pc on pc.id = va.piece_id where pc.title = 'Big upload, answer lost' and a.kind = 'video'`);
  assert(asset === String(size), `the stored file should have every byte: ${asset} of ${size}`);
  await s.context.close();
});

await step('big files: a tab closed in the middle is picked up where it stopped when the same file is chosen again', async () => {
  const s = await signIn('producer@example.com', { init: BIG_ON });
  const first = s.page;
  const pid = await createPiece(first, 'Big upload, tab closed');
  let passed = 0;
  await first.route('**/api/uploads/*/resumable', async (route) => {
    if (route.request().method() !== 'PATCH') return route.continue();
    // The first piece gets through, then the connection is gone for good.
    if (passed++ === 0) return route.continue();
    return route.abort('connectionreset');
  });
  await first.getByRole('button', { name: /Upload (first|new) version/ }).first().click();
  const d = first.getByRole('dialog');
  await d.locator('input[type=file]').setInputFiles(path.join(ASSETS, 'big.webm'));
  await d.getByRole('button', { name: 'Upload and send to review' }).click();
  await until('the first piece to be kept', () => sql(`select coalesce(max(received_bytes), 0) from upload u join variant v on v.id = u.variant_id where v.piece_id = '${pid}'`) === String(CHUNK), 30_000);
  await d.getByText(/connection problem, trying again/).waitFor({ timeout: 20_000 });
  await shot(first, 'upload-connection-problem');
  await first.close(); // the tab is closed

  const second = await s.context.newPage();
  watch(second, 'producer-again');
  const offsets = [];
  await second.route('**/api/uploads/*/resumable', (route) => {
    if (route.request().method() === 'PATCH') offsets.push(Number(route.request().headers()['upload-offset']));
    return route.continue();
  });
  await second.goto(`/pieces/${pid}`);
  await uploadVersion(second, ['big.webm'], { timeout: 90_000 });
  assert(offsets[0] === CHUNK, `the new tab should begin after the first piece, not at 0: ${JSON.stringify(offsets)}`);
  assert(offsets.length === 2, `only the two pieces that were missing are sent: ${JSON.stringify(offsets)}`);
  assert(sql(`select count(*) from upload u join variant v on v.id = u.variant_id where v.piece_id = '${pid}'`) === '1', 'the same upload is carried on, not a new one');
  await s.context.close();
});

// ───────────────────────────── the readiness checks ─────────────────────────────
await step('readiness: networks are connected, and the checks say what they found, in the screen and on the command line', async () => {
  const p = admin.page;
  await p.goto('/settings?tab=accounts');
  await p.getByRole('button', { name: 'Connect Facebook and Instagram' }).click();
  await p.waitForURL(/connection=/);
  const d = p.getByRole('dialog');
  await d.getByText('Choose what to connect').waitFor();
  await d.getByRole('checkbox').first().check();
  await d.getByRole('checkbox').nth(1).check();
  await d.getByRole('button', { name: /Connect 2/ }).click();
  await p.getByText('Connected', { exact: true }).first().waitFor();
  await p.getByRole('button', { name: 'Connect YouTube' }).click();
  await p.waitForURL(/connection=/);
  await p.getByRole('dialog').getByRole('button', { name: 'Connect', exact: true }).click();
  await p.getByText('until then videos upload as private').waitFor();
  // YouTube was asked for the Analytics permission too, because the deployment turned it on.
  const asked = (await fakes.state()).authorizations['/auth']?.scope ?? '';
  assert(asked.includes('yt-analytics.readonly') && asked.includes('youtube.upload'), `YouTube sign-in asked for: ${asked}`);

  await p.getByRole('button', { name: 'Is this server ready?' }).click();
  const server = p.getByRole('dialog');
  await server.getByRole('heading', { name: 'Is this server ready?' }).waitFor();
  await server.getByText('Token key').waitFor();
  assert((await server.locator('li[data-status]').count()) >= 5, 'the server check should list its lines');
  await shot(p, 'check-server');
  await server.getByRole('button', { name: 'Close' }).first().click();

  const row = p.locator('tr', { hasText: 'Lumen Coffee TV' });
  await row.getByRole('button', { name: 'Check' }).click();
  const dlg = p.getByRole('dialog');
  await dlg.getByText('Permissions', { exact: true }).waitFor();
  const perms = dlg.locator('li[data-status]', { hasText: 'Permissions' });
  assert((await perms.getAttribute('data-status')) === 'pass', `all permissions, Analytics included, were granted: ${await perms.innerText()}`);
  await shot(p, 'check-account');
  await dlg.getByRole('button', { name: 'Close' }).first().click();
});

await step('readiness: the command checks a real publish end to end, writes a transcript with the secrets removed, and exits with what it found', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'estudio-capture-'));
  let out;
  try {
    out = execFileSync('node', ['--import', 'tsx', 'apps/api/src/cli.ts', 'check', '--brand', 'Lumen Coffee', '--network', 'instagram', '--publish', '--yes', '--json', '--capture', dir], { stdio: ['ignore', 'pipe', 'pipe'], timeout: 120_000 }).toString();
  } catch (err) {
    // A failed line makes the command exit with 1, and what it found is still on its standard output.
    out = err.stdout?.toString() ?? '';
    if (!out) throw err;
  }
  const report = JSON.parse(out);
  const account = report.accounts.find((a) => a.account.network === 'instagram');
  const ids = Object.fromEntries(account.results.map((r) => [r.id, r.status]));
  for (const id of ['connected', 'health', 'publish.prepare', 'publish.publish']) assert(ids[id] === 'pass', `${id}: ${ids[id]} (${JSON.stringify(ids)})`);
  assert(account.results.some((r) => r.id === 'publish.cleanup' && /delete/i.test(r.title)), 'it should say the test post is the person\'s to delete');
  assert((await fakes.state()).instagram.length >= 1, 'a post should have reached the (fake) network');
  const files = readdirSync(dir).filter((f) => f.startsWith('transcript-'));
  assert(files.length === 1, `one transcript expected: ${files}`);
  const text = readFileSync(path.join(dir, files[0]), 'utf8');
  const transcript = JSON.parse(text);
  assert(transcript.exchanges.length > 3, 'the transcript should hold the calls');
  // What must be gone is the VALUES: a field called access_token whose value says [removed] is how the transcript shows it was there.
  const leak = /.{0,60}(page-token|e2e-secret|access_token=(?!\[removed\])|"(?:client_secret|access_token|refresh_token)":\s*"(?!\[removed\])|access-\d+|refresh-\d+).{0,60}/.exec(text);
  assert(!leak, `the transcript must not hold a token or a secret: …${leak?.[0]}…`);
});

await step('phone: the second step, the account page, subtitles and the checks fit a narrow screen', async () => {
  const s = await signIn('reviewer@example.com', { viewport: { width: 390, height: 800 } });
  const p = s.page;
  for (const [url, wait, name] of [['/security', 'Your account', 'phone-account'], [state.captionsReview, 'Subtitles', 'phone-subtitles']]) {
    await p.goto(url);
    await p.getByText(wait, { exact: true }).first().waitFor();
    const overflow = await p.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    assert(overflow <= 1, `${url} scrolls sideways by ${overflow}px`);
    await shot(p, name);
  }
  await s.context.close();
  const a = await signIn('approver@example.com', { viewport: { width: 390, height: 800 } });
  await asksForCode(a.page);
  const overflow = await a.page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  assert(overflow <= 1, `the code step scrolls sideways by ${overflow}px`);
  await shot(a.page, 'phone-second-step');
  await a.context.close();
});

await browser.close();
if (problems.length) {
  console.log(`\n${problems.length} problem(s):`);
  for (const p of problems) console.log(` - ${p}`);
  process.exit(1);
}
console.log('\nAll phase 5 steps passed.');
