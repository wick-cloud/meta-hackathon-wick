import { describe, expect, it } from 'vitest';
import type { CatalogItem } from '../src/shared/types.js';
import {
  acceptedBidQuote,
  commissionPricing,
  revenueShare,
  fixedQuote,
  managedPricing,
  requireCurrentRate,
  requireFreshManagedRate,
  MAX_RATE_AGE_MS,
  MAX_RATE_FUTURE_SKEW_MS,
} from '../src/shared/pricing.js';
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
  managedRouteVerification: 'organization-catalog-byok-disabled',
  rateMicrosPerSecond: 5,
  rateSource: 'wick-customer-catalog',
  rateRetrievedAt: new Date().toISOString(),
};

describe('managed fixed quotes (offline)', () => {
  it('prices the gross rental so the provider net covers compute after the 15% commission', () => {
    const pricing = managedPricing(item);
    expect([15, 30, 60].map((duration) => fixedQuote(pricing, duration).totalPriceCents)).toEqual([
      1, 2, 3,
    ]);
    expect(fixedQuote(pricing, 30)).toMatchObject({
      upstreamEstimatedComputeMicros: '9000',
      totalPriceCents: 2,
      durationSeconds: 1800,
      commissionBps: 1500,
      rounding: 'ceil-once-to-cent-minimum-one-cent',
    });
  });
  it('handles exact after-commission cent boundaries and free rates', () => {
    expect(
      fixedQuote(managedPricing({ ...item, rateMicrosPerSecond: 85 }), 15).totalPriceCents,
    ).toBe(9);
    expect(
      fixedQuote(managedPricing({ ...item, rateMicrosPerSecond: 86 }), 15).totalPriceCents,
    ).toBe(10);
    expect(
      fixedQuote(managedPricing({ ...item, rateMicrosPerSecond: 0 }), 60).totalPriceCents,
    ).toBe(1);
    expect(
      fixedQuote(managedPricing({ ...item, rateMicrosPerSecond: 100 }), 15).totalPriceCents,
    ).toBe(11);
  });
  it('splits every price exactly without increasing the buyer total or rounding small fees up', () => {
    expect(revenueShare(0.01)).toMatchObject({
      grossCents: 0.01,
      brokerFeeMicros: '15',
      providerNetMicros: '85',
    });
    expect(revenueShare(12.34)).toMatchObject({
      grossCents: 12.34,
      brokerFeeMicros: '18510',
      providerNetMicros: '104890',
    });
    expect(revenueShare(10000)).toEqual({
      commissionBps: 1500,
      grossCents: 10000,
      brokerFeeMicros: '15000000',
      providerNetMicros: '85000000',
    });
    expect(revenueShare(3)).toEqual({
      commissionBps: 1500,
      grossCents: 3,
      brokerFeeMicros: '4500',
      providerNetMicros: '25500',
    });
    for (const price of [0, 1, 2, 3, 99, 100, 100000000]) {
      const split = revenueShare(price);
      expect(BigInt(split.brokerFeeMicros) + BigInt(split.providerNetMicros)).toBe(
        BigInt(price) * 10000n,
      );
      expect(BigInt(split.brokerFeeMicros) * 100n).toBe(BigInt(price) * 10000n * 15n);
    }
    for (const price of [-1, 0.005, NaN, Infinity, 100000001])
      expect(() => revenueShare(price)).toThrow();
  });
  it('preserves legacy markup snapshots while new bids on old offerings use the provider commission', () => {
    const legacy = {
      ...managedPricing({ ...item, rateMicrosPerSecond: 100 }),
      model: 'wick-managed-rate-v1' as const,
      commissionBps: undefined,
      markupBps: 2000,
    };
    expect(fixedQuote(legacy, 30)).toMatchObject({
      totalPriceCents: 22,
      priceBasis: 'target-markup',
      markupBps: 2000,
    });
    expect(fixedQuote(legacy, 30)).not.toHaveProperty('revenueShare');
    expect(fixedQuote(commissionPricing(legacy), 30)).toMatchObject({
      totalPriceCents: 22,
      commissionBps: 1500,
      priceBasis: 'provider-commission-floor',
    });
    expect(acceptedBidQuote(legacy, 30, 22)).toMatchObject({
      model: 'wick-provider-commission-v1',
      revenueShare: revenueShare(22),
    });
    expect(legacy.markupBps).toBe(2000);
    expect(acceptedBidQuote(legacy, 30, 22)).not.toHaveProperty('markupBps');
    const distinct = { ...legacy, rateMicrosPerSecond: 47 };
    expect(fixedQuote(distinct, 30).totalPriceCents).toBe(11);
    expect(fixedQuote(commissionPricing(distinct), 30).totalPriceCents).toBe(10);
  });
  it('rejects unsafe values and never silently rounds upstream rates', () => {
    for (const rateMicrosPerSecond of [-1, 1.2, Number.MAX_SAFE_INTEGER + 1, NaN, Infinity])
      expect(() => managedPricing({ ...item, rateMicrosPerSecond })).toThrow();
    expect(() =>
      fixedQuote(managedPricing({ ...item, rateMicrosPerSecond: Number.MAX_SAFE_INTEGER }), 60),
    ).toThrow(/limit/);
    expect(() => fixedQuote({ ...managedPricing(item), commissionBps: 2000 }, 30)).toThrow();
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
      requireCurrentRate(pricing, { ...item, rateRetrievedAt: new Date().toISOString() }),
    ).not.toThrow();
    expect(pricing.rateRetrievedAt).toBe(item.rateRetrievedAt);
  });
  it('preserves competitive accepted prices while separately freezing target and compute floor', () => {
    const pricing = managedPricing(item);
    expect(acceptedBidQuote(pricing, 30, 2)).toMatchObject({
      totalPriceCents: 2,
      targetTotalPriceCents: 2,
      upstreamCostFloorCents: 2,
      upstreamEstimatedComputeMicros: '9000',
      priceBasis: 'provider-bid',
      commissionBps: 1500,
    });
    expect(() => acceptedBidQuote(pricing, 30, 1)).toThrow(/cost floor/);
    expect(acceptedBidQuote(pricing, 30, 7)).toMatchObject({
      totalPriceCents: 7,
      revenueShare: revenueShare(7),
    });
    const costlier = managedPricing({ ...item, rateMicrosPerSecond: 23 });
    expect(acceptedBidQuote(costlier, 15, 3).upstreamCostFloorCents).toBe(3);
    expect(() => acceptedBidQuote(costlier, 15, 2)).toThrow(/cost floor/);
    expect(() => acceptedBidQuote(pricing, 15, 0)).toThrow(/cost floor/);
    expect(() => acceptedBidQuote(pricing, 15, 1.005)).toThrow();
  });
  it('requires recent admission sources, bounds future skew and keeps historical snapshots readable', () => {
    const now = Date.parse('2026-10-28T12:00:00Z');
    const source = (delta: number) => ({
      ...item,
      rateRetrievedAt: new Date(now + delta).toISOString(),
    });
    expect(() => requireFreshManagedRate(source(-MAX_RATE_AGE_MS), now)).not.toThrow();
    expect(() => requireFreshManagedRate(source(MAX_RATE_FUTURE_SKEW_MS), now)).not.toThrow();
    expect(() => requireFreshManagedRate(source(-MAX_RATE_AGE_MS - 1), now)).toThrow(/stale/);
    expect(() => requireFreshManagedRate(source(MAX_RATE_FUTURE_SKEW_MS + 1), now)).toThrow(
      /future/,
    );
    expect(() => requireFreshManagedRate({ ...item, rateRetrievedAt: 'invalid' }, now)).toThrow();
    const frozen = fixedQuote(managedPricing(source(-100 * MAX_RATE_AGE_MS)), 30);
    expect(vmView({ quote_snapshot: { totalPriceCents: 2, pricing: frozen } }).pricing).toEqual(
      frozen,
    );
    expect(() => managedPricing({ ...item, managedRouteVerification: undefined })).toThrow(
      /verified/,
    );
  });
  it('preserves old fixture views and frozen quote amounts without adding fabricated prices', () => {
    expect(offeringView({ price_cents: 120 }).priceCents).toBe(120);
    expect(offeringView({ price_cents: 120 })).not.toHaveProperty('pricing');
    expect(requestView({ catalog_snapshot: {} })).not.toHaveProperty('pricing');
    expect(vmView({ quote_snapshot: { totalPriceCents: 150 } }).priceCents).toBe(150);
    expect(vmView({ quote_snapshot: { totalPriceCents: 150 } })).not.toHaveProperty('pricing');
  });
});
