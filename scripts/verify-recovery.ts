import 'dotenv/config';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Pool } from 'pg';

/** Local integration verification only. No external API or compute allocation is allowed. */
function configuredUrl(value: string, name: string): URL {
  try {
    return new URL(value);
  } catch {
    throw new Error(`${name} must be a valid URL.`);
  }
}
const appUrl = configuredUrl(process.env.APP_URL ?? 'http://localhost:3000', 'APP_URL');
const databaseUrl = configuredUrl(process.env.DATABASE_URL ?? '', 'DATABASE_URL');
const loopback = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);
assert(
  process.env.WICK_MODE === 'fixture' && process.env.MUSE_MODE === 'fixture',
  'Recovery verification requires both explicit fixture modes.',
);
assert(
  appUrl.protocol === 'http:' && loopback.has(appUrl.hostname),
  'Recovery verification requires a plain HTTP loopback APP_URL.',
);
assert(!appUrl.username && !appUrl.password, 'APP_URL must not contain credentials.');
assert(
  loopback.has(databaseUrl.hostname),
  'Recovery verification requires a loopback PostgreSQL database.',
);
assert(
  process.env.SEED_BUYER_PASSWORD,
  'Supply the seeded buyer password through the environment.',
);
const serverEntry = resolve('dist/src/server/index.js');
assert(
  existsSync(serverEntry) && existsSync(resolve('dist/client/index.html')),
  'Run npm run build before verifying recovery.',
);
const port = Number(appUrl.port || 80);
assert(Number(process.env.PORT ?? 3000) === port, 'PORT must match APP_URL.');

const pool = new Pool({ connectionString: databaseUrl.toString(), max: 2 });
let child: ChildProcess | undefined;
let cookie = '';
let requestId: string | undefined;
let vmId: string | undefined;
let cleanupConfirmed = false;

async function until<T>(
  label: string,
  operation: () => Promise<T | undefined>,
  timeout = 65_000,
): Promise<T> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const result = await operation();
    if (result !== undefined) return result;
    await delay(300);
  }
  throw new Error(`Timed out: ${label}`);
}

