import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { deliver, dueDeliveries } from '../../api/src/services/webhooks.js';
import { scanSlotAlerts } from '../../api/src/services/slots.js';
import { createEnv, type Actor, type Env } from '../../api/test/helpers.js';
import { Studio } from '../src/api.js';
import { parseConfig, type Config } from '../src/config.js';
import { consoleLogger, silentLogger } from '../src/log.js';
const LOG = process.env.TEST_LOG ? consoleLogger() : silentLogger;
import { handle } from '../src/pipeline.js';
import { Queue, type Item } from '../src/queue.js';
import { loadTemplates, startRunner, type Runner } from '../src/runner.js';
import { createServer } from '../src/server.js';
import http from 'node:http';
import { DateTime } from 'luxon';

const here = path.dirname(fileURLToPath(import.meta.url));
const FAKE_AGENT = path.join(here, 'fake-agent.mjs');

let env: Env;
let apiUrl: string;
let work: string;
let video: Buffer;
let agent: Actor;
let token: string;

const freePort = () => new Promise<number>((resolve) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = (s.address() as net.AddressInfo).port; s.close(() => resolve(p)); }); });

beforeAll(async () => {
  work = mkdtempSync(path.join(tmpdir(), 'runner-loop-'));
  const port = await freePort();
  apiUrl = `http://127.0.0.1:${port}`;
  env = await createEnv({ MEDIA_URL: apiUrl, TOKEN_KEY: Buffer.alloc(32, 9).toString('base64') }, { realMedia: true });
  await env.app.listen({ port, host: '127.0.0.1' });
  const p = path.join(work, 'v1.mp4');
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=s=540x960:r=25', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000,volume=6dB', '-t', '6', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', p]);
  video = readFileSync(p);
  const t = await env.call(env.users.admin, 'POST', `/api/brands/${env.brandId}/tokens`, { name: 'Agent runner' });
  token = t.body.token;
  agent = { id: 'tok', email: 'agent', bearer: token };
  await limits({ max_rounds: 3, max_cost_per_piece: 5, max_cost_per_month: 100, max_run_minutes: 30 });
});
afterAll(async () => {
  await env.close();
  rmSync(work, { recursive: true, force: true });
});

// ───────────────────────────── a runner under test ─────────────────────────────

interface Rig {
  config: Config;
  queue: Queue;
  runner: Runner;
  server: http.Server;
  webhookUrl: string;
  secret: string;
  clock: { skew: number };
  dir: string;
  stop: () => Promise<void>;
}
const rigs: Rig[] = [];

async function rig(o: { mode?: string; agentExtra?: Record<string, unknown>; checks?: Record<string, unknown>; checkRetries?: number; templates?: Record<string, string>; webhookEvents?: string[] } = {}): Promise<Rig> {
  const dir = mkdtempSync(path.join(work, 'rig-'));
  const created = await env.call(env.users.admin, 'POST', `/api/brands/${env.brandId}/webhooks`, { url: 'http://127.0.0.1:9/placeholder', events: o.webhookEvents ?? ['version.changes_requested'] });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const secret = created.body.secret as string;
  const config = parseConfig(
    {
      workspaceRoot: path.join(dir, 'work'),
      maxConcurrentRuns: 1,
      brands: {
        lumen: {
          api: apiUrl, token, webhookSecret: secret,
          templates: o.templates ?? { 'version.changes_requested': path.join(here, '../templates/changes-requested.md'), 'slot.needs_content': path.join(here, '../templates/slot-needs-content.md') },
          agent: { command: [process.execPath, FAKE_AGENT], input: 'stdin', env: { FAKE_AGENT_MODE: o.mode ?? 'ok' }, cost: { from: 'stdout-json', path: 'total_cost_usd' }, killGraceSeconds: 1, ...(o.agentExtra ?? {}) },
          checks: o.checks ?? {},
          checkRetries: o.checkRetries ?? 1,
        },
      },
    },
    dir,
    {},
  );
  const queue = new Queue(config.stateDir);
  const clock = { skew: 0 };
  const runner = startRunner(config, queue, LOG, { tickMs: 50, now: () => Date.now() + clock.skew });
  const server = createServer({ config, queue, log: LOG, wake: () => runner.wake() });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const webhookUrl = `http://127.0.0.1:${(server.address() as net.AddressInfo).port}/webhooks/lumen`;
  await env.call(env.users.admin, 'PATCH', `/api/webhooks/${created.body.id}`, { url: webhookUrl });
  const r: Rig = {
    config, queue, runner, server, webhookUrl, secret, clock, dir,
    async stop() {
      await runner.stop();
      await new Promise<void>((res) => server.close(() => res()));
      await env.call(env.users.admin, 'DELETE', `/api/webhooks/${created.body.id}`);
    },
  };
  rigs.push(r);
  return r;
}
afterEach(async () => {
  while (rigs.length) await rigs.pop()!.stop();
  await limits({ max_rounds: 3, max_cost_per_piece: 5, max_cost_per_month: 100, max_run_minutes: 30 });
  await env.db.query('delete from agent_run');
});

