import { diskCatalogEligible, requireDisk, reserveVmDisk } from '../disks/service.js';
import { moneyCents } from './data.js';
import { studioAuthority, type StudioSource } from '../coding/studio-budget.js';
import { MIN_ORDER_PRICE_CENTS } from '../../shared/money.js';
import { randomUUID } from 'node:crypto';
import { clientOperationKey, enforceKeyLimit, withOperation } from '../operations.js';
import type { Pool, PoolClient } from 'pg';
import { automaticBidPrices, availableForBids } from './policy.js';
import { availableForInterval, globalAvailableForInterval } from '../agreements/calendar.js';
import {
  acceptedBidQuote,
  commissionPricing,
  revenueShare,
  fixedQuote,
  managedPricing,
  requireCurrentRate,
  requireFreshManagedRate,
} from '../../shared/pricing.js';
import type { Actor, CatalogItem } from '../../shared/types.js';
import { HttpError, type AppContext } from '../context.js';
import { transaction, enqueue, activity, QUEUES } from './db.js';
import { assertProviderCatalog, CLOUD_PROVIDERS } from './provider-identity.js';
import {
  assertManagedCustomerRoute,
  catalogSatisfiesRequest,
  compatibleRequest,
  MAX_MATCH_CATALOGS,
  requestCatalogs,
  sameCatalogAllocation,
} from './matching.js';
import {
  bidView,
  getProvider,
  integer,
  positiveNumber,
  offeringView,
  requestView,
  shortText,
  type Row,
  uuid,
} from './data.js';

