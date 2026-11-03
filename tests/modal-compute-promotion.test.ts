import { describe, expect, it } from 'vitest';
import type { CatalogItem } from '../src/shared/types.js';
import type { AppContext } from '../src/server/context.js';
import { loadConfig } from '../src/server/config.js';
import {
  compareComputeBidPriority,
  isSponsoredModalBid,
  modalComputePromotionQuote,
} from '../src/server/marketplace/compute-promotion.js';
import {
  acceptedBidQuote,
  fixedQuote,
  managedPricing,
  MODAL_COMPUTE_PROMOTION_ID,
  MODAL_COMPUTE_PROMOTION_MAX_UPSTREAM_MICROS,
  MODAL_COMPUTE_PROMOTION_PRICE_CENTS,
  revenueShare,
  sponsoredComputeQuote,
} from '../src/shared/pricing.js';

const catalog: CatalogItem = {
  id: 'modal:small:auto',
  name: 'Modal Small · offline pricing contract',
  description: '',
  provider: 'modal',
  profile: 'small',
  region: 'auto',
  cpu: 2,
  memoryGb: 4,
  approved: true,
  durationMinutes: [15, 30, 60],
  pricingMode: 'managed',
  managedRouteVerification: 'organization-catalog-byok-disabled',
  rateMicrosPerSecond: 100,
  rateSource: 'wick-customer-catalog',
  rateRetrievedAt: '2026-11-03T12:00:00Z',
};

describe('explicit one-cent compute sponsorship pricing', () => {
  it('freezes the real cost, exact commission, and operator-funded gap separately from the buyer total', () => {
    const pricing = managedPricing(catalog);
    const quote = sponsoredComputeQuote(pricing, 30);
    expect(MODAL_COMPUTE_PROMOTION_PRICE_CENTS).toBe(1);
    expect(MODAL_COMPUTE_PROMOTION_MAX_UPSTREAM_MICROS).toBe(1_000_000);
    expect(quote).toMatchObject({
      model: 'wick-provider-commission-v1',
      priceBasis: 'operator-sponsored',
      totalPriceCents: 1,
      targetTotalPriceCents: 22,
      upstreamCostFloorCents: 22,
      upstreamEstimatedComputeMicros: '180000',
      durationSeconds: 1800,
      commissionBps: 1500,
      revenueShare: {
        grossCents: 1,
        commissionBps: 1500,
        brokerFeeMicros: '1500',
        providerNetMicros: '8500',
      },
      promotion: {
        id: MODAL_COMPUTE_PROMOTION_ID,
        fundedBy: 'operator-wick-account',
        estimatedSubsidyMicros: '171500',
        maxUpstreamComputeMicros: '1000000',
      },
    });
    expect(quote.promotion?.id).toBe('modal-one-cent-v1');
    expect(pricing).not.toHaveProperty('promotion');
    expect(fixedQuote(pricing, 30).totalPriceCents).toBe(22);
    expect(() => acceptedBidQuote(pricing, 30, 1)).toThrow(/cost floor/);
    expect(acceptedBidQuote(pricing, 30, 22)).not.toHaveProperty('promotion');
  });

  it.each([
    ['micro', 34, 15, '30600'],
    ['micro', 34, 30, '61200'],
    ['micro', 34, 60, '122400'],
    ['small', 67, 15, '60300'],
    ['small', 67, 30, '120600'],
    ['small', 67, 60, '241200'],
    ['medium', 133, 15, '119700'],
    ['medium', 133, 30, '239400'],
    ['medium', 133, 60, '478800'],
    ['large', 265, 15, '238500'],
    ['large', 265, 30, '477000'],
    ['large', 265, 60, '954000'],
  ])(
    'keeps advertised Modal %s at %i µUSD/sec for %i minutes under the rental cap',
    (_, rate, duration, upstream) => {
      const quote = sponsoredComputeQuote(
        managedPricing({ ...catalog, rateMicrosPerSecond: Number(rate) }),
        Number(duration),
      );
      expect(quote.totalPriceCents).toBe(1);
      expect(quote.upstreamEstimatedComputeMicros).toBe(upstream);
      expect(quote.revenueShare).toEqual(revenueShare(1));
      expect(quote.promotion?.estimatedSubsidyMicros).toBe((BigInt(upstream) - 8500n).toString());
      expect(BigInt(quote.upstreamEstimatedComputeMicros)).toBeLessThanOrEqual(1_000_000n);
    },
  );

  it('admits the highest integer rate below the cap and rejects the next rate', () => {
    expect(
      sponsoredComputeQuote(managedPricing({ ...catalog, rateMicrosPerSecond: 1111 }), 15),
    ).toMatchObject({
      totalPriceCents: 1,
      upstreamEstimatedComputeMicros: '999900',
      promotion: { estimatedSubsidyMicros: '991400' },
    });
    expect(() =>
      sponsoredComputeQuote(managedPricing({ ...catalog, rateMicrosPerSecond: 1112 }), 15),
    ).toThrow();
  });

  it('never records a negative subsidy for a free or already cost-covered route', () => {
    for (const rateMicrosPerSecond of [0, 9]) {
      const quote = sponsoredComputeQuote(
        managedPricing({ ...catalog, rateMicrosPerSecond: rateMicrosPerSecond }),
        15,
      );
      expect(quote.revenueShare).toEqual(revenueShare(1));
      expect(quote.promotion?.estimatedSubsidyMicros).toBe('0');
    }
  });

  it('cannot use the sponsorship entry point for arbitrary prices or unsupported durations', () => {
    const pricing = managedPricing(catalog);
    for (const price of [0, 0.01, 0.99, 1.01, 2, NaN, Infinity])
      expect(() => sponsoredComputeQuote(pricing, 30, price)).toThrow();
    expect(() => sponsoredComputeQuote(pricing, 16)).toThrow();
  });
});

