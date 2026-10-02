// End-to-end check of phase 3, in a real browser: a comment becomes a new version with nobody lifting a finger.
//
// The real app, a real PostgreSQL, the real runner (a separate process), real ffmpeg, and a scripted stand-in for the agent
// (apps/runner/test/fake-agent.mjs). Everything the people do, they do through the screens.
//
// What this proves: the app's own behaviour and the runner's, end to end. What it cannot prove: how a real agent behaves.
// For that, see e2e/README.md (the run with Claude Code).
//
// Needs the API running on an EMPTY database that has only been bootstrapped, and apps/runner built or runnable with tsx.
// Environment: BASE_URL, ASSETS, SHOTS, DATABASE_URL, CHROMIUM, RUNNER_PORT (default 8788), AGENT (scripted | claude).
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const BASE = process.env.BASE_URL ?? 'http://localhost:3000';
const ASSETS = process.env.ASSETS ?? path.resolve('e2e/assets');
const SHOTS = process.env.SHOTS ?? path.resolve('e2e/shots-phase3');
const RUNNER_PORT = Number(process.env.RUNNER_PORT ?? 8788);
const REAL_AGENT = process.env.AGENT === 'claude';
mkdirSync(SHOTS, { recursive: true });

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM ?? '/opt/pw-browsers/chromium', args: ['--no-sandbox', '--disable-background-networking', '--no-first-run'] });
const problems = [];
const pages = [];
let n = 0;
let runner = null;
const runnerLog = [];

async function newSession(email, viewport = { width: 1280, height: 900 }, mobile = false) {
  const context = await browser.newContext({ baseURL: BASE, locale: 'en-US', viewport, isMobile: mobile, hasTouch: mobile });
  // The interface is in Spanish unless the person chose otherwise; these steps read its English.
  await context.addInitScript(() => { try { localStorage.setItem('studio.locale', 'en'); } catch { /* no storage: Spanish */ } });
  const page = await context.newPage();
  pages.push([email, page]);
  page.on('pageerror', (e) => problems.push(`[${email}] page error: ${e.message}`));
  page.on('console', (m) => m.type() === 'error' && !/status of 4\d\d/.test(m.text()) && problems.push(`[${email}] console error: ${m.text()}`));
  await page.goto('/login');
  await page.getByLabel('Email').fill(email);
  await page.getByRole('button', { name: /Development sign-in/ }).click();
  await page.waitForURL('**/pieces');
  return { context, page };
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
    // What every open screen looked like at that moment.
    for (const [email, page] of pages) await page.screenshot({ path: path.join(SHOTS, `fail-${String(++n).padStart(2, '0')}-${email.split('@')[0]}.png`) }).catch(() => {});
  }
}
const assert = (cond, msg) => { if (!cond) throw new Error(msg); };

/** Reloads the page until check() passes: the runner works in the background, so the screen catches up on its own time. */
async function until(page, what, check, timeoutMs = 120_000) {
  const t0 = Date.now();
  let last = '';
  while (Date.now() - t0 < timeoutMs) {
    try {
      const r = await check();
      if (r === true) return;
      last = String(r);
    } catch (e) { last = e.message; }
    await new Promise((r) => setTimeout(r, 1500));
    await page.reload();
    // The screens fetch after they load: checking straight after the reload would look at a page that has not filled in yet.
    await page.waitForLoadState('networkidle').catch(() => {});
  }
  throw new Error(`Timed out waiting for ${what}. Last seen: ${last}`);
}
// The agent card reuses the row style, so a bare '.version-row' also matches its runs: a version's row starts with its number.
const versionRows = (page) => page.locator('.version-row').filter({ hasText: /^v\d+/ });
const versionRow = (page, n) => page.locator('.version-row').filter({ hasText: new RegExp(`^v${n}(?!\\d)`) });
async function seekVideo(page, seconds) {
  await page.waitForFunction(() => document.querySelector('video')?.readyState >= 2, null, { timeout: 20_000 });
  await page.evaluate((t) => new Promise((resolve) => {
    const v = document.querySelector('video');
    v.pause();
    v.addEventListener('seeked', () => resolve(), { once: true });
    v.currentTime = t;
  }), seconds);
}

const state = {};
const admin = await newSession('admin@example.com');
const api = (method, url, data) => admin.context.request.fetch(url, { method, data, headers: { 'x-requested-by': 'studio', 'accept-language': 'en' } });

