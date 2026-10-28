import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { beforeAll, beforeEach, afterAll, describe, expect, it, vi } from 'vitest';
import { migrate } from '../src/server/db.js';
import { loadConfig } from '../src/server/config.js';
import type { AppContext } from '../src/server/context.js';
import type { Actor, CatalogItem } from '../src/shared/types.js';
import { configureRealMarketplace } from '../src/server/marketplace/configure-real.js';
import { createRequest, submitBid } from '../src/server/marketplace/auction.js';
import { syncCatalog } from '../src/server/marketplace/data.js';

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
  rateMicrosPerSecond: 5,
  rateSource: 'wick-customer-catalog',
  rateRetrievedAt: '2026-10-28T00:00:00Z',
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
  markupBps: 2000,
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
      muse: { mode: 'fixture' },
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
    await expect(submitBid(ctx, supplier, request.id, { totalPriceCents: 1 })).rejects.toThrow(
      /2 USD cents/,
    );
    const bid = await submitBid(ctx, supplier, request.id, { totalPriceCents: 2 });
    const frozenBefore = (
      await pool.query('SELECT offering_snapshot,total_price_cents FROM broker_bids WHERE id=$1', [
        bid.id,
      ])
    ).rows[0];
    await configureRealMarketplace(
      pool,
      [{ ...item, rateRetrievedAt: '2026-10-28T01:00:00Z' }],
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
});
