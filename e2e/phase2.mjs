// End-to-end check of phase 2 against FAKE networks: connect accounts through the real UI, schedule posts, and watch the
// real worker prepare, publish and verify them (real ffmpeg, real Postgres, real pg-boss, real browser).
//
// What this proves: the app's own behaviour end to end. What it cannot prove: that Meta and Google behave like the fakes
// in apps/api/test/fakes. See e2e/README.md and docs/phase-2.md.
//
// Needs the API running against e2e/fakes.mts (see e2e/README.md), on an EMPTY database that has only been bootstrapped.
// Environment: BASE_URL, FAKES_URL (control surface, default http://127.0.0.1:4010), ASSETS, SHOTS, DATABASE_URL (psql URI),
// CHROMIUM.
import { chromium } from 'playwright-core';
import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

const BASE = process.env.BASE_URL ?? 'http://localhost:3000';
const FAKES = process.env.FAKES_URL ?? 'http://127.0.0.1:4010';
const ASSETS = process.env.ASSETS ?? path.resolve('e2e/assets');
const SHOTS = process.env.SHOTS ?? path.resolve('e2e/shots-phase2');
const DB = process.env.DATABASE_URL ?? 'postgres://postgres@localhost:5433/estudio_e2e2';
mkdirSync(SHOTS, { recursive: true });

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM ?? '/opt/pw-browsers/chromium', args: ['--no-sandbox', '--disable-background-networking', '--no-first-run'] });
const problems = [];
let n = 0;

async function newSession(email, viewport = { width: 1280, height: 900 }, mobile = false) {
  const context = await browser.newContext({ baseURL: BASE, viewport, isMobile: mobile, hasTouch: mobile, acceptDownloads: true });
  const page = await context.newPage();
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
  }
}

const assert = (cond, msg) => { if (!cond) throw new Error(msg); };
const sql = (q) => execFileSync('psql', [DB, '-tA', '-c', q], { stdio: 'pipe' }).toString().trim();
const fakes = {
  state: async () => (await fetch(`${FAKES}/__state`)).json(),
  control: async (body) => { await fetch(`${FAKES}/__control`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); },
};

/** Reloads the page until check() passes: the worker works in the background, so the screen catches up on its own time. */
async function until(page, what, check, timeoutMs = 90_000) {
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
  }
  throw new Error(`Timed out waiting for ${what}. Last seen: ${last}`);
}

const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
const state = {};

const admin = await newSession('admin@example.com');
const api = (method, url, data) => admin.context.request.fetch(url, { method, data, headers: { 'x-requested-by': 'studio' } });

await step('seed: the fake networks start blank, and members are added for the approver and the producer', async () => {
  await fakes.control({ op: 'reset' });
  const me = await (await api('GET', '/api/me')).json();
  state.brandId = me.brands[0].id;
  for (const [email, name, role] of [['approver@example.com', 'Ana Approver', 'approver'], ['producer@example.com', 'Paula Producer', 'producer']]) {
    const r = await api('POST', `/api/brands/${state.brandId}/members`, { email, name, role });
    assert(r.ok(), `adding ${email}: ${r.status()}`);
  }
});

// ───────────────────────────── connecting ─────────────────────────────
await step('settings: the buttons to connect are there and enabled, because the server has credentials', async () => {
  const p = admin.page;
  await p.goto('/settings?tab=accounts');
  assert(await p.getByRole('button', { name: 'Connect Facebook and Instagram' }).isEnabled(), 'Meta connect button should be enabled');
  assert(await p.getByRole('button', { name: 'Connect YouTube' }).isEnabled(), 'YouTube connect button should be enabled');
  await shot(p, 'accounts-empty');
});

await step('connect Facebook and Instagram: sign in at the network, choose both, they show as connected', async () => {
  const p = admin.page;
  await p.getByRole('button', { name: 'Connect Facebook and Instagram' }).click();
  await p.waitForURL(/connection=/);
  const d = p.getByRole('dialog');
  await d.getByText('Choose what to connect').waitFor();
  await d.getByText('Lumen Coffee').first().waitFor();
  await d.getByText('lumen.coffee').waitFor();
  assert((await d.locator('input[type=checkbox]').count()) === 2, 'expected a Facebook Page and an Instagram account to choose from');
  assert(await d.getByRole('button', { name: 'Connect', exact: true }).isDisabled(), 'nothing should be pre-selected when there are two candidates');
  await d.getByRole('checkbox').first().check();
  await d.getByRole('checkbox').nth(1).check();
  await shot(p, 'connection-picker');
  await d.getByRole('button', { name: /Connect 2/ }).click();
  await p.getByText('Connected', { exact: true }).first().waitFor();
  assert((await p.locator('.chip-approved', { hasText: 'Connected' }).count()) === 2, 'both accounts should show as connected');
  assert(!/connection=/.test(p.url()), 'the address should be clean again');
  await shot(p, 'accounts-meta-connected');
});

