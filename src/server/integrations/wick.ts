import { createHash, randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import type { CatalogItem } from '../../shared/types.js';
import type { CreateEnvironmentInput, WickAdapter, WickConnections, WickCreateResult, WickEnvironment, WickSession } from './types.js';

export interface WickConfig {
  wickMode: 'fixture' | 'real';
  wickApiBase: string;
  wickApiKey?: string;
  wickOrganizationId: string;
  wickGroupId: string;
}

/** Sanitized failure: response bodies and service credentials never become API errors. */
export class WickApiError extends Error {
  constructor(message: string, public statusCode?: number, public admissionRejected = false) {
    super(message);
    this.name = 'WickApiError';
  }
}

const MAX_RESPONSE_BYTES = 1024 * 1024;
const RENTAL_SECONDS = [900, 1800, 3600];
type JsonObject = Record<string, unknown>;
function object(value: unknown, field: string): JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new WickApiError(`Wick response has invalid ${field}`);
  return value as JsonObject;
}
function string(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.length || value.length > 8192) throw new WickApiError(`Wick response has invalid ${field}`);
  return value;
}
function timestamp(value: unknown, field: string): string {
  const result = string(value, field);
  if (!Number.isFinite(Date.parse(result))) throw new WickApiError(`Wick response has invalid ${field}`);
  return new Date(result).toISOString();
}
function finitePositive(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) throw new WickApiError(`Wick response has invalid ${field}`);
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
    ...(raw.createdAt == null ? {} : { createdAt: timestamp(raw.createdAt, 'environment.createdAt') }),
    raw,
  };
}
export function parseCreateResult(value: unknown): WickCreateResult {
  const raw = object(value, 'create response');
  const operation = object(raw.operation, 'operation');
  return {
    environment: parseEnvironment(raw.environment),
    operation: { id: string(operation.id, 'operation.id'), status: string(operation.status, 'operation.status') },
    raw,
  };
}
export function parseConnections(value: unknown): WickConnections {
  const raw = object(value, 'connections');
  if (typeof raw.terminal !== 'boolean') throw new WickApiError('Wick response has invalid terminal capability');
  return { terminal: raw.terminal };
}
export function parseSession(value: unknown, environmentId: string): WickSession {
  const raw = object(value, 'session response');
  const session = object(raw.session, 'session');
  if (session.environmentId !== environmentId) throw new WickApiError('Wick session scope does not match environment');
  const token = string(raw.token, 'session token');
  const terminalWebsocketUrl = string(raw.terminalWebsocketUrl, 'terminalWebsocketUrl');
  const url = new URL(terminalWebsocketUrl);
  if (url.protocol !== 'wss:' || url.username || url.password) throw new WickApiError('Wick terminal URL must use secure WebSocket transport');
  const expiresAt = timestamp(session.expiresAt, 'session.expiresAt');
  if (Date.parse(expiresAt) <= Date.now() + 5000) throw new WickApiError('Wick terminal session is already expiring');
  return { token, terminalWebsocketUrl, expiresAt };
}

/** Public offer TTL bounds and create's finite ttlSeconds allow these exact durations. */
export function parseCatalog(value: unknown, config: Pick<WickConfig, 'wickOrganizationId' | 'wickGroupId'>): CatalogItem[] {
  const raw = object(value, 'catalog');
  if (!Array.isArray(raw.profiles) || !Array.isArray(raw.offers)) throw new WickApiError('Wick catalog must contain profiles and offers');
  const profiles = new Map(raw.profiles.map(value => {
    const profile = object(value, 'profile');
    return [string(profile.id, 'profile.id'), profile];
  }));
  const result: CatalogItem[] = [];
  for (const value of raw.offers) {
    const offer = object(value, 'offer');
    if (offer.available !== true) continue;
    const profileId = string(offer.profile, 'offer.profile');
    const profile = profiles.get(profileId);
    if (!profile) throw new WickApiError('Wick offer refers to an unknown resource profile');
    const provider = string(offer.provider, 'offer.provider');
    const region = string(offer.region, 'offer.region');
    const maximum = finitePositive(offer.maxTtlSeconds, 'offer.maxTtlSeconds');
    const durationMinutes = RENTAL_SECONDS.filter(seconds => seconds <= maximum).map(seconds => seconds / 60);
    if (!durationMinutes.length) continue;
    const resources = offer.resources == null ? profile : object(offer.resources, 'offer.resources');
    // Connection capability is checked again before charging; catalog capabilities are not a readiness assertion.
    result.push({
      id: `${provider}:${profileId}:${region}`,
      name: `${string(profile.name, 'profile.name')} · ${provider}`,
      description: typeof profile.description === 'string' ? profile.description : 'Published Wick configuration',
      provider, profile: profileId, region,
      cpu: finitePositive(resources.cpu, 'resources.cpu'),
      memoryGb: finitePositive(resources.memoryMiB, 'resources.memoryMiB') / 1024,
      durationMinutes, approved: false,
      organizationId: config.wickOrganizationId, groupId: config.wickGroupId,
    });
  }
  return result;
}

