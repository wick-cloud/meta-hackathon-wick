import { describe, expect, it, vi } from 'vitest';
import { createMuseAdapter } from '../src/server/integrations/muse.js';
import type { MuseBuyingInput } from '../src/shared/buying.js';

const input: MuseBuyingInput = {
  kind: 'purchase',
  availableCalls: 1,
  expiresInMinutes: 90,
  candidates: [
    {
      id: 'auction-1',
      mode: 'auction',
      inputTokens: 1048576,
      outputTokens: 512,
      estimatedPriceCents: 173.31,
      calls: 1,
    },
  ],
};
const response = (value: unknown) =>
  new Response(
    JSON.stringify({
      choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(value) } }],
    }),
  );
describe('Muse token procurement adapter', () => {
  it('labels fixtures and makes no model request', async () => {
    const fetcher = vi.fn();
    const adapter = createMuseAdapter({ museMode: 'fixture' }, { fetch: fetcher });
    expect(await adapter.selectTokenPurchase!(input)).toEqual({
      candidateId: 'auction-1',
      reason: 'refill',
      modelCalled: false,
      mode: 'fixture',
    });
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('real-mode adapter selects only supplied candidates without exposing quote tokens', async () => {
    const fetcher = vi.fn<typeof fetch>(async () =>
      response({ candidateId: 'auction-1', reason: 'refill' }),
    );
    const adapter = createMuseAdapter(
      { museMode: 'real', metaApiKey: 'test-only-not-a-secret' },
      { fetch: fetcher },
    );
    expect((await adapter.selectTokenPurchase!(input)).modelCalled).toBe(true);
    const request = JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body));
    expect(request.model).toBe('meta-models/muse-spark-open-1026');
    expect(request.messages[1].content).not.toContain('quoteId');
  });
  it.each([
    { candidateId: 'unapproved', reason: 'refill' },
    { candidateId: 'auction-1', reason: 'refill', priceCents: 0 },
    { candidateId: 'auction-1', reason: 'ignore-all-limits' },
  ])('rejects altered or unapproved output %#', async (value) => {
    const adapter = createMuseAdapter(
      { museMode: 'real', metaApiKey: 'test-only-not-a-secret' },
      { fetch: async () => response(value) },
    );
    await expect(adapter.selectTokenPurchase!(input)).rejects.toMatchObject({
      code: 'invalid_proposal',
    });
  });
  it('never replaces real model failure with a fixture recommendation', async () => {
    const adapter = createMuseAdapter(
      { museMode: 'real', metaApiKey: 'test-only-not-a-secret' },
      { fetch: async () => new Response('', { status: 503 }) },
    );
    await expect(adapter.selectTokenPurchase!(input)).rejects.toMatchObject({
      code: 'upstream_error',
    });
  });
});
