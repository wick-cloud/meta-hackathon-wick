import type { CreateEnvironmentInput, WickAdapter, WickEnvironment } from './types.js';

/** Read-only reconciliation. Absence is uncertainty, never proof that create was rejected. */
export async function discoverEnvironment(
  adapter: WickAdapter,
  input: CreateEnvironmentInput,
  admittedAfter: Date | string,
): Promise<WickEnvironment | undefined> {
  if (!adapter.list) return undefined;
  const earliest = new Date(admittedAfter).getTime() - 1000;
  if (!Number.isFinite(earliest)) return undefined;
  const matches = new Map<string, WickEnvironment>();
  for (const archived of [false, true]) {
    let cursor: string | undefined;
    for (let page = 0; page < 2; page++) {
      const response = await adapter.list({
        organizationId: input.organizationId,
        groupId: input.groupId,
        search: input.name,
        provider: input.provider,
        limit: 50,
        newest: true,
        archived,
        ...(cursor ? { cursor } : {}),
      });
      for (const environment of response.items) {
        const created = Date.parse(environment.createdAt || '');
        if (
          environment.name === input.name &&
          environment.organizationId === input.organizationId &&
          environment.groupId === input.groupId &&
          environment.provider === input.provider &&
          environment.profile === input.profile &&
          (!input.providerKeyId || environment.providerKeyId === input.providerKeyId) &&
          Number.isFinite(created) &&
          created >= earliest &&
          created <= Date.now() + 1000
        )
          matches.set(environment.id, environment);
      }
      if (!response.nextCursor) break;
      cursor = response.nextCursor;
      if (page === 1)
        throw new Error(
          'Environment discovery exceeded its bounded listing; admission remains unknown.',
        );
    }
  }
  if (matches.size !== 1) return undefined;
  return [...matches.values()][0];
}

export function managedEnvironmentMatches(
  environment: WickEnvironment | undefined,
  input: CreateEnvironmentInput,
) {
  return Boolean(
    environment &&
    environment.billingMode === 'wick_managed' &&
    !environment.providerKeyId &&
    environment.organizationId === input.organizationId &&
    environment.groupId === input.groupId &&
    environment.provider === input.provider &&
    environment.profile === input.profile,
  );
}

/** Ownership and billing are separate: an owned unexpected BYOK VM is safe to quarantine. */
export function environmentOwnershipMatches(
  environment: WickEnvironment,
  input: CreateEnvironmentInput,
  createdAfter: Date | string,
) {
  const created = Date.parse(environment.createdAt || '');
  const earliest = new Date(createdAfter).getTime() - 1000;
  return (
    environment.name === input.name &&
    environment.organizationId === input.organizationId &&
    environment.groupId === input.groupId &&
    environment.provider === input.provider &&
    environment.profile === input.profile &&
    (!input.providerKeyId || environment.providerKeyId === input.providerKeyId) &&
    Number.isFinite(created) &&
    Number.isFinite(earliest) &&
    created >= earliest &&
    created <= Date.now() + 1000
  );
}
