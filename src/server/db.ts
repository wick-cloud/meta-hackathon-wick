import { Pool, types, type PoolClient } from 'pg';
import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
/** NUMERIC money remains a JSON number, as the existing cents API requires. */
export function parseDatabaseNumeric(value: string): number {
  const result = Number(value);
  if (!Number.isFinite(result) || Math.abs(result) > Number.MAX_SAFE_INTEGER / 100)
    throw new Error('Database numeric value exceeds the safe application range.');
  return result;
}
export function createPool(databaseUrl: string) {
  return new Pool({
    connectionString: databaseUrl,
    max: 20,
    connectionTimeoutMillis: 5000,
    idleTimeoutMillis: 30000,
    statement_timeout: 15000,
    idle_in_transaction_session_timeout: 15000,
    types: {
      getTypeParser: (oid, format) =>
        oid === 1700 && format !== 'binary'
          ? parseDatabaseNumeric
          : types.getTypeParser(oid, format),
    },
  });
}
async function migrationFiles(directory: string) {
  const files = new Map<string, { sql: string; sha256: string }>();
  for (const name of (await readdir(directory)).filter((n) => /^\d+.*\.sql$/.test(n)).sort()) {
    const sql = await readFile(resolve(directory, name), 'utf8');
    files.set(name, { sql, sha256: createHash('sha256').update(sql).digest('hex') });
  }
  return files;
}

/** Production startup validates the pre-deployed schema without applying application DDL. */
export async function verifyMigrations(pool: Pool, directory = resolve('migrations')) {
  const files = await migrationFiles(directory);
  const applied = (
    await pool.query<{ name: string; sha256: string | null }>(
      'SELECT name,sha256 FROM broker_migrations',
    )
  ).rows;
  if (
    applied.length !== files.size ||
    applied.some((row) => files.get(row.name)?.sha256 !== row.sha256)
  )
    throw new Error(
      'Database migration history differs from this release. Run the migration command before starting.',
    );
}

export async function migrate(pool: Pool, directory = resolve('migrations')) {
  const files = await migrationFiles(directory);
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock(872193410)');
    await client.query(
      'CREATE TABLE IF NOT EXISTS broker_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now(), sha256 text)',
    );
    await client.query('ALTER TABLE broker_migrations ADD COLUMN IF NOT EXISTS sha256 text');
    const applied = (
      await client.query<{ name: string; sha256: string | null }>(
        'SELECT name,sha256 FROM broker_migrations',
      )
    ).rows;
    for (const row of applied) {
      const file = files.get(row.name);
      if (!file || (row.sha256 !== null && row.sha256 !== file.sha256))
        throw new Error(`Applied migration differs from this release: ${row.name}`);
    }
    for (const [name, { sql, sha256 }] of files) {
      if (applied.some((row) => row.name === name)) {
        // Legacy databases have no historical digest. Establish a baseline once; never
        // claim this proves the contents that were applied before checksums existed.
        await client.query(
          'UPDATE broker_migrations SET sha256=$2 WHERE name=$1 AND sha256 IS NULL',
          [name, sha256],
        );
        continue;
      }
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO broker_migrations(name,sha256) VALUES($1,$2)', [
          name,
          sha256,
        ]);
        await client.query('COMMIT');
      } catch (e) {
        await client.query('ROLLBACK');
        throw e;
      }
    }
  } finally {
    try {
      await client.query('SELECT pg_advisory_unlock(872193410)');
    } finally {
      client.release();
    }
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
