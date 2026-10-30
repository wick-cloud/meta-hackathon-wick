import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyRequest } from 'fastify';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { migrate } from '../src/server/db.js';
import { HttpError, type AppContext } from '../src/server/context.js';
import type { CatalogItem } from '../src/shared/types.js';
import { transaction } from '../src/server/marketplace/db.js';
import { applyCreditEntry, creditWalletView } from '../src/server/agreements/credits.js';
import { createAgreement, cancelUnmatched } from '../src/server/agreements/service.js';
import { matchAgreement } from '../src/server/agreements/matching.js';
import {
  activateAgreement,
  scheduledActivationCleaned,
  scheduledActivationReady,
} from '../src/server/agreements/activation.js';
import { maintainAgreements, settleWindow } from '../src/server/agreements/settlement.js';
import { registerAgreements } from '../src/server/agreements/index.js';
import {
  availableForInterval,
  globalAvailableForInterval,
  assertGlobalFutureCapacity,
} from '../src/server/agreements/calendar.js';
import { datePlus, localDate } from '../src/server/agreements/recurrence.js';

const url = process.env.TEST_DATABASE_URL,
  schema = `agreements_${randomUUID().replaceAll('-', '')}`;
describe.skipIf(!url)('funded manual agreements (real disposable PostgreSQL)', () => {
  let admin: Pool, pool: Pool, ctx: AppContext, providerId: string, scheduledId: string;
  const buyer = 'scheduled-buyer',
    other = 'another-buyer';
  const catalog = {
    id: 'micro',
    name: 'Micro',
    description: 'Test',
    provider: 'test',
    profile: 'micro',
    region: 'test-region',
    cpu: 1,
    memoryGb: 1,
    durationMinutes: [15, 30, 60],
    approved: true,
    organizationId: 'test-org',
    groupId: 'test-group',
    maxTtlSeconds: 86400,
    deadlineEnforcement: 'native',
  };
  beforeAll(async () => {
    admin = new Pool({ connectionString: url });
    await admin.query(`CREATE SCHEMA ${schema}`);
    pool = new Pool({ connectionString: url, max: 12, options: `-c search_path=${schema},public` });
    await migrate(pool);
    ctx = {
      pool,
      config: { maxConcurrentVms: 20, wickOrganizationId: 'test-org', wickGroupId: 'test-group' },
      wick: {
        mode: 'fixture',
        create: vi.fn(() => {
          throw new Error('No native create is allowed by these tests.');
        }),
      },
      boss: { send: vi.fn(async () => randomUUID()) },
      muse: { mode: 'fixture' },
      requireActor: async (request: FastifyRequest) => ({
        id: (request.headers['x-buyer'] as string) ?? buyer,
        role: (request.headers['x-role'] ?? 'buyer') as 'buyer',
        name: 'Tester',
        email: 'test@example.invalid',
      }),
    } as unknown as AppContext;
  }, 30000);
  beforeEach(async () => {
    vi.clearAllMocks();
    await pool.query(
      'TRUNCATE broker_catalog,broker_providers,broker_agreements,broker_credit_wallets CASCADE',
    );
    await pool.query(
      "INSERT INTO broker_settings(key,value) VALUES('maxConcurrentVms','20') ON CONFLICT(key) DO UPDATE SET value='20'",
    );
    await pool.query('INSERT INTO broker_catalog(id,item,approved) VALUES($1,$2,true)', [
      catalog.id,
      catalog,
    ]);
    providerId = (
      await pool.query(
        "INSERT INTO broker_providers(user_id,name,total_capacity,policy) VALUES('provider','Supplier',12,$1) RETURNING id",
        [{ reserveSlots: 0, allowedCatalogIds: ['micro'] }],
      )
    ).rows[0].id;
    scheduledId = (
      await pool.query(
        `INSERT INTO broker_scheduled_offerings(provider_id,operation_key,input_fingerprint,catalog_id,name,kind,time_zone,weekdays,window_start,window_end,available_until,capacity_quantity,discount_rate_cents_per_hour,normal_rate_cents_per_hour) VALUES($1,'test-offering','test','micro','Overnight','capacity_window','UTC',ARRAY[0,1,2,3,4,5,6],'00:00','06:00','08:00',20,10,20) RETURNING id`,
        [providerId],
      )
    ).rows[0].id;
    await grant(buyer, 20000);
  });
  afterAll(async () => {
    await pool?.end();
    if (admin) {
      await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await admin.end();
    }
  });
  async function grant(id: string, amount: number, key = randomUUID()) {
    return transaction(pool, (db) =>
      applyCreditEntry(db, id, {
        operationKey: key,
        kind: 'grant',
        balanceDeltaCents: amount,
        reservedDeltaCents: 0,
        description: 'Disposable pilot credit',
      }),
    );
  }
  function input(key = randomUUID()) {
    return {
      operationKey: key,
      description: 'Seven-day capacity',
      startDate: datePlus(localDate(Date.now(), 'UTC'), 1),
      timeZone: 'UTC',
      windowStart: '00:00',
      windowEnd: '06:00',
      minimumQuantity: 12,
      targetQuantity: 20,
      requirements: { cpu: 1, memoryGb: 1 },
      region: 'any',
      maxDiscountRateCentsPerHour: 10,
      continuation: { enabled: true, until: '08:00', maxRateCentsPerHour: 20 },
    };
  }
  async function bookedCurrent(ended = false, buffer = 0) {
    const id = randomUUID(),
      windowId = randomUUID(),
      bookingId = randomUUID();
    const now = Date.now(),
      start = new Date(now - 3600000).toISOString(),
      discount = new Date(now + (ended ? -120000 : 1800000)).toISOString(),
      end = new Date(now + (ended ? -60000 : 3600000)).toISOString();
    const spec = input();
    await pool.query(
      `INSERT INTO broker_agreements(id,buyer_id,operation_key,input_fingerprint,description,specification,status,target_quantity,minimum_quantity,starts_at,expires_at,time_zone,source_mode,max_amount_cents,reserved_cents,committed_cents,accepting_topups) VALUES($1,$2,$3,'test','Current booked agreement',$4,'approved',12,12,$5,$6,'UTC','fixture',$7,$7,1200,false)`,
      [id, buyer, randomUUID(), spec, start, end, 1200 + buffer],
    );
    await transaction(pool, (db) =>
      applyCreditEntry(db, buyer, {
        operationKey: `agreement:${id}:reserve`,
        kind: 'reserve',
        balanceDeltaCents: 0,
        reservedDeltaCents: 1200 + buffer,
        agreementId: id,
        description: 'Reserve test booked block',
      }),
    );
    await pool.query(
      'INSERT INTO broker_agreement_windows(id,agreement_id,starts_at,discount_ends_at,ends_at,approved_quantity,committed_cents) VALUES($1,$2,$3,$4,$5,12,1200)',
      [windowId, id, start, discount, end],
    );
    await pool.query(
      "INSERT INTO broker_agreement_bookings(id,agreement_id,window_id,provider_id,scheduled_offering_id,catalog_id,snapshot,quantity,unit_price_cents,starts_at,discount_ends_at,ends_at) VALUES($1,$2,$3,$4,$5,'micro',$6,12,100,$7,$8,$9)",
      [
        bookingId,
        id,
        windowId,
        providerId,
        scheduledId,
        {
          catalog,
          providerName: 'Supplier',
          offering: { discountRateCentsPerHour: 10, normalRateCentsPerHour: 20 },
          revision: 1,
        },
        start,
        discount,
        end,
      ],
    );
    return { id, windowId, bookingId };
  }
  it('atomically reserves maximum credit, commits minimum across all seven windows, and starts zero VMs', async () => {
    const detail = await createAgreement(ctx, buyer, input());
    expect(detail.agreement.status).toBe('approved');
    expect(detail.agreement.windows.map((w) => w.approvedQuantity)).toEqual(Array(7).fill(12));
    expect(detail.agreement).toMatchObject({
      reservedCents: 14000,
      committedCents: 8400,
      settledCents: 0,
      topUpAllowanceCents: 5600,
      activationMode: 'manual',
    });
    expect(await creditWalletView(pool, buyer)).toMatchObject({
      balanceCents: 20000,
      reservedCents: 14000,
      availableCents: 6000,
    });
    expect((await pool.query('SELECT count(*) n FROM broker_vms')).rows[0].n).toBe('0');
    expect(ctx.boss.send).not.toHaveBeenCalled();
    expect(ctx.wick.create).not.toHaveBeenCalled();
  });
  it('keeps an order open without any partial bookings if even one weekday cannot reach the minimum', async () => {
    await pool.query('UPDATE broker_scheduled_offerings SET weekdays=ARRAY[1,2,3,4,5,6]');
    const d = await createAgreement(ctx, buyer, input());
    expect(d.agreement.status).toBe('open');
    expect(d.bookings).toEqual([]);
    expect(d.agreement.reservedCents).toBe(0);
    expect(d.agreement.blockedCode).toBe('awaiting_capacity');
  });
  it('does not approve without full maximum funding; retries match after a separate grant', async () => {
    await pool.query('UPDATE broker_credit_wallets SET balance_cents=9000 WHERE buyer_id=$1', [
      buyer,
    ]);
    const d = await createAgreement(ctx, buyer, input());
    expect(d.agreement.blockedCode).toBe('needs_credit');
    expect(d.bookings).toHaveLength(0);
    await grant(buyer, 10000);
    await matchAgreement(ctx, d.agreement.id);
    expect(
      (
        await pool.query('SELECT status,reserved_cents FROM broker_agreements WHERE id=$1', [
          d.agreement.id,
        ])
      ).rows[0],
    ).toMatchObject({ status: 'approved', reserved_cents: 14000 });
  });
  it('replays create/grants and rejects changed operation-key payloads', async () => {
    const spec = input(),
      a = await createAgreement(ctx, buyer, spec),
      b = await createAgreement(ctx, buyer, spec);
    expect(b.agreement.id).toBe(a.agreement.id);
    await expect(
      createAgreement(ctx, buyer, { ...spec, targetQuantity: 19 }),
    ).rejects.toMatchObject({ statusCode: 409 });
    const key = randomUUID();
    await grant(other, 100, key);
    await grant(other, 100, key);
    await expect(grant(other, 200, key)).rejects.toMatchObject({ statusCode: 409 });
    expect((await creditWalletView(pool, other)).balanceCents).toBe(100);
  });
  it('tops up only uncommitted held credit and releases the unmatched remainder without cancelling booked rights', async () => {
    const a = await createAgreement(ctx, buyer, input());
    await pool.query('UPDATE broker_providers SET total_capacity=16 WHERE id=$1', [providerId]);
    await matchAgreement(ctx, a.agreement.id);
    const row = (
      await pool.query('SELECT reserved_cents,committed_cents FROM broker_agreements WHERE id=$1', [
        a.agreement.id,
      ])
    ).rows[0];
    expect(row).toMatchObject({ reserved_cents: 14000, committed_cents: 11200 });
    const d = await cancelUnmatched(ctx, a.agreement.id, buyer, { operationKey: randomUUID() });
    expect(d.agreement).toMatchObject({
      status: 'approved',
      reservedCents: 11200,
      committedCents: 11200,
      acceptingTopUps: false,
    });
    expect((await creditWalletView(pool, buyer)).balanceCents).toBe(20000);
  });
  it('does not reprice an existing booking when a scheduled offering revision changes', async () => {
    const a = await createAgreement(ctx, buyer, input());
    await pool.query('UPDATE broker_providers SET total_capacity=20 WHERE id=$1', [providerId]);
    await pool.query(
      'UPDATE broker_scheduled_offerings SET discount_rate_cents_per_hour=9,revision=2 WHERE id=$1',
      [scheduledId],
    );
    await matchAgreement(ctx, a.agreement.id);
    const amounts = (
      await pool.query(
        'SELECT unit_price_cents,quantity FROM broker_agreement_bookings WHERE agreement_id=$1',
        [a.agreement.id],
      )
    ).rows;
    expect(amounts).toHaveLength(7);
    expect(amounts.every((r) => r.unit_price_cents === 100 && r.quantity === 12)).toBe(true);
  });
  it('retains replacement supply when a cheaper booked offer cannot top up its frozen revision', async () => {
    const first = await createAgreement(ctx, buyer, input());
    await pool.query('UPDATE broker_providers SET total_capacity=20 WHERE id=$1', [providerId]);
    await pool.query(
      'UPDATE broker_scheduled_offerings SET discount_rate_cents_per_hour=9,revision=2 WHERE id=$1',
      [scheduledId],
    );
    await pool.query(
      `INSERT INTO broker_scheduled_offerings(provider_id,operation_key,input_fingerprint,catalog_id,name,kind,time_zone,weekdays,window_start,window_end,available_until,capacity_quantity,discount_rate_cents_per_hour,normal_rate_cents_per_hour)
       VALUES($1,'replacement-supply','test','micro','Replacement supply','capacity_window','UTC',ARRAY[0,1,2,3,4,5,6],'00:00','06:00','08:00',8,10,20)`,
      [providerId],
    );
    await matchAgreement(ctx, first.agreement.id);
    expect(
      (
        await pool.query(
          'SELECT approved_quantity FROM broker_agreement_windows WHERE agreement_id=$1',
          [first.agreement.id],
        )
      ).rows.map((w) => w.approved_quantity),
    ).toEqual(Array(7).fill(20));
    expect(
      (
        await pool.query(
          'SELECT quantity,unit_price_cents FROM broker_agreement_bookings WHERE agreement_id=$1 AND scheduled_offering_id=$2',
          [first.agreement.id, scheduledId],
        )
      ).rows,
    ).toEqual(Array(7).fill({ quantity: 12, unit_price_cents: 100 }));
  });
  it('allows legacy unrestricted provider policies while serializing competing agreements against one calendar', async () => {
    await pool.query("UPDATE broker_providers SET policy='{}' WHERE id=$1", [providerId]);
    await grant(other, 20000);
    const results = await Promise.all([
      createAgreement(ctx, buyer, input()),
      createAgreement(ctx, other, input()),
    ]);
    expect(results.map((r) => r.agreement.status).sort()).toEqual(['approved', 'open']);
    expect(
      (await pool.query('SELECT max(approved_quantity) n FROM broker_agreement_windows')).rows[0].n,
    ).toBe(12);
  });
  it('manual activation is idempotent, strictly scoped, fixed-cutoff and does not create runtime invoices', async () => {
    const a = await bookedCurrent(),
      body = { operationKey: randomUUID(), windowId: a.windowId, quantity: 2 };
    await expect(activateAgreement(ctx, a.id, other, body)).rejects.toMatchObject({
      statusCode: 404,
    });
    const first = await activateAgreement(ctx, a.id, buyer, body),
      again = await activateAgreement(ctx, a.id, buyer, body);
    expect(first.activations).toHaveLength(2);
    expect(again.replayed).toBe(true);
    expect(again.activations.map((a) => a.vmId)).toEqual(first.activations.map((a) => a.vmId));
    const vm = (
      await pool.query('SELECT * FROM broker_vms WHERE id=$1', [first.activations[0].vmId])
    ).rows[0];
    expect(vm.quote_snapshot.billingSource).toBe('scheduled_capacity');
    expect(new Date(vm.expires_at).toISOString()).toBe(vm.create_input.hardEndAt);
    expect(vm.create_input.ttlSeconds).toBeGreaterThanOrEqual(60);
    expect(ctx.boss.send).toHaveBeenCalledTimes(2);
    expect((await pool.query('SELECT count(*) n FROM broker_invoices')).rows[0].n).toBe('0');
    await expect(
      activateAgreement(ctx, a.id, buyer, { ...body, quantity: 1 }),
    ).rejects.toMatchObject({ statusCode: 409 });
  });
  it('counts in-flight/failed activations until confirmed cleanup, then credits a failed slot once', async () => {
    const a = await bookedCurrent(),
      first = await activateAgreement(ctx, a.id, buyer, {
        operationKey: randomUUID(),
        windowId: a.windowId,
        quantity: 12,
      });
    await expect(
      activateAgreement(ctx, a.id, buyer, {
        operationKey: randomUUID(),
        windowId: a.windowId,
        quantity: 1,
      }),
    ).rejects.toMatchObject({ statusCode: 409 });
    const vm = (
      await pool.query('SELECT * FROM broker_vms WHERE id=$1', [first.activations[0].vmId])
    ).rows[0];
    await transaction(pool, async (db) => {
      await scheduledActivationCleaned(ctx, db, vm, { admissionRejected: true });
      await scheduledActivationCleaned(ctx, db, vm, { admissionRejected: true });
    });
    expect(
      (await pool.query('SELECT adjustment_cents FROM broker_agreements WHERE id=$1', [a.id]))
        .rows[0].adjustment_cents,
    ).toBe(100);
    expect(
      (await pool.query('SELECT count(*) n FROM broker_agreement_adjustments')).rows[0].n,
    ).toBe('1');
  });
  it('settles booked idle capacity exactly once and releases the maximum-term buffer on expiry', async () => {
    const a = await bookedCurrent(true);
    await settleWindow(ctx, a.windowId);
    await settleWindow(ctx, a.windowId);
    expect(await creditWalletView(pool, buyer)).toMatchObject({
      balanceCents: 18800,
      reservedCents: 0,
    });
    expect((await pool.query('SELECT count(*) n FROM broker_agreement_charges')).rows[0].n).toBe(
      '1',
    );
    await maintainAgreements(ctx);
    expect(
      (await pool.query('SELECT status FROM broker_agreements WHERE id=$1', [a.id])).rows[0].status,
    ).toBe('expired');
    expect(ctx.boss.send).not.toHaveBeenCalled();
  });
  it('refuses expired manual starts and currently revoked native deadline capability', async () => {
    const ended = await bookedCurrent(true);
    await expect(
      activateAgreement(ctx, ended.id, buyer, {
        operationKey: randomUUID(),
        windowId: ended.windowId,
        quantity: 1,
      }),
    ).rejects.toMatchObject({ statusCode: 409 });
    const a = await bookedCurrent();
    await pool.query("UPDATE broker_agreements SET source_mode='real' WHERE id=$1", [a.id]);
    await pool.query(
      "UPDATE broker_catalog SET source_mode='real',item=item||'{\"deadlineEnforcement\":\"supervised\"}' WHERE id='micro'",
    );
    const real = {
      ...ctx,
      wick: {
        ...ctx.wick,
        mode: 'real',
        catalog: async () =>
          (await pool.query("SELECT item FROM broker_catalog WHERE id='micro'")).rows.map(
            (r) => r.item,
          ),
      },
    } as AppContext;
    await expect(
      activateAgreement(real, a.id, buyer, {
        operationKey: randomUUID(),
        windowId: a.windowId,
        quantity: 1,
      }),
    ).rejects.toMatchObject({ statusCode: 409 });
    expect((await pool.query('SELECT count(*) n FROM broker_vms')).rows[0].n).toBe('0');
  });
  it('does not let global capacity be lowered below future booked rights', async () => {
    await createAgreement(ctx, buyer, input());
    await transaction(pool, async (db) => {
      await expect(assertGlobalFutureCapacity(db, 11)).rejects.toMatchObject({ statusCode: 409 });
      expect(
        await globalAvailableForInterval(
          ctx,
          db,
          new Date(Date.now() + 2 * 86400000).toISOString(),
          new Date(Date.now() + 3 * 86400000).toISOString(),
        ),
      ).toBeGreaterThanOrEqual(8);
    });
  });
  it('uses actual ready state only as runtime metadata and keeps buyer wallet untouched', async () => {
    const a = await bookedCurrent(),
      r = await activateAgreement(ctx, a.id, buyer, {
        operationKey: randomUUID(),
        windowId: a.windowId,
        quantity: 1,
      });
    const vm = (await pool.query('SELECT * FROM broker_vms WHERE id=$1', [r.activations[0].vmId]))
      .rows[0];
    await transaction(pool, (db) => scheduledActivationReady(ctx, db, vm));
    expect(
      (
        await pool.query(
          'SELECT status,first_ready_at FROM broker_agreement_activations WHERE id=$1',
          [r.activations[0].id],
        )
      ).rows[0].status,
    ).toBe('running');
    expect((await creditWalletView(pool, buyer)).balanceCents).toBe(20000);
  });
  it('returns private buyer-only details and truthful fixture draft metadata over HTTP', async () => {
    const app = Fastify();
    app.setErrorHandler((err, _req, reply) =>
      reply
        .status(err instanceof HttpError ? err.statusCode : 500)
        .send({ message: err instanceof Error ? err.message : 'Request failed' }),
    );
    await registerAgreements(app, ctx);
    const a = await createAgreement(ctx, buyer, input());
    expect(
      (
        await app.inject({
          url: `/api/agreements/${a.agreement.id}`,
          headers: { 'x-buyer': other },
        })
      ).statusCode,
    ).toBe(404);
    const draft = await app.inject({
      method: 'POST',
      url: '/api/agreements/draft',
      payload: { prompt: '12 VMs 00:00 to 06:00 for seven days' },
    });
    expect(draft.json()).toMatchObject({
      mode: 'fixture',
      modelCalled: false,
      draft: { minimumQuantity: 12 },
    });
    await app.close();
  });
  it('reverses a pending failure adjustment when the same booked slot later delivers; later failed restarts do not refund it', async () => {
    const a = await bookedCurrent();
    async function start() {
      const r = await activateAgreement(ctx, a.id, buyer, {
        operationKey: randomUUID(),
        windowId: a.windowId,
        quantity: 1,
      });
      return (await pool.query('SELECT * FROM broker_vms WHERE id=$1', [r.activations[0].vmId]))
        .rows[0];
    }
    async function clean(vm: Record<string, any>) {
      await transaction(pool, async (db) => {
        await db.query('UPDATE broker_vms SET cleanup_confirmed_at=clock_timestamp() WHERE id=$1', [
          vm.id,
        ]);
        await db.query('UPDATE broker_holds SET released_at=clock_timestamp() WHERE bid_id=$1', [
          vm.bid_id,
        ]);
        await scheduledActivationCleaned(ctx, db, vm);
      });
    }
    const first = await start();
    await clean(first);
    expect(
      (await pool.query('SELECT adjustment_cents FROM broker_agreements WHERE id=$1', [a.id]))
        .rows[0].adjustment_cents,
    ).toBe(100);
    const second = await start();
    await transaction(pool, (db) => scheduledActivationReady(ctx, db, second));
    expect(
      (await pool.query('SELECT adjustment_cents FROM broker_agreements WHERE id=$1', [a.id]))
        .rows[0].adjustment_cents,
    ).toBe(0);
    await clean(second);
    const third = await start();
    await clean(third);
    expect(
      (await pool.query('SELECT count(*) n FROM broker_agreement_adjustments')).rows[0].n,
    ).toBe('0');
  });
  it('retains unused expired credit until every scheduled activation has cleanup acknowledgement', async () => {
    const a = await bookedCurrent(true, 300);
    await pool.query(
      `INSERT INTO broker_agreement_activations(agreement_id,window_id,booking_id,slot_index,operation_key,item_number,ends_at) SELECT $1,$2,$3,1,'uncertain-cleanup',1,ends_at FROM broker_agreement_windows WHERE id=$2`,
      [a.id, a.windowId, a.bookingId],
    );
    await maintainAgreements(ctx);
    expect(
      (
        await pool.query(
          'SELECT status,reserved_cents,blocked_reason FROM broker_agreements WHERE id=$1',
          [a.id],
        )
      ).rows[0],
    ).toMatchObject({
      status: 'expired',
      reserved_cents: 300,
      blocked_reason: expect.stringContaining('pending confirmed VM cleanup'),
    });
    expect((await creditWalletView(pool, buyer)).reservedCents).toBe(300);
    await pool.query(
      "UPDATE broker_agreement_activations SET cleaned_at=clock_timestamp(),status='terminated' WHERE agreement_id=$1",
      [a.id],
    );
    await pool.query('UPDATE broker_agreements SET next_match_at=clock_timestamp() WHERE id=$1', [
      a.id,
    ]);
    await maintainAgreements(ctx);
    expect((await creditWalletView(pool, buyer)).reservedCents).toBe(0);
    expect(
      (await pool.query('SELECT reserved_cents FROM broker_agreements WHERE id=$1', [a.id])).rows[0]
        .reserved_cents,
    ).toBe(0);
  });
  it('requires fresh managed rates within the frozen ceiling and rejects catalog resource drift before any activation', async () => {
    const a = await bookedCurrent();
    const managed = {
      ...catalog,
      provider: 'e2b',
      pricingMode: 'managed',
      rateMicrosPerSecond: 23,
      rateSource: 'wick-customer-catalog',
      rateRetrievedAt: new Date().toISOString(),
      managedRouteVerification: 'execution-preview-managed',
    };
    await pool.query("UPDATE broker_agreements SET source_mode='real' WHERE id=$1", [a.id]);
    await pool.query("UPDATE broker_catalog SET source_mode='real',item=$1 WHERE id='micro'", [
      managed,
    ]);
    await pool.query(
      "UPDATE broker_agreement_bookings SET snapshot=jsonb_set(snapshot,'{catalog}',$2) WHERE agreement_id=$1",
      [a.id, managed],
    );
    const real = {
      ...ctx,
      wick: {
        ...ctx.wick,
        mode: 'real',
        catalog: async () =>
          (await pool.query("SELECT item FROM broker_catalog WHERE id='micro'")).rows.map(
            (r) => r.item,
          ),
      },
    } as AppContext;
    const activate = () =>
      activateAgreement(real, a.id, buyer, {
        operationKey: randomUUID(),
        windowId: a.windowId,
        quantity: 1,
      });
    await pool.query(
      "UPDATE broker_catalog SET item=jsonb_set(item,'{rateMicrosPerSecond}','24') WHERE id='micro'",
    );
    await expect(activate()).rejects.toThrow(/frozen scheduled cost ceiling/);
    await pool.query(
      "UPDATE broker_catalog SET item=jsonb_set(jsonb_set(item,'{rateMicrosPerSecond}','23'),'{rateRetrievedAt}',to_jsonb((clock_timestamp()-interval '20 minutes')::text)) WHERE id='micro'",
    );
    await expect(activate()).rejects.toThrow(/stale/);
    await pool.query("UPDATE broker_catalog SET item=$1::jsonb||'{\"cpu\":2}' WHERE id='micro'", [
      managed,
    ]);
    await expect(activate()).rejects.toThrow(/route or scope changed/);
    await pool.query(
      "UPDATE broker_catalog SET item=$1::jsonb||'{\"rateMicrosPerSecond\":22}' WHERE id='micro'",
      [managed],
    );
    const valid = await activate();
    const vm = (
      await pool.query('SELECT create_input FROM broker_vms WHERE id=$1', [
        valid.activations[0].vmId,
      ])
    ).rows[0];
    expect(vm.create_input.maximumPriceMicrosPerSecond).toBe(23);
  });
  it('does not scan unrelated instant history when checking future global capacity', async () => {
    await pool.query(
      `INSERT INTO broker_requests(buyer_id,description,catalog_id,catalog_snapshot,region,duration_minutes,max_price_cents,requirements,status,created_at) SELECT 'historical-buyer','Old auction','micro','{}','test-region',30,1,'{}','cancelled',clock_timestamp()-n*interval '1 minute' FROM generate_series(1,20000) n`,
    );
    await pool.query('ANALYZE broker_requests');
    await pool.query('ANALYZE broker_vms');
    await transaction(pool, async (db) => {
      const spy = vi.spyOn(db, 'query');
      const start = new Date(Date.now() + 86400000).toISOString(),
        end = new Date(Date.now() + 90000000).toISOString();
      expect(await globalAvailableForInterval(ctx, db, start, end)).toBe(20);
      const sql = spy.mock.calls
        .map((call) => String(call[0]))
        .find((sql) => sql.includes(') occupied'))!;
      spy.mockRestore();
      const plan = (await db.query(`EXPLAIN(ANALYZE,BUFFERS,FORMAT JSON) ${sql}`, [start, null]))
        .rows[0]['QUERY PLAN'][0].Plan;
      const nodes: Record<string, any>[] = [];
      function walk(p: Record<string, any>) {
        nodes.push(p);
        for (const child of p.Plans ?? []) walk(child);
      }
      walk(plan);
      const historyReads = nodes.filter((p) => p['Relation Name'] === 'broker_requests');
      expect(historyReads.length).toBeGreaterThan(0);
      expect(
        historyReads.every(
          (p) => Number(p['Actual Rows']) + Number(p['Rows Removed by Filter'] ?? 0) < 100,
        ),
      ).toBe(true);
      expect(historyReads.some((p) => p['Index Name'] === 'broker_requests_open')).toBe(true);
    });
  });
  it('expires healthy known instant holds before future bookings but retains unknown and terminating allocations', async () => {
    const offering = (
      await pool.query(
        "INSERT INTO broker_offerings(provider_id,catalog_id,name,description,price_cents) VALUES($1,'micro','Instant','Test',5) RETURNING id",
        [providerId],
      )
    ).rows[0];
    const r = (
      await pool.query(
        "INSERT INTO broker_requests(buyer_id,description,catalog_id,catalog_snapshot,region,duration_minutes,max_price_cents,requirements,status) VALUES($1,'Instant','micro','{}','test-region',30,5,'{}','provisioning') RETURNING id",
        [buyer],
      )
    ).rows[0];
    const bid = (
      await pool.query(
        "INSERT INTO broker_bids(request_id,provider_id,offering_id,offering_snapshot,total_price_cents,status) VALUES($1,$2,$3,'{}',5,'won') RETURNING id",
        [r.id, providerId, offering.id],
      )
    ).rows[0];
    await pool.query('INSERT INTO broker_holds(bid_id,provider_id) VALUES($1,$2)', [
      bid.id,
      providerId,
    ]);
    const vm = (
      await pool.query(
        "INSERT INTO broker_vms(request_id,buyer_id,provider_id,bid_id,status,environment_id,create_key,create_input,catalog_snapshot,quote_snapshot,expires_at) VALUES($1,$2,$3,$4,'running','known-environment',$5,'{}','{}','{}',clock_timestamp()+interval '30 minutes') RETURNING id",
        [r.id, buyer, providerId, bid.id, randomUUID()],
      )
    ).rows[0];
    const start = new Date(Date.now() + 86400000).toISOString(),
      end = new Date(Date.now() + 90000000).toISOString();
    await transaction(pool, async (db) => {
      expect(await availableForInterval(ctx, db, providerId, start, end)).toBe(12);
      expect(await globalAvailableForInterval(ctx, db, start, end)).toBe(20);
    });
    await pool.query("UPDATE broker_vms SET status='terminating' WHERE id=$1", [vm.id]);
    await transaction(pool, async (db) => {
      expect(await availableForInterval(ctx, db, providerId, start, end)).toBe(11);
      expect(await globalAvailableForInterval(ctx, db, start, end)).toBe(19);
      expect(await globalAvailableForInterval(ctx, db, start, end, undefined, r.id)).toBe(20);
    });
  });
  it('filters unrelated regions, resources, policies and local-time schedules before its bounded candidate frontier', async () => {
    await pool.query("UPDATE broker_providers SET policy='{}' WHERE id=$1", [providerId]);
    await pool.query(
      "INSERT INTO broker_catalog(id,item,approved) VALUES('wrong-region',$1,true)",
      [{ ...catalog, id: 'wrong-region', region: 'other-region' }],
    );
    await pool.query(
      `INSERT INTO broker_scheduled_offerings(provider_id,operation_key,input_fingerprint,catalog_id,name,kind,time_zone,weekdays,window_start,window_end,available_until,capacity_quantity,discount_rate_cents_per_hour,normal_rate_cents_per_hour)
      SELECT $1::uuid,'unrelated-region-'||n,'test','wrong-region','Cheap wrong region','capacity_window','UTC',ARRAY[0,1,2,3,4,5,6],'00:00','06:00','08:00',20,1,2 FROM generate_series(1,70)n
      UNION ALL SELECT $1::uuid,'unrelated-time-'||n,'test','micro','Cheap wrong hours','capacity_window','UTC',ARRAY[0,1,2,3,4,5,6],'12:00','18:00','20:00',20,1,2 FROM generate_series(1,70)n`,
      [providerId],
    );
    const result = await createAgreement(ctx, buyer, { ...input(), region: 'test-region' });
    expect(result.agreement.status).toBe('approved');
    expect(result.bookings).toHaveLength(7);
    expect(result.bookings.every((b) => b.catalogId === 'micro' && b.unitPriceCents === 100)).toBe(
      true,
    );
  });
  it('publishes and retires provider schedules idempotently without mutating accepted commitments', async () => {
    const app = Fastify();
    app.setErrorHandler((err, _req, reply) =>
      reply
        .status(err instanceof HttpError ? err.statusCode : 500)
        .send({ message: err instanceof Error ? err.message : 'Request failed' }),
    );
    await registerAgreements(app, ctx);
    const payload = {
      operationKey: randomUUID(),
      catalogId: 'micro',
      name: 'New schedule',
      kind: 'capacity_window',
      timeZone: 'UTC',
      weekdays: [0, 1, 2, 3, 4, 5, 6],
      windowStart: '00:00',
      windowEnd: '06:00',
      availableUntil: '08:00',
      capacityQuantity: 12,
      discountRateCentsPerHour: 10,
      normalRateCentsPerHour: 20,
    };
    const headers = { 'x-buyer': 'provider', 'x-role': 'provider' },
      first = await app.inject({
        method: 'POST',
        url: '/api/provider/scheduled-offerings',
        headers,
        payload,
      });
    expect(first.statusCode).toBe(200);
    const second = await app.inject({
      method: 'POST',
      url: '/api/provider/scheduled-offerings',
      headers,
      payload,
    });
    expect(second.json().id).toBe(first.json().id);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/provider/scheduled-offerings',
          headers,
          payload: { ...payload, name: 'Changed' },
        })
      ).statusCode,
    ).toBe(409);
    const created = first.json();
    expect(
      (
        await app.inject({
          method: 'PATCH',
          url: `/api/provider/scheduled-offerings/${created.id}`,
          headers,
          payload: { active: false, expectedRevision: created.revision },
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await app.inject({
          method: 'PATCH',
          url: `/api/provider/scheduled-offerings/${created.id}`,
          headers,
          payload: { active: true, expectedRevision: created.revision },
        })
      ).statusCode,
    ).toBe(409);
    expect(ctx.wick.create).not.toHaveBeenCalled();
    await app.close();
  });
  it('does not let duplicate cheap offers from one nearly full supplier hide other available capacity', async () => {
    await pool.query('UPDATE broker_providers SET total_capacity=1 WHERE id=$1', [providerId]);
    await pool.query(
      `INSERT INTO broker_scheduled_offerings(provider_id,operation_key,input_fingerprint,catalog_id,name,kind,time_zone,weekdays,window_start,window_end,available_until,capacity_quantity,discount_rate_cents_per_hour,normal_rate_cents_per_hour)
       SELECT $1,'limited-cheap-'||n,'test','micro','Cheap one-slot supplier','capacity_window','UTC',ARRAY[0,1,2,3,4,5,6],'00:00','06:00','08:00',1,1,2 FROM generate_series(1,70)n`,
      [providerId],
    );
    const free = (
      await pool.query(
        `INSERT INTO broker_providers(user_id,name,total_capacity,policy) VALUES('second-provider','Available supplier',8,'{"allowedCatalogIds":["micro"]}') RETURNING id`,
      )
    ).rows[0];
    await pool.query(
      `INSERT INTO broker_scheduled_offerings(provider_id,operation_key,input_fingerprint,catalog_id,name,kind,time_zone,weekdays,window_start,window_end,available_until,capacity_quantity,discount_rate_cents_per_hour,normal_rate_cents_per_hour)
       VALUES($1,'second-provider-offer','test','micro','Available at a higher price','capacity_window','UTC',ARRAY[0,1,2,3,4,5,6],'00:00','06:00','08:00',8,10,20)`,
      [free.id],
    );
    const result = await createAgreement(ctx, buyer, {
      ...input(),
      minimumQuantity: 8,
      targetQuantity: 9,
    });
    expect(result.agreement.status).toBe('approved');
    expect(result.agreement.windows.map((w) => w.approvedQuantity)).toEqual(Array(7).fill(9));
    expect(result.bookings.filter((b) => b.providerId === providerId)).toHaveLength(7);
    expect(
      result.bookings
        .filter((b) => b.providerId === providerId)
        .every((b) => b.quantity === 1 && b.unitPriceCents === 10),
    ).toBe(true);
    expect(
      result.bookings
        .filter((b) => b.providerId === free.id)
        .every((b) => b.quantity === 8 && b.unitPriceCents === 100),
    ).toBe(true);
  });
  it('retains distinct one-slot offerings needed to fill the same supplier capacity', async () => {
    await pool.query('UPDATE broker_providers SET total_capacity=20 WHERE id=$1', [providerId]);
    await pool.query('UPDATE broker_scheduled_offerings SET active=false');
    await pool.query(
      `INSERT INTO broker_scheduled_offerings(provider_id,operation_key,input_fingerprint,catalog_id,name,kind,time_zone,weekdays,window_start,window_end,available_until,capacity_quantity,discount_rate_cents_per_hour,normal_rate_cents_per_hour)
       SELECT $1,'distinct-slot-'||n,'test','micro','Distinct one-slot offering','capacity_window','UTC',ARRAY[0,1,2,3,4,5,6],'00:00','06:00','08:00',1,10,20 FROM generate_series(1,20)n`,
      [providerId],
    );
    const result = await createAgreement(ctx, buyer, { ...input(), minimumQuantity: 20 });
    expect(result.agreement.status).toBe('approved');
    expect(result.agreement.windows.map((w) => w.approvedQuantity)).toEqual(Array(7).fill(20));
    expect(result.bookings).toHaveLength(140);
    expect(result.bookings.every((b) => b.quantity === 1 && b.unitPriceCents === 100)).toBe(true);
  });
  it.each(['booked', 'physical'] as const)(
    'filters 70 cheaper offers from a provider with no %s headroom before the candidate limit',
    async (kind) => {
      if (kind === 'booked') {
        await grant(other, 20000);
        const existing = await createAgreement(ctx, other, { ...input(), targetQuantity: 12 });
        expect(existing.agreement.status).toBe('approved');
      } else {
        await pool.query('UPDATE broker_providers SET total_capacity=1 WHERE id=$1', [providerId]);
        const regular = (
          await pool.query(
            "INSERT INTO broker_offerings(provider_id,catalog_id,name,description,price_cents) VALUES($1,'micro','Uncertain native create','Test',5) RETURNING id",
            [providerId],
          )
        ).rows[0];
        const request = (
          await pool.query(
            "INSERT INTO broker_requests(buyer_id,description,catalog_id,catalog_snapshot,region,duration_minutes,max_price_cents,requirements,status) VALUES('uncertain-buyer','Unknown create','micro','{}','test-region',30,5,'{}','failed') RETURNING id",
          )
        ).rows[0];
        const bid = (
          await pool.query(
            "INSERT INTO broker_bids(request_id,provider_id,offering_id,offering_snapshot,total_price_cents,status) VALUES($1,$2,$3,'{}',5,'won') RETURNING id",
            [request.id, providerId, regular.id],
          )
        ).rows[0];
        await pool.query('INSERT INTO broker_holds(bid_id,provider_id) VALUES($1,$2)', [
          bid.id,
          providerId,
        ]);
        await pool.query(
          "INSERT INTO broker_vms(request_id,buyer_id,provider_id,bid_id,status,create_key,create_input,catalog_snapshot,quote_snapshot) VALUES($1,'uncertain-buyer',$2,$3,'failed',$4,'{}','{}','{}')",
          [request.id, providerId, bid.id, randomUUID()],
        );
      }
      await pool.query(
        `INSERT INTO broker_scheduled_offerings(provider_id,operation_key,input_fingerprint,catalog_id,name,kind,time_zone,weekdays,window_start,window_end,available_until,capacity_quantity,discount_rate_cents_per_hour,normal_rate_cents_per_hour)
      SELECT $1,'full-provider-cheap-'||n,'test','micro','Cheap but fully occupied','capacity_window','UTC',ARRAY[0,1,2,3,4,5,6],'00:00','06:00','08:00',20,1,2 FROM generate_series(1,70)n`,
        [providerId],
      );
      const free = (
        await pool.query(
          "INSERT INTO broker_providers(user_id,name,total_capacity,policy) VALUES('free-provider','Available higher price provider',8,'{\"allowedCatalogIds\":[\"micro\"]}') RETURNING id",
        )
      ).rows[0];
      await pool.query(
        `INSERT INTO broker_scheduled_offerings(provider_id,operation_key,input_fingerprint,catalog_id,name,kind,time_zone,weekdays,window_start,window_end,available_until,capacity_quantity,discount_rate_cents_per_hour,normal_rate_cents_per_hour) VALUES($1,'available-provider-offer','test','micro','Available at a higher price','capacity_window','UTC',ARRAY[0,1,2,3,4,5,6],'00:00','06:00','08:00',8,10,20)`,
        [free.id],
      );
      const result = await createAgreement(ctx, buyer, { ...input(), minimumQuantity: 8 });
      expect(result.agreement.status).toBe('approved');
      expect(result.agreement.windows.map((w) => w.approvedQuantity)).toEqual(Array(7).fill(8));
      expect(result.bookings).toHaveLength(7);
      expect(
        result.bookings.every(
          (b) => b.providerId === free.id && b.quantity === 8 && b.unitPriceCents === 100,
        ),
      ).toBe(true);
      expect(ctx.wick.create).not.toHaveBeenCalled();
    },
  );
  it('aggregates only bookings overlapping the seven requested windows when unrelated booking history grows', async () => {
    const client = await pool.connect(),
      prototype = Object.getPrototypeOf(client);
    client.release();
    const spy = vi.spyOn(prototype, 'query');
    let sql = '',
      values: unknown[] = [];
    try {
      await createAgreement(ctx, buyer, input());
      const calls = spy.mock.calls.filter((call) =>
        String(call[0]).includes('WITH wanted AS MATERIALIZED'),
      );
      expect(calls).toHaveLength(1);
      sql = String(calls[0][0]);
      values = calls[0][1] as unknown[];
    } finally {
      spy.mockRestore();
    }
    // Exercise both overlap reads and the existing-booking join with remaining
    // capacity; a full supplier would short-circuit before that join executes.
    await pool.query('UPDATE broker_providers SET total_capacity=20 WHERE id=$1', [providerId]);
    await pool.query('ANALYZE broker_agreement_bookings');
    await pool.query('ANALYZE broker_agreement_windows');
    const before = (await pool.query(`EXPLAIN(ANALYZE,BUFFERS,FORMAT JSON) ${sql}`, values))
      .rows[0]['QUERY PLAN'][0].Plan;
    const old = await bookedCurrent(true);
    await pool.query(
      `WITH added AS(INSERT INTO broker_agreement_windows(agreement_id,starts_at,discount_ends_at,ends_at,approved_quantity,committed_cents)
      SELECT $1,clock_timestamp()-n*interval '1 day'-interval '2 days',clock_timestamp()-n*interval '1 day'-interval '2 days'+interval '1 hour',clock_timestamp()-n*interval '1 day'-interval '2 days'+interval '2 hours',1,100 FROM generate_series(1,5000)n RETURNING *)
      INSERT INTO broker_agreement_bookings(agreement_id,window_id,provider_id,scheduled_offering_id,catalog_id,snapshot,quantity,unit_price_cents,starts_at,discount_ends_at,ends_at)
      SELECT $1,w.id,$2,$3,'micro','{}',1,100,w.starts_at,w.discount_ends_at,w.ends_at FROM added w`,
      [old.id, providerId, scheduledId],
    );
    await pool.query('ANALYZE broker_agreement_bookings');
    await pool.query('ANALYZE broker_agreement_windows');
    const after = (await pool.query(`EXPLAIN(ANALYZE,BUFFERS,FORMAT JSON) ${sql}`, values)).rows[0][
      'QUERY PLAN'
    ][0].Plan;
    function nodes(plan: Record<string, any>): Record<string, any>[] {
      return [plan, ...(plan.Plans ?? []).flatMap(nodes)];
    }
    const small = nodes(before),
      large = nodes(after);
    for (const set of [small, large])
      expect(
        set
          .filter((p) => p['Relation Name'] === 'broker_agreement_bookings')
          .every(
            (p) =>
              (Number(p['Actual Rows']) + Number(p['Rows Removed by Filter'] ?? 0)) *
                Number(p['Actual Loops']) <
              100,
          ),
      ).toBe(true);
    expect(large.some((p) => p['Index Name'] === 'broker_agreement_bookings_interval')).toBe(true);
  });
  it('commits provider admission denials before returning an error and replays them without duplicate receipts, credit or native work', async () => {
    const a = await bookedCurrent(),
      body = { operationKey: randomUUID(), windowId: a.windowId, quantity: 2 };
    await pool.query("UPDATE broker_catalog SET item=item||'{\"cpu\":2}' WHERE id='micro'");
    const first = await activateAgreement(ctx, a.id, buyer, body).then(
      () => null,
      (error) => error as HttpError,
    );
    expect(first).toMatchObject({ statusCode: 409 });
    expect(first?.message).toContain('[booked_configuration_changed]');
    const rows = (
      await pool.query(
        'SELECT * FROM broker_agreement_activations WHERE agreement_id=$1 ORDER BY item_number',
        [a.id],
      )
    ).rows;
    expect(rows).toHaveLength(2);
    expect(
      rows.every(
        (r) => r.status === 'failed' && r.cleaned_at && r.vm_id === null && r.request_id === null,
      ),
    ).toBe(true);
    expect(
      (await pool.query('SELECT kind FROM broker_agreement_actions WHERE agreement_id=$1', [a.id]))
        .rows[0].kind,
    ).toBe('activate_rejected');
    expect(
      (await pool.query('SELECT adjustment_cents FROM broker_agreements WHERE id=$1', [a.id]))
        .rows[0].adjustment_cents,
    ).toBe(200);
    const replay = await activateAgreement(ctx, a.id, buyer, body).then(
      () => null,
      (error) => error as HttpError,
    );
    expect(replay?.message).toBe(first?.message);
    expect(
      (
        await pool.query(
          'SELECT id FROM broker_agreement_activations WHERE agreement_id=$1 ORDER BY item_number',
          [a.id],
        )
      ).rows.map((r) => r.id),
    ).toEqual(rows.map((r) => r.id));
    await expect(
      activateAgreement(ctx, a.id, buyer, { ...body, operationKey: randomUUID() }),
    ).rejects.toMatchObject({ statusCode: 409 });
    expect(
      (
        await pool.query(
          'SELECT count(*) n FROM broker_agreement_adjustments WHERE agreement_id=$1',
          [a.id],
        )
      ).rows[0].n,
    ).toBe('2');
    expect(await creditWalletView(pool, buyer)).toMatchObject({
      balanceCents: 20000,
      reservedCents: 1200,
    });
    expect((await pool.query('SELECT count(*) n FROM broker_vms')).rows[0].n).toBe('0');
    expect((await pool.query('SELECT count(*) n FROM broker_requests')).rows[0].n).toBe('0');
    expect(ctx.boss.send).not.toHaveBeenCalled();
    expect(ctx.wick.create).not.toHaveBeenCalled();
    await pool.query("UPDATE broker_catalog SET item=$1 WHERE id='micro'", [catalog]);
    const recovered = await activateAgreement(ctx, a.id, buyer, {
      ...body,
      operationKey: randomUUID(),
    });
    for (const activated of recovered.activations) {
      const vm = (await pool.query('SELECT * FROM broker_vms WHERE id=$1', [activated.vmId]))
        .rows[0];
      await transaction(pool, (db) => scheduledActivationReady(ctx, db, vm));
    }
    expect(
      (await pool.query('SELECT adjustment_cents FROM broker_agreements WHERE id=$1', [a.id]))
        .rows[0].adjustment_cents,
    ).toBe(0);
    expect(
      (
        await pool.query(
          'SELECT count(*) n FROM broker_agreement_adjustments WHERE agreement_id=$1',
          [a.id],
        )
      ).rows[0].n,
    ).toBe('0');
  });
  it('settles a rejected provider start as an undelivered booked slot instead of charging it as idle capacity', async () => {
    const a = await bookedCurrent(),
      body = { operationKey: randomUUID(), windowId: a.windowId, quantity: 2 };
    await pool.query("UPDATE broker_catalog SET approved=false WHERE id='micro'");
    await expect(activateAgreement(ctx, a.id, buyer, body)).rejects.toThrow(
      /booked_catalog_unavailable/,
    );
    // Advance this private fixture's stored window to its settlement boundary; no native VM exists.
    await pool.query(
      "UPDATE broker_agreement_windows SET discount_ends_at=clock_timestamp()-interval '2 minutes',ends_at=clock_timestamp()-interval '1 minute' WHERE id=$1",
      [a.windowId],
    );
    await settleWindow(ctx, a.windowId);
    await settleWindow(ctx, a.windowId);
    expect(await creditWalletView(pool, buyer)).toMatchObject({
      balanceCents: 19000,
      reservedCents: 0,
    });
    const charge = (
      await pool.query('SELECT * FROM broker_agreement_charges WHERE window_id=$1', [a.windowId])
    ).rows[0];
    expect(charge).toMatchObject({ gross_cents: 1200, credit_cents: 200, total_cents: 1000 });
    expect(charge.revenue_share.brokerFeeMicros).toBe('1500000');
    expect(
      (await pool.query('SELECT settled_cents FROM broker_agreements WHERE id=$1', [a.id])).rows[0]
        .settled_cents,
    ).toBe(1000);
    await expect(activateAgreement(ctx, a.id, buyer, body)).rejects.toThrow(
      /booked_catalog_unavailable/,
    );
    expect(
      (
        await pool.query(
          'SELECT count(*) n FROM broker_agreement_activations WHERE agreement_id=$1',
          [a.id],
        )
      ).rows[0].n,
    ).toBe('2');
  });
  it('does not credit invalid buyer timing, ownership, quantities or concurrent-VM quota errors', async () => {
    const a = await bookedCurrent(),
      ended = await bookedCurrent(true),
      body = { operationKey: randomUUID(), windowId: a.windowId, quantity: 1 };
    await expect(activateAgreement(ctx, a.id, other, body)).rejects.toMatchObject({
      statusCode: 404,
    });
    await expect(
      activateAgreement(ctx, ended.id, buyer, { ...body, windowId: ended.windowId }),
    ).rejects.toThrow(/only inside this booked window/);
    await expect(activateAgreement(ctx, a.id, buyer, { ...body, quantity: 13 })).rejects.toThrow(
      /approved unused slots/,
    );
    await pool.query("UPDATE broker_settings SET value='1' WHERE key='maxConcurrentVms'");
    await activateAgreement(ctx, a.id, buyer, body);
    await pool.query("UPDATE broker_catalog SET approved=false WHERE id='micro'");
    await expect(
      activateAgreement(ctx, a.id, buyer, { ...body, operationKey: randomUUID() }),
    ).rejects.toThrow(/active VM limit/);
    expect((await pool.query('SELECT count(*) n FROM broker_agreement_actions')).rows[0].n).toBe(
      '1',
    );
    expect(
      (await pool.query('SELECT count(*) n FROM broker_agreement_adjustments')).rows[0].n,
    ).toBe('0');
  });
  it('preserves all-or-none VM creation but credits only the provider route that failed in a mixed batch', async () => {
    const a = await bookedCurrent();
    await pool.query(
      "INSERT INTO broker_catalog(id,item,approved) VALUES('second-micro',$1,true)",
      [{ ...catalog, id: 'second-micro' }],
    );
    const second = (
      await pool.query(
        "INSERT INTO broker_providers(user_id,name,total_capacity,policy) VALUES('second-provider','Second supplier',12,'{}') RETURNING id",
      )
    ).rows[0];
    const secondOffering = (
      await pool.query(
        `INSERT INTO broker_scheduled_offerings(provider_id,operation_key,input_fingerprint,catalog_id,name,kind,time_zone,weekdays,window_start,window_end,available_until,capacity_quantity,discount_rate_cents_per_hour,normal_rate_cents_per_hour) SELECT $1,'second-route-offer','test','second-micro','Second supplier','capacity_window',time_zone,weekdays,window_start,window_end,available_until,12,10,20 FROM broker_scheduled_offerings WHERE id=$2 RETURNING id`,
        [second.id, scheduledId],
      )
    ).rows[0];
    await pool.query('UPDATE broker_agreement_bookings SET quantity=1 WHERE id=$1', [a.bookingId]);
    await pool.query(
      `INSERT INTO broker_agreement_bookings(agreement_id,window_id,provider_id,scheduled_offering_id,catalog_id,snapshot,quantity,unit_price_cents,starts_at,discount_ends_at,ends_at) SELECT agreement_id,window_id,$2,$3,'second-micro',$4,1,100,starts_at,discount_ends_at,ends_at FROM broker_agreement_bookings WHERE id=$1`,
      [
        a.bookingId,
        second.id,
        secondOffering.id,
        {
          catalog: { ...catalog, id: 'second-micro' },
          providerName: 'Second supplier',
          offering: { discountRateCentsPerHour: 10, normalRateCentsPerHour: 20 },
        },
      ],
    );
    await pool.query("UPDATE broker_catalog SET item=item||'{\"cpu\":2}' WHERE id='micro'");
    await expect(
      activateAgreement(ctx, a.id, buyer, {
        operationKey: randomUUID(),
        windowId: a.windowId,
        quantity: 2,
      }),
    ).rejects.toThrow(/booked_configuration_changed/);
    const receipts = (
      await pool.query(
        'SELECT booking_id FROM broker_agreement_activations WHERE agreement_id=$1',
        [a.id],
      )
    ).rows;
    expect(receipts).toEqual([{ booking_id: a.bookingId }]);
    expect(
      (await pool.query('SELECT adjustment_cents FROM broker_agreements WHERE id=$1', [a.id]))
        .rows[0].adjustment_cents,
    ).toBe(100);
    expect((await pool.query('SELECT count(*) n FROM broker_vms')).rows[0].n).toBe('0');
    expect(ctx.boss.send).not.toHaveBeenCalled();
  });
  it('rejects uncertified real schedule publication and reactivation while retaining historical replay and allowing pauses', async () => {
    const real = { ...ctx, wick: { ...ctx.wick, mode: 'real' } } as AppContext;
    const managed = {
      ...catalog,
      provider: 'e2b',
      pricingMode: 'managed',
      rateMicrosPerSecond: 23,
      rateSource: 'wick-customer-catalog',
      rateRetrievedAt: new Date().toISOString(),
      managedRouteVerification: 'execution-preview-managed',
      maxTtlSeconds: 28800,
      deadlineEnforcement: 'supervised',
    };
    await pool.query("UPDATE broker_catalog SET source_mode='real',item=$1 WHERE id='micro'", [
      managed,
    ]);
    const app = Fastify();
    app.setErrorHandler((err, _req, reply) =>
      reply
        .status(err instanceof HttpError ? err.statusCode : 500)
        .send({ message: err instanceof Error ? err.message : 'Request failed' }),
    );
    await registerAgreements(app, real);
    const headers = { 'x-buyer': 'provider', 'x-role': 'provider' },
      payload = {
        operationKey: randomUUID(),
        catalogId: 'micro',
        name: 'Certified eight-hour schedule',
        kind: 'capacity_window',
        timeZone: 'UTC',
        weekdays: [0, 1, 2, 3, 4, 5, 6],
        windowStart: '00:00',
        windowEnd: '06:00',
        availableUntil: '08:00',
        capacityQuantity: 12,
        discountRateCentsPerHour: 10,
        normalRateCentsPerHour: 20,
      };
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/provider/scheduled-offerings',
          headers,
          payload,
        })
      ).statusCode,
    ).toBe(409);
    expect(
      (
        await app.inject({
          method: 'PATCH',
          url: `/api/provider/scheduled-offerings/${scheduledId}`,
          headers,
          payload: { active: false, expectedRevision: 1 },
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await app.inject({
          method: 'PATCH',
          url: `/api/provider/scheduled-offerings/${scheduledId}`,
          headers,
          payload: { active: true, expectedRevision: 2 },
        })
      ).statusCode,
    ).toBe(409);
    await pool.query(
      "UPDATE broker_catalog SET item=jsonb_set(item,'{deadlineEnforcement}','\"native\"') WHERE id='micro'",
    );
    const published = await app.inject({
      method: 'POST',
      url: '/api/provider/scheduled-offerings',
      headers,
      payload,
    });
    expect(published.statusCode).toBe(200);
    expect(published.json().deadlineEligible).toBe(true);
    await pool.query(
      "UPDATE broker_catalog SET item=jsonb_set(item,'{deadlineEnforcement}','\"supervised\"') WHERE id='micro'",
    );
    const replay = await app.inject({
      method: 'POST',
      url: '/api/provider/scheduled-offerings',
      headers,
      payload,
    });
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toMatchObject({ id: published.json().id, deadlineEligible: false });
    expect(ctx.wick.create).not.toHaveBeenCalled();
    await app.close();
  });
  it('paginates provider commitments in chronological window order instead of transaction timestamp and random UUID order', async () => {
    const a = await createAgreement(ctx, buyer, input());
    const app = Fastify();
    await registerAgreements(app, ctx);
    const starts: string[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 4; page++) {
      const response = await app.inject({
        url: `/api/provider/commitments?limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
        headers: { 'x-buyer': 'provider', 'x-role': 'provider' },
      });
      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.items.length).toBeLessThanOrEqual(2);
      expect(body.items.every((b: { timeZone: string }) => b.timeZone === 'UTC')).toBe(true);
      starts.push(...body.items.map((b: { startsAt: string }) => b.startsAt));
      cursor = body.nextCursor;
    }
    expect(cursor).toBeUndefined();
    expect(starts).toEqual(a.agreement.windows.map((w) => w.startsAt));
    await app.close();
  });
  it('limits candidates by full booked-block total so low-discount expensive-continuation offers cannot hide the cheaper total', async () => {
    await grant(buyer, 20000);
    await pool.query(
      `INSERT INTO broker_scheduled_offerings(provider_id,operation_key,input_fingerprint,catalog_id,name,kind,time_zone,weekdays,window_start,window_end,available_until,capacity_quantity,discount_rate_cents_per_hour,normal_rate_cents_per_hour) SELECT $1,'expensive-continuation-'||n,'test','micro','Low discount, expensive continuation','capacity_window','UTC',ARRAY[0,1,2,3,4,5,6],'00:00','06:00','08:00',20,1,100 FROM generate_series(1,70)n`,
      [providerId],
    );
    const result = await createAgreement(ctx, buyer, {
      ...input(),
      continuation: { enabled: true, until: '08:00', maxRateCentsPerHour: 100 },
    });
    expect(result.agreement.status).toBe('approved');
    expect(result.bookings.every((b) => b.unitPriceCents === 100)).toBe(true);
    expect(
      (
        await pool.query(
          'SELECT DISTINCT scheduled_offering_id FROM broker_agreement_bookings WHERE agreement_id=$1',
          [result.agreement.id],
        )
      ).rows,
    ).toEqual([{ scheduled_offering_id: scheduledId }]);
  });
  it('breaks equal block-total ties by earliest published offer before random UUID order', async () => {
    const earliest = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
    await pool.query(
      `INSERT INTO broker_scheduled_offerings(id,provider_id,operation_key,input_fingerprint,catalog_id,name,kind,time_zone,weekdays,window_start,window_end,available_until,capacity_quantity,discount_rate_cents_per_hour,normal_rate_cents_per_hour,created_at) VALUES($1,$2,'earliest-equal-total','test','micro','Earliest published equal price','capacity_window','UTC',ARRAY[0,1,2,3,4,5,6],'00:00','06:00','08:00',20,10,20,'2026-01-01T00:00:00.000001Z'),('00000000-0000-4000-8000-000000000001',$2,'later-equal-total','test','micro','Later published equal price','capacity_window','UTC',ARRAY[0,1,2,3,4,5,6],'00:00','06:00','08:00',20,10,20,'2026-01-01T00:00:00.000002Z')`,
      [earliest, providerId],
    );
    const result = await createAgreement(ctx, buyer, input());
    expect(result.agreement.status).toBe('approved');
    expect(
      (
        await pool.query(
          'SELECT DISTINCT scheduled_offering_id FROM broker_agreement_bookings WHERE agreement_id=$1',
          [result.agreement.id],
        )
      ).rows,
    ).toEqual([{ scheduled_offering_id: earliest }]);
  });
  it('refreshes one native snapshot outside admission locks, rejects a new rate drift durably, and preserves frozen funding and manual approvals', async () => {
    const a = await bookedCurrent(),
      managed = {
        ...catalog,
        provider: 'e2b',
        pricingMode: 'managed',
        rateMicrosPerSecond: 23,
        rateSource: 'wick-customer-catalog',
        rateRetrievedAt: new Date().toISOString(),
        managedRouteVerification: 'execution-preview-managed',
      };
    await pool.query("UPDATE broker_agreements SET source_mode='real' WHERE id=$1", [a.id]);
    await pool.query("UPDATE broker_catalog SET source_mode='real',item=$1 WHERE id='micro'", [
      managed,
    ]);
    await pool.query(
      "UPDATE broker_agreement_bookings SET snapshot=jsonb_set(snapshot,'{catalog}',$2) WHERE agreement_id=$1",
      [a.id, managed],
    );
    await pool.query(
      "INSERT INTO broker_catalog(id,item,approved,source_mode) VALUES('manual-disabled',$1,false,'real')",
      [{ ...managed, id: 'manual-disabled' }],
    );
    const frozen = (
      await pool.query(
        'SELECT snapshot,unit_price_cents FROM broker_agreement_bookings WHERE id=$1',
        [a.bookingId],
      )
    ).rows[0];
    let nativeRate = 24;
    const nativeCatalog = vi.fn(async () => {
      await transaction(pool, async (db) =>
        expect(
          (
            await db.query(
              "SELECT pg_try_advisory_xact_lock(hashtext('broker-global-vm-admission')) AS acquired",
            )
          ).rows[0].acquired,
        ).toBe(true),
      );
      return [
        { ...managed, rateMicrosPerSecond: nativeRate, rateRetrievedAt: new Date().toISOString() },
        { ...managed, id: 'manual-disabled', rateRetrievedAt: new Date().toISOString() },
      ] as unknown as CatalogItem[];
    });
    const real = {
      ...ctx,
      wick: { ...ctx.wick, mode: 'real', catalog: nativeCatalog },
    } as AppContext;
    const body = { operationKey: randomUUID(), windowId: a.windowId, quantity: 1 };
    await expect(activateAgreement(real, a.id, other, body)).rejects.toMatchObject({
      statusCode: 404,
    });
    expect(nativeCatalog).not.toHaveBeenCalled();
    await expect(activateAgreement(real, a.id, buyer, body)).rejects.toThrow(
      /frozen_cost_ceiling_exceeded/,
    );
    expect(nativeCatalog).toHaveBeenCalledTimes(1);
    expect(
      (
        await pool.query(
          "SELECT (item->>'rateMicrosPerSecond')::int rate FROM broker_catalog WHERE id='micro'",
        )
      ).rows[0].rate,
    ).toBe(24);
    expect(
      (await pool.query("SELECT approved FROM broker_catalog WHERE id='manual-disabled'")).rows[0]
        .approved,
    ).toBe(false);
    expect(
      (
        await pool.query(
          'SELECT snapshot,unit_price_cents FROM broker_agreement_bookings WHERE id=$1',
          [a.bookingId],
        )
      ).rows[0],
    ).toEqual(frozen);
    expect(
      (
        await pool.query(
          'SELECT reserved_cents,committed_cents,settled_cents FROM broker_agreements WHERE id=$1',
          [a.id],
        )
      ).rows[0],
    ).toMatchObject({ reserved_cents: 1200, committed_cents: 1200, settled_cents: 0 });
    await expect(activateAgreement(real, a.id, buyer, body)).rejects.toThrow(
      /frozen_cost_ceiling_exceeded/,
    );
    expect(nativeCatalog).toHaveBeenCalledTimes(1);
    nativeRate = 22;
    const result = await activateAgreement(real, a.id, buyer, {
      ...body,
      operationKey: randomUUID(),
    });
    expect(nativeCatalog).toHaveBeenCalledTimes(2);
    const vm = (
      await pool.query('SELECT create_input FROM broker_vms WHERE id=$1', [
        result.activations[0].vmId,
      ])
    ).rows[0];
    expect(vm.create_input.maximumPriceMicrosPerSecond).toBe(23);
    expect(ctx.wick.create).not.toHaveBeenCalled();
  });
  it('does not change bookings or grant financial failure credit when the current native catalog cannot be read', async () => {
    const a = await bookedCurrent();
    await pool.query("UPDATE broker_agreements SET source_mode='real' WHERE id=$1", [a.id]);
    const nativeCatalog = vi.fn(async () => {
        throw new Error('Untrusted upstream response body must not escape.');
      }),
      real = { ...ctx, wick: { ...ctx.wick, mode: 'real', catalog: nativeCatalog } } as AppContext;
    const before = (
        await pool.query('SELECT * FROM broker_agreement_bookings WHERE id=$1', [a.bookingId])
      ).rows[0],
      body = { operationKey: randomUUID(), windowId: a.windowId, quantity: 1 };
    await expect(activateAgreement(real, a.id, buyer, body)).rejects.toMatchObject({
      statusCode: 503,
      message: expect.stringContaining('Current native pricing could not be verified'),
    });
    expect(nativeCatalog).toHaveBeenCalledTimes(1);
    expect(
      (await pool.query('SELECT * FROM broker_agreement_bookings WHERE id=$1', [a.bookingId]))
        .rows[0],
    ).toEqual(before);
    for (const table of [
      'broker_agreement_actions',
      'broker_agreement_activations',
      'broker_agreement_adjustments',
      'broker_vms',
    ])
      expect((await pool.query(`SELECT count(*) n FROM ${table}`)).rows[0].n).toBe('0');
    expect(await creditWalletView(pool, buyer)).toMatchObject({
      balanceCents: 20000,
      reservedCents: 1200,
    });
    expect(ctx.wick.create).not.toHaveBeenCalled();
    expect(ctx.boss.send).not.toHaveBeenCalled();
  });
  it('rejects a changed reservation above the reviewed ceiling before creating an order or touching wallet credit', async () => {
    const spec = input(),
      before = await creditWalletView(pool, buyer),
      ledger = (await pool.query('SELECT count(*) n FROM broker_credit_ledger')).rows[0].n;
    await expect(
      createAgreement(ctx, buyer, { ...spec, maxReservationCents: 13999 }),
    ).rejects.toMatchObject({
      statusCode: 409,
      message: expect.stringContaining('reviewed credit ceiling'),
    });
    for (const table of [
      'broker_agreements',
      'broker_agreement_windows',
      'broker_agreement_bookings',
      'broker_agreement_activations',
      'broker_vms',
    ])
      expect((await pool.query(`SELECT count(*) n FROM ${table}`)).rows[0].n).toBe('0');
    expect(await creditWalletView(pool, buyer)).toEqual(before);
    expect((await pool.query('SELECT count(*) n FROM broker_credit_ledger')).rows[0].n).toBe(
      ledger,
    );
    expect(ctx.boss.send).not.toHaveBeenCalled();
    expect(ctx.wick.create).not.toHaveBeenCalled();
    const accepted = await createAgreement(ctx, buyer, { ...spec, maxReservationCents: 14000 });
    expect(accepted.agreement.status).toBe('approved');
    expect(accepted.agreement.reservedCents).toBe(14000);
    expect(accepted.agreement.specification.maxReservationCents).toBe(14000);
    const legacy = await createAgreement(ctx, other, input());
    expect(legacy.agreement.id).toBeTruthy();
    expect(legacy.agreement.specification.maxReservationCents).toBeUndefined();
  });
});
