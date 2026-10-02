import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { Secrets } from './secrets.js';

/**
 * One argument of the agent's command. A plain string may hold {{placeholders}}; an object adds arguments only when a
 * value exists (a budget flag that is left out when there is no budget to pass).
 */
const argSchema = z.union([z.string(), z.object({ if: z.string(), args: z.array(z.string()).min(1) })]);

const costSchema = z.union([
  /** The agent prints JSON on its output, and the cost is a number at this path (Claude Code: "total_cost_usd"). */
  z.object({ from: z.literal('stdout-json'), path: z.string().min(1) }),
  /** The agent says what it cost in result.json. */
  z.object({ from: z.literal('result') }),
  /** A flat amount for every run. */
  z.object({ fixed: z.number().min(0) }),
]);

const checksSchema = z
  .object({
    /** Networks that must be able to publish the file. Unset: the file must suit at least one of the brand's networks. */
    requireNetworks: z.array(z.string()).default([]),
    /** Integrated loudness range, in LUFS, outside which a warning is raised. */
    loudness: z.object({ min: z.number(), max: z.number() }).default({ min: -23, max: -9 }),
    /** True peak above this (dBTP) is a warning. */
    truePeakMax: z.number().default(-1),
    /** The shorter side of a video, in pixels, below which a warning is raised. */
    minShortSide: z.number().int().default(720),
    /** "warn" looks for detail where a network's own interface covers the frame; "off" skips it. */
    coveredZones: z.enum(['warn', 'off']).default('warn'),
  })
  .default({ requireNetworks: [], loudness: { min: -23, max: -9 }, truePeakMax: -1, minShortSide: 720, coveredZones: 'warn' });

/** A value of the agent's environment: written out (`${NAME}` works), or read from a file, for a key the runner must not hold in its own environment. */
const envValue = z.union([z.string(), z.object({ file: z.string().min(1) })]);

const sandboxSchema = z.object({
  /**
   * A command the agent's command is put after, which runs it apart from the runner: bwrap, firejail, `docker run …`. Its
   * {{placeholders}} are the runner's own paths (runDir, inputDir, outputDir, pieceDir, sourcesDir), the run and piece directories
   * as the agent sees them (agentRunDir, agentPieceDir), and home, runId, pieceId, brand, uid, gid.
   */
  command: z.array(argSchema).min(1),
  /**
   * Where the sandbox shows the piece directory to the agent, when it is not at the same path (a container's mount point). The
   * agent's command and its ESTUDIO_* variables then get the paths as the agent sees them.
   */
  pieceDir: z.string().startsWith('/').optional(),
});

const brandSchema = z.object({
  /** The studio's address. */
  api: z.string().url(),
  /** This brand's producer token, or (better) a file that holds it, readable by the runner's user only. */
  token: z.string().min(10).optional(),
  tokenFile: z.string().min(1).optional(),
  /** The webhook's secret. A list lets an old and a new secret both work while one is being rotated; in a file, one per line. */
  webhookSecret: z.union([z.string().min(10), z.array(z.string().min(10)).min(1)]).optional(),
  webhookSecretFile: z.string().min(1).optional(),
  /** Instruction template per event type, as a path relative to this file. Events with no template are ignored. */
  templates: z.record(z.string(), z.string()).default({}),
  agent: z.object({
    command: z.array(argSchema).min(1),
    /** How the instructions reach the agent: on its standard input, or only as the file named by {{instructionsFile}}. */
    input: z.enum(['stdin', 'file']).default('stdin'),
    /** Extra environment for the agent. The studio's token and the webhook secret are never part of it. */
    env: z.record(z.string(), envValue).default({}),
    cost: costSchema.default({ from: 'result' }),
    killGraceSeconds: z.number().int().min(1).max(120).default(10),
    /** Run the agent as this user and group, not the runner's (the runner must start as root). Its workspace is made theirs. */
    runAs: z.object({ uid: z.number().int().min(1), gid: z.number().int().min(1) }).optional(),
    sandbox: sandboxSchema.optional(),
  }),
  checks: checksSchema,
  /** Extra tries when the output fails the automatic checks, each costing another run of the agent. */
  checkRetries: z.number().int().min(0).max(3).default(1),
});

