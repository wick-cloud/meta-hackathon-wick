import { afterEach, describe, expect, it, vi } from 'vitest';
import { createWickAdapter, parseCatalog } from '../src/server/integrations/wick.js';
import { discoverEnvironment } from '../src/server/integrations/discovery.js';
import type { CreateEnvironmentInput, WickAdapter } from '../src/server/integrations/types.js';

const config = {
  wickMode: 'real' as const,
  wickApiBase: 'https://wick.example/api',
  wickApiKey: 'offline-only',
  wickOrganizationId: 'org_test',
  wickGroupId: 'group_test',
};
const input: CreateEnvironmentInput = {
  organizationId: 'org_test',
  groupId: 'group_test',
  name: 'broker-unique-owned',
  provider: 'e2b',
  profile: 'small',
  region: 'auto',
  ttlSeconds: 900,
  visibility: 'private',
  maximumPriceMicrosPerSecond: 5,
};
const observed = {
  ...input,
  id: 'owned-environment',
  billingMode: 'wick_managed',
  createdAt: new Date().toISOString(),
  expiresAt: new Date(Date.now() + 900000).toISOString(),
  status: 'running',
};
afterEach(() => vi.unstubAllGlobals());

describe('read-only Wick discovery and managed route verification', () => {
  it('uses the official bounded organization list wire contract and retains ownership/billing evidence', async () => {
    const fetcher = vi.fn(
      async () => new Response(JSON.stringify({ data: [observed], nextCursor: null })),
    );
    vi.stubGlobal('fetch', fetcher);
    const adapter = createWickAdapter(config);
    const found = await discoverEnvironment(adapter, input, new Date(Date.now() - 5000));
    expect(found).toMatchObject({
      id: observed.id,
      name: input.name,
      organizationId: input.organizationId,
      groupId: input.groupId,
      billingMode: 'wick_managed',
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
    for (const call of fetcher.mock.calls) {
      const [url, options] = call as unknown as [URL, RequestInit];
      const parsed = new URL(url);
      expect(parsed.pathname).toBe('/api/v1/organizations/org_test/environments');
      expect(Object.fromEntries(parsed.searchParams)).toMatchObject({
        groupId: 'group_test',
        search: input.name,
        provider: 'e2b',
        limit: '50',
        newest: 'true',
      });
      expect(options.method).toBe('GET');
    }
  });
  it('keeps absent, foreign, old, and duplicate matches uncertain without ever creating', async () => {
    const create = vi.fn();
    for (const items of [
      [],
      [{ ...observed, groupId: 'foreign' }],
      [{ ...observed, createdAt: '2020-01-01' }],
      [observed, { ...observed, id: 'ambiguous' }],
    ]) {
      const adapter = { list: vi.fn(async () => ({ items })), create } as unknown as WickAdapter;
      expect(
        await discoverEnvironment(adapter, input, new Date(Date.now() - 5000)),
      ).toBeUndefined();
    }
    expect(create).not.toHaveBeenCalled();
  });
  it('discovers exactly owned unexpected BYOK for cleanup without accepting a mismatched explicit key', async () => {
    const byok = { ...observed, billingMode: 'byok', providerKeyId: 'unexpected-key' };
    const adapter = {
      list: vi.fn(async () => ({ items: [byok] })),
      create: vi.fn(),
    } as unknown as WickAdapter;
    expect(await discoverEnvironment(adapter, input, new Date(Date.now() - 5000))).toMatchObject({
      id: observed.id,
      billingMode: 'byok',
    });
    expect(
      await discoverEnvironment(
        adapter,
        { ...input, providerKeyId: 'different-key' },
        new Date(Date.now() - 5000),
      ),
    ).toBeUndefined();
    expect(adapter.create).not.toHaveBeenCalled();
  });
  it('rejects an unregistered provider create before any request regardless of a frozen rate', async () => {
    const fetcher = vi.fn();
    vi.stubGlobal('fetch', fetcher);
    await expect(
      createWickAdapter(config).create(
        { ...input, provider: 'provider-unknown' },
        'never-unknown-123',
      ),
    ).rejects.toThrow(/registered managed/);
    expect(fetcher).not.toHaveBeenCalled();
  });
  it.each(['wick_managed', 'byok', 'unknown', 'foreign-organization', 'foreign-group'])(
    'verifies E2B selected %s route through the official read-only execution preview',
    async (billingMode) => {
      const offer = {
        provider: 'e2b',
        profile: 'micro',
        region: 'us',
        available: true,
        maxTtlSeconds: 900,
        rateMicrosPerSecond: 23,
        byok: { enabled: true },
        resources: { cpu: 1, memoryMiB: 1024, diskMiB: 5120 },
      };
      const fetcher = vi.fn(
        async (url: URL) =>
          new Response(
            JSON.stringify(
              String(url).endsWith('/execution-preview')
                ? {
                    kind: 'environment',
                    organizationId:
                      billingMode === 'foreign-organization'
                        ? 'foreign'
                        : config.wickOrganizationId,
                    groupId: billingMode === 'foreign-group' ? 'foreign' : config.wickGroupId,
                    eligible: true,
                    selectedOffer: {
                      provider: 'e2b',
                      profile: 'micro',
                      region: 'us',
                      billingMode: billingMode.startsWith('foreign-')
                        ? 'wick_managed'
                        : billingMode,
                      externalCompute: billingMode === 'byok',
                      ...(billingMode === 'byok' ? { providerKeyId: 'organization-key' } : {}),
                    },
                    fallbackOffers: [],
                  }
                : {
                    profiles: [{ id: 'micro', name: 'Micro', cpu: 1, memoryMiB: 1024 }],
                    offers: [offer, { ...offer, provider: 'provider-unknown' }],
                  },
            ),
          ),
      );
      vi.stubGlobal('fetch', fetcher);
      const items = await createWickAdapter(config).catalog();
      if (billingMode === 'wick_managed')
        expect(items).toEqual([
          expect.objectContaining({
            id: 'e2b:micro:us',
            managedRouteVerification: 'execution-preview-managed',
            rateMicrosPerSecond: 23,
          }),
        ]);
      else expect(items).toEqual([]);
      expect(fetcher).toHaveBeenCalledTimes(2);
      const [url, options] = fetcher.mock.calls[1] as unknown as [URL, RequestInit];
      expect(String(url)).toBe('https://wick.example/api/v1/execution-preview');
      expect(options.method).toBe('POST');
      expect(JSON.parse(String(options.body))).toEqual({
        kind: 'environment',
        input: {
          organizationId: config.wickOrganizationId,
          groupId: config.wickGroupId,
          name: 'wick-broker-route-preview',
          provider: 'e2b',
          profile: 'micro',
          region: 'us',
          ttlSeconds: 900,
          visibility: 'private',
          maximumPriceMicrosPerSecond: 23,
        },
      });
      expect(fetcher.mock.calls.some((call) => String(call[0]).endsWith('/environments'))).toBe(
        false,
      );
    },
  );
  it('excludes ambiguous BYOK/scope/provider routes while accepting the filtered scoped E2B response', () => {
    const offer = {
      provider: 'e2b',
      profile: 'small',
      region: 'auto',
      available: true,
      maxTtlSeconds: 900,
      rateMicrosPerSecond: 5,
      byok: { enabled: false },
    };
    const catalog = {
      profiles: [{ id: 'small', name: 'Small', cpu: 2, memoryMiB: 3814 }],
      offers: [
        offer,
        { ...offer, scope: 'private' },
        { ...offer, scope: 'organization' },
        { ...offer, byok: { enabled: true } },
        { ...offer, provider: 'other' },
        { ...offer, provider: 'provider-unknown' },
        { ...offer, byok: undefined },
      ],
    };
    const selected = parseCatalog(catalog, config);
    expect(selected).toHaveLength(1);
    expect(selected[0]).toMatchObject({
      memoryGb: 3814 / 1024,
      managedRouteVerification: 'organization-catalog-byok-disabled',
    });
  });
});
