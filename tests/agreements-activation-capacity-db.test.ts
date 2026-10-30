import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { migrate } from '../src/server/db.js';
import type { AppContext } from '../src/server/context.js';
import { activateAgreement } from '../src/server/agreements/activation.js';
import { submitBid } from '../src/server/marketplace/auction.js';
import { confirmCleanup } from '../src/server/marketplace/lifecycle.js';
import type { Actor } from '../src/shared/types.js';

const url = process.env.TEST_DATABASE_URL;
const schema = `agreement_physical_${randomUUID().replaceAll('-', '')}`;
const buyer = 'capacity-review-buyer';
const catalog = {
  id: 'capacity-micro',
  name: 'Micro',
  description: 'Local fixture',
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

describe.skipIf(!url)(
  'scheduled activations retain physical provider occupancy (isolated PostgreSQL)',
  () => {
    let admin: Pool, pool: Pool, ctx: AppContext;
    beforeAll(async () => {
      admin = new Pool({ connectionString: url, max: 1 });
      await admin.query(`CREATE SCHEMA ${schema}`);
      pool = new Pool({
        connectionString: url,
        max: 8,
        options: `-c search_path=${schema},public`,
      });
      await migrate(pool);
      ctx = {
        pool,
        config: { maxConcurrentVms: 20, wickOrganizationId: 'test-org', wickGroupId: 'test-group' },
        wick: {
          mode: 'fixture',
          create: vi.fn(() => {
            throw new Error('Native calls are forbidden.');
          }),
        },
        boss: { send: vi.fn(async () => randomUUID()) },
      } as unknown as AppContext;
    }, 30000);
    beforeEach(async () => {
      vi.clearAllMocks();
      await pool.query(
        'TRUNCATE broker_catalog,broker_providers,broker_agreements,broker_credit_wallets CASCADE',
      );
      await pool.query(
        "INSERT INTO broker_catalog(id,item,approved) VALUES('capacity-micro',$1,true)",
        [catalog],
      );
    });
    afterAll(async () => {
      await pool?.end();
      if (admin) {
        await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
        await admin.end();
      }
    });

    async function provider(capacity: number, reserveSlots = 0) {
      const userId = randomUUID();
      const row = (
        await pool.query(
          'INSERT INTO broker_providers(user_id,name,total_capacity,policy) VALUES($1,$1,$2,$3) RETURNING id',
          [
            userId,
            capacity,
            {
              minimumPriceCents: 1,
              basePriceCents: 5,
              reserveSlots,
              allowedCatalogIds: [catalog.id],
              autoBid: true,
            },
          ],
        )
      ).rows[0];
      const scheduledId = (
        await pool.query(
          `INSERT INTO broker_scheduled_offerings(provider_id,operation_key,input_fingerprint,catalog_id,name,kind,time_zone,weekdays,window_start,window_end,available_until,capacity_quantity,discount_rate_cents_per_hour,normal_rate_cents_per_hour) VALUES($1,$2,'fixture',$3,'Scheduled','capacity_window','UTC',ARRAY[0,1,2,3,4,5,6],'00:00','06:00','08:00',$4,10,20) RETURNING id`,
          [row.id, randomUUID(), catalog.id, Math.min(20, capacity)],
        )
      ).rows[0].id;
      const offeringId = (
        await pool.query(
          "INSERT INTO broker_offerings(provider_id,catalog_id,name,description,price_cents) VALUES($1,$2,'Instant','Local fixture',5) RETURNING id",
          [row.id, catalog.id],
        )
      ).rows[0].id;
      return {
        id: row.id as string,
        scheduledId,
        offeringId,
        actor: {
          id: userId,
          role: 'provider',
          name: userId,
          email: 'fixture@example.invalid',
        } as Actor,
      };
    }
    async function booked(
      supply: { provider: Awaited<ReturnType<typeof provider>>; quantity: number }[],
    ) {
      const total = supply.reduce((sum, s) => sum + s.quantity, 0);
      const startsAt = new Date(Date.now() - 3600000).toISOString();
      const discountEndsAt = new Date(Date.now() + 1800000).toISOString();
      const endsAt = new Date(Date.now() + 3600000).toISOString();
      const id = (
        await pool.query(
          `INSERT INTO broker_agreements(buyer_id,operation_key,input_fingerprint,description,specification,status,target_quantity,minimum_quantity,starts_at,expires_at,time_zone,source_mode,max_amount_cents,reserved_cents,committed_cents,accepting_topups) VALUES($1,$2,'fixture','Current booked capacity',$3,'approved',$4,$4,$5,$6,'UTC','fixture',$7,$7,$7,false) RETURNING id`,
          [
            buyer,
            randomUUID(),
            { requirements: { cpu: 1, memoryGb: 1 } },
            total,
            startsAt,
            endsAt,
            total * 100,
          ],
        )
      ).rows[0].id;
      const windowId = (
        await pool.query(
          'INSERT INTO broker_agreement_windows(agreement_id,starts_at,discount_ends_at,ends_at,approved_quantity,committed_cents) VALUES($1,$2,$3,$4,$5,$6) RETURNING id',
          [id, startsAt, discountEndsAt, endsAt, total, total * 100],
        )
      ).rows[0].id;
      await pool.query(
        'INSERT INTO broker_credit_wallets(buyer_id,balance_cents,reserved_cents) VALUES($1,20000,$2)',
        [buyer, total * 100],
      );
      for (const s of supply)
        await pool.query(
          `INSERT INTO broker_agreement_bookings(agreement_id,window_id,provider_id,scheduled_offering_id,catalog_id,snapshot,quantity,unit_price_cents,starts_at,discount_ends_at,ends_at) VALUES($1,$2,$3,$4,$5,$6,$7,100,$8,$9,$10)`,
          [
            id,
            windowId,
            s.provider.id,
            s.provider.scheduledId,
            catalog.id,
            {
              catalog,
              providerName: 'Fixture',
              offering: { discountRateCentsPerHour: 10, normalRateCentsPerHour: 20 },
              revision: 1,
            },
            s.quantity,
            startsAt,
            discountEndsAt,
            endsAt,
          ],
        );
      return { id, windowId };
    }
    async function instantRequest(status = 'open') {
      return (
        await pool.query(
          `INSERT INTO broker_requests(buyer_id,description,catalog_id,catalog_snapshot,region,duration_minutes,max_price_cents,requirements,status,closes_at) VALUES($1,'Instant',$2,$3,'test-region',30,5,$4,$5,clock_timestamp()+interval '30 seconds') RETURNING id`,
          [
            buyer,
            catalog.id,
            { ...catalog, sourceMode: 'fixture' },
            { cpu: 1, memoryGb: 1 },
            status,
          ],
        )
      ).rows[0].id as string;
    }
    async function oldUncleanedVm(p: Awaited<ReturnType<typeof provider>>) {
      const requestId = await instantRequest('ready');
      const bidId = (
        await pool.query(
          "INSERT INTO broker_bids(request_id,provider_id,offering_id,offering_snapshot,total_price_cents,status) VALUES($1,$2,$3,'{}',5,'won') RETURNING id",
          [requestId, p.id, p.offeringId],
        )
      ).rows[0].id;
      await pool.query('INSERT INTO broker_holds(bid_id,provider_id) VALUES($1,$2)', [bidId, p.id]);
      return (
        await pool.query(
          `INSERT INTO broker_vms(request_id,buyer_id,provider_id,bid_id,status,environment_id,create_key,create_input,catalog_snapshot,quote_snapshot,expires_at) VALUES($1,$2,$3,$4,'terminating',$5,$6,'{}',$7,'{}',clock_timestamp()-interval '5 minutes') RETURNING id`,
          [
            requestId,
            buyer,
            p.id,
            bidId,
            randomUUID(),
            randomUUID(),
            { ...catalog, sourceMode: 'fixture' },
          ],
        )
      ).rows[0].id as string;
    }
    const activate = (a: { id: string; windowId: string }, quantity: number) =>
      activateAgreement(ctx, a.id, buyer, {
        operationKey: randomUUID(),
        windowId: a.windowId,
        quantity,
      });

    it('blocks 12 starts over two uncertain old VMs, starts ten, and retains the last two booked rights until cleanup', async () => {
      const p = await provider(12),
        a = await booked([{ provider: p, quantity: 12 }]);
      const old = [await oldUncleanedVm(p), await oldUncleanedVm(p)];
      await expect(activate(a, 12)).rejects.toMatchObject({ statusCode: 409 });
      expect(
        (await pool.query('SELECT count(*)::int n FROM broker_agreement_activations')).rows[0].n,
      ).toBe(0);
      expect((await activate(a, 10)).activations).toHaveLength(10);
      expect(
        (
          await pool.query(
            'SELECT count(*)::int n FROM broker_holds WHERE provider_id=$1 AND released_at IS NULL',
            [p.id],
          )
        ).rows[0].n,
      ).toBe(12);
      await expect(activate(a, 2)).rejects.toMatchObject({ statusCode: 409 });
      expect(
        (
          await pool.query('SELECT quantity FROM broker_agreement_bookings WHERE window_id=$1', [
            a.windowId,
          ])
        ).rows[0].quantity,
      ).toBe(12);
      for (const vm of old) await confirmCleanup(ctx, vm);
      expect((await activate(a, 2)).activations).toHaveLength(2);
      expect(
        (
          await pool.query(
            'SELECT balance_cents,reserved_cents FROM broker_credit_wallets WHERE buyer_id=$1',
            [buyer],
          )
        ).rows[0],
      ).toMatchObject({ balance_cents: 20000, reserved_cents: 1200 });
      expect(ctx.wick.create).not.toHaveBeenCalled();
    });

    it('selects another booked supplier when the first supplier has no physical slots', async () => {
      const first = await provider(2),
        second = await provider(3);
      const a = await booked([
        { provider: first, quantity: 2 },
        { provider: second, quantity: 3 },
      ]);
      await oldUncleanedVm(first);
      await oldUncleanedVm(first);
      const result = await activate(a, 3);
      const rows = (
        await pool.query('SELECT DISTINCT provider_id FROM broker_vms WHERE id=ANY($1::uuid[])', [
          result.activations.map((a) => a.vmId),
        ])
      ).rows;
      expect(rows).toEqual([{ provider_id: second.id }]);
    });

    it('counts existing scheduled runtimes once while preserving the supplier spare-slot reserve', async () => {
      const p = await provider(12, 2),
        a = await booked([{ provider: p, quantity: 10 }]);
      expect((await activate(a, 4)).activations).toHaveLength(4);
      expect((await activate(a, 6)).activations).toHaveLength(6);
      expect(
        (
          await pool.query(
            'SELECT count(*)::int n FROM broker_holds WHERE provider_id=$1 AND released_at IS NULL',
            [p.id],
          )
        ).rows[0].n,
      ).toBe(10);
      await expect(activate(a, 1)).rejects.toMatchObject({ statusCode: 409 });
    });

    it('rejects an instant hold that would consume fully booked global capacity on another supplier', async () => {
      const bookedProvider = await provider(20),
        freeProvider = await provider(20);
      const a = await booked([{ provider: bookedProvider, quantity: 20 }]);
      await expect(
        submitBid(ctx, freeProvider.actor, await instantRequest(), {
          offeringId: freeProvider.offeringId,
          totalPriceCents: 5,
        }),
      ).rejects.toMatchObject({ statusCode: 409 });
      expect((await activate(a, 20)).activations).toHaveLength(20);
    });

    it('counts multiple supplier bids on one instant request as one global reservation beside booked rights', async () => {
      const bookedProvider = await provider(19),
        one = await provider(20),
        two = await provider(20);
      const a = await booked([{ provider: bookedProvider, quantity: 19 }]);
      const request = await instantRequest();
      await submitBid(ctx, one.actor, request, { offeringId: one.offeringId, totalPriceCents: 5 });
      await submitBid(ctx, two.actor, request, { offeringId: two.offeringId, totalPriceCents: 5 });
      await expect(
        submitBid(ctx, one.actor, await instantRequest(), {
          offeringId: one.offeringId,
          totalPriceCents: 5,
        }),
      ).rejects.toMatchObject({ statusCode: 409 });
      expect((await activate(a, 19)).activations).toHaveLength(19);
    });
  },
);
