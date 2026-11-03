import type { CatalogItem, FixedQuote, ManagedPricing } from '../../shared/types.js';
import {
  fixedQuote,
  commissionPricing,
  isSponsoredComputeQuote,
  managedPricing,
  MODAL_COMPUTE_PROMOTION_MAX_UPSTREAM_MICROS,
  MODAL_COMPUTE_PROMOTION_PRICE_CENTS,
  requireCurrentRate,
  sponsoredComputeQuote,
} from '../../shared/pricing.js';
import type { AppContext } from '../context.js';
import type { Row } from './data.js';
import type { ProviderIdentity } from './provider-identity.js';

/** Only trusted catalog/account rows can grant the operator-funded exception. */
export function modalComputePromotionQuote(
  ctx: Pick<AppContext, 'config' | 'wick'>,
  provider: ProviderIdentity & { simulated?: boolean },
  catalog: CatalogItem,
  pricing: ManagedPricing,
  durationMinutes: number,
): FixedQuote | undefined {
  if (
    ctx.config.modalComputePromotionEnabled !== true ||
    ctx.wick.mode !== 'real' ||
    provider.cloud_provider !== 'modal' ||
    provider.simulated !== false ||
    catalog.provider !== 'modal' ||
    !catalog.approved ||
    !catalog.durationMinutes.includes(durationMinutes)
  )
    return undefined;
  requireCurrentRate(pricing, catalog);
  const target = fixedQuote(commissionPricing(pricing), durationMinutes);
  if (
    BigInt(target.upstreamEstimatedComputeMicros) >
    BigInt(MODAL_COMPUTE_PROMOTION_MAX_UPSTREAM_MICROS)
  )
    return undefined;
  return sponsoredComputeQuote(pricing, durationMinutes);
}

/** Frozen valid sponsored bids retain their promise, including after the promotion stops. */
export function isSponsoredModalBid(bid: Row): boolean {
  const snapshot = bid.offering_snapshot;
  const catalog = snapshot?.catalog;
  const pricing = snapshot?.pricing;
  if (
    bid.total_price_cents !== MODAL_COMPUTE_PROMOTION_PRICE_CENTS ||
    snapshot?.cloudProvider !== 'modal' ||
    snapshot?.simulated !== false ||
    catalog?.provider !== 'modal' ||
    catalog?.sourceMode !== 'real' ||
    !isSponsoredComputeQuote(pricing) ||
    pricing.rateMicrosPerSecond !== catalog.rateMicrosPerSecond
  )
    return false;
  try {
    managedPricing(catalog);
    return catalog.durationMinutes.includes(pricing.durationSeconds / 60);
  } catch {
    return false;
  }
}

/** Stable-sort SQL rows already ordered by price, accepted timestamp, then ID.
 * Keeping equal priority stable preserves PostgreSQL's microsecond timestamp precision. */
export function compareComputeBidPriority(a: Row, b: Row): number {
  return (
    a.total_price_cents - b.total_price_cents ||
    Number(isSponsoredModalBid(b)) - Number(isSponsoredModalBid(a))
  );
}
