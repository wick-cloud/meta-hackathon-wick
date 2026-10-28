import { Pool, type PoolClient } from 'pg';
import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
export function createPool(databaseUrl: string) {
  return new Pool({
    connectionString: databaseUrl,
    max: 20,
    connectionTimeoutMillis: 5000,
    idleTimeoutMillis: 30000,
    statement_timeout: 15000,
    idle_in_transaction_session_timeout: 15000,
  });
}
export async function migrate(pool: Pool) {
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock(872193410)');
    await client.query(
      'CREATE TABLE IF NOT EXISTS broker_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())',
    );
    for (const name of (await readdir(resolve('migrations')))
      .filter((n) => /^\d+.*\.sql$/.test(n))
      .sort()) {
      if ((await client.query('SELECT 1 FROM broker_migrations WHERE name=$1', [name])).rowCount)
        continue;
      const sql = await readFile(resolve('migrations', name), 'utf8');
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO broker_migrations(name) VALUES($1)', [name]);
        await client.query('COMMIT');
      } catch (e) {
        await client.query('ROLLBACK');
        throw e;
      }
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock(872193410)');
    client.release();
  }
}
export async function transaction<T>(pool: Pool, fn: (client: PoolClient) => Promise<T>) {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const out = await fn(c);
    await c.query('COMMIT');
    return out;
  } catch (e) {
    await c.query('ROLLBACK');
    throw e;
  } finally {
    c.release();
  }
}
