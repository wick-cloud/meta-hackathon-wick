import { CLOUD_PROVIDERS } from '../src/shared/providers.js';
import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import { Pool } from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { HttpError, type AppContext } from '../src/server/context.js';
import { migrate } from '../src/server/db.js';
import type { MuseAdapter } from '../src/server/integrations/types.js';
import { registerMarketplace } from '../src/server/marketplace/index.js';
import { registerMuse } from '../src/server/muse/index.js';
import { managedPricing } from '../src/shared/pricing.js';
import type { Actor, CatalogItem, SupplierPolicy } from '../src/shared/types.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
const schema = `broker_identity_routes_${randomUUID().replaceAll('-', '')}`;
const providerId = randomUUID();
const foreignOfferingId = randomUUID();
const actor: Actor = {
  id: 'provider-identity-e2b',
  email: 'e2b@test.invalid',
  name: 'E2B account',
  role: 'provider',
};
const items: CatalogItem[] = CLOUD_PROVIDERS.map((provider) => ({
  id: `${provider}:small:us`,
  name: `Small ${provider}`,
  description: 'Synthetic approved route for offline boundary tests',
  provider,
  profile: 'small',
  region: 'us',
  cpu: 2,
  memoryGb: 4,
  durationMinutes: [15, 30, 60],
  approved: true,
  pricingMode: 'managed',
  managedRouteVerification: 'execution-preview-managed',
  rateMicrosPerSecond: 5,
  rateSource: 'wick-customer-catalog',
  rateRetrievedAt: new Date().toISOString(),
}));
// Deliberately forge a broad editable policy: the account's native identity must still govern.
const widePolicy: SupplierPolicy = {
  autoBid: true,
  minimumPriceCents: 1,
  basePriceCents: 5,
  maxPriceCents: 1000,
  allowedCatalogIds: items.map((item) => item.id),
};
const ownPolicy: SupplierPolicy = { ...widePolicy, allowedCatalogIds: [items[0]!.id] };
const receipt = { observed: [], decision: 'Offline suggestion', constraints: [] };

