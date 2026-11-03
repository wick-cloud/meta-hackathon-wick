import { randomBytes, randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import websocket from '@fastify/websocket';
import WebSocket from 'ws';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAuth, createRequireActor } from '../src/server/auth.js';
import { loadConfig } from '../src/server/config.js';
import type { AppContext } from '../src/server/context.js';
import { migrate, transaction } from '../src/server/db.js';
import {
  registerDemo,
  reconcileDemo,
  maintainDemo,
  demoTerminalActor,
} from '../src/server/demo/index.js';
import { reconcileDisk } from '../src/server/disks/index.js';
import { createInferenceRuntime } from '../src/server/inference/runtime.js';
import { registerInference } from '../src/server/inference/index.js';
import { initializeInference, closeTokenAuction } from '../src/server/inference/market.js';
import { createMuseAdapter } from '../src/server/integrations/muse.js';
import { createWickAdapter } from '../src/server/integrations/wick.js';
import { registerTerminal } from '../src/server/integrations/terminal.js';
import { awardHeldBid, closeAuction, submitBid } from '../src/server/marketplace/auction.js';
import { cleanupVm, provisionVm } from '../src/server/marketplace/lifecycle.js';
import type { DemoState } from '../src/shared/demo.js';
import type { Actor, CatalogItem } from '../src/shared/types.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
const origin = 'http://localhost:3000';
const modalCatalog: CatalogItem = {
  id: 'modal:micro:auto',
  name: 'Modal Micro',
  provider: 'modal',
  profile: 'micro',
  region: 'auto',
  cpu: 1,
  memoryGb: 1,
  durationMinutes: [15, 30, 60],
  approved: true,
  capabilities: ['persistent-drives'],
  description: 'An explicit fixture for the fixed demo route.',
  organizationId: 'demo-organization',
  groupId: 'demo-group',
};
const e2bCatalog: CatalogItem = {
  ...modalCatalog,
  id: 'e2b:micro:us',
  name: 'E2B Micro',
  provider: 'e2b',
  region: 'us',
};

