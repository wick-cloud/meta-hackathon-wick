import { MAX_RATE_FUTURE_SKEW_MS } from '../../shared/pricing.js';
import type { AppContext } from '../context.js';
import { getCatalog, syncCatalog } from './data.js';

const QUEUE = 'broker-catalog-refresh';
const REFRESH_INTERVAL_MS = 5 * 60 * 1000;

export interface CatalogRefreshJob {
  mode: 'real';
  organizationId: string;
  groupId: string;
  startup?: boolean;
}

export async function refreshRealCatalog(ctx: AppContext, job: CatalogRefreshJob) {
  if (
    ctx.wick.mode !== 'real' ||
    job?.mode !== 'real' ||
    !ctx.config.wickOrganizationId ||
    !ctx.config.wickGroupId ||
    job.organizationId !== ctx.config.wickOrganizationId ||
    job.groupId !== ctx.config.wickGroupId
  )
    return;

  if (job.startup) {
    const approved = (await getCatalog(ctx)).filter((item) => item.approved);
    const now = Date.now();
    if (
      approved.length > 0 &&
      approved.every((item) => {
        const retrieved = Date.parse(item.rateRetrievedAt ?? '');
        return (
          Number.isFinite(retrieved) &&
          now - retrieved < REFRESH_INTERVAL_MS &&
          retrieved - now <= MAX_RATE_FUTURE_SKEW_MS
        );
      })
    )
      return;
  }
  await syncCatalog(ctx);
}

export async function startCatalogRefresh(ctx: AppContext) {
  await ctx.boss.createQueue(QUEUE, {
    policy: 'exclusive',
    retryLimit: 2,
    retryDelay: 30,
    retryBackoff: true,
    expireInSeconds: 90,
    retentionSeconds: 600,
    deleteAfterSeconds: 86400,
  });
  await ctx.boss.work<CatalogRefreshJob>(
    QUEUE,
    { localConcurrency: 1, batchSize: 1, pollingIntervalSeconds: 5 },
    async (jobs) => {
      for (const job of jobs) await refreshRealCatalog(ctx, job.data);
    },
  );
  if (ctx.wick.mode !== 'real') {
    await ctx.boss.unschedule(QUEUE, 'real');
    return;
  }
  const { wickOrganizationId: organizationId, wickGroupId: groupId } = ctx.config;
  if (!organizationId || !groupId)
    throw new Error('Real catalog refresh requires the configured Wick organization and group.');
  const job: CatalogRefreshJob = { mode: 'real', organizationId, groupId };
  await ctx.boss.schedule(QUEUE, '*/5 * * * *', job, {
    key: 'real',
    tz: 'UTC',
    missed: 'once',
  });
  await ctx.boss.send(QUEUE, { ...job, startup: true });
}
