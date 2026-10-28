import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createWickAdapter } from '../src/server/integrations/wick.js';
import type { CreateEnvironmentInput } from '../src/server/integrations/types.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
const config = {
  wickMode: 'fixture' as const,
  wickApiBase: 'https://example.invalid/api',
  wickOrganizationId: 'fixture-org',
  wickGroupId: 'fixture-group',
};
const input: CreateEnvironmentInput = {
  organizationId: 'fixture-org',
  groupId: 'fixture-group',
  provider: 'simulated-demo',
  profile: 'small',
  name: 'fixture concurrency',
  ttlSeconds: 900,
  visibility: 'private',
};

describe.skipIf(!databaseUrl)('durable simulated Wick lifecycle (PostgreSQL)', () => {
  const pool = new Pool({ connectionString: databaseUrl, max: 12 });
  const keys: string[] = [];
  beforeAll(async () => {
    await pool.query(
      await readFile(new URL('../migrations/003_fixture.sql', import.meta.url), 'utf8'),
    );
  });
  afterAll(async () => {
    if (keys.length)
      await pool.query('DELETE FROM broker_fixture_environments WHERE create_key=ANY($1::text[])', [
        keys,
      ]);
    await pool.end();
  });
  const key = () => {
    const value = `fixture-test-${randomUUID()}`;
    keys.push(value);
    return value;
  };
  it('concurrent retries allocate one environment and preserve the original admission expiry across adapter recovery', async () => {
    const adapter = createWickAdapter(config, pool);
    const createKey = key();
    const created = await Promise.all(
      Array.from({ length: 12 }, () => adapter.create(input, createKey)),
    );
    expect(new Set(created.map((result) => result.environment.id)).size).toBe(1);
    expect(new Set(created.map((result) => result.environment.expiresAt)).size).toBe(1);
    const environment = created[0]!.environment;
    expect(Date.parse(environment.expiresAt!) - Date.parse(environment.createdAt!)).toBe(900_000);
    const recoveredAdapter = createWickAdapter(config, pool);
    const recovered = await recoveredAdapter.create(input, createKey);
    expect(recovered.environment.expiresAt).toBe(environment.expiresAt);
    expect(recovered.environment.id).toBe(environment.id);
    expect(
      (
        await pool.query(
          'SELECT count(*)::int AS count FROM broker_fixture_environments WHERE create_key=$1',
          [createKey],
        )
      ).rows[0].count,
    ).toBe(1);
  });
  it('rejects changed create parameters for a reused key', async () => {
    const adapter = createWickAdapter(config, pool);
    const createKey = key();
    await adapter.create(input, createKey);
    await expect(adapter.create({ ...input, ttlSeconds: 1800 }, createKey)).rejects.toThrow(
      'different',
    );
  });
  it('keeps termination acceptance distinct from confirmed cleanup', async () => {
    const adapter = createWickAdapter(config, pool);
    const { environment } = await adapter.create(input, key());
    await adapter.terminate(environment.id);
    expect((await adapter.get(environment.id)).status).toBe('terminating');
    await pool.query(
      "UPDATE broker_fixture_environments SET termination_requested_at=clock_timestamp()-interval '1 second' WHERE id=$1",
      [environment.id],
    );
    expect((await adapter.get(environment.id)).status).toBe('terminated');
  });
  it('does not report ready or terminal capability for an environment that expires before setup completes', async () => {
    const adapter = createWickAdapter(config, pool);
    const { environment } = await adapter.create(input, key());
    await pool.query(
      "UPDATE broker_fixture_environments SET expires_at=clock_timestamp()-interval '1 second',ready_at=clock_timestamp()+interval '1 second' WHERE id=$1",
      [environment.id],
    );
    expect((await adapter.get(environment.id)).status).toBe('terminated');
    expect(await adapter.connections(environment.id)).toEqual({ terminal: false });
    await expect(adapter.session(environment.id)).rejects.toThrow('unavailable');
  });
});
