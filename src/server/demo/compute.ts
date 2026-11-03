import type { Pool, PoolClient } from 'pg';
import type { Actor, CatalogItem } from '../../shared/types.js';
import { isMoneyCents, subtractCents } from '../../shared/money.js';
import { commissionPricing, fixedQuote, requireCurrentRate } from '../../shared/pricing.js';
import { HttpError, type AppContext } from '../context.js';
import { diskCatalogEligible } from '../disks/service.js';
import type { Row } from '../marketplace/data.js';
import { availableForBids } from '../marketplace/policy.js';
import { modalComputePromotionQuote } from '../marketplace/compute-promotion.js';

export const DEMO_COMPUTE_CATALOG_IDS = ['modal:micro:auto', 'e2b:micro:us'] as const;
const VERSION = 'homepage-modal-credit-v1';
/** Only a fenced demo worker may supply this argument; it is never read from HTTP input. */
export interface DemoComputeSource {
  runId: string;
  leaseToken: string;
}
export interface DemoComputePolicy {
  version: typeof VERSION;
  runId: string;
  providerIds: string[];
  effectiveModalPriceCents: 1;
  maxGrossPriceCents: 25;
  tieBreak: 'modal-first';
  bidStrategy: 'supplier-base';
}
export interface DemoComputePrice {
  version: typeof VERSION;
  runId: string;
  grossPriceCents: number;
  sponsorCreditCents: number;
  effectivePriceCents: number;
}

export function demoComputeCatalogEligible(ctx: AppContext, item: CatalogItem): boolean {
  return Boolean(
    DEMO_COMPUTE_CATALOG_IDS.includes(item.id as (typeof DEMO_COMPUTE_CATALOG_IDS)[number]) &&
    item.id === `${item.provider}:${item.profile}:${item.region}` &&
    item.profile === 'micro' &&
    !item.gpu &&
    item.durationMinutes.includes(15) &&
    diskCatalogEligible(ctx, item),
  );
}

/** Read-only supply discovery; submitBid still owns every binding policy/capacity check. */
export async function demoComputeProviders(
  ctx: AppContext,
  db: Pool | PoolClient,
  catalogs: CatalogItem[],
): Promise<string[]> {
  const providerIds: string[] = [];
  for (const id of DEMO_COMPUTE_CATALOG_IDS) {
    const catalog = catalogs.find((item) => item.id === id);
    if (!catalog || !demoComputeCatalogEligible(ctx, catalog))
      throw new HttpError(409, 'The qualified Modal and E2B Micro disk routes are required.');
    const candidates = (
      await db.query(
        `SELECT p.*,o.pricing,(SELECT count(*)::int FROM broker_holds h
          WHERE h.provider_id=p.id AND h.released_at IS NULL) held
         FROM broker_providers p JOIN LATERAL(SELECT pricing FROM broker_offerings o
          WHERE o.provider_id=p.id AND o.catalog_id=$1 AND o.active
          ORDER BY o.price_cents,o.id LIMIT 1) o ON true
         WHERE p.cloud_provider=$2 AND p.policy->>'autoBid'='true' AND p.total_capacity>0
          AND (p.policy->'allowedCatalogIds' IS NULL OR p.policy->'allowedCatalogIds'='null'::jsonb
            OR p.policy->'allowedCatalogIds' ? $1)
         ORDER BY p.id LIMIT 8`,
        [id, catalog.provider],
      )
    ).rows;
    const provider = candidates.find((candidate) => {
      try {
        let floor = 1;
        if (ctx.wick.mode === 'real') {
          requireCurrentRate(candidate.pricing, catalog);
          floor = fixedQuote(commissionPricing(candidate.pricing), 15).upstreamCostFloorCents!;
        }
        const promotion = modalComputePromotionQuote(
          ctx,
          candidate,
          catalog,
          candidate.pricing,
          15,
        );
        const base =
          promotion?.totalPriceCents ??
          Math.max(floor, candidate.policy.minimumPriceCents, candidate.policy.basePriceCents);
        return (
          // The broader promotion's upstream allowance must never widen this demo's budget.
          floor <= 25 &&
          isMoneyCents(base) &&
          base >= candidate.policy.minimumPriceCents &&
          base <= 25 &&
          (candidate.policy.maxPriceCents === undefined ||
            base <= candidate.policy.maxPriceCents) &&
          availableForBids(candidate.total_capacity, candidate.held, candidate.policy) > 0
        );
      } catch {
        return false;
      }
    });
    if (!provider)
      throw new HttpError(
        409,
        'Modal and E2B need available Micro offers within the demo gross limit.',
      );
    providerIds.push(provider.id);
  }
  return providerIds;
}

export function demoComputePolicy(request: Row): DemoComputePolicy | null {
  const policy = request.catalog_snapshot?.demoCompute;
  if (policy === undefined) return null;
  if (
    policy?.version !== VERSION ||
    typeof policy.runId !== 'string' ||
    !Array.isArray(policy.providerIds) ||
    policy.providerIds.length !== 2 ||
    new Set(policy.providerIds).size !== 2 ||
    policy.providerIds.some((id: unknown) => typeof id !== 'string') ||
    policy.effectiveModalPriceCents !== 1 ||
    policy.maxGrossPriceCents !== 25 ||
    policy.tieBreak !== 'modal-first' ||
    policy.bidStrategy !== 'supplier-base'
  )
    throw new HttpError(409, 'The frozen demo sponsorship policy is invalid.');
  return policy as DemoComputePolicy;
}

