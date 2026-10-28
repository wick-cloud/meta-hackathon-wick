import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../src/server/config.js';
import type { AppContext } from '../src/server/context.js';
import { migrate } from '../src/server/db.js';
import { registerMarketplace } from '../src/server/marketplace/index.js';
import { createRequest, submitBid } from '../src/server/marketplace/auction.js';
import {
  availableForBids,
  normalizedPolicy,
  validatePolicy,
} from '../src/server/marketplace/policy.js';
import type { Actor, CatalogItem, SupplierPolicy } from '../src/shared/types.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
const schema = `broker_capacity_${randomUUID().replaceAll('-', '')}`;
const basePolicy: SupplierPolicy = {
  autoBid: false,
  minimumPriceCents: 5,
  basePriceCents: 10,
  maxPriceCents: 100,
  allowedCatalogIds: ['capacity-test'],
};
const catalog: CatalogItem = {
  id: 'capacity-test',
  name: 'Capacity fixture',
  description: 'Offline',
  provider: 'fixture',
  profile: 'small',
  region: 'us',
  cpu: 2,
  memoryGb: 4,
  durationMinutes: [15, 30, 60],
  approved: true,
};
const actor: Actor = {
  id: 'capacity-provider',
  role: 'provider',
  name: 'Owned supplier',
  email: 'supplier@test.invalid',
};
const buyer: Actor = {
  id: 'capacity-buyer',
  role: 'buyer',
  name: 'Buyer',
  email: 'buyer@test.invalid',
};
const receipt = {
  observed: ['Own capacity only'],
  decision: 'Keep two slots spare.',
  constraints: ['Provider review required'],
};

describe('capacity policy arithmetic and explicit validation', () => {
  it('legacy policies preserve limits and reserve zero; negative availability clamps to zero', () => {
    expect(normalizedPolicy(basePolicy)).toEqual({ ...basePolicy, reserveSlots: 0 });
    expect(availableForBids(3, 1, basePolicy)).toBe(2);
    expect(availableForBids(3, 1, { ...basePolicy, reserveSlots: 2 })).toBe(0);
    expect(availableForBids(1, 2, { ...basePolicy, reserveSlots: 2 })).toBe(0);
  });
  it('preserves omitted capabilities and requires explicit valid integer money/reserves', () => {
    expect(
      validatePolicy(
        { autoBid: true, minimumPriceCents: 6, basePriceCents: 10 },
        { ...basePolicy, reserveSlots: 2 },
      ),
    ).toEqual({ ...basePolicy, autoBid: true, minimumPriceCents: 6, reserveSlots: 2 });
    expect(() => validatePolicy({ ...basePolicy, minimumPriceCents: 0.5 })).toThrow('integer');
    expect(() => validatePolicy({ ...basePolicy, reserveSlots: -1 })).toThrow('integer');
    expect(() => validatePolicy({ ...basePolicy, reserveSlots: null })).toThrow('integer');
    expect(() => validatePolicy({ ...basePolicy, basePriceCents: 4 })).toThrow('at least');
    expect(() => validatePolicy({ ...basePolicy, allowedCatalogIds: [''] })).toThrow('catalog IDs');
  });
});

