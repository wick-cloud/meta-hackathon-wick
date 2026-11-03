import { describe, expect, it } from 'vitest';
import {
  basePriceMatches,
  buildSalesAnalysis,
  type SalesSnapshot,
} from '../src/server/marketplace/sales-analysis.js';
import type { Row } from '../src/server/marketplace/data.js';
import type { CatalogItem, Mode, SupplierPolicy } from '../src/shared/types.js';
import { isMoneyCents } from '../src/shared/money.js';

const small: CatalogItem = {
  id: 'own-small',
  name: 'Own small',
  description: 'Offline sales analysis fixture',
  provider: 'e2b',
  profile: 'small',
  region: 'us',
  cpu: 2,
  memoryGb: 4,
  durationMinutes: [15, 30, 60],
  approved: true,
  organizationId: 'own-org',
  groupId: 'own-group',
  resources: { cpu: 2, memoryGb: 4, diskGb: 10 },
};
const large: CatalogItem = {
  ...small,
  id: 'own-large',
  name: 'Own large',
  profile: 'large',
  cpu: 4,
  memoryGb: 8,
  resources: { cpu: 4, memoryGb: 8, diskGb: 20 },
};
const baselinePolicy: SupplierPolicy = {
  autoBid: true,
  minimumPriceCents: 8,
  basePriceCents: 10.01,
  maxPriceCents: 20,
  reserveSlots: 2,
};
function request(item: CatalogItem = small, maxPriceCents = 20, sourceMode: Mode = 'fixture'): Row {
  return {
    catalog_id: item.id,
    catalog_snapshot: { ...item, sourceMode },
    region: item.region,
    duration_minutes: 30,
    max_price_cents: maxPriceCents,
    requirements: { cpu: 2, memoryGb: 4 },
  };
}
function snapshot(changes: Partial<SalesSnapshot> = {}): SalesSnapshot {
  return {
    policy: { ...baselinePolicy },
    capacity: { total: 5, held: 1, available: 2 },
    catalog: [small],
    activeCatalogIds: [small.id],
    requests: [request()],
    bidStatuses: ['won', 'lost', 'held', 'cancelled'],
    demand: [{ count: 3, region: 'us', durationMinutes: 30 }],
    sourceMode: 'fixture',
    sponsoredPricing: false,
    ...changes,
  };
}
function managed(item: CatalogItem, rateMicrosPerSecond: number): CatalogItem {
  return {
    ...item,
    rateMicrosPerSecond,
    rateRetrievedAt: '2026-11-03T12:00:00.000Z',
    rateSource: 'wick-customer-catalog',
    pricingMode: 'managed',
    managedRouteVerification: 'execution-preview-managed',
  };
}

