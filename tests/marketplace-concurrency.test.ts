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
import { closeAuction, createRequest, submitBid } from '../src/server/marketplace/auction.js';
import { cleanupVm, markReady, provisionVm, terminateVm } from '../src/server/marketplace/lifecycle.js';
import type { WickAdapter, WickEnvironment } from '../src/server/integrations/types.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
const schema = `broker_test_${randomUUID().replaceAll('-', '')}`;
const queueSchema = `${schema}_jobs`;
const catalog: CatalogItem = {
  id: 'test-small', name: 'Test Linux', description: 'Explicit test configuration',
  provider: 'test', profile: 'small', region: 'test-region', cpu: 2, memoryGb: 4,
  durationMinutes: [15, 30, 60], approved: true,
  organizationId: 'test-org', groupId: 'test-group',
};

describe.skipIf(!databaseUrl)('PostgreSQL marketplace concurrency and invariants', () => {
  let admin: Pool;
  let pool: Pool;
  let boss: PgBoss;
  let ctx: AppContext;

  beforeAll(async () => {
    admin = new Pool({ connectionString: databaseUrl });
    await admin.query(`CREATE SCHEMA ${schema}`);
    pool = new Pool({ connectionString: databaseUrl, max: 12, options: `-c search_path=${schema},public` });
    await migrate(pool);
    boss = new PgBoss({ connectionString: databaseUrl!, schema: queueSchema });
    await boss.start();
    for (const queue of Object.values(QUEUES)) await boss.createQueue(queue);
    ctx = {
      pool, boss,
      config: loadConfig({
        NODE_ENV: 'test', DATABASE_URL: databaseUrl!, BETTER_AUTH_SECRET: 'test-only-auth-secret-with-at-least-32-characters',
        WICK_MODE: 'fixture', MUSE_MODE: 'fixture', WICK_ORGANIZATION_ID: 'test-org', WICK_GROUP_ID: 'test-group',
      }),
      // Domain tests never contact an external service or allocate real resources.
      wick: { mode: 'fixture', catalog: async () => [catalog] } as AppContext['wick'],
      muse: { mode: 'fixture' } as AppContext['muse'],
      requireActor: async () => { throw new Error('HTTP authentication is covered by browser tests.'); },
    };
  }, 30_000);

  beforeEach(async () => {
    await pool.query('TRUNCATE broker_activity, broker_invoices, broker_holds, broker_vms, broker_bids, broker_requests, broker_offerings, broker_providers, broker_catalog CASCADE');
    await pool.query('INSERT INTO broker_catalog(id,item,approved) VALUES($1,$2,true)', [catalog.id, catalog]);
    await pool.query("UPDATE broker_settings SET value='2' WHERE key='maxConcurrentVms'");
    for (const queue of Object.values(QUEUES)) await boss.deleteAllJobs(queue);
  });

  afterAll(async () => {
    if (boss) await boss.stop({ graceful: true });
    if (pool) await pool.end();
    if (admin) {
      await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await admin.query(`DROP SCHEMA IF EXISTS ${queueSchema} CASCADE`);
      await admin.end();
    }
  });

  async function provider(capacity = 1, price = 200) {
    const providerId = randomUUID();
    const actor: Actor = { id: randomUUID(), email: `${providerId}@test.invalid`, name: 'Test supplier', role: 'provider', providerId };
    await pool.query('INSERT INTO broker_providers(id,user_id,name,total_capacity,policy) VALUES($1,$2,$3,$4,$5)', [
      providerId, actor.id, actor.name, capacity,
      { autoBid: false, minimumPriceCents: 50, basePriceCents: price, allowedCatalogIds: [catalog.id] },
    ]);
    const offeringId = randomUUID();
    await pool.query('INSERT INTO broker_offerings(id,provider_id,catalog_id,name,description,price_cents) VALUES($1,$2,$3,$4,$5,$6)', [
      offeringId, providerId, catalog.id, 'Published test offering', 'Test only', price,
    ]);
    return { actor, providerId, offeringId };
  }

  async function request(closed = false, buyerId = randomUUID()) {
    const id = randomUUID();
    await pool.query(`INSERT INTO broker_requests(id,buyer_id,description,catalog_id,catalog_snapshot,region,duration_minutes,max_price_cents,requirements,closes_at)
      VALUES($1,$2,'Test interactive environment',$3,$4,$5,30,1000,$6,clock_timestamp()+$7::interval)`,
    [id, buyerId, catalog.id, catalog, catalog.region, { cpu: 2, memoryGb: 4 }, closed ? '-1 second' : '60 seconds']);
    return id;
  }

  async function acceptedBid(requestId: string, supplier: Awaited<ReturnType<typeof provider>>, price: number, createdAt?: string, bidId: string = randomUUID()) {
    const offering = (await pool.query('SELECT * FROM broker_offerings WHERE id=$1', [supplier.offeringId])).rows[0];
    await pool.query(`INSERT INTO broker_bids(id,request_id,provider_id,offering_id,offering_snapshot,total_price_cents,created_at)
      VALUES($1,$2,$3,$4,$5,$6,COALESCE($7::timestamptz,clock_timestamp()))`,
    [bidId, requestId, supplier.providerId, supplier.offeringId, offering, price, createdAt ?? null]);
    await pool.query('INSERT INTO broker_holds(bid_id,provider_id) VALUES($1,$2)', [bidId, supplier.providerId]);
    return bidId;
  }

  async function awardedVm() {
    const supplier = await provider();
    const buyerId = randomUUID();
    const requestId = await request(true, buyerId);
    const bidId = await acceptedBid(requestId, supplier, 200);
    await closeAuction(ctx, requestId);
    const vm = (await pool.query('SELECT * FROM broker_vms WHERE request_id=$1', [requestId])).rows[0];
    return { vm, supplier, buyerId, bidId, requestId };
  }

  function lifecycleContext(environment: WickEnvironment, terminal = true) {
    const state = { environment, terminal };
    const wick: WickAdapter = {
      mode: 'fixture', catalog: async () => [catalog], preview: async () => ({}),
      create: vi.fn(async () => ({ environment: { ...state.environment } })),
      get: vi.fn(async () => ({ ...state.environment })),
      connections: vi.fn(async () => ({ terminal: state.terminal })),
      session: async () => { throw new Error('These tests never open terminal sessions.'); },
      terminate: vi.fn(async () => {}),
    };
    return { state, wick, lifecycle: { ...ctx, wick } };
  }

  it('competing bids cannot reserve one supplier slot twice', async () => {
    const supplier = await provider(1);
    const requests = await Promise.all([request(), request()]);
    const outcomes = await Promise.allSettled(requests.map(id => submitBid(ctx, supplier.actor, id, { totalPriceCents: 200, offeringId: supplier.offeringId })));
    expect(outcomes.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(outcomes.filter(result => result.status === 'rejected')).toHaveLength(1);
    expect(Number((await pool.query('SELECT count(*) FROM broker_holds WHERE released_at IS NULL')).rows[0].count)).toBe(1);
    expect(Number((await pool.query('SELECT count(*) FROM broker_bids')).rows[0].count)).toBe(1);
  });

  it('concurrent duplicate submissions produce only one bid and reservation', async () => {
    const supplier = await provider(3);
    const id = await request();
    await Promise.allSettled(Array.from({ length: 8 }, () => submitBid(ctx, supplier.actor, id, { totalPriceCents: 200 })));
    expect(Number((await pool.query('SELECT count(*) FROM broker_bids WHERE request_id=$1', [id])).rows[0].count)).toBe(1);
    expect(Number((await pool.query('SELECT count(*) FROM broker_holds WHERE released_at IS NULL')).rows[0].count)).toBe(1);
  });

  it('rejects a bid after the auction deadline without taking capacity', async () => {
    const supplier = await provider();
    const id = await request(true);
    await expect(submitBid(ctx, supplier.actor, id, { totalPriceCents: 200 })).rejects.toThrow();
    expect(Number((await pool.query('SELECT count(*) FROM broker_holds')).rows[0].count)).toBe(0);
  });

  it('closes concurrently once, awards lowest fixed price, and releases only losing holds', async () => {
    const first = await provider();
    const second = await provider();
    const id = await request(true);
    const losingBid = await acceptedBid(id, first, 300);
    const winningBid = await acceptedBid(id, second, 200);
    const outcomes = await Promise.allSettled(Array.from({ length: 6 }, () => closeAuction(ctx, id)));
    expect(outcomes.filter(result => result.status === 'rejected')).toEqual([]);
    const stored = (await pool.query('SELECT * FROM broker_requests WHERE id=$1', [id])).rows[0];
    expect(stored.winning_bid_id).toBe(winningBid);
    expect(stored.status).toBe('provisioning');
    expect(Number((await pool.query('SELECT count(*) FROM broker_vms WHERE request_id=$1', [id])).rows[0].count)).toBe(1);
    expect((await pool.query('SELECT released_at FROM broker_holds WHERE bid_id=$1', [winningBid])).rows[0].released_at).toBeNull();
    expect((await pool.query('SELECT released_at FROM broker_holds WHERE bid_id=$1', [losingBid])).rows[0].released_at).not.toBeNull();
    const jobs = await pool.query(`SELECT count(*) FROM ${queueSchema}.job WHERE name=$1 AND data->>'vmId'=(SELECT id::text FROM broker_vms WHERE request_id=$2)`, [QUEUES.provision, id]);
    expect(Number(jobs.rows[0].count)).toBe(1);
  });

  it('breaks equal-price ties by accepted timestamp and then identifier', async () => {
    const suppliers = await Promise.all([provider(), provider(), provider()]);
    const id = await request(true);
    const ids = ['00000000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000000'];
    await acceptedBid(id, suppliers[0]!, 200, '2026-01-01T00:00:00Z', ids[0]);
    await acceptedBid(id, suppliers[1]!, 200, '2026-01-01T00:00:00Z', ids[1]);
    await acceptedBid(id, suppliers[2]!, 200, '2026-01-01T00:00:01Z', ids[2]);
    await closeAuction(ctx, id);
    expect((await pool.query('SELECT winning_bid_id FROM broker_requests WHERE id=$1', [id])).rows[0].winning_bid_id).toBe(ids[1]);
  });

  it('rolls back the award and capacity changes when durable enqueue fails', async () => {
    const first = await provider();
    const second = await provider();
    const id = await request(true);
    await acceptedBid(id, first, 200);
    await acceptedBid(id, second, 300);
    const unavailableQueue = {
      ...ctx,
      boss: { send: async () => { throw new Error('Queue insert failed'); } } as unknown as PgBoss,
    };
    await expect(closeAuction(unavailableQueue, id)).rejects.toThrow('Queue insert failed');
    expect((await pool.query('SELECT status FROM broker_requests WHERE id=$1', [id])).rows[0].status).toBe('open');
    expect(Number((await pool.query('SELECT count(*) FROM broker_vms')).rows[0].count)).toBe(0);
    expect(Number((await pool.query('SELECT count(*) FROM broker_holds WHERE released_at IS NULL')).rows[0].count)).toBe(2);
    expect((await pool.query('SELECT DISTINCT status FROM broker_bids')).rows.map(row => row.status)).toEqual(['held']);
  });

  it('keeps an existing reservation eligible after supplier policy and offering changes', async () => {
    const supplier = await provider();
    const id = await request(true);
    const bidId = await acceptedBid(id, supplier, 200);
    await pool.query('UPDATE broker_providers SET total_capacity=0,policy=$2 WHERE id=$1', [supplier.providerId, { autoBid: false, minimumPriceCents: 9999, basePriceCents: 9999, allowedCatalogIds: [] }]);
    await pool.query('UPDATE broker_offerings SET price_cents=9999,revision=2,active=false WHERE id=$1', [supplier.offeringId]);
    await closeAuction(ctx, id);
    expect((await pool.query('SELECT winning_bid_id FROM broker_requests WHERE id=$1', [id])).rows[0].winning_bid_id).toBe(bidId);
    const vm = (await pool.query('SELECT * FROM broker_vms WHERE request_id=$1', [id])).rows[0];
    expect(JSON.stringify(vm.quote_snapshot)).toContain('200');
    expect(JSON.stringify(vm.quote_snapshot)).not.toContain('9999');
    expect(vm.create_key).toBeTruthy();
    expect((await pool.query('SELECT released_at FROM broker_holds WHERE bid_id=$1', [bidId])).rows[0].released_at).toBeNull();
  });

  it('limits concurrent actual VM admissions even when auctions close together', async () => {
    const supplier = await provider(3);
    const buyer = randomUUID();
    const requests = await Promise.all(Array.from({ length: 3 }, () => request(true, buyer)));
    for (const id of requests) await acceptedBid(id, supplier, 200);
    const outcomes = await Promise.allSettled(requests.map(id => closeAuction(ctx, id)));
    expect(outcomes.filter(result => result.status === 'rejected')).toEqual([]);
    expect(Number((await pool.query('SELECT count(*) FROM broker_vms WHERE cleanup_confirmed_at IS NULL')).rows[0].count)).toBe(2);
    expect(Number((await pool.query('SELECT count(*) FROM broker_holds WHERE released_at IS NULL')).rows[0].count)).toBe(2);
  });

  it('cannot mutate an accepted environment specification in SQL', async () => {
    const id = await request();
    await expect(pool.query('UPDATE broker_requests SET duration_minutes=60 WHERE id=$1', [id])).rejects.toThrow(/immutable/i);
    expect((await pool.query('SELECT duration_minutes FROM broker_requests WHERE id=$1', [id])).rows[0].duration_minutes).toBe(30);
  });

  it('creates one fixed invoice when concurrent readiness processing confirms running and terminal capability', async () => {
    const { vm } = await awardedVm();
    const { lifecycle, wick } = lifecycleContext({ id: 'test-environment', status: 'running', expiresAt: new Date(Date.now() + 1_800_000).toISOString() });
    await Promise.all(Array.from({ length: 8 }, () => provisionVm(lifecycle, vm.id)));
    await Promise.all(Array.from({ length: 4 }, () => markReady(lifecycle, vm.id)));
    expect(wick.create).toHaveBeenCalledTimes(1);
    const invoices = (await pool.query('SELECT * FROM broker_invoices WHERE vm_id=$1', [vm.id])).rows;
    expect(invoices).toHaveLength(1);
    expect(invoices[0].total_cents).toBe(200);
    expect(invoices[0].fee_cents).toBe(0);
    expect(invoices[0].status).toBe('demo');
    expect((await pool.query('SELECT status FROM broker_vms WHERE id=$1', [vm.id])).rows[0].status).toBe('running');
  });

  it('does not charge for running without terminal capability and never extends observed admission expiry', async () => {
    const { vm } = await awardedVm();
    const expiresAt = new Date(Date.now() + 1_800_000).toISOString();
    const { lifecycle, state } = lifecycleContext({ id: 'test-environment', status: 'running', expiresAt }, false);
    await provisionVm(lifecycle, vm.id);
    expect(Number((await pool.query('SELECT count(*) FROM broker_invoices')).rows[0].count)).toBe(0);
    expect((await pool.query('SELECT status FROM broker_vms WHERE id=$1', [vm.id])).rows[0].status).toBe('provisioning');
    state.terminal = true;
    state.environment.expiresAt = new Date(Date.now() + 3_600_000).toISOString();
    await provisionVm(lifecycle, vm.id);
    expect(Number((await pool.query('SELECT count(*) FROM broker_invoices')).rows[0].count)).toBe(1);
    expect((await pool.query('SELECT expires_at FROM broker_vms WHERE id=$1', [vm.id])).rows[0].expires_at.toISOString()).toBe(expiresAt);
  });

  it('keeps an expired-before-ready rental uncharged and reserved until cleanup confirmation', async () => {
    const { vm, bidId } = await awardedVm();
    const { lifecycle } = lifecycleContext({ id: 'test-environment', status: 'running', expiresAt: new Date(Date.now() - 1_000).toISOString() });
    await provisionVm(lifecycle, vm.id);
    expect(Number((await pool.query('SELECT count(*) FROM broker_invoices')).rows[0].count)).toBe(0);
    expect((await pool.query('SELECT status FROM broker_vms WHERE id=$1', [vm.id])).rows[0].status).toBe('expired');
    expect((await pool.query('SELECT released_at FROM broker_holds WHERE bid_id=$1', [bidId])).rows[0].released_at).toBeNull();
  });

  it('does not charge when upstream supplies no authoritative expiry', async () => {
    const { vm } = await awardedVm();
    const { lifecycle } = lifecycleContext({ id: 'test-environment', status: 'running', expiresAt: null });
    await provisionVm(lifecycle, vm.id);
    expect(Number((await pool.query('SELECT count(*) FROM broker_invoices')).rows[0].count)).toBe(0);
    const persisted = (await pool.query('SELECT status,expires_at FROM broker_vms WHERE id=$1', [vm.id])).rows[0];
    expect(persisted.status).toBe('provisioning');
    expect(persisted.expires_at).toBeNull();
  });

  it('reconciles an uncertain create with the same persisted idempotency key', async () => {
    const { vm, bidId } = await awardedVm();
    const { lifecycle, wick } = lifecycleContext({ id: 'test-environment', status: 'running', expiresAt: new Date(Date.now() + 1_800_000).toISOString() });
    vi.mocked(wick.create).mockRejectedValueOnce(new Error('Connection lost after submitting create'));
    await provisionVm(lifecycle, vm.id);
    expect(Number((await pool.query('SELECT count(*) FROM broker_invoices')).rows[0].count)).toBe(0);
    expect((await pool.query('SELECT released_at FROM broker_holds WHERE bid_id=$1', [bidId])).rows[0].released_at).toBeNull();
    await provisionVm(lifecycle, vm.id);
    expect(wick.create).toHaveBeenCalledTimes(2);
    const calls = vi.mocked(wick.create).mock.calls;
    expect(calls[0]?.[1]).toBe(vm.create_key);
    expect(calls[1]?.[1]).toBe(vm.create_key);
    expect(calls[0]?.[0]).toEqual(calls[1]?.[0]);
    expect(Number((await pool.query('SELECT count(*) FROM broker_vms')).rows[0].count)).toBe(1);
    expect(Number((await pool.query('SELECT count(*) FROM broker_invoices')).rows[0].count)).toBe(1);
  });

  it('retains the winner slot after termination acceptance and preserves the full ready charge', async () => {
    const { vm, bidId, buyerId } = await awardedVm();
    const { lifecycle, state, wick } = lifecycleContext({ id: 'test-environment', status: 'running', expiresAt: new Date(Date.now() + 1_800_000).toISOString() });
    await provisionVm(lifecycle, vm.id);
    await terminateVm(lifecycle, buyerId, vm.id);
    state.environment.status = 'terminating';
    await cleanupVm(lifecycle, vm.id);
    expect(wick.terminate).toHaveBeenCalledTimes(1);
    expect((await pool.query('SELECT cleanup_confirmed_at FROM broker_vms WHERE id=$1', [vm.id])).rows[0].cleanup_confirmed_at).toBeNull();
    expect((await pool.query('SELECT released_at FROM broker_holds WHERE bid_id=$1', [bidId])).rows[0].released_at).toBeNull();
    state.environment.status = 'terminated';
    await cleanupVm(lifecycle, vm.id);
    expect((await pool.query('SELECT cleanup_confirmed_at FROM broker_vms WHERE id=$1', [vm.id])).rows[0].cleanup_confirmed_at).not.toBeNull();
    expect((await pool.query('SELECT released_at FROM broker_holds WHERE bid_id=$1', [bidId])).rows[0].released_at).not.toBeNull();
    const invoices = (await pool.query('SELECT total_cents FROM broker_invoices WHERE vm_id=$1', [vm.id])).rows;
    expect(invoices).toEqual([{ total_cents: 200 }]);
  });

  it('owner cancellation racing a create response prevents a charge and remains cancelled', async () => {
    const { vm, buyerId, bidId, requestId } = await awardedVm();
    const { lifecycle, wick } = lifecycleContext({ id: 'test-environment', status: 'running', expiresAt: new Date(Date.now() + 1_800_000).toISOString() });
    let releaseCreate!: (value: { environment: WickEnvironment }) => void;
    let markEntered!: () => void;
    const entered = new Promise<void>(resolve => { markEntered = resolve; });
    const response = new Promise<{ environment: WickEnvironment }>(resolve => { releaseCreate = resolve; });
    vi.mocked(wick.create).mockImplementation(async () => { markEntered(); return response; });
    const provisioning = provisionVm(lifecycle, vm.id);
    await entered;
    expect(await terminateVm(lifecycle, randomUUID(), vm.id)).toBe(false);
    expect(await terminateVm(lifecycle, buyerId, vm.id)).toBe(true);
    releaseCreate({ environment: { id: 'test-environment', status: 'running', expiresAt: new Date(Date.now() + 1_800_000).toISOString() } });
    await provisioning;
    expect(Number((await pool.query('SELECT count(*) FROM broker_invoices')).rows[0].count)).toBe(0);
    expect((await pool.query('SELECT status FROM broker_requests WHERE id=$1', [requestId])).rows[0].status).toBe('cancelled');
    expect((await pool.query('SELECT released_at FROM broker_holds WHERE bid_id=$1', [bidId])).rows[0].released_at).toBeNull();
  });

  it('confirmed create rejection before admission releases the slot without an invoice', async () => {
    const { vm, bidId } = await awardedVm();
    const { lifecycle, wick } = lifecycleContext({ id: 'unused', status: 'running', expiresAt: null });
    vi.mocked(wick.create).mockRejectedValueOnce(Object.assign(new Error('Rejected before admission'), { admissionRejected: true }));
    await provisionVm(lifecycle, vm.id);
    expect(Number((await pool.query('SELECT count(*) FROM broker_invoices')).rows[0].count)).toBe(0);
    expect((await pool.query('SELECT status,cleanup_confirmed_at FROM broker_vms WHERE id=$1', [vm.id])).rows[0].status).toBe('failed');
    expect((await pool.query('SELECT released_at FROM broker_holds WHERE bid_id=$1', [bidId])).rows[0].released_at).not.toBeNull();
  });

  it('no offers ends the attempt without allocating or restarting an auction', async () => {
    const id = await request(true);
    await closeAuction(ctx, id);
    await closeAuction(ctx, id);
    expect((await pool.query('SELECT status FROM broker_requests WHERE id=$1', [id])).rows[0].status).toBe('no_offers');
    expect(Number((await pool.query('SELECT count(*) FROM broker_vms')).rows[0].count)).toBe(0);
    expect(Number((await pool.query(`SELECT count(*) FROM ${queueSchema}.job`)).rows[0].count)).toBe(0);
  });

  it('requires an exact catalog rental duration and rejects customer execution fields', async () => {
    const buyer: Actor = { id: randomUUID(), email: 'buyer@test.invalid', name: 'Test buyer', role: 'buyer' };
    await pool.query('UPDATE broker_catalog SET item=$2 WHERE id=$1', [catalog.id, { ...catalog, durationMinutes: [30] }]);
    const body = { description: 'Interactive environment', catalogId: catalog.id, region: catalog.region, durationMinutes: 30, maxPriceCents: 1000, requirements: { cpu: 2, memoryGb: 4 } };
    await expect(createRequest(ctx, buyer, { ...body, durationMinutes: 15 })).rejects.toThrow(/exact/i);
    await expect(createRequest(ctx, buyer, { ...body, maxPriceCents: 2.5 })).rejects.toThrow(/integer/i);
    await expect(createRequest(ctx, buyer, { ...body, command: 'run arbitrary customer workload' })).rejects.toThrow(/execution fields/i);
    expect(Number((await pool.query('SELECT count(*) FROM broker_requests')).rows[0].count)).toBe(0);
  });
});
