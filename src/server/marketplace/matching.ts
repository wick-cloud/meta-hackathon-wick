import type { CatalogItem } from '../../shared/types.js';
import { HttpError } from '../context.js';
import { isCloudProvider } from '../../shared/providers.js';
import type { Row } from './data.js';

export const MAX_MATCH_CATALOGS = 32;

/** A location-free request is explicit; it never turns a named region into a wildcard. */
export function catalogSatisfiesRequest(item: CatalogItem, request: Row): boolean {
  const gpu = request.requirements?.gpu;
  return (
    Number.isFinite(item.cpu) &&
    Number.isFinite(item.memoryGb) &&
    item.cpu >= request.requirements?.cpu &&
    item.memoryGb >= request.requirements?.memoryGb &&
    item.durationMinutes.includes(request.duration_minutes) &&
    (request.region === 'any' || item.region === request.region) &&
    (!gpu || (gpu === 'any' ? Boolean(item.gpu) : item.gpu === gpu))
  );
}

export function compatibleRequest(request: Row): boolean {
  return request.catalog_snapshot?.matchMode === 'compatible';
}

/** Existing requests retain exact-route semantics. New compatible requests carry a bounded book. */
export function requestCatalogs(request: Row): CatalogItem[] {
  if (!compatibleRequest(request)) return [request.catalog_snapshot as CatalogItem];
  const items = request.catalog_snapshot?.eligibleCatalogs;
  if (
    !Array.isArray(items) ||
    !items.length ||
    items.length > MAX_MATCH_CATALOGS ||
    items.some((item) => !item || typeof item.id !== 'string') ||
    new Set(items.map((item) => item.id)).size !== items.length
  )
    throw new HttpError(
      409,
      'The frozen provider configurations are invalid. Start a new request.',
    );
  return items as CatalogItem[];
}

export function assertManagedCustomerRoute(item: CatalogItem): void {
  if (!isCloudProvider(item.provider) || item.providerKeyId)
    throw new HttpError(400, 'This route is unavailable for managed customer rentals.');
}

/** Resource/scope drift needs a new review even if the published rate stayed the same. */
export function sameCatalogAllocation(frozen: CatalogItem, current: CatalogItem): boolean {
  return (
    frozen.id === current.id &&
    frozen.provider === current.provider &&
    frozen.profile === current.profile &&
    frozen.region === current.region &&
    frozen.cpu === current.cpu &&
    frozen.memoryGb === current.memoryGb &&
    frozen.gpu === current.gpu &&
    frozen.organizationId === current.organizationId &&
    frozen.groupId === current.groupId &&
    frozen.providerKeyId === current.providerKeyId &&
    frozen.resources?.cpu === current.resources?.cpu &&
    frozen.resources?.memoryGb === current.resources?.memoryGb &&
    frozen.resources?.diskGb === current.resources?.diskGb &&
    frozen.resources?.gpu === current.resources?.gpu
  );
}