const configSchema = z.object({
  listen: z.object({ host: z.string().default('0.0.0.0'), port: z.number().int().min(1).max(65535).default(8787) }).default({ host: '0.0.0.0', port: 8787 }),
  workspaceRoot: z.string().min(1),
  /** Where the queue and its history live. Default: .state inside the workspace root. */
  stateDir: z.string().optional(),
  maxConcurrentRuns: z.number().int().min(1).max(8).default(1),
  ffmpeg: z.string().default('ffmpeg'),
  ffprobe: z.string().default('ffprobe'),
  brands: z
    .record(z.string(), brandSchema)
    .refine((b) => Object.keys(b).length > 0, 'Configure at least one brand')
    .refine((b) => Object.keys(b).every((k) => /^[a-z0-9][a-z0-9_-]*$/i.test(k)), 'Brand keys are letters, digits, - and _ (they appear in the webhook address)'),
});

type BrandInput = z.infer<typeof brandSchema>;
/** The agent's settings, with every value of its environment read. */
export type AgentSpec = Omit<BrandInput['agent'], 'env'> & { env: Record<string, string> };
/** A brand as the runner uses it: its token and webhook secrets read, from the file or the configuration. */
export type Brand = Omit<BrandInput, 'token' | 'tokenFile' | 'webhookSecret' | 'webhookSecretFile' | 'agent'> & {
  token: string;
  webhookSecret: string[];
  agent: AgentSpec;
};
export type ArgSpec = z.infer<typeof argSchema>;
export type CostSpec = z.infer<typeof costSchema>;
export type Config = Omit<z.infer<typeof configSchema>, 'brands'> & {
  brands: Record<string, Brand>;
  /** Absolute paths, resolved against the config file. */
  workspaceRoot: string;
  stateDir: string;
  baseDir: string;
  /** Everything secret the runner holds, so that none of it is ever posted to the studio. */
  secrets: Secrets;
  /** What is allowed but unsafe, said once when the runner starts. */
  warnings: string[];
};

/** ${NAME} in any string value is replaced by the environment variable, so secrets need not be written in the file. */
export function interpolate(value: unknown, env: Record<string, string | undefined>): unknown {
  if (typeof value === 'string') {
    return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_m, name: string) => {
      const v = env[name];
      if (v === undefined || v === '') throw new Error(`The configuration uses \${${name}}, but that environment variable is not set`);
      return v;
    });
  }
  if (Array.isArray(value)) return value.map((v) => interpolate(v, env));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, interpolate(v, env)]));
  return value;
}

