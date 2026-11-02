import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerAgreements, startAgreementWorkers } from '../src/server/agreements/index.js';
import { HttpError, type AppContext } from '../src/server/context.js';
import { createMuseAdapter } from '../src/server/integrations/muse.js';
import type { Role } from '../src/shared/types.js';

const removed = [
  ['POST', '/api/agreements', 'buyer'],
  ['POST', '/api/agreements/preview', 'buyer'],
  ['POST', '/api/agreements/draft', 'buyer'],
  ['POST', '/api/provider/scheduled-offerings', 'provider'],
  ['PATCH', '/api/provider/scheduled-offerings/00000000-0000-4000-8000-000000000001', 'provider'],
  ['POST', '/api/provider/scheduled-offerings/draft', 'provider'],
] as const;

describe('retired scheduled VM entry points', () => {
  let app: FastifyInstance, ctx: AppContext;
  const query = vi.fn(async () => {
    throw new Error('A retired route must not query or mutate data.');
  });
  const nativeCreate = vi.fn(),
    modelCall = vi.fn(),
    send = vi.fn();
  beforeEach(async () => {
    vi.clearAllMocks();
    app = Fastify();
    app.setErrorHandler((error, _request, reply) =>
      reply
        .status(error instanceof HttpError ? error.statusCode : 500)
        .send({ error: error instanceof Error ? error.message : 'Request failed' }),
    );
    ctx = {
      pool: { query },
      wick: { mode: 'real', create: nativeCreate },
      muse: { mode: 'real', translate: modelCall },
      boss: { send },
      requireActor: async (request: FastifyRequest, roles?: Role[]) => {
        const role = request.headers['x-role'] as Role | undefined;
        if (!role) throw new HttpError(401, 'Sign in.');
        if (!roles?.includes(role)) throw new HttpError(403, 'Role denied.');
        return { id: 'actor', role, name: 'Actor', email: 'actor@example.invalid' };
      },
    } as unknown as AppContext;
    await registerAgreements(app, ctx);
  });
  afterEach(async () => {
    await app.close();
  });

  it.each(removed)(
    'rejects %s %s before any funding, model call or VM create',
    async (method, url, role) => {
      const response = await app.inject({
        method,
        url,
        headers: { 'x-role': role },
        payload: { operationKey: 'retired-attempt', active: true },
      });
      expect(response.statusCode).toBe(410);
      expect(response.json().error).toContain('removed');
      expect(query).not.toHaveBeenCalled();
      expect(nativeCreate).not.toHaveBeenCalled();
      expect(modelCall).not.toHaveBeenCalled();
      expect(send).not.toHaveBeenCalled();
    },
  );
  it.each(removed)('authenticates %s %s before revealing retirement', async (method, url, role) => {
    expect((await app.inject({ method, url })).statusCode).toBe(401);
    const wrong = role === 'buyer' ? 'provider' : 'buyer';
    expect((await app.inject({ method, url, headers: { 'x-role': wrong } })).statusCode).toBe(403);
    expect(query).not.toHaveBeenCalled();
  });
  it('keeps wallet and legacy ownership/cleanup routes registered', () => {
    for (const [method, url] of [
      ['GET', '/api/credits'],
      ['GET', '/api/agreements/:id'],
      ['POST', '/api/agreements/:id/cancel-unmatched'],
      ['POST', '/api/agreements/:id/activate'],
      ['GET', '/api/provider/commitments'],
    ] as const)
      expect(app.hasRoute({ method, url })).toBe(true);
  });
  it('does not expose the removed scheduled Muse operation', () => {
    const adapter = createMuseAdapter({ museMode: 'fixture' });
    expect(adapter).not.toHaveProperty('draftSchedule');
  });
  it('runs queued legacy maintenance without selecting new demand or scheduling VM creation', async () => {
    let work: (() => Promise<void>) | undefined;
    const legacyQuery = vi.fn(async (sql: string) => {
      expect(sql).not.toContain('accepting_topups');
      expect(sql).not.toContain('broker_scheduled_offerings');
      return { rows: [] };
    });
    const boss = {
      createQueue: vi.fn(async () => {}),
      work: vi.fn(async (_name: string, _options: unknown, handler: () => Promise<void>) => {
        work = handler;
      }),
      schedule: vi.fn(async () => {}),
      send: vi.fn(async () => {}),
    };
    await startAgreementWorkers({
      ...ctx,
      pool: { query: legacyQuery },
      boss,
    } as unknown as AppContext);
    expect(work).toBeDefined();
    await work!();
    expect(legacyQuery).toHaveBeenCalledTimes(2);
    expect(nativeCreate).not.toHaveBeenCalled();
  });
});
