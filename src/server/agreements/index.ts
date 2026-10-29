import type { FastifyInstance } from 'fastify';
import { HttpError, type AppContext } from '../context.js';
import { shortText, uuid } from '../marketplace/data.js';
import { agreementDetail } from './data.js';
import { createAgreement, cancelUnmatched, previewAgreement } from './service.js';
import { activateAgreement } from './activation.js';
import { registerCreditRoutes } from './credits.js';
import { registerProviderAgreementRoutes } from './provider.js';
import { localDate, datePlus } from './recurrence.js';
export { startAgreementWorkers, maintainAgreements, settleWindow } from './settlement.js';
export {
  scheduledActivationReady,
  scheduledActivationCleaned,
  activateAgreement,
} from './activation.js';
export {
  availableForInterval,
  globalAvailableForInterval,
  assertProviderFutureCapacity,
  assertGlobalFutureCapacity,
} from './calendar.js';
export { createAgreement, cancelUnmatched, previewAgreement } from './service.js';
export { matchAgreement } from './matching.js';

export async function registerAgreements(app: FastifyInstance, ctx: AppContext) {
  const draftCalls = new Map<string, { count: number; resetsAt: number }>();
  function limitDrafts(actorId: string) {
    const now = Date.now();
    for (const [id, entry] of draftCalls) if (entry.resetsAt <= now) draftCalls.delete(id);
    const entry = draftCalls.get(actorId) ?? { count: 0, resetsAt: now + 60000 };
    if (entry.count >= 10 || (draftCalls.size >= 1000 && !draftCalls.has(actorId)))
      throw new HttpError(
        429,
        'Muse scheduled draft limit reached. Try again in a minute or use manual controls.',
      );
    entry.count++;
    draftCalls.set(actorId, entry);
  }
  await registerCreditRoutes(app, ctx);
  await registerProviderAgreementRoutes(app, ctx);
  app.post('/api/agreements/preview', async (request) => {
    await ctx.requireActor(request, ['buyer']);
    return previewAgreement(ctx, request.body);
  });
  app.post('/api/agreements', async (request) => {
    const actor = await ctx.requireActor(request, ['buyer']);
    return createAgreement(ctx, actor.id, request.body, actor.apiKey);
  });
  app.get('/api/agreements/:id', async (request) =>
    agreementDetail(
      ctx,
      ctx.pool,
      uuid((request.params as { id: string }).id),
      (await ctx.requireActor(request, ['buyer'])).id,
    ),
  );
  app.post('/api/agreements/:id/cancel-unmatched', async (request) => {
    const actor = await ctx.requireActor(request, ['buyer']);
    return cancelUnmatched(
      ctx,
      uuid((request.params as { id: string }).id),
      actor.id,
      request.body,
      actor.apiKey,
    );
  });
  app.post('/api/agreements/:id/activate', async (request) => {
    const actor = await ctx.requireActor(request, ['buyer']);
    return activateAgreement(
      ctx,
      uuid((request.params as { id: string }).id),
      actor.id,
      request.body,
      actor.apiKey,
    );
  });
  for (const provider of [false, true])
    app.post(
      provider ? '/api/provider/scheduled-offerings/draft' : '/api/agreements/draft',
      async (request) => {
        const actor = await ctx.requireActor(request, provider ? ['provider'] : ['buyer']);
        limitDrafts(actor.id);
        const prompt = shortText((request.body as { prompt?: unknown })?.prompt, 'Prompt');
        const catalog = (
          await ctx.pool.query(
            'SELECT id,item,approved FROM broker_catalog WHERE approved AND source_mode=$1 ORDER BY id LIMIT 64',
            [ctx.wick.mode],
          )
        ).rows.map((r) => ({ ...r.item, id: r.id, approved: r.approved }));
        if (!catalog.length)
          throw new HttpError(409, 'Approve a configuration before drafting a capacity schedule.');
        if (ctx.muse.mode === 'real') {
          if (!ctx.muse.draftSchedule)
            throw new HttpError(503, 'The scheduled Muse draft adapter is unavailable.');
          return ctx.muse.draftSchedule({
            kind: provider ? 'offering' : 'agreement',
            description: prompt,
            catalog,
          });
        }
        const selected = catalog[0];
        const times = [...prompt.matchAll(/\b([01]?\d|2[0-3]):([0-5]\d)\b/g)].map(
          (m) => `${m[1].padStart(2, '0')}:${m[2]}`,
        );
        const quantity = Math.min(
          20,
          Math.max(1, Number(prompt.match(/\b(\d+)\s*(?:vms?|slots?|sandboxes?)\b/i)?.[1] ?? 12)),
        );
        const date = (await ctx.pool.query('SELECT clock_timestamp() at')).rows[0].at.getTime();
        const draft = provider
          ? {
              catalogId: selected.id,
              name: prompt.slice(0, 120),
              kind: 'discount_schedule',
              timeZone: 'UTC',
              weekdays: [0, 1, 2, 3, 4, 5, 6],
              windowStart: times[0] ?? '00:00',
              windowEnd: times[1] ?? '06:00',
              availableUntil: times[2] ?? times[1] ?? '06:00',
              capacityQuantity: quantity,
            }
          : {
              description: prompt,
              startDate: datePlus(localDate(date, 'UTC'), 1),
              timeZone: 'UTC',
              windowStart: times[0] ?? '00:00',
              windowEnd: times[1] ?? '06:00',
              minimumQuantity: quantity,
              targetQuantity: 20,
              requirements: {
                cpu: selected.cpu,
                memoryGb: selected.memoryGb,
                ...(selected.gpu ? { gpu: selected.gpu } : {}),
              },
              region: selected.region,
            };
        return {
          draft,
          mode: 'fixture',
          modelCalled: false,
          explanation:
            'Fixture resource suggestion and deterministic schedule draft. Review the timezone, times, quantities and prices; no model was called and nothing is booked.',
        };
      },
    );
}
