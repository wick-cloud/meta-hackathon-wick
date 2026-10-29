import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { migrate } from '../src/server/db.js';
import type { AppContext } from '../src/server/context.js';
import type { Actor, CatalogItem } from '../src/shared/types.js';
import { createRequest } from '../src/server/marketplace/auction.js';
import { createAgreement } from '../src/server/agreements/service.js';
import { activateAgreement } from '../src/server/agreements/activation.js';
import { acceptCounteroffer, createIntent } from '../src/server/marketplace/negotiation.js';
import { operationFingerprint } from '../src/server/operations.js';
import { publicCatalogView } from '../src/server/public-views.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
describe('Broker operation fingerprints and public catalog', () => {
  it('normalizes object keys and undefined without reordering arrays', () => {
    expect(operationFingerprint({ a: 1, b: { x: 2, y: 3 } })).toBe(
      operationFingerprint({ b: { y: 3, x: 2 }, a: 1, z: undefined }),
    );
    expect(operationFingerprint([1, 2])).not.toBe(operationFingerprint([2, 1]));
  });
  it('does not expose native credential or tenant identifiers', () => {
    const item = {
      id: 'micro',
      name: 'Micro',
      provider: 'test',
      region: 'us',
      profile: 'micro',
      description: 'Test',
      cpu: 1,
      memoryGb: 1,
      durationMinutes: [30],
      approved: true,
      organizationId: 'private-org',
      groupId: 'private-group',
      providerKeyId: 'private-provider-key',
      raw: { secret: 'private' },
    } as CatalogItem;
    const text = JSON.stringify(publicCatalogView(item));
    expect(text).not.toContain('private');
    expect(text).toContain('Micro');
  });
});

