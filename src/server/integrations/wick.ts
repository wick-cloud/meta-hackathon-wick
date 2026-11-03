import { realDrives, fixtureDrives } from './drives.js';
import { z } from 'zod';
import { createHash, randomUUID } from 'node:crypto';
import { Wick, WickError, WickTimeoutError } from '@wick-cloud/sdk';
import WebSocket from 'ws';
import { fixtureTerminal } from './terminal-fixture.js';
import type { Pool } from 'pg';
import type { CatalogItem } from '../../shared/types.js';
import type {
  CreateEnvironmentInput,
  WickAdapter,
  WickConnections,
  WickCreateResult,
  WickEnvironment,
  WickSession,
  WickTerminal,
} from './types.js';

export interface WickConfig {
  wickMode: 'fixture' | 'real';
  wickApiBase: string;
  wickApiKey?: string;
  wickOrganizationId: string;
  wickGroupId: string;
}

/** Sanitized failure: response bodies and service credentials never become API errors. */
export class WickApiError extends Error {
  constructor(
    message: string,
    public statusCode?: number,
    public admissionRejected = false,
  ) {
    super(message);
    this.name = 'WickApiError';
  }
}

const MAX_RESPONSE_BYTES = 1024 * 1024;
const RENTAL_SECONDS = [900, 1800, 3600];
const MANAGED_PROVIDERS = new Map([
  ['e2b', 'E2B'],
  ['daytona', 'Daytona'],
  ['modal', 'Modal'],
  ['provider-blaxel', 'Baseten (Blaxel)'],
]);
const MAX_MANAGED_ROUTES = 16;
const ROUTE_PREVIEW_CONCURRENCY = 4;
type JsonObject = Record<string, unknown>;
function object(value: unknown, field: string): JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new WickApiError(`Wick response has invalid ${field}`);
  return value as JsonObject;
}
function string(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.length || value.length > 8192)
    throw new WickApiError(`Wick response has invalid ${field}`);
  return value;
}
function timestamp(value: unknown, field: string): string {
  const result = string(value, field);
  if (!Number.isFinite(Date.parse(result)))
    throw new WickApiError(`Wick response has invalid ${field}`);
  return new Date(result).toISOString();
}
function finitePositive(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0)
    throw new WickApiError(`Wick response has invalid ${field}`);
  return value;
}

/** Keep the public response envelope in raw; do not invent aliases for undocumented fields. */
export function parseEnvironment(value: unknown): WickEnvironment {
  const raw = object(value, 'environment');
  const statuses = ['provisioning', 'running', 'terminating', 'terminated', 'failed'];
  if (typeof raw.status !== 'string' || !statuses.includes(raw.status)) {
    throw new WickApiError('Wick environment state is unsupported for finite rentals');
  }
  return {
    id: string(raw.id, 'environment.id'),
    status: raw.status as WickEnvironment['status'],
    expiresAt: raw.expiresAt == null ? null : timestamp(raw.expiresAt, 'environment.expiresAt'),
    ...(raw.hardEndAt == null
      ? {}
      : { hardEndAt: timestamp(raw.hardEndAt, 'environment.hardEndAt') }),
    ...(raw.createdAt == null
      ? {}
      : { createdAt: timestamp(raw.createdAt, 'environment.createdAt') }),
    ...Object.fromEntries(
      ['name', 'organizationId', 'groupId', 'provider', 'profile', 'providerKeyId'].flatMap(
        (field) =>
          raw[field] == null ? [] : [[field, string(raw[field], `environment.${field}`)]],
      ),
    ),
    ...(raw.billingMode === 'wick_managed' || raw.billingMode === 'byok'
      ? { billingMode: raw.billingMode }
      : {}),
    ...(raw.workspaceDrive == null
      ? {}
      : {
          workspaceDrive: z
            .object({
              driveId: z.string().min(1).max(150),
              generation: z.string().min(1).max(150),
              status: z.enum([
                'reserved',
                'mounting',
                'mounted',
                'connecting',
                'connected',
                'detaching',
                'detached',
              ]),
              attachmentMode: z.enum(['exclusive', 'shared']).optional(),
              accessMode: z.enum(['mount', 'files']).optional(),
              workspacePath: z.string().optional(),
            })
            .parse(raw.workspaceDrive),
        }),
    raw,
  };
}
export function parseCreateResult(value: unknown): WickCreateResult {
  const raw = object(value, 'create response');
  const operation = object(raw.operation, 'operation');
  return {
    environment: parseEnvironment(raw.environment),
    operation: {
      id: string(operation.id, 'operation.id'),
      status: string(operation.status, 'operation.status'),
    },
    raw,
  };
}
export function parseConnections(value: unknown): WickConnections {
  const raw = object(value, 'connections');
  if (typeof raw.terminal !== 'boolean')
    throw new WickApiError('Wick response has invalid terminal capability');
  return { terminal: raw.terminal };
}
export function parseSession(value: unknown, environmentId: string): WickSession {
  const raw = object(value, 'session response');
  const session = object(raw.session, 'session');
  if (session.environmentId !== environmentId)
    throw new WickApiError('Wick session scope does not match environment');
  const token = string(raw.token, 'session token');
  const terminalWebsocketUrl = string(raw.terminalWebsocketUrl, 'terminalWebsocketUrl');
  const url = new URL(terminalWebsocketUrl);
  if (url.protocol !== 'wss:' || url.username || url.password || url.search || url.hash)
    throw new WickApiError('Wick terminal URL must use secure WebSocket transport');
  const expiresAt = timestamp(session.expiresAt, 'session.expiresAt');
  if (Date.parse(expiresAt) <= Date.now() + 5000)
    throw new WickApiError('Wick terminal session is already expiring');
  return { token, terminalWebsocketUrl, expiresAt };
}