describe.skipIf(!databaseUrl)(
  'homepage guest admission and lifecycle (disposable PostgreSQL)',
  () => {
    const schema = `homepage_demo_${randomUUID().replaceAll('-', '')}`;
    const sellers: Actor[] = [
      {
        id: randomUUID(),
        role: 'provider',
        email: 'baseten@demo-test.invalid',
        name: 'Baseten',
        providerId: '10000000-0000-4000-8000-000000000001',
      },
      {
        id: randomUUID(),
        role: 'provider',
        email: 'modal@demo-test.invalid',
        name: 'Modal',
        providerId: '20000000-0000-4000-8000-000000000002',
      },
    ];
    let admin: Pool,
      pool: Pool,
      app: FastifyInstance,
      ctx: AppContext,
      socketOrigin = '';
    let testNetwork = 100;
    const sockets: WebSocket[] = [];
    const commands = vi.fn(async () => ({
      stdout: 'WICK_DEMO_SCRIPT_READY',
      stderr: '',
      exitCode: 0,
      simulated: true,
    }));
    beforeAll(async () => {
      admin = new Pool({ connectionString: databaseUrl });
      await admin.query(`CREATE SCHEMA ${schema}`);
      pool = new Pool({
        connectionString: databaseUrl,
        options: `-c search_path=${schema},public`,
        max: 16,
      });
      await migrate(pool);
      const config = loadConfig({
        NODE_ENV: 'test',
        APP_URL: origin,
        DATABASE_URL: databaseUrl!,
        BETTER_AUTH_SECRET: 'homepage-demo-fixture-auth-secret-more-than-32-characters',
        AUTH_TRUST_RAILWAY_PROXY: 'true',
        WICK_MODE: 'fixture',
        MUSE_MODE: 'fixture',
        INFERENCE_MARKET_MODE: 'fixture',
        DISKS_ENABLED: 'true',
        LIVE_DEMO_ENABLED: 'true',
        LIVE_DEMO_ALLOW_FIXTURES: 'true',
      });
      const auth = createAuth(config, pool);
      ctx = {
        config,
        pool,
        boss: { send: vi.fn(async () => randomUUID()) },
        wick: { ...createWickAdapter(config, pool), runCommand: commands },
        muse: createMuseAdapter(config),
        inference: await createInferenceRuntime(config),
        requireActor: createRequireActor(auth, pool),
      } as unknown as AppContext;
      app = Fastify({ logger: false });
      app.setErrorHandler((error, _request, reply) => {
        const e = error as Error & { statusCode?: number; code?: string; retryAfter?: number };
        if (e.retryAfter !== undefined) reply.header('Retry-After', e.retryAfter);
        return reply
          .code(e.statusCode ?? (e.name === 'ZodError' ? 400 : 500))
          .send({ error: e.message, code: e.code });
      });
      await app.register(websocket);
      await registerDemo(app, ctx);
      await registerInference(app, ctx);
      await registerTerminal(app, ctx);
      app.get('/terminal-identity/:id', async (request) => demoTerminalActor(ctx, request));
      app.get('/api/me', async (request) => ({ user: await ctx.requireActor(request) }));
      for (const path of ['/api/requests', '/api/studio/tasks', '/api/keys', '/api/disks'])
        app.post(path, async (request) => ({ actor: await ctx.requireActor(request, ['buyer']) }));
      await app.ready();
      await app.listen({ host: '127.0.0.1', port: 0 });
      const address = app.server.address();
      if (!address || typeof address === 'string')
        throw new Error('Missing fixture listen address');
      socketOrigin = `ws://127.0.0.1:${address.port}`;
    });
    beforeEach(async () => {
      testNetwork++;
      for (const socket of sockets) socket.terminate();
      sockets.length = 0;
      await pool.query(
        'TRUNCATE "user",broker_catalog,broker_providers,broker_inference_routes,broker_demo_days,broker_fixture_environments,broker_fixture_drives,broker_operation_receipts CASCADE',
      );
      ctx.config.liveDemoEnabled = true;
      ctx.config.liveDemoAllowFixtures = true;
      ctx.config.authTrustRailwayProxy = true;
      ctx.config.nodeEnv = 'test';
      ctx.config.disksEnabled = true;
      ctx.wick.runCommand = commands;
      commands.mockClear();
      ctx.inference = await createInferenceRuntime(ctx.config);
      for (const [i, seller] of sellers.entries()) {
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
              allowedCatalogIds: [i === 1 ? modalCatalog.id : e2bCatalog.id],
            },
            i === 1 ? 'modal' : 'e2b',
          ],
        );
      }
      await pool.query(
        "INSERT INTO broker_catalog(id,item,approved,source_mode) VALUES($1,$2,true,'fixture')",
        [modalCatalog.id, modalCatalog],
      );
      await pool.query(
        "INSERT INTO broker_catalog(id,item,approved,source_mode) VALUES($1,$2,true,'fixture')",
        [e2bCatalog.id, e2bCatalog],
      );
      await pool.query(
        "INSERT INTO broker_offerings(provider_id,catalog_id,name,description,price_cents) VALUES($1,$2,'Modal Micro','Fixture demo supply',8)",
        [sellers[1]!.providerId, modalCatalog.id],
      );
      await pool.query(
        "INSERT INTO broker_offerings(provider_id,catalog_id,name,description,price_cents) VALUES($1,$2,'E2B Micro','Fixture demo supply',5)",
        [sellers[0]!.providerId, e2bCatalog.id],
      );
      await initializeInference(ctx);
    });
    afterAll(async () => {
      for (const socket of sockets) socket.terminate();
      await app?.close();
      await pool?.end();
      if (admin) {
        await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
        await admin.end();
      }
    });

    const headers = (ip: string, cookie = '') => ({
      origin,
      'x-real-ip': ip,
      ...(cookie ? { cookie } : {}),
    });
    async function visitor(ip = `192.0.2.${testNetwork}`) {
      const response = await app.inject({ method: 'GET', url: '/api/demo', headers: headers(ip) });
      expect(response.statusCode).toBe(200);
      // Model a previously issued opaque browser secret without creating a DB identity.
      // A separate HTTP test below covers registration before the first start.
      expect(response.headers['set-cookie']).toBeUndefined();
      const cookie = `wick_demo=${randomBytes(32).toString('base64url')}`;
      return { ip, cookie, state: response.json<DemoState>() };
    }
    async function start(
      client: { ip: string; cookie: string },
      operationKey = randomUUID(),
      extra = {},
    ) {
      return app.inject({
        method: 'POST',
        url: '/api/demo/start',
        headers: headers(client.ip, client.cookie),
        payload: { operationKey, ...extra },
      });
    }
    async function row(id: string) {
      return (await pool.query('SELECT * FROM broker_demo_runs WHERE id=$1', [id])).rows[0];
    }
    async function read(client: { ip: string; cookie: string }) {
      const response = await app.inject({
        method: 'GET',
        url: '/api/demo',
        headers: headers(client.ip, client.cookie),
      });
      expect(response.statusCode).toBe(200);
      return response.json<DemoState>();
    }
    async function reachVmAuction(client: Awaited<ReturnType<typeof visitor>>) {
      const response = await start(client);
      expect(response.statusCode, response.body).toBe(200);
      const id = response.json<DemoState>().run!.id;
      await reconcileDemo(ctx, id);
      let current = await row(id);
      expect(current.status).toBe('auction');
      expect(current.token_order_id).toBeTruthy();
      const tokenOrder = (
        await pool.query('SELECT * FROM broker_token_orders WHERE id=$1', [current.token_order_id])
      ).rows[0];
      expect(tokenOrder).toMatchObject({
        status: 'open',
        input_tokens: 5000,
        output_tokens: 2048,
        max_total_cents: 5,
      });
      expect(current.disk_id).toBeNull();
      expect(current.request_id).toBeNull();
      await pool.query(
        "UPDATE broker_token_orders SET closes_at=clock_timestamp()-interval '1 second' WHERE id=$1",
        [current.token_order_id],
      );
      await closeTokenAuction(ctx, current.token_order_id);
      await reconcileDemo(ctx, id);
      current = await row(id);
      expect(current.pack_id).toBeTruthy();
      expect(current.disk_id).toBeTruthy();
      await reconcileDisk(ctx, current.disk_id);
      await reconcileDemo(ctx, id);
      current = await row(id);
      expect(current.request_id, current.message).toBeTruthy();
      return current;
    }
    async function readyRun(client: Awaited<ReturnType<typeof visitor>>, bootstrap = true) {
      const current = await reachVmAuction(client);
      await submitBid(ctx, sellers[0]!, current.request_id, { totalPriceCents: 5 });
      await submitBid(ctx, sellers[1]!, current.request_id, { totalPriceCents: 8 });
      await closeAuction(ctx, current.request_id);
      expect(
        (await pool.query('SELECT status FROM broker_requests WHERE id=$1', [current.request_id]))
          .rows[0].status,
      ).toBe('open');
      // The immutable 30-second request clock is deliberately left intact. The
      // shared award primitive advances this domain fixture; browser coverage
      // exercises the real deadline instead of sleeping in every unit scenario.
      await transaction(pool, async (db) => {
        const request = (
          await db.query('SELECT * FROM broker_requests WHERE id=$1 FOR UPDATE', [
            current.request_id,
          ])
        ).rows[0];
        const bid = (
          await db.query(
            "SELECT * FROM broker_bids WHERE request_id=$1 AND provider_id=$2 AND status='held' FOR UPDATE",
            [current.request_id, sellers[1]!.providerId],
          )
        ).rows[0];
        await awardHeldBid(ctx, db, request, bid);
      });
      const vm = (
        await pool.query('SELECT * FROM broker_vms WHERE request_id=$1', [current.request_id])
      ).rows[0];
      expect(vm).toBeDefined();
      await provisionVm(ctx, vm.id);
      await pool.query(
        "UPDATE broker_fixture_environments SET ready_at=clock_timestamp()-interval '1 second'",
      );
      await provisionVm(ctx, vm.id);
      if (!bootstrap) return { ...(await row(current.id)), vm_id: vm.id };
      await reconcileDemo(ctx, current.id);
      const ready = await row(current.id);
      expect(ready.status, ready.message).toBe('ready');
      return ready;
    }
    async function end(client: Awaited<ReturnType<typeof visitor>>) {
      const response = await app.inject({
        method: 'POST',
        url: '/api/demo/end',
        headers: headers(client.ip, client.cookie),
        payload: { operationKey: randomUUID() },
      });
      expect(response.statusCode, response.body).toBe(200);
      return response.json<DemoState>();
    }
    async function openTerminal(client: Awaited<ReturnType<typeof visitor>>, vmId: string) {
      const socket = new WebSocket(`${socketOrigin}/api/vms/${vmId}/terminal`, {
        headers: headers(client.ip, client.cookie),
      });
      sockets.push(socket);
      await new Promise<void>((resolve, reject) => {
        socket.once('error', reject);
        socket.on('message', (data) => {
          if (JSON.parse(data.toString()).type === 'ready') resolve();
        });
      });
      return socket;
    }
    async function useTerminal(socket: WebSocket) {
      const output = new Promise<void>((resolve, reject) => {
        const closed = () => reject(new Error('The active terminal closed before responding.'));
        const message = (data: WebSocket.RawData) => {
          const frame = JSON.parse(data.toString());
          if (
            frame.type === 'output' &&
            Buffer.from(frame.data, 'base64').toString('utf8') === '/workspace (simulated)\r\n'
          ) {
            socket.off('message', message);
            socket.off('close', closed);
            resolve();
          }
        };
        socket.once('close', closed);
        socket.on('message', message);
      });
      socket.send(JSON.stringify({ type: 'input', data: 'pwd\r' }));
      await output;
    }
    async function finishCleanup(runId: string) {
      let current = await row(runId);
      await reconcileDemo(ctx, runId);
      current = await row(runId);
      if (current.vm_id) {
        await cleanupVm(ctx, current.vm_id);
        await pool.query(
          "UPDATE broker_fixture_environments SET termination_requested_at=clock_timestamp()-interval '1 second' WHERE status='terminating'",
        );
        await cleanupVm(ctx, current.vm_id);
      }
      await reconcileDemo(ctx, runId);
      current = await row(runId);
      if (current.disk_id) await reconcileDisk(ctx, current.disk_id);
      await reconcileDemo(ctx, runId);
      return row(runId);
    }

    it('keeps homepage status read-only and disabled by default', async () => {
      ctx.config.liveDemoEnabled = false;
      const guest = await visitor();
      expect(guest.state.enabled).toBe(false);
      expect(guest.state.available).toBe(false);
      expect(guest.state.run).toBeNull();
      expect((await pool.query('SELECT count(*)::int n FROM broker_demo_visitors')).rows[0].n).toBe(
        0,
      );
      expect((await pool.query('SELECT count(*)::int n FROM "user"')).rows[0].n).toBe(
        sellers.length,
      );
      expect((await start(guest)).statusCode).toBeGreaterThanOrEqual(400);
      expect((await pool.query('SELECT count(*)::int n FROM broker_demo_runs')).rows[0].n).toBe(0);
      expect(commands).not.toHaveBeenCalled();
    });

    it('stores an opaque guest digest without creating ordinary login credentials or sessions', async () => {
      const guest = await visitor();
      expect(guest.state.available).toBe(true);
      const response = await start(guest);
      expect(response.statusCode, response.body).toBe(200);
      const run = response.json<DemoState>().run!;
      const stored = await row(run.id);
      const identity = (
        await pool.query('SELECT * FROM broker_demo_visitors WHERE id=$1', [stored.visitor_id])
      ).rows[0];
      expect(identity.secret_digest).toMatch(/^[a-f0-9]{64}$/);
      expect(JSON.stringify(identity)).not.toContain(guest.cookie.split('=')[1]);
      expect(
        (
          await pool.query('SELECT count(*)::int n FROM account WHERE "userId"=$1', [
            stored.buyer_id,
          ])
        ).rows[0].n,
      ).toBe(0);
      expect(
        (
          await pool.query('SELECT count(*)::int n FROM session WHERE "userId"=$1', [
            stored.buyer_id,
          ])
        ).rows[0].n,
      ).toBe(0);
      const publicBody = JSON.stringify(await read(guest));
      expect(publicBody).not.toContain('secret_digest');
      expect(publicBody).not.toContain('ip_digest');
      expect(publicBody).not.toContain(stored.buyer_id);
      expect(stored.reserved_cents).toBe(50);
    });

    it('registers a durable browser cookie before any demo resources are admitted', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/demo/session',
        headers: headers('192.0.2.44'),
        payload: {},
      });
      expect(response.statusCode, response.body).toBe(204);
      const cookie = response.headers['set-cookie'];
      expect(cookie).toEqual(expect.stringContaining('wick_demo='));
      expect(cookie).toEqual(expect.stringContaining('HttpOnly'));
      expect(cookie).toEqual(expect.stringContaining('SameSite=Strict'));
      expect(cookie).not.toEqual(expect.stringContaining('better-auth'));
      expect((await pool.query('SELECT count(*)::int n FROM broker_demo_runs')).rows[0].n).toBe(0);
      expect((await pool.query('SELECT count(*)::int n FROM broker_demo_visitors')).rows[0].n).toBe(
        0,
      );
      expect((await pool.query('SELECT count(*)::int n FROM broker_demo_days')).rows[0].n).toBe(0);
      const guest = { ip: '192.0.2.44', cookie: String(cookie).split(';')[0]! };
      const renewed = await app.inject({
        method: 'POST',
        url: '/api/demo/session',
        headers: headers(guest.ip, guest.cookie),
        payload: {},
      });
      expect(renewed.statusCode).toBe(204);
      expect(renewed.headers['set-cookie']).toBe(cookie);
      expect((await start(guest)).statusCode).toBe(200);
    });

    it('cannot allocate a demo until the browser sends its saved cookie back', async () => {
      for (const cookie of ['', 'wick_demo=invalid']) {
        const response = await app.inject({
          method: 'POST',
          url: '/api/demo/start',
          headers: headers(`192.0.2.${testNetwork}`, cookie),
          payload: { operationKey: randomUUID() },
        });
        expect(response.statusCode).toBe(409);
        expect(response.headers['set-cookie']).toBeUndefined();
        expect(response.json().error).toContain('Enable cookies');
      }
      expect((await pool.query('SELECT count(*)::int n FROM broker_demo_runs')).rows[0].n).toBe(0);
      expect((await pool.query('SELECT count(*)::int n FROM broker_demo_days')).rows[0].n).toBe(0);
    });

    it('recovers an admitted run with the pre-saved cookie after losing its start response or changing IP', async () => {
      const ip = `192.0.2.${testNetwork}`;
      const registered = await app.inject({
        method: 'POST',
        url: '/api/demo/session',
        headers: headers(ip),
        payload: {},
      });
      const cookie = String(registered.headers['set-cookie']).split(';')[0]!;
      const started = await start({ ip, cookie });
      expect(started.statusCode).toBe(200);
      expect(started.headers['set-cookie']).toBeUndefined();
      // Only the cookie from registration survives. Reload/another tab does not
      // need the start response, operation key, or the network's original IP.
      const recovered = await read({ ip: '203.0.113.204', cookie });
      expect(recovered.run?.id).toBe(started.json<DemoState>().run!.id);
      expect((await pool.query('SELECT count(*)::int n FROM broker_demo_runs')).rows[0].n).toBe(1);
      expect((await read({ ip, cookie: '' })).run).toBeNull();
      expect(
        (await read({ ip, cookie: `wick_demo=${randomBytes(32).toString('base64url')}` })).run,
      ).toBeNull();
    });

    it('requires the application origin to register a demo browser', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/demo/session',
        headers: { ...headers(`192.0.2.${testNetwork}`), origin: 'https://untrusted.invalid' },
        payload: {},
      });
      expect(response.statusCode).toBe(403);
      expect(response.headers['set-cookie']).toBeUndefined();
    });

    it('allows shared-network status polling while enforcing its bounded read limit', async () => {
      // Keep this focused on HTTP throttling; status reads create no resources.
      ctx.config.liveDemoEnabled = false;
      const responses = await Promise.all(
        Array.from({ length: 180 }, () =>
          app.inject({
            method: 'GET',
            url: '/api/demo',
            headers: headers(`192.0.2.${testNetwork}`),
          }),
        ),
      );
      expect(responses.every((response) => response.statusCode === 200)).toBe(true);
      const limited = await app.inject({
        method: 'GET',
        url: '/api/demo',
        headers: headers(`192.0.2.${testNetwork}`),
      });
      expect(limited.statusCode).toBe(429);
      expect(limited.headers['retry-after']).toBeDefined();
      expect((await pool.query('SELECT count(*)::int n FROM broker_demo_runs')).rows[0].n).toBe(0);
    });

    it('does not treat a demo cookie as a signed-in buyer on existing APIs', async () => {
      const guest = await visitor();
      expect((await start(guest)).statusCode).toBe(200);
      expect(
        (
          await app.inject({
            method: 'GET',
            url: '/api/me',
            headers: headers(guest.ip, guest.cookie),
          })
        ).statusCode,
      ).toBe(401);
      for (const url of ['/api/requests', '/api/studio/tasks', '/api/keys', '/api/disks'])
        expect(
          (
            await app.inject({
              method: 'POST',
              url,
              headers: headers(guest.ip, guest.cookie),
              payload: {},
            })
          ).statusCode,
        ).toBe(401);
    });

    it('rejects browser-selected providers, sizes and resource budgets before reserving funding', async () => {
      const guest = await visitor();
      for (const extra of [
        { provider: 'modal' },
        { catalogId: 'modal:large:auto' },
        { budgetCents: 100000 },
        { durationMinutes: 60 },
        { command: 'arbitrary command' },
      ])
        expect((await start(guest, randomUUID(), extra)).statusCode).toBe(400);
      expect((await pool.query('SELECT count(*)::int n FROM broker_demo_runs')).rows[0].n).toBe(0);
      expect((await pool.query('SELECT count(*)::int n FROM broker_demo_days')).rows[0].n).toBe(0);
    });

    it('requires the configured origin for all anonymous demo mutations', async () => {
      const guest = await visitor();
      for (const requestHeaders of [
        { cookie: guest.cookie, 'x-real-ip': guest.ip },
        { ...headers(guest.ip, guest.cookie), origin: 'https://untrusted.invalid' },
        { ...headers(guest.ip, guest.cookie), 'sec-fetch-site': 'cross-site' },
      ]) {
        const response = await app.inject({
          method: 'POST',
          url: '/api/demo/start',
          headers: requestHeaders,
          payload: { operationKey: randomUUID() },
        });
        expect(response.statusCode).toBe(403);
      }
      expect((await pool.query('SELECT count(*)::int n FROM broker_demo_runs')).rows[0].n).toBe(0);
    });

    it('serializes concurrent starts and replays the same operation without extra reservations', async () => {
      const guest = await visitor();
      const operationKey = randomUUID();
      const responses = await Promise.all(
        Array.from({ length: 5 }, () => start(guest, operationKey)),
      );
      for (const response of responses) expect(response.statusCode, response.body).toBe(200);
      const ids = new Set(responses.map((response) => response.json<DemoState>().run!.id));
      expect(ids.size).toBe(1);
      expect((await pool.query('SELECT count(*)::int n FROM broker_demo_runs')).rows[0].n).toBe(1);
      expect(
        (await pool.query('SELECT sum(reserved_cents)::int n FROM broker_demo_days')).rows[0].n,
      ).toBe(50);
      const different = await start(guest);
      expect(different.statusCode, different.body).toBe(200);
      expect(different.json<DemoState>().run!.id).toBe([...ids][0]);
      expect((await read(guest)).run!.id).toBe([...ids][0]);
    });

    it('resumes one browser run across concurrent fresh keys and unavailable purchase prerequisites', async () => {
      const guest = await visitor();
      const responses = await Promise.all(
        Array.from({ length: 5 }, (_, i) =>
          start(guest, randomUUID(), { kind: i % 2 ? 'studio' : 'terminal' }),
        ),
      );
      for (const response of responses) expect(response.statusCode, response.body).toBe(200);
      const runs = responses.map((response) => response.json<DemoState>().run!);
      expect(new Set(runs.map((run) => run.id)).size).toBe(1);
      expect(new Set(runs.map((run) => run.kind)).size).toBe(1);
      ctx.config.disksEnabled = false;
      try {
        const resumed = await start(guest, randomUUID(), { kind: 'studio', demoName: 'Other' });
        expect(resumed.statusCode, resumed.body).toBe(200);
        expect(resumed.json<DemoState>().run).toMatchObject({
          id: runs[0]!.id,
          kind: runs[0]!.kind,
          demoName: '',
        });
      } finally {
        ctx.config.disksEnabled = true;
      }
      expect((await pool.query('SELECT count(*)::int n FROM broker_demo_runs')).rows[0].n).toBe(1);
      expect(
        (await pool.query('SELECT sum(reserved_cents)::int n FROM broker_demo_days')).rows[0].n,
      ).toBe(50);
      expect(
        (
          await pool.query(
            'SELECT count(*)::int n FROM broker_inference_grants WHERE buyer_id=$1',
            [(await row(runs[0]!.id)).buyer_id],
          )
        ).rows[0].n,
      ).toBe(1);
      expect(commands).not.toHaveBeenCalled();
    });

    it('durably replays a fresh resume key after cleanup and cooldown without another reservation', async () => {
      const guest = await visitor();
      const initial = await start(guest);
      expect(initial.statusCode, initial.body).toBe(200);
      const runId = initial.json<DemoState>().run!.id;
      const resumeKey = randomUUID();
      const input = { kind: 'studio', demoName: 'Alex' };
      const resumes = await Promise.all(
        Array.from({ length: 4 }, () => start(guest, resumeKey, input)),
      );
      for (const response of resumes) {
        expect(response.statusCode, response.body).toBe(200);
        expect(response.json<DemoState>().run).toMatchObject({
          id: runId,
          kind: 'terminal',
          demoName: '',
        });
      }
      expect((await start(guest, resumeKey, { kind: 'terminal' })).statusCode).toBe(409);
      expect((await start(guest, resumeKey, { ...input, demoName: 'Other' })).statusCode).toBe(409);
      expect(
        (
          await pool.query('SELECT * FROM broker_demo_start_replays WHERE operation_key=$1', [
            resumeKey,
          ])
        ).rows,
      ).toMatchObject([{ run_id: runId, requested_kind: 'studio', requested_name: 'Alex' }]);
      await pool.query(
        "UPDATE broker_demo_runs SET status='ended',ended_at=clock_timestamp(),vm_cleanup_at=clock_timestamp(),cooldown_until=clock_timestamp()-interval '1 second' WHERE id=$1",
        [runId],
      );
      expect((await read(guest)).available).toBe(true);
      const replay = await start(guest, resumeKey, input);
      expect(replay.statusCode, replay.body).toBe(200);
      expect(replay.json<DemoState>().run).toMatchObject({ id: runId, status: 'ended' });
      expect((await pool.query('SELECT count(*)::int n FROM broker_demo_runs')).rows[0].n).toBe(1);
      expect(
        (await pool.query('SELECT sum(reserved_cents)::int n FROM broker_demo_days')).rows[0].n,
      ).toBe(50);
    });

    it('rejects conflicting concurrent resume inputs without changing the existing task', async () => {
      const guest = await visitor();
      const initial = await start(guest);
      expect(initial.statusCode, initial.body).toBe(200);
      const runId = initial.json<DemoState>().run!.id;
      const resumeKey = randomUUID();
      const inputs = [{ kind: 'terminal' }, { kind: 'studio', demoName: 'Alex' }];
      const responses = await Promise.all(inputs.map((input) => start(guest, resumeKey, input)));
      expect(responses.map((response) => response.statusCode).sort()).toEqual([200, 409]);
      const acceptedIndex = responses.findIndex((response) => response.statusCode === 200);
      const replay = await start(guest, resumeKey, inputs[acceptedIndex]);
      expect(replay.statusCode, replay.body).toBe(200);
      expect(replay.json<DemoState>().run).toMatchObject({
        id: runId,
        kind: 'terminal',
        demoName: '',
      });
      expect(
        (await pool.query('SELECT count(*)::int n FROM broker_demo_start_replays')).rows[0].n,
      ).toBe(1);
      expect((await pool.query('SELECT count(*)::int n FROM broker_demo_runs')).rows[0].n).toBe(1);
      expect(
        (await pool.query('SELECT sum(reserved_cents)::int n FROM broker_demo_days')).rows[0].n,
      ).toBe(50);
    });

    it('cannot exceed the network allowance with a fresh cookie or forged forwarding chain', async () => {
      const first = await visitor();
      const ids: string[] = [];
      for (let i = 0; i < 3; i++) {
        const client = i === 0 ? first : await visitor(first.ip);
        const started = await start(client);
        expect(started.statusCode, started.body).toBe(200);
        ids.push(started.json<DemoState>().run!.id);
        if (i < 2)
          await pool.query(
            "UPDATE broker_demo_runs SET status='ended',ended_at=clock_timestamp(),vm_cleanup_at=clock_timestamp(),cooldown_until=clock_timestamp()+interval '20 minutes' WHERE id=$1",
            [ids[i]],
          );
      }
      const second = await visitor(first.ip);
      expect(second.cookie).not.toBe(first.cookie);
      const response = await app.inject({
        method: 'POST',
        url: '/api/demo/start',
        headers: { ...headers(second.ip, second.cookie), 'x-forwarded-for': '198.51.100.250' },
        payload: { operationKey: randomUUID() },
      });
      expect(response.statusCode).toBeGreaterThanOrEqual(400);
      expect((await pool.query('SELECT count(*)::int n FROM broker_demo_runs')).rows[0].n).toBe(3);
      expect(
        (await pool.query('SELECT count(DISTINCT ip_digest)::int n FROM broker_demo_runs')).rows[0]
          .n,
      ).toBe(1);
      expect((await read(second)).run).toBeNull();
      expect(JSON.stringify(await read(second))).not.toContain(ids[2]);
    });

    it('admits five concurrent runs and holds their slots until cleanup is confirmed', async () => {
      const clients = await Promise.all(
        Array.from({ length: 8 }, (_, i) => visitor(`192.0.2.${i + 1}`)),
      );
      const responses = await Promise.all(clients.map((client) => start(client)));
      const accepted = responses.filter((r) => r.statusCode === 200);
      expect(accepted).toHaveLength(5);
      const rejected = responses.filter((r) => r.statusCode !== 200);
      expect(rejected).toHaveLength(3);
      for (const response of rejected) {
        expect(response.statusCode, response.body).toBe(429);
        expect(response.json().error).toBe(
          'All 5 demo slots are in use. Please try again after a demo ends.',
        );
      }
      expect(
        (await pool.query('SELECT count(*)::int n FROM broker_demo_runs WHERE ended_at IS NULL'))
          .rows[0].n,
      ).toBe(5);
      expect(
        (await pool.query('SELECT sum(reserved_cents)::int n FROM broker_demo_days')).rows[0].n,
      ).toBe(250);

      const waiting = clients[responses.findIndex((response) => response.statusCode === 429)]!;
      const endingRun = accepted[0]!.json<DemoState>().run!.id;
      await pool.query(
        "UPDATE broker_demo_runs SET status='ending',stop_requested=true WHERE id=$1",
        [endingRun],
      );
      expect((await read(waiting)).available).toBe(false);
      expect((await start(waiting)).statusCode).toBe(429);
      await pool.query(
        "UPDATE broker_demo_runs SET status='ended',ended_at=clock_timestamp(),vm_cleanup_at=clock_timestamp(),cooldown_until=clock_timestamp()+interval '20 minutes' WHERE id=$1",
        [endingRun],
      );
      expect((await read(waiting)).available).toBe(true);
      const replacement = await start(waiting);
      expect(replacement.statusCode, replacement.body).toBe(200);
      expect(
        (await pool.query('SELECT count(*)::int n FROM broker_demo_runs WHERE ended_at IS NULL'))
          .rows[0].n,
      ).toBe(5);
      expect(
        (await pool.query('SELECT sum(reserved_cents)::int n FROM broker_demo_days')).rows[0].n,
      ).toBe(300);
    });

    it('keeps the three-run network allowance when five browser sessions race', async () => {
      const clients = await Promise.all(Array.from({ length: 5 }, () => visitor()));
      const responses = await Promise.all(clients.map((client) => start(client)));
      expect(responses.filter((response) => response.statusCode === 200)).toHaveLength(3);
      const rejected = responses.filter((response) => response.statusCode !== 200);
      expect(rejected).toHaveLength(2);
      for (const response of rejected) {
        expect(response.statusCode, response.body).toBe(429);
        expect(response.json().error).toContain('This network has used its demo allowance.');
      }
      expect(
        (await pool.query('SELECT sum(reserved_cents)::int n FROM broker_demo_days')).rows[0].n,
      ).toBe(150);
    });

    it('does not admit an eleventh fifty-cent daily reservation', async () => {
      const first = await visitor();
      const firstStart = await start(first);
      expect(firstStart.statusCode).toBe(200);
      await pool.query(
        "UPDATE broker_demo_runs SET status='ended',ended_at=clock_timestamp(),native_attempted_at=clock_timestamp(),cooldown_until=clock_timestamp()+interval '20 minutes'",
      );
      await pool.query('UPDATE broker_demo_days SET reserved_cents=500');
      const next = await visitor('192.0.2.99');
      const denied = await start(next);
      expect(denied.statusCode).toBeGreaterThanOrEqual(400);
      expect(
        (await pool.query('SELECT reserved_cents FROM broker_demo_days')).rows[0].reserved_cents,
      ).toBe(500);
      expect((await pool.query('SELECT count(*)::int n FROM broker_demo_runs')).rows[0].n).toBe(1);
    });

    it('keeps a browser cooldown but lets a shared network run a few demos', async () => {
      const end = (id: string, cooldown: Date) =>
        pool.query(
          "UPDATE broker_demo_runs SET status='ended',ended_at=clock_timestamp(),vm_cleanup_at=clock_timestamp(),cooldown_until=$2 WHERE id=$1",
          [id, cooldown],
        );
      const first = await visitor();
      const firstRun = (await start(first)).json<DemoState>().run!.id;
      const firstCooldown = new Date(Date.now() + 10 * 60000);
      await end(firstRun, firstCooldown);
      const current = await read(first);
      expect(current.cooldownUntil).toBe(firstCooldown.toISOString());
      expect(current.available).toBe(false);
      expect((await start(first)).statusCode).toBeGreaterThanOrEqual(400);

      // Others on the same network, including a browser that cleared its cookie, still start.
      const second = await visitor(first.ip);
      expect((await read(second)).available).toBe(true);
      const secondStart = await start(second);
      expect(secondStart.statusCode, secondStart.body).toBe(200);
      await end(secondStart.json<DemoState>().run!.id, new Date(Date.now() + 20 * 60000));
      const third = await visitor(first.ip);
      expect((await start(third)).statusCode).toBe(200);

      // The network's allowance is DEMO_NETWORK_RUNS active or cooling-down runs.
      const fourth = await visitor(first.ip);
      const blocked = await read(fourth);
      expect(blocked).toMatchObject({
        available: false,
        reason:
          'This network has used its demo allowance. Please try again after a demo ends or cools down.',
        cooldownUntil: firstCooldown.toISOString(),
      });
      expect((await start(fourth)).statusCode).toBe(429);
      expect((await visitor('192.0.2.200')).state.available).toBe(true);

      await pool.query(
        "UPDATE broker_demo_runs SET cooldown_until=clock_timestamp()-interval '1 second' WHERE id=$1",
        [firstRun],
      );
      const admitted = await start(fourth);
      expect(admitted.statusCode, admitted.body).toBe(200);
    });

    it('fails closed when paid-mode prerequisites or the exact demo compute route are missing', async () => {
      const guest = await visitor();
      ctx.config.nodeEnv = 'production';
      expect((await start(guest)).statusCode).toBeGreaterThanOrEqual(400);
      ctx.config.nodeEnv = 'test';
      ctx.config.disksEnabled = false;
      expect((await start(guest)).statusCode).toBeGreaterThanOrEqual(400);
      ctx.config.disksEnabled = true;
      await pool.query('UPDATE broker_catalog SET approved=false WHERE id=$1', [modalCatalog.id]);
      expect((await start(guest)).statusCode).toBeGreaterThanOrEqual(400);
      expect((await pool.query('SELECT count(*)::int n FROM broker_demo_runs')).rows[0].n).toBe(0);
      expect(commands).not.toHaveBeenCalled();
    });

    it('runs genuine fixture auctions in order with every qualified token seller and exact Modal compute', async () => {
      const guest = await visitor();
      const current = await readyRun(guest);
      const grant = (
        await pool.query('SELECT * FROM broker_inference_grants WHERE id=$1', [current.grant_id])
      ).rows[0];
      expect(grant.allowed_providers).toEqual(['modal', 'baseten']);
      expect(grant.max_purchase_cents).toBe(5);
      expect(grant.allow_instant).toBe(false);
      const pack = (
        await pool.query('SELECT * FROM broker_token_packs WHERE id=$1', [current.pack_id])
      ).rows[0];
      // Both qualified Muse sellers genuinely bid; the lowest accepted bid supplies the pack.
      const tokenBids = (
        await pool.query(
          'SELECT provider,price_cents FROM broker_token_bids WHERE order_id=$1 ORDER BY price_cents,provider',
          [current.token_order_id],
        )
      ).rows;
      expect(tokenBids.map((b) => b.provider).sort()).toEqual(['baseten', 'modal']);
      expect(pack.provider).toBe(tokenBids[0].provider);
      const request = (
        await pool.query('SELECT * FROM broker_requests WHERE id=$1', [current.request_id])
      ).rows[0];
      expect(request).toMatchObject({
        catalog_id: modalCatalog.id,
        duration_minutes: 15,
        region: 'any',
        disk_id: current.disk_id,
      });
      expect(request.catalog_snapshot).toMatchObject({ provider: 'modal', profile: 'micro' });
      expect(
        (await pool.query('SELECT count(*)::int n FROM broker_fixture_environments')).rows[0].n,
      ).toBe(1);
      expect(
        (await pool.query('SELECT count(*)::int n FROM broker_fixture_drives')).rows[0].n,
      ).toBe(1);
      expect(commands).toHaveBeenCalledTimes(1);
      const view = await read(guest);
      expect(view.run!.tokens!.provider).toBe(pack.provider);
      expect(view.run!.tokens!.bids).toHaveLength(2);
      expect(view.run!.vm!.provider).toBe('modal');
      expect(view.run!.vm).toMatchObject({
        priceCents: 1,
        grossPriceCents: 8,
        sponsorCreditCents: 7,
      });
      // The script's receipt.json repeats the same public award the homepage shows.
      const bootstrap = (commands.mock.calls[0] as unknown as [string, { command: string }])[1];
      const encodedReceipt = bootstrap.command.match(
        /f\.write_bytes\(base64\.b64decode\("([A-Za-z0-9+/=]+)"\)\)/,
      )?.[1];
      const receipt = JSON.parse(Buffer.from(encodedReceipt!, 'base64').toString());
      expect(receipt.compute).toMatchObject({
        winner: 'Modal',
        size: 'Micro',
        leaseMinutes: 15,
        paid: '$0.01',
        grossBid: '$0.08',
        sponsorCredit: '$0.07',
      });
      expect(receipt.compute.bids).toHaveLength(view.run!.vm!.bids.length);
      expect(receipt.tokens).toMatchObject({
        seller: pack.provider === 'modal' ? 'Modal' : 'Baseten',
        input: 5000,
        output: 2048,
      });
      expect(receipt.tokens.paid).toBe(
        view.run!.tokens!.priceCents === null ? null : `$${view.run!.tokens!.priceCents / 100}`,
      );
      expect(view.run!.vm!.bids).toEqual([
        expect.objectContaining({
          provider: 'e2b',
          catalogId: e2bCatalog.id,
          priceCents: 5,
          grossPriceCents: 5,
          sponsorCreditCents: 0,
        }),
        expect.objectContaining({
          provider: 'modal',
          catalogId: modalCatalog.id,
          priceCents: 1,
          grossPriceCents: 8,
          sponsorCreditCents: 7,
        }),
      ]);
      expect(view.run!.vm!.terminalPath).toBe(`/api/vms/${current.vm_id}/terminal`);
      expect(view.run!.canIssueKey).toBe(true);
      expect(JSON.stringify(view)).not.toContain('fixture_');
      expect(JSON.stringify(view)).not.toContain('secret_digest');
    });

    it('recovers committed resource identities after a worker checkpoint is lost without reallocation', async () => {
      const guest = await visitor();
      const current = await readyRun(guest);
      await pool.query(
        'UPDATE broker_demo_runs SET disk_id=NULL,request_id=NULL,token_order_id=NULL,pack_id=NULL,vm_id=NULL WHERE id=$1',
        [current.id],
      );
      await maintainDemo(ctx);
      await Promise.all([reconcileDemo(ctx, current.id), reconcileDemo(ctx, current.id)]);
      const recovered = await row(current.id);
      for (const field of ['disk_id', 'request_id', 'token_order_id', 'pack_id', 'vm_id'])
        expect(recovered[field]).toBe(current[field]);
      expect(recovered.status).toBe('ready');
      expect(commands).toHaveBeenCalledTimes(1);
      expect((await pool.query('SELECT count(*)::int n FROM broker_token_orders')).rows[0].n).toBe(
        1,
      );
      expect(
        (await pool.query('SELECT count(*)::int n FROM broker_fixture_environments')).rows[0].n,
      ).toBe(1);
      expect(
        (await pool.query('SELECT count(*)::int n FROM broker_fixture_drives')).rows[0].n,
      ).toBe(1);
    });

    it('keeps a bootstrapped terminal ready in its final 30 seconds and revokes it at actual expiry', async () => {
      const guest = await visitor();
      const current = await readyRun(guest);
      const expiresAt = new Date(Date.now() + 20_000);
      await pool.query('UPDATE broker_vms SET expires_at=$2 WHERE id=$1', [
        current.vm_id,
        expiresAt,
      ]);
      await pool.query('UPDATE broker_demo_runs SET expires_at=$2 WHERE id=$1', [
        current.id,
        expiresAt,
      ]);
      const socket = await openTerminal(guest, current.vm_id);

      await reconcileDemo(ctx, current.id);
      expect(await row(current.id)).toMatchObject({
        status: 'ready',
        stop_requested: false,
        expires_at: expiresAt,
      });
      expect((await read(guest)).run!.vm!.terminalPath).toBe(`/api/vms/${current.vm_id}/terminal`);
      expect(commands).toHaveBeenCalledTimes(1);
      await useTerminal(socket);

      const closed = new Promise<void>((resolve) => socket.once('close', () => resolve()));
      const expiredAt = new Date(Date.now() - 1000);
      await pool.query('UPDATE broker_vms SET expires_at=$2 WHERE id=$1', [
        current.vm_id,
        expiredAt,
      ]);
      await pool.query('UPDATE broker_demo_runs SET expires_at=$2 WHERE id=$1', [
        current.id,
        expiredAt,
      ]);
      await reconcileDemo(ctx, current.id);
      expect(await row(current.id)).toMatchObject({ status: 'ending', stop_requested: true });
      expect((await read(guest)).run!.vm!.terminalPath).toBeNull();
      const denied = await app.inject({
        method: 'GET',
        url: `/terminal-identity/${current.vm_id}`,
        headers: headers(guest.ip, guest.cookie),
      });
      expect(denied.statusCode).toBe(403);
      await closed;
      expect((await finishCleanup(current.id)).status).toBe('ended');
    });

    it('still refuses to bootstrap a VM with fewer than 30 seconds remaining', async () => {
      const guest = await visitor();
      const current = await readyRun(guest, false);
      await pool.query(
        "UPDATE broker_vms SET expires_at=clock_timestamp()+interval '20 seconds' WHERE id=$1",
        [current.vm_id],
      );
      await reconcileDemo(ctx, current.id);
      expect(await row(current.id)).toMatchObject({
        status: 'ending',
        stop_requested: true,
        failed: true,
        bootstrap_started_at: null,
        bootstrap_completed_at: null,
      });
      expect(commands).not.toHaveBeenCalled();
      expect((await read(guest)).run!.vm!.terminalPath).toBeNull();
      expect((await finishCleanup(current.id)).status).toBe('failed');
    });

    it('keeps the terminal usable and reconnectable after both model requests are used', async () => {
      const guest = await visitor();
      const current = await readyRun(guest);
      const socket = await openTerminal(guest, current.vm_id);
      const issued = await app.inject({
        method: 'POST',
        url: '/api/demo/key',
        headers: headers(guest.ip, guest.cookie),
        payload: { operationKey: randomUUID() },
      });
      expect(issued.statusCode, issued.body).toBe(200);
      const request = () =>
        app.inject({
          method: 'POST',
          url: '/api/v1/chat/completions',
          headers: { authorization: `Bearer ${issued.json().token}` },
          payload: {
            operationKey: randomUUID(),
            model: 'meta/muse-spark-open',
            messages: [{ role: 'user', content: 'Hello Muse' }],
            max_tokens: 1024,
          },
        });
      for (let call = 0; call < 2; call++) {
        const completion = await request();
        expect(completion.statusCode, completion.body).toBe(200);
      }
      const exhausted = await request();
      expect(exhausted.statusCode, exhausted.body).toBe(429);
      expect(exhausted.json().code).toBe('demo_request_limit');

      await reconcileDemo(ctx, current.id);
      expect(await row(current.id)).toMatchObject({
        status: 'ready',
        stop_requested: false,
        ended_at: null,
        expires_at: current.expires_at,
      });
      expect(
        (await pool.query('SELECT status,expires_at FROM broker_vms WHERE id=$1', [current.vm_id]))
          .rows[0],
      ).toMatchObject({ status: 'running', expires_at: current.expires_at });
      const state = await read(guest);
      expect(state.run!.tokens!.requestsUsed).toBe(2);
      expect(state.run!.canIssueKey).toBe(false);
      expect(state.run!.vm!.terminalPath).toBe(`/api/vms/${current.vm_id}/terminal`);
      await useTerminal(socket);
      await useTerminal(await openTerminal(guest, current.vm_id));
      expect(commands).toHaveBeenCalledTimes(1);
    });

    it('admits only the owner terminal, revokes its socket on End, and cleans the private resources', async () => {
      const guest = await visitor();
      const current = await readyRun(guest);
      const terminalUrl = `/terminal-identity/${current.vm_id}`;
      const owner = await app.inject({
        method: 'GET',
        url: terminalUrl,
        headers: headers(guest.ip, guest.cookie),
      });
      expect(owner.statusCode, owner.body).toBe(200);
      expect(owner.json().id).toBe(current.buyer_id);
      const other = await visitor('192.0.2.79');
      expect(
        (
          await app.inject({
            method: 'GET',
            url: terminalUrl,
            headers: headers(other.ip, other.cookie),
          })
        ).statusCode,
      ).toBe(403);
      expect(
        (
          await app.inject({
            method: 'GET',
            url: `/terminal-identity/${randomUUID()}`,
            headers: headers(guest.ip, guest.cookie),
          })
        ).statusCode,
      ).toBe(403);
      const issued = await app.inject({
        method: 'POST',
        url: '/api/demo/key',
        headers: headers(guest.ip, guest.cookie),
        payload: { operationKey: randomUUID() },
      });
      expect(issued.statusCode, issued.body).toBe(200);
      expect(issued.json().token).toMatch(/^wbk_/);
      const socket = new WebSocket(`${socketOrigin}/api/vms/${current.vm_id}/terminal`, {
        headers: headers(guest.ip, guest.cookie),
      });
      sockets.push(socket);
      await new Promise<void>((resolve, reject) => {
        socket.once('error', reject);
        socket.on('message', (data) => {
          if (JSON.parse(data.toString()).type === 'ready') resolve();
        });
      });
      const closed = new Promise<void>((resolve) => socket.once('close', () => resolve()));
      await end(guest);
      expect(
        (
          await app.inject({
            method: 'GET',
            url: terminalUrl,
            headers: headers(guest.ip, guest.cookie),
          })
        ).statusCode,
      ).toBe(403);
      await closed;
      const ended = await finishCleanup(current.id);
      expect(ended.status, ended.message).toBe('ended');
      expect(ended.ended_at).toBeInstanceOf(Date);
      expect(ended.cooldown_until.getTime() - ended.vm_cleanup_at.getTime()).toBe(20 * 60000);
      expect(
        (await pool.query('SELECT status FROM broker_disks WHERE id=$1', [current.disk_id])).rows[0]
          .status,
      ).toBe('deleted');
      expect(
        (
          await pool.query('SELECT status FROM broker_inference_grants WHERE id=$1', [
            current.grant_id,
          ])
        ).rows[0].status,
      ).toBe('closed');
      expect(
        (
          await pool.query(
            'SELECT count(*)::int n FROM broker_api_keys WHERE user_id=$1 AND revoked_at IS NULL',
            [current.buyer_id],
          )
        ).rows[0].n,
      ).toBe(0);
      expect(
        (await pool.query('SELECT reserved_cents FROM broker_demo_days')).rows[0].reserved_cents,
      ).toBe(50);
      const receipt = await read(guest);
      expect(receipt.run!.canIssueKey).toBe(false);
      expect(receipt.run!.vm!.terminalPath).toBeNull();
      expect(receipt.cooldownUntil).toBe(ended.cooldown_until.toISOString());
    });

    it('holds admission and disk ownership until an uncertain VM termination is confirmed', async () => {
      const guest = await visitor();
      const current = await readyRun(guest);
      await end(guest);
      await reconcileDemo(ctx, current.id);
      const originalGet = ctx.wick.get;
      ctx.wick.get = async () => {
        throw new Error('Uncertain native cleanup fixture');
      };
      try {
        await cleanupVm(ctx, current.vm_id);
        await reconcileDemo(ctx, current.id);
        const pending = await row(current.id);
        expect(pending.ended_at).toBeNull();
        expect(pending.cooldown_until).toBeNull();
        expect(
          (await pool.query('SELECT status FROM broker_disks WHERE id=$1', [current.disk_id]))
            .rows[0].status,
        ).toBe('ready');
        expect(
          (await pool.query('SELECT reserved_cents FROM broker_demo_days')).rows[0].reserved_cents,
        ).toBe(50);
        const resumed = await start(guest);
        expect(resumed.statusCode, resumed.body).toBe(200);
        expect(resumed.json<DemoState>().run).toMatchObject({ id: current.id, status: 'ending' });
        expect((await pool.query('SELECT count(*)::int n FROM broker_demo_runs')).rows[0].n).toBe(
          1,
        );
      } finally {
        ctx.wick.get = originalGet;
      }
      expect((await finishCleanup(current.id)).status).toBe('ended');
    });

    it('creates no disk or VM when the token auction loses every eligible offer', async () => {
      const guest = await visitor();
      const started = await start(guest);
      expect(started.statusCode).toBe(200);
      const id = started.json<DemoState>().run!.id;
      await reconcileDemo(ctx, id);
      let current = await row(id);
      await pool.query('UPDATE broker_token_offerings SET active=false');
      await pool.query(
        "UPDATE broker_token_orders SET closes_at=clock_timestamp()-interval '1 second' WHERE id=$1",
        [current.token_order_id],
      );
      await closeTokenAuction(ctx, current.token_order_id);
      await reconcileDemo(ctx, id);
      await reconcileDemo(ctx, id);
      current = await row(id);
      expect(current.status, current.message).toBe('failed');
      expect(current.disk_id).toBeNull();
      expect(current.request_id).toBeNull();
      expect(current.vm_id).toBeNull();
      expect(
        (await pool.query('SELECT count(*)::int n FROM broker_fixture_environments')).rows[0].n,
      ).toBe(0);
      expect(
        (await pool.query('SELECT count(*)::int n FROM broker_fixture_drives')).rows[0].n,
      ).toBe(0);
      expect(commands).not.toHaveBeenCalled();
    });

    it('never exposes a terminal or retries an uncertain bootstrap command', async () => {
      const guest = await visitor();
      const current = await readyRun(guest, false);
      commands.mockRejectedValueOnce(new Error('private-bootstrap-error-do-not-persist'));
      await reconcileDemo(ctx, current.id);
      const failed = await row(current.id);
      expect(failed.status).toBe('ending');
      expect(failed.failed).toBe(true);
      expect(failed.bootstrap_started_at).toBeInstanceOf(Date);
      expect(failed.bootstrap_completed_at).toBeNull();
      const state = await read(guest);
      expect(state.run!.vm!.terminalPath).toBeNull();
      expect(state.run!.canIssueKey).toBe(false);
      expect(JSON.stringify(state)).not.toContain('private-bootstrap-error');
      expect((await finishCleanup(current.id)).status).toBe('failed');
      expect(commands).toHaveBeenCalledTimes(1);
      expect(
        (await pool.query('SELECT status FROM broker_disks WHERE id=$1', [current.disk_id])).rows[0]
          .status,
      ).toBe('deleted');
    });

    it('replaying an old End operation cannot terminate a later accepted demo', async () => {
      const guest = await visitor();
      const started = await start(guest);
      const originalId = started.json<DemoState>().run!.id;
      const operationKey = randomUUID();
      const close = () =>
        app.inject({
          method: 'POST',
          url: '/api/demo/end',
          headers: headers(guest.ip, guest.cookie),
          payload: { operationKey },
        });
      expect((await close()).statusCode).toBe(200);
      await reconcileDemo(ctx, originalId);
      expect((await row(originalId)).status).toBe('ended');
      await pool.query(
        "UPDATE broker_demo_runs SET cooldown_until=clock_timestamp()-interval '1 second' WHERE id=$1",
        [originalId],
      );
      const next = await start(guest);
      expect(next.statusCode, next.body).toBe(200);
      const nextId = next.json<DemoState>().run!.id;
      expect(nextId).not.toBe(originalId);
      expect((await close()).statusCode).toBe(200);
      expect((await row(nextId)).stop_requested).toBe(false);
    });
  },
);