describe.skipIf(!databaseUrl)('provider identity HTTP boundaries (isolated PostgreSQL)', () => {
  let admin: Pool, pool: Pool, app: FastifyInstance;
  const proposeCapacityPolicy = vi.fn<MuseAdapter['proposeCapacityPolicy']>(async () => ({
    policy: ownPolicy,
    receipt,
    mode: 'fixture',
    modelCalled: false,
  }));
  const proposeOfferings = vi.fn<MuseAdapter['proposeOfferings']>(async () => ({
    proposals: [],
    receipt,
    mode: 'fixture',
  }));

  beforeAll(async () => {
    admin = new Pool({ connectionString: databaseUrl });
    await admin.query(`CREATE SCHEMA ${schema}`);
    pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema},public` });
    await migrate(pool);
  });
  beforeEach(async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => {
        throw new Error('External calls are forbidden in this test');
      }),
    );
    proposeCapacityPolicy.mockReset();
    proposeCapacityPolicy.mockResolvedValue({
      policy: ownPolicy,
      receipt,
      mode: 'fixture',
      modelCalled: false,
    });
    proposeOfferings.mockClear();
    await pool.query('TRUNCATE broker_providers,broker_catalog,broker_requests CASCADE');
    for (const item of items)
      await pool.query(
        "INSERT INTO broker_catalog(id,item,approved,source_mode) VALUES($1,$2,true,'real')",
        [item.id, { ...item, rateRetrievedAt: new Date().toISOString() }],
      );
    await pool.query(
      `INSERT INTO broker_providers(id,user_id,name,total_capacity,policy,simulated,cloud_provider)
       VALUES($1,$2,'E2B account',5,$3,false,'e2b')`,
      [providerId, actor.id, widePolicy],
    );
    await pool.query(
      `INSERT INTO broker_offerings(id,provider_id,catalog_id,name,description,price_cents,pricing,active)
       VALUES($1,$2,$3,'Historical foreign route','Retained old offering',5,$4,false)`,
      [foreignOfferingId, providerId, items[1]!.id, managedPricing(items[1]!)],
    );
    app = Fastify();
    app.setErrorHandler((error: Error & { statusCode?: number }, _request, reply) =>
      reply.code(error.statusCode ?? 500).send({ error: error.message }),
    );
    const ctx = {
      pool,
      config: {},
      wick: { mode: 'real' },
      muse: { mode: 'fixture', proposeCapacityPolicy, proposeOfferings },
      requireActor: async (_request: unknown, roles?: string[]) => {
        if (roles && !roles.includes(actor.role)) throw new HttpError(403, 'Forbidden.');
        return actor;
      },
    } as unknown as AppContext;
    await registerMarketplace(app, ctx);
    await registerMuse(app, ctx);
  });
  afterEach(async () => {
    await app?.close();
    expect(fetch).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
  afterAll(async () => {
    await pool?.end();
    if (admin) {
      await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await admin.end();
    }
  });
  const providerRow = async () =>
    (
      await pool.query(
        'SELECT cloud_provider,policy,policy_revision,policy_apply_receipt,total_capacity FROM broker_providers WHERE id=$1',
        [providerId],
      )
    ).rows[0];

  it('rejects foreign publication and reactivation despite a forged broad policy; own offerings work', async () => {
    const body = {
      name: 'Reviewed route',
      description: 'Provider-owned offering',
      catalogId: items[1]!.id,
    };
    const rejected = await app.inject({
      method: 'POST',
      url: '/api/provider/offerings',
      payload: body,
    });
    expect(rejected.statusCode).toBe(403);
    expect(rejected.json().error).toContain('different provider account');
    expect((await pool.query('SELECT count(*)::int AS n FROM broker_offerings')).rows[0].n).toBe(1);
    const before = (
      await pool.query('SELECT active,revision FROM broker_offerings WHERE id=$1', [
        foreignOfferingId,
      ])
    ).rows[0];
    const reactivated = await app.inject({
      method: 'PATCH',
      url: `/api/provider/offerings/${foreignOfferingId}`,
      payload: { active: true, cloudProvider: 'daytona' },
    });
    expect(reactivated.statusCode).toBe(403);
    expect(
      (
        await pool.query('SELECT active,revision FROM broker_offerings WHERE id=$1', [
          foreignOfferingId,
        ])
      ).rows[0],
    ).toEqual(before);

    const published = await app.inject({
      method: 'POST',
      url: '/api/provider/offerings',
      payload: { ...body, catalogId: items[0]!.id, cloudProvider: 'daytona' },
    });
    expect(published.statusCode, published.body).toBe(200);
    expect(published.json()).toMatchObject({
      catalogId: items[0]!.id,
      cloudProvider: 'e2b',
      simulated: false,
      active: true,
    });
    const offeringId = published.json().id;
    expect(
      (
        await app.inject({
          method: 'PATCH',
          url: `/api/provider/offerings/${offeringId}`,
          payload: { active: false },
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await app.inject({
          method: 'PATCH',
          url: `/api/provider/offerings/${offeringId}`,
          payload: { active: true },
        })
      ).statusCode,
    ).toBe(200);
    expect((await providerRow()).cloud_provider).toBe('e2b');
  });

  it.each(['sail', 'provider-tenki', 'provider-freestyle', 'boat'])(
    'publishes only the bound %s route and preserves that identity',
    async (cloudProvider) => {
      const own = items.find((item) => item.provider === cloudProvider)!;
      await pool.query('UPDATE broker_providers SET cloud_provider=$2 WHERE id=$1', [
        providerId,
        cloudProvider,
      ]);
      const published = await app.inject({
        method: 'POST',
        url: '/api/provider/offerings',
        payload: {
          name: 'New provider route',
          description: 'Offline qualified configuration',
          catalogId: own.id,
        },
      });
      expect(published.statusCode, published.body).toBe(200);
      expect(published.json()).toMatchObject({ cloudProvider, catalogId: own.id, active: true });
      const rejected = await app.inject({
        method: 'POST',
        url: '/api/provider/offerings',
        payload: {
          name: 'Foreign provider route',
          description: 'Must remain forbidden',
          catalogId: items[0]!.id,
        },
      });
      expect(rejected.statusCode, rejected.body).toBe(403);
      expect((await providerRow()).cloud_provider).toBe(cloudProvider);
    },
  );

  it('rejects unknown native identities in the expanded database constraint', async () => {
    await expect(
      pool.query('UPDATE broker_providers SET cloud_provider=$2 WHERE id=$1', [
        providerId,
        'provider-unknown',
      ]),
    ).rejects.toMatchObject({ code: '23514' });
    expect((await providerRow()).cloud_provider).toBe('e2b');
  });

  it('rejects foreign policy IDs and identity edits while preserving atomic revisions and readonly dashboard identity', async () => {
    const before = await providerRow();
    const body = {
      ...widePolicy,
      expectedRevision: before.policy_revision,
      operationKey: 'foreign-policy-123',
    };
    const rejected = await app.inject({
      method: 'PUT',
      url: '/api/provider/policy',
      payload: body,
    });
    expect(rejected.statusCode).toBe(403);
    expect(await providerRow()).toEqual(before);
    for (const key of ['cloudProvider', 'cloud_provider']) {
      expect(
        (
          await app.inject({
            method: 'PUT',
            url: '/api/provider/policy',
            payload: { ...body, [key]: 'daytona' },
          })
        ).statusCode,
      ).toBe(400);
      expect(await providerRow()).toEqual(before);
    }
    const own = await app.inject({
      method: 'PUT',
      url: '/api/provider/policy',
      payload: {
        ...ownPolicy,
        expectedRevision: before.policy_revision,
        operationKey: 'own-policy-123',
      },
    });
    expect(own.statusCode, own.body).toBe(200);
    expect(own.json().policy.allowedCatalogIds).toEqual([items[0]!.id]);
    expect(own.json().policyRevision).toBe(before.policy_revision + 1);
    const capacity = await app.inject({
      method: 'PUT',
      url: '/api/provider/capacity',
      payload: { total: 7, cloudProvider: 'daytona', cloud_provider: 'daytona' },
    });
    expect(capacity.statusCode).toBe(200);
    const dashboard = await app.inject({
      method: 'GET',
      url: `/api/provider/dashboard?providerId=${randomUUID()}`,
    });
    expect(dashboard.statusCode).toBe(200);
    expect(dashboard.json().provider).toMatchObject({
      id: providerId,
      cloudProvider: 'e2b',
      simulated: false,
    });
    expect(dashboard.json().capacity.total).toBe(7);
    expect((await providerRow()).cloud_provider).toBe('e2b');
  });

  it('limits policy proposal input to the bound cloud and rejects a foreign model suggestion', async () => {
    const proposal = await app.inject({
      method: 'POST',
      url: '/api/provider/policy/propose',
      payload: { strategy: 'Leave one spare slot' },
    });
    expect(proposal.statusCode, proposal.body).toBe(200);
    expect(proposeCapacityPolicy).toHaveBeenCalledOnce();
    expect(proposeCapacityPolicy.mock.calls[0]![0]).toMatchObject({
      catalogIds: [items[0]!.id],
      capacity: { total: 5, held: 0, available: 5 },
    });
    const before = await providerRow();
    proposeCapacityPolicy.mockResolvedValueOnce({
      policy: widePolicy,
      receipt,
      mode: 'fixture',
      modelCalled: false,
    });
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/provider/policy/propose',
          payload: { strategy: 'Suggest another route' },
        })
      ).statusCode,
    ).toBe(422);
    expect(await providerRow()).toEqual(before);
  });

  it('sends Muse only owned catalog, prices and scoped demand even with a broad policy', async () => {
    for (const item of items)
      await pool.query(
        `INSERT INTO broker_requests(buyer_id,description,catalog_id,catalog_snapshot,region,duration_minutes,max_price_cents,requirements,status)
         VALUES('private-buyer','private requirements prose',$1,$2,'us',30,100,'{"cpu":2,"memoryGb":4}','no_offers')`,
        [item.id, { ...item, sourceMode: 'real' }],
      );
    const response = await app.inject({
      method: 'POST',
      url: '/api/provider/offerings/propose',
      payload: {},
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(proposeOfferings).toHaveBeenCalledOnce();
    const input = proposeOfferings.mock.calls[0]![0];
    expect(input.catalog.map((item) => item.id)).toEqual([items[0]!.id]);
    expect(input.pricedCandidates?.map((candidate) => candidate.catalogId)).toEqual([items[0]!.id]);
    expect(input.demand).toEqual([
      { region: 'us', durationMinutes: 30, requirements: { cpu: 2, memoryGb: 4 }, count: 1 },
    ]);
    expect(JSON.stringify(input)).not.toMatch(/private-buyer|private requirements prose/);
  });
});
