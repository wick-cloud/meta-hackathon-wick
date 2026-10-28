import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { PgBoss } from 'pg-boss';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { migrate } from '../src/server/db.js';
import { loadConfig } from '../src/server/config.js';
import type { AppContext } from '../src/server/context.js';
import type { Actor, CatalogItem } from '../src/shared/types.js';
import { QUEUES } from '../src/server/marketplace/db.js';
import { createRequest, submitBid } from '../src/server/marketplace/auction.js';
import {
  acceptCounteroffer,
  createIntent,
  getIntent,
  proposeCounteroffers,
} from '../src/server/marketplace/negotiation.js';
import { createMuseAdapter } from '../src/server/integrations/muse.js';
import { cleanupVm, provisionVm, terminateVm } from '../src/server/marketplace/lifecycle.js';
import { requestView } from '../src/server/marketplace/data.js';
import { managedPricing } from '../src/shared/pricing.js';
import Fastify from 'fastify';
import { registerNegotiation } from '../src/server/marketplace/negotiation.js';
import { createWickAdapter } from '../src/server/integrations/wick.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
const schema = `negotiation_${randomUUID().replaceAll('-', '')}`,
  jobs = `${schema}_jobs`;
const item: CatalogItem = {
  id: 'test-e2b',
  name: 'Test E2B',
  description: 'Fixture',
  provider: 'e2b',
  profile: 'small',
  region: 'us',
  cpu: 2,
  memoryGb: 3.724609375,
  durationMinutes: [15, 30, 60],
  approved: true,
};
const buyer: Actor = {
  id: randomUUID(),
  name: 'Buyer',
  email: 'buyer@test.invalid',
  role: 'buyer',
};
const desired = {
  cpu: 4,
  memoryGb: 8,
  gpu: 'unsupported-gpu',
  region: 'unsupported-region',
  durationMinutes: 45,
  maxPriceCents: 500,
};
const flexibility = {
  minCPU: 2,
  minMemoryGb: item.memoryGb,
  allowedRegions: ['us'],
  allowedDurations: [15, 30],
  hardMaxPriceCents: 400,
  gpu: 'none',
};