const limits = async (agentSettings: Record<string, unknown>) => {
  const r = await env.call(env.users.admin, 'PATCH', `/api/brands/${env.brandId}`, { agent: agentSettings });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
};
async function flush() {
  for (let i = 0; i < 20; i++) {
    const due = await dueDeliveries(env.ctx);
    if (!due.length) return;
    for (const id of due) await deliver(env.ctx, id);
  }
}
async function waitFor<T>(what: string, fn: () => Promise<T | false | null | undefined>, ms = 60_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}
const finishedRun = (pieceId: string | null, n = 1) =>
  waitFor('the agent run to finish', async () => {
    const rows = await env.db.query(`select * from agent_run where ($1::uuid is null or piece_id = $1) and status = 'finished' and outcome <> 'blocked' order by started_at, seq`, [pieceId]);
    return rows.length >= n ? rows[n - 1] : false;
  });

/** A piece with one version in review that has real video in it, ready for reviewers. */
async function piece(format = '9:16') {
  const { pieceId, variantId } = await env.makePiece(env.users.producer, 'video', format);
  const v = await env.newVersion(env.users.producer, variantId, [{ name: 'take1.mp4', mime: 'video/mp4', data: video }]);
  expect(v.status, JSON.stringify(v.body)).toBe(201);
  return { pieceId, variantId, versionId: v.body.id as string };
}
const comment = async (versionId: string, body: string, extra: Record<string, unknown> = {}) => {
  const r = await env.call(env.users.reviewer, 'POST', `/api/versions/${versionId}/comments`, { body, ...extra });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body.id as string;
};
const requestChanges = async (versionId: string, note?: string) => {
  const r = await env.call(env.users.reviewer, 'POST', `/api/versions/${versionId}/request-changes`, note ? { note } : {});
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  await flush();
};
const versions = (variantId: string) => env.db.query(`select ver.*, t.name as token_name from version ver left join api_token t on t.id = ver.author_token_id where variant_id = $1 order by number`, [variantId]);
const thread = async (versionId: string, id: string) => (await env.call(env.users.reviewer, 'GET', `/api/versions/${versionId}/comments?carried=true`)).body.find((c: any) => c.id === id);
const runDirOf = (r: Rig, pieceId: string) => {
  const base = path.join(r.config.workspaceRoot, 'lumen', pieceId, 'runs');
  return existsSync(base) ? readdirSync(base).map((d) => path.join(base, d)) : [];
};

// ───────────────────────────── from a comment to a new version ─────────────────────────────

