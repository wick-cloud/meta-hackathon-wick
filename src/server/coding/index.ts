import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { AppContext } from '../context.js';
import { HttpError } from '../context.js';
import { uuid } from '../marketplace/data.js';
import {
  ownerOnly,
  createCodingJob,
  listCodingJobs,
  codingDetail,
  controlCoding,
  processCodingJob,
  maintainCoding,
  CODING_QUEUE,
} from './service.js';

export function registerCoding(app: FastifyInstance, ctx: AppContext) {
  const owner = async (r: FastifyRequest) => {
    const actor = await ctx.requireActor(r, ['buyer']);
    ownerOnly(actor);
    return actor;
  };
  app.get('/api/coding/options', async (r) => {
    const actor = await owner(r);
    const vms = (
      await ctx.pool.query(
        `SELECT id,environment_id,catalog_snapshot->>'name' name,catalog_snapshot->>'provider' provider,expires_at
    FROM broker_vms WHERE buyer_id=$1 AND status='running' AND expires_at>clock_timestamp()+interval '30 seconds' ORDER BY created_at DESC,id DESC LIMIT 20`,
        [actor.id],
      )
    ).rows;
    const grants = (
      await ctx.pool.query(
        `SELECT id,name,available_cents,expires_at,source_mode FROM broker_inference_grants WHERE buyer_id=$1 AND status='active'
      AND expires_at>clock_timestamp()+interval '30 seconds' ORDER BY created_at DESC,id DESC LIMIT 25`,
        [actor.id],
      )
    ).rows;
    return {
      vms,
      grants,
      executionAvailable: typeof ctx.wick.runCommand === 'function',
      mode: ctx.wick.mode,
      requirements:
        'Linux VM with Python 3, Git and working bubblewrap user/PID/network namespaces. Tests run without network access.',
    };
  });
  app.get('/api/coding/jobs', async (r) => listCodingJobs(ctx, await owner(r), r.query));
  app.post('/api/coding/jobs', async (r) => createCodingJob(ctx, await owner(r), r.body));
  app.get('/api/coding/jobs/:id', async (r) =>
    codingDetail(ctx, await owner(r), uuid((r.params as { id: string }).id)),
  );
  for (const action of ['pause', 'resume', 'stop', 'reconcile'] as const)
    app.post(`/api/coding/jobs/:id/${action}`, async (r) =>
      controlCoding(ctx, await owner(r), uuid((r.params as { id: string }).id), action),
    );
  app.get('/api/coding/jobs/:id/patch', async (r, reply) => {
    const detail = await codingDetail(ctx, await owner(r), uuid((r.params as { id: string }).id));
    const step = detail.steps.findLast((s) => s.action === 'diff' && s.status === 'completed');
    const result = step?.result?.result as { output?: string; truncated?: boolean } | undefined;
    if (detail.artifactsExpired || !result?.output || result.truncated)
      throw new HttpError(
        409,
        'A complete retained patch is not available. Inspect the VM terminal.',
      );
    return reply
      .type('text/x-diff')
      .header('Content-Disposition', `attachment; filename="muse-${detail.job.id}.patch"`)
      .send(result.output);
  });
}
export async function startCodingWorkers(ctx: AppContext) {
  await ctx.boss.createQueue(CODING_QUEUE);
  await ctx.boss.work<{ id: string }>(
    CODING_QUEUE,
    { localConcurrency: 4, pollingIntervalSeconds: 1 },
    async (jobs) => {
      for (const job of jobs) await processCodingJob(ctx, uuid(job.data.id));
    },
  );
  const maintenance = 'broker-coding-maintenance';
  await ctx.boss.createQueue(maintenance);
  await ctx.boss.work(maintenance, { localConcurrency: 1 }, async () => maintainCoding(ctx));
  await ctx.boss.schedule(maintenance, '* * * * *', {}, { tz: 'UTC' });
  await maintainCoding(ctx);
}
