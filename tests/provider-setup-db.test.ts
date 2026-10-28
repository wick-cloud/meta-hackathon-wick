import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { verifyPassword } from 'better-auth/crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { migrate } from '../src/server/db.js';
import { managedPricing } from '../src/shared/pricing.js';
import type { CatalogItem } from '../src/shared/types.js';
import {
  configureProviderMarketplace,
  configureRealMarketplace,
  type ProviderMarketplaceSetup,
} from '../src/server/marketplace/configure-real.js';
import {
  CLOUD_PROVIDERS,
  assertProviderCatalog,
  assertProviderCatalogIds,
} from '../src/server/marketplace/provider-identity.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
const schema = `broker_provider_setup_${randomUUID().replaceAll('-', '')}`;
const password = 'provider-test-only-password';
const names = ['E2B', 'Daytona', 'Baseten', 'Modal'];
const catalog: CatalogItem[] = CLOUD_PROVIDERS.map((provider, index) => ({
  id: `${provider}:small:us`,
  name: `${names[index]} small`,
  description: 'Offline contract',
  provider,
  profile: 'small',
  region: 'us',
  cpu: 1,
  memoryGb: 1,
  approved: false,
  durationMinutes: [15, 30, 60],
  pricingMode: 'managed',
  managedRouteVerification: 'organization-catalog-byok-disabled',
  rateMicrosPerSecond: 5 + index,
  rateSource: 'wick-customer-catalog',
  rateRetrievedAt: new Date().toISOString(),
}));
const setup = (): ProviderMarketplaceSetup => ({
  providers: CLOUD_PROVIDERS.map((cloudProvider, index) => ({
    cloudProvider,
    name: names[index],
    email: `${index}@providers.test.invalid`,
    password,
    catalogIds: [catalog[index].id],
    capacity: 5,
    autoBid: true,
  })),
  retireSupplierEmails: ['old@suppliers.test.invalid'],
});

describe('provider cloud identity', () => {
  it('allows legacy rows and rejects another cloud for bound providers', () => {
    expect(() => assertProviderCatalog({}, { provider: 'e2b' })).not.toThrow();
    expect(() =>
      assertProviderCatalog({ cloud_provider: 'e2b' }, { provider: 'e2b' }),
    ).not.toThrow();
    expect(() => assertProviderCatalog({ cloud_provider: 'e2b' }, { provider: 'modal' })).toThrow(
      'different provider',
    );
  });
});

