import { describe, expect, it, vi } from 'vitest';
import { createMuseAdapter } from '../src/server/integrations/muse.js';
import { automaticBidPrices, availableForBids } from '../src/server/marketplace/policy.js';
import type { CatalogItem, SupplierPolicy } from '../src/shared/types.js';

const policy: SupplierPolicy = {
  autoBid: true,
  minimumPriceCents: 7,
  basePriceCents: 10,
  maxPriceCents: 20,
};
const item: CatalogItem = {
  id: 'strategy-small',
  name: 'Strategy small',
  description: 'Offline test',
  provider: 'fixture',
  profile: 'small',
  region: 'auto',
  cpu: 2,
  memoryGb: 4,
  durationMinutes: [15, 30, 60],
  approved: true,
};
const input = () => ({
  request: {
    description: 'Small environment',
    catalogId: item.id,
    region: item.region,
    durationMinutes: 30,
    maxPriceCents: 12,
    requirements: { cpu: 2, memoryGb: 4 },
  },
  policy,
  availableCapacity: 3,
  catalog: [item],
  suggestedTotalPriceCents: 10,
  discountTotalPriceCents: 9,
});
function model(value: unknown) {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
    new Response(
      JSON.stringify({
        choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(value) } }],
      }),
      { status: 200 },
    ),
  );
  return {
    fetcher,
    adapter: createMuseAdapter(
      { museMode: 'real', metaApiKey: 'offline-test-key' },
      { fetch: fetcher },
    ),
  };
}

describe('capacity-aware server bid prices', () => {
  it('offers at most ten percent off only with surplus and at least half of unreserved slots free', () => {
    expect(automaticBidPrices(policy, 7, 6, 3)).toEqual({
      basePriceCents: 10,
      discountPriceCents: 9,
    });
    expect(automaticBidPrices(policy, 7, 6, 2)).toEqual({ basePriceCents: 10 });
    expect(automaticBidPrices(policy, 7, 1, 1)).toEqual({ basePriceCents: 10 });
    const reserved = { ...policy, reserveSlots: 2 };
    expect(availableForBids(6, 2, reserved)).toBe(2);
    expect(automaticBidPrices(reserved, 7, 6, 2)).toEqual({
      basePriceCents: 10,
      discountPriceCents: 9,
    });
  });

  it('never discounts through the effective floor or rounds beyond the discount limit', () => {
    expect(automaticBidPrices(policy, 9.5, 6, 6)).toEqual({
      basePriceCents: 10,
      discountPriceCents: 9.5,
    });
    expect(automaticBidPrices(policy, 11, 6, 6)).toEqual({ basePriceCents: 11 });
    expect(automaticBidPrices({ ...policy, basePriceCents: 10.01 }, 7, 6, 6)).toEqual({
      basePriceCents: 10.01,
      discountPriceCents: 9.01,
    });
  });
});

describe('optional discount decision and base-price bid', () => {
  it('offers the server discount when Muse accepts it', async () => {
    const { adapter, fetcher } = model({ decision: 'bid', catalogId: item.id });
    const bid = await adapter.proposeBid(input());
    expect(bid).toMatchObject({ decision: 'bid', totalPriceCents: 9, modelCalled: true });
    const payload = JSON.parse(String(fetcher.mock.calls[0]![1]!.body));
    expect(JSON.parse(payload.messages[1].content)).toMatchObject({
      baseTotalPriceCents: 10,
      totalPriceCents: 9,
    });
  });

  it('still offers the unchanged base when Muse declines a discount', async () => {
    const { adapter } = model({ decision: 'decline', catalogId: null });
    const bid = await adapter.proposeBid(input());
    expect(bid).toMatchObject({
      decision: 'bid',
      catalogId: item.id,
      totalPriceCents: 10,
      modelCalled: true,
    });
    expect(bid.receipt.decision).toContain('Muse declined the optional discount');
  });

  it('bids base directly without model veto when there is no discount candidate', async () => {
    const { adapter, fetcher } = model({ decision: 'decline', catalogId: null });
    expect(
      await adapter.proposeBid({ ...input(), discountTotalPriceCents: undefined }),
    ).toMatchObject({ decision: 'bid', totalPriceCents: 10, modelCalled: false });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('does not reduce the base to the buyer budget after a declined discount', async () => {
    const { adapter } = model({ decision: 'decline', catalogId: null });
    const bid = await adapter.proposeBid({
      ...input(),
      request: { ...input().request, maxPriceCents: 9.5 },
    });
    expect(bid).toMatchObject({ decision: 'decline', modelCalled: true });
    expect(bid.totalPriceCents).toBeUndefined();
    expect(bid.receipt.decision).toContain('unchanged base total');
  });

  it('can offer an accepted policy discount when the base exceeds budget', async () => {
    const { adapter } = model({ decision: 'bid', catalogId: item.id });
    expect(
      await adapter.proposeBid({
        ...input(),
        request: { ...input().request, maxPriceCents: 9 },
      }),
    ).toMatchObject({ decision: 'bid', totalPriceCents: 9 });
  });

  it.each([
    { availableCapacity: 0 },
    { policy: { ...policy, allowedCatalogIds: [] } },
    { request: { ...input().request, maxPriceCents: 8 } },
    { request: { ...input().request, requirements: { cpu: 8, memoryGb: 4 } } },
    { request: { ...input().request, region: 'us' } },
    { catalog: [{ ...item, approved: false }] },
  ])('keeps eligibility declines out of the base-price path: %j', async (change) => {
    const { adapter, fetcher } = model({ decision: 'decline', catalogId: null });
    expect(await adapter.proposeBid({ ...input(), ...change })).toMatchObject({
      decision: 'decline',
      modelCalled: false,
    });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each([
    { decision: 'decline', catalogId: item.id },
    { decision: 'bid', catalogId: 'another-configuration' },
    { decision: 'bid', catalogId: item.id, totalPriceCents: 8 },
  ])('does not turn malformed model responses into a fallback bid: %j', async (value) => {
    const { adapter } = model(value);
    await expect(adapter.proposeBid(input())).rejects.toMatchObject({ code: 'invalid_proposal' });
  });

  it('does not convert model transport failure to a bid', async () => {
    const { adapter, fetcher } = model({ decision: 'decline', catalogId: null });
    fetcher.mockRejectedValue(new Error('Offline transport failure'));
    await expect(adapter.proposeBid(input())).rejects.toMatchObject({ code: 'unavailable' });
  });
});