export async function createRequest(
  ctx: AppContext,
  actor: Actor,
  body: Row,
  priorRequestId?: string,
  studio?: StudioSource,
) {
  if (!body || typeof body !== 'object' || Array.isArray(body))
    throw new HttpError(400, 'A request body is required.');
  const diskId = body.diskId === undefined ? undefined : uuid(body.diskId);
  if (diskId && actor.apiKey && !actor.apiKey.scopes.includes('disks:use'))
    throw new HttpError(403, 'This key requires disks:use to attach a disk.');
  const description = shortText(body.description, 'Description', 4000);
  const catalogId = shortText(body.catalogId, 'Catalog configuration', 160);
  const region = shortText(body.region, 'Region', 120);
  if (body.matchAcrossProviders !== undefined && typeof body.matchAcrossProviders !== 'boolean')
    throw new HttpError(400, 'Provider matching must be explicitly enabled or disabled.');
  const matchAcrossProviders = body.matchAcrossProviders === true;
  if (region === 'any' && !matchAcrossProviders)
    throw new HttpError(400, 'Any region requires explicit matching across providers.');
  const durationMinutes = integer(body.durationMinutes ?? 30, 'Rental duration', 15, 60);
  if (![15, 30, 60].includes(durationMinutes))
    throw new HttpError(400, 'Choose exactly 15, 30 or 60 minutes.');
  const maxPriceCents = moneyCents(
    body.maxPriceCents,
    'Maximum total price',
    MIN_ORDER_PRICE_CENTS,
  );
  const cpu = integer(body.requirements?.cpu, 'CPU requirement', 1, 1024);
  const memoryGb = positiveNumber(body.requirements?.memoryGb, 'Memory requirement (GiB)', 16384);
  const gpu = body.requirements?.gpu
    ? shortText(body.requirements.gpu, 'GPU requirement', 120)
    : undefined;
  for (const key of ['git', 'repository', 'repo', 'task', 'command', 'agent'])
    if (key in body)
      throw new HttpError(400, 'Environment requests cannot contain workload execution fields.');
  enforceKeyLimit(actor.apiKey, 'maxAuctionCents', maxPriceCents);
  const operation = clientOperationKey(body.operationKey, Boolean(actor.apiKey));
  return transaction(ctx.pool, async (db) =>
    withOperation(
      db,
      actor,
      priorRequestId ? 'orders.retry' : 'orders.create',
      operation,
      {
        description,
        catalogId,
        ...(diskId ? { diskId } : {}),
        region,
        matchAcrossProviders,
        durationMinutes,
        maxPriceCents,
        requirements: { cpu, memoryGb, ...(gpu ? { gpu } : {}) },
        priorRequestId: priorRequestId ?? null,
        mode: ctx.wick.mode,
        ...(studio ? { studioTaskId: studio.id } : {}),
      },
      async () => {
        if (priorRequestId) {
          const prior = (
            await db.query('SELECT * FROM broker_requests WHERE id=$1 AND buyer_id=$2 FOR UPDATE', [
              priorRequestId,
              actor.id,
            ])
          ).rows[0];
          if (!prior) throw new HttpError(404, 'Request not found.');
          if (!['no_offers', 'failed', 'cancelled'].includes(prior.status))
            throw new HttpError(409, 'Only a finished unsuccessful attempt can be retried.');
          if (prior.resolution_request_id) {
            const resolved = (
              await db.query('SELECT * FROM broker_requests WHERE id=$1', [
                prior.resolution_request_id,
              ])
            ).rows[0];
            if (resolved?.prior_request_id === prior.id && !resolved.negotiation_intent_id)
              return requestView(resolved);
            throw new HttpError(
              409,
              'This request was already resolved by an accepted alternative.',
            );
          }
          if (
            (
              await db.query(
                'SELECT 1 FROM broker_vms WHERE request_id=$1 AND cleanup_confirmed_at IS NULL',
                [prior.id],
              )
            ).rowCount
          )
            throw new HttpError(409, 'Wait for the prior environment cleanup before retrying.');
          if ((prior.catalog_snapshot.sourceMode ?? 'fixture') !== ctx.wick.mode)
            throw new HttpError(409, 'The integration mode changed. Review a new request.');
        }
        if (diskId) await requireDisk(ctx, db, actor.id, diskId);
        const result = await db.query(
          'SELECT item,approved FROM broker_catalog WHERE id=$1 AND source_mode=$2 FOR SHARE',
          [catalogId, ctx.wick.mode],
        );
        const catalog = result.rows[0]
          ? ({ ...result.rows[0].item, approved: result.rows[0].approved } as CatalogItem)
          : undefined;
        if (!catalog || !result.rows[0].approved)
          throw new HttpError(400, 'Choose an administrator-approved configuration.');
        if (diskId && !diskCatalogEligible(ctx, catalog))
          throw new HttpError(400, 'Choose a qualified persistent-disk configuration.');
        let pricing;
        if (ctx.wick.mode === 'real') {
          try {
            assertManagedCustomerRoute(catalog);
            requireFreshManagedRate(catalog);
            pricing = managedPricing(catalog);
          } catch (error) {
            throw new HttpError(400, (error as Error).message);
          }
        }
        if (!catalog.durationMinutes.includes(durationMinutes))
          throw new HttpError(
            400,
            'This configuration does not support the exact selected rental duration.',
          );
        if (
          (region !== 'any' && catalog.region !== region) ||
          catalog.cpu < cpu ||
          catalog.memoryGb < memoryGb ||
          (gpu && (gpu === 'any' ? !catalog.gpu : catalog.gpu !== gpu))
        )
          throw new HttpError(
            400,
            'The configuration does not satisfy the requested region and resources.',
          );
        const frozen = {
          ...catalog,
          approved: true,
          sourceMode: ctx.wick.mode,
          ...(pricing ? { pricing } : {}),
        };
        let eligibleCatalogs: Row[] | undefined;
        if (matchAcrossProviders) {
          const rows = (
            await db.query(
              `SELECT id,item FROM broker_catalog WHERE approved AND source_mode=$1
           AND ($1 <> 'real' OR item->>'provider'=ANY($2::text[]))
           AND (item->>'cpu')::numeric >= $3 AND (item->>'memoryGb')::numeric >= $4
           AND ($5='any' OR item->>'region'=$5)
           AND item->'durationMinutes' @> $6::jsonb
           ORDER BY id LIMIT $7 FOR SHARE`,
              [
                ctx.wick.mode,
                [...CLOUD_PROVIDERS],
                cpu,
                memoryGb,
                region,
                JSON.stringify([durationMinutes]),
                MAX_MATCH_CATALOGS + 1,
              ],
            )
          ).rows;
          if (rows.length > MAX_MATCH_CATALOGS)
            throw new HttpError(
              400,
              'Too many matching configurations. Choose a region or narrower resources.',
            );
          eligibleCatalogs = rows
            .map((row) => ({ ...row.item, id: row.id, approved: true }) as CatalogItem)
            .filter((item) => !diskId || diskCatalogEligible(ctx, item))
            .filter((item) =>
              catalogSatisfiesRequest(item, {
                requirements: { cpu, memoryGb, ...(gpu ? { gpu } : {}) },
                region,
                duration_minutes: durationMinutes,
              }),
            )
            .map((item) => {
              try {
                if (ctx.wick.mode === 'real') {
                  assertManagedCustomerRoute(item);
                  requireFreshManagedRate(item);
                }
                return {
                  ...item,
                  approved: true,
                  sourceMode: ctx.wick.mode,
                  ...(ctx.wick.mode === 'real' ? { pricing: managedPricing(item) } : {}),
                };
              } catch (error) {
                throw new HttpError(400, (error as Error).message);
              }
            });
          if (!eligibleCatalogs.length)
            throw new HttpError(
              400,
              'No approved configuration satisfies the reviewed requirements.',
            );
        }
        if (studio) {
          const task = await studioAuthority(db, studio, actor);
          if (task.vm_request_id) {
            const prior = (
              await db.query('SELECT * FROM broker_requests WHERE id=$1 AND buyer_id=$2', [
                task.vm_request_id,
                actor.id,
              ])
            ).rows[0];
            if (prior) return requestView(prior);
          }
          if (Number(task.compute_reserved_cents) < maxPriceCents)
            throw new HttpError(
              409,
              'Compute must be reserved from the task budget before auction admission.',
            );
        }
        const r = await db.query(
          `INSERT INTO broker_requests(buyer_id,description,catalog_id,catalog_snapshot,region,duration_minutes,max_price_cents,requirements,prior_request_id,source_api_key_id,studio_task_id,disk_id)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
          [
            actor.id,
            description,
            catalogId,
            {
              ...frozen,
              ...(eligibleCatalogs ? { matchMode: 'compatible', eligibleCatalogs } : {}),
            },
            region,
            durationMinutes,
            maxPriceCents,
            { cpu, memoryGb, ...(gpu ? { gpu } : {}) },
            priorRequestId || null,
            actor.apiKey?.id ?? null,
            studio?.id ?? null,
            diskId ?? null,
          ],
        );
        const request = r.rows[0];
        if (studio)
          await db.query('UPDATE broker_studio_tasks SET vm_request_id=$2 WHERE id=$1', [
            studio.id,
            request.id,
          ]);
        if (priorRequestId) {
          await db.query('UPDATE broker_requests SET resolution_request_id=$2 WHERE id=$1', [
            priorRequestId,
            request.id,
          ]);
          await db.query(
            "UPDATE broker_intents SET status='resolved' WHERE source_request_id=$1 AND status='open'",
            [priorRequestId],
          );
        }
        await enqueue(ctx, db, QUEUES.close, { requestId: request.id }, 30);
        const providers = await db.query(
          `SELECT p.id FROM broker_providers p WHERE p.policy->>'autoBid'='true'
       AND ($3::boolean=false OR $4 <> 'real' OR p.cloud_provider IS NOT NULL)
       AND EXISTS(SELECT 1 FROM broker_catalog c
         JOIN LATERAL(SELECT 1 FROM broker_offerings o WHERE o.provider_id=p.id
           AND o.catalog_id=c.id AND o.active ORDER BY o.price_cents,o.id LIMIT 1) published ON true
         WHERE c.approved AND c.source_mode=$4 AND c.id=ANY($1::text[])
         AND (p.cloud_provider IS NULL OR p.cloud_provider=c.item->>'provider')
         AND (p.policy->'allowedCatalogIds' IS NULL OR p.policy->'allowedCatalogIds'='null'::jsonb
              OR p.policy->'allowedCatalogIds' ? c.id))
       ORDER BY (p.cloud_provider IS NOT NULL) DESC,p.id LIMIT $2`,
          [
            (eligibleCatalogs ?? [frozen]).map((item) => item.id),
            8,
            matchAcrossProviders,
            ctx.wick.mode,
          ],
        );
        for (const p of providers.rows)
          await enqueue(ctx, db, QUEUES.auto, { requestId: request.id, providerId: p.id });
        return requestView(request);
      },
    ),
  );
}

interface PublishedMatch {
  offering: Row;
  catalog: CatalogItem;
  frozen: CatalogItem;
  minimumPriceCents: number;
}

/** At most one published offering per frozen configuration; no history-wide book load. */
async function publishedMatches(
  ctx: AppContext,
  db: Pool | PoolClient,
  request: Row,
  provider: Row,
  offeringId?: string,
): Promise<PublishedMatch[]> {
  if (ctx.wick.mode === 'real' && compatibleRequest(request) && !provider.cloud_provider)
    throw new HttpError(
      403,
      'An operator-assigned provider route is required for provider matching.',
    );
  const frozen = requestCatalogs(request).filter(
    (item) =>
      !provider.policy.allowedCatalogIds || provider.policy.allowedCatalogIds.includes(item.id),
  );
  if (!frozen.length)
    throw new HttpError(400, 'Provider policy excludes every reviewed configuration.');
  const rows = (
    await db.query(
      `SELECT o.*,c.item AS catalog_item FROM broker_catalog c
       JOIN LATERAL(SELECT o.* FROM broker_offerings o WHERE o.provider_id=$1
         AND o.catalog_id=c.id AND o.active AND ($4::uuid IS NULL OR o.id=$4)
         ORDER BY o.price_cents,o.id LIMIT 1 FOR SHARE) o ON true
       WHERE c.id=ANY($2::text[]) AND c.approved AND c.source_mode=$3
         AND ($5::text IS NULL OR c.item->>'provider'=$5)
       ORDER BY o.price_cents,o.id LIMIT $6 FOR SHARE OF c`,
      [
        provider.id,
        frozen.map((item) => item.id),
        ctx.wick.mode,
        offeringId ?? null,
        provider.cloud_provider ?? null,
        MAX_MATCH_CATALOGS,
      ],
    )
  ).rows;
  const matches: PublishedMatch[] = [];
  let invalid: Error | undefined;
  for (const row of rows) {
    const catalog = { ...row.catalog_item, id: row.catalog_id, approved: true } as CatalogItem;
    const selected = frozen.find((item) => item.id === catalog.id)!;
    try {
      assertProviderCatalog(provider, catalog);
      if (request.disk_id && !diskCatalogEligible(ctx, catalog))
        throw new HttpError(409, 'The provider no longer supports the requested disk.');
      if (!sameCatalogAllocation(selected, catalog) || !catalogSatisfiesRequest(catalog, request))
        throw new HttpError(409, 'The reviewed configuration changed. Start a new request.');
      let minimumPriceCents = Math.max(MIN_ORDER_PRICE_CENTS, provider.policy.minimumPriceCents);
      if (ctx.wick.mode === 'real') {
        assertManagedCustomerRoute(catalog);
        if ((request.catalog_snapshot.sourceMode ?? 'fixture') !== 'real' || !row.pricing)
          throw new HttpError(
            409,
            'A real request and a published managed-rate offering are required.',
          );
        requireCurrentRate(row.pricing, catalog);
        requireCurrentRate(row.pricing, selected);
        minimumPriceCents = Math.max(
          minimumPriceCents,
          fixedQuote(commissionPricing(row.pricing), request.duration_minutes)
            .upstreamCostFloorCents!,
        );
      }
      matches.push({ offering: row, catalog, frozen: selected, minimumPriceCents });
    } catch (error) {
      invalid ??= error as Error;
    }
  }
  if (!matches.length) {
    if (invalid instanceof HttpError) throw invalid;
    if (invalid) throw new HttpError(409, invalid.message);
    throw new HttpError(
      400,
      'Publish an active offering for a reviewed configuration before bidding.',
    );
  }
  return matches.sort(
    (a, b) =>
      Math.max(a.minimumPriceCents, provider.policy.basePriceCents) -
        Math.max(b.minimumPriceCents, provider.policy.basePriceCents) ||
      a.offering.price_cents - b.offering.price_cents ||
      a.offering.id.localeCompare(b.offering.id),
  );
}

export async function submitBid(
  ctx: AppContext,
  actor: Actor,
  requestId: string,
  input: { totalPriceCents: number; offeringId?: string; operationKey?: string },
  source: 'manual' | 'auto' = 'manual',
) {
  const price = moneyCents(input.totalPriceCents, 'Total price', MIN_ORDER_PRICE_CENTS);
  const key = clientOperationKey(input.operationKey, Boolean(actor.apiKey));
  return transaction(ctx.pool, async (db) =>
    withOperation(
      db,
      actor,
      'provider.bids.create',
      key,
      { requestId, price, offeringId: input.offeringId ?? null, source },
      async () => {
        await db.query("SELECT pg_advisory_xact_lock(hashtext('broker-global-vm-admission'))");
        const request = (
          await db.query('SELECT * FROM broker_requests WHERE id=$1 FOR UPDATE', [requestId])
        ).rows[0];
        if (!request) throw new HttpError(404, 'Request not found.');
        const deadline = (
          await db.query(
            'SELECT clock_timestamp()<closes_at AS eligible FROM broker_requests WHERE id=$1',
            [requestId],
          )
        ).rows[0].eligible;
        if (request.status !== 'open' || !deadline)
          throw new HttpError(409, 'This auction has closed. Late bids are not accepted.');
        const provider = await getProvider(db, actor);
        await db.query('SELECT id FROM broker_providers WHERE id=$1 FOR UPDATE', [provider.id]);
        const p = (await db.query('SELECT * FROM broker_providers WHERE id=$1', [provider.id]))
          .rows[0];
        const policy = p.policy;
        if (source === 'auto' && !policy.autoBid)
          throw new HttpError(409, 'Automatic bidding was disabled before submission.');
        if (
          price > request.max_price_cents ||
          price < policy.minimumPriceCents ||
          (policy.maxPriceCents !== undefined && price > policy.maxPriceCents)
        )
          throw new HttpError(
            400,
            'Price is outside the customer budget or provider pricing policy.',
          );
        const match = (await publishedMatches(ctx, db, request, p, input.offeringId))[0]!;
        const offering = match.offering;
        let pricing;
        if (ctx.wick.mode === 'real') {
          try {
            pricing = acceptedBidQuote(offering.pricing, request.duration_minutes, price);
          } catch (error) {
            throw new HttpError(409, (error as Error).message);
          }
        }
        const existing = (
          await db.query('SELECT id FROM broker_bids WHERE request_id=$1 AND provider_id=$2', [
            requestId,
            p.id,
          ])
        ).rows[0];
        if (existing) throw new HttpError(409, 'This provider already submitted a binding bid.');
        const held = Number(
          (
            await db.query(
              'SELECT count(*)::int AS n FROM broker_holds WHERE provider_id=$1 AND released_at IS NULL',
              [p.id],
            )
          ).rows[0].n,
        );
        const availableCapacity = availableForBids(p.total_capacity, held, policy);
        if (availableCapacity < 1)
          throw new HttpError(409, 'All simulated supplier slots are already reserved.');
        if (source === 'auto') {
          const currentPrices = automaticBidPrices(
            policy,
            match.minimumPriceCents,
            p.total_capacity,
            availableCapacity,
          );
          if (![currentPrices.basePriceCents, currentPrices.discountPriceCents].includes(price))
            throw new HttpError(
              409,
              'The automatic bid strategy changed before submission. Request a fresh proposal.',
            );
        }
        const interval = instantReservationInterval(request);
        if ((await availableForInterval(ctx, db, p.id, interval.startsAt, interval.endsAt)) < 1)
          throw new HttpError(409, 'This rental would overlap already booked capacity.');
        const scheduled = await db.query(
          "SELECT 1 FROM broker_agreement_bookings WHERE tstzrange(starts_at,ends_at,'[)') && tstzrange($1::timestamptz,$2::timestamptz,'[)') LIMIT 1",
          [interval.startsAt, interval.endsAt],
        );
        if (
          scheduled.rowCount &&
          (await globalAvailableForInterval(
            ctx,
            db,
            interval.startsAt,
            interval.endsAt,
            undefined,
            request.id,
          )) < 1
        )
          throw new HttpError(
            409,
            'The concurrent VM limit is committed to scheduled capacity for this rental interval.',
          );
        const bid = (
          await db.query(
            `WITH acceptance AS MATERIALIZED (SELECT clock_timestamp() AS accepted_at) INSERT INTO broker_bids(request_id,provider_id,offering_id,offering_snapshot,total_price_cents,source_api_key_id,created_at) SELECT $1,$2,$3,$4,$5,$6,accepted_at FROM acceptance WHERE accepted_at<(SELECT closes_at FROM broker_requests WHERE id=$1) RETURNING *`,
            [
              requestId,
              p.id,
              offering.id,
              {
                ...offeringView(offering),
                bidSource: source,
                catalog: { ...match.frozen, sourceMode: ctx.wick.mode },
                simulated: p.simulated,
                cloudProvider: p.cloud_provider,
                revenueShare: revenueShare(price),
                ...(pricing ? { pricing } : {}),
              },
              price,
              actor.apiKey?.id ?? null,
            ],
          )
        ).rows[0];
        if (!bid)
          throw new HttpError(
            409,
            'This auction closed while capacity was being reserved. Late bids are not accepted.',
          );
        await db.query('INSERT INTO broker_holds(bid_id,provider_id) VALUES($1,$2)', [
          bid.id,
          p.id,
        ]);
        await activity(
          db,
          p.id,
          requestId,
          'bid',
          'Submitted a fixed-price bid and reserved one simulated capacity slot.',
        );
        return bidView({ ...bid, provider_name: p.name });
      },
    ),
  );
}

export async function closeAuction(ctx: AppContext, requestId: string) {
  return transaction(ctx.pool, async (db) => {
    await db.query("SELECT pg_advisory_xact_lock(hashtext('broker-global-vm-admission'))");
    const request = (
      await db.query('SELECT * FROM broker_requests WHERE id=$1 FOR UPDATE', [requestId])
    ).rows[0];
    if (!request || request.status !== 'open') return;
    const time = await db.query(
      'SELECT GREATEST(0,EXTRACT(EPOCH FROM (closes_at-clock_timestamp()))) AS remaining FROM broker_requests WHERE id=$1',
      [requestId],
    );
    if (Number(time.rows[0].remaining) > 0) {
      await enqueue(
        ctx,
        db,
        QUEUES.close,
        { requestId },
        Math.ceil(Number(time.rows[0].remaining)),
      );
      return;
    }
    const bids = (
      await db.query(
        "SELECT * FROM broker_bids WHERE request_id=$1 AND status='held' ORDER BY total_price_cents,created_at,id FOR UPDATE",
        [requestId],
      )
    ).rows;
    if ((request.catalog_snapshot.sourceMode ?? 'fixture') !== ctx.wick.mode) {
      await db.query(
        "UPDATE broker_requests SET status='failed',failure_reason='The Wick integration mode changed. Create a new request with the current approved catalog.' WHERE id=$1",
        [requestId],
      );
      await db.query("UPDATE broker_bids SET status='lost' WHERE request_id=$1", [requestId]);
      await db.query(
        "UPDATE broker_holds SET released_at=now(),release_reason='Integration mode changed before admission' WHERE bid_id IN(SELECT id FROM broker_bids WHERE request_id=$1) AND released_at IS NULL",
        [requestId],
      );
      return;
    }
    if (!bids.length) {
      await db.query(
        "UPDATE broker_requests SET status='no_offers',failure_reason='No eligible offers arrived before the auction closed.' WHERE id=$1",
        [requestId],
      );
      return;
    }
    if (!(await globalAdmissionAvailable(ctx, db, request))) {
      await db.query(
        "UPDATE broker_requests SET status='failed',failure_reason='The concurrent VM limit, booked capacity, or original launch deadline prevents this rental. Review a new auction.' WHERE id=$1",
        [requestId],
      );
      await db.query("UPDATE broker_bids SET status='lost' WHERE request_id=$1", [requestId]);
      await db.query(
        "UPDATE broker_holds SET released_at=now(),release_reason='VM limit reached' WHERE bid_id IN(SELECT id FROM broker_bids WHERE request_id=$1) AND released_at IS NULL",
        [requestId],
      );
      return;
    }
    if (request.disk_id) {
      try {
        await requireDisk(ctx, db, request.buyer_id, request.disk_id);
        const winningCatalogId = bids[0].offering_snapshot?.catalog?.id ?? request.catalog_id;
        const current = (
          await db.query(
            'SELECT item,approved FROM broker_catalog WHERE id=$1 AND source_mode=$2 FOR SHARE',
            [winningCatalogId, ctx.wick.mode],
          )
        ).rows[0];
        if (!current || !diskCatalogEligible(ctx, { ...current.item, approved: current.approved }))
          throw new HttpError(409, 'Persistent disk support changed before admission.');
      } catch (error) {
        if (!(error instanceof HttpError)) throw error;
        await db.query(
          "UPDATE broker_requests SET status='failed',failure_reason='The disk or its qualified provider route is unavailable. Review a new rental.' WHERE id=$1",
          [requestId],
        );
        await db.query(
          "UPDATE broker_bids SET status='lost' WHERE request_id=$1 AND status='held'",
          [requestId],
        );
        await db.query(
          "UPDATE broker_holds SET released_at=now(),release_reason='Disk unavailable before admission' WHERE bid_id IN(SELECT id FROM broker_bids WHERE request_id=$1) AND released_at IS NULL",
          [requestId],
        );
        return;
      }
    }
    return awardHeldBid(ctx, db, request, bids[0]);
  });
}

/** Caller holds the request/provider rows. Shared admission lock covers every award path. */
export function instantReservationInterval(request: Row) {
  const closesAt = new Date(request.closes_at ?? Date.now()).getTime();
  const admissionDeadlineAt = new Date(closesAt + 300_000).toISOString();
  return {
    startsAt: new Date().toISOString(),
    admissionDeadlineAt,
    endsAt: new Date(closesAt + 420_000 + Number(request.duration_minutes) * 60_000).toISOString(),
  };
}
export async function globalAdmissionAvailable(ctx: AppContext, db: PoolClient, request?: Row) {
  await db.query("SELECT pg_advisory_xact_lock(hashtext('broker-global-vm-admission'))");
  const configured =
    (await db.query("SELECT value FROM broker_settings WHERE key='maxConcurrentVms'")).rows[0]
      ?.value ?? ctx.config.maxConcurrentVms;
  const count = Number(
    (await db.query('SELECT count(*)::int AS n FROM broker_vms WHERE cleanup_confirmed_at IS NULL'))
      .rows[0].n,
  );
  if (count >= Number(configured)) return false;
  if (request) {
    const interval = instantReservationInterval(request);
    if (Date.parse(interval.admissionDeadlineAt) <= Date.now()) return false;
    if (
      (await globalAvailableForInterval(
        ctx,
        db,
        interval.startsAt,
        interval.endsAt,
        undefined,
        request.id,
      )) < 1
    )
      return false;
  }
  return true;
}

/** Shared frozen quote + VM + provision-job owner; does not call Wick or run workloads. */
export async function awardHeldBid(ctx: AppContext, db: PoolClient, request: Row, winner: Row) {
  const winnerCatalog = winner.offering_snapshot?.catalog as CatalogItem | undefined;
  if (compatibleRequest(request) && !winnerCatalog)
    throw new HttpError(409, 'The winning bid has no frozen provider configuration.');
  const catalog = winnerCatalog ?? request.catalog_snapshot;
  const reviewed = requestCatalogs(request).find((item) => item.id === catalog.id);
  if (
    !reviewed ||
    !sameCatalogAllocation(reviewed, catalog) ||
    !catalogSatisfiesRequest(catalog, request)
  )
    throw new HttpError(409, 'The winning configuration is outside the reviewed request.');
  if (
    compatibleRequest(request) &&
    ctx.wick.mode === 'real' &&
    winner.offering_snapshot?.cloudProvider !== catalog.provider
  )
    throw new HttpError(409, 'The winning provider route does not match the frozen configuration.');
  assertProviderCatalog({ cloud_provider: winner.offering_snapshot?.cloudProvider }, catalog);
  if (ctx.wick.mode === 'real') assertManagedCustomerRoute(catalog);
  if (!(await globalAdmissionAvailable(ctx, db, request)))
    throw new HttpError(409, 'The concurrent VM limit is reached.');
  if (request.studio_task_id) {
    const allowed = (
      await db.query(
        `SELECT 1 FROM broker_studio_tasks t JOIN broker_inference_grants g ON g.id=t.grant_id
      WHERE t.id=$1 AND NOT t.stop_requested AND t.outcome IS NULL AND t.deadline_at>clock_timestamp()
      AND t.compute_reserved_cents >= $2 AND g.status='active' AND g.expires_at>clock_timestamp()`,
        [request.studio_task_id, winner.total_price_cents],
      )
    ).rowCount;
    if (!allowed) throw new HttpError(409, 'Studio no longer authorizes this compute award.');
  }
  const disk = request.disk_id
    ? await requireDisk(ctx, db, request.buyer_id, request.disk_id)
    : null;
  if (disk && !diskCatalogEligible(ctx, catalog))
    throw new HttpError(409, 'The selected provider is no longer qualified for persistent disks.');
  const requestId = request.id;
  await db.query(
    "UPDATE broker_bids SET status=CASE WHEN id=$2 THEN 'won' ELSE 'lost' END WHERE request_id=$1",
    [requestId, winner.id],
  );
  await db.query(
    "UPDATE broker_holds SET released_at=now(),release_reason='Auction lost' WHERE bid_id IN(SELECT id FROM broker_bids WHERE request_id=$1 AND id<>$2) AND released_at IS NULL",
    [requestId, winner.id],
  );
  const vmId = randomUUID();
  const config = ctx.config as unknown as Record<string, unknown>;
  const createInput = {
    organizationId: catalog.organizationId || config.wickOrganizationId || 'fixture-organization',
    groupId: catalog.groupId || config.wickGroupId || 'fixture-group',
    name: `${config.environmentNamePrefix || 'wick-broker'}-${vmId.slice(0, 8)}`,
    provider: catalog.provider,
    profile: catalog.profile,
    region: catalog.region,
    ...(catalog.providerKeyId ? { providerKeyId: catalog.providerKeyId } : {}),
    ...(ctx.wick.mode === 'real'
      ? { maximumPriceMicrosPerSecond: catalog.rateMicrosPerSecond }
      : {}),
    ttlSeconds: request.duration_minutes * 60,
    visibility: 'private',
    ...(disk
      ? { workspaceDrive: { driveId: disk.upstream_id, accessMode: 'mount' as const } }
      : {}),
  };
  if (
    ctx.wick.mode === 'real' &&
    ((!catalog.organizationId && !config.wickOrganizationId) ||
      (!catalog.groupId && !config.wickGroupId))
  )
    throw new HttpError(
      503,
      'Real Wick organization and group must be configured before awarding.',
    );
  await db.query(
    `INSERT INTO broker_vms(id,request_id,buyer_id,provider_id,bid_id,create_key,create_input,catalog_snapshot,quote_snapshot,disk_id)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [
      vmId,
      requestId,
      request.buyer_id,
      winner.provider_id,
      winner.id,
      `broker-v1:${vmId}`,
      createInput,
      catalog,
      {
        totalPriceCents: winner.total_price_cents,
        ...(request.studio_task_id
          ? { billingSource: 'studio_task', studioTaskId: request.studio_task_id }
          : {}),
        currency: 'USD',
        feeCents: 0,
        ...(winner.offering_snapshot.revenueShare
          ? { revenueShare: winner.offering_snapshot.revenueShare }
          : {}),
        offering: winner.offering_snapshot,
        acceptedAt: isoDate(winner.created_at),
        admissionDeadlineAt: instantReservationInterval(request).admissionDeadlineAt,
        ...(winner.offering_snapshot.pricing ? { pricing: winner.offering_snapshot.pricing } : {}),
      },
      request.disk_id ?? null,
    ],
  );
  if (disk) await reserveVmDisk(db, vmId, request.disk_id);
  await db.query("UPDATE broker_requests SET status='provisioning',winning_bid_id=$2 WHERE id=$1", [
    requestId,
    winner.id,
  ]);
  await activity(
    db,
    winner.provider_id,
    requestId,
    'awarded',
    request.negotiation_intent_id
      ? 'Buyer explicitly accepted the reviewed provider and fixed total. Quote and offering revision frozen.'
      : 'Lowest eligible fixed-price offer won. Quote and offering revision frozen.',
  );
  await enqueue(ctx, db, QUEUES.provision, { vmId });
  return { vmId, winningBidId: winner.id };
}

function isoDate(value: unknown) {
  return new Date(value as string).toISOString();
}

export async function proposeBid(ctx: AppContext, actor: Actor, requestId: string) {
  const provider = await getProvider(ctx.pool, actor);
  const budgetStartedAt = performance.now();
  const request = (
    await ctx.pool.query(
      "SELECT *,EXTRACT(EPOCH FROM(closes_at-clock_timestamp()))*1000 AS remaining_ms FROM broker_requests WHERE id=$1 AND status='open' AND closes_at>clock_timestamp()",
      [requestId],
    )
  ).rows[0];
  if (!request) throw new HttpError(409, 'This request is no longer accepting offers.');
  const held = Number(
    (
      await ctx.pool.query(
        'SELECT count(*)::int AS n FROM broker_holds WHERE provider_id=$1 AND released_at IS NULL',
        [provider.id],
      )
    ).rows[0].n,
  );
  const match = (await publishedMatches(ctx, ctx.pool, request, provider))[0]!;
  const minimumPriceCents = match.minimumPriceCents;
  const availableCapacity = availableForBids(provider.total_capacity, held, provider.policy);
  const prices = automaticBidPrices(
    provider.policy,
    minimumPriceCents,
    provider.total_capacity,
    availableCapacity,
  );
  if (
    minimumPriceCents > request.max_price_cents ||
    (provider.policy.maxPriceCents !== undefined &&
      minimumPriceCents > provider.policy.maxPriceCents)
  )
    return {
      decision: 'decline' as const,
      mode: ctx.muse.mode,
      modelCalled: false,
      receipt: {
        observed: ['Supplier policy, buyer budget and frozen Wick cost floor.'],
        decision: 'No price satisfies the cost floor, supplier policy and buyer budget.',
        constraints: ['No model call or capacity reservation.', 'No payment due.'],
      },
    };
  // The database clock owns the auction deadline. Monotonic elapsed time
  // conservatively includes the intervening eligibility reads and leaves room
  // for the binding submission's own SQL deadline/capacity recheck.
  const remainingMs = Math.floor(
    Number(request.remaining_ms) - (performance.now() - budgetStartedAt) - 1000,
  );
  if (!Number.isFinite(remainingMs) || remainingMs < 1)
    throw new HttpError(
      409,
      'Too little auction time remains for a safe bid proposal. Manual bidding remains available while the auction is open.',
    );
  const proposal = await ctx.muse.proposeBid({
    timeoutMs: Math.min(8000, remainingMs),
    request: {
      description: request.description,
      catalogId: match.catalog.id,
      durationMinutes: request.duration_minutes,
      maxPriceCents: request.max_price_cents,
      requirements: request.requirements,
      region: match.catalog.region,
    },
    policy: { ...provider.policy, minimumPriceCents },
    availableCapacity,
    suggestedTotalPriceCents: prices.basePriceCents,
    ...(prices.discountPriceCents !== undefined
      ? { discountTotalPriceCents: prices.discountPriceCents }
      : {}),
    catalog: [match.catalog],
  });
  if (proposal.decision === 'bid') {
    moneyCents(proposal.totalPriceCents, 'Proposed price');
    if (proposal.catalogId && proposal.catalogId !== match.catalog.id)
      throw new HttpError(422, 'Muse proposed a different configuration.');
    if (
      proposal.totalPriceCents! > request.max_price_cents ||
      proposal.totalPriceCents! < minimumPriceCents ||
      ![prices.basePriceCents, prices.discountPriceCents].includes(proposal.totalPriceCents!) ||
      (provider.policy.maxPriceCents !== undefined &&
        proposal.totalPriceCents! > provider.policy.maxPriceCents)
    )
      throw new HttpError(422, 'Muse proposal violates the fixed-price policy or request budget.');
  }
  return { ...proposal, offeringId: match.offering.id as string, mode: ctx.muse.mode };
}

export async function cancelRequest(ctx: AppContext, actor: Actor, id: string, key?: string) {
  key = clientOperationKey(key, Boolean(actor.apiKey));
  return transaction(ctx.pool, async (db) =>
    withOperation(db, actor, 'orders.cancel', key, { id }, async () => {
      const row = (
        await db.query('SELECT * FROM broker_requests WHERE id=$1 AND buyer_id=$2 FOR UPDATE', [
          id,
          actor.id,
        ])
      ).rows[0];
      if (!row) throw new HttpError(404, 'Request not found.');
      if (row.status === 'cancelled') return { cancelled: true };
      if (row.status !== 'open')
        throw new HttpError(
          409,
          'The auction has ended. Manage termination from the VM detail page.',
        );
      await db.query("UPDATE broker_requests SET status='cancelled' WHERE id=$1", [id]);
      await db.query("UPDATE broker_bids SET status='cancelled' WHERE request_id=$1", [id]);
      await db.query(
        "UPDATE broker_holds SET released_at=now(),release_reason='Buyer cancelled auction' WHERE bid_id IN(SELECT id FROM broker_bids WHERE request_id=$1) AND released_at IS NULL",
        [id],
      );
      return { cancelled: true };
    }),
  );
}
