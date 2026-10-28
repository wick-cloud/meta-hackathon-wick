import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import Fastify from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { migrate } from '../src/server/db.js';
import { recentUnmetDemand, offeringPriceCandidates } from '../src/server/muse/demand.js';
import type { CatalogItem } from '../src/shared/types.js';
import { registerMarketplace } from '../src/server/marketplace/index.js';
import type { AppContext } from '../src/server/context.js';
import { registerMuse } from '../src/server/muse/index.js';
import { createMuseAdapter } from '../src/server/integrations/muse.js';
import { MAX_MATCH_CATALOGS } from '../src/server/marketplace/matching.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
const schema = `muse_demand_${randomUUID().replaceAll('-', '')}`;
const item: CatalogItem = {
  id: 'demand-offline',
  name: 'Offline approved',
  description: '',
  provider: 'simulated-demo',
  profile: 'small',
  region: 'test-us',
  cpu: 2,
  memoryGb: 4,
  durationMinutes: [15, 30, 60],
  approved: true,
};
const desired = { cpu: 2, memoryGb: 4, region: 'test-us', durationMinutes: 30, maxPriceCents: 500 };
const policy = { autoBid: false, basePriceCents: 5, minimumPriceCents: 4 };

describe.skipIf(!databaseUrl)('bounded unresolved Muse demand using isolated PostgreSQL', () => {
  let admin: Pool, pool: Pool;
  beforeAll(async () => {
    admin = new Pool({ connectionString: databaseUrl });
    await admin.query(`CREATE SCHEMA ${schema}`);
    pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema},public` });
    await migrate(pool);
  });
  beforeEach(async () => {
    await pool.query('TRUNCATE broker_intents,broker_requests,broker_catalog CASCADE');
    await pool.query(
      "INSERT INTO broker_catalog(id,item,approved,source_mode) VALUES($1,$2,true,'fixture')",
      [item.id, item],
    );
  });
  afterAll(async () => {
    await pool?.end();
    if (admin) {
      await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await admin.end();
    }
  });
  async function request(
    mode = 'fixture',
    age = '0 seconds',
    overrides: { region?: string; gpu?: string; eligibleCatalogs?: unknown } = {},
  ) {
    return (
      await pool.query(
        `INSERT INTO broker_requests(buyer_id,description,catalog_id,catalog_snapshot,region,duration_minutes,max_price_cents,requirements,status,created_at)
      VALUES('private-buyer','private free text',$1,$2,$5,30,500,$3,'no_offers',now()-$4::interval) RETURNING id`,
        [
          item.id,
          {
            ...item,
            sourceMode: mode,
            ...(overrides.eligibleCatalogs !== undefined
              ? { matchMode: 'compatible', eligibleCatalogs: overrides.eligibleCatalogs }
              : {}),
          },
          { cpu: 2, memoryGb: 4, ...(overrides.gpu ? { gpu: overrides.gpu } : {}) },
          age,
          overrides.region ?? 'test-us',
        ],
      )
    ).rows[0].id;
  }
  async function intent(status = 'open', source?: string, overrides = {}) {
    return (
      await pool.query(
        `INSERT INTO broker_intents(buyer_id,operation_key,description,desired,flexibility,source_mode,status,source_request_id)
      VALUES('private-buyer',$1,'private desired prose',$2,'{}','fixture',$3,$4) RETURNING id`,
        [randomUUID(), { ...desired, ...overrides }, status, source ?? null],
      )
    ).rows[0].id;
  }
  it('excludes other modes, old history, disallowed catalog and resolved requests', async () => {
    await request();
    await request('real');
    await request('fixture', '8 days');
    const resolved = await request(),
      replacement = await request('real');
    await pool.query('UPDATE broker_requests SET resolution_request_id=$2 WHERE id=$1', [
      resolved,
      replacement,
    ]);
    expect(await recentUnmetDemand(pool, 'fixture', [item.id])).toEqual([
      { region: 'test-us', durationMinutes: 30, requirements: { cpu: 2, memoryGb: 4 }, count: 1 },
    ]);
    expect(await recentUnmetDemand(pool, 'fixture', [])).toEqual([]);
    expect(await recentUnmetDemand(pool, 'fixture', ['excluded'])).toEqual([]);
  });
  it('counts unresolved supported intents once, excludes accepted substitutes and unsupported exact requirements', async () => {
    const source = await request();
    await intent('open', source);
    await intent('accepted');
    await intent('resolved');
    await intent('open', undefined, { durationMinutes: 120 });
    await intent('open', undefined, { region: 'unsupported-region' });
    const rows = await recentUnmetDemand(pool, 'fixture', [item.id]);
    expect(rows).toHaveLength(1);
    expect(rows[0].count).toBe(1);
    expect(JSON.stringify(rows)).not.toMatch(/private|buyer|description|operation/);
  });
  it('bounds request aggregation before grouping', async () => {
    await pool.query(
      `INSERT INTO broker_requests(buyer_id,description,catalog_id,catalog_snapshot,region,duration_minutes,max_price_cents,requirements,status)
      SELECT 'buyer-'||n,'private prose',$1,$2,'test-us',30,500,$3,'no_offers' FROM generate_series(1,205) n`,
      [item.id, { ...item, sourceMode: 'fixture' }, { cpu: 2, memoryGb: 4 }],
    );
    expect((await recentUnmetDemand(pool, 'fixture', [item.id]))[0].count).toBe(200);
  });

  it('attributes compatible unmet requests to another frozen cloud, keeping legacy exact matching and private aggregation', async () => {
    const target = { ...item, id: 'daytona-small', provider: 'daytona', region: 'us-pdx-1' };
    const unreviewed = { ...target, id: 'daytona-unreviewed' };
    for (const candidate of [target, unreviewed])
      await pool.query(
        "INSERT INTO broker_catalog(id,item,approved,source_mode) VALUES($1,$2,true,'fixture')",
        [candidate.id, candidate],
      );
    await request('fixture', '0 seconds', { region: 'any', eligibleCatalogs: [item, target] });
    await request();
    const groups = await recentUnmetDemand(pool, 'fixture', [target.id]);
    expect(groups).toEqual([
      { region: 'any', durationMinutes: 30, requirements: { cpu: 2, memoryGb: 4 }, count: 1 },
    ]);
    expect(await recentUnmetDemand(pool, 'fixture', [unreviewed.id])).toEqual([]);
    expect(JSON.stringify(groups)).not.toMatch(/private|buyer|description|eligibleCatalogs/);
  });

  it('bounds compatible books and aggregation without falling back from malformed books to their reference', async () => {
    await request('fixture', '0 seconds', { region: 'any', eligibleCatalogs: { id: item.id } });
    await request('fixture', '0 seconds', {
      region: 'any',
      eligibleCatalogs: Array.from({ length: MAX_MATCH_CATALOGS + 1 }, () => item),
    });
    expect(await recentUnmetDemand(pool, 'fixture', [item.id])).toEqual([]);
    const book = {
      ...item,
      sourceMode: 'fixture',
      matchMode: 'compatible',
      eligibleCatalogs: [item],
    };
    await pool.query(
      `INSERT INTO broker_requests(buyer_id,description,catalog_id,catalog_snapshot,region,duration_minutes,max_price_cents,requirements,status)
       SELECT 'private-'||n,'private prose',$1,$2,'any',30,500,$3,'no_offers' FROM generate_series(1,205) n`,
      [item.id, book, { cpu: 2, memoryGb: 4 }],
    );
    const groups = await recentUnmetDemand(pool, 'fixture', [item.id]);
    expect(groups).toEqual([
      { region: 'any', durationMinutes: 30, requirements: { cpu: 2, memoryGb: 4 }, count: 200 },
    ]);
  });

  it('supports explicit any-region/GPU intent demand without broadening other native regions or GPU names', async () => {
    const gpu = { ...item, id: 'modal-gpu', provider: 'modal', region: 'auto', gpu: 'H100' };
    await pool.query(
      "INSERT INTO broker_catalog(id,item,approved,source_mode) VALUES($1,$2,true,'fixture')",
      [gpu.id, gpu],
    );
    await intent('open', undefined, { region: 'any', gpu: 'any' });
    await intent('open', undefined, { region: 'us', gpu: 'any' });
    await intent('open', undefined, { region: 'any', gpu: 'L4' });
    expect(await recentUnmetDemand(pool, 'fixture', [gpu.id])).toEqual([
      {
        region: 'any',
        durationMinutes: 30,
        requirements: { cpu: 2, memoryGb: 4, gpu: 'any' },
        count: 1,
      },
    ]);
    expect(await recentUnmetDemand(pool, 'fixture', [item.id])).toEqual([]);
  });

  it('passes compatible any-region demand through the fixture adapter and prices only the owning cloud offering', async () => {
    const gpu = {
      ...item,
      id: 'daytona-reviewed-gpu',
      provider: 'daytona',
      region: 'us-pdx-1',
      gpu: 'H100',
    };
    await pool.query(
      "INSERT INTO broker_catalog(id,item,approved,source_mode) VALUES($1,$2,true,'fixture')",
      [gpu.id, gpu],
    );
    await request('fixture', '0 seconds', {
      region: 'any',
      gpu: 'any',
      eligibleCatalogs: [item, gpu],
    });
    const userId = randomUUID();
    await pool.query(
      "INSERT INTO broker_providers(user_id,name,total_capacity,policy,cloud_provider) VALUES($1,'Owned Daytona',5,$2,'daytona')",
      [userId, { ...policy, allowedCatalogIds: [gpu.id] }],
    );
    const app = Fastify();
    app.setErrorHandler((error: Error & { statusCode?: number }, _request, reply) =>
      reply.code(error.statusCode ?? 500).send({ error: error.message }),
    );
    await registerMuse(app, {
      pool,
      wick: { mode: 'fixture' },
      muse: createMuseAdapter(
        { museMode: 'fixture' },
        {
          fetch: () => {
            throw Error('No Meta calls permitted');
          },
        },
      ),
      requireActor: async () => ({ id: userId, role: 'provider' }),
    } as unknown as AppContext);
    try {
      const response = await app.inject({
        method: 'POST',
        url: '/api/provider/offerings/propose',
        payload: {},
      });
      expect(response.statusCode, response.body).toBe(200);
      expect(response.json()).toMatchObject({
        mode: 'fixture',
        modelCalled: false,
        proposals: [{ catalogId: gpu.id, durationMinutes: 30, priceCents: 5 }],
      });
      expect(response.json().proposals).toHaveLength(1);
      expect(JSON.stringify(response.json())).not.toMatch(/private-buyer|private free text/);
    } finally {
      await app.close();
    }
  });

  it('publishes the reviewed real 30-minute floor price and rejects changed prices or policy exclusions atomically', async () => {
    const real = {
      ...item,
      provider: 'e2b',
      pricingMode: 'managed',
      managedRouteVerification: 'execution-preview-managed',
      rateMicrosPerSecond: 23,
      rateSource: 'wick-customer-catalog',
      rateRetrievedAt: new Date().toISOString(),
    };
    await pool.query("UPDATE broker_catalog SET item=$2,source_mode='real' WHERE id=$1", [
      item.id,
      real,
    ]);
    const userId = randomUUID();
    const supplier = (
      await pool.query(
        "INSERT INTO broker_providers(user_id,name,total_capacity,policy) VALUES($1,'Offline',1,$2) RETURNING id",
        [
          userId,
          { ...policy, minimumPriceCents: 7, basePriceCents: 7, allowedCatalogIds: [item.id] },
        ],
      )
    ).rows[0];
    const app = Fastify();
    app.setErrorHandler((e: Error & { statusCode?: number }, _r, reply) =>
      reply.code(e.statusCode ?? 500).send({ error: e.message }),
    );
    await registerMarketplace(app, {
      pool,
      config: {},
      wick: { mode: 'real' },
      requireActor: async () => ({ id: userId, role: 'provider' }),
    } as unknown as AppContext);
    const body = {
      catalogId: item.id,
      name: 'Reviewed demand allocation',
      description: 'Existing approved allocation',
      durationMinutes: 30,
      priceBasis: 'server-priced-candidate',
      priceCents: 6,
    };
    try {
      expect(
        (await app.inject({ method: 'POST', url: '/api/provider/offerings', payload: body }))
          .statusCode,
      ).toBe(409);
      expect(
        (
          await pool.query('SELECT count(*)::int AS n FROM broker_offerings WHERE provider_id=$1', [
            supplier.id,
          ])
        ).rows[0].n,
      ).toBe(0);
      const published = await app.inject({
        method: 'POST',
        url: '/api/provider/offerings',
        payload: { ...body, priceCents: 7 },
      });
      expect(published.statusCode, published.body).toBe(200);
      expect(published.json().priceCents).toBe(7);
      await pool.query(
        "UPDATE broker_providers SET policy=jsonb_set(policy,'{allowedCatalogIds}','[]') WHERE id=$1",
        [supplier.id],
      );
      expect(
        (
          await app.inject({
            method: 'POST',
            url: '/api/provider/offerings',
            payload: { ...body, name: 'Disallowed', priceCents: 7 },
          })
        ).statusCode,
      ).toBe(400);
      expect(
        (
          await pool.query('SELECT count(*)::int AS n FROM broker_offerings WHERE provider_id=$1', [
            supplier.id,
          ])
        ).rows[0].n,
      ).toBe(1);
    } finally {
      await app.close();
    }
  });
});

describe('server-priced offering duration candidates', () => {
  it('applies current real rate, integer target, policy floor and explicit 30-minute semantics', () => {
    const real: CatalogItem = {
      ...item,
      provider: 'e2b',
      pricingMode: 'managed',
      managedRouteVerification: 'execution-preview-managed',
      rateMicrosPerSecond: 23,
      rateSource: 'wick-customer-catalog',
      rateRetrievedAt: new Date().toISOString(),
    };
    expect(offeringPriceCandidates([real], { ...policy, minimumPriceCents: 7 }, 'real')).toEqual([
      { id: `${item.id}:30`, catalogId: item.id, durationMinutes: 30, totalPriceCents: 7 },
    ]);
    expect(offeringPriceCandidates([real], { ...policy, allowedCatalogIds: [] }, 'real')).toEqual(
      [],
    );
    expect(
      offeringPriceCandidates([{ ...real, rateRetrievedAt: '2020-01-01' }], policy, 'real'),
    ).toEqual([]);
    expect(offeringPriceCandidates([real], { ...policy, maxPriceCents: 4 }, 'real')).toEqual([]);
  });
  it('keeps fixture prices deterministic and does not invent unsupported publish durations', () => {
    expect(offeringPriceCandidates([item], policy, 'fixture')[0]).toMatchObject({
      durationMinutes: 30,
      totalPriceCents: 5,
    });
    expect(
      offeringPriceCandidates([{ ...item, durationMinutes: [15] }], policy, 'fixture'),
    ).toEqual([]);
  });
});
