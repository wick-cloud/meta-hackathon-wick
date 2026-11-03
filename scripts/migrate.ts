import { loadConfig } from '../src/server/config.js';
import { createPool, migrate } from '../src/server/db.js';
import { PgBoss } from 'pg-boss';
const config = loadConfig();
const pool = createPool(config.databaseUrl);
const boss = new PgBoss({
  connectionString: config.databaseUrl,
  schema: 'pgboss',
  supervise: false,
  schedule: false,
  connectionTimeoutMillis: 5000,
  options: '-c statement_timeout=15000 -c idle_in_transaction_session_timeout=15000',
});
boss.on('error', () => console.error('Queue migration failed.'));
try {
  await migrate(pool);
  await boss.start();
  console.log('Database migrations applied.');
} finally {
  await boss.stop();
  await pool.end();
}