describe('a request for changes becomes a new version, with nobody lifting a finger', () => {
  it('runs the agent on what was commented, uploads v2, answers each comment, and closes the run', async () => {
    const r = await rig({ mode: 'ok', agentExtra: { env: { FAKE_AGENT_MODE: 'cost' } } });
    const { pieceId, variantId, versionId } = await piece();
    const logo = await comment(versionId, 'The logo is cut off here', { anchor: { type: 'time', t: 2.5 } });
    const legal = await comment(versionId, 'Check the legal line with the licence holder first');
    const impossible = await comment(versionId, 'Show the back of the cup, which is impossible with this footage', { anchor: { type: 'time', t: 4 } });
    const forgotten = await comment(versionId, 'A forgotten detail the agent will not mention');
    const mine = await comment(versionId, 'Do not touch the legal footer, I will ask Ana', { peopleOnly: true });
    await requestChanges(versionId, 'Please keep it under ten seconds');

    const run = await finishedRun(pieceId);
    expect(run).toMatchObject({ outcome: 'uploaded', trigger: 'version.changes_requested' });
    expect(Number(run.cost)).toBe(0.42);

    // A new version, made by the token, that went back to review.
    const vs = await versions(variantId);
    expect(vs.map((v) => [v.number, v.review_state, v.token_name])).toEqual([[1, 'superseded', null], [2, 'in_review', 'Agent runner']]);
    expect(run.version_id).toBe(vs[1]!.id);
    expect(vs[1]!.notes).toContain('Agent round 1');
    expect(vs[1]!.notes).toContain('Brightened the picture');
    expect(vs[1]!.notes).toMatch(/Automatic checks: .*Instagram Reel/);
    const assets = await env.db.query('select kind, name, width, height from asset where version_id = $1', [vs[1]!.id]);
    expect(assets).toEqual([expect.objectContaining({ kind: 'video', name: 'revised.mp4', width: 540, height: 960 })]);

    // Each comment is answered, one by one, in the way the agent said.
    const latest = vs[1]!.id;
    const t1 = await thread(latest, logo);
    expect(t1).toMatchObject({ status: 'resolved', resolved_in_number: 2 });
    expect(t1.replies).toEqual([expect.objectContaining({ reply_kind: 'fixed', by_agent: true, body: expect.stringContaining('Changed it') })]);
    expect((await thread(latest, legal))).toMatchObject({ status: 'open', replies: [expect.objectContaining({ reply_kind: 'needs_human', body: 'This needs a person to decide.' })] });
    expect((await thread(latest, impossible))).toMatchObject({ status: 'open', replies: [expect.objectContaining({ reply_kind: 'cannot_do', body: expect.stringContaining('source footage') })] });
    // Not left in silence, even though the agent said nothing about it.
    expect((await thread(latest, forgotten))).toMatchObject({ status: 'open', replies: [expect.objectContaining({ reply_kind: 'needs_human', body: expect.stringContaining('did not say what it did') })] });
    // For people only: neither answered nor resolved.
    expect((await thread(latest, mine))).toMatchObject({ status: 'open', people_only: true, replies: [] });

    // What the agent was given: the comments with where they point, the frame, the people-only warning, what networks accept.
    const [dir] = runDirOf(r, pieceId);
    const instr = readFileSync(path.join(dir!, 'instructions.md'), 'utf8');
    expect(instr).toContain('The logo is cut off here');
    expect(instr).toContain('Video, at 0:02.5 (2.5 seconds)');
    expect(instr).toContain(`input/frames/${logo}.jpg`);
    expect(instr).toContain('Please keep it under ten seconds');
    expect(instr).toContain('For people only: leave these alone');
    expect(instr.indexOf('Do not touch the legal footer')).toBeGreaterThan(instr.indexOf('For people only'));
    expect(instr.split('For people only: leave these alone')[0]).not.toContain('Do not touch the legal footer'); // not among the comments for the agent
    expect(instr).toMatch(/instagram[\s\S]*Reel/);
    expect(instr).toContain('Round 1'.toLowerCase() === '' ? '' : 'round 1 of 3');
    expect(existsSync(path.join(dir!, 'input', 'frames', `${logo}.jpg`))).toBe(true);
    expect(readdirSync(path.join(dir!, 'input', 'previous'))).toEqual(['0-video-take1.mp4']);
    const given = JSON.parse(readFileSync(path.join(dir!, 'input', 'comments.json'), 'utf8')) as { id: string }[];
    expect(given.map((c) => c.id)).not.toContain(mine);

    // The piece's own page of the story.
    const summary = (await env.call(env.users.approver, 'GET', `/api/pieces/${pieceId}/agent`)).body;
    expect(summary).toMatchObject({ rounds: 1, status: 'idle' });
    expect(summary.runs[0]).toMatchObject({ outcome: 'uploaded', version_number: 2, cost: 0.42, detail: { checks: { errors: 0 } } });
    expect(r.queue.list()).toHaveLength(0); // done and remembered
  });

  it('handles the same event once, however many times it is sent', async () => {
    const r = await rig({ mode: 'ok' });
    const { pieceId, variantId, versionId } = await piece();
    await comment(versionId, 'Brighter, please');
    await requestChanges(versionId);
    await finishedRun(pieceId);
    const d = await env.db.one(`select id from webhook_delivery order by created_at desc limit 1`);
    await env.call(env.users.admin, 'POST', `/api/webhook-deliveries/${d!.id}/redeliver`);
    await flush();
    await new Promise((res) => setTimeout(res, 500));
    expect((await versions(variantId)).length).toBe(2);
    expect(await env.db.query(`select 1 from agent_run where piece_id = $1`, [pieceId])).toHaveLength(1);
    expect(r.queue.list()).toHaveLength(0);
  });

  it('does nothing for a request a person has already moved past', async () => {
    const r = await rig({ mode: 'ok' });
    const { pieceId, variantId, versionId } = await piece();
    await comment(versionId, 'Brighter, please');
    r.queue.add({ id: randomUUID(), brand: 'lumen', type: 'version.changes_requested', receivedAt: new Date().toISOString(), payload: { id: 'x', type: 'version.changes_requested', data: { piece: { id: pieceId }, version: { id: versionId, variant: { id: variantId } } } } });
    // The version is still in review (changes were never requested), so there is nothing for the agent.
    await waitFor('the item to be dropped', async () => r.queue.list().length === 0);
    expect(await env.db.query(`select 1 from agent_run where piece_id = $1`, [pieceId])).toHaveLength(0);
  });

  it('leaves the comments that are for people only, and does not start the agent when that is all there is', async () => {
    const r = await rig({ mode: 'ok' });
    const { pieceId, variantId, versionId } = await piece();
    const a = await comment(versionId, 'Ask Ana about the music', { peopleOnly: true });
    await requestChanges(versionId);
    const run = await finishedRun(pieceId);
    expect(run).toMatchObject({ outcome: 'needs_people' });
    expect(run.notes).toContain('people only');
    expect((await versions(variantId)).length).toBe(1);
    expect((await thread(versionId, a)).replies).toEqual([]);
    expect(runDirOf(r, pieceId).every((d) => !existsSync(path.join(d, 'instructions.md')))).toBe(true); // the agent was never invoked
  });
});