/** Public offer TTL bounds and create's finite ttlSeconds allow these exact durations. */
export function parseCatalog(
  value: unknown,
  config: Pick<WickConfig, 'wickOrganizationId' | 'wickGroupId'>,
  verifiedManagedRoutes: ReadonlySet<string> = new Set(),
): CatalogItem[] {
  const raw = object(value, 'catalog');
  if (!Array.isArray(raw.profiles) || !Array.isArray(raw.offers))
    throw new WickApiError('Wick catalog must contain profiles and offers');
  const profiles = new Map(
    raw.profiles.map((value) => {
      const profile = object(value, 'profile');
      return [string(profile.id, 'profile.id'), profile];
    }),
  );
  const result = new Map<string, CatalogItem>();
  const rateRetrievedAt = new Date().toISOString();
  for (const value of raw.offers) {
    const offer = object(value, 'offer');
    if (offer.available !== true) continue;
    // Explicit capability omission is a known terminal blocker, even when compute is available.
    // Older catalog shapes without capabilities remain subject to the existing readiness check.
    if (Array.isArray(offer.capabilities) && !offer.capabilities.includes('interactive-terminal'))
      continue;
    // Connection-specific BYOK offers have no approved complete cost semantics.
    if (
      offer.providerKeyId != null ||
      offer.mode === 'byok' ||
      (offer.scope != null && offer.scope !== 'global')
    )
      continue;
    const provider = string(offer.provider, 'offer.provider');
    // Provider names select native Wick routes, independently of marketplace account names.
    const providerName = MANAGED_PROVIDERS.get(provider);
    if (!providerName || !offer.byok) continue;
    const rate = offer.rateMicrosPerSecond;
    if (!Number.isSafeInteger(rate) || (rate as number) < 0)
      throw new WickApiError('Wick offer has invalid rateMicrosPerSecond');
    const profileId = string(offer.profile, 'offer.profile');
    const profile = profiles.get(profileId);
    if (!profile) throw new WickApiError('Wick offer refers to an unknown resource profile');
    const region = string(offer.region, 'offer.region');
    const route = `${provider}:${profileId}:${region}`;
    const byokDisabled = object(offer.byok, 'offer.byok').enabled === false;
    if (!byokDisabled && !verifiedManagedRoutes.has(route)) continue;
    const maximum = finitePositive(offer.maxTtlSeconds, 'offer.maxTtlSeconds');
    const durationMinutes = RENTAL_SECONDS.filter((seconds) => seconds <= maximum).map(
      (seconds) => seconds / 60,
    );
    if (!durationMinutes.length) continue;
    const resources =
      offer.resources == null ? profile : object(offer.resources, 'offer.resources');
    const description =
      typeof profile.description === 'string'
        ? profile.description
        : 'Published Wick configuration';
    // Connection capability is checked again before charging; catalog capabilities are not a readiness assertion.
    const item: CatalogItem = {
      id: `${provider}:${profileId}:${region}`,
      name: `${string(profile.name, 'profile.name')} · ${providerName}`,
      description:
        provider === 'provider-blaxel'
          ? `${description} Listed as Baseten, backed by Blaxel. CPU and disk figures are estimates; Blaxel manages these resources.`
          : description,
      provider,
      profile: profileId,
      region,
      rateMicrosPerSecond: rate as number,
      rateRetrievedAt,
      rateSource: 'wick-customer-catalog',
      pricingMode: 'managed',
      managedRouteVerification: verifiedManagedRoutes.has(route)
        ? 'execution-preview-managed'
        : 'organization-catalog-byok-disabled',
      resources: {
        cpu: finitePositive(resources.cpu, 'resources.cpu'),
        memoryGb: finitePositive(resources.memoryMiB, 'resources.memoryMiB') / 1024,
        ...(typeof resources.diskMiB === 'number'
          ? { diskGb: finitePositive(resources.diskMiB, 'resources.diskMiB') / 1024 }
          : {}),
      },
      cpu: finitePositive(resources.cpu, 'resources.cpu'),
      memoryGb: finitePositive(resources.memoryMiB, 'resources.memoryMiB') / 1024,
      durationMinutes,
      maxTtlSeconds: maximum,
      ...(Array.isArray(offer.capabilities)
        ? { capabilities: z.array(z.string().max(100)).max(100).parse(offer.capabilities) }
        : {}),
      ...(['native', 'supervised', 'none'].includes(String(offer.deadlineEnforcement))
        ? { deadlineEnforcement: offer.deadlineEnforcement as CatalogItem['deadlineEnforcement'] }
        : {}),
      approved: false,
      organizationId: config.wickOrganizationId,
      groupId: config.wickGroupId,
    };
    const existing = result.get(route);
    if (existing && JSON.stringify(existing) !== JSON.stringify(item))
      throw new WickApiError('Wick catalog has conflicting offers for one managed route');
    result.set(route, item);
  }
  return [...result.values()];
}

