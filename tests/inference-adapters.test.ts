import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../src/server/config.js';
import {
  BASETEN_BASE,
  BASETEN_MODEL,
  MODAL_BASE,
  InferenceUpstreamError,
  boundedJson,
  createInferenceRuntime,
  dispatchReal,
  fixtureInputTokens,
  routeView,
  type RuntimeRoute,
} from '../src/server/inference/runtime.js';
import {
  INFERENCE_CONTRACT,
  INFERENCE_MODEL_ID,
  utf8InputReservation,
  type InferenceCompletionInput,
  type InferenceProvider,
} from '../src/shared/inference.js';

// All credentials are synthetic. Every network call must use a mocked fetch.
const NOW = Date.parse('2026-10-30T12:00:00Z');
const MODAL_MODEL = 'fixture-muse-endpoint.modal.direct';
const env = {
  DATABASE_URL: 'postgresql://localhost/unused_adapter_fixture',
  BETTER_AUTH_SECRET: 'offline-inference-test-secret-at-least-32-characters',
  WICK_MODE: 'fixture',
  MUSE_MODE: 'fixture',
};
const realEnv = {
  ...env,
  INFERENCE_MARKET_MODE: 'real',
  INFERENCE_BASETEN_API_KEY: 'offline-baseten-secret',
  INFERENCE_MODAL_MODEL: MODAL_MODEL,
  INFERENCE_MODAL_PROXY_TOKEN: 'offline-proxy-id.offline-proxy-secret',
};
const input: InferenceCompletionInput = {
  model: INFERENCE_MODEL_ID,
  messages: [{ role: 'user', content: 'Hello, world.' }],
  max_tokens: 128,
  temperature: 0.5,
  stream: false,
};
let directory: string;

