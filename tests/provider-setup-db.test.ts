import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { verifyPassword } from 'better-auth/crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { migrate } from '../src/server/db.js';
import { fixedQuote, managedPricing } from '../src/shared/pricing.js';
import type { CatalogItem } from '../src/shared/types.js';
import {
  configureProviderMarketplace,
  providerSetupBasePrice,
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
const names = ['E2B', 'Daytona', 'Baseten', 'Modal', 'Sail', 'Tenki', 'Freestyle', 'Boat.dev'];
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
  mode: 'activate',
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

  it('creates eight correctly priced cloud accounts while preserving auth, leases and frozen history', async () => {
    const authBefore = await snapshot(['"user"', 'account', '"session"']);
    const historyBefore = await snapshot(historyTables);
    const report = await configureProviderMarketplace(pool, catalog, setup());
    expect(report.createdAccounts).toBe(8);
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
      expect(provider.policy.minimumPriceCents).toBe(1);
      expect(provider.policy.basePriceCents).toBe(
        providerSetupBasePrice(fixedQuote(managedPricing(catalog[i]), 30).totalPriceCents),
      );
      expect(provider.policy.autoBid).toBe(true);
      expect(provider.simulated).toBe(false);
      const credential = (
        await pool.query('SELECT password FROM account WHERE "userId"=$1', [provider.user_id])
      ).rows[0];
      expect(await verifyPassword({ hash: credential.password, password })).toBe(true);
      const offering = (
        await pool.query('SELECT * FROM broker_offerings WHERE provider_id=$1', [provider.id])
      ).rows[0];
      expect(offering.catalog_id).toBe(catalog[i].id);
      expect(Number(offering.price_cents)).toBe(provider.policy.basePriceCents);
      expect(offering.active).toBe(true);
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

  it('stages only the four additions without resupplying existing credentials or changing existing accounts', async () => {
    const original = setup();
    original.providers = original.providers.slice(0, 4);
    original.retireSupplierEmails = [];
    await configureProviderMarketplace(pool, catalog, original);
    const before = await snapshot([
      '"user"',
      'account',
      '"session"',
      'broker_providers',
      'broker_offerings',
      'broker_catalog',
    ]);
    const additions = setup();
    delete additions.mode;
    additions.retireSupplierEmails = [];
    additions.providers = additions.providers.slice(4).map((p) => ({ ...p, capacity: 1 }));
    const report = await configureProviderMarketplace(pool, catalog, additions);
    expect(report.createdAccounts).toBe(4);
    expect(report.setupMode).toBe('stage');
    expect(report.approvedConfigurations).toBe(0);
    const after = await snapshot([
      '"user"',
      'account',
      '"session"',
      'broker_providers',
      'broker_offerings',
      'broker_catalog',
    ]);
    expect(
      after.map((rows, index) => rows.filter((r) => before[index].some((old) => old.id === r.id))),
    ).toEqual(before);
    for (const p of report.providers) {
      expect(p.capacity).toBe(1);
      expect(p.autoBid).toBe(false);
    }
    const newCatalog = await pool.query(
      'SELECT approved FROM broker_catalog WHERE id=ANY($1::text[])',
      [additions.providers.flatMap((p) => p.catalogIds)],
    );
    expect(newCatalog.rows).toEqual(Array.from({ length: 4 }, () => ({ approved: false })));
    const newOfferings = await pool.query(
      'SELECT active FROM broker_offerings WHERE catalog_id=ANY($1::text[])',
      [additions.providers.flatMap((p) => p.catalogIds)],
    );
    expect(newOfferings.rows).toEqual(Array.from({ length: 4 }, () => ({ active: false })));
    const retry = {
      ...additions,
      providers: additions.providers.map((p) => ({ ...p, password: undefined })),
    };
    expect((await configureProviderMarketplace(pool, catalog, retry)).createdAccounts).toBe(0);
    expect(
      await snapshot([
        '"user"',
        'account',
        '"session"',
        'broker_providers',
        'broker_offerings',
        'broker_catalog',
      ]),
    ).toEqual(after);
  });

  it('preserves customized capacity, policies, renamed offerings and approval on default retries; activation and update are explicit', async () => {
    const selected = {
      ...setup(),
      providers: [setup().providers[4]],
      retireSupplierEmails: [],
      mode: 'stage' as const,
    };
    await configureProviderMarketplace(pool, catalog, selected);
    const provider = (
      await pool.query("SELECT * FROM broker_providers WHERE cloud_provider='sail'")
    ).rows[0];
    const customPolicy = {
      ...provider.policy,
      basePriceCents: 123.45,
      maxPriceCents: 200,
      reserveSlots: 2,
      operatorNote: 'keep this',
    };
    await pool.query('UPDATE broker_providers SET total_capacity=7,policy=$2 WHERE id=$1', [
      provider.id,
      customPolicy,
    ]);
    await pool.query(
      "UPDATE broker_offerings SET name='Custom renamed allocation',price_cents=123.45,active=false,revision=9 WHERE provider_id=$1",
      [provider.id],
    );
    const before = await snapshot([
      '"user"',
      'account',
      '"session"',
      'broker_providers',
      'broker_offerings',
      'broker_catalog',
      ...historyTables,
    ]);
    const retry = {
      ...selected,
      providers: selected.providers.map((p) => ({ ...p, password: undefined, capacity: 1 })),
    };
    delete (retry as ProviderMarketplaceSetup).mode;
    await configureProviderMarketplace(pool, catalog, retry);
    expect(
      await snapshot([
        '"user"',
        'account',
        '"session"',
        'broker_providers',
        'broker_offerings',
        'broker_catalog',
        ...historyTables,
      ]),
    ).toEqual(before);
    await configureProviderMarketplace(pool, catalog, { ...retry, mode: 'activate' });
    const activated = (
      await pool.query('SELECT * FROM broker_providers WHERE id=$1', [provider.id])
    ).rows[0];
    expect(activated.total_capacity).toBe(7);
    expect(activated.policy).toEqual({ ...customPolicy, autoBid: true });
    const offering = (
      await pool.query('SELECT * FROM broker_offerings WHERE provider_id=$1', [provider.id])
    ).rows;
    expect(offering).toHaveLength(1);
    expect(offering[0]).toMatchObject({
      name: 'Custom renamed allocation',
      active: true,
      revision: 10,
    });
    expect(Number(offering[0].price_cents)).toBe(123.45);
    expect(
      (
        await pool.query('SELECT approved FROM broker_catalog WHERE id=$1', [
          selected.providers[0].catalogIds[0],
        ])
      ).rows[0].approved,
    ).toBe(true);
    await configureProviderMarketplace(pool, catalog, {
      ...retry,
      mode: 'activate',
      updateExisting: true,
    });
    const updated = (await pool.query('SELECT * FROM broker_providers WHERE id=$1', [provider.id]))
      .rows[0];
    expect(updated.total_capacity).toBe(1);
    expect(updated.policy.basePriceCents).toBe(
      providerSetupBasePrice(fixedQuote(managedPricing(catalog[4]), 30).totalPriceCents),
    );
    expect(updated.policy).not.toHaveProperty('operatorNote');
    expect(await snapshot(historyTables)).toEqual(before.slice(6));
  });

  it('requires a password only for new users and does not activate an underpriced existing offering without an explicit update', async () => {
    const selected = {
      ...setup(),
      providers: [{ ...setup().providers[4], password: undefined }],
      retireSupplierEmails: [],
      mode: 'stage' as const,
    };
    const before = await snapshot([
      '"user"',
      'account',
      'broker_providers',
      'broker_offerings',
      'broker_catalog',
    ]);
    await expect(configureProviderMarketplace(pool, catalog, selected)).rejects.toThrow(
      'private password',
    );
    expect(
      await snapshot([
        '"user"',
        'account',
        'broker_providers',
        'broker_offerings',
        'broker_catalog',
      ]),
    ).toEqual(before);
    await configureProviderMarketplace(pool, catalog, {
      ...selected,
      providers: [{ ...selected.providers[0], password }],
    });
    const provider = (
      await pool.query("SELECT id FROM broker_providers WHERE cloud_provider='sail'")
    ).rows[0];
    await pool.query('UPDATE broker_offerings SET price_cents=1 WHERE provider_id=$1', [
      provider.id,
    ]);
    const staged = await snapshot([
      '"user"',
      'account',
      'broker_providers',
      'broker_offerings',
      'broker_catalog',
    ]);
    await expect(
      configureProviderMarketplace(pool, catalog, { ...selected, mode: 'activate' }),
    ).rejects.toThrow('cost floor');
    expect(
      await snapshot([
        '"user"',
        'account',
        'broker_providers',
        'broker_offerings',
        'broker_catalog',
      ]),
    ).toEqual(staged);
    const report = await configureProviderMarketplace(pool, catalog, {
      ...selected,
      mode: 'activate',
      updateExisting: true,
    });
    expect(report.approvedConfigurations).toBe(1);
    expect(report.providers[0].autoBid).toBe(true);
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