function managedPreviewMatches(value: unknown, input: CreateEnvironmentInput): boolean {
  const preview = object(value, 'execution preview');
  if (
    preview.kind !== 'environment' ||
    preview.organizationId !== input.organizationId ||
    preview.groupId !== input.groupId ||
    preview.eligible !== true ||
    !preview.selectedOffer ||
    !Array.isArray(preview.fallbackOffers) ||
    preview.fallbackOffers.length !== 0
  )
    return false;
  const selected = object(preview.selectedOffer, 'selected managed offer');
  if (
    Array.isArray(selected.capabilities) &&
    !selected.capabilities.includes('interactive-terminal')
  )
    return false;
  return (
    selected.provider === input.provider &&
    selected.profile === input.profile &&
    selected.region === input.region &&
    selected.billingMode === 'wick_managed' &&
    selected.providerKeyId == null &&
    selected.externalCompute === false
  );
}

function createBody(
  input: CreateEnvironmentInput,
): CreateEnvironmentInput & { profile: 'micro' | 'small' | 'medium' | 'large' } {
  const scheduled = input.hardEndAt !== undefined;
  if (
    !(scheduled
      ? Number.isSafeInteger(input.ttlSeconds) &&
        input.ttlSeconds >= 60 &&
        input.ttlSeconds <= 86400
      : RENTAL_SECONDS.includes(input.ttlSeconds)) ||
    input.visibility !== 'private'
  ) {
    throw new WickApiError(
      'Only private, finite 15, 30, or 60 minute rentals are supported',
      400,
      true,
    );
  }
  if (
    scheduled &&
    (!Number.isFinite(Date.parse(input.hardEndAt!)) ||
      Date.parse(input.hardEndAt!) < Date.now() + 60_000)
  )
    throw new WickApiError('The scheduled hard cutoff is too close or has elapsed', 400, true);
  for (const field of ['organizationId', 'groupId', 'name', 'provider', 'profile'] as const) {
    if (typeof input[field] !== 'string' || !input[field].length || input[field].length > 150) {
      throw new WickApiError(`Invalid Wick create ${field}`, 400, true);
    }
  }
  if (!['micro', 'small', 'medium', 'large'].includes(input.profile))
    throw new WickApiError('Unsupported Wick resource profile', 400, true);
  if (
    input.maximumPriceMicrosPerSecond !== undefined &&
    (!Number.isSafeInteger(input.maximumPriceMicrosPerSecond) ||
      input.maximumPriceMicrosPerSecond < 0)
  )
    throw new WickApiError('Invalid frozen Wick price limit', 400, true);
  // Deliberately enumerate fields: no repository, agent, setup, task, secret or arbitrary execution input.
  return {
    organizationId: input.organizationId,
    groupId: input.groupId,
    name: input.name,
    provider: input.provider,
    profile: input.profile as 'micro' | 'small' | 'medium' | 'large',
    ttlSeconds: input.ttlSeconds,
    ...(scheduled ? { hardEndAt: new Date(input.hardEndAt!).toISOString() } : {}),
    visibility: 'private',
    ...(input.workspaceDrive
      ? {
          workspaceDrive: z
            .object({ driveId: z.string().min(1).max(150), accessMode: z.literal('mount') })
            .strict()
            .parse(input.workspaceDrive),
        }
      : {}),
    ...(input.region ? { region: input.region } : {}),
    ...(input.providerKeyId ? { providerKeyId: input.providerKeyId } : {}),
    ...(input.maximumPriceMicrosPerSecond === undefined
      ? {}
      : { maximumPriceMicrosPerSecond: input.maximumPriceMicrosPerSecond }),
  };
}

