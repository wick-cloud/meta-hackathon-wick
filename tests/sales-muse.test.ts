import { describe, expect, it, vi } from 'vitest';
import { createMuseAdapter } from '../src/server/integrations/muse.js';
import type { SalesAdviceInput } from '../src/shared/sales.js';

function salesInput(): SalesAdviceInput {
  const policy = {
    autoBid: false,
    minimumPriceCents: 10,
    basePriceCents: 30,
    maxPriceCents: 60,
    reserveSlots: 1,
    allowedCatalogIds: ['approved-small'],
  };
  return {
    goal: 'Find more matching requests while keeping my spare slot.',
    currentPolicy: policy,
    capacity: { total: 4, held: 1, available: 2 },
    evidence: [
      { id: 'policy', label: 'Saved limits', detail: 'One slot is reserved.' },
      { id: 'demand', label: 'Sampled demand', detail: 'Ten recent requests were sampled.' },
      { id: 'capacity', label: 'Current capacity', detail: 'Two slots are currently available.' },
    ],
    candidates: [
      {
        id: 'enable-auto',
        title: 'Enable automatic bids',
        description: 'Keep the saved pricing and spare slots.',
        policy: { ...policy, autoBid: true },
        comparison: { sampledRequests: 10, currentMatches: 3, proposedMatches: 3 },
        evidenceIds: ['policy', 'capacity'],
      },
      {
        id: 'lower-base',
        title: 'Review a lower base',
        description: 'Keep the saved floor and spare slots.',
        policy: { ...policy, basePriceCents: 20 },
        comparison: { sampledRequests: 10, currentMatches: 3, proposedMatches: 7 },
        evidenceIds: ['policy', 'demand'],
      },
    ],
  };
}

const selection = () => ({
  summary: 'The lower base matches more sampled requests; this does not forecast auction wins.',
  recommendations: [
    {
      candidateId: 'lower-base',
      explanation: 'Review the supplied lower base while preserving your floor and spare slot.',
      evidenceIds: ['policy', 'demand'],
    },
  ],
});
const response = (value: unknown) =>
  new Response(
    JSON.stringify({
      choices: [
        {
          finish_reason: 'stop',
          message: { content: JSON.stringify(value), reasoning: 'private upstream reasoning' },
        },
      ],
      private_upstream_metadata: 'never forward',
    }),
  );
const realAdapter = (fetcher: typeof fetch) =>
  createMuseAdapter({ museMode: 'real', metaApiKey: 'test-only-server-key' }, { fetch: fetcher });

