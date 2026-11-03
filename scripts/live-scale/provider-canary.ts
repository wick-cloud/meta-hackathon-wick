import assert from 'node:assert/strict';
import { isMoneyCents } from '../../src/shared/money.js';

export const PROVIDER_CANARIES = {
  sail: { profile: 'micro', cpu: 1, memoryGb: 2, diskGb: 8 },
  'provider-tenki': { profile: 'micro', cpu: 1, memoryGb: 1, diskGb: 5 },
  'provider-freestyle': { profile: 'small', cpu: 2, memoryGb: 4, diskGb: 16 },
  boat: { profile: 'small', cpu: 2, memoryGb: 3814 / 1024, diskGb: 8 },
} as const;
export const PROVIDER_SIZE_CANARIES = {
  medium: {
    sail: { profile: 'medium', cpu: 4, memoryGb: 8, diskGb: 32 },
    boat: { profile: 'medium', cpu: 4, memoryGb: 7629 / 1024, diskGb: 32 },
  },
  large: {
    sail: { profile: 'large', cpu: 8, memoryGb: 16, diskGb: 64 },
    boat: { profile: 'large', cpu: 8, memoryGb: 15258 / 1024, diskGb: 116.4150390625 },
  },
} as const;
export type CanaryMode = 'provider-canary' | 'provider-size-canary' | 'provider-size-retry-canary';
export const CANARY_QUOTE_CEILING_CENTS = 20;
export const CANARY_HOLD_MS = 130_000;

export interface CanaryRoute {
  provider: string;
  profile: string;
  region: string;
  catalogId: string;
  offeringId?: string;
  cpu?: number;
  memoryGb?: number;
  diskGb?: number;
  capacity: number;
}

export function validateCanaryRoutes(
  target: number,
  providers: CanaryRoute[],
  mode: CanaryMode = 'provider-canary',
) {
  assert(
    ['provider-canary', 'provider-size-canary', 'provider-size-retry-canary'].includes(mode),
    'CANARY_MODE',
  );
  const sizeMode = mode === 'provider-size-canary';
  const retryMode = mode === 'provider-size-retry-canary';
  assert.equal(target, retryMode ? 1 : sizeMode ? 2 : 4, 'CANARY_REQUEST_LIMIT');
  const profile = providers[0]?.profile;
  if (sizeMode) assert(profile === 'medium' || profile === 'large', 'CANARY_SIZE_WAVE');
  const routes = retryMode
    ? { boat: PROVIDER_SIZE_CANARIES.large.boat }
    : sizeMode
      ? PROVIDER_SIZE_CANARIES[profile as keyof typeof PROVIDER_SIZE_CANARIES]
      : PROVIDER_CANARIES;
  assert.deepEqual(
    providers.map((p) => p.provider).sort(),
    Object.keys(routes).sort(),
    'CANARY_REVIEWED_PROVIDERS',
  );
  for (const p of providers) {
    const expected = routes[p.provider as keyof typeof routes];
    assert.equal(p.profile, expected.profile, 'CANARY_PROFILE');
    assert.equal(p.region, 'auto', 'CANARY_REGION');
    assert.equal(p.catalogId, `${p.provider}:${expected.profile}:auto`, 'CANARY_CATALOG');
    assert.equal(p.cpu, expected.cpu, 'CANARY_CPU');
    assert.equal(p.memoryGb, expected.memoryGb, 'CANARY_MEMORY');
    assert.equal(p.diskGb, expected.diskGb, 'CANARY_DISK');
    assert.equal(p.capacity, 1, 'CANARY_CAPACITY');
    assert(
      typeof p.offeringId === 'string' && /^[0-9a-f-]{36}$/.test(p.offeringId),
      'CANARY_OFFERING',
    );
  }
}

export function validateCanaryBase(base: number, minimum: number, costFloor: number, max?: number) {
  assert(
    isMoneyCents(base) &&
      base >= Math.max(1, minimum, costFloor) &&
      base <= CANARY_QUOTE_CEILING_CENTS &&
      (max === undefined || base <= max),
    'CANARY_BASE_PRICE',
  );
  return base;
}

/** Size qualification follows production's effective base without rewriting saved account policy. */
export function canaryQuote(
  mode: CanaryMode,
  configuredBase: number,
  minimum: number,
  costFloor: number,
  max?: number,
) {
  return validateCanaryBase(
    mode === 'provider-canary' ? configuredBase : Math.max(configuredBase, minimum, costFloor),
    minimum,
    costFloor,
    max,
  );
}
