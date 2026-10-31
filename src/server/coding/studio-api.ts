import type { FastifyInstance, FastifyRequest } from 'fastify';
import { HttpError } from '../context.js';
import type { AppContext } from '../context.js';
import { uuid } from '../marketplace/data.js';
import { ownerOnly } from './service.js';
import {
  STUDIO_QUEUE,
  studioOptions,
  createStudioTask,
  listStudioTasks,
  studioDetail,
  studioPatch,
  controlStudio,
  processStudioTask,
  maintainStudio,
} from './studio.js';

export function registerStudio(app: FastifyInstance, ctx: AppContext) {
  const owner = async (r: FastifyRequest) => {
    const actor = await ctx.requireActor(r, ['buyer']);
    if (
      !['GET', 'HEAD', 'OPTIONS'].includes(r.method) &&
      r.headers.origin !== new URL(ctx.config.appUrl).origin
    )
      throw new HttpError(403, 'Studio requires the application origin.');
    ownerOnly(actor);
    return actor;
  };
  const id = (r: FastifyRequest) => uuid((r.params as { id: string }).id);
  app.get('/api/studio/options', async (r) => {
    await owner(r);
    return studioOptions(ctx);
  });
  app.get('/api/studio/tasks', async (r) => listStudioTasks(ctx, await owner(r), r.query));
  app.post('/api/studio/tasks', async (r) => createStudioTask(ctx, await owner(r), r.body));
  app.get('/api/studio/tasks/:id', async (r) => studioDetail(ctx, await owner(r), id(r)));
  for (const action of ['stop', 'resume', 'fund'] as const)
    app.post(`/api/studio/tasks/:id/${action}`, async (r) =>
      controlStudio(ctx, await owner(r), id(r), action, r.body),
    );
  app.get('/api/studio/tasks/:id/patch', async (r, reply) =>
    reply
      .type('text/x-diff')
      .header('Content-Disposition', `attachment; filename="studio-${id(r)}.patch"`)
      .send(await studioPatch(ctx, await owner(r), id(r))),
  );
}
export async function startStudioWorkers(ctx: AppContext) {
  await ctx.boss.createQueue(STUDIO_QUEUE);
  await ctx.boss.work<{ id: string }>(
    STUDIO_QUEUE,
    { localConcurrency: 2, pollingIntervalSeconds: 1 },
    async (jobs) => {
      for (const job of jobs) await processStudioTask(ctx, uuid(job.data.id));
    },
  );
  const name = 'broker-studio-maintenance';
  await ctx.boss.createQueue(name);
  await ctx.boss.work(name, { localConcurrency: 1 }, async () => maintainStudio(ctx));
  await ctx.boss.schedule(name, '* * * * *', {}, { tz: 'UTC' });
  await maintainStudio(ctx);
}