function createBody(input: CreateEnvironmentInput): CreateEnvironmentInput {
  if (!RENTAL_SECONDS.includes(input.ttlSeconds) || input.visibility !== 'private') {
    throw new WickApiError('Only private, finite 15, 30, or 60 minute rentals are supported', 400, true);
  }
  for (const field of ['organizationId', 'groupId', 'name', 'provider', 'profile'] as const) {
    if (typeof input[field] !== 'string' || !input[field].length || input[field].length > 150) {
      throw new WickApiError(`Invalid Wick create ${field}`, 400, true);
    }
  }
  // Deliberately enumerate fields: no repository, agent, setup, task, secret or arbitrary execution input.
  return {
    organizationId: input.organizationId, groupId: input.groupId, name: input.name,
    provider: input.provider, profile: input.profile, ttlSeconds: input.ttlSeconds, visibility: 'private',
    ...(input.region ? { region: input.region } : {}),
    ...(input.providerKeyId ? { providerKeyId: input.providerKeyId } : {}),
  };
}

async function readJson(response: Response): Promise<unknown> {
  const declared = Number(response.headers.get('content-length') ?? 0);
  if (declared > MAX_RESPONSE_BYTES) throw new WickApiError('Wick response exceeds the size limit');
  const reader = response.body?.getReader();
  if (!reader) throw new WickApiError('Wick returned an empty response');
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      length += part.value.length;
      if (length > MAX_RESPONSE_BYTES) throw new WickApiError('Wick response exceeds the size limit');
      chunks.push(part.value);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } catch (error) {
    if (error instanceof WickApiError) throw error;
    throw new WickApiError('Wick returned an invalid JSON response');
  } finally { await reader.cancel().catch(() => undefined); }
}

