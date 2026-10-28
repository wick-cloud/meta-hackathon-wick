import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import Fastify from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { migrate } from '../src/server/db.js';
import { HttpError, type AppContext } from '../src/server/context.js';
import { registerMarketplace } from '../src/server/marketplace/index.js';
import { revenueShare } from '../src/shared/pricing.js';
import type { Actor } from '../src/shared/types.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
const schema = `broker_earnings_${randomUUID().replaceAll('-', '')}`;
const providerId = randomUUID(),
  otherProviderId = randomUUID();
const offeringId = randomUUID(),
  otherOfferingId = randomUUID();
const actor: Actor = {
  id: 'earnings-provider',
  email: 'provider@test.invalid',
  name: 'Provider',
  role: 'provider',
};
const catalog = {
  id: 'earnings-fixture',
  name: 'Earnings fixture',
  provider: 'fixture',
  profile: 'small',
  region: 'test',
  cpu: 2,
  memoryGb: 4,
  durationMinutes: [30],
  approved: true,
};
// Keep identical to the production projection/order/limit, including the provider filter before pagination.
const earningsQuery = `SELECT i.*,i.created_at::text AS cursor_created_at,v.catalog_snapshot->>'name' AS catalog_name
 FROM broker_invoices i JOIN broker_vms v ON v.id=i.vm_id
 WHERE i.provider_id=$1 AND ($2::timestamptz IS NULL OR (i.created_at,i.id)<($2,$3::uuid))
 ORDER BY i.created_at DESC,i.id DESC LIMIT $4`;