describe('Muse seller sales advice', () => {
  it('ranks fixture scenarios by matching improvement then enabling automation without a call', async () => {
    const fetcher = vi.fn();
    const input = salesInput();
    input.candidates.push({
      ...input.candidates[1]!,
      id: 'unchanged',
      comparison: { sampledRequests: 10, currentMatches: 3, proposedMatches: 3 },
    });
    const result = await createMuseAdapter({ museMode: 'fixture' }, { fetch: fetcher })
      .recommendSales!(input);
    expect(result.recommendations.map((item) => item.candidateId)).toEqual([
      'lower-base',
      'enable-auto',
    ]);
    expect(result).toMatchObject({ mode: 'fixture', modelCalled: false });
    expect(result.summary).toContain('not a full replay');
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each(['fixture', 'real'] as const)(
    'returns no candidates without calling the model in %s mode',
    async (mode) => {
      const fetcher = vi.fn();
      const adapter = createMuseAdapter(
        { museMode: mode, metaApiKey: 'test-only-server-key' },
        { fetch: fetcher },
      );
      const result = await adapter.recommendSales!({ ...salesInput(), candidates: [] });
      expect(result).toMatchObject({ recommendations: [], modelCalled: false, mode });
      expect(fetcher).not.toHaveBeenCalled();
    },
  );

  it('sends the exact model and strict schema, projects only allowed fields, and returns final content only', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => response(selection()));
    const input = salesInput();
    const contaminated = {
      ...input,
      goal: 'More sales. password=goal-secret and Bearer pasted-auth-token',
      privateRivalPolicy: 'forbidden-top-level',
      currentPolicy: { ...input.currentPolicy, privateKey: 'forbidden-current-policy' },
      capacity: { ...input.capacity, credentials: 'forbidden-capacity' },
      evidence: input.evidence.map((item) => ({ ...item, rawRequest: 'forbidden-evidence' })),
      candidates: input.candidates.map((item) => ({
        ...item,
        privateBuyerEmail: 'forbidden-candidate',
        policy: { ...item.policy, password: 'forbidden-proposed-policy' },
        comparison: { ...item.comparison, rivalBids: 'forbidden-comparison' },
      })),
    };
    const result = await realAdapter(fetcher).recommendSales!(contaminated);
    expect(result).toEqual({ ...selection(), mode: 'real', modelCalled: true });
    const [url, options] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe('https://inference.baseten.co/v1/chat/completions');
    const request = JSON.parse(String(options!.body));
    expect(request.model).toBe('meta-models/muse-spark-open-1026');
    expect(request.response_format).toMatchObject({
      type: 'json_schema',
      json_schema: { name: 'wick_sales_advice', strict: true },
    });
    const sentInput = JSON.parse(request.messages[1].content);
    expect(sentInput.currentPolicy).toEqual(input.currentPolicy);
    expect(sentInput.capacity).toEqual(input.capacity);
    expect(sentInput.candidates).toEqual(input.candidates);
    expect(sentInput.evidence).toEqual(input.evidence);
    expect(sentInput.goal).toContain('[redacted]');
    expect(request.messages[1].content).not.toMatch(/forbidden-|goal-secret|pasted-auth-token/);
    expect(request.messages[0].content).toContain('not a full replay');
    expect(JSON.stringify(result)).not.toMatch(/reasoning|private_upstream|never forward/);
  });

  it('accepts an empty model selection when the goal cannot be met', async () => {
    const result = await realAdapter(async () =>
      response({
        summary: 'None of the supplied scenarios can address this goal.',
        recommendations: [],
      }),
    ).recommendSales!(salesInput());
    expect(result).toMatchObject({ recommendations: [], mode: 'real', modelCalled: true });
  });

  it('keeps redacted input and final text within their size contracts', async () => {
    const value = selection();
    value.summary = `${'x'.repeat(691)} token=z`;
    value.recommendations[0]!.explanation = `${'x'.repeat(491)} token=z`;
    const fetcher = vi.fn<typeof fetch>(async () => response(value));
    const input = salesInput();
    input.goal = `${'x'.repeat(992)} token=z`;
    const result = await realAdapter(fetcher).recommendSales!(input);
    expect(result.summary.length).toBeLessThanOrEqual(700);
    expect(result.recommendations[0]!.explanation.length).toBeLessThanOrEqual(500);
    expect(JSON.stringify(result)).not.toContain('token=z');
    const request = JSON.parse(String(fetcher.mock.calls[0]![1]!.body));
    expect(JSON.parse(request.messages[1].content).goal.length).toBeLessThanOrEqual(1000);
    expect(request.messages[1].content).not.toContain('token=z');
  });

  it.each([
    [
      'unknown candidate',
      {
        ...selection(),
        recommendations: [{ ...selection().recommendations[0], candidateId: 'foreign' }],
      },
    ],
    [
      'duplicate candidate',
      {
        ...selection(),
        recommendations: [selection().recommendations[0], selection().recommendations[0]],
      },
    ],
    [
      'unknown evidence',
      {
        ...selection(),
        recommendations: [{ ...selection().recommendations[0], evidenceIds: ['foreign'] }],
      },
    ],
    [
      'another candidate evidence',
      {
        ...selection(),
        recommendations: [{ ...selection().recommendations[0], evidenceIds: ['capacity'] }],
      },
    ],
    [
      'duplicate evidence',
      {
        ...selection(),
        recommendations: [{ ...selection().recommendations[0], evidenceIds: ['policy', 'policy'] }],
      },
    ],
    [
      'missing evidence',
      { ...selection(), recommendations: [{ ...selection().recommendations[0], evidenceIds: [] }] },
    ],
    [
      'too many evidence references',
      {
        ...selection(),
        recommendations: [
          { ...selection().recommendations[0], evidenceIds: ['policy', 'demand', 'a', 'b', 'c'] },
        ],
      },
    ],
    [
      'too many recommendations',
      { ...selection(), recommendations: Array(4).fill(selection().recommendations[0]) },
    ],
    [
      'invented price',
      { ...selection(), recommendations: [{ ...selection().recommendations[0], priceCents: 0 }] },
    ],
    ['raw reasoning field', { ...selection(), reasoning: 'not allowed' }],
    ['long summary', { ...selection(), summary: 'x'.repeat(701) }],
    [
      'long explanation',
      {
        ...selection(),
        recommendations: [{ ...selection().recommendations[0], explanation: 'x'.repeat(501) }],
      },
    ],
    [
      'blank explanation',
      {
        ...selection(),
        recommendations: [{ ...selection().recommendations[0], explanation: ' ' }],
      },
    ],
  ])('rejects %s from the model', async (_name, value) => {
    await expect(
      realAdapter(async () => response(value)).recommendSales!(salesInput()),
    ).rejects.toMatchObject({ code: 'invalid_proposal' });
  });

  it.each(['floor', 'spare', 'comparison', 'unknown evidence', 'duplicate input id'])(
    'rejects unsafe input %s before contacting the model',
    async (kind) => {
      const input = salesInput();
      if (kind === 'floor') input.candidates[0]!.policy.minimumPriceCents = 9;
      if (kind === 'spare') input.candidates[0]!.policy.reserveSlots = 0;
      if (kind === 'comparison') input.candidates[0]!.comparison.proposedMatches = 11;
      if (kind === 'unknown evidence') input.candidates[0]!.evidenceIds = ['foreign'];
      if (kind === 'duplicate input id') input.candidates[0]!.id = input.candidates[1]!.id;
      const fetcher = vi.fn();
      await expect(realAdapter(fetcher).recommendSales!(input)).rejects.toMatchObject({
        code: 'invalid_proposal',
      });
      expect(fetcher).not.toHaveBeenCalled();
    },
  );

  it('preserves visible real errors without a fixture fallback or upstream body', async () => {
    await expect(
      realAdapter(async () => new Response('private upstream error', { status: 503 }))
        .recommendSales!(salesInput()),
    ).rejects.toMatchObject({
      code: 'upstream_error',
      message: 'Muse request failed (HTTP 503). Manual controls remain available.',
    });
  });
});
