import { createHash } from 'node:crypto';
import type { FastifyRequest } from 'fastify';
import type { Pool } from 'pg';
import { describe, expect, it, vi } from 'vitest';
import { createRequireActor, type createAuth } from '../src/server/auth.js';

// A terminal's repeated lease checks revalidate auth without becoming HTTP requests.
it('does not charge HTTP rate budgets for internal terminal revalidation', async () => {
  let now = Date.now();
  const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
  const id = '44444444-4444-4444-8444-444444444444',
    secret = 's'.repeat(43),
    token = `wbk_${id}.${secret}`;
  const query = vi.fn(async () => ({
    rows: [
      {
        key_id: id,
        secret_digest: createHash('sha256').update(secret).digest('hex'),
        scopes: ['vms:terminal'],
        limits: {},
        issued_role: 'buyer',
        issued_provider_id: null,
        last_used_at: new Date(now),
        id: 'buyer',
        email: 'fixture@keys.invalid',
        name: 'Fixture',
        role: 'buyer',
        providerId: null,
        actual_provider_id: null,
        active: true,
      },
    ],
  }));
  const requireActor = createRequireActor(
    {} as ReturnType<typeof createAuth>,
    { query } as unknown as Pool,
  );
  const request = () =>
    ({
      headers: { authorization: `Bearer ${token}` },
      method: 'GET',
      routeOptions: { url: '/api/vms/:id/terminal' },
    }) as FastifyRequest;
  try {
    const sessions = Array.from({ length: 20 }, request);
    for (const r of sessions) await requireActor(r);
    for (let tick = 0; tick < 16; tick++) {
      now += 2000;
      for (const r of sessions) await requireActor(r);
    }
    expect(query).toHaveBeenCalledTimes(340);
    for (let i = 0; i < 280; i++) await requireActor(request());
    await expect(requireActor(request())).rejects.toMatchObject({ statusCode: 429 });
  } finally {
    clock.mockRestore();
  }
});
