import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerAgreements } from '../src/server/agreements/index.js';
import { HttpError, type AppContext } from '../src/server/context.js';

describe('authenticated scheduled Muse draft budgets (offline model)', () => {
  let app: FastifyInstance, now: number;
  const query = vi.fn(async (sql: string) => {
    if (!sql.startsWith('SELECT id,item,approved FROM broker_catalog'))
      throw new Error('Scheduled drafts must remain read-only.');
    return {
      rows: [
        { id: 'fixture-small', approved: true, item: { cpu: 1, memoryGb: 1, region: 'fixture' } },
      ],
    };
  });
  const draftSchedule = vi.fn(async () => ({
    draft: {},
    mode: 'real',
    modelCalled: true,
    explanation: 'Offline model response.',
  }));
  beforeEach(async () => {
    now = 1000000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    query.mockClear();
    draftSchedule.mockClear();
    app = Fastify();
    const ctx = {
      pool: { query },
      wick: { mode: 'fixture' },
      muse: { mode: 'real', draftSchedule },
      requireActor: async (request: { headers: Record<string, string> }, roles: string[]) => {
        const id = request.headers['x-test-actor'];
        if (!id) throw new HttpError(401, 'Sign in.');
        const role = request.headers['x-test-role'] ?? 'buyer';
        if (!roles.includes(role)) throw new HttpError(403, 'Role denied.');
        return { id, role };
      },
    } as unknown as AppContext;
    await registerAgreements(app, ctx);
    await app.ready();
  });
  afterEach(async () => {
    await app.close();
    vi.restoreAllMocks();
  });
  const send = (actor: string, role = 'buyer') =>
    app.inject({
      method: 'POST',
      url:
        role === 'provider' ? '/api/provider/scheduled-offerings/draft' : '/api/agreements/draft',
      headers: { 'x-test-actor': actor, 'x-test-role': role },
      payload: { prompt: 'Twenty slots from 00:00 to 06:00.' },
    });

  it('rejects the eleventh draft before any extra catalog read or model call', async () => {
    for (let i = 0; i < 10; i++) expect((await send('buyer-one')).statusCode).toBe(200);
    const rejected = await send('buyer-one');
    expect(rejected.statusCode).toBe(429);
    expect(rejected.json().message).toContain('manual controls');
    expect(query).toHaveBeenCalledTimes(10);
    expect(draftSchedule).toHaveBeenCalledTimes(10);
  });

  it('shares one actor budget between buyer and supplier draft endpoints', async () => {
    for (let i = 0; i < 6; i++) expect((await send('same-actor')).statusCode).toBe(200);
    for (let i = 0; i < 4; i++) expect((await send('same-actor', 'provider')).statusCode).toBe(200);
    expect((await send('same-actor', 'provider')).statusCode).toBe(429);
    expect((await send('same-actor')).statusCode).toBe(429);
    expect(draftSchedule).toHaveBeenCalledTimes(10);
  });

  it('keeps independent actor limits and expires the one-minute budget', async () => {
    for (let i = 0; i < 10; i++) await send('buyer-one');
    expect((await send('buyer-two')).statusCode).toBe(200);
    expect((await send('buyer-one')).statusCode).toBe(429);
    now += 60000;
    expect((await send('buyer-one')).statusCode).toBe(200);
    expect(draftSchedule).toHaveBeenCalledTimes(12);
  });

  it('authenticates before charging a budget or reading catalog data', async () => {
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/agreements/draft',
          payload: { prompt: 'Test' },
        })
      ).statusCode,
    ).toBe(401);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/provider/scheduled-offerings/draft',
          headers: { 'x-test-actor': 'buyer', 'x-test-role': 'buyer' },
          payload: { prompt: 'Test' },
        })
      ).statusCode,
    ).toBe(403);
    expect(query).not.toHaveBeenCalled();
    expect(draftSchedule).not.toHaveBeenCalled();
    for (let i = 0; i < 10; i++) expect((await send('buyer')).statusCode).toBe(200);
  });

  it('bounds the actor map at one thousand entries and evicts expired entries', async () => {
    for (let i = 0; i < 1000; i++) expect((await send(`actor-${i}`)).statusCode).toBe(200);
    expect((await send('new-actor')).statusCode).toBe(429);
    expect((await send('actor-0')).statusCode).toBe(200);
    now += 60000;
    expect((await send('new-actor')).statusCode).toBe(200);
    expect(draftSchedule).toHaveBeenCalledTimes(1002);
    expect(query).toHaveBeenCalledTimes(1002);
  });
});
