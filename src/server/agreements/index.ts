import type { FastifyInstance } from 'fastify';
import { HttpError, type AppContext } from '../context.js';
import { uuid } from '../marketplace/data.js';
import { agreementDetail } from './data.js';
import { cancelUnmatched } from './service.js';
import { activateAgreement } from './activation.js';
import { registerCreditRoutes } from './credits.js';
import { registerProviderAgreementRoutes } from './provider.js';
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
export { cancelUnmatched } from './service.js';

/** New scheduled capacity has been retired; historical records stay readable. */
export async function registerAgreements(app: FastifyInstance, ctx: AppContext) {
  await registerCreditRoutes(app, ctx);
  await registerProviderAgreementRoutes(app, ctx);
  for (const path of ['/api/agreements/preview', '/api/agreements', '/api/agreements/draft'])
    app.post(path, async (request) => {
      await ctx.requireActor(request, ['buyer']);
      throw new HttpError(
        410,
        'Scheduled VM agreements have been removed. Use an instant VM auction.',
      );
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
}
