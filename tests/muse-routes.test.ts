import Fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { registerMuse } from '../src/server/muse/index.js';
import { createMuseAdapter } from '../src/server/integrations/muse.js';
import { HttpError, type AppContext } from '../src/server/context.js';
import type { Mode, Role } from '../src/shared/types.js';

const apps: ReturnType<typeof Fastify>[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});
async function harness(role: Role | 'anonymous' = 'buyer', wickMode: Mode = 'fixture') {
  const app = Fastify();
  apps.push(app);
  app.setErrorHandler((error: Error & { statusCode?: number }, _request, reply) => {
    reply.code(error.statusCode ?? 500).send({ error: error.message });
  });
  const query = vi.fn(async (sql: string, params?: unknown[]) => {
    if (sql.includes('SELECT id,item,approved FROM broker_catalog'))
      return {
        rows: [
          {
            id: 'small',
            item: {
              id: 'small',
              approved: false,
              cpu: 2,
              memoryGb: 4,
              region: 'us-east',
              durationMinutes: [15, 30, 60],
            },
            approved: true,
          },
        ],
      };
    if (sql.includes('FROM broker_providers'))
      return {
        rows: [
          {
            id: 'provider-a',
            user_id: params?.[0],
            policy: { autoBid: true, minimumPriceCents: 30, basePriceCents: 50 },
          },
        ],
      };
    return {
      rows: [
        { region: 'us-east', durationMinutes: 30, requirements: { cpu: 2, memoryGb: 4 }, count: 3 },
      ],
    };
  });
  const translate = vi.fn(async (_description: string, _catalog: unknown[]) => ({
    mode: 'fixture',
    proposal: { catalogId: 'small' },
  }));
  const proposeOfferings = vi.fn(async (_input: unknown) => ({ mode: 'fixture', proposals: [] }));
  const requireActor = vi.fn(async (_request: unknown, roles?: Role[]) => {
    if (role === 'anonymous') throw new HttpError(401, 'Authentication required.');
    if (roles && !roles.includes(role)) throw new HttpError(403, 'Access denied.');
    return { id: 'actor-owned-id', email: 'test@example.invalid', name: 'Test', role };
  });
  const ctx = {
    config: {},
    pool: { query },
    wick: { mode: wickMode },
    muse: { translate, proposeOfferings },
    requireActor,
  } as unknown as AppContext;
  await registerMuse(app, ctx);
  return { app, query, translate, proposeOfferings, requireActor, ctx };
}

