import type { CatalogItem, Mode, SupplierPolicy } from '../../shared/types.js';
import type { SalesCandidate, SalesEvidence } from '../../shared/sales.js';
import { centsFromUnits, formatMoney, moneyUnits } from '../../shared/money.js';
import { fixedQuote, managedPricing } from '../../shared/pricing.js';
import { catalogSatisfiesRequest, requestCatalogs, sameCatalogAllocation } from './matching.js';
import { normalizedPolicy } from './policy.js';
import type { Row } from './data.js';

export interface SalesSnapshot {
  policy: SupplierPolicy;
  capacity: { total: number; held: number; available: number };
  catalog: CatalogItem[];
  activeCatalogIds: string[];
  requests: Row[];
  bidStatuses: string[];
  demand: { count: number; region: string; durationMinutes: number }[];
  sourceMode: Mode;
  sponsoredPricing: boolean;
}

/** A comparison at today's rates, not a reconstruction of past auctions or capacity. */
export function basePriceMatches(snapshot: SalesSnapshot, policy: SupplierPolicy): number {
  const active = new Set(snapshot.activeCatalogIds);
  return snapshot.requests.filter((request) => {
    if (request.disk_id || request.catalog_snapshot?.demoCompute) return false;
    if ((request.catalog_snapshot?.sourceMode ?? 'fixture') !== snapshot.sourceMode) return false;
    let frozen: CatalogItem[];
    try {
      frozen = requestCatalogs(request);
    } catch {
      return false;
    }
    return frozen.some((reviewed) => {
      const current = snapshot.catalog.find((item) => item.id === reviewed?.id);
      if (
        !current ||
        !current.approved ||
        !active.has(current.id) ||
        (policy.allowedCatalogIds && !policy.allowedCatalogIds.includes(current.id)) ||
        !sameCatalogAllocation(reviewed, current) ||
        !catalogSatisfiesRequest(current, request)
      )
        return false;
      try {
        const floor =
          snapshot.sourceMode === 'real'
            ? fixedQuote(managedPricing(current), request.duration_minutes).upstreamCostFloorCents!
            : 1;
        const price = Math.max(policy.basePriceCents, policy.minimumPriceCents, floor);
        return (
          price <= Number(request.max_price_cents) &&
          (policy.maxPriceCents === undefined || price <= policy.maxPriceCents)
        );
      } catch {
        return false;
      }
    });
  }).length;
}