describe.skipIf(!databaseUrl)('buyer-reviewed nonbinding negotiation', () => {
  let admin: Pool, pool: Pool, boss: PgBoss, ctx: AppContext;
  let providerId: string, offeringId: string, providerActor: Actor;
  beforeAll(async () => {
    admin = new Pool({ connectionString: databaseUrl });
    await admin.query(`CREATE SCHEMA ${schema}`);
    pool = new Pool({
      connectionString: databaseUrl,
      max: 16,
      options: `-c search_path=${schema},public`,
    });
    await migrate(pool);
    boss = new PgBoss({ connectionString: databaseUrl!, schema: jobs });
    await boss.start();
    for (const queue of Object.values(QUEUES)) await boss.createQueue(queue);
    const config = loadConfig({
      NODE_ENV: 'test',
      DATABASE_URL: databaseUrl!,
      BETTER_AUTH_SECRET: 'test-only-secret-longer-than-thirty-two-characters',
      WICK_MODE: 'fixture',
      MUSE_MODE: 'fixture',
    });
    ctx = {
      pool,
      boss,
      config,
      wick: createWickAdapter(config, pool),
      muse: createMuseAdapter(config),
      requireActor: async () => buyer,
    };
  }, 30000);
  beforeEach(async () => {
    await pool.query(
      'TRUNCATE broker_activity,broker_invoices,broker_holds,broker_vms,broker_bids,broker_counteroffers,broker_intents,broker_requests,broker_offerings,broker_providers,broker_catalog CASCADE',
    );
    await pool.query(
      'INSERT INTO broker_catalog(id,item,approved,source_mode) VALUES($1,$2,true,$3)',
      [item.id, item, 'fixture'],
    );
    await pool.query(
      "INSERT INTO broker_settings(key,value) VALUES('maxConcurrentVms','20') ON CONFLICT(key) DO UPDATE SET value='20'",
    );
    providerId = randomUUID();
    offeringId = randomUUID();
    providerActor = {
      id: randomUUID(),
      name: 'Demo supplier',
      email: 'provider@test.invalid',
      role: 'provider',
      providerId,
    };
    await pool.query(
      'INSERT INTO broker_providers(id,user_id,name,total_capacity,policy) VALUES($1,$2,$3,3,$4)',
      [
        providerId,
        providerActor.id,
        providerActor.name,
        {
          autoBid: false,
          minimumPriceCents: 50,
          basePriceCents: 100,
          reserveSlots: 2,
          allowedCatalogIds: [item.id],
        },
      ],
    );
    await pool.query(
      'INSERT INTO broker_offerings(id,provider_id,catalog_id,name,description,price_cents) VALUES($1,$2,$3,$4,$5,100)',
      [offeringId, providerId, item.id, 'Test alternative', 'Fixture only'],
    );
    for (const queue of Object.values(QUEUES)) await boss.deleteAllJobs(queue);
    ctx.muse = createMuseAdapter(ctx.config);
    ctx.wick = createWickAdapter(ctx.config, pool);
  });
  afterAll(async () => {
    if (boss) await boss.stop({ graceful: true });
    if (pool) await pool.end();
    if (admin) {
      await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await admin.query(`DROP SCHEMA IF EXISTS ${jobs} CASCADE`);
      await admin.end();
    }
  });
  async function intent(extra: Record<string, unknown> = {}) {
    return createIntent(ctx, buyer, {
      operationKey: randomUUID(),
      description: 'Review alternative interactive environment',
      desired,
      flexibility,
      ...extra,
    });
  }
  async function proposed(extra: Record<string, unknown> = {}) {
    const i = await intent(extra);
    const p = await proposeCounteroffers(ctx, buyer, i.id);
    expect(p.offers.length).toBeGreaterThan(0);
    return p;
  }
  async function counts() {
    return (
      await pool.query(
        'SELECT (SELECT count(*)::int FROM broker_requests) requests,(SELECT count(*)::int FROM broker_holds WHERE released_at IS NULL) holds,(SELECT count(*)::int FROM broker_vms) vms',
      )
    ).rows[0];
  }
  it('records unsupported dimensions without binding, preserves strict defaults and budget', async () => {
    const i = await intent({ flexibility: undefined });
    expect(i.desired).toEqual(desired);
    expect(i.flexibility.minMemoryGb).toBe(8);
    expect(i.flexibility.allowedRegions).toEqual(['unsupported-region']);
    expect((await proposeCounteroffers(ctx, buyer, i.id)).offers).toHaveLength(0);
    expect(await counts()).toEqual({ requests: 0, holds: 0, vms: 0 });
  });
  it('validates explicit permissions and never increases the reviewed budget', async () => {
    await expect(
      intent({ flexibility: { ...flexibility, hardMaxPriceCents: 501 } }),
    ).rejects.toThrow(/Hard total/);
    await expect(
      intent({ flexibility: { ...flexibility, allowedRegions: ['imaginary'] } }),
    ).rejects.toThrow(/supported/);
    await expect(intent({ flexibility: { ...flexibility, minCPU: 0 } })).rejects.toThrow(
      /Minimum CPU/,
    );
  });
  it('makes deterministic public diffs without holds, requests or VMs and isolates provider projection', async () => {
    const spy = vi.spyOn(ctx.muse, 'selectCounteroffers');
    const result = await proposed();
    expect(await counts()).toEqual({ requests: 0, holds: 0, vms: 0 });
    const offer = result.offers[0];
    expect(offer.before).toEqual(desired);
    expect(offer.after.memoryGb).toBe(item.memoryGb);
    expect(offer.totalPriceCents).toBe(100);
    expect(offer.tradeoffs.join(' ')).toContain('unsupported-region');
    expect(JSON.stringify(offer)).not.toMatch(
      /reserveSlots|minimumPriceCents|policyRevision|organizationId/,
    );
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][0].capacity.available).toBe(1);
    expect(JSON.stringify(spy.mock.calls[0][0])).not.toContain(buyer.id);
  });
  it('uses immutable idempotent intents and rejects changed operation bodies', async () => {
    const key = randomUUID(),
      a = await intent({ operationKey: key }),
      b = await intent({ operationKey: key });
    expect(a.id).toBe(b.id);
    await expect(intent({ operationKey: key, description: 'Different' })).rejects.toThrow(
      /different intent/,
    );
    await expect(
      pool.query("UPDATE broker_intents SET desired='{}' WHERE id=$1", [a.id]),
    ).rejects.toThrow(/immutable/);
  });
  it('rejects hallucinated selections with no binding side effects', async () => {
    ctx.muse.selectCounteroffers = async () => ({
      selections: [{ candidateId: 'fiction', rationale: 'made up' }],
      receipt: { observed: [], decision: '', constraints: [] },
      mode: 'fixture',
      modelCalled: false,
    });
    const i = await intent();
    await expect(proposeCounteroffers(ctx, buyer, i.id)).rejects.toThrow(/unsupported/);
    expect(await counts()).toEqual({ requests: 0, holds: 0, vms: 0 });
  });
  it('binds the explicit provider and price directly once under concurrent duplicate acceptance', async () => {
    const p = await proposed(),
      key = randomUUID();
    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        acceptCounteroffer(ctx, buyer, p.intent.id, p.offers[0].id, { operationKey: key }),
      ),
    );
    expect(new Set(results.map((r) => r.vmId)).size).toBe(1);
    expect(await counts()).toEqual({ requests: 1, holds: 1, vms: 1 });
    const row = (
      await pool.query(
        'SELECT r.*,v.quote_snapshot FROM broker_requests r JOIN broker_vms v ON v.request_id=r.id',
      )
    ).rows[0];
    expect(row.status).toBe('provisioning');
    expect(row.quote_snapshot.totalPriceCents).toBe(p.offers[0].totalPriceCents);
    expect(row.requirements.memoryGb).toBe(item.memoryGb);
    await expect(
      pool.query("UPDATE broker_requests SET region='changed' WHERE id=$1", [row.id]),
    ).rejects.toThrow(/immutable/);
  });
  it('serializes sibling acceptance and capacity races with no reserve leakage', async () => {
    const a = await proposed(),
      b = await proposed();
    const outcomes = await Promise.allSettled([
      acceptCounteroffer(ctx, buyer, a.intent.id, a.offers[0].id, { operationKey: randomUUID() }),
      acceptCounteroffer(ctx, buyer, a.intent.id, a.offers[1].id, { operationKey: randomUUID() }),
      acceptCounteroffer(ctx, buyer, b.intent.id, b.offers[0].id, { operationKey: randomUUID() }),
    ]);
    expect(outcomes.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(await counts()).toEqual({ requests: 1, holds: 1, vms: 1 });
  });
  it.each(['policy', 'offering', 'catalog', 'capacity', 'global', 'mode', 'expired'])(
    'rejects stale %s atomically',
    async (kind) => {
      const p = await proposed();
      if (kind === 'policy')
        await pool.query(
          "UPDATE broker_providers SET policy=jsonb_set(policy,'{minimumPriceCents}','75') WHERE id=$1",
          [providerId],
        );
      if (kind === 'offering')
        await pool.query('UPDATE broker_offerings SET revision=revision+1 WHERE id=$1', [
          offeringId,
        ]);
      if (kind === 'catalog')
        await pool.query('UPDATE broker_catalog SET approved=false WHERE id=$1', [item.id]);
      if (kind === 'capacity')
        await pool.query('UPDATE broker_providers SET total_capacity=2 WHERE id=$1', [providerId]);
      if (kind === 'global')
        await pool.query("UPDATE broker_settings SET value='0' WHERE key='maxConcurrentVms'");
      if (kind === 'mode') ctx.wick = { ...ctx.wick, mode: 'real' };
      if (kind === 'expired')
        await pool.query("UPDATE broker_counteroffers SET expires_at=now()-interval '1 second'");
      await expect(
        acceptCounteroffer(ctx, buyer, p.intent.id, p.offers[0].id, { operationKey: randomUUID() }),
      ).rejects.toThrow();
      expect(await counts()).toEqual({ requests: 0, holds: 0, vms: 0 });
    },
  );
  it('rejects a different buyer and cross-intent offer ownership', async () => {
    const p = await proposed(),
      other = { ...buyer, id: randomUUID() };
    await expect(getIntent(ctx, other, p.intent.id)).rejects.toThrow(/not found/);
    await expect(
      acceptCounteroffer(ctx, other, p.intent.id, p.offers[0].id, { operationKey: randomUUID() }),
    ).rejects.toThrow(/not found/);
    const second = await intent();
    await expect(
      acceptCounteroffer(ctx, buyer, second.id, p.offers[0].id, { operationKey: randomUUID() }),
    ).rejects.toThrow(/belong/);
    expect(await counts()).toEqual({ requests: 0, holds: 0, vms: 0 });
  });
  it('rolls back request, bid, hold and VM if the transactional provision enqueue fails', async () => {
    const p = await proposed();
    const spy = vi.spyOn(boss, 'send').mockRejectedValueOnce(new Error('queue unavailable'));
    await expect(
      acceptCounteroffer(ctx, buyer, p.intent.id, p.offers[0].id, { operationKey: randomUUID() }),
    ).rejects.toThrow(/queue unavailable/);
    spy.mockRestore();
    expect(await counts()).toEqual({ requests: 0, holds: 0, vms: 0 });
    expect((await getIntent(ctx, buyer, p.intent.id)).intent.status).toBe('open');
  });
  it('serializes source normal retry against acceptance and preserves original requirements', async () => {
    const original = (
      await pool.query(
        `INSERT INTO broker_requests(buyer_id,description,catalog_id,catalog_snapshot,region,duration_minutes,max_price_cents,requirements,status) VALUES($1,'Original',$2,$3,$4,30,500,$5,'no_offers') RETURNING *`,
        [buyer.id, item.id, item, item.region, { cpu: 2, memoryGb: item.memoryGb }],
      )
    ).rows[0];
    const i = await intent({
      sourceRequestId: original.id,
      desired: {
        cpu: 2,
        memoryGb: item.memoryGb,
        region: item.region,
        durationMinutes: 30,
        maxPriceCents: 500,
      },
      flexibility: undefined,
    });
    const p = await proposeCounteroffers(ctx, buyer, i.id);
    const results = await Promise.allSettled([
      acceptCounteroffer(ctx, buyer, i.id, p.offers[0].id, { operationKey: randomUUID() }),
      createRequest(
        ctx,
        buyer,
        {
          description: original.description,
          catalogId: item.id,
          region: item.region,
          durationMinutes: 30,
          maxPriceCents: 500,
          requirements: original.requirements,
        },
        original.id,
      ),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect((await counts()).requests).toBe(2);
    const after = (await pool.query('SELECT * FROM broker_requests WHERE id=$1', [original.id]))
      .rows[0];
    expect(after.requirements).toEqual(original.requirements);
    expect(after.catalog_snapshot).toEqual(original.catalog_snapshot);
    expect(after.resolution_request_id).toBeTruthy();
  });
  it.each(['provider', 'global'])('rechecks expiry after waiting for a %s lock', async (kind) => {
    const p = await proposed();
    await pool.query(
      "UPDATE broker_counteroffers SET expires_at=clock_timestamp()+interval '150 milliseconds' WHERE id=$1",
      [p.offers[0].id],
    );
    const lock = await pool.connect();
    await lock.query('BEGIN');
    if (kind === 'provider')
      await lock.query('SELECT id FROM broker_providers WHERE id=$1 FOR UPDATE', [providerId]);
    else await lock.query("SELECT pg_advisory_xact_lock(hashtext('broker-global-vm-admission'))");
    const pending = acceptCounteroffer(ctx, buyer, p.intent.id, p.offers[0].id, {
      operationKey: randomUUID(),
    });
    const observed = pending.catch((error) => error);
    await new Promise((resolve) => setTimeout(resolve, 250));
    await lock.query('ROLLBACK');
    lock.release();
    expect((await observed).message).toMatch(/expired/);
    expect(await counts()).toEqual({ requests: 0, holds: 0, vms: 0 });
  });
  it('limits repeated proposal fanout before model calls', async () => {
    const app = Fastify();
    app.setErrorHandler((error: any, _request, reply) =>
      reply.code(error.statusCode ?? 500).send({ error: error.message }),
    );
    registerNegotiation(app, ctx);
    const i = await intent();
    const spy = vi.spyOn(ctx.muse, 'selectCounteroffers');
    for (let n = 0; n < 10; n++)
      expect(
        (await app.inject({ method: 'POST', url: `/api/intents/${i.id}/propose` })).statusCode,
      ).toBe(200);
    expect(
      (await app.inject({ method: 'POST', url: `/api/intents/${i.id}/propose` })).statusCode,
    ).toBe(429);
    expect(spy).toHaveBeenCalledTimes(10);
    await app.close();
  });
  it('uses current real rates and deterministic supplier floor, then rejects stale source rates', async () => {
    const real = {
      ...item,
      organizationId: 'test-org',
      groupId: 'test-group',
      rateMicrosPerSecond: 23,
      rateRetrievedAt: new Date().toISOString(),
      rateSource: 'wick-customer-catalog' as const,
      pricingMode: 'managed' as const,
      managedRouteVerification: 'execution-preview-managed' as const,
    };
    ctx.wick = { ...ctx.wick, mode: 'real' };
    await pool.query("UPDATE broker_catalog SET source_mode='real',item=$1 WHERE id=$2", [
      real,
      item.id,
    ]);
    await pool.query('UPDATE broker_offerings SET pricing=$1 WHERE id=$2', [
      managedPricing(real),
      offeringId,
    ]);
    await pool.query(
      "UPDATE broker_providers SET policy=jsonb_set(policy,'{minimumPriceCents}','5') WHERE id=$1",
      [providerId],
    );
    const p = await proposed();
    const offer = p.offers.find((o) => o.after.durationMinutes === 15)!;
    expect(offer.totalPriceCents).toBe(5);
    expect(offer.pricing.upstreamEstimatedComputeMicros).toBe('20700');
    expect(offer.pricing.upstreamCostFloorCents).toBe(3);
    await pool.query('UPDATE broker_catalog SET item=$1 WHERE id=$2', [
      { ...real, rateRetrievedAt: new Date(Date.now() - 16 * 60_000).toISOString() },
      item.id,
    ]);
    await expect(
      acceptCounteroffer(ctx, buyer, p.intent.id, offer.id, { operationKey: randomUUID() }),
    ).rejects.toThrow(/stale/);
    expect(await counts()).toEqual({ requests: 0, holds: 0, vms: 0 });
  });
  it('shares capacity with manual binding bids and keeps reserved slots spare', async () => {
    const p = await proposed();
    const request = await createRequest(ctx, buyer, {
      description: 'Exact request',
      catalogId: item.id,
      region: item.region,
      durationMinutes: 30,
      maxPriceCents: 500,
      requirements: { cpu: 2, memoryGb: item.memoryGb },
    });
    const results = await Promise.allSettled([
      acceptCounteroffer(ctx, buyer, p.intent.id, p.offers[0].id, { operationKey: randomUUID() }),
      submitBid(ctx, providerActor, request.id, { totalPriceCents: 100, offeringId }),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect((await counts()).holds).toBe(1);
  });
  it('provisions a fixture accepted alternative, issues one frozen invoice and releases its hold only after cleanup', async () => {
    const p = await proposed(),
      accepted = await acceptCounteroffer(ctx, buyer, p.intent.id, p.offers[0].id, {
        operationKey: randomUUID(),
      });
    await provisionVm(ctx, accepted.vmId);
    await pool.query(
      "UPDATE broker_fixture_environments SET ready_at=clock_timestamp()-interval '1 second'",
    );
    await provisionVm(ctx, accepted.vmId);
    const invoices = (
      await pool.query('SELECT * FROM broker_invoices WHERE vm_id=$1', [accepted.vmId])
    ).rows;
    expect(invoices).toHaveLength(1);
    expect(invoices[0].total_cents).toBe(p.offers[0].totalPriceCents);
    await terminateVm(ctx, buyer.id, accepted.vmId);
    await cleanupVm(ctx, accepted.vmId);
    expect((await counts()).holds).toBe(1);
    await pool.query(
      "UPDATE broker_fixture_environments SET termination_requested_at=clock_timestamp()-interval '1 second'",
    );
    await cleanupVm(ctx, accepted.vmId);
    expect((await counts()).holds).toBe(0);
    expect(
      (await pool.query('SELECT cleanup_confirmed_at FROM broker_vms WHERE id=$1', [accepted.vmId]))
        .rows[0].cleanup_confirmed_at,
    ).toBeTruthy();
  });
  it('freezes the lower approved hard budget through failed negotiated rental retry', async () => {
    const p = await proposed();
    expect(p.offers[0].before.maxPriceCents).toBe(500);
    expect(p.offers[0].after.maxPriceCents).toBe(400);
    const accepted = await acceptCounteroffer(ctx, buyer, p.intent.id, p.offers[0].id, {
      operationKey: randomUUID(),
    });
    await terminateVm(ctx, buyer.id, accepted.vmId);
    await cleanupVm(ctx, accepted.vmId);
    const original = (
      await pool.query('SELECT * FROM broker_requests WHERE id=$1', [accepted.requestId])
    ).rows[0];
    expect(original.max_price_cents).toBe(400);
    const retried = await createRequest(ctx, buyer, requestView(original), original.id);
    expect(retried.maxPriceCents).toBe(400);
  });
  it('rejects a malformed persisted alternative specification without leaking a hold', async () => {
    const p = await proposed();
    await pool.query(
      "UPDATE broker_counteroffers SET snapshot=jsonb_set(snapshot,'{after,cpu}','1024') WHERE id=$1",
      [p.offers[0].id],
    );
    await expect(
      acceptCounteroffer(ctx, buyer, p.intent.id, p.offers[0].id, { operationKey: randomUUID() }),
    ).rejects.toThrow(/specification is invalid/);
    expect(await counts()).toEqual({ requests: 0, holds: 0, vms: 0 });
  });
  it('requires an actual GPU when the buyer explicitly allows any GPU model', async () => {
    const i = await intent({
      desired: { ...desired, gpu: undefined },
      flexibility: { ...flexibility, gpu: 'any' },
    });
    expect((await proposeCounteroffers(ctx, buyer, i.id)).offers).toHaveLength(0);
    expect(await counts()).toEqual({ requests: 0, holds: 0, vms: 0 });
  });
});
