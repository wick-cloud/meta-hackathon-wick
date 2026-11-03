import { describe, expect, it } from 'vitest';
import {
  renewalOwnershipMatches,
  renewalRequestAllowed,
} from '../scripts/provider-renewal-proof.js';

const base = new URL('https://wick.example/api');
describe('owned native VM renewal observer restrictions', () => {
  it('allows only exact environment observation and scoped-session creation', () => {
    expect(
      renewalRequestAllowed(
        base,
        'env_owned',
        new URL('https://wick.example/api/v1/environments/env_owned'),
        'GET',
      ),
    ).toBe(true);
    expect(
      renewalRequestAllowed(
        base,
        'env_owned',
        new URL('https://wick.example/api/v1/environments/env_owned/sessions'),
        'POST',
      ),
    ).toBe(true);
  });
  it.each([
    ['https://wick.example/api/v1/environments', 'POST'],
    ['https://wick.example/api/v1/environments/env_owned', 'DELETE'],
    ['https://wick.example/api/v1/environments/env_owned/commands', 'POST'],
    ['https://wick.example/api/v1/environments/env_other/sessions', 'POST'],
    ['https://foreign.example/api/v1/environments/env_owned/sessions', 'POST'],
    ['https://wick.example/api/v1/environments/env_owned/sessions?token=redacted', 'POST'],
    ['https://user:secret@wick.example/api/v1/environments/env_owned', 'GET'],
  ])('refuses all other API surfaces (%s %s)', (url, method) => {
    expect(renewalRequestAllowed(base, 'env_owned', new URL(url), method)).toBe(false);
  });
  it('requires exact frozen identity, run times and managed billing before opening any terminal', () => {
    const now = Date.now();
    const receipt = {
      vmId: '12345678-1234-1234-1234-123456789012',
      environmentId: 'env_owned',
      provider: 'boat',
      profile: 'small',
      region: 'auto',
      createdAt: new Date(now - 1000).toISOString(),
    };
    const environment = {
      id: 'env_owned',
      name: 'wick-broker-12345678',
      organizationId: 'test-org',
      groupId: 'test-group',
      provider: 'boat',
      profile: 'small',
      region: 'auto',
      billingMode: 'wick_managed',
      createdAt: new Date(now).toISOString(),
    };
    const settings = {
      baseUrl: 'https://broker.example',
      mode: 'provider-canary' as const,
      target: 4,
      providers: [],
      wick: {
        baseUrl: base.href,
        token: 'offline-test-token',
        organizationId: 'test-org',
        groupId: 'test-group',
      },
    };
    const start = { at: new Date(now - 2000).toISOString(), deadline: now + 720000 };
    expect(renewalOwnershipMatches(environment, receipt, settings, start, now)).toBe(true);
    expect(
      renewalOwnershipMatches(
        { ...environment, region: 'us-east-1' },
        receipt,
        settings,
        start,
        now,
      ),
    ).toBe(true);
    const explicitReceipt = { ...receipt, region: 'us-east-1' };
    expect(
      renewalOwnershipMatches(
        { ...environment, region: 'us-east-1' },
        explicitReceipt,
        settings,
        start,
        now,
      ),
    ).toBe(true);
    expect(
      renewalOwnershipMatches(
        { ...environment, region: 'us-west-2' },
        explicitReceipt,
        settings,
        start,
        now,
      ),
    ).toBe(false);
    for (const change of [
      { id: 'foreign' },
      { name: 'foreign' },
      { organizationId: 'foreign' },
      { groupId: 'foreign' },
      { provider: 'sail' },
      { profile: 'micro' },
      { region: '' },
      { region: '   ' },
      { billingMode: 'byok' },
      { providerKeyId: 'key' },
      { createdAt: new Date(now - 60000).toISOString() },
    ])
      expect(
        renewalOwnershipMatches({ ...environment, ...change }, receipt, settings, start, now),
      ).toBe(false);
  });
});
