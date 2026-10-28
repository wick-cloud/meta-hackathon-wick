import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { beforeAll, beforeEach, afterAll, describe, expect, it, vi } from 'vitest';
import { migrate } from '../src/server/db.js';
import { loadConfig } from '../src/server/config.js';
import type { AppContext } from '../src/server/context.js';
import type { Actor, CatalogItem } from '../src/shared/types.js';
import { revenueShare } from '../src/shared/pricing.js';
import { configureRealMarketplace } from '../src/server/marketplace/configure-real.js';
import {
  createRequest,
  submitBid,
  proposeBid,
  closeAuction,
} from '../src/server/marketplace/auction.js';
import { createMuseAdapter } from '../src/server/integrations/muse.js';
import { syncCatalog } from '../src/server/marketplace/data.js';
import {
  refreshRealCatalog,
  type CatalogRefreshJob,
} from '../src/server/marketplace/catalog-refresh.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
const schema = `broker_prices_${randomUUID().replaceAll('-', '')}`;
const item: CatalogItem = {
  id: 'real-offline-priced',
  name: 'Real contract fixture',
  description: '',
  provider: 'boat',
  profile: 'small',
  region: 'auto',
  cpu: 1,
  memoryGb: 1,
  approved: false,
  durationMinutes: [15, 30, 60],
  pricingMode: 'managed',
  managedRouteVerification: 'organization-catalog-byok-disabled',
  rateMicrosPerSecond: 5,
  rateSource: 'wick-customer-catalog',
  rateRetrievedAt: new Date().toISOString(),
};
const buyer: Actor = {
  id: 'offline-buyer',
  email: 'buyer@test.invalid',
  name: 'Buyer',
  role: 'buyer',
};
const supplier: Actor = {
  id: 'offline-supplier',
  email: 'supplier@test.invalid',
  name: 'Supplier',
  role: 'provider',
};
const options = {
  catalogIds: [item.id],
  supplierEmails: [supplier.email],
  capacity: 21,
  autoBid: false,
};