async function lockRun(ctx: AppContext, db: PoolClient, runId: string, buyerId: string) {
  const allowedMode =
    (ctx.wick.mode === 'real' && ctx.inference?.mode === 'real') ||
    (ctx.config.nodeEnv !== 'production' &&
      ctx.config.liveDemoAllowFixtures &&
      ctx.wick.mode === 'fixture' &&
      ctx.inference?.mode === 'fixture');
  const run = (
    await db.query(
      `SELECT d.*,d.expires_at>clock_timestamp() AS unexpired,
        d.lease_until>clock_timestamp() AS leased
       FROM broker_demo_runs d JOIN broker_demo_days b ON b.day=d.budget_day
       WHERE d.id=$1 AND d.buyer_id=$2 AND d.reserved_cents=50 AND b.reserved_cents>=50
       FOR UPDATE OF d`,
      [runId, buyerId],
    )
  ).rows[0];
  if (
    !ctx.config.liveDemoEnabled ||
    !allowedMode ||
    !run ||
    run.source_mode !== ctx.wick.mode ||
    run.stop_requested ||
    run.ended_at ||
    !run.unexpired ||
    !run.pack_id ||
    !run.disk_id ||
    !['provisioning', 'auction'].includes(run.status)
  )
    throw new HttpError(409, 'The reserved demo no longer authorizes a compute auction.');
  return run;
}

export async function authorizeDemoComputeSource(
  ctx: AppContext,
  db: PoolClient,
  actor: Actor,
  source: DemoComputeSource,
  input: Row,
) {
  const run = await lockRun(ctx, db, source.runId, actor.id);
  if (
    actor.apiKey ||
    actor.role !== 'buyer' ||
    !run.leased ||
    run.lease_token !== source.leaseToken ||
    run.request_id ||
    input.diskId !== run.disk_id ||
    input.catalogId !== DEMO_COMPUTE_CATALOG_IDS[0] ||
    input.durationMinutes !== 15 ||
    input.maxPriceCents !== 25 ||
    input.region !== 'any' ||
    input.matchAcrossProviders !== true ||
    input.operationKey !== `demo:${run.id}:vm`
  )
    throw new HttpError(
      403,
      'Only the active demo worker can authorize its fixed compute request.',
    );
  return run;
}

export function newDemoComputePolicy(runId: string, providerIds: string[]): DemoComputePolicy {
  return {
    version: VERSION,
    runId,
    providerIds,
    effectiveModalPriceCents: 1,
    maxGrossPriceCents: 25,
    tieBreak: 'modal-first',
    bidStrategy: 'supplier-base',
  };
}

export async function authorizeDemoComputeRequest(ctx: AppContext, db: PoolClient, request: Row) {
  const policy = demoComputePolicy(request);
  if (!policy) return null;
  const run = await lockRun(ctx, db, policy.runId, request.buyer_id);
  if (
    run.request_id !== request.id ||
    run.disk_id !== request.disk_id ||
    request.duration_minutes !== 15 ||
    Number(request.max_price_cents) !== 25
  )
    throw new HttpError(409, 'The demo sponsorship is not bound to this fixed compute request.');
  return policy;
}

export function demoComputePrice(
  request: Row,
  providerId: string,
  catalog: CatalogItem | undefined,
  gross: number,
): DemoComputePrice | null {
  const policy = demoComputePolicy(request);
  if (!policy) return null;
  if (
    !catalog ||
    !policy.providerIds.includes(providerId) ||
    !DEMO_COMPUTE_CATALOG_IDS.includes(catalog.id as (typeof DEMO_COMPUTE_CATALOG_IDS)[number]) ||
    !isMoneyCents(gross) ||
    gross < 1 ||
    gross > policy.maxGrossPriceCents
  )
    throw new HttpError(409, 'This offer is outside the fixed demo sponsorship.');
  const effective = catalog.id === DEMO_COMPUTE_CATALOG_IDS[0] ? 1 : gross;
  return {
    version: VERSION,
    runId: policy.runId,
    grossPriceCents: gross,
    sponsorCreditCents: subtractCents(gross, effective),
    effectivePriceCents: effective,
  };
}

export function demoBidPrice(request: Row, bid: Row): DemoComputePrice {
  const expected = demoComputePrice(
    request,
    bid.provider_id,
    bid.offering_snapshot?.catalog,
    Number(bid.total_price_cents),
  );
  const actual = bid.offering_snapshot?.demoSponsorship;
  if (
    !expected ||
    !actual ||
    Object.keys(expected).some((key) => actual[key] !== expected[key as keyof DemoComputePrice])
  )
    throw new HttpError(409, 'The accepted demo bid has no matching frozen sponsorship receipt.');
  return expected;
}

export function selectDemoBid(request: Row, bids: Row[]): Row {
  for (const bid of bids) demoBidPrice(request, bid);
  // A truthful tie is resolved by the disclosed Modal sponsor preference, never a fabricated bid.
  const ranked = [...bids].sort((a, b) => {
    const left = demoBidPrice(request, a),
      right = demoBidPrice(request, b);
    return (
      left.effectivePriceCents - right.effectivePriceCents ||
      Number(b.offering_snapshot.catalog.id === DEMO_COMPUTE_CATALOG_IDS[0]) -
        Number(a.offering_snapshot.catalog.id === DEMO_COMPUTE_CATALOG_IDS[0]) ||
      new Date(a.created_at).getTime() - new Date(b.created_at).getTime() ||
      a.id.localeCompare(b.id)
    );
  });
  const winner = ranked[0];
  if (!winner || winner.offering_snapshot.catalog.id !== DEMO_COMPUTE_CATALOG_IDS[0])
    throw new HttpError(
      409,
      'No eligible Modal Micro sponsorship offer arrived. No fallback VM was allocated.',
    );
  demoBidPrice(request, winner);
  return winner;
}
