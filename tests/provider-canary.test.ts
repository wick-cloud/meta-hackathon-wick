import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  PROVIDER_CANARIES,
  PROVIDER_SIZE_CANARIES,
  canaryQuote,
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
  const sizeRoutes = (profile: 'medium' | 'large') =>
    Object.entries(PROVIDER_SIZE_CANARIES[profile]).map(([provider, resources]) => ({
      provider,
      ...resources,
      region: 'auto',
      catalogId: `${provider}:${profile}:auto`,
      offeringId: randomUUID(),
      capacity: 1,
    }));
  it('confines the singleton retry to Boat Large and cannot weaken the two-route size wave', () => {
    const boat = sizeRoutes('large').filter((p) => p.provider === 'boat');
    expect(() => validateCanaryRoutes(1, boat, 'provider-size-retry-canary')).not.toThrow();
    expect(() => validateCanaryRoutes(2, boat, 'provider-size-retry-canary')).toThrow();
    expect(() => validateCanaryRoutes(1, boat, 'provider-size-canary')).toThrow();
    expect(() =>
      validateCanaryRoutes(1, sizeRoutes('large'), 'provider-size-retry-canary'),
    ).toThrow();
    expect(() =>
      validateCanaryRoutes(1, [boat[0], boat[0]], 'provider-size-retry-canary'),
    ).toThrow();
    expect(() =>
      validateCanaryRoutes(
        1,
        sizeRoutes('large').filter((p) => p.provider === 'sail'),
        'provider-size-retry-canary',
      ),
    ).toThrow();
    expect(() =>
      validateCanaryRoutes(
        1,
        sizeRoutes('medium').filter((p) => p.provider === 'boat'),
        'provider-size-retry-canary',
      ),
    ).toThrow();
    expect(canaryQuote('provider-size-retry-canary', 2.4, 1, 3)).toBe(3);
    expect(() => canaryQuote('provider-size-retry-canary', 2.4, 1, 21)).toThrow();
  });
  it.each(['medium', 'large'] as const)(
    'permits exactly the reviewed two %s routes in an isolated size wave',
    (profile) => {
      expect(() =>
        validateCanaryRoutes(2, sizeRoutes(profile), 'provider-size-canary'),
      ).not.toThrow();
      expect(() => validateCanaryRoutes(4, sizeRoutes(profile), 'provider-size-canary')).toThrow();
      expect(() => validateCanaryRoutes(2, sizeRoutes(profile))).toThrow();
      expect(() =>
        validateCanaryRoutes(
          2,
          [sizeRoutes(profile)[0], sizeRoutes(profile)[0]],
          'provider-size-canary',
        ),
      ).toThrow();
      const mixed = [sizeRoutes('medium')[0], sizeRoutes('large')[1]];
      expect(() => validateCanaryRoutes(2, mixed, 'provider-size-canary')).toThrow();
      const inflated = sizeRoutes(profile);
      inflated[0].memoryGb += 1;
      expect(() => validateCanaryRoutes(2, inflated, 'provider-size-canary')).toThrow();
    },
  );
  it('uses the safe effective base for larger sizes without discounting a higher saved base', () => {
    expect(canaryQuote('provider-size-canary', 3.6, 1, 5)).toBe(5);
    expect(canaryQuote('provider-size-canary', 3.6, 1, 9)).toBe(9);
    expect(canaryQuote('provider-size-canary', 2.4, 1, 2)).toBe(2.4);
    expect(canaryQuote('provider-size-canary', 2.4, 1, 3)).toBe(3);
    expect(canaryQuote('provider-size-canary', 2.4, 7, 3)).toBe(7);
    expect(() => canaryQuote('provider-size-canary', 2.4, 1, 21)).toThrow();
    expect(() => canaryQuote('provider-size-canary', 2.4, 1, 9, 8)).toThrow();
    expect(() => canaryQuote('provider-canary', 2.4, 1, 3)).toThrow();
  });
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
