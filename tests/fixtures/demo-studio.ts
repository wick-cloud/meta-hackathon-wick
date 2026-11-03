import { randomBytes, randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import { Pool } from 'pg';
import { expect, vi } from 'vitest';
import { createAuth, createRequireActor } from '../../src/server/auth.js';
import { registerStudio } from '../../src/server/coding/studio-api.js';
import { loadConfig } from '../../src/server/config.js';
import type { AppContext } from '../../src/server/context.js';
import { migrate, transaction } from '../../src/server/db.js';
import { demoTerminalActor, reconcileDemo, registerDemo } from '../../src/server/demo/index.js';
import { reconcileDisk } from '../../src/server/disks/index.js';
import { registerInference } from '../../src/server/inference/index.js';
import { closeTokenAuction, initializeInference } from '../../src/server/inference/market.js';
import { createInferenceRuntime, fixtureInputTokens } from '../../src/server/inference/runtime.js';
import { createMuseAdapter } from '../../src/server/integrations/muse.js';
import { createWickAdapter } from '../../src/server/integrations/wick.js';
import { awardHeldBid, submitBid } from '../../src/server/marketplace/auction.js';
import { cleanupVm, provisionVm } from '../../src/server/marketplace/lifecycle.js';
import type { Actor, CatalogItem } from '../../src/shared/types.js';

export const demoOrigin = 'http://localhost:3000';
export type DemoGuest = { ip: string; cookie: string };
let network = 1;
export const demoGuest = (ip = `198.51.100.${network++}`): DemoGuest => ({
  ip,
  cookie: `wick_demo=${randomBytes(32).toString('base64url')}`,
});
export const demoHeaders = (guest: DemoGuest) => ({
  origin: demoOrigin,
  'x-real-ip': guest.ip,
  cookie: guest.cookie,
});

/** Local fixture supply only. Each caller owns and drops a separate PostgreSQL schema. */
export async function createDemoStudioFixture(databaseUrl: string) {
  const schema = `demo_studio_${randomUUID().replaceAll('-', '')}`;
  const admin = new Pool({ connectionString: databaseUrl });
  await admin.query(`CREATE SCHEMA ${schema}`);
  const pool = new Pool({
    connectionString: databaseUrl,
    options: `-c search_path=${schema},public`,
    max: 12,
  });
  await migrate(pool);
  const config = loadConfig({
    NODE_ENV: 'test',
    APP_URL: demoOrigin,
    DATABASE_URL: databaseUrl,
    BETTER_AUTH_SECRET: 'studio-demo-fixture-auth-secret-more-than-32-characters',
    AUTH_TRUST_RAILWAY_PROXY: 'true',
    WICK_MODE: 'fixture',
    MUSE_MODE: 'fixture',
    INFERENCE_MARKET_MODE: 'fixture',
    DISKS_ENABLED: 'true',
    LIVE_DEMO_ENABLED: 'true',
    LIVE_DEMO_ALLOW_FIXTURES: 'true',
  });
  const auth = createAuth(config, pool);
  const commands = vi.fn(async (_id: string, _input: { command: string }) => ({
    stdout: 'WICK_DEMO_SCRIPT_READY',
    stderr: '',
    exitCode: 0,
    simulated: true,
  }));
  const ctx = {
    config,
    pool,
    boss: { send: vi.fn(async () => randomUUID()) },
    wick: { ...createWickAdapter(config, pool), runCommand: commands },
    muse: createMuseAdapter(config),
    inference: await createInferenceRuntime(config),
    requireActor: createRequireActor(auth, pool),
  } as unknown as AppContext;
  const app = Fastify({ logger: false });
  app.setErrorHandler((error, _request, reply) => {
    const e = error as Error & { statusCode?: number; code?: string; retryAfter?: number };
    if (e.retryAfter !== undefined) reply.header('Retry-After', e.retryAfter);
    return reply
      .code(e.statusCode ?? (e.name === 'ZodError' ? 400 : 500))
      .send({ error: e.message, code: e.code });
  });
  await registerDemo(app, ctx);
  await registerInference(app, ctx);
  registerStudio(app, ctx);
  app.get('/api/me', async (request) => ({ user: await ctx.requireActor(request) }));
  app.get('/terminal-identity/:id', async (request) => demoTerminalActor(ctx, request));
  await app.ready();
  const catalogs = ['modal', 'e2b'].map((provider): CatalogItem => ({
    id: provider === 'modal' ? 'modal:micro:auto' : 'e2b:micro:us',
    name: `${provider} Micro`,
    provider,
    profile: 'micro',
    region: provider === 'modal' ? 'auto' : 'us',
    cpu: 1,
    memoryGb: 1,
    durationMinutes: [15, 30, 60],
    approved: true,
    capabilities: ['persistent-drives'],
    description: 'Local Studio demo fixture',
    organizationId: 'demo-organization',
    groupId: 'demo-group',
  }));
  const sellers: Actor[] = catalogs.map((item) => ({
    id: randomUUID(),
    providerId: randomUUID(),
    role: 'provider',
    name: item.provider,
    email: `${item.provider}@studio-demo.invalid`,
  }));
  async function reset() {
    await pool.query(
      'TRUNCATE "user",broker_catalog,broker_providers,broker_inference_routes,broker_demo_days,broker_fixture_environments,broker_fixture_drives,broker_operation_receipts CASCADE',
    );
    commands.mockReset();
    commands.mockResolvedValue({
      stdout: 'WICK_DEMO_SCRIPT_READY',
      stderr: '',
      exitCode: 0,
      simulated: true,
    });
    ctx.inference = await createInferenceRuntime(config);
    ctx.inference.dispatch = vi.fn(async (_route, input, id) => ({
      id: `fixture_${id}`,
      content: JSON.stringify({ source: "print('Hello, World!')\n" }),
      finishReason: 'stop',
      inputTokens: fixtureInputTokens(input),
      outputTokens: 32,
    }));
    for (const [i, item] of catalogs.entries()) {
      const seller = sellers[i]!;
      await pool.query(
        'INSERT INTO "user"(id,email,name,role,"providerId") VALUES($1,$2,$3,$4,$5)',
        [seller.id, seller.email, seller.name, seller.role, seller.providerId],
      );
      await pool.query(
        'INSERT INTO broker_providers(id,user_id,name,total_capacity,policy,cloud_provider) VALUES($1,$2,$3,5,$4,$5)',
        [
          seller.providerId,
          seller.id,
          seller.name,
          {
            autoBid: true,
            basePriceCents: 8,
            minimumPriceCents: 1,
            maxPriceCents: 100,
            allowedCatalogIds: [item.id],
          },
          item.provider,
        ],
      );
      await pool.query(
        "INSERT INTO broker_catalog(id,item,approved,source_mode) VALUES($1,$2,true,'fixture')",
        [item.id, item],
      );
      await pool.query(
        "INSERT INTO broker_offerings(provider_id,catalog_id,name,description,price_cents) VALUES($1,$2,$3,'Local fixture',8)",
        [seller.providerId, item.id, item.name],
      );
    }
    await initializeInference(ctx);
  }
  const row = async (id: string) =>
    (await pool.query('SELECT * FROM broker_demo_runs WHERE id=$1', [id])).rows[0];
  const studio = async (id: string) =>
    (await pool.query('SELECT * FROM broker_demo_studio WHERE run_id=$1', [id])).rows[0];
  const read = async (guest: DemoGuest) =>
    (await app.inject({ method: 'GET', url: '/api/demo', headers: demoHeaders(guest) })).json();
  const start = (guest: DemoGuest, kind?: string, operationKey = randomUUID(), extra = {}) =>
    app.inject({
      method: 'POST',
      url: '/api/demo/start',
      headers: demoHeaders(guest),
      payload: { operationKey, ...(kind === undefined ? {} : { kind }), ...extra },
    });
  const end = (guest: DemoGuest) =>
    app.inject({
      method: 'POST',
      url: '/api/demo/end',
      headers: demoHeaders(guest),
      payload: { operationKey: randomUUID() },
    });
  async function ready(guest: DemoGuest, kind: 'terminal' | 'studio' = 'studio') {
    const response = await start(guest, kind);
    expect(response.statusCode, response.body).toBe(200);
    const id = response.json().run.id;
    await reconcileDemo(ctx, id);
    let run = await row(id);
    await pool.query(
      "UPDATE broker_token_orders SET closes_at=clock_timestamp()-interval '1 second' WHERE id=$1",
      [run.token_order_id],
    );
    await closeTokenAuction(ctx, run.token_order_id);
    await reconcileDemo(ctx, id);
    run = await row(id);
    await reconcileDisk(ctx, run.disk_id);
    await reconcileDemo(ctx, id);
    run = await row(id);
    await submitBid(ctx, sellers[0]!, run.request_id, { totalPriceCents: 8 });
    await submitBid(ctx, sellers[1]!, run.request_id, { totalPriceCents: 5 });
    // Advance the domain fixture via the existing award primitive. Never alter
    // the immutable compute clock or a live provider's bid/deadline policy.
    await transaction(pool, async (db) => {
      const request = (
        await db.query('SELECT * FROM broker_requests WHERE id=$1 FOR UPDATE', [run.request_id])
      ).rows[0];
      const bid = (
        await db.query(
          "SELECT * FROM broker_bids WHERE request_id=$1 AND provider_id=$2 AND status='held' FOR UPDATE",
          [run.request_id, sellers[0]!.providerId],
        )
      ).rows[0];
      await awardHeldBid(ctx, db, request, bid);
    });
    const vm = (await pool.query('SELECT * FROM broker_vms WHERE request_id=$1', [run.request_id]))
      .rows[0];
    await provisionVm(ctx, vm.id);
    await pool.query(
      "UPDATE broker_fixture_environments SET ready_at=clock_timestamp()-interval '1 second'",
    );
    await provisionVm(ctx, vm.id);
    await reconcileDemo(ctx, id);
    return row(id);
  }
  async function cleanup(id: string) {
    await reconcileDemo(ctx, id);
    let run = await row(id);
    if (run.vm_id) {
      await cleanupVm(ctx, run.vm_id);
      await pool.query(
        "UPDATE broker_fixture_environments SET termination_requested_at=clock_timestamp()-interval '1 second' WHERE status='terminating'",
      );
      await cleanupVm(ctx, run.vm_id);
    }
    await reconcileDemo(ctx, id);
    run = await row(id);
    if (run.disk_id) await reconcileDisk(ctx, run.disk_id);
    await reconcileDemo(ctx, id);
    return row(id);
  }
  async function close() {
    await app.close();
    await pool.end();
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.end();
  }
  return { app, ctx, pool, commands, reset, row, studio, read, start, end, ready, cleanup, close };
}
