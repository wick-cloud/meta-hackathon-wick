import { describe, expect, it } from 'vitest';
import { providerSetupOptions } from '../scripts/provider-setup-options.js';
import { providerSetupBasePrice } from '../src/server/marketplace/configure-real.js';

describe('explicit provider setup command', () => {
  it('requires a subset rather than implicitly reconfiguring every provider', () => {
    expect(() => providerSetupOptions([], {})).toThrow('Explicit');
    expect(() => providerSetupOptions(['--providers'], {})).toThrow('subset');
    expect(() => providerSetupOptions(['--providers', 'unknown'], {})).toThrow('registered');
    expect(() => providerSetupOptions(['--providers', 'tenki,provider-tenki'], {})).toThrow('once');
    expect(() =>
      providerSetupOptions(['--providers', 'boat', '--stage', '--activate'], {}),
    ).toThrow('Use');
  });
  it('selects only four additions, defaults to staged one-slot accounts, and reads private credentials from their own variables', () => {
    const parsed = providerSetupOptions(['--providers', 'sail,tenki,freestyle,boat'], {
      REAL_PROVIDER_SAIL_EMAIL: 'sail@test.invalid',
      REAL_PROVIDER_SAIL_PASSWORD: 'private-synthetic-password',
      REAL_PROVIDER_SAIL_CATALOG_IDS: 'sail:micro:auto',
      REAL_PROVIDER_BOAT_CAPACITY: '2',
    });
    expect(parsed.mode).toBe('stage');
    expect(parsed.updateExisting).toBe(false);
    expect(parsed.providers.map((p) => p.cloudProvider)).toEqual([
      'sail',
      'provider-tenki',
      'provider-freestyle',
      'boat',
    ]);
    expect(parsed.providers.map((p) => p.capacity)).toEqual([1, 1, 1, 2]);
    expect(parsed.providers[0]).toMatchObject({
      email: 'sail@test.invalid',
      password: 'private-synthetic-password',
      catalogIds: ['sail:micro:auto'],
    });
    expect(parsed.providers[3].name).toBe('Boat.dev');
  });
  it('requires explicit activation/update and permits omitted passwords for existing accounts', () => {
    const parsed = providerSetupOptions(['--activate', '--update-existing'], {
      REAL_PROVIDER_IDS: 'provider-tenki',
      REAL_PROVIDER_CAPACITY: '3',
      REAL_PROVIDER_TENKI_AUTO_BID: 'false',
    });
    expect(parsed).toMatchObject({
      mode: 'activate',
      updateExisting: true,
      providers: [
        { cloudProvider: 'provider-tenki', capacity: 3, autoBid: false, password: undefined },
      ],
    });
    expect(() =>
      providerSetupOptions([], { REAL_PROVIDER_IDS: 'boat', REAL_PROVIDER_BOAT_AUTO_BID: 'yes' }),
    ).toThrow('true or false');
  });
  it('prices the requested twenty percent base margin at the supported money precision', () => {
    expect(providerSetupBasePrice(3)).toBe(3.6);
    expect(providerSetupBasePrice(1.01)).toBe(1.22);
    expect(providerSetupBasePrice(100)).toBe(120);
  });
});