describe('what goes wrong is said, never silent', () => {
  it('answers every comment "needs a person" when the agent crashes, and records the failure', async () => {
    await rig({ mode: 'crash' });
    const { pieceId, variantId, versionId } = await piece();
    const a = await comment(versionId, 'Brighter');
    const b = await comment(versionId, 'Louder music');
    await requestChanges(versionId);
    const run = await finishedRun(pieceId);
    expect(run).toMatchObject({ outcome: 'failed' });
    expect(run.notes).toContain('exited with 3');
    expect(run.notes).toContain('boom');
    expect((await versions(variantId)).length).toBe(1);
    for (const id of [a, b]) expect((await thread(versionId, id)).replies).toEqual([expect.objectContaining({ reply_kind: 'needs_human', by_agent: true })]);
    expect((await env.db.query(`select 1 from notification where kind = 'agent.failed'`)).length).toBeGreaterThan(0);
  });

  it('answers "needs a person" when the agent leaves no files, or files identical to the old ones', async () => {
    for (const mode of ['nofiles', 'identical']) {
      await rig({ mode });
      const { pieceId, variantId, versionId } = await piece();
      const a = await comment(versionId, 'Brighter');
      await requestChanges(versionId);
      const run = await finishedRun(pieceId);
      expect(run.outcome, mode).toBe('failed');
      expect(run.notes, mode).toMatch(mode === 'nofiles' ? /left no video, image or PDF/ : /identical to the previous version/);
      expect((await versions(variantId)).length, mode).toBe(1);
      expect((await thread(versionId, a)).replies, mode).toEqual([expect.objectContaining({ reply_kind: 'needs_human' })]);
      await rigs.pop()!.stop();
    }
  });

  it('treats an agent that declines every comment, with reasons, as an answer for a person: not a failure, and in its own words', async () => {
    await rig({ mode: 'declines' });
    const { pieceId, variantId, versionId } = await piece();
    const a = await comment(versionId, 'Make the text bigger');
    const b = await comment(versionId, 'Replace the footage: impossible without a new shoot');
    await requestChanges(versionId);
    const run = await finishedRun(pieceId);
    expect(run.outcome).toBe('needs_people');
    expect(run.notes).toContain('cannot be done from the files I have');
    expect((await versions(variantId)).length).toBe(1);
    expect((await thread(versionId, a)).replies).toEqual([expect.objectContaining({ reply_kind: 'needs_human', by_agent: true, body: 'Declined: Make the text bigger' })]);
    expect((await thread(versionId, b)).replies).toEqual([expect.objectContaining({ reply_kind: 'cannot_do', by_agent: true })]);
    // Not a failure to look into, but someone has to take the piece from here, and is told.
    expect(await env.db.query(`select 1 from notification where kind = 'agent.failed' and payload->>'pieceId' = $1`, [pieceId])).toHaveLength(0);
    expect((await env.db.query(`select 1 from notification where kind = 'agent.needs_person' and payload->>'reason' = 'agent_declined' and payload->>'pieceId' = $1`, [pieceId])).length).toBeGreaterThan(0);
  });

  it('still fails a run that makes nothing when it claims to have fixed a comment, or says nothing about one', async () => {
    // "Brighter" is reported fixed with no file to show for it; "forgotten" gets no word at all.
    for (const [mode, bodies] of [['nofiles', ['Brighter', 'Replace the footage: impossible']], ['declines', ['Make the text bigger', 'A forgotten detail']]] as const) {
      await rig({ mode });
      const { pieceId, variantId, versionId } = await piece();
      const ids = [];
      for (const body of bodies) ids.push(await comment(versionId, body));
      await requestChanges(versionId);
      const run = await finishedRun(pieceId);
      expect(run.outcome, mode).toBe('failed');
      expect((await versions(variantId)).length, mode).toBe(1);
      for (const id of ids) expect((await thread(versionId, id)).replies, mode).toEqual([expect.objectContaining({ reply_kind: 'needs_human' })]);
      await rigs.pop()!.stop();
    }
  });

  it('stops an agent that runs out of time, and says so on every comment', async () => {
    await rig({ mode: 'slow' });
    await env.db.query(`update brand set agent = jsonb_set(agent, '{max_run_minutes}', '0.1') where id = $1`, [env.brandId]); // six seconds
    const { pieceId, versionId } = await piece();
    const a = await comment(versionId, 'Brighter');
    const t0 = Date.now();
    await requestChanges(versionId);
    const run = await finishedRun(pieceId);
    expect(run).toMatchObject({ outcome: 'timeout' });
    expect(Date.now() - t0).toBeLessThan(25_000); // the agent was set to sleep for a minute
    expect((await thread(versionId, a)).replies).toEqual([expect.objectContaining({ reply_kind: 'needs_human', body: expect.stringContaining('ran out of time') })]);
  });

  it('refuses a result that points outside its own output directory, by a path or by a link', async () => {
    for (const mode of ['traversal', 'symlink-manifest', 'symlink-inferred']) {
      await rig({ mode });
      const { pieceId, versionId, variantId } = await piece();
      await comment(versionId, 'Brighter');
      await requestChanges(versionId);
      const run = await finishedRun(pieceId);
      expect(run.outcome, mode).toBe('failed');
      expect(run.notes, mode).toMatch(/not a file in the output directory|leads somewhere outside it/);
      expect((await versions(variantId)).length, mode).toBe(1);
      await rigs.pop()!.stop();
    }
  });
});

