import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  renewalOwnershipMatches,
  renewalRequestAllowed,
  runRenewalObservers,
} from '../scripts/provider-renewal-proof.js';
import {
  CANARY_HOLD_MS,
  CANARY_QUOTE_CEILING_CENTS,
  PROVIDER_CANARIES,
  PROVIDER_SIZE_CANARIES,
} from '../scripts/live-scale/provider-canary.js';
import type { Journal, JournalRecord } from '../scripts/live-scale/safety.js';

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

function observerRun(profile?: keyof typeof PROVIDER_SIZE_CANARIES, retry = false) {
  const settings: Parameters<typeof runRenewalObservers>[0] = {
    baseUrl: 'https://broker.example',
    mode: retry
      ? 'provider-size-retry-canary'
      : profile
        ? 'provider-size-canary'
        : 'provider-canary',
    target: retry ? 1 : profile ? 2 : 4,
    providers: Object.entries(profile ? PROVIDER_SIZE_CANARIES[profile] : PROVIDER_CANARIES)
      .filter(([provider]) => !retry || provider === 'boat')
      .map(([provider, route], index) => ({
        provider,
        ...route,
        region: 'auto',
        catalogId: `${provider}:${route.profile}:auto`,
        offeringId: `00000000-0000-4000-8000-00000000000${index + 1}`,
        capacity: 1,
        rateMicrosPerSecond: 1,
        basePriceCents: 3,
      })),
    wick: {
      baseUrl: 'https://wick.example',
      token: 'offline-test-token',
      organizationId: 'test-org',
      groupId: 'test-group',
    },
  };
  const fingerprint = createHash('sha256')
    .update(
      JSON.stringify({
        baseUrl: settings.baseUrl,
        scope: [settings.wick.organizationId, settings.wick.groupId],
        providers: settings.providers.map((p) => [
          p.provider,
          p.catalogId,
          p.profile,
          p.region,
          p.rateMicrosPerSecond,
        ]),
        mode: settings.mode,
        target: settings.target,
        quoteCeilingCents: CANARY_QUOTE_CEILING_CENTS,
        terminalHoldMs: CANARY_HOLD_MS,
        canaries: settings.providers.map((p) => [
          p.provider,
          p.offeringId,
          p.cpu,
          p.memoryGb,
          p.diskGb,
          p.capacity,
          p.basePriceCents,
        ]),
      }),
    )
    .digest('hex');
  const now = Date.now();
  const at = new Date(now).toISOString();
  const runId = '00000000-0000-4000-8000-000000000099';
  const records: JournalRecord[] = [
    {
      kind: 'prepared',
      at,
      runId,
      mode: settings.mode,
      target: settings.target,
      maximumRunMs: 720000,
      baseUrl: settings.baseUrl,
      fingerprint,
    },
    // Too little time to open any terminal: still exercises the complete journal gate.
    { kind: 'runner-start', at, deadline: now + 60000 },
    ...settings.providers.flatMap((p, index) => {
      const item = index + 1;
      const requestId = `request-${item}`;
      return [
        {
          kind: 'request-intent',
          at,
          item,
          body: {
            description: `Broker hosted scale ${runId} item ${item}`,
            catalogId: p.catalogId,
            durationMinutes: 15,
          },
        },
        { kind: 'request-result', at, item, requestId },
        {
          kind: 'vm-receipt',
          at,
          vmId: `00000000-0000-4000-8000-00000000001${item}`,
          requestId,
          environmentId: `env-owned-${item}`,
          provider: p.provider,
          profile: p.profile,
          region: p.region,
          createdAt: at,
        },
      ];
    }),
  ];
  const journal = {
    read: () => records,
    append: (kind: string, fields: Record<string, unknown>) =>
      records.push({ kind, at, ...fields }),
  } as unknown as Journal;
  return { settings, records, journal };
}

describe('renewal observer frozen qualification modes', () => {
  it.each([undefined, 'medium', 'large'] as const)(
    'accepts only the frozen %s run and skips terminals without sufficient time',
    async (profile) => {
      const { settings, journal } = observerRun(profile);
      const fetch = vi.spyOn(globalThis, 'fetch');
      try {
        const results = await runRenewalObservers(settings, journal);
        expect(results).toHaveLength(profile ? 2 : 4);
        expect(results.every((r) => r.outcome === 'insufficient-run-time')).toBe(true);
        expect(fetch).not.toHaveBeenCalled();
      } finally {
        fetch.mockRestore();
      }
    },
  );
  it('rejects more receipts than the two-size-run attempt limit', async () => {
    const { settings, records, journal } = observerRun('medium');
    records.push({
      ...records.find((r) => r.kind === 'vm-receipt')!,
      vmId: '00000000-0000-4000-8000-000000000019',
      environmentId: 'env-extra',
    });
    await expect(runRenewalObservers(settings, journal)).rejects.toThrow('RECEIPT_BOUND');
  });
  it('rejects a journal from another qualification mode', async () => {
    const { settings, records, journal } = observerRun('large');
    records[0]!.mode = 'provider-canary';
    await expect(runRenewalObservers(settings, journal)).rejects.toThrow('JOURNAL_SCOPE');
  });
  it('rejects a journal with a changed reviewed route quote', async () => {
    const { settings, journal } = observerRun('medium');
    settings.providers[0]!.basePriceCents = 4;
    await expect(runRenewalObservers(settings, journal)).rejects.toThrow('JOURNAL_SCOPE');
  });
  it('accepts the bounded Boat Large singleton journal without opening a network session', async () => {
    const { settings, journal } = observerRun('large', true);
    const fetch = vi.spyOn(globalThis, 'fetch');
    try {
      const results = await runRenewalObservers(settings, journal);
      expect(results).toHaveLength(1);
      expect(results[0]).toMatchObject({ provider: 'boat', outcome: 'insufficient-run-time' });
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      fetch.mockRestore();
    }
  });
  it('rejects a second singleton receipt', async () => {
    const { settings, records, journal } = observerRun('large', true);
    records.push({
      ...records.find((r) => r.kind === 'vm-receipt')!,
      vmId: '00000000-0000-4000-8000-000000000019',
      environmentId: 'env-extra',
    });
    await expect(runRenewalObservers(settings, journal)).rejects.toThrow('RECEIPT_BOUND');
  });
  it('rejects the Medium profile in singleton retry mode', async () => {
    const { settings, journal } = observerRun('medium', true);
    await expect(runRenewalObservers(settings, journal)).rejects.toThrow('CANARY_PROFILE');
  });
  it('rejects a target greater than one in singleton retry mode', async () => {
    const { settings, journal } = observerRun('large', true);
    settings.target = 2;
    await expect(runRenewalObservers(settings, journal)).rejects.toThrow('CANARY_REQUEST_LIMIT');
  });
});