await step('seed: members for the approver, the reviewer and the producer', async () => {
  const me = await (await api('GET', '/api/me')).json();
  state.brandId = me.brands[0].id;
  for (const [email, name, role] of [['approver@example.com', 'Ana Approver', 'approver'], ['reviewer@example.com', 'Rafa Reviewer', 'reviewer'], ['producer@example.com', 'Paula Producer', 'producer']]) {
    const r = await api('POST', `/api/brands/${state.brandId}/members`, { email, name, role });
    assert(r.ok(), `adding ${email}: ${r.status()}`);
  }
  // An approval is for named accounts. This one is registered by hand: nothing here publishes.
  const acc = await api('POST', `/api/brands/${state.brandId}/accounts`, { network: 'instagram', externalId: 'lumen.coffee', displayName: '@lumen.coffee' });
  assert(acc.ok(), `adding the account: ${acc.status()}`);
});

// ───────────────────────────── set up, the way an admin would ─────────────────────────────
await step('settings: the agent will not start until budgets are set, and the admin sets them', async () => {
  const p = admin.page;
  await p.goto('/settings?tab=agent');
  await p.getByText('The agent will not start until both budgets are set').waitFor();
  await shot(p, 'agent-settings-empty');
  await p.getByLabel(/Budget per piece/).fill(REAL_AGENT ? '2' : '5');
  await p.getByLabel(/Budget per month/).fill('50');
  await p.getByRole('button', { name: 'Save' }).click();
  await p.getByText('Saved').first().waitFor();
  await p.reload();
  assert((await p.getByLabel(/Budget per piece/).inputValue()) === (REAL_AGENT ? '2' : '5'), 'the budget was not saved');
  assert((await p.getByText('The agent will not start until both budgets are set').count()) === 0, 'the warning should be gone');
  await p.getByText(/Spent .*0 USD of 50 USD/).waitFor();
});

await step('settings: a producer token for the agent, shown once', async () => {
  const p = admin.page;
  await p.goto('/settings?tab=tokens');
  await p.getByLabel('Name').fill('Agent runner');
  await p.getByRole('button', { name: 'Create token' }).click();
  const d = p.getByRole('dialog');
  await d.getByText('Copy your token now').waitFor();
  state.token = (await d.locator('pre').innerText()).trim();
  assert(/^est_/.test(state.token), 'expected a token');
  await d.getByRole('button', { name: 'Done' }).click();
});

await step('settings: a webhook to the runner; its secret is shown once and never again', async () => {
  const p = admin.page;
  await p.goto('/settings?tab=webhooks');
  await p.getByRole('button', { name: 'Add a webhook' }).first().click();
  const d = p.getByRole('dialog');
  await d.getByLabel(/^Address/).fill(`http://127.0.0.1:${RUNNER_PORT}/webhooks/lumen`);
  await d.getByLabel('Description (optional)').fill('The runner');
  await d.getByLabel(/version\.approved/).check();
  await shot(p, 'webhook-dialog');
  await d.getByRole('button', { name: 'Add webhook' }).click();
  const s = p.getByRole('dialog');
  await s.getByText('Copy the secret now').waitFor();
  state.secret = (await s.locator('pre').innerText()).trim();
  assert(/^whsec_/.test(state.secret), 'expected a secret');
  await s.getByRole('button', { name: 'Done' }).click();
  await p.getByText('http://127.0.0.1').first().waitFor();
  assert(!(await p.content()).includes(state.secret), 'the secret is on the page after it was closed');
  assert(!(await (await api('GET', `/api/brands/${state.brandId}/webhooks`)).text()).includes(state.secret), 'the API returns the secret again');
});