function certificate(provider: InferenceProvider = 'baseten', patch: Record<string, unknown> = {}) {
  return {
    provider,
    contract: INFERENCE_CONTRACT,
    nativeModel: provider === 'baseten' ? BASETEN_MODEL : MODAL_MODEL,
    revision: 'accounting-contract-v1',
    evidence:
      'Offline fixture evidence for unit tests only; this does not qualify a live provider.',
    validUntil: new Date(NOW + 86400000).toISOString(),
    fixedInputUpperBound: 32768,
    maximumOutputTokens: 4096,
    authoritativeUsage: true,
    outputIncludesReasoning: true,
    allAcceptedTextCovered: true,
    rejectionHasNoUsage: true,
    ...patch,
  };
}
async function certificateFile(value: unknown, raw = false) {
  const path = join(directory, `${randomUUID()}.json`);
  await writeFile(path, raw ? String(value) : JSON.stringify(value), { mode: 0o600 });
  return path;
}
async function certifiedRuntime(certificates: unknown = [certificate(), certificate('modal')]) {
  const path = await certificateFile(certificates);
  return createInferenceRuntime(loadConfig({ ...realEnv, INFERENCE_QUALIFICATION_FILE: path }));
}
function route(provider: InferenceProvider = 'baseten'): RuntimeRoute {
  return {
    provider,
    mode: 'real',
    fingerprint: 'offline-route-fingerprint',
    qualified: true,
    reason: 'Offline test route',
    inputBound: 32768,
    maximumOutputTokens: 4096,
    validUntil: NOW + 86400000,
    nativeModel: provider === 'baseten' ? BASETEN_MODEL : MODAL_MODEL,
    baseUrl: provider === 'baseten' ? BASETEN_BASE : MODAL_BASE,
    apiKey:
      provider === 'baseten' ? 'offline-baseten-secret' : 'offline-proxy-id.offline-proxy-secret',
  };
}
function completion(patch: Record<string, unknown> = {}) {
  return {
    id: 'provider-request-123',
    choices: [{ message: { content: 'A short answer.' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 20, completion_tokens: 12, total_tokens: 32 },
    ...patch,
  };
}
function response(value: unknown, headers: HeadersInit = {}) {
  return new Response(JSON.stringify(value), {
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'broker-inference-adapters-'));
});
afterAll(async () => {
  await rm(directory, { recursive: true, force: true });
});
beforeEach(() => {
  vi.spyOn(Date, 'now').mockReturnValue(NOW);
  vi.stubGlobal(
    'fetch',
    vi
      .fn<typeof fetch>()
      .mockRejectedValue(new Error('Unexpected network access in adapter unit test')),
  );
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('inference runtime enablement and qualification', () => {
  it('keeps fixed contracts unchanged and requires explicit qualification for request-sized UTF-8 reservations', async () => {
    const fixed = await certifiedRuntime();
    const dynamic = await certifiedRuntime([
      certificate('baseten', { fixedInputUpperBound: 1048576, inputAccounting: 'utf8-bytes-v1' }),
    ]);
    const old = fixed.routes.get('baseten')!,
      next = dynamic.routes.get('baseten')!;
    expect(routeView(old).minimumInputReservation).toBe(32768);
    expect(routeView(next).minimumInputReservation).toBe(4128);
    expect(routeView(next)).toMatchObject({
      minimumPackInputTokens: 4129,
      minimumOutputTokens: 1,
      inputAccounting: 'utf8-bytes-v1',
      maximumInputReservation: 1048576,
    });
    expect(routeView(old).minimumPackInputTokens).toBe(32768);
    expect(next.fingerprint).not.toBe(old.fingerprint);
    const { inputReservation } = await import('../src/server/inference/runtime.js');
    for (const content of ['a', 'Reply with only OK.', '修复 🧪 e\u0301', '\uFDFA']) {
      const messages = [{ role: 'user' as const, content }];
      expect(utf8InputReservation(messages, next.inputBound)).toBe(
        inputReservation(next, { messages }),
      );
    }
    expect(
      inputReservation(next, { messages: [{ role: 'user', content: 'Reply with only OK.' }] }),
    ).toBe(4147);
    expect(inputReservation(old, input)).toBe(32768);
    const unicode = { messages: [{ role: 'user' as const, content: '修复 🧪 e\u0301' }] };
    expect(inputReservation(next, unicode)).toBe(
      4128 + Buffer.byteLength(unicode.messages[0].content, 'utf8'),
    );
    expect(inputReservation(next, unicode)).toBeLessThan(4200);
    const many = {
      messages: Array.from({ length: 64 }, () => ({
        role: 'user' as const,
        content: '🧪'.repeat(200),
      })),
    };
    expect(inputReservation(next, many)).toBe(4096 + 64 * (32 + 800));
    const compatibility = { messages: [{ role: 'user' as const, content: '\uFDFA'.repeat(1000) }] };
    expect(inputReservation(next, compatibility)).toBeGreaterThan(
      4128 + Buffer.byteLength(compatibility.messages[0].content),
    );
    const directives =
      'Reasoning effort Reasoning Effort reasoning effort REASONING EFFORT '.repeat(500);
    expect(inputReservation(next, { messages: [{ role: 'system', content: directives }] })).toBe(
      4128 + Buffer.byteLength(directives) + 4 * 500 * 2,
    );
    expect(inputReservation(next, { messages: [{ role: 'user', content: directives }] })).toBe(
      4128 + Buffer.byteLength(directives),
    );
    const invalid = await certifiedRuntime([
      certificate('baseten', { fixedInputUpperBound: 4000, inputAccounting: 'utf8-bytes-v1' }),
    ]);
    expect(invalid.routes.get('baseten')!.qualified).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
  });
  it('defaults to an off marketplace and does not call a provider', async () => {
    const config = loadConfig(env);
    expect(config.inferenceMarketMode).toBe('off');
    const runtime = await createInferenceRuntime(config);
    expect(runtime.enabled).toBe(false);
    expect(runtime.mode).toBe('fixture');
    expect([...runtime.routes.keys()]).toEqual(['modal', 'baseten']);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('keeps credentialed real routes unqualified without accounting evidence', async () => {
    const runtime = await createInferenceRuntime(loadConfig(realEnv));
    expect(runtime.enabled).toBe(true);
    expect(runtime.mode).toBe('real');
    for (const native of runtime.routes.values()) {
      expect(native.qualified).toBe(false);
      expect(routeView(native).qualified).toBe(false);
      await expect(runtime.dispatch(native, input, 'request-no-evidence')).rejects.toMatchObject({
        code: 'unqualified_route',
        definite: true,
      });
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  it('preserves actionable missing credential and native-model reasons in the public route', async () => {
    const runtime = await createInferenceRuntime(
      loadConfig({ ...env, INFERENCE_MARKET_MODE: 'real' }),
    );
    expect(routeView(runtime.routes.get('baseten')!).reason).toContain(
      'credentials are not configured',
    );
    expect(routeView(runtime.routes.get('modal')!).reason).toContain(
      'actual Modal SharedEndpoint model ID',
    );
  });

  it('requires provider and configured native-model identity to match qualification exactly', async () => {
    const valid = await certifiedRuntime();
    expect([...valid.routes.values()].every((item) => item.qualified)).toBe(true);
    expect(valid.routes.get('baseten')).toMatchObject({
      nativeModel: BASETEN_MODEL,
      baseUrl: BASETEN_BASE,
      inputBound: 32768,
      maximumOutputTokens: 4096,
    });
    expect(valid.routes.get('modal')).toMatchObject({
      nativeModel: MODAL_MODEL,
      baseUrl: MODAL_BASE,
    });
    const changed = await certifiedRuntime([
      certificate('baseten', { nativeModel: 'different-model' }),
      certificate('modal'),
    ]);
    expect(changed.routes.get('baseten')!.qualified).toBe(false);
    expect(changed.routes.get('modal')!.qualified).toBe(true);
    const oneProvider = await certifiedRuntime([certificate('baseten')]);
    expect(oneProvider.routes.get('baseten')!.qualified).toBe(true);
    expect(oneProvider.routes.get('modal')!.qualified).toBe(false);
  });

  it.each([
    'authoritativeUsage',
    'outputIncludesReasoning',
    'allAcceptedTextCovered',
    'rejectionHasNoUsage',
  ])('rejects missing or false %s evidence', async (field) => {
    for (const value of [undefined, false]) {
      const runtime = await certifiedRuntime([
        certificate('baseten', { [field]: value }),
        certificate('modal'),
      ]);
      expect([...runtime.routes.values()].every((item) => !item.qualified)).toBe(true);
      expect(runtime.routes.get('baseten')!.reason).toContain('qualification is invalid');
    }
  });

  it.each([
    ['short evidence', { evidence: 'unproven' }],
    ['wrong contract', { contract: 'different-contract' }],
    ['fractional input bound', { fixedInputUpperBound: 1.5 }],
    ['zero input bound', { fixedInputUpperBound: 0 }],
    ['excessive output bound', { maximumOutputTokens: 8193 }],
    ['zero output minimum', { minimumOutputTokens: 0 }],
    ['inverted output range', { minimumOutputTokens: 512, maximumOutputTokens: 256 }],
    [
      'Modal policy on Baseten',
      { usagePolicy: 'modal-generated-token-ids-v1', minimumOutputTokens: 256 },
    ],
    ['unexpected field', { undocumentedFallback: true }],
  ])('fails closed for %s', async (_name, patch) => {
    const runtime = await certifiedRuntime([certificate('baseten', patch)]);
    expect(runtime.routes.get('baseten')!.qualified).toBe(false);
  });

  it('rejects invalid JSON, oversized files, duplicate providers and nonexistent files without network access', async () => {
    const invalid = await certificateFile('{', true);
    const oversized = await certificateFile(' '.repeat(32769), true);
    const duplicates = await certificateFile([certificate(), certificate()]);
    for (const path of [invalid, oversized, duplicates, join(directory, 'does-not-exist.json')]) {
      const runtime = await createInferenceRuntime(
        loadConfig({ ...realEnv, INFERENCE_QUALIFICATION_FILE: path }),
      );
      expect([...runtime.routes.values()].every((item) => !item.qualified)).toBe(true);
      expect(runtime.routes.get('baseten')!.reason).toContain('qualification is invalid');
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  it('expires qualification at the exact boundary and honors an accounting quarantine', async () => {
    const expired = await certifiedRuntime([
      certificate('baseten', { validUntil: new Date(NOW).toISOString() }),
    ]);
    expect(expired.routes.get('baseten')!.qualified).toBe(false);
    expect(routeView(expired.routes.get('baseten')!).reason).toContain('expired');
    const qualified = (await certifiedRuntime()).routes.get('baseten')!;
    expect(routeView(qualified, true)).toMatchObject({
      qualified: false,
      reason: 'Accounting quarantine: operator reconciliation is required.',
    });
    vi.mocked(Date.now).mockReturnValue(qualified.validUntil);
    expect(routeView(qualified).qualified).toBe(false);
    await expect(dispatchReal(qualified, input, 'expired-at-dispatch')).rejects.toMatchObject({
      code: 'unqualified_route',
      definite: true,
    });
    expect(fetch).not.toHaveBeenCalled();
  });
  it('accepts a sealed Railway JSON certificate without requiring a mounted file', async () => {
    const inline = await createInferenceRuntime(
      loadConfig({ ...realEnv, INFERENCE_QUALIFICATION_JSON: JSON.stringify([certificate()]) }),
    );
    const file = await certifiedRuntime([certificate()]);
    expect(inline.routes.get('baseten')!.qualified).toBe(true);
    expect(inline.routes.get('baseten')!.fingerprint).toBe(file.routes.get('baseten')!.fingerprint);
    expect(fetch).not.toHaveBeenCalled();
  });
  it('fails closed on malformed, oversized or ambiguous sealed JSON qualification', async () => {
    for (const patch of [
      { INFERENCE_QUALIFICATION_JSON: '{' },
      { INFERENCE_QUALIFICATION_JSON: ' '.repeat(32769) },
      {
        INFERENCE_QUALIFICATION_JSON: JSON.stringify([certificate()]),
        INFERENCE_QUALIFICATION_FILE: 'ambiguous-file.json',
      },
    ]) {
      const runtime = await createInferenceRuntime(loadConfig({ ...realEnv, ...patch }));
      expect(runtime.routes.get('baseten')!.qualified).toBe(false);
      expect(runtime.routes.get('baseten')!.reason).toContain('qualification is invalid');
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  it('preserves purchased semantic identity across evidence renewal but changes it for accounting changes', async () => {
    const original = (await certifiedRuntime([certificate()])).routes.get('baseten')!;
    const renewed = (
      await certifiedRuntime([
        certificate('baseten', {
          evidence: 'Renewed offline test evidence for the same accounting contract.',
          validUntil: new Date(NOW + 3 * 86400000).toISOString(),
        }),
      ])
    ).routes.get('baseten')!;
    expect(renewed.qualified).toBe(true);
    expect(renewed.fingerprint).toBe(original.fingerprint);
    for (const patch of [
      { revision: 'accounting-contract-v2' },
      { fixedInputUpperBound: 65536 },
      { maximumOutputTokens: 2048 },
      { minimumOutputTokens: 256 },
    ]) {
      const changed = (await certifiedRuntime([certificate('baseten', patch)])).routes.get(
        'baseten',
      )!;
      expect(changed.fingerprint).not.toBe(original.fingerprint);
    }
  });
});

describe('single-attempt provider requests and authoritative usage', () => {
  it('rejects output caps outside the certified range without contacting the provider', async () => {
    const fetcher = vi.fn<typeof fetch>();
    const native = (
      await certifiedRuntime([certificate('modal', { minimumOutputTokens: 256 })])
    ).routes.get('modal')!;
    expect(routeView(native).reason).toContain('256');
    expect(routeView(native).minimumOutputTokens).toBe(256);
    await expect(
      dispatchReal(native, { ...input, max_tokens: 8 }, 'below-minimum', fetcher),
    ).rejects.toMatchObject({ code: 'unqualified_output_limit', definite: true });
    await expect(
      dispatchReal(native, { ...input, max_tokens: 4097 }, 'above-maximum', fetcher),
    ).rejects.toMatchObject({ code: 'unqualified_output_limit', definite: true });
    expect(fetcher).not.toHaveBeenCalled();
    const explicitDefault = (
      await certifiedRuntime([certificate('baseten', { minimumOutputTokens: 1 })])
    ).routes.get('baseten')!;
    expect(explicitDefault.fingerprint).toBe(
      (await certifiedRuntime([certificate()])).routes.get('baseten')!.fingerprint,
    );
  });
  it.each(['baseten', 'modal'] as const)(
    'requests native JSON only for opted-in internal %s calls',
    async (provider) => {
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response(completion()));
      await dispatchReal(
        (await certifiedRuntime()).routes.get(provider)!,
        input,
        'internal-json',
        fetcher,
        { jsonObject: true },
      );
      expect(JSON.parse(fetcher.mock.calls[0]![1]!.body as string).response_format).toEqual({
        type: 'json_object',
      });
      expect(fetcher).toHaveBeenCalledTimes(1);
    },
  );
  it.each(['baseten', 'modal'] as const)(
    'omits provider-specific reasoning parameters for %s and preserves accounting bounds',
    async (provider) => {
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response(completion()));
      const native = (await certifiedRuntime()).routes.get(provider)!;
      const result = await dispatchReal(
        native,
        { ...input, max_tokens: 2048 },
        'planning-provider-reasoning',
        fetcher,
      );
      const body = JSON.parse(fetcher.mock.calls[0]![1]!.body as string);
      expect(body.max_tokens).toBe(2048);
      expect(body).not.toHaveProperty('reasoning_effort');
      expect(body).not.toHaveProperty('reasoning');
      expect(result.inputTokens).toBe(20);
      expect(result.outputTokens).toBe(12);
      expect(fetcher).toHaveBeenCalledTimes(1);
      expect(native.inputBound).toBe(32768);
    },
  );
  it.each(['baseten', 'modal'] as const)(
    'dispatches %s to its fixed URL with its actual model and private authentication',
    async (provider) => {
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response(completion()));
      const native = (await certifiedRuntime()).routes.get(provider)!;
      const result = await dispatchReal(native, input, 'broker-request-id', fetcher);
      expect(result).toEqual({
        id: 'provider-request-123',
        content: 'A short answer.',
        finishReason: 'stop',
        inputTokens: 20,
        outputTokens: 12,
      });
      expect(fetcher).toHaveBeenCalledTimes(1);
      const [url, init] = fetcher.mock.calls[0]!;
      expect(url).toBe(`${provider === 'baseten' ? BASETEN_BASE : MODAL_BASE}/chat/completions`);
      expect(init).toMatchObject({ method: 'POST', redirect: 'error' });
      expect(init!.signal).toBeInstanceOf(AbortSignal);
      const headers = new Headers(init!.headers);
      expect(headers.get('authorization')).toBe(`Bearer ${native.apiKey}`);
      expect(headers.get('x-request-id')).toBe('broker-request-id');
      expect(headers.get('modal-routing-affinity-key')).toBe(
        provider === 'modal' ? 'broker-request-id' : null,
      );
      expect(JSON.parse(init!.body as string)).toEqual({
        ...input,
        model: provider === 'baseten' ? BASETEN_MODEL : MODAL_MODEL,
        stream: false,
        n: 1,
      });
      expect(fetch).not.toHaveBeenCalled();
    },
  );

  it('uses authoritative completion totals including reasoning without counting reasoning twice or estimating visible text', async () => {
    const value = completion({
      choices: [
        {
          message: {
            content: 'OK',
            reasoning: 'Private intermediate text must not replace the final content.',
          },
          finish_reason: 'length',
        },
      ],
      usage: {
        prompt_tokens: 100,
        completion_tokens: 80,
        total_tokens: 180,
        completion_tokens_details: { reasoning_tokens: 72 },
      },
    });
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response(value));
    const result = await dispatchReal(route(), input, 'reasoning-request', fetcher);
    expect(result).toMatchObject({
      content: 'OK',
      finishReason: 'length',
      inputTokens: 100,
      outputTokens: 80,
    });
    expect(result).not.toHaveProperty('reasoning');
  });
  it('settles reasoning-only generation when the final text is null', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      response(
        completion({
          choices: [{ message: { content: null }, finish_reason: 'length' }],
        }),
      ),
    );
    expect(await dispatchReal(route(), input, 'reasoning-only', fetcher)).toMatchObject({
      content: '',
      outputTokens: 12,
      inputTokens: 20,
    });
  });

  it('uses Modal completion totals once when reasoning is reported at the top level', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      response(
        completion({
          usage: {
            prompt_tokens: 152,
            completion_tokens: 187,
            total_tokens: 339,
            reasoning_tokens: 180,
          },
        }),
      ),
    );
    expect(await dispatchReal(route('modal'), input, 'modal-reasoning', fetcher)).toMatchObject({
      inputTokens: 152,
      outputTokens: 187,
    });
  });

  it.each([
    { prompt_tokens: 161, completion_tokens: 8, total_tokens: 169, reasoning_tokens: 10 },
    { prompt_tokens: 20, completion_tokens: 12, total_tokens: 32, reasoning_tokens: -1 },
    { prompt_tokens: 20, completion_tokens: 12, total_tokens: 32, reasoning_tokens: 1.5 },
    { prompt_tokens: 20, completion_tokens: 12, total_tokens: 32, reasoning_tokens: '8' },
    {
      prompt_tokens: 20,
      completion_tokens: 12,
      total_tokens: 32,
      reasoning_tokens: 8,
      completion_tokens_details: { reasoning_tokens: 7 },
    },
  ])('keeps contradictory or malformed top-level reasoning unresolved: %j', async (usage) => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response(completion({ usage })));
    await expect(
      dispatchReal(route('modal'), input, 'modal-conflicting-reasoning', fetcher),
    ).rejects.toMatchObject({ definite: false });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it.each(['modal', 'baseten'] as const)(
    'accepts null token-ID extensions on legacy %s',
    async (provider) => {
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
        response(
          completion({
            choices: [
              {
                message: { content: 'OK' },
                finish_reason: 'stop',
                prompt_token_ids: null,
                response_token_ids: null,
              },
            ],
          }),
        ),
      );
      expect(
        await dispatchReal(route(provider), input, 'legacy-null-extensions', fetcher),
      ).toMatchObject({ inputTokens: 20, outputTokens: 12 });
    },
  );
  it('requires a fingerprinted Modal token-ID contract and verifies primary usage independently', async () => {
    const legacy = (
      await certifiedRuntime([certificate('modal', { minimumOutputTokens: 256 })])
    ).routes.get('modal')!;
    const native = (
      await certifiedRuntime([
        certificate('modal', {
          minimumOutputTokens: 256,
          usagePolicy: 'modal-generated-token-ids-v1',
        }),
      ])
    ).routes.get('modal')!;
    expect(native.fingerprint).not.toBe(legacy.fingerprint);
    const invalid = await certifiedRuntime([
      certificate('modal', { usagePolicy: 'modal-generated-token-ids-v1' }),
    ]);
    expect(invalid.routes.get('modal')!.qualified).toBe(false);
    const data = completion({
      choices: [
        {
          message: { content: 'OK' },
          finish_reason: 'stop',
          prompt_token_ids: [1, 2, 3],
          response_token_ids: [4, 5, 6, 7, 8],
        },
      ],
      usage: {
        prompt_tokens: 3,
        completion_tokens: 5,
        total_tokens: 8,
        reasoning_tokens: 7,
        completion_tokens_details: { reasoning_tokens: 6 },
      },
    });
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => response(data));
    const result = await dispatchReal(
      native,
      { ...input, max_tokens: 256 },
      'verified-modal',
      fetcher,
    );
    expect(result).toMatchObject({
      inputTokens: 3,
      outputTokens: 5,
      usageVerification: { method: 'modal-generated-token-ids-v1', reportedReasoningTokens: 7 },
    });
    expect(result).not.toHaveProperty('platformOutputTokens');
    expect(result).not.toHaveProperty('prompt_token_ids');
    expect(JSON.parse(String(fetcher.mock.calls[0][1]?.body)).return_token_ids).toBe(true);
    await expect(
      dispatchReal(legacy, { ...input, max_tokens: 256 }, 'legacy-unchanged', fetcher),
    ).rejects.toMatchObject({ code: 'inconsistent_usage', definite: false });
    expect(JSON.parse(String(fetcher.mock.calls[1][1]?.body))).not.toHaveProperty(
      'return_token_ids',
    );
  });
  it.each([
    { prompt_token_ids: undefined, response_token_ids: [4, 5] },
    { prompt_token_ids: null, response_token_ids: null },
    { prompt_token_ids: [1, 2, 3], response_token_ids: undefined },
    { prompt_token_ids: [1, 2], response_token_ids: [4, 5] },
    { prompt_token_ids: [1, 2, 3], response_token_ids: [4] },
    { prompt_token_ids: [1, 2, 3], response_token_ids: [4, 5.5] },
    { prompt_token_ids: [1, 2, 3], response_token_ids: [4, -1] },
  ])('rejects missing, malformed or mismatched raw token evidence: %j', async (ids) => {
    const native = {
      ...route('modal'),
      minimumOutputTokens: 256,
      usagePolicy: 'modal-generated-token-ids-v1' as const,
    };
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      response(
        completion({
          choices: [{ message: { content: 'OK' }, finish_reason: 'stop', ...ids }],
          usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
        }),
      ),
    );
    await expect(
      dispatchReal(native, { ...input, max_tokens: 256 }, 'bad-token-evidence', fetcher),
    ).rejects.toMatchObject({ definite: false });
  });
  it('never accepts inconsistent primary totals even with matching raw token lengths', async () => {
    const native = {
      ...route('modal'),
      minimumOutputTokens: 256,
      usagePolicy: 'modal-generated-token-ids-v1' as const,
    };
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      response(
        completion({
          choices: [
            {
              message: { content: 'OK' },
              finish_reason: 'stop',
              prompt_token_ids: [1, 2, 3],
              response_token_ids: [4, 5],
            },
          ],
          usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 6, reasoning_tokens: 8 },
        }),
      ),
    );
    await expect(
      dispatchReal(native, { ...input, max_tokens: 256 }, 'bad-primary-totals', fetcher),
    ).rejects.toMatchObject({ code: 'inconsistent_usage', definite: false });
  });
  it.each(['top-level', 'nested', 'both'] as const)(
    'absorbs exactly one extra Modal reasoning token reported %s without charging agent quota',
    async (location) => {
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
        response(
          completion({
            usage: {
              prompt_tokens: 161,
              completion_tokens: 8,
              total_tokens: 169,
              ...(location !== 'nested' ? { reasoning_tokens: 9 } : {}),
              ...(location !== 'top-level'
                ? { completion_tokens_details: { reasoning_tokens: 9 } }
                : {}),
            },
          }),
        ),
      );
      expect(
        await dispatchReal(route('modal'), input, 'modal-platform-token', fetcher),
      ).toMatchObject({ inputTokens: 161, outputTokens: 8, platformOutputTokens: 1 });
    },
  );
  it('does not apply the Modal discrepancy allowance to Baseten', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      response(
        completion({
          usage: {
            prompt_tokens: 161,
            completion_tokens: 8,
            total_tokens: 169,
            reasoning_tokens: 9,
          },
        }),
      ),
    );
    await expect(
      dispatchReal(route('baseten'), input, 'baseten-strict-usage', fetcher),
    ).rejects.toMatchObject({ code: 'inconsistent_usage', definite: false });
  });

  it.each([13, -1, 1.5, '10'])(
    'keeps contradictory or malformed reasoning count %s unresolved',
    async (reasoningTokens) => {
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
        response(
          completion({
            usage: {
              prompt_tokens: 20,
              completion_tokens: 12,
              total_tokens: 32,
              completion_tokens_details: { reasoning_tokens: reasoningTokens },
            },
          }),
        ),
      );
      await expect(dispatchReal(route(), input, 'bad-reasoning', fetcher)).rejects.toMatchObject({
        definite: false,
      });
      expect(fetcher).toHaveBeenCalledTimes(1);
    },
  );

  it.each([
    ['missing usage', undefined],
    ['null usage', null],
    ['missing output', { prompt_tokens: 20, total_tokens: 20 }],
    ['negative input', { prompt_tokens: -1, completion_tokens: 12, total_tokens: 11 }],
    ['fractional output', { prompt_tokens: 20, completion_tokens: 1.5, total_tokens: 21.5 }],
    ['string output', { prompt_tokens: 20, completion_tokens: '12', total_tokens: 32 }],
  ])('does not release quota after %s', async (_name, usage) => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        response(completion({ usage }), { 'x-request-id': 'provider-correlation' }),
      );
    await expect(dispatchReal(route(), input, 'missing-usage', fetcher)).rejects.toMatchObject({
      code: 'missing_authoritative_usage',
      definite: false,
      providerRequestId: 'provider-correlation',
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('rejects inconsistent total usage and keeps the provider response ID', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        response(
          completion({ usage: { prompt_tokens: 20, completion_tokens: 12, total_tokens: 33 } }),
        ),
      );
    await expect(dispatchReal(route(), input, 'inconsistent-usage', fetcher)).rejects.toMatchObject(
      { code: 'inconsistent_usage', definite: false, providerRequestId: 'provider-request-123' },
    );
  });

  it.each([400, 401, 403, 404, 413, 422, 429, 408, 409, 500, 502, 503])(
    'classifies HTTP %i without retries or response-body exposure',
    async (status) => {
      const cancel = vi.fn();
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('private provider error details'));
        },
        cancel,
      });
      const fetcher = vi
        .fn<typeof fetch>()
        .mockResolvedValue(
          new Response(stream, { status, headers: { 'x-request-id': 'provider-error-request' } }),
        );
      const promise = dispatchReal(route(), input, 'http-error', fetcher);
      await expect(promise).rejects.toMatchObject({
        code: `upstream_${status}`,
        definite: [400, 401, 403, 404, 413, 422, 429].includes(status),
        providerRequestId: 'provider-error-request',
        message: `upstream_${status}`,
      });
      expect(cancel).toHaveBeenCalledTimes(1);
      expect(fetcher).toHaveBeenCalledTimes(1);
    },
  );

  it('enforces the 90-second request signal and treats timeout as an unknown outcome', async () => {
    const controller = new AbortController();
    const timeout = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(controller.signal);
    const fetcher = vi.fn<typeof fetch>().mockImplementation(
      async (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init!.signal!.addEventListener(
            'abort',
            () => reject(new DOMException('offline timeout', 'TimeoutError')),
            { once: true },
          );
        }),
    );
    const pending = dispatchReal(route(), input, 'timeout-request', fetcher);
    const rejection = expect(pending).rejects.toMatchObject({
      code: 'transport_outcome_unknown',
      definite: false,
    });
    controller.abort();
    await rejection;
    expect(timeout).toHaveBeenCalledWith(90000);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('redacts transport errors and never falls back to another provider', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockRejectedValue(
        new Error('transport failure with offline-private-token and prompt contents'),
      );
    const pending = dispatchReal(route('modal'), input, 'transport-error', fetcher);
    await expect(pending).rejects.toMatchObject({
      code: 'transport_outcome_unknown',
      definite: false,
      message: 'transport_outcome_unknown',
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('rejects malformed JSON, absent bodies and multiple completions as uncertain', async () => {
    for (const body of [
      new Response('{'),
      new Response(null),
      response(completion({ choices: [completion().choices[0], completion().choices[0]] })),
    ]) {
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(body);
      await expect(
        dispatchReal(route(), input, 'malformed-response', fetcher),
      ).rejects.toBeInstanceOf(InferenceUpstreamError);
      expect(fetcher).toHaveBeenCalledTimes(1);
    }
  });

  it('bounds streamed response bytes and cancels an oversized response before consuming the rest', async () => {
    const cancel = vi.fn();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(2 * 1024 * 1024 + 1));
      },
      cancel,
    });
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(stream));
    await expect(dispatchReal(route(), input, 'oversize-response', fetcher)).rejects.toMatchObject({
      code: 'response_too_large',
      definite: false,
    });
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('counts UTF-8 bytes at the response bound, including multibyte characters split across chunks', async () => {
    const bytes = new TextEncoder().encode('{"text":"🙂"}');
    const body = () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(bytes.slice(0, 11));
            controller.enqueue(bytes.slice(11));
            controller.close();
          },
        }),
      );
    await expect(boundedJson(body(), bytes.length)).resolves.toEqual({ text: '🙂' });
    await expect(boundedJson(body(), bytes.length - 1)).rejects.toMatchObject({
      code: 'response_too_large',
      definite: false,
    });
  });
});

