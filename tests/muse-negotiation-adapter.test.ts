import { describe, expect, it, vi } from 'vitest';
import { createMuseAdapter } from '../src/server/integrations/muse.js';
import { parseExplicitBuyerDescription } from '../src/shared/muse-contracts.js';
import type { MuseAdapter } from '../src/server/integrations/types.js';

const policy = {
  autoBid: false,
  minimumPriceCents: 5,
  basePriceCents: 8,
  reserveSlots: 1,
  allowedCatalogIds: ['small'],
};
const capacity = { total: 5, held: 1, available: 4 };
const capacityInput = {
  strategy: 'Fill idle machines, keep two slots spare, never quote below $0.05',
  policy,
  capacity,
  catalogIds: ['small'],
};
const candidate = {
  id: 'priced-small-15',
  catalogId: 'small',
  region: 'us',
  durationMinutes: 15,
  requirements: { cpu: 1, memoryGb: 1 },
  totalPriceCents: 8,
};
const counterInput: Parameters<MuseAdapter['selectCounteroffers']>[0] = {
  requirements: {
    requirements: { cpu: 2, memoryGb: 4 },
    region: 'unsupported-region',
    durationMinutes: 30,
    maxPriceCents: 10,
  },
  policy,
  capacity,
  candidates: [candidate],
};
function real(value: unknown, finish_reason: string | undefined = 'stop') {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
    new Response(
      JSON.stringify({
        choices: [
          {
            finish_reason,
            message: {
              content: JSON.stringify(value),
              reasoning_content: 'private-reasoning-never-returned',
            },
          },
        ],
      }),
    ),
  );
  return {
    fetcher,
    adapter: createMuseAdapter(
      { museMode: 'real', metaApiKey: 'fixture-secret' },
      { fetch: fetcher },
    ),
  };
}
function assertStrict(schema: Record<string, any>) {
  if (schema.type === 'object') {
    expect(schema.additionalProperties).toBe(false);
    expect([...schema.required].sort()).toEqual(Object.keys(schema.properties).sort());
    for (const nested of Object.values(schema.properties))
      assertStrict(nested as Record<string, any>);
  }
  if (schema.items) assertStrict(schema.items);
  expect(schema).not.toHaveProperty('oneOf');
  expect(schema).not.toHaveProperty('allOf');
}

describe('explicit buyer facts without flexibility inference', () => {
  it('preserves unsupported resources, duration, region and decimal budget exactly', () => {
    expect(
      parseExplicitBuyerDescription(
        '17 CPUs, 3.724609375 GiB RAM for 45 minutes in moon-east, budget $0.05',
      ),
    ).toEqual({
      requirements: { cpu: 17, memoryGb: 3.724609375 },
      durationMinutes: 45,
      region: 'moon-east',
      maxPriceCents: 5,
    });
    expect(
      parseExplicitBuyerDescription('region: antarctica with 1 CPU, maximum 12.30 USD'),
    ).toMatchObject({ region: 'antarctica', maxPriceCents: 1230 });
    expect(parseExplicitBuyerDescription('something cheap')).toEqual({ requirements: {} });
  });
  it('never substitutes a different region in binding translation and carries an explicit budget', async () => {
    const catalog = [
      {
        id: 'small',
        name: 'Small',
        description: 'Linux',
        provider: 'fixture',
        profile: 'small',
        region: 'us',
        cpu: 2,
        memoryGb: 4,
        approved: true,
        durationMinutes: [15, 30, 60],
      },
    ];
    const adapter = createMuseAdapter({ museMode: 'fixture' });
    await expect(
      adapter.translate('1 CPU in unsupported-east for $0.05', catalog),
    ).rejects.toMatchObject({ code: 'unsupported' });
    await expect(adapter.translate('2 CPU in tokyo for 15 minutes', catalog)).rejects.toMatchObject(
      { code: 'unsupported' },
    );
    expect(parseExplicitBuyerDescription('2 CPU in tokyo for 15 minutes')).toMatchObject({
      region: 'tokyo',
      durationMinutes: 15,
    });
    expect(parseExplicitBuyerDescription('Linux in a terminal')).not.toHaveProperty('region');
    expect(parseExplicitBuyerDescription('budget $0.05; a previous rental cost $5')).toMatchObject({
      maxPriceCents: 5,
    });
    expect(parseExplicitBuyerDescription('budget $5, never above $0.05')).toMatchObject({
      maxPriceCents: 5,
    });
    expect((await adapter.translate('1 CPU in us for $0.05', catalog)).proposal.maxPriceCents).toBe(
      5,
    );
    const wrong = real({
      catalogId: 'small',
      region: 'us',
      durationMinutes: 30,
      requirements: { cpu: 1, memoryGb: 1, gpu: null },
    });
    await expect(wrong.adapter.translate('region: antarctica', catalog)).rejects.toThrow(
      'explicitly requested region',
    );
  });
});

