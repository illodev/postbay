import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import path from 'node:path';
import type { ArgSpec, CostSpec } from './config.js';

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
 * The agent does not inherit the runner's environment: the studio's token and the webhook secret are in it, and the
 * agent has no business with either. It gets what a program needs to run and find its own login, and what the
 * brand's configuration adds.
 */
const PASS = ['PATH', 'HOME', 'USER', 'LOGNAME', 'LANG', 'LC_ALL', 'TERM', 'TMPDIR', 'TZ', 'SHELL', 'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE', 'HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY', 'https_proxy', 'http_proxy', 'no_proxy'];
export function agentEnv(extra: Record<string, string>, source: Record<string, string | undefined> = process.env): Record<string, string> {
  const env: Record<string, string> = {};
  for (const k of PASS) if (source[k] !== undefined) env[k] = source[k]!;
  return { ...env, ...extra };
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
  stdin?: string;
  timeoutMs: number;
  killGraceMs: number;
  logPrefix: string;
  signal?: AbortSignal;
}): Promise<AgentRun> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const [cmd, ...args] = o.command;
    const child = spawn(cmd!, args, { cwd: o.cwd, env: o.env, stdio: ['pipe', 'pipe', 'pipe'], detached: true });
    const outLog = createWriteStream(`${o.logPrefix}.stdout.log`);
    const errLog = createWriteStream(`${o.logPrefix}.stderr.log`);
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