describe('fictional tokens stay separate from certified real accounting', () => {
  it('uses deterministic UTF-8 fixture framing and never calls fetch in fixture mode', async () => {
    const runtime = await createInferenceRuntime(
      loadConfig({ ...env, INFERENCE_MARKET_MODE: 'fixture' }),
    );
    const unicode: InferenceCompletionInput = {
      ...input,
      messages: [
        { role: 'system', content: 'é' },
        { role: 'user', content: '🙂' },
      ],
      max_tokens: 5,
    };
    expect(fixtureInputTokens(unicode)).toBe(8 + 8 + 6 + 2 + 8 + 4 + 4);
    for (const native of runtime.routes.values()) {
      expect(routeView(native).minimumInputReservation).toBe(20);
      const result = await runtime.dispatch(native, unicode, 'fixture-only');
      expect(result).toMatchObject({
        id: 'fixture-fixture-only',
        content: 'Fixtu',
        inputTokens: 40,
        outputTokens: 5,
      });
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  it('publishes the certified real input reservation and returns provider usage instead of fixture counts', async () => {
    const native = (await certifiedRuntime()).routes.get('modal')!;
    expect(routeView(native).minimumInputReservation).toBe(32768);
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        response(
          completion({ usage: { prompt_tokens: 1234, completion_tokens: 11, total_tokens: 1245 } }),
        ),
      );
    const result = await dispatchReal(native, input, 'real-counts', fetcher);
    expect(result.inputTokens).toBe(1234);
    expect(result.inputTokens).not.toBe(fixtureInputTokens(input));
    expect(native.inputBound).toBe(32768);
  });
});
