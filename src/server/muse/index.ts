import type { FastifyInstance } from 'fastify';
import { HttpError, type AppContext } from '../context.js';
import { getCatalog, getProvider } from '../marketplace/data.js';

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
    const [provider, catalog, demand] = await Promise.all([
      getProvider(ctx.pool, actor),
      getCatalog(ctx),
      ctx.pool.query(`
        SELECT region, duration_minutes AS "durationMinutes", requirements, count(*)::integer AS count
        FROM (
          SELECT region,duration_minutes,requirements
          FROM broker_requests WHERE status='no_offers'
          ORDER BY created_at DESC,id DESC LIMIT 200
        ) recent
        GROUP BY region,duration_minutes,requirements
        ORDER BY count(*) DESC,region,duration_minutes LIMIT 40
      `),
    ]);
    // Buyer identity, free text, credentials and other suppliers' policies never leave this route.
    return ctx.muse.proposeOfferings({ demand: demand.rows, catalog, policy: provider.policy });
  });
}
