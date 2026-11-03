import { describe, expect, it, vi } from 'vitest';
import {
  BrokerClient,
  BrokerError,
  INFERENCE_MODEL_ID,
  type InferenceCompletionInput,
} from '../packages/sdk/src/index.js';
import { BROKER_API_SCHEMAS, BROKER_OPERATION_SCHEMAS } from '../packages/sdk/src/contracts.js';
import Ajv2020 from 'ajv/dist/2020.js';

const key = 'wbk_inference_fixture.nonproduction_secret';
const response = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status });
function client(fetcher: typeof fetch) {
  return new BrokerClient({ baseUrl: 'https://broker.example', apiKey: key, fetch: fetcher });
}
const completion: InferenceCompletionInput = {
  model: INFERENCE_MODEL_ID,
  messages: [{ role: 'user', content: 'Summarize this text.' }],
  max_tokens: 128,
  stream: false,
};

describe('Broker prepaid inference clients', () => {
  it('keeps quotation nonbinding and sends one stable mutation key for each purchase or completion', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => response({ items: [] }));
    const broker = client(fetcher);
    await broker.inference.quote({ inputTokens: 1000000, outputTokens: 100000 });
    await broker.inference.orders.create(
      {
        mode: 'auction',
        inputTokens: 1000000,
        outputTokens: 100000,
        maxTotalCents: 123.45,
      },
      { operationKey: 'token-purchase-001' },
    );
    await broker.inference.complete(completion, { operationKey: 'inference-call-001' });
    expect(fetcher.mock.calls.map(([url]) => new URL(String(url)).pathname)).toEqual([
      '/api/inference/quotes',
      '/api/token-orders',
      '/api/v1/chat/completions',
    ]);
    expect(fetcher.mock.calls[0]![1]!.headers).not.toHaveProperty('Idempotency-Key');
    expect(JSON.parse(String(fetcher.mock.calls[0]![1]!.body))).not.toHaveProperty('operationKey');
    for (const [offset, operationKey] of [
      [1, 'token-purchase-001'],
      [2, 'inference-call-001'],
    ] as const) {
      const request = fetcher.mock.calls[offset]![1]!;
      expect(request.headers).toMatchObject({
        Authorization: `Bearer ${key}`,
        'Idempotency-Key': operationKey,
      });
      expect(JSON.parse(String(request.body)).operationKey).toBe(operationKey);
      expect(request.redirect).toBe('error');
    }
    await expect(broker.inference.complete(completion, {} as never)).rejects.toMatchObject({
      code: 'operation_key_required',
    });
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(JSON.parse(String(fetcher.mock.calls[1]![1]!.body)).maxTotalCents).toBe(123.45);
  });

  it('never retries an uncertain generation, purchases a refill, or replaces a completed request', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        response(
          {
            error: 'Outcome unknown',
            code: 'inference_outcome_unknown',
            requestId: 'http-1',
            inferenceRequestId: 'call-1',
          },
          409,
        ),
      )
      .mockResolvedValueOnce(
        response(
          {
            error: 'Read the receipt',
            code: 'completed_without_result',
            requestId: 'http-2',
            inferenceRequestId: 'call-1',
          },
          409,
        ),
      )
      .mockResolvedValueOnce(
        response({ id: 'call-1', status: 'settled', inputTokens: 12, outputTokens: 30 }),
      );
    const broker = client(fetcher);
    for (const [code, requestId] of [
      ['inference_outcome_unknown', 'http-1'],
      ['completed_without_result', 'http-2'],
    ])
      await expect(
        broker.inference.complete(completion, { operationKey: 'same-inference-call' }),
      ).rejects.toMatchObject({
        code,
        requestId,
        inferenceRequestId: 'call-1',
        operationKey: 'same-inference-call',
      });
    expect(fetcher).toHaveBeenCalledTimes(2);
    await expect(broker.inference.receipt('call-1')).resolves.toMatchObject({
      id: 'call-1',
      status: 'settled',
    });
    expect(
      fetcher.mock.calls.map(([url, init]) => [new URL(String(url)).pathname, init!.method]),
    ).toEqual([
      ['/api/v1/chat/completions', 'POST'],
      ['/api/v1/chat/completions', 'POST'],
      ['/api/inference/requests/call-1', 'GET'],
    ]);
  });

  it('recovers through the structured inference receipt ID while preserving HTTP correlation', async () => {
    const inferenceRequestId = '11111111-1111-4111-8111-111111111111';
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        response(
          {
            error: 'Read the receipt.',
            code: 'inference_pending',
            requestId: 'http-request-7',
            inferenceRequestId,
          },
          409,
        ),
      )
      .mockResolvedValueOnce(response({ id: inferenceRequestId, status: 'outcome_unknown' }));
    const broker = client(fetcher);
    const error = await broker.inference
      .complete(completion, { operationKey: 'recover-inference-001' })
      .catch((error: unknown) => error);
    expect(error).toBeInstanceOf(BrokerError);
    if (!(error instanceof BrokerError)) throw Error('Expected inference error');
    expect(error.toJSON()).toMatchObject({
      requestId: 'http-request-7',
      inferenceRequestId,
      operationKey: 'recover-inference-001',
    });
    expect(JSON.parse(JSON.stringify(error)).inferenceRequestId).toBe(inferenceRequestId);
    await expect(broker.inference.receipt(error.inferenceRequestId!)).resolves.toMatchObject({
      id: inferenceRequestId,
      status: 'outcome_unknown',
    });
    expect(String(fetcher.mock.calls[1]![0])).toBe(
      `https://broker.example/api/inference/requests/${inferenceRequestId}`,
    );
  });

  it('bounds waits without cancelling or resubmitting and recognizes awarded token packs', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response({ order: { id: 'order-1', status: 'open' } }));
    const broker = client(fetcher);
    await expect(
      broker.inference.orders.wait('order-1', { timeoutMs: 20, pollIntervalMs: 100 }),
    ).resolves.toMatchObject({
      state: 'pending',
      id: 'order-1',
      resource: { order: { status: 'open' } },
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0]![1]!.method).toBe('GET');
    fetcher.mockResolvedValueOnce(
      response({ order: { id: 'order-1', status: 'awarded' }, pack: { id: 'pack-1' } }),
    );
    await expect(broker.inference.orders.wait('order-1')).resolves.toMatchObject({
      state: 'complete',
      resource: { pack: { id: 'pack-1' } },
    });
  });

  it('preserves pack cursors and sends supplier revisions through the ordinary authorized mutation path', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => response({ items: [] }));
    const broker = client(fetcher);
    await broker.inference.packs({ limit: 5, cursor: 'cursor+/value' });
    await broker.provider.inference.offering();
    await broker.provider.inference.updateOffering(
      {
        expectedRevision: 1,
        active: true,
        autoBid: true,
        inputRateMicrosPerMillion: 1500000,
        outputRateMicrosPerMillion: 5000000,
        instantMarkupBps: 100,
        minimumPriceCents: 1,
        maxOutstandingInputTokens: 1000000,
        maxOutstandingOutputTokens: 100000,
      },
      { operationKey: 'supplier-offer-update' },
    );
    expect(new URL(String(fetcher.mock.calls[0]![0])).searchParams.get('cursor')).toBe(
      'cursor+/value',
    );
    expect(JSON.parse(String(fetcher.mock.calls[2]![1]!.body))).toMatchObject({
      expectedRevision: 1,
      operationKey: 'supplier-offer-update',
    });
    expect(fetcher.mock.calls[2]![1]!.method).toBe('PUT');
  });

  it('documents strict text completion inputs and exact structured token response schemas', () => {
    const Ajv = Ajv2020 as unknown as new (options: object) => {
      compile: (schema: unknown) => (value: unknown) => boolean;
    };
    const ajv = new Ajv({ strict: false, validateFormats: false });
    const validate = ajv.compile({
      ...BROKER_API_SCHEMAS.InferenceCompletionInput,
      components: { schemas: BROKER_API_SCHEMAS },
    });
    const valid = { ...completion, operationKey: 'schema-request-001' };
    expect(validate({ ...valid, top_p: 0 })).toBe(true);
    for (const invalid of [
      { ...valid, stream: true },
      { ...valid, tools: [] },
      { ...valid, messages: [{ role: 'user', content: [{ type: 'image_url', image_url: 'x' }] }] },
      { ...valid, max_tokens: -1 },
      { ...valid, max_tokens: 8193 },
      { ...valid, messages: Array.from({ length: 65 }, () => ({ role: 'user', content: '' })) },
      { ...valid, messages: [{ role: 'user', content: 'x'.repeat(60001) }] },
      { ...valid, operationKey: 'short' },
    ])
      expect(validate(invalid)).toBe(false);
    for (const name of [
      'InferenceGrant',
      'TokenPack',
      'TokenOrderDetail',
      'InferenceReceipt',
      'TokenOffering',
    ]) {
      expect(BROKER_API_SCHEMAS[name]).toMatchObject({
        type: 'object',
        additionalProperties: false,
      });
      expect((BROKER_API_SCHEMAS[name]!.required as string[]).length).toBeGreaterThan(3);
    }
    expect(BROKER_OPERATION_SCHEMAS['POST /api/token-orders']).toMatchObject({
      input: 'TokenOrderInput',
      output: 'TokenOrder',
    });
    expect(BROKER_OPERATION_SCHEMAS['GET /api/token-orders/:id']).toMatchObject({
      output: 'TokenOrderDetail',
    });
    const validatePurchase = ajv.compile({
      ...BROKER_API_SCHEMAS.TokenOrderInput,
      components: { schemas: BROKER_API_SCHEMAS },
    });
    const purchase = {
      operationKey: 'instant-schema-001',
      inputTokens: 1000000,
      outputTokens: 100000,
      mode: 'instant',
      maxTotalCents: 500,
      quoteId: 'signed-quote.'.padEnd(700, 'a'),
    };
    expect(validatePurchase(purchase)).toBe(true);
    expect(validatePurchase({ ...purchase, quoteId: 'a'.repeat(4001) })).toBe(false);
    expect(validatePurchase({ ...purchase, inputTokens: 10000001 })).toBe(false);
    expect(validatePurchase({ ...purchase, outputTokens: 1000001 })).toBe(false);
    const validateQuote = ajv.compile(BROKER_API_SCHEMAS.TokenQuote);
    const quote = {
      quoteId: 'signed-token-quote',
      grantId: null,
      fundingSource: 'wallet',
      packExpiresAt: '2026-11-02T12:00:00.000Z',
      provider: 'modal',
      modelId: INFERENCE_MODEL_ID,
      inputTokens: 10000,
      outputTokens: 1000,
      priceCents: 123.45,
      costFloorCents: 100,
      expiresAt: '2026-11-02T10:01:00.000Z',
      mode: 'fixture',
    };
    expect(validateQuote(quote)).toBe(true);
    expect(validateQuote({ ...quote, fundingSource: 'other' })).toBe(false);
    const { fundingSource: _funding, packExpiresAt: _expiry, ...legacyQuote } = quote;
    expect(validateQuote({ ...legacyQuote, grantId: 'agent-grant-id' })).toBe(true);
    const validateCredit = ajv.compile(BROKER_API_SCHEMAS.CreditEntry);
    expect(
      validateCredit({
        id: 'credit-1',
        kind: 'token_purchase',
        amountCents: -25,
        reservedDeltaCents: -25,
        grantId: 'grant-1',
        operationKey: 'token-purchase-001',
        createdAt: '2026-10-30T10:00:00.000Z',
        description: 'Prepaid input/output token pack',
      }),
    ).toBe(true);
  });
});
