import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { PgBoss } from 'pg-boss';
import Fastify from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { migrate } from '../src/server/db.js';
import { loadConfig } from '../src/server/config.js';
import type { AppContext } from '../src/server/context.js';
import type { Actor, CatalogItem } from '../src/shared/types.js';
import { QUEUES, transaction } from '../src/server/marketplace/db.js';
import { revenueShare } from '../src/shared/pricing.js';
import {
  awardHeldBid,
  closeAuction,
  createRequest,
  submitBid,
} from '../src/server/marketplace/auction.js';
import {
  cleanupVm,
  markReady,
  provisionVm,
  terminateVm,
} from '../src/server/marketplace/lifecycle.js';
import type { WickAdapter, WickEnvironment } from '../src/server/integrations/types.js';
import { registerMarketplace, startMarketplaceWorkers } from '../src/server/marketplace/index.js';
import { getCatalog, syncCatalog } from '../src/server/marketplace/data.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
const schema = `broker_test_${randomUUID().replaceAll('-', '')}`;
const queueSchema = `${schema}_jobs`;
const catalog: CatalogItem = {
  id: 'test-small',
  name: 'Test Linux',
  description: 'Explicit test configuration',
  provider: 'test',
  profile: 'small',
  region: 'test-region',
  cpu: 2,
  memoryGb: 4,
  durationMinutes: [15, 30, 60],
  approved: true,
  organizationId: 'test-org',
  groupId: 'test-group',
};

