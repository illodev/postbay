import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { deliver, dueDeliveries } from '../../api/src/services/webhooks.js';
import { createEnv, type Env } from '../../api/test/helpers.js';
import { parseConfig, type Config } from '../src/config.js';
import { consoleLogger, silentLogger } from '../src/log.js';
import { Queue } from '../src/queue.js';
import { startRunner, type Runner } from '../src/runner.js';
import { createServer } from '../src/server.js';

// A request for changes on a piece made from a project: the agent works in the project, the runner commits what it changed and says
// which commit the new version came from. Against a real API, real PostgreSQL, real git and real ffmpeg, with the scripted agent.
const LOG = process.env.TEST_LOG ? consoleLogger() : silentLogger;
const here = path.dirname(fileURLToPath(import.meta.url));
const FAKE_AGENT = path.join(here, 'fake-agent.mjs');
const TEMPLATES = path.join(here, '..', 'templates');
const SOURCE = 'videos:2026-09-29-quarterly-taxes/telenovela';

let env: Env;
let apiUrl: string;
let work: string;
let video: Buffer;
let token: string;
let repo: string;
let projects: string;

const freePort = () => new Promise<number>((resolve) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = (s.address() as net.AddressInfo).port; s.close(() => resolve(p)); }); });
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 'Owner', GIT_AUTHOR_EMAIL: 'owner@example.com', GIT_COMMITTER_NAME: 'Owner', GIT_COMMITTER_EMAIL: 'owner@example.com' } }).trim();

beforeAll(async () => {
  work = mkdtempSync(path.join(tmpdir(), 'runner-project-loop-'));
  const port = await freePort();
  apiUrl = `http://127.0.0.1:${port}`;
  env = await createEnv({ MEDIA_URL: apiUrl, TOKEN_KEY: Buffer.alloc(32, 9).toString('base64') }, { realMedia: true });
  await env.app.listen({ port, host: '127.0.0.1' });
  const p = path.join(work, 'v1.mp4');
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=s=540x960:r=25', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000,volume=6dB', '-t', '6', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', p]);
  video = readFileSync(p);
  token = (await env.call(env.users.admin, 'POST', `/api/brands/${env.brandId}/tokens`, { name: 'Agent runner' })).body.token;
  await env.call(env.users.admin, 'PATCH', `/api/brands/${env.brandId}`, { agent: { max_rounds: 3, max_cost_per_piece: 5, max_cost_per_month: 100, max_run_minutes: 30 } });

  // The person's repository of video projects: one folder per piece, a scene and its assets, and a link someone committed by mistake.
  repo = path.join(work, 'videos');
  mkdirSync(path.join(repo, '2026-09-29-quarterly-taxes', 'telenovela'), { recursive: true });
  writeFileSync(path.join(repo, '2026-09-29-quarterly-taxes', 'telenovela', 'scene.js'), '// the telenovela\n');
  writeFileSync(path.join(repo, 'CLAUDE.md'), 'Render with the engine.\n');
  symlinkSync('/etc', path.join(repo, 'escape'));
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'The projects');
  // A folder of projects worked on in place.
  projects = path.join(work, 'projects');
  mkdirSync(path.join(projects, 'client', 'promo'), { recursive: true });
  writeFileSync(path.join(projects, 'client', 'promo', 'scene.js'), '// the promo\n');
});
afterAll(async () => {
  await env.close();
  rmSync(work, { recursive: true, force: true });
});

interface Rig {
  config: Config;
  runner: Runner;
  server: http.Server;
  stop: () => Promise<void>;
}
const rigs: Rig[] = [];
afterEach(async () => {
  while (rigs.length) await rigs.pop()!.stop();
  await env.db.query('delete from agent_run');
});

const PROJECT = () => ({
  repos: { videos: { mode: 'git', repo, author: { name: 'Studio agent', email: 'agent@studio.test' } }, local: { mode: 'dir', root: projects } },
  default: 'videos',
  template: path.join(TEMPLATES, 'project-changes-requested.md'),
});

