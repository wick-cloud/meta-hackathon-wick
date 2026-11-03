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
              allowedCatalogIds: [modalCatalog.id],
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
        "INSERT INTO broker_offerings(provider_id,catalog_id,name,description,price_cents) VALUES($1,$2,'Modal Micro','Fixture demo supply',8)",
        [sellers[1]!.providerId, modalCatalog.id],
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
      // A separate HTTP test below covers the first POST's actual cookie issuance.
      expect(response.headers['set-cookie']).toBeUndefined();
      const cookie = `wick_demo=${randomBytes(32).toString('base64url')}`;
      return { ip, cookie, state: response.json<DemoState>() };
    }
    async function start(
      client: Awaited<ReturnType<typeof visitor>>,
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
    async function read(client: Awaited<ReturnType<typeof visitor>>) {
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
            "SELECT * FROM broker_bids WHERE request_id=$1 AND status='held' FOR UPDATE",
            [current.request_id],
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

    it('issues the first guest cookie only when the visitor starts the demo', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/demo/start',
        headers: headers('192.0.2.44'),
        payload: { operationKey: randomUUID() },
      });
      expect(response.statusCode, response.body).toBe(200);
      const cookie = response.headers['set-cookie'];
      expect(cookie).toEqual(expect.stringContaining('wick_demo='));
      expect(cookie).toEqual(expect.stringContaining('HttpOnly'));
      expect(cookie).toEqual(expect.stringContaining('SameSite=Strict'));
      expect(cookie).not.toEqual(expect.stringContaining('better-auth'));
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
      expect(different.statusCode).toBeGreaterThanOrEqual(400);
      expect((await read(guest)).run!.id).toBe([...ids][0]);
    });

    it('cannot bypass the per-network active run with a fresh cookie or forged forwarding chain', async () => {
      const first = await visitor();
      expect((await start(first)).statusCode).toBe(200);
      const second = await visitor(first.ip);
      expect(second.cookie).not.toBe(first.cookie);
      const response = await app.inject({
        method: 'POST',
        url: '/api/demo/start',
        headers: { ...headers(second.ip, second.cookie), 'x-forwarded-for': '198.51.100.250' },
        payload: { operationKey: randomUUID() },
      });
      expect(response.statusCode).toBeGreaterThanOrEqual(400);
      expect((await pool.query('SELECT count(*)::int n FROM broker_demo_runs')).rows[0].n).toBe(1);
      expect((await read(second)).run).toBeNull();
      expect(JSON.stringify(await read(second))).not.toContain((await read(first)).run!.id);
    });

    it('admits only two concurrent runs even when independent visitors race', async () => {
      const clients = await Promise.all(
        ['192.0.2.1', '192.0.2.2', '192.0.2.3', '192.0.2.4'].map((ip) => visitor(ip)),
      );
      const responses = await Promise.all(clients.map((client) => start(client)));
      expect(responses.filter((r) => r.statusCode === 200)).toHaveLength(2);
      expect(responses.filter((r) => r.statusCode >= 400)).toHaveLength(2);
      expect(
        (await pool.query('SELECT count(*)::int n FROM broker_demo_runs WHERE ended_at IS NULL'))
          .rows[0].n,
      ).toBe(2);
      expect(
        (await pool.query('SELECT sum(reserved_cents)::int n FROM broker_demo_days')).rows[0].n,
      ).toBe(100);
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

    it('retains one paired cooldown across visitor and network identities', async () => {
      const guest = await visitor();
      const result = await start(guest);
      const runId = result.json<DemoState>().run!.id;
      const cooldown = new Date(Date.now() + 20 * 60000);
      await pool.query(
        "UPDATE broker_demo_runs SET status='ended',ended_at=clock_timestamp(),vm_cleanup_at=clock_timestamp(),cooldown_until=$2 WHERE id=$1",
        [runId, cooldown],
      );
      const current = await read(guest);
      expect(current.cooldownUntil).toBe(cooldown.toISOString());
      expect(current.available).toBe(false);
      expect((await start(guest)).statusCode).toBeGreaterThanOrEqual(400);
      const clearedCookie = await visitor(guest.ip);
      expect((await start(clearedCookie)).statusCode).toBeGreaterThanOrEqual(400);
      await pool.query(
        "UPDATE broker_demo_runs SET cooldown_until=clock_timestamp()-interval '1 second' WHERE id=$1",
        [runId],
      );
      expect((await start(guest)).statusCode).toBe(200);
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

    it('runs genuine fixture auctions in order with fixed Baseten tokens and exact Modal compute', async () => {
      const guest = await visitor();
      const current = await readyRun(guest);
      const grant = (
        await pool.query('SELECT * FROM broker_inference_grants WHERE id=$1', [current.grant_id])
      ).rows[0];
      expect(grant.allowed_providers).toEqual(['baseten']);
      expect(grant.max_purchase_cents).toBe(5);
      expect(grant.allow_instant).toBe(false);
      const pack = (
        await pool.query('SELECT * FROM broker_token_packs WHERE id=$1', [current.pack_id])
      ).rows[0];
      expect(pack.provider).toBe('baseten');
      const request = (
        await pool.query('SELECT * FROM broker_requests WHERE id=$1', [current.request_id])
      ).rows[0];
      expect(request).toMatchObject({
        catalog_id: modalCatalog.id,
        duration_minutes: 15,
        region: 'auto',
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
      expect(view.run!.tokens!.provider).toBe('baseten');
      expect(view.run!.vm!.provider).toBe('modal');
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
        expect((await start(guest)).statusCode).toBeGreaterThanOrEqual(400);
      } finally {
        ctx.wick.get = originalGet;
      }
      expect((await finishCleanup(current.id)).status).toBe('ended');
    });

    it('creates no disk or VM when the Baseten auction loses its eligible offer', async () => {
      const guest = await visitor();
      const started = await start(guest);
      expect(started.statusCode).toBe(200);
      const id = started.json<DemoState>().run!.id;
      await reconcileDemo(ctx, id);
      let current = await row(id);
      await pool.query("UPDATE broker_token_offerings SET active=false WHERE provider='baseten'");
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