async function readJson(response: Response): Promise<unknown> {
  const declared = Number(response.headers.get('content-length') ?? 0);
  if (declared > MAX_RESPONSE_BYTES) {
    await response.body?.cancel().catch(() => undefined);
    throw new WickApiError('Wick response exceeds the size limit');
  }
  const reader = response.body?.getReader();
  if (!reader) throw new WickApiError('Wick returned an empty response');
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      length += part.value.length;
      if (length > MAX_RESPONSE_BYTES)
        throw new WickApiError('Wick response exceeds the size limit');
      chunks.push(part.value);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } catch (error) {
    if (error instanceof WickApiError) throw error;
    throw new WickApiError('Wick returned an invalid JSON response');
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

function realAdapter(config: WickConfig): WickAdapter {
  if (!config.wickApiKey) throw new Error('WICK_API_KEY is required when WICK_MODE=real');
  const base = new URL(config.wickApiBase.replace(/\/$/, '') + '/');
  if (base.protocol !== 'https:' || base.username || base.password || base.search || base.hash)
    throw new Error('WICK_API_BASE must be a credential-free HTTPS URL');

  // The SDK owns request framing, idempotency, scoped terminal authentication and renewal.
  // This transport boundary adds response limits and validates every session, including renewals.
  const boundedFetch: typeof fetch = async (input, options) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.origin !== base.origin || !url.pathname.startsWith(base.pathname))
      throw new WickApiError('Wick request origin is outside the configured API');
    const headers = new Headers(options?.headers);
    headers.set('Accept', 'application/json');
    headers.set('x-wick-vocabulary', 'snapshots');
    const response = await fetch(url, { ...options, headers, redirect: 'error' });
    if (
      (response.url && new URL(response.url).origin !== base.origin) ||
      (response.status >= 300 && response.status < 400)
    ) {
      await response.body?.cancel();
      throw new WickApiError('Wick redirects are not allowed');
    }
    if (!response.ok) {
      await response.body?.cancel();
      // Do not let the SDK parse, retain or expose the service's arbitrary error body.
      return new Response(JSON.stringify({ error: { code: 'HTTP_REJECTED' } }), {
        status: response.status,
      });
    }
    if (response.status === 204) return response;
    const body = await readJson(response);
    const sessionMatch = url.pathname.match(/\/environments\/([^/]+)\/sessions$/);
    if (sessionMatch) {
      const session = parseSession(body, decodeURIComponent(sessionMatch[1]!));
      if (session.token === config.wickApiKey)
        throw new WickApiError('Wick session did not provide a scoped token');
    }
    return new Response(JSON.stringify(body), {
      status: response.status,
      headers: { 'Content-Type': 'application/json' },
    });
  };
  const sdk = new Wick({
    baseUrl: base.toString().replace(/\/$/, ''),
    token: config.wickApiKey,
    timeoutMs: 12_000,
    fetch: boundedFetch,
    statusRetry: false,
    webSocket: (endpoint) => {
      const url = new URL(endpoint);
      if (url.protocol !== 'wss:' || url.username || url.password || url.search || url.hash)
        throw new WickApiError('Wick terminal URL must use secure WebSocket transport');
      // There are deliberately no Authorization headers here. SDK sends only the scoped token.
      const socket = new WebSocket(url, {
        maxPayload: 256 * 1024,
        perMessageDeflate: false,
        followRedirects: false,
        handshakeTimeout: 12_000,
      });
      socket.on('error', () => undefined);
      socket.on('close', () => clearTimeout(forcedClose));
      let forcedClose: ReturnType<typeof setTimeout> | undefined;
      const originalClose = socket.close.bind(socket);
      socket.close = (...args) => {
        originalClose(...args);
        forcedClose ??= setTimeout(() => socket.terminate(), 2000);
        forcedClose.unref();
      };
      return socket as unknown as globalThis.WebSocket;
    },
  });
  async function invoke<T>(work: () => Promise<T>, admission = false): Promise<T> {
    try {
      return await work();
    } catch (error) {
      if (error instanceof WickApiError) throw error;
      if (error instanceof WickError)
        throw new WickApiError(
          `Wick API rejected the request (HTTP ${error.status})`,
          error.status,
          admission && [400, 422].includes(error.status),
        );
      throw new WickApiError(
        error instanceof WickTimeoutError
          ? 'Wick API deadline exceeded; outcome requires reconciliation'
          : 'Wick API could not be reached; outcome requires reconciliation',
      );
    }
  }
  function approvedBody(input: CreateEnvironmentInput) {
    const body = createBody(input);
    if (body.organizationId !== config.wickOrganizationId || body.groupId !== config.wickGroupId)
      throw new WickApiError('Wick create target is outside the configured scope', 400, true);
    if (body.providerKeyId) throw new WickApiError('BYOK pricing is unsupported', 400, true);
    if (!MANAGED_PROVIDERS.has(body.provider))
      throw new WickApiError(
        'Only E2B, Daytona, Modal, and Baseten (Blaxel) customer routes are supported',
        400,
        true,
      );
    if (body.maximumPriceMicrosPerSecond === undefined)
      throw new WickApiError('Real Wick creation requires a frozen maximum price', 400, true);
    return body;
  }
  return {
    mode: 'real',
    drives: realDrives(config),
    async runCommand(id, input) {
      if (input.command.length > 16000)
        throw new WickApiError('Coding command exceeds the request limit');
      const result = await invoke(() =>
        sdk.environments.runCommand({ path: { id }, body: input, timeoutMs: 110000 }),
      );
      if (
        typeof result.stdout !== 'string' ||
        typeof result.stderr !== 'string' ||
        !Number.isInteger(result.exitCode) ||
        result.simulated
      )
        throw new WickApiError('Wick returned an invalid command receipt');
      return {
        stdout: result.stdout.slice(0, 100000),
        stderr: result.stderr.slice(0, 2000),
        exitCode: result.exitCode,
      };
    },
    async catalog() {
      const raw = await invoke(() =>
        sdk.catalog.get({ query: { organizationId: config.wickOrganizationId } }),
      );
      // Bounded, read-only previews establish the selected route in this exact org/group.
      // Merely advertising BYOK support does not establish managed billing.
      const potential = new Set(
        raw.offers
          .filter((offer) => MANAGED_PROVIDERS.has(offer.provider))
          .map((offer) => `${offer.provider}:${offer.profile}:${offer.region}`),
      );
      const candidates = parseCatalog(raw, config, potential);
      if (candidates.length > MAX_MANAGED_ROUTES)
        throw new WickApiError('Too many managed routes for bounded verification');
      const verified: CatalogItem[] = [];
      for (let offset = 0; offset < candidates.length; offset += ROUTE_PREVIEW_CONCURRENCY) {
        const batch = await Promise.all(
          candidates.slice(offset, offset + ROUTE_PREVIEW_CONCURRENCY).map(async (item) => {
            const body = approvedBody({
              organizationId: config.wickOrganizationId,
              groupId: config.wickGroupId,
              name: 'wick-broker-route-preview',
              provider: item.provider,
              profile: item.profile,
              region: item.region,
              ttlSeconds: 900,
              visibility: 'private',
              maximumPriceMicrosPerSecond: item.rateMicrosPerSecond,
            });
            const preview = await invoke(() =>
              sdk.executionPreview.create({ body: { kind: 'environment', input: body } }),
            );
            return managedPreviewMatches(preview, body) ? item : undefined;
          }),
        );
        verified.push(...batch.filter((item): item is CatalogItem => item !== undefined));
      }
      return verified;
    },
    async preview(input) {
      const body = approvedBody(input);
      const route = await invoke(() =>
        sdk.executionPreview.create({ body: { kind: 'environment', input: body } }),
      );
      if (!managedPreviewMatches(route, body))
        throw new WickApiError('Wick managed billing route could not be confirmed', 400, true);
      return invoke(() => sdk.environments.preview({ body }), true);
    },
    async create(input, key) {
      const body = approvedBody(input);
      if (key.length < 8 || key.length > 200)
        throw new WickApiError('Invalid persisted idempotency key', 400, true);
      return parseCreateResult(
        await invoke(() => sdk.environments.create({ body, idempotencyKey: key }), true),
      );
    },
    async get(id) {
      const environment = parseEnvironment(
        await invoke(() => sdk.environments.get({ path: { id } })),
      );
      if (environment.id !== id)
        throw new WickApiError('Wick returned an environment outside the requested scope');
      return environment;
    },
    async list(input) {
      if (
        input.organizationId !== config.wickOrganizationId ||
        input.groupId !== config.wickGroupId ||
        input.limit !== 50 ||
        !input.newest ||
        !input.search ||
        input.search.length > 150 ||
        (input.cursor && input.cursor.length > 2048)
      )
        throw new WickApiError('Invalid bounded environment discovery scope');
      const page = object(
        await invoke(() =>
          sdk.environments.list({
            path: { id: input.organizationId },
            query: {
              groupId: input.groupId,
              search: input.search,
              provider: input.provider,
              limit: 50,
              newest: 'true',
              archived: input.archived ? 'true' : 'false',
              ...(input.cursor ? { cursor: input.cursor } : {}),
            },
          }),
        ),
        'environment page',
      );
      if (!Array.isArray(page.data) || page.data.length > 50)
        throw new WickApiError('Invalid bounded environment page');
      return {
        items: page.data.map(parseEnvironment),
        ...(page.nextCursor == null
          ? {}
          : { nextCursor: string(page.nextCursor, 'environment cursor') }),
      };
    },
    async connections(id) {
      return parseConnections(
        await invoke(() => sdk.environments.getConnections({ path: { id } })),
      );
    },
    async session(id) {
      return parseSession(await invoke(() => sdk.environments.createSession({ path: { id } })), id);
    },
    async terminal(id, options = {}): Promise<WickTerminal> {
      const terminal = await invoke(() =>
        sdk.environments.terminal(id, { ...options, timeoutMs: 12_000 }),
      );
      return {
        input: (data) => {
          // Wick limits each input frame to 16,384 characters, while Broker accepts 32 KiB
          // pastes. Keep sends synchronous and never split a UTF-16 surrogate pair.
          if (data.length === 0) terminal.input(data);
          for (let start = 0; start < data.length;) {
            let end = Math.min(start + 16_384, data.length);
            if (
              end < data.length &&
              data.charCodeAt(end - 1) >= 0xd800 &&
              data.charCodeAt(end - 1) <= 0xdbff &&
              data.charCodeAt(end) >= 0xdc00 &&
              data.charCodeAt(end) <= 0xdfff
            )
              end--;
            terminal.input(data.slice(start, end));
            start = end;
          }
        },
        resize: (cols, rows) => terminal.resize(cols, rows),
        ack: (bytes) => terminal.ack(bytes),
        close: () => terminal.close(),
        async *[Symbol.asyncIterator]() {
          try {
            for await (const event of terminal) {
              if (event.type === 'ready') {
                if (event.environmentId !== id)
                  throw new WickApiError('Wick terminal scope does not match environment');
                yield { type: 'ready' as const };
              } else if (event.type === 'output' || event.type === 'exit' || event.type === 'pong')
                yield event;
              else if (event.type !== 'renewed')
                throw new WickApiError('Unsupported Wick terminal event');
            }
          } catch {
            throw new WickApiError('Wick terminal connection failed');
          } finally {
            terminal.close();
          }
        },
      };
    },
    async terminate(id) {
      // Acceptance is not cleanup: callers poll get() for confirmed termination.
      const result = parseCreateResult(
        await invoke(() => sdk.environments.terminate({ path: { id } })),
      );
      if (result.environment.id !== id)
        throw new WickApiError(
          'Wick termination response does not match the requested environment',
        );
    },
  };
}