/** A runner for the brand. `project: false` configures no projects at all. */
async function rig(o: { mode?: string; project?: unknown; agentExtra?: Record<string, unknown> } = {}): Promise<Rig> {
  const dir = mkdtempSync(path.join(work, 'rig-'));
  const created = await env.call(env.users.admin, 'POST', `/api/brands/${env.brandId}/webhooks`, { url: 'http://127.0.0.1:9/placeholder', events: ['version.changes_requested'] });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const config = parseConfig(
    {
      workspaceRoot: path.join(dir, 'work'),
      brands: {
        lumen: {
          api: apiUrl, token, webhookSecret: created.body.secret,
          templates: { 'version.changes_requested': path.join(TEMPLATES, 'changes-requested.md') },
          agent: { command: [process.execPath, FAKE_AGENT], env: { FAKE_AGENT_MODE: o.mode ?? 'project' }, killGraceSeconds: 1, ...(o.agentExtra ?? {}) },
          checks: {},
          project: o.project === false ? undefined : (o.project ?? PROJECT()),
        },
      },
    },
    dir,
    {},
  );
  const queue = new Queue(config.stateDir);
  const runner = startRunner(config, queue, LOG, { tickMs: 50 });
  const server = createServer({ config, queue, log: LOG, wake: () => runner.wake() });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  await env.call(env.users.admin, 'PATCH', `/api/webhooks/${created.body.id}`, { url: `http://127.0.0.1:${(server.address() as net.AddressInfo).port}/webhooks/lumen` });
  const r: Rig = {
    config, runner, server,
    async stop() {
      await runner.stop();
      await new Promise<void>((res) => server.close(() => res()));
      await env.call(env.users.admin, 'DELETE', `/api/webhooks/${created.body.id}`);
    },
  };
  rigs.push(r);
  return r;
}

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
const finishedRun = (pieceId: string, n = 1) =>
  waitFor('the agent run to finish', async () => {
    const rows = await env.db.query(`select * from agent_run where piece_id = $1 and status = 'finished' and outcome <> 'blocked' order by started_at, seq`, [pieceId]);
    return rows.length >= n ? rows[n - 1] : false;
  });

/** A piece in review with a real video, made from the project `source` names (or from none). */
async function piece(source: string | null, title = 'Quarterly taxes: the telenovela') {
  const created = await env.call(env.users.producer, 'POST', `/api/brands/${env.brandId}/pieces`, { title, kind: 'video', ...(source ? { source } : {}) });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const pieceId = created.body.id as string;
  const variantId = (await env.call(env.users.producer, 'POST', `/api/pieces/${pieceId}/variants`, { format: '9:16' })).body.id as string;
  const v = await env.newVersion(env.users.producer, variantId, [{ name: 'take1.mp4', mime: 'video/mp4', data: video }]);
  expect(v.status, JSON.stringify(v.body)).toBe(201);
  return { pieceId, variantId, versionId: v.body.id as string };
}
const comment = async (versionId: string, body: string) => {
  const r = await env.call(env.users.reviewer, 'POST', `/api/versions/${versionId}/comments`, { body });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body.id as string;
};
const requestChanges = async (versionId: string) => {
  expect((await env.call(env.users.reviewer, 'POST', `/api/versions/${versionId}/request-changes`, {})).status).toBe(200);
  await flush();
};
const versions = (variantId: string) => env.db.query('select * from version where variant_id = $1 order by number', [variantId]);
const thread = async (versionId: string, id: string) => (await env.call(env.users.reviewer, 'GET', `/api/versions/${versionId}/comments?carried=true`)).body.find((c: any) => c.id === id);