const SECRET_NAME = /KEY|TOKEN|SECRET|PASS|AUTH|CREDENTIAL/i;
const fromEnvironment = (v: unknown) => (Array.isArray(v) ? v : [v]).some((x) => typeof x === 'string' && /\$\{[A-Za-z_]/.test(x));

/**
 * Reads a secret from a file that only its owner can read. A file others can read is refused, as ssh refuses a key: the point of
 * the file is that nothing else on the machine (an agent running as another user, say) can read it.
 */
export function readSecretFile(file: string): string {
  let st;
  try {
    st = statSync(file);
  } catch (err) {
    throw new Error(`cannot read ${file}: ${(err as Error).message}`);
  }
  if (!st.isFile()) throw new Error(`${file} is not a file`);
  if ((st.mode & 0o077) !== 0) throw new Error(`${file} can be read by other users (mode ${(st.mode & 0o777).toString(8)}): chmod 600 it`);
  const text = readFileSync(file, 'utf8').trim();
  if (!text) throw new Error(`${file} is empty`);
  return text;
}

export function parseConfig(raw: unknown, baseDir: string, env: Record<string, string | undefined> = process.env, o: { uid?: number } = {}): Config {
  const parsed = configSchema.safeParse(interpolate(raw, env));
  if (!parsed.success) {
    throw new Error(`Invalid configuration: ${parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ')}`);
  }
  const c = parsed.data;
  const rawBrands = ((raw as { brands?: Record<string, any> })?.brands ?? {}) as Record<string, any>;
  const uid = o.uid ?? process.getuid?.();
  const problems: string[] = [];
  const warnings: string[] = [];
  const secrets: { label: string; value: string }[] = [];
  const brands: Record<string, Brand> = {};
  const file = (p: string) => path.resolve(baseDir, p);

  for (const [key, b] of Object.entries(c.brands)) {
    const where = `brands.${key}`;
    const rb = rawBrands[key] ?? {};
    try {
      if (!!b.token === !!b.tokenFile) throw new Error('give the producer token as tokenFile (or token), one of the two');
      if (!!b.webhookSecret === !!b.webhookSecretFile) throw new Error('give the webhook secret as webhookSecretFile (or webhookSecret), one of the two');
      const token = b.tokenFile ? readSecretFile(file(b.tokenFile)) : b.token!;
      if (token.length < 10) throw new Error('the producer token is too short');
      const webhookSecret = b.webhookSecretFile
        ? readSecretFile(file(b.webhookSecretFile)).split('\n').map((l) => l.trim()).filter(Boolean)
        : [b.webhookSecret!].flat();
      if (webhookSecret.some((x) => x.length < 10)) throw new Error('a webhook secret is too short');
      secrets.push({ label: `${key}: studio token`, value: token }, ...webhookSecret.map((value) => ({ label: `${key}: webhook secret`, value })));

      const agentEnv: Record<string, string> = {};
      for (const [name, v] of Object.entries(b.agent.env)) {
        if (typeof v === 'string') {
          agentEnv[name] = v;
          // What comes from the runner's environment under a name that says it is a credential is treated as secret (a base URL is not).
          if (fromEnvironment(rb.agent?.env?.[name]) && SECRET_NAME.test(name)) secrets.push({ label: `${key}: agent.env.${name}`, value: v });
        } else {
          agentEnv[name] = readSecretFile(file(v.file));
          secrets.push({ label: `${key}: agent.env.${name}`, value: agentEnv[name] });
        }
      }
      if (b.agent.runAs && !agentEnv.HOME) {
        throw new Error("agent.runAs needs agent.env.HOME, the agent user's own home (the runner's is not passed to it)");
      }
      brands[key] = { ...b, token, webhookSecret, agent: { ...b.agent, env: agentEnv } };

      if (!b.tokenFile && fromEnvironment(rb.token)) {
        warnings.push(`${key}: the studio token comes from an environment variable. Anything running as the runner's user can read the runner's environment (/proc/<pid>/environ), the agent too unless it runs as another user or in a sandbox: put it in a file (mode 600) and use tokenFile.`);
      }
      if (!b.webhookSecretFile && fromEnvironment(rb.webhookSecret)) {
        warnings.push(`${key}: the webhook secret comes from an environment variable, which the agent can read the same way: use webhookSecretFile.`);
      }
      if (!b.agent.runAs && !b.agent.sandbox) {
        warnings.push(`${key}: the agent runs as the runner's own user with no sandbox, so it can read whatever the runner can, this runner's secret files and other brands' workspaces included. Set agent.runAs or agent.sandbox (see the README).`);
      }
      if (b.agent.runAs && uid !== 0) {
        warnings.push(`${key}: agent.runAs needs the runner to start as root (or with CAP_SETUID, CAP_SETGID and CAP_CHOWN); without that the agent will not start.`);
      }
      if (b.agent.runAs && b.agent.runAs.uid === uid) warnings.push(`${key}: agent.runAs is the runner's own user, which keeps nothing apart.`);
    } catch (err) {
      problems.push(`${where}: ${(err as Error).message}`);
    }
  }
  if (problems.length) throw new Error(`Invalid configuration: ${problems.join('; ')}`);
  const workspaceRoot = path.resolve(baseDir, c.workspaceRoot);
  return {
    ...c, brands, workspaceRoot, stateDir: path.resolve(baseDir, c.stateDir ?? path.join(workspaceRoot, '.state')), baseDir,
    secrets: new Secrets(secrets), warnings,
  };
}

export function loadConfig(file: string, env: Record<string, string | undefined> = process.env): Config {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    throw new Error(`Could not read the configuration ${file}: ${(err as Error).message}`);
  }
  const config = parseConfig(raw, path.dirname(path.resolve(file)), env);
  // A secret written out in the file is as safe as the file.
  const literal = Object.values(((raw as { brands?: Record<string, any> }).brands ?? {})).some(
    (b) => (typeof b?.token === 'string' && !fromEnvironment(b.token)) || (b?.webhookSecret && !fromEnvironment(b.webhookSecret)),
  );
  if (literal && (statSync(file).mode & 0o077) !== 0) {
    config.warnings.push(`${file} holds a token or a webhook secret and other users can read it: chmod 600 it, or move the secrets to tokenFile and webhookSecretFile.`);
  }
  return config;
}
