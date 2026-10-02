import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chmod, chown, lchown, lstat, mkdir, readdir, readFile, realpath, rename, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { GitRepo, ProjectRepo, ProjectSpec } from './config.js';
import type { Secrets } from './secrets.js';
import type { Access, Dirs } from './workspace.js';

/**
 * Pieces made from a project. A piece's `source` (set in the studio) says where the code and material it is made from live:
 * "<key>:<path>", where the key is one of the brand's `project.repos` and the path a folder inside it ("videos:2026-09-29-taxes/telenovela"),
 * or just "<path>" for the brand's default. The runner turns it into the directory the agent works in:
 *
 * - `git`: the runner keeps a clone of the repository (bare, under the brand's directory) and gives each piece its own worktree, on its
 *   own branch, inside the piece's directory (so whatever shows the piece directory to the agent shows the project too). The worktree is
 *   kept between the piece's rounds. After the agent runs, the runner commits what changed, and pushes if told to.
 * - `dir`: the project's folder, worked on in place.
 *
 * A source is never trusted: it must name a configured key, its path must stay inside the repository or directory (no absolute paths,
 * no "..", and no symbolic link leading out of it), and it must be a folder.
 */

/** A source that cannot be turned into a project directory, said in words a person can act on. */
export class ProjectError extends Error {}

/** What a run knows about its piece's project. Kept with the queue item, so a restart carries on with it. */
export interface Project {
  source: string;
  key: string;
  mode: 'git' | 'dir';
  /** The folder inside the repository or directory ('' for the whole repository). */
  subpath: string;
  /** The directory the agent works in, as the runner sees it. */
  dir: string;
  /** git: the piece's worktree, its branch and the clone it belongs to. */
  worktree?: string;
  branch?: string;
  repoDir?: string;
  /** git: the commit the agent started from. */
  head?: string;
  /** git: what the runner committed after the agent ran. */
  commit?: string | null;
  changedFiles?: number;
  pushed?: boolean;
  pushError?: string;
  commitError?: string;
}

const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;
const KEYED = /^([A-Za-z0-9][A-Za-z0-9_-]*):(.*)$/s;

/** Splits a source into the repository it names and the path inside it, and checks the path can only lead inside. */
export function parseSource(source: string, spec: ProjectSpec): { repo: ProjectRepo; subpath: string } {
  const s = source.trim();
  if (!s) throw new ProjectError('the source is empty');
  if (s.length > 500 || CONTROL.test(s)) throw new ProjectError('the source is not one line of text');
  let key: string | undefined;
  let rest = s;
  const m = KEYED.exec(s);
  if (m) {
    key = m[1]!;
    rest = m[2]!;
    if (!spec.repos[key]) throw new ProjectError(`"${key}" is not one of this runner's project repositories (${Object.keys(spec.repos).join(', ')})`);
  } else {
    key = spec.default;
    if (!key) throw new ProjectError(`the source does not say which repository it is in: write it as "<${Object.keys(spec.repos).join('|')}>:<folder>"`);
  }
  const repo = spec.repos[key]!;
  if (rest.startsWith('/') || rest.startsWith('\\') || /^[A-Za-z]:[\\/]/.test(rest)) throw new ProjectError(`"${rest}" is an absolute path: a source is a folder inside the repository`);
  const parts = rest.split('/').filter((x) => x !== '' && x !== '.');
  if (parts.includes('..')) throw new ProjectError(`"${rest}" leads out of the repository ("..")`);
  if (repo.mode === 'dir' && parts.length === 0) throw new ProjectError(`the source names no folder inside ${repo.root}`);
  return { repo, subpath: parts.join('/') };
}

/** The real path of `rel` under `root`, which must be a directory that stays inside it, symbolic links included. */
async function folderInside(root: string, rel: string, what: string): Promise<string> {
  const realRoot = await realpath(root);
  let real: string;
  try {
    real = await realpath(path.join(realRoot, rel));
  } catch {
    throw new ProjectError(`there is no folder "${rel}" in ${what}`);
  }
  if (real !== realRoot && !real.startsWith(realRoot + path.sep)) throw new ProjectError(`"${rel}" leads outside ${what} (through a symbolic link)`);
  if (!(await stat(real)).isDirectory()) throw new ProjectError(`"${rel}" in ${what} is not a folder`);
  return real;
}