describe('a piece made from a project in git', () => {
  it('is revised in its own worktree, on its own branch, and every round is a commit the new version names', async () => {
    const r = await rig();
    const { pieceId, variantId, versionId } = await piece(SOURCE);
    const logo = await comment(versionId, 'The logo goes in the corner');
    const shadow = await comment(versionId, 'The shadow is missing');
    await requestChanges(versionId);

    const run = await finishedRun(pieceId);
    expect(run.outcome, run.notes).toBe('uploaded');
    const clone = path.join(r.config.workspaceRoot, 'lumen', '_repos', 'videos.git');
    const worktree = path.join(r.config.workspaceRoot, 'lumen', pieceId, 'project', 'videos');
    const branch = `studio/${pieceId}`;
    const sha1 = git(clone, 'rev-parse', `refs/heads/${branch}`);

    // The agent was told about the project, in the project's instructions, and worked in the piece's worktree on the piece's branch.
    const vs = await versions(variantId);
    expect(vs.map((v) => v.number)).toEqual([1, 2]);
    const notes = vs[1]!.notes as string;
    expect(notes).toContain(`project ${path.join(worktree, '2026-09-29-quarterly-taxes', 'telenovela')}; branch ${branch}; saw scene.js;`);
    expect(notes).toContain('first line: # Revise "Quarterly taxes: the telenovela" in its project');
    // The version says which commit it was made from.
    expect(notes).toContain(`Project ${SOURCE}: commit ${sha1} on branch ${branch}.`);
    expect(run.detail.project).toMatchObject({ source: SOURCE, mode: 'git', branch, commit: sha1, base: git(repo, 'rev-parse', 'main'), files: 2 });

    // The commit: by the configured author, on top of the base branch, with the round, the piece and each comment.
    expect(git(clone, 'rev-parse', `${branch}~1`)).toBe(git(repo, 'rev-parse', 'main'));
    expect(git(clone, 'log', '-1', '--format=%an <%ae>', branch)).toBe('Studio agent <agent@studio.test>');
    const message = git(clone, 'log', '-1', '--format=%B', branch);
    expect(message.split('\n')[0]).toBe('Studio round 1: Quarterly taxes: the telenovela');
    expect(message).toContain('asked for on version 1');
    expect(message).toContain(`- ${logo}: fixed`);
    expect(message).toContain(`- ${shadow}: fixed`);
    expect(git(clone, 'log', '-1', '--format=%(trailers:key=Studio-Comment,valueonly)', branch).split('\n').sort()).toEqual([logo, shadow].sort());
    expect(git(clone, 'log', '-1', '--format=%(trailers:key=Studio-Piece,valueonly)', branch)).toBe(pieceId);
    expect(git(clone, 'log', '-1', '--format=%(trailers:key=Studio-Run,valueonly)', branch)).toBe(run.id);
    expect(git(clone, 'show', '--name-only', '--format=', branch).split('\n').sort()).toEqual(['2026-09-29-quarterly-taxes/telenovela/round-1.txt', '2026-09-29-quarterly-taxes/telenovela/scene.js']);
    expect(git(clone, 'show', `${branch}:2026-09-29-quarterly-taxes/telenovela/scene.js`)).toContain(`// ${logo}: The logo goes in the corner`);
    expect(git(worktree, 'status', '--porcelain')).toBe('');
    // The person's own repository is not touched.
    expect(git(repo, 'branch', '--list')).toBe('* main');
    expect(git(repo, 'status', '--porcelain')).toBe('');
    // The comments are answered as usual.
    expect(await thread(vs[1]!.id, logo)).toMatchObject({ status: 'resolved', replies: [expect.objectContaining({ reply_kind: 'fixed' })] });

    // Round 2: the same worktree, with round 1's work in it, and a second commit on the same branch.
    const warmer = await comment(vs[1]!.id, 'Now make the title bigger');
    await requestChanges(vs[1]!.id);
    const run2 = await finishedRun(pieceId, 2);
    expect(run2.outcome, run2.notes).toBe('uploaded');
    const sha2 = git(clone, 'rev-parse', `refs/heads/${branch}`);
    expect(sha2).not.toBe(sha1);
    expect(git(clone, 'rev-parse', `${branch}~1`)).toBe(sha1);
    const v3 = (await versions(variantId))[2]!;
    expect(v3.notes).toContain('saw round-1.txt,scene.js;');
    expect(v3.notes).toContain(`Project ${SOURCE}: commit ${sha2} on branch ${branch}.`);
    const message2 = git(clone, 'log', '-1', '--format=%B', branch);
    expect(message2.split('\n')[0]).toBe('Studio round 2: Quarterly taxes: the telenovela');
    expect(message2).toContain(`- ${warmer}: fixed`);
    expect(readdirSync(path.join(r.config.workspaceRoot, 'lumen', pieceId, 'project'))).toEqual(['videos']); // one worktree, kept
  });

  it('commits nothing, and throws the change away, when the agent wrote a secret of the runner into the project', async () => {
    const r = await rig({ mode: 'project-leak', agentExtra: { env: { FAKE_AGENT_MODE: 'project-leak', FAKE_LEAK: token } } });
    const { pieceId, variantId, versionId } = await piece(SOURCE);
    const a = await comment(versionId, 'Brighter');
    await requestChanges(versionId);
    const run = await finishedRun(pieceId);
    expect(run.outcome).toBe('failed');
    expect(run.notes).toContain('held a secret of this runner');
    expect((await versions(variantId)).length).toBe(1);
    expect((await thread(versionId, a)).replies).toEqual([expect.objectContaining({ reply_kind: 'needs_human' })]);
    const clone = path.join(r.config.workspaceRoot, 'lumen', '_repos', 'videos.git');
    const dir = path.join(r.config.workspaceRoot, 'lumen', pieceId, 'project', 'videos', '2026-09-29-quarterly-taxes', 'telenovela');
    expect(git(clone, 'rev-parse', `refs/heads/studio/${pieceId}`)).toBe(git(repo, 'rev-parse', 'main')); // the branch did not move
    expect(existsSync(path.join(dir, 'secret.txt'))).toBe(false);
    expect(readFileSync(path.join(dir, 'scene.js'), 'utf8')).toBe('// the telenovela\n');
    expect(JSON.stringify(run)).not.toContain(token);
  });

  it('keeps on the branch what an agent changed in a run that made no version, for a person to look at', async () => {
    const r = await rig();
    // The checks refuse what the agent makes, so the run ends without a version.
    r.config.brands.lumen!.checks.requireNetworks = ['a-network-nobody-has'];
    const { pieceId, variantId, versionId } = await piece(SOURCE);
    await comment(versionId, 'Brighter');
    await requestChanges(versionId);
    const run = await finishedRun(pieceId);
    expect(run.outcome).toBe('checks_failed');
    expect((await versions(variantId)).length).toBe(1);
    const clone = path.join(r.config.workspaceRoot, 'lumen', '_repos', 'videos.git');
    const sha = git(clone, 'rev-parse', `refs/heads/studio/${pieceId}`);
    expect(git(clone, 'log', '-1', '--format=%s', sha)).toBe('Studio round 1: Quarterly taxes: the telenovela (not uploaded: checks_failed)');
    expect(run.notes).toContain(`commit ${sha} on branch studio/${pieceId}`);
    expect(run.detail.project).toMatchObject({ commit: sha });
  });
});