describe('the automatic checks', () => {
  it('gives the agent a second go, telling it what failed, and uploads once it passes', async () => {
    const r = await rig({ mode: 'retry', agentExtra: { env: { FAKE_AGENT_MODE: 'retry' }, cost: { fixed: 0.5 } }, checks: { requireNetworks: ['instagram'] } });
    const { pieceId, variantId, versionId } = await piece();
    await comment(versionId, 'Brighter');
    await requestChanges(versionId);
    const run = await finishedRun(pieceId);
    expect(run).toMatchObject({ outcome: 'uploaded' });
    expect(Number(run.cost)).toBe(1); // two runs of the agent, half a unit each
    expect(run.detail.attempts).toBe(2);
    expect((await versions(variantId)).length).toBe(2);
    const [dir] = runDirOf(r, pieceId);
    const second = readFileSync(path.join(dir!, 'instructions.md'), 'utf8');
    expect(second).toContain('did not pass the automatic checks');
    expect(second).toMatch(/Instagram cannot publish short\.mp4/);
  });

  it('does not upload what keeps failing, and says which check', async () => {
    await rig({ mode: 'always-short', checks: { requireNetworks: ['instagram'] }, checkRetries: 1 });
    const { pieceId, variantId, versionId } = await piece();
    const a = await comment(versionId, 'Brighter');
    await requestChanges(versionId);
    const run = await finishedRun(pieceId);
    expect(run).toMatchObject({ outcome: 'checks_failed' });
    expect(run.notes).toContain('did not pass the automatic checks');
    expect(run.detail.checks.errors).toBeGreaterThan(0);
    expect((await versions(variantId)).length).toBe(1);
    expect((await thread(versionId, a)).replies).toEqual([expect.objectContaining({ reply_kind: 'needs_human', body: expect.stringContaining('automatic checks') })]);
  });

  it('puts warnings in the version notes for the reviewers, without blocking', async () => {
    await rig({ mode: 'ok', checks: { loudness: { min: -12, max: -9 } } }); // the fake agent keeps the source audio, which is louder than this allows
    const { pieceId, variantId, versionId } = await piece();
    await comment(versionId, 'Brighter');
    await requestChanges(versionId);
    await finishedRun(pieceId);
    const vs = await versions(variantId);
    expect(vs.length).toBe(2);
    expect(vs[1]!.notes).toMatch(/Warning: revised\.mp4 is .* LUFS/);
  });
});

describe('the safeguards, as the runner meets them', () => {
  it('does not start an agent past the round cap, and the people responsible are told', async () => {
    const r = await rig({ mode: 'ok' });
    await limits({ max_rounds: 1 });
    const { pieceId, variantId, versionId } = await piece();
    await comment(versionId, 'Brighter');
    await requestChanges(versionId);
    await finishedRun(pieceId);
    const v2 = (await versions(variantId))[1]!.id as string;
    await comment(v2, 'Now make it warmer');
    await requestChanges(v2);
    await waitFor('the second request to be dropped', async () => (await env.db.query(`select 1 from agent_run where piece_id = $1 and outcome = 'blocked'`, [pieceId])).length === 1);
    await waitFor('the queue to empty', async () => r.queue.list().length === 0);
    expect((await versions(variantId)).length).toBe(2); // no third version
    const s = (await env.call(env.users.approver, 'GET', `/api/pieces/${pieceId}/agent`)).body;
    expect(s).toMatchObject({ status: 'needs_person', blocked_reason: 'rounds_exhausted', rounds: 1 });
    expect((await env.db.query(`select 1 from notification where kind = 'agent.needs_person'`)).length).toBeGreaterThan(0);
    expect(runDirOf(r, pieceId)).toHaveLength(1); // the agent ran once only
  });

  it('does not start an agent when no budget has been set', async () => {
    const r = await rig({ mode: 'ok' });
    await limits({ max_cost_per_month: null });
    const { pieceId, versionId } = await piece();
    await comment(versionId, 'Brighter');
    await requestChanges(versionId);
    await waitFor('the refusal', async () => (await env.db.query(`select 1 from agent_run where piece_id = $1 and blocked_reason = 'budget_not_set'`, [pieceId])).length === 1);
    await waitFor('the queue to empty', async () => r.queue.list().length === 0);
    expect(runDirOf(r, pieceId)).toHaveLength(0);
  });

  it('waits its turn when another agent is working on the piece, then goes', async () => {
    const r = await rig({ mode: 'ok' });
    const { pieceId, variantId, versionId } = await piece();
    await comment(versionId, 'Brighter');
    // Somebody else holds the piece.
    const other = await env.call(agent, 'POST', `/api/pieces/${pieceId}/agent-runs`, { trigger: 'manual' });
    expect(other.status).toBe(201);
    await requestChanges(versionId);
    await waitFor('the runner to be told the piece is busy', async () => r.queue.list()[0]?.notBefore ? r.queue.list()[0] : false);
    expect(r.queue.list()[0]!.notBefore).toBeGreaterThan(Date.now() + 30_000);
    expect((await versions(variantId)).length).toBe(1);
    await env.call(agent, 'POST', `/api/agent-runs/${other.body.id}/finish`, { outcome: 'aborted' });
    r.clock.skew = 61_000; // a minute later, as the runner's clock sees it
    r.runner.wake();
    await waitFor('the second version', async () => (await versions(variantId)).length === 2);
  });
});