await step('the runner starts with that token and secret, and connects to the studio', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'phase3-runner-'));
  state.runnerDir = dir;
  // Only what Claude Code needs to sign in, by name. Not CLAUDE_*: those can tie a child to the session that launched it.
  const claudeEnv = Object.fromEntries(['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_MODEL'].filter((k) => process.env[k]).map((k) => [k, `\${${k}}`]));
  const agent = REAL_AGENT
    ? {
        command: ['claude', '-p', '--output-format', 'json', { if: 'maxBudget', args: ['--max-budget-usd', '{{maxBudget}}'] }, '--add-dir', '{{pieceDir}}', '--permission-mode', 'acceptEdits',
          '--allowedTools', 'Read', 'Write', 'Edit', 'Glob', 'Grep', 'Bash(ffmpeg:*)', 'Bash(ffprobe:*)', 'Bash(ls:*)', 'Bash(mkdir:*)', 'Bash(cp:*)', 'Bash(mv:*)'],
        env: claudeEnv, cost: { from: 'stdout-json', path: 'total_cost_usd' }, killGraceSeconds: 10,
      }
    : { command: [process.execPath, path.resolve('apps/runner/test/fake-agent.mjs')], env: { FAKE_AGENT_MODE: 'cost' }, cost: { from: 'stdout-json', path: 'total_cost_usd' }, killGraceSeconds: 2 };
  const config = {
    listen: { host: '127.0.0.1', port: RUNNER_PORT },
    workspaceRoot: path.join(dir, 'work'),
    brands: {
      lumen: {
        api: BASE, token: state.token, webhookSecret: state.secret,
        templates: { 'version.changes_requested': path.resolve('apps/runner/templates/changes-requested.md'), 'slot.needs_content': path.resolve('apps/runner/templates/slot-needs-content.md') },
        agent,
        checks: { coveredZones: 'warn' },
        checkRetries: 1,
      },
    },
  };
  const file = path.join(dir, 'runner.config.json');
  writeFileSync(file, JSON.stringify(config, null, 2));
  runner = spawn('node', ['--import', 'tsx', 'apps/runner/src/main.ts', file], { stdio: ['ignore', 'pipe', 'pipe'], env: process.env });
  runner.stdout.on('data', (c) => runnerLog.push(c.toString()));
  runner.stderr.on('data', (c) => runnerLog.push(c.toString()));
  const t0 = Date.now();
  for (;;) {
    try {
      if ((await fetch(`http://127.0.0.1:${RUNNER_PORT}/health`)).ok) break;
    } catch { /* not up yet */ }
    assert(Date.now() - t0 < 30_000, `the runner did not start:\n${runnerLog.join('')}`);
    await new Promise((r) => setTimeout(r, 300));
  }
  const t1 = Date.now();
  while (!runnerLog.join('').includes('connected to the studio')) {
    assert(Date.now() - t1 < 15_000, `the runner could not sign in to the studio:\n${runnerLog.join('')}`);
    await new Promise((r) => setTimeout(r, 300));
  }
});

await step('webhooks: "Send a test" reaches the runner and shows as delivered', async () => {
  const p = admin.page;
  await p.goto('/settings?tab=webhooks');
  await p.getByRole('button', { name: 'Send a test' }).click();
  const d = p.getByRole('dialog');
  await d.getByText('Deliveries').first().waitFor();
  await d.locator('.chip-approved', { hasText: 'Delivered' }).first().waitFor({ timeout: 30_000 });
  await d.getByText('Test').first().waitFor();
  await shot(p, 'webhook-deliveries-test');
  await d.getByRole('button', { name: 'Close' }).click();
});

// ───────────────────────────── a piece, and a request for changes ─────────────────────────────
const producer = await newSession('producer@example.com');
await step('producer: makes a piece and uploads the first version', async () => {
  const p = producer.page;
  await p.getByRole('button', { name: 'New piece' }).click();
  const d = p.getByRole('dialog');
  await d.getByLabel('Title').fill('Spring menu reel');
  await d.getByRole('button', { name: 'Create piece' }).click();
  await p.waitForURL(/\/pieces\/[0-9a-f-]{36}$/);
  state.pieceId = p.url().split('/').pop();
  await p.getByRole('button', { name: 'Add variant' }).first().click();
  await p.getByRole('dialog').getByRole('button', { name: 'Add variant' }).click();
  await p.getByRole('button', { name: /Upload (first|new) version/ }).first().click();
  const u = p.getByRole('dialog');
  await u.locator('input[type=file]').setInputFiles([path.join(ASSETS, 'reel-v1.webm')]);
  await u.getByRole('button', { name: 'Upload and send to review' }).click();
  await p.getByText('Version uploaded and sent to review').waitFor({ timeout: 60_000 });
});

