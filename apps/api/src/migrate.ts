import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Db } from './db.js';

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'migrations');

/** Applies pending migrations in order, under a lock so two processes never collide. */
export async function migrate(db: Db): Promise<string[]> {
  const client = await db.pool.connect();
  const applied: string[] = [];
  try {
    await client.query('select pg_advisory_lock(727274)');
    await client.query(
      'create table if not exists schema_migration (name text primary key, applied_at timestamptz not null default now())',
    );
    const done = new Set((await client.query('select name from schema_migration')).rows.map((r) => r.name as string));
    const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
    for (const file of files) {
      if (done.has(file)) continue;
      const sql = await readFile(path.join(dir, file), 'utf8');
      try {
        await client.query('begin');
        await client.query(sql);
        await client.query('insert into schema_migration (name) values ($1)', [file]);
        await client.query('commit');
        applied.push(file);
      } catch (err) {
        await client.query('rollback');
        throw new Error(`Migration ${file} failed: ${(err as Error).message}`);
      }
    }
  } finally {
    await client.query('select pg_advisory_unlock(727274)').catch(() => {});
    client.release();
  }
  return applied;
}