export function buildSalesAnalysis(snapshot: SalesSnapshot): {
  evidence: SalesEvidence[];
  candidates: SalesCandidate[];
  limitations: string[];
} {
  const policy = normalizedPolicy(snapshot.policy);
  const currentMatches = snapshot.sponsoredPricing ? 0 : basePriceMatches(snapshot, policy);
  const bidCount = (status: string) => snapshot.bidStatuses.filter((s) => s === status).length;
  const demandCount = snapshot.demand.reduce((sum, group) => sum + Number(group.count), 0);
  const evidence: SalesEvidence[] = [
    {
      id: 'capacity',
      label: 'Configured capacity now',
      detail: `${snapshot.capacity.available} slots available for new bids; ${snapshot.capacity.held} held; ${policy.reserveSlots} kept spare out of ${snapshot.capacity.total} configured slots.`,
    },
    {
      id: 'automation',
      label: 'Automatic bidding',
      detail: policy.autoBid
        ? 'Automatic bids and counteroffers are enabled within the saved policy.'
        : 'Automatic bids and counteroffers are off. Published listings alone do not enable bidding.',
    },
    {
      id: 'pricing',
      label: 'Saved pricing limits',
      detail: `Base ${formatMoney(policy.basePriceCents)}; minimum ${formatMoney(policy.minimumPriceCents)}${policy.maxPriceCents === undefined ? '; no policy maximum' : `; maximum ${formatMoney(policy.maxPriceCents)}`}. Managed cost floors are enforced separately for each rental.`,
    },
    {
      id: 'bids',
      label: 'Your recent bid outcomes',
      detail: `${snapshot.bidStatuses.length} most recent bids sampled in the last 7 days: ${bidCount('won')} won, ${bidCount('lost')} lost, ${bidCount('held')} pending and ${bidCount('cancelled')} cancelled. A lost bid alone does not establish why it lost.`,
    },
    {
      id: 'sample',
      label: 'Recent request comparison',
      detail: snapshot.sponsoredPricing
        ? 'Sponsored Modal pricing is active. Ordinary base-price comparisons are unavailable for this account.'
        : `${currentMatches} of ${snapshot.requests.length} sampled completed auctions match your current base price, published configurations and policy at current rates. This is not a count of bids that would have won.`,
    },
    {
      id: 'offerings',
      label: 'Published configurations',
      detail: `${snapshot.activeCatalogIds.length} approved configurations have a current active offering. ${snapshot.activeCatalogIds.filter((id) => !policy.allowedCatalogIds || policy.allowedCatalogIds.includes(id)).length} are permitted by your saved policy.`,
    },
    {
      id: 'demand',
      label: 'Recent unmet demand',
      detail: `${demandCount} unresolved requests or intents across ${snapshot.demand.length} compatible demand groups in the bounded 7-day sample. This is observed demand, not a forecast.`,
    },
  ];
  const limitations = [
    'The sample covers at most 200 recent completed auctions and 200 of your bids from the last 7 days. It is not the entire marketplace.',
    'Base-price matches use current approved configurations, published offerings and current rates against the original reviewed request scope. They exclude automatic discounts and do not replay historical capacity, auction timing or competing bids.',
    'Disk-backed requests and sponsored homepage demos are excluded. Configured slots are not upstream utilization. No wins, revenue or profit are predicted.',
    'Each recommendation is an alternative policy. Applying one requires a fresh analysis before applying another. Your price floor, maximum and spare-slot reserve are preserved.',
  ];
  if (snapshot.sponsoredPricing)
    limitations.push(
      'Sponsored Modal pricing is active; base-price recommendations are withheld. Review its promotion and policy directly.',
    );
  const candidates: SalesCandidate[] = [];
  const add = (
    id: string,
    title: string,
    description: string,
    proposed: SupplierPolicy,
    evidenceIds: string[],
  ) => {
    if (JSON.stringify(proposed) === JSON.stringify(policy)) return;
    candidates.push({
      id,
      title,
      description,
      policy: proposed,
      evidenceIds,
      comparison: {
        sampledRequests: snapshot.requests.length,
        currentMatches,
        proposedMatches: basePriceMatches(snapshot, proposed),
      },
    });
  };
  // No speculative price cuts with no supporting request evidence or special-price routes.
  if (!snapshot.sponsoredPricing && snapshot.capacity.available > 0) {
    if (!policy.autoBid && currentMatches > 0)
      add(
        'enable-bidding',
        'Respond automatically to matching requests',
        'Enable automatic bids and counteroffers within your current limits. This changes how matching future demand is handled; it does not change the historical price-match count.',
        { ...policy, autoBid: true },
        ['automation', 'sample', 'capacity'],
      );
    for (const percent of [5, 10]) {
      const basePriceCents = Math.max(
        policy.minimumPriceCents,
        centsFromUnits((moneyUnits(policy.basePriceCents) * BigInt(100 - percent) + 99n) / 100n),
      );
      const proposed = { ...policy, basePriceCents };
      if (
        basePriceCents < policy.basePriceCents &&
        basePriceMatches(snapshot, proposed) > currentMatches &&
        !candidates.some((c) => c.policy.basePriceCents === basePriceCents)
      )
        add(
          `base-${percent}`,
          `Lower the base price by up to ${percent}%`,
          'Reach more sampled buyer budgets while keeping the saved floor and reserve. Actual bids still cover the applicable managed compute floor. Lower prices reduce your share per rental; this comparison does not predict more sales.',
          proposed,
          ['pricing', 'sample', 'capacity'],
        );
    }
    if (policy.allowedCatalogIds) {
      const added = snapshot.activeCatalogIds.filter(
        (id) => !policy.allowedCatalogIds!.includes(id),
      );
      const allowedCatalogIds = [...new Set([...policy.allowedCatalogIds, ...added])];
      const proposed = { ...policy, allowedCatalogIds };
      if (
        added.length &&
        allowedCatalogIds.length <= 100 &&
        basePriceMatches(snapshot, proposed) > currentMatches
      )
        add(
          'include-published',
          'Include more of your published configurations',
          'Permit your other approved, already-published configurations in new bids. This does not create listings or add another cloud provider.',
          proposed,
          ['offerings', 'sample', 'demand'],
        );
    }
  }
  for (const candidate of candidates) {
    const id = `comparison-${candidate.id}`;
    evidence.push({
      id,
      label: candidate.title,
      detail: `At the proposed settings, ${candidate.comparison.proposedMatches} of ${candidate.comparison.sampledRequests} sampled requests match, compared with ${currentMatches} at current settings. The same current-rate comparison is used for both.`,
    });
    candidate.evidenceIds = [...candidate.evidenceIds.slice(0, 3), id];
  }
  return { evidence, candidates, limitations };
}
