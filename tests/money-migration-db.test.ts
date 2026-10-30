import { randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { Pool } from 'pg';
import { describe, expect, it } from 'vitest';
import { migrate } from '../src/server/db.js';

describe.skipIf(!process.env.TEST_DATABASE_URL)('money migration on existing data', () => {
  it('preserves cent balances and append-only history, and rejects finer values without rounding', async () => {
    const schema = `money_${randomUUID().replaceAll('-', '')}`;
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
      for (const name of (await readdir('migrations'))
        .filter((n) => /^\d+.*\.sql$/.test(n) && n < '020')
        .sort()) {
        await pool.query(await readFile(`migrations/${name}`, 'utf8'));
        await pool.query('INSERT INTO broker_migrations(name) VALUES($1)', [name]);
      }
      await pool.query(
        "INSERT INTO broker_credit_wallets(buyer_id,balance_cents,reserved_cents) VALUES('existing-owner',2500,1000)",
      );
      await pool.query(
        "INSERT INTO broker_credit_ledger(buyer_id,operation_key,kind,amount_cents,reserved_delta_cents,description,input_fingerprint) VALUES('existing-owner','old-credit','grant',2500,0,'Existing credit','existing-fingerprint')",
      );
      const snapshot = async () => ({
        wallet: (
          await pool.query(
            'SELECT buyer_id,balance_cents::text,reserved_cents::text FROM broker_credit_wallets',
          )
        ).rows,
        history: (
          await pool.query(
            'SELECT id,buyer_id,operation_key,amount_cents::text,reserved_delta_cents::text,input_fingerprint FROM broker_credit_ledger',
          )
        ).rows,
      });
      const before = await snapshot();
      await migrate(pool);
      await migrate(pool);
      expect(await snapshot()).toEqual(before);
      await pool.query(
        "UPDATE broker_credit_wallets SET balance_cents=2500.01 WHERE buyer_id='existing-owner'",
      );
      expect(
        (await pool.query('SELECT balance_cents FROM broker_credit_wallets')).rows[0].balance_cents,
      ).toBe(2500.01);
      await expect(
        pool.query(
          "UPDATE broker_credit_wallets SET balance_cents=2500.001 WHERE buyer_id='existing-owner'",
        ),
      ).rejects.toMatchObject({ code: '23514' });
      expect(
        (await pool.query('SELECT balance_cents FROM broker_credit_wallets')).rows[0].balance_cents,
      ).toBe(2500.01);
    } finally {
      await pool.end();
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    }
  });
});
