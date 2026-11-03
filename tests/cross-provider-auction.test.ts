import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { migrate, transaction } from '../src/server/db.js';
import { loadConfig } from '../src/server/config.js';
import type { AppContext } from '../src/server/context.js';
import type { Actor, CatalogItem } from '../src/shared/types.js';
import { fixedQuote, managedPricing, revenueShare } from '../src/shared/pricing.js';
import { createMuseAdapter } from '../src/server/integrations/muse.js';
import type { WickEnvironment } from '../src/server/integrations/types.js';
import {
  awardHeldBid,
  closeAuction,
  createRequest,
  proposeBid,
  submitBid,
} from '../src/server/marketplace/auction.js';
import { markReady, confirmCleanup } from '../src/server/marketplace/lifecycle.js';
import { observeVmDisk, reconcileVmDisk } from '../src/server/disks/service.js';
import { QUEUES } from '../src/server/marketplace/db.js';
import type { Row } from '../src/server/marketplace/data.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
const schema = `cross_cloud_${randomUUID().replaceAll('-', '')}`;
const buyer: Actor = {
  id: randomUUID(),
  email: 'buyer@test.invalid',
  name: 'Buyer',
  role: 'buyer',
};

describe.skipIf(!databaseUrl)(
  'reviewed cross-provider auctions without upstream allocations',
  () => {
    let admin: Pool, pool: Pool, ctx: AppContext;
    let catalogs: CatalogItem[];
    let providers: { actor: Actor; id: string; offeringId: string; item: CatalogItem }[];

    beforeAll(async () => {
      admin = new Pool({ connectionString: databaseUrl });
      await admin.query(`CREATE SCHEMA ${schema}`);
      pool = new Pool({
        connectionString: databaseUrl,
        max: 6,
        options: `-c search_path=${schema},public`,
      });
      await migrate(pool);
      const config = loadConfig({
        NODE_ENV: 'test',
        DATABASE_URL: databaseUrl!,
        BETTER_AUTH_SECRET: 'cross-provider-offline-test-secret-only',
        WICK_MODE: 'fixture',
        MUSE_MODE: 'fixture',
        WICK_ORGANIZATION_ID: 'test-org',
        WICK_GROUP_ID: 'test-group',
      });
      ctx = {
        pool,
        config,
        boss: { send: vi.fn(async () => null) },
        wick: {
          mode: 'real',
          create: vi.fn(() => {
            throw new Error('No upstream allocation permitted');
          }),
        },
        muse: createMuseAdapter(config),
        requireActor: async () => buyer,
      } as unknown as AppContext;
    });

    beforeEach(async () => {
      vi.mocked(ctx.boss.send).mockClear();
      ctx.config.disksEnabled = false;
      ctx.config.diskQualifiedCatalogIds = [];
      delete ctx.wick.drives;
      await pool.query(
        'TRUNCATE broker_activity,broker_invoices,broker_holds,broker_vms,broker_bids,broker_requests,broker_offerings,broker_providers,broker_catalog CASCADE',
      );
      await pool.query(
        "INSERT INTO broker_settings(key,value) VALUES('maxConcurrentVms','20') ON CONFLICT(key) DO UPDATE SET value='20'",
      );
      catalogs = [
        ['e2b', 'us', 46],
        ['daytona', 'us', 47],
        ['provider-blaxel', 'us-pdx-1', 46],
        ['modal', 'auto', 67],
      ].map(([provider, region, rate]) => ({
        id: `${provider}:small:${region}`,
        name: `${provider} Small`,
        description: 'Offline published catalog contract',
        provider: provider as string,
        profile: 'small',
        region: region as string,
        cpu: 2,
        memoryGb: 4,
        durationMinutes: [15, 30, 60],
        approved: true,
        organizationId: 'test-org',
        groupId: 'test-group',
        rateMicrosPerSecond: rate as number,
        rateRetrievedAt: new Date().toISOString(),
        rateSource: 'wick-customer-catalog',
        pricingMode: 'managed',
        managedRouteVerification: 'execution-preview-managed',
        resources: { cpu: 2, memoryGb: 4, diskGb: 8 },
      }));
      providers = [];
      for (const item of catalogs) {
        await storeCatalog(item);
        const id = randomUUID();
        const actor: Actor = {
          id: randomUUID(),
          email: `${id}@test.invalid`,
          name: item.provider === 'provider-blaxel' ? 'Baseten · Blaxel route' : item.provider,
          role: 'provider',
          providerId: id,
        };
        await pool.query(
          'INSERT INTO broker_providers(id,user_id,name,total_capacity,policy,simulated,cloud_provider) VALUES($1,$2,$3,5,$4,false,$5)',
          [
            id,
            actor.id,
            actor.name,
            {
              autoBid: true,
              minimumPriceCents: 1,
              basePriceCents: 1,
              maxPriceCents: 1000,
              allowedCatalogIds: [item.id],
            },
            item.provider,
          ],
        );
        const offeringId = await storeOffering(id, item);
        providers.push({ actor, id, offeringId, item });
      }
    });

    afterAll(async () => {
      await pool?.end();
      if (admin) {
        await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
        await admin.end();
      }
    });

    async function storeCatalog(item: CatalogItem) {
      await pool.query(
        "INSERT INTO broker_catalog(id,item,approved,source_mode) VALUES($1,$2,true,'real') ON CONFLICT(id) DO UPDATE SET item=excluded.item",
        [item.id, item],
      );
    }
    async function storeOffering(providerId: string, item: CatalogItem) {
      const id = randomUUID(),
        pricing = managedPricing(item);
      await pool.query(
        'INSERT INTO broker_offerings(id,provider_id,catalog_id,name,description,price_cents,pricing) VALUES($1,$2,$3,$4,$5,$6,$7)',
        [
          id,
          providerId,
          item.id,
          'Managed native allocation',
          'Offline test only',
          fixedQuote(pricing, 30).totalPriceCents,
          pricing,
        ],
      );
      return id;
    }
    function request(overrides: Record<string, unknown> = {}) {
      return createRequest(ctx, buyer, {
        description: 'Two CPU Linux workspace',
        catalogId: catalogs[0]!.id,
        region: 'any',
        durationMinutes: 30,
        maxPriceCents: 100,
        requirements: { cpu: 2, memoryGb: 4 },
        matchAcrossProviders: true,
        ...overrides,
      });
    }
    async function storedRequest(id: string) {
      return (await pool.query('SELECT * FROM broker_requests WHERE id=$1', [id])).rows[0];
    }
    async function award(requestId: string, bidId: string) {
      return transaction(pool, async (db) => {
        const req = (
          await db.query('SELECT * FROM broker_requests WHERE id=$1 FOR UPDATE', [requestId])
        ).rows[0];
        const bid = (await db.query('SELECT * FROM broker_bids WHERE id=$1 FOR UPDATE', [bidId]))
          .rows[0];
        return awardHeldBid(ctx, db, req, bid);
      });
    }

    it('freezes all four reviewed routes and enqueues only their eligible bound accounts', async () => {
      const req = await request();
      const snapshot = (await storedRequest(req.id)).catalog_snapshot;
      expect(snapshot.matchMode).toBe('compatible');
      expect(snapshot.eligibleCatalogs.map((item: CatalogItem) => item.id).sort()).toEqual(
        catalogs.map((item) => item.id).sort(),
      );
      expect(
        snapshot.eligibleCatalogs.every(
          (item: Record<string, unknown>) => item.pricing && item.sourceMode === 'real',
        ),
      ).toBe(true);
      const bids = vi.mocked(ctx.boss.send).mock.calls.filter(([queue]) => queue === QUEUES.auto);
      expect(
        bids.map(([, payload]) => (payload as { providerId: string }).providerId).sort(),
      ).toEqual(providers.map((p) => p.id).sort());
      expect(ctx.wick.create).not.toHaveBeenCalled();
    });

    it('preserves exact-route behavior unless matching and any-region choice are explicit', async () => {
      for (const matchAcrossProviders of [undefined, false]) {
        await expect(request({ matchAcrossProviders })).rejects.toThrow(/Any region/);
      }
      await expect(request({ matchAcrossProviders: 'true' })).rejects.toThrow(/explicitly/);
      const exact = await request({ region: 'us', matchAcrossProviders: false });
      expect((await storedRequest(exact.id)).catalog_snapshot.matchMode).toBeUndefined();
      await expect(
        submitBid(ctx, providers[1]!.actor, exact.id, { totalPriceCents: 20 }),
      ).rejects.toThrow(/policy|reviewed/);
      await expect(
        submitBid(ctx, providers[0]!.actor, exact.id, { totalPriceCents: 20 }),
      ).resolves.toMatchObject({ totalPriceCents: 20 });
    });

    it('freezes the server-selected bid source for exact auction attribution', async () => {
      const req = await request();
      const auto = await submitBid(
        ctx,
        providers[0]!.actor,
        req.id,
        { totalPriceCents: 20 },
        'auto',
      );
      const manual = await submitBid(ctx, providers[1]!.actor, req.id, { totalPriceCents: 20 });
      expect(auto.source).toBe('auto');
      expect(manual.source).toBe('manual');
      const saved = (
        await pool.query('SELECT offering_snapshot FROM broker_bids WHERE id=$1', [auto.id])
      ).rows[0];
      expect(saved.offering_snapshot.bidSource).toBe('auto');
      expect(ctx.wick.create).not.toHaveBeenCalled();
    });

    it('does not widen an explicit region to Modal auto or the Blaxel native location', async () => {
      const req = await request({ region: 'us' });
      const snapshot = (await storedRequest(req.id)).catalog_snapshot;
      expect(snapshot.eligibleCatalogs.map((item: CatalogItem) => item.provider).sort()).toEqual([
        'daytona',
        'e2b',
      ]);
      await expect(
        submitBid(ctx, providers[2]!.actor, req.id, { totalPriceCents: 20 }),
      ).rejects.toThrow(/policy|reviewed/);
      await expect(
        submitBid(ctx, providers[3]!.actor, req.id, { totalPriceCents: 20 }),
      ).rejects.toThrow(/policy|reviewed/);
      expect((await pool.query('SELECT count(*)::int AS n FROM broker_holds')).rows[0].n).toBe(0);
    });

    it('excludes insufficient resources and durations, and cannot bid them through an explicit offering ID', async () => {
      const weak = {
        ...catalogs[1]!,
        id: 'daytona:micro:us',
        profile: 'micro',
        cpu: 1,
        memoryGb: 2,
      };
      const short = { ...catalogs[1]!, id: 'daytona:short:us', durationMinutes: [15] };
      for (const item of [weak, short]) {
        await storeCatalog(item);
        const offeringId = await storeOffering(providers[1]!.id, item);
        await pool.query(
          "UPDATE broker_providers SET policy=jsonb_set(policy,'{allowedCatalogIds}',(policy->'allowedCatalogIds') || to_jsonb($2::text)) WHERE id=$1",
          [providers[1]!.id, item.id],
        );
        const req = await request();
        expect(
          (await storedRequest(req.id)).catalog_snapshot.eligibleCatalogs.map(
            (entry: CatalogItem) => entry.id,
          ),
        ).not.toContain(item.id);
        await expect(
          submitBid(ctx, providers[1]!.actor, req.id, { totalPriceCents: 20, offeringId }),
        ).rejects.toThrow(/active offering/);
      }
      expect((await pool.query('SELECT count(*)::int AS n FROM broker_holds')).rows[0].n).toBe(0);
    });

    it('uses each chosen route cost floor and returns the native offering for automatic bids', async () => {
      const req = await request();
      const modal = providers[3]!;
      await expect(submitBid(ctx, modal.actor, req.id, { totalPriceCents: 10 })).rejects.toThrow(
        /cost floor/,
      );
      // A source refresh stores approved:false in item JSON; the operator's SQL approval is authoritative.
      await storeCatalog({ ...modal.item, approved: false });
      const proposal = await proposeBid(ctx, modal.actor, req.id);
      expect(proposal).toMatchObject({
        decision: 'bid',
        catalogId: modal.item.id,
        offeringId: modal.offeringId,
        totalPriceCents: 15,
        modelCalled: false,
      });

      if (proposal.decision !== 'bid') throw new Error('Expected the current managed route to bid');
      await expect(
        submitBid(ctx, modal.actor, req.id, {
          totalPriceCents: proposal.totalPriceCents!,
          offeringId: proposal.offeringId,
        }),
      ).resolves.toMatchObject({ totalPriceCents: 15 });
    });

    it('matches an explicit any-GPU requirement only to GPU-bearing reviewed configurations', async () => {
      await storeCatalog({ ...catalogs[0]!, gpu: 'T4' });
      const req = await request({
        region: 'us',
        requirements: { cpu: 2, memoryGb: 4, gpu: 'any' },
      });
      expect(
        (await storedRequest(req.id)).catalog_snapshot.eligibleCatalogs.map(
          (item: CatalogItem) => item.id,
        ),
      ).toEqual([catalogs[0]!.id]);
      await expect(
        submitBid(ctx, providers[0]!.actor, req.id, { totalPriceCents: 20 }),
      ).resolves.toMatchObject({ totalPriceCents: 20 });
      await expect(
        submitBid(ctx, providers[1]!.actor, req.id, { totalPriceCents: 20 }),
      ).rejects.toThrow(/policy|reviewed/);
      await expect(
        request({ region: 'us', requirements: { cpu: 2, memoryGb: 4, gpu: 'H100' } }),
      ).rejects.toThrow(/does not satisfy/);
    });
    it('compares current and frozen selected rates without comparing another cloud seed rate', async () => {
      const req = await request();
      await storeCatalog({ ...catalogs[0]!, rateMicrosPerSecond: 99 });
      await expect(
        submitBid(ctx, providers[0]!.actor, req.id, { totalPriceCents: 30 }),
      ).rejects.toThrow(/rate changed/);
      await expect(
        submitBid(ctx, providers[3]!.actor, req.id, { totalPriceCents: 20 }),
      ).resolves.toMatchObject({ totalPriceCents: 20 });
      await storeCatalog({ ...catalogs[1]!, cpu: 1 });
      await expect(
        submitBid(ctx, providers[1]!.actor, req.id, { totalPriceCents: 20 }),
      ).rejects.toThrow(/configuration changed/);
      expect((await pool.query('SELECT count(*)::int AS n FROM broker_holds')).rows[0].n).toBe(1);
    });

    it('cannot use another account offering or widen a bound cloud identity through policy', async () => {
      const req = await request();
      const e2b = providers[0]!,
        modal = providers[3]!;
      await expect(
        submitBid(ctx, e2b.actor, req.id, { totalPriceCents: 30, offeringId: modal.offeringId }),
      ).rejects.toThrow(/active offering/);
      const injected = await storeOffering(e2b.id, modal.item);
      await pool.query(
        "UPDATE broker_providers SET policy=jsonb_set(policy,'{allowedCatalogIds}',$2::jsonb) WHERE id=$1",
        [e2b.id, JSON.stringify([modal.item.id])],
      );
      await expect(
        submitBid(ctx, e2b.actor, req.id, { totalPriceCents: 30, offeringId: injected }),
      ).rejects.toThrow(/active offering/);
      await pool.query('UPDATE broker_providers SET cloud_provider=NULL WHERE id=$1', [e2b.id]);
      await expect(
        submitBid(ctx, e2b.actor, req.id, { totalPriceCents: 30, offeringId: injected }),
      ).rejects.toThrow(/operator-assigned/);
      expect((await pool.query('SELECT count(*)::int AS n FROM broker_holds')).rows[0].n).toBe(0);
    });

    it('freezes the winning Blaxel route, exact rate and 15% split through VM and invoice ownership', async () => {
      const req = await request();
      const prices = [30, 20, 12, 25];
      const bids = [];
      for (let i = 0; i < providers.length; i++)
        bids.push(
          await submitBid(ctx, providers[i]!.actor, req.id, { totalPriceCents: prices[i]! }),
        );
      const selected = providers[2]!,
        winner = bids[2]!;
      const result = await award(req.id, winner.id);
      await closeAuction(ctx, req.id);
      const vm = (await pool.query('SELECT * FROM broker_vms WHERE id=$1', [result.vmId])).rows[0];
      expect(vm.provider_id).toBe(selected.id);
      expect(vm.catalog_snapshot).toMatchObject({
        id: selected.item.id,
        provider: 'provider-blaxel',
        region: 'us-pdx-1',
      });
      expect(vm.create_input).toMatchObject({
        provider: 'provider-blaxel',
        region: 'us-pdx-1',
        profile: 'small',
        maximumPriceMicrosPerSecond: 46,
        organizationId: 'test-org',
        groupId: 'test-group',
        ttlSeconds: 1800,
      });
      expect(vm.quote_snapshot).toMatchObject({
        totalPriceCents: 12,
        feeCents: 0,
        revenueShare: revenueShare(12),
        offering: {
          catalogId: selected.item.id,
          catalog: { provider: 'provider-blaxel' },
          simulated: false,
          cloudProvider: 'provider-blaxel',
        },
      });
      expect(
        (await pool.query('SELECT count(*)::int AS n FROM broker_holds WHERE released_at IS NULL'))
          .rows[0].n,
      ).toBe(1);
      const environment: WickEnvironment = {
        id: `offline-${randomUUID()}`,
        status: 'running',
        name: vm.create_input.name,
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 1800000).toISOString(),
        organizationId: 'test-org',
        groupId: 'test-group',
        provider: 'provider-blaxel',
        profile: 'small',
        billingMode: 'wick_managed',
        raw: {},
      };
      await pool.query('UPDATE broker_vms SET environment_id=$2,expires_at=$3 WHERE id=$1', [
        vm.id,
        environment.id,
        environment.expiresAt,
      ]);
      expect(await markReady(ctx, vm.id, environment, true)).toBe(true);
      await markReady(ctx, vm.id, environment, true);
      expect(
        (
          await pool.query(
            'SELECT provider_id,total_cents,revenue_share FROM broker_invoices WHERE vm_id=$1',
            [vm.id],
          )
        ).rows,
      ).toEqual([{ provider_id: selected.id, total_cents: 12, revenue_share: revenueShare(12) }]);
      expect(
        (
          await pool.query('SELECT count(*)::int AS n FROM broker_vms WHERE request_id=$1', [
            req.id,
          ])
        ).rows[0].n,
      ).toBe(1);
      expect(ctx.wick.create).not.toHaveBeenCalled();
    });

    it('never falls back to the seed cloud when a compatible winning snapshot is missing', async () => {
      const req = await request();
      const bid = await submitBid(ctx, providers[1]!.actor, req.id, { totalPriceCents: 20 });
      const frozen = (
        await pool.query('SELECT offering_snapshot FROM broker_bids WHERE id=$1', [bid.id])
      ).rows[0].offering_snapshot;
      await pool.query(
        "UPDATE broker_bids SET offering_snapshot=offering_snapshot-'catalog' WHERE id=$1",
        [bid.id],
      );
      await expect(award(req.id, bid.id)).rejects.toThrow(/no frozen provider/);
      const unbound = { ...frozen };
      delete unbound.cloudProvider;
      await pool.query('UPDATE broker_bids SET offering_snapshot=$2 WHERE id=$1', [
        bid.id,
        unbound,
      ]);
      await expect(award(req.id, bid.id)).rejects.toThrow(/provider route does not match/);
      expect((await pool.query('SELECT count(*)::int AS n FROM broker_vms')).rows[0].n).toBe(0);
      expect(
        (await pool.query('SELECT status FROM broker_bids WHERE id=$1', [bid.id])).rows[0].status,
      ).toBe('held');
    });

    async function persistentDisk() {
      ctx.config.disksEnabled = true;
      ctx.config.diskQualifiedCatalogIds = catalogs.slice(0, 2).map((item) => item.id);
      ctx.wick.drives = {} as NonNullable<typeof ctx.wick.drives>;
      await pool.query(
        'INSERT INTO "user"(id,name,email,role) VALUES($1,$2,$3,$4) ON CONFLICT(id) DO NOTHING',
        [buyer.id, buyer.name, buyer.email, 'buyer'],
      );
      for (const item of catalogs.slice(0, 2)) {
        item.capabilities = ['persistent-drives'];
        item.approved = false; // Upstream JSON stays unapproved after the DB approval changes.
        await storeCatalog(item);
      }
      const id = randomUUID();
      await pool.query(
        "INSERT INTO broker_disks(id,buyer_id,name,source_mode,status,upstream_id,create_key) VALUES($1,$2,'Persistent project','real','ready',$3,$4)",
        [id, buyer.id, `drive-${id}`, `disk-${id}`],
      );
      return id;
    }

    it('freezes owned disks across requests, filters unsupported providers and preserves API key scope boundaries', async () => {
      const diskId = await persistentDisk();
      const req = await request({ diskId });
      expect(req.diskId).toBe(diskId);
      const frozen = await storedRequest(req.id);
      expect(
        frozen.catalog_snapshot.eligibleCatalogs.map((item: CatalogItem) => item.id).sort(),
      ).toEqual(
        catalogs
          .slice(0, 2)
          .map((item) => item.id)
          .sort(),
      );
      await expect(
        pool.query('UPDATE broker_requests SET disk_id=NULL WHERE id=$1', [req.id]),
      ).rejects.toThrow(/immutable/);
      await expect(
        createRequest(ctx, { ...buyer, id: randomUUID() }, { ...req, diskId }),
      ).rejects.toThrow('Disk not found');
      await expect(
        createRequest(
          ctx,
          {
            ...buyer,
            apiKey: {
              id: randomUUID(),
              scopes: ['orders:write'],
              limits: { maxAuctionCents: 100 },
            },
          },
          { ...req, diskId, operationKey: 'no-disk-authority' },
        ),
      ).rejects.toThrow('disks:use');
      await expect(
        submitBid(ctx, providers[2]!.actor, req.id, { totalPriceCents: 20 }),
      ).rejects.toThrow();
    });

    it('releases pre-admission holds when disk qualification is withdrawn before closing', async () => {
      const diskId = await persistentDisk();
      const req = await request({ diskId });
      await submitBid(ctx, providers[0]!.actor, req.id, { totalPriceCents: 20 });
      ctx.config.disksEnabled = false;
      // Fixture-only clock advancement in this disposable schema. Production
      // request specifications remain immutable (covered separately above).
      await pool.query('ALTER TABLE broker_requests DISABLE TRIGGER broker_request_immutable');
      try {
        await pool.query(
          "UPDATE broker_requests SET closes_at=clock_timestamp()-interval '1 second' WHERE id=$1",
          [req.id],
        );
      } finally {
        await pool.query('ALTER TABLE broker_requests ENABLE TRIGGER broker_request_immutable');
      }
      await closeAuction(ctx, req.id);
      expect((await storedRequest(req.id)).status).toBe('failed');
      expect(
        (await pool.query('SELECT count(*)::int n FROM broker_holds WHERE released_at IS NULL'))
          .rows[0].n,
      ).toBe(0);
      expect(
        (await pool.query('SELECT count(*)::int n FROM broker_vms WHERE request_id=$1', [req.id]))
          .rows[0].n,
      ).toBe(0);
    });

    it('requires the exact native shared mount before invoice and confirmed detachment before releasing capacity', async () => {
      const diskId = await persistentDisk();
      const req = await request({ diskId });
      const bid = await submitBid(ctx, providers[1]!.actor, req.id, { totalPriceCents: 20 });
      const result = await award(req.id, bid.id);
      let vm = (await pool.query('SELECT * FROM broker_vms WHERE id=$1', [result.vmId])).rows[0];
      expect(vm.create_input.workspaceDrive).toEqual({
        driveId: `drive-${diskId}`,
        accessMode: 'mount',
      });
      const environment: WickEnvironment = {
        id: `offline-${randomUUID()}`,
        status: 'running',
        name: vm.create_input.name,
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 1800000).toISOString(),
        organizationId: 'test-org',
        groupId: 'test-group',
        provider: 'daytona',
        profile: 'small',
        billingMode: 'wick_managed',
      };
      await pool.query('UPDATE broker_vms SET environment_id=$2,expires_at=$3 WHERE id=$1', [
        vm.id,
        environment.id,
        environment.expiresAt,
      ]);
      vm = { ...vm, environment_id: environment.id };
      expect(await markReady(ctx, vm.id, environment, true)).toBe(false);
      const mount = {
        driveId: `drive-${diskId}`,
        generation: 'mount-generation-1',
        attachmentMode: 'shared' as const,
        accessMode: 'mount' as const,
        workspacePath: '/workspace',
        status: 'mounted',
      };
      expect(
        await observeVmDisk(ctx, vm, {
          ...environment,
          workspaceDrive: { ...mount, accessMode: 'files' },
        }),
      ).toBe(false);
      expect(
        await observeVmDisk(ctx, vm, {
          ...environment,
          workspaceDrive: { ...mount, driveId: 'another-drive' },
        }),
      ).toBe(false);
      expect(await observeVmDisk(ctx, vm, { ...environment, workspaceDrive: mount })).toBe(true);
      expect(
        await observeVmDisk(ctx, vm, {
          ...environment,
          workspaceDrive: { ...mount, generation: 'stale-other-generation' },
        }),
      ).toBe(false);
      expect(await markReady(ctx, vm.id, { ...environment, workspaceDrive: mount }, true)).toBe(
        true,
      );
      expect(
        (await pool.query('SELECT count(*)::int n FROM broker_invoices WHERE vm_id=$1', [vm.id]))
          .rows[0].n,
      ).toBe(1);
      await expect(confirmCleanup(ctx, vm.id)).rejects.toThrow(/detachment/);
      const attached = {
        drive: { cleanupPending: false, attachments: [{ environmentId: environment.id }] },
      };
      ctx.wick.drives!.get = vi.fn(async () => attached) as never;
      expect(await reconcileVmDisk(ctx, vm, { ...environment, status: 'terminated' })).toBe(false);
      ctx.wick.drives!.get = vi.fn(async () => ({
        drive: { cleanupPending: false, attachments: [] },
      })) as never;
      expect(await reconcileVmDisk(ctx, vm, { ...environment, status: 'terminated' })).toBe(true);
      await confirmCleanup(ctx, vm.id);
      expect(
        (await pool.query('SELECT cleanup_confirmed_at FROM broker_vms WHERE id=$1', [vm.id]))
          .rows[0].cleanup_confirmed_at,
      ).not.toBeNull();
      expect(
        (await pool.query('SELECT status FROM broker_disks WHERE id=$1', [diskId])).rows[0].status,
      ).toBe('ready');
    });

    it('shares one disk across providers and cleans only the terminated VM attachment', async () => {
      const diskId = await persistentDisk();
      const vms: { vm: Row; environment: WickEnvironment }[] = [];
      for (const provider of providers.slice(0, 2)) {
        const req = await request({ diskId });
        const bid = await submitBid(ctx, provider.actor, req.id, { totalPriceCents: 20 });
        const result = await award(req.id, bid.id);
        const row = (await pool.query('SELECT * FROM broker_vms WHERE id=$1', [result.vmId]))
          .rows[0];
        const environment: WickEnvironment = {
          id: `offline-${randomUUID()}`,
          status: 'running',
          name: row.create_input.name,
          createdAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + 1800000).toISOString(),
          organizationId: 'test-org',
          groupId: 'test-group',
          provider: provider.item.provider,
          profile: 'small',
          billingMode: 'wick_managed',
          workspaceDrive: {
            driveId: `drive-${diskId}`,
            generation: `generation-${row.id}`,
            status: 'mounted',
            attachmentMode: 'shared',
            accessMode: 'mount',
            workspacePath: '/workspace',
          },
        };
        await pool.query('UPDATE broker_vms SET environment_id=$2,expires_at=$3 WHERE id=$1', [
          row.id,
          environment.id,
          environment.expiresAt,
        ]);
        const vm = { ...row, environment_id: environment.id };
        expect(await observeVmDisk(ctx, vm, environment)).toBe(true);
        expect(await markReady(ctx, vm.id, environment, true)).toBe(true);
        vms.push({ vm, environment });
      }
      expect(
        (
          await pool.query(
            "SELECT count(*)::int n FROM broker_disk_attachments WHERE disk_id=$1 AND status='mounted'",
            [diskId],
          )
        ).rows[0].n,
      ).toBe(2);
      ctx.wick.drives!.get = vi.fn(async () => ({
        drive: { cleanupPending: false, attachments: [{ environmentId: vms[1].environment.id }] },
      })) as never;
      expect(
        await reconcileVmDisk(ctx, vms[0].vm, { ...vms[0].environment, status: 'terminated' }),
      ).toBe(true);
      await confirmCleanup(ctx, vms[0].vm.id);
      expect(
        (
          await pool.query('SELECT status,cleanup_confirmed_at FROM broker_vms WHERE id=$1', [
            vms[1].vm.id,
          ])
        ).rows[0],
      ).toMatchObject({ status: 'running', cleanup_confirmed_at: null });
      expect(
        (
          await pool.query('SELECT status FROM broker_disk_attachments WHERE vm_id=$1', [
            vms[1].vm.id,
          ])
        ).rows[0].status,
      ).toBe('mounted');
      expect(
        (await pool.query('SELECT status FROM broker_disks WHERE id=$1', [diskId])).rows[0].status,
      ).toBe('ready');
    });

    it('rejects more than sixteen matching native routes without silently truncating the market', async () => {
      for (let i = 0; i < 13; i++)
        await storeCatalog({ ...catalogs[0]!, id: `e2b:small:extra-${i}` });
      await expect(request()).rejects.toThrow(/Too many matching configurations/);
      expect((await pool.query('SELECT count(*)::int AS n FROM broker_requests')).rows[0].n).toBe(
        0,
      );
      expect(ctx.wick.create).not.toHaveBeenCalled();
    });
  },
);
