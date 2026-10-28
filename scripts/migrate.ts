import { loadConfig } from '../src/server/config.js';
import { createPool, migrate } from '../src/server/db.js';
const pool = createPool(loadConfig().databaseUrl);
try {
  await migrate(pool);
  console.log('Database migrations applied.');
} finally {
  await pool.end();
}
