// End-to-end smoke test: drives the real app in a real browser, with real ffmpeg and a real Postgres.
//
//   1. Start Postgres, then the API with AUTH_DEV_LOGIN=true and WEB_DIST pointing at the built web app.
//   2. Seed members, accounts and slots (see e2e/README.md).
//   3. node e2e/smoke.mjs
//
// Environment: BASE_URL (default http://localhost:3000), ASSETS (folder with reel-v1.webm, reel-v2.webm, slide-1.png,
// slide-2.png, deck.pdf), SHOTS (folder for screenshots), DATABASE_URL (psql URI, used to make a post "due"),
// CHROMIUM (browser executable).
import { chromium } from 'playwright-core';
import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

const BASE = process.env.BASE_URL ?? 'http://localhost:3000';
const ASSETS = process.env.ASSETS ?? path.resolve('e2e/assets');
const SHOTS = process.env.SHOTS ?? path.resolve('e2e/shots');
const DB = process.env.DATABASE_URL ?? 'postgres://postgres@localhost:5433/estudio';
mkdirSync(SHOTS, { recursive: true });

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM ?? '/opt/pw-browsers/chromium', args: ['--no-sandbox', '--disable-background-networking', '--no-first-run'] });
const problems = [];
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let n = 0;

async function newSession(email, viewport = { width: 1280, height: 900 }, mobile = false) {
  const context = await browser.newContext({ baseURL: BASE, locale: 'en-US', viewport, isMobile: mobile, hasTouch: mobile, acceptDownloads: true });
  const page = await context.newPage();
  page.on('pageerror', (e) => problems.push(`[${email}] page error: ${e.message}`));
  page.on('console', (m) => m.type() === 'error' && !/status of 4\d\d/.test(m.text()) && problems.push(`[${email}] console error: ${m.text()}`));
  await page.goto('/login');
  await page.getByLabel('Email').fill(email);
  await page.getByRole('button', { name: /Development sign-in/ }).click();
  await page.waitForURL('**/pieces');
  return { context, page };
}

async function shot(page, name) {
  await page.screenshot({ path: path.join(SHOTS, `${String(++n).padStart(2, '0')}-${name}.png`), fullPage: false });
}

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

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

/** Waits until fn() in the page returns the expected value, and says what it saw if it never does. */
async function expectCount(page, selector, expected, what) {
  try {
    await page.waitForFunction(([sel, n]) => document.querySelectorAll(sel).length === n, [selector, expected], { timeout: 8000 });
  } catch {
    const seen = await page.locator(selector).count();
    throw new Error(`${what}: expected ${expected}, saw ${seen}`);
  }
}

async function noHorizontalScroll(page, label) {
  const w = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, inner: window.innerWidth }));
  assert(w.scroll <= w.inner + 1, `${label}: page scrolls sideways (${w.scroll} > ${w.inner})`);
}

async function createPiece(page, title, kind) {
  await page.getByRole('button', { name: 'New piece' }).click();
  const d = page.getByRole('dialog');
  await d.getByLabel('Title').fill(title);
  if (kind) await d.getByLabel('Type').selectOption(kind);
  await d.getByRole('button', { name: 'Create piece' }).click();
  await page.waitForURL(/\/pieces\/[0-9a-f-]{36}$/);
  return page.url().split('/').pop();
}

async function addVariant(page) {
  await page.getByRole('button', { name: 'Add variant' }).first().click();
  const d = page.getByRole('dialog');
  await d.getByRole('button', { name: 'Add variant' }).click();
  await page.getByRole('button', { name: /Upload (first|new) version/ }).waitFor();
}

async function uploadVersion(page, files, { notes = '', resolve = [] } = {}) {
  await page.getByRole('button', { name: /Upload (first|new) version/ }).first().click();
  const d = page.getByRole('dialog');
  await d.locator('input[type=file]').setInputFiles(files.map((f) => path.join(ASSETS, f)));
  if (notes) await d.getByLabel('What changed').fill(notes);
  for (const text of resolve) await d.getByLabel(new RegExp(text)).check();
  await d.getByRole('button', { name: 'Upload and send to review' }).click();
  await page.getByText('Version uploaded and sent to review').waitFor({ timeout: 60_000 });
}

