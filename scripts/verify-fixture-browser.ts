import 'dotenv/config';
import { randomUUID, randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { hashPassword } from 'better-auth/crypto';
import { loadConfig } from '../src/server/config.js';
import { createPool, migrate } from '../src/server/db.js';
import { createWickAdapter } from '../src/server/integrations/wick.js';
import { seedMarketplace } from '../src/server/marketplace/index.js';
import { buildApp } from '../src/server/app.js';
import type { Actor } from '../src/shared/types.js';

// This harness creates fresh test identities; it never runs the account-reset seed.
const testUrl = new URL(process.env.TEST_DATABASE_URL || 'invalid:');
const previewUrl = process.env.DATABASE_URL ? new URL(process.env.DATABASE_URL) : undefined;
if (
  !['postgres:', 'postgresql:'].includes(testUrl.protocol) ||
  !['localhost', '127.0.0.1', '[::1]'].includes(testUrl.hostname) ||
  !/test/i.test(testUrl.pathname) ||
  (previewUrl && testUrl.pathname === previewUrl.pathname)
)
  throw new Error('A distinct local TEST_DATABASE_URL with test in its database name is required.');
const port = Number(process.env.FIXTURE_BROWSER_PORT || 3301);
if (!Number.isInteger(port) || port < 1024 || port > 65535 || port === 3000)
  throw new Error('Choose an isolated test port; port 3000 is reserved for preview.');
const appUrl = `http://127.0.0.1:${port}`;
const runId = randomUUID();
const password = randomBytes(32).toString('base64url');
const config = loadConfig({
  NODE_ENV: 'test',
  PORT: String(port),
  HOST: '127.0.0.1',
  APP_URL: appUrl,
  DATABASE_URL: testUrl.href,
  BETTER_AUTH_SECRET: randomBytes(32).toString('hex'),
  WICK_MODE: 'fixture',
  MUSE_MODE: 'fixture',
  LOG_LEVEL: 'silent',
});
const pool = createPool(config.databaseUrl);
const lock = await pool.connect();
let running: Awaited<ReturnType<typeof buildApp>> | undefined;
try {
  const exclusive = await lock.query('SELECT pg_try_advisory_lock(872193415) AS locked');
  if (!exclusive.rows[0].locked)
    throw new Error('Another offline browser harness owns this database.');
  await migrate(pool);
  const actors: Actor[] = [
    {
      id: randomUUID(),
      email: `buyer-${runId}@test.invalid`,
      name: 'Fixture buyer',
      role: 'buyer',
    },
    {
      id: randomUUID(),
      email: `provider-${runId}@test.invalid`,
      name: 'Fixture demo supplier',
      role: 'provider',
    },
    {
      id: randomUUID(),
      email: `admin-${runId}@test.invalid`,
      name: 'Fixture admin',
      role: 'admin',
    },
  ];
  const hash = await hashPassword(password);
  for (const actor of actors) {
    await pool.query(
      'INSERT INTO "user"(id,email,name,role,"emailVerified") VALUES($1,$2,$3,$4,true)',
      [actor.id, actor.email, actor.name, actor.role],
    );
    await pool.query(
      'INSERT INTO account(id,"accountId","providerId","userId",password) VALUES($1,$2,\'credential\',$2,$3)',
      [randomUUID(), actor.id, hash],
    );
  }
  await seedMarketplace(pool, actors, await createWickAdapter(config, pool).catalog(), 'fixture');
  await pool.query(
    'UPDATE "user" u SET "providerId"=p.id FROM broker_providers p WHERE p.user_id=u.id AND u.id=$1',
    [actors[1]!.id],
  );
  running = await buildApp(config, { clientRoot: resolve('.verify-dist/client') });
  await running.app.listen({ port, host: '127.0.0.1' });
  const artifacts = resolve(
    process.env.FIXTURE_BROWSER_ARTIFACTS || 'test-results/offline-browser',
  );
  await mkdir(artifacts, { recursive: true, mode: 0o700 });
  const exitCode = await new Promise<number>((done, reject) => {
    const child = spawn(
      process.execPath,
      ['node_modules/@playwright/test/cli.js', 'test', '--output', resolve(artifacts, 'results')],
      {
        stdio: 'inherit',
        env: {
          ...process.env,
          NODE_ENV: 'test',
          DATABASE_URL: testUrl.href,
          APP_URL: appUrl,
          E2E_BASE_URL: appUrl,
          WICK_MODE: 'fixture',
          MUSE_MODE: 'fixture',
          WICK_API_KEY: '',
          BASETEN_API_KEY: '',
          META_API_KEY: '',
          SEED_BUYER_EMAIL: actors[0]!.email,
          E2E_BUYER_EMAIL: actors[0]!.email,
          SEED_SUPPLIER_A_EMAIL: actors[1]!.email,
          E2E_PROVIDER_EMAIL: actors[1]!.email,
          SEED_ADMIN_EMAIL: actors[2]!.email,
          SEED_BUYER_PASSWORD: password,
          SEED_SUPPLIER_A_PASSWORD: password,
          SEED_ADMIN_PASSWORD: password,
          PLAYWRIGHT_HTML_OUTPUT_DIR: resolve(artifacts, 'html'),
        },
      },
    );
    child.once('error', reject);
    child.once('exit', (code) => done(code ?? 1));
  });
  process.exitCode = exitCode;
} finally {
  await running?.app.close();
  await lock.query('SELECT pg_advisory_unlock(872193415)');
  lock.release();
  await pool.end();
}