describe('seller historical base-price matching', () => {
  it('uses the frozen exact route and only this seller’s current published catalog', () => {
    const rival = { ...small, id: 'rival-small', provider: 'modal' };
    const data = snapshot({ requests: [request(small), request(rival)] });
    expect(basePriceMatches(data, data.policy)).toBe(1);
    expect(
      basePriceMatches({ ...data, catalog: [large], activeCatalogIds: [large.id] }, data.policy),
    ).toBe(0);
  });

  it('counts an explicitly compatible request once and never broadens its reviewed book', () => {
    const rival = { ...small, id: 'rival-small', provider: 'modal' };
    const compatible = {
      ...request(rival),
      region: 'any',
      catalog_snapshot: {
        sourceMode: 'fixture',
        matchMode: 'compatible',
        eligibleCatalogs: [rival, small, large],
      },
    };
    const data = snapshot({
      catalog: [small, large],
      activeCatalogIds: [small.id, large.id],
      requests: [compatible],
    });
    expect(basePriceMatches(data, data.policy)).toBe(1);
    expect(
      basePriceMatches(
        {
          ...data,
          requests: [
            {
              ...compatible,
              catalog_snapshot: { ...compatible.catalog_snapshot, eligibleCatalogs: [rival] },
            },
          ],
        },
        data.policy,
      ),
    ).toBe(0);
  });

  it.each([
    ['inactive listing', { activeCatalogIds: [] }],
    ['unapproved configuration', { catalog: [{ ...small, approved: false }] }],
    ['saved allowlist exclusion', { policy: { ...baselinePolicy, allowedCatalogIds: [large.id] } }],
  ] satisfies [string, Partial<SalesSnapshot>][])('excludes %s', (_name, change) => {
    const data = snapshot(change);
    expect(basePriceMatches(data, data.policy)).toBe(0);
  });

  it.each([
    { provider: 'modal' },
    { profile: 'replacement-profile' },
    { region: 'eu' },
    { cpu: 4 },
    { memoryGb: 8 },
    { organizationId: 'different-org' },
    { groupId: 'different-group' },
    { resources: { ...small.resources!, diskGb: 30 } },
  ])('does not match a current allocation that drifted from reviewed scope: %j', (change) => {
    const data = snapshot({ catalog: [{ ...small, ...change }] });
    expect(basePriceMatches(data, data.policy)).toBe(0);
  });

  it.each([
    { requirements: { cpu: 8, memoryGb: 4 } },
    { requirements: { cpu: 2, memoryGb: 16 } },
    { requirements: { cpu: 2, memoryGb: 4, gpu: 'any' } },
    { region: 'eu' },
    { duration_minutes: 45 },
  ])('retains resource, location and exact-duration constraints: %j', (change) => {
    const data = snapshot({ requests: [{ ...request(), ...change }] });
    expect(basePriceMatches(data, data.policy)).toBe(0);
  });

  it('excludes unsupported source modes, disks, demos and malformed compatible books', () => {
    const data = snapshot({
      requests: [
        request(),
        request(small, 20, 'real'),
        { ...request(), disk_id: 'disk' },
        { ...request(), catalog_snapshot: { ...small, demoCompute: { enabled: true } } },
        { ...request(), catalog_snapshot: { matchMode: 'compatible', eligibleCatalogs: [] } },
        {
          ...request(),
          catalog_snapshot: { matchMode: 'compatible', eligibleCatalogs: [small, small] },
        },
      ],
    });
    expect(basePriceMatches(data, data.policy)).toBe(1);
  });

  it('uses the higher of today’s cost-covered floor, policy floor and base against buyer and seller limits', () => {
    // 48 micro-USD/second × 1,800 seconds / 8,500 = a rounded-up 11-cent gross floor.
    const item = managed(small, 48);
    const data = snapshot({
      sourceMode: 'real',
      catalog: [item],
      requests: [request(item, 10.99, 'real'), request(item, 11, 'real')],
      policy: { ...baselinePolicy, basePriceCents: 9, maxPriceCents: 20 },
    });
    expect(basePriceMatches(data, data.policy)).toBe(1);
    expect(basePriceMatches(data, { ...data.policy, maxPriceCents: 10.99 })).toBe(0);
    expect(
      basePriceMatches(data, { ...data.policy, minimumPriceCents: 12, basePriceCents: 12 }),
    ).toBe(0);
    expect(basePriceMatches(data, { ...data.policy, basePriceCents: 12 })).toBe(0);
  });

  it('compares original scope at the current rate instead of reconstructing a historical quote', () => {
    const historic = managed(small, 1);
    const current = managed(small, 48);
    const data = snapshot({
      sourceMode: 'real',
      catalog: [current],
      requests: [request(historic, 10, 'real')],
      policy: { ...baselinePolicy, basePriceCents: 9 },
    });
    expect(basePriceMatches(data, data.policy)).toBe(0);
    expect(basePriceMatches({ ...data, catalog: [managed(small, 47)] }, data.policy)).toBe(1);
  });

  it('ignores real routes without usable managed-rate evidence', () => {
    const data = snapshot({ sourceMode: 'real', requests: [request(small, 20, 'real')] });
    expect(basePriceMatches(data, data.policy)).toBe(0);
  });
});