async function seekVideo(page, seconds) {
  await page.waitForFunction(() => document.querySelector('video')?.readyState >= 2, null, { timeout: 20_000 });
  await page.evaluate(
    (t) => new Promise((resolve) => {
      const v = document.querySelector('video');
      v.pause();
      v.addEventListener('seeked', () => resolve(), { once: true });
      v.currentTime = t;
    }),
    seconds,
  );
}

const state = {};

// ───────────────────────────── producer creates and uploads ─────────────────────────────
const producer = await newSession('producer@example.com');
await step('producer: pieces page is empty and has a New piece button', async () => {
  await producer.page.getByText('No pieces here yet').waitFor();
  await shot(producer.page, 'pieces-empty');
});

await step('producer: creates a video piece, adds a 9:16 variant and uploads v1', async () => {
  state.pieceId = await createPiece(producer.page, 'Spring menu reel');
  await addVariant(producer.page);
  await uploadVersion(producer.page, ['reel-v1.webm'], { notes: 'First cut with the new intro' });
  await producer.page.getByText('v1', { exact: true }).waitFor();
  await shot(producer.page, 'piece-v1-in-review');
});

// ───────────────────────────── reviewer comments ─────────────────────────────
const reviewer = await newSession('reviewer@example.com');
await step('reviewer: opens v1, comments on two moments (real frames), requests changes', async () => {
  const p = reviewer.page;
  await p.goto(`/pieces/${state.pieceId}`);
  await p.getByRole('link', { name: 'Review', exact: true }).click();
  await p.waitForURL(/\/review\//);
  state.reviewUrl1 = p.url();
  assert((await p.getByRole('button', { name: 'Approve…' }).count()) === 0, 'a reviewer should not see Approve');

  await seekVideo(p, 2.5);
  await p.getByRole('button', { name: 'Comment here' }).click();
  await p.getByLabel('Comment', { exact: true }).fill('The logo is cut off at this moment');
  await p.getByRole('button', { name: 'Post comment' }).click();
  await p.getByText('The logo is cut off at this moment').waitFor();

  await seekVideo(p, 4);
  await p.getByRole('button', { name: 'Comment here' }).click();
  await p.getByLabel('Comment', { exact: true }).fill('Music is too loud here');
  await p.getByRole('button', { name: 'Post comment' }).click();
  await p.getByText('Music is too loud here').waitFor();

  const thumb = p.locator('img.frame-thumb').first();
  await thumb.waitFor();
  await p.waitForFunction(() => document.querySelector('img.frame-thumb')?.naturalWidth > 0);
  assert((await p.locator('.marker').count()) === 2, 'expected two markers on the timeline');
  await shot(p, 'review-v1-comments');

  await p.getByRole('button', { name: 'Request changes' }).click();
  await p.getByRole('dialog').getByRole('button', { name: 'Request changes' }).click();
  await p.getByText('Changes requested').first().waitFor();
});

// ───────────────────────────── producer uploads v2 resolving one comment ─────────────────────────────
await step('producer: uploads v2 and ticks the comment it fixed', async () => {
  const p = producer.page;
  await p.goto(`/pieces/${state.pieceId}`);
  await uploadVersion(p, ['reel-v2.webm'], { notes: 'Logo moved, music untouched', resolve: ['The logo is cut off'] });
  await p.getByText('Superseded').waitFor();
});

await step('producer: replies to the comment that is still open, marking it as needing a person', async () => {
  const p = producer.page;
  await p.getByRole('link', { name: 'Review', exact: true }).click();
  await p.waitForURL(/\/review\//);
  assert((await p.getByRole('button', { name: 'Post comment' }).count()) === 0, 'a producer should not start threads');
  await p.getByText('still open from v1').waitFor();
  await p.getByLabel('Reply', { exact: true }).fill('Needs the music licence checked first');
  await p.getByLabel('Reply type').selectOption('needs_human');
  await p.getByRole('button', { name: 'Send' }).click();
  await p.getByText('Needs the music licence checked first').waitFor();
  await p.locator('.reply .chip', { hasText: 'Needs a person' }).waitFor();
  await shot(p, 'producer-reply');
});

// ───────────────────────────── approver ─────────────────────────────
const approver = await newSession('approver@example.com');
await step('approver: cannot approve with an open comment, resolves it, then approves', async () => {
  const p = approver.page;
  await p.goto(`/pieces/${state.pieceId}`);
  await p.getByRole('link', { name: 'Review', exact: true }).click();
  await p.waitForURL(/\/review\//);
  state.reviewUrl2 = p.url();
  await p.getByText('still open from v1').waitFor();
  await p.getByRole('button', { name: 'Approve…' }).click();
  const d = p.getByRole('dialog');
  await d.getByText(/1 comment is still open/).waitFor();
  assert(await d.getByRole('button', { name: 'Approve', exact: true }).isDisabled(), 'Approve should be disabled while a comment is open');
  await shot(p, 'approve-blocked-by-open-comment');
  await d.getByRole('button', { name: 'Cancel' }).click();

  await p.getByRole('button', { name: 'Resolve' }).first().click();
  await p.getByText('Nothing open.').waitFor();
  await p.getByRole('button', { name: 'Approve…' }).click();
  const d2 = p.getByRole('dialog');
  assert(await d2.getByRole('button', { name: 'Approve', exact: true }).isDisabled(), 'Approve should need accounts and the checklist');
  await d2.getByLabel(/Instagram/).check();
  await d2.getByLabel('Facts verified').check();
  await d2.getByLabel('Subtitles reviewed').check();
  await shot(p, 'approve-dialog');
  await d2.getByRole('button', { name: 'Approve', exact: true }).click();
  await p.getByText('Approved for 1 account').waitFor();
});

await step('approver: sees v1 comments resolved in v2 and compares the two versions', async () => {
  const p = approver.page;
  await p.getByRole('tab', { name: /Comments/ }).click();
  await p.getByText(/Resolved \(\d\)/).click();
  await p.getByText('resolved in v2').waitFor();
  await p.getByLabel('Compare with').selectOption({ label: 'v1' });
  await p.waitForFunction(() => document.querySelectorAll('.compare video').length === 2);
  await p.waitForFunction(() => [...document.querySelectorAll('.compare video')].every((v) => v.readyState >= 2), null, { timeout: 15_000 })
    .catch(() => { throw new Error('one of the two compared videos never loaded a frame'); });
  await shot(p, 'compare-v1-v2');
  await p.getByLabel('Compare with').selectOption('');
});

await step('approver: schedules the approved version five days out', async () => {
  const p = approver.page;
  await p.getByRole('button', { name: 'Schedule…' }).click();
  const d = p.getByRole('dialog');
  const day = new Date(Date.now() + 5 * 86400000).toISOString().slice(0, 10);
  state.day = day;
  await d.getByLabel(/Date and time/).fill(`${day}T19:00`);
  await d.getByLabel('Text').fill('Our spring menu is here. Which one are you trying first?');
  await d.getByRole('button', { name: 'Schedule', exact: true }).click();
  await p.getByText('Scheduled: someone has to publish it').waitFor();
});

await step('approver: the scheduled post shows on the piece page', async () => {
  const p = approver.page;
  await p.goto(`/pieces/${state.pieceId}`);
  await p.getByRole('region', { name: 'Publications' }).getByText('Scheduled').waitFor();
  await shot(p, 'piece-with-publication');
});

await step('approver: calendar shows the post and empty slots, and a post can be dragged to another day', async () => {
  const p = approver.page;
  await p.goto('/calendar');
  await p.getByText('Spring menu reel').first().waitFor();
  assert((await p.locator('.cal-slot').count()) > 0, 'expected empty slots from the Tuesday and Thursday rules');
  await shot(p, 'calendar-month');
  const dayOfItem = () =>
    p.evaluate(() => {
      const el = [...document.querySelectorAll('.cal-item')].find((e) => e.textContent.includes('Spring menu reel'));
      return el?.closest('.cal-day')?.getAttribute('aria-label') ?? null;
    });
  const dayBefore = await dayOfItem();
  assert(dayBefore, 'the post is not in any calendar cell');
  const labels = await p.locator('.cal-day:not(.out):not(.blocked)').evaluateAll((els) => els.map((e) => e.getAttribute('aria-label')));
  const nextLabel = labels[labels.indexOf(dayBefore) + 1] ?? labels[labels.indexOf(dayBefore) - 1];
  assert(nextLabel, 'no neighbouring day to drop on');
  await p.locator('.cal-item', { hasText: 'Spring menu reel' }).first().dragTo(p.locator(`.cal-day[aria-label="${nextLabel}"]`));
  await p.getByText('Moved', { exact: true }).waitFor();
  await p.waitForFunction(
    (before) => {
      const el = [...document.querySelectorAll('.cal-item')].find((e) => e.textContent.includes('Spring menu reel'));
      const now = el?.closest('.cal-day')?.getAttribute('aria-label');
      return !!now && now !== before;
    },
    dayBefore,
    { timeout: 8000 },
  ).catch(() => { throw new Error(`the post did not move away from ${dayBefore}`); });
});

await step('approver: pausing the brand blocks moves and shows the banner; resuming clears it', async () => {
  const p = approver.page;
  await p.goto('/settings');
  await p.getByRole('button', { name: 'Pause brand' }).click();
  await p.getByRole('status').filter({ hasText: 'This brand is paused' }).waitFor();
  await shot(p, 'brand-paused');
  await p.getByRole('button', { name: 'Resume brand' }).click();
  await p.getByRole('button', { name: 'Pause brand' }).waitFor();
});

await step('assisted publishing: a due post is packaged and recorded as published', async () => {
  const p = approver.page;
  execFileSync('psql', [DB, '-c', `update publication set scheduled_at = now() - interval '2 minutes' where status = 'scheduled'`], { stdio: 'pipe' });
  await p.goto('/today');
  await p.getByRole('button', { name: 'Publish…' }).click();
  const d = p.getByRole('dialog');
  await d.getByText('Our spring menu is here').waitFor();
  await d.getByRole('link', { name: 'Download' }).first().waitFor();
  await shot(p, 'publish-pack');
  await d.getByRole('button', { name: 'I published it…' }).click();
  const d2 = p.getByRole('dialog');
  await d2.getByLabel(/Link to the post/).fill('https://example.com/p/spring-menu');
  await d2.getByRole('button', { name: 'Mark as published' }).click();
  await p.getByText('Marked as published').waitFor();
  await p.getByText('Nothing to publish right now').waitFor();
});

// ───────────────────────────── PDF and carousel ─────────────────────────────
await step('PDF: renders, and an area of a page can be marked and commented', async () => {
  await producer.page.goto('/pieces');
  state.pdfPiece = await createPiece(producer.page, 'Quarterly deck', 'pdf');
  await addVariant(producer.page);
  await uploadVersion(producer.page, ['deck.pdf']);

  const p = reviewer.page;
  await p.goto(`/pieces/${state.pdfPiece}`);
  await p.getByRole('link', { name: 'Review', exact: true }).click();
  await p.locator('canvas').waitFor();
  await p.getByText('Page 1 of 3').waitFor();
  await p.waitForFunction(() => document.querySelector('canvas')?.width > 100);
  const box = await p.locator('.region-layer').boundingBox();
  await p.mouse.move(box.x + box.width * 0.2, box.y + box.height * 0.2);
  await p.mouse.down();
  await p.mouse.move(box.x + box.width * 0.6, box.y + box.height * 0.35, { steps: 5 });
  await p.mouse.up();
  await p.getByText('Page 1 · area').first().waitFor();
  await p.getByLabel('Comment', { exact: true }).fill('This heading needs the new brand font');
  await p.getByRole('button', { name: 'Post comment' }).click();
  await p.getByText('This heading needs the new brand font').waitFor();
  await expectCount(p, '.region-box:not(.draft)', 1, 'region boxes on page 1');
  await p.getByRole('button', { name: 'Next page' }).click();
  await p.getByText('Page 2 of 3').waitFor();
  await expectCount(p, '.region-box:not(.draft)', 0, 'region boxes on page 2');
  await shot(p, 'pdf-region-comment');
});

await step('carousel: two images, a point comment on the second one', async () => {
  await producer.page.goto('/pieces');
  state.carousel = await createPiece(producer.page, 'Menu carousel', 'carousel');
  await addVariant(producer.page);
  await uploadVersion(producer.page, ['slide-1.png', 'slide-2.png']);

  const p = reviewer.page;
  await p.goto(`/pieces/${state.carousel}`);
  await p.getByRole('link', { name: 'Review', exact: true }).click();
  await p.getByText('Item 1 of 2').waitFor();
  await p.getByRole('button', { name: 'Next page' }).click();
  await p.getByText('Item 2 of 2').waitFor();
  const box = await p.locator('.region-layer').boundingBox();
  await p.mouse.click(box.x + box.width * 0.5, box.y + box.height * 0.5);
  await p.getByText('Page 2 · point').first().waitFor();
  await p.getByLabel('Comment', { exact: true }).fill('Price is missing on this slide');
  await p.getByRole('button', { name: 'Post comment' }).click();
  await p.getByText('Price is missing on this slide').waitFor();
  await shot(p, 'carousel-point-comment');
});

// ───────────────────────────── roles and access ─────────────────────────────
const reader = await newSession('reader@example.com');
await step('reader: can look but not comment, upload, approve or reach settings', async () => {
  const p = reader.page;
  await p.goto(state.reviewUrl2.replace(BASE, ''));
  await p.getByText('Open (').waitFor();
  assert((await p.getByRole('button', { name: 'Post comment' }).count()) === 0, 'reader sees a comment form');
  assert((await p.getByRole('button', { name: 'Comment here' }).count()) === 0, 'reader sees Comment here');
  assert((await p.getByRole('link', { name: 'Settings' }).count()) === 0, 'reader sees Settings');
  await p.goto(`/pieces/${state.pieceId}`);
  assert((await p.getByRole('button', { name: /Upload/ }).count()) === 0, 'reader sees an upload button');
});

await step('approver cannot approve a version they uploaded themselves', async () => {
  const p = approver.page;
  await p.goto('/pieces');
  const id = await createPiece(p, 'Approver upload');
  await addVariant(p);
  await uploadVersion(p, ['reel-v1.webm']);
  await p.getByRole('link', { name: 'Review', exact: true }).click();
  await p.getByText('You uploaded this version').waitFor();
  assert(await p.getByRole('button', { name: 'Approve…' }).isDisabled(), 'Approve should be disabled for the uploader');
  void id;
});

// ───────────────────────────── mobile ─────────────────────────────
const mobile = await newSession('approver@example.com', { width: 390, height: 844 }, true);
await step('mobile: pieces, review and calendar fit the screen', async () => {
  const p = mobile.page;
  await noHorizontalScroll(p, 'pieces');
  await shot(p, 'mobile-pieces');
  await p.goto(state.reviewUrl2.replace(BASE, ''));
  await p.getByText('Open (').waitFor();
  await p.waitForFunction(() => document.querySelector('video')?.readyState >= 1);
  await noHorizontalScroll(p, 'review');
  await shot(p, 'mobile-review');
  await p.goto('/calendar');
  await p.getByText('Calendar').first().waitFor();
  await noHorizontalScroll(p, 'calendar');
  await shot(p, 'mobile-calendar');
  await p.goto('/settings');
  await p.getByRole('heading', { name: 'Settings' }).waitFor();
  await noHorizontalScroll(p, 'settings');
});

await browser.close();
console.log(problems.length ? `\n${problems.length} problem(s):\n- ${problems.join('\n- ')}` : '\nAll steps passed with no page errors.');
process.exit(problems.length ? 1 : 0);
