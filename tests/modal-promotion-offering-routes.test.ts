import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import { registerMuse } from '../src/server/muse/index.js';
import type { AppContext } from '../src/server/context.js';
import type { CatalogItem } from '../src/shared/types.js';

// Intercepted SQL and model selection: no database, account writes or upstream calls.
describe('bounded server-priced offering suggestions', () => {
  for (const promoted of [false, true]) {
    it(`keeps 31 matching routes within the model's 30-candidate contract (promotion ${promoted})`, async () => {
      const items: CatalogItem[] = Array.from({ length: 31 }, (_, index) => ({
        id: `modal:route-${index}:auto`,
        name: `Route ${index}`,
        description: '',
        provider: 'modal',
        profile: 'small',
        region: 'auto',
        cpu: 2,
        memoryGb: 4,
        durationMinutes: [15, 30, 60],
        approved: true,
        pricingMode: 'managed',
        rateMicrosPerSecond: 100,
        rateSource: 'wick-customer-catalog',
        rateRetrievedAt: new Date().toISOString(),
        managedRouteVerification: 'execution-preview-managed',
      }));
      const policy = {
        autoBid: true,
        basePriceCents: promoted ? 1 : 25,
        minimumPriceCents: 1,
        maxPriceCents: promoted ? 1 : 100,
      };
      const proposeOfferings = vi.fn(async () => ({ proposals: [], mode: 'fixture' }));
      const query = vi.fn(async (sql: string) => {
        if (sql.startsWith('SELECT * FROM broker_providers'))
          return { rows: [{ id: 'provider', cloud_provider: 'modal', simulated: false, policy }] };
        if (sql.includes('SELECT id,item,approved FROM broker_catalog'))
          return { rows: items.map((item) => ({ id: item.id, item, approved: true })) };
        if (sql.includes('WITH recent_requests'))
          return {
            rows: [
              {
                region: 'any',
                durationMinutes: 30,
                requirements: { cpu: 2, memoryGb: 4 },
                count: 1,
              },
            ],
          };
        throw Error('Unexpected fixture SQL');
      });
      const app = Fastify();
      try {
        await registerMuse(app, {
          pool: { query },
          config: { modalComputePromotionEnabled: promoted },
          wick: { mode: 'real' },
          muse: { proposeOfferings },
          requireActor: async () => ({ id: 'provider-user', role: 'provider' }),
        } as unknown as AppContext);
        const response = await app.inject({
          method: 'POST',
          url: '/api/provider/offerings/propose',
          payload: {},
        });
        expect(response.statusCode).toBe(200);
        expect(proposeOfferings).toHaveBeenCalledOnce();
        const input = proposeOfferings.mock.calls[0] as unknown as [
          { pricedCandidates: Array<{ totalPriceCents: number }> },
        ];
        expect(input[0].pricedCandidates).toHaveLength(30);
        expect(
          input[0].pricedCandidates.every(
            (candidate) => candidate.totalPriceCents === (promoted ? 1 : 22),
          ),
        ).toBe(true);
      } finally {
        await app.close();
      }
    });
  }
});
