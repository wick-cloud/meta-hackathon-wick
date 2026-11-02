import { randomBytes, randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import { Pool } from 'pg';
import { Ajv2020 } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { beforeAll, afterAll, describe, it, expect, vi } from 'vitest';
import { migrate } from '../src/server/db.js';
import { loadConfig } from '../src/server/config.js';
import { createAuth, createRequireActor, registerBrokerKeyAccess } from '../src/server/auth.js';
import { brokerSecretDigest } from '../src/server/developer-keys.js';
import { scopesForRole } from '../src/shared/developer.js';
import { registerMarketplace } from '../src/server/marketplace/index.js';
import { registerOrders } from '../src/server/orders.js';
import { registerAgreements } from '../src/server/agreements/index.js';
import { registerAgreementBilling } from '../src/server/agreement-billing.js';
import { registerNegotiation } from '../src/server/marketplace/negotiation.js';
import { registerMuse } from '../src/server/muse/index.js';
import { fixtureCatalog } from '../src/server/integrations/wick.js';
import { createMuseAdapter } from '../src/server/integrations/muse.js';
import { publicCatalogView } from '../src/server/public-views.js';
import type { AppContext } from '../src/server/context.js';
import { BROKER_API_SCHEMAS, BROKER_OPERATION_SCHEMAS } from '../packages/sdk/src/contracts.js';
import { BrokerClient } from '../packages/sdk/src/index.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
describe.skipIf(!databaseUrl)(
  'public API wire contract with actual Broker key authentication and PostgreSQL',
  () => {
    const schema = `wire_${randomUUID().replaceAll('-', '')}`;
    let admin: Pool,
      pool: Pool,
      app: FastifyInstance,
      ctx: AppContext,
      buyer: BrokerClient,
      provider: BrokerClient;
    const buyerId = randomUUID(),
      providerUser = randomUUID(),
      providerId = randomUUID();
    const ajv = new Ajv2020({ strict: false, allErrors: true });
    addFormats(ajv);
    const definitions = JSON.parse(
      JSON.stringify(BROKER_API_SCHEMAS).replaceAll('#/components/schemas/', '#/$defs/'),
    );
    const validators = new Map<string, ReturnType<typeof ajv.compile>>();
    function validate(name: string, value: unknown) {
      let check = validators.get(name);
      if (!check) {
        check = ajv.compile({ $defs: definitions, $ref: `#/$defs/${name}` });
        validators.set(name, check);
      }
      expect(check(value), `${name}: ${JSON.stringify(check.errors)}`).toBe(true);
    }
    const requests: { method: string; path: string; value: unknown }[] = [];
    async function issue(role: 'buyer' | 'provider', userId: string) {
      const id = randomUUID(),
        secret = randomBytes(32).toString('base64url'),
        prefix = `wbk_${id}`;
      await pool.query(
        `INSERT INTO broker_api_keys(id,user_id,name,prefix,secret_digest,scopes,limits,issued_role,issued_provider_id,expires_at) VALUES($1,$2,'Wire fixture',$3,$4,$5,$6,$7,$8,clock_timestamp()+interval '1 day')`,
        [
          id,
          userId,
          prefix,
          brokerSecretDigest(secret),
          JSON.stringify(scopesForRole(role)),
          JSON.stringify(
            role === 'buyer'
              ? {
                  maxAuctionCents: 10000,
                  maxAgreementReservationCents: 10000,
                  maxActivationQuantity: 20,
                }
              : {},
          ),
          role,
          role === 'provider' ? providerId : null,
        ],
      );
      return `${prefix}.${secret}`;
    }
    beforeAll(async () => {
      admin = new Pool({ connectionString: databaseUrl });
      await admin.query(`CREATE SCHEMA ${schema}`);
      pool = new Pool({
        connectionString: databaseUrl,
        options: `-c search_path=${schema},public`,
      });
      await migrate(pool);
      for (const [id, role] of [
        [buyerId, 'buyer'],
        [providerUser, 'provider'],
      ])
        await pool.query(
          'INSERT INTO "user"(id,email,name,role,"emailVerified") VALUES($1,$2,$3,$4,true)',
          [id, `${role}@wire.invalid`, role, role],
        );
      await pool.query(
        "INSERT INTO broker_providers(id,user_id,name,total_capacity,policy) VALUES($1,$2,'Wire provider',5,$3)",
        [
          providerId,
          providerUser,
          { autoBid: false, minimumPriceCents: 1, basePriceCents: 5, reserveSlots: 0 },
        ],
      );
      await pool.query('UPDATE "user" SET "providerId"=$2 WHERE id=$1', [providerUser, providerId]);
      const config = loadConfig({
        NODE_ENV: 'test',
        APP_URL: 'http://localhost:3000',
        DATABASE_URL: databaseUrl!,
        BETTER_AUTH_SECRET: 'wire-fixture-secret-with-at-least-32-characters',
        WICK_MODE: 'fixture',
        MUSE_MODE: 'fixture',
      });
      for (const item of fixtureCatalog(config))
        await pool.query('INSERT INTO broker_catalog(id,item,approved) VALUES($1,$2,true)', [
          item.id,
          {
            ...item,
            pricingMode: 'managed',
            managedRouteVerification: 'execution-preview-managed',
          },
        ]);
      await pool.query(
        'INSERT INTO broker_credit_wallets(buyer_id,balance_cents,reserved_cents) VALUES($1,10000,0)',
        [buyerId],
      );
      await pool.query("UPDATE broker_settings SET value='20' WHERE key='maxConcurrentVms'");
      app = Fastify({ logger: false });
      app.setErrorHandler((error, _request, reply) =>
        reply
          .code((error as { statusCode?: number }).statusCode ?? 500)
          .send({ error: (error as Error).message }),
      );
      const requireActor = createRequireActor(createAuth(config, pool), pool);
      ctx = {
        config,
        pool,
        requireActor,
        muse: createMuseAdapter({ museMode: 'fixture' }),
        wick: {
          mode: 'fixture',
          create: vi.fn(() => {
            throw Error('No native allocation allowed');
          }),
        },
        boss: { send: vi.fn(async () => randomUUID()) },
      } as unknown as AppContext;
      registerBrokerKeyAccess(app, requireActor);
      app.get('/api/me', async (request) => ({
        user: await requireActor(request),
        modes: { wick: 'fixture', muse: 'fixture' },
        catalog: fixtureCatalog(config).map(publicCatalogView),
        commissionBps: 1500,
      }));
      app.get('/api/catalog', async (request) => {
        await requireActor(request);
        return {
          items: (await pool.query('SELECT item FROM broker_catalog')).rows.map((row) =>
            publicCatalogView(row.item),
          ),
        };
      });
      await registerMarketplace(app, ctx);
      registerOrders(app, ctx);
      await registerAgreements(app, ctx);
      registerAgreementBilling(app, ctx);
      registerNegotiation(app, ctx);
      await registerMuse(app, ctx);
      await app.ready();
      const fetcher: typeof fetch = async (input, init) => {
        const url = new URL(String(input));
        const response = await app.inject({
          method: init?.method as 'GET' | 'POST' | 'PUT' | 'PATCH',
          url: url.pathname + url.search,
          headers: init?.headers as Record<string, string>,
          ...(init?.body ? { payload: String(init.body) } : {}),
        });
        if (response.statusCode !== 200)
          throw Error(
            `Fixture ${init?.method} ${url.pathname} returned ${response.statusCode}: ${response.body}`,
          );
        const value = response.json();
        requests.push({ method: init?.method ?? 'GET', path: url.pathname, value });
        return new Response(response.body, {
          status: response.statusCode,
          headers: { 'Content-Type': 'application/json' },
        });
      };
      buyer = new BrokerClient({
        baseUrl: config.appUrl,
        apiKey: await issue('buyer', buyerId),
        fetch: fetcher,
      });
      provider = new BrokerClient({
        baseUrl: config.appUrl,
        apiKey: await issue('provider', providerUser),
        fetch: fetcher,
      });
    });
    afterAll(async () => {
      if (app) await app.close();
      if (pool) await pool.end();
      if (admin) {
        await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
        await admin.end();
      }
    });
    it('validates row-bearing buyer/provider flows using the public package and exact route response schemas', async () => {
      const order = await buyer.orders.create(
        {
          description: 'Wire test',
          catalogId: 'dev-small',
          region: 'us-east',
          durationMinutes: 30,
          maxPriceCents: 100,
          requirements: { cpu: 2, memoryGb: 4 },
        },
        { operationKey: 'wire-auction-create' },
      );
      const offering = await provider.provider.offerings.create(
        {
          catalogId: 'dev-small',
          name: 'Wire Small',
          description: 'Fixture supply',
          priceCents: 5,
        },
        { operationKey: 'wire-offering-create' },
      );
      const bid = await provider.provider.bids.submit(
        order.id,
        { totalPriceCents: 5, offeringId: offering.id },
        { operationKey: 'wire-provider-bid' },
      );
      // Seed a provisioning record to exercise the existing VM view without waiting
      // for the live auction clock or invoking any native provider lifecycle.
      await pool.query(
        "UPDATE broker_requests SET status='provisioning',winning_bid_id=$2 WHERE id=$1",
        [order.id, bid.id],
      );
      await pool.query(
        `INSERT INTO broker_vms(request_id,buyer_id,provider_id,bid_id,status,create_key,create_input,catalog_snapshot,quote_snapshot) VALUES($1,$2,$3,$4,'provisioning','wire-fixture-native-key',$5,$6,$7)`,
        [
          order.id,
          buyerId,
          providerId,
          bid.id,
          { ttlSeconds: 1800 },
          { name: 'Wire Small', region: 'us-east', sourceMode: 'fixture' },
          { totalPriceCents: 5 },
        ],
      );
      await buyer.me();
      await buyer.catalog.list();
      await buyer.orders.get(order.id);
      await buyer.orders.list();
      await buyer.orders.requests();
      await buyer.vms.list();
      const vms = await buyer.vms.list();
      expect(vms.items.length).toBe(1);
      await buyer.vms.get(vms.items[0].id);
      await buyer.billing.wallet();
      await buyer.billing.history();
      await buyer.billing.invoices();
      await buyer.billing.agreementCharges();
      await provider.provider.dashboard();
      await provider.provider.requests();
      await provider.provider.offerings.list();
      await provider.provider.activity();
      await provider.provider.earnings();
      await provider.provider.agreementCharges();
      await provider.provider.policy.propose('Keep one slot spare without changing prices');
      await buyer.muse.translate('2 CPU, 4 GiB, 30 minutes');
      // Historical billing remains readable after scheduled creation retires.
      await provider.provider.scheduledOfferings.list();
      await provider.provider.commitments();
      const intent = await buyer.alternatives.create(
        {
          description: 'Wire intent',
          desired: {
            cpu: 2,
            memoryGb: 4,
            region: 'us-east',
            durationMinutes: 30,
            maxPriceCents: 100,
          },
        },
        { operationKey: 'wire-intent-create' },
      );
      await buyer.alternatives.list();
      await buyer.alternatives.get(intent.id);
      for (const request of requests) {
        const template = Object.entries(BROKER_OPERATION_SCHEMAS).find(([signature]) => {
          const [method, path] = signature.split(' ');
          if (method !== request.method) return false;
          const pattern = '^' + path.replace(/:[A-Za-z]+/g, '[^/]+') + '$';
          return new RegExp(pattern).test(request.path);
        });
        expect(template, `${request.method} ${request.path}`).toBeDefined();
        validate(template![1].output, request.value);
      }
      expect(requests.map((request) => `${request.method} ${request.path}`)).toEqual(
        expect.arrayContaining([
          'POST /api/requests',
          'GET /api/orders',
          'GET /api/vms',
          'GET /api/credits',
          'GET /api/agreement-charges',
          'GET /api/provider/agreement-charges',
        ]),
      );
      expect(ctx.wick.create).not.toHaveBeenCalled();
    });
  },
);
