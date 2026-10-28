import type { CatalogItem, FixedQuote, ManagedPricing, RevenueShare } from './types.js';

export const PROVIDER_COMMISSION_BPS = 1500;
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
export function managedPricing(item: CatalogItem): ManagedPricing {
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
  return {
    model: 'wick-provider-commission-v1',
    rateMicrosPerSecond: item.rateMicrosPerSecond!,
    rateSource: item.rateSource,
    rateRetrievedAt: item.rateRetrievedAt,
    commissionBps: PROVIDER_COMMISSION_BPS,
  };
}

/** A new binding quote always uses the current fee; legacy immutable views retain their model. */
export function commissionPricing(pricing: ManagedPricing): ManagedPricing {
  if (!['wick-managed-rate-v1', 'wick-provider-commission-v1'].includes(pricing.model))
    throw new Error('Unrecognized managed pricing snapshot.');
  return {
    model: 'wick-provider-commission-v1',
    rateMicrosPerSecond: pricing.rateMicrosPerSecond,
    rateSource: pricing.rateSource,
    rateRetrievedAt: pricing.rateRetrievedAt,
    commissionBps: PROVIDER_COMMISSION_BPS,
  };
}

/** A cent is 10,000 micro-USD. Both shares are exact even on one-cent rentals. */
export function revenueShare(grossCents: number): RevenueShare {
  if (!Number.isSafeInteger(grossCents) || grossCents < 0 || grossCents > 100000000)
    throw new Error('Invalid gross rental total.');
  return {
    commissionBps: PROVIDER_COMMISSION_BPS,
    grossCents,
    brokerFeeMicros: (BigInt(grossCents) * BigInt(PROVIDER_COMMISSION_BPS)).toString(),
    providerNetMicros: (BigInt(grossCents) * BigInt(10000 - PROVIDER_COMMISSION_BPS)).toString(),
  };
}

/** Preserve v1 historical calculations; new quotes cover compute after a provider-paid 15% fee. */
export function fixedQuote(pricing: ManagedPricing, durationMinutes: number): FixedQuote {
  const legacy = pricing.model === 'wick-managed-rate-v1';
  if (
    (!legacy && pricing.model !== 'wick-provider-commission-v1') ||
    !Number.isSafeInteger(pricing.rateMicrosPerSecond) ||
    pricing.rateMicrosPerSecond < 0 ||
    (legacy
      ? !Number.isSafeInteger(pricing.markupBps) ||
        pricing.markupBps! < 0 ||
        pricing.markupBps! > 100000
      : pricing.commissionBps !== PROVIDER_COMMISSION_BPS) ||
    ![15, 30, 60].includes(durationMinutes)
  )
    throw new Error('Invalid managed pricing snapshot or finite rental duration.');
  const durationSeconds = durationMinutes * 60;
  const upstream = BigInt(pricing.rateMicrosPerSecond) * BigInt(durationSeconds);
  const minimumGross = (upstream + 8499n) / 8500n;
  const cents = legacy
    ? (upstream * BigInt(10000 + pricing.markupBps!) + 99999999n) / 100000000n
    : minimumGross;
  const totalPriceCents = Number(cents < 1n ? 1n : cents);
  if (!Number.isSafeInteger(totalPriceCents) || totalPriceCents > 100000000)
    throw new Error('The fixed quote exceeds the supported customer price limit.');
  return {
    ...pricing,
    durationSeconds,
    upstreamEstimatedComputeMicros: upstream.toString(),
    totalPriceCents,
    targetTotalPriceCents: totalPriceCents,
    // For new quotes the floor is gross: the provider's 85% must cover estimated compute.
    upstreamCostFloorCents: Number((legacy ? (upstream + 9999n) / 10000n : minimumGross) || 1n),
    priceBasis: legacy ? 'target-markup' : 'provider-commission-floor',
    ...(!legacy ? { revenueShare: revenueShare(totalPriceCents) } : {}),
    currency: 'USD',
    rounding: 'ceil-once-to-cent-minimum-one-cent',
  };
}

export function acceptedBidQuote(
  pricing: ManagedPricing,
  durationMinutes: number,
  price: number,
): FixedQuote {
  const target = fixedQuote(commissionPricing(pricing), durationMinutes);
  if (!Number.isSafeInteger(price) || price < target.upstreamCostFloorCents! || price > 100000000)
    throw new Error(
      `The fixed bid must be at least the Wick compute cost floor after the provider commission of ${target.upstreamCostFloorCents} USD cents.`,
    );
  return {
    ...target,
    totalPriceCents: price,
    revenueShare: revenueShare(price),
    priceBasis: 'provider-bid',
  };
}

export function requireCurrentRate(pricing: ManagedPricing, catalog: CatalogItem) {
  requireFreshManagedRate(catalog);
  const current = managedPricing(catalog);
  if (pricing.rateMicrosPerSecond !== current.rateMicrosPerSecond)
    throw new Error(
      'The published Wick rate changed. Refresh the offering and start a new request.',
    );
}