describe('what the agent is and is not given', () => {
  it('runs without the runner\'s environment: no studio token, no webhook secret', async () => {
    await rig({ mode: 'env' });
    process.env.SECRET_THAT_SHOULD_NOT_LEAK = 'abc';
    const { pieceId, variantId, versionId } = await piece();
    await comment(versionId, 'Brighter');
    await requestChanges(versionId);
    await finishedRun(pieceId);
    delete process.env.SECRET_THAT_SHOULD_NOT_LEAK;
    const notes = (await versions(variantId))[1]!.notes as string;
    const names = /env: ([^\n.]*)/.exec(notes)![1]!.split(',');
    expect(names).toContain('PATH');
    expect(names).toContain('FAKE_AGENT_MODE');
    expect(names).toContain('ESTUDIO_OUTPUT_DIR');
    expect(names).not.toContain('SECRET_THAT_SHOULD_NOT_LEAK');
    expect(notes).not.toContain(token);
  });

  it('keeps the sources of a piece between rounds', async () => {
    await rig({ mode: 'sources' });
    const { pieceId, variantId, versionId } = await piece();
    await comment(versionId, 'Brighter');
    await requestChanges(versionId);
    await finishedRun(pieceId);
    const v2 = (await versions(variantId))[1]!.id as string;
    expect((await versions(variantId))[1]!.notes).toContain('sources seen: none');
    await comment(v2, 'Even brighter');
    await requestChanges(v2);
    await finishedRun(pieceId, 2);
    const v3 = (await versions(variantId))[2]!;
    expect(v3.notes).toMatch(/sources seen: round-\d+\.txt/);
    expect(v3.notes).toContain('Agent round 2');
  });
});

describe('the runner\'s secrets', () => {
  it('posts nothing of a result that holds one, wherever the agent put it', async () => {
    // The agent has got hold of the studio token (here it is simply handed to it) and writes it where the runner posts from.
    for (const mode of ['leak', 'leak-in-file']) {
      await rig({ mode, agentExtra: { env: { FAKE_AGENT_MODE: mode, FAKE_LEAK: token } } });
      const { pieceId, variantId, versionId } = await piece();
      const a = await comment(versionId, 'Brighter');
      await requestChanges(versionId);
      const run = await finishedRun(pieceId);
      expect(run.outcome, mode).toBe('failed');
      expect(run.notes, mode).toContain('held a secret of this runner');
      expect((await versions(variantId)).length, mode).toBe(1); // nothing uploaded
      const t = await thread(versionId, a);
      expect(t.replies, mode).toEqual([expect.objectContaining({ reply_kind: 'needs_human', by_agent: true })]);
      const posted = JSON.stringify([await env.db.query('select * from agent_run where piece_id = $1', [pieceId]), t, await versions(variantId)]);
      expect(posted, mode).not.toContain(token);
      await rigs.pop()!.stop();
    }
  });

  it('takes one out of whatever else it posts, such as the error output of an agent that crashed', async () => {
    await rig({ mode: 'leak-crash', agentExtra: { env: { FAKE_AGENT_MODE: 'leak-crash', FAKE_LEAK: token } } });
    const { pieceId, versionId } = await piece();
    await comment(versionId, 'Brighter');
    await requestChanges(versionId);
    const run = await finishedRun(pieceId);
    expect(run.outcome).toBe('failed');
    expect(run.notes).toContain('exited with 3');
    expect(run.notes).toContain('token=[secret removed]');
    expect(run.notes).not.toContain(token);
  });

  // bwrap (bubblewrap) as the sandbox, where it is installed and allowed to make namespaces.
  const bwrap = (() => {
    try {
      execFileSync('bwrap', ['--ro-bind', '/', '/', '--unshare-all', 'true'], { stdio: 'ignore' });
      return true;
    } catch {
      return false;
    }
  })();

  it.skipIf(!bwrap)('lets a sandboxed agent see its piece and nothing else: not the runner\'s secret files, its environment, or other brands', async () => {
    // What the agent must not reach: a secret file of the runner's, another brand's workspace, the runner's environment.
    const secretFile = path.join(work, 'lumen.token');
    writeFileSync(secretFile, token);
    chmodSync(secretFile, 0o600);
    const snoop = (r: Rig) => {
      const other = path.join(r.config.workspaceRoot, 'otherbrand', 'piece');
      mkdirSync(other, { recursive: true });
      writeFileSync(path.join(other, 'brief.md'), 'another brand\'s plans');
      return [secretFile, path.join(other, 'brief.md'), `/proc/${process.pid}/environ`].join(',');
    };
    const readable = async (r: Rig) => {
      const { pieceId, variantId, versionId } = await piece();
      await comment(versionId, 'Brighter');
      await requestChanges(versionId);
      const run = await finishedRun(pieceId);
      expect(run.outcome, run.notes).toBe('uploaded');
      return /readable: ([^;]*)/.exec((await versions(variantId))[1]!.notes as string)![1]!;
    };

    // Without a sandbox, an agent of the runner's own user reads all three: what the finding was about.
    const plain = await rig({ mode: 'snoop' });
    plain.config.brands.lumen!.agent.env.FAKE_SNOOP = snoop(plain);
    expect((await readable(plain)).split(',')).toHaveLength(3);
    await rigs.pop()!.stop();

    const node = path.dirname(path.dirname(process.execPath));
    const boxed = await rig({
      mode: 'snoop',
      agentExtra: {
        sandbox: {
          command: [
            'bwrap', '--die-with-parent', '--new-session', '--unshare-all',
            '--ro-bind', '/usr', '/usr', '--symlink', 'usr/bin', '/bin', '--symlink', 'usr/lib', '/lib', '--symlink', 'usr/lib64', '/lib64',
            '--ro-bind-try', '/etc/alternatives', '/etc/alternatives', '--ro-bind-try', '/etc/ld.so.cache', '/etc/ld.so.cache',
            '--ro-bind', node, node, '--ro-bind', here, here,
            '--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp',
            '--bind', '{{pieceDir}}', '/work', '--chdir', '{{agentRunDir}}', '--',
          ],
          pieceDir: '/work',
        },
      },
    });
    boxed.config.brands.lumen!.agent.env.FAKE_SNOOP = snoop(boxed);
    expect(await readable(boxed)).toBe('none');
    // The brand's directory and the runner's state are closed to other users too.
    const modeOf = (p: string) => (statSync(p).mode & 0o777).toString(8);
    expect(modeOf(path.join(boxed.config.workspaceRoot, 'lumen'))).toBe('700');
    expect(modeOf(boxed.config.stateDir)).toBe('700');
    expect(modeOf(boxed.config.workspaceRoot)).toBe('700');
  });
});

