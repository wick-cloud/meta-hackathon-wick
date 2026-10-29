import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Pool } from 'pg';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import {
  createWickAdapter,
  fixtureCatalog,
  parseCatalog,
  parseEnvironment,
} from '../src/server/integrations/wick.js';
import {
  managedEnvironmentMatches,
  environmentOwnershipMatches,
} from '../src/server/integrations/discovery.js';
import type { CreateEnvironmentInput } from '../src/server/integrations/types.js';

const config = {
  wickMode: 'fixture' as const,
  wickApiBase: 'https://example.invalid/api',
  wickOrganizationId: 'scheduled-org',
  wickGroupId: 'scheduled-group',
};
const input: CreateEnvironmentInput = {
  organizationId: config.wickOrganizationId,
  groupId: config.wickGroupId,
  name: 'scheduled-owned-test',
  provider: 'simulated-demo',
  profile: 'small',
  ttlSeconds: 28800,
  visibility: 'private',
};
const deadline = () => new Date(Date.now() + 4 * 3600000).toISOString();
afterEach(() => vi.unstubAllGlobals());

describe('scheduled Wick adapter contract', () => {
  it('forwards the immutable cap through the pinned real SDK without sending workload inputs', async () => {
    const hardEndAt = deadline();
    const fetcher = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      expect(body.hardEndAt).toBe(hardEndAt);
      expect(body.ttlSeconds).toBe(28800);
      expect(body).not.toHaveProperty('repository');
      expect(body).not.toHaveProperty('agent');
      expect(body).not.toHaveProperty('apiKey');
      return new Response(
        JSON.stringify({
          environment: {
            ...body,
            id: 'test-native',
            status: 'provisioning',
            createdAt: new Date().toISOString(),
            expiresAt: hardEndAt,
            billingMode: 'wick_managed',
          },
          operation: { id: 'test-operation', status: 'running' },
        }),
        { status: 202 },
      );
    });
    vi.stubGlobal('fetch', fetcher);
    const wick = createWickAdapter({ ...config, wickMode: 'real', wickApiKey: 'fake-test-key' });
    const result = await wick.create(
      { ...input, provider: 'e2b', maximumPriceMicrosPerSecond: 23, hardEndAt },
      'scheduled-test-idempotency',
    );
    expect(result.environment.hardEndAt).toBe(hardEndAt);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('retains finite ordinary rentals while allowing bounded longer leases only with a hard end', async () => {
    const wick = createWickAdapter(config, {} as Pool);
    await expect(wick.preview(input)).rejects.toThrow('15, 30, or 60');
    await expect(wick.preview({ ...input, hardEndAt: deadline() })).resolves.toMatchObject({
      eligible: true,
      mode: 'fixture',
    });
    await expect(
      wick.preview({ ...input, ttlSeconds: 86401, hardEndAt: deadline() }),
    ).rejects.toThrow();
    await expect(
      wick.preview({ ...input, ttlSeconds: 59, hardEndAt: deadline() }),
    ).rejects.toThrow();
  });
  it('rejects elapsed, malformed or too-close hard cutoffs before any admission', async () => {
    const wick = createWickAdapter(config, {} as Pool);
    for (const hardEndAt of [
      'tomorrow',
      new Date(Date.now() - 1000).toISOString(),
      new Date(Date.now() + 30000).toISOString(),
    ])
      await expect(wick.preview({ ...input, hardEndAt })).rejects.toThrow('cutoff');
  });
  it('never infers native deadline enforcement from a relative max TTL', () => {
    const offer = {
      provider: 'e2b',
      byok: { enabled: false },
      profile: 'small',
      region: 'us',
      maxTtlSeconds: 86400,
      available: true,
      rateMicrosPerSecond: 23,
    };
    const source = (extra: object) => ({
      profiles: [{ id: 'small', name: 'Small', cpu: 2, memoryMiB: 4096 }],
      offers: [{ ...offer, ...extra }],
    });
    const legacy = parseCatalog(source({}), config)[0];
    expect(legacy.maxTtlSeconds).toBe(86400);
    expect(legacy.deadlineEnforcement).toBeUndefined();
    expect(
      parseCatalog(source({ deadlineEnforcement: 'supervised' }), config)[0].deadlineEnforcement,
    ).toBe('supervised');
    expect(
      parseCatalog(source({ deadlineEnforcement: 'native' }), config)[0].deadlineEnforcement,
    ).toBe('native');
    expect(fixtureCatalog(config).every((item) => item.deadlineEnforcement === 'native')).toBe(
      true,
    );
  });
  it('requires the exact cap receipt for managed readiness but preserves ownership for quarantine cleanup', () => {
    const hardEndAt = deadline(),
      create = { ...input, hardEndAt };
    const observed = {
      id: 'owned-vm',
      status: 'running',
      createdAt: new Date().toISOString(),
      expiresAt: hardEndAt,
      hardEndAt,
      organizationId: input.organizationId,
      groupId: input.groupId,
      name: input.name,
      provider: input.provider,
      profile: input.profile,
      billingMode: 'wick_managed',
    };
    const environment = parseEnvironment(observed);
    expect(managedEnvironmentMatches(environment, create)).toBe(true);
    for (const unexpected of [
      { ...environment, hardEndAt: undefined },
      { ...environment, expiresAt: new Date(Date.parse(hardEndAt) + 60000).toISOString() },
    ]) {
      expect(managedEnvironmentMatches(unexpected, create)).toBe(false);
      expect(environmentOwnershipMatches(unexpected, create, new Date(Date.now() - 1000))).toBe(
        true,
      );
    }
  });
});

const databaseUrl = process.env.TEST_DATABASE_URL;
describe.skipIf(!databaseUrl)('scheduled fixture expiry and recovery (PostgreSQL)', () => {
  const pool = new Pool({ connectionString: databaseUrl });
  const keys: string[] = [];
  afterAll(async () => {
    if (keys.length)
      await pool.query('DELETE FROM broker_fixture_environments WHERE create_key=ANY($1::text[])', [
        keys,
      ]);
    await pool.end();
  });
  it('clamps the native fixture lifetime to the original absolute cap across retries', async () => {
    await pool.query(
      await readFile(new URL('../migrations/003_fixture.sql', import.meta.url), 'utf8'),
    );
    const wick = createWickAdapter(config, pool),
      hardEndAt = deadline(),
      key = `scheduled-${randomUUID()}`;
    keys.push(key);
    const created = await wick.create({ ...input, hardEndAt }, key);
    expect(created.environment.expiresAt).toBe(hardEndAt);
    expect(created.environment.hardEndAt).toBe(hardEndAt);
    const recovered = await createWickAdapter(config, pool).create({ ...input, hardEndAt }, key);
    expect(recovered.environment.id).toBe(created.environment.id);
    expect(recovered.environment.expiresAt).toBe(hardEndAt);
    await expect(
      wick.create(
        { ...input, hardEndAt: new Date(Date.parse(hardEndAt) + 3600000).toISOString() },
        key,
      ),
    ).rejects.toThrow('different');
  });
});
