import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../src/server/config.js';
import type { AppContext } from '../src/server/context.js';
import { migrate, transaction } from '../src/server/db.js';
import { demoState } from '../src/server/demo/service.js';
import { observeVmDisk } from '../src/server/disks/service.js';
import type { WickEnvironment } from '../src/server/integrations/types.js';
import {
  awardHeldBid,
  closeAuction,
  createRequest,
  proposeBid,
  submitBid,
} from '../src/server/marketplace/auction.js';
import { QUEUES } from '../src/server/marketplace/db.js';
import { markReady } from '../src/server/marketplace/lifecycle.js';
import type { Actor, CatalogItem } from '../src/shared/types.js';
import { fixedQuote, managedPricing, revenueShare } from '../src/shared/pricing.js';

const url = process.env.TEST_DATABASE_URL;
describe.skipIf(!url)('demo sponsorship with real pricing contracts and no native calls', () => {
  const schema = `demo_compute_${randomUUID().replaceAll('-', '')}`;
  const buyer: Actor = {
    id: randomUUID(),
    role: 'buyer',
    email: 'demo@test.invalid',
    name: 'Guest',
  };
  let admin: Pool, pool: Pool, ctx: AppContext;
  let runId: string, leaseToken: string, diskId: string;
  let suppliers: { actor: Actor; catalog: CatalogItem }[];
  beforeAll(async () => {
    admin = new Pool({ connectionString: url });
    await admin.query(`CREATE SCHEMA ${schema}`);
    pool = new Pool({ connectionString: url, options: `-c search_path=${schema},public`, max: 8 });
    await migrate(pool);
    ctx = {
      config: loadConfig({
        NODE_ENV: 'test',
        DATABASE_URL: url!,
        BETTER_AUTH_SECRET: 'demo-compute-offline-secret-more-than-32-characters',
        WICK_MODE: 'fixture',
        MUSE_MODE: 'fixture',
        LIVE_DEMO_ENABLED: 'true',
        DISKS_ENABLED: 'true',
        DISK_QUALIFIED_CATALOG_IDS: '*',
        WICK_ORGANIZATION_ID: 'offline-org',
        WICK_GROUP_ID: 'offline-group',
      }),
      pool,
      boss: { send: vi.fn(async () => randomUUID()) },
      wick: {
        mode: 'real',
        drives: {},
        create: vi.fn(() => {
          throw new Error('Native allocation forbidden');
        }),
      },
      inference: { mode: 'real' },
      muse: {
        mode: 'real',
        proposeBid: vi.fn(() => {
          throw new Error('Paid bidding model call forbidden');
        }),
      },
    } as unknown as AppContext;
  });
  beforeEach(async () => {
    await pool.query(
      'TRUNCATE "user",broker_catalog,broker_providers,broker_inference_routes,broker_demo_days,broker_operation_receipts CASCADE',
    );
    vi.mocked(ctx.boss.send).mockClear();
    vi.mocked(ctx.muse.proposeBid).mockClear();
    ctx.config.liveDemoEnabled = true;
    ctx.config.modalComputePromotionEnabled = false;
    suppliers = [];
    for (const [provider, profile, region, rate, base] of [
      ['modal', 'micro', 'auto', 34, 8],
      ['e2b', 'micro', 'us', 23, 5],
      ['sail', 'micro', 'auto', 12, 4],
    ] as const) {
      const catalog: CatalogItem = {
        id: `${provider}:${profile}:${region}`,
        name: `${provider} Micro`,
        description: 'Offline native contract',
        provider,
        profile,
        region,
        cpu: 1,
        memoryGb: 2,
        durationMinutes: [15, 30, 60],
        approved: true,
        capabilities: ['persistent-drives'],
        organizationId: 'offline-org',
        groupId: 'offline-group',
        pricingMode: 'managed',
        managedRouteVerification: 'execution-preview-managed',
        rateMicrosPerSecond: rate,
        rateRetrievedAt: new Date().toISOString(),
        rateSource: 'wick-customer-catalog',
      };
      const actor: Actor = {
        id: randomUUID(),
        role: 'provider',
        providerId: randomUUID(),
        email: `${provider}@test.invalid`,
        name: provider,
      };
      suppliers.push({ actor, catalog });
      await pool.query(
        'INSERT INTO "user"(id,email,name,role,"providerId") VALUES($1,$2,$3,$4,$5)',
        [actor.id, actor.email, actor.name, actor.role, actor.providerId],
      );
      await pool.query(
        'INSERT INTO broker_providers(id,user_id,name,total_capacity,policy,cloud_provider,simulated) VALUES($1,$2,$3,5,$4,$5,false)',
        [
          actor.providerId,
          actor.id,
          actor.name,
          {
            autoBid: true,
            minimumPriceCents: 1,
            basePriceCents: base,
            maxPriceCents: 100,
            allowedCatalogIds: [catalog.id],
          },
          provider,
        ],
      );
      await pool.query(
        "INSERT INTO broker_catalog(id,item,approved,source_mode) VALUES($1,$2,true,'real')",
        [catalog.id, catalog],
      );
      await pool.query(
        "INSERT INTO broker_offerings(provider_id,catalog_id,name,description,price_cents,pricing) VALUES($1,$2,$3,'Offline qualified offer',$4,$5)",
        [
          actor.providerId,
          catalog.id,
          catalog.name,
          fixedQuote(managedPricing(catalog), 30).totalPriceCents,
          managedPricing(catalog),
        ],
      );
    }
    await pool.query('INSERT INTO "user"(id,email,name,role) VALUES($1,$2,$3,$4)', [
      buyer.id,
      buyer.email,
      buyer.name,
      buyer.role,
    ]);
    const grant = (
      await pool.query(
        `INSERT INTO broker_inference_grants(buyer_id,name,source_mode,funded_cents,available_cents,max_purchase_cents,allowed_providers,expires_at)
      VALUES($1,'Offline demo','real',5,5,5,'["baseten"]',clock_timestamp()+interval '18 minutes') RETURNING id`,
        [buyer.id],
      )
    ).rows[0];
    await pool.query(
      `INSERT INTO broker_inference_routes(provider,provider_id,source_mode,fingerprint,qualified,blocked_reason,input_bound,max_output_tokens,cost_input_rate,cost_output_rate)
      VALUES('baseten',$1,'real','offline-contract',true,'',5000,1024,1250000,4250000)`,
      [suppliers[0]!.actor.providerId],
    );
    const order = (
      await pool.query(
        `INSERT INTO broker_token_orders(grant_id,buyer_id,operation_key,input_fingerprint,mode,source_mode,status,input_tokens,output_tokens,max_total_cents,price_cents,provider,closes_at,expires_at)
      VALUES($1,$2,$3,'offline','auction','real','awarded',5000,2048,5,1,'baseten',clock_timestamp(),clock_timestamp()+interval '18 minutes') RETURNING id`,
        [grant.id, buyer.id, randomUUID()],
      )
    ).rows[0];
    const pack = (
      await pool.query(
        `INSERT INTO broker_token_packs(order_id,grant_id,buyer_id,provider,provider_id,source_mode,route_fingerprint,snapshot,input_tokens,output_tokens,available_input,available_output,price_cents,expires_at)
      VALUES($1,$2,$3,'baseten',$4,'real','offline-contract','{}',5000,2048,5000,2048,1,clock_timestamp()+interval '18 minutes') RETURNING id`,
        [order.id, grant.id, buyer.id, suppliers[0]!.actor.providerId],
      )
    ).rows[0];
    diskId = (
      await pool.query(
        `INSERT INTO broker_disks(buyer_id,name,source_mode,status,upstream_id,create_key)
      VALUES($1,'Private offline disk','real','ready',$2,$3) RETURNING id`,
        [buyer.id, `offline-drive-${randomUUID()}`, randomUUID()],
      )
    ).rows[0].id;
    const visitor = (
      await pool.query(
        'INSERT INTO broker_demo_visitors(id,secret_digest,buyer_id) VALUES($1,$2,$3) RETURNING id',
        [randomUUID(), 'a'.repeat(64), buyer.id],
      )
    ).rows[0];
    await pool.query('INSERT INTO broker_demo_days(day,reserved_cents) VALUES(CURRENT_DATE,50)');
    runId = randomUUID();
    leaseToken = randomUUID();
    await pool.query(
      `INSERT INTO broker_demo_runs(id,visitor_id,buyer_id,ip_digest,operation_key,source_mode,budget_day,status,grant_id,token_order_id,pack_id,disk_id,lease_token,lease_until)
      VALUES($1,$2,$3,$4,$5,'real',CURRENT_DATE,'provisioning',$6,$7,$8,$9,$10,clock_timestamp()+interval '3 minutes')`,
      [
        runId,
        visitor.id,
        buyer.id,
        'b'.repeat(64),
        randomUUID(),
        grant.id,
        order.id,
        pack.id,
        diskId,
        leaseToken,
      ],
    );
  });
  afterAll(async () => {
    await pool?.end();
    if (admin) {
      await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await admin.end();
    }
  });
  const body = () => ({
    operationKey: `demo:${runId}:vm`,
    description: `Homepage demo ${runId}`,
    catalogId: 'modal:micro:auto',
    region: 'any',
    matchAcrossProviders: true,
    durationMinutes: 15,
    maxPriceCents: 25,
    requirements: { cpu: 1, memoryGb: 2 },
    diskId,
  });
  const create = () =>
    createRequest(ctx, buyer, body(), undefined, undefined, { runId, leaseToken });
  async function row(id: string) {
    return (await pool.query('SELECT * FROM broker_requests WHERE id=$1', [id])).rows[0];
  }
  async function bids(id: string) {
    return (
      await pool.query('SELECT * FROM broker_bids WHERE request_id=$1 ORDER BY created_at,id', [id])
    ).rows;
  }
  async function close(id: string) {
    // Only this disposable schema advances its immutable auction clock; production retains 30 seconds.
    await pool.query('ALTER TABLE broker_requests DISABLE TRIGGER broker_request_immutable');
    try {
      await pool.query(
        "UPDATE broker_requests SET closes_at=clock_timestamp()-interval '1 second' WHERE id=$1",
        [id],
      );
    } finally {
      await pool.query('ALTER TABLE broker_requests ENABLE TRIGGER broker_request_immutable');
    }
    return closeAuction(ctx, id);
  }
  async function bid(id: string, index: number, price: number) {
    return submitBid(ctx, suppliers[index]!.actor, id, { totalPriceCents: price });
  }
  async function noAllocation(id: string) {
    expect(
      (await pool.query('SELECT count(*)::int n FROM broker_vms WHERE request_id=$1', [id])).rows[0]
        .n,
    ).toBe(0);
    expect(
      (
        await pool.query(
          'SELECT count(*)::int n FROM broker_holds h JOIN broker_bids b ON b.id=h.bid_id WHERE b.request_id=$1 AND h.released_at IS NULL',
          [id],
        )
      ).rows[0].n,
    ).toBe(0);
    expect(ctx.wick.create).not.toHaveBeenCalled();
  }

  it.each([false, true])(
    'invites and binds every qualified Micro supplier and preserves gross invoices with global promotion=%s',
    async (promotion) => {
      ctx.config.modalComputePromotionEnabled = promotion;
      if (promotion) {
        await pool.query(
          `UPDATE broker_providers SET policy=policy || '{"minimumPriceCents":1,"basePriceCents":1,"maxPriceCents":1}'::jsonb WHERE id=$1`,
          [suppliers[0]!.actor.providerId],
        );
        await pool.query('UPDATE broker_offerings SET price_cents=1 WHERE provider_id=$1', [
          suppliers[0]!.actor.providerId,
        ]);
      }
      const modalGross = promotion ? 1 : 8;
      const policies = (await pool.query('SELECT id,policy FROM broker_providers ORDER BY id'))
        .rows;
      const request = await create();
      expect(await create()).toEqual(request);
      expect(
        (await pool.query('SELECT request_id FROM broker_demo_runs WHERE id=$1', [runId])).rows[0]
          .request_id,
      ).toBe(request.id);
      expect(
        (await row(request.id)).catalog_snapshot.eligibleCatalogs
          .map((c: CatalogItem) => c.id)
          .sort(),
      ).toEqual(['e2b:micro:us', 'modal:micro:auto', 'sail:micro:auto']);
      expect((await row(request.id)).catalog_snapshot.demoCompute.providerIds).toEqual(
        suppliers.map((s) => s.actor.providerId),
      );
      expect(
        vi.mocked(ctx.boss.send).mock.calls.filter(([queue]) => queue === QUEUES.auto),
      ).toHaveLength(3);
      for (const [index, expected] of [
        [0, modalGross],
        [1, 5],
        [2, 4],
      ] as const) {
        const proposal = await proposeBid(ctx, suppliers[index]!.actor, request.id);
        expect(proposal).toMatchObject({
          decision: 'bid',
          totalPriceCents: expected,
          modelCalled: false,
        });
        await submitBid(
          ctx,
          suppliers[index]!.actor,
          request.id,
          { totalPriceCents: proposal.totalPriceCents!, offeringId: proposal.offeringId },
          'auto',
        );
      }
      expect(ctx.muse.proposeBid).not.toHaveBeenCalled();
      expect(
        (await pool.query('SELECT count(*)::int n FROM broker_holds WHERE released_at IS NULL'))
          .rows[0].n,
      ).toBe(3);
      // Already accepted global promotion quotes retain their terms after the flag turns off.
      ctx.config.modalComputePromotionEnabled = false;
      await close(request.id);
      await closeAuction(ctx, request.id);
      const vm = (await pool.query('SELECT * FROM broker_vms WHERE request_id=$1', [request.id]))
        .rows[0];
      expect(vm.create_input).toMatchObject({
        provider: 'modal',
        profile: 'micro',
        region: 'auto',
        ttlSeconds: 900,
        maximumPriceMicrosPerSecond: 34,
      });
      expect(vm.quote_snapshot).toMatchObject({
        totalPriceCents: modalGross,
        revenueShare: revenueShare(modalGross),
        demoSponsorship: {
          grossPriceCents: modalGross,
          sponsorCreditCents: modalGross - 1,
          effectivePriceCents: 1,
        },
      });
      expect(vm.quote_snapshot.pricing.upstreamEstimatedComputeMicros).toBe('30600');
      if (promotion)
        expect(vm.quote_snapshot.pricing).toMatchObject({
          priceBasis: 'operator-sponsored',
          upstreamCostFloorCents: 4,
          promotion: { id: 'modal-one-cent-v1', estimatedSubsidyMicros: '22100' },
        });
      expect((await bids(request.id)).map((b) => [b.total_price_cents, b.status])).toEqual([
        [modalGross, 'won'],
        [5, 'lost'],
        [4, 'lost'],
      ]);
      const disk = (await pool.query('SELECT upstream_id FROM broker_disks WHERE id=$1', [diskId]))
        .rows[0];
      const environment: WickEnvironment = {
        id: `offline-${randomUUID()}`,
        name: vm.create_input.name,
        status: 'running',
        provider: 'modal',
        profile: 'micro',
        organizationId: 'offline-org',
        groupId: 'offline-group',
        billingMode: 'wick_managed',
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 900000).toISOString(),
        raw: {},
        workspaceDrive: {
          driveId: disk.upstream_id,
          accessMode: 'mount',
          attachmentMode: 'shared',
          generation: 'offline-generation',
          status: 'mounted',
          workspacePath: '/workspace',
        },
      };
      await pool.query('UPDATE broker_vms SET environment_id=$2,expires_at=$3 WHERE id=$1', [
        vm.id,
        environment.id,
        environment.expiresAt,
      ]);
      expect(await observeVmDisk(ctx, { ...vm, environment_id: environment.id }, environment)).toBe(
        true,
      );
      expect(await markReady(ctx, vm.id, environment, true)).toBe(true);
      await markReady(ctx, vm.id, environment, true);
      expect(
        (
          await pool.query('SELECT total_cents,revenue_share FROM broker_invoices WHERE vm_id=$1', [
            vm.id,
          ])
        ).rows,
      ).toEqual([{ total_cents: modalGross, revenue_share: revenueShare(modalGross) }]);
      await pool.query('UPDATE broker_demo_runs SET vm_id=$2 WHERE id=$1', [runId, vm.id]);
      ctx.config.liveDemoEnabled = false;
      const receipt = await demoState(ctx, {
        visitorDigest: 'a'.repeat(64),
        ipDigest: 'b'.repeat(64),
      });
      expect(receipt.run!.vm).toMatchObject({
        priceCents: 1,
        grossPriceCents: modalGross,
        sponsorCreditCents: modalGross - 1,
      });
      expect(receipt.run!.vm!.operatorSponsored).toBe(promotion ? true : undefined);
      expect(
        receipt.run!.vm!.bids.find((entry) => entry.provider === 'modal')!.operatorSponsored,
      ).toBe(promotion ? true : undefined);
      expect((await pool.query('SELECT id,policy FROM broker_providers ORDER BY id')).rows).toEqual(
        policies,
      );
      expect(
        (await pool.query('SELECT reserved_cents FROM broker_demo_days')).rows[0].reserved_cents,
      ).toBe(50);
      expect(ctx.wick.create).not.toHaveBeenCalled();
    },
  );

  it('does not inherit the global promotion’s larger upstream cost allowance', async () => {
    ctx.config.modalComputePromotionEnabled = true;
    const expensive = { ...suppliers[0]!.catalog, rateMicrosPerSecond: 300 };
    await pool.query('UPDATE broker_catalog SET item=$2 WHERE id=$1', [expensive.id, expensive]);
    await pool.query('UPDATE broker_offerings SET pricing=$2,price_cents=1 WHERE catalog_id=$1', [
      expensive.id,
      managedPricing(expensive),
    ]);
    await pool.query(
      `UPDATE broker_providers SET policy=policy || '{"minimumPriceCents":1,"basePriceCents":1,"maxPriceCents":1}'::jsonb WHERE id=$1`,
      [suppliers[0]!.actor.providerId],
    );
    await expect(create()).rejects.toThrow(/gross limit/);
    expect((await pool.query('SELECT count(*)::int n FROM broker_requests')).rows[0].n).toBe(0);
  });

  it('rejects forged source fields, a stale worker fence and unqualified second supply without creating an auction', async () => {
    await expect(
      createRequest(ctx, buyer, { ...body(), demoCompute: { runId } }),
    ).rejects.toMatchObject({ statusCode: 400 });
    await expect(
      createRequest(ctx, buyer, body(), undefined, undefined, { runId, leaseToken: randomUUID() }),
    ).rejects.toMatchObject({ statusCode: 403 });
    await pool.query(
      "UPDATE broker_providers SET policy=jsonb_set(policy,'{autoBid}','false') WHERE id=ANY($1::uuid[])",
      [[suppliers[1]!.actor.providerId, suppliers[2]!.actor.providerId]],
    );
    await expect(create()).rejects.toThrow(/competing Micro offer/);
    expect((await pool.query('SELECT count(*)::int n FROM broker_requests')).rows[0].n).toBe(0);
    expect(
      (await pool.query('SELECT request_id FROM broker_demo_runs WHERE id=$1', [runId])).rows[0]
        .request_id,
    ).toBeNull();
  });

  it('enforces real gross floors, the 25-cent ceiling and the frozen invited-seller boundary', async () => {
    // Sail is not invited while its automatic bidding is off at admission.
    const sail = suppliers[2]!.actor.providerId;
    await pool.query(
      "UPDATE broker_providers SET policy=jsonb_set(policy,'{autoBid}','false') WHERE id=$1",
      [sail],
    );
    const request = await create();
    expect((await row(request.id)).catalog_snapshot.demoCompute.providerIds).not.toContain(sail);
    await pool.query(
      "UPDATE broker_providers SET policy=jsonb_set(policy,'{autoBid}','true') WHERE id=$1",
      [sail],
    );
    await expect(bid(request.id, 0, 1)).rejects.toThrow(/cost floor/);
    await expect(bid(request.id, 0, 26)).rejects.toThrow(/budget/);
    await expect(bid(request.id, 2, 4)).rejects.toThrow(/outside/);
    expect(await bids(request.id)).toHaveLength(0);
    expect((await pool.query('SELECT count(*)::int n FROM broker_holds')).rows[0].n).toBe(0);
  });

  it('fails closed and releases the real E2B bid when no Modal offer arrives', async () => {
    const request = await create();
    await bid(request.id, 1, 5);
    await close(request.id);
    expect((await row(request.id)).status).toBe('failed');
    await noAllocation(request.id);
  });

  it('does not fabricate an E2B bid if its supply is withdrawn after admission', async () => {
    const request = await create();
    await pool.query(
      "UPDATE broker_providers SET policy=jsonb_set(policy,'{autoBid}','false') WHERE id=$1",
      [suppliers[1]!.actor.providerId],
    );
    await expect(
      submitBid(ctx, suppliers[1]!.actor, request.id, { totalPriceCents: 5 }, 'auto'),
    ).rejects.toThrow(/disabled/);
    await bid(request.id, 0, 8);
    await close(request.id);
    expect(await bids(request.id)).toHaveLength(1);
    expect(
      (
        await pool.query('SELECT catalog_snapshot FROM broker_vms WHERE request_id=$1', [
          request.id,
        ])
      ).rows[0].catalog_snapshot.provider,
    ).toBe('modal');
  });

  it.each(['stopped', 'expired', 'disabled', 'invalid receipt'])(
    'releases both held offers without allocation when sponsorship is %s',
    async (reason) => {
      const request = await create();
      await bid(request.id, 0, 8);
      await bid(request.id, 1, 5);
      if (reason === 'stopped')
        await pool.query('UPDATE broker_demo_runs SET stop_requested=true WHERE id=$1', [runId]);
      if (reason === 'expired')
        await pool.query(
          "UPDATE broker_demo_runs SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",
          [runId],
        );
      if (reason === 'disabled') ctx.config.liveDemoEnabled = false;
      if (reason === 'invalid receipt')
        await pool.query(
          "UPDATE broker_bids SET offering_snapshot=offering_snapshot-'catalog' WHERE request_id=$1",
          [request.id],
        );
      await close(request.id);
      expect((await row(request.id)).status).toBe('failed');
      await noAllocation(request.id);
    },
  );

  it('blocks a direct non-Modal award before any VM row is created', async () => {
    const request = await create();
    await bid(request.id, 1, 5);
    await expect(
      transaction(pool, async (db) =>
        awardHeldBid(ctx, db, await row(request.id), (await bids(request.id))[0]),
      ),
    ).rejects.toThrow(/Only the sponsored Modal/);
    expect((await pool.query('SELECT count(*)::int n FROM broker_vms')).rows[0].n).toBe(0);
  });

  it('uses the disclosed Modal priority when a genuine rival ties at one cent', async () => {
    const e2b = { ...suppliers[1]!.catalog, rateMicrosPerSecond: 0 };
    await pool.query('UPDATE broker_catalog SET item=$2 WHERE id=$1', [e2b.id, e2b]);
    await pool.query('UPDATE broker_offerings SET pricing=$2 WHERE catalog_id=$1', [
      e2b.id,
      managedPricing(e2b),
    ]);
    await pool.query(
      "UPDATE broker_providers SET policy=jsonb_set(policy,'{basePriceCents}','1') WHERE id=$1",
      [suppliers[1]!.actor.providerId],
    );
    const request = await create();
    await bid(request.id, 1, 1);
    await bid(request.id, 0, 8);
    await close(request.id);
    expect((await bids(request.id)).map((b) => [b.total_price_cents, b.status])).toEqual([
      [1, 'lost'],
      [8, 'won'],
    ]);
  });

  it('leaves ordinary compatible auctions on gross price with cheaper E2B winning', async () => {
    const request = await createRequest(ctx, buyer, { ...body(), operationKey: randomUUID() });
    expect((await row(request.id)).catalog_snapshot.demoCompute).toBeUndefined();
    await bid(request.id, 0, 8);
    await bid(request.id, 1, 5);
    await close(request.id);
    const vm = (await pool.query('SELECT * FROM broker_vms WHERE request_id=$1', [request.id]))
      .rows[0];
    expect(vm.catalog_snapshot.provider).toBe('e2b');
    expect(vm.quote_snapshot.totalPriceCents).toBe(5);
    expect(vm.quote_snapshot.demoSponsorship).toBeUndefined();
    expect(vm.quote_snapshot.revenueShare).toEqual(revenueShare(5));
  });
});
