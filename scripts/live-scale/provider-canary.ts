import assert from 'node:assert/strict';
import { isMoneyCents } from '../../src/shared/money.js';

export const PROVIDER_CANARIES = {
  sail: { profile: 'micro', cpu: 1, memoryGb: 2, diskGb: 8 },
  'provider-tenki': { profile: 'micro', cpu: 1, memoryGb: 1, diskGb: 5 },
  'provider-freestyle': { profile: 'small', cpu: 2, memoryGb: 4, diskGb: 16 },
  boat: { profile: 'small', cpu: 2, memoryGb: 3814 / 1024, diskGb: 8 },
} as const;
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

export function validateCanaryRoutes(target: number, providers: CanaryRoute[]) {
  assert.equal(target, 4, 'Canary qualification permits exactly four request attempts.');
  assert.deepEqual(
    providers.map((p) => p.provider).sort(),
    Object.keys(PROVIDER_CANARIES).sort(),
    'Canary qualification requires the four exact reviewed providers.',
  );
  for (const p of providers) {
    const expected = PROVIDER_CANARIES[p.provider as keyof typeof PROVIDER_CANARIES];
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