// ───────────────────────────── one thing at a time ─────────────────────────────

const held = new Map<string, Promise<void>>();

/** Waits for whatever holds `key` in this process, then holds it until the returned function is called. */
export async function acquire(key: string): Promise<() => void> {
  const before = held.get(key) ?? Promise.resolve();
  let release!: () => void;
  const mine = new Promise<void>((r) => (release = r));
  const chained = before.then(() => mine);
  held.set(key, chained);
  await before;
  return () => {
    release();
    if (held.get(key) === chained) held.delete(key);
  };
}

async function locked<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const release = await acquire(key);
  try {
    return await fn();
  } finally {
    release();
  }
}

// ───────────────────────────── git ─────────────────────────────

/** What git says, without any password an address carries. */
const scrub = (s: string) => s.replace(/(\b[a-z][a-z0-9+.-]*:\/\/)[^/@\s]+@/gi, '$1***@');

export interface GitOptions {
  /** The repository (--git-dir): always given, so a `.git` file the agent could have rewritten is never followed. */
  gitDir: string;
  workTree?: string;
  auth?: GitRepo['auth'];
  /** For SSH without a known_hosts file of the configuration's: where the server's key is remembered. */
  knownHosts?: string;
  input?: string;
  timeoutMs?: number;
  env?: Record<string, string>;
  /** A global configuration file for this git (see gitConfigFor). */
  globalConfig?: string;
}

/**
 * Runs git as the runner. Hooks and the file-system monitor are off, and the repository is named explicitly: the agent can change
 * every file of the worktree, so nothing in it may make git run a program for the runner. Credentials go in git's environment only,
 * never in its arguments (which any user can read) or in the repository's configuration (which the agent may read).
 */