describe.skipIf(!databaseUrl)('real pricing database contracts with zero network calls', () => {
  let admin: Pool;
  let pool: Pool;
  let ctx: AppContext;
  beforeAll(async () => {
    admin = new Pool({ connectionString: databaseUrl });
    await admin.query(`CREATE SCHEMA ${schema}`);
    pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema},public` });
    await migrate(pool);
    ctx = {
      pool,
      config: loadConfig({
        NODE_ENV: 'test',
        DATABASE_URL: databaseUrl!,
        BETTER_AUTH_SECRET: 'offline-pricing-tests-with-no-external-service',
        WICK_MODE: 'fixture',
        MUSE_MODE: 'fixture',
      }),
      boss: { send: vi.fn(async () => null) },
      wick: {
        mode: 'real',
        catalog: async () => [item],
        create: vi.fn(() => {
          throw new Error('No allocations permitted');
        }),
      },
      muse: createMuseAdapter({ museMode: 'fixture' }),
      requireActor: async () => buyer,
    } as unknown as AppContext;
  });
  beforeEach(async () => {
    await pool.query(
      'TRUNCATE broker_activity,broker_invoices,broker_holds,broker_vms,broker_bids,broker_requests,broker_offerings,broker_providers,broker_catalog,"user" CASCADE',
    );
    await pool.query('INSERT INTO "user"(id,name,email,role) VALUES($1,$2,$3,$4)', [
      supplier.id,
      supplier.name,
      supplier.email,
      supplier.role,
    ]);
    await pool.query(
      'INSERT INTO "session"(id,"userId",token,"expiresAt") VALUES(\'old-session\',$1,\'test-only-session-placeholder\',now()+interval \'1 hour\')',
      [supplier.id],
    );
    await pool.query(
      'INSERT INTO account(id,"accountId","providerId","userId",password) VALUES(\'old-account\',$1,\'credential\',$1,\'test-only-password-hash-placeholder\')',
      [supplier.id],
    );
  });
  afterAll(async () => {
    await pool?.end();
    if (admin) {
      await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await admin.end();
    }
  });
  const makeRequest = () =>
    createRequest(ctx, buyer, {
      description: 'Offline real-pricing contract',
      catalogId: item.id,
      region: item.region,
      durationMinutes: 30,
      maxPriceCents: 100,
      requirements: { cpu: 1, memoryGb: 1 },
    });

  it('idempotently configures demo allocations while preserving sessions, passwords, old fixture rows and frozen bids', async () => {
    const authBefore = await Promise.all(
      ['"user"', '"session"', 'account'].map(
        async (table) => (await pool.query(`SELECT * FROM ${table}`)).rows,
      ),
    );
    const oldItem = { ...item, id: 'legacy-fixture', approved: true };
    await pool.query('INSERT INTO broker_catalog(id,item,approved) VALUES($1,$2,true)', [
      oldItem.id,
      oldItem,
    ]);
    await configureRealMarketplace(pool, [item], options);
    const request = await makeRequest();
    expect(request.pricing?.totalPriceCents).toBe(2);
    const bid = await submitBid(ctx, supplier, request.id, { totalPriceCents: 2 });
    expect(bid.pricing).toMatchObject({
      totalPriceCents: 2,
      targetTotalPriceCents: 2,
      priceBasis: 'provider-bid',
    });
    const frozenBefore = (
      await pool.query('SELECT offering_snapshot,total_price_cents FROM broker_bids WHERE id=$1', [
        bid.id,
      ])
    ).rows[0];
    await configureRealMarketplace(
      pool,
      [{ ...item, rateRetrievedAt: new Date().toISOString() }],
      options,
    );
    expect((await pool.query('SELECT count(*)::int AS n FROM broker_offerings')).rows[0].n).toBe(1);
    expect((await pool.query('SELECT revision FROM broker_offerings')).rows[0].revision).toBe(1);
    expect(
      (
        await pool.query(
          'SELECT offering_snapshot,total_price_cents FROM broker_bids WHERE id=$1',
          [bid.id],
        )
      ).rows[0],
    ).toEqual(frozenBefore);
    expect(
      (await pool.query('SELECT released_at FROM broker_holds WHERE bid_id=$1', [bid.id])).rows[0]
        .released_at,
    ).toBeNull();
    expect(
      (
        await pool.query('SELECT item,approved,source_mode FROM broker_catalog WHERE id=$1', [
          oldItem.id,
        ])
      ).rows[0],
    ).toEqual({ item: oldItem, approved: true, source_mode: 'fixture' });
    expect(
      await Promise.all(
        ['"user"', '"session"', 'account'].map(
          async (table) => (await pool.query(`SELECT * FROM ${table}`)).rows,
        ),
      ),
    ).toEqual(authBefore);
    expect(ctx.wick.create).not.toHaveBeenCalled();
  });

  it('uses 15% net coverage for new bids on a legacy 20% offering without rewriting it', async () => {
    const source = { ...item, rateMicrosPerSecond: 47 };
    await configureRealMarketplace(pool, [source], options);
    await pool.query(
      'UPDATE broker_offerings SET pricing=(pricing-\'commissionBps\') || \'{"model":"wick-managed-rate-v1","markupBps":2000}\'::jsonb,price_cents=11',
    );
    const before = (await pool.query('SELECT pricing,price_cents FROM broker_offerings')).rows[0];
    const request = await makeRequest();
    expect(request.pricing?.totalPriceCents).toBe(10);
    await expect(submitBid(ctx, supplier, request.id, { totalPriceCents: 9 })).rejects.toThrow(
      /cost floor/,
    );
    const bid = await submitBid(ctx, supplier, request.id, { totalPriceCents: 10 });
    expect(bid.pricing).toMatchObject({
      model: 'wick-provider-commission-v1',
      totalPriceCents: 10,
      commissionBps: 1500,
    });
    expect(bid.revenueShare).toEqual(revenueShare(10));
    expect((await pool.query('SELECT pricing,price_cents FROM broker_offerings')).rows[0]).toEqual(
      before,
    );
  });

  it('rejects stale offerings after catalog rate increases and preserves the old request snapshot', async () => {
    await configureRealMarketplace(pool, [item], options);
    const request = await makeRequest();
    await syncCatalog({
      ...ctx,
      wick: { ...ctx.wick, catalog: async () => [{ ...item, rateMicrosPerSecond: 10 }] },
    });
    await expect(submitBid(ctx, supplier, request.id, { totalPriceCents: 2 })).rejects.toThrow(
      /rate changed/,
    );
    expect(
      (await pool.query('SELECT catalog_snapshot FROM broker_requests WHERE id=$1', [request.id]))
        .rows[0].catalog_snapshot.rateMicrosPerSecond,
    ).toBe(5);
    expect((await pool.query('SELECT count(*)::int AS n FROM broker_holds')).rows[0].n).toBe(0);
    expect(ctx.wick.create).not.toHaveBeenCalled();
  });

  it('preserves competitive manual prices and Muse supplier policy above the upstream cost floor', async () => {
    await configureRealMarketplace(pool, [item], options);
    await pool.query(
      `UPDATE broker_providers SET policy=policy || '{"minimumPriceCents":3,"basePriceCents":7,"maxPriceCents":9}'::jsonb`,
    );
    const request = await makeRequest();
    expect(await proposeBid(ctx, supplier, request.id)).toMatchObject({
      decision: 'bid',
      totalPriceCents: 7,
      mode: 'fixture',
      modelCalled: false,
    });
    await expect(submitBid(ctx, supplier, request.id, { totalPriceCents: 2 })).rejects.toThrow(
      /policy/,
    );
    await expect(submitBid(ctx, supplier, request.id, { totalPriceCents: 10 })).rejects.toThrow(
      /policy/,
    );
    const bid = await submitBid(ctx, supplier, request.id, { totalPriceCents: 8 });
    expect(bid.totalPriceCents).toBe(8);
    expect(bid.revenueShare).toEqual(revenueShare(8));
    expect(bid.pricing).toMatchObject({
      totalPriceCents: 8,
      targetTotalPriceCents: 2,
      upstreamEstimatedComputeMicros: '9000',
    });
    expect(ctx.wick.create).not.toHaveBeenCalled();
  });

  it('rejects a below-cost manual bid and raises Muse minimum without overriding provider base', async () => {
    const costlier = { ...item, rateMicrosPerSecond: 23 };
    await configureRealMarketplace(pool, [costlier], options);
    await pool.query(
      `UPDATE broker_providers SET policy=policy || '{"minimumPriceCents":1,"basePriceCents":1}'::jsonb`,
    );
    const request = await makeRequest();
    expect(await proposeBid(ctx, supplier, request.id)).toMatchObject({
      decision: 'bid',
      totalPriceCents: 5,
      mode: 'fixture',
    });
    await expect(submitBid(ctx, supplier, request.id, { totalPriceCents: 4 })).rejects.toThrow(
      /cost floor/,
    );
    expect(
      (await submitBid(ctx, supplier, request.id, { totalPriceCents: 5 })).totalPriceCents,
    ).toBe(5);
  });

  it('rejects unsafe model prices independently of the model adapter', async () => {
    await configureRealMarketplace(pool, [{ ...item, rateMicrosPerSecond: 23 }], options);
    await pool.query(
      `UPDATE broker_providers SET policy=policy || '{"minimumPriceCents":1,"basePriceCents":5,"maxPriceCents":9}'::jsonb`,
    );
    const request = await makeRequest();
    for (const price of [4, 10, 101]) {
      const proposed = vi.fn(async () => ({
        decision: 'bid' as const,
        totalPriceCents: price,
        catalogId: item.id,
        receipt: { observed: [], decision: '', constraints: [] },
      }));
      await expect(
        proposeBid(
          { ...ctx, muse: { ...ctx.muse, mode: 'real', proposeBid: proposed } },
          supplier,
          request.id,
        ),
      ).rejects.toThrow(/policy|budget/);
      expect(proposed.mock.calls[0]).toBeDefined();
    }
    expect(ctx.wick.create).not.toHaveBeenCalled();
    expect((await pool.query('SELECT count(*)::int AS n FROM broker_bids')).rows[0].n).toBe(0);
  });

  it('rejects stale and future chosen catalog sources before new requests while preserving existing quote views', async () => {
    await configureRealMarketplace(pool, [item], options);
    const request = await makeRequest();
    const bid = await submitBid(ctx, supplier, request.id, { totalPriceCents: 2 });
    const frozen = (
      await pool.query('SELECT offering_snapshot FROM broker_bids WHERE id=$1', [bid.id])
    ).rows[0];
    for (const offset of [-16 * 60 * 1000, 61 * 1000]) {
      const invalid = { ...item, rateRetrievedAt: new Date(Date.now() + offset).toISOString() };
      await pool.query('UPDATE broker_catalog SET item=$1 WHERE id=$2', [invalid, item.id]);
      await expect(makeRequest()).rejects.toThrow(/stale|future/);
      await expect(configureRealMarketplace(pool, [invalid], options)).rejects.toThrow(
        /stale|future/,
      );
    }
    expect(
      (await pool.query('SELECT offering_snapshot FROM broker_bids WHERE id=$1', [bid.id])).rows[0],
    ).toEqual(frozen);
    expect(ctx.wick.create).not.toHaveBeenCalled();
  });

  it('keeps BYOK unsupported and does not invent supplier accounts', async () => {
    await expect(
      configureRealMarketplace(pool, [{ ...item, pricingMode: 'byok' }], options),
    ).rejects.toThrow(/BYOK/);
    await expect(
      configureRealMarketplace(pool, [item], {
        ...options,
        supplierEmails: ['unknown@test.invalid'],
      }),
    ).rejects.toThrow(/existing|invited/);
    expect((await pool.query('SELECT count(*)::int AS n FROM broker_catalog')).rows[0].n).toBe(0);
    expect((await pool.query('SELECT count(*)::int AS n FROM "user"')).rows[0].n).toBe(1);
  });

  it('refreshes stale approved rates without changing accepted prices or approving new routes', async () => {
    const approved = {
      ...item,
      id: 'refresh-e2b',
      provider: 'e2b',
      organizationId: 'test-org',
      groupId: 'test-group',
    };
    const refreshOptions = { ...options, catalogIds: [approved.id] };
    await configureRealMarketplace(pool, [approved], refreshOptions);
    const legacy = { ...item, id: 'legacy-refresh-fixture', approved: true };
    await pool.query('INSERT INTO broker_catalog(id,item,approved) VALUES($1,$2,true)', [
      legacy.id,
      legacy,
    ]);
    const scoped = {
      ...ctx,
      config: { ...ctx.config, wickOrganizationId: 'test-org', wickGroupId: 'test-group' },
    };
    const requestBody = {
      description: 'Catalog refresh preserves the accepted rental',
      catalogId: approved.id,
      region: approved.region,
      durationMinutes: 30,
      maxPriceCents: 100,
      requirements: { cpu: 1, memoryGb: 1 },
    };
    // Shorten only this isolated test schema's default; request deadlines stay immutable.
    await pool.query(
      "ALTER TABLE broker_requests ALTER COLUMN closes_at SET DEFAULT now()+interval '2 seconds'",
    );
    let request: Awaited<ReturnType<typeof createRequest>>;
    try {
      request = await createRequest(scoped, buyer, requestBody);
    } finally {
      await pool.query(
        "ALTER TABLE broker_requests ALTER COLUMN closes_at SET DEFAULT now()+interval '30 seconds'",
      );
    }
    const bid = await submitBid(scoped, supplier, request.id, { totalPriceCents: 2 });
    await new Promise((resolve) =>
      setTimeout(resolve, Math.max(0, Date.parse(request.closesAt!) - Date.now()) + 25),
    );
    await closeAuction(scoped, request.id);
    const frozen = (
      await pool.query(
        'SELECT catalog_snapshot,quote_snapshot FROM broker_vms WHERE request_id=$1',
        [request.id],
      )
    ).rows[0];
    expect(frozen.quote_snapshot.totalPriceCents).toBe(2);
    expect(frozen.quote_snapshot.revenueShare).toEqual(revenueShare(2));
    expect(
      (await pool.query('SELECT status FROM broker_bids WHERE id=$1', [bid.id])).rows[0].status,
    ).toBe('won');

    await pool.query('UPDATE broker_catalog SET item=$1 WHERE id=$2', [
      { ...approved, rateRetrievedAt: new Date(Date.now() - 16 * 60 * 1000).toISOString() },
      approved.id,
    ]);
    await expect(createRequest(scoped, buyer, requestBody)).rejects.toThrow(/stale/);
    const latest = {
      ...approved,
      rateMicrosPerSecond: 10,
      rateRetrievedAt: new Date().toISOString(),
    };
    const discovered = { ...latest, id: 'new-unapproved-e2b' };
    const fetchCatalog = vi.fn(async () => [latest, discovered]);
    await refreshRealCatalog(
      { ...scoped, wick: { ...ctx.wick, catalog: fetchCatalog } },
      { mode: 'real', organizationId: 'test-org', groupId: 'test-group' },
    );
    expect(fetchCatalog).toHaveBeenCalledTimes(1);
    expect(
      (
        await pool.query(
          'SELECT id,approved FROM broker_catalog WHERE source_mode=$1 ORDER BY id',
          ['real'],
        )
      ).rows,
    ).toEqual([
      { id: discovered.id, approved: false },
      { id: approved.id, approved: true },
    ]);
    expect(
      (
        await pool.query('SELECT item,approved,source_mode FROM broker_catalog WHERE id=$1', [
          legacy.id,
        ])
      ).rows[0],
    ).toEqual({
      item: legacy,
      approved: true,
      source_mode: 'fixture',
    });
    expect(
      (
        await pool.query(
          'SELECT catalog_snapshot,quote_snapshot FROM broker_vms WHERE request_id=$1',
          [request.id],
        )
      ).rows[0],
    ).toEqual(frozen);
    expect((await createRequest(scoped, buyer, requestBody)).pricing?.rateMicrosPerSecond).toBe(10);
    expect(ctx.wick.create).not.toHaveBeenCalled();
  });

  it('rejects overlapping refreshes before their SDK read and releases the lock after failure', async () => {
    let release!: () => void;
    let signalStarted!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = new Promise<void>((resolve) => {
      signalStarted = resolve;
    });
    const firstRead = vi.fn(async () => {
      signalStarted();
      await gate;
      return [{ ...item, provider: 'e2b' }];
    });
    const secondRead = vi.fn(async () => [{ ...item, provider: 'e2b', rateMicrosPerSecond: 10 }]);
    const pending = syncCatalog({ ...ctx, wick: { ...ctx.wick, catalog: firstRead } });
    await started;
    try {
      await expect(
        syncCatalog({ ...ctx, wick: { ...ctx.wick, catalog: secondRead } }),
      ).rejects.toMatchObject({ statusCode: 409 });
      expect(secondRead).not.toHaveBeenCalled();
    } finally {
      release();
      await pending;
    }
    const beforeFailure = (
      await pool.query('SELECT item,approved,updated_at FROM broker_catalog WHERE id=$1', [item.id])
    ).rows[0];
    await expect(
      syncCatalog({
        ...ctx,
        wick: {
          ...ctx.wick,
          catalog: async () => {
            throw new Error('Offline catalog failure');
          },
        },
      }),
    ).rejects.toThrow('Offline catalog failure');
    expect(
      (
        await pool.query('SELECT item,approved,updated_at FROM broker_catalog WHERE id=$1', [
          item.id,
        ])
      ).rows[0],
    ).toEqual(beforeFailure);
    await syncCatalog({ ...ctx, wick: { ...ctx.wick, catalog: secondRead } });
    expect(secondRead).toHaveBeenCalledTimes(1);
    expect(
      (await pool.query('SELECT item FROM broker_catalog WHERE id=$1', [item.id])).rows[0].item
        .rateMicrosPerSecond,
    ).toBe(10);
    expect(ctx.wick.create).not.toHaveBeenCalled();
  });

  it('skips fixture, mismatched-scope and recently refreshed startup jobs', async () => {
    const approved = {
      ...item,
      id: 'startup-e2b',
      provider: 'e2b',
      rateRetrievedAt: new Date().toISOString(),
    };
    await configureRealMarketplace(pool, [approved], { ...options, catalogIds: [approved.id] });
    const fetchCatalog = vi.fn(async () => [
      { ...approved, rateRetrievedAt: new Date().toISOString() },
    ]);
    const scoped = {
      ...ctx,
      config: { ...ctx.config, wickOrganizationId: 'test-org', wickGroupId: 'test-group' },
      wick: { ...ctx.wick, catalog: fetchCatalog },
    };
    const job: CatalogRefreshJob = {
      mode: 'real',
      organizationId: 'test-org',
      groupId: 'test-group',
      startup: true,
    };
    await refreshRealCatalog({ ...scoped, wick: { ...scoped.wick, mode: 'fixture' } }, job);
    await refreshRealCatalog(scoped, { ...job, organizationId: 'old-org' });
    await refreshRealCatalog(scoped, { ...job, groupId: 'old-group' });
    await refreshRealCatalog(scoped, job);
    expect(fetchCatalog).not.toHaveBeenCalled();
    await pool.query('UPDATE broker_catalog SET item=$1 WHERE id=$2', [
      { ...approved, rateRetrievedAt: new Date(Date.now() - 6 * 60 * 1000).toISOString() },
      approved.id,
    ]);
    await refreshRealCatalog(scoped, job);
    expect(fetchCatalog).toHaveBeenCalledTimes(1);
    expect(ctx.wick.create).not.toHaveBeenCalled();
  });
});
