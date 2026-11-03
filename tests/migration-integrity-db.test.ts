import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Pool } from 'pg';
import { describe, expect, it } from 'vitest';
import { migrate, verifyMigrations } from '../src/server/db.js';

describe.skipIf(!process.env.TEST_DATABASE_URL)('migration release integrity', () => {
  it('baselines legacy history once, detects edits, and validates without DDL', async () => {
    const schema = `integrity_${randomUUID().replaceAll('-', '')}`;
    const directory = await mkdtemp(join(tmpdir(), 'broker-migrations-'));
    const admin = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
    await admin.query(`CREATE SCHEMA ${schema}`);
    const pool = new Pool({
      connectionString: process.env.TEST_DATABASE_URL,
      options: `-c search_path=${schema},public`,
    });
    try {
      await pool.query(
        'CREATE TABLE broker_migrations(name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())',
      );
      await pool.query("INSERT INTO broker_migrations(name) VALUES('001_initial.sql')");
      await pool.query('CREATE TABLE preserved(value text)');
      await pool.query("INSERT INTO preserved VALUES('existing record')");
      await writeFile(join(directory, '001_initial.sql'), 'CREATE TABLE preserved(value text);');
      await migrate(pool, directory);
      await verifyMigrations(pool, directory);
      expect((await pool.query('SELECT value FROM preserved')).rows).toEqual([
        { value: 'existing record' },
      ]);
      expect((await pool.query('SELECT sha256 FROM broker_migrations')).rows[0].sha256).toMatch(
        /^[a-f0-9]{64}$/,
      );
      await writeFile(join(directory, '001_initial.sql'), 'DROP TABLE preserved;');
      await expect(migrate(pool, directory)).rejects.toThrow('Applied migration differs');
      await expect(verifyMigrations(pool, directory)).rejects.toThrow('migration history differs');
      expect((await pool.query('SELECT count(*) FROM preserved')).rows[0].count).toBe('1');
      await writeFile(join(directory, '001_initial.sql'), 'CREATE TABLE preserved(value text);');
      await writeFile(join(directory, '002_new.sql'), 'CREATE TABLE additional(value text);');
      await expect(verifyMigrations(pool, directory)).rejects.toThrow('migration history differs');
      await migrate(pool, directory);
      await pool.query('BEGIN READ ONLY');
      await verifyMigrations(pool, directory);
      await pool.query('ROLLBACK');
      await rm(join(directory, '002_new.sql'));
      await expect(migrate(pool, directory)).rejects.toThrow('Applied migration differs');
    } finally {
      await pool.end();
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