describe.skipIf(!databaseUrl)(
  'provider capacity manager HTTP and reservation invariants, offline',
  () => {
    let admin: Pool;
    let pool: Pool;
    let ctx: AppContext;
    let providerId: string;
    const app = Fastify();
    const propose = vi.fn(async () => ({
      policy: { ...basePolicy, reserveSlots: 2 },
      receipt,
      mode: 'fixture' as const,
      modelCalled: false,
    }));
    const allocate = vi.fn(async () => {
      throw new Error('No VM allocation permitted');
    });

    beforeAll(async () => {
      admin = new Pool({ connectionString: databaseUrl });
      await admin.query(`CREATE SCHEMA ${schema}`);
      pool = new Pool({
        connectionString: databaseUrl,
        options: `-c search_path=${schema},public`,
        max: 8,
      });
      await migrate(pool);
      ctx = {
        pool,
        config: loadConfig({
          NODE_ENV: 'test',
          DATABASE_URL: databaseUrl!,
          BETTER_AUTH_SECRET: 'capacity-offline-test-secret-32-chars',
          WICK_MODE: 'fixture',
          MUSE_MODE: 'fixture',
        }),
        boss: { send: vi.fn(async () => null) },
        wick: { mode: 'fixture', create: allocate },
        muse: { mode: 'fixture', proposeCapacityPolicy: propose },
        requireActor: async () => actor,
      } as unknown as AppContext;
      app.setErrorHandler((error: Error & { statusCode?: number }, _request, reply) =>
        reply.code(error.statusCode ?? 500).send({ error: error.message }),
      );
      await registerMarketplace(app, ctx);
    });
    beforeEach(async () => {
      await pool.query(
        'TRUNCATE broker_activity,broker_invoices,broker_vms,broker_holds,broker_bids,broker_requests,broker_offerings,broker_providers,broker_catalog CASCADE',
      );
      providerId = randomUUID();
      await pool.query('INSERT INTO broker_catalog(id,item,approved) VALUES($1,$2,true)', [
        catalog.id,
        catalog,
      ]);
      await pool.query(
        'INSERT INTO broker_providers(id,user_id,name,total_capacity,policy) VALUES($1,$2,$3,3,$4)',
        [providerId, actor.id, actor.name, basePolicy],
      );
      await pool.query(
        'INSERT INTO broker_providers(user_id,name,total_capacity,policy) VALUES($1,$2,999,$3)',
        [
          'competitor-private',
          'Hidden competitor',
          { ...basePolicy, minimumPriceCents: 88, basePriceCents: 99 },
        ],
      );
      await pool.query(
        'INSERT INTO broker_offerings(provider_id,catalog_id,name,description,price_cents) VALUES($1,$2,$3,$4,10)',
        [providerId, catalog.id, 'Own offering', 'Fixture'],
      );
      propose.mockReset();
      propose.mockResolvedValue({
        policy: { ...basePolicy, reserveSlots: 2 },
        receipt,
        mode: 'fixture',
        modelCalled: false,
      });
    });
    afterAll(async () => {
      await app.close();
      await pool?.end();
      if (admin) {
        await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
        await admin.end();
      }
      expect(allocate).not.toHaveBeenCalled();
    });
    const dashboard = async () =>
      (await app.inject({ method: 'GET', url: '/api/provider/dashboard' })).json();
    const apply = (policy: SupplierPolicy, expectedRevision: number, operationKey = randomUUID()) =>
      app.inject({
        method: 'PUT',
        url: '/api/provider/policy',
        payload: { ...policy, expectedRevision, operationKey },
      });
    const request = () =>
      createRequest(ctx, buyer, {
        description: 'Offline capacity invariant',
        catalogId: catalog.id,
        region: catalog.region,
        durationMinutes: 15,
        maxPriceCents: 100,
        requirements: { cpu: 2, memoryGb: 4 },
      });

    it('projects only the caller provider; proposing changes no limits, holds, requests or VMs', async () => {
      const result = await app.inject({
        method: 'POST',
        url: '/api/provider/policy/propose',
        payload: { strategy: 'Fill idle machines; keep two slots spare; never below $0.05.' },
      });
      expect(result.statusCode, result.body).toBe(200);
      expect(result.json()).toMatchObject({
        baseRevision: 1,
        mode: 'fixture',
        modelCalled: false,
        policy: { reserveSlots: 2 },
        capacity: { total: 3, held: 0, available: 3 },
      });
      expect(propose).toHaveBeenCalledWith({
        strategy: 'Fill idle machines; keep two slots spare; never below $0.05.',
        policy: { ...basePolicy, reserveSlots: 0 },
        capacity: { total: 3, held: 0, free: 3, available: 3 },
        catalogIds: [catalog.id],
      });
      expect(JSON.stringify(propose.mock.calls)).not.toContain('competitor-private');
      expect(await dashboard()).toMatchObject({ policyRevision: 1, policy: { reserveSlots: 0 } });
      for (const table of ['broker_holds', 'broker_requests', 'broker_vms'])
        expect((await pool.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n).toBe(0);
    });

    it('explicit apply persists limits/revision and reports sellable vs spare capacity', async () => {
      const result = await apply({ ...basePolicy, reserveSlots: 2 }, 1);
      expect(result.statusCode, result.body).toBe(200);
      expect(result.json()).toMatchObject({ policyRevision: 2, policy: { reserveSlots: 2 } });
      expect(await dashboard()).toMatchObject({
        policyRevision: 2,
        capacity: { total: 3, held: 0, free: 3, available: 1 },
      });
    });

    it('concurrent identical Apply retries return one durable response and write one activity', async () => {
      const key = randomUUID();
      const policy = { ...basePolicy, reserveSlots: 2 };
      const results = await Promise.all([apply(policy, 1, key), apply(policy, 1, key)]);
      expect(results.map((result) => result.statusCode)).toEqual([200, 200]);
      expect(results[0].json()).toEqual(results[1].json());
      expect(results[0].json()).toMatchObject({ policyRevision: 2, policy });
      expect(
        (
          await pool.query(
            "SELECT count(*)::int AS n FROM broker_activity WHERE provider_id=$1 AND kind='policy_changed'",
            [providerId],
          )
        ).rows[0].n,
      ).toBe(1);
      const stored = (
        await pool.query('SELECT policy_apply_receipt FROM broker_providers WHERE id=$1', [
          providerId,
        ])
      ).rows[0].policy_apply_receipt;
      expect(stored.response).toEqual(results[0].json());
      expect(stored.operationKey).toBe(key);
    });

    it('lost-response replay survives later capacity changes and JSON property order without mutation', async () => {
      const key = randomUUID();
      // Omitted capabilities are captured from the policy at the original revision.
      const input: SupplierPolicy = { autoBid: true, minimumPriceCents: 6, basePriceCents: 10 };
      const applied = await apply(input, 1, key);
      expect(applied.statusCode, applied.body).toBe(200);
      await pool.query('UPDATE broker_providers SET total_capacity=1 WHERE id=$1', [providerId]);
      const retry = await app.inject({
        method: 'PUT',
        url: '/api/provider/policy',
        payload: {
          operationKey: key,
          expectedRevision: 1,
          basePriceCents: 10,
          minimumPriceCents: 6,
          autoBid: true,
        },
      });
      expect(retry.statusCode, retry.body).toBe(200);
      expect(retry.json()).toEqual(applied.json());
      expect(retry.json().policy.allowedCatalogIds).toEqual(basePolicy.allowedCatalogIds);
      expect(await dashboard()).toMatchObject({ policyRevision: 3, capacity: { total: 1 } });
      expect(
        (
          await pool.query(
            "SELECT count(*)::int AS n FROM broker_activity WHERE provider_id=$1 AND kind='policy_changed'",
            [providerId],
          )
        ).rows[0].n,
      ).toBe(1);
    });

    it('rejects same-key changed input and stale different operations, retaining the accepted receipt', async () => {
      const key = randomUUID();
      const policy = { ...basePolicy, reserveSlots: 2 };
      const applied = await apply(policy, 1, key);
      expect(applied.statusCode).toBe(200);
      expect((await apply({ ...policy, reserveSlots: 1 }, 1, key)).statusCode).toBe(409);
      expect((await apply(policy, 2, key)).statusCode).toBe(409);
      expect((await apply({ ...policy, reserveSlots: 1 }, 1)).statusCode).toBe(409);
      expect(await dashboard()).toMatchObject({ policyRevision: 2, policy: { reserveSlots: 2 } });
      expect((await apply(policy, 1, key)).json()).toEqual(applied.json());
    });

    it('bounds receipts to the latest accepted Apply and keeps superseded operations stale', async () => {
      const firstKey = randomUUID();
      const lastKey = randomUUID();
      expect((await apply({ ...basePolicy, reserveSlots: 1 }, 1, firstKey)).statusCode).toBe(200);
      const latest = await apply({ ...basePolicy, reserveSlots: 2 }, 2, lastKey);
      expect(latest.statusCode).toBe(200);
      expect((await apply({ ...basePolicy, reserveSlots: 1 }, 1, firstKey)).statusCode).toBe(409);
      const stored = (
        await pool.query('SELECT policy_apply_receipt FROM broker_providers WHERE id=$1', [
          providerId,
        ])
      ).rows[0].policy_apply_receipt;
      expect(stored.operationKey).toBe(lastKey);
      expect(stored.response).toEqual(latest.json());
    });

    it('a new no-op Apply consumes a revision so superseded retries cannot write duplicate activity', async () => {
      const policy = { ...basePolicy, reserveSlots: 0 };
      const firstKey = randomUUID();
      const secondKey = randomUUID();
      const first = await apply(policy, 1, firstKey);
      expect(first.statusCode).toBe(200);
      const second = await apply(policy, 2, secondKey);
      expect(second.statusCode).toBe(200);
      expect(second.json()).toMatchObject({ policyRevision: 3, policy });
      expect((await apply(policy, 1, firstKey)).statusCode).toBe(409);
      expect((await apply({ ...policy, minimumPriceCents: 6 }, 1, firstKey)).statusCode).toBe(409);
      expect((await apply(policy, 2, secondKey)).json()).toEqual(second.json());
      expect(
        (
          await pool.query(
            "SELECT count(*)::int AS n FROM broker_activity WHERE provider_id=$1 AND kind='policy_changed'",
            [providerId],
          )
        ).rows[0].n,
      ).toBe(2);
      expect(await dashboard()).toMatchObject({ policyRevision: 3 });
    });

    it('scopes identical operation keys to the owning provider and rejects missing keys', async () => {
      const key = randomUUID();
      expect((await apply({ ...basePolicy, reserveSlots: 2 }, 1, key)).statusCode).toBe(200);
      ctx.requireActor = async () => ({ ...actor, id: 'competitor-private' });
      try {
        const result = await apply({ ...basePolicy, reserveSlots: 1 }, 1, key);
        expect(result.statusCode, result.body).toBe(200);
        expect(result.json()).toMatchObject({ policyRevision: 2, policy: { reserveSlots: 1 } });
      } finally {
        ctx.requireActor = async () => actor;
      }
      expect(await dashboard()).toMatchObject({ policyRevision: 2, policy: { reserveSlots: 2 } });
      const missing = await app.inject({
        method: 'PUT',
        url: '/api/provider/policy',
        payload: { ...basePolicy, expectedRevision: 2 },
      });
      expect(missing.statusCode).toBe(400);
    });

    it('does not hold provider locks during model calls and rejects their stale revision afterward', async () => {
      propose.mockImplementationOnce(async () => {
        // This update would wait indefinitely if the model were called under the row lock.
        await pool.query('UPDATE broker_providers SET total_capacity=4 WHERE id=$1', [providerId]);
        return {
          policy: { ...basePolicy, reserveSlots: 2 },
          receipt,
          mode: 'fixture',
          modelCalled: false,
        };
      });
      const result = await app.inject({
        method: 'POST',
        url: '/api/provider/policy/propose',
        payload: { strategy: 'Review current limits' },
      });
      expect(result.statusCode, result.body).toBe(200);
      expect(result.json().baseRevision).toBe(1);
      expect((await apply(result.json().policy, result.json().baseRevision)).statusCode).toBe(409);
      expect((await dashboard()).policyRevision).toBe(2);
    });

    it('capacity changes and direct administrative policy updates invalidate old proposals', async () => {
      expect(
        (await app.inject({ method: 'PUT', url: '/api/provider/capacity', payload: { total: 4 } }))
          .statusCode,
      ).toBe(200);
      expect((await apply({ ...basePolicy, reserveSlots: 2 }, 1)).statusCode).toBe(409);
      await pool.query(
        "UPDATE broker_providers SET policy=jsonb_set(policy,'{minimumPriceCents}','6') WHERE id=$1",
        [providerId],
      );
      expect((await apply({ ...basePolicy, reserveSlots: 1 }, 2)).statusCode).toBe(409);
      expect(await dashboard()).toMatchObject({
        policyRevision: 3,
        policy: { minimumPriceCents: 6 },
      });
    });

    it('concurrent reviewed applies have exactly one winner and require a revision', async () => {
      const results = await Promise.all([
        apply({ ...basePolicy, reserveSlots: 1 }, 1),
        apply({ ...basePolicy, reserveSlots: 2 }, 1),
      ]);
      expect(results.map((r) => r.statusCode).sort()).toEqual([200, 409]);
      expect(
        (await app.inject({ method: 'PUT', url: '/api/provider/policy', payload: basePolicy }))
          .statusCode,
      ).toBe(400);
      expect((await dashboard()).policyRevision).toBe(2);
    });

    it('malformed or hallucinated model limits never activate', async () => {
      propose.mockResolvedValueOnce({
        policy: { ...basePolicy, reserveSlots: 4 },
        receipt,
        mode: 'fixture',
        modelCalled: false,
      });
      expect(
        (
          await app.inject({
            method: 'POST',
            url: '/api/provider/policy/propose',
            payload: { strategy: 'Review only' },
          })
        ).statusCode,
      ).toBe(422);
      propose.mockResolvedValueOnce({
        policy: { ...basePolicy, reserveSlots: 0, allowedCatalogIds: ['hallucinated'] },
        receipt,
        mode: 'fixture',
        modelCalled: false,
      });
      expect(
        (
          await app.inject({
            method: 'POST',
            url: '/api/provider/policy/propose',
            payload: { strategy: 'Review only' },
          })
        ).statusCode,
      ).toBe(422);
      expect((await dashboard()).policyRevision).toBe(1);
    });

    it('reserve capacity is atomic for competing manual and auto bids', async () => {
      expect((await apply({ ...basePolicy, autoBid: true, reserveSlots: 2 }, 1)).statusCode).toBe(
        200,
      );
      const requests = await Promise.all([request(), request(), request()]);
      const results = await Promise.allSettled(
        requests.map((r, index) =>
          submitBid(ctx, actor, r.id, { totalPriceCents: 10 }, index === 1 ? 'auto' : 'manual'),
        ),
      );
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      expect(results.filter((r) => r.status === 'rejected')).toHaveLength(2);
      expect(
        (await pool.query('SELECT count(*)::int AS n FROM broker_holds WHERE released_at IS NULL'))
          .rows[0].n,
      ).toBe(1);
      expect(await dashboard()).toMatchObject({ capacity: { held: 1, free: 2, available: 0 } });
    });

    it('manual and auto bids enforce current approved floor; existing holds survive reduced limits', async () => {
      const first = await request();
      await expect(submitBid(ctx, actor, first.id, { totalPriceCents: 4 })).rejects.toThrow(
        'pricing policy',
      );
      await submitBid(ctx, actor, first.id, { totalPriceCents: 5 });
      expect((await apply({ ...basePolicy, autoBid: true, reserveSlots: 3 }, 1)).statusCode).toBe(
        200,
      );
      const second = await request();
      await expect(
        submitBid(ctx, actor, second.id, { totalPriceCents: 4 }, 'auto'),
      ).rejects.toThrow('pricing policy');
      await expect(
        submitBid(ctx, actor, second.id, { totalPriceCents: 5 }, 'auto'),
      ).rejects.toThrow('reserved');
      expect(
        (await pool.query('SELECT count(*)::int AS n FROM broker_holds WHERE released_at IS NULL'))
          .rows[0].n,
      ).toBe(1);
    });
  },
);