function realAdapter(config: WickConfig): WickAdapter {
  if (!config.wickApiKey) throw new Error('WICK_API_KEY is required when WICK_MODE=real');
  const base = new URL(config.wickApiBase.replace(/\/$/, '') + '/');
  if (base.protocol !== 'https:' || base.username || base.password) throw new Error('WICK_API_BASE must be a credential-free HTTPS URL');
  const request = async (path: string, options: { method?: string; body?: unknown; key?: string } = {}): Promise<unknown> => {
    const controller = new AbortController();
    const deadline = setTimeout(() => controller.abort(), 12_000);
    try {
      const response = await fetch(new URL(path.replace(/^\//, ''), base), {
        method: options.method ?? 'GET', redirect: 'error', signal: controller.signal,
        headers: {
          Authorization: `Bearer ${config.wickApiKey}`, Accept: 'application/json', 'x-wick-vocabulary': 'snapshots',
          ...(options.body === undefined ? {} : { 'Content-Type': 'application/json' }),
          ...(options.key ? { 'Idempotency-Key': options.key } : {}),
        },
        ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
      });
      if (!response.ok) {
        await response.body?.cancel();
        const rejected = path === '/v1/environments' && [400, 422].includes(response.status);
        throw new WickApiError(`Wick API rejected the request (HTTP ${response.status})`, response.status, rejected);
      }
      return await readJson(response);
    } catch (error) {
      if (error instanceof WickApiError) throw error;
      throw new WickApiError(controller.signal.aborted ? 'Wick API deadline exceeded; outcome requires reconciliation' : 'Wick API could not be reached; outcome requires reconciliation');
    } finally { clearTimeout(deadline); }
  };
  const envPath = (id: string) => `/v1/environments/${encodeURIComponent(id)}`;
  return {
    mode: 'real',
    async catalog() {
      const catalog = object(await request(`/v1/catalog?organizationId=${encodeURIComponent(config.wickOrganizationId)}`), 'catalog');
      // Organization provider metadata identifies pinned BYOK connections. Read only public metadata;
      // no provider diagnostics or connection/account mutation is performed.
      const result: CatalogItem[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < 5; page++) {
        const suffix = cursor ? `&cursor=${encodeURIComponent(cursor)}` : '';
        const response = object(await request(`/v1/organizations/${encodeURIComponent(config.wickOrganizationId)}/providers?limit=200${suffix}`), 'providers');
        if (!Array.isArray(response.data)) throw new WickApiError('Wick providers response must contain data');
        for (const value of response.data) {
          const provider = object(value, 'provider');
          if (provider.available !== true || provider.revokedAt != null) continue;
          if (!Array.isArray(provider.offers)) throw new WickApiError('Wick provider has no offer list');
          const items = parseCatalog({ profiles: catalog.profiles, offers: provider.offers }, config);
          const providerKeyId = provider.providerKeyId == null ? undefined : string(provider.providerKeyId, 'provider.providerKeyId');
          for (const item of items) {
            if (provider.scope === 'organization' && !providerKeyId) continue; // No provable exact connection pin.
            result.push(providerKeyId ? { ...item, id: `${providerKeyId}:${item.profile}:${item.region}`, providerKeyId } : item);
          }
        }
        if (response.nextCursor == null) return [...new Map(result.map(item => [item.id, item])).values()];
        cursor = string(response.nextCursor, 'providers.nextCursor');
      }
      throw new WickApiError('Wick provider catalog exceeded the bounded pagination limit');
    },
    async preview(input) { return request('/v1/environments/preview', { method: 'POST', body: createBody(input) }); },
    async create(input, key) {
      if (key.length < 8 || key.length > 200) throw new WickApiError('Invalid persisted idempotency key', 400, true);
      return parseCreateResult(await request('/v1/environments', { method: 'POST', body: createBody(input), key }));
    },
    async get(id) {
      const environment = parseEnvironment(await request(envPath(id)));
      if (environment.id !== id) throw new WickApiError('Wick returned an environment outside the requested scope');
      return environment;
    },
    async connections(id) { return parseConnections(await request(`${envPath(id)}/connections`)); },
    async session(id) { return parseSession(await request(`${envPath(id)}/sessions`, { method: 'POST' }), id); },
    async terminate(id) {
      // Acceptance is not cleanup. Callers must poll get() until a confirmed terminal lifecycle state.
      const result = parseCreateResult(await request(`${envPath(id)}/terminate`, { method: 'POST' }));
      if (result.environment.id !== id) throw new WickApiError('Wick termination response does not match the requested environment');
    },
  };
}

export function fixtureCatalog(config: Pick<WickConfig, 'wickOrganizationId' | 'wickGroupId'>): CatalogItem[] {
  const common = { provider: 'simulated-demo', region: 'us-east', durationMinutes: [15, 30, 60], approved: true, organizationId: config.wickOrganizationId, groupId: config.wickGroupId };
  return [
    { ...common, id: 'dev-small', profile: 'small', name: 'Developer Small', description: 'Simulated demo supply · everyday development', cpu: 2, memoryGb: 4 },
    { ...common, id: 'dev-standard', profile: 'medium', name: 'Developer Standard', description: 'Simulated demo supply · extra room for your tools', cpu: 4, memoryGb: 8 },
    { ...common, id: 'gpu-starter', profile: 'large', name: 'GPU Starter', description: 'Simulated demo supply · GPU configuration, no real GPU allocated', cpu: 8, memoryGb: 16, gpu: 'Simulated GPU' },
  ];
}

type FixtureRow = { id: string; input_hash: string; status: WickEnvironment['status']; admitted_at: Date; expires_at: Date };
function fixtureEnvironment(row: FixtureRow): WickEnvironment {
  return { id: row.id, status: row.status, expiresAt: row.expires_at.toISOString(), createdAt: row.admitted_at.toISOString() };
}
function fixtureAdapter(config: WickConfig, pool: Pool): WickAdapter {
  async function get(id: string): Promise<WickEnvironment> {
    const { rows } = await pool.query<FixtureRow>(`
      UPDATE broker_fixture_environments SET status = CASE
        WHEN status IN ('terminated','failed') THEN status
        WHEN expires_at <= clock_timestamp() THEN 'terminated'
        WHEN status = 'terminating' AND termination_requested_at + interval '500 milliseconds' <= clock_timestamp() THEN 'terminated'
        WHEN status = 'provisioning' AND ready_at <= clock_timestamp() THEN 'running'
        ELSE status END
      WHERE id = $1 RETURNING *`, [id]);
    if (!rows[0]) throw new WickApiError('Simulated environment not found', 404);
    return fixtureEnvironment(rows[0]);
  }
  return {
    mode: 'fixture',
    async catalog() { return fixtureCatalog(config); },
    async preview(input) { createBody(input); return { eligible: true, blockers: [], mode: 'fixture', label: 'Simulated admission; no VM or operational charge', requiredReservationMicros: 0, fallbackProviders: [] }; },
    async create(input, key) {
      const body = createBody(input);
      const serialized = JSON.stringify(body);
      const hash = createHash('sha256').update(serialized).digest('hex');
      // clock_timestamp() is used once as the admission instant. Retries never update it or expires_at.
      const { rows } = await pool.query<FixtureRow>(`
        WITH admission AS (SELECT clock_timestamp() AS at)
        INSERT INTO broker_fixture_environments (id,create_key,input_hash,input_json,status,admitted_at,expires_at,ready_at)
        SELECT $1,$2,$3,$4::jsonb,'provisioning',at,at + $5 * interval '1 second',at + interval '1500 milliseconds' FROM admission
        ON CONFLICT(create_key) DO UPDATE SET create_key=EXCLUDED.create_key RETURNING *`,
      [`fixture_${randomUUID()}`, key, hash, serialized, body.ttlSeconds]);
      const row = rows[0]!;
      if (row.input_hash !== hash) throw new WickApiError('Idempotency key was used with different environment input', 409);
      const environment = await get(row.id);
      return { environment, operation: { id: `fixture_op_${row.id}`, status: environment.status === 'provisioning' ? 'running' : 'succeeded' }, raw: { mode: 'fixture' } };
    },
    get,
    async connections(id) { const environment = await get(id); return { terminal: environment.status === 'running' }; },
    async session(id) {
      const environment = await get(id);
      if (environment.status !== 'running') throw new WickApiError('Simulated terminal is unavailable', 409);
      return { token: `fixture_${randomUUID()}`, terminalWebsocketUrl: `fixture://terminal/${encodeURIComponent(id)}`, expiresAt: new Date(Math.min(Date.now() + 240_000, Date.parse(environment.expiresAt!))).toISOString() };
    },
    async terminate(id) {
      const result = await pool.query(`UPDATE broker_fixture_environments SET status='terminating',termination_requested_at=COALESCE(termination_requested_at,clock_timestamp()) WHERE id=$1 AND status NOT IN ('terminated','failed')`, [id]);
      if (!result.rowCount) await get(id);
    },
  };
}

export function createWickAdapter(config: WickConfig, pool?: Pool): WickAdapter {
  if (config.wickMode === 'real') return realAdapter(config);
  if (config.wickMode !== 'fixture') throw new Error('Explicit WICK_MODE=fixture or real is required');
  if (!pool) throw new Error('The explicit Wick fixture adapter requires PostgreSQL persistence');
  return fixtureAdapter(config, pool);
}