describe.skipIf(!databaseUrl)('operator provider setup with no external calls', () => {
  let admin: Pool;
  let pool: Pool;
  let oldProviderId: string;
  const historyTables = [
    'broker_requests',
    'broker_bids',
    'broker_holds',
    'broker_vms',
    'broker_invoices',
  ];
  const snapshot = async (tables: string[]) =>
    Promise.all(
      tables.map(async (table) => (await pool.query(`SELECT * FROM ${table} ORDER BY id`)).rows),
    );

  beforeAll(async () => {
    admin = new Pool({ connectionString: databaseUrl });
    await admin.query(`CREATE SCHEMA ${schema}`);
    pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema},public` });
    await migrate(pool);
  });
  beforeEach(async () => {
    await pool.query('TRUNCATE "user",broker_catalog,broker_providers,broker_requests CASCADE');
    await pool.query(`INSERT INTO "user"(id,email,name,role) VALUES
      ('buyer','buyer@test.invalid','Existing buyer','buyer'),
      ('admin','admin@test.invalid','Existing admin','admin'),
      ('old','old@suppliers.test.invalid','Existing supplier','provider')`);
    await pool.query(`INSERT INTO account(id,"accountId","providerId","userId",password)
      SELECT id,id,'credential',id,'existing-password-hash' FROM "user"`);
    await pool.query(`INSERT INTO "session"(id,"userId",token,"expiresAt")
      SELECT id,id,id,now()+interval '1 hour' FROM "user"`);
    oldProviderId = (
      await pool.query(
        `INSERT INTO broker_providers(user_id,name,total_capacity,policy)
       VALUES('old','Legacy supplier',10,$1) RETURNING id`,
        [
          {
            autoBid: true,
            minimumPriceCents: 1,
            basePriceCents: 5,
            allowedCatalogIds: [catalog[0].id],
          },
        ],
      )
    ).rows[0].id;
    await pool.query(
      "INSERT INTO broker_catalog(id,item,approved,source_mode) VALUES($1,$2,true,'real'),('old-fixture',$2,true,'fixture')",
      [catalog[0].id, catalog[0]],
    );
    const offering = (
      await pool.query(
        `INSERT INTO broker_offerings(provider_id,catalog_id,name,description,price_cents,pricing)
       VALUES($1,$2,'Legacy real','Historical',5,$3) RETURNING id`,
        [oldProviderId, catalog[0].id, managedPricing(catalog[0])],
      )
    ).rows[0].id;
    await pool.query(
      `INSERT INTO broker_offerings(provider_id,catalog_id,name,description,price_cents)
      VALUES($1,'old-fixture','Legacy fixture','Historical fixture',5)`,
      [oldProviderId],
    );
    const requestId = (
      await pool.query(
        `INSERT INTO broker_requests(buyer_id,description,catalog_id,catalog_snapshot,region,duration_minutes,max_price_cents,requirements)
       VALUES('buyer','Frozen historical request',$1,$2,'us',30,10,'{"cpu":1,"memoryGb":1}') RETURNING id`,
        [catalog[0].id, { ...catalog[0], sourceMode: 'real' }],
      )
    ).rows[0].id;
    const bidId = (
      await pool.query(
        `INSERT INTO broker_bids(request_id,provider_id,offering_id,offering_snapshot,total_price_cents)
       VALUES($1,$2,$3,'{"frozen":true}',5) RETURNING id`,
        [requestId, oldProviderId, offering],
      )
    ).rows[0].id;
    await pool.query('INSERT INTO broker_holds(bid_id,provider_id) VALUES($1,$2)', [
      bidId,
      oldProviderId,
    ]);
    const vmId = (
      await pool.query(
        `INSERT INTO broker_vms(request_id,buyer_id,provider_id,bid_id,create_key,create_input,catalog_snapshot,quote_snapshot)
       VALUES($1,'buyer',$2,$3,'frozen-create-key','{}',$4,'{"totalPriceCents":5}') RETURNING id`,
        [requestId, oldProviderId, bidId, { ...catalog[0], sourceMode: 'real' }],
      )
    ).rows[0].id;
    await pool.query(
      "INSERT INTO broker_invoices(vm_id,buyer_id,provider_id,subtotal_cents,total_cents) VALUES($1,'buyer',$2,5,5)",
      [vmId, oldProviderId],
    );
  });
  afterAll(async () => {
    await pool?.end();
    if (admin) {
      await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await admin.end();
    }
  });

  it('creates four correctly priced cloud accounts while preserving auth, leases and frozen history', async () => {
    const authBefore = await snapshot(['"user"', 'account', '"session"']);
    const historyBefore = await snapshot(historyTables);
    const report = await configureProviderMarketplace(pool, catalog, setup());
    expect(report.createdAccounts).toBe(4);
    expect(report.retiredSuppliers).toBe(1);
    expect(report.commissionBps).toBe(1500);
    expect(JSON.stringify(report)).not.toContain(password);
    for (let i = 0; i < setup().providers.length; i++) {
      const input = setup().providers[i];
      const provider = (
        await pool.query(
          'SELECT p.*,u.email,u."providerId" FROM broker_providers p JOIN "user" u ON u.id=p.user_id WHERE u.email=$1',
          [input.email],
        )
      ).rows[0];
      expect(provider.cloud_provider).toBe(input.cloudProvider);
      expect(provider.providerId).toBe(provider.id);
      expect(provider.total_capacity).toBe(5);
      expect(provider.policy.allowedCatalogIds).toEqual(input.catalogIds);
      expect(provider.simulated).toBe(false);
      const credential = (
        await pool.query('SELECT password FROM account WHERE "userId"=$1', [provider.user_id])
      ).rows[0];
      expect(await verifyPassword({ hash: credential.password, password })).toBe(true);
      const offering = (
        await pool.query('SELECT * FROM broker_offerings WHERE provider_id=$1', [provider.id])
      ).rows[0];
      expect(offering.catalog_id).toBe(catalog[i].id);
      expect(offering.pricing.rateMicrosPerSecond).toBe(catalog[i].rateMicrosPerSecond);
      expect(offering.description).toContain(input.cloudProvider);
    }
    const authAfter = await snapshot(['"user"', 'account', '"session"']);
    expect(
      authAfter.map((rows, index) =>
        rows.filter((row) => authBefore[index].some((old) => old.id === row.id)),
      ),
    ).toEqual(authBefore);
    expect(await snapshot(historyTables)).toEqual(historyBefore);
    const legacy = (
      await pool.query('SELECT policy,total_capacity FROM broker_providers WHERE id=$1', [
        oldProviderId,
      ])
    ).rows[0];
    expect(legacy.policy.autoBid).toBe(false);
    expect(legacy.total_capacity).toBe(10);
    expect(
      (
        await pool.query(
          'SELECT name,active FROM broker_offerings WHERE provider_id=$1 ORDER BY name',
          [oldProviderId],
        )
      ).rows,
    ).toEqual([
      { name: 'Legacy fixture', active: true },
      { name: 'Legacy real', active: false },
    ]);
  });

  it('serializes concurrent replays without replacing passwords, sessions or identities', async () => {
    await configureProviderMarketplace(pool, catalog, setup());
    const authBefore = await snapshot(['"user"', 'account', '"session"']);
    const providersBefore = await snapshot(['broker_providers', 'broker_offerings']);
    const retry = setup();
    retry.providers.forEach((provider) => (provider.password = 'ignored-replacement-password'));
    const reports = await Promise.all([
      configureProviderMarketplace(pool, catalog, retry),
      configureProviderMarketplace(pool, catalog, retry),
    ]);
    expect(reports.map((report) => report.createdAccounts)).toEqual([0, 0]);
    expect(await snapshot(['"user"', 'account', '"session"'])).toEqual(authBefore);
    expect(await snapshot(['broker_providers', 'broker_offerings'])).toEqual(providersBefore);
  });

  it('rejects role, binding and cross-cloud configuration collisions atomically', async () => {
    const badRole = setup();
    badRole.providers[0].email = 'buyer@test.invalid';
    await expect(configureProviderMarketplace(pool, catalog, badRole)).rejects.toThrow(
      'another role',
    );
    expect((await pool.query('SELECT count(*)::int AS n FROM "user"')).rows[0].n).toBe(3);
    const badCatalog = setup();
    badCatalog.providers[0].catalogIds = [catalog[1].id];
    await expect(configureProviderMarketplace(pool, catalog, badCatalog)).rejects.toThrow(
      'assigned upstream',
    );
    await configureProviderMarketplace(pool, catalog, setup());
    const before = await snapshot(['"user"', 'account', 'broker_providers', 'broker_offerings']);
    const badBinding = setup();
    [badBinding.providers[0].email, badBinding.providers[1].email] = [
      badBinding.providers[1].email,
      badBinding.providers[0].email,
    ];
    await expect(configureProviderMarketplace(pool, catalog, badBinding)).rejects.toThrow(
      'different upstream',
    );
    await expect(
      configureRealMarketplace(pool, catalog, {
        catalogIds: [catalog[0].id],
        supplierEmails: [setup().providers[0].email],
        capacity: 5,
        autoBid: true,
      }),
    ).rejects.toThrow('provider-specific');
    expect(await snapshot(['"user"', 'account', 'broker_providers', 'broker_offerings'])).toEqual(
      before,
    );
  });

  it('validates editable policy IDs against the readonly cloud binding and source mode', async () => {
    await configureProviderMarketplace(pool, catalog, setup());
    await expect(
      assertProviderCatalogIds(pool, { cloud_provider: 'e2b' }, [catalog[0].id], 'real'),
    ).resolves.toBeUndefined();
    await expect(
      assertProviderCatalogIds(pool, { cloud_provider: 'e2b' }, [catalog[1].id], 'real'),
    ).rejects.toThrow('belong to this provider');
    await expect(
      assertProviderCatalogIds(pool, { cloud_provider: 'e2b' }, [catalog[0].id], 'fixture'),
    ).rejects.toThrow('belong to this provider');
    await expect(
      assertProviderCatalogIds(pool, { cloud_provider: 'e2b' }, undefined, 'real'),
    ).resolves.toBeUndefined();
  });
});
