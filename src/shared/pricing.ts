import type { CatalogItem, FixedQuote, ManagedPricing } from './types.js';

export const DEFAULT_MARKUP_BPS = 2000;
export const MAX_RATE_AGE_MS = 15 * 60 * 1000;
export const MAX_RATE_FUTURE_SKEW_MS = 60 * 1000;

/** Admission requires a recently retrieved source; historical snapshots remain readable. */
export function requireFreshManagedRate(item: CatalogItem, now = Date.now()) {
  const retrieved = Date.parse(item.rateRetrievedAt ?? '');
  if (
    !Number.isFinite(retrieved) ||
    !Number.isFinite(now) ||
    now - retrieved > MAX_RATE_AGE_MS ||
    retrieved - now > MAX_RATE_FUTURE_SKEW_MS
  )
    throw new Error(
      'The published Wick rate timestamp is stale or in the future. Sync the catalog.',
    );
}
export function managedPricing(item: CatalogItem, markupBps = DEFAULT_MARKUP_BPS): ManagedPricing {
  if (item.pricingMode !== 'managed' || item.providerKeyId)
    throw new Error(
      'Only managed Wick pricing is supported. BYOK cost semantics are not approved.',
    );
  if (
    !Number.isSafeInteger(item.rateMicrosPerSecond) ||
    item.rateMicrosPerSecond! < 0 ||
    item.rateSource !== 'wick-customer-catalog' ||
    !item.rateRetrievedAt ||
    !Number.isFinite(Date.parse(item.rateRetrievedAt))
  )
    throw new Error(
      'A published Wick rate and its retrieval timestamp are required. Sync the catalog.',
    );
  if (
    item.managedRouteVerification !== 'organization-catalog-byok-disabled' &&
    item.managedRouteVerification !== 'execution-preview-managed'
  )
    throw new Error(
      'This Wick route has not been verified for managed billing. Sync an approved catalog.',
    );
  if (!Number.isSafeInteger(markupBps) || markupBps < 0 || markupBps > 100000)
    throw new Error('Target markup must be an integer from 0 to 100000 basis points.');
  return {
    model: 'wick-managed-rate-v1',
    rateMicrosPerSecond: item.rateMicrosPerSecond!,
    rateSource: item.rateSource,
    rateRetrievedAt: item.rateRetrievedAt,
    markupBps,
  };
}

/** USD micro-units stay integral. Apply markup before rounding up exactly once to cents. */
export function fixedQuote(pricing: ManagedPricing, durationMinutes: number): FixedQuote {
  if (
    pricing.model !== 'wick-managed-rate-v1' ||
    !Number.isSafeInteger(pricing.rateMicrosPerSecond) ||
    pricing.rateMicrosPerSecond < 0 ||
    !Number.isSafeInteger(pricing.markupBps) ||
    pricing.markupBps < 0 ||
    pricing.markupBps > 100000 ||
    ![15, 30, 60].includes(durationMinutes)
  )
    throw new Error('Invalid managed pricing snapshot or finite rental duration.');
  const durationSeconds = durationMinutes * 60;
  const upstream = BigInt(pricing.rateMicrosPerSecond) * BigInt(durationSeconds);
  const numerator = upstream * BigInt(10000 + pricing.markupBps);
  const cents = (numerator + 99999999n) / 100000000n;
  const totalPriceCents = Number(cents < 1n ? 1n : cents);
  if (!Number.isSafeInteger(totalPriceCents) || totalPriceCents > 100000000)
    throw new Error('The fixed quote exceeds the supported customer price limit.');
  return {
    ...pricing,
    durationSeconds,
    upstreamEstimatedComputeMicros: upstream.toString(),
    totalPriceCents,
    targetTotalPriceCents: totalPriceCents,
    upstreamCostFloorCents: Number((upstream + 9999n) / 10000n || 1n),
    priceBasis: 'target-markup',
    currency: 'USD',
    rounding: 'ceil-once-to-cent-minimum-one-cent',
  };
}

export function acceptedBidQuote(
  pricing: ManagedPricing,
  durationMinutes: number,
  price: number,
): FixedQuote {
  const target = fixedQuote(pricing, durationMinutes);
  if (!Number.isSafeInteger(price) || price < target.upstreamCostFloorCents! || price > 100000000)
    throw new Error(
      `The fixed bid must be at least the Wick compute cost floor of ${target.upstreamCostFloorCents} USD cents.`,
    );
  return { ...target, totalPriceCents: price, priceBasis: 'provider-bid' };
}

export function requireCurrentRate(pricing: ManagedPricing, catalog: CatalogItem) {
  requireFreshManagedRate(catalog);
  const current = managedPricing(catalog, pricing.markupBps);
  if (pricing.rateMicrosPerSecond !== current.rateMicrosPerSecond)
    throw new Error(
      'The published Wick rate changed. Refresh the offering and start a new request.',
    );
}
