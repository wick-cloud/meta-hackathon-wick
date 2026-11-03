import { CLOUD_PROVIDERS, PROVIDER_REGISTRY } from '../src/shared/providers.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createWickAdapter,
  parseCatalog,
  parseConnections,
  parseCreateResult,
  parseEnvironment,
  parseSession,
  WickApiError,
} from '../src/server/integrations/wick.js';
import type { CreateEnvironmentInput } from '../src/server/integrations/types.js';

const config = {
  wickMode: 'real' as const,
  wickApiBase: 'https://wick.example/api',
  wickApiKey: 'test-service-key',
  wickOrganizationId: 'org_test',
  wickGroupId: 'grp_test',
};
const create: CreateEnvironmentInput = {
  organizationId: 'org_test',
  groupId: 'grp_test',
  name: 'broker-test',
  provider: 'e2b',
  profile: 'small',
  region: 'us-east',
  ttlSeconds: 1800,
  maximumPriceMicrosPerSecond: 5,
  visibility: 'private',
};
// Synthetic values shaped against the public OpenAPI, not captured customer data.
const environment = {
  id: 'env_test',
  status: 'provisioning',
  createdAt: '2026-10-28T06:00:00.000Z',
  expiresAt: '2026-10-28T06:30:00.000Z',
  provider: 'e2b',
  profile: 'small',
  requiresReconciliation: false,
};
const mutation = {
  environment,
  operation: { id: 'op_test', status: 'running', type: 'create' },
  replayed: false,
};
const managedProviders = CLOUD_PROVIDERS;
const catalogOffer = (provider: string, region = 'auto') => ({
  provider,
  byok: { enabled: true },
  profile: 'small',
  region,
  maxTtlSeconds: 3600,
  available: true,
  rateMicrosPerSecond: 5,
});
const catalogResponse = (offers: ReturnType<typeof catalogOffer>[]) => ({
  profiles: [{ id: 'small', name: 'Small', cpu: 2, memoryMiB: 4096 }],
  offers,
});
const routePreview = (input: Pick<CreateEnvironmentInput, 'provider' | 'profile' | 'region'>) => ({
  kind: 'environment',
  organizationId: config.wickOrganizationId,
  groupId: config.wickGroupId,
  eligible: true,
  selectedOffer: {
    provider: input.provider,
    profile: input.profile,
    region: input.region,
    billingMode: 'wick_managed',
    externalCompute: false,
  },
  fallbackOffers: [],
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('public Wick REST contract', () => {
  it('retains the documented mutation envelope and authoritative expiry', () => {
    const parsed = parseCreateResult(mutation);
    expect(parsed.environment.expiresAt).toBe(environment.expiresAt);
    expect(parsed.operation).toEqual({ id: 'op_test', status: 'running' });
    expect(parsed.raw).toBe(mutation);
    expect(parsed.environment.raw).toBe(environment);
    expect(() => parseCreateResult({ data: mutation })).toThrow('operation');
  });
  it('does not synthesize expiry, ready state, or cleanup from unrelated fields', () => {
    expect(
      parseEnvironment({ id: 'env_test', status: 'provisioning', ttlSeconds: 1800 }).expiresAt,
    ).toBeNull();
    expect(() => parseEnvironment({ ...environment, status: 'paused' })).toThrow('unsupported');
    expect(() => parseEnvironment({ ...environment, expiresAt: 'tomorrow' })).toThrow('expiresAt');
    expect(() => parseConnections({ terminalWebsocketUrl: 'wss://wick.example' })).toThrow();
    expect(parseConnections({ provider: 'e2b', terminal: false, ssh: true })).toEqual({
      terminal: false,
    });
  });
  it('reads session expiry from nested public session and enforces environment scope', () => {
    const expiresAt = new Date(Date.now() + 240_000).toISOString();
    const response = {
      session: { id: 'session_test', environmentId: 'env_test', expiresAt },
      token: 'scoped-token',
      terminalWebsocketUrl: 'wss://wick.example/terminal',
    };
    expect(parseSession(response, 'env_test')).toEqual({
      token: response.token,
      terminalWebsocketUrl: response.terminalWebsocketUrl,
      expiresAt,
    });
    expect(() => parseSession(response, 'another-env')).toThrow('scope');
    expect(() =>
      parseSession({ ...response, terminalWebsocketUrl: 'http://127.0.0.1/' }, 'env_test'),
    ).toThrow('secure');
    expect(() =>
      parseSession(
        { ...response, session: { ...response.session, expiresAt: '2020-01-01' } },
        'env_test',
      ),
    ).toThrow('expiring');
    expect(() =>
      parseSession(
        { token: 'x', terminalWebsocketUrl: 'wss://wick.example', expiresAt },
        'env_test',
      ),
    ).toThrow('session');
  });
  it('maps only available offers and exact supported finite TTLs; starts real choices unapproved', () => {
    const offer = {
      provider: 'e2b',
      byok: { enabled: false },
      profile: 'small',
      region: 'us-east',
      maxTtlSeconds: 1800,
      available: true,
      rateMicrosPerSecond: 5,
    };
    const catalog = parseCatalog(
      {
        profiles: [
          { id: 'small', name: 'Small', cpu: 2, memoryMiB: 4096, description: 'Small machine' },
        ],
        offers: [
          offer,
          { ...offer, region: 'elsewhere', available: false },
          { ...offer, region: 'too-short', maxTtlSeconds: 899 },
        ],
      },
      config,
    );
    expect(catalog).toEqual([
      expect.objectContaining({
        id: 'e2b:small:us-east',
        name: 'Small · E2B',
        description: 'Small machine',
        provider: 'e2b',
        profile: 'small',
        region: 'us-east',
        cpu: 2,
        memoryGb: 4,
        durationMinutes: [15, 30],
        approved: false,
        organizationId: 'org_test',
        groupId: 'grp_test',
        rateMicrosPerSecond: 5,
        rateSource: 'wick-customer-catalog',
        rateRetrievedAt: expect.any(String),
        pricingMode: 'managed',
      }),
    ]);
    expect(() => parseCatalog({ items: [] }, config)).toThrow('profiles and offers');
  });
  it('excludes an available route with explicit terminal omission while retaining the other registered providers', async () => {
    const offers = managedProviders.map((provider) => ({
      ...catalogOffer(provider),
      capabilities:
        provider === 'provider-blaxel'
          ? ['command-execution', 'file-transfer']
          : ['command-execution', 'interactive-terminal'],
    }));
    const raw = catalogResponse(offers);
    const previewed: string[] = [];
    const fetcher = vi.fn(async (url: URL, options?: RequestInit) => {
      if (String(url).endsWith('/execution-preview')) {
        const input = JSON.parse(String(options?.body)).input;
        previewed.push(input.provider);
        return new Response(JSON.stringify(routePreview(input)));
      }
      return new Response(JSON.stringify(raw));
    });
    vi.stubGlobal('fetch', fetcher);
    const items = await createWickAdapter(config).catalog();
    expect(items.map((item) => item.provider)).toEqual(
      managedProviders.filter((id) => id !== 'provider-blaxel'),
    );
    expect(previewed).toEqual(managedProviders.filter((id) => id !== 'provider-blaxel'));
    expect(fetcher.mock.calls.every(([url]) => !String(url).endsWith('/environments'))).toBe(true);
  });
  it.each([
    { capabilities: [], accepted: false },
    { capabilities: ['command-execution'], accepted: false },
    { capabilities: ['interactive-terminal'], accepted: true },
    { capabilities: undefined, accepted: true },
  ])(
    'honors explicit selected-offer terminal capability while preserving legacy unknown: $accepted / $capabilities',
    async ({ capabilities, accepted }) => {
      const offer = catalogOffer('e2b');
      const fetcher = vi.fn(async (url: URL, options?: RequestInit) => {
        if (String(url).endsWith('/execution-preview')) {
          const input = JSON.parse(String(options?.body)).input;
          const preview = routePreview(input);
          return new Response(
            JSON.stringify({
              ...preview,
              selectedOffer: {
                ...preview.selectedOffer,
                ...(capabilities === undefined ? {} : { capabilities }),
              },
            }),
          );
        }
        return new Response(JSON.stringify(catalogResponse([offer])));
      });
      vi.stubGlobal('fetch', fetcher);
      const adapter = createWickAdapter(config);
      expect(await adapter.catalog()).toHaveLength(accepted ? 1 : 0);
      if (!accepted) {
        await expect(adapter.preview({ ...create, region: 'auto' })).rejects.toThrow(
          'managed billing route',
        );
        expect(
          fetcher.mock.calls.every(([url]) => !String(url).endsWith('/environments/preview')),
        ).toBe(true);
      }
    },
  );
  it('uses Bearer auth, the persisted idempotency key, and only allowed create fields', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify(mutation), { status: 202 }));
    vi.stubGlobal('fetch', fetcher);
    const adapter = createWickAdapter(config);
    await adapter.create(
      {
        ...create,
        agent: 'codex',
        repository: { url: 'https://example.invalid/private' },
        setup: 'run something',
        environmentDefinition: { schemaVersion: 1, setup: [{ command: 'not authorized' }] },
      } as CreateEnvironmentInput,
      'persisted-key-123',
    );
    expect(fetcher).toHaveBeenCalledOnce();
    const [url, options] = fetcher.mock.calls[0]! as unknown as [URL, RequestInit];
    expect(url.toString()).toBe('https://wick.example/api/v1/environments');
    expect(options.redirect).toBe('error');
    expect(Object.fromEntries(new Headers(options.headers))).toMatchObject({
      authorization: 'Bearer test-service-key',
      'idempotency-key': 'persisted-key-123',
    });
    expect(JSON.parse(String(options.body))).toEqual(create);
  });
  it.each(managedProviders)(
    'uses the filtered %s customer catalog and verifies selected managed billing',
    async (provider) => {
      const offer = {
        provider,
        byok: { enabled: false },
        profile: 'small',
        region: 'auto',
        maxTtlSeconds: 3600,
        available: true,
        rateMicrosPerSecond: 5,
        resources: { cpu: 1, memoryMiB: 2048, diskMiB: 4096 },
      };
      const fetcher = vi.fn(
        async (url: URL) =>
          new Response(
            JSON.stringify(
              String(url).endsWith('/execution-preview')
                ? {
                    kind: 'environment',
                    organizationId: config.wickOrganizationId,
                    groupId: config.wickGroupId,
                    eligible: true,
                    selectedOffer: {
                      provider,
                      profile: 'small',
                      region: 'auto',
                      billingMode: 'wick_managed',
                      externalCompute: false,
                    },
                    fallbackOffers: [],
                  }
                : {
                    profiles: [{ id: 'small', name: 'Small', cpu: 2, memoryMiB: 4096 }],
                    offers: [offer, { ...offer, providerKeyId: 'byok-unapproved' }],
                  },
            ),
          ),
      );
      vi.stubGlobal('fetch', fetcher);
      const items = await createWickAdapter(config).catalog();
      expect(fetcher).toHaveBeenCalledTimes(2);
      expect(items).toHaveLength(1);
      expect(items[0]).toMatchObject({
        id: `${provider}:small:auto`,
        cpu: 1,
        memoryGb: 2,
        resources: { cpu: 1, memoryGb: 2, diskGb: 4 },
        rateMicrosPerSecond: 5,
        pricingMode: 'managed',
        approved: false,
      });
      expect(items[0]).not.toHaveProperty('gpu');
      expect(items[0]).not.toHaveProperty('providerKeyId');
      expect(items[0]!.name).toBe(
        `Small · ${provider === 'provider-blaxel' ? 'Baseten (Blaxel)' : PROVIDER_REGISTRY.find(({ id }) => id === provider)!.name}`,
      );
      if (provider === 'provider-blaxel')
        expect(items[0]!.description).toContain('CPU and disk figures are estimates');
      expect(Number.isFinite(Date.parse(items[0]!.rateRetrievedAt!))).toBe(true);
    },
  );
  it('retains the new providers’ exact resources and offered durations without synthesizing sizes', () => {
    const raw = {
      profiles: [
        { id: 'micro', name: 'Micro', cpu: 1, memoryMiB: 2048 },
        { id: 'small', name: 'Small', cpu: 2, memoryMiB: 4096 },
      ],
      offers: [
        {
          ...catalogOffer('sail'),
          profile: 'micro',
          resources: { cpu: 1, memoryMiB: 2048, diskMiB: 8192 },
        },
        {
          ...catalogOffer('provider-tenki'),
          profile: 'micro',
          maxTtlSeconds: 1800,
          resources: { cpu: 1, memoryMiB: 1024, diskMiB: 5120 },
        },
        {
          ...catalogOffer('provider-freestyle'),
          resources: { cpu: 2, memoryMiB: 4096, diskMiB: 16384 },
        },
        { ...catalogOffer('boat'), resources: { cpu: 2, memoryMiB: 3814, diskMiB: 8192 } },
        { ...catalogOffer('boat', 'too-short'), maxTtlSeconds: 120 },
      ].map((offer) => ({
        ...offer,
        byok: { enabled: false },
        capabilities: ['interactive-terminal'],
      })),
    };
    const items = parseCatalog(raw, config);
    expect(
      items.map(({ id, cpu, memoryGb, durationMinutes }) => ({
        id,
        cpu,
        memoryGb,
        durationMinutes,
      })),
    ).toEqual([
      { id: 'sail:micro:auto', cpu: 1, memoryGb: 2, durationMinutes: [15, 30, 60] },
      { id: 'provider-tenki:micro:auto', cpu: 1, memoryGb: 1, durationMinutes: [15, 30] },
      { id: 'provider-freestyle:small:auto', cpu: 2, memoryGb: 4, durationMinutes: [15, 30, 60] },
      { id: 'boat:small:auto', cpu: 2, memoryGb: 3814 / 1024, durationMinutes: [15, 30, 60] },
    ]);
    expect(items.some(({ id }) => id === 'sail:small:auto' || id === 'boat:micro:auto')).toBe(
      false,
    );
  });

  it('deduplicates identical routes and rejects conflicting published rate or resource offers', () => {
    const offer = { ...catalogOffer('e2b'), byok: { enabled: false } };
    expect(parseCatalog(catalogResponse([offer, offer]), config)).toHaveLength(1);
    expect(() =>
      parseCatalog(catalogResponse([offer, { ...offer, rateMicrosPerSecond: 6 }]), config),
    ).toThrow('conflicting');
    expect(() =>
      parseCatalog(
        {
          ...catalogResponse([offer]),
          offers: [offer, { ...offer, resources: { cpu: 4, memoryMiB: 8192 } }],
        },
        config,
      ),
    ).toThrow('conflicting');
  });
  it.each(managedProviders)(
    'excludes %s routes with a substituted provider or fallback',
    async (provider) => {
      const offer = catalogOffer(provider);
      const valid = routePreview(offer);
      const substituted = provider === 'e2b' ? 'modal' : 'e2b';
      for (const preview of [
        { ...valid, selectedOffer: { ...valid.selectedOffer, provider: substituted } },
        { ...valid, fallbackOffers: [valid.selectedOffer] },
      ]) {
        const fetcher = vi.fn(
          async (url: URL) =>
            new Response(
              JSON.stringify(
                url.pathname.endsWith('/execution-preview') ? preview : catalogResponse([offer]),
              ),
            ),
        );
        vi.stubGlobal('fetch', fetcher);
        expect(await createWickAdapter(config).catalog()).toEqual([]);
        await expect(
          createWickAdapter(config).preview({ ...create, provider, region: 'auto' }),
        ).rejects.toThrow('managed billing route');
        expect(fetcher).toHaveBeenCalledTimes(3);
      }
    },
  );
  it('fails catalog verification explicitly when one provider preview fails', async () => {
    const fetcher = vi.fn(async (url: URL, options?: RequestInit) => {
      if (!url.pathname.endsWith('/execution-preview'))
        return new Response(
          JSON.stringify(catalogResponse(managedProviders.map((p) => catalogOffer(p)))),
        );
      const input = JSON.parse(String(options?.body)).input as CreateEnvironmentInput;
      return input.provider === 'daytona'
        ? new Response('private supplier failure', { status: 503 })
        : new Response(JSON.stringify(routePreview(input)));
    });
    vi.stubGlobal('fetch', fetcher);
    await expect(createWickAdapter(config).catalog()).rejects.toMatchObject({
      name: 'WickApiError',
      statusCode: 503,
      message: 'Wick API rejected the request (HTTP 503)',
    });
    expect(fetcher).toHaveBeenCalledTimes(5);
    expect(fetcher.mock.calls.some(([url]) => url.pathname.endsWith('/environments'))).toBe(false);
  });
  it('rejects more than thirty-two distinct routes before issuing preview requests', async () => {
    const offers = Array.from({ length: 33 }, (_, i) => catalogOffer('e2b', `region-${i}`));
    const fetcher = vi.fn(async () => new Response(JSON.stringify(catalogResponse(offers))));
    vi.stubGlobal('fetch', fetcher);
    await expect(createWickAdapter(config).catalog()).rejects.toThrow('Too many managed routes');
    expect(fetcher).toHaveBeenCalledOnce();
  });
  it('verifies thirty-two distinct routes in bounded batches of four and preserves catalog order', async () => {
    const offers = Array.from({ length: 32 }, (_, i) => catalogOffer('e2b', `region-${i}`));
    const releases: (() => void)[] = [];
    let inFlight = 0,
      maximumInFlight = 0,
      drain = false;
    const fetcher = vi.fn(async (url: URL, options?: RequestInit) => {
      if (!url.pathname.endsWith('/execution-preview'))
        return new Response(JSON.stringify(catalogResponse([offers[0]!, ...offers])));
      inFlight++;
      maximumInFlight = Math.max(maximumInFlight, inFlight);
      if (!drain) await new Promise<void>((resolve) => releases.push(resolve));
      inFlight--;
      const input = JSON.parse(String(options?.body)).input as CreateEnvironmentInput;
      return new Response(JSON.stringify(routePreview(input)));
    });
    vi.stubGlobal('fetch', fetcher);
    const pending = createWickAdapter(config).catalog();
    try {
      for (let batch = 0; batch < 8; batch++) {
        await vi.waitFor(() => expect(releases).toHaveLength(4));
        expect(inFlight).toBe(4);
        expect(fetcher).toHaveBeenCalledTimes(1 + (batch + 1) * 4);
        for (const release of releases.splice(0)) release();
      }
      const items = await pending;
      expect(items.map((item) => item.id)).toEqual(
        offers.map((offer) => `e2b:small:${offer.region}`),
      );
      expect(maximumInFlight).toBe(4);
      expect(fetcher).toHaveBeenCalledTimes(33);
    } finally {
      drain = true;
      for (const release of releases.splice(0)) release();
      await pending.catch(() => undefined);
    }
  });
  it.each(['provider-unknown', 'baseten', 'unknown'])(
    'rejects the unconfigured native provider %s before any call',
    async (provider) => {
      const fetcher = vi.fn();
      vi.stubGlobal('fetch', fetcher);
      const adapter = createWickAdapter(config);
      await expect(adapter.create({ ...create, provider }, 'unsupported-key-123')).rejects.toThrow(
        'customer routes',
      );
      await expect(adapter.preview({ ...create, provider })).rejects.toThrow('customer routes');
      expect(fetcher).not.toHaveBeenCalled();
    },
  );
  it.each(managedProviders)(
    'rejects unsupported %s BYOK before making a request',
    async (provider) => {
      const fetcher = vi.fn();
      vi.stubGlobal('fetch', fetcher);
      await expect(
        createWickAdapter(config).create(
          { ...create, provider, providerKeyId: 'unapproved-target' },
          'stable-key-123',
        ),
      ).rejects.toThrow('BYOK');
      expect(fetcher).not.toHaveBeenCalled();
    },
  );
  it.each(managedProviders)(
    'sends the exact %s route and frozen price through SDK preview and create',
    async (provider) => {
      const input = { ...create, provider };
      const fetcher = vi.fn(
        async (url: URL) =>
          new Response(
            JSON.stringify(
              String(url).endsWith('/execution-preview')
                ? {
                    kind: 'environment',
                    organizationId: config.wickOrganizationId,
                    groupId: config.wickGroupId,
                    eligible: true,
                    selectedOffer: {
                      provider: input.provider,
                      profile: input.profile,
                      region: input.region,
                      billingMode: 'wick_managed',
                      externalCompute: false,
                    },
                    fallbackOffers: [],
                  }
                : { ...mutation, environment: { ...environment, provider } },
            ),
            { status: 202 },
          ),
      );
      vi.stubGlobal('fetch', fetcher);
      const adapter = createWickAdapter(config);
      await adapter.preview(input);
      expect((await adapter.create(input, 'frozen-key-123')).environment.provider).toBe(provider);
      expect(fetcher.mock.calls).toHaveLength(3);
      for (const call of fetcher.mock.calls) {
        const options = (call as unknown as [URL, RequestInit])[1];
        const body = JSON.parse(String(options.body));
        expect(body.kind === 'environment' ? body.input : body).toEqual(input);
      }
      const { maximumPriceMicrosPerSecond: _rate, ...unpriced } = input;
      await expect(adapter.create(unpriced, 'unpriced-key-123')).rejects.toThrow('frozen maximum');
      expect(fetcher.mock.calls).toHaveLength(3);
    },
  );
  it('replays the same key without generating a replacement and preserves upstream replay flag', async () => {
    const fetcher = vi.fn(
      async () => new Response(JSON.stringify({ ...mutation, replayed: true }), { status: 202 }),
    );
    vi.stubGlobal('fetch', fetcher);
    const adapter = createWickAdapter(config);
    const one = await adapter.create(create, 'stable-key-123');
    const two = await adapter.create(create, 'stable-key-123');
    expect(two.environment.expiresAt).toBe(one.environment.expiresAt);
    expect(two.raw).toMatchObject({ replayed: true });
    expect(
      fetcher.mock.calls.every(
        (call) =>
          new Headers((call as unknown as [URL, RequestInit])[1].headers).get('Idempotency-Key') ===
          'stable-key-123',
      ),
    ).toBe(true);
  });
  it.each([400, 401, 403, 409, 422, 429, 500, 503])(
    'classifies HTTP %i without fake success or error-body leakage',
    async (status) => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => new Response('secret credential error detail', { status })),
      );
      const error = await createWickAdapter(config)
        .create(create, 'stable-key-123')
        .then(
          () => {
            throw new Error('Expected Wick failure');
          },
          (error) => error as WickApiError,
        );
      expect(error).toBeInstanceOf(WickApiError);
      expect(error.admissionRejected).toBe([400, 422].includes(status));
      expect(error.message).not.toContain('secret');
    },
  );
  it('keeps network uncertainty distinct from confirmed admission rejection', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('Service key must not leak');
      }),
    );
    const error = await createWickAdapter(config)
      .create(create, 'stable-key-123')
      .then(
        () => {
          throw new Error('Expected Wick failure');
        },
        (error) => error as WickApiError,
      );
    expect(error.admissionRejected).toBe(false);
    expect(error.message).toContain('reconciliation');
    expect(error.message).not.toContain('Service key');
  });
  it('rejects observations and termination receipts for a different environment', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify(environment), { status: 200 })),
    );
    await expect(createWickAdapter(config).get('different-environment')).rejects.toThrow('scope');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify(mutation), { status: 202 })),
    );
    await expect(createWickAdapter(config).terminate('different-environment')).rejects.toThrow(
      'does not match',
    );
  });
  it('rejects redirected service-key requests and oversized responses without exposing upstream detail', async () => {
    const fetcher = vi.fn(
      async () =>
        new Response('do not follow', {
          status: 302,
          headers: { Location: 'https://attacker.invalid/' },
        }),
    );
    vi.stubGlobal('fetch', fetcher);
    await expect(createWickAdapter(config).catalog()).rejects.toThrow('reconciliation');
    expect(fetcher).toHaveBeenCalledOnce();
    expect((fetcher.mock.calls[0] as unknown as [URL, RequestInit])[1].redirect).toBe('error');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('x'.repeat(1024 * 1024 + 1))),
    );
    await expect(createWickAdapter(config).catalog()).rejects.toThrow('reconciliation');
  });
  it('cancels an oversized declared body before reading or retaining upstream data', async () => {
    const cancel = vi.fn();
    const pull = vi.fn();
    const body = new ReadableStream<Uint8Array>({ cancel, pull }, { highWaterMark: 0 });
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () => new Response(body, { headers: { 'content-length': String(1024 * 1024 + 1) } }),
      ),
    );
    await expect(createWickAdapter(config).catalog()).rejects.toThrow('reconciliation');
    expect(cancel).toHaveBeenCalledOnce();
    expect(pull).not.toHaveBeenCalled();
  });
  it('rejects credential-bearing API bases and wrong organization/group before issuing calls', async () => {
    const fetcher = vi.fn();
    vi.stubGlobal('fetch', fetcher);
    expect(() =>
      createWickAdapter({ ...config, wickApiBase: 'https://secret@wick.example/api' }),
    ).toThrow('credential-free');
    await expect(
      createWickAdapter(config).create(
        { ...create, organizationId: 'different-org' },
        'scope-key-123',
      ),
    ).rejects.toThrow('scope');
    await expect(
      createWickAdapter(config).create({ ...create, groupId: 'different-group' }, 'scope-key-123'),
    ).rejects.toThrow('scope');
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('requires an explicit adapter mode and never replaces real errors with fixtures', async () => {
    expect(() => createWickAdapter({ ...config, wickMode: 'fixture' })).toThrow('PostgreSQL');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ unexpected: 'shape' }), { status: 202 })),
    );
    await expect(createWickAdapter(config).create(create, 'stable-key-123')).rejects.toThrow();
  });
  it('rejects unsupported rental durations before making an API call', async () => {
    const fetcher = vi.fn();
    vi.stubGlobal('fetch', fetcher);
    await expect(
      createWickAdapter(config).create({ ...create, ttlSeconds: 7200 }, 'stable-key-123'),
    ).rejects.toThrow('15, 30, or 60');
    expect(fetcher).not.toHaveBeenCalled();
  });
});
