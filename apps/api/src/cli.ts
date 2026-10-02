import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { loadConfig } from './config.js';
import { setTap, type Exchange } from './connectors/http.js';
import { createDb } from './db.js';
import { isValidZone } from './domain/time.js';
import { localeOf, t, withLocale, type Key, type Params } from './i18n/index.js';
import { migrate } from './migrate.js';
import { consoleLogger, createContext } from './runtime.js';
import { resetByEmail } from './services/secondfactor.js';
import { formatChecks, runChecks } from './services/selfcheck.js';

const [command, ...rest] = process.argv.slice(2);

/** `--name value`, or just `--name` for a switch (it reads as "true"). */
function flags(args: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    const k = args[i];
    if (!k?.startsWith('--')) throw new Error(`Bad arguments near "${k ?? ''}"`);
    const next = args[i + 1];
    if (next === undefined || next.startsWith('--')) out[k.slice(2)] = 'true';
    else { out[k.slice(2)] = next; i++; }
  }
  return out;
}

const USAGE = `Usage:
  npm run migrate -w @estudio/api
  npm run bootstrap -- --workspace "Acme" --brand "Acme Spain" --timezone Europe/Madrid --admin you@example.com
  npm run check -w @estudio/api -- --brand "Acme Spain" [--network threads] [--json] [--capture ./transcripts] [--publish --yes]
      Checks the server and every connected account of a brand, and says what to fix (docs/phase-5.md).
      --capture writes every call made to the networks, with secrets removed, so a mismatch can be reported.
      --publish makes ONE REAL POST on each account, and needs --yes. The app cannot delete it: you do.
  npm run reset-2fa -w @estudio/api -- --email you@example.com
      Removes a person's authenticator and recovery codes, for an admin who lost both. It also signs them out everywhere and voids
      any sign-in link not used yet; they set a new authenticator up at their next sign-in.`;

const config = loadConfig();
const db = createDb(config.DATABASE_URL);
try {
  if (command === 'migrate') {
    const applied = await migrate(db);
    console.log(applied.length ? `Applied: ${applied.join(', ')}` : 'Nothing to apply');
  } else if (command === 'bootstrap') {
    // Creates the first workspace, brand and admin. Everything else is done from the app.
    const f = flags(rest);
    for (const k of ['workspace', 'brand', 'timezone', 'admin']) if (!f[k]) throw new Error(`Missing --${k}\n${USAGE}`);
    if (!isValidZone(f.timezone!)) throw new Error(`${f.timezone} is not a valid IANA time zone`);
    await migrate(db);
    const out = await db.tx(async (tx) => {
      const w = (await tx.one('insert into workspace (name) values ($1) returning id', [f.workspace]))!;
      const b = (await tx.one('insert into brand (workspace_id, name, timezone) values ($1,$2,$3) returning id', [w.id, f.brand, f.timezone]))!;
      const email = f.admin!.trim().toLowerCase();
      const u =
        (await tx.one('select id from app_user where lower(email) = $1', [email])) ??
        (await tx.one('insert into app_user (email) values ($1) returning id', [email]))!;
      await tx.query(`insert into member (user_id, brand_id, role) values ($1,$2,'admin')`, [u.id, b.id]);
      return { workspace: w.id, brand: b.id, admin: email };
    });
    console.log(`Created workspace ${out.workspace}, brand ${out.brand}, admin ${out.admin}`);
  } else if (command === 'reset-2fa') {
    const f = flags(rest);
    if (!f.email || f.email === 'true') throw new Error(`Missing --email\n${USAGE}`);
    await migrate(db);
    const done = await resetByEmail(createContext(config, db, consoleLogger()), f.email);
    if (!done) throw new Error(`There is no account for ${f.email}`);
    console.log(`The authenticator and recovery codes of ${f.email} are gone, every session of theirs has ended and any sign-in link not used yet no longer works. They set up a new authenticator the next time they sign in; an email tells them about the reset.`);
  } else if (command === 'check') {
    // The report is written in the language the terminal is set to (LANG): English for en_*, Spanish otherwise.
    const locale = localeOf(process.env.LANG);
    const say = (key: Key, params?: Params) => t(locale, key, params);
    const f = flags(rest);
    if (!f.brand || f.brand === 'true') throw new Error(`Missing --brand\n${USAGE}`);
    if (f.publish && !f.yes) throw new Error(say('check.cli.publishNeedsYes'));
    await migrate(db);
    const ctx = createContext(config, db, consoleLogger());
    const exchanges: (Exchange & { account: string })[] = [];
    let current = '(server)';
    if (f.capture) setTap((e) => exchanges.push({ account: current, ...e }));
    const report = await withLocale(locale, () => runChecks(ctx, { brand: f.brand!, network: f.network, publish: !!f.publish, onAccount: (label) => { current = label; } }));
    setTap(null);
    if (f.json) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      console.log(`${say('check.cli.checking', { brand: report.brand.name })}\n\n${say('check.cli.server')}\n${formatChecks(report.server)}`);
      for (const a of report.accounts) console.log(`\n${a.account.network} · ${a.account.display_name}\n${formatChecks(a.results)}`);
      if (!report.accounts.length) console.log(`\n${say('check.cli.noAccounts')}`);
      console.log(`\n${say(report.ok ? 'check.cli.ok' : 'check.cli.failed')}`);
    }
    if (f.capture) {
      await mkdir(f.capture, { recursive: true });
      const file = path.join(f.capture, `transcript-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
      await writeFile(file, JSON.stringify({ note: 'Every call this check made to the networks. Tokens, secrets and signed query strings are removed.', exchanges }, null, 2));
      console.error(say('check.cli.transcript', { count: exchanges.length, file }));
    }
    if (!report.ok) process.exitCode = 1;
  } else {
    console.log(USAGE);
    process.exitCode = 1;
  }
} catch (err) {
  console.error((err as Error).message);
  process.exitCode = 1;
} finally {
  await db.close();
}