describe.skipIf(!databaseUrl)('Broker machine operations (disposable PostgreSQL)', () => {
  const schema = `broker_operations_${randomUUID().replaceAll('-', '')}`;
  let admin: Pool, pool: Pool, ctx: AppContext, actor: Actor;
  const body = {
    description: 'Customer agent environment',
    catalogId: 'fixture-micro',
    region: 'test-region',
    durationMinutes: 30,
    maxPriceCents: 50,
    requirements: { cpu: 1, memoryGb: 1 },
  };
  beforeAll(async () => {
    admin = new Pool({ connectionString: databaseUrl });
    await admin.query(`CREATE SCHEMA ${schema}`);
    pool = new Pool({
      connectionString: databaseUrl,
      max: 8,
      options: `-c search_path=${schema},public`,
    });
    await migrate(pool);
    const userId = randomUUID(),
      keyId = randomUUID();
    await pool.query(
      'INSERT INTO "user"(id,email,name,role,"emailVerified") VALUES($1,$2,$3,\'buyer\',true)',
      [userId, `${userId}@test.invalid`, 'Buyer'],
    );
    await pool.query(
      "INSERT INTO broker_api_keys(id,user_id,name,prefix,secret_digest,scopes,limits,issued_role,expires_at) VALUES($1,$2,'Agent',$3,$4,'[]','{}','buyer',now()+interval '30 days')",
      [keyId, userId, `wbk_${keyId}`, '0'.repeat(64)],
    );
    actor = {
      id: userId,
      name: 'Buyer',
      email: `${userId}@test.invalid`,
      role: 'buyer',
      apiKey: {
        id: keyId,
        scopes: ['orders:write', 'agreements:write', 'agreements:activate'],
        limits: { maxAuctionCents: 50, maxAgreementReservationCents: 7, maxActivationQuantity: 2 },
      },
    };
    const item = {
      id: body.catalogId,
      name: 'Micro',
      description: 'Fixture only',
      provider: 'fixture',
      profile: 'micro',
      region: body.region,
      cpu: 1,
      memoryGb: 1,
      durationMinutes: [15, 30, 60],
      approved: true,
    };
    await pool.query(
      "INSERT INTO broker_catalog(id,item,approved,source_mode) VALUES($1,$2,true,'fixture')",
      [item.id, item],
    );
    ctx = {
      pool,
      config: { maxConcurrentVms: 20 },
      boss: { send: vi.fn(async () => randomUUID()) },
      wick: {
        mode: 'fixture',
        create: vi.fn(() => {
          throw Error('No native allocation allowed');
        }),
      },
      muse: { mode: 'fixture' },
    } as unknown as AppContext;
  });
  afterAll(async () => {
    await pool?.end();
    if (admin) {
      await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await admin.end();
    }
  });
  it('commits one auction and one queue job across concurrent identical submissions', async () => {
    const input = { ...body, operationKey: 'same-auction-operation' };
    const results = await Promise.all(
      Array.from({ length: 8 }, () => createRequest(ctx, actor, input)),
    );
    expect(new Set(results.map((r) => r.id)).size).toBe(1);
    expect((await pool.query('SELECT count(*)::int n FROM broker_requests')).rows[0].n).toBe(1);
    expect(vi.mocked(ctx.boss.send)).toHaveBeenCalledTimes(1);
    expect(
      (await pool.query('SELECT source_api_key_id FROM broker_requests')).rows[0].source_api_key_id,
    ).toBe(actor.apiKey!.id);
    expect((await pool.query('SELECT count(*)::int n FROM broker_key_actions')).rows[0].n).toBe(1);
  });
  it('replays normalized defaults, rejects different inputs, and never expands key authority', async () => {
    const original = await createRequest(ctx, actor, {
      ...body,
      operationKey: 'normalized-auction',
    });
    const { durationMinutes: _duration, ...defaults } = body;
    expect(
      (await createRequest(ctx, actor, { ...defaults, operationKey: 'normalized-auction' })).id,
    ).toBe(original.id);
    await expect(
      createRequest(ctx, actor, {
        ...body,
        description: 'Different',
        operationKey: 'normalized-auction',
      }),
    ).rejects.toMatchObject({ statusCode: 409 });
    const smaller = { ...actor, apiKey: { ...actor.apiKey!, limits: { maxAuctionCents: 49 } } };
    await expect(
      createRequest(ctx, smaller, { ...body, operationKey: 'normalized-auction' }),
    ).rejects.toMatchObject({ statusCode: 403 });
    await expect(createRequest(ctx, actor, body)).rejects.toMatchObject({ statusCode: 400 });
  });
  it('checks agreement maximum across the full term and creates no VMs on approval', async () => {
    const startDate = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
    const input = {
      operationKey: 'bounded-agreement',
      description: 'Manual activation only',
      startDate,
      timeZone: 'UTC',
      windowStart: '00:00',
      windowEnd: '01:00',
      minimumQuantity: 1,
      targetQuantity: 1,
      requirements: { cpu: 1, memoryGb: 1 },
      region: 'any',
      maxDiscountRateCentsPerHour: 1,
    };
    const smaller = { ...actor.apiKey!, limits: { maxAgreementReservationCents: 6 } };
    await expect(createAgreement(ctx, actor.id, input, smaller)).rejects.toMatchObject({
      statusCode: 403,
    });
    await createAgreement(ctx, actor.id, input, actor.apiKey);
    expect((await pool.query('SELECT count(*)::int n FROM broker_vms')).rows[0].n).toBe(0);
    await expect(createAgreement(ctx, actor.id, input, smaller)).rejects.toMatchObject({
      statusCode: 403,
    });
  });
  it('checks activation quantity before native refresh and caps accepted alternatives', async () => {
    await expect(
      activateAgreement(
        ctx,
        randomUUID(),
        actor.id,
        { operationKey: 'activation-operation', windowId: randomUUID(), quantity: 3 },
        actor.apiKey,
      ),
    ).rejects.toMatchObject({ statusCode: 403 });
    const intent = await createIntent(ctx, actor, {
      operationKey: 'intent-operation',
      description: 'Nonbinding need',
      desired: {
        cpu: 1,
        memoryGb: 1,
        region: 'test-region',
        durationMinutes: 30,
        maxPriceCents: 100,
      },
    });
    await expect(
      acceptCounteroffer(ctx, actor, intent.id, randomUUID(), { operationKey: 'accept-operation' }),
    ).rejects.toMatchObject({ statusCode: 403 });
    expect(vi.mocked(ctx.wick.create)).not.toHaveBeenCalled();
  });
});
