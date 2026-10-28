import Fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { rentalSourceLabel } from '../src/client/api.js';
import type { AppContext } from '../src/server/context.js';
import { registerMarketplace, startMarketplaceWorkers } from '../src/server/marketplace/index.js';

const apps: ReturnType<typeof Fastify>[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe('historical VM source mode after real mode cutover', () => {
  it.each([undefined, 'fixture', 'real'] as const)(
    'reports frozen %s source in buyer list and detail regardless of current mode',
    async (sourceMode) => {
      const vmId = 'f36352d9-f705-4ef3-872a-e14aa5648100';
      const row = {
        id: vmId,
        buyer_id: 'buyer',
        status: 'terminated',
        catalog_snapshot: {
          name: 'Historical environment',
          region: 'auto',
          ...(sourceMode ? { sourceMode } : {}),
        },
        create_input: { ttlSeconds: 900 },
        quote_snapshot: { totalPriceCents: 120 },
        cleanup_confirmed_at: new Date(),
        created_at: new Date(),
      };
      const app = Fastify();
      apps.push(app);
      const ctx = {
        wick: { mode: 'real' },
        requireActor: async () => ({ id: 'buyer', role: 'buyer' }),
        pool: { query: vi.fn(async () => ({ rows: [row] })) },
      } as unknown as AppContext;
      await registerMarketplace(app, ctx);
      const list = await app.inject({ method: 'GET', url: '/api/vms' });
      const detail = await app.inject({ method: 'GET', url: `/api/vms/${vmId}` });
      expect(list.statusCode).toBe(200);
      expect(detail.statusCode).toBe(200);
      const expected = sourceMode ?? 'fixture';
      expect(list.json().items[0].sourceMode).toBe(expected);
      expect(detail.json().sourceMode).toBe(expected);
      expect(rentalSourceLabel(detail.json().sourceMode)).toBe(
        expected === 'real' ? 'Real Wick VM' : 'Fixture simulation',
      );
    },
  );

  it('still refuses to start real workers with any unresolved prior-mode rental', async () => {
    const query = vi.fn(async () => ({ rows: [{ id: 'unresolved-fixture-vm' }] }));
    const createQueue = vi.fn();
    await expect(
      startMarketplaceWorkers({
        wick: { mode: 'real' },
        pool: { query },
        boss: { createQueue },
      } as unknown as AppContext),
    ).rejects.toThrow('Cannot switch Wick mode');
    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0]).toBeDefined();
    expect(createQueue).not.toHaveBeenCalled();
  });
});