describe('a piece made from a folder worked on in place', () => {
  it('is revised where it is, and the version says so', async () => {
    const r = await rig();
    const { pieceId, variantId, versionId } = await piece('local:client/promo', 'Promo');
    const a = await comment(versionId, 'Shorter title');
    await requestChanges(versionId);
    const run = await finishedRun(pieceId);
    expect(run.outcome, run.notes).toBe('uploaded');
    const dir = path.join(projects, 'client', 'promo');
    expect(readFileSync(path.join(dir, 'scene.js'), 'utf8')).toContain(`// ${a}: Shorter title`);
    expect(existsSync(path.join(dir, 'round-1.txt'))).toBe(true);
    const notes = (await versions(variantId))[1]!.notes as string;
    expect(notes).toContain(`project ${dir}; branch not a git worktree;`);
    expect(notes).toContain('Project local:client/promo: worked on in place');
    expect(existsSync(path.join(r.config.workspaceRoot, 'lumen', '_repos'))).toBe(false);
  });
});

describe('a source that leads anywhere else', () => {
  it('is refused before the agent starts, and every comment is told a person has to look', async () => {
    const r = await rig();
    for (const [source, why] of [
      ['videos:../../etc', /leads out of the repository/],
      ['videos:escape', /leads outside .* symbolic link/],
      ['local:/etc', /absolute path/],
      ['elsewhere:x', /not one of this runner's project repositories/],
      ['videos:2026-09-29-quarterly-taxes/nothing-here', /there is no folder/],
    ] as const) {
      const { pieceId, variantId, versionId } = await piece(source);
      const a = await comment(versionId, 'Brighter');
      await requestChanges(versionId);
      const run = await finishedRun(pieceId);
      expect(run.outcome, source).toBe('failed');
      expect(run.notes, source).toContain(`The piece's project (${source}) could not be used`);
      expect(run.notes, source).toMatch(why);
      expect((await versions(variantId)).length, source).toBe(1);
      expect((await thread(versionId, a)).replies, source).toEqual([expect.objectContaining({ reply_kind: 'needs_human', body: expect.stringContaining("The piece's project could not be used") })]);
      const runs = path.join(r.config.workspaceRoot, 'lumen', pieceId, 'runs');
      for (const d of existsSync(runs) ? readdirSync(runs) : []) expect(existsSync(path.join(runs, d, 'instructions.md')), source).toBe(false); // never started
    }
  });
});

describe('a piece without a source', () => {
  it('is revised as before, from its files, with the usual instructions: also when the brand has projects, and when it has none', async () => {
    for (const configured of [true, false]) {
      await rig({ project: configured ? PROJECT() : false });
      const { pieceId, variantId, versionId } = await piece(configured ? null : SOURCE); // without projects configured, even a source changes nothing
      await comment(versionId, 'Brighter');
      await requestChanges(versionId);
      const run = await finishedRun(pieceId);
      expect(run.outcome, run.notes).toBe('uploaded');
      const notes = (await versions(variantId))[1]!.notes as string;
      expect(notes).toContain('no project; instructions: # Revise "Quarterly taxes: the telenovela"');
      expect(notes).not.toContain('Project ');
      expect(run.detail.project).toBeUndefined();
      await rigs.pop()!.stop();
    }
  });
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

describe.skipIf(!bwrap)('in a sandbox', () => {
  const node = path.dirname(path.dirname(process.execPath));
  const box = (extra: unknown[]) => [
    'bwrap', '--die-with-parent', '--new-session', '--unshare-all',
    '--ro-bind', '/usr', '/usr', '--symlink', 'usr/bin', '/bin', '--symlink', 'usr/lib', '/lib', '--symlink', 'usr/lib64', '/lib64',
    '--ro-bind-try', '/etc/alternatives', '/etc/alternatives', '--ro-bind-try', '/etc/ld.so.cache', '/etc/ld.so.cache',
    '--ro-bind', node, node, '--ro-bind', here, here,
    '--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp',
    '--bind', '{{pieceDir}}', '/work', ...extra, '--chdir', '{{agentRunDir}}', '--',
  ];

  it('shows a git project where the piece is mounted, and git works there with the clone mounted read-only', async () => {
    const r = await rig({ agentExtra: { sandbox: { command: box([{ if: 'projectRepo', args: ['--ro-bind', '{{projectRepo}}', '{{projectRepo}}'] }]), pieceDir: '/work' } } });
    const { pieceId, variantId, versionId } = await piece(SOURCE);
    await comment(versionId, 'The logo goes in the corner');
    await requestChanges(versionId);
    const run = await finishedRun(pieceId);
    expect(run.outcome, run.notes).toBe('uploaded');
    const notes = (await versions(variantId))[1]!.notes as string;
    expect(notes).toContain(`project /work/project/videos/2026-09-29-quarterly-taxes/telenovela; branch studio/${pieceId}; saw scene.js;`);
    const clone = path.join(r.config.workspaceRoot, 'lumen', '_repos', 'videos.git');
    expect(notes).toContain(`commit ${git(clone, 'rev-parse', `refs/heads/studio/${pieceId}`)} on branch studio/${pieceId}`);
  });

  it('mounts a folder worked on in place where sandbox.projectDir says, and nothing else of the machine', async () => {
    mkdirSync(path.join(projects, 'boxed'), { recursive: true });
    writeFileSync(path.join(projects, 'boxed', 'scene.js'), '// boxed\n');
    await rig({ agentExtra: { sandbox: { command: box([{ if: 'projectMount', args: ['--bind', '{{projectMount}}', '{{agentProjectDir}}'] }]), pieceDir: '/work', projectDir: '/project' } } });
    const { pieceId, variantId, versionId } = await piece('local:boxed', 'Boxed');
    const a = await comment(versionId, 'Make it pop');
    await requestChanges(versionId);
    const run = await finishedRun(pieceId);
    expect(run.outcome, run.notes).toBe('uploaded');
    expect((await versions(variantId))[1]!.notes).toContain('project /project; branch not a git worktree; saw scene.js;');
    expect(readFileSync(path.join(projects, 'boxed', 'scene.js'), 'utf8')).toContain(`// ${a}: Make it pop`);
    expect(existsSync(path.join(projects, 'client', 'promo', 'round-2.txt'))).toBe(false); // the other projects were not there to touch
  });
});
