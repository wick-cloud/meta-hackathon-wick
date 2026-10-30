import { readFile, stat } from 'node:fs/promises';
import { z } from 'zod';
import type { Config } from '../config.js';
import { operationFingerprint } from '../operations.js';
import {
  INFERENCE_CONTRACT,
  INFERENCE_MODEL_ID,
  INFERENCE_MODEL_NAME,
  INFERENCE_PROVIDERS,
  type InferenceCompletionInput,
  type InferenceProvider,
  type InferenceRoute,
} from '../../shared/inference.js';

export const BASETEN_MODEL = 'meta-models/muse-spark-open-1026';
export const BASETEN_BASE = 'https://inference.baseten.co/v1';
export const MODAL_BASE = 'https://inference.us-west.modal.direct/v1';
const qualification = z
  .object({
    provider: z.enum(INFERENCE_PROVIDERS),
    contract: z.literal(INFERENCE_CONTRACT),
    nativeModel: z.string().min(1).max(300),
    revision: z.string().min(1).max(100),
    evidence: z.string().min(20).max(2000),
    validUntil: z.string().datetime(),
    fixedInputUpperBound: z.number().int().min(1).max(10_000_000),
    maximumOutputTokens: z.number().int().min(1).max(8192),
    authoritativeUsage: z.literal(true),
    outputIncludesReasoning: z.literal(true),
    allAcceptedTextCovered: z.literal(true),
    rejectionHasNoUsage: z.literal(true),
  })
  .strict();
