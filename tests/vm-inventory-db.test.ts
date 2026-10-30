import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import Fastify, { type FastifyRequest } from 'fastify';
import { Pool } from 'pg';
import { migrate } from '../src/server/db.js';
import { HttpError, type AppContext } from '../src/server/context.js';
import {
  inventoryQuery,
  listVmInventory,
  registerVmInventory,
} from '../src/server/marketplace/inventory.js';

describe.skipIf(!process.env.TEST_DATABASE_URL)(
  'buyer VM inventory on disposable PostgreSQL',
  () => {
    const schema = `vm_inventory_${randomUUID().replaceAll('-', '')}`,
      owner = 'inventory-owner',
      other = 'another-owner';
    const catalogId = 'inventory-test';
    let admin: Pool, pool: Pool, provider: string, offering: string;
    beforeAll(async () => {
      admin = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
      await admin.query(`CREATE SCHEMA ${schema}`);
      pool = new Pool({
        connectionString: process.env.TEST_DATABASE_URL,
        max: 4,
        options: `-c search_path=${schema},public`,
      });
      await migrate(pool);
      await pool.query('INSERT INTO broker_catalog(id,item,approved) VALUES($1,$2,true)', [
        catalogId,
        { id: catalogId, name: 'Small Linux', cpu: 2, memoryGb: 4, provider: 'e2b' },
      ]);
      provider = (
        await pool.query(
          "INSERT INTO broker_providers(user_id,name,total_capacity,policy) VALUES('supplier','E2B',5,'{}') RETURNING id",
        )
      ).rows[0].id;
      offering = (
        await pool.query(
          "INSERT INTO broker_offerings(provider_id,catalog_id,name,description,price_cents) VALUES($1,$2,'Small','Fixture',173.31) RETURNING id",
          [provider, catalogId],
        )
      ).rows[0].id;
    });
    beforeEach(async () => {
      await pool.query('TRUNCATE broker_requests CASCADE');
    });
    afterAll(async () => {
      await pool?.end();
      if (admin) {
        await admin.query(`DROP SCHEMA ${schema} CASCADE`);
        await admin.end();
      }
    });
    async function vm(
      options: {
        buyer?: string;
        status?: string;
        cleanup?: boolean;
        name?: string;
        created?: string;
        provider?: string;
      } = {},
    ) {
      const request = (
        await pool.query(
          "INSERT INTO broker_requests(buyer_id,description,catalog_id,catalog_snapshot,region,duration_minutes,max_price_cents,requirements,status) VALUES($1,'Fixture VM',$2,'{}','us-east',30,200,'{}','ready') RETURNING id",
          [options.buyer ?? owner, catalogId],
        )
      ).rows[0].id;
      const bid = (
        await pool.query(
          "INSERT INTO broker_bids(request_id,provider_id,offering_id,offering_snapshot,total_price_cents,status) VALUES($1,$2,$3,'{}',173.31,'won') RETURNING id",
          [request, provider, offering],
        )
      ).rows[0].id;
      return (
        await pool.query(
          `INSERT INTO broker_vms(request_id,buyer_id,provider_id,bid_id,status,create_key,create_input,catalog_snapshot,quote_snapshot,created_at,expires_at,cleanup_confirmed_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,clock_timestamp()+interval '30 minutes',CASE WHEN $11 THEN clock_timestamp() ELSE NULL END) RETURNING id`,
          [
            request,
            options.buyer ?? owner,
            provider,
            bid,
            options.status ?? 'running',
            randomUUID(),
            { privateAdmission: 'fixture-secret-must-not-leak' },
            {
              name: options.name ?? 'Small Linux',
              provider: options.provider ?? 'e2b',
              sourceMode: 'real',
              region: 'us-east',
              cpu: 2,
              memoryGb: 4,
              resources: { cpu: 4, memoryGb: 8 },
            },
            { totalPriceCents: 173.31, billingSource: 'instant_vm' },
            options.created ?? new Date().toISOString(),
            options.cleanup ?? false,
          ],
        )
      ).rows[0].id;
    }
    it('returns only owned snapshot fields, with actual frozen resources and exact price', async () => {
      const id = await vm();
      await vm({ buyer: other });
      const page = await listVmInventory(pool, owner, {});
      expect(page.items).toHaveLength(1);
      expect(page.items[0]).toMatchObject({
        id,
        provider: 'e2b',
        providerName: 'E2B',
        cpu: 4,
        memoryGb: 8,
        priceCents: 173.31,
        sourceMode: 'real',
      });
      expect(JSON.stringify(page)).not.toContain('fixture-secret');
      expect(JSON.stringify(page)).not.toContain('create_input');
      expect((await listVmInventory(pool, other, { search: id })).items).toHaveLength(0);
    });
    it('keeps cleanup-held failures active and moves only confirmed history into History', async () => {
      const running = await vm(),
        held = await vm({ status: 'failed' }),
        ended = await vm({ status: 'failed', cleanup: true });
      expect(
        (await listVmInventory(pool, owner, { status: 'active' })).items.map((v) => v.id).sort(),
      ).toEqual([running, held].sort());
      expect(
        (await listVmInventory(pool, owner, { status: 'past' })).items.map((v) => v.id),
      ).toEqual([ended]);
      expect((await listVmInventory(pool, owner, { status: 'failed' })).items).toHaveLength(2);
    });
    it('searches literal names or IDs and filters the snapshot provider before pagination', async () => {
      const literal = await vm({ name: '100%_safe', provider: 'modal' });
      await vm({ name: '100XXsafe' });
      expect(
        (await listVmInventory(pool, owner, { search: '100%_' })).items.map((v) => v.id),
      ).toEqual([literal]);
      expect(
        (await listVmInventory(pool, owner, { search: literal })).items.map((v) => v.id),
      ).toEqual([literal]);
      expect(
        (await listVmInventory(pool, owner, { provider: 'modal' })).items.map((v) => v.id),
      ).toEqual([literal]);
    });
    for (const sort of ['newest', 'oldest'])
      it(`paginates ${sort} in both directions without losing timestamp microseconds`, async () => {
        const ids = [];
        for (let n = 1; n <= 5; n++)
          ids.push(await vm({ created: `2026-10-30T20:00:00.00000${n}Z` }));
        const expected = sort === 'newest' ? [...ids].reverse() : ids;
        const first = await listVmInventory(pool, owner, { sort, limit: 2 });
        const second = await listVmInventory(pool, owner, {
          sort,
          limit: 2,
          cursor: first.nextCursor,
        });
        const third = await listVmInventory(pool, owner, {
          sort,
          limit: 2,
          cursor: second.nextCursor,
        });
        expect([...first.items, ...second.items, ...third.items].map((v) => v.id)).toEqual(
          expected,
        );
        expect(
          (
            await listVmInventory(pool, owner, { sort, limit: 2, before: second.previousCursor })
          ).items.map((v) => v.id),
        ).toEqual(first.items.map((v) => v.id));
        expect(
          (
            await listVmInventory(pool, owner, { sort, limit: 2, before: third.previousCursor })
          ).items.map((v) => v.id),
        ).toEqual(second.items.map((v) => v.id));
        expect(third.nextCursor).toBeUndefined();
        expect(first.previousCursor).toBeUndefined();
      });
    it('keeps one query and page-sized enrichment with substantial unrelated history', async () => {
      const id = await vm();
      await pool.query(
        `WITH r AS(INSERT INTO broker_requests(buyer_id,description,catalog_id,catalog_snapshot,region,duration_minutes,max_price_cents,requirements,status,created_at)
      SELECT CASE WHEN n<=6000 THEN $1 ELSE $2 END,'History',$3,'{}','us-east',30,200,'{}','ready',clock_timestamp()-n*interval '1 minute' FROM generate_series(1,7000)n RETURNING id,buyer_id,created_at),
      b AS(INSERT INTO broker_bids(request_id,provider_id,offering_id,offering_snapshot,total_price_cents,status) SELECT id,$4,$5,'{}',100,'won' FROM r RETURNING id,request_id)
      INSERT INTO broker_vms(request_id,buyer_id,provider_id,bid_id,status,create_key,create_input,catalog_snapshot,quote_snapshot,created_at,cleanup_confirmed_at)
      SELECT r.id,r.buyer_id,$4,b.id,'terminated',r.id::text,'{}',$6,'{}',r.created_at,clock_timestamp() FROM r JOIN b ON b.request_id=r.id`,
        [
          owner,
          other,
          catalogId,
          provider,
          offering,
          { name: 'Historical Linux', provider: 'e2b' },
        ],
      );
      await pool.query('ANALYZE broker_vms');
      await pool.query('ANALYZE broker_providers');
      const queries: { sql: string; values: unknown[]; rows: number }[] = [];
      const bounded = {
        query: async (sql: string, values: unknown[]) => {
          const result = await pool.query(sql, values);
          queries.push({ sql, values, rows: result.rows.length });
          return result;
        },
      } as unknown as Pool;
      const page = await listVmInventory(bounded, owner, { limit: 25 });
      expect(page.items).toHaveLength(25);
      expect(queries).toHaveLength(1);
      expect(queries[0].rows).toBe(26);
      const plan = (
        await pool.query(
          `EXPLAIN(ANALYZE,BUFFERS,FORMAT JSON) ${queries[0].sql}`,
          queries[0].values,
        )
      ).rows[0]['QUERY PLAN'][0];
      expect(JSON.stringify(plan)).toContain('broker_vms_buyer_page');
      queries.length = 0;
      expect((await listVmInventory(bounded, owner, { search: id })).items).toHaveLength(1);
      const exact = (
        await pool.query(
          `EXPLAIN(ANALYZE,BUFFERS,FORMAT JSON) ${queries[0].sql}`,
          queries[0].values,
        )
      ).rows[0]['QUERY PLAN'][0];
      expect(JSON.stringify(exact)).toContain('broker_vms_pkey');
      queries.length = 0;
      expect(
        (await listVmInventory(bounded, owner, { search: 'Historical', status: 'past' })).items,
      ).toHaveLength(30);
      const filtered = (
        await pool.query(
          `EXPLAIN(ANALYZE,BUFFERS,FORMAT JSON) ${queries[0].sql}`,
          queries[0].values,
        )
      ).rows[0]['QUERY PLAN'][0];
      expect(filtered.Plan['Actual Rows']).toBeLessThanOrEqual(31);
      expect(queries).toHaveLength(1);
    });
    it('rejects malformed filters and enforces the buyer-only browser endpoint', async () => {
      for (const query of [
        { limit: 101 },
        { status: 'paused' },
        { sort: 'price' },
        { provider: 'x/y' },
        { search: 'x'.repeat(101) },
        { cursor: 'bad' },
        { cursor: 'x', before: 'y' },
      ])
        expect(() => inventoryQuery(query)).toThrow(HttpError);
      const app = Fastify();
      app.setErrorHandler((e, _r, reply) =>
        reply.code((e as HttpError).statusCode ?? 500).send({ error: 'Rejected' }),
      );
      registerVmInventory(app, {
        pool,
        requireActor: async (request: FastifyRequest) => {
          if (request.headers['x-role'] === 'provider') throw new HttpError(403, 'Buyer only');
          return {
            id: (request.headers['x-buyer'] as string) ?? owner,
            role: 'buyer',
            ...(request.headers['x-key'] ? { apiKey: { id: 'fixture-key' } } : {}),
          };
        },
      } as unknown as AppContext);
      try {
        const id = await vm();
        expect((await app.inject('/api/vm-inventory')).statusCode).toBe(200);
        expect(
          (await app.inject({ url: '/api/vm-inventory', headers: { 'x-role': 'provider' } }))
            .statusCode,
        ).toBe(403);
        expect(
          (await app.inject({ url: '/api/vm-inventory', headers: { 'x-key': 'yes' } })).statusCode,
        ).toBe(403);
        expect(
          (
            await app.inject({
              url: `/api/vm-inventory?search=${id}`,
              headers: { 'x-buyer': other },
            })
          ).json().items,
        ).toHaveLength(0);
      } finally {
        await app.close();
      }
    });
  },
);
