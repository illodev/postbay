import { spawn } from 'node:child_process';
import { constants, createWriteStream } from 'node:fs';
import path from 'node:path';
import type { AgentSpec, ArgSpec, CostSpec } from './config.js';
import type { Dirs } from './workspace.js';

/** Fills {{placeholders}} in the command, and drops the optional arguments whose value does not exist. */
export function buildCommand(spec: ArgSpec[], vars: Record<string, string | undefined>): string[] {
  const fill = (s: string) =>
    s.replace(/\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g, (_m, name: string) => {
      const v = vars[name];
      if (v === undefined) throw new Error(`The agent command uses {{${name}}}, which has no value here`);
      return v;
    });
  const out: string[] = [];
  for (const a of spec) {
    if (typeof a === 'string') out.push(fill(a));
    else if (vars[a.if] !== undefined && vars[a.if] !== '') out.push(...a.args.map(fill));
  }
  return out;
}

const path_ = (o: unknown, p: string): unknown => p.split('.').reduce<unknown>((acc, k) => (acc && typeof acc === 'object' ? (acc as Record<string, unknown>)[k] : undefined), o);

/** What a run cost, by whichever way the brand's configuration says the agent reports it. */
export function parseCost(spec: CostSpec, stdout: string, result: { cost?: number } | null): number {
  if ('fixed' in spec) return spec.fixed;
  if (spec.from === 'result') return typeof result?.cost === 'number' && result.cost >= 0 ? result.cost : 0;
  // The agent prints JSON, maybe after other lines: take the last line that parses as an object.
  const lines = stdout.trim().split('\n').reverse();
  for (const line of [stdout.trim(), ...lines]) {
    try {
      const v = path_(JSON.parse(line), spec.path);
      if (typeof v === 'number' && v >= 0) return v;
    } catch {
      /* not that line */
    }
  }
  return 0;
}

/**
 * The agent does not inherit the runner's environment: whatever secrets are in it are none of the agent's business. It
 * gets what a program needs to run and find its own login, and what the brand's configuration adds. An agent that runs as
 * another user (runAs) does not get the runner's identity either (HOME, USER, LOGNAME, SHELL): its configuration gives HOME.
 *
 * This keeps the secrets out of the agent's own environment only. The runner's environment stays readable through
 * /proc/<pid>/environ to anything running as the runner's user, which is why secrets belong in files and the agent in
 * another user or a sandbox (see the README).
 */
const IDENTITY = ['HOME', 'USER', 'LOGNAME', 'SHELL'];
const PASS = ['PATH', ...IDENTITY, 'LANG', 'LC_ALL', 'TERM', 'TMPDIR', 'TZ', 'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE', 'HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY', 'https_proxy', 'http_proxy', 'no_proxy'];
export function agentEnv(extra: Record<string, string>, source: Record<string, string | undefined> = process.env, o: { identity?: boolean } = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const k of PASS) if (source[k] !== undefined && (o.identity !== false || !IDENTITY.includes(k))) env[k] = source[k]!;
  return { ...env, ...extra };
}

/** How the agent is started: the command (behind the sandbox's, if any), its environment, where, and as whom. */
export interface AgentPlan {
  command: string[];
  env: Record<string, string>;
  cwd: string;
  uid?: number;
  gid?: number;
}

const underPiece = (dirs: Dirs, p: string) => {
  const rel = path.relative(dirs.piece, p);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
};

/** A path of the piece directory as the agent sees it: under `sandbox.pieceDir` when the sandbox mounts the piece somewhere else. */
const seenIn = (agent: AgentSpec, dirs: Dirs) => (p: string) => {
  const mount = agent.sandbox?.pieceDir;
  return mount ? path.posix.join(mount, path.relative(dirs.piece, p).split(path.sep).join('/')) : p;
};

/**
 * Where the agent sees a piece's project directory. A git worktree sits inside the piece directory, so it is wherever the piece is; a
 * project worked on in place (dir mode) is elsewhere, and shown at `sandbox.projectDir`, or at its own path.
 */
export function agentProjectDir(agent: AgentSpec, dirs: Dirs, dir: string): string {
  return underPiece(dirs, dir) ? seenIn(agent, dirs)(dir) : (agent.sandbox?.projectDir ?? dir);
}

/** A piece's project, for one run: the directory the agent works in and, in git mode, the clone its worktree belongs to. */
export interface ProjectPaths {
  dir: string;
  repoDir?: string;
}

/**
 * Puts the agent's command together for one run. With a sandbox, its command comes first, filled with the runner's paths, and
 * the agent's command and ESTUDIO_* variables get the paths as the agent sees them (`sandbox.pieceDir` when the sandbox mounts
 * the piece directory somewhere else, `sandbox.projectDir` for a project outside it).
 */