export function fixtureCatalog(
  config: Pick<WickConfig, 'wickOrganizationId' | 'wickGroupId'>,
): CatalogItem[] {
  const common = {
    provider: 'simulated-demo',
    region: 'us-east',
    durationMinutes: [15, 30, 60],
    maxTtlSeconds: 86400,
    deadlineEnforcement: 'native' as const,
    capabilities: ['interactive-terminal', 'persistent-drives'],
    approved: true,
    organizationId: config.wickOrganizationId,
    groupId: config.wickGroupId,
  };
  return [
    {
      ...common,
      id: 'dev-small',
      profile: 'small',
      name: 'Developer Small',
      description: 'Simulated demo supply · everyday development',
      cpu: 2,
      memoryGb: 4,
    },
    {
      ...common,
      id: 'dev-standard',
      profile: 'medium',
      name: 'Developer Standard',
      description: 'Simulated demo supply · extra room for your tools',
      cpu: 4,
      memoryGb: 8,
    },
    {
      ...common,
      id: 'gpu-starter',
      profile: 'large',
      name: 'GPU Starter',
      description: 'Simulated demo supply · GPU configuration, no real GPU allocated',
      cpu: 8,
      memoryGb: 16,
      gpu: 'Simulated GPU',
    },
  ];
}

type FixtureRow = {
  id: string;
  input_hash: string;
  status: WickEnvironment['status'];
  admitted_at: Date;
  expires_at: Date;
  input_json?: CreateEnvironmentInput;
};
function fixtureEnvironment(row: FixtureRow): WickEnvironment {
  return {
    id: row.id,
    status: row.status,
    expiresAt: row.expires_at.toISOString(),
    createdAt: row.admitted_at.toISOString(),
    ...(row.input_json?.workspaceDrive
      ? {
          workspaceDrive: {
            driveId: row.input_json.workspaceDrive.driveId,
            generation: `fixture-${row.id}`,
            status:
              row.status === 'terminated'
                ? 'detached'
                : row.status === 'running'
                  ? 'mounted'
                  : 'mounting',
            attachmentMode: 'shared' as const,
            accessMode: 'mount' as const,
            workspacePath: '/workspace',
          },
        }
      : {}),
    ...(row.input_json
      ? {
          name: row.input_json.name,
          organizationId: row.input_json.organizationId,
          groupId: row.input_json.groupId,
          provider: row.input_json.provider,
          profile: row.input_json.profile,
          ...(row.input_json.hardEndAt ? { hardEndAt: row.input_json.hardEndAt } : {}),
        }
      : {}),
  };
}
function fixtureAdapter(config: WickConfig, pool: Pool): WickAdapter {
  async function get(id: string): Promise<WickEnvironment> {
    const { rows } = await pool.query<FixtureRow>(
      `
      UPDATE broker_fixture_environments SET status = CASE
        WHEN status IN ('terminated','failed') THEN status
        WHEN expires_at <= clock_timestamp() THEN 'terminated'
        WHEN status = 'terminating' AND termination_requested_at + interval '500 milliseconds' <= clock_timestamp() THEN 'terminated'
        WHEN status = 'provisioning' AND ready_at <= clock_timestamp() THEN 'running'
        ELSE status END
      WHERE id = $1 RETURNING *`,
      [id],
    );
    if (!rows[0]) throw new WickApiError('Simulated environment not found', 404);
    return fixtureEnvironment(rows[0]);
  }
  return {
    mode: 'fixture',
    drives: fixtureDrives(config, pool),
    async list(input) {
      const rows = (
        await pool.query<FixtureRow>(
          `SELECT * FROM broker_fixture_environments WHERE input_json->>'organizationId'=$1
        AND input_json->>'groupId'=$2 AND input_json->>'provider'=$3 AND input_json->>'name'=$4
        ORDER BY admitted_at DESC LIMIT 50`,
          [input.organizationId, input.groupId, input.provider, input.search],
        )
      ).rows;
      return { items: rows.map(fixtureEnvironment) };
    },
    async catalog() {
      return fixtureCatalog(config);
    },
    async preview(input) {
      createBody(input);
      return {
        eligible: true,
        blockers: [],
        mode: 'fixture',
        label: 'Simulated admission; no VM or operational charge',
        requiredReservationMicros: 0,
        fallbackProviders: [],
      };
    },
    async create(input, key) {
      const body = createBody(input);
      const serialized = JSON.stringify(body);
      const hash = createHash('sha256').update(serialized).digest('hex');
      // clock_timestamp() is used once as the admission instant. Retries never update it or expires_at.
      const { rows } = await pool.query<FixtureRow>(
        `
        WITH admission AS (SELECT clock_timestamp() AS at)
        INSERT INTO broker_fixture_environments (id,create_key,input_hash,input_json,status,admitted_at,expires_at,ready_at)
        SELECT $1,$2,$3,$4::jsonb,'provisioning',at,LEAST(at + $5 * interval '1 second',COALESCE($6::timestamptz,'infinity'::timestamptz)),at + interval '1500 milliseconds' FROM admission
        ON CONFLICT(create_key) DO UPDATE SET create_key=EXCLUDED.create_key RETURNING *`,
        [`fixture_${randomUUID()}`, key, hash, serialized, body.ttlSeconds, body.hardEndAt ?? null],
      );
      const row = rows[0]!;
      if (row.input_hash !== hash)
        throw new WickApiError('Idempotency key was used with different environment input', 409);
      const environment = await get(row.id);
      return {
        environment,
        operation: {
          id: `fixture_op_${row.id}`,
          status: environment.status === 'provisioning' ? 'running' : 'succeeded',
        },
        raw: { mode: 'fixture' },
      };
    },
    get,
    async connections(id) {
      const environment = await get(id);
      return { terminal: environment.status === 'running' };
    },
    async session(id) {
      const environment = await get(id);
      if (environment.status !== 'running')
        throw new WickApiError('Simulated terminal is unavailable', 409);
      return {
        token: `fixture_${randomUUID()}`,
        terminalWebsocketUrl: `fixture://terminal/${encodeURIComponent(id)}`,
        expiresAt: new Date(
          Math.min(Date.now() + 240_000, Date.parse(environment.expiresAt!)),
        ).toISOString(),
      };
    },
    async terminal(id, options) {
      const environment = await get(id);
      if (environment.status !== 'running')
        throw new WickApiError('Simulated terminal is unavailable', 409);
      return fixtureTerminal(options);
    },
    async terminate(id) {
      const result = await pool.query(
        `UPDATE broker_fixture_environments SET status='terminating',termination_requested_at=COALESCE(termination_requested_at,clock_timestamp()) WHERE id=$1 AND status NOT IN ('terminated','failed')`,
        [id],
      );
      if (!result.rowCount) await get(id);
    },
  };
}

export function createWickAdapter(config: WickConfig, pool?: Pool): WickAdapter {
  if (config.wickMode === 'real') return realAdapter(config);
  if (config.wickMode !== 'fixture')
    throw new Error('Explicit WICK_MODE=fixture or real is required');
  if (!pool) throw new Error('The explicit Wick fixture adapter requires PostgreSQL persistence');
  return fixtureAdapter(config, pool);
}
