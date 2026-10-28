import type { FastifyInstance } from 'fastify';
import { HttpError, type AppContext } from '../context.js';
import { getCatalog, getProvider } from '../marketplace/data.js';
import { offeringPriceCandidates, recentUnmetDemand } from './demand.js';
import { catalogSatisfiesRequest } from '../marketplace/matching.js';

/** A small per-user limit also bounds paid calls; no model loop or automatic retry. */
export async function registerMuse(app: FastifyInstance, ctx: AppContext) {
  const calls = new Map<string, { count: number; resetsAt: number }>();
  function rateLimit(actorId: string) {
    const now = Date.now();
    for (const [id, entry] of calls) if (entry.resetsAt <= now) calls.delete(id);
    const entry = calls.get(actorId) ?? { count: 0, resetsAt: now + 60_000 };
    if (entry.count >= 10 || (calls.size >= 1000 && !calls.has(actorId)))
      throw new HttpError(
        429,
        'Muse request limit reached. Try again in a minute or use manual controls.',
      );
    entry.count += 1;
    calls.set(actorId, entry);
  }

  app.post<{ Body: { description: string } }>(
    '/api/muse/translate',
    {
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['description'],
          properties: { description: { type: 'string', minLength: 1, maxLength: 4000 } },
        },
      },
    },
    async (request) => {
      const actor = await ctx.requireActor(request, ['buyer']);
      rateLimit(actor.id);
      const catalog = await getCatalog(ctx);
      return ctx.muse.translate(request.body.description, catalog);
    },
  );

  app.post('/api/provider/offerings/propose', async (request) => {
    const actor = await ctx.requireActor(request, ['provider']);
    rateLimit(actor.id);
    const [provider, catalog] = await Promise.all([getProvider(ctx.pool, actor), getCatalog(ctx)]);
    const allowed = catalog.filter(
      (item) =>
        item.approved &&
        (!provider.cloud_provider || item.provider === provider.cloud_provider) &&
        (!provider.policy.allowedCatalogIds || provider.policy.allowedCatalogIds.includes(item.id)),
    );
    const demand = await recentUnmetDemand(
      ctx.pool,
      ctx.wick.mode,
      allowed.map((item) => item.id),
    );
    const pricedCandidates = offeringPriceCandidates(
      allowed,
      provider.policy,
      ctx.wick.mode,
    ).filter((candidate) => {
      const item = allowed.find((entry) => entry.id === candidate.catalogId)!;
      return demand.some((group) =>
        catalogSatisfiesRequest(item, {
          region: group.region,
          duration_minutes: group.durationMinutes,
          requirements: group.requirements,
        }),
      );
    });
    // Buyer identity, free text, credentials and other suppliers' policies never leave this route.
    return ctx.muse.proposeOfferings({
      demand,
      catalog: allowed,
      policy: provider.policy,
      pricedCandidates,
    });
  });
}
