import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import { Pool } from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { migrate } from '../src/server/db.js';
import { loadConfig } from '../src/server/config.js';
import type { AppContext } from '../src/server/context.js';
import type { Actor, CatalogItem } from '../src/shared/types.js';
import type { WickEnvironment } from '../src/server/integrations/types.js';
import { fixedQuote, managedPricing, revenueShare } from '../src/shared/pricing.js';
import {
  closeAuction,
  createRequest,
  proposeBid,
  submitBid,
} from '../src/server/marketplace/auction.js';
import { markReady } from '../src/server/marketplace/lifecycle.js';
import { registerComputePromotionAdmin } from '../src/server/marketplace/compute-promotion-admin.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
const schema = `modal_promotion_${randomUUID().replaceAll('-', '')}`;
const buyer: Actor = {
  id: randomUUID(),
  email: 'buyer@offline.invalid',
  name: 'Buyer',
  role: 'buyer',
};
type Provider = { id: string; actor: Actor; item: CatalogItem; offeringId: string };

describe.skipIf(!databaseUrl)('Modal sponsorship database contracts without upstream calls', () => {
  let admin: Pool, pool: Pool, ctx: AppContext;
  let app: FastifyInstance, authenticatedActor: Actor;
  let modal: Provider, e2b: Provider, daytona: Provider;

  beforeAll(async () => {
    admin = new Pool({ connectionString: databaseUrl });
    await admin.query(`CREATE SCHEMA ${schema}`);
    pool = new Pool({
      connectionString: databaseUrl,
      max: 6,
      options: `-c search_path=${schema},public`,
    });
    await migrate(pool);
    ctx = {
      pool,
      config: loadConfig({
        NODE_ENV: 'test',
        DATABASE_URL: databaseUrl!,
        BETTER_AUTH_SECRET: 'offline-modal-promotion-test-secret-only',
        WICK_MODE: 'fixture',
        MUSE_MODE: 'fixture',
        WICK_ORGANIZATION_ID: 'offline-org',
        WICK_GROUP_ID: 'offline-group',
        MODAL_COMPUTE_PROMOTION_ENABLED: 'true',
      }),
      boss: { send: vi.fn(async () => null) },
      wick: {
        mode: 'real',
        create: vi.fn(() => {
          throw new Error('Native allocation is forbidden in this suite');
        }),
      },
      muse: {
        mode: 'real',
        proposeBid: vi.fn(() => {
          throw new Error('Model calls are forbidden in this suite');
        }),
      },
      requireActor: async (_request: unknown, roles: Actor['role'][] = []) => {
        if (!roles.includes(authenticatedActor.role))
          throw Object.assign(new Error('This action requires an administrator.'), {
            statusCode: 403,
          });
        return authenticatedActor;
      },
    } as unknown as AppContext;
    app = Fastify();
    app.setErrorHandler((error: Error & { statusCode?: number }, _request, reply) =>
      reply.code(error.statusCode ?? 500).send({ error: error.message }),
    );
    await registerComputePromotionAdmin(app, ctx);
  });

  async function provider(route: string, rate: number): Promise<Provider> {
    const id = randomUUID(),
      offeringId = randomUUID();
    const actor: Actor = {
      id: randomUUID(),
      providerId: id,
      email: `${route}@offline.invalid`,
      name: route,
      role: 'provider',
    };
    const item: CatalogItem = {
      id: `${route}:small:auto`,
      name: `${route} Small`,
      description: 'Offline promotion contract',
      provider: route,
      profile: 'small',
      region: 'auto',
      cpu: 2,
      memoryGb: 4,
      approved: true,
      durationMinutes: [15, 30, 60],
      organizationId: 'offline-org',
      groupId: 'offline-group',
      pricingMode: 'managed',
      managedRouteVerification: 'execution-preview-managed',
      rateMicrosPerSecond: rate,
      rateSource: 'wick-customer-catalog',
      rateRetrievedAt: new Date().toISOString(),
    };
    await pool.query(
      "INSERT INTO broker_catalog(id,item,approved,source_mode) VALUES($1,$2,true,'real')",
      [item.id, item],
    );
    await pool.query(
      'INSERT INTO broker_providers(id,user_id,name,total_capacity,policy,simulated,cloud_provider) VALUES($1,$2,$3,1,$4,false,$5)',
      [
        id,
        actor.id,
        actor.name,
        {
          autoBid: true,
          minimumPriceCents: 1,
          basePriceCents: 1,
          maxPriceCents: 200,
          allowedCatalogIds: [item.id],
        },
        route,
      ],
    );
    const pricing = managedPricing(item);
    await pool.query(
      'INSERT INTO broker_offerings(id,provider_id,catalog_id,name,description,price_cents,pricing) VALUES($1,$2,$3,$4,$5,$6,$7)',
      [
        offeringId,
        id,
        item.id,
        `${route} managed offering`,
        'Offline only',
        fixedQuote(pricing, 30).totalPriceCents,
        pricing,
      ],
    );
    return { id, actor, item, offeringId };
  }

  beforeEach(async () => {
    authenticatedActor = buyer;
    ctx.config.modalComputePromotionEnabled = true;
    vi.mocked(ctx.wick.create).mockClear();
    vi.mocked(ctx.muse.proposeBid).mockClear();
    vi.mocked(ctx.boss.send).mockClear();
    await pool.query(
      'TRUNCATE broker_operation_receipts,broker_activity,broker_invoices,broker_holds,broker_vms,broker_bids,broker_requests,broker_offerings,broker_providers,broker_catalog CASCADE',
    );
    await pool.query(
      "INSERT INTO broker_settings(key,value) VALUES('maxConcurrentVms','20') ON CONFLICT(key) DO UPDATE SET value='20'",
    );
    e2b = await provider('e2b', 0);
    modal = await provider('modal', 100);
    daytona = await provider('daytona', 100);
  });
  afterEach(() => {
    expect(ctx.wick.create).not.toHaveBeenCalled();
    expect(ctx.muse.proposeBid).not.toHaveBeenCalled();
  });
  afterAll(async () => {
    await app?.close();
    await pool?.end();
    if (admin) {
      await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await admin.end();
    }
  });

  function request(overrides: Record<string, unknown> = {}) {
    return createRequest(ctx, buyer, {
      description: 'Offline resource-compatible promotion request',
      catalogId: e2b.item.id,
      region: 'any',
      durationMinutes: 30,
      maxPriceCents: 200,
      requirements: { cpu: 2, memoryGb: 4 },
      matchAcrossProviders: true,
      ...overrides,
    });
  }
  async function updateCatalog(target: Provider, change: Partial<CatalogItem>) {
    target.item = { ...target.item, ...change, rateRetrievedAt: new Date().toISOString() };
    await pool.query('UPDATE broker_catalog SET item=$2 WHERE id=$1', [
      target.item.id,
      target.item,
    ]);
    const pricing = managedPricing(target.item);
    await pool.query('UPDATE broker_offerings SET pricing=$2,price_cents=$3 WHERE id=$1', [
      target.offeringId,
      pricing,
      fixedQuote(pricing, 30).totalPriceCents,
    ]);
  }
  async function noReservations() {
    expect((await pool.query('SELECT count(*)::int AS n FROM broker_holds')).rows[0].n).toBe(0);
    expect((await pool.query('SELECT count(*)::int AS n FROM broker_bids')).rows[0].n).toBe(0);
  }
  async function expire(requestId: string) {
    // Advance only this disposable schema's auction deadline; accepted bid times stay real.
    await pool.query('ALTER TABLE broker_requests DISABLE TRIGGER broker_request_immutable');
    try {
      await pool.query('UPDATE broker_requests SET closes_at=clock_timestamp() WHERE id=$1', [
        requestId,
      ]);
    } finally {
      await pool.query('ALTER TABLE broker_requests ENABLE TRIGGER broker_request_immutable');
    }
  }
  async function close(requestId: string, olderBid: string, newerBid?: string) {
    if (newerBid)
      expect(
        (
          await pool.query(
            'SELECT earlier.created_at<later.created_at AS accepted_later FROM broker_bids earlier,broker_bids later WHERE earlier.id=$1 AND later.id=$2',
            [olderBid, newerBid],
          )
        ).rows[0].accepted_later,
      ).toBe(true);
    await expire(requestId);
    await closeAuction(ctx, requestId);
    return (await pool.query('SELECT * FROM broker_vms WHERE request_id=$1', [requestId])).rows[0];
  }

  it('quotes automatically without a model, wins a later one-cent tie, and freezes one exact invoice', async () => {
    const req = await request({ maxPriceCents: 1 });
    const older = await submitBid(ctx, e2b.actor, req.id, { totalPriceCents: 1 });
    const proposal = await proposeBid(ctx, modal.actor, req.id);
    expect(proposal).toMatchObject({
      decision: 'bid',
      totalPriceCents: 1,
      modelCalled: false,
      offeringId: modal.offeringId,
    });
    const later = await submitBid(
      ctx,
      modal.actor,
      req.id,
      { totalPriceCents: 1, offeringId: modal.offeringId },
      'auto',
    );
    expect(later.pricing).toMatchObject({
      totalPriceCents: 1,
      upstreamCostFloorCents: 22,
      upstreamEstimatedComputeMicros: '180000',
      promotion: {
        id: 'modal-one-cent-v1',
        estimatedSubsidyMicros: '171500',
        maxUpstreamComputeMicros: '1000000',
      },
    });
    expect(later.revenueShare).toEqual(revenueShare(1));
    const frozenPricing = later.pricing;
    // Disabling future promotions or refreshing the catalog cannot rewrite an accepted promise.
    ctx.config.modalComputePromotionEnabled = false;
    await updateCatalog(modal, { rateMicrosPerSecond: 110 });
    const vm = await close(req.id, older.id, later.id);
    expect(vm.provider_id).toBe(modal.id);
    expect(vm.bid_id).toBe(later.id);
    expect(vm.create_input).toMatchObject({
      provider: 'modal',
      ttlSeconds: 1800,
      maximumPriceMicrosPerSecond: 100,
    });
    expect(vm.quote_snapshot).toMatchObject({
      totalPriceCents: 1,
      feeCents: 0,
      revenueShare: revenueShare(1),
    });
    expect(vm.quote_snapshot.pricing).toEqual(frozenPricing);
    const holds = (await pool.query('SELECT bid_id,released_at FROM broker_holds ORDER BY bid_id'))
      .rows;
    expect(holds.find((hold) => hold.bid_id === older.id).released_at).not.toBeNull();
    expect(holds.find((hold) => hold.bid_id === later.id).released_at).toBeNull();
    const environment: WickEnvironment = {
      id: `offline-${randomUUID()}`,
      name: vm.create_input.name,
      provider: 'modal',
      profile: 'small',
      organizationId: 'offline-org',
      groupId: 'offline-group',
      status: 'running',
      billingMode: 'wick_managed',
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 1800000).toISOString(),
      raw: {},
    };
    await pool.query('UPDATE broker_vms SET environment_id=$2,expires_at=$3 WHERE id=$1', [
      vm.id,
      environment.id,
      environment.expiresAt,
    ]);
    expect(await markReady(ctx, vm.id, environment, true)).toBe(true);
    expect(await markReady(ctx, vm.id, environment, true)).toBe(false);
    await closeAuction(ctx, req.id);
    expect(
      (
        await pool.query(
          'SELECT provider_id,total_cents,fee_cents,revenue_share FROM broker_invoices WHERE vm_id=$1',
          [vm.id],
        )
      ).rows,
    ).toEqual([
      {
        provider_id: modal.id,
        total_cents: 1,
        fee_cents: 0,
        revenue_share: {
          commissionBps: 1500,
          grossCents: 1,
          brokerFeeMicros: '1500',
          providerNetMicros: '8500',
        },
      },
    ]);
    expect(
      (await pool.query('SELECT count(*)::int AS n FROM broker_vms WHERE request_id=$1', [req.id]))
        .rows[0].n,
    ).toBe(1);
  });

  it('keeps ordinary timestamp tie-breaking when the promotion is disabled', async () => {
    ctx.config.modalComputePromotionEnabled = false;
    await updateCatalog(modal, { rateMicrosPerSecond: 0 });
    const req = await request();
    const first = await submitBid(ctx, e2b.actor, req.id, { totalPriceCents: 1 });
    const second = await submitBid(ctx, modal.actor, req.id, { totalPriceCents: 1 });
    expect(second.pricing).not.toHaveProperty('promotion');
    expect((await close(req.id, first.id, second.id)).provider_id).toBe(e2b.id);
  });

  it('uses the reviewed promotion instead of a higher provider base while retaining its minimum and maximum', async () => {
    await pool.query('UPDATE broker_providers SET policy=policy || $2::jsonb WHERE id=$1', [
      modal.id,
      { minimumPriceCents: 1, basePriceCents: 10, maxPriceCents: 100 },
    ]);
    const req = await request({ maxPriceCents: 1 });
    const proposal = await proposeBid(ctx, modal.actor, req.id);
    expect(proposal).toMatchObject({ decision: 'bid', totalPriceCents: 1, modelCalled: false });
    const bid = await submitBid(
      ctx,
      modal.actor,
      req.id,
      { totalPriceCents: 1, offeringId: modal.offeringId },
      'auto',
    );
    expect(bid.pricing).toMatchObject({ totalPriceCents: 1, priceBasis: 'operator-sponsored' });
    expect(
      (await pool.query('SELECT policy FROM broker_providers WHERE id=$1', [modal.id])).rows[0]
        .policy,
    ).toMatchObject({ minimumPriceCents: 1, basePriceCents: 10, maxPriceCents: 100 });
  });

  it('chooses the lower upstream cost when compatible Modal sizes share the sponsored buyer price', async () => {
    const large: CatalogItem = {
      ...modal.item,
      id: 'modal:large:auto',
      name: 'Modal Large',
      profile: 'large',
      cpu: 8,
      memoryGb: 16,
      rateMicrosPerSecond: 265,
    };
    const largeOfferingId = '00000000-0000-4000-8000-000000000001';
    await pool.query(
      "INSERT INTO broker_catalog(id,item,approved,source_mode) VALUES($1,$2,true,'real')",
      [large.id, large],
    );
    // Give Large the better list price and ID so only upstream-cost ordering favors Small.
    await pool.query(
      'INSERT INTO broker_offerings(id,provider_id,catalog_id,name,description,price_cents,pricing) VALUES($1,$2,$3,$4,$5,1,$6)',
      [largeOfferingId, modal.id, large.id, 'Modal Large', 'Offline only', managedPricing(large)],
    );
    await pool.query('UPDATE broker_providers SET policy=policy || $2::jsonb WHERE id=$1', [
      modal.id,
      { allowedCatalogIds: [modal.item.id, large.id] },
    ]);
    const req = await request({ maxPriceCents: 1 });
    expect(await proposeBid(ctx, modal.actor, req.id)).toMatchObject({
      decision: 'bid',
      totalPriceCents: 1,
      offeringId: modal.offeringId,
      modelCalled: false,
    });
    const bid = await submitBid(ctx, modal.actor, req.id, { totalPriceCents: 1 }, 'auto');
    expect(bid.catalogId).toBe(modal.item.id);
    expect(
      (await pool.query('SELECT offering_id FROM broker_bids WHERE id=$1', [bid.id])).rows[0]
        .offering_id,
    ).toBe(modal.offeringId);
    expect(bid.pricing).toMatchObject({
      totalPriceCents: 1,
      upstreamEstimatedComputeMicros: '180000',
    });
  });

  it('leaves non-Modal and disabled Modal cost floors intact', async () => {
    const req = await request();
    await expect(submitBid(ctx, daytona.actor, req.id, { totalPriceCents: 1 })).rejects.toThrow(
      /cost floor/,
    );
    ctx.config.modalComputePromotionEnabled = false;
    await expect(submitBid(ctx, modal.actor, req.id, { totalPriceCents: 1 })).rejects.toThrow(
      /cost floor/,
    );
    await noReservations();
    const ordinary = await submitBid(ctx, daytona.actor, req.id, { totalPriceCents: 22 });
    expect(ordinary.pricing).toMatchObject({
      totalPriceCents: 22,
      upstreamCostFloorCents: 22,
      priceBasis: 'provider-bid',
    });
    expect(ordinary.pricing).not.toHaveProperty('promotion');
  });

  it('does not sponsor a simulated Modal account or a different account bound to the Modal catalog', async () => {
    const req = await request();
    await pool.query('UPDATE broker_providers SET simulated=true WHERE id=$1', [modal.id]);
    await expect(submitBid(ctx, modal.actor, req.id, { totalPriceCents: 1 })).rejects.toThrow();
    await pool.query(
      "UPDATE broker_providers SET simulated=false,cloud_provider='e2b' WHERE id=$1",
      [modal.id],
    );
    await expect(submitBid(ctx, modal.actor, req.id, { totalPriceCents: 1 })).rejects.toThrow();
    await noReservations();
  });

  it('does not sponsor a route whose full rental cost exceeds the operator cap', async () => {
    await updateCatalog(modal, { rateMicrosPerSecond: 556 });
    const req = await request();
    await expect(submitBid(ctx, modal.actor, req.id, { totalPriceCents: 1 })).rejects.toThrow(
      /cost floor/,
    );
    await noReservations();
    const ordinary = await submitBid(ctx, modal.actor, req.id, { totalPriceCents: 118 });
    expect(ordinary.pricing).toMatchObject({
      totalPriceCents: 118,
      upstreamEstimatedComputeMicros: '1000800',
      priceBasis: 'provider-bid',
    });
    expect(ordinary.pricing).not.toHaveProperty('promotion');
  });

  it('cannot offer incompatible resources or an unpublished configuration', async () => {
    await updateCatalog(e2b, { cpu: 4, memoryGb: 8 });
    const incompatible = await request({ requirements: { cpu: 4, memoryGb: 8 } });
    await expect(
      submitBid(ctx, modal.actor, incompatible.id, { totalPriceCents: 1 }),
    ).rejects.toThrow();
    const compatible = await request();
    await pool.query('UPDATE broker_offerings SET active=false WHERE id=$1', [modal.offeringId]);
    await expect(
      submitBid(ctx, modal.actor, compatible.id, { totalPriceCents: 1 }),
    ).rejects.toThrow(/offering|configuration/);
    await noReservations();
  });

  it('does not bypass the supplier price policy or its automatic-bidding switch', async () => {
    const req = await request();
    await pool.query('UPDATE broker_providers SET policy=policy || $2::jsonb WHERE id=$1', [
      modal.id,
      { minimumPriceCents: 2, basePriceCents: 2 },
    ]);
    await expect(submitBid(ctx, modal.actor, req.id, { totalPriceCents: 1 })).rejects.toThrow(
      /policy/,
    );
    await pool.query('UPDATE broker_providers SET policy=policy || $2::jsonb WHERE id=$1', [
      modal.id,
      { minimumPriceCents: 1, basePriceCents: 1, autoBid: false },
    ]);
    await expect(
      submitBid(ctx, modal.actor, req.id, { totalPriceCents: 1 }, 'auto'),
    ).rejects.toThrow(/disabled/);
    await noReservations();
  });

  it('rejects late and full-account bids without reserving a slot', async () => {
    const late = await request();
    await expire(late.id);
    await expect(submitBid(ctx, modal.actor, late.id, { totalPriceCents: 1 })).rejects.toThrow(
      /closed|Late/,
    );
    const full = await request();
    await pool.query('UPDATE broker_providers SET total_capacity=0 WHERE id=$1', [modal.id]);
    await expect(submitBid(ctx, modal.actor, full.id, { totalPriceCents: 1 })).rejects.toThrow(
      /capacity|reserved|slots/,
    );
    await noReservations();
  });

  it('concurrent sponsored bids cannot reserve the same provider slot twice', async () => {
    const requests = await Promise.all([request(), request()]);
    const results = await Promise.allSettled(
      requests.map((req) => submitBid(ctx, modal.actor, req.id, { totalPriceCents: 1 }, 'auto')),
    );
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    expect(
      (await pool.query('SELECT count(*)::int AS n FROM broker_holds WHERE released_at IS NULL'))
        .rows[0].n,
    ).toBe(1);
    expect((await pool.query('SELECT count(*)::int AS n FROM broker_bids')).rows[0].n).toBe(1);
  });

  const adminPath = '/api/admin/compute-promotion/modal';
  function asAdmin() {
    authenticatedActor = { ...buyer, role: 'admin' };
  }
  async function promotionState() {
    const response = await app.inject({ method: 'GET', url: adminPath });
    expect(response.statusCode).toBe(200);
    return response.json();
  }
  function configurePromotion(payload: Record<string, unknown>) {
    return app.inject({ method: 'POST', url: adminPath, payload });
  }
  async function mutationSnapshot() {
    return {
      providers: (await pool.query('SELECT * FROM broker_providers ORDER BY id')).rows,
      offerings: (await pool.query('SELECT * FROM broker_offerings ORDER BY id')).rows,
      bids: (await pool.query('SELECT * FROM broker_bids ORDER BY id')).rows,
      holds: (await pool.query('SELECT * FROM broker_holds ORDER BY id')).rows,
      receipts: (await pool.query('SELECT * FROM broker_operation_receipts ORDER BY operation_key'))
        .rows,
      activity: (await pool.query('SELECT * FROM broker_activity ORDER BY id')).rows,
    };
  }

  it('admin configuration updates only Modal pricing and preserves holds, history, bindings and spare capacity', async () => {
    await pool.query(
      'UPDATE broker_providers SET total_capacity=5,policy=policy || $2::jsonb,policy_apply_receipt=$3 WHERE id=$1',
      [
        modal.id,
        { autoBid: false, basePriceCents: 10, reserveSlots: 2 },
        { operationKey: 'prior-provider-policy', response: { policyRevision: 2 } },
      ],
    );
    ctx.config.modalComputePromotionEnabled = false;
    const existingRequest = await request();
    await submitBid(ctx, modal.actor, existingRequest.id, { totalPriceCents: 22 });
    ctx.config.modalComputePromotionEnabled = true;
    const medium: CatalogItem = {
      ...modal.item,
      id: 'modal:medium:auto',
      name: 'Modal Medium',
      profile: 'medium',
      cpu: 4,
      memoryGb: 8,
      rateMicrosPerSecond: 133,
    };
    await pool.query(
      "INSERT INTO broker_catalog(id,item,approved,source_mode) VALUES($1,$2,true,'real')",
      [medium.id, medium],
    );
    const retiredId = randomUUID();
    await pool.query(
      'INSERT INTO broker_offerings(id,provider_id,catalog_id,name,description,price_cents,pricing,active) VALUES($1,$2,$3,$4,$5,60,$6,false)',
      [
        retiredId,
        modal.id,
        medium.id,
        'Historical retired offer',
        'Keep unchanged',
        managedPricing(medium),
      ],
    );
    asAdmin();
    const state = await promotionState();
    expect(state).toMatchObject({
      enabled: true,
      mode: 'real',
      provider: {
        id: modal.id,
        totalCapacity: 5,
        held: 1,
        cloudProvider: 'modal',
        simulated: false,
        policy: { autoBid: false, basePriceCents: 10, reserveSlots: 2 },
      },
      offeringsTruncated: false,
    });
    expect(state.offerings).toHaveLength(2);
    const before = await mutationSnapshot();
    const response = await configurePromotion({
      operationKey: randomUUID(),
      expectedRevision: state.provider.policyRevision,
      catalogIds: [medium.id, modal.item.id],
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      enabled: true,
      provider: {
        id: modal.id,
        totalCapacity: 5,
        held: 1,
        cloudProvider: 'modal',
        simulated: false,
        policyRevision: state.provider.policyRevision + 1,
        policy: {
          autoBid: true,
          minimumPriceCents: 1,
          basePriceCents: 1,
          maxPriceCents: 1,
          reserveSlots: 2,
          allowedCatalogIds: [medium.id, modal.item.id].sort(),
        },
      },
    });
    const after = await mutationSnapshot();
    expect(after.bids).toEqual(before.bids);
    expect(after.holds).toEqual(before.holds);
    expect(after.providers.filter((row) => row.id !== modal.id)).toEqual(
      before.providers.filter((row) => row.id !== modal.id),
    );
    const originalProvider = before.providers.find((row) => row.id === modal.id);
    expect(after.providers.find((row) => row.id === modal.id)).toMatchObject({
      id: originalProvider.id,
      user_id: originalProvider.user_id,
      name: originalProvider.name,
      cloud_provider: originalProvider.cloud_provider,
      simulated: originalProvider.simulated,
      created_at: originalProvider.created_at,
      total_capacity: originalProvider.total_capacity,
      policy_apply_receipt: originalProvider.policy_apply_receipt,
    });
    const oldActive = before.offerings.find((row) => row.id === modal.offeringId);
    expect(after.offerings.find((row) => row.id === modal.offeringId)).toMatchObject({
      active: true,
      price_cents: 1,
      revision: oldActive.revision + 1,
    });
    expect(after.offerings.find((row) => row.id === retiredId)).toEqual(
      before.offerings.find((row) => row.id === retiredId),
    );
    expect(after.offerings.filter((row) => row.catalog_id === medium.id && row.active)).toEqual([
      expect.objectContaining({ price_cents: 1, provider_id: modal.id }),
    ]);
    expect(after.offerings.filter((row) => row.provider_id !== modal.id)).toEqual(
      before.offerings.filter((row) => row.provider_id !== modal.id),
    );
    expect(after.receipts).toHaveLength(1);
    expect(
      (await pool.query("SELECT value FROM broker_settings WHERE key='maxConcurrentVms'")).rows[0]
        .value,
    ).toBe(20);
  });

  it('admin retries replay once, even after disable, while changed inputs and stale revisions fail atomically', async () => {
    asAdmin();
    const state = await promotionState();
    const body = {
      operationKey: randomUUID(),
      expectedRevision: state.provider.policyRevision,
      catalogIds: [modal.item.id],
    };
    const first = await configurePromotion(body);
    expect(first.statusCode).toBe(200);
    const applied = await mutationSnapshot();
    expect((await configurePromotion(body)).json()).toEqual(first.json());
    expect((await configurePromotion({ ...body, catalogIds: [e2b.item.id] })).statusCode).toBe(409);
    expect((await configurePromotion({ ...body, operationKey: randomUUID() })).statusCode).toBe(
      409,
    );
    ctx.config.modalComputePromotionEnabled = false;
    const replay = await configurePromotion(body);
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toEqual(first.json());
    expect(await mutationSnapshot()).toEqual(applied);
  });

  it('admin configuration rejects non-Modal, unapproved, and over-cap advertised routes without partial writes', async () => {
    asAdmin();
    const state = await promotionState();
    const unapproved = { ...modal.item, id: 'modal:unapproved:auto', approved: false };
    // Fifteen and thirty minutes fit; the advertised hour exceeds the cap by 800 µUSD.
    const overCap = { ...modal.item, id: 'modal:overcap:auto', rateMicrosPerSecond: 278 };
    for (const item of [unapproved, overCap])
      await pool.query(
        "INSERT INTO broker_catalog(id,item,approved,source_mode) VALUES($1,$2,$3,'real')",
        [item.id, item, item.approved],
      );
    const before = await mutationSnapshot();
    for (const invalidId of [e2b.item.id, unapproved.id, overCap.id]) {
      const response = await configurePromotion({
        operationKey: randomUUID(),
        expectedRevision: state.provider.policyRevision,
        catalogIds: [modal.item.id, invalidId],
      });
      expect(response.statusCode).toBe(400);
      expect(await mutationSnapshot()).toEqual(before);
    }
  });

  it('admin configuration requires admin authority, explicit enablement and real mode', async () => {
    expect((await app.inject({ method: 'GET', url: adminPath })).statusCode).toBe(403);
    const body = { operationKey: randomUUID(), expectedRevision: 1, catalogIds: [modal.item.id] };
    expect((await configurePromotion(body)).statusCode).toBe(403);
    asAdmin();
    const before = await mutationSnapshot();
    ctx.config.modalComputePromotionEnabled = false;
    expect((await promotionState()).enabled).toBe(false);
    expect((await configurePromotion(body)).statusCode).toBe(409);
    ctx.config.modalComputePromotionEnabled = true;
    ctx.wick.mode = 'fixture';
    try {
      expect((await configurePromotion(body)).statusCode).toBe(409);
    } finally {
      ctx.wick.mode = 'real';
    }
    expect((await configurePromotion({ ...body, totalCapacity: 999 })).statusCode).toBe(400);
    expect(await mutationSnapshot()).toEqual(before);
  });
});
