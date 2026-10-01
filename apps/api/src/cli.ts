import { loadConfig } from './config.js';
import { createDb } from './db.js';
import { isValidZone } from './domain/time.js';
import { migrate } from './migrate.js';

const [command, ...rest] = process.argv.slice(2);

function flags(args: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < args.length; i += 2) {
    const k = args[i];
    const v = args[i + 1];
    if (!k?.startsWith('--') || v === undefined) throw new Error(`Bad arguments near "${k ?? ''}"`);
    out[k.slice(2)] = v;
  }
  return out;
}

const USAGE = `Usage:
  npm run migrate -w @estudio/api
  npm run bootstrap -- --workspace "Acme" --brand "Acme Spain" --timezone Europe/Madrid --admin you@example.com`;

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
