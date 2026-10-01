import pg from 'pg';

// Postgres bigint (file sizes in bytes) fits comfortably in a JS number.
pg.types.setTypeParser(20, (v) => Number(v));
// date columns come back as 'YYYY-MM-DD', without going through the server's time zone.
pg.types.setTypeParser(1082, (v) => v);

export type Row = Record<string, any>;

export interface Queryable {
  query<T extends Row = Row>(sql: string, params?: unknown[]): Promise<T[]>;
  one<T extends Row = Row>(sql: string, params?: unknown[]): Promise<T | null>;
}

export interface Db extends Queryable {
  tx<T>(fn: (tx: Queryable) => Promise<T>): Promise<T>;
  close(): Promise<void>;
  pool: pg.Pool;
}

function wrap(client: pg.Pool | pg.PoolClient): Queryable {
  const query = async <T extends Row = Row>(sql: string, params: unknown[] = []) =>
    (await client.query(sql, params)).rows as T[];
  return {
    query,
    one: async <T extends Row = Row>(sql: string, params: unknown[] = []) => (await query<T>(sql, params))[0] ?? null,
  };
}

export function createDb(connectionString: string): Db {
  const pool = new pg.Pool({ connectionString, max: 10 });
  const base = wrap(pool);
  return {
    ...base,
    pool,
    async tx(fn) {
      const client = await pool.connect();
      try {
        await client.query('begin');
        const out = await fn(wrap(client));
        await client.query('commit');
        return out;
      } catch (err) {
        await client.query('rollback').catch(() => {});
        throw err;
      } finally {
        client.release();
      }
    },
    close: () => pool.end(),
  };
}
