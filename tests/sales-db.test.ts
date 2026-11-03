import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import { Pool } from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { HttpError, type AppContext } from '../src/server/context.js';
import { migrate } from '../src/server/db.js';
import type { MuseAdapter } from '../src/server/integrations/types.js';
import { registerMarketplace } from '../src/server/marketplace/index.js';
import type { SalesAdviceInput, SalesAdviceSelection, SalesReport } from '../src/shared/sales.js';
import type { Actor, CatalogItem, Mode, SupplierPolicy } from '../src/shared/types.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
const schema = `broker_sales_${randomUUID().replaceAll('-', '')}`;
const origin = 'http://localhost:3000';
const providerId = randomUUID();
const otherProviderId = randomUUID();
const offeringId = randomUUID();
const owner: Actor = {
  id: 'sales-provider-owner',
  email: 'seller-private@example.invalid',
  name: 'E2B test seller',
  role: 'provider',
};
const policy: SupplierPolicy = {
  autoBid: false,
  minimumPriceCents: 10,
  basePriceCents: 100,
  maxPriceCents: 200,
  reserveSlots: 1,
  allowedCatalogIds: ['sales-e2b-micro'],
};
const catalog: CatalogItem = {
  id: 'sales-e2b-micro',
  name: 'E2B Micro',
  description: 'Approved test catalog',
  provider: 'e2b',
  profile: 'micro',
  region: 'us',
  cpu: 2,
  memoryGb: 4,
  durationMinutes: [15, 30, 60],
  approved: true,
  organizationId: 'private-wick-organization',
  groupId: 'private-wick-group',
};

function selectFirst(input: SalesAdviceInput): SalesAdviceSelection {
  const candidate = input.candidates[0];
  return {
    summary: candidate ? 'Review an available policy adjustment.' : 'Keep the current policy.',
    recommendations: candidate
      ? [
          {
            candidateId: candidate.id,
            explanation: 'This option addresses the supplied evidence and preserves your limits.',
            evidenceIds: candidate.evidenceIds.slice(0, 2),
          },
        ]
      : [],
    mode: 'fixture',
    modelCalled: false,
  };
}

