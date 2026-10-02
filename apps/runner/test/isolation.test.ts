import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { planAgent } from '../src/agent.js';
import { Studio } from '../src/api.js';
import { parseConfig, readSecretFile } from '../src/config.js';
import { Secrets, secretsInEnvironment } from '../src/secrets.js';
import { dirsFor, ensureDirs, readResult } from '../src/workspace.js';

const dir = mkdtempSync(path.join(tmpdir(), 'runner-isolation-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const TOKEN = 'est_TheStudioTokenOfLumen0123456789';
const SECRET = 'whsec_TheWebhookSecretOfLumen0123';
const file = (name: string, text: string, mode = 0o600) => {
  const p = path.join(dir, name);
  writeFileSync(p, text);
  chmodSync(p, mode);
  return p;
};
const mode = (p: string) => (statSync(p).mode & 0o777).toString(8);
const brand = (extra: Record<string, unknown> = {}) => ({ api: 'https://studio.example', agent: { command: ['claude', '-p'] }, ...extra });
const parse = (b: Record<string, unknown>, env: Record<string, string> = {}, uid = 1000) => parseConfig({ workspaceRoot: path.join(dir, 'work'), brands: { lumen: b } }, dir, env, { uid });

describe('where the runner keeps its secrets', () => {
  it('reads the token and the webhook secrets from files only their owner can read, one secret per line', () => {
    const c = parse(brand({ tokenFile: file('lumen.token', `${TOKEN}\n`), webhookSecretFile: file('lumen.whsec', `${SECRET}\nwhsec_TheOldSecretStillAccepted\n`) }));
    expect(c.brands.lumen!.token).toBe(TOKEN);
    expect(c.brands.lumen!.webhookSecret).toEqual([SECRET, 'whsec_TheOldSecretStillAccepted']);
    expect(c.secrets.foundIn(`a ${TOKEN} b`)).toEqual(['lumen: studio token']);
  });

  it('refuses a file other users can read, as ssh refuses a key', () => {
    expect(() => readSecretFile(file('open.token', TOKEN, 0o644))).toThrow(/can be read by other users \(mode 644\): chmod 600/);
    expect(() => readSecretFile(file('group.token', TOKEN, 0o640))).toThrow(/chmod 600/);
    expect(() => parse(brand({ tokenFile: file('open2.token', TOKEN, 0o604), webhookSecret: SECRET }))).toThrow(/brands\.lumen: .*chmod 600/);
    expect(() => readSecretFile(path.join(dir, 'missing.token'))).toThrow(/cannot read/);
  });

  it('wants one way of giving each, and says so', () => {
    expect(() => parse(brand({ webhookSecret: SECRET }))).toThrow(/tokenFile \(or token\), one of the two/);
    expect(() => parse(brand({ token: TOKEN, tokenFile: file('both.token', TOKEN), webhookSecret: SECRET }))).toThrow(/one of the two/);
    expect(() => parse(brand({ token: TOKEN }))).toThrow(/webhookSecretFile \(or webhookSecret\)/);
  });

  it('warns when a secret comes from the environment, which an agent of the same user can read through /proc', () => {
    const c = parse(brand({ token: '${LUMEN_TOKEN}', webhookSecret: '${LUMEN_SECRET}', agent: { command: ['x'], env: { ANTHROPIC_API_KEY: '${KEY}', ANTHROPIC_BASE_URL: '${BASE}', MODE: 'plain' } } }), {
      LUMEN_TOKEN: TOKEN, LUMEN_SECRET: SECRET, KEY: 'sk-ant-SomeApiKeyFromTheEnvironment', BASE: 'https://api.anthropic.com',
    });
    expect(c.warnings.join('\n')).toMatch(/studio token comes from an environment variable.*tokenFile/);
    expect(c.warnings.join('\n')).toMatch(/webhook secret comes from an environment variable.*webhookSecretFile/);
    // What came from the environment under a credential's name is treated as a secret; an address, or what is written out, is not.
    expect(c.secrets.foundIn('sk-ant-SomeApiKeyFromTheEnvironment plain https://api.anthropic.com')).toEqual(['lumen: agent.env.ANTHROPIC_API_KEY']);
  });

  it('reads a value of the agent\'s environment from a file, and keeps it secret', () => {
    const c = parse(brand({ token: TOKEN, webhookSecret: SECRET, agent: { command: ['x'], env: { ANTHROPIC_API_KEY: { file: file('lumen.key', 'sk-ant-FromAFile0123456789') } } } }));
    expect(c.brands.lumen!.agent.env.ANTHROPIC_API_KEY).toBe('sk-ant-FromAFile0123456789');
    expect(c.secrets.foundIn('x sk-ant-FromAFile0123456789')).toEqual(['lumen: agent.env.ANTHROPIC_API_KEY']);
  });

  it('warns when the agent is not kept apart from the runner, and checks what keeping it apart needs', () => {
    const plain = parse(brand({ token: TOKEN, webhookSecret: SECRET }));
    expect(plain.warnings.join('\n')).toMatch(/runs as the runner's own user with no sandbox/);
    const sandboxed = parse(brand({ token: TOKEN, webhookSecret: SECRET, agent: { command: ['x'], sandbox: { command: ['bwrap', '--'] } } }));
    expect(sandboxed.warnings).toEqual([]);
    expect(() => parse(brand({ token: TOKEN, webhookSecret: SECRET, agent: { command: ['x'], runAs: { uid: 2001, gid: 2001 } } }))).toThrow(/agent\.env\.HOME/);
    const asOther = { token: TOKEN, webhookSecret: SECRET, agent: { command: ['x'], runAs: { uid: 2001, gid: 2001 }, env: { HOME: '/home/agent' } } };
    expect(parse(brand(asOther), {}, 0).warnings).toEqual([]);
    expect(parse(brand(asOther), {}, 1000).warnings.join('\n')).toMatch(/needs the runner to start as root/);
    expect(() => parse(brand({ token: TOKEN, webhookSecret: SECRET, agent: { command: ['x'], runAs: { uid: 0, gid: 0 }, env: { HOME: '/root' } } }))).toThrow(/runAs/);
  });
});

describe('looking for secrets in what is about to be posted', () => {
  const secrets = new Secrets([{ label: 'a: studio token', value: TOKEN }, { label: 'a: webhook secret', value: SECRET }, { label: 'short', value: 'abc' }]);

  it('finds them in text, says which by name only, and can take them out', () => {
    expect(secrets.size).toBe(2); // a value this short is not looked for
    expect(secrets.foundIn(`notes ${SECRET} and ${TOKEN}`).sort()).toEqual(['a: studio token', 'a: webhook secret']);
    expect(secrets.foundIn('nothing here abc')).toEqual([]);
    expect(secrets.redact(`x${TOKEN}y${TOKEN}`)).toBe('x[secret removed]y[secret removed]');
  });

  it('finds them in a file of any size, also across the pieces it is read in', async () => {
    const big = Buffer.alloc(3 * 1024 * 1024, 0x20);
    big.write(TOKEN, 1024 * 1024 - 10); // straddles the first megabyte
    const p = path.join(dir, 'big.bin');
    writeFileSync(p, big);
    expect(await secrets.foundInFile(p)).toEqual(['a: studio token']);
    writeFileSync(p, Buffer.alloc(2 * 1024 * 1024, 0x41));
    expect(await secrets.foundInFile(p)).toEqual([]);
  });

  it('finds them in a process\'s environment as /proc gives it', () => {
    expect(secretsInEnvironment(secrets, Buffer.from(`PATH=/usr/bin\0STUDIO_TOKEN=${TOKEN}\0HOME=/root\0`))).toEqual(['a: studio token']);
    expect(secretsInEnvironment(secrets, 'PATH=/usr/bin\0HOME=/root\0')).toEqual([]);
  });

  it('never sends one to the studio, whatever the runner posts', async () => {
    const sent: string[] = [];
    const studio = new Studio('http://studio.test', TOKEN, (async (_url: unknown, init?: RequestInit) => {
      sent.push(String(init?.body ?? ''));
      return new Response('{}', { status: 200 });
    }) as typeof fetch, secrets);
    await studio.finishRun('run', { outcome: 'failed', notes: `The agent exited with 3. token=${TOKEN}` });
    await studio.reply('c', { body: `see ${SECRET}`, kind: 'needs_human' });
    expect(sent.join('\n')).not.toContain(TOKEN);
    expect(sent.join('\n')).not.toContain(SECRET);
    expect(JSON.parse(sent[0]!).notes).toBe('The agent exited with 3. token=[secret removed]');
  });
});

describe('how the agent is started', () => {
  const dirs = dirsFor('/var/lib/runner', 'lumen', 'piece-1', 'run-1');
  const run = { brand: 'lumen', runId: 'run-1', pieceId: 'piece-1', maxMinutes: '30', maxBudget: '2.5' };
  const source = { PATH: '/usr/bin', HOME: '/home/runner', USER: 'runner', LUMEN_TOKEN: TOKEN };

  it('as before without a sandbox: the paths as they are, the runner\'s environment left out', () => {
    const p = planAgent({ command: ['claude', '--add-dir', '{{pieceDir}}', '{{outputDir}}'], input: 'stdin', env: { K: 'v' }, cost: { from: 'result' }, killGraceSeconds: 10 }, dirs, run, source);
    expect(p.command).toEqual(['claude', '--add-dir', '/var/lib/runner/lumen/piece-1', '/var/lib/runner/lumen/piece-1/runs/run-1/output']);
    expect(p.cwd).toBe(dirs.run);
    expect(p.env).toMatchObject({ PATH: '/usr/bin', HOME: '/home/runner', K: 'v', ESTUDIO_OUTPUT_DIR: dirs.output });
    expect(JSON.stringify(p.env)).not.toContain(TOKEN);
    expect(p.uid).toBeUndefined();
  });

  it('behind a sandbox: its command first with the runner\'s paths, the agent\'s with the paths as the sandbox shows them', () => {
    const p = planAgent({
      command: ['claude', '--add-dir', '{{pieceDir}}', 'Edit(/{{outputDir}}/**)'], input: 'stdin', env: { HOME: '/srv/agent-home' }, cost: { from: 'result' }, killGraceSeconds: 10,
      sandbox: { command: ['docker', 'run', '--rm', '-i', '-u', '{{uid}}', '-v', '{{pieceDir}}:/work', '-v', '{{home}}:{{home}}', '-w', '{{agentRunDir}}', 'agent-image'], pieceDir: '/work' },
    }, dirs, run, source);
    expect(p.command).toEqual([
      'docker', 'run', '--rm', '-i', '-u', String(process.getuid!()), '-v', '/var/lib/runner/lumen/piece-1:/work', '-v', '/srv/agent-home:/srv/agent-home', '-w', '/work/runs/run-1', 'agent-image',
      'claude', '--add-dir', '/work', 'Edit(//work/runs/run-1/output/**)',
    ]);
    expect(p.env).toMatchObject({ ESTUDIO_RUN_DIR: '/work/runs/run-1', ESTUDIO_OUTPUT_DIR: '/work/runs/run-1/output', ESTUDIO_SOURCES_DIR: '/work/sources' });
  });

  it('as another user: that user\'s identity, not the runner\'s', () => {
    const p = planAgent({ command: ['claude'], input: 'stdin', env: { HOME: '/home/agent-lumen' }, cost: { from: 'result' }, killGraceSeconds: 10, runAs: { uid: 2001, gid: 2002 } }, dirs, run, source);
    expect(p).toMatchObject({ uid: 2001, gid: 2002 });
    expect(p.env.HOME).toBe('/home/agent-lumen');
    expect(p.env.USER).toBeUndefined();
  });
});

describe('the workspace', () => {
  it('is the runner\'s alone without runAs: each brand\'s directory is closed to everyone else', async () => {
    const d = dirsFor(path.join(dir, 'ws'), 'lumen', 'piece-9', 'run-9');
    mkdirSync(d.brand, { recursive: true, mode: 0o755 }); // as an older runner left it
    await ensureDirs(d);
    for (const p of [d.brand, d.piece, d.run, d.input, d.output, d.sources]) expect(mode(p), p).toBe('700');
  });

  it('reads result.json only from inside the output directory, and not one of any size', async () => {
    const out = path.join(dir, 'out');
    mkdirSync(out, { recursive: true });
    expect(await readResult(out)).toEqual({ missing: true });
    symlinkSync(file('elsewhere.json', TOKEN), path.join(out, 'result.json'));
    expect(await readResult(out)).toEqual({ problem: 'result.json leads somewhere outside the output directory' });
    rmSync(path.join(out, 'result.json'));
    writeFileSync(path.join(out, 'result.json'), Buffer.alloc(2 * 1024 * 1024, 0x20));
    expect(await readResult(out)).toMatchObject({ problem: expect.stringContaining('more than the') });
    writeFileSync(path.join(out, 'result.json'), '{"notes":"ok"}');
    expect(await readResult(out)).toEqual({ text: '{"notes":"ok"}' });
  });
});