describe('Muse route authorization and input boundaries', () => {
  it('filters unrelated configurations and shows a 30-minute publish baseline for 15-minute demand', async () => {
    const { app, query, ctx } = await harness('provider');
    ctx.muse = createMuseAdapter(
      { museMode: 'fixture' },
      {
        fetch: () => {
          throw new Error('No Meta calls');
        },
      },
    );
    query.mockImplementation(async (sql: string) => {
      if (sql.includes('SELECT id,item,approved FROM broker_catalog'))
        return {
          rows: [
            {
              id: 'small',
              approved: true,
              item: {
                id: 'small',
                name: 'Small',
                description: '',
                provider: 'fixture',
                profile: 'small',
                region: 'us-east',
                cpu: 2,
                memoryGb: 4,
                durationMinutes: [15, 30, 60],
              },
            },
            {
              id: 'other',
              approved: true,
              item: {
                id: 'other',
                name: 'Other',
                description: '',
                provider: 'fixture',
                profile: 'small',
                region: 'eu',
                cpu: 2,
                memoryGb: 4,
                durationMinutes: [15, 30, 60],
              },
            },
          ],
        } as never;
      if (sql.includes('FROM broker_providers'))
        return {
          rows: [
            {
              id: 'provider-a',
              policy: { autoBid: false, minimumPriceCents: 30, basePriceCents: 50 },
            },
          ],
        } as never;
      return {
        rows: [
          {
            region: 'us-east',
            durationMinutes: 15,
            requirements: { cpu: 2, memoryGb: 4 },
            count: 3,
          },
        ],
      } as never;
    });
    const response = await app.inject({
      method: 'POST',
      url: '/api/provider/offerings/propose',
      payload: {},
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toMatchObject({
      mode: 'fixture',
      modelCalled: false,
      proposals: [
        {
          catalogId: 'small',
          durationMinutes: 30,
          priceCents: 50,
          priceBasis: 'server-priced-candidate',
        },
      ],
    });
    expect(response.json().proposals).toHaveLength(1);
  });
  it('rejects unauthenticated calls before reading data or invoking Muse', async () => {
    const { app, query, translate } = await harness('anonymous');
    const response = await app.inject({
      method: 'POST',
      url: '/api/muse/translate',
      payload: { description: 'Linux' },
    });
    expect(response.statusCode).toBe(401);
    expect(query).not.toHaveBeenCalled();
    expect(translate).not.toHaveBeenCalled();
  });
  it('requires a buyer for translation and a provider for offering suggestions', async () => {
    const provider = await harness('provider');
    expect(
      (
        await provider.app.inject({
          method: 'POST',
          url: '/api/muse/translate',
          payload: { description: 'Linux' },
        })
      ).statusCode,
    ).toBe(403);
    const buyer = await harness('buyer');
    expect(
      (
        await buyer.app.inject({
          method: 'POST',
          url: '/api/provider/offerings/propose',
          payload: {},
        })
      ).statusCode,
    ).toBe(403);
  });
  it.each(['fixture', 'real'] as const)(
    'uses administrator approval and isolates %s catalog data',
    async (mode) => {
      const { app, query, translate } = await harness('buyer', mode);
      const response = await app.inject({
        method: 'POST',
        url: '/api/muse/translate',
        payload: { description: 'Linux' },
      });
      expect(response.statusCode).toBe(200);
      expect(translate.mock.calls[0]).toEqual([
        'Linux',
        [
          {
            id: 'small',
            approved: true,
            cpu: 2,
            memoryGb: 4,
            region: 'us-east',
            durationMinutes: [15, 30, 60],
          },
        ],
      ]);
      const catalogQuery = query.mock.calls.find(([sql]) => sql.includes('FROM broker_catalog'));
      expect(catalogQuery?.[0]).toContain('WHERE source_mode=$1');
      expect(catalogQuery?.[1]).toEqual([mode]);
    },
  );
  it('obtains policy for authenticated supplier and uses only recorded aggregate demand', async () => {
    const { app, query, proposeOfferings } = await harness('provider');
    const response = await app.inject({
      method: 'POST',
      url: '/api/provider/offerings/propose',
      payload: {
        providerId: 'other-provider',
        demand: [{ description: 'untrusted-body' }],
        policy: { basePriceCents: 0 },
      },
    });
    expect(response.statusCode).toBe(200);
    const providerQuery = query.mock.calls.find(([sql]) => sql.includes('FROM broker_providers'));
    expect(providerQuery?.[0]).toContain('WHERE user_id=$1');
    expect(providerQuery?.[1]).toEqual(['actor-owned-id']);
    const catalogQuery = query.mock.calls.find(([sql]) => sql.includes('FROM broker_catalog'));
    expect(catalogQuery?.[0]).toContain('WHERE source_mode=$1');
    expect(catalogQuery?.[1]).toEqual(['fixture']);
    const suggestionInput = proposeOfferings.mock.calls[0]?.[0] as unknown as {
      policy: { basePriceCents: number };
      demand: unknown[];
    };
    expect(suggestionInput.policy.basePriceCents).toBe(50);
    expect(suggestionInput.demand).toEqual([
      { region: 'us-east', durationMinutes: 30, requirements: { cpu: 2, memoryGb: 4 }, count: 3 },
    ]);
    expect(JSON.stringify(suggestionInput)).not.toContain('other-provider');
    expect(JSON.stringify(suggestionInput)).not.toContain('untrusted-body');
    const demandQuery = query.mock.calls.find(([sql]) => sql.includes('WITH recent_requests'));
    expect(demandQuery?.[1]).toEqual(['fixture', ['small']]);
    expect(demandQuery?.[0]).toContain("interval '7 days'");
    expect(demandQuery?.[0]).toContain('resolution_request_id IS NULL');
    expect(suggestionInput).toMatchObject({
      pricedCandidates: [{ catalogId: 'small', durationMinutes: 30, totalPriceCents: 50 }],
    });
  });
  it('bounds repeated paid translation requests per authenticated actor', async () => {
    const { app, translate } = await harness();
    for (let index = 0; index < 10; index++)
      expect(
        (
          await app.inject({
            method: 'POST',
            url: '/api/muse/translate',
            payload: { description: 'Linux' },
          })
        ).statusCode,
      ).toBe(200);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/muse/translate',
          payload: { description: 'Linux' },
        })
      ).statusCode,
    ).toBe(429);
    expect(translate).toHaveBeenCalledTimes(10);
  });
});
