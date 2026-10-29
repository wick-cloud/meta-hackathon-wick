import type { CatalogItem } from '../shared/types.js';
/** Explicit public projection; future native fields do not become public implicitly. */
export function publicCatalogView(item: CatalogItem) {
  const fields = [
    'id',
    'name',
    'description',
    'provider',
    'profile',
    'region',
    'cpu',
    'memoryGb',
    'gpu',
    'durationMinutes',
    'approved',
    'rateMicrosPerSecond',
    'rateRetrievedAt',
    'rateSource',
    'pricingMode',
    'managedRouteVerification',
    'resources',
    'maxTtlSeconds',
    'deadlineEnforcement',
  ] as const;
  return Object.fromEntries(fields.filter((k) => item[k] !== undefined).map((k) => [k, item[k]]));
}
