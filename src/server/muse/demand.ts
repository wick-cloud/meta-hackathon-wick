import type { Pool } from 'pg';
import type { CatalogItem, SupplierPolicy } from '../../shared/types.js';
import { fixedQuote, managedPricing, requireFreshManagedRate } from '../../shared/pricing.js';

/** Recent unresolved demand only, bounded before aggregation; never selects identities/free text. */
export async function recentUnmetDemand(pool: Pool, mode: string, catalogIds: string[]) {
  if (!catalogIds.length) return [];
  const result = await pool.query(
    `WITH recent_requests AS (
      SELECT r.region,r.duration_minutes,r.requirements,r.created_at
      FROM broker_requests r
      WHERE r.status='no_offers' AND r.created_at>now()-interval '7 days'
        AND COALESCE(r.catalog_snapshot->>'sourceMode','fixture')=$1
        AND r.catalog_id=ANY($2::text[]) AND r.resolution_request_id IS NULL
        AND NOT EXISTS(SELECT 1 FROM broker_requests child WHERE child.prior_request_id=r.id)
        AND NOT EXISTS(SELECT 1 FROM broker_intents i WHERE i.source_request_id=r.id)
      ORDER BY r.created_at DESC,r.id DESC LIMIT 200
    ), recent_intents AS (
      SELECT i.desired,i.created_at FROM broker_intents i
      WHERE i.status='open' AND i.source_mode=$1 AND i.created_at>now()-interval '7 days'
      ORDER BY i.created_at DESC,i.id DESC LIMIT 200
    ), eligible_intents AS (
      SELECT desired->>'region' AS region,(desired->>'durationMinutes')::int AS duration_minutes,
        jsonb_strip_nulls(jsonb_build_object('cpu',desired->'cpu','memoryGb',desired->'memoryGb','gpu',desired->'gpu')) AS requirements,
        created_at FROM recent_intents i
      WHERE (desired->>'durationMinutes')::int IN(15,30,60)
        AND EXISTS(SELECT 1 FROM broker_catalog c WHERE c.id=ANY($2::text[]) AND c.source_mode=$1 AND c.approved
          AND c.item->>'region'=i.desired->>'region'
          AND (c.item->>'cpu')::numeric >= (i.desired->>'cpu')::numeric
          AND (c.item->>'memoryGb')::numeric >= (i.desired->>'memoryGb')::numeric
          AND (i.desired->>'gpu' IS NULL OR i.desired->>'gpu'='' OR c.item->>'gpu'=i.desired->>'gpu')
          AND c.item->'durationMinutes' @> jsonb_build_array((i.desired->>'durationMinutes')::int))
    ), bounded AS (
      SELECT * FROM (SELECT * FROM recent_requests UNION ALL SELECT * FROM eligible_intents) d
      ORDER BY created_at DESC LIMIT 200
    ) SELECT region,duration_minutes AS "durationMinutes",requirements,count(*)::integer AS count
      FROM bounded GROUP BY region,duration_minutes,requirements
      ORDER BY count(*) DESC,region,duration_minutes LIMIT 40`,
    [mode, catalogIds.slice(0, 100)],
  );
  return result.rows;
}

/** Publishing uses a 30-minute baseline; the model chooses a candidate, never a price. */
export function offeringPriceCandidates(
  catalog: CatalogItem[],
  policy: SupplierPolicy,
  mode: 'fixture' | 'real',
  markupBps: number,
) {
  return catalog
    .filter(
      (item) =>
        item.approved &&
        item.durationMinutes.includes(30) &&
        (!policy.allowedCatalogIds || policy.allowedCatalogIds.includes(item.id)),
    )
    .slice(0, 100)
    .flatMap((item) => {
      let price = Math.max(policy.minimumPriceCents, policy.basePriceCents);
      if (mode === 'real') {
        try {
          requireFreshManagedRate(item);
          price = Math.max(
            policy.minimumPriceCents,
            fixedQuote(managedPricing(item, markupBps), 30).totalPriceCents,
          );
        } catch {
          return [];
        }
      }
      if (policy.maxPriceCents !== undefined && price > policy.maxPriceCents) return [];
      return [
        { id: `${item.id}:30`, catalogId: item.id, durationMinutes: 30, totalPriceCents: price },
      ];
    })
    .slice(0, 30);
}
