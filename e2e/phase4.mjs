// End-to-end check of phase 4 against FAKE networks: the six new networks (Threads, Bluesky, X, LinkedIn, Pinterest, TikTok), the
// per-network options in the schedule dialog, results (metrics) and prizes for commenting, all through the real UI, with the real
// worker, real ffmpeg, real PostgreSQL and a real browser.
//
// What this proves: the app's own behaviour end to end. What it cannot prove: that the real networks behave like the fakes in
// apps/api/test/fakes (written from each network's documentation; nothing here reaches a real network). See docs/phase-4.md.
//
// Needs the API running against e2e/fakes.mts (e2e/phase4.sh does it all), on an EMPTY database that has only been bootstrapped.
// Environment: BASE_URL, FAKES_URL, ASSETS, SHOTS, DATABASE_URL (psql URI), CHROMIUM, E2E_BLUESKY_HANDLE, E2E_BLUESKY_PASSWORD.
import { chromium } from 'playwright-core';
import { createHmac } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

const BASE = process.env.BASE_URL ?? 'http://localhost:3300';
const FAKES = process.env.FAKES_URL ?? 'http://127.0.0.1:4040';
const ASSETS = process.env.ASSETS ?? path.resolve('e2e/assets');
const SHOTS = process.env.SHOTS ?? path.resolve('e2e/shots-phase4');
const DB = process.env.DATABASE_URL ?? 'postgres://postgres@localhost:5433/estudio_e2e_phase4';
const META_SECRET = 'e2e-secret';
mkdirSync(SHOTS, { recursive: true });

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM ?? '/opt/pw-browsers/chromium', args: ['--no-sandbox', '--disable-background-networking', '--no-first-run'] });
const problems = [];
let n = 0;

async function newSession(email, viewport = { width: 1280, height: 900 }, mobile = false) {
  const context = await browser.newContext({ baseURL: BASE, locale: 'en-US', viewport, isMobile: mobile, hasTouch: mobile, acceptDownloads: true });
  // The interface is in Spanish unless the person chose otherwise; these steps read its English.
  await context.addInitScript(() => { try { localStorage.setItem('studio.locale', 'en'); } catch { /* no storage: Spanish */ } });
  const page = await context.newPage();
  page.on('pageerror', (e) => problems.push(`[${email}] page error: ${e.message}`));
  page.on('console', (m) => m.type() === 'error' && !/status of (4\d\d|5\d\d)/.test(m.text()) && problems.push(`[${email}] console error: ${m.text()}`));
  await page.goto('/login');
  await page.getByLabel('Email').fill(email);
  await page.getByRole('button', { name: /Development sign-in/ }).click();
  await page.waitForURL('**/pieces');
  return { context, page };
}