export function git(args: string[], o: GitOptions): Promise<string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !/^GIT_|ASKPASS$/.test(k)) env[k] = v;
  Object.assign(env, { GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' }, o.globalConfig ? { GIT_CONFIG_GLOBAL: o.globalConfig } : {}, o.env ?? {});
  if (o.auth?.token) {
    const basic = Buffer.from(`${o.auth.username}:${o.auth.token}`).toString('base64');
    Object.assign(env, { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'http.extraHeader', GIT_CONFIG_VALUE_0: `Authorization: Basic ${basic}` });
  }
  if (o.auth?.sshKeyFile) {
    const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
    const known = o.auth.knownHostsFile ?? o.knownHosts;
    env.GIT_SSH_COMMAND = [
      'ssh', '-i', q(o.auth.sshKeyFile), '-o', 'IdentitiesOnly=yes', '-o', 'BatchMode=yes',
      ...(known ? ['-o', `UserKnownHostsFile=${q(known)}`] : []),
      '-o', `StrictHostKeyChecking=${o.auth.knownHostsFile ? 'yes' : 'accept-new'}`,
    ].join(' ');
  }
  const full = [
    '-c', 'safe.directory=*', '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'commit.gpgsign=false', '-c', 'core.quotePath=false',
    `--git-dir=${o.gitDir}`, ...(o.workTree ? [`--work-tree=${o.workTree}`] : []), ...args,
  ];
  return new Promise((resolve, reject) => {
    const child = execFile('git', full, { env, cwd: o.workTree ?? o.gitDir, timeout: o.timeoutMs ?? 120_000, maxBuffer: 16 * 1024 * 1024, encoding: 'utf8' }, (err, stdout, stderr) => {
      if (err) {
        const lines = (stderr || err.message).trim().split('\n');
        const fatal = lines.filter((l) => /^(fatal|error):/.test(l));
        const why = (fatal.length ? fatal : lines.slice(-3)).join(' ');
        reject(new Error(`git ${args[0]} failed: ${scrub(why)}`));
      } else resolve(stdout);
    });
    // git may exit without reading its input (most commands do): that is not an error.
    child.stdin?.on('error', () => {});
    child.stdin?.end(o.input ?? '');
  });
}

const gitOk = (args: string[], o: GitOptions) => git(args, o).then(() => true, () => false);

const GLOBAL_CONFIG = `# Written by the studio runner for the git it runs. Repositories here belong to other users (the agent's worktrees, a person's
# repository it fetches from), which git refuses to work in unless told otherwise, and only in a global configuration such as this
# one (before git 2.40, "-c safe.directory" is not enough). The runner's user's own configuration still applies.
[safe]
	directory = *
[include]
	path = ~/.gitconfig
	path = ~/.config/git/config
`;

/** The global configuration file the runner's git uses, written once per brand. */
async function gitConfigFor(dirs: Dirs, access: Access): Promise<string> {
  const file = path.join(dirs.brand, '_repos', 'gitconfig');
  await runnerDir(path.dirname(file), access);
  const now = await readFile(file, 'utf8').catch(() => '');
  if (now !== GLOBAL_CONFIG) await writeFile(file, GLOBAL_CONFIG, { mode: 0o644 });
  return file;
}

/**
 * After a push into a repository on this machine that belongs to someone else (the person's own, mounted into a container where the
 * runner is root), what git just wrote there is given to that repository's owner: otherwise the owner could no longer write in the
 * directories git made, and their next commit could fail. Files of any third user are left alone.
 */
async function giveBackPushed(repo: string): Promise<void> {
  const me = process.getuid?.();
  if (me === undefined || !path.isAbsolute(repo)) return;
  let gitDir = path.join(repo, '.git');
  if (!(await stat(gitDir).then((st) => st.isDirectory(), () => false))) gitDir = repo;
  const owner = await stat(gitDir).catch(() => null);
  if (!owner || owner.uid === me) return;
  const walk = async (p: string): Promise<void> => {
    const st = await lstat(p).catch(() => null);
    if (!st) return;
    if (st.uid === me) await lchown(p, owner.uid, owner.gid);
    if (st.isDirectory()) for (const name of await readdir(p)) await walk(path.join(p, name));
  };
  for (const part of ['objects', 'refs', 'logs', 'packed-refs', 'FETCH_HEAD']) await walk(path.join(gitDir, part));
}

/** Where the brand's clone of a repository is kept. */
export const repoDirOf = (dirs: Dirs, key: string) => path.join(dirs.brand, '_repos', `${key}.git`);
/** Where a piece's worktree of a repository is. */
export const worktreeOf = (dirs: Dirs, key: string) => path.join(dirs.piece, 'project', key);

/** The piece's branch, as the configuration names it. */
export function branchName(repo: GitRepo, run: { pieceId: string; brand: string }): string {
  return repo.branch.replace(/\{\{\s*(pieceId|brand)\s*\}\}/g, (_m, k: 'pieceId' | 'brand') => run[k]);
}

/**
 * The administrative directory git keeps for a worktree (`<clone>/worktrees/<name>`), found from the clone's own records rather than
 * from the worktree's `.git` file, which is the agent's to change.
 */
async function adminDirOf(repoDir: string, worktree: string): Promise<string | null> {
  const base = path.join(repoDir, 'worktrees');
  if (!existsSync(base)) return null;
  const wanted = new Set([path.join(worktree, '.git')]);
  try {
    wanted.add(path.join(await realpath(worktree), '.git'));
  } catch {
    /* not there */
  }
  for (const name of await readdir(base)) {
    try {
      const target = (await readFile(path.join(base, name, 'gitdir'), 'utf8')).trim();
      if (wanted.has(target)) return path.join(base, name);
    } catch {
      /* not a worktree's record */
    }
  }
  return null;
}

/**
 * A directory of the runner's that the agent may read but not change: with agent.runAs the agent's group can look in (to run `git status`
 * in its worktree, say), as with the rest of the piece's directory; without it, nobody else.
 */
async function runnerDir(dir: string, access: Access): Promise<void> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  if (access.runAs) await chown(dir, process.getuid!(), access.runAs.gid);
  await chmod(dir, access.runAs ? 0o750 : 0o700);
}