describe.skipIf(!databaseUrl)('provider commission earnings (isolated PostgreSQL)', () => {
  let admin: Pool, pool: Pool;
  beforeAll(async () => {
    admin = new Pool({ connectionString: databaseUrl });
    await admin.query(`CREATE SCHEMA ${schema}`);
    pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema},public` });
    await migrate(pool);
  });
  beforeEach(async () => {
    await pool.query(
      'TRUNCATE broker_activity,broker_invoices,broker_vms,broker_holds,broker_bids,broker_requests,broker_offerings,broker_providers,broker_catalog CASCADE',
    );
    await pool.query('INSERT INTO broker_catalog(id,item,approved) VALUES($1,$2,true)', [
      catalog.id,
      catalog,
    ]);
    await pool.query(
      `INSERT INTO broker_providers(id,user_id,name,total_capacity,policy) VALUES($1,$2,'Own provider',1,'{}'),($3,'other-provider','Other provider',1,'{}')`,
      [providerId, actor.id, otherProviderId],
    );
    await pool.query(
      `INSERT INTO broker_offerings(id,provider_id,catalog_id,name,description,price_cents) VALUES($1,$2,$5,'Own offering','Fixture',200),($3,$4,$5,'Other offering','Fixture',200)`,
      [offeringId, providerId, otherOfferingId, otherProviderId, catalog.id],
    );
  });
  afterAll(async () => {
    await pool?.end();
    if (admin) {
      await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await admin.end();
    }
  });
  async function seed(count: number) {
    // One bounded SQL fixture statement; no API calls, customer information or compute allocations.
    await pool.query(
      `WITH generated AS MATERIALIZED (
    SELECT n,gen_random_uuid() AS request_id,gen_random_uuid() AS bid_id,gen_random_uuid() AS vm_id,
      CASE WHEN n%10=0 THEN $1::uuid ELSE $2::uuid END AS provider_id,
      CASE WHEN n%10=0 THEN $3::uuid ELSE $4::uuid END AS offering_id,
      CASE WHEN n%20=0 THEN NULL::jsonb ELSE $7::jsonb END AS revenue_share
    FROM generate_series(1,$8::integer) n
  ), requests AS (
    INSERT INTO broker_requests(id,buyer_id,description,catalog_id,catalog_snapshot,region,duration_minutes,max_price_cents,requirements,status)
    SELECT request_id,'private-fixture-buyer','Fixture',$5,$6,'test',30,200,'{"cpu":2,"memoryGb":4}','ready' FROM generated RETURNING id
  ), bids AS (
    INSERT INTO broker_bids(id,request_id,provider_id,offering_id,offering_snapshot,total_price_cents,status)
    SELECT g.bid_id,g.request_id,g.provider_id,g.offering_id,'{}',200,'won' FROM generated g JOIN requests r ON r.id=g.request_id RETURNING id
  ), vms AS (
    INSERT INTO broker_vms(id,request_id,buyer_id,provider_id,bid_id,create_key,create_input,catalog_snapshot,quote_snapshot,status,cleanup_confirmed_at)
    SELECT g.vm_id,g.request_id,'private-fixture-buyer',g.provider_id,g.bid_id,g.vm_id::text,'{}',$6,
      jsonb_build_object('totalPriceCents',200,'revenueShare',g.revenue_share),'terminated',now()
    FROM generated g JOIN bids b ON b.id=g.bid_id RETURNING id
  )
  INSERT INTO broker_invoices(vm_id,buyer_id,provider_id,subtotal_cents,total_cents,revenue_share,created_at)
  SELECT g.vm_id,'private-fixture-buyer',g.provider_id,200,200,g.revenue_share,'2026-10-28T12:00:00Z'
  FROM generated g JOIN vms v ON v.id=g.vm_id`,
      [
        providerId,
        otherProviderId,
        offeringId,
        otherOfferingId,
        catalog.id,
        catalog,
        revenueShare(200),
        count,
      ],
    );
  }
  it('authorizes providers, isolates earnings before stable pagination and leaves historical fees unassessed', async () => {
    await seed(30);
    let currentActor = actor;
    const app = Fastify();
    await registerMarketplace(app, {
      pool,
      requireActor: async (_request: unknown, roles: string[]) => {
        if (!roles.includes(currentActor.role)) throw new HttpError(403, 'Forbidden.');
        return currentActor;
      },
    } as unknown as AppContext);
    try {
      const expected = (
        await pool.query(
          'SELECT id,revenue_share FROM broker_invoices WHERE provider_id=$1 ORDER BY created_at DESC,id DESC',
          [providerId],
        )
      ).rows;
      const first = await app.inject({
        method: 'GET',
        url: `/api/provider/earnings?limit=2&providerId=${otherProviderId}`,
      });
      expect(first.statusCode).toBe(200);
      const page = first.json();
      expect(page.items).toHaveLength(2);
      expect(page.nextCursor).toBeTruthy();
      const second = (
        await app.inject({
          method: 'GET',
          url: `/api/provider/earnings?limit=2&cursor=${encodeURIComponent(page.nextCursor)}`,
        })
      ).json();
      const items = [...page.items, ...second.items];
      expect(items.map((x: any) => x.id)).toEqual(expected.map((x: any) => x.id));
      expect(second.nextCursor).toBeUndefined();
      expect(items.filter((x: any) => x.legacy)).toHaveLength(1);
      for (const item of items) {
        expect(item.totalCents).toBe(200);
        expect(item.label).toBe('No payment due');
        expect(item).not.toHaveProperty('buyerId');
        if (item.legacy) expect(item).not.toHaveProperty('revenueShare');
        else expect(item.revenueShare).toEqual(revenueShare(200));
      }
      currentActor = { ...actor, role: 'buyer' };
      expect((await app.inject({ method: 'GET', url: '/api/provider/earnings' })).statusCode).toBe(
        403,
      );
    } finally {
      await app.close();
    }
  });
  it('rejects incomplete, null, mispriced or rounded-up accounting while SQL NULL retains legacy invoices', async () => {
    await seed(10);
    const { id } = (
      await pool.query('SELECT id FROM broker_invoices WHERE provider_id=$1', [providerId])
    ).rows[0];
    const good = revenueShare(200);
    for (const bad of [
      {},
      { ...good, commissionBps: null },
      { ...good, providerNetMicros: null },
      { ...good, grossCents: 201 },
      { ...good, brokerFeeMicros: '300001' },
      { ...good, brokerFeeMicros: '300000.0' },
      { ...good, providerNetMicros: '1699999' },
      { ...good, commissionBps: '1500' },
    ]) {
      await expect(
        pool.query('UPDATE broker_invoices SET revenue_share=$1 WHERE id=$2', [bad, id]),
      ).rejects.toThrow();
      expect(
        (await pool.query('SELECT revenue_share FROM broker_invoices WHERE id=$1', [id])).rows[0]
          .revenue_share,
      ).toEqual(good);
    }
    await pool.query('UPDATE broker_invoices SET revenue_share=NULL WHERE id=$1', [id]);
    expect(
      (await pool.query('SELECT revenue_share FROM broker_invoices WHERE id=$1', [id])).rows[0]
        .revenue_share,
    ).toBeNull();
  });
  it('bounds page work with substantial unrelated history using the provider index', async () => {
    const samples: Record<string, unknown>[] = [];
    for (const count of [20, 10000]) {
      await seed(count);
      await pool.query('ANALYZE broker_invoices');
      await pool.query('ANALYZE broker_vms');
      const first = (await pool.query(earningsQuery, [providerId, null, null, 21])).rows;
      expect(first.length).toBeLessThanOrEqual(21);
      for (const cursor of [null, first.at(-1)]) {
        const args = [providerId, cursor?.cursor_created_at ?? null, cursor?.id ?? null, 21];
        const rows = (await pool.query(earningsQuery, args)).rows;
        expect(rows.length).toBeLessThanOrEqual(21);
        const explained = (
          await pool.query(`EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) ${earningsQuery}`, args)
        ).rows[0]['QUERY PLAN'][0];
        const nodes: any[] = [];
        function visit(node: any) {
          nodes.push(node);
          for (const child of node.Plans ?? []) visit(child);
        }
        visit(explained.Plan);
        if (count === 10000) {
          expect(nodes.some((n) => n['Index Name'] === 'broker_invoices_provider_page')).toBe(true);
          expect(
            nodes
              .filter((n) => n['Relation Name'] === 'broker_invoices')
              .every((n) => n['Node Type'] !== 'Seq Scan'),
          ).toBe(true);
          expect(
            nodes
              .filter((n) => n['Relation Name'] === 'broker_invoices')
              .reduce((sum, n) => sum + n['Actual Rows'] * n['Actual Loops'], 0),
          ).toBeLessThanOrEqual(21);
          expect(
            nodes
              .filter((n) => n['Relation Name'] === 'broker_invoices')
              .reduce((sum, n) => sum + (n['Rows Removed by Filter'] ?? 0) * n['Actual Loops'], 0),
          ).toBeLessThanOrEqual(21);
          expect(nodes.some((n) => (n['Sort Method'] ?? '').includes('external'))).toBe(false);
        }
        samples.push({
          fixtureRows: count,
          cursor: !!cursor,
          returned: rows.length,
          executionMs: explained['Execution Time'],
          sharedHitBlocks: explained.Plan['Shared Hit Blocks'],
          scans: nodes
            .filter((n) => n['Relation Name'])
            .map((n) => ({
              relation: n['Relation Name'],
              kind: n['Node Type'],
              index: n['Index Name'],
              rows: n['Actual Rows'],
              loops: n['Actual Loops'],
              removed: n['Rows Removed by Filter'] ?? 0,
            })),
        });
      }
    }
    console.info('Provider earnings query evidence:', JSON.stringify(samples));
  });
});