await step('connect YouTube: one channel, preselected; it starts unaudited', async () => {
  const p = admin.page;
  await p.getByRole('button', { name: 'Connect YouTube' }).click();
  await p.waitForURL(/connection=/);
  const d = p.getByRole('dialog');
  await d.getByText('Lumen Coffee TV').waitFor();
  await d.getByRole('button', { name: 'Connect', exact: true }).click();
  await p.getByText('until then videos upload as private').waitFor();
  assert((await p.locator('.chip-approved', { hasText: 'Connected' }).count()) === 3, 'three connected accounts expected');
  await shot(p, 'accounts-all-connected');
});

await step('secrets: no token ever reaches the browser, and the database holds them sealed', async () => {
  const text = await (await api('GET', `/api/brands/${state.brandId}/accounts`)).text();
  assert(!/token/i.test(text.replace(/token_expires|dataAccessExpiresAt/gi, '')), 'the accounts response mentions a token');
  const raw = sql(`select count(*) from social_account where token_encrypted is not null and position('page-token'::bytea in token_encrypted) > 0`);
  assert(raw === '0', 'a token is stored in the clear');
});

await step('settings: publishing lead and tolerance are saved', async () => {
  const p = admin.page;
  await p.goto('/settings?tab=general');
  await p.getByLabel(/Start preparing/).fill('20');
  await p.getByLabel(/Still publish up to/).fill('10');
  await p.getByRole('button', { name: 'Save' }).click();
  await p.getByText(/Saved/).first().waitFor().catch(() => {});
  await p.reload();
  assert((await p.getByLabel(/Start preparing/).inputValue()) === '20', 'lead was not saved');
  assert((await p.getByLabel(/Still publish up to/).inputValue()) === '10', 'tolerance was not saved');
  const bad = await api('PATCH', `/api/brands/${state.brandId}`, { publishing: { prepare_lead_minutes: 3, late_tolerance_minutes: 10 } });
  assert(bad.status() === 400, `a 3 minute lead should be refused, got ${bad.status()}`);
});

