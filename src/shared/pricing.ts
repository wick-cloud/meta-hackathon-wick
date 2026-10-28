import type { CatalogItem, FixedQuote, ManagedPricing } from './types.js';

export const DEFAULT_MARKUP_BPS = 2000;
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
    currency: 'USD',
    rounding: 'ceil-once-to-cent-minimum-one-cent',
  };
}

export function requireCurrentRate(pricing: ManagedPricing, catalog: CatalogItem) {
  const current = managedPricing(catalog, pricing.markupBps);
  if (pricing.rateMicrosPerSecond !== current.rateMicrosPerSecond)
    throw new Error(
      'The published Wick rate changed. Refresh the offering and start a new request.',
    );
}