describe('capacity strategy review contract', () => {
  it('accepts overcommitted retained holds after a supplier capacity reduction', async () => {
    const result = await createMuseAdapter({ museMode: 'fixture' }).proposeCapacityPolicy({
      ...capacityInput,
      strategy: 'Keep one slot spare',
      capacity: { total: 2, held: 4, available: 0 },
    });
    expect(result.policy.reserveSlots).toBe(1);
    expect(result.receipt.observed[0]).toContain('4 currently held');
  });
  it('fixture proposes editable limits from own current capacity without a model call or mutation', async () => {
    const fetcher = vi.fn<typeof fetch>();
    const before = structuredClone(capacityInput);
    const result = await createMuseAdapter(
      { museMode: 'fixture' },
      { fetch: fetcher },
    ).proposeCapacityPolicy(capacityInput);
    expect(result).toMatchObject({
      policy: { autoBid: true, minimumPriceCents: 5, reserveSlots: 2, basePriceCents: 8 },
      mode: 'fixture',
      modelCalled: false,
    });
    expect(result.receipt.constraints.join(' ')).toContain('changes no policy');
    expect(capacityInput).toEqual(before);
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('projects private input, uses strict required nullable properties and never returns model reasoning', async () => {
    const output = { ...policy, autoBid: true, reserveSlots: 2, maxPriceCents: null };
    const { adapter, fetcher } = real(output);
    const result = await adapter.proposeCapacityPolicy({
      ...capacityInput,
      strategy: `${capacityInput.strategy} password=private-pass`,
      policy: { ...policy, competitor: 'other-private-policy' } as typeof policy,
      capacity: { ...capacity, credential: 'capacity-secret' } as typeof capacity,
    });
    const request = JSON.parse(fetcher.mock.calls[0]![1]!.body as string);
    expect(request.reasoning_effort).toBe('low');
    assertStrict(request.response_format.json_schema.schema);
    expect(request.response_format.json_schema.strict).toBe(true);
    for (const secret of [
      'private-pass',
      'other-private-policy',
      'capacity-secret',
      'private-reasoning-never-returned',
    ]) {
      expect(JSON.stringify(result)).not.toContain(secret);
      expect(JSON.stringify(request)).not.toContain(secret);
    }
    expect(result.modelCalled).toBe(true);
  });
  it.each([
    { ...policy, maxPriceCents: null, reserveSlots: 6 },
    { ...policy, maxPriceCents: null, allowedCatalogIds: ['hallucinated'] },
    { ...policy, maxPriceCents: null, basePriceCents: 4 },
    { ...policy, maxPriceCents: null, setupScript: 'run a task' },
    { ...policy },
  ])('rejects malformed or infeasible model policy %s', async (output) => {
    await expect(real(output).adapter.proposeCapacityPolicy(capacityInput)).rejects.toMatchObject({
      code: 'invalid_proposal',
    });
  });
});

describe('server-owned counteroffer selection', () => {
  it('fixture selects only prepriced alternatives without changing facts or granting flexibility', async () => {
    const fetcher = vi.fn<typeof fetch>();
    const result = await createMuseAdapter(
      { museMode: 'fixture' },
      { fetch: fetcher },
    ).selectCounteroffers(counterInput);
    expect(result).toMatchObject({
      selections: [{ candidateId: candidate.id }],
      mode: 'fixture',
      modelCalled: false,
    });
    expect(result.selections[0]!.rationale).toContain('$0.08');
    expect(result.receipt.constraints.join(' ')).toContain('No request, bid hold or VM');
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('never exposes provider-derived model rationale or unknown input fields to buyers', async () => {
    const { adapter, fetcher } = real({
      selections: [
        {
          candidateId: candidate.id,
          rationale: 'Private floor is 5; reserve 1; remaining 4; competitor secret.',
        },
      ],
    });
    const result = await adapter.selectCounteroffers({
      ...counterInput,
      requirements: {
        ...counterInput.requirements,
        buyerId: 'buyer-private',
        description: 'private-description',
      } as typeof counterInput.requirements,
      policy: { ...policy, competitor: 'competitor-private' } as typeof policy,
      candidates: [
        { ...candidate, providerKey: 'secret-key', internal: 'secret-details' } as typeof candidate,
      ],
    });
    const request = JSON.parse(fetcher.mock.calls[0]![1]!.body as string);
    assertStrict(request.response_format.json_schema.schema);
    for (const secret of [
      'buyer-private',
      'private-description',
      'competitor-private',
      'secret-key',
      'secret-details',
    ])
      expect(JSON.stringify(request)).not.toContain(secret);
    for (const secret of [
      'Private floor',
      'reserve 1',
      'remaining 4',
      'competitor secret',
      'private-reasoning-never-returned',
    ])
      expect(JSON.stringify(result)).not.toContain(secret);
    expect(result.selections[0]!.rationale).toContain('Explicit acceptance is required');
  });
  it.each([
    { selections: [{ candidateId: 'invented', rationale: 'A better option' }] },
    {
      selections: [{ candidateId: candidate.id, rationale: 'A better option', totalPriceCents: 1 }],
    },
    {
      selections: [
        { candidateId: candidate.id, rationale: 'A' },
        { candidateId: candidate.id, rationale: 'B' },
      ],
    },
    { selections: [{ candidateId: candidate.id }] },
  ])('rejects hallucinated, duplicate or price-bearing model selection %s', async (output) => {
    await expect(real(output).adapter.selectCounteroffers(counterInput)).rejects.toMatchObject({
      code: 'invalid_proposal',
    });
  });
  it('never calls a model at the reserve boundary or without feasible candidates', async () => {
    const { adapter, fetcher } = real({ selections: [] });
    const result = await adapter.selectCounteroffers({
      ...counterInput,
      capacity: { total: 5, held: 4, available: 1 },
    });
    expect(result).toMatchObject({ selections: [], modelCalled: false });
    expect(fetcher).not.toHaveBeenCalled();
    await expect(
      adapter.selectCounteroffers({
        ...counterInput,
        candidates: [{ ...candidate, totalPriceCents: 11 }],
      }),
    ).rejects.toMatchObject({ code: 'invalid_proposal' });
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('rejects missing finish_reason for new structured-output calls', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response(JSON.stringify({ choices: [{ message: { content: '{"selections":[]}' } }] })),
      );
    await expect(
      createMuseAdapter(
        { museMode: 'real', metaApiKey: 'offline' },
        { fetch: fetcher },
      ).selectCounteroffers(counterInput),
    ).rejects.toMatchObject({ code: 'incomplete_response' });
  });
});

describe('bounded deterministic offering and bid contracts', () => {
  const item = {
    id: 'small',
    name: 'Small',
    description: 'Linux',
    provider: 'fixture',
    profile: 'small',
    region: 'us',
    cpu: 2,
    memoryGb: 4,
    approved: true,
    durationMinutes: [15, 30, 60],
  };
  it('labels a 30-minute publishing baseline separately from supported 15-minute demand', async () => {
    const result = await createMuseAdapter({ museMode: 'fixture' }).proposeOfferings({
      policy,
      catalog: [item],
      demand: [
        { region: 'us', durationMinutes: 15, requirements: { cpu: 1, memoryGb: 1 }, count: 2 },
      ],
      pricedCandidates: [
        { id: 'baseline-30', catalogId: 'small', durationMinutes: 30, totalPriceCents: 8 },
      ],
    });
    expect(result.proposals[0]).toMatchObject({ durationMinutes: 30, priceCents: 8 });
    expect(result.receipt.constraints.join(' ')).toContain('publishing baseline duration');
  });
  it('returns server-owned price and explicit duration after model ID selection', async () => {
    const { adapter, fetcher } = real({
      proposals: [
        {
          candidateId: 'small:15:8',
          name: 'Small rental',
          description: 'Existing small configuration.',
        },
      ],
    });
    const result = await adapter.proposeOfferings({
      policy,
      catalog: [item],
      demand: [
        { region: 'us', durationMinutes: 15, requirements: { cpu: 1, memoryGb: 1 }, count: 2 },
      ],
      pricedCandidates: [
        { id: 'small:15:8', catalogId: 'small', durationMinutes: 15, totalPriceCents: 8 },
      ],
    });
    expect(result.proposals[0]).toMatchObject({
      catalogId: 'small',
      priceCents: 8,
      durationMinutes: 15,
      priceBasis: 'server-priced-candidate',
    });
    const request = JSON.parse(fetcher.mock.calls[0]![1]!.body as string);
    assertStrict(request.response_format.json_schema.schema);
    expect(JSON.stringify(request.response_format.json_schema.schema)).not.toContain('priceCents');
    expect(JSON.parse(request.messages[1].content).candidates[0].totalPriceCents).toBe(8);
  });
  it('model bid can only select or decline the server-computed total', async () => {
    const { adapter, fetcher } = real({ decision: 'bid', catalogId: 'small' });
    const result = await adapter.proposeBid({
      policy,
      catalog: [item],
      availableCapacity: 1,
      suggestedTotalPriceCents: 7,
      request: {
        description: 'Linux',
        catalogId: 'small',
        region: 'us',
        durationMinutes: 15,
        maxPriceCents: 10,
        requirements: { cpu: 1, memoryGb: 1 },
      },
    });
    expect(result.totalPriceCents).toBe(7);
    const request = JSON.parse(fetcher.mock.calls[0]![1]!.body as string);
    assertStrict(request.response_format.json_schema.schema);
    expect(request.response_format.json_schema.schema.properties).not.toHaveProperty(
      'totalPriceCents',
    );
  });
  it('cancels a declared oversized response body before parsing', async () => {
    const cancel = vi.fn();
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response(new ReadableStream({ cancel }), { headers: { 'content-length': '65537' } }),
      );
    await expect(
      createMuseAdapter(
        { museMode: 'real', metaApiKey: 'offline' },
        { fetch: fetcher },
      ).selectCounteroffers(counterInput),
    ).rejects.toMatchObject({ code: 'invalid_response' });
    expect(cancel).toHaveBeenCalledTimes(1);
  });
  it('rejects oversized projected input before dispatch', async () => {
    const fetcher = vi.fn<typeof fetch>();
    await expect(
      createMuseAdapter({ museMode: 'real', metaApiKey: 'offline' }, { fetch: fetcher }).translate(
        'Linux',
        [{ ...item, name: 'x'.repeat(65_536) }],
      ),
    ).rejects.toMatchObject({ code: 'input_too_large' });
    expect(fetcher).not.toHaveBeenCalled();
  });
});