async function startApp() {
  child = spawn(process.execPath, [serverEntry], {
    cwd: process.cwd(),
    env: { ...process.env, NODE_ENV: 'test', HOST: '0.0.0.0', LOG_LEVEL: 'warn' },
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  await until(
    'application readiness',
    async () => {
      if (!child || child.exitCode !== null || child.signalCode !== null)
        throw new Error(`Application exited before readiness (${child?.exitCode}).`);
      try {
        const response = await fetch(new URL('/ready', appUrl), {
          signal: AbortSignal.timeout(1000),
        });
        return response.ok ? true : undefined;
      } catch {
        return undefined;
      }
    },
    20_000,
  );
}

async function stopApp() {
  if (!child || child.exitCode !== null) {
    child = undefined;
    return;
  }
  const running = child;
  const exited = once(running, 'exit');
  running.kill('SIGTERM');
  let timer: ReturnType<typeof setTimeout> | undefined;
  const result = await Promise.race([
    exited.then(([code]) => ({ exited: true, code })),
    new Promise<{ exited: boolean; code: null }>((resolve) => {
      timer = setTimeout(() => resolve({ exited: false, code: null }), 28_000);
    }),
  ]).finally(() => clearTimeout(timer));
  if (!result.exited) {
    running.kill('SIGKILL');
    await exited;
  }
  child = undefined;
  assert(
    result.exited && result.code === 0,
    'The application must shut down gracefully with exit code zero.',
  );
}

async function api(path: string, method = 'GET', body?: unknown) {
  const response = await fetch(new URL(path, appUrl), {
    method,
    headers: {
      Cookie: cookie,
      Origin: appUrl.origin,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(10_000),
  });
  assert(response.ok, `${method} ${path} returned HTTP ${response.status}.`);
  return response.json();
}

async function snapshot() {
  const result = await pool.query(
    `SELECT v.id,v.create_key,v.environment_id,v.expires_at::text,
    v.ready_at::text,i.id AS invoice_id,i.total_cents,h.released_at::text
    FROM broker_vms v JOIN broker_holds h ON h.bid_id=v.bid_id
    LEFT JOIN broker_invoices i ON i.vm_id=v.id WHERE v.id=$1`,
    [vmId],
  );
  assert.equal(result.rowCount, 1);
  return result.rows[0];
}

try {
  let alreadyRunning = false;
  try {
    await fetch(new URL('/health', appUrl), { signal: AbortSignal.timeout(1000) });
    alreadyRunning = true;
  } catch {}
  assert(
    !alreadyRunning,
    'Stop the existing local preview before running this script. It manages one app process at a time.',
  );
  await startApp();
  const signedIn = await fetch(new URL('/api/auth/sign-in/email', appUrl), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: appUrl.origin },
    body: JSON.stringify({
      email: process.env.SEED_BUYER_EMAIL ?? 'buyer@demo.wick.local',
      password: process.env.SEED_BUYER_PASSWORD,
    }),
  });
  assert(signedIn.ok, `Local fixture buyer sign-in returned ${signedIn.status}.`);
  cookie = signedIn.headers
    .getSetCookie()
    .map((value) => value.split(';')[0])
    .join('; ');
  assert(cookie, 'Better Auth must return a session cookie.');
  const me = await api('/api/me');
  assert.equal(me.modes.wick, 'fixture');
  assert.equal(me.modes.muse, 'fixture');
  const catalog = me.catalog.find(
    (item: { approved: boolean; durationMinutes: number[] }) =>
      item.approved && item.durationMinutes.includes(30),
  );
  assert(catalog, 'The local fixture catalog must have an approved 30-minute configuration.');
  const request = await api('/api/requests', 'POST', {
    description: `Local process restart verification ${new Date().toISOString()}`,
    catalogId: catalog.id,
    region: catalog.region,
    durationMinutes: 30,
    maxPriceCents: 10_000,
    requirements: {
      cpu: catalog.cpu,
      memoryGb: catalog.memoryGb,
      ...(catalog.gpu ? { gpu: catalog.gpu } : {}),
    },
  });
  requestId = request.id;
  console.log('Recovery check: real database auction created; restarting before close.');
  await stopApp();
  await startApp();
  const recovered = await api(`/api/requests/${requestId}`);
  assert.equal(
    recovered.request.closesAt,
    request.closesAt,
    'Restart must not reset the auction deadline.',
  );
  assert.equal(recovered.request.description, request.description);
  await until('durable auction, provisioning and readiness', async () => {
    const detail = await api(`/api/requests/${requestId}`);
    vmId = detail.vm?.id;
    if (['failed', 'cancelled', 'no_offers'].includes(detail.request.status))
      throw new Error(
        `Auction ended as ${detail.request.status}: ${detail.request.failureReason ?? ''}`,
      );
    return detail.vm?.status === 'running' ? true : undefined;
  });
  const before = await snapshot();
  assert(
    before.environment_id &&
      before.create_key &&
      before.expires_at &&
      before.ready_at &&
      before.invoice_id,
  );
  assert.equal(before.released_at, null, 'The winner capacity slot remains held while running.');
  console.log('Recovery check: VM running and one invoice recorded; restarting again.');
  await stopApp();
  await startApp();
  const active = await api(`/api/vms/${vmId}`);
  assert.equal(active.status, 'running');
  assert.deepEqual(
    await snapshot(),
    before,
    'Restart must preserve environment, create key, exact expiry, readiness, quote and invoice.',
  );
  const counts = await pool.query(
    `SELECT (SELECT count(*) FROM broker_vms WHERE request_id=$1)::int AS vms,
    (SELECT count(*) FROM broker_invoices WHERE vm_id=$2)::int AS invoices,
    (SELECT count(*) FROM broker_fixture_environments WHERE create_key=$3)::int AS environments`,
    [requestId, vmId, before.create_key],
  );
  assert.deepEqual(counts.rows[0], { vms: 1, invoices: 1, environments: 1 });
  await api(`/api/vms/${vmId}/terminate`, 'POST');
  await until(
    'confirmed fixture cleanup',
    async () => {
      const state = await pool.query('SELECT cleanup_confirmed_at FROM broker_vms WHERE id=$1', [
        vmId,
      ]);
      return state.rows[0]?.cleanup_confirmed_at ? true : undefined;
    },
    30_000,
  );
  cleanupConfirmed = true;
  assert.notEqual(
    (await snapshot()).released_at,
    null,
    'Confirmed cleanup releases the winner slot.',
  );
  assert.equal(
    (await snapshot()).invoice_id,
    before.invoice_id,
    'Early termination retains the same fixed invoice.',
  );
  console.log(
    'PASS: auction and running VM survived two graceful process restarts; session, create key, environment, expiry and single invoice persisted; cleanup confirmed.',
  );
} finally {
  if (child && requestId && !cleanupConfirmed) {
    try {
      const detail = await api(`/api/requests/${requestId}`);
      vmId = detail.vm?.id;
      if (vmId) await api(`/api/vms/${vmId}/terminate`, 'POST');
      else if (detail.request.status === 'open')
        await api(`/api/requests/${requestId}/cancel`, 'POST');
    } catch {
      console.error('Local verification cleanup needs a retry after the app restarts.');
    }
  }
  try {
    await stopApp();
  } finally {
    await pool.end();
  }
}