const configEnvironment = {
  NODE_ENV: 'test',
  DATABASE_URL: 'postgres://offline:offline@localhost:5432/not_connected_by_unit_tests',
  BETTER_AUTH_SECRET: 'offline-modal-promotion-config-contract-only',
  WICK_MODE: 'fixture',
  MUSE_MODE: 'fixture',
};
const context = () =>
  ({
    config: loadConfig({ ...configEnvironment, MODAL_COMPUTE_PROMOTION_ENABLED: 'true' }),
    wick: { mode: 'real' },
  }) as Pick<AppContext, 'config' | 'wick'>;
const freshCatalog = (): CatalogItem => ({ ...catalog, rateRetrievedAt: new Date().toISOString() });
const realModal = { cloud_provider: 'modal', simulated: false };

describe('promotion eligibility and immutable tie attribution', () => {
  it('is disabled unless the operator explicitly enables it', () => {
    const config = loadConfig(configEnvironment);
    expect(config.modalComputePromotionEnabled).toBe(false);
    const item = freshCatalog();
    expect(
      modalComputePromotionQuote(
        { ...context(), config },
        realModal,
        item,
        managedPricing(item),
        30,
      ),
    ).toBeUndefined();
  });

  it('requires real execution, the trusted Modal account, and an approved Modal configuration', () => {
    const ctx = context(),
      item = freshCatalog(),
      pricing = managedPricing(item);
    expect(modalComputePromotionQuote(ctx, realModal, item, pricing, 30)?.totalPriceCents).toBe(1);
    expect(
      modalComputePromotionQuote(
        { ...ctx, wick: { ...ctx.wick, mode: 'fixture' } },
        realModal,
        item,
        pricing,
        30,
      ),
    ).toBeUndefined();
    for (const provider of [
      { cloud_provider: 'e2b', simulated: false },
      { cloud_provider: null, simulated: false },
      { cloud_provider: 'modal', simulated: true },
      { cloud_provider: 'modal' },
    ])
      expect(modalComputePromotionQuote(ctx, provider, item, pricing, 30)).toBeUndefined();
    expect(
      modalComputePromotionQuote(ctx, realModal, { ...item, provider: 'e2b' }, pricing, 30),
    ).toBeUndefined();
    expect(
      modalComputePromotionQuote(ctx, realModal, { ...item, approved: false }, pricing, 30),
    ).toBeUndefined();
    expect(
      modalComputePromotionQuote(ctx, realModal, { ...item, durationMinutes: [15] }, pricing, 30),
    ).toBeUndefined();
    const capped = { ...item, rateMicrosPerSecond: 556 };
    expect(
      modalComputePromotionQuote(ctx, realModal, capped, managedPricing(capped), 30),
    ).toBeUndefined();
  });

  it('retains fresh managed-rate verification and does not sponsor BYOK, stale, or changed prices', () => {
    const ctx = context(),
      item = freshCatalog(),
      pricing = managedPricing(item);
    for (const change of [
      { pricingMode: 'byok' as const },
      { providerKeyId: 'offline-unapproved-key' },
      { managedRouteVerification: undefined },
      { rateRetrievedAt: new Date(Date.now() - 3600000).toISOString() },
      { rateMicrosPerSecond: item.rateMicrosPerSecond! + 1 },
    ])
      expect(() =>
        modalComputePromotionQuote(ctx, realModal, { ...item, ...change }, pricing, 30),
      ).toThrow();
  });

  function frozenBid() {
    const item = freshCatalog();
    return {
      id: 'later-modal',
      total_price_cents: 1,
      offering_snapshot: {
        cloudProvider: 'modal',
        simulated: false,
        catalog: { ...item, sourceMode: 'real' },
        pricing: sponsoredComputeQuote(managedPricing(item), 30),
      },
    };
  }

  it('grants tie priority only to exact, internally consistent frozen sponsorship evidence', () => {
    const valid = frozenBid();
    expect(isSponsoredModalBid(valid)).toBe(true);
    const invalid = [
      { ...valid, total_price_cents: 2 },
      { ...valid, offering_snapshot: { ...valid.offering_snapshot, cloudProvider: 'e2b' } },
      { ...valid, offering_snapshot: { ...valid.offering_snapshot, simulated: true } },
      {
        ...valid,
        offering_snapshot: {
          ...valid.offering_snapshot,
          catalog: { ...valid.offering_snapshot.catalog, provider: 'e2b' },
        },
      },
      {
        ...valid,
        offering_snapshot: {
          ...valid.offering_snapshot,
          catalog: { ...valid.offering_snapshot.catalog, sourceMode: 'fixture' },
        },
      },
      {
        ...valid,
        offering_snapshot: {
          ...valid.offering_snapshot,
          catalog: { ...valid.offering_snapshot.catalog, rateMicrosPerSecond: 101 },
        },
      },
      {
        ...valid,
        offering_snapshot: {
          ...valid.offering_snapshot,
          pricing: {
            ...valid.offering_snapshot.pricing,
            promotion: {
              ...valid.offering_snapshot.pricing.promotion,
              estimatedSubsidyMicros: '0',
            },
          },
        },
      },
      {
        ...valid,
        offering_snapshot: {
          ...valid.offering_snapshot,
          pricing: {
            ...valid.offering_snapshot.pricing,
            revenueShare: { ...valid.offering_snapshot.pricing.revenueShare, brokerFeeMicros: '0' },
          },
        },
      },
    ];
    for (const bid of invalid) expect(isSponsoredModalBid(bid)).toBe(false);
    expect(
      isSponsoredModalBid({
        total_price_cents: 1,
        offering_snapshot: { promotion: 'modal-one-cent-v1' },
      }),
    ).toBe(false);
  });

  it('preserves frozen attribution after the catalog freshness window has passed', () => {
    const bid = frozenBid();
    bid.offering_snapshot.catalog.rateRetrievedAt = '2020-01-01T00:00:00Z';
    bid.offering_snapshot.pricing.rateRetrievedAt = '2020-01-01T00:00:00Z';
    expect(isSponsoredModalBid(bid)).toBe(true);
  });

  it('prefers validated one-cent sponsorship while preserving SQL order for equal priority', () => {
    const promo = frozenBid();
    const first = { id: 'earlier-other', total_price_cents: 1, offering_snapshot: {} };
    const expensive = { id: 'higher-price', total_price_cents: 2, offering_snapshot: {} };
    expect([expensive, first, promo].sort(compareComputeBidPriority).map((bid) => bid.id)).toEqual([
      'later-modal',
      'earlier-other',
      'higher-price',
    ]);
    const sqlOrdered = [
      { ...promo, id: 'z-earlier', created_at: '2026-11-03T12:00:00.000001Z' },
      { ...promo, id: 'a-later', created_at: '2026-11-03T12:00:00.000002Z' },
    ];
    expect(sqlOrdered.sort(compareComputeBidPriority).map((bid) => bid.id)).toEqual([
      'z-earlier',
      'a-later',
    ]);
  });
});
