import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  PROVIDER_CANARIES,
  validateCanaryBase,
  validateCanaryRoutes,
} from '../scripts/live-scale/provider-canary.js';

const routes = () =>
  Object.entries(PROVIDER_CANARIES).map(([provider, resources]) => ({
    provider,
    ...resources,
    region: 'auto',
    catalogId: `${provider}:${resources.profile}:auto`,
    offeringId: randomUUID(),
    capacity: 1,
  }));
describe('reviewed provider canary authority', () => {
  it('permits only the exact four resource profiles with one slot each', () => {
    expect(() => validateCanaryRoutes(4, routes())).not.toThrow();
    for (const change of [
      { profile: 'micro' },
      { cpu: 1 },
      { memoryGb: 2 },
      { diskGb: 10 },
      { capacity: 2 },
      { region: 'us' },
      { catalogId: 'boat:micro:auto' },
      { offeringId: '' },
    ]) {
      const input = routes();
      Object.assign(
        input.find((p) => p.provider === 'boat')!,
        change,
      );
      expect(() => validateCanaryRoutes(4, input)).toThrow();
    }
    expect(() => validateCanaryRoutes(20, routes())).toThrow();
    expect(() => validateCanaryRoutes(4, routes().slice(1))).toThrow();
    expect(() => validateCanaryRoutes(4, [routes()[0], ...routes().slice(0, 3)])).toThrow();
  });
  it('preserves fractional base quotes and never silently changes price to fit a bound', () => {
    expect(validateCanaryBase(10.8, 1, 4.0236, 20)).toBe(10.8);
    expect(validateCanaryBase(20, 1, 1)).toBe(20);
    for (const args of [
      [20.0001, 1, 1],
      [10.8, 1, 11],
      [10.8, 11, 1],
      [10.8, 1, 1, 10],
      [1.00001, 1, 1],
      [NaN, 1, 1],
    ])
      expect(() => validateCanaryBase(...(args as [number, number, number, number?]))).toThrow();
  });
});