export function planAgent(
  agent: AgentSpec, dirs: Dirs,
  run: { brand: string; runId: string; pieceId: string; maxBudget?: string; maxMinutes: string; project?: ProjectPaths },
  source: Record<string, string | undefined> = process.env,
): AgentPlan {
  const host = { runDir: dirs.run, inputDir: dirs.input, outputDir: dirs.output, pieceDir: dirs.piece, sourcesDir: dirs.sources };
  const seen = seenIn(agent, dirs);
  const inside = Object.fromEntries(Object.entries(host).map(([k, v]) => [k, seen(v)])) as typeof host;
  const project = run.project;
  const agentProject = project ? agentProjectDir(agent, dirs, project.dir) : undefined;
  const command = buildCommand(agent.command, {
    ...inside, instructionsFile: 'instructions.md', maxBudget: run.maxBudget, maxMinutes: run.maxMinutes, runId: run.runId, pieceId: run.pieceId,
    projectDir: agentProject,
  });
  const prefix = agent.sandbox
    ? buildCommand(agent.sandbox.command, {
        ...host, agentRunDir: inside.runDir, agentPieceDir: inside.pieceDir, runId: run.runId, pieceId: run.pieceId, brand: run.brand,
        home: agent.env.HOME ?? source.HOME, uid: String(agent.runAs?.uid ?? process.getuid?.() ?? ''), gid: String(agent.runAs?.gid ?? process.getgid?.() ?? ''),
        // The project: where it is, where the agent sees it, what to mount when it is not inside the piece directory (dir mode), and
        // the clone a git worktree belongs to (mounted read-only, it lets `git status` work inside the sandbox).
        projectDir: project?.dir, agentProjectDir: agentProject,
        projectMount: project && !underPiece(dirs, project.dir) ? project.dir : undefined, projectRepo: project?.repoDir,
      })
    : [];
  const env = agentEnv(
    {
      ...agent.env, ESTUDIO_RUN_DIR: inside.runDir, ESTUDIO_INPUT_DIR: inside.inputDir, ESTUDIO_OUTPUT_DIR: inside.outputDir, ESTUDIO_SOURCES_DIR: inside.sourcesDir,
      ...(agentProject ? { ESTUDIO_PROJECT_DIR: agentProject } : {}),
    },
    source,
    { identity: !agent.runAs },
  );
  return { command: [...prefix, ...command], env, cwd: dirs.run, uid: agent.runAs?.uid, gid: agent.runAs?.gid };
}

export interface AgentRun {
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  aborted: boolean;
  stdout: string;
  stderr: string;
  durationMs: number;
}

const TAIL = 256 * 1024;

/**
 * Runs the agent's command to the end, or until the time is up. It runs in its own process group, so stopping it stops
 * whatever it started too. Its output is kept in files as well as in memory (the tail).
 */
export function runAgent(o: {
  command: string[];
  cwd: string;
  env: Record<string, string>;
  /** Another user and group to run as (needs the runner to be root). */
  uid?: number;
  gid?: number;
  stdin?: string;
  timeoutMs: number;
  killGraceMs: number;
  logPrefix: string;
  signal?: AbortSignal;
}): Promise<AgentRun> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const [cmd, ...args] = o.command;
    // Node drops the supplementary groups too when it changes the user.
    const child = spawn(cmd!, args, { cwd: o.cwd, env: o.env, stdio: ['pipe', 'pipe', 'pipe'], detached: true, uid: o.uid, gid: o.gid });
    // Never through a link: the logs are written by the runner, and a link left where they go would make it write somewhere else.
    const logFlags = constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW;
    const outLog = createWriteStream(`${o.logPrefix}.stdout.log`, { flags: logFlags as unknown as string, mode: 0o600 });
    const errLog = createWriteStream(`${o.logPrefix}.stderr.log`, { flags: logFlags as unknown as string, mode: 0o600 });
    outLog.on('error', () => {});
    errLog.on('error', () => {});
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let aborted = false;
    let killTimer: NodeJS.Timeout | undefined;

    const stop = () => {
      if (child.pid === undefined) return;
      const group = (sig: NodeJS.Signals) => {
        try { process.kill(-child.pid!, sig); } catch { /* already gone */ }
      };
      group('SIGTERM');
      killTimer = setTimeout(() => group('SIGKILL'), o.killGraceMs);
    };
    const timer = setTimeout(() => { timedOut = true; stop(); }, o.timeoutMs);
    const onAbort = () => { aborted = true; stop(); };
    if (o.signal?.aborted) onAbort();
    else o.signal?.addEventListener('abort', onAbort, { once: true });

    child.stdout.on('data', (c: Buffer) => { outLog.write(c); stdout = (stdout + c.toString('utf8')).slice(-TAIL); });
    child.stderr.on('data', (c: Buffer) => { errLog.write(c); stderr = (stderr + c.toString('utf8')).slice(-TAIL); });
    child.stdin.on('error', () => { /* the agent did not read its input: not our problem */ });
    child.stdin.end(o.stdin ?? '');

    child.on('error', (err) => {
      clearTimeout(timer);
      clearTimeout(killTimer);
      reject(new Error(`Could not start the agent (${cmd}): ${err.message}`));
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      clearTimeout(killTimer);
      o.signal?.removeEventListener('abort', onAbort);
      outLog.end();
      errLog.end();
      resolve({ exitCode: code, signal, timedOut, aborted, stdout, stderr, durationMs: Date.now() - started });
    });
  });
}

export const logPrefix = (runDir: string, attempt: number) => path.join(runDir, `agent-${attempt + 1}`);
