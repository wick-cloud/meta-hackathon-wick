import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import { bidView, vmView } from '../src/server/marketplace/data.js';
import { registerMarketplace } from '../src/server/marketplace/index.js';
import type { AppContext } from '../src/server/context.js';

describe('bounded auction and cleanup attribution', () => {
  it('leaves historical bid provenance unknown instead of inventing a source', () => {
    expect(bidView({ id: 'legacy', offering_snapshot: {} }).source).toBeNull();
    expect(bidView({ id: 'new', offering_snapshot: { bidSource: 'auto' } }).source).toBe('auto');
  });

  it('returns actual cleanup confirmation independently of the lifecycle label', () => {
    const row = { status: 'terminated', cleanup_confirmed_at: new Date('2026-10-29T17:00:00Z') };
    expect(vmView(row)).toMatchObject({
      cleanupConfirmedAt: '2026-10-29T17:00:00.000Z',
      cleanupPending: false,
    });
    expect(vmView({ status: 'terminating' })).toMatchObject({
      cleanupConfirmedAt: null,
      cleanupPending: true,
    });
  });

  it('attributes model receipts to requests within the authenticated provider page query', async () => {
    const app = Fastify();
    const query = vi.fn(async (sql: string, params: unknown[]) => {
      if (sql.includes('FROM broker_providers')) {
        expect(params).toEqual(['actor-owned']);
        return { rows: [{ id: 'provider-owned', user_id: 'actor-owned', policy: {} }] };
      }
      expect(sql).toContain('FROM broker_activity WHERE provider_id=$1');
      expect(params).toEqual(['provider-owned', null, null, 2]);
      return {
        rows: [
          {
            id: 1,
            request_id: 'exact-order',
            kind: 'proposal',
            created_at: new Date('2026-10-29T17:00:00Z'),
            receipt: { observed: [], decision: 'Eligible', constraints: [] },
            mode: 'real',
            model_called: true,
          },
        ],
      };
    });
    const requireActor = vi.fn(async () => ({ id: 'actor-owned', role: 'provider' }));
    try {
      await registerMarketplace(app, { pool: { query }, requireActor } as unknown as AppContext);
      const response = await app.inject('/api/provider/activity?limit=1');
      expect(response.statusCode).toBe(200);
      expect(response.json().items[0]).toMatchObject({
        requestId: 'exact-order',
        mode: 'real',
        modelCalled: true,
      });
      expect(requireActor).toHaveBeenCalledWith(expect.anything(), ['provider']);
      expect(query).toHaveBeenCalledTimes(2);
    } finally {
      await app.close();
    }
  });
});