/** A visitor with no account: the page a prize message links to is opened like this. */
async function anonymous(viewport = { width: 1280, height: 800 }) {
  const context = await browser.newContext({ baseURL: BASE, locale: 'en-US', viewport, acceptDownloads: true });
  // The interface is in Spanish unless the person chose otherwise; these steps read its English.
  await context.addInitScript(() => { try { localStorage.setItem('studio.locale', 'en'); } catch { /* no storage: Spanish */ } });
  const page = await context.newPage();
  page.on('pageerror', (e) => problems.push(`[anonymous] page error: ${e.message}`));
  page.on('console', (m) => m.type() === 'error' && !/status of (4\d\d|5\d\d)/.test(m.text()) && problems.push(`[anonymous] console error: ${m.text()}`));
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
async function until(page, what, check, timeoutMs = 90_000, reload = true) {
  const t0 = Date.now();
  let last = '';
  while (Date.now() - t0 < timeoutMs) {
    try {
      const r = await check();
      if (r === true) return;
      last = String(r);
    } catch (e) { last = e.message; }
    await new Promise((r) => setTimeout(r, 1500));
    if (reload) {
      await page.reload();
      await page.waitForLoadState('networkidle');
    }
  }
  throw new Error(`Timed out waiting for ${what}. Last seen: ${last}`);
}

const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
const state = {};

const admin = await newSession('admin@example.com');
const api = (method, url, data) => admin.context.request.fetch(url, { method, data, headers: { 'x-requested-by': 'studio', 'accept-language': 'en' } });
const accountOf = async (network) => (await (await api('GET', `/api/brands/${state.brandId}/accounts`)).json()).find((a) => a.network === network);

await step('seed: the fake networks start blank, members are added, and TikTok has this site as its verified media domain', async () => {
  await fakes.control({ op: 'reset' });
  await fakes.control({ op: 'tiktok.domain', value: BASE });
  const me = await (await api('GET', '/api/me')).json();
  state.brandId = me.brands[0].id;
  for (const [email, name, role] of [['approver@example.com', 'Ana Approver', 'approver'], ['producer@example.com', 'Paula Producer', 'producer']]) {
    const r = await api('POST', `/api/brands/${state.brandId}/members`, { email, name, role });
    assert(r.ok(), `adding ${email}: ${r.status()}`);
  }
});

// ───────────────────────────── connecting the new networks ─────────────────────────────
/** The accounts list refreshes a moment after a dialog closes: wait for the number of connected accounts rather than count at once. */
async function connectedCount(p, n) {
  const chips = p.locator('.chip-approved', { hasText: 'Connected' });
  for (let i = 0; i < 40; i++) {
    if ((await chips.count()) === n) return;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`${n} accounts should show as connected, ${await chips.count()} do`);
}
const BUTTONS = ['Facebook and Instagram', 'YouTube', 'Threads', 'TikTok', 'LinkedIn', 'X', 'Pinterest', 'Bluesky'];

await step('accounts: a connect button for every network, all enabled because the server has credentials', async () => {
  const p = admin.page;
  await p.goto('/settings?tab=accounts');
  await p.getByText('Connect to a network').waitFor();
  for (const b of BUTTONS) assert(await p.getByRole('button', { name: `Connect ${b}`, exact: true }).isEnabled(), `Connect ${b} should be enabled`);
  await shot(p, 'accounts-eight-networks');
});

await step('connect Threads, X, LinkedIn and TikTok through their sign-in pages: one account each, preselected', async () => {
  const p = admin.page;
  for (const [button, shown] of [['Threads', '@lumen.coffee'], ['X', /lumencoffee/], ['LinkedIn', 'Lumen Coffee'], ['TikTok', '@lumencoffee']]) {
    await p.getByRole('button', { name: `Connect ${button}`, exact: true }).click();
    await p.waitForURL(/connection=/);
    const d = p.getByRole('dialog');
    await d.getByText('Choose what to connect').waitFor();
    await d.getByText(shown).first().waitFor();
    await d.getByRole('button', { name: 'Connect', exact: true }).click();
    await d.waitFor({ state: 'detached' });
  }
  await connectedCount(p, 4);
});

await step('connect Pinterest: the choice is a board, and two are offered', async () => {
  const p = admin.page;
  await p.getByRole('button', { name: 'Connect Pinterest', exact: true }).click();
  await p.waitForURL(/connection=/);
  const d = p.getByRole('dialog');
  await d.getByText('Spring menu').waitFor();
  await d.getByText('Behind the bar').waitFor();
  assert(await d.getByRole('button', { name: 'Connect', exact: true }).isDisabled(), 'with two boards nothing is pre-selected');
  await d.getByLabel(/Spring menu/).check();
  await shot(p, 'connect-pinterest-boards');
  await d.getByRole('button', { name: 'Connect', exact: true }).click();
  await d.waitFor({ state: 'detached' });
  await connectedCount(p, 5);
});

await step('connect Bluesky: no sign-in page, so a form; a wrong app password is refused in plain words, the right one connects', async () => {
  const p = admin.page;
  await p.getByRole('button', { name: 'Connect Bluesky', exact: true }).click();
  const d = p.getByRole('dialog');
  await d.getByRole('heading', { name: 'Connect Bluesky' }).waitFor();
  assert((await d.locator('input[type=password]').count()) === 1, 'the app password must be a password field');
  await d.getByLabel('Handle').fill(process.env.E2E_BLUESKY_HANDLE ?? 'lumen.bsky.social');
  await d.getByLabel('App password').fill('not-the-password');
  await d.getByRole('button', { name: 'Continue' }).click();
  await d.getByText(/did not accept that handle and app password/).waitFor();
  await d.getByLabel('App password').fill(process.env.E2E_BLUESKY_PASSWORD ?? 'app-pass-1234');
  await shot(p, 'connect-bluesky-form');
  await d.getByRole('button', { name: 'Continue' }).click();
  await p.waitForURL(/connection=/);
  await p.getByRole('dialog').getByText('Choose what to connect').waitFor();
  await p.getByRole('dialog').getByRole('button', { name: 'Connect', exact: true }).click();
  await p.getByRole('dialog').waitFor({ state: 'detached' });
  await connectedCount(p, 6);
  assert(!(await p.content()).includes(process.env.E2E_BLUESKY_PASSWORD ?? 'app-pass-1234'), 'the app password must not come back to the page');
});

await step('secrets: no token or password reaches the browser, and the database holds them sealed', async () => {
  const text = await (await api('GET', `/api/brands/${state.brandId}/accounts`)).text();
  assert(!/token|password/i.test(text.replace(/token_expires|dataAccessExpiresAt/gi, '')), 'the accounts response mentions a token or password');
  for (const needle of ['long-', 'app-pass', 'tok-', 'access-']) {
    assert(sql(`select count(*) from social_account where token_encrypted is not null and position('${needle}'::bytea in token_encrypted) > 0`) === '0', `"${needle}" is stored in the clear`);
  }
});

await step('approval flags: TikTok and Pinterest say posts stay private until the network approves the app, and an admin can flip it', async () => {
  const p = admin.page;
  await p.goto('/settings?tab=accounts');
  // Each account is a row; a network that reviews the app has a switch under it.
  const tiktok = p.locator('li.ent', { hasText: 'TikTok' });
  await tiktok.getByText(/until then posts are made private/).waitFor();
  const pinterest = p.locator('li.ent', { hasText: 'Pinterest' });
  await pinterest.getByText(/until then pins are not visible to others/).waitFor();
  assert((await p.locator('li.ent', { hasText: 'Threads' }).getByRole('switch').count()) === 0, 'Threads has no approval flag');
  await shot(p, 'accounts-all-networks');
});

await step('connect Meta without prizes: only the usual permissions are asked for', async () => {
  const p = admin.page;
  await p.getByRole('button', { name: 'Connect Facebook and Instagram', exact: true }).click();
  await p.waitForURL(/connection=/);
  const d = p.getByRole('dialog');
  await d.getByText('lumen.coffee').waitFor();
  await d.getByRole('checkbox').first().check();
  await d.getByRole('checkbox').nth(1).check();
  await d.getByRole('button', { name: /Connect 2/ }).click();
  await d.waitFor({ state: 'detached' });
  await connectedCount(p, 8);
  const asked = (await fakes.state()).metaCalls;
  assert(asked.length > 0, 'Meta should have been called');
});

// ───────────────────────────── a piece for every network ─────────────────────────────
const producer = await newSession('producer@example.com');
await step('producer: creates a photo piece (4:5) and uploads an image', async () => {
  const p = producer.page;
  await p.getByRole('button', { name: 'New piece' }).click();
  const d = p.getByRole('dialog');
  await d.getByLabel('Title').fill('Spring menu photo');
  await d.getByRole('button', { name: 'Create piece' }).click();
  await p.waitForURL(/\/pieces\/[0-9a-f-]{36}$/);
  state.pieceId = p.url().split('/').pop();
  await p.getByRole('button', { name: 'Add variant' }).first().click();
  const v = p.getByRole('dialog');
  await v.getByLabel('Format').selectOption('4:5');
  await v.getByRole('button', { name: 'Add variant' }).click();
  await p.getByRole('button', { name: /Upload (first|new) version/ }).first().click();
  const u = p.getByRole('dialog');
  await u.locator('input[type=file]').setInputFiles([path.join(ASSETS, 'slide-1.png')]);
  await u.getByRole('button', { name: 'Upload and send to review' }).click();
  await p.getByText('Version uploaded and sent to review').waitFor({ timeout: 60_000 });
});

const approver = await newSession('approver@example.com');
await step('approver: approves the photo for every account', async () => {
  const p = approver.page;
  await p.goto(`/pieces/${state.pieceId}`);
  await p.getByRole('link', { name: 'Review', exact: true }).click();
  await p.waitForURL(/\/review\//);
  state.reviewUrl = p.url();
  await p.getByRole('button', { name: 'Approve…' }).click();
  const d = p.getByRole('dialog');
  for (const name of [/^Instagram ·/, /^Facebook ·/, /^Threads ·/, /^Bluesky ·/, /^X ·/, /^LinkedIn ·/, /^Pinterest ·/, /^TikTok ·/]) await d.getByLabel(name).check();
  await d.getByRole('button', { name: 'Approve', exact: true }).click();
  await p.getByText('Approved for 8 accounts').waitFor();
});

// ───────────────────────────── schedule: what each network asks for ─────────────────────────────
async function openSchedule(p, network) {
  await p.goto(state.reviewUrl);
  await p.getByRole('button', { name: 'Schedule…' }).click();
  const d = p.getByRole('dialog');
  const acc = await accountOf(network);
  await d.getByRole('combobox').first().selectOption({ label: `${{ x: 'X', tiktok: 'TikTok', linkedin: 'LinkedIn', threads: 'Threads', bluesky: 'Bluesky', pinterest: 'Pinterest', instagram: 'Instagram', facebook: 'Facebook' }[network]} · ${acc.display_name}` });
  await d.getByLabel(/Date and time/).fill(`${tomorrow}T${state.nextTime()}`);
  await d.getByTestId('plan').waitFor();
  return d;
}
let minute = 0;
state.nextTime = () => `${String(9 + Math.floor(minute / 60)).padStart(2, '0')}:${String(minute++ % 60).padStart(2, '0')}`;
const textBox = (d) => d.getByRole('textbox', { name: /^Text( |$)/ });
const scheduleButton = (d) => d.getByRole('button', { name: 'Schedule', exact: true });

await step('Threads: counts characters, text-only options do not appear, and it schedules', async () => {
  const p = approver.page;
  const d = await openSchedule(p, 'threads');
  await d.getByTestId('plan').getByText('The app will publish this').waitFor();
  await textBox(d).fill('Spring menu is here, come and try it');
  await d.locator('.counter', { hasText: 'Characters 36 / 500' }).waitFor();
  assert((await d.getByTestId('options-threads').count()) === 0, 'Threads declares no settings of its own');
  await scheduleButton(d).click();
  await p.getByText('Scheduled: the app will publish it').waitFor();
});

await step('Bluesky: the limit counts what a person sees as one character, not code points', async () => {
  const p = approver.page;
  const d = await openSchedule(p, 'bluesky');
  const family = '\u{1F468}‍\u{1F469}‍\u{1F467}‍\u{1F466}'; // one family emoji: seven code points, one character
  await textBox(d).fill(`${family.repeat(3)} spring #menu`);
  // 3 emoji + " spring #menu" (13) = 16 as seen; by code points it would be 3 * 7 + 13 = 34.
  await d.locator('.counter', { hasText: 'Characters (as seen) 16 / 300' }).waitFor();
  await d.getByLabel(/Description of the picture/).fill('A latte on a wooden table');
  await d.getByTestId('options-bluesky').waitFor();
  await scheduleButton(d).click();
  await p.getByText('Scheduled: the app will publish it').waitFor();
});

await step('X: alt text is a setting of its own; it schedules', async () => {
  const p = approver.page;
  const d = await openSchedule(p, 'x');
  await textBox(d).fill('Spring menu is here');
  await d.getByLabel(/Description of the picture/).fill('A latte on a wooden table');
  await d.getByTestId('plan').getByText('The app will publish this').waitFor();
  await scheduleButton(d).click();
  await p.getByText('Scheduled: the app will publish it').waitFor();
});

await step('LinkedIn: an image post asks for alt text, not the document title', async () => {
  const p = approver.page;
  const d = await openSchedule(p, 'linkedin');
  await textBox(d).fill('Our spring menu, now on LinkedIn');
  await d.getByLabel(/Description of the picture/).waitFor();
  assert((await d.getByLabel(/Title of the video or document/).count()) === 0, 'the document title is for videos and documents only');
  await scheduleButton(d).click();
  await p.getByText('Scheduled: the app will publish it').waitFor();
});

await step('Pinterest: title and destination link are settings of the pin; it schedules', async () => {
  const p = approver.page;
  const d = await openSchedule(p, 'pinterest');
  await textBox(d).fill('Spring menu ideas');
  await d.getByLabel(/Pin title/).fill('Spring menu');
  await d.getByLabel(/Destination link/).fill('https://example.com/spring-menu');
  await scheduleButton(d).click();
  await p.getByText('Scheduled: the app will publish it').waitFor();
});

await step('TikTok: the settings come from TikTok while the post is written, nothing is chosen for the person, one consent sentence at a time', async () => {
  const p = approver.page;
  const d = await openSchedule(p, 'tiktok');
  await textBox(d).fill('Spring menu on TikTok #spring');
  // The settings are asked of TikTok now (creator_info, through /api/brands/:id/accounts/:id/options): who posts, and what it allows.
  const opts = d.getByTestId('options-tiktok');
  await opts.waitFor();
  await opts.getByText(/^Posting to TikTok as /).waitFor();
  const privacy = opts.getByLabel(/Who can see this post/);
  assert((await privacy.inputValue()) === '', 'who can see the post must start empty');
  // The app has not passed TikTok's audit: TikTok only takes "Only me", so that is the only choice offered.
  const offered = (await privacy.locator('option').allTextContents()).filter((t) => t !== 'Choose…');
  assert(JSON.stringify(offered) === JSON.stringify(['Only me']), `before the audit only "Only me" is offered, got ${JSON.stringify(offered)}`);
  for (const label of ['Allow comments', 'Allow duets', 'Allow stitches']) {
    const box = opts.getByLabel(new RegExp(label));
    if (await box.count()) assert(!(await box.isChecked()), `${label} must start unticked`);
  }
  // A photo post: duets and stitches are for videos.
  await d.getByTestId('plan').getByText(/Photos/).waitFor().catch(() => {});
  const plainConsent = opts.getByText("By posting, you agree to TikTok's Music Usage Confirmation.", { exact: true });
  const brandedConsent = opts.getByText("By posting, you agree to TikTok's Branded Content Policy and Music Usage Confirmation.", { exact: true });
  await plainConsent.waitFor();
  assert((await brandedConsent.count()) === 0, 'only one consent sentence is shown at a time');
  await d.getByText(/Choose who can see this post/).waitFor();
  assert(await scheduleButton(d).isDisabled(), 'without a privacy choice it cannot be scheduled');
  await d.getByText(/has not passed TikTok's audit yet/).waitFor();
  await shot(p, 'schedule-tiktok-empty');

  await privacy.selectOption({ label: 'Only me' });
  await d.getByText(/Choose who can see this post/).waitFor({ state: 'detached' });
  await d.getByText(/TikTok needs this agreement before posting/).waitFor();

  // Promoting something has to say what; branded content cannot be private, and brings its own consent sentence instead of the plain one.
  await opts.getByLabel(/This post promotes a brand/).check();
  await d.getByText(/say whether it is your own brand, branded content, or both/).waitFor();
  await opts.getByLabel(/^Branded content/).check();
  assert(await privacy.locator('option', { hasText: 'Only me' }).isDisabled(), '"Only me" cannot be picked for branded content');
  await d.getByText(/Branded content cannot be private/).waitFor();
  await brandedConsent.waitFor();
  assert((await plainConsent.count()) === 0, 'the branded-content consent replaces the plain one');
  await d.getByText(/TikTok needs this agreement for branded content/).waitFor();
  await shot(p, 'schedule-tiktok-branded');
  await opts.getByLabel(/This post promotes a brand/).uncheck();
  await d.getByText(/Branded content cannot be private|say whether it is your own brand/).waitFor({ state: 'detached' });
  await plainConsent.waitFor();
  assert((await brandedConsent.count()) === 0, 'back to the plain consent sentence');
  // The consent is the last thing missing.
  await d.getByText(/TikTok needs this agreement before posting/).waitFor();
  await opts.getByRole('checkbox', { name: /I agree/ }).check();
  await d.getByText(/TikTok needs this agreement before posting/).waitFor({ state: 'detached' });
  await shot(p, 'schedule-tiktok-ready');
  await scheduleButton(d).click();
  await p.getByText('Scheduled: the app will publish it').waitFor();
});

await step('Instagram and Facebook: a plain caption, as before', async () => {
  const p = approver.page;
  for (const network of ['instagram', 'facebook']) {
    const d = await openSchedule(p, network);
    await textBox(d).fill('Comment RECIPE and we will send you the spring menu recipe!');
    await d.getByTestId('plan').getByText('The app will publish this').waitFor();
    await scheduleButton(d).click();
    await p.getByText('Scheduled: the app will publish it').waitFor();
  }
  assert(sql(`select count(*) from publication where status = 'scheduled' and manual = false`) === '8', 'eight automatic publications expected');
});

await step('what was typed is kept as the post\'s options (and nothing hidden is sent)', async () => {
  const rows = sql(`select a.network, p.options::text from publication p join social_account a on a.id = p.social_account_id order by a.network`).split('\n');
  const opts = Object.fromEntries(rows.map((r) => { const [net, ...rest] = r.split('|'); return [net, JSON.parse(rest.join('|'))]; }));
  assert(opts.tiktok.privacy === 'SELF_ONLY' && opts.tiktok.consent === true, `TikTok options wrong: ${JSON.stringify(opts.tiktok)}`);
  assert(opts.tiktok.consentBranded === undefined && opts.tiktok.yourBrand === undefined && opts.tiktok.brandedContent === undefined, `hidden TikTok fields were sent: ${JSON.stringify(opts.tiktok)}`);
  assert(opts.x.altText === 'A latte on a wooden table', `X alt text wrong: ${JSON.stringify(opts.x)}`);
  assert(opts.pinterest.link === 'https://example.com/spring-menu' && opts.pinterest.title === 'Spring menu', `Pinterest options wrong: ${JSON.stringify(opts.pinterest)}`);
});

// ───────────────────────────── the worker publishes ─────────────────────────────
await step('the worker publishes to all eight networks, and each fake received what was asked', async () => {
  const p = approver.page;
  sql(`update publication set scheduled_at = now() + interval '8 seconds', prepare_at = now(), next_run_at = now() where status = 'scheduled' and manual = false`);
  await p.goto(`/pieces/${state.pieceId}`);
  await until(p, 'eight publications to be published', async () => {
    const pending = sql(`select string_agg(a.network || ':' || p.status || coalesce(' (' || p.last_error || ')', ''), ', ') from publication p join social_account a on a.id = p.social_account_id where p.status <> 'published'`);
    return pending === '' || `still not published: ${pending}`;
  }, 150_000);
  await shot(p, 'piece-published-eight-networks');

  const s = await fakes.state();
  assert(s.threads.length === 1 && s.threads[0].text === 'Spring menu is here, come and try it', `Threads: ${JSON.stringify(s.threads)}`);
  assert(s.bluesky.length === 1 && /spring #menu$/.test(s.bluesky[0].text), `Bluesky: ${JSON.stringify(s.bluesky)}`);
  assert(s.bluesky[0].facets === 1, 'the hashtag in the Bluesky post should be a link facet');
  assert(s.bluesky[0].embed?.$type?.includes('images') && s.bluesky[0].embed.images?.length === 1, `Bluesky should carry the image: ${JSON.stringify(s.bluesky[0].embed)}`);
  assert(s.bluesky[0].embed.images[0].alt === 'A latte on a wooden table', 'the alt text should reach Bluesky with the picture');
  assert(Object.values(s.xAlt).includes('A latte on a wooden table'), `the alt text should reach X: ${JSON.stringify(s.xAlt)}`);
  assert(s.x.length === 1 && s.x[0].text === 'Spring menu is here' && s.x[0].media.length === 1, `X: ${JSON.stringify(s.x)}`);
  assert(s.linkedin.length === 1 && s.linkedin[0].commentary === 'Our spring menu, now on LinkedIn', `LinkedIn: ${JSON.stringify(s.linkedin)}`);
  assert(s.pinterest.length === 1 && s.pinterest[0].link === 'https://example.com/spring-menu' && s.pinterest[0].title === 'Spring menu', `Pinterest: ${JSON.stringify(s.pinterest)}`);
  assert(s.tiktok.length === 1, `TikTok: ${JSON.stringify(s.tiktok)}`);
  assert(s.tiktok[0].info.privacy_level === 'SELF_ONLY', `TikTok must be private until audited, got ${s.tiktok[0].info.privacy_level}`);
  assert(s.instagram.length === 1 && s.facebook.length === 1, 'Instagram and Facebook each should have one post');
});

await step('TikTok and Pinterest: posted but private until the network approves the app, and the page says so in each one\'s own words', async () => {
  const p = approver.page;
  await p.goto(`/pieces/${state.pieceId}`);
  const row = (network) => p.getByRole('region', { name: 'Publications' }).locator('tbody tr').filter({ hasText: network });
  await until(p, 'both posts to be verified as private', async () => {
    const t = await row('TikTok').innerText();
    const q = await row('Pinterest').innerText();
    return (/Posted as private: TikTok/.test(t) && /not visible to others until Pinterest/.test(q)) || `${t.replace(/\s+/g, ' ')} || ${q.replace(/\s+/g, ' ')}`;
    // TikTok is still processing the upload at the first check; the engine looks again after a wait of its own (about a minute).
  }, 180_000);
  await row('TikTok').locator('.chip', { hasText: 'Private' }).waitFor();
  assert(!/Google/.test(await row('TikTok').innerText()), 'TikTok must not be explained in Google\'s words');
  await shot(p, 'piece-private-until-approved');
});

// ───────────────────────────── results ─────────────────────────────
await step('results: readings come in when they fall due, and each network is shown on its own, never added together', async () => {
  const p = admin.page;
  await until(p, 'every public post to have its 1 hour reading scheduled', async () => {
    const c = sql(`select count(*) from metric_snapshot`);
    return Number(c) >= 4 || `${c} snapshots so far`;
  }, 60_000, false);
  sql(`update metric_snapshot set due_at = now(), next_attempt_at = now() where age = '1h'`);
  await until(p, 'the 1 hour readings to be taken', async () => {
    const c = sql(`select count(*) from metric_snapshot where age = '1h' and status = 'ok'`);
    const all = sql(`select count(*) from metric_snapshot where age = '1h'`);
    return (Number(c) > 0 && c === all) || `${c} of ${all} read`;
  }, 90_000, false);
  await p.goto('/results');
  await p.getByRole('navigation', { name: 'Breadcrumb' }).getByText('Results').waitFor();
  // One section per network, named by its heading.
  const sections = await p.locator('section.rs-net').evaluateAll((els) => els.map((e) => e.querySelector('h2')?.textContent?.trim() ?? ''));
  for (const name of ['Instagram', 'Facebook', 'Threads', 'Bluesky', 'X', 'LinkedIn']) assert(sections.includes(name), `no results section for ${name}: ${sections.join(', ')}`);
  // Private posts are listed (they were published) but have no readings: nothing is taken until a post is public.
  for (const name of ['TikTok', 'Pinterest']) {
    assert(sections.includes(name), `${name} should be listed even without readings: ${sections.join(', ')}`);
    const s = p.getByRole('region', { name });
    await s.getByText('0 with a reading').waitFor();
    await s.getByText('Not read yet').waitFor();
    await s.getByText(/Private: numbers are for a post only the account can see/).waitFor();
  }
  // Threads: views 120, likes 9 (the fake's numbers), shown under its own heading.
  const threads = p.getByRole('region', { name: 'Threads' });
  await threads.getByText('120').first().waitFor();
  assert(await threads.locator('td.num', { hasText: '9' }).count() > 0, 'Threads likes should show');
  assert((await p.getByText(/all networks/i).count()) === 1, 'only the filter says "All networks": there is no total across networks');
  await shot(p, 'results-by-network');
  await p.getByLabel('Network').selectOption('x');
  await p.waitForFunction(() => document.querySelectorAll('section.card[aria-label]').length === 1);
  await shot(p, 'results-filtered-x');
  await p.getByLabel('Network').selectOption('');
  await p.getByRole('region', { name: 'Threads' }).getByRole('button', { name: 'Readings' }).click();
  const d = p.getByRole('dialog');
  await d.getByText('1 hour').waitFor();
  await d.getByText('Waiting').first().waitFor();
  await shot(p, 'results-readings');
  await d.getByRole('button', { name: 'Close' }).last().click();
});

// ───────────────────────────── prizes ─────────────────────────────
await step('prizes: off by default, so nothing about them shows on a post', async () => {
  const p = approver.page;
  await p.goto(`/pieces/${state.pieceId}`);
  await p.getByRole('region', { name: 'Publications' }).locator('tbody tr').first().waitFor();
  await p.waitForLoadState('networkidle'); // the brand's settings, which say whether prizes are on, have arrived
  assert((await p.getByRole('button', { name: 'Prize…' }).count()) === 0, 'the Prize button should not show while prizes are off');
});

await step('prizes: an admin switches them on, adds a link and uploads a file', async () => {
  const p = admin.page;
  await p.goto('/settings?tab=prizes');
  await p.getByRole('heading', { name: 'Prizes for commenting' }).waitFor();
  await p.getByLabel(/Use prizes in this brand/).check();
  await p.getByLabel(/Keep people for/).fill('14');
  await p.getByRole('button', { name: 'Save', exact: true }).click();
  await p.getByText('Saved', { exact: true }).waitFor();
  const add = p.locator('form', { has: p.getByRole('heading', { name: 'Add a prize' }) });
  // A link
  await add.getByLabel('Name').fill('Recipe on our blog');
  await add.getByRole('textbox', { name: /^Link/ }).fill(`${BASE}/api/health`);
  await add.getByRole('button', { name: 'Add prize' }).click();
  await p.getByRole('cell', { name: 'Recipe on our blog' }).waitFor();
  // A file
  await add.getByLabel(/A file kept here/).check();
  await add.getByLabel('Name').fill('Spring menu PDF');
  await add.getByLabel('Prize file').setInputFiles(path.join(ASSETS, 'deck.pdf'));
  await add.getByRole('button', { name: 'Add prize' }).click();
  await p.getByRole('cell', { name: 'Spring menu PDF' }).waitFor();
  await p.locator('tbody tr', { hasText: 'Spring menu PDF' }).getByText('Ready').waitFor();
  await shot(p, 'prizes-settings');
  const row = sql(`select kind, uploaded_at is not null from prize where name = 'Spring menu PDF'`);
  assert(row === 'file|t', `the file prize should be uploaded and confirmed, got ${row}`);
  assert(sql(`select retention_days from (select (prizes->>'retention_days')::int as retention_days from brand) b`) === '14', 'retention was not saved');
});

await step('prizes: the Meta setup addresses are shown, and a person can be erased', async () => {
  const p = admin.page;
  for (const url of [`${BASE}/api/meta/webhook`, `${BASE}/api/meta/data-deletion`, `${BASE}/data-deletion`]) await p.getByText(url, { exact: true }).waitFor();
  await p.getByRole('heading', { name: 'Erase a person' }).waitFor();
});

await step('a prize on an Instagram post: the account was connected without permission to message, and the dialog says so', async () => {
  const p = approver.page;
  await p.goto(`/pieces/${state.pieceId}`);
  const row = p.getByRole('region', { name: 'Publications' }).locator('tbody tr').filter({ hasText: 'Instagram' });
  await row.getByRole('button', { name: 'Prize…' }).click();
  const d = p.getByRole('dialog');
  await d.getByTestId('needs-reconnect').waitFor();
  await d.getByLabel('Keyword').fill('recipe');
  await d.getByLabel(/The text of this post tells people/).check();
  await d.getByRole('button', { name: 'Save', exact: true }).click();
  await d.getByText(/connected without the permission to send messages/).last().waitFor();
  await shot(p, 'prize-needs-reconnect');
  await d.getByRole('button', { name: 'Close' }).last().click();
});

await step('reconnect Meta with prizes on: the sign-in now asks for the messaging permissions', async () => {
  await fakes.control({ op: 'meta.scopes', scopes: ['pages_show_list', 'pages_read_engagement', 'pages_manage_posts', 'instagram_basic', 'instagram_content_publish', 'instagram_manage_messages', 'pages_messaging', 'instagram_manage_comments', 'instagram_manage_insights'] });
  const p = admin.page;
  await p.goto('/settings?tab=accounts');
  const row = p.locator('li.ent', { hasText: 'Instagram' }).first();
  const start = p.waitForRequest((r) => r.url().includes('/connections/meta') && r.method() === 'POST');
  // Renewing is in the row's "⋯" menu.
  await row.getByRole('button', { name: /^Actions for / }).click();
  await p.getByRole('menuitem', { name: 'Renew' }).click();
  await start;
  await p.waitForURL(/connection=/);
  const d = p.getByRole('dialog');
  await d.getByRole('button', { name: 'Reconnect' }).click();
  await d.waitFor({ state: 'detached' });
  const granted = sql(`select granted_permissions::text from social_account where network = 'instagram'`);
  assert(/instagram_manage_messages/.test(granted), `the messaging permission should be granted now: ${granted}`);
});

await step('the rule is saved, the message is previewed, and prizes run only with the notice confirmed', async () => {
  const p = approver.page;
  await p.goto(`/pieces/${state.pieceId}`);
  const row = p.getByRole('region', { name: 'Publications' }).locator('tbody tr').filter({ hasText: 'Instagram' });
  await row.getByRole('button', { name: 'Prize…' }).click();
  const d = p.getByRole('dialog');
  await d.locator('select').selectOption({ label: 'Spring menu PDF (file)' }); // the dialog has loaded once this is possible
  assert((await d.getByTestId('needs-reconnect').count()) === 0, 'the reconnect notice should be gone');
  await d.getByLabel('Keyword').fill('recipe');
  await d.getByText('What Alex receives').waitFor();
  await d.getByRole('textbox', { name: /^Message/ }).fill('Hi {{name}}! Your {{prize}} is here, without a link');
  await d.getByRole('button', { name: 'Save', exact: true }).click();
  await d.getByText(/has to contain \{\{link\}\}/).waitFor();
  await d.getByRole('textbox', { name: /^Message/ }).fill('Hi {{name}}! Your {{prize}}: {{link}} (works for {{hours}} hours)');
  await d.getByRole('button', { name: 'Save', exact: true }).click();
  await d.getByText(/Confirm that the post's own text tells people the reply is automatic/).waitFor();
  await d.getByLabel(/The text of this post tells people/).check();
  await d.getByRole('button', { name: 'Save', exact: true }).click();
  await p.getByText('Prize saved: it is running').waitFor();
  await d.getByText('Running', { exact: true }).first().waitFor();
  await shot(p, 'prize-rule');
  await d.getByRole('button', { name: 'Close' }).last().click();
  assert(sql(`select active from prize_rule`) === 't', 'the rule should be active');
});

const sign = (raw) => `sha256=${createHmac('sha256', META_SECRET).update(raw).digest('hex')}`;
async function pushComment({ id, text, personId, username, mediaId }) {
  const at = Date.now();
  await fakes.control({ op: 'meta.comment', mediaId, id, text, personId, username, at });
  const body = JSON.stringify({ object: 'instagram', entry: [{ id: '222', time: Math.floor(at / 1000), changes: [{ field: 'comments', value: { id, text, media: { id: mediaId }, from: { id: personId, username } } }] }] });
  return fetch(`${BASE}/api/meta/webhook`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-hub-signature-256': sign(body) }, body });
}

await step('a comment with the keyword arrives by webhook: the person gets the prize by private message within seconds', async () => {
  const s = await fakes.state();
  state.mediaId = s.instagram[0].id;
  const unsigned = await fetch(`${BASE}/api/meta/webhook`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  assert(unsigned.status === 403, `an unsigned push must be refused, got ${unsigned.status}`);
  const challenge = await fetch(`${BASE}/api/meta/webhook?hub.mode=subscribe&hub.verify_token=e2e-verify&hub.challenge=12345`);
  assert((await challenge.text()) === '12345', 'the verification handshake should echo the challenge');
  const wrong = await fetch(`${BASE}/api/meta/webhook?hub.mode=subscribe&hub.verify_token=nope&hub.challenge=12345`);
  assert(wrong.status === 403, 'a wrong verify token must be refused');

  assert((await pushComment({ id: 'c-1', text: 'Nice! RECIPE please 🙏', personId: 'user-alex', username: 'alex', mediaId: state.mediaId })).ok, 'the signed push was refused');
  assert((await pushComment({ id: 'c-2', text: 'Looks great', personId: 'user-bea', username: 'bea', mediaId: state.mediaId })).ok, 'the signed push was refused');
  await until(admin.page, 'the prize to be sent', async () => {
    const m = (await fakes.state()).metaMessages;
    return m.length === 1 || `${m.length} messages sent`;
  }, 60_000, false);
  const m = (await fakes.state()).metaMessages[0];
  assert(m.commentId === 'c-1', `the private reply should answer comment c-1, got ${m.commentId}`);
  assert(/Hi alex! Your Spring menu PDF: http:\/\/localhost:3300\/prize\/[\w-]{20,} \(works for 72 hours\)/.test(m.text), `the message is not what was written:\n${m.text}`);
  assert(m.text.trimEnd().endsWith('This is an automatic message.'), 'the automatic-message note must end every message');
  state.prizeLink = m.text.match(/http:\/\/localhost:3300\/prize\/[\w-]+/)[0];
  assert(sql(`select count(*) from prize_delivery`) === '1', 'only the comment with the keyword should be an entry');
  assert(sql(`select status from prize_delivery`) === 'sent', 'the delivery should be marked as sent');
});

await step('the same person commenting again does not get it twice', async () => {
  assert((await pushComment({ id: 'c-3', text: 'recipe!!', personId: 'user-alex', username: 'alex', mediaId: state.mediaId })).ok, 'the signed push was refused');
  await until(admin.page, 'the repeat to be recorded as skipped', async () => {
    const c = sql(`select count(*) from prize_delivery where status = 'skipped' and reason = 'already_received'`);
    return c === '1' || `${c} skipped so far`;
  }, 30_000, false);
  assert((await fakes.state()).metaMessages.length === 1, 'no second message may be sent');
});

await step('the prize page: anyone with the link opens it without signing in, and downloads the file', async () => {
  const visitor = await anonymous();
  const p = visitor.page;
  await p.goto(state.prizeLink.replace('http://localhost:3300', ''));
  await p.getByTestId('public-prize').waitFor();
  await p.getByRole('heading', { name: 'Spring menu PDF' }).waitFor();
  await p.getByText('From Lumen Coffee').waitFor();
  assert(await p.locator('meta[name=robots]').getAttribute('content') === 'noindex, nofollow', 'the page must not be indexed');
  assert(!/alex|user-/i.test(await p.locator('body').innerText()), 'the page must say nothing about who the prize was sent to');
  await shot(p, 'public-prize-page');
  const [download] = await Promise.all([p.waitForEvent('download'), p.getByRole('button', { name: 'Download' }).click()]);
  const saved = path.join(SHOTS, 'downloaded-deck.pdf');
  await download.saveAs(saved);
  assert(readFileSync(saved).equals(readFileSync(path.join(ASSETS, 'deck.pdf'))), 'the downloaded file is not the file that was uploaded');
  assert(sql(`select downloads from prize_delivery where status = 'sent'`) === '1', 'the download should be counted');
  // A made-up link says nothing.
  await p.goto('/prize/abcdefabcdefabcdefabcdef');
  await p.getByRole('alert').waitFor();
  await visitor.context.close();
});

await step('the prize dialog lists who won, by the name they show, and what happened', async () => {
  const p = approver.page;
  await p.goto(`/pieces/${state.pieceId}`);
  const row = p.getByRole('region', { name: 'Publications' }).locator('tbody tr').filter({ hasText: 'Instagram' });
  await row.getByRole('button', { name: 'Prize…' }).click();
  const d = p.getByRole('dialog');
  await d.getByRole('cell', { name: 'alex' }).first().waitFor();
  await d.getByText('1 download').waitFor();
  await d.getByText('This person already received this prize').waitFor();
  assert(!/user-alex/.test(await d.innerText()), "the network's id for a person is never shown");
  await shot(p, 'prize-deliveries');
  await d.getByRole('button', { name: 'Close' }).last().click();
});

await step('a network that cannot message gets a public page: Threads, with a link prize', async () => {
  const p = approver.page;
  await p.goto(`/pieces/${state.pieceId}`);
  const row = p.getByRole('region', { name: 'Publications' }).locator('tbody tr').filter({ hasText: 'Threads' });
  await row.getByRole('button', { name: 'Prize…' }).click();
  const d = p.getByRole('dialog');
  await d.getByText(/cannot send private messages here/).waitFor();
  await d.locator('select').selectOption({ label: 'Recipe on our blog (link)' });
  await d.getByLabel('Note to yourself').fill('pinned comment');
  await d.getByLabel(/The text of this post tells people/).check();
  await d.getByRole('button', { name: 'Save', exact: true }).click();
  await p.getByText('Prize saved: it is running').waitFor();
  const link = d.locator('code').first();
  await link.waitFor();
  state.publicLink = (await link.innerText()).trim();
  assert(/\/prize\/[\w-]{20,}$/.test(state.publicLink), `a public link was expected, got ${state.publicLink}`);
  await shot(p, 'prize-public-link');
  await d.getByRole('button', { name: 'Close' }).last().click();
  const visitor = await anonymous();
  await visitor.page.goto(state.publicLink.replace(BASE, ''));
  await visitor.page.getByRole('heading', { name: 'Recipe on our blog' }).waitFor();
  await Promise.all([visitor.page.waitForURL(/\/api\/health/), visitor.page.getByRole('button', { name: 'Open' }).click()]);
  await visitor.context.close();
});

await step('erasing a person: by the name they show, from Settings', async () => {
  assert((await pushComment({ id: 'c-4', text: 'recipe', personId: 'user-carl', username: 'carl', mediaId: state.mediaId })).ok, 'the signed push was refused');
  await until(admin.page, 'carl to receive the prize', async () => sql(`select count(*) from prize_delivery where person_name = 'carl' and status = 'sent'`) === '1' || 'not yet', 30_000, false);
  const p = admin.page;
  await p.goto('/settings?tab=prizes');
  await p.getByRole('heading', { name: 'Erase a person' }).waitFor();
  const erase = p.locator('form', { has: p.getByRole('heading', { name: 'Erase a person' }) });
  await erase.getByRole('textbox', { name: 'Name', exact: true }).fill('carl');
  await erase.getByRole('button', { name: 'Erase', exact: true }).click();
  // The app asks first, in its own dialog.
  await p.getByRole('dialog').getByRole('button', { name: 'Erase', exact: true }).click();
  await p.getByText(/Deleted 1 entry/).waitFor();
  assert(sql(`select count(*) from prize_delivery where person_name = 'carl'`) === '0', 'carl should be gone');
  assert(sql(`select count(*) from prize_delivery where person_name = 'alex'`) !== '0', 'alex should be untouched');
  const audit = sql(`select count(*) from audit_event where action = 'prize.person_erased' and after::text not like '%carl%'`);
  assert(audit === '1', 'the audit log should record that someone was erased, without saying who');
});

await step("Meta's data-deletion callback: signed, answered with a status page, and the person's rows are gone", async () => {
  const payload = Buffer.from(JSON.stringify({ user_id: 'user-alex', algorithm: 'HMAC-SHA256', issued_at: Math.floor(Date.now() / 1000) })).toString('base64url');
  const sig = createHmac('sha256', META_SECRET).update(payload).digest('base64url');
  const bad = await fetch(`${BASE}/api/meta/data-deletion`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: `signed_request=${sig.slice(0, -2)}xx.${payload}` });
  assert(bad.status === 403, `a wrong signature must be refused, got ${bad.status}`);
  const r = await fetch(`${BASE}/api/meta/data-deletion`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: `signed_request=${sig}.${payload}` });
  const text = await r.text();
  assert(r.ok, `the callback failed: ${r.status} ${text}`);
  const body = JSON.parse(text);
  assert(/\/data-deletion\?code=del_/.test(body.url) && body.confirmation_code.startsWith('del_'), `Meta needs a url and a confirmation code, got ${JSON.stringify(body)}`);
  assert(sql(`select count(*) from prize_delivery where person_id = 'user-alex'`) === '0', "alex's rows should be deleted");
  assert(!sql(`select person_id from deletion_request`).includes('user-alex'), "the person's id must not be kept in the request log");
  const visitor = await anonymous();
  await visitor.page.goto(body.url.replace(BASE, ''));
  await visitor.page.getByTestId('data-deletion').getByText(/was handled/).waitFor();
  await visitor.page.getByText(/We deleted 2 entries about you/).waitFor();
  await shot(visitor.page, 'data-deletion-page');
  await visitor.context.close();
});

await step('retention: entries past their date are deleted by the worker, and the audit log keeps only a count', async () => {
  assert((await pushComment({ id: 'c-5', text: 'recipe', personId: 'user-dora', username: 'dora', mediaId: state.mediaId })).ok, 'the signed push was refused');
  await until(admin.page, 'dora to receive the prize', async () => sql(`select count(*) from prize_delivery where person_name = 'dora' and status = 'sent'`) === '1' || 'not yet', 30_000, false);
  sql(`update prize_delivery set purge_after = now() - interval '1 minute' where person_name = 'dora'`);
  await until(admin.page, 'the worker to purge dora', async () => sql(`select count(*) from prize_delivery where person_name = 'dora'`) === '0' || 'still there', 60_000, false);
  assert(sql(`select count(*) from audit_event where action = 'prize.purged'`) !== '0', 'the purge should be on the audit log');
  assert(!sql(`select string_agg(after::text, ' ') from audit_event where action = 'prize.purged'`).includes('dora'), 'the audit log must not name who was deleted');
});

// ───────────────────────────── a phone ─────────────────────────────
await step('phone: results, the prizes tab and the prize page fit a narrow screen', async () => {
  const mobile = await newSession('admin@example.com', { width: 390, height: 800 }, true);
  const p = mobile.page;
  for (const [url, wait, name] of [['/results', 'Results', 'results'], ['/settings?tab=prizes', 'Prizes for commenting', 'prizes'], ['/settings?tab=accounts', 'Connect to a network', 'accounts']]) {
    await p.goto(url);
    await p.getByText(wait, { exact: false }).first().waitFor();
    const w = await p.evaluate(() => ({ scroll: document.documentElement.scrollWidth, inner: window.innerWidth }));
    assert(w.scroll <= w.inner + 1, `${name} scrolls sideways (${w.scroll} > ${w.inner})`);
    await shot(p, `${name}-mobile`);
  }
  await mobile.context.close();
  const visitor = await anonymous({ width: 390, height: 700 });
  await visitor.page.goto('/prize/abcdefabcdefabcdefabcdef');
  await visitor.page.getByRole('alert').waitFor();
  const w = await visitor.page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, inner: window.innerWidth }));
  assert(w.scroll <= w.inner + 1, 'the prize page scrolls sideways on a phone');
  await visitor.context.close();
});

await browser.close();
if (problems.length) {
  console.log(`\n${problems.length} problem(s):`);
  for (const x of problems) console.log(` - ${x}`);
  process.exit(1);
}
console.log('\nAll phase 4 end-to-end steps passed.');
