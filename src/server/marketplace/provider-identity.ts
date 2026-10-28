import type { Pool, PoolClient } from 'pg';
import { HttpError } from '../context.js';

export const CLOUD_PROVIDERS = ['e2b', 'daytona', 'provider-blaxel', 'modal'] as const;
export type CloudProvider = (typeof CLOUD_PROVIDERS)[number];
export interface ProviderIdentity {
  cloud_provider?: string | null;
}

export function assertProviderCatalog(
  provider: ProviderIdentity,
  catalog: { provider: string },
): void {
  if (provider.cloud_provider && provider.cloud_provider !== catalog.provider)
    throw new HttpError(403, 'This configuration belongs to a different provider account.');
}

/** A provider may narrow its policy, but policy edits cannot change its operator-assigned route. */
export async function assertProviderCatalogIds(
  db: Pool | PoolClient,
  provider: ProviderIdentity,
  catalogIds: string[] | undefined,
  sourceMode: 'fixture' | 'real',
): Promise<void> {
  if (!provider.cloud_provider || !catalogIds?.length) return;
  if (catalogIds.length > 100)
    throw new HttpError(400, 'Choose at most 100 provider configurations.');
  const ids = [...new Set(catalogIds)];
  const { rows } = await db.query(
    `SELECT id FROM broker_catalog WHERE id=ANY($1::text[]) AND source_mode=$2
     AND item->>'provider'=$3 FOR SHARE`,
    [ids, sourceMode, provider.cloud_provider],
  );
  if (rows.length !== ids.length)
    throw new HttpError(403, 'Allowed configurations must belong to this provider account.');
}