describe('after a restart', () => {
  async function started(r: Rig) {
    const { pieceId, variantId, versionId } = await piece();
    const a = await comment(versionId, 'Brighter');
    const b = await comment(versionId, 'Forgotten, but not by the people');
    const studio = new Studio(apiUrl, token);
    const run = await studio.startRun({ pieceId }, { trigger: 'version.changes_requested' });
    return { pieceId, variantId, versionId, a, b, run, studio, r };
  }
  const item = (s: Awaited<ReturnType<typeof started>>, extra: Partial<Item>): Item => ({
    id: randomUUID(), brand: 'lumen', type: 'version.changes_requested', receivedAt: new Date().toISOString(), tries: 0, notBefore: 0, stage: 'agent_done',
    payload: { data: { piece: { id: s.pieceId }, version: { id: s.versionId, variant: { id: s.variantId } } } },
    runId: s.run.id, round: 1, maxRounds: 3, maxCost: 5, maxMinutes: 30, ...extra,
  });
  const deps = (r: Rig) => ({ config: r.config, studioFor: () => new Studio(apiUrl, token), templates: loadTemplates(r.config), queue: r.queue, log: silentLogger, now: Date.now });

  it('carries on from "the agent has finished": uploads what it left, answers the comments, closes the run', async () => {
    const r = await rig({ mode: 'ok' });
    const s = await started(r);
    // What an earlier process left behind: the agent's output on disk, and the item saying so.
    const out = path.join(r.dir, 'left-behind');
    execFileSync('mkdir', ['-p', out]);
    execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=s=540x960:r=25', '-t', '3', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', path.join(out, 'recovered.mp4')]);
    const it = item(s, {
      work: {
        brandId: s.run.id, brandName: 'Test', startedAt: Date.now(), deadline: Date.now() + 600_000, cost: 0.3, attempts: 0, eligible: [s.a, s.b],
        files: [{ path: path.join(out, 'recovered.mp4'), kind: 'video', position: 0 }], notes: 'Recovered after a restart',
        said: [{ id: s.a, status: 'fixed', reply: 'Done before the restart' }],
        checks: { errors: 0, warnings: 0, summary: ['ok'], issues: [] },
      },
    });
    r.queue.add(it);
    r.queue.save(it);
    const taken = r.queue.take(Date.now())!;
    expect(await handle(deps(r), taken)).toEqual({ done: true });

    const vs = await versions(s.variantId);
    expect(vs.map((v) => v.number)).toEqual([1, 2]);
    expect(vs[1]!.notes).toContain('Recovered after a restart');
    expect((await thread(vs[1]!.id, s.a)).replies[0]).toMatchObject({ reply_kind: 'fixed', body: 'Done before the restart' });
    expect((await thread(vs[1]!.id, s.b)).replies[0]).toMatchObject({ reply_kind: 'needs_human' });
    const run = (await env.db.one('select * from agent_run where id = $1', [s.run.id]))!;
    expect(run).toMatchObject({ outcome: 'uploaded', version_id: vs[1]!.id });
    expect(Number(run.cost)).toBe(0.3);
  });

  it('carries on from "the run has started": does the work under the same run, not a second one', async () => {
    const r = await rig({ mode: 'ok' });
    const s = await started(r);
    const it = item(s, { stage: 'started', work: { brandId: 'unused', brandName: 'Test brand', startedAt: Date.now(), deadline: Date.now() + 600_000, cost: 0, attempts: 0, eligible: [] } });
    // The brand id is known from the token, so the item only needs to say where it was.
    it.work!.brandId = env.brandId;
    r.queue.add(it);
    r.queue.save(it);
    expect(await handle(deps(r), r.queue.take(Date.now())!)).toEqual({ done: true });
    expect((await versions(s.variantId)).length).toBe(2);
    expect(await env.db.query('select 1 from agent_run where piece_id = $1', [s.pieceId])).toHaveLength(1); // the run the studio already had
    expect((await env.db.one('select outcome from agent_run where id = $1', [s.run.id]))!.outcome).toBe('uploaded');
    expect((await thread((await versions(s.variantId))[1]!.id, s.a)).replies[0]).toMatchObject({ reply_kind: 'fixed' });
  });

  it('does not answer a comment twice if it stopped halfway through the replies', async () => {
    const r = await rig({ mode: 'ok' });
    const s = await started(r);
    const v2 = await env.newVersion(agent, s.variantId, [{ name: 'later.mp4', mime: 'video/mp4', data: Buffer.concat([video, Buffer.from('x')]) }]);
    await s.studio.reply(s.a, { body: 'Already said', kind: 'fixed' });
    const it = item(s, {
      stage: 'uploaded', versionId: v2.body.id, versionNumber: 2, repliedIds: [s.a],
      work: { brandId: 'b', brandName: 'T', startedAt: 0, deadline: 0, cost: 0, attempts: 0, eligible: [s.a, s.b], files: [], notes: '', said: [{ id: s.a, status: 'fixed' }], checks: { errors: 0, warnings: 0, summary: [], issues: [] } },
    });
    r.queue.add(it);
    r.queue.save(it);
    await handle(deps(r), r.queue.take(Date.now())!);
    expect((await thread(v2.body.id, s.a)).replies).toHaveLength(1);
    expect((await thread(v2.body.id, s.b)).replies).toHaveLength(1);
    expect((await env.db.one('select outcome from agent_run where id = $1', [s.run.id]))!.outcome).toBe('uploaded');
  });
});