describe.skipIf(!databaseUrl)('PostgreSQL marketplace concurrency and invariants', () => {
  let admin: Pool;
  let pool: Pool;
  let boss: PgBoss;
  let ctx: AppContext;

  beforeAll(async () => {
    admin = new Pool({ connectionString: databaseUrl });
    await admin.query(`CREATE SCHEMA ${schema}`);
    pool = new Pool({
      connectionString: databaseUrl,
      max: 12,
      options: `-c search_path=${schema},public`,
    });
    await migrate(pool);
    boss = new PgBoss({ connectionString: databaseUrl!, schema: queueSchema });
    await boss.start();
    for (const queue of Object.values(QUEUES)) await boss.createQueue(queue);
    ctx = {
      pool,
      boss,
      config: loadConfig({
        NODE_ENV: 'test',
        DATABASE_URL: databaseUrl!,
        BETTER_AUTH_SECRET: 'test-only-auth-secret-with-at-least-32-characters',
        WICK_MODE: 'fixture',
        MUSE_MODE: 'fixture',
        MAX_CONCURRENT_VMS: '2',
        WICK_ORGANIZATION_ID: 'test-org',
        WICK_GROUP_ID: 'test-group',
      }),
      // Domain tests never contact an external service or allocate real resources.
      wick: { mode: 'fixture', catalog: async () => [catalog] } as AppContext['wick'],
      muse: { mode: 'fixture' } as AppContext['muse'],
      requireActor: async () => {
        throw new Error('HTTP authentication is covered by browser tests.');
      },
    };
  }, 30_000);

  beforeEach(async () => {
    await pool.query(
      'TRUNCATE broker_activity, broker_invoices, broker_holds, broker_vms, broker_bids, broker_requests, broker_offerings, broker_providers, broker_catalog CASCADE',
    );
    await pool.query('INSERT INTO broker_catalog(id,item,approved) VALUES($1,$2,true)', [
      catalog.id,
      catalog,
    ]);
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
    const actor: Actor = {
      id: randomUUID(),
      email: `${providerId}@test.invalid`,
      name: 'Test supplier',
      role: 'provider',
      providerId,
    };
    await pool.query(
      'INSERT INTO broker_providers(id,user_id,name,total_capacity,policy) VALUES($1,$2,$3,$4,$5)',
      [
        providerId,
        actor.id,
        actor.name,
        capacity,
        {
          autoBid: false,
          minimumPriceCents: 50,
          basePriceCents: price,
          allowedCatalogIds: [catalog.id],
        },
      ],
    );
    const offeringId = randomUUID();
    await pool.query(
      'INSERT INTO broker_offerings(id,provider_id,catalog_id,name,description,price_cents) VALUES($1,$2,$3,$4,$5,$6)',
      [offeringId, providerId, catalog.id, 'Published test offering', 'Test only', price],
    );
    return { actor, providerId, offeringId };
  }

  async function request(
    closed = false,
    buyerId: string = randomUUID(),
    closingInterval = '60 seconds',
  ) {
    const id = randomUUID();
    await pool.query(
      `INSERT INTO broker_requests(id,buyer_id,description,catalog_id,catalog_snapshot,region,duration_minutes,max_price_cents,requirements,closes_at)
      VALUES($1,$2,'Test interactive environment',$3,$4,$5,30,1000,$6,clock_timestamp()+$7::interval)`,
      [
        id,
        buyerId,
        catalog.id,
        catalog,
        catalog.region,
        { cpu: 2, memoryGb: 4 },
        closed ? '-1 second' : closingInterval,
      ],
    );
    return id;
  }

  async function acceptedBid(
    requestId: string,
    supplier: Awaited<ReturnType<typeof provider>>,
    price: number,
    createdAt?: string,
    bidId: string = randomUUID(),
  ) {
    const offering = (
      await pool.query('SELECT * FROM broker_offerings WHERE id=$1', [supplier.offeringId])
    ).rows[0];
    await pool.query(
      `INSERT INTO broker_bids(id,request_id,provider_id,offering_id,offering_snapshot,total_price_cents,created_at)
      VALUES($1,$2,$3,$4,$5,$6,COALESCE($7::timestamptz,clock_timestamp()))`,
      [
        bidId,
        requestId,
        supplier.providerId,
        supplier.offeringId,
        offering,
        price,
        createdAt ?? null,
      ],
    );
    await pool.query('INSERT INTO broker_holds(bid_id,provider_id) VALUES($1,$2)', [
      bidId,
      supplier.providerId,
    ]);
    return bidId;
  }

  async function awardedVm() {
    const supplier = await provider();
    const buyerId = randomUUID();
    const requestId = await request(true, buyerId);
    const bidId = await acceptedBid(requestId, supplier, 200);
    await closeAuction(ctx, requestId);
    const vm = (await pool.query('SELECT * FROM broker_vms WHERE request_id=$1', [requestId]))
      .rows[0];
    return { vm, supplier, buyerId, bidId, requestId };
  }

  function lifecycleContext(environment: WickEnvironment, terminal = true) {
    const state = { environment, terminal };
    const wick: WickAdapter = {
      mode: 'fixture',
      catalog: async () => [catalog],
      preview: async () => ({}),
      create: vi.fn(async () => ({ environment: { ...state.environment } })),
      get: vi.fn(async () => ({ ...state.environment })),
      connections: vi.fn(async () => ({ terminal: state.terminal })),
      session: async () => {
        throw new Error('These tests never open terminal sessions.');
      },
      terminal: async () => {
        throw new Error('These tests never open terminal connections.');
      },
      terminate: vi.fn(async () => {}),
    };
    return { state, wick, lifecycle: { ...ctx, wick } };
  }

  function startupWithoutConsumers(lifecycle: AppContext): AppContext {
    // Exercise recovery SQL without starting a second polling loop in the test.
    // Queue sends still use the actual PostgreSQL queue and transaction owner.
    return {
      ...lifecycle,
      boss: {
        createQueue: vi.fn(async () => {}),
        work: vi.fn(async () => {}),
        unschedule: vi.fn(async () => {}),
        send: boss.send.bind(boss),
      } as unknown as PgBoss,
    };
  }

  it('overlapping startup preserves the active worker lease and defers a duplicate lifecycle job', async () => {
    const { vm } = await awardedVm();
    const { lifecycle, wick } = lifecycleContext({
      id: 'rolling-deploy-environment',
      status: 'running',
      expiresAt: new Date(Date.now() + 1_800_000).toISOString(),
    });
    let releaseCreate!: (value: { environment: WickEnvironment }) => void;
    let markEntered!: () => void;
    const entered = new Promise<void>((resolve) => {
      markEntered = resolve;
    });
    const response = new Promise<{ environment: WickEnvironment }>((resolve) => {
      releaseCreate = resolve;
    });
    vi.mocked(wick.create).mockImplementation(async () => {
      markEntered();
      return response;
    });
    const first = provisionVm(lifecycle, vm.id);
    await entered;
    try {
      const before = (
        await pool.query('SELECT lease_until,poll_attempts FROM broker_vms WHERE id=$1', [vm.id])
      ).rows[0];
      const overlapping = startupWithoutConsumers(lifecycle);
      await startMarketplaceWorkers(overlapping);
      expect(
        (await pool.query('SELECT lease_until,poll_attempts FROM broker_vms WHERE id=$1', [vm.id]))
          .rows[0],
      ).toEqual(before);
      await provisionVm(overlapping, vm.id);
      expect(
        (await pool.query('SELECT lease_until,poll_attempts FROM broker_vms WHERE id=$1', [vm.id]))
          .rows[0],
      ).toEqual(before);
      expect(before.poll_attempts).toBe(1);
      expect(wick.create).toHaveBeenCalledTimes(1);
      expect(
        Number(
          (
            await pool.query(
              `SELECT count(*) FROM ${queueSchema}.job WHERE name=$1 AND data->>'vmId'=$2 AND start_after>$3::timestamptz`,
              [QUEUES.provision, vm.id, before.lease_until],
            )
          ).rows[0].count,
        ),
      ).toBe(1);
    } finally {
      releaseCreate({
        environment: {
          id: 'rolling-deploy-environment',
          status: 'running',
          expiresAt: new Date(Date.now() + 1_800_000).toISOString(),
        },
      });
      await first;
    }
    expect(wick.create).toHaveBeenCalledTimes(1);
    expect(
      Number(
        (await pool.query('SELECT count(*) FROM broker_invoices WHERE vm_id=$1', [vm.id])).rows[0]
          .count,
      ),
    ).toBe(1);
  });

  it('startup recovers an expired lifecycle lease without changing the persisted create key', async () => {
    const { vm } = await awardedVm();
    const { lifecycle, wick } = lifecycleContext({
      id: 'expired-lease-environment',
      status: 'running',
      expiresAt: new Date(Date.now() + 1_800_000).toISOString(),
    });
    await pool.query("UPDATE broker_vms SET lease_until=now()-interval '1 second' WHERE id=$1", [
      vm.id,
    ]);
    const recovered = startupWithoutConsumers(lifecycle);
    await startMarketplaceWorkers(recovered);
    await provisionVm(recovered, vm.id);
    expect(wick.create).toHaveBeenCalledExactlyOnceWith(vm.create_input, vm.create_key);
    expect(
      (
        await pool.query('SELECT status,create_key,lease_until FROM broker_vms WHERE id=$1', [
          vm.id,
        ])
      ).rows[0],
    ).toEqual({ status: 'running', create_key: vm.create_key, lease_until: null });
    expect(
      Number(
        (await pool.query('SELECT count(*) FROM broker_invoices WHERE vm_id=$1', [vm.id])).rows[0]
          .count,
      ),
    ).toBe(1);
  });

  it('competing bids cannot reserve one supplier slot twice', async () => {
    const supplier = await provider(1);
    const requests = await Promise.all([request(), request()]);
    const outcomes = await Promise.allSettled(
      requests.map((id) =>
        submitBid(ctx, supplier.actor, id, {
          totalPriceCents: 200,
          offeringId: supplier.offeringId,
        }),
      ),
    );
    expect(outcomes.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(outcomes.filter((result) => result.status === 'rejected')).toHaveLength(1);
    expect(
      Number(
        (await pool.query('SELECT count(*) FROM broker_holds WHERE released_at IS NULL')).rows[0]
          .count,
      ),
    ).toBe(1);
    expect(Number((await pool.query('SELECT count(*) FROM broker_bids')).rows[0].count)).toBe(1);
  });

  it('concurrent duplicate submissions produce only one bid and reservation', async () => {
    const supplier = await provider(3);
    const id = await request();
    await Promise.allSettled(
      Array.from({ length: 8 }, () => submitBid(ctx, supplier.actor, id, { totalPriceCents: 200 })),
    );
    expect(
      Number(
        (await pool.query('SELECT count(*) FROM broker_bids WHERE request_id=$1', [id])).rows[0]
          .count,
      ),
    ).toBe(1);
    expect(
      Number(
        (await pool.query('SELECT count(*) FROM broker_holds WHERE released_at IS NULL')).rows[0]
          .count,
      ),
    ).toBe(1);
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
    const outcomes = await Promise.allSettled(
      Array.from({ length: 6 }, () => closeAuction(ctx, id)),
    );
    expect(outcomes.filter((result) => result.status === 'rejected')).toEqual([]);
    const stored = (await pool.query('SELECT * FROM broker_requests WHERE id=$1', [id])).rows[0];
    expect(stored.winning_bid_id).toBe(winningBid);
    expect(stored.status).toBe('provisioning');
    expect(
      Number(
        (await pool.query('SELECT count(*) FROM broker_vms WHERE request_id=$1', [id])).rows[0]
          .count,
      ),
    ).toBe(1);
    expect(
      (await pool.query('SELECT released_at FROM broker_holds WHERE bid_id=$1', [winningBid]))
        .rows[0].released_at,
    ).toBeNull();
    expect(
      (await pool.query('SELECT released_at FROM broker_holds WHERE bid_id=$1', [losingBid]))
        .rows[0].released_at,
    ).not.toBeNull();
    const jobs = await pool.query(
      `SELECT count(*) FROM ${queueSchema}.job WHERE name=$1 AND data->>'vmId'=(SELECT id::text FROM broker_vms WHERE request_id=$2)`,
      [QUEUES.provision, id],
    );
    expect(Number(jobs.rows[0].count)).toBe(1);
  });

  it('breaks equal-price ties by accepted timestamp and then identifier', async () => {
    const suppliers = await Promise.all([provider(), provider(), provider()]);
    const id = await request(true);
    const ids = [
      '00000000-0000-4000-8000-000000000002',
      '00000000-0000-4000-8000-000000000001',
      '00000000-0000-4000-8000-000000000000',
    ];
    await acceptedBid(id, suppliers[0]!, 200, '2026-01-01T00:00:00Z', ids[0]);
    await acceptedBid(id, suppliers[1]!, 200, '2026-01-01T00:00:00Z', ids[1]);
    await acceptedBid(id, suppliers[2]!, 200, '2026-01-01T00:00:01Z', ids[2]);
    await closeAuction(ctx, id);
    expect(
      (await pool.query('SELECT winning_bid_id FROM broker_requests WHERE id=$1', [id])).rows[0]
        .winning_bid_id,
    ).toBe(ids[1]);
  });

  it('rolls back the award and capacity changes when durable enqueue fails', async () => {
    const first = await provider();
    const second = await provider();
    const id = await request(true);
    await acceptedBid(id, first, 200);
    await acceptedBid(id, second, 300);
    const unavailableQueue = {
      ...ctx,
      boss: {
        send: async () => {
          throw new Error('Queue insert failed');
        },
      } as unknown as PgBoss,
    };
    await expect(closeAuction(unavailableQueue, id)).rejects.toThrow('Queue insert failed');
    expect(
      (await pool.query('SELECT status FROM broker_requests WHERE id=$1', [id])).rows[0].status,
    ).toBe('open');
    expect(Number((await pool.query('SELECT count(*) FROM broker_vms')).rows[0].count)).toBe(0);
    expect(
      Number(
        (await pool.query('SELECT count(*) FROM broker_holds WHERE released_at IS NULL')).rows[0]
          .count,
      ),
    ).toBe(2);
    expect(
      (await pool.query('SELECT DISTINCT status FROM broker_bids')).rows.map((row) => row.status),
    ).toEqual(['held']);
  });

  it('keeps an existing reservation eligible after supplier policy and offering changes', async () => {
    const supplier = await provider();
    const id = await request(true);
    const bidId = await acceptedBid(id, supplier, 200);
    await pool.query('UPDATE broker_providers SET total_capacity=0,policy=$2 WHERE id=$1', [
      supplier.providerId,
      { autoBid: false, minimumPriceCents: 9999, basePriceCents: 9999, allowedCatalogIds: [] },
    ]);
    await pool.query(
      'UPDATE broker_offerings SET price_cents=9999,revision=2,active=false WHERE id=$1',
      [supplier.offeringId],
    );
    await closeAuction(ctx, id);
    expect(
      (await pool.query('SELECT winning_bid_id FROM broker_requests WHERE id=$1', [id])).rows[0]
        .winning_bid_id,
    ).toBe(bidId);
    const vm = (await pool.query('SELECT * FROM broker_vms WHERE request_id=$1', [id])).rows[0];
    expect(JSON.stringify(vm.quote_snapshot)).toContain('200');
    expect(JSON.stringify(vm.quote_snapshot)).not.toContain('9999');
    expect(vm.create_key).toBeTruthy();
    expect(
      (await pool.query('SELECT released_at FROM broker_holds WHERE bid_id=$1', [bidId])).rows[0]
        .released_at,
    ).toBeNull();
  });

  it('limits concurrent actual VM admissions even when auctions close together', async () => {
    const supplier = await provider(3);
    const buyer = randomUUID();
    const requests = await Promise.all(Array.from({ length: 3 }, () => request(true, buyer)));
    for (const id of requests) await acceptedBid(id, supplier, 200);
    const outcomes = await Promise.allSettled(requests.map((id) => closeAuction(ctx, id)));
    expect(outcomes.filter((result) => result.status === 'rejected')).toEqual([]);
    expect(
      Number(
        (await pool.query('SELECT count(*) FROM broker_vms WHERE cleanup_confirmed_at IS NULL'))
          .rows[0].count,
      ),
    ).toBe(2);
    expect(
      Number(
        (await pool.query('SELECT count(*) FROM broker_holds WHERE released_at IS NULL')).rows[0]
          .count,
      ),
    ).toBe(2);
  });

  it('admits only 20 of 21 simultaneous auctions, invoices readiness once, and retains all holds until confirmed cleanup', async () => {
    const adminActor: Actor = {
      id: randomUUID(),
      email: 'scale-admin@test.invalid',
      name: 'Scale test administrator',
      role: 'admin',
    };
    const app = Fastify();
    await registerMarketplace(app, { ...ctx, requireActor: async () => adminActor });
    try {
      const configured = await app.inject({
        method: 'PUT',
        url: '/api/admin/config',
        payload: { maxConcurrentVms: 20 },
      });
      expect(configured.statusCode).toBe(200);
      expect(configured.json()).toEqual({ maxConcurrentVms: 20 });
    } finally {
      await app.close();
    }

    const supplier = await provider(21);
    const buyerId = randomUUID();
    const requestIds = await Promise.all(Array.from({ length: 21 }, () => request(true, buyerId)));
    await Promise.all(requestIds.map((id, index) => acceptedBid(id, supplier, 200 + index)));
    // The persisted administrator limit must override a lower environment default.
    const limited = { ...ctx, config: { ...ctx.config, maxConcurrentVms: 1 } };
    await Promise.all(requestIds.map((id) => closeAuction(limited, id)));
    const vms = (await pool.query('SELECT * FROM broker_vms ORDER BY id')).rows;
    expect(vms).toHaveLength(20);
    expect(new Set(vms.map((vm) => vm.create_key)).size).toBe(20);
    const rejected = (
      await pool.query("SELECT id,failure_reason FROM broker_requests WHERE status='failed'")
    ).rows;
    expect(rejected).toHaveLength(1);
    expect(rejected[0].failure_reason).toMatch(/concurrent VM limit/i);
    expect(Number((await pool.query('SELECT count(*) FROM broker_invoices')).rows[0].count)).toBe(
      0,
    );
    expect(
      Number(
        (await pool.query('SELECT count(*) FROM broker_holds WHERE released_at IS NULL')).rows[0]
          .count,
      ),
    ).toBe(20);
    expect(
      Number(
        (
          await pool.query(`SELECT count(*) FROM ${queueSchema}.job WHERE name=$1`, [
            QUEUES.provision,
          ])
        ).rows[0].count,
      ),
    ).toBe(20);

    const { lifecycle, state, wick } = lifecycleContext(
      { id: 'unused', status: 'running', expiresAt: null },
      false,
    );
    const environments = new Map<string, WickEnvironment>();
    vi.mocked(wick.create).mockImplementation(async (_input, key) => {
      const id = `offline-${key}`;
      const environment: WickEnvironment = {
        id,
        status: 'running',
        expiresAt: new Date(Date.now() + 900_000).toISOString(),
      };
      environments.set(id, environment);
      return { environment: { ...environment } };
    });
    vi.mocked(wick.get).mockImplementation(async (id) => {
      const environment = environments.get(id);
      if (!environment) throw new Error('Unknown offline environment');
      return { ...environment };
    });
    vi.mocked(wick.terminate).mockImplementation(async (id) => {
      const environment = environments.get(id);
      if (!environment) throw new Error('Unknown offline environment');
      environment.status = 'terminating';
    });

    await Promise.all(vms.map((vm) => provisionVm(lifecycle, vm.id)));
    expect(wick.create).toHaveBeenCalledTimes(20);
    expect(environments.size).toBe(20);
    expect(Number((await pool.query('SELECT count(*) FROM broker_invoices')).rows[0].count)).toBe(
      0,
    );

    state.terminal = true;
    await Promise.all(
      vms.flatMap((vm) => [provisionVm(lifecycle, vm.id), provisionVm(lifecycle, vm.id)]),
    );
    await Promise.all(vms.map((vm) => markReady(lifecycle, vm.id)));
    expect(wick.create).toHaveBeenCalledTimes(20);
    expect(
      Number(
        (await pool.query("SELECT count(*) FROM broker_vms WHERE status='running'")).rows[0].count,
      ),
    ).toBe(20);
    const invoices = (
      await pool.query(
        `SELECT i.vm_id,i.total_cents,i.fee_cents,i.status,v.quote_snapshot
         FROM broker_invoices i JOIN broker_vms v ON v.id=i.vm_id`,
      )
    ).rows;
    expect(invoices).toHaveLength(20);
    expect(new Set(invoices.map((invoice) => invoice.vm_id)).size).toBe(20);
    for (const invoice of invoices) {
      expect(invoice.total_cents).toBe(invoice.quote_snapshot.totalPriceCents);
      expect(invoice.fee_cents).toBe(0);
      expect(invoice.status).toBe('demo');
    }

    await Promise.all(vms.map((vm) => terminateVm(lifecycle, buyerId, vm.id)));
    await Promise.all(vms.map((vm) => cleanupVm(lifecycle, vm.id)));
    expect(wick.terminate).toHaveBeenCalledTimes(20);
    expect(
      Number(
        (await pool.query('SELECT count(*) FROM broker_vms WHERE cleanup_confirmed_at IS NULL'))
          .rows[0].count,
      ),
    ).toBe(20);
    expect(
      Number(
        (await pool.query('SELECT count(*) FROM broker_holds WHERE released_at IS NULL')).rows[0]
          .count,
      ),
    ).toBe(20);

    for (const environment of environments.values()) environment.status = 'terminated';
    await Promise.all(vms.map((vm) => cleanupVm(lifecycle, vm.id)));
    expect(
      Number(
        (await pool.query('SELECT count(*) FROM broker_vms WHERE cleanup_confirmed_at IS NULL'))
          .rows[0].count,
      ),
    ).toBe(0);
    expect(
      Number(
        (await pool.query('SELECT count(*) FROM broker_holds WHERE released_at IS NULL')).rows[0]
          .count,
      ),
    ).toBe(0);
    expect(Number((await pool.query('SELECT count(*) FROM broker_invoices')).rows[0].count)).toBe(
      20,
    );
    expect(wick.create).toHaveBeenCalledTimes(20);
  });

  it('rejects the 21st simultaneous manual reservation at supplier capacity 20, then accepts it with explicit spare capacity', async () => {
    const supplier = await provider(20);
    const requestIds = await Promise.all(Array.from({ length: 21 }, () => request()));
    const outcomes = await Promise.allSettled(
      requestIds.map((id) =>
        submitBid(ctx, supplier.actor, id, {
          totalPriceCents: 200,
          offeringId: supplier.offeringId,
        }),
      ),
    );
    expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(20);
    expect(outcomes.filter((outcome) => outcome.status === 'rejected')).toHaveLength(1);
    const rejectedIndex = outcomes.findIndex((outcome) => outcome.status === 'rejected');
    const rejected = outcomes[rejectedIndex];
    expect(rejected?.status === 'rejected' && rejected.reason.message).toMatch(/reserved/i);

    const app = Fastify();
    await registerMarketplace(app, { ...ctx, requireActor: async () => supplier.actor });
    try {
      expect(
        (await app.inject({ method: 'GET', url: '/api/provider/dashboard' })).json().capacity,
      ).toEqual({ total: 20, held: 20, free: 0, available: 0 });
      expect(
        (await app.inject({ method: 'PUT', url: '/api/provider/capacity', payload: { total: 21 } }))
          .statusCode,
      ).toBe(200);
      await submitBid(ctx, supplier.actor, requestIds[rejectedIndex]!, {
        totalPriceCents: 200,
        offeringId: supplier.offeringId,
      });
      expect(
        (await app.inject({ method: 'GET', url: '/api/provider/dashboard' })).json().capacity,
      ).toEqual({ total: 21, held: 21, free: 0, available: 0 });
    } finally {
      await app.close();
    }
    expect(Number((await pool.query('SELECT count(*) FROM broker_vms')).rows[0].count)).toBe(0);
    expect(Number((await pool.query('SELECT count(*) FROM broker_invoices')).rows[0].count)).toBe(
      0,
    );
  });

  it('cannot mutate an accepted environment specification in SQL', async () => {
    const id = await request();
    await expect(
      pool.query('UPDATE broker_requests SET duration_minutes=60 WHERE id=$1', [id]),
    ).rejects.toThrow(/immutable/i);
    expect(
      (await pool.query('SELECT duration_minutes FROM broker_requests WHERE id=$1', [id])).rows[0]
        .duration_minutes,
    ).toBe(30);
  });

  it('creates one fixed invoice when concurrent readiness processing confirms running and terminal capability', async () => {
    const { vm } = await awardedVm();
    const { lifecycle, wick } = lifecycleContext({
      id: 'test-environment',
      status: 'running',
      expiresAt: new Date(Date.now() + 1_800_000).toISOString(),
    });
    await Promise.all(Array.from({ length: 8 }, () => provisionVm(lifecycle, vm.id)));
    await Promise.all(Array.from({ length: 4 }, () => markReady(lifecycle, vm.id)));
    expect(wick.create).toHaveBeenCalledTimes(1);
    const invoices = (await pool.query('SELECT * FROM broker_invoices WHERE vm_id=$1', [vm.id]))
      .rows;
    expect(invoices).toHaveLength(1);
    expect(invoices[0].total_cents).toBe(200);
    expect(invoices[0].fee_cents).toBe(0);
    expect(invoices[0].status).toBe('demo');
    expect(invoices[0].revenue_share).toBeNull(); // A pre-commission binding bid stays historical.
    expect(vm.quote_snapshot).not.toHaveProperty('revenueShare');
    expect(
      (await pool.query('SELECT status FROM broker_vms WHERE id=$1', [vm.id])).rows[0].status,
    ).toBe('running');
  });

  it('freezes the exact provider share at binding bid and copies it once at concurrent readiness', async () => {
    const supplier = await provider();
    const requestId = await request();
    const accepted = await submitBid(ctx, supplier.actor, requestId, { totalPriceCents: 200 });
    const split = revenueShare(200);
    expect(accepted.revenueShare).toEqual(split);
    const { vmId } = await transaction(pool, async (db) => {
      const r = (
        await db.query('SELECT * FROM broker_requests WHERE id=$1 FOR UPDATE', [requestId])
      ).rows[0];
      await db.query('SELECT id FROM broker_providers WHERE id=$1 FOR UPDATE', [
        supplier.providerId,
      ]);
      const b = (await db.query('SELECT * FROM broker_bids WHERE id=$1', [accepted.id])).rows[0];
      return awardHeldBid(ctx, db, r, b);
    });
    const frozen = (await pool.query('SELECT quote_snapshot FROM broker_vms WHERE id=$1', [vmId]))
      .rows[0].quote_snapshot;
    expect(frozen.revenueShare).toEqual(split);
    const { lifecycle } = lifecycleContext({
      id: 'test-commission-environment',
      status: 'running',
      expiresAt: new Date(Date.now() + 1800000).toISOString(),
    });
    await Promise.all(Array.from({ length: 4 }, () => provisionVm(lifecycle, vmId)));
    await Promise.all(Array.from({ length: 4 }, () => markReady(lifecycle, vmId)));
    const invoices = (await pool.query('SELECT * FROM broker_invoices WHERE vm_id=$1', [vmId]))
      .rows;
    expect(invoices).toHaveLength(1);
    expect(invoices[0]).toMatchObject({
      subtotal_cents: 200,
      fee_cents: 0,
      total_cents: 200,
      revenue_share: split,
      status: 'demo',
    });
    expect(
      (await pool.query('SELECT quote_snapshot FROM broker_vms WHERE id=$1', [vmId])).rows[0]
        .quote_snapshot,
    ).toEqual(frozen);
  });

  it('does not charge for running without terminal capability and never extends observed admission expiry', async () => {
    const { vm } = await awardedVm();
    const expiresAt = new Date(Date.now() + 1_800_000).toISOString();
    const { lifecycle, state } = lifecycleContext(
      { id: 'test-environment', status: 'running', expiresAt },
      false,
    );
    await provisionVm(lifecycle, vm.id);
    expect(Number((await pool.query('SELECT count(*) FROM broker_invoices')).rows[0].count)).toBe(
      0,
    );
    expect(
      (await pool.query('SELECT status FROM broker_vms WHERE id=$1', [vm.id])).rows[0].status,
    ).toBe('provisioning');
    state.terminal = true;
    state.environment.expiresAt = new Date(Date.now() + 3_600_000).toISOString();
    await provisionVm(lifecycle, vm.id);
    expect(Number((await pool.query('SELECT count(*) FROM broker_invoices')).rows[0].count)).toBe(
      1,
    );
    expect(
      (
        await pool.query('SELECT expires_at FROM broker_vms WHERE id=$1', [vm.id])
      ).rows[0].expires_at.toISOString(),
    ).toBe(expiresAt);
  });

  it('keeps an expired-before-ready rental uncharged and reserved until cleanup confirmation', async () => {
    const { vm, bidId } = await awardedVm();
    const { lifecycle } = lifecycleContext({
      id: 'test-environment',
      status: 'running',
      expiresAt: new Date(Date.now() - 1_000).toISOString(),
    });
    await provisionVm(lifecycle, vm.id);
    expect(Number((await pool.query('SELECT count(*) FROM broker_invoices')).rows[0].count)).toBe(
      0,
    );
    expect(
      (await pool.query('SELECT status FROM broker_vms WHERE id=$1', [vm.id])).rows[0].status,
    ).toBe('expired');
    expect(
      (await pool.query('SELECT released_at FROM broker_holds WHERE bid_id=$1', [bidId])).rows[0]
        .released_at,
    ).toBeNull();
  });

  it('does not charge when upstream supplies no authoritative expiry', async () => {
    const { vm } = await awardedVm();
    const { lifecycle } = lifecycleContext({
      id: 'test-environment',
      status: 'running',
      expiresAt: null,
    });
    await provisionVm(lifecycle, vm.id);
    expect(Number((await pool.query('SELECT count(*) FROM broker_invoices')).rows[0].count)).toBe(
      0,
    );
    const persisted = (
      await pool.query('SELECT status,expires_at FROM broker_vms WHERE id=$1', [vm.id])
    ).rows[0];
    expect(persisted.status).toBe('provisioning');
    expect(persisted.expires_at).toBeNull();
  });

  it('reconciles an uncertain create with the same persisted idempotency key', async () => {
    const { vm, bidId } = await awardedVm();
    const { lifecycle, wick } = lifecycleContext({
      id: 'test-environment',
      status: 'running',
      expiresAt: new Date(Date.now() + 1_800_000).toISOString(),
    });
    vi.mocked(wick.create).mockRejectedValueOnce(
      new Error('Connection lost after submitting create'),
    );
    await provisionVm(lifecycle, vm.id);
    expect(Number((await pool.query('SELECT count(*) FROM broker_invoices')).rows[0].count)).toBe(
      0,
    );
    expect(
      (await pool.query('SELECT released_at FROM broker_holds WHERE bid_id=$1', [bidId])).rows[0]
        .released_at,
    ).toBeNull();
    await provisionVm(lifecycle, vm.id);
    expect(wick.create).toHaveBeenCalledTimes(2);
    const calls = vi.mocked(wick.create).mock.calls;
    expect(calls[0]?.[1]).toBe(vm.create_key);
    expect(calls[1]?.[1]).toBe(vm.create_key);
    expect(calls[0]?.[0]).toEqual(calls[1]?.[0]);
    expect(Number((await pool.query('SELECT count(*) FROM broker_vms')).rows[0].count)).toBe(1);
    expect(Number((await pool.query('SELECT count(*) FROM broker_invoices')).rows[0].count)).toBe(
      1,
    );
  });

  it('never creates during cleanup when admission is unknown and keeps its hold', async () => {
    const { vm, bidId, buyerId } = await awardedVm();
    const { lifecycle, wick } = lifecycleContext({
      id: 'uncertain',
      status: 'running',
      expiresAt: new Date(Date.now() + 900000).toISOString(),
    });
    vi.mocked(wick.create).mockRejectedValueOnce(new Error('Transport outcome unknown'));
    wick.list = vi.fn(async () => ({ items: [] }));
    await provisionVm(lifecycle, vm.id);
    await terminateVm(lifecycle, buyerId, vm.id);
    await cleanupVm(lifecycle, vm.id);
    expect(wick.create).toHaveBeenCalledTimes(1);
    expect(wick.terminate).not.toHaveBeenCalled();
    expect(wick.list).toHaveBeenCalledTimes(2);
    const row = (
      await pool.query('SELECT cleanup_confirmed_at,failure_reason FROM broker_vms WHERE id=$1', [
        vm.id,
      ])
    ).rows[0];
    expect(row.cleanup_confirmed_at).toBeNull();
    expect(row.failure_reason).toContain('UNKNOWN');
    expect(
      (await pool.query('SELECT released_at FROM broker_holds WHERE bid_id=$1', [bidId])).rows[0]
        .released_at,
    ).toBeNull();
  });

  it('discovers exact owned environment after a missing create response without replaying create', async () => {
    const { vm, buyerId, bidId } = await awardedVm();
    const environment = {
      id: 'discovered-exact',
      status: 'running' as const,
      expiresAt: new Date(Date.now() + 900000).toISOString(),
      createdAt: new Date().toISOString(),
      ...vm.create_input,
    };
    const { lifecycle, wick, state } = lifecycleContext(environment);
    vi.mocked(wick.create).mockRejectedValueOnce(new Error('Response lost'));
    wick.list = vi.fn(async () => ({
      items: [{ ...environment, id: 'foreign', groupId: 'wrong' }, environment],
    }));
    vi.mocked(wick.terminate).mockImplementation(async () => {
      state.environment.status = 'terminated';
    });
    await provisionVm(lifecycle, vm.id);
    await terminateVm(lifecycle, buyerId, vm.id);
    await cleanupVm(lifecycle, vm.id);
    expect(wick.create).toHaveBeenCalledTimes(1);
    expect(wick.terminate).toHaveBeenCalledExactlyOnceWith('discovered-exact');
    expect(
      (await pool.query('SELECT released_at FROM broker_holds WHERE bid_id=$1', [bidId])).rows[0]
        .released_at,
    ).not.toBeNull();
  });

  it.each(['byok', 'missing', 'provider-key', 'wrong-scope'])(
    'quarantines %s real billing without issuing an invoice',
    async (failure) => {
      const { vm } = await awardedVm();
      await pool.query(
        'UPDATE broker_vms SET catalog_snapshot=catalog_snapshot || \'{"sourceMode":"real"}\'::jsonb WHERE id=$1',
        [vm.id],
      );
      const environment: WickEnvironment = {
        id: 'real-billing-fixture',
        status: 'running',
        expiresAt: new Date(Date.now() + 900000).toISOString(),
        ...vm.create_input,
        billingMode: 'wick_managed',
        createdAt: new Date().toISOString(),
      };
      if (failure === 'byok') environment.billingMode = 'byok';
      if (failure === 'missing') delete environment.billingMode;
      if (failure === 'provider-key') environment.providerKeyId = 'unapproved';
      if (failure === 'wrong-scope') environment.groupId = 'different-group';
      const { lifecycle, wick, state } = lifecycleContext(environment);
      wick.mode = 'real';
      await provisionVm(lifecycle, vm.id);
      expect(
        (await pool.query('SELECT status,failure_reason FROM broker_vms WHERE id=$1', [vm.id]))
          .rows[0],
      ).toMatchObject(
        failure === 'wrong-scope'
          ? { status: 'provisioning', failure_reason: expect.stringContaining('ownership') }
          : { status: 'terminating', failure_reason: expect.stringContaining('billing scope') },
      );
      expect((await pool.query('SELECT count(*)::int AS n FROM broker_invoices')).rows[0].n).toBe(
        0,
      );
      if (failure === 'wrong-scope') {
        expect(
          (await pool.query('SELECT environment_id FROM broker_vms WHERE id=$1', [vm.id])).rows[0]
            .environment_id,
        ).toBeNull();
        wick.list = vi.fn(async () => ({ items: [] }));
        await terminateVm(lifecycle, vm.buyer_id, vm.id);
        await cleanupVm(lifecycle, vm.id);
        expect(wick.terminate).not.toHaveBeenCalled();
      } else {
        vi.mocked(wick.terminate).mockImplementation(async () => {
          state.environment.status = 'terminated';
        });
        await cleanupVm(lifecycle, vm.id);
        expect(wick.terminate).toHaveBeenCalledExactlyOnceWith(environment.id);
      }
    },
  );

  it('waits for pending billing metadata and verifies managed billing before readiness', async () => {
    const { vm } = await awardedVm();
    await pool.query(
      'UPDATE broker_vms SET catalog_snapshot=catalog_snapshot || \'{"sourceMode":"real"}\'::jsonb WHERE id=$1',
      [vm.id],
    );
    const environment: WickEnvironment = {
      ...vm.create_input,
      id: 'pending-billing',
      status: 'provisioning',
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 900000).toISOString(),
    };
    const { lifecycle, wick, state } = lifecycleContext(environment);
    wick.mode = 'real';
    await provisionVm(lifecycle, vm.id);
    expect(
      (await pool.query('SELECT status FROM broker_vms WHERE id=$1', [vm.id])).rows[0].status,
    ).toBe('provisioning');
    expect((await pool.query('SELECT count(*)::int AS n FROM broker_invoices')).rows[0].n).toBe(0);
    state.environment.status = 'running';
    state.environment.billingMode = 'wick_managed';
    await provisionVm(lifecycle, vm.id);
    expect((await pool.query('SELECT count(*)::int AS n FROM broker_invoices')).rows[0].n).toBe(1);
  });

  it('charges real rentals only after matching managed billing observation and terminal readiness', async () => {
    const { vm } = await awardedVm();
    await pool.query(
      'UPDATE broker_vms SET catalog_snapshot=catalog_snapshot || \'{"sourceMode":"real"}\'::jsonb WHERE id=$1',
      [vm.id],
    );
    const environment: WickEnvironment = {
      id: 'managed-billing-fixture',
      status: 'running',
      expiresAt: new Date(Date.now() + 900000).toISOString(),
      ...vm.create_input,
      billingMode: 'wick_managed',
      createdAt: new Date().toISOString(),
    };
    const { lifecycle, wick } = lifecycleContext(environment);
    wick.mode = 'real';
    expect(await markReady(lifecycle, vm.id)).toBe(false);
    await pool.query('UPDATE broker_vms SET environment_id=$2,expires_at=$3 WHERE id=$1', [
      vm.id,
      environment.id,
      environment.expiresAt,
    ]);
    for (const invalid of [
      { ...environment, id: 'foreign-id' },
      { ...environment, status: 'provisioning' as const },
      { ...environment, expiresAt: 'invalid' },
      { ...environment, name: 'wrong-name' },
    ])
      expect(await markReady(lifecycle, vm.id, invalid, true)).toBe(false);
    expect(await markReady(lifecycle, vm.id, environment, false)).toBe(false);
    await provisionVm(lifecycle, vm.id);
    expect((await pool.query('SELECT count(*)::int AS n FROM broker_invoices')).rows[0].n).toBe(1);
  });

  it('retains the winner slot after termination acceptance and preserves the full ready charge', async () => {
    const { vm, bidId, buyerId } = await awardedVm();
    const { lifecycle, state, wick } = lifecycleContext({
      id: 'test-environment',
      status: 'running',
      expiresAt: new Date(Date.now() + 1_800_000).toISOString(),
    });
    await provisionVm(lifecycle, vm.id);
    await terminateVm(lifecycle, buyerId, vm.id);
    state.environment.status = 'terminating';
    await cleanupVm(lifecycle, vm.id);
    expect(wick.terminate).toHaveBeenCalledTimes(1);
    expect(
      (await pool.query('SELECT cleanup_confirmed_at FROM broker_vms WHERE id=$1', [vm.id])).rows[0]
        .cleanup_confirmed_at,
    ).toBeNull();
    expect(
      (await pool.query('SELECT released_at FROM broker_holds WHERE bid_id=$1', [bidId])).rows[0]
        .released_at,
    ).toBeNull();
    state.environment.status = 'terminated';
    await cleanupVm(lifecycle, vm.id);
    expect(
      (await pool.query('SELECT cleanup_confirmed_at FROM broker_vms WHERE id=$1', [vm.id])).rows[0]
        .cleanup_confirmed_at,
    ).not.toBeNull();
    expect(
      (await pool.query('SELECT released_at FROM broker_holds WHERE bid_id=$1', [bidId])).rows[0]
        .released_at,
    ).not.toBeNull();
    const invoices = (
      await pool.query('SELECT total_cents FROM broker_invoices WHERE vm_id=$1', [vm.id])
    ).rows;
    expect(invoices).toEqual([{ total_cents: 200 }]);
  });

  it('owner cancellation racing a create response prevents a charge and remains cancelled', async () => {
    const { vm, buyerId, bidId, requestId } = await awardedVm();
    const { lifecycle, wick } = lifecycleContext({
      id: 'test-environment',
      status: 'running',
      expiresAt: new Date(Date.now() + 1_800_000).toISOString(),
    });
    let releaseCreate!: (value: { environment: WickEnvironment }) => void;
    let markEntered!: () => void;
    const entered = new Promise<void>((resolve) => {
      markEntered = resolve;
    });
    const response = new Promise<{ environment: WickEnvironment }>((resolve) => {
      releaseCreate = resolve;
    });
    vi.mocked(wick.create).mockImplementation(async () => {
      markEntered();
      return response;
    });
    const provisioning = provisionVm(lifecycle, vm.id);
    await entered;
    expect(await terminateVm(lifecycle, randomUUID(), vm.id)).toBe(false);
    expect(await terminateVm(lifecycle, buyerId, vm.id)).toBe(true);
    releaseCreate({
      environment: {
        id: 'test-environment',
        status: 'running',
        expiresAt: new Date(Date.now() + 1_800_000).toISOString(),
      },
    });
    await provisioning;
    expect(Number((await pool.query('SELECT count(*) FROM broker_invoices')).rows[0].count)).toBe(
      0,
    );
    expect(
      (await pool.query('SELECT status FROM broker_requests WHERE id=$1', [requestId])).rows[0]
        .status,
    ).toBe('cancelled');
    expect(
      (await pool.query('SELECT released_at FROM broker_holds WHERE bid_id=$1', [bidId])).rows[0]
        .released_at,
    ).toBeNull();
  });

  it('confirmed create rejection before admission releases the slot without an invoice', async () => {
    const { vm, bidId } = await awardedVm();
    const { lifecycle, wick } = lifecycleContext({
      id: 'unused',
      status: 'running',
      expiresAt: null,
    });
    vi.mocked(wick.create).mockRejectedValueOnce(
      Object.assign(new Error('Rejected before admission'), { admissionRejected: true }),
    );
    await provisionVm(lifecycle, vm.id);
    expect(Number((await pool.query('SELECT count(*) FROM broker_invoices')).rows[0].count)).toBe(
      0,
    );
    expect(
      (await pool.query('SELECT status,cleanup_confirmed_at FROM broker_vms WHERE id=$1', [vm.id]))
        .rows[0].status,
    ).toBe('failed');
    expect(
      (await pool.query('SELECT released_at FROM broker_holds WHERE bid_id=$1', [bidId])).rows[0]
        .released_at,
    ).not.toBeNull();
  });

  it('no offers ends the attempt without allocating or restarting an auction', async () => {
    const id = await request(true);
    await closeAuction(ctx, id);
    await closeAuction(ctx, id);
    expect(
      (await pool.query('SELECT status FROM broker_requests WHERE id=$1', [id])).rows[0].status,
    ).toBe('no_offers');
    expect(Number((await pool.query('SELECT count(*) FROM broker_vms')).rows[0].count)).toBe(0);
    expect(
      Number((await pool.query(`SELECT count(*) FROM ${queueSchema}.job`)).rows[0].count),
    ).toBe(0);
  });

  it('requires an exact catalog rental duration and rejects customer execution fields', async () => {
    const buyer: Actor = {
      id: randomUUID(),
      email: 'buyer@test.invalid',
      name: 'Test buyer',
      role: 'buyer',
    };
    await pool.query('UPDATE broker_catalog SET item=$2 WHERE id=$1', [
      catalog.id,
      { ...catalog, durationMinutes: [30] },
    ]);
    const body = {
      description: 'Interactive environment',
      catalogId: catalog.id,
      region: catalog.region,
      durationMinutes: 30,
      maxPriceCents: 1000,
      requirements: { cpu: 2, memoryGb: 4 },
    };
    await expect(createRequest(ctx, buyer, { ...body, durationMinutes: 15 })).rejects.toThrow(
      /exact/i,
    );
    await expect(createRequest(ctx, buyer, { ...body, maxPriceCents: 2.005 })).rejects.toThrow(
      /decimal/i,
    );
    await expect(
      createRequest(ctx, buyer, { ...body, command: 'run arbitrary customer workload' }),
    ).rejects.toThrow(/execution fields/i);
    expect(Number((await pool.query('SELECT count(*) FROM broker_requests')).rows[0].count)).toBe(
      0,
    );
  });

  it('rejects bids whose deadline passes while waiting for the supplier capacity lock', async () => {
    const supplier = await provider();
    const id = await request(false, randomUUID(), '1 second');
    const lock = await pool.connect();
    await lock.query('BEGIN');
    await lock.query('SELECT id FROM broker_providers WHERE id=$1 FOR UPDATE', [
      supplier.providerId,
    ]);
    const submission = Promise.allSettled([
      submitBid(ctx, supplier.actor, id, { totalPriceCents: 200 }),
    ]);
    try {
      await new Promise((resolve) => setTimeout(resolve, 1100));
      await lock.query('COMMIT');
    } finally {
      await lock.query('ROLLBACK');
      lock.release();
    }
    const outcomes = await submission;
    expect(outcomes[0]?.status).toBe('rejected');
    expect(Number((await pool.query('SELECT count(*) FROM broker_holds')).rows[0].count)).toBe(0);
  });

  it('scopes request, VM, invoice, cancellation and retry HTTP queries to their buyer owner', async () => {
    const { vm, requestId } = await awardedVm();
    const otherBuyer: Actor = {
      id: randomUUID(),
      email: 'other-buyer@test.invalid',
      name: 'Other buyer',
      role: 'buyer',
    };
    const app = Fastify();
    await registerMarketplace(app, { ...ctx, requireActor: async () => otherBuyer });
    try {
      for (const url of [`/api/requests/${requestId}`, `/api/vms/${vm.id}`])
        expect((await app.inject({ method: 'GET', url })).statusCode).toBe(404);
      for (const url of [
        `/api/requests/${requestId}/cancel`,
        `/api/requests/${requestId}/retry`,
        `/api/vms/${vm.id}/terminate`,
      ])
        expect((await app.inject({ method: 'POST', url })).statusCode).toBe(404);
      for (const url of ['/api/requests', '/api/vms', '/api/invoices'])
        expect((await app.inject({ method: 'GET', url })).json().items).toEqual([]);
      expect(
        (await pool.query('SELECT status FROM broker_vms WHERE id=$1', [vm.id])).rows[0].status,
      ).toBe('provisioning');
    } finally {
      await app.close();
    }
  });

  it('paginates records with identical timestamps without dropping or repeating them', async () => {
    const buyer: Actor = {
      id: randomUUID(),
      email: 'page-buyer@test.invalid',
      name: 'Pagination buyer',
      role: 'buyer',
    };
    const inserted = await pool.query(
      `INSERT INTO broker_requests(buyer_id,description,catalog_id,catalog_snapshot,region,duration_minutes,max_price_cents,requirements)
      SELECT $1,'Same-time request',$2,$3,$4,30,1000,$5 FROM generate_series(1,5) RETURNING id`,
      [buyer.id, catalog.id, catalog, catalog.region, { cpu: 2, memoryGb: 4 }],
    );
    const app = Fastify();
    await registerMarketplace(app, { ...ctx, requireActor: async () => buyer });
    try {
      const ids: string[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < 3; page++) {
        const response = await app.inject({
          method: 'GET',
          url: `/api/requests?limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
        });
        expect(response.statusCode).toBe(200);
        const result = response.json();
        ids.push(...result.items.map((item: { id: string }) => item.id));
        cursor = result.nextCursor;
      }
      expect(cursor).toBeUndefined();
      expect(ids.sort()).toEqual(inserted.rows.map((row) => row.id).sort());
    } finally {
      await app.close();
    }
  });

  it('cancellation before the first provisioning attempt releases the slot without creating an environment', async () => {
    const { vm, buyerId, bidId } = await awardedVm();
    const { lifecycle, wick } = lifecycleContext({
      id: 'must-not-be-created',
      status: 'running',
      expiresAt: null,
    });
    await terminateVm(lifecycle, buyerId, vm.id);
    await cleanupVm(lifecycle, vm.id);
    expect(wick.create).not.toHaveBeenCalled();
    expect(wick.terminate).not.toHaveBeenCalled();
    expect(
      (await pool.query('SELECT released_at FROM broker_holds WHERE bid_id=$1', [bidId])).rows[0]
        .released_at,
    ).not.toBeNull();
    expect(Number((await pool.query('SELECT count(*) FROM broker_invoices')).rows[0].count)).toBe(
      0,
    );
  });

  it('cannot observe or charge a real rental through a fixture adapter after a mode switch', async () => {
    const { vm, bidId } = await awardedVm();
    await pool.query(
      `UPDATE broker_vms SET catalog_snapshot=jsonb_set(catalog_snapshot,'{sourceMode}','"real"'),environment_id='real-environment',expires_at=now()+interval '30 minutes' WHERE id=$1`,
      [vm.id],
    );
    const { lifecycle, wick } = lifecycleContext({
      id: 'real-environment',
      status: 'running',
      expiresAt: new Date(Date.now() + 1_800_000).toISOString(),
    });
    await provisionVm(lifecycle, vm.id);
    await cleanupVm(lifecycle, vm.id);
    expect(await markReady(lifecycle, vm.id)).toBe(false);
    expect(wick.create).not.toHaveBeenCalled();
    expect(wick.get).not.toHaveBeenCalled();
    expect(wick.terminate).not.toHaveBeenCalled();
    expect(Number((await pool.query('SELECT count(*) FROM broker_invoices')).rows[0].count)).toBe(
      0,
    );
    expect(
      (await pool.query('SELECT released_at FROM broker_holds WHERE bid_id=$1', [bidId])).rows[0]
        .released_at,
    ).toBeNull();
  });

  it('cannot allocate or terminate a legacy fixture rental through the real adapter after a mode switch', async () => {
    const { vm, bidId } = await awardedVm();
    const { lifecycle, wick } = lifecycleContext({
      id: 'must-not-be-created',
      status: 'running',
      expiresAt: new Date(Date.now() + 1_800_000).toISOString(),
    });
    wick.mode = 'real';
    await provisionVm(lifecycle, vm.id);
    await cleanupVm(lifecycle, vm.id);
    expect(await markReady(lifecycle, vm.id)).toBe(false);
    expect(wick.create).not.toHaveBeenCalled();
    expect(wick.get).not.toHaveBeenCalled();
    expect(wick.connections).not.toHaveBeenCalled();
    expect(wick.terminate).not.toHaveBeenCalled();
    expect(
      (
        await pool.query(
          'SELECT status,environment_id,poll_attempts,cleanup_attempts,lease_until FROM broker_vms WHERE id=$1',
          [vm.id],
        )
      ).rows[0],
    ).toEqual({
      status: 'provisioning',
      environment_id: null,
      poll_attempts: 0,
      cleanup_attempts: 0,
      lease_until: null,
    });
    expect(Number((await pool.query('SELECT count(*) FROM broker_invoices')).rows[0].count)).toBe(
      0,
    );
    expect(
      (await pool.query('SELECT released_at FROM broker_holds WHERE bid_id=$1', [bidId])).rows[0]
        .released_at,
    ).toBeNull();
  });

  it('releases unawarded fixture bids after a real-mode switch without admitting or invoicing a VM', async () => {
    const supplier = await provider();
    const requestId = await request(true);
    const bidId = await acceptedBid(requestId, supplier, 200);
    const real = { ...ctx, wick: { ...ctx.wick, mode: 'real' as const } };
    await closeAuction(real, requestId);
    const stored = (
      await pool.query('SELECT status,failure_reason FROM broker_requests WHERE id=$1', [requestId])
    ).rows[0];
    expect(stored.status).toBe('failed');
    expect(stored.failure_reason).toMatch(/integration mode changed/i);
    expect(
      (await pool.query('SELECT status FROM broker_bids WHERE id=$1', [bidId])).rows[0].status,
    ).toBe('lost');
    expect(
      (await pool.query('SELECT released_at FROM broker_holds WHERE bid_id=$1', [bidId])).rows[0]
        .released_at,
    ).not.toBeNull();
    expect(Number((await pool.query('SELECT count(*) FROM broker_vms')).rows[0].count)).toBe(0);
    expect(Number((await pool.query('SELECT count(*) FROM broker_invoices')).rows[0].count)).toBe(
      0,
    );
  });

  it('excludes previously stored Boat real configurations without changing historical rows', async () => {
    const oldBoat = { ...catalog, id: 'old-boat', provider: 'boat' };
    await pool.query(
      "INSERT INTO broker_catalog(id,item,approved,source_mode) VALUES($1,$2,true,'real')",
      [oldBoat.id, oldBoat],
    );
    const real = { ...ctx, wick: { ...ctx.wick, mode: 'real' as const } };
    expect(await getCatalog(real)).toEqual([]);
    expect(
      (await pool.query('SELECT item,approved FROM broker_catalog WHERE id=$1', [oldBoat.id]))
        .rows[0],
    ).toEqual({ item: oldBoat, approved: true });
    expect(await getCatalog(ctx)).toHaveLength(1);
  });

  it('removes approval from vanished catalog items and excludes fixture configurations in real mode', async () => {
    const real = { ...ctx, wick: { ...ctx.wick, mode: 'real' as const } };
    expect(await getCatalog(real)).toEqual([]);
    const buyer: Actor = {
      id: randomUUID(),
      email: 'mode-buyer@test.invalid',
      name: 'Mode buyer',
      role: 'buyer',
    };
    await expect(
      createRequest(real, buyer, {
        description: 'Must not allocate fixture ID',
        catalogId: catalog.id,
        region: catalog.region,
        durationMinutes: 30,
        maxPriceCents: 1000,
        requirements: { cpu: 2, memoryGb: 4 },
      }),
    ).rejects.toThrow(/approved/i);
    await syncCatalog({ ...ctx, wick: { ...ctx.wick, catalog: async () => [] } });
    expect(
      (await pool.query('SELECT approved FROM broker_catalog WHERE id=$1', [catalog.id])).rows[0]
        .approved,
    ).toBe(false);
  });

  it('uses the configured concurrency limit when no administrator override exists', async () => {
    await pool.query("DELETE FROM broker_settings WHERE key='maxConcurrentVms'");
    const limited = { ...ctx, config: { ...ctx.config, maxConcurrentVms: 1 } };
    const supplier = await provider(2);
    const requests = await Promise.all([request(true), request(true)]);
    for (const id of requests) await acceptedBid(id, supplier, 200);
    const outcomes = await Promise.allSettled(requests.map((id) => closeAuction(limited, id)));
    expect(outcomes.filter((result) => result.status === 'rejected')).toEqual([]);
    expect(Number((await pool.query('SELECT count(*) FROM broker_vms')).rows[0].count)).toBe(1);
    expect(
      Number(
        (await pool.query('SELECT count(*) FROM broker_holds WHERE released_at IS NULL')).rows[0]
          .count,
      ),
    ).toBe(1);
  });
});