describe('server-generated seller policy scenarios', () => {
  it('calculates bounded 5% and 10% reductions rounded up to supported money units', () => {
    const data = snapshot({
      requests: [10.01, 9.51, 9.5, 9.01, 9.0].map((budget) => request(small, budget)),
    });
    const { candidates } = buildSalesAnalysis(data);
    expect(
      candidates.map((candidate) => ({
        id: candidate.id,
        base: candidate.policy.basePriceCents,
        comparison: candidate.comparison,
      })),
    ).toEqual([
      {
        id: 'base-5',
        base: 9.51,
        comparison: { sampledRequests: 5, currentMatches: 1, proposedMatches: 2 },
      },
      {
        id: 'base-10',
        base: 9.01,
        comparison: { sampledRequests: 5, currentMatches: 1, proposedMatches: 4 },
      },
    ]);
    expect(candidates.every((candidate) => isMoneyCents(candidate.policy.basePriceCents))).toBe(
      true,
    );
  });

  it('clamps reductions to the saved floor and deduplicates identical clamped scenarios', () => {
    const data = snapshot({
      policy: { ...baselinePolicy, minimumPriceCents: 9.6 },
      requests: [request(small, 9.6), request(small, 9.59)],
    });
    const { candidates } = buildSalesAnalysis(data);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({
      id: 'base-5',
      policy: { minimumPriceCents: 9.6, basePriceCents: 9.6 },
      comparison: { currentMatches: 0, proposedMatches: 1 },
    });
  });

  it.each([
    { requests: [] },
    { requests: [request(small, 30)] },
    { requests: [request(small, 1)] },
    { capacity: { total: 3, held: 1, available: 0 } },
  ])(
    'withholds speculative changes without additional matching budgets or usable capacity: %j',
    (change) => {
      expect(buildSalesAnalysis(snapshot(change)).candidates).toEqual([]);
    },
  );

  it('does not recommend cuts that remain blocked by the managed compute floor', () => {
    const item = managed(small, 48);
    const data = snapshot({
      sourceMode: 'real',
      catalog: [item],
      requests: [request(item, 10, 'real')],
    });
    expect(buildSalesAnalysis(data).candidates).toEqual([]);
  });

  it('offers automation only when requests already match, preserving the historical match count', () => {
    const data = snapshot({ policy: { ...baselinePolicy, autoBid: false } });
    expect(buildSalesAnalysis(data).candidates).toMatchObject([
      {
        id: 'enable-bidding',
        policy: { autoBid: true },
        comparison: { currentMatches: 1, proposedMatches: 1 },
      },
    ]);
    expect(buildSalesAnalysis({ ...data, requests: [] }).candidates).toEqual([]);
    expect(
      buildSalesAnalysis({ ...data, capacity: { total: 3, held: 1, available: 0 } }).candidates,
    ).toEqual([]);
  });

  it('preserves the floor, maximum and spare slots in every alternative and includes only approved published catalogs', () => {
    const inactive = { ...large, id: 'own-inactive' };
    const unapproved = { ...large, id: 'own-unapproved', approved: false };
    const data = snapshot({
      policy: { ...baselinePolicy, autoBid: false, allowedCatalogIds: [small.id] },
      catalog: [small, large, inactive, unapproved],
      // The endpoint derives this list from this provider’s active, approved offerings.
      activeCatalogIds: [small.id, large.id],
      requests: [
        request(small),
        request(small, 9.51),
        request(small, 9.01),
        request(large),
        request(inactive),
        request(unapproved),
      ],
    });
    const original = structuredClone(data);
    const { candidates, evidence } = buildSalesAnalysis(data);
    expect(candidates.map((candidate) => candidate.id)).toEqual([
      'enable-bidding',
      'base-5',
      'base-10',
      'include-published',
    ]);
    for (const candidate of candidates) {
      expect(candidate.policy).toMatchObject({
        minimumPriceCents: 8,
        maxPriceCents: 20,
        reserveSlots: 2,
      });
      expect(candidate.evidenceIds).toHaveLength(4);
      expect(candidate.evidenceIds.every((id) => evidence.some((item) => item.id === id))).toBe(
        true,
      );
    }
    expect(
      candidates.find((candidate) => candidate.id === 'include-published')?.policy
        .allowedCatalogIds,
    ).toEqual([small.id, large.id]);
    expect(data).toEqual(original);
  });

  it('withholds ordinary price recommendations for sponsored accounts', () => {
    const report = buildSalesAnalysis(
      snapshot({ sponsoredPricing: true, policy: { ...baselinePolicy, autoBid: false } }),
    );
    expect(report.candidates).toEqual([]);
    expect(report.evidence.find((item) => item.id === 'sample')?.detail).toContain(
      'comparisons are unavailable',
    );
    expect(report.limitations.join(' ')).toContain('base-price recommendations are withheld');
  });

  it('describes observed outcomes and current-rate comparisons without attributing losses or predicting wins', () => {
    const report = buildSalesAnalysis(snapshot({ requests: [request(small, 9.51)] }));
    expect(report.evidence.find((item) => item.id === 'bids')?.detail).toContain(
      'A lost bid alone does not establish why it lost.',
    );
    expect(report.evidence.find((item) => item.id === 'sample')?.detail).toContain(
      'not a count of bids that would have won',
    );
    expect(report.evidence.find((item) => item.id === 'demand')?.detail).toContain(
      'not a forecast',
    );
    expect(report.limitations.join(' ')).toContain('No wins, revenue or profit are predicted.');
    expect(report.limitations.join(' ')).toContain('do not replay historical capacity');
    expect(
      report.candidates.every((candidate) =>
        candidate.description.includes('does not predict more sales'),
      ),
    ).toBe(true);
  });
});