/** Makes every file of a worktree the agent's own (with agent.runAs), without following links. */
async function giveToAgent(dir: string, access: Access): Promise<void> {
  const ids = access.runAs;
  if (!ids) return;
  const walk = async (p: string): Promise<void> => {
    const st = await lstat(p);
    if (st.uid !== ids.uid || st.gid !== ids.gid) await lchown(p, ids.uid, ids.gid);
    if (st.isDirectory()) for (const name of await readdir(p)) await walk(path.join(p, name));
  };
  await walk(dir);
}

export interface PrepareOptions {
  spec: ProjectSpec;
  source: string;
  dirs: Dirs;
  brandKey: string;
  pieceId: string;
  access?: Access;
}

/** Resolves a piece's source to the directory its agent works in: in git mode, the piece's own worktree, made or reused. */
export async function prepareProject(o: PrepareOptions): Promise<Project> {
  const { repo, subpath } = parseSource(o.source, o.spec);
  const source = o.source.trim();
  if (repo.mode === 'dir') {
    if (!existsSync(repo.root)) throw new ProjectError(`the project directory ${repo.root} does not exist on the runner's machine`);
    await folderInside(repo.root, subpath, `the "${repo.key}" directory`);
    // The path as configured (it was just checked to lead inside), so that what the sandbox mounts is what the configuration says.
    return { source, key: repo.key, mode: 'dir', subpath, dir: path.join(repo.root, subpath) };
  }

  const repoDir = repoDirOf(o.dirs, repo.key);
  const worktree = worktreeOf(o.dirs, repo.key);
  const branch = branchName(repo, { pieceId: o.pieceId, brand: o.brandKey });
  const knownHosts = path.join(o.dirs.brand, '_repos', 'known_hosts');
  const access = o.access ?? {};
  const globalConfig = await gitConfigFor(o.dirs, access);
  const g = { gitDir: repoDir, auth: repo.auth, knownHosts, globalConfig };

  const adminDir = await locked(repoDir, async () => {
    await runnerDir(repoDir, access);
    if (!existsSync(path.join(repoDir, 'HEAD'))) {
      await git(['init', '--bare', '--quiet'], g);
      await git(['remote', 'add', 'origin', repo.repo], g);
    } else {
      await git(['remote', 'set-url', 'origin', repo.repo], g);
    }
    try {
      await git(['check-ref-format', '--branch', branch], g);
    } catch {
      throw new ProjectError(`"${branch}" is not a valid branch name (project.repos.${repo.key}.branch)`);
    }

    let admin = existsSync(worktree) ? await adminDirOf(repoDir, worktree) : null;
    if (existsSync(worktree) && !admin) {
      // A folder git does not know as a worktree (its clone was removed, say): kept aside, not deleted, and made again.
      await rename(worktree, `${worktree}.orphaned-${Date.now()}`);
    }
    if (!admin) {
      await git(['worktree', 'prune'], g);
      await git(['fetch', '--quiet', '--prune', 'origin'], { ...g, timeoutMs: 15 * 60_000 });
      await runnerDir(path.dirname(worktree), access);
      if (await gitOk(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], g)) {
        await git(['worktree', 'add', '--quiet', worktree, branch], g);
      } else if (await gitOk(['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${branch}`], g)) {
        await git(['worktree', 'add', '--quiet', '--no-track', '-b', branch, worktree, `origin/${branch}`], g);
      } else if (await gitOk(['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${repo.baseBranch}`], g)) {
        await git(['worktree', 'add', '--quiet', '--no-track', '-b', branch, worktree, `origin/${repo.baseBranch}`], g);
      } else {
        throw new ProjectError(`the repository "${repo.key}" has no branch ${repo.baseBranch} to start from`);
      }
      admin = await adminDirOf(repoDir, worktree);
      if (!admin) throw new ProjectError('git made the worktree but it cannot be found in the repository');
    }
    return admin;
  });

  const w = { gitDir: adminDir, workTree: worktree, globalConfig };
  const on = (await git(['symbolic-ref', '--quiet', 'HEAD'], w).catch(() => '')).trim();
  if (on !== `refs/heads/${branch}`) throw new ProjectError(`the piece's worktree is not on its branch ${branch} any more (${on || 'detached'}): a person has to look at ${worktree}`);
  await giveToAgent(worktree, access);
  await folderInside(worktree, subpath, `the "${repo.key}" repository on ${branch}`);
  const head = (await git(['rev-parse', 'HEAD'], w)).trim();
  return { source, key: repo.key, mode: 'git', subpath, dir: path.join(worktree, subpath), worktree, branch, repoDir, head };
}

export interface CommitResult {
  commit: string | null;
  changedFiles: number;
  pushed?: boolean;
  pushError?: string;
  /** Labels of the runner's secrets found in what changed: then nothing was committed, and the changes were thrown away. */
  leaked?: string[];
}

/**
 * Commits everything that changed in the piece's worktree since the agent started, as the configured author, and pushes the piece's
 * branch if told to. Before anything is committed, every changed file is searched for the runner's secrets: a project is shared (and
 * maybe pushed), so a secret the agent was made to write into it must not stay there.
 */
export async function commitProject(project: Project, repo: GitRepo, o: { message: string; secrets: Secrets; dirs: Dirs }): Promise<CommitResult> {
  if (project.mode !== 'git' || !project.worktree || !project.repoDir || !project.branch) throw new Error('not a git project');
  const knownHosts = path.join(o.dirs.brand, '_repos', 'known_hosts');
  const globalConfig = path.join(o.dirs.brand, '_repos', 'gitconfig');
  return locked(project.repoDir, async () => {
    const adminDir = await adminDirOf(project.repoDir!, project.worktree!);
    if (!adminDir) throw new Error(`the worktree ${project.worktree} is no longer one of the repository's`);
    const w = { gitDir: adminDir, workTree: project.worktree!, globalConfig };
    const on = (await git(['symbolic-ref', '--quiet', 'HEAD'], w).catch(() => '')).trim();
    if (on !== `refs/heads/${project.branch}`) throw new Error(`the worktree is not on ${project.branch} any more (${on || 'detached'}), so nothing was committed`);

    await git(['add', '--all'], w);
    const since = project.head ?? 'HEAD';
    const changed = (await git(['diff', '--cached', '--name-only', '-z', since], w)).split('\0').filter(Boolean);
    const leaked = new Set<string>();
    for (const rel of changed) {
      const file = path.join(project.worktree!, rel);
      try {
        if ((await lstat(file)).isFile()) for (const label of await o.secrets.foundInFile(file)) leaked.add(label);
      } catch {
        /* deleted */
      }
    }
    if (leaked.size) {
      // Nothing of it is kept: the worktree goes back to where the agent started.
      await git(['reset', '--quiet', '--hard', since], w);
      await git(['clean', '--quiet', '-d', '--force'], w);
      return { commit: null, changedFiles: changed.length, leaked: [...leaked] };
    }
    const staged = !(await gitOk(['diff', '--cached', '--quiet'], w));
    if (!staged) {
      const head = (await git(['rev-parse', 'HEAD'], w)).trim();
      // The agent may have committed on its own: then that is the commit, with nothing more to add.
      return { commit: head === since ? null : head, changedFiles: changed.length };
    }
    const a = repo.author;
    await git(['commit', '--quiet', '--no-verify', '--file=-'], {
      ...w, input: o.message,
      env: { GIT_AUTHOR_NAME: a.name, GIT_AUTHOR_EMAIL: a.email, GIT_COMMITTER_NAME: a.name, GIT_COMMITTER_EMAIL: a.email },
    });
    const commit = (await git(['rev-parse', 'HEAD'], w)).trim();
    if (!repo.push) return { commit, changedFiles: changed.length };
    try {
      await git(['push', '--quiet', 'origin', `refs/heads/${project.branch}:refs/heads/${project.branch}`], { gitDir: project.repoDir!, auth: repo.auth, knownHosts, globalConfig, timeoutMs: 10 * 60_000 });
      await giveBackPushed(repo.repo).catch(() => {});
      return { commit, changedFiles: changed.length, pushed: true };
    } catch (err) {
      return { commit, changedFiles: changed.length, pushed: false, pushError: (err as Error).message };
    }
  });
}
