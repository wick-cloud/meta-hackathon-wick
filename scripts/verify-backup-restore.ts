/** Disposable fixture databases only. Never backs up or restores an existing application DB. */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { Pool } from 'pg';
import { migrate, verifyMigrations } from '../src/server/db.js';

const target = new URL(process.env.TEST_DATABASE_URL ?? '');
assert(['postgres:', 'postgresql:'].includes(target.protocol), 'Use a PostgreSQL test URL.');
assert(
  ['127.0.0.1', 'localhost', '[::1]'].includes(target.hostname),
  'Restore verification requires a loopback test server.',
);
assert(!target.search, 'Use a test URL without connection overrides.');
const id = randomUUID().replaceAll('-', '');
const sourceName = `restore_source_${id}`,
  restoredName = `restore_target_${id}`;
const directory = await mkdtemp(join(tmpdir(), 'broker-restore-'));
const dump = join(directory, 'fixture.dump');
const admin = new Pool({ connectionString: target.href });
const created: string[] = [];
const pools: Pool[] = [];
const exec = promisify(execFile);
const connect = (name: string) => {
  const url = new URL(target);
  url.pathname = '/' + name;
  const pool = new Pool({ connectionString: url.href });
  pools.push(pool);
  return pool;
};
function postgresEnv(name: string) {
  return {
    PATH: process.env.PATH,
    PGHOST: target.hostname.replace(/^\[|\]$/g, ''),
    PGPORT: target.port || '5432',
    PGUSER: decodeURIComponent(target.username),
    PGPASSWORD: decodeURIComponent(target.password),
    PGDATABASE: name,
    PGCONNECT_TIMEOUT: '5',
  };
}
try {
  const serverMajor = Math.floor(
    Number((await admin.query('SHOW server_version_num')).rows[0].server_version_num) / 10000,
  );
  for (const tool of ['pg_dump', 'pg_restore']) {
    const version = await exec(tool, ['--version'], {
      env: postgresEnv(sourceName),
      timeout: 5000,
    });
    const clientMajor = Number(/PostgreSQL\) (\d+)/.exec(version.stdout)?.[1]);
    assert.equal(
      clientMajor,
      serverMajor,
      `${tool} must match the PostgreSQL server major version; select matching client tools in PATH.`,
    );
  }
  for (const name of [sourceName, restoredName]) {
    await admin.query(`CREATE DATABASE ${name}`);
    created.push(name);
  }
  const source = connect(sourceName);
  await migrate(source);
  await source.query(
    "INSERT INTO broker_credit_wallets(buyer_id,balance_cents,reserved_cents) VALUES('restore-fixture',100,20)",
  );
  await source.query(
    "INSERT INTO broker_credit_ledger(buyer_id,operation_key,kind,amount_cents,reserved_delta_cents,description,input_fingerprint) VALUES('restore-fixture','restore-grant','grant',100,0,'Restore fixture','restore-fingerprint')",
  );
  const snapshot = async (pool: Pool) => ({
    wallets: (await pool.query('SELECT * FROM broker_credit_wallets ORDER BY buyer_id')).rows,
    ledger: (await pool.query('SELECT * FROM broker_credit_ledger ORDER BY id')).rows,
    migrations: (await pool.query('SELECT * FROM broker_migrations ORDER BY name')).rows,
  });
  const before = await snapshot(source);
  await exec('pg_dump', ['--format=custom', '--no-owner', '--no-privileges', '--file', dump], {
    env: postgresEnv(sourceName),
    timeout: 60000,
    maxBuffer: 1024 * 1024,
  });
  await exec(
    'pg_restore',
    ['--exit-on-error', '--no-owner', '--no-privileges', '--dbname', restoredName, dump],
    {
      env: postgresEnv(restoredName),
      timeout: 60000,
      maxBuffer: 1024 * 1024,
    },
  );
  const restored = connect(restoredName);
  await verifyMigrations(restored);
  assert.deepEqual(
    await snapshot(restored),
    before,
    'Wallet, ledger and migration records must survive restoration exactly.',
  );
  console.log(
    'Backup restore passed: disposable fixture schema, wallet, ledger and migration digests preserved.',
  );
} finally {
  await Promise.all(pools.map((pool) => pool.end()));
  try {
    for (const name of created.reverse()) await admin.query(`DROP DATABASE ${name}`);
  } finally {
    await admin.end();
    await rm(directory, { recursive: true, force: true });
  }
}
