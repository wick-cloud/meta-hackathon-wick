import { afterEach, describe, it, expect, vi } from 'vitest';
import { BrokerClient, BrokerError } from '../packages/sdk/src/index.js';
import type { CreateOrderInput } from '../packages/sdk/src/index.js';

const key = 'wbk_sdk_fixture.nonproduction_secret';
const input: CreateOrderInput = {
  description: 'A development environment',
  catalogId: 'small',
  region: 'us',
  durationMinutes: 30,
  maxPriceCents: 100,
  requirements: { cpu: 2, memoryGb: 4 },
};
const ok = (value: unknown) =>
  new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
const create = (fetcher: ReturnType<typeof vi.fn>, requestTimeoutMs?: number) =>
  new BrokerClient({
    baseUrl: 'https://broker.example',
    apiKey: key,
    fetch: fetcher as typeof fetch,
    requestTimeoutMs,
  });
afterEach(() => vi.useRealTimers());

describe('Broker TypeScript client request and recovery contract', () => {
  it('accepts only Broker credentials and credential-free HTTPS or loopback origins', () => {
    for (const apiKey of ['wick_live_credential', 'sk-native-key', '', `Bearer ${key}`])
      expect(() => new BrokerClient({ baseUrl: 'https://broker.example', apiKey })).toThrow(
        'Broker API key',
      );
    for (const baseUrl of [
      'http://external.example',
      'https://user:pass@broker.example',
      'https://broker.example/api',
      'https://broker.example/?token=x',
    ])
      expect(() => new BrokerClient({ baseUrl, apiKey: key })).toThrow();
    expect(() => new BrokerClient({ baseUrl: 'http://127.0.0.1:3000', apiKey: key })).not.toThrow();
    expect(
      JSON.stringify(new BrokerClient({ baseUrl: 'https://broker.example', apiKey: key })),
    ).not.toContain(key);
  });
  it('uses Bearer headers only on the configured origin and rejects redirects', async () => {
    const fetcher = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
        ok({ items: [] }),
      ),
      client = create(fetcher);
    await client.catalog.list();
    const [url, request] = fetcher.mock.calls[0] as unknown as [URL, RequestInit];
    expect(String(url)).toBe('https://broker.example/api/catalog');
    expect(request.headers).toMatchObject({
      Authorization: `Bearer ${key}`,
      Accept: 'application/json',
    });
    expect(request.redirect).toBe('error');
    expect(request).not.toHaveProperty('credentials');
    await expect(client.request('GET', 'https://evil.example/api/catalog')).rejects.toMatchObject({
      code: 'invalid_input',
    });
    await expect(client.request('GET', '/api/../../auth')).rejects.toMatchObject({
      code: 'invalid_input',
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('keeps operation keys stable in mutation headers and JSON, without automatic retries', async () => {
    const fetcher = vi.fn(
        async (_input: RequestInfo | URL, _init?: RequestInit) =>
          new Response(
            JSON.stringify({ error: 'Busy', code: 'unavailable', requestId: 'request-1' }),
            { status: 503 },
          ),
      ),
      client = create(fetcher);
    await expect(
      client.orders.create(input, { operationKey: 'stable-order-1' }),
    ).rejects.toMatchObject({
      status: 503,
      code: 'unavailable',
      requestId: 'request-1',
      operationKey: 'stable-order-1',
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const request = fetcher.mock.calls[0][1] as unknown as RequestInit;
    expect(request.headers).toMatchObject({ 'Idempotency-Key': 'stable-order-1' });
    expect(JSON.parse(String(request.body))).toEqual({ ...input, operationKey: 'stable-order-1' });
    await expect(client.orders.create(input, {} as never)).rejects.toMatchObject({
      code: 'operation_key_required',
    });
    await expect(
      client.request('POST', '/api/requests', {
        body: { ...input, operationKey: 'other-operation' },
        operationKey: 'stable-order-1',
      }),
    ).rejects.toMatchObject({ code: 'invalid_input' });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('retries transient reads at most three total attempts and observes Retry-After', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('{}', { status: 429, headers: { 'Retry-After': '0' } }))
      .mockResolvedValueOnce(new Response('{}', { status: 503, headers: { 'Retry-After': '0' } }))
      .mockResolvedValueOnce(ok({ items: [] }));
    await expect(create(fetcher).catalog.list()).resolves.toEqual({ items: [] });
    expect(fetcher).toHaveBeenCalledTimes(3);
    const slow = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Response(JSON.stringify({ error: 'Rate limited', code: 'rate_limited' }), {
          status: 429,
          headers: { 'Retry-After': '60' },
        }),
    );
    await expect(create(slow).catalog.list()).rejects.toMatchObject({
      status: 429,
      retryAfterMs: 60000,
    });
    expect(slow).toHaveBeenCalledTimes(1);
  });
  it('does not retry proposal POSTs or leak transport error details and credentials', async () => {
    const fetcher = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => {
      throw new Error('Private transport detail ' + key);
    });
    let failure: unknown;
    try {
      await create(fetcher).muse.translate('2 CPU, 4 GiB');
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(BrokerError);
    expect(JSON.stringify(failure)).not.toContain(key);
    expect(JSON.stringify(failure)).not.toContain('Private transport');
    expect(fetcher).toHaveBeenCalledTimes(1);
    const reflected = create(
      vi.fn(
        async (_input: RequestInfo | URL, _init?: RequestInit) =>
          new Response(JSON.stringify({ error: `Invalid token ${key}` }), { status: 401 }),
      ),
    );
    await expect(reflected.me()).rejects.toMatchObject({ message: 'Invalid token [redacted]' });
  });
  it('rejects oversized or invalid JSON without returning arbitrary response text', async () => {
    for (const response of [
      new Response('<html>secret upstream page</html>'),
      new Response(JSON.stringify({ large: 'x'.repeat(2 * 1024 * 1024) })),
    ]) {
      await expect(
        create(vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => response)).me(),
      ).rejects.toMatchObject({
        code: 'invalid_response',
      });
    }
  });
  it('cancels a declared oversized response without starting to read its body', async () => {
    const cancel = vi.fn(),
      pull = vi.fn();
    const response = new Response(
      new ReadableStream<Uint8Array>({ cancel, pull }, { highWaterMark: 0 }),
      { headers: { 'Content-Length': String(2 * 1024 * 1024 + 1) } },
    );
    const fetcher = vi.fn(async () => response);
    await expect(create(fetcher).me()).rejects.toMatchObject({ code: 'invalid_response' });
    expect(cancel).toHaveBeenCalledOnce();
    expect(pull).not.toHaveBeenCalled();
    expect(fetcher).toHaveBeenCalledOnce();
  });
  it.each(['cancelled', 'timeout'] as const)(
    'preserves %s and the operation key when a mutation body stalls after headers',
    async (code) => {
      const controller = new AbortController();
      let bodyStarted!: () => void;
      const started = new Promise<void>((resolve) => {
        bodyStarted = resolve;
      });
      const fetcher = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        const signal = init!.signal!;
        return new Response(
          new ReadableStream<Uint8Array>({
            start(stream) {
              stream.enqueue(Buffer.from('{"id":'));
              signal.addEventListener('abort', () => stream.error(signal.reason), { once: true });
              bodyStarted();
            },
          }),
        );
      });
      const request = create(fetcher, code === 'timeout' ? 20 : 1000).orders.create(input, {
        operationKey: 'stable-streamed-order',
        signal: controller.signal,
      });
      const rejected = expect(request).rejects.toMatchObject({
        code,
        operationKey: 'stable-streamed-order',
      });
      await started;
      if (code === 'cancelled') controller.abort();
      await rejected;
      expect(fetcher).toHaveBeenCalledOnce();
    },
  );
  it('times out waits with a saved resource reference and never cancels or resubmits', async () => {
    const fetcher = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
        ok({ request: { id: 'auction-1', status: 'open' }, bids: [], vm: null }),
      ),
      client = create(fetcher);
    const result = await client.orders.wait('auction-1', { timeoutMs: 20, pollIntervalMs: 100 });
    expect(result).toMatchObject({
      state: 'pending',
      id: 'auction-1',
      resource: { request: { status: 'open' } },
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(
      fetcher.mock.calls.every((call) => (call[1] as unknown as RequestInit).method === 'GET'),
    ).toBe(true);
  });
  it('returns final auction and VM outcomes and respects caller cancellation', async () => {
    const fetcher = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      ok({ request: { id: 'auction-1', status: 'no_offers' }, bids: [], vm: null }),
    );
    await expect(create(fetcher).orders.wait('auction-1')).resolves.toMatchObject({
      state: 'complete',
      id: 'auction-1',
    });
    await expect(
      create(
        vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
          ok({ id: 'vm-1', status: 'running' }),
        ),
      ).vms.wait('vm-1'),
    ).resolves.toMatchObject({ state: 'complete', resource: { status: 'running' } });
    const controller = new AbortController();
    controller.abort();
    await expect(
      create(fetcher).orders.wait('auction-1', { signal: controller.signal }),
    ).rejects.toMatchObject({ code: 'cancelled' });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('preserves pagination cursors and sends proposal inputs without committing them', async () => {
    const fetcher = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
        ok({ items: [] }),
      ),
      client = create(fetcher);
    await client.orders.list({ limit: 25, cursor: 'opaque+/cursor', status: 'history' });
    expect((fetcher.mock.calls[0][0] as unknown as URL).searchParams.get('cursor')).toBe(
      'opaque+/cursor',
    );
    await client.provider.policy.propose('Keep two slots spare');
    expect(String(fetcher.mock.calls[1][0])).toBe(
      'https://broker.example/api/provider/policy/propose',
    );
    expect(JSON.parse(String((fetcher.mock.calls[1][1] as unknown as RequestInit).body))).toEqual({
      strategy: 'Keep two slots spare',
    });
  });
});
