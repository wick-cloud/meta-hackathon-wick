import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AppContext } from '../src/server/context.js';
import { proposeBid } from '../src/server/marketplace/auction.js';
import type { Actor, CatalogItem } from '../src/shared/types.js';

const actor: Actor = {
  id: 'budget-supplier',
  role: 'provider',
  name: 'Supplier',
  email: 'fixture@example.invalid',
};
const item: CatalogItem = {
  id: 'budget-small',
  name: 'Small',
  description: 'Offline fixture',
  provider: 'simulated-demo',
  profile: 'small',
  region: 'fixture',
  cpu: 2,
  memoryGb: 4,
  approved: true,
  durationMinutes: [15, 30, 60],
};

function fixture(remainingMs: number | string, readElapsedMs = 0, open = true) {
  let elapsed = 0;
  vi.spyOn(performance, 'now').mockImplementation(() => elapsed);
  const policy = { minimumPriceCents: 10, basePriceCents: 15, autoBid: true };
  const request = {
    id: 'budget-request',
    description: 'Small environment',
    catalog_id: item.id,
    catalog_snapshot: { ...item, sourceMode: 'fixture' },
    region: item.region,
    requirements: { cpu: 1, memoryGb: 1 },
    duration_minutes: 30,
    max_price_cents: 25,
    remaining_ms: remainingMs,
  };
  const query = vi.fn(async (sql: string) => {
    if (sql.includes('FROM broker_providers WHERE user_id'))
      return { rows: [{ id: 'budget-provider', user_id: actor.id, total_capacity: 5, policy }] };
    if (sql.includes('FROM broker_requests WHERE id')) return { rows: open ? [request] : [] };
    if (sql.includes('FROM broker_holds')) return { rows: [{ n: 0 }] };
    if (sql.includes('SELECT o.*,c.item AS catalog_item')) {
      elapsed = readElapsedMs;
      return {
        rows: [{ id: 'budget-offering', catalog_id: item.id, catalog_item: item, price_cents: 15 }],
      };
    }
    throw new Error('Unexpected query in bounded bid caller.');
  });
  const model = vi.fn(async () => ({
    decision: 'bid',
    catalogId: item.id,
    totalPriceCents: 15,
    modelCalled: true,
    receipt: { observed: [], decision: 'Offline test', constraints: [] },
  }));
  const ctx = {
    pool: { query },
    wick: { mode: 'fixture' },
    muse: { mode: 'real', proposeBid: model },
  } as unknown as AppContext;
  return { ctx, model, query };
}
afterEach(() => vi.restoreAllMocks());

describe('Muse bids stay within the remaining 30-second auction', () => {
  it('limits a new auction bid to eight seconds rather than the interactive model deadline', async () => {
    const f = fixture('30000', 250);
    const result = await proposeBid(f.ctx, actor, 'budget-request');
    expect(result.decision).toBe('bid');
    expect(f.model).toHaveBeenCalledWith(expect.objectContaining({ timeoutMs: 8000 }));
    expect(f.query).toHaveBeenCalledTimes(4);
  });

  it('subtracts eligibility-read time and a submission margin from database-relative remaining time', async () => {
    const f = fixture('3500.75', 1000);
    await proposeBid(f.ctx, actor, 'budget-request');
    expect(f.model).toHaveBeenCalledWith(expect.objectContaining({ timeoutMs: 1500 }));
    expect(f.query).toHaveBeenCalledTimes(4);
  });

  it.each([800, 1800, 'not-a-deadline'])(
    'does not spend a model call with exhausted/unverified budget %s',
    async (remaining) => {
      const f = fixture(remaining, 1000);
      await expect(proposeBid(f.ctx, actor, 'budget-request')).rejects.toMatchObject({
        statusCode: 409,
      });
      expect(f.model).not.toHaveBeenCalled();
      expect(f.query).toHaveBeenCalledTimes(4);
    },
  );

  it('does not query capacity or invoke the model for an already-closed auction', async () => {
    const f = fixture(0, 0, false);
    await expect(proposeBid(f.ctx, actor, 'budget-request')).rejects.toMatchObject({
      statusCode: 409,
    });
    expect(f.model).not.toHaveBeenCalled();
    expect(f.query).toHaveBeenCalledTimes(2);
  });
});