describe('an empty slot', () => {
  it('becomes a new piece, made by the agent, in review, against the campaign that is running', async () => {
    const r = await rig({ mode: 'slotnew', webhookEvents: ['slot.needs_content'] });
    await env.db.query('delete from slot where brand_id = $1', [env.brandId]);
    const campaign = await env.call(env.users.admin, 'POST', `/api/brands/${env.brandId}/campaigns`, { name: 'Spring launch', objective: 'Make the new menu famous' });
    // A slot tomorrow at noon, in the brand's own time.
    const tomorrow = DateTime.now().setZone('Europe/Madrid').plus({ days: 1 });
    await env.call(env.users.admin, 'POST', `/api/brands/${env.brandId}/slots`, { accountId: env.accounts.instagram, weekday: tomorrow.weekday, localTime: '12:00', label: 'Reels' });
    expect(await scanSlotAlerts(env.ctx)).toBe(1);
    await flush();

    const run = await finishedRun(null);
    expect(run).toMatchObject({ outcome: 'uploaded', trigger: 'slot.needs_content' });
    const created = (await env.db.one(`select p.*, ver.number, ver.author_token_id from piece p join variant v on v.piece_id = p.id join version ver on ver.variant_id = v.id where p.title = 'Slot filler: the spring menu'`))!;
    expect(created).toMatchObject({ kind: 'video', ai_generated: true, review_state: 'in_review', number: 1, target_date: tomorrow.toISODate() });
    expect(created.author_token_id).not.toBeNull();
    expect(created.campaign_id).toBe(campaign.body.id);
    expect(run.piece_id).toBe(created.id); // the run points at what it made
    expect(run.version_id).not.toBeNull();
    const slotDir = readdirSync(path.join(r.config.workspaceRoot, 'lumen')).find((d) => d.startsWith('_slots_'))!;
    const runs = path.join(r.config.workspaceRoot, 'lumen', slotDir, 'runs');
    const instr = readFileSync(path.join(runs, readdirSync(runs)[0]!, 'instructions.md'), 'utf8');
    expect(instr).toContain('Spring launch: Make the new menu famous');
    expect(instr).toContain('Reels');
    await env.db.query('delete from slot where brand_id = $1', [env.brandId]);
  });
});
