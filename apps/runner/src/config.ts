import { readFileSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';

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

const brandSchema = z.object({
  /** The studio's address, and this brand's producer token. */
  api: z.string().url(),
  token: z.string().min(10),
  /** The webhook's secret. A list lets an old and a new secret both work while one is being rotated. */
  webhookSecret: z.union([z.string().min(10), z.array(z.string().min(10)).min(1)]),
  /** Instruction template per event type, as a path relative to this file. Events with no template are ignored. */
  templates: z.record(z.string(), z.string()).default({}),
  agent: z.object({
    command: z.array(argSchema).min(1),
    /** How the instructions reach the agent: on its standard input, or only as the file named by {{instructionsFile}}. */
    input: z.enum(['stdin', 'file']).default('stdin'),
    /** Extra environment for the agent. The studio's token is never part of it. */
    env: z.record(z.string(), z.string()).default({}),
    cost: costSchema.default({ from: 'result' }),
    killGraceSeconds: z.number().int().min(1).max(120).default(10),
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

export type Brand = z.infer<typeof brandSchema>;
export type ArgSpec = z.infer<typeof argSchema>;
export type CostSpec = z.infer<typeof costSchema>;
export type Config = z.infer<typeof configSchema> & {
  /** Absolute paths, resolved against the config file. */
  workspaceRoot: string;
  stateDir: string;
  baseDir: string;
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

export function parseConfig(raw: unknown, baseDir: string, env: Record<string, string | undefined> = process.env): Config {
  const parsed = configSchema.safeParse(interpolate(raw, env));
  if (!parsed.success) {
    throw new Error(`Invalid configuration: ${parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ')}`);
  }
  const c = parsed.data;
  const workspaceRoot = path.resolve(baseDir, c.workspaceRoot);
  return { ...c, workspaceRoot, stateDir: path.resolve(baseDir, c.stateDir ?? path.join(workspaceRoot, '.state')), baseDir };
}

export function loadConfig(file: string, env: Record<string, string | undefined> = process.env): Config {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    throw new Error(`Could not read the configuration ${file}: ${(err as Error).message}`);
  }
  return parseConfig(raw, path.dirname(path.resolve(file)), env);
}
