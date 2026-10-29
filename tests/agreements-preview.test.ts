import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgreementInput, AgreementPreview } from '../src/shared/agreements.js';
import type { Role } from '../src/shared/types.js';
import { HttpError, type AppContext } from '../src/server/context.js';
import { registerAgreements } from '../src/server/agreements/index.js';

describe('authoritative scheduled agreement preview', () => {
  let app: FastifyInstance, ctx: AppContext;
  const input: AgreementInput = {
    operationKey: 'readonly-preview-key',
    description: 'Seven-day preview',
    startDate: '2026-10-29',
    timeZone: 'America/Vancouver',
    windowStart: '00:00',
    windowEnd: '06:00',
    minimumQuantity: 12,
    targetQuantity: 20,
    requirements: { cpu: 1, memoryGb: 1 },
    region: 'any',
    maxDiscountRateCentsPerHour: 10,
    continuation: { enabled: true, until: '08:00', maxRateCentsPerHour: 20 },
  };
  beforeEach(async () => {
    app = Fastify();
    app.setErrorHandler((error, _req, reply) =>
      reply
        .status(error instanceof HttpError ? error.statusCode : 500)
        .send({ error: error instanceof Error ? error.message : 'Failed' }),
    );
    ctx = {
      pool: {
        query: vi.fn(async (sql: string) => {
          expect(sql).toBe('SELECT clock_timestamp() at');
          return { rows: [{ at: new Date('2026-10-28T00:00:00Z') }] };
        }),
        connect: vi.fn(() => {
          throw new Error('Preview must not acquire a transaction or locks.');
        }),
      },
      wick: { mode: 'fixture', catalog: vi.fn(), create: vi.fn(), terminate: vi.fn() },
      muse: { mode: 'fixture', translate: vi.fn() },
      boss: { send: vi.fn() },
      requireActor: vi.fn(async (request: FastifyRequest, roles?: Role[]) => {
        const role = request.headers['x-role'] as Role | undefined;
        if (!role) throw new HttpError(401, 'Sign in.');
        if (!roles?.includes(role)) throw new HttpError(403, 'Buyer access required.');
        return { id: 'buyer', role, name: 'Buyer', email: 'buyer@example.invalid' };
      }),
    } as unknown as AppContext;
    await registerAgreements(app, ctx);
  });
  afterEach(async () => {
    await app.close();
  });
  it('returns server DST endpoints and reservation amounts with exactly one clock read and no writes/native/credit actions', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/agreements/preview',
      headers: { 'x-role': 'buyer' },
      payload: input,
    });
    expect(response.statusCode).toBe(200);
    const result = response.json<AgreementPreview>();
    expect(result).toMatchObject({
      maxAmountCents: 14200,
      minimumAmountCents: 8520,
      timeZone: 'America/Vancouver',
    });
    expect(result.windows).toHaveLength(7);
    expect(result.windows[3]).toEqual({
      startsAt: '2026-11-01T07:00:00.000Z',
      discountEndsAt: '2026-11-01T14:00:00.000Z',
      endsAt: '2026-11-01T16:00:00.000Z',
    });
    expect(ctx.pool.query).toHaveBeenCalledTimes(1);
    expect(ctx.pool.connect).not.toHaveBeenCalled();
    expect(ctx.wick.catalog).not.toHaveBeenCalled();
    expect(ctx.wick.create).not.toHaveBeenCalled();
    expect(ctx.wick.terminate).not.toHaveBeenCalled();
    expect(ctx.muse.translate).not.toHaveBeenCalled();
    expect(ctx.boss.send).not.toHaveBeenCalled();
    expect(ctx.requireActor).toHaveBeenCalledWith(expect.anything(), ['buyer']);
  });
  it.each([undefined, 'provider', 'admin'])(
    'requires buyer authentication before the clock read: %s',
    async (role) => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/agreements/preview',
        headers: role ? { 'x-role': role } : {},
        payload: input,
      });
      expect(response.statusCode).toBe(role ? 403 : 401);
      expect(ctx.pool.query).not.toHaveBeenCalled();
      expect(ctx.pool.connect).not.toHaveBeenCalled();
      expect(ctx.wick.create).not.toHaveBeenCalled();
    },
  );
  it('validates the full candidate operation key and calendar without creating a draft order', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/agreements/preview',
      headers: { 'x-role': 'buyer' },
      payload: { ...input, operationKey: '' },
    });
    expect(response.statusCode).toBe(400);
    expect(ctx.pool.query).toHaveBeenCalledTimes(1);
    expect(ctx.boss.send).not.toHaveBeenCalled();
  });
  it('rejects a lower accepted ceiling, while higher/equal ceilings and legacy candidates remain compatible', async () => {
    const rejected = await app.inject({
      method: 'POST',
      url: '/api/agreements/preview',
      headers: { 'x-role': 'buyer' },
      payload: { ...input, maxReservationCents: 14000 },
    });
    expect(rejected.statusCode).toBe(409);
    expect(rejected.json().error).toMatch(/reviewed credit ceiling/);
    for (const cap of [14200, 15000, undefined]) {
      const response = await app.inject({
        method: 'POST',
        url: '/api/agreements/preview',
        headers: { 'x-role': 'buyer' },
        payload: { ...input, maxReservationCents: cap },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json().maxAmountCents).toBe(14200);
    }
    expect(ctx.pool.connect).not.toHaveBeenCalled();
    expect(ctx.wick.create).not.toHaveBeenCalled();
  });
});
