import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../src/server/config.js';
import type { AppContext } from '../src/server/context.js';
import { migrate } from '../src/server/db.js';
import { createMuseAdapter } from '../src/server/integrations/muse.js';
import { registerMarketplace } from '../src/server/marketplace/index.js';
import { registerMuse } from '../src/server/muse/index.js';
import type { CatalogItem } from '../src/shared/types.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
const schema = `broker_fractional_${randomUUID().replaceAll('-', '')}`;
const boatMemory = 3814 / 1024;
const boat: CatalogItem = {
  id: 'offline-boat-small',
  name: 'Boat small contract fixture',
  description: 'Published resource shape, entirely offline',
  provider: 'boat',
  profile: 'small',
  region: 'auto',
  cpu: 2,
  memoryGb: boatMemory,
  resources: { cpu: 2, memoryGb: boatMemory },
  approved: true,
  durationMinutes: [15, 30, 60],
  pricingMode: 'managed',
  managedRouteVerification: 'organization-catalog-byok-disabled',
  rateMicrosPerSecond: 5,
  rateSource: 'wick-customer-catalog',
  rateRetrievedAt: new Date().toISOString(),
};

describe.skipIf(!databaseUrl)('fractional Boat GiB through buyer HTTP APIs, offline', () => {
  let admin: Pool;
  let pool: Pool;
  const app = Fastify();
  const allocate = vi.fn(() => {
    throw new Error('Live allocations are forbidden in this test');
  });
  const modelFetch = vi.fn<typeof fetch>(() => {
    throw new Error('Meta calls are forbidden in this test');
  });
  const requestBody = () => ({
    description: 'Manual exact catalog resources',
    catalogId: boat.id,
    region: boat.region,
    durationMinutes: 15,
    maxPriceCents: 10,
    requirements: { cpu: boat.cpu, memoryGb: boat.memoryGb },
  });
  beforeAll(async () => {
    admin = new Pool({ connectionString: databaseUrl });
    await admin.query(`CREATE SCHEMA ${schema}`);
    pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema},public` });
    await migrate(pool);
    const ctx = {
      pool,
      config: loadConfig({
        NODE_ENV: 'test',
        DATABASE_URL: databaseUrl!,
        BETTER_AUTH_SECRET: 'offline-fractional-memory-test-secret',
        WICK_MODE: 'fixture',
        MUSE_MODE: 'fixture',
      }),
      boss: { send: vi.fn(async () => null) },
      wick: { mode: 'real', create: allocate },
      muse: createMuseAdapter({ museMode: 'fixture' }, { fetch: modelFetch }),
      requireActor: async () => ({
        id: 'offline-buyer',
        name: 'Offline buyer',
        email: 'buyer@test.invalid',
        role: 'buyer',
      }),
    } as unknown as AppContext;
    app.setErrorHandler((error: Error & { statusCode?: number }, _request, reply) => {
      reply.code(error.statusCode ?? 500).send({ error: error.message });
    });
    await registerMarketplace(app, ctx);
    await registerMuse(app, ctx);
  });
  beforeEach(async () => {
    await pool.query('TRUNCATE broker_requests,broker_catalog CASCADE');
    await pool.query(
      "INSERT INTO broker_catalog(id,item,approved,source_mode) VALUES($1,$2,true,'real')",
      [boat.id, { ...boat, rateRetrievedAt: new Date().toISOString() }],
    );
  });
  afterAll(async () => {
    await app.close();
    await pool?.end();
    if (admin) {
      await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await admin.end();
    }
    expect(allocate).not.toHaveBeenCalled();
    expect(modelFetch).not.toHaveBeenCalled();
  });

  it('accepts and freezes exact Boat RAM copied by manual review without rounding up', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/requests',
      payload: requestBody(),
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().requirements.memoryGb).toBe(3.724609375);
    const stored = (await pool.query('SELECT requirements,catalog_snapshot FROM broker_requests'))
      .rows[0];
    expect(stored.requirements.memoryGb).toBe(boatMemory);
    expect(stored.catalog_snapshot.memoryGb).toBe(boatMemory);
    expect(stored.catalog_snapshot.resources.memoryGb).toBe(boatMemory);
  });

  it('preserves fractional explicit memory in Muse fixture translation and submits that proposal', async () => {
    const description = '2 vCPUs and 3.724609375 GiB RAM for 15 minutes';
    const translated = await app.inject({
      method: 'POST',
      url: '/api/muse/translate',
      payload: { description },
    });
    expect(translated.statusCode).toBe(200);
    const result = translated.json();
    expect(result.mode).toBe('fixture');
    expect(result.proposal.requirements.memoryGb).toBe(boatMemory);
    const submitted = await app.inject({
      method: 'POST',
      url: '/api/requests',
      payload: { ...result.proposal, description, maxPriceCents: 10 },
    });
    expect(submitted.statusCode, submitted.body).toBe(200);
    expect(submitted.json().requirements.memoryGb).toBe(boatMemory);
  });

  it('accepts positive sub-GiB requirements but rejects requests above actual Boat memory', async () => {
    const body = requestBody();
    body.requirements.memoryGb = 0.5;
    expect(
      (await app.inject({ method: 'POST', url: '/api/requests', payload: body })).statusCode,
    ).toBe(200);
    body.requirements.memoryGb = 4;
    const tooLarge = await app.inject({ method: 'POST', url: '/api/requests', payload: body });
    expect(tooLarge.statusCode).toBe(400);
    expect(tooLarge.json().error).toContain('does not satisfy');
    const translated = await app.inject({
      method: 'POST',
      url: '/api/muse/translate',
      payload: { description: '4 GiB RAM for 15 minutes' },
    });
    expect(translated.statusCode).toBe(422);
  });

  it.each([0, -0.5, null, '3.724609375', 16384.1])(
    'rejects invalid memory %s before persisting a request',
    async (memoryGb) => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/requests',
        payload: { ...requestBody(), requirements: { cpu: 2, memoryGb } },
      });
      expect(response.statusCode).toBe(400);
      expect(response.json().error).toContain('finite positive');
      expect(
        (await pool.query('SELECT count(*)::int AS count FROM broker_requests')).rows[0].count,
      ).toBe(0);
    },
  );
});
