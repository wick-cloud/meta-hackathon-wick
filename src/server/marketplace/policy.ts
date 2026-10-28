import type { SupplierPolicy } from '../../shared/types.js';
import { HttpError } from '../context.js';
import { integer } from './data.js';

/** Legacy policies retain all capabilities and keep zero additional slots spare. */
export function normalizedPolicy(policy: SupplierPolicy): SupplierPolicy {
  return { ...policy, reserveSlots: policy.reserveSlots ?? 0 };
}

/** Call while holding the provider row lock before creating any new reservation. */
export function availableForBids(total: number, held: number, policy: SupplierPolicy): number {
  return Math.max(0, total - held - (policy.reserveSlots ?? 0));
}

/** Optional capabilities are preserved when older clients omit them, never silently removed. */
export function validatePolicy(input: unknown, previous?: SupplierPolicy): SupplierPolicy {
  if (!input || typeof input !== 'object' || Array.isArray(input))
    throw new HttpError(400, 'An explicit pricing policy is required.');
  const body = input as Record<string, unknown>;
  if (typeof body.autoBid !== 'boolean')
    throw new HttpError(400, 'Auto bid must be true or false.');
  const policy: SupplierPolicy = {
    autoBid: body.autoBid,
    minimumPriceCents: integer(body.minimumPriceCents, 'Minimum total price'),
    basePriceCents: integer(body.basePriceCents, 'Base total price'),
    reserveSlots: integer(
      body.reserveSlots === undefined ? (previous?.reserveSlots ?? 0) : body.reserveSlots,
      'Reserved spare slots',
      0,
      10000,
    ),
  };
  if (policy.basePriceCents < policy.minimumPriceCents)
    throw new HttpError(400, 'Base price must be at least the minimum price.');
  const maxPrice = body.maxPriceCents === undefined ? previous?.maxPriceCents : body.maxPriceCents;
  if (maxPrice !== undefined && maxPrice !== null) {
    policy.maxPriceCents = integer(maxPrice, 'Maximum total price');
    if (policy.maxPriceCents < policy.basePriceCents)
      throw new HttpError(400, 'Maximum price must be at least the base price.');
  }
  const allowed =
    body.allowedCatalogIds === undefined ? previous?.allowedCatalogIds : body.allowedCatalogIds;
  if (allowed !== undefined) {
    if (
      !Array.isArray(allowed) ||
      allowed.length > 100 ||
      allowed.some((id) => typeof id !== 'string' || !id.trim() || id.length > 160)
    )
      throw new HttpError(400, 'Allowed configurations must be a list of at most 100 catalog IDs.');
    policy.allowedCatalogIds = [...new Set(allowed as string[])];
  }
  return policy;
}