describe.skipIf(!databaseUrl)('seller sales recommendations (isolated PostgreSQL)', () => {
  let admin: Pool;
  let pool: Pool;
  let app: FastifyInstance;
  let actor: Actor | null;
  let ctx: AppContext;
  const recommendSales = vi.fn<NonNullable<MuseAdapter['recommendSales']>>();
  const enqueue = vi.fn();

  beforeAll(async () => {
    admin = new Pool({ connectionString: databaseUrl });
    await admin.query(`CREATE SCHEMA ${schema}`);
    pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema},public` });
    await migrate(pool);
  });

  async function addCatalog(item: CatalogItem, mode: Mode = 'fixture') {
    await pool.query(
      'INSERT INTO broker_catalog(id,item,approved,source_mode) VALUES($1,$2,true,$3)',
      [item.id, item, mode],
    );
  }

  async function addRequest(item = catalog, mode: Mode = 'fixture', maxPriceCents = 95) {
    return (
      await pool.query(
        `INSERT INTO broker_requests(buyer_id,description,catalog_id,catalog_snapshot,region,
         duration_minutes,max_price_cents,requirements,status,created_at,closes_at)
         VALUES('private-buyer-identity','private customer prompt never for Muse',$1,$2,'us',
         30,$3,'{"cpu":2,"memoryGb":4}','no_offers',now()-interval '2 hours',now()-interval '1 hour')
         RETURNING id`,
        [item.id, { ...item, sourceMode: mode }, maxPriceCents],
      )
    ).rows[0].id as string;
  }

  beforeEach(async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => {
        throw new Error('No external calls in database tests');
      }),
    );
    recommendSales.mockReset();
    recommendSales.mockImplementation(async (input) => selectFirst(input));
    enqueue.mockReset();
    actor = { ...owner };
    await pool.query('TRUNCATE broker_providers,broker_catalog,broker_requests CASCADE');
    await addCatalog(catalog);
    await pool.query(
      `INSERT INTO broker_providers(id,user_id,name,total_capacity,policy,simulated,cloud_provider)
       VALUES($1,$2,'E2B test seller',5,$3,true,'e2b'),
             ($4,'other-private-seller','Other seller',8,$3,true,'daytona')`,
      [providerId, owner.id, policy, otherProviderId],
    );
    await pool.query(
      `INSERT INTO broker_offerings(id,provider_id,catalog_id,name,description,price_cents,active)
       VALUES($1,$2,$3,'Published Micro','Public offering',100,true)`,
      [offeringId, providerId, catalog.id],
    );
    await addRequest();
    app = Fastify();
    app.setErrorHandler((error: Error & { statusCode?: number }, _request, reply) =>
      reply.code(error.statusCode ?? 500).send({ error: error.message }),
    );
    ctx = {
      pool,
      config: { appUrl: origin },
      wick: { mode: 'fixture' },
      muse: { mode: 'fixture', recommendSales },
      boss: { send: enqueue },
      requireActor: async (_request: unknown, roles?: string[]) => {
        if (!actor) throw new HttpError(401, 'Sign in required.');
        if (roles && !roles.includes(actor.role)) throw new HttpError(403, 'Wrong role.');
        return actor;
      },
    } as unknown as AppContext;
    await registerMarketplace(app, ctx);
  });

  afterEach(async () => {
    await app?.close();
    expect(fetch).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  afterAll(async () => {
    await pool?.end();
    if (admin) {
      await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await admin.end();
    }
  });

  const propose = (requestOrigin: string | null = origin) =>
    app.inject({
      method: 'POST',
      url: '/api/provider/sales/propose',
      headers: requestOrigin ? { origin: requestOrigin } : {},
      payload: { goal: 'Help fill idle machines while preserving my floor and spare slots.' },
    });

  const providerState = async () =>
    (
      await pool.query(
        'SELECT policy,policy_revision,policy_apply_receipt,total_capacity FROM broker_providers WHERE id=$1',
        [providerId],
      )
    ).rows[0];

  it('returns reviewable recommendations without changing policy or reserving capacity', async () => {
    const before = await providerState();
    const response = await propose();
    expect(response.statusCode, response.body).toBe(200);
    const report = response.json<SalesReport>();
    expect(report).toMatchObject({
      baseRevision: before.policy_revision,
      currentPolicy: policy,
      mode: 'fixture',
      sourceMode: 'fixture',
      modelCalled: false,
      capacity: { total: 5, held: 0, available: 4 },
    });
    expect(report.recommendations.length).toBeGreaterThan(0);
    for (const recommendation of report.recommendations) {
      expect(recommendation.policy.minimumPriceCents).toBe(policy.minimumPriceCents);
      expect(recommendation.policy.reserveSlots).toBe(policy.reserveSlots);
      expect(recommendation.comparison.sampledRequests).toBe(1);
      expect(recommendation.evidenceIds.length).toBeGreaterThan(0);
    }
    expect(await providerState()).toEqual(before);
    expect((await pool.query('SELECT count(*)::int AS n FROM broker_holds')).rows[0].n).toBe(0);
    expect((await pool.query('SELECT count(*)::int AS n FROM broker_bids')).rows[0].n).toBe(0);
    expect(recommendSales).toHaveBeenCalledOnce();
  });

  it('passes only aggregate evidence and scenario data to Meta', async () => {
    await pool.query(
      `INSERT INTO broker_activity(provider_id,kind,message)
       VALUES($1,'bid_declined','private activity text and credential never for Muse')`,
      [providerId],
    );
    const response = await propose();
    expect(response.statusCode, response.body).toBe(200);
    const input = recommendSales.mock.calls[0]![0];
    expect(input.capacity).toEqual({ total: 5, held: 0, available: 4 });
    expect(input.evidence.length).toBeGreaterThan(0);
    expect(JSON.stringify(input)).not.toMatch(
      /private-buyer-identity|private customer prompt|seller-private@example|private-wick|private activity text/,
    );
  });

  it('isolates other sellers, foreign catalogs and the other Wick mode', async () => {
    expect((await propose()).statusCode).toBe(200);
    const baseline = recommendSales.mock.calls[0]![0];
    const foreign: CatalogItem = { ...catalog, id: 'sales-foreign-daytona', provider: 'daytona' };
    const real: CatalogItem = { ...catalog, id: 'sales-real-e2b' };
    await addCatalog(foreign);
    await addCatalog(real, 'real');
    await addRequest(foreign);
    const otherModeRequest = await addRequest(real, 'real');
    const foreignRequest = await addRequest(foreign, 'fixture', 150);
    const otherOffering = randomUUID();
    await pool.query(
      `INSERT INTO broker_offerings(id,provider_id,catalog_id,name,description,price_cents,active)
       VALUES($1,$2,$3,'Other private offering','Not this seller',80,true)`,
      [otherOffering, otherProviderId, foreign.id],
    );
    await pool.query(
      `INSERT INTO broker_bids(request_id,provider_id,offering_id,offering_snapshot,total_price_cents,status)
       VALUES($1,$2,$3,'{}',80,'won')`,
      [foreignRequest, otherProviderId, otherOffering],
    );
    await pool.query(
      `INSERT INTO broker_bids(request_id,provider_id,offering_id,offering_snapshot,total_price_cents,status)
       VALUES($1,$2,$3,'{}',90,'won')`,
      [otherModeRequest, providerId, offeringId],
    );
    await pool.query(
      `INSERT INTO broker_activity(provider_id,kind,message) VALUES($1,'bid_declined','foreign secret')`,
      [otherProviderId],
    );
    const response = await propose();
    expect(response.statusCode, response.body).toBe(200);
    expect(recommendSales.mock.calls[1]![0]).toEqual(baseline);
    expect(response.json<SalesReport>().catalogNames).not.toHaveProperty(foreign.id);
    expect(response.json<SalesReport>().catalogNames).not.toHaveProperty(real.id);
  });

  it('requires a provider owner session and the application origin', async () => {
    expect((await propose(null)).statusCode).toBe(403);
    expect((await propose('https://foreign.invalid')).statusCode).toBe(403);
    actor = null;
    expect((await propose()).statusCode).toBe(401);
    actor = { ...owner, role: 'buyer' };
    expect((await propose()).statusCode).toBe(403);
    actor = { ...owner, apiKey: { id: randomUUID(), scopes: ['muse:propose'], limits: {} } };
    expect((await propose()).statusCode).toBe(403);
    actor = { ...owner, id: 'unconfigured-provider' };
    expect((await propose()).statusCode).toBe(403);
    expect(recommendSales).not.toHaveBeenCalled();
  });

  it('rejects a policy or capacity revision changed while Meta was evaluating', async () => {
    let release!: () => void;
    let began!: () => void;
    const running = new Promise<void>((resolve) => {
      began = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    recommendSales.mockImplementationOnce(async (input) => {
      began();
      await gate;
      return selectFirst(input);
    });
    const request = propose();
    await running;
    await pool.query('UPDATE broker_providers SET total_capacity=6 WHERE id=$1', [providerId]);
    release();
    const response = await request;
    expect(response.statusCode, response.body).toBe(409);
    expect((await providerState()).policy).toEqual(policy);
    expect((await providerState()).total_capacity).toBe(6);
  });

  it('returns a failed real model call without simulated advice or policy changes', async () => {
    const before = await providerState();
    ctx.muse.mode = 'real';
    recommendSales.mockRejectedValueOnce(new HttpError(503, 'Muse is unavailable.'));
    const response = await propose();
    expect(response.statusCode).toBe(503);
    expect(response.json()).not.toHaveProperty('recommendations');
    expect(recommendSales).toHaveBeenCalledOnce();
    expect(await providerState()).toEqual(before);
  });

  it('reports no recommendations when there is no request evidence for a policy change', async () => {
    await pool.query('TRUNCATE broker_requests CASCADE');
    const before = await providerState();
    const response = await propose();
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json<SalesReport>().recommendations).toEqual([]);
    expect(recommendSales.mock.calls[0]![0].candidates).toEqual([]);
    expect(await providerState()).toEqual(before);
  });

  it('rejects overlapping analyses before making another model call', async () => {
    let release!: () => void;
    let began!: () => void;
    const running = new Promise<void>((resolve) => {
      began = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    recommendSales.mockImplementationOnce(async (input) => {
      began();
      await gate;
      return selectFirst(input);
    });
    const first = propose();
    await running;
    try {
      const overlapping = await propose();
      expect(overlapping.statusCode, overlapping.body).toBe(409);
      expect(recommendSales).toHaveBeenCalledOnce();
    } finally {
      release();
    }
    expect((await first).statusCode).toBe(200);
  });

  it('applies a reviewed policy once and rejects stale alternatives or changed retry bodies', async () => {
    const analysis = await propose();
    expect(analysis.statusCode, analysis.body).toBe(200);
    const report = analysis.json<SalesReport>();
    const recommendation = report.recommendations[0]!;
    expect(recommendation).toBeDefined();
    const attempt = {
      ...recommendation.policy,
      expectedRevision: report.baseRevision,
      operationKey: 'sales-reviewed-apply-123',
    };
    const apply = (body: typeof attempt) =>
      app.inject({
        method: 'PUT',
        url: '/api/provider/policy',
        headers: { origin },
        payload: body,
      });
    const first = await apply(attempt);
    expect(first.statusCode, first.body).toBe(200);
    expect(first.json().policy).toEqual(recommendation.policy);
    const after = await providerState();
    expect(after.policy_revision).toBe(report.baseRevision + 1);
    const replay = await apply(attempt);
    expect(replay.statusCode, replay.body).toBe(200);
    expect(replay.json()).toEqual(first.json());
    expect(await providerState()).toEqual(after);
    expect(
      (await apply({ ...attempt, basePriceCents: attempt.basePriceCents + 1 })).statusCode,
    ).toBe(409);
    expect(
      (await apply({ ...attempt, operationKey: 'sales-stale-alternative-456' })).statusCode,
    ).toBe(409);
    expect(await providerState()).toEqual(after);
    expect(
      (
        await pool.query(
          "SELECT count(*)::int AS n FROM broker_activity WHERE provider_id=$1 AND kind='policy_changed'",
          [providerId],
        )
      ).rows[0].n,
    ).toBe(1);
  });
});
