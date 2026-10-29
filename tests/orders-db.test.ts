import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { migrate } from '../src/server/db.js';
import { HttpError, type AppContext } from '../src/server/context.js';
import { listOrders, orderFilters, ORDERS_QUERY, registerOrders } from '../src/server/orders.js';
import { registerAgreementBilling } from '../src/server/agreement-billing.js';
import { revenueShare } from '../src/shared/pricing.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
const schema = `orders_${randomUUID().replaceAll('-', '')}`;
const buyer = 'orders-buyer',
  otherBuyer = 'another-buyer';
describe.skipIf(!databaseUrl)('persistent Orders history (real PostgreSQL)', () => {
  let pool: Pool, admin: Pool, ctx: AppContext, providerId: string, offeringId: string;
  beforeAll(async () => {
    admin = new Pool({ connectionString: databaseUrl });
    await admin.query(`CREATE SCHEMA ${schema}`);
    pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema},public` });
    await migrate(pool);
    ctx = { pool } as AppContext;
  });
  beforeEach(async () => {
    await pool.query(
      'TRUNCATE broker_catalog,broker_providers,broker_agreements,broker_credit_wallets CASCADE',
    );
    await pool.query(`INSERT INTO broker_catalog(id,item,approved) VALUES('orders-test',$1,true)`, [
      {
        id: 'orders-test',
        name: 'Test environment',
        provider: 'simulated-demo',
        profile: 'small',
        region: 'test',
        cpu: 2,
        memoryGb: 4,
        durationMinutes: [15, 30, 60],
        approved: true,
      },
    ]);
    providerId = (
      await pool.query(
        `INSERT INTO broker_providers(user_id,name,total_capacity,policy) VALUES('orders-provider','Supplier',20,'{}') RETURNING id`,
      )
    ).rows[0].id;
    offeringId = (
      await pool.query(
        `INSERT INTO broker_offerings(provider_id,catalog_id,name,description,price_cents) VALUES($1,'orders-test','Test','Test',5) RETURNING id`,
        [providerId],
      )
    ).rows[0].id;
  });
  afterAll(async () => {
    await pool?.end();
    if (admin) {
      await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await admin.end();
    }
  });
  async function request(
    status = 'open',
    options: { at?: string; owner?: string; vm?: string; cleaned?: boolean } = {},
  ) {
    const id = randomUUID();
    await pool.query(
      `INSERT INTO broker_requests(id,buyer_id,description,catalog_id,catalog_snapshot,region,duration_minutes,max_price_cents,requirements,status,created_at)
      VALUES($1,$2,$3,'orders-test','{}','test',30,10,'{}',$4,COALESCE($5::timestamptz,clock_timestamp()))`,
      [id, options.owner ?? buyer, `Order ${id}`, status, options.at ?? null],
    );
    if (options.vm) {
      const bid = (
        await pool.query(
          `INSERT INTO broker_bids(request_id,provider_id,offering_id,offering_snapshot,total_price_cents,status) VALUES($1,$2,$3,'{}',5,'won') RETURNING id`,
          [id, providerId, offeringId],
        )
      ).rows[0].id;
      await pool.query('UPDATE broker_requests SET winning_bid_id=$2 WHERE id=$1', [id, bid]);
      await pool.query(
        `INSERT INTO broker_vms(request_id,buyer_id,provider_id,bid_id,status,create_key,create_input,catalog_snapshot,quote_snapshot,expires_at,cleanup_confirmed_at)
        VALUES($1,$2,$3,$4,$5,$6,'{}','{}','{"totalPriceCents":5}',clock_timestamp()+interval '1 hour',CASE WHEN $7 THEN clock_timestamp() END)`,
        [
          id,
          options.owner ?? buyer,
          providerId,
          bid,
          options.vm,
          `orders-${id}`,
          options.cleaned ?? false,
        ],
      );
    }
    return id;
  }
  async function agreement(at?: string) {
    return (
      await pool.query(
        `INSERT INTO broker_agreements(buyer_id,operation_key,input_fingerprint,description,specification,status,target_quantity,minimum_quantity,starts_at,expires_at,time_zone,source_mode,max_amount_cents,reserved_cents,committed_cents,created_at)
      VALUES($1,$2,'test','Seven day capacity','{}','approved',20,12,clock_timestamp()+interval '1 day',clock_timestamp()+interval '8 days','Asia/Singapore','fixture',14000,14000,8400,COALESCE($3::timestamptz,clock_timestamp())) RETURNING id`,
        [buyer, randomUUID(), at ?? null],
      )
    ).rows[0].id;
  }
  it('keeps successful, cancelled, unmatched and failed auctions discoverable with separate VM state', async () => {
    const ids = await Promise.all([
      request('open'),
      request('no_offers'),
      request('failed'),
      request('cancelled'),
      request('ready', { vm: 'running' }),
      request('ready', { vm: 'expired', cleaned: true }),
    ]);
    await request('open', { owner: otherBuyer });
    const result = await listOrders(ctx, buyer, {});
    expect(new Set(result.items.map((r) => r.id))).toEqual(new Set(ids));
    expect(result.items.map((r) => r.status)).toEqual(
      expect.arrayContaining(['open', 'no_offers', 'failed', 'cancelled', 'running', 'completed']),
    );
    const matched = result.items.find((r) => r.status === 'running')!;
    expect(matched.auctionStatus).toBe('ready');
    expect(matched.vmStatus).toBe('running');
    expect(matched.cleanupPending).toBe(true);
    expect(result.items.find((r) => r.status === 'completed')?.cleanupPending).toBe(false);
    expect(matched.amount).toEqual({ label: 'accepted', amountCents: 5 });
    expect(matched.detailUrl).toBe(`/requests/${matched.id}`);
    expect(matched.vmUrl).toMatch(/^\/vms\//);
    expect(result.items.find((r) => r.status === 'no_offers')?.retryUrl).toMatch(/^\/new\?copy=/);
    expect(result.items.find((r) => r.status === 'open')?.amount).toEqual({
      label: 'budget',
      amountCents: 10,
    });
  });
  it('merges agreements and auctions without duplicating manual activation child requests', async () => {
    const agreementId = await agreement();
    await pool.query(
      `INSERT INTO broker_agreement_windows(agreement_id,starts_at,discount_ends_at,ends_at,approved_quantity,committed_cents) VALUES($1,clock_timestamp()+interval '1 day',clock_timestamp()+interval '30 hours',clock_timestamp()+interval '32 hours',12,1200)`,
      [agreementId],
    );
    const child = await request('ready', { vm: 'running' });
    await pool.query('UPDATE broker_requests SET agreement_id=$2 WHERE id=$1', [
      child,
      agreementId,
    ]);
    const auctionId = await request();
    const result = await listOrders(ctx, buyer, {});
    expect(result.items).toHaveLength(2);
    expect(result.items.map((r) => r.id)).toEqual(expect.arrayContaining([agreementId, auctionId]));
    const row = result.items.find((r) => r.kind === 'agreement')!;
    expect(row.key).toBe(`agreement:${agreementId}`);
    expect(row.approvedQuantity).toBe(12);
    expect(row.runningQuantity).toBe(1);
    expect(row.amount).toEqual({
      label: 'reserved',
      amountCents: 14000,
      committedCents: 8400,
      reservedCents: 14000,
    });
    expect((await listOrders(ctx, buyer, { kind: 'auction' })).items).toHaveLength(1);
    expect((await listOrders(ctx, buyer, { kind: 'agreement' })).items[0]?.id).toBe(agreementId);
  });
  it('preserves database microseconds and source kind through every page', async () => {
    const ids = [];
    for (let n = 1; n <= 3; n++)
      ids.push(await request('cancelled', { at: `2026-10-28T06:00:00.00000${n}Z` }));
    await agreement('2026-10-28T06:00:00.000002Z');
    const seen: string[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 4; page++) {
      const result = await listOrders(ctx, buyer, { limit: '1', ...(cursor ? { cursor } : {}) });
      expect(result.items).toHaveLength(1);
      seen.push(result.items[0].key);
      cursor = result.nextCursor;
      if (page === 0)
        expect(JSON.parse(Buffer.from(cursor!, 'base64url').toString())[0]).toContain('.000003');
    }
    expect(new Set(seen).size).toBe(4);
    expect(cursor).toBeUndefined();
    expect(seen.filter((k) => k.startsWith('auction:')).map((k) => k.split(':')[1])).toEqual(
      ids.reverse(),
    );
  });
  it('filters before pagination and does not load unrelated history for active orders', async () => {
    await pool.query(
      `INSERT INTO broker_requests(buyer_id,description,catalog_id,catalog_snapshot,region,duration_minutes,max_price_cents,requirements,status,created_at)
      SELECT $1,'Historical order','orders-test','{}','test',30,10,'{}','cancelled',clock_timestamp()-interval '1 day'-n*interval '1 second' FROM generate_series(1,10000) n`,
      [buyer],
    );
    const active = await request('open', {
      at: new Date(Date.now() - 20 * 86400000).toISOString(),
    });
    await pool.query('ANALYZE broker_requests');
    await pool.query('ANALYZE broker_vms');
    const activeRows = await listOrders(ctx, buyer, { status: 'active', limit: '1' });
    expect(activeRows.items.map((r) => r.id)).toEqual([active]);
    const recent = await listOrders(ctx, buyer, { created: '24h' });
    expect(recent.items).toHaveLength(0);
    const plan = (
      await pool.query('EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) ' + ORDERS_QUERY, [
        buyer,
        null,
        null,
        null,
        'active',
        null,
        'auction',
        26,
      ])
    ).rows[0]['QUERY PLAN'][0];
    const requestScans: Record<string, any>[] = [];
    function visit(node: Record<string, any>) {
      if (node['Relation Name'] === 'broker_requests') requestScans.push(node);
      for (const child of node.Plans ?? []) visit(child);
    }
    visit(plan.Plan);
    expect(requestScans.length).toBeGreaterThan(0);
    expect(
      requestScans.every((n) => (n['Actual Rows'] ?? 0) + (n['Rows Removed by Filter'] ?? 0) < 100),
      JSON.stringify(
        requestScans.map((n) => ({
          type: n['Node Type'],
          index: n['Index Name'],
          rows: n['Actual Rows'],
          removed: n['Rows Removed by Filter'],
          loops: n['Actual Loops'],
        })),
      ),
    ).toBe(true);
    const calls: string[] = [];
    const measured = {
      ...ctx,
      pool: {
        query: async (sql: string, args: unknown[]) => {
          calls.push(sql);
          return pool.query(sql, args);
        },
      },
    } as unknown as AppContext;
    await listOrders(measured, buyer, { limit: '25' });
    expect(calls).toHaveLength(2);
  });
  it('authenticates the list, rejects malformed filters, and never creates an auction on GET', async () => {
    const app = Fastify();
    let role = 'buyer';
    registerOrders(app, {
      ...ctx,
      requireActor: async (_request, roles) => {
        if (!roles?.includes(role as 'buyer')) throw new HttpError(403, 'Forbidden');
        return { id: buyer, role: 'buyer', name: 'Buyer', email: 'buyer@test.invalid' };
      },
    });
    const id = await request('cancelled');
    expect((await app.inject('/api/orders')).json().items[0].id).toBe(id);
    for (const url of [
      '/api/orders?limit=0',
      '/api/orders?kind=provider',
      '/api/orders?cursor=bad',
    ])
      expect((await app.inject(url)).statusCode).toBe(400);
    role = 'provider';
    expect((await app.inject('/api/orders')).statusCode).toBe(403);
    expect((await pool.query('SELECT count(*)::int AS n FROM broker_requests')).rows[0].n).toBe(1);
    await app.close();
  });
  it('returns settled agreement charges only to their buyer and supplier, without pretending they are VM invoices', async () => {
    const agreementId = await agreement();
    const w = (
      await pool.query(
        `INSERT INTO broker_agreement_windows(agreement_id,starts_at,discount_ends_at,ends_at,approved_quantity) VALUES($1,now()-interval '8 hours',now()-interval '2 hours',now(),2) RETURNING id`,
        [agreementId],
      )
    ).rows[0].id;
    const s = (
      await pool.query(
        `INSERT INTO broker_scheduled_offerings(provider_id,operation_key,input_fingerprint,catalog_id,name,kind,time_zone,weekdays,window_start,window_end,available_until,capacity_quantity,discount_rate_cents_per_hour,normal_rate_cents_per_hour) VALUES($1,'billing-test','test','orders-test','Scheduled','capacity_window','UTC',ARRAY[0,1,2,3,4,5,6],'00:00','06:00','08:00',2,10,20) RETURNING id`,
        [providerId],
      )
    ).rows[0].id;
    const b = (
      await pool.query(
        `INSERT INTO broker_agreement_bookings(agreement_id,window_id,provider_id,scheduled_offering_id,catalog_id,snapshot,quantity,unit_price_cents,starts_at,discount_ends_at,ends_at) VALUES($1,$2,$3,$4,'orders-test',$5,2,100,now()-interval '8 hours',now()-interval '2 hours',now()) RETURNING id`,
        [
          agreementId,
          w,
          providerId,
          s,
          { offering: { discountRateCentsPerHour: 10, normalRateCentsPerHour: 20 } },
        ],
      )
    ).rows[0].id;
    await pool.query(
      `INSERT INTO broker_agreement_charges(booking_id,agreement_id,window_id,buyer_id,provider_id,gross_cents,credit_cents,total_cents,revenue_share) VALUES($1,$2,$3,$4,$5,200,100,100,$6)`,
      [b, agreementId, w, buyer, providerId, revenueShare(100)],
    );
    const app = Fastify();
    let actor = {
      id: buyer,
      role: 'buyer' as 'buyer' | 'provider' | 'admin',
      name: 'Buyer',
      email: 'test@example.invalid',
    };
    registerAgreementBilling(app, {
      ...ctx,
      requireActor: async (_request, roles) => {
        if (!roles?.includes(actor.role)) throw new HttpError(403, 'Forbidden');
        return actor;
      },
    });
    const own = await app.inject('/api/agreement-charges');
    expect(own.statusCode).toBe(200);
    expect(own.json().items[0]).toMatchObject({
      agreementId,
      grossCents: 200,
      creditCents: 100,
      totalCents: 100,
      feeCents: 0,
      revenueShare: revenueShare(100),
      status: 'pilot-credit',
    });
    expect(own.json().items[0].vmId).toBeUndefined();
    actor = { ...actor, id: otherBuyer };
    expect((await app.inject('/api/agreement-charges')).json().items).toHaveLength(0);
    actor = { ...actor, id: 'orders-provider', role: 'provider' };
    expect((await app.inject('/api/provider/agreement-charges')).json().items).toHaveLength(1);
    expect((await app.inject('/api/agreement-charges')).statusCode).toBe(403);
    await app.close();
  });
});

describe('order filter validation', () => {
  it('bounds pages and accepts only declared filters', () => {
    expect(orderFilters({})).toMatchObject({
      kind: 'all',
      status: 'all',
      created: 'all',
      limit: 25,
    });
    for (const query of [
      { limit: '101' },
      { status: 'unbounded' },
      { created: 'ever' },
      { cursor: 'x'.repeat(800) },
    ])
      expect(() => orderFilters(query)).toThrow();
  });
});
