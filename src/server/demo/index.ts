import { z } from 'zod';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { HttpError, type AppContext } from '../context.js';
import { operationSchema } from '../inference/data.js';
import { createDemoIdentity, demoIdentity, demoIpDigest } from './access.js';
import { DEMO_QUEUE, demoState, startDemo, endDemo, demoKey } from './service.js';
import { maintainDemo, reconcileDemo } from './worker.js';

const startMutation = z
  .object({
    operationKey: operationSchema,
    kind: z.enum(['terminal', 'studio']).default('terminal'),
  })
  .strict();
const mutation = z.object({ operationKey: operationSchema }).strict();
function origin(ctx: AppContext, request: FastifyRequest) {
  if (
    request.headers.origin !== new URL(ctx.config.appUrl).origin ||
    request.headers['sec-fetch-site'] === 'cross-site'
  )
    throw new HttpError(403, 'Demo actions require the application origin.');
  if (request.headers.authorization !== undefined)
    throw new HttpError(403, 'Use this browser’s demo controls.');
}
export async function registerDemo(app: FastifyInstance, ctx: AppContext) {
  const buckets = new Map<string, { until: number; count: number }>();
  function throttle(request: FastifyRequest, kind: 'read' | 'write' | 'end') {
    const now = Date.now(),
      key = `${kind}:${demoIpDigest(ctx, request)}`;
    let entry = buckets.get(key);
    if (!entry || entry.until <= now) {
      if (buckets.size >= 4000)
        for (const [id, value] of buckets) if (value.until <= now) buckets.delete(id);
      // Keep cancellation available even when unrelated public traffic fills the cache.
      if (buckets.size >= 4000 && !buckets.has(key) && kind === 'end') return;
      if (buckets.size >= 4000 && !buckets.has(key))
        throw Object.assign(new HttpError(429, 'Demo traffic is busy. Please try again shortly.'), {
          retryAfter: 60,
        });
      entry = { until: now + 60_000, count: 0 };
      buckets.set(key, entry);
    }
    if (entry.count >= (kind === 'write' ? 10 : 60))
      throw Object.assign(new HttpError(429, 'Please wait before another demo request.'), {
        retryAfter: Math.max(1, Math.ceil((entry.until - now) / 1000)),
      });
    entry.count++;
  }
  app.get('/api/demo', async (request, reply) => {
    throttle(request, 'read');
    reply.header('Cache-Control', 'private, no-store');
    return demoState(ctx, demoIdentity(ctx, request), demoIpDigest(ctx, request));
  });
  app.post('/api/demo/start', async (request, reply) => {
    origin(ctx, request);
    throttle(request, 'write');
    const input = startMutation.parse(request.body);
    const identity = createDemoIdentity(ctx, request, reply);
    try {
      await startDemo(ctx, identity, input.operationKey, input.kind);
    } catch (error) {
      // A losing parallel first-start must not overwrite the winning browser cookie.
      reply.removeHeader('Set-Cookie');
      throw error;
    }
    return demoState(ctx, identity);
  });
  app.post('/api/demo/end', async (request) => {
    origin(ctx, request);
    throttle(request, 'end');
    const input = mutation.parse(request.body),
      identity = demoIdentity(ctx, request);
    if (!identity) throw new HttpError(401, 'No demo browser session was found.');
    await endDemo(ctx, identity, input.operationKey);
    return demoState(ctx, identity);
  });
  app.post('/api/demo/key', async (request, reply) => {
    origin(ctx, request);
    throttle(request, 'write');
    const input = mutation.parse(request.body),
      identity = demoIdentity(ctx, request);
    if (!identity) throw new HttpError(401, 'No demo browser session was found.');
    reply.header('Cache-Control', 'private, no-store');
    return demoKey(ctx, identity, input.operationKey);
  });
}
export async function startDemoWorkers(ctx: AppContext) {
  await ctx.boss.createQueue(DEMO_QUEUE);
  await ctx.boss.work<{ id: string }>(
    DEMO_QUEUE,
    { localConcurrency: 2, pollingIntervalSeconds: 1 },
    async (jobs) => {
      for (const job of jobs) await reconcileDemo(ctx, job.data.id);
    },
  );
  const maintenance = 'broker-homepage-demo-maintenance';
  await ctx.boss.createQueue(maintenance);
  await ctx.boss.work(maintenance, { localConcurrency: 1 }, async () => maintainDemo(ctx));
  await ctx.boss.schedule(maintenance, '* * * * *', {}, { tz: 'UTC' });
  await maintainDemo(ctx);
}
export { startDemo, demoState, endDemo, demoKey, reconcileDemo, maintainDemo };
export { demoIdentity, demoTerminalActor } from './access.js';