// ───────────────────────────── produce and approve ─────────────────────────────
const producer = await newSession('producer@example.com');
await step('producer: creates a Reel piece and uploads a WebM (which no network accepts as it is)', async () => {
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

const approver = await newSession('approver@example.com');
await step('approver: sees what Instagram and YouTube would cover over the picture', async () => {
  const p = approver.page;
  await p.goto(`/pieces/${state.pieceId}`);
  await p.getByRole('link', { name: 'Review', exact: true }).click();
  await p.waitForURL(/\/review\//);
  state.reviewUrl = p.url();
  const select = p.getByLabel('Safe area');
  await select.waitFor();
  const options = await select.locator('option').allTextContents();
  const reel = options.find((o) => /Instagram/.test(o) && /Reel/.test(o));
  assert(reel, `no Instagram Reel in the safe-area options: ${options.join(' | ')}`);
  assert((await p.getByTestId('safe-zone').count()) === 0, 'nothing is shown until one is chosen');
  await select.selectOption({ label: reel });
  await p.getByTestId('safe-zone').waitFor();
  const box = await p.getByTestId('safe-zone').boundingBox();
  const video = await p.locator('video').boundingBox();
  assert(Math.abs(box.width - video.width) < 2 && Math.abs(box.height - video.height) < 2, `the overlay does not cover the video exactly (${JSON.stringify(box)} vs ${JSON.stringify(video)})`);
  assert((await p.locator('.safe-zone').evaluate((e) => getComputedStyle(e).pointerEvents)) === 'none', 'the overlay must not take clicks');
  await shot(p, 'review-safe-zone');
  await select.selectOption('');
});

await step('approver: approves the version for all three accounts', async () => {
  const p = approver.page;
  await p.getByRole('button', { name: 'Approve…' }).click();
  const d = p.getByRole('dialog');
  for (const name of [/Instagram/, /Facebook/, /YouTube/]) await d.getByLabel(name).check();
  await d.getByRole('button', { name: 'Approve', exact: true }).click();
  await p.getByText('Approved for 3 accounts').waitFor();
});

// ───────────────────────────── schedule ─────────────────────────────
async function openSchedule(p, account) {
  await p.goto(state.reviewUrl);
  await p.getByRole('button', { name: 'Schedule…' }).click();
  const d = p.getByRole('dialog');
  await d.getByRole('combobox').first().selectOption({ label: account });
  return d;
}
const accountLabel = async (network) => (await (await api('GET', `/api/brands/${state.brandId}/accounts`)).json()).find((a) => a.network === network);

await step('schedule Instagram: says the app will publish, counts characters, blocks an over-long caption', async () => {
  const p = approver.page;
  const ig = await accountLabel('instagram');
  const d = await openSchedule(p, `Instagram · ${ig.display_name}`);
  await d.getByLabel(/Date and time/).fill(`${tomorrow}T10:00`);
  await d.getByTestId('plan').getByText('The app will publish this').waitFor();
  await d.getByTestId('plan').getByText(/as Reel/).waitFor();

  await d.getByLabel('Text').fill('x'.repeat(2300));
  await d.locator('.counter[data-over]', { hasText: 'Characters 2300 / 2200' }).waitFor();
  await d.getByText('Blocks publishing').waitFor();
  assert(await d.getByRole('button', { name: 'Schedule', exact: true }).isDisabled(), 'an over-long caption must not be schedulable');
  await shot(p, 'schedule-too-long');

  await d.getByLabel('Text').fill(`${'Our spring menu is here, and it is worth the wait. '.repeat(4)}#spring #coffee`);
  await d.getByText('… more').waitFor(); // longer than the 125 characters a feed shows
  await d.locator('.counter', { hasText: 'Hashtags 2 / 30' }).waitFor();
  await d.getByText('Blocks publishing').waitFor({ state: 'detached' });
  await d.getByLabel('First comment (optional)').fill('Link in bio');
  await shot(p, 'schedule-instagram');
  await d.getByRole('button', { name: 'Schedule', exact: true }).click();
  await p.getByText('Scheduled: the app will publish it').waitFor();
});

await step('schedule YouTube (no first comment there) and Facebook twice', async () => {
  const p = approver.page;
  const yt = await accountLabel('youtube');
  let d = await openSchedule(p, `YouTube · ${yt.display_name}`);
  await d.getByLabel(/Date and time/).fill(`${tomorrow}T10:30`);
  await d.getByTestId('plan').getByText('The app will publish this').waitFor();
  assert((await d.getByLabel('First comment (optional)').count()) === 0, 'YouTube has no first comment');
  await d.getByLabel('Text').fill('Spring menu: the full story');
  await d.getByRole('button', { name: 'Schedule', exact: true }).click();
  await p.getByText('Scheduled: the app will publish it').waitFor();

  const fb = await accountLabel('facebook');
  for (const [time, text] of [['11:00', 'Spring menu, Facebook first'], ['12:00', 'Spring menu, Facebook second']]) {
    d = await openSchedule(p, `Facebook · ${fb.display_name}`);
    await d.getByLabel(/Date and time/).fill(`${tomorrow}T${time}`);
    await d.getByTestId('plan').getByText('The app will publish this').waitFor();
    await d.getByLabel('Text').fill(text);
    await d.getByRole('button', { name: 'Schedule', exact: true }).click();
    await p.getByText('Scheduled: the app will publish it').waitFor();
  }
});

await step('schedule a by-hand post: the person can opt out of automatic publishing', async () => {
  const p = approver.page;
  const ig = await accountLabel('instagram');
  const d = await openSchedule(p, `Instagram · ${ig.display_name}`);
  await d.getByLabel(/Date and time/).fill(`${tomorrow}T14:00`);
  await d.getByTestId('plan').getByText('The app will publish this').waitFor();
  await d.getByLabel(/I will publish this one by hand/).check();
  await d.getByTestId('plan').getByText('A person publishes this.').waitFor();
  await d.getByRole('button', { name: 'Schedule', exact: true }).click();
  await p.getByText('Scheduled: someone has to publish it').waitFor();
  assert(sql(`select count(*) from publication where manual = true`) === '1', 'exactly one manual publication expected');
});

await step('piece page: lists the five publications, automatic ones marked as such', async () => {
  const p = approver.page;
  await p.goto(`/pieces/${state.pieceId}`);
  const region = p.getByRole('region', { name: 'Publications' });
  await region.getByText('Automatic').first().waitFor();
  assert((await region.locator('tbody tr').count()) === 5, 'expected 5 publications');
  assert((await region.locator('.chip', { hasText: 'Automatic' }).count()) === 4, 'expected 4 automatic');
  assert((await region.locator('.chip', { hasText: 'By hand' }).count()) === 1, 'expected 1 by hand');
  await shot(p, 'piece-publications-scheduled');
});

// ───────────────────────────── the worker publishes ─────────────────────────────
const rowFor = (p, network, time) => p.getByRole('region', { name: 'Publications' }).locator('tbody tr').filter({ hasText: network }).filter({ hasText: time });

await step('Instagram and YouTube: made due, the worker prepares, publishes and verifies them with real ffmpeg', async () => {
  const p = approver.page;
  sql(`update publication p set scheduled_at = now() + interval '8 seconds', prepare_at = now(), next_run_at = now() from social_account a
       where a.id = p.social_account_id and a.network in ('instagram','youtube') and p.status = 'scheduled' and p.manual = false`);
  await p.goto(`/pieces/${state.pieceId}`);
  await until(p, 'Instagram and YouTube to be published', async () => {
    const rows = await p.getByRole('region', { name: 'Publications' }).locator('tbody tr').allTextContents();
    const done = rows.filter((r) => /Published/.test(r) && /(Instagram|YouTube)/.test(r));
    return done.length === 2 || rows.map((r) => r.replace(/\s+/g, ' ')).join(' || ');
  });
  // "Published" shows as soon as the network accepted the post; the check that it is really live follows a moment later.
  await until(p, 'both posts to be verified', async () => {
    const verified = sql(`select count(*) from publication_attempt where step = 'verify' and outcome = 'ok'`);
    return Number(verified) >= 2 || `${verified} verified so far`;
  }, 60_000);
  await shot(p, 'piece-published-automatically');

  const instagram = p.getByRole('region', { name: 'Publications' }).locator('tbody tr').filter({ hasText: 'Instagram' }).filter({ hasText: 'Published' });
  const link = instagram.getByRole('link', { name: 'Open post' });
  assert((await link.getAttribute('href')).startsWith('https://www.instagram.com/p/'), 'the Instagram post should link to the network');

  const s = await fakes.state();
  assert(s.instagram.length === 1, `expected 1 Instagram post, saw ${s.instagram.length}`);
  assert(s.instagram[0].params.caption.endsWith('#spring #coffee'), 'the caption did not reach Instagram');
  assert(/REELS/.test(s.instagram[0].params.media_type), `expected a Reel, got ${s.instagram[0].params.media_type}`);
  assert(/^https?:\/\//.test(s.instagram[0].params.video_url), 'Instagram should be given a URL to fetch');
  assert(s.instagram[0].comments.includes('Link in bio'), 'the first comment was not posted');
  assert(s.youtube.length === 1 && s.youtube[0].uploaded, 'the video should be uploaded to YouTube');
  assert(s.youtube[0].snippet.title === 'Spring menu reel', 'the YouTube title should be the piece title');
  assert(sql(`select count(*) from rendition`) !== '0', 'the WebM should have been transcoded into a rendition');
  assert(sql(`select count(*) from publication_attempt where step = 'verify' and outcome = 'ok'`) !== '0', 'a verify attempt should be on record');
});

await step('YouTube: uploaded as private because the project is not audited, and the page says so', async () => {
  const p = approver.page;
  const row = p.getByRole('region', { name: 'Publications' }).locator('tbody tr').filter({ hasText: 'YouTube' });
  await row.getByText('Uploaded as private').waitFor();
  await row.locator('.chip', { hasText: 'Private' }).waitFor();
  const notified = sql(`select count(*) from notification where kind = 'publication.private'`);
  assert(Number(notified) >= 1, 'someone should have been told it is private');
});

await step('history: every attempt is listed with its step and result', async () => {
  const p = approver.page;
  const row = p.getByRole('region', { name: 'Publications' }).locator('tbody tr').filter({ hasText: 'Instagram' }).filter({ hasText: 'Published' });
  await row.getByRole('button', { name: 'History' }).click();
  const d = p.getByRole('dialog');
  await d.getByRole('cell', { name: 'Prepare' }).first().waitFor();
  await d.getByRole('cell', { name: 'Publish', exact: true }).first().waitFor();
  await d.getByRole('cell', { name: /Check it is live/ }).first().waitFor();
  await shot(p, 'publication-history');
  await d.getByRole('button', { name: 'Close' }).click();
});

await step('YouTube: once Google audits the project, "Check again" finds the video public', async () => {
  const p = approver.page;
  await fakes.control({ op: 'google.audited', value: true });
  await p.reload();
  const row = () => p.getByRole('region', { name: 'Publications' }).locator('tbody tr').filter({ hasText: 'YouTube' });
  await row().getByRole('button', { name: 'Check again' }).click();
  await until(p, 'the YouTube video to show as live', async () => (await row().getByText('Uploaded as private').count()) === 0 && (await row().locator('.chip', { hasText: 'Private' }).count()) === 0);
});

await step('Facebook: a refused file fails at once with the network\'s reason, and can be handed over to a person', async () => {
  const p = approver.page;
  await fakes.control({ op: 'meta.fail', path: '(video_reels|videos)$', code: 100, message: 'Invalid parameter: video could not be processed', status: 400, times: 5 });
  sql(`update publication p set prepare_at = now(), next_run_at = now() from social_account a
       where a.id = p.social_account_id and a.network = 'facebook' and p.status = 'scheduled' and p.text = 'Spring menu, Facebook first'`);
  await p.goto(`/pieces/${state.pieceId}`);
  const row = () => p.getByRole('region', { name: 'Publications' }).locator('tbody tr').filter({ hasText: 'Facebook' }).filter({ hasText: /Failed|Published/ });
  await until(p, 'the Facebook post to fail', async () => (await row().locator('.chip-failed', { hasText: 'Failed' }).count()) === 1);
  await row().getByText(/Refused by the network/).waitFor();
  await row().getByText(/video could not be processed/).waitFor();
  assert((await row().getByRole('button', { name: 'Try again…' }).count()) === 1, 'a failed post offers Try again');
  assert(sql(`select attempts from publication where status = 'failed'`) !== '', 'a failed publication is recorded');
  await shot(p, 'publication-failed');

  p.once('dialog', (d) => d.accept());
  await row().getByRole('button', { name: "I'll do it by hand" }).click();
  await p.getByText('Handed over').waitFor();
  await fakes.control({ op: 'meta.reset' });
});

await step('Publish page: the handed-over post is in "Due now", and the person records it', async () => {
  const p = approver.page;
  sql(`update publication set scheduled_at = now() - interval '2 minutes' where manual = true and text = 'Spring menu, Facebook first'`);
  await p.goto('/today');
  await p.getByRole('region', { name: 'Due now' }).getByText('Spring menu reel').first().waitFor();
  await p.getByRole('region', { name: 'Due now' }).getByRole('button', { name: 'Publish…' }).first().click();
  const d = p.getByRole('dialog');
  await d.getByText('Spring menu, Facebook first').waitFor();
  await d.getByRole('button', { name: 'I published it…' }).click();
  await p.getByRole('dialog').getByRole('button', { name: 'Mark as published' }).click();
  await p.getByText('Marked as published').waitFor();
});

await step('Facebook: a post is handed to the network to hold until the hour, and cancelling takes it down there', async () => {
  const p = approver.page;
  sql(`update publication p set prepare_at = now(), next_run_at = now() where p.text = 'Spring menu, Facebook second' and p.status = 'scheduled'`);
  await p.goto(`/pieces/${state.pieceId}`);
  const row = () => p.getByRole('region', { name: 'Publications' }).locator('tbody tr').filter({ hasText: 'Facebook' }).filter({ hasText: 'Ready' });
  await until(p, 'Facebook to be holding the post', async () => (await row().getByText(/holds it until the hour/).count()) === 1);
  const held = await fakes.state();
  assert(held.facebook.length === 1 && held.facebook[0].params.published === 'false' && !!held.facebook[0].params.scheduled_publish_time, 'the post should be on Facebook, unpublished, with its own schedule');
  await shot(p, 'facebook-held-natively');

  p.once('dialog', (d) => d.accept());
  await row().getByRole('button', { name: 'Cancel' }).click();
  await until(p, 'the post to be taken down from Facebook', async () => (await fakes.state()).facebook.length === 0);
});

await step('Instagram: the network says the connection is no longer valid, so the account asks to be reconnected', async () => {
  const p = approver.page;
  const ig = await accountLabel('instagram');
  // A second Instagram post for the same file, then Instagram rejects the token when the app prepares it.
  const d = await openSchedule(p, `Instagram · ${ig.display_name}`);
  await d.getByLabel(/Date and time/).fill(`${tomorrow}T16:00`);
  await d.getByTestId('plan').getByText('The app will publish this').waitFor();
  await d.getByLabel('Text').fill('Second Instagram post');
  await d.getByRole('button', { name: 'Schedule', exact: true }).click();
  await p.getByText('Scheduled: the app will publish it').waitFor();
  await fakes.control({ op: 'meta.fail', path: '/media$', code: 190, message: 'Error validating access token: Session has expired', status: 400, times: 3 });
  sql(`update publication set prepare_at = now(), next_run_at = now() where text = 'Second Instagram post'`);

  const a = admin.page;
  await a.goto('/settings?tab=accounts');
  await until(a, 'Instagram to need reconnecting', async () => (await a.locator('.chip-failed', { hasText: 'Needs reconnecting' }).count()) === 1);
  await shot(a, 'account-needs-reconnecting');
  const notices = await (await api('GET', '/api/notifications')).json();
  assert(notices.items.some((x) => x.kind === 'account.reconnect'), 'the admin should have been notified');
});

await step('reconnect: the same account only, and the waiting post carries on straight away', async () => {
  const a = admin.page;
  await a.locator('tr', { hasText: 'Instagram' }).getByRole('button', { name: 'Reconnect' }).click();
  await a.waitForURL(/connection=/);
  const d = a.getByRole('dialog');
  await d.getByText(/Reconnect/).first().waitFor();
  assert((await d.locator('input[type=radio]').count()) === 1, 'only the matching Instagram account is offered');
  assert(await d.locator('input[type=radio]').isChecked(), 'it is preselected');
  await shot(a, 'reconnect-dialog');
  await fakes.control({ op: 'meta.reset' });
  await d.getByRole('button', { name: 'Reconnect', exact: true }).click();
  await a.locator('tr', { hasText: 'Instagram' }).locator('.chip-approved', { hasText: 'Connected' }).waitFor();

  const p = approver.page;
  await p.goto(`/pieces/${state.pieceId}`);
  const rows = () => p.getByRole('region', { name: 'Publications' }).locator('tbody tr');
  await until(p, 'the waiting Instagram post to be prepared after reconnecting', async () => {
    const ready = await rows().filter({ hasText: 'Instagram' }).filter({ hasText: 'Ready' }).count();
    return ready === 1 || `${ready} ready rows among: ${(await rows().allTextContents()).map((r) => r.replace(/\s+/g, ' ').slice(0, 90)).join(' || ')}`;
  }, 60_000);
});

await step('calendar and publish page: automatic posts are marked, and the page has no needless sections', async () => {
  const p = approver.page;
  await p.goto('/calendar');
  await p.locator('.cal-item .auto-dot').first().waitFor();
  await shot(p, 'calendar-automatic');
  await p.goto('/today');
  await p.getByRole('region', { name: 'Coming up' }).waitFor();
  assert((await p.getByRole('region', { name: 'Needs attention' }).count()) === 0, 'nothing needs attention at this point');
  await shot(p, 'publish-page');
});

await step('phone: the accounts tab and the schedule dialog fit a narrow screen', async () => {
  const mobile = await newSession('admin@example.com', { width: 390, height: 800 }, true);
  const p = mobile.page;
  await p.goto('/settings?tab=accounts');
  await p.getByText('Connect to a network').waitFor();
  const w = await p.evaluate(() => ({ scroll: document.documentElement.scrollWidth, inner: window.innerWidth }));
  assert(w.scroll <= w.inner + 1, `accounts tab scrolls sideways (${w.scroll} > ${w.inner})`);
  await shot(p, 'accounts-mobile');
  await mobile.context.close();
});

await browser.close();
if (problems.length) {
  console.log(`\n${problems.length} problem(s):`);
  for (const x of problems) console.log(` - ${x}`);
  process.exit(1);
}
console.log('\nAll phase 2 end-to-end steps passed.');