const reviewer = await newSession('reviewer@example.com');
await step('reviewer: comments on a frame, adds a note for people only, and requests changes', async () => {
  const p = reviewer.page;
  await p.goto(`/pieces/${state.pieceId}`);
  await p.getByRole('link', { name: 'Review', exact: true }).click();
  await p.waitForURL(/\/review\//);
  state.review1 = p.url();
  await seekVideo(p, 2.5);
  await p.getByRole('button', { name: 'Comment here' }).click();
  await p.getByLabel('Comment', { exact: true }).fill(REAL_AGENT ? 'Make the whole video about 25% brighter. Change nothing else.' : 'The picture is too dark here');
  await p.getByRole('button', { name: 'Post comment' }).click();
  // Not getByText: React mirrors a textarea's value into its text content, so that would match the box itself before the post lands.
  await p.locator('.thread', { hasText: REAL_AGENT ? /25% brighter/ : 'The picture is too dark here' }).waitFor();

  await p.getByLabel('Comment', { exact: true }).fill('Ask Ana whether the music is licensed');
  await p.getByLabel(/Only people/).check();
  await p.getByRole('button', { name: 'Post comment' }).click();
  await p.locator('.thread', { hasText: 'Ask Ana whether the music is licensed' }).locator('.chip', { hasText: 'only people' }).waitFor();
  await shot(p, 'review-comments-with-people-only');

  await p.getByRole('button', { name: 'Request changes' }).click();
  await p.getByRole('dialog').getByRole('button', { name: 'Request changes' }).click();
  await p.getByText('Changes requested').first().waitFor();
});

await step('the agent turns it into version 2 without anyone passing it on', async () => {
  const p = producer.page;
  await p.goto(`/pieces/${state.pieceId}`);
  await until(p, 'version 2 to appear', async () => (await versionRow(p, 2).count()) > 0 || `${await versionRows(p).count()} versions; runner log tail: ${runnerLog.join('').split('\n').slice(-4).join(' | ')}`, REAL_AGENT ? 420_000 : 150_000);
  const v2 = versionRow(p, 2);
  await v2.locator('.chip', { hasText: 'agent' }).waitFor();
  await v2.getByText('In review').waitFor();
  assert(await versionRow(p, 1).getByText('Superseded').count() === 1, 'v1 should be superseded');
  await shot(p, 'piece-with-agent-version');
});

await step('the piece shows the agent card: round, cost, what the run did and the checks', async () => {
  const p = producer.page;
  const card = p.getByRole('region', { name: 'Agent' });
  await card.getByText('Round 1 of 3').waitFor();
  await card.getByText('Sent a new version').waitFor();
  await card.getByText('Idle').waitFor();
  if (!REAL_AGENT) await card.getByText(/spent 0\.42 USD of 5 USD/).waitFor();
  await card.getByText(/Checks:/).waitFor();
  await shot(p, 'piece-agent-card');
});

await step('reviewer: sees the agent\'s answer, the comment resolved in v2, and the people-only note left alone', async () => {
  const p = reviewer.page;
  await p.goto(`/pieces/${state.pieceId}`);
  await versionRow(p, 2).getByRole('link', { name: 'Review' }).click();
  await p.waitForURL(/\/review\//);
  state.review2 = p.url();
  await p.getByText(/uploaded by Agent runner \(agent\)/).waitFor();
  const mine = p.locator('.thread', { hasText: 'Ask Ana whether the music is licensed' });
  await mine.waitFor();
  assert((await mine.locator('.reply').count()) === 0, 'the agent answered a comment that is for people only');
  assert((await mine.locator('.chip', { hasText: 'only people' }).count()) === 1, 'the people-only mark is gone');
  await p.getByText(/Resolved \(1\)/).click();
  const fixed = p.locator('.thread.resolved').first();
  await fixed.getByText('resolved in v2').waitFor();
  await fixed.locator('.reply.agent').getByText('Fixed').waitFor();
  await p.getByRole('tab', { name: 'Details' }).click();
  await p.getByText(/Agent round 1/).first().waitFor().catch(() => {});
  await p.getByRole('tab', { name: 'Comments' }).click();
  await shot(p, 'review-v2-after-agent');
});

await step('settings: the run is in the history, the month\'s spending moved, and the webhook shows what it delivered', async () => {
  const p = admin.page;
  await p.goto('/settings?tab=agent');
  const row = p.locator('tbody tr', { hasText: 'Spring menu reel' });
  await row.getByText('Sent a new version').waitFor();
  await row.getByText('Changes requested').waitFor();
  if (!REAL_AGENT) await p.getByText(/Spent 0\.42 USD of 50 USD/).waitFor();
  await shot(p, 'agent-settings-with-run');
  await p.goto('/settings?tab=webhooks');
  await p.getByRole('button', { name: 'Deliveries' }).click();
  const d = p.getByRole('dialog');
  await d.locator('tr', { hasText: 'Changes requested' }).locator('.chip-approved', { hasText: 'Delivered' }).waitFor();
  await d.getByRole('button', { name: 'Attempts' }).first().click();
  await p.getByRole('dialog').last().locator('.chip', { hasText: '202' }).waitFor();
  await shot(p, 'webhook-attempts');
});

// ───────────────────────────── the round cap ─────────────────────────────
await step('settings: with one round allowed, a second request is not handed to the agent', async () => {
  const p = admin.page;
  await p.goto('/settings?tab=agent');
  await p.getByLabel('Rounds per piece').fill('1');
  await p.getByRole('button', { name: 'Save' }).click();
  await p.getByText('Saved').first().waitFor();
  const q = reviewer.page;
  await q.goto(state.review2);
  // A real agent has no editable text in this clip, so for it the second request is one it can always do.
  const second = REAL_AGENT ? 'Make the colours a bit more saturated. Change nothing else.' : 'Now make the text bigger';
  await q.getByLabel('Comment', { exact: true }).fill(second);
  await q.getByRole('button', { name: 'Post comment' }).click();
  await q.locator('.thread', { hasText: second }).waitFor();
  await q.getByRole('button', { name: 'Request changes' }).click();
  await q.getByRole('dialog').getByRole('button', { name: 'Request changes' }).click();
  await q.getByText('Changes requested').first().waitFor();
  const pp = producer.page;
  await pp.goto(`/pieces/${state.pieceId}`);
  await until(pp, 'the piece to say it needs a person', async () => (await pp.getByRole('region', { name: 'Agent' }).getByText('Needs a person').count()) > 0);
  const card = pp.getByRole('region', { name: 'Agent' });
  await card.getByText('Rounds used up').first().waitFor();
  await card.getByRole('status').getByText(/used its 1 rounds/).waitFor();
  assert((await versionRows(pp).count()) === 2, 'no third version should exist');
  await shot(pp, 'piece-needs-a-person');
});

await step('the approver is told, and can hand the piece back to the agent, which then does the pending request', async () => {
  const p = (await newSession('approver@example.com')).page;
  await p.getByRole('button', { name: /Notifications/ }).click();
  await p.getByText('The agent handed a piece back to a person').first().waitFor();
  await shot(p, 'bell-needs-a-person');
  await p.goto(`/pieces/${state.pieceId}`);
  const card = p.getByRole('region', { name: 'Agent' });
  await card.getByRole('button', { name: 'Hand it back to the agent' }).click();
  await p.getByText('Handed back to the agent').waitFor();
  await until(p, 'version 3 to appear', async () => (await versionRow(p, 3).count()) > 0, REAL_AGENT ? 420_000 : 150_000);
  await versionRow(p, 3).locator('.chip', { hasText: 'agent' }).waitFor();
  await p.getByRole('region', { name: 'Agent' }).getByText('Round 1 of 1').waitFor(); // counted from zero again
  state.approver = p;
});

await step('the approver can approve what the agent made, once the people-only note is dealt with', async () => {
  const p = state.approver;
  await versionRow(p, 3).getByRole('link', { name: 'Review' }).click();
  await p.waitForURL(/\/review\//);
  await p.getByRole('button', { name: 'Approve…' }).click();
  const d = p.getByRole('dialog');
  await d.getByText(/comment.* still open/).waitFor(); // the note for people only still blocks approval
  await d.getByRole('button', { name: 'Cancel' }).click();
  const mine = p.locator('.thread', { hasText: 'Ask Ana whether the music is licensed' });
  await mine.getByRole('button', { name: 'Resolve' }).click();
  await p.getByText('Nothing open.').waitFor();
  await p.getByRole('button', { name: 'Approve…' }).click();
  await p.getByRole('dialog').getByLabel(/Instagram/).check();
  await p.getByRole('dialog').getByRole('button', { name: 'Approve', exact: true }).click();
  await p.getByText(/Approved for 1 account/).waitFor();
});

await step('phone: the webhooks and agent tabs fit a narrow screen', async () => {
  const mobile = await newSession('admin@example.com', { width: 390, height: 800 }, true);
  for (const tab of ['webhooks', 'agent']) {
    await mobile.page.goto(`/settings?tab=${tab}`);
    await mobile.page.getByRole('tab', { selected: true }).waitFor();
    await mobile.page.waitForTimeout(400);
    const w = await mobile.page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, inner: window.innerWidth }));
    assert(w.scroll <= w.inner + 1, `${tab} tab scrolls sideways (${w.scroll} > ${w.inner})`);
    await shot(mobile.page, `${tab}-mobile`);
  }
  await mobile.context.close();
});

runner?.kill('SIGTERM');
await browser.close();
if (problems.length) {
  console.log(`\n${problems.length} problem(s):`);
  for (const x of problems) console.log(` - ${x}`);
  console.log('\nRunner log (tail):\n' + runnerLog.join('').split('\n').slice(-25).join('\n'));
  process.exit(1);
}
console.log('\nAll phase 3 end-to-end steps passed.');
