import type { FastifyInstance } from 'fastify';
import type { SalesReport } from '../../shared/sales.js';
import type { CatalogItem } from '../../shared/types.js';
import { requireCurrentRate } from '../../shared/pricing.js';
import { HttpError, type AppContext } from '../context.js';
import { recentUnmetDemand } from '../muse/demand.js';
import { shortText, type Row } from './data.js';
import { availableForBids, normalizedPolicy } from './policy.js';
import { assertManagedCustomerRoute, MAX_MATCH_CATALOGS } from './matching.js';
import { buildSalesAnalysis, type SalesSnapshot } from './sales-analysis.js';

export function registerSales(app: FastifyInstance, ctx: AppContext) {
  const calls = new Map<string, { count: number; until: number }>();
  const pending = new Set<string>();
  app.post('/api/provider/sales/propose', async (request): Promise<SalesReport> => {
    const actor = await ctx.requireActor(request, ['provider']);
    if (actor.apiKey || request.headers.origin !== new URL(ctx.config.appUrl).origin)
      throw new HttpError(403, 'Use the signed-in seller workspace from the application origin.');
    const body = request.body as Row | undefined;
    if (!body || Object.keys(body).some((key) => key !== 'goal'))
      throw new HttpError(400, 'Supply only a selling goal.');
    const goal = shortText(body.goal, 'Selling goal', 1000);
    if (pending.has(actor.id)) throw new HttpError(409, 'A sales analysis is already in progress.');
    const now = Date.now();
    for (const [id, budget] of calls) if (budget.until <= now) calls.delete(id);
    const budget = calls.get(actor.id);
    if ((budget?.count ?? 0) >= 5 || (!budget && calls.size >= 2048))
      throw new HttpError(429, 'Sales analysis limit reached. Try again in a minute.');
    calls.set(actor.id, { count: (budget?.count ?? 0) + 1, until: budget?.until ?? now + 60000 });
    pending.add(actor.id);
    try {
      const db = await ctx.pool.connect();
      let provider: Row;
      let rows: Row[];
      let requests: Row[];
      let bids: Row[];
      try {
        await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
        provider = (
          await db.query(
            `SELECT p.*,(SELECT count(*)::int FROM broker_holds h WHERE h.provider_id=p.id AND h.released_at IS NULL) AS held
           FROM broker_providers p WHERE p.user_id=$1`,
            [actor.id],
          )
        ).rows[0];
        if (!provider) throw new HttpError(403, 'Provider access is not configured.');
        rows = (
          await db.query(
            `SELECT c.id,c.item,c.approved,o.pricing,o.id AS offering_id FROM broker_catalog c
           LEFT JOIN LATERAL (SELECT id,pricing FROM broker_offerings WHERE provider_id=$1 AND catalog_id=c.id AND active
             ORDER BY price_cents,id LIMIT 1) o ON true
           WHERE c.source_mode=$2 AND c.approved AND ($3::text IS NULL OR c.item->>'provider'=$3)
           ORDER BY c.id LIMIT 100`,
            [provider.id, ctx.wick.mode, provider.cloud_provider ?? null],
          )
        ).rows;
        requests = (
          await db.query(
            `WITH recent AS MATERIALIZED (
             SELECT id,catalog_id,catalog_snapshot,region,duration_minutes,max_price_cents,requirements
             FROM broker_requests WHERE created_at>now()-interval '7 days' AND status NOT IN('open','cancelled')
               AND COALESCE(catalog_snapshot->>'sourceMode','fixture')=$1 AND disk_id IS NULL
               AND NOT (catalog_snapshot ? 'demoCompute')
               AND NOT EXISTS(SELECT 1 FROM broker_demo_runs d WHERE d.request_id=broker_requests.id)
             ORDER BY created_at DESC,id DESC LIMIT 200
           ) SELECT * FROM recent r WHERE r.catalog_id=ANY($2::text[]) OR
             (r.catalog_snapshot->>'matchMode'='compatible' AND EXISTS(
               SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(r.catalog_snapshot->'eligibleCatalogs')='array' THEN
                 CASE WHEN jsonb_array_length(r.catalog_snapshot->'eligibleCatalogs')<=$3 THEN r.catalog_snapshot->'eligibleCatalogs' ELSE '[]'::jsonb END
                 ELSE '[]'::jsonb END) item WHERE item->>'id'=ANY($2::text[])))`,
            [ctx.wick.mode, rows.map((r) => r.id), MAX_MATCH_CATALOGS],
          )
        ).rows;
        bids = (
          await db.query(
            `SELECT b.status FROM broker_bids b JOIN broker_requests r ON r.id=b.request_id
           WHERE b.provider_id=$1 AND b.created_at>now()-interval '7 days'
             AND COALESCE(r.catalog_snapshot->>'sourceMode','fixture')=$2
           ORDER BY b.created_at DESC,b.id DESC LIMIT 200`,
            [provider.id, ctx.wick.mode],
          )
        ).rows;
        await db.query('COMMIT');
      } catch (error) {
        await db.query('ROLLBACK');
        throw error;
      } finally {
        db.release();
      }
      const policy = normalizedPolicy(provider.policy);
      const catalog: CatalogItem[] = [];
      const activeCatalogIds: string[] = [];
      for (const row of rows) {
        const item = { ...row.item, id: row.id, approved: true } as CatalogItem;
        try {
          if (ctx.wick.mode === 'real') {
            // Unbound legacy sellers cannot receive cross-provider recommendations.
            if (!provider.cloud_provider) continue;
            assertManagedCustomerRoute(item);
            if (!row.pricing) continue;
            requireCurrentRate(row.pricing, item);
          }
          catalog.push(item);
          if (row.offering_id) activeCatalogIds.push(item.id);
        } catch {
          /* Unqualified/stale offerings are not sales opportunities. */
        }
      }
      const capacity = {
        total: Number(provider.total_capacity),
        held: Number(provider.held),
        available: availableForBids(Number(provider.total_capacity), Number(provider.held), policy),
      };
      const demand = await recentUnmetDemand(
        ctx.pool,
        ctx.wick.mode,
        catalog.map((c) => c.id),
      );
      const snapshot: SalesSnapshot = {
        policy,
        capacity,
        catalog,
        activeCatalogIds,
        requests,
        bidStatuses: bids.map((b) => b.status),
        demand,
        sourceMode: ctx.wick.mode,
        sponsoredPricing:
          ctx.wick.mode === 'real' &&
          provider.cloud_provider === 'modal' &&
          provider.simulated === false &&
          ctx.config.modalComputePromotionEnabled === true,
      };
      const { evidence, candidates, limitations } = buildSalesAnalysis(snapshot);
      if (!ctx.muse.recommendSales) throw new HttpError(503, 'Muse sales analysis is unavailable.');
      const advice = await ctx.muse.recommendSales({
        goal,
        currentPolicy: policy,
        capacity,
        evidence,
        candidates,
      });
      // The model runs outside locks. Never return a stale or newly unauthorized proposal.
      const currentActor = await ctx.requireActor(request, ['provider']);
      const current = (
        await ctx.pool.query('SELECT id,policy_revision FROM broker_providers WHERE user_id=$1', [
          actor.id,
        ])
      ).rows[0];
      if (
        currentActor.id !== actor.id ||
        currentActor.apiKey ||
        !current ||
        current.id !== provider.id ||
        current.policy_revision !== provider.policy_revision
      )
        throw new HttpError(
          409,
          'Your account, capacity or policy changed during analysis. Generate new recommendations.',
        );
      const selected = new Set<string>();
      if (!Array.isArray(advice.recommendations) || advice.recommendations.length > 3)
        throw new HttpError(422, 'Muse returned an invalid sales recommendation.');
      const recommendations = advice.recommendations.map((rec) => {
        const candidate = candidates.find((c) => c.id === rec.candidateId);
        if (
          !candidate ||
          selected.has(candidate.id) ||
          !Array.isArray(rec.evidenceIds) ||
          !rec.evidenceIds.length ||
          rec.evidenceIds.some((id) => !candidate.evidenceIds.includes(id))
        )
          throw new HttpError(
            422,
            'Muse selected an unknown recommendation or unsupported evidence.',
          );
        selected.add(candidate.id);
        return { ...candidate, evidenceIds: rec.evidenceIds, explanation: rec.explanation };
      });
      return {
        generatedAt: new Date().toISOString(),
        baseRevision: provider.policy_revision,
        currentPolicy: policy,
        capacity,
        mode: advice.mode,
        sourceMode: ctx.wick.mode,
        modelCalled: advice.modelCalled,
        summary: advice.summary,
        evidence,
        recommendations,
        limitations,
        catalogNames: Object.fromEntries(catalog.map((c) => [c.id, c.name])),
      };
    } finally {
      pending.delete(actor.id);
    }
  });
}