export interface RuntimeRoute {
  provider: InferenceProvider;
  mode: 'fixture' | 'real';
  fingerprint: string;
  qualified: boolean;
  reason: string;
  inputBound: number;
  maximumOutputTokens: number;
  validUntil: number;
  nativeModel: string;
  baseUrl: string;
  apiKey?: string;
}
export interface AdapterResult {
  id: string;
  content: string;
  finishReason: string;
  inputTokens: number;
  outputTokens: number;
}
export class InferenceUpstreamError extends Error {
  constructor(
    public code: string,
    public definite: boolean,
    public providerRequestId?: string,
  ) {
    super(code);
  }
}
export interface InferenceRuntime {
  enabled: boolean;
  mode: 'fixture' | 'real';
  routes: Map<InferenceProvider, RuntimeRoute>;
  dispatch(
    route: RuntimeRoute,
    input: InferenceCompletionInput,
    requestId: string,
  ): Promise<AdapterResult>;
}
export function routeView(route: RuntimeRoute, quarantined = false): InferenceRoute {
  const qualified = route.qualified && route.validUntil > Date.now() && !quarantined;
  return {
    provider: route.provider,
    mode: route.mode,
    modelId: INFERENCE_MODEL_ID,
    modelName: INFERENCE_MODEL_NAME,
    qualified,
    reason: quarantined
      ? 'Accounting quarantine: operator reconciliation is required.'
      : route.validUntil > 0 && route.validUntil <= Date.now()
        ? 'Accounting qualification has expired.'
        : route.reason,
    minimumInputReservation: route.mode === 'fixture' ? 20 : route.inputBound,
    maximumOutputTokens: route.maximumOutputTokens,
  };
}
/** Fixture tokens are fictional UTF-8 bytes plus framing; never used for a real route. */
export function fixtureInputTokens(input: InferenceCompletionInput): number {
  return (
    8 + input.messages.reduce((n, m) => n + 8 + Buffer.byteLength(m.role + m.content, 'utf8'), 0)
  );
}
export async function boundedJson(response: Response, maximum = 2 * 1024 * 1024): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) throw new InferenceUpstreamError('missing_response', false);
  let size = 0;
  const chunks: Uint8Array[] = [];
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maximum) throw new InferenceUpstreamError('response_too_large', false);
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch (error) {
    await reader.cancel().catch(() => {});
    if (error instanceof InferenceUpstreamError) throw error;
    throw new InferenceUpstreamError('invalid_response', false);
  }
}
const usageSchema = z.object({
  id: z.string().min(1).max(300),
  choices: z
    .array(
      z.object({
        message: z.object({ content: z.string().nullable() }),
        finish_reason: z.string().max(80),
      }),
    )
    .length(1),
  usage: z.object({
    prompt_tokens: z.number().int().positive(),
    completion_tokens: z.number().int().nonnegative(),
    total_tokens: z.number().int().nonnegative(),
    completion_tokens_details: z
      .object({ reasoning_tokens: z.number().int().nonnegative().optional() })
      .optional(),
  }),
});
/** A single buffered POST. No retries, redirects, provider failover, or prompt logging. */
export async function dispatchReal(
  route: RuntimeRoute,
  input: InferenceCompletionInput,
  requestId: string,
  fetcher: typeof fetch = fetch,
): Promise<AdapterResult> {
  if (!route.qualified || route.validUntil <= Date.now() || !route.apiKey)
    throw new InferenceUpstreamError('unqualified_route', true);
  try {
    const response = await fetcher(`${route.baseUrl}/chat/completions`, {
      method: 'POST',
      redirect: 'error',
      signal: AbortSignal.timeout(90_000),
      headers: {
        Authorization: `Bearer ${route.apiKey}`,
        'Content-Type': 'application/json',
        'X-Request-Id': requestId,
        ...(route.provider === 'modal' ? { 'Modal-Routing-Affinity-Key': requestId } : {}),
      },
      body: JSON.stringify({ ...input, model: route.nativeModel, stream: false, n: 1 }),
    });
    const upstreamId = response.headers.get('x-request-id')?.slice(0, 300);
    if (!response.ok) {
      await response.body?.cancel();
      // Only certified pre-generation rejections release quota. 5xx are uncertain.
      throw new InferenceUpstreamError(
        `upstream_${response.status}`,
        [400, 401, 403, 404, 413, 422, 429].includes(response.status),
        upstreamId,
      );
    }
    const parsed = usageSchema.safeParse(await boundedJson(response));
    if (!parsed.success)
      throw new InferenceUpstreamError('missing_authoritative_usage', false, upstreamId);
    const data = parsed.data;
    if (
      data.usage.total_tokens !== data.usage.prompt_tokens + data.usage.completion_tokens ||
      (data.usage.completion_tokens_details?.reasoning_tokens ?? 0) > data.usage.completion_tokens
    )
      throw new InferenceUpstreamError('inconsistent_usage', false, data.id);
    return {
      id: data.id,
      content: data.choices[0].message.content ?? '',
      finishReason: data.choices[0].finish_reason,
      inputTokens: data.usage.prompt_tokens,
      outputTokens: data.usage.completion_tokens,
    };
  } catch (error) {
    if (error instanceof InferenceUpstreamError) throw error;
    throw new InferenceUpstreamError('transport_outcome_unknown', false);
  }
}
export async function createInferenceRuntime(config: Config): Promise<InferenceRuntime> {
  const mode = config.inferenceMarketMode === 'real' ? 'real' : 'fixture';
  let certificates: z.infer<typeof qualification>[] = [];
  let fileError = false;
  if (mode === 'real' && (config.inferenceQualificationFile || config.inferenceQualificationJson)) {
    try {
      if (config.inferenceQualificationFile && config.inferenceQualificationJson) throw Error();
      if (
        config.inferenceQualificationFile &&
        (await stat(config.inferenceQualificationFile)).size > 32768
      )
        throw Error();
      const raw =
        config.inferenceQualificationJson ||
        (await readFile(config.inferenceQualificationFile!, 'utf8'));
      if (Buffer.byteLength(raw) > 32768) throw Error();
      certificates = z.array(qualification).max(2).parse(JSON.parse(raw));
      if (new Set(certificates.map((c) => c.provider)).size !== certificates.length) throw Error();
    } catch {
      fileError = true;
    }
  }
  const routes = new Map<InferenceProvider, RuntimeRoute>();
  for (const provider of INFERENCE_PROVIDERS) {
    const nativeModel = provider === 'baseten' ? BASETEN_MODEL : (config.inferenceModalModel ?? '');
    const apiKey =
      provider === 'baseten' ? config.inferenceBasetenApiKey : config.inferenceModalProxyToken;
    const cert = certificates.find((c) => c.provider === provider && c.nativeModel === nativeModel);
    const qualified =
      mode === 'fixture' ||
      Boolean(
        apiKey && nativeModel && cert && Date.parse(cert.validUntil) > Date.now() && !fileError,
      );
    const reason =
      mode === 'fixture'
        ? 'Simulated tokens and provider responses. No real inference is sold.'
        : qualified
          ? 'Operator-qualified buffered text accounting.'
          : fileError
            ? 'Accounting qualification is invalid; real purchases are disabled.'
            : !nativeModel
              ? 'Discover and configure the actual Modal SharedEndpoint model ID.'
              : !apiKey
                ? 'Provider inference credentials are not configured.'
                : 'Input bounds, reasoning usage, and pre-generation rejection accounting require qualification.';
    routes.set(provider, {
      provider,
      mode,
      nativeModel,
      apiKey,
      baseUrl: provider === 'baseten' ? BASETEN_BASE : MODAL_BASE,
      // Renewal evidence/dates do not change already purchased accounting terms.
      fingerprint: operationFingerprint({
        provider,
        mode,
        nativeModel,
        contract: INFERENCE_CONTRACT,
        accounting: cert
          ? {
              revision: cert.revision,
              inputBound: cert.fixedInputUpperBound,
              maximumOutputTokens: cert.maximumOutputTokens,
            }
          : null,
      }),
      qualified,
      reason,
      inputBound: cert?.fixedInputUpperBound ?? 1,
      maximumOutputTokens: cert?.maximumOutputTokens ?? 8192,
      validUntil:
        mode === 'fixture' ? Number.MAX_SAFE_INTEGER : cert ? Date.parse(cert.validUntil) : 0,
    });
  }
  return {
    enabled: config.inferenceMarketMode !== 'off',
    mode,
    routes,
    async dispatch(route, input, requestId) {
      if (route.mode === 'real') return dispatchReal(route, input, requestId);
      const content = 'Fixture response: prepaid token access is working.';
      const outputTokens = Math.min(input.max_tokens, Buffer.byteLength(content));
      return {
        id: `fixture-${requestId}`,
        content: content.slice(0, outputTokens),
        finishReason: 'stop',
        inputTokens: fixtureInputTokens(input),
        outputTokens,
      };
    },
  };
}
