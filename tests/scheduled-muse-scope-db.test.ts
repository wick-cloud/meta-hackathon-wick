import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import { Pool } from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerAgreements } from '../src/server/agreements/index.js';
import type { AppContext } from '../src/server/context.js';
import { migrate } from '../src/server/db.js';
import type { MuseAdapter } from '../src/server/integrations/types.js';
import type { Mode } from '../src/shared/types.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
const schema = `scheduled_draft_scope_${randomUUID().replaceAll('-', '')}`;
const actorId = 'scheduled-draft-provider';

describe.skipIf(!databaseUrl)('scheduled draft provider scope (isolated PostgreSQL)', () => {
  let admin: Pool, pool: Pool, app: FastifyInstance;
  const draftSchedule = vi.fn<NonNullable<MuseAdapter['draftSchedule']>>(async (input) => ({
    draft: { catalogId: input.catalog[0]?.id },
    mode: 'real',
    modelCalled: true,
    explanation: 'Offline model fixture.',
  }));
  beforeAll(async () => {
    admin = new Pool({ connectionString: databaseUrl });
    await admin.query(`CREATE SCHEMA ${schema}`);
    pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema},public` });
    await migrate(pool);
  });
  beforeEach(async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => {
        throw new Error('External calls are forbidden.');
      }),
    );
    draftSchedule.mockClear();
    await pool.query('TRUNCATE broker_providers,broker_catalog CASCADE');
    // More foreign configurations than the draft limit sort before the owned route.
    await pool.query(`INSERT INTO broker_catalog(id,item,approved,source_mode)
      SELECT 'a_foreign_'||lpad(i::text,3,'0'),
        jsonb_build_object('provider','daytona','cpu',2,'memoryGb',4,'region','foreign'),
        true,'fixture' FROM generate_series(1,70) AS i`);
    for (const [id, mode, approved] of [
      ['z_own_allowed', 'fixture', true],
      ['z_own_disallowed', 'fixture', true],
      ['z_unapproved', 'fixture', false],
      ['z_other_mode', 'real', true],
    ] as const)
      await pool.query(
        `INSERT INTO broker_catalog(id,item,approved,source_mode) VALUES($1,$2,$3,$4)`,
        [id, { provider: 'e2b', cpu: 2, memoryGb: 4, region: 'owned' }, approved, mode],
      );
    await pool.query(
      `INSERT INTO broker_providers(user_id,name,total_capacity,policy,cloud_provider)
       VALUES($1,'Scoped provider',20,$2,'e2b')`,
      [
        actorId,
        { allowedCatalogIds: ['a_foreign_001', 'z_own_allowed', 'z_unapproved', 'z_other_mode'] },
      ],
    );
  });
  afterEach(async () => {
    await app?.close();
    expect(fetch).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
  afterAll(async () => {
    await pool?.end();
    if (admin) {
      await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await admin.end();
    }
  });
  async function send(mode: Mode, provider = true) {
    app = Fastify();
    app.setErrorHandler((error: Error & { statusCode?: number }, _request, reply) =>
      reply.code(error.statusCode ?? 500).send({ error: error.message }),
    );
    await registerAgreements(app, {
      pool,
      wick: { mode: 'fixture' },
      muse: { mode, draftSchedule },
      requireActor: async () => ({ id: actorId, role: provider ? 'provider' : 'buyer' }),
    } as unknown as AppContext);
    return app.inject({
      method: 'POST',
      url: provider ? '/api/provider/scheduled-offerings/draft' : '/api/agreements/draft',
      payload: { prompt: '2 slots from 01:00 to 05:00' },
    });
  }

  it.each(['fixture', 'real'] as const)(
    'uses only the owned, policy-allowed route before limiting the %s draft catalog',
    async (mode) => {
      const response = await send(mode);
      expect(response.statusCode, response.body).toBe(200);
      expect(response.json().draft.catalogId).toBe('z_own_allowed');
      if (mode === 'real') {
        expect(draftSchedule).toHaveBeenCalledOnce();
        expect(draftSchedule.mock.calls[0][0].catalog.map((item) => item.id)).toEqual([
          'z_own_allowed',
        ]);
      } else expect(draftSchedule).not.toHaveBeenCalled();
    },
  );
  it('allows all approved owned routes when the policy has no catalog restriction', async () => {
    await pool.query('UPDATE broker_providers SET policy=$1 WHERE user_id=$2', [{}, actorId]);
    const response = await send('real');
    expect(response.statusCode, response.body).toBe(200);
    expect(draftSchedule.mock.calls[0][0].catalog.map((item) => item.id)).toEqual([
      'z_own_allowed',
      'z_own_disallowed',
    ]);
  });
  it.each(['fixture', 'real'] as const)(
    'rejects an empty provider allowlist before any %s draft is generated',
    async (mode) => {
      await pool.query('UPDATE broker_providers SET policy=$1 WHERE user_id=$2', [
        { allowedCatalogIds: [] },
        actorId,
      ]);
      const response = await send(mode);
      expect(response.statusCode, response.body).toBe(409);
      expect(response.json().error).toContain('provider account and policy');
      expect(draftSchedule).not.toHaveBeenCalled();
    },
  );
  it('preserves legacy unbound provider accounts while applying their explicit policy', async () => {
    await pool.query('UPDATE broker_providers SET cloud_provider=NULL WHERE user_id=$1', [actorId]);
    const response = await send('real');
    expect(response.statusCode, response.body).toBe(200);
    expect(draftSchedule.mock.calls[0][0].catalog.map((item) => item.id)).toEqual([
      'a_foreign_001',
      'z_own_allowed',
    ]);
  });
  it('requires a configured provider account before generating a provider draft', async () => {
    await pool.query('DELETE FROM broker_providers WHERE user_id=$1', [actorId]);
    const response = await send('real');
    expect(response.statusCode, response.body).toBe(403);
    expect(draftSchedule).not.toHaveBeenCalled();
  });
  it('keeps buyer drafts independent of provider identity and bounded at 64 entries', async () => {
    await pool.query('DELETE FROM broker_providers WHERE user_id=$1', [actorId]);
    const response = await send('real', false);
    expect(response.statusCode, response.body).toBe(200);
    const catalog = draftSchedule.mock.calls[0][0].catalog;
    expect(catalog).toHaveLength(64);
    expect(catalog.every((item) => item.provider === 'daytona')).toBe(true);
  });
});
