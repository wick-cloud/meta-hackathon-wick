import { describe, expect, it } from 'vitest';
import type { CatalogItem } from '../src/shared/types.js';
import { fixedQuote, managedPricing, requireCurrentRate } from '../src/shared/pricing.js';
import { offeringView, requestView, vmView } from '../src/server/marketplace/data.js';

const item: CatalogItem = {
  id: 'public-rate-fixture',
  name: 'Pricing contract fixture',
  description: '',
  provider: 'boat',
  profile: 'small',
  region: 'auto',
  cpu: 1,
  memoryGb: 1,
  approved: true,
  durationMinutes: [15, 30, 60],
  pricingMode: 'managed',
  rateMicrosPerSecond: 5,
  rateSource: 'wick-customer-catalog',
  rateRetrievedAt: '2026-10-28T00:00:00.000Z',
};

describe('managed fixed quotes (offline)', () => {
  it('prices actual duration with integer markup before one upward cent rounding', () => {
    const pricing = managedPricing(item);
    expect([15, 30, 60].map((duration) => fixedQuote(pricing, duration).totalPriceCents)).toEqual([
      1, 2, 3,
    ]);
    expect(fixedQuote(pricing, 30)).toMatchObject({
      upstreamEstimatedComputeMicros: '9000',
      totalPriceCents: 2,
      durationSeconds: 1800,
      markupBps: 2000,
      rounding: 'ceil-once-to-cent-minimum-one-cent',
    });
  });
  it('handles exact integer cent boundaries, free rates and configurable markup', () => {
    expect(
      fixedQuote(managedPricing({ ...item, rateMicrosPerSecond: 100 }, 0), 15).totalPriceCents,
    ).toBe(9);
    expect(
      fixedQuote(managedPricing({ ...item, rateMicrosPerSecond: 100 }, 1), 15).totalPriceCents,
    ).toBe(10);
    expect(
      fixedQuote(managedPricing({ ...item, rateMicrosPerSecond: 0 }), 60).totalPriceCents,
    ).toBe(1);
    expect(
      fixedQuote(managedPricing({ ...item, rateMicrosPerSecond: 101 }, 10000), 15).totalPriceCents,
    ).toBe(19);
  });
  it('rejects unsafe values and never silently rounds upstream rates', () => {
    for (const rateMicrosPerSecond of [-1, 1.2, Number.MAX_SAFE_INTEGER + 1, NaN, Infinity])
      expect(() => managedPricing({ ...item, rateMicrosPerSecond })).toThrow();
    expect(() =>
      fixedQuote(managedPricing({ ...item, rateMicrosPerSecond: Number.MAX_SAFE_INTEGER }), 60),
    ).toThrow(/limit/);
    expect(() => managedPricing(item, -1)).toThrow();
    expect(() => fixedQuote(managedPricing(item), 16)).toThrow();
  });
  it('requires rate provenance, rejects BYOK and detects changed snapshots', () => {
    expect(() => managedPricing({ ...item, rateRetrievedAt: undefined })).toThrow(/timestamp/);
    expect(() => managedPricing({ ...item, rateSource: undefined })).toThrow(/timestamp/);
    expect(() => managedPricing({ ...item, pricingMode: 'byok' })).toThrow(/BYOK/);
    expect(() => managedPricing({ ...item, providerKeyId: 'not-supported' })).toThrow(/BYOK/);
    const pricing = managedPricing(item);
    expect(() => requireCurrentRate(pricing, { ...item, rateMicrosPerSecond: 6 })).toThrow(
      /changed/,
    );
    expect(() =>
      requireCurrentRate(pricing, { ...item, rateRetrievedAt: '2026-10-28T01:00:00Z' }),
    ).not.toThrow();
    expect(pricing.rateRetrievedAt).toBe(item.rateRetrievedAt);
  });
  it('preserves old fixture views and frozen quote amounts without adding fabricated prices', () => {
    expect(offeringView({ price_cents: 120 }).priceCents).toBe(120);
    expect(offeringView({ price_cents: 120 })).not.toHaveProperty('pricing');
    expect(requestView({ catalog_snapshot: {} })).not.toHaveProperty('pricing');
    expect(vmView({ quote_snapshot: { totalPriceCents: 150 } }).priceCents).toBe(150);
    expect(vmView({ quote_snapshot: { totalPriceCents: 150 } })).not.toHaveProperty('pricing');
  });
});
