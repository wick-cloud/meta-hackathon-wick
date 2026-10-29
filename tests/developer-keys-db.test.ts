import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import websocket from '@fastify/websocket';
import WebSocket from 'ws';
import { Pool } from 'pg';
import { hashPassword } from 'better-auth/crypto';
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import {
  createAuth,
  createRequireActor,
  registerAuth,
  registerBrokerKeyAccess,
} from '../src/server/auth.js';
import { registerDeveloperKeys, brokerSecretDigest } from '../src/server/developer-keys.js';
import { registerTerminal } from '../src/server/integrations/terminal.js';
import { fixtureTerminal } from '../src/server/integrations/terminal-fixture.js';
import { loadConfig } from '../src/server/config.js';
import { migrate } from '../src/server/db.js';
import { HttpError, type AppContext } from '../src/server/context.js';
import type { BrokerKeySummary, BrokerScope } from '../src/shared/developer.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
describe.skipIf(!databaseUrl)(
  'Broker credential boundary using PostgreSQL and real browser sessions',
  () => {
    const schema = `key_test_${randomUUID().replaceAll('-', '')}`,
      origin = 'http://localhost:3000',
      password = 'fixture-browser-password-only',
      buyerId = randomUUID(),
      otherId = randomUUID(),
      providerUserId = randomUUID(),
      providerId = randomUUID(),
      vmId = randomUUID();
    let pool: Pool,
      admin: Pool,
      app: FastifyInstance,
      ctx: AppContext,
      buyerCookie = '',
      otherCookie = '',
      providerCookie = '',
      endpoint = '';
    let currentOwner = buyerId;
    const sockets: WebSocket[] = [];
    const headers = (token: string) => ({ authorization: `Bearer ${token}` });
    async function mint(
      scopes: BrokerScope[] = ['account:read', 'catalog:read', 'vms:terminal'],
      limits: Record<string, number> = {},
      cookie = buyerCookie,
      days = 30,
    ) {
      const response = await app.inject({
        method: 'POST',
        url: '/api/keys',
        headers: { cookie, origin },
        payload: { name: 'Fixture integration key', scopes, limits, expiresInDays: days },
      });
      expect(response.statusCode).toBe(200);
      return response.json() as { key: BrokerKeySummary; token: string };
    }
    beforeAll(async () => {
      admin = new Pool({ connectionString: databaseUrl });
      await admin.query(`CREATE SCHEMA ${schema}`);
      pool = new Pool({
        connectionString: databaseUrl,
        options: `-c search_path=${schema},public`,
      });
      await migrate(pool);
      for (const [id, email, role] of [
        [buyerId, 'buyer@keys.invalid', 'buyer'],
        [otherId, 'other@keys.invalid', 'buyer'],
        [providerUserId, 'provider@keys.invalid', 'provider'],
      ]) {
        await pool.query(
          'INSERT INTO "user"(id,email,name,role,"emailVerified") VALUES($1,$2,$3,$4,true)',
          [id, email, 'Fixture account', role],
        );
        await pool.query(
          'INSERT INTO account(id,"accountId","providerId","userId",password) VALUES($1,$2,\'credential\',$2,$3)',
          [randomUUID(), id, await hashPassword(password)],
        );
      }
      await pool.query(
        'INSERT INTO broker_providers(id,user_id,name,total_capacity,policy) VALUES($1,$2,$3,5,$4)',
        [
          providerId,
          providerUserId,
          'Fixture provider',
          JSON.stringify({ autoBid: false, basePriceCents: 10, minimumPriceCents: 1 }),
        ],
      );
      await pool.query('UPDATE "user" SET "providerId"=$2 WHERE id=$1', [
        providerUserId,
        providerId,
      ]);
      const config = loadConfig({
        NODE_ENV: 'test',
        APP_URL: origin,
        DATABASE_URL: databaseUrl!,
        BETTER_AUTH_SECRET: 'fixture-broker-keys-auth-secret-at-least-32-characters',
        WICK_MODE: 'fixture',
        MUSE_MODE: 'fixture',
      });
      app = Fastify({ logger: false });
      app.setErrorHandler((error, _request, reply) => {
        const e = error as Error & { statusCode?: number; retryAfter?: number };
        if (e.retryAfter) reply.header('Retry-After', e.retryAfter);
        return reply.code(e.statusCode ?? 500).send({ error: e.message });
      });
      const auth = createAuth(config, pool),
        requireActor = createRequireActor(auth, pool);
      ctx = { config, pool, requireActor } as AppContext;
      registerBrokerKeyAccess(app, requireActor);
      await registerAuth(app, auth, config);
      await registerDeveloperKeys(app, ctx);
      app.get('/api/me', async (request) => ({ user: await requireActor(request) }));
      app.get('/api/catalog', async (request) => ({ actor: await requireActor(request) }));
      app.get('/api/admin/config', async (request) => ({
        actor: await requireActor(request, ['admin']),
      }));
      app.get('/api/unclassified', async (request) => ({ actor: await requireActor(request) }));
      app.post('/api/requests', async (request) => ({
        actor: await requireActor(request, ['buyer']),
        body: request.body,
      }));
      app.put('/api/provider/capacity', async (request) => ({
        actor: await requireActor(request, ['provider']),
        body: request.body,
      }));
      await app.register(websocket);
      await registerTerminal(app, {
        ...ctx,
        wick: { mode: 'fixture', terminal: async () => fixtureTerminal() },
        pool: {
          query: async (sql: string, args: unknown[]) =>
            sql.includes('FROM broker_vms')
              ? {
                  rows:
                    args[1] === currentOwner
                      ? [
                          {
                            id: vmId,
                            buyer_id: currentOwner,
                            status: 'running',
                            environment_id: 'fixture_env',
                            expires_at: new Date(Date.now() + 60000),
                            source_mode: 'fixture',
                          },
                        ]
                      : [],
                }
              : pool.query(sql, args),
        },
      } as unknown as AppContext);
      await app.ready();
      async function login(email: string) {
        const result = await app.inject({
          method: 'POST',
          url: '/api/auth/sign-in/email',
          headers: { origin },
          payload: { email, password },
        });
        expect(result.statusCode).toBe(200);
        const cookies = result.headers['set-cookie'];
        return (typeof cookies === 'string' ? [cookies] : (cookies ?? []))
          .map((c) => c.split(';')[0])
          .join('; ');
      }
      buyerCookie = await login('buyer@keys.invalid');
      otherCookie = await login('other@keys.invalid');
      providerCookie = await login('provider@keys.invalid');
      await app.listen({ port: 0, host: '127.0.0.1' });
      const address = app.server.address();
      if (!address || typeof address === 'string') throw Error('Missing address');
      endpoint = `ws://127.0.0.1:${address.port}/api/vms/${vmId}/terminal`;
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
    it('creates a separate random key once and stores only its digest', async () => {
      const issued = await mint();
      expect(issued.token).toMatch(/^wbk_[a-f0-9-]{36}\.[A-Za-z0-9_-]{43}$/);
      const row = (await pool.query('SELECT * FROM broker_api_keys WHERE id=$1', [issued.key.id]))
        .rows[0];
      expect(row.secret_digest).toBe(brokerSecretDigest(issued.token.split('.')[1]));
      expect(JSON.stringify(row)).not.toContain(issued.token.split('.')[1]);
      const listed = await app.inject({
        method: 'GET',
        url: '/api/keys',
        headers: { cookie: buyerCookie },
      });
      expect(listed.statusCode).toBe(200);
      expect(listed.body).not.toContain(issued.token);
      expect(listed.body).not.toContain('secret_digest');
      const result = await app.inject({
        method: 'GET',
        url: '/api/me',
        headers: headers(issued.token),
      });
      expect(result.statusCode).toBe(200);
      expect(result.json().user).toMatchObject({
        id: buyerId,
        role: 'buyer',
        apiKey: { id: issued.key.id, scopes: issued.key.scopes, limits: {} },
      });
    });
    it('rejects Wick or malformed credentials even with a valid browser cookie', async () => {
      for (const token of ['wick_upstream_service_key', 'wbk_invalid', '']) {
        const r = await app.inject({
          method: 'GET',
          url: '/api/me',
          headers: { ...headers(token), cookie: buyerCookie },
        });
        expect(r.statusCode).toBe(401);
      }
    });
    it('denies missing scopes, unclassified routes, key management and admin endpoints', async () => {
      const issued = await mint(['account:read']);
      for (const url of ['/api/catalog', '/api/admin/config', '/api/unclassified', '/api/keys'])
        expect(
          (await app.inject({ method: 'GET', url, headers: headers(issued.token) })).statusCode,
        ).toBe(403);
      expect(
        (
          await app.inject({
            method: 'POST',
            url: '/api/keys',
            headers: headers(issued.token),
            payload: { name: 'Escalation', scopes: ['account:read'] },
          })
        ).statusCode,
      ).toBe(403);
    });
    it('requires valid role scopes, operation limits and safe browser origin', async () => {
      for (const payload of [
        { name: 'Wrong role', scopes: ['provider:read'] },
        { name: 'Missing limit', scopes: ['orders:write'] },
        { name: 'Bad expiry', scopes: ['account:read'], expiresInDays: 91 },
        { name: 'Bad limit', scopes: ['orders:write'], limits: { maxAuctionCents: -1 } },
      ])
        expect(
          (
            await app.inject({
              method: 'POST',
              url: '/api/keys',
              headers: { cookie: buyerCookie, origin },
              payload,
            })
          ).statusCode,
        ).toBe(400);
      expect(
        (
          await app.inject({
            method: 'POST',
            url: '/api/keys',
            headers: { cookie: buyerCookie },
            payload: { name: 'Missing origin', scopes: ['account:read'] },
          })
        ).statusCode,
      ).toBe(403);
      await mint(['account:read'], {}, buyerCookie, 90);
    });
    it('requires stable mutation keys and reconciles headers with body', async () => {
      const issued = await mint(['account:read', 'orders:write'], { maxAuctionCents: 100 });
      expect(
        (
          await app.inject({
            method: 'POST',
            url: '/api/requests',
            headers: headers(issued.token),
            payload: {},
          })
        ).statusCode,
      ).toBe(400);
      const result = await app.inject({
        method: 'POST',
        url: '/api/requests',
        headers: { ...headers(issued.token), 'idempotency-key': 'fixture-operation-001' },
        payload: {},
      });
      expect(result.statusCode).toBe(200);
      expect(result.json().body.operationKey).toBe('fixture-operation-001');
      expect(
        (
          await app.inject({
            method: 'POST',
            url: '/api/requests',
            headers: { ...headers(issued.token), 'idempotency-key': 'fixture-operation-001' },
            payload: { operationKey: 'fixture-operation-002' },
          })
        ).statusCode,
      ).toBe(400);
    });
    it('rejects role changes and provider rebinding rather than expanding old privileges', async () => {
      const buyer = await mint(['account:read']);
      await pool.query('UPDATE "user" SET role=\'provider\' WHERE id=$1', [buyerId]);
      expect(
        (await app.inject({ method: 'GET', url: '/api/me', headers: headers(buyer.token) }))
          .statusCode,
      ).toBe(401);
      await pool.query('UPDATE "user" SET role=\'buyer\' WHERE id=$1', [buyerId]);
      expect(
        (await app.inject({ method: 'GET', url: '/api/me', headers: headers(buyer.token) }))
          .statusCode,
      ).toBe(401);
      const provider = await mint(['account:read', 'provider:read'], {}, providerCookie);
      expect(
        (await app.inject({ method: 'GET', url: '/api/me', headers: headers(provider.token) }))
          .statusCode,
      ).toBe(200);
      await pool.query('UPDATE "user" SET "providerId"=$2 WHERE id=$1', [
        providerUserId,
        randomUUID(),
      ]);
      expect(
        (await app.inject({ method: 'GET', url: '/api/me', headers: headers(provider.token) }))
          .statusCode,
      ).toBe(401);
      await pool.query('UPDATE "user" SET "providerId"=$2 WHERE id=$1', [
        providerUserId,
        providerId,
      ]);
    });
    it('does not let another browser account revoke a key', async () => {
      const issued = await mint();
      expect(
        (
          await app.inject({
            method: 'DELETE',
            url: `/api/keys/${issued.key.id}`,
            headers: { cookie: otherCookie, origin },
          })
        ).statusCode,
      ).toBe(404);
      expect(
        (
          await app.inject({ method: 'GET', url: '/api/keys', headers: { cookie: otherCookie } })
        ).json().items,
      ).toHaveLength(0);
    });
    it('revocation and expiry reject access and revocation is idempotent', async () => {
      const issued = await mint();
      for (let i = 0; i < 2; i++)
        expect(
          (
            await app.inject({
              method: 'DELETE',
              url: `/api/keys/${issued.key.id}`,
              headers: { cookie: buyerCookie, origin },
            })
          ).statusCode,
        ).toBe(200);
      expect(
        (await app.inject({ method: 'GET', url: '/api/me', headers: headers(issued.token) }))
          .statusCode,
      ).toBe(401);
      const expired = await mint();
      await pool.query(
        "UPDATE broker_api_keys SET created_at=now()-interval '2 days',expires_at=now()-interval '1 day' WHERE id=$1",
        [expired.key.id],
      );
      expect(
        (await app.inject({ method: 'GET', url: '/api/me', headers: headers(expired.token) }))
          .statusCode,
      ).toBe(401);
    });
    it('bounds indexed auth lookup work and throttles last-use writes', async () => {
      const issued = await mint(['account:read']);
      await app.inject({ method: 'GET', url: '/api/me', headers: headers(issued.token) });
      const first = (
        await pool.query('SELECT last_used_at FROM broker_api_keys WHERE id=$1', [issued.key.id])
      ).rows[0].last_used_at;
      await app.inject({ method: 'GET', url: '/api/me', headers: headers(issued.token) });
      const second = (
        await pool.query('SELECT last_used_at FROM broker_api_keys WHERE id=$1', [issued.key.id])
      ).rows[0].last_used_at;
      expect(second.getTime()).toBe(first.getTime());
    });
    it('allows a machine terminal without Origin, rejects foreign Origin and closes on revocation', async () => {
      const issued = await mint(['account:read', 'vms:terminal']);
      const socket = new WebSocket(endpoint, { headers: headers(issued.token) });
      sockets.push(socket);
      await new Promise<void>((resolve, reject) => {
        socket.once('open', resolve);
        socket.once('error', reject);
      });
      const denied = new WebSocket(endpoint, {
        headers: { ...headers(issued.token), origin: 'https://attacker.invalid' },
      });
      sockets.push(denied);
      expect(
        await new Promise((resolve) => {
          denied.once('unexpected-response', (_r, r) => {
            r.resume();
            resolve(r.statusCode);
          });
          denied.on('error', () => {});
        }),
      ).toBe(403);
      const closed = new Promise<number>((resolve) =>
        socket.once('close', (code) => resolve(code)),
      );
      await app.inject({
        method: 'DELETE',
        url: `/api/keys/${issued.key.id}`,
        headers: { cookie: buyerCookie, origin },
      });
      expect(await closed).toBe(1008);
      expect(currentOwner).toBe(buyerId);
    }, 5000);
    it('atomically enforces the twenty active key cap under concurrent creation', async () => {
      const results = await Promise.all(
        Array.from({ length: 23 }, (_, i) =>
          app.inject({
            method: 'POST',
            url: '/api/keys',
            headers: { cookie: otherCookie, origin },
            payload: { name: `Concurrent ${i}`, scopes: ['account:read'] },
          }),
        ),
      );
      expect(results.filter((r) => r.statusCode === 200)).toHaveLength(20);
      expect(results.filter((r) => r.statusCode === 409)).toHaveLength(3);
      expect(
        Number(
          (
            await pool.query(
              'SELECT count(*)::int n FROM broker_api_keys WHERE user_id=$1 AND revoked_at IS NULL',
              [otherId],
            )
          ).rows[0].n,
        ),
      ).toBe(20);
    });
  },
);
