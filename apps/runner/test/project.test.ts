import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { buildCommand, planAgent } from '../src/agent.js';
import { parseConfig, type GitRepo, type ProjectSpec } from '../src/config.js';
import { acquire, commitProject, parseSource, prepareProject, ProjectError } from '../src/project.js';
import { Secrets } from '../src/secrets.js';
import { loadTemplates } from '../src/runner.js';
import { dirsFor, ensureDirs } from '../src/workspace.js';

const dir = mkdtempSync(path.join(tmpdir(), 'runner-project-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const sh = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 'Owner', GIT_AUTHOR_EMAIL: 'owner@example.com', GIT_COMMITTER_NAME: 'Owner', GIT_COMMITTER_EMAIL: 'owner@example.com' } }).trim();

/** A repository of video projects, the way a person keeps one: a folder per piece, each with its scene and assets. */
function videosRepo(name = 'videos') {
  const repo = path.join(dir, name);
  mkdirSync(path.join(repo, '2026-09-29-quarterly-taxes', 'telenovela', 'assets'), { recursive: true });
  writeFileSync(path.join(repo, 'drawn-by-code.json'), '{}\n');
  writeFileSync(path.join(repo, '2026-09-29-quarterly-taxes', 'telenovela', 'scene.js'), '// the scene\n');
  writeFileSync(path.join(repo, '2026-09-29-quarterly-taxes', 'telenovela', 'assets', 'logo.svg'), '<svg/>\n');
  symlinkSync('/etc', path.join(repo, 'escape')); // committed: a link that leads out of the repository
  sh(repo, 'init', '-q', '-b', 'main');
  sh(repo, 'add', '-A');
  sh(repo, 'commit', '-q', '-m', 'Projects');
  return repo;
}

const gitRepo = (repo: string, extra: Partial<GitRepo> = {}): GitRepo => ({
  key: 'videos', mode: 'git', repo, baseBranch: 'main', branch: 'studio/{{pieceId}}', author: { name: 'Studio agent', email: 'agent@studio.test' }, push: false, ...extra,
});
const SOURCE = 'videos:2026-09-29-quarterly-taxes/telenovela';

describe('a source', () => {
  const spec: ProjectSpec = { repos: { videos: gitRepo('/srv/videos'), scratch: { key: 'scratch', mode: 'dir', root: '/srv/scratch' } }, default: 'videos' };

  it('names a repository and a folder inside it, or a folder of the default one', () => {
    expect(parseSource(SOURCE, spec)).toMatchObject({ repo: { key: 'videos' }, subpath: '2026-09-29-quarterly-taxes/telenovela' });
    expect(parseSource('  scratch:./a//b/  ', spec)).toMatchObject({ repo: { key: 'scratch' }, subpath: 'a/b' });
    expect(parseSource('2026-09-29-quarterly-taxes/telenovela', spec)).toMatchObject({ repo: { key: 'videos' }, subpath: '2026-09-29-quarterly-taxes/telenovela' });
    expect(parseSource('videos:', spec)).toMatchObject({ subpath: '' }); // the whole repository is the project
  });

  it('can only lead inside: no absolute paths, no "..", no unknown repository, nothing that is not one line', () => {
    for (const [bad, why] of [
      ['videos:../other', /leads out/], ['videos:a/../../etc', /leads out/], ['videos:/etc', /absolute/], ['videos:\\etc', /absolute/],
      ['other:folder', /not one of this runner's project repositories/], ['scratch:', /names no folder/], ['scratch:.', /names no folder/],
      ['', /empty/], ['videos:a\nb', /one line/], [`videos:${'a'.repeat(500)}`, /one line/],
    ] as const) {
      expect(() => parseSource(bad, spec), bad).toThrow(ProjectError);
      expect(() => parseSource(bad, spec), bad).toThrow(why);
    }
    // Without a default and with several repositories, a source has to say which.
    expect(() => parseSource('folder', { repos: spec.repos })).toThrow(/does not say which repository/);
  });
});

describe('a project worked on in place (dir mode)', () => {
  const root = path.join(dir, 'projects');
  mkdirSync(path.join(root, 'client', 'promo'), { recursive: true });
  writeFileSync(path.join(root, 'client', 'not-a-folder'), 'x');
  mkdirSync(path.join(dir, 'outside'), { recursive: true });
  symlinkSync(path.join(dir, 'outside'), path.join(root, 'client', 'sneaky'));
  symlinkSync(path.join(root, 'client', 'promo'), path.join(root, 'client', 'alias'));
  const spec: ProjectSpec = { repos: { local: { key: 'local', mode: 'dir', root } }, default: 'local' };
  const dirs = dirsFor(path.join(dir, 'ws-dir'), 'lumen', 'piece-d', 'run-d');

  it('is the folder the source names', async () => {
    const p = await prepareProject({ spec, source: 'local:client/promo', dirs, brandKey: 'lumen', pieceId: 'piece-d' });
    expect(p).toMatchObject({ mode: 'dir', key: 'local', subpath: 'client/promo', dir: path.join(root, 'client', 'promo') });
    expect(p.worktree).toBeUndefined();
    // A link that stays inside is fine.
    expect((await prepareProject({ spec, source: 'client/alias', dirs, brandKey: 'lumen', pieceId: 'piece-d' })).dir).toBe(path.join(root, 'client', 'alias'));
  });

  it('is refused when it leads outside through a link, is missing, or is not a folder', async () => {
    const tryIt = (source: string) => prepareProject({ spec, source, dirs, brandKey: 'lumen', pieceId: 'piece-d' });
    await expect(tryIt('client/sneaky')).rejects.toThrow(/leads outside .* symbolic link/);
    await expect(tryIt('client/missing')).rejects.toThrow(/there is no folder "client\/missing"/);
    await expect(tryIt('client/not-a-folder')).rejects.toThrow(/is not a folder/);
    await expect(prepareProject({ spec: { repos: { local: { key: 'local', mode: 'dir', root: path.join(dir, 'nowhere') } } }, source: 'local:x', dirs, brandKey: 'lumen', pieceId: 'p' })).rejects.toThrow(/does not exist/);
  });
});

describe('a project in a git repository', () => {
  const repo = videosRepo();
  const spec: ProjectSpec = { repos: { videos: gitRepo(repo) } };
  const root = path.join(dir, 'ws-git');
  const prep = async (pieceId: string, source = SOURCE) => {
    const dirs = dirsFor(root, 'lumen', pieceId, `run-${Date.now()}`);
    await ensureDirs(dirs);
    return { dirs, project: await prepareProject({ spec, source, dirs, brandKey: 'lumen', pieceId }) };
  };

  it('gives each piece its own worktree, on its own branch from the base, inside the piece directory, and keeps it between rounds', async () => {
    const { dirs, project } = await prep('piece-1');
    expect(project).toMatchObject({ mode: 'git', branch: 'studio/piece-1', worktree: path.join(dirs.piece, 'project', 'videos'), subpath: '2026-09-29-quarterly-taxes/telenovela' });
    expect(project.dir).toBe(path.join(dirs.piece, 'project', 'videos', '2026-09-29-quarterly-taxes', 'telenovela'));
    expect(project.head).toBe(sh(repo, 'rev-parse', 'HEAD'));
    expect(readFileSync(path.join(project.dir, 'scene.js'), 'utf8')).toBe('// the scene\n');
    expect(sh(project.dir, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('studio/piece-1');
    // The clone lives with the brand, not in the piece, and nothing the runner keeps there holds a credential.
    expect(project.repoDir).toBe(path.join(dirs.brand, '_repos', 'videos.git'));
    expect(execFileSync('git', ['config', '--get', 'remote.origin.url'], { cwd: project.repoDir!, encoding: 'utf8' }).trim()).toBe(repo);
    // git refuses repositories of other users (a person's, mounted into the runner's container) unless a global configuration says so.
    expect(readFileSync(path.join(dirs.brand, '_repos', 'gitconfig'), 'utf8')).toMatch(/\[safe\]\n\tdirectory = \*/);

    // Work left in the worktree is still there the next round: it is the same worktree.
    writeFileSync(path.join(project.dir, 'note.txt'), 'from round 1');
    const again = await prep('piece-1');
    expect(again.project.worktree).toBe(project.worktree);
    expect(readFileSync(path.join(again.project.dir, 'note.txt'), 'utf8')).toBe('from round 1');

    // Another piece gets a worktree of its own.
    const other = await prep('piece-2');
    expect(other.project.branch).toBe('studio/piece-2');
    expect(existsSync(path.join(other.project.dir, 'note.txt'))).toBe(false);
  });

  it('commits what changed, as the configured author, with the message it is given, and only that piece\'s branch moves', async () => {
    const { dirs, project } = await prep('piece-3');
    writeFileSync(path.join(project.dir, 'scene.js'), '// the scene, with the logo in the corner\n');
    writeFileSync(path.join(project.dir, 'assets', 'shadow.svg'), '<svg/>\n');
    const message = 'Studio round 1: Quarterly taxes\n\nComments:\n- c1: fixed\n\nStudio-Piece: piece-3\nStudio-Comment: c1\n';
    const r = await commitProject(project, gitRepo(repo), { message, secrets: new Secrets([]), dirs });
    expect(r).toMatchObject({ commit: expect.stringMatching(/^[0-9a-f]{40}$/), changedFiles: 2 });
    const wt = project.worktree!;
    expect(sh(wt, 'log', '-1', '--format=%H')).toBe(r.commit);
    expect(sh(wt, 'log', '-1', '--format=%an <%ae>|%cn')).toBe('Studio agent <agent@studio.test>|Studio agent');
    expect(sh(wt, 'log', '-1', '--format=%B')).toBe(message.trim());
    expect(sh(wt, 'log', '-1', '--format=%(trailers:key=Studio-Comment,valueonly)')).toBe('c1');
    expect(sh(wt, 'show', '--name-only', '--format=', 'HEAD').split('\n').sort()).toEqual(['2026-09-29-quarterly-taxes/telenovela/assets/shadow.svg', '2026-09-29-quarterly-taxes/telenovela/scene.js']);
    expect(sh(wt, 'status', '--porcelain')).toBe('');
    // The person's repository is not touched: the commit is on the piece's branch in the runner's clone.
    expect(sh(repo, 'branch', '--list')).toBe('* main');

    // Nothing changed: nothing to commit.
    const again = await commitProject({ ...project, head: r.commit! }, gitRepo(repo), { message, secrets: new Secrets([]), dirs });
    expect(again).toEqual({ commit: null, changedFiles: 0 });
  });

  it('commits nothing, and throws the changes away, when a secret of the runner is in them', async () => {
    const { dirs, project } = await prep('piece-4');
    const secrets = new Secrets([{ label: 'lumen: studio token', value: 'est_TheStudioTokenOfLumen0123456789' }]);
    writeFileSync(path.join(project.dir, 'scene.js'), '// est_TheStudioTokenOfLumen0123456789\n');
    writeFileSync(path.join(project.dir, 'new-file.txt'), 'harmless');
    const r = await commitProject(project, gitRepo(repo), { message: 'x', secrets, dirs });
    expect(r).toMatchObject({ commit: null, leaked: ['lumen: studio token'] });
    expect(sh(project.worktree!, 'rev-parse', 'HEAD')).toBe(project.head);
    expect(readFileSync(path.join(project.dir, 'scene.js'), 'utf8')).toBe('// the scene\n');
    expect(existsSync(path.join(project.dir, 'new-file.txt'))).toBe(false);
  });

  it('pushes the piece\'s branch when told to', async () => {
    const remote = path.join(dir, 'remote.git');
    execFileSync('git', ['clone', '-q', '--bare', repo, remote]);
    const pushing: ProjectSpec = { repos: { videos: gitRepo(remote, { push: true }) } };
    const dirs = dirsFor(path.join(dir, 'ws-push'), 'lumen', 'piece-5', 'run-5');
    await ensureDirs(dirs);
    const project = await prepareProject({ spec: pushing, source: SOURCE, dirs, brandKey: 'lumen', pieceId: 'piece-5' });
    writeFileSync(path.join(project.dir, 'scene.js'), '// pushed\n');
    const r = await commitProject(project, pushing.repos.videos as GitRepo, { message: 'Studio round 1: pushed\n', secrets: new Secrets([]), dirs });
    expect(r).toMatchObject({ pushed: true });
    expect(sh(remote, 'rev-parse', 'refs/heads/studio/piece-5')).toBe(r.commit);
    // A push that is refused is said, and the commit stays.
    rmSync(remote, { recursive: true, force: true });
    writeFileSync(path.join(project.dir, 'scene.js'), '// not pushed\n');
    const r2 = await commitProject({ ...project, head: r.commit! }, pushing.repos.videos as GitRepo, { message: 'Studio round 2: not pushed\n', secrets: new Secrets([]), dirs });
    expect(r2).toMatchObject({ commit: expect.stringMatching(/^[0-9a-f]{40}$/), pushed: false, pushError: expect.stringContaining('git push failed') });
  });

  it('refuses a folder that leads out of the repository through a committed link, a missing one, and a missing base branch', async () => {
    await expect(prep('piece-6', 'videos:escape')).rejects.toThrow(/leads outside .* symbolic link/);
    await expect(prep('piece-7', 'videos:2026-09-29-quarterly-taxes/missing')).rejects.toThrow(/there is no folder/);
    const noBase: ProjectSpec = { repos: { videos: gitRepo(repo, { baseBranch: 'develop' }) } };
    const dirs = dirsFor(path.join(dir, 'ws-nobase'), 'lumen', 'piece-8', 'run-8');
    await ensureDirs(dirs);
    await expect(prepareProject({ spec: noBase, source: SOURCE, dirs, brandKey: 'lumen', pieceId: 'piece-8' })).rejects.toThrow(/no branch develop to start from/);
  });

  it('refuses a worktree that is no longer on its piece\'s branch, rather than commit somewhere else', async () => {
    const { dirs, project } = await prep('piece-9');
    sh(project.worktree!, 'checkout', '-q', '--detach');
    await expect(prep('piece-9')).rejects.toThrow(/not on its branch studio\/piece-9/);
    await expect(commitProject(project, gitRepo(repo), { message: 'x', secrets: new Secrets([]), dirs })).rejects.toThrow(/not on studio\/piece-9/);
  });

  it('ignores a .git file the agent rewrote: the runner names the repository itself, and runs none of its hooks', async () => {
    const { dirs, project } = await prep('piece-10');
    // A repository of the agent's making, with a hook that would run as the runner.
    const evil = path.join(dir, 'evil');
    execFileSync('git', ['init', '-q', evil]);
    const marker = path.join(dir, 'hook-ran');
    writeFileSync(path.join(evil, '.git', 'hooks', 'pre-commit'), `#!/bin/sh\ntouch ${marker}\n`);
    chmodSync(path.join(evil, '.git', 'hooks', 'pre-commit'), 0o755);
    writeFileSync(path.join(project.worktree!, '.git'), `gitdir: ${path.join(evil, '.git')}\n`);
    writeFileSync(path.join(project.dir, 'scene.js'), '// changed\n');
    const r = await commitProject(project, gitRepo(repo), { message: 'Studio round 1\n', secrets: new Secrets([]), dirs });
    expect(r.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(existsSync(marker)).toBe(false);
    expect(sh(project.repoDir!, 'rev-parse', 'refs/heads/studio/piece-10')).toBe(r.commit);
  });
});

describe('one agent at a time in a project', () => {
  it('makes the second wait until the first is done', async () => {
    const order: string[] = [];
    const first = await acquire('project:/x');
    const second = acquire('project:/x').then((release) => {
      order.push('second');
      release();
    });
    await new Promise((r) => setTimeout(r, 30));
    order.push('first done');
    first();
    await second;
    expect(order).toEqual(['first done', 'second']);
    (await acquire('project:/x'))(); // free again
  });
});

describe('how the agent is shown its project', () => {
  const dirs = dirsFor('/var/lib/runner', 'lumen', 'piece-1', 'run-1');
  const run = { brand: 'lumen', runId: 'run-1', pieceId: 'piece-1', maxMinutes: '30' };
  const base = { input: 'stdin' as const, env: { HOME: '/home/agent' }, cost: { from: 'result' as const }, killGraceSeconds: 10 };
  const command = ['claude', { if: 'projectDir', args: ['--add-dir', '{{projectDir}}', 'Edit(/{{projectDir}}/**)'] }];

  it('without a project, as before: no flag, no variable', () => {
    const p = planAgent({ ...base, command }, dirs, run, {});
    expect(p.command).toEqual(['claude']);
    expect(p.env.ESTUDIO_PROJECT_DIR).toBeUndefined();
  });

  it('a git worktree is inside the piece directory, so a sandbox that mounts the piece elsewhere shows it there too', () => {
    const worktree = '/var/lib/runner/lumen/piece-1/project/videos/2026-09-29-quarterly-taxes/telenovela';
    const sandbox = {
      command: ['bwrap', '--bind', '{{pieceDir}}', '/work', { if: 'projectMount', args: ['--bind', '{{projectMount}}', '{{agentProjectDir}}'] }, { if: 'projectRepo', args: ['--ro-bind', '{{projectRepo}}', '{{projectRepo}}'] }, '--chdir', '{{agentRunDir}}', '--'],
      pieceDir: '/work',
    };
    const p = planAgent({ ...base, command, sandbox }, dirs, { ...run, project: { dir: worktree, repoDir: '/var/lib/runner/lumen/_repos/videos.git' } }, {});
    expect(p.command).toEqual([
      'bwrap', '--bind', '/var/lib/runner/lumen/piece-1', '/work', '--ro-bind', '/var/lib/runner/lumen/_repos/videos.git', '/var/lib/runner/lumen/_repos/videos.git', '--chdir', '/work/runs/run-1', '--',
      'claude', '--add-dir', '/work/project/videos/2026-09-29-quarterly-taxes/telenovela', 'Edit(//work/project/videos/2026-09-29-quarterly-taxes/telenovela/**)',
    ]);
    expect(p.env.ESTUDIO_PROJECT_DIR).toBe('/work/project/videos/2026-09-29-quarterly-taxes/telenovela');
  });

  it('a folder worked on in place is outside it: mounted on its own, where sandbox.projectDir says', () => {
    const sandbox = {
      command: ['docker', 'run', '-v', '{{pieceDir}}:/work', { if: 'projectMount', args: ['-v', '{{projectMount}}:{{agentProjectDir}}'] }, 'img'],
      pieceDir: '/work', projectDir: '/project',
    };
    const p = planAgent({ ...base, command, sandbox }, dirs, { ...run, project: { dir: '/srv/projects/client/promo' } }, {});
    expect(p.command).toEqual(['docker', 'run', '-v', '/var/lib/runner/lumen/piece-1:/work', '-v', '/srv/projects/client/promo:/project', 'img', 'claude', '--add-dir', '/project', 'Edit(//project/**)']);
    expect(p.env.ESTUDIO_PROJECT_DIR).toBe('/project');
    // Without a sandbox, it is where it is.
    const plain = planAgent({ ...base, command }, dirs, { ...run, project: { dir: '/srv/projects/client/promo' } }, {});
    expect(plain.command).toEqual(['claude', '--add-dir', '/srv/projects/client/promo', 'Edit(//srv/projects/client/promo/**)']);
    expect(plain.env.ESTUDIO_PROJECT_DIR).toBe('/srv/projects/client/promo');
  });
});

describe('the project configuration', () => {
  const TOKEN = 'est_TheStudioTokenOfLumen0123456789';
  const SECRET = 'whsec_TheWebhookSecretOfLumen0123';
  const parse = (project: unknown) =>
    parseConfig({ workspaceRoot: path.join(dir, 'work'), brands: { lumen: { api: 'https://studio.example', token: TOKEN, webhookSecret: SECRET, agent: { command: ['x'], sandbox: { command: ['bwrap', '--'] } }, project } } }, dir, {}, { uid: 1000 });

  it('fills in what is left out, resolves paths against the configuration, and has a default when there is one place', () => {
    const c = parse({ repos: { videos: { mode: 'git', repo: 'repos/videos' }, remote: { mode: 'git', repo: 'git@github.com:acme/videos.git' }, web: { mode: 'git', repo: 'https://github.com/acme/videos.git' } }, default: 'videos', template: 'templates/project.md' });
    expect(c.brands.lumen!.project).toMatchObject({
      default: 'videos', template: 'templates/project.md',
      repos: {
        videos: { mode: 'git', repo: path.join(dir, 'repos/videos'), baseBranch: 'main', branch: 'studio/{{pieceId}}', author: { name: 'Studio agent' }, push: false },
        remote: { repo: 'git@github.com:acme/videos.git' },
        web: { repo: 'https://github.com/acme/videos.git' },
      },
    });
    expect(parse({ repos: { local: { mode: 'dir', root: 'projects' } } }).brands.lumen!.project).toEqual({ repos: { local: { key: 'local', mode: 'dir', root: path.join(dir, 'projects') } }, default: 'local', template: undefined });
  });

  it('reads a push token from a file only its owner can read, and keeps it among the secrets never posted', () => {
    const f = path.join(dir, 'git.token');
    writeFileSync(f, 'ghp_AGitTokenThatMustNeverBePosted\n');
    chmodSync(f, 0o600);
    const c = parse({ repos: { videos: { mode: 'git', repo: 'https://github.com/acme/videos.git', push: true, auth: { tokenFile: f } } } });
    expect((c.brands.lumen!.project!.repos.videos as GitRepo).auth).toEqual({ token: 'ghp_AGitTokenThatMustNeverBePosted', username: 'x-access-token' });
    expect(c.secrets.foundIn('x ghp_AGitTokenThatMustNeverBePosted')).toEqual(['lumen: project.repos.videos token']);
    chmodSync(f, 0o644);
    expect(() => parse({ repos: { videos: { mode: 'git', repo: 'x', auth: { tokenFile: f } } } })).toThrow(/chmod 600/);
  });

  it('refuses what cannot work, and warns about a password in an address', () => {
    expect(() => parse({ repos: {} })).toThrow(/at least one/);
    expect(() => parse({ repos: { 'bad key': { mode: 'dir', root: '/x' } } })).toThrow(/not a valid key/);
    expect(() => parse({ repos: { a: { mode: 'dir', root: '/x' } }, default: 'b' })).toThrow(/project\.default is "b"/);
    expect(() => parse({ repos: { a: { mode: 'git', repo: '/x', branch: 'studio/all' } } })).toThrow(/must hold \{\{pieceId\}\}/);
    expect(() => parse({ repos: { a: { mode: 'git', repo: '/x', branch: 'studio/{{title}}-{{pieceId}}' } } })).toThrow(/\{\{title\}\}/);
    expect(() => parse({ repos: { a: { mode: 'ftp', root: '/x' } } })).toThrow(/Invalid configuration/);
    expect(parse({ repos: { a: { mode: 'git', repo: 'https://bob:hunter2@git.example/videos.git' } } }).warnings.join('\n')).toMatch(/password in its address/);
  });
});

describe('the example configuration for a code-driven brand', () => {
  it('is valid, its templates load, and its command gives Claude Code the project only when the piece has one', () => {
    const example = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'examples', 'drawn-by-code.config.json');
    const templates = path.join(path.dirname(example), '..', 'templates');
    // Where the image keeps things, mapped to this checkout; the secrets, to files of this test.
    const secret = (name: string) => {
      const f = path.join(dir, `example-${name}`);
      writeFileSync(f, `${name}-0123456789abcdef`);
      chmodSync(f, 0o600);
      return f;
    };
    const text = readFileSync(example, 'utf8')
      .replaceAll('/opt/studio/apps/runner/templates', templates)
      .replace('/run/secrets/lumen.token', secret('token'))
      .replace('/run/secrets/lumen.webhook-secret', secret('webhook'))
      .replace('/run/secrets/claude-oauth-token', secret('claude'));
    const c = parseConfig(JSON.parse(text), dir, {}, { uid: 0 });
    expect(c.warnings).toEqual([]);
    const brand = c.brands.lumen!;
    expect(brand.project?.repos.videos).toMatchObject({ mode: 'git', repo: '/srv/projects/videos', push: false });
    expect(brand.agent.env.CLAUDE_CODE_OAUTH_TOKEN).toBe('claude-0123456789abcdef');
    expect(c.secrets.foundIn('x claude-0123456789abcdef')).toEqual(['lumen: agent.env.CLAUDE_CODE_OAUTH_TOKEN']);
    expect([...loadTemplates(c).keys()].sort()).toEqual(['lumen:project', 'lumen:version.changes_requested']);

    const vars = { pieceDir: '/w/p', outputDir: '/w/p/runs/r/output', sourcesDir: '/w/p/sources', maxBudget: '2' };
    const without = buildCommand(brand.agent.command, vars);
    expect(without.join(' ')).not.toContain('projectDir');
    const withProject = buildCommand(brand.agent.command, { ...vars, projectDir: '/w/p/project/videos/a' });
    expect(withProject).toEqual(expect.arrayContaining(['--add-dir', '/w/p/project/videos/a', 'Edit(//w/p/project/videos/a/**)', 'Bash(node /opt/drawn-by-code/engine/render.mjs:*)']));
    // Every --add-dir comes before the list of allowed tools, which takes everything after it.
    expect(withProject.lastIndexOf('--add-dir')).toBeLessThan(withProject.indexOf('--allowedTools'));
  });
});
