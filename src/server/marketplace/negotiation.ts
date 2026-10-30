import { isMoneyCents } from '../../shared/money.js';
import { moneyCents } from './data.js';
import { enforceKeyLimit, recordKeyAction } from '../operations.js';
import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { PoolClient } from 'pg';
import type { Actor, CatalogItem, Mode } from '../../shared/types.js';
import {
  acceptedBidQuote,
  commissionPricing,
  revenueShare,
  fixedQuote,
  managedPricing,
  requireCurrentRate,
} from '../../shared/pricing.js';
import { HttpError, type AppContext } from '../context.js';
import { activity, transaction } from './db.js';
import { awardHeldBid, globalAdmissionAvailable, instantReservationInterval } from './auction.js';
import { availableForInterval } from '../agreements/calendar.js';
import { integer, positiveNumber, shortText, uuid, offeringView, iso, type Row } from './data.js';
import { availableForBids } from './policy.js';
import { assertProviderCatalog } from './provider-identity.js';

type Desired = {
  cpu: number;
  memoryGb: number;
  gpu?: string;
  region: string;
  durationMinutes: number;
  maxPriceCents: number;
};
type Flexibility = {
  minCPU: number;
  minMemoryGb: number;
  allowedRegions: string[];
  allowedDurations: number[];
  hardMaxPriceCents: number;
  gpu: 'preserve' | 'none' | 'any';
};
const requirements = (d: { cpu: number; memoryGb: number; gpu?: string }) => ({
  cpu: d.cpu,
  memoryGb: d.memoryGb,
  ...(d.gpu ? { gpu: d.gpu } : {}),
});
function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, child]) => [key, stable(child)]),
    );
  return value;
}
const hash = (value: unknown) =>
  createHash('sha256')
    .update(JSON.stringify(stable(value)))
    .digest('hex');
const operationKey = (value: unknown) => {
  const key = shortText(value, 'Operation key', 160);
  if (key.length < 8 || !/^[a-zA-Z0-9:._-]+$/.test(key))
    throw new HttpError(
      400,
      'Use a stable operation key of 8–160 letters, digits, or :._- characters.',
    );
  return key;
};
function parseDesired(value: Row): Desired {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new HttpError(400, 'Review desired resources, region, duration and budget.');
  return {
    cpu: integer(value.cpu, 'Desired CPU', 1, 1024),
    memoryGb: positiveNumber(value.memoryGb, 'Desired memory (GiB)', 16384),
    ...(value.gpu ? { gpu: shortText(value.gpu, 'Desired GPU', 120) } : {}),
    region: shortText(value.region, 'Desired region', 120),
    durationMinutes: integer(value.durationMinutes, 'Desired duration', 1, 1440),
    maxPriceCents: moneyCents(value.maxPriceCents, 'Hard budget'),
  };
}
function parseFlexibility(value: Row | undefined, d: Desired): Flexibility {
  if (value !== undefined && (!value || typeof value !== 'object' || Array.isArray(value)))
    throw new HttpError(400, 'Flexibility must contain explicit reviewed limits.');
  if (!value)
    return {
      minCPU: d.cpu,
      minMemoryGb: d.memoryGb,
      allowedRegions: [d.region],
      allowedDurations: [d.durationMinutes],
      hardMaxPriceCents: d.maxPriceCents,
      gpu: 'preserve',
    };
  const minCPU = integer(value.minCPU, 'Minimum CPU', 1, d.cpu);
  const minMemoryGb = positiveNumber(value.minMemoryGb, 'Minimum memory (GiB)', d.memoryGb);
  if (
    !Array.isArray(value.allowedRegions) ||
    !value.allowedRegions.length ||
    value.allowedRegions.length > 12
  )
    throw new HttpError(400, 'Choose 1–12 explicit allowed regions.');
  if (
    !Array.isArray(value.allowedDurations) ||
    !value.allowedDurations.length ||
    value.allowedDurations.length > 3
  )
    throw new HttpError(400, 'Choose explicit supported durations.');
  const allowedRegions = [
    ...new Set<string>(
      value.allowedRegions.map((r: unknown) => shortText(r, 'Allowed region', 120)),
    ),
  ];
  const allowedDurations = [
    ...new Set<number>(
      value.allowedDurations.map((n: unknown) => integer(n, 'Allowed duration', 15, 60)),
    ),
  ];
  if (allowedDurations.some((n) => ![15, 30, 60].includes(n)))
    throw new HttpError(400, 'Allowed rental durations are 15, 30 or 60 minutes.');
  if (!['preserve', 'none', 'any'].includes(value.gpu))
    throw new HttpError(400, 'Choose an explicit GPU constraint.');
  return {
    minCPU,
    minMemoryGb,
    allowedRegions,
    allowedDurations,
    hardMaxPriceCents: moneyCents(value.hardMaxPriceCents, 'Hard total limit', 0, d.maxPriceCents),
    gpu: value.gpu,
  };
}
const intentView = (r: Row) => ({
  id: r.id,
  description: r.description,
  desired: r.desired,
  flexibility: r.flexibility,
  sourceMode: r.source_mode,
  sourceRequestId: r.source_request_id,
  status: r.status,
  acceptedOfferId: r.accepted_offer_id,
  acceptedRequestId: r.accepted_request_id,
  createdAt: iso(r.created_at),
});
const offerView = (r: Row) => ({
  id: r.id,
  ...r.snapshot.public,
  expiresAt: iso(r.expires_at),
  mode: r.mode,
  modelCalled: r.model_called,
});
function ensureOpen(intent: Row, ctx: AppContext) {
  if (intent.source_mode !== ctx.wick.mode)
    throw new HttpError(409, 'The integration mode changed. Review a new intent.');
  if (intent.status !== 'open') throw new HttpError(409, 'This intent has already been resolved.');
}
async function ownedIntent(ctx: AppContext, actor: Actor, id: string) {
  const row = (
    await ctx.pool.query('SELECT * FROM broker_intents WHERE id=$1 AND buyer_id=$2', [
      uuid(id),
      actor.id,
    ])
  ).rows[0];
  if (!row) throw new HttpError(404, 'Intent not found.');
  return row;
}
async function lockSource(db: PoolClient, actor: Actor, sourceId?: string | null) {
  if (!sourceId) return;
  const source = (
    await db.query('SELECT * FROM broker_requests WHERE id=$1 AND buyer_id=$2 FOR UPDATE', [
      sourceId,
      actor.id,
    ])
  ).rows[0];
  if (!source) throw new HttpError(404, 'Source request not found.');
  if (!['no_offers', 'failed', 'cancelled'].includes(source.status))
    throw new HttpError(409, 'Only a finished unsuccessful request can be negotiated.');
  if (
    (
      await db.query(
        'SELECT 1 FROM broker_vms WHERE request_id=$1 AND cleanup_confirmed_at IS NULL',
        [sourceId],
      )
    ).rowCount
  )
    throw new HttpError(409, 'Wait for the original environment cleanup before negotiating.');
  return source;
}
export async function createIntent(ctx: AppContext, actor: Actor, body: Row) {
  if (!body || typeof body !== 'object' || Array.isArray(body))
    throw new HttpError(400, 'An intent body is required.');
  for (const key of ['git', 'repository', 'repo', 'task', 'command', 'agent'])
    if (key in body) throw new HttpError(400, 'Intents cannot contain workload execution fields.');
  const key = operationKey(body.operationKey);
  const description = shortText(body.description, 'Description', 4000);
  const desired = parseDesired(body.desired);
  const flexibility = parseFlexibility(body.flexibility, desired);
  const sourceId = body.sourceRequestId ? uuid(body.sourceRequestId) : null;
  return transaction(ctx.pool, async (db) => {
    const source = await lockSource(db, actor, sourceId);
    const duplicate = (
      await db.query('SELECT * FROM broker_intents WHERE buyer_id=$1 AND operation_key=$2', [
        actor.id,
        key,
      ])
    ).rows[0];
    if (duplicate) {
      if (
        hash([
          duplicate.description,
          duplicate.desired,
          duplicate.flexibility,
          duplicate.source_mode,
          duplicate.source_request_id,
        ]) !== hash([description, desired, flexibility, ctx.wick.mode, sourceId])
      )
        throw new HttpError(409, 'This operation already has a different intent.');
      return intentView(duplicate);
    }
    if (source?.resolution_request_id)
      throw new HttpError(409, 'The original request has already been resolved.');
    if (source && (source.catalog_snapshot.sourceMode ?? 'fixture') !== ctx.wick.mode)
      throw new HttpError(409, 'The original request uses another integration mode.');
    if (
      source &&
      hash(desired) !==
        hash(
          parseDesired({
            ...source.requirements,
            region: source.region,
            durationMinutes: source.duration_minutes,
            maxPriceCents: source.max_price_cents,
          }),
        )
    )
      throw new HttpError(
        400,
        'The original request requirements must remain unchanged. Review flexibility separately.',
      );
    if (body.flexibility) {
      const regions = new Set(
        (
          await db.query(
            "SELECT DISTINCT item->>'region' AS region FROM broker_catalog WHERE approved AND source_mode=$1",
            [ctx.wick.mode],
          )
        ).rows.map((r) => r.region),
      );
      if (flexibility.allowedRegions.some((r) => !regions.has(r)))
        throw new HttpError(
          400,
          'Explicit flexible regions must be supported by the approved catalog.',
        );
    }
    const inserted = (
      await db.query(
        `INSERT INTO broker_intents(buyer_id,operation_key,description,desired,flexibility,source_mode,source_request_id) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING RETURNING *`,
        [actor.id, key, description, desired, flexibility, ctx.wick.mode, sourceId],
      )
    ).rows[0];
    if (inserted) {
      await recordKeyAction(db, actor, 'intents.create', key, inserted.id);
      return intentView(inserted);
    }
    const existing = (
      await db.query('SELECT * FROM broker_intents WHERE buyer_id=$1 AND operation_key=$2', [
        actor.id,
        key,
      ])
    ).rows[0];
    if (
      !existing ||
      hash([
        existing.description,
        existing.desired,
        existing.flexibility,
        existing.source_mode,
        existing.source_request_id,
      ]) !== hash([description, desired, flexibility, ctx.wick.mode, sourceId])
    )
      throw new HttpError(409, 'This operation or source request already has a different intent.');
    return intentView(existing);
  });
}
export async function getIntent(ctx: AppContext, actor: Actor, id: string) {
  const intent = await ownedIntent(ctx, actor, id);
  const offers = (
    await ctx.pool.query(
      'SELECT * FROM broker_counteroffers WHERE intent_id=$1 ORDER BY created_at DESC,id LIMIT 30',
      [intent.id],
    )
  ).rows;
  return { intent: intentView(intent), offers: offers.map(offerView) };
}
function feasible(item: CatalogItem, duration: number, d: Desired, f: Flexibility) {
  return (
    item.cpu >= f.minCPU &&
    item.memoryGb >= f.minMemoryGb &&
    f.allowedRegions.includes(item.region) &&
    f.allowedDurations.includes(duration) &&
    item.durationMinutes.includes(duration) &&
    (f.gpu === 'any'
      ? Boolean(item.gpu)
      : f.gpu === 'none'
        ? !item.gpu
        : (item.gpu ?? '') === (d.gpu ?? ''))
  );
}
function publicChanges(d: Desired, after: Desired) {
  const changes: string[] = [];
  for (const [key, label] of [
    ['cpu', 'CPU'],
    ['memoryGb', 'Memory (GiB)'],
    ['gpu', 'GPU'],
    ['region', 'Region'],
    ['durationMinutes', 'Duration (minutes)'],
    ['maxPriceCents', 'Maximum total budget (USD cents)'],
  ] as const)
    if ((d[key] ?? 'none') !== (after[key] ?? 'none'))
      changes.push(`${label}: ${d[key] ?? 'none'} → ${after[key] ?? 'none'}.`);
  return changes.length ? changes : ['Requested resources, region and duration are preserved.'];
}
function catalogIdentity(item: CatalogItem) {
  return {
    id: item.id,
    provider: item.provider,
    profile: item.profile,
    region: item.region,
    cpu: item.cpu,
    memoryGb: item.memoryGb,
    gpu: item.gpu ?? null,
    durationMinutes: [...item.durationMinutes].sort(),
    organizationId: item.organizationId ?? null,
    groupId: item.groupId ?? null,
    providerKeyId: item.providerKeyId ?? null,
    rateMicrosPerSecond: item.rateMicrosPerSecond ?? null,
    pricingMode: item.pricingMode ?? null,
    managedRouteVerification: item.managedRouteVerification ?? null,
  };
}
function quoteCandidate(
  ctx: AppContext,
  p: Row,
  offering: Row,
  item: CatalogItem,
  duration: number,
) {
  let pricing;
  let price = offering.price_cents;
  if (ctx.wick.mode === 'real') {
    if (!offering.pricing) throw new HttpError(409, 'A current managed-rate offering is required.');
    requireCurrentRate(offering.pricing, item);
    const target = fixedQuote(commissionPricing(offering.pricing), duration);
    price = target.totalPriceCents;
    pricing = acceptedBidQuote(
      offering.pricing,
      duration,
      Math.max(price, p.policy.minimumPriceCents),
    );
  }
  price = Math.max(price, p.policy.minimumPriceCents, pricing?.upstreamCostFloorCents ?? 0);
  if (
    !isMoneyCents(price) ||
    price < 0 ||
    price > 100000000 ||
    (p.policy.maxPriceCents !== undefined && price > p.policy.maxPriceCents)
  )
    return;
  return {
    totalPriceCents: price,
    revenueShare: revenueShare(price),
    ...(pricing ? { pricing } : {}),
  };
}
type ProposalResult = Awaited<ReturnType<typeof getIntent>>;
function proposalResult(intent: Row, offers: Row[]): ProposalResult {
  return {
    intent: intentView(intent),
    offers: offers
      .sort(
        (a, b) =>
          a.snapshot.public.totalPriceCents - b.snapshot.public.totalPriceCents ||
          a.id.localeCompare(b.id),
      )
      .map(offerView),
  };
}

type ProposalState = {
  pending: Map<string, Promise<ProposalResult>>;
  cache: Map<string, { fingerprint: string; expiresAt: number; offerIds: string[] }>;
};
// One app process: in-flight work is shared only within the authenticated buyer/intent.
// A short, bounded cache also covers a model decision to propose no alternatives.
const proposalStates = new WeakMap<AppContext, ProposalState>();
export async function proposeCounteroffers(ctx: AppContext, actor: Actor, id: string) {
  const intent = await ownedIntent(ctx, actor, id);
  ensureOpen(intent, ctx);
  let state = proposalStates.get(ctx);
  if (!state) {
    state = { pending: new Map(), cache: new Map() };
    proposalStates.set(ctx, state);
  }
  const key = `${ctx.wick.mode}:${actor.id}:${intent.id}`;
  const pending = state.pending.get(key);
  if (pending) return pending;
  if (state.pending.size >= 128)
    throw new HttpError(429, 'Muse suggestions are busy. Try again shortly.');
  const work = generateCounteroffers(ctx, actor, intent, state, key);
  state.pending.set(key, work);
  try {
    return await work;
  } finally {
    state.pending.delete(key);
  }
}
async function generateCounteroffers(
  ctx: AppContext,
  actor: Actor,
  intent: Row,
  state: ProposalState,
  key: string,
): Promise<ProposalResult> {
  const desired = intent.desired as Desired,
    flex = intent.flexibility as Flexibility;
  // One bounded SQL projection; provider private policy never crosses provider boundaries.
  const rows = (
    await ctx.pool.query(
      `WITH candidates AS (
    SELECT p.*,(SELECT count(*)::int FROM broker_holds h WHERE h.provider_id=p.id AND h.released_at IS NULL) AS held
    FROM broker_providers p WHERE p.policy->>'autoBid'='true' AND EXISTS(
      SELECT 1 FROM broker_catalog c JOIN LATERAL(
        SELECT 1 FROM broker_offerings o WHERE o.provider_id=p.id AND o.catalog_id=c.id AND o.active ORDER BY o.price_cents,o.id LIMIT 1
      ) published ON true WHERE c.approved AND c.source_mode=$1
        AND (p.cloud_provider IS NULL OR c.item->>'provider'=p.cloud_provider)
        AND (p.policy->'allowedCatalogIds' IS NULL OR p.policy->'allowedCatalogIds'='null'::jsonb OR p.policy->'allowedCatalogIds' ? c.id)
    ) ORDER BY p.id LIMIT 4)
    SELECT row_to_json(p) AS provider,row_to_json(o) AS offering,c.item FROM candidates p CROSS JOIN LATERAL(
      SELECT published.* FROM broker_catalog c JOIN LATERAL(
        SELECT o.* FROM broker_offerings o WHERE o.provider_id=p.id AND o.catalog_id=c.id AND o.active ORDER BY o.price_cents,o.id LIMIT 1
      ) published ON true WHERE c.approved AND c.source_mode=$1
        AND (p.cloud_provider IS NULL OR c.item->>'provider'=p.cloud_provider)
        AND (p.policy->'allowedCatalogIds' IS NULL OR p.policy->'allowedCatalogIds'='null'::jsonb OR p.policy->'allowedCatalogIds' ? c.id)
      ORDER BY published.price_cents,published.id LIMIT 12
    ) o JOIN broker_catalog c ON c.id=o.catalog_id AND c.approved AND c.source_mode=$1 ORDER BY p.id,o.id LIMIT 48`,
      [ctx.wick.mode],
    )
  ).rows;
  const groups = new Map<string, { provider: Row; candidates: Row[] }>();
  for (const row of rows) {
    const p = row.provider,
      offering = row.offering,
      item = row.item as CatalogItem;
    if (ctx.wick.mode === 'real' && item.provider === 'boat') continue;
    if (p.cloud_provider && p.cloud_provider !== item.provider) continue;
    if (
      p.policy.autoBid !== true ||
      availableForBids(p.total_capacity, p.held, p.policy) < 1 ||
      (p.policy.allowedCatalogIds && !p.policy.allowedCatalogIds.includes(item.id))
    )
      continue;
    const group: { provider: Row; candidates: Row[] } = groups.get(p.id) ?? {
      provider: p,
      candidates: [],
    };
    for (const duration of item.durationMinutes) {
      if (group.candidates.length >= 12 || !feasible(item, duration, desired, flex)) continue;
      let quote;
      try {
        quote = quoteCandidate(ctx, p, offering, item, duration);
      } catch {
        continue;
      }
      if (
        !quote ||
        quote.totalPriceCents > flex.hardMaxPriceCents ||
        quote.totalPriceCents > desired.maxPriceCents
      )
        continue;
      const after: Desired = {
        ...requirements(item),
        region: item.region,
        durationMinutes: duration,
        maxPriceCents: flex.hardMaxPriceCents,
      };
      const candidate = {
        providerId: p.id,
        offeringId: offering.id,
        offeringRevision: offering.revision,
        offeringPriceCents: offering.price_cents,
        policyRevision: p.policy_revision,
        catalog: item,
        catalogIdentity: catalogIdentity(item),
        ...quote,
        after,
        public: {
          providerName: p.name,
          simulated: p.simulated,
          cloudProvider: item.provider,
          catalogId: item.id,
          catalogName: item.name,
          offeringId: offering.id,
          before: desired,
          after,
          totalPriceCents: quote.totalPriceCents,
          tradeoffs: publicChanges(desired, after),
          ...(quote.pricing ? { pricing: quote.pricing } : {}),
        },
      };
      group.candidates.push({ ...candidate, id: hash(candidate) });
    }
    if (group.candidates.length) groups.set(p.id, group);
  }
  const selected: { candidate: Row; mode: Mode; modelCalled: boolean }[] = [];
  const bounded = [...groups.values()];
  const fingerprint = hash(
    bounded.map(({ provider, candidates }) => ({
      providerId: provider.id,
      policyRevision: provider.policy_revision,
      held: provider.held,
      candidates: candidates.map((c) => c.id),
    })),
  );
  const now = Date.now();
  for (const [cacheKey, entry] of state.cache)
    if (entry.expiresAt <= now) state.cache.delete(cacheKey);
  const cached = state.cache.get(key);
  if (cached?.fingerprint === fingerprint) {
    const offers = (
      await ctx.pool.query(
        'SELECT * FROM broker_counteroffers WHERE intent_id=$1 AND id=ANY($2::uuid[]) AND expires_at>clock_timestamp() ORDER BY created_at DESC,id LIMIT 3',
        [intent.id, cached.offerIds],
      )
    ).rows;
    if (offers.length === cached.offerIds.length) return proposalResult(intent, offers);
  }
  for (let offset = 0; offset < bounded.length; offset += 2) {
    const results = await Promise.all(
      bounded.slice(offset, offset + 2).map(async ({ provider, candidates }) => {
        const response = await ctx.muse.selectCounteroffers({
          requirements: {
            requirements: requirements(desired),
            region: desired.region,
            durationMinutes: desired.durationMinutes,
            maxPriceCents: flex.hardMaxPriceCents,
          },
          policy: provider.policy,
          capacity: {
            total: provider.total_capacity,
            held: provider.held,
            available: availableForBids(provider.total_capacity, provider.held, provider.policy),
          },
          candidates: candidates.map((c) => ({
            id: c.id,
            catalogId: c.catalog.id,
            region: c.after.region,
            durationMinutes: c.after.durationMinutes,
            requirements: requirements(c.after),
            totalPriceCents: c.totalPriceCents,
          })),
        });
        if (
          !Array.isArray(response.selections) ||
          response.selections.length > 3 ||
          new Set(response.selections.map((s) => s.candidateId)).size !== response.selections.length
        )
          throw new HttpError(422, 'Muse returned invalid candidate selections.');
        return response.selections.map((selection) => {
          const candidate = candidates.find((c) => c.id === selection.candidateId);
          if (!candidate) throw new HttpError(422, 'Muse selected an unsupported candidate.');
          return { candidate, mode: response.mode, modelCalled: response.modelCalled };
        });
      }),
    );
    selected.push(...results.flat());
  }
  // Persist only bounded deterministic public alternatives. No reservation, auction or Wick call.
  const persistedResult = await transaction(ctx.pool, async (db) => {
    const current = (
      await db.query('SELECT * FROM broker_intents WHERE id=$1 AND buyer_id=$2 FOR UPDATE', [
        intent.id,
        actor.id,
      ])
    ).rows[0];
    ensureOpen(current, ctx);
    const persisted: Row[] = [];
    for (const { candidate, mode, modelCalled } of selected
      .sort((a, b) => a.candidate.totalPriceCents - b.candidate.totalPriceCents)
      .slice(0, 3)) {
      const provider = (
        await db.query('SELECT * FROM broker_providers WHERE id=$1 FOR SHARE', [
          candidate.providerId,
        ])
      ).rows[0];
      if (
        !provider ||
        provider.policy.autoBid !== true ||
        provider.policy_revision !== candidate.policyRevision
      )
        continue;
      const inserted = (
        await db.query(
          `INSERT INTO broker_counteroffers(intent_id,provider_id,offering_id,candidate_key,snapshot,mode,model_called) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(intent_id,candidate_key) DO NOTHING RETURNING *`,
          [
            intent.id,
            candidate.providerId,
            candidate.offeringId,
            candidate.id,
            candidate,
            mode,
            modelCalled,
          ],
        )
      ).rows[0];
      const stored =
        inserted ??
        (
          await db.query(
            `UPDATE broker_counteroffers SET expires_at=CASE WHEN expires_at<=clock_timestamp() THEN clock_timestamp()+interval '5 minutes' ELSE expires_at END WHERE intent_id=$1 AND candidate_key=$2 RETURNING *`,
            [intent.id, candidate.id],
          )
        ).rows[0];
      persisted.push(stored);
      if (inserted)
        await activity(
          db,
          provider.id,
          null,
          'counteroffer_proposed',
          'Counteroffer proposed; waiting for explicit buyer acceptance. No slot is held.',
          {
            mode,
            modelCalled,
            receipt: {
              observed: [
                `${candidate.catalog.name}; ${candidate.after.durationMinutes} minutes; fixed total ${candidate.totalPriceCents} USD cents.`,
                `Approved policy revision ${provider.policy_revision}; minimum total ${provider.policy.minimumPriceCents} USD cents; ${provider.policy.reserveSlots ?? 0} spare slots protected.`,
              ],
              decision:
                'Proposed a supported alternative within the buyer’s reviewed flexibility and your approved automatic limits.',
              constraints: [
                'Explicit buyer acceptance is required.',
                'Proposal reserves no capacity and creates no environment.',
              ],
            },
          },
        );
    }
    return persisted;
  }).then((offers) => {
    if (state.cache.size >= 256 && !state.cache.has(key))
      state.cache.delete(state.cache.keys().next().value!);
    state.cache.set(key, {
      fingerprint,
      expiresAt: Date.now() + 30_000,
      offerIds: offers.map((o) => o.id),
    });
    return proposalResult(intent, offers);
  });
  return persistedResult;
}

export async function acceptCounteroffer(
  ctx: AppContext,
  actor: Actor,
  id: string,
  offerId: string,
  body: Row,
) {
  const key = operationKey(body?.operationKey);
  const initial = await ownedIntent(ctx, actor, id);
  enforceKeyLimit(actor.apiKey, 'maxAuctionCents', initial.flexibility.hardMaxPriceCents);
  uuid(offerId);
  return transaction(ctx.pool, async (db) => {
    await db.query("SELECT pg_advisory_xact_lock(hashtext('broker-global-vm-admission'))");
    const source = await lockSource(db, actor, initial.source_request_id);
    const intent = (
      await db.query('SELECT * FROM broker_intents WHERE id=$1 AND buyer_id=$2 FOR UPDATE', [
        initial.id,
        actor.id,
      ])
    ).rows[0];
    if (intent.status === 'accepted') {
      if (intent.accepted_offer_id !== offerId || intent.acceptance_key !== key)
        throw new HttpError(
          409,
          'A different alternative or operation already resolved this intent.',
        );
      const vm = (
        await db.query('SELECT id,bid_id FROM broker_vms WHERE request_id=$1', [
          intent.accepted_request_id,
        ])
      ).rows[0];
      return { requestId: intent.accepted_request_id, vmId: vm.id, winningBidId: vm.bid_id };
    }
    ensureOpen(intent, ctx);
    if (source?.resolution_request_id)
      throw new HttpError(409, 'The original request has already been resolved.');
    const offer = (
      await db.query(
        'SELECT * FROM broker_counteroffers WHERE id=$1 AND intent_id=$2 AND expires_at>clock_timestamp() FOR SHARE',
        [offerId, intent.id],
      )
    ).rows[0];
    if (!offer)
      throw new HttpError(
        409,
        'This alternative expired or does not belong to your intent. Request new suggestions.',
      );
    const snap = offer.snapshot;
    const p = (
      await db.query('SELECT * FROM broker_providers WHERE id=$1 FOR UPDATE', [offer.provider_id])
    ).rows[0];
    if (p.policy.autoBid !== true)
      throw new HttpError(409, 'This provider paused automatic bids and counteroffers.');
    const offering = (
      await db.query('SELECT * FROM broker_offerings WHERE id=$1 AND provider_id=$2 FOR SHARE', [
        offer.offering_id,
        p.id,
      ])
    ).rows[0];
    const catalog = (
      await db.query(
        'SELECT item,approved FROM broker_catalog WHERE id=$1 AND source_mode=$2 FOR SHARE',
        [snap.catalog.id, ctx.wick.mode],
      )
    ).rows[0];
    if (
      !catalog?.approved ||
      !offering?.active ||
      offering.catalog_id !== snap.catalog.id ||
      offering.revision !== snap.offeringRevision ||
      offering.price_cents !== snap.offeringPriceCents ||
      p.policy_revision !== snap.policyRevision ||
      hash(catalogIdentity(catalog.item)) !== hash(snap.catalogIdentity)
    )
      throw new HttpError(
        409,
        'The reviewed offering, catalog or provider limits changed. Review a new alternative.',
      );
    if (ctx.wick.mode === 'real' && catalog.item.provider === 'boat')
      throw new HttpError(409, 'This provider is unavailable for customer rentals.');
    assertProviderCatalog(p, catalog.item);
    if (p.policy.allowedCatalogIds && !p.policy.allowedCatalogIds.includes(catalog.item.id))
      throw new HttpError(409, 'The provider no longer permits this configuration.');
    if (
      !feasible(catalog.item, snap.after.durationMinutes, intent.desired, intent.flexibility) ||
      snap.totalPriceCents > intent.desired.maxPriceCents ||
      snap.totalPriceCents > intent.flexibility.hardMaxPriceCents
    )
      throw new HttpError(409, 'The alternative exceeds your reviewed flexibility or budget.');
    let quote;
    try {
      quote = quoteCandidate(ctx, p, offering, catalog.item, snap.after.durationMinutes);
    } catch {
      throw new HttpError(409, 'The managed rate is stale or changed. Review a new alternative.');
    }
    if (
      !quote ||
      quote.totalPriceCents !== snap.totalPriceCents ||
      hash(snap.revenueShare ?? null) !== hash(quote.revenueShare)
    )
      throw new HttpError(
        409,
        'The reviewed fixed total or provider commission changed. Review a new alternative.',
      );
    const reviewedAfter: Desired = {
      ...requirements(catalog.item),
      region: catalog.item.region,
      durationMinutes: snap.after.durationMinutes,
      maxPriceCents: intent.flexibility.hardMaxPriceCents,
    };
    if (hash(snap.after) !== hash(reviewedAfter))
      throw new HttpError(
        409,
        'The reviewed alternative specification is invalid. Review a new alternative.',
      );
    const held = Number(
      (
        await db.query(
          'SELECT count(*)::int AS n FROM broker_holds WHERE provider_id=$1 AND released_at IS NULL',
          [p.id],
        )
      ).rows[0].n,
    );
    if (availableForBids(p.total_capacity, held, p.policy) < 1)
      throw new HttpError(409, 'The provider no longer has an available slot.');
    const interval = instantReservationInterval({ duration_minutes: snap.after.durationMinutes });
    if ((await availableForInterval(ctx, db, p.id, interval.startsAt, interval.endsAt)) < 1)
      throw new HttpError(409, 'This rental would overlap already booked capacity.');
    if (!(await globalAdmissionAvailable(ctx, db)))
      throw new HttpError(409, 'The concurrent VM limit is reached. No reservation was created.');
    if (
      !(
        await db.query(
          'SELECT expires_at>clock_timestamp() AS valid FROM broker_counteroffers WHERE id=$1',
          [offer.id],
        )
      ).rows[0]?.valid
    )
      throw new HttpError(
        409,
        'This alternative expired while capacity was checked. Review a new alternative.',
      );
    // Time-based rate validity must also survive waits for provider/global locks.
    try {
      quoteCandidate(ctx, p, offering, catalog.item, snap.after.durationMinutes);
    } catch {
      throw new HttpError(409, 'The managed rate became stale. Review a new alternative.');
    }
    const pricing = ctx.wick.mode === 'real' ? managedPricing(catalog.item) : undefined;
    const request = (
      await db.query(
        `INSERT INTO broker_requests(buyer_id,description,catalog_id,catalog_snapshot,region,duration_minutes,max_price_cents,requirements,prior_request_id,negotiation_intent_id,source_api_key_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
        [
          actor.id,
          intent.description,
          catalog.item.id,
          {
            ...catalog.item,
            approved: true,
            sourceMode: ctx.wick.mode,
            ...(pricing ? { pricing } : {}),
          },
          catalog.item.region,
          snap.after.durationMinutes,
          intent.flexibility.hardMaxPriceCents,
          requirements(reviewedAfter),
          source?.id ?? null,
          intent.id,
          actor.apiKey?.id ?? null,
        ],
      )
    ).rows[0];
    const bid = (
      await db.query(
        `INSERT INTO broker_bids(request_id,provider_id,offering_id,offering_snapshot,total_price_cents) VALUES($1,$2,$3,$4,$5) RETURNING *`,
        [
          request.id,
          p.id,
          offering.id,
          {
            ...offeringView(offering),
            simulated: p.simulated,
            cloudProvider: p.cloud_provider,
            catalog: request.catalog_snapshot,
            revenueShare: revenueShare(snap.totalPriceCents),
            ...(quote.pricing ? { pricing: quote.pricing } : {}),
          },
          snap.totalPriceCents,
        ],
      )
    ).rows[0];
    await db.query('INSERT INTO broker_holds(bid_id,provider_id) VALUES($1,$2)', [bid.id, p.id]);
    const awarded = await awardHeldBid(ctx, db, request, bid);
    await recordKeyAction(db, actor, 'intents.accept', key, request.id);
    await activity(
      db,
      p.id,
      request.id,
      'counteroffer_accepted',
      'Buyer accepted the reviewed counteroffer; the fixed quote is frozen and provisioning is queued.',
      {
        mode: offer.mode,
        modelCalled: offer.model_called,
        receipt: {
          observed: [
            `${catalog.item.name}; ${snap.after.durationMinutes} minutes; fixed total ${snap.totalPriceCents} USD cents.`,
            `Approved policy revision ${p.policy_revision}; ${p.policy.reserveSlots ?? 0} spare slots protected.`,
          ],
          decision:
            'Accepted the buyer-approved alternative under your active automatic bids and counteroffers policy.',
          constraints: [
            'Provider floor, spare capacity and global admission revalidated.',
            'One frozen quote and capacity hold; normal provisioning and cleanup apply.',
          ],
        },
      },
    );
    await db.query(
      "UPDATE broker_intents SET status='accepted',accepted_offer_id=$2,accepted_request_id=$3,acceptance_key=$4 WHERE id=$1",
      [intent.id, offerId, request.id, key],
    );
    if (source)
      await db.query('UPDATE broker_requests SET resolution_request_id=$2 WHERE id=$1', [
        source.id,
        request.id,
      ]);
    return { requestId: request.id, ...awarded };
  });
}
export function registerNegotiation(app: FastifyInstance, ctx: AppContext) {
  const calls = new Map<string, { count: number; resetsAt: number }>();
  function rateLimit(actorId: string) {
    const now = Date.now();
    for (const [id, entry] of calls) if (entry.resetsAt <= now) calls.delete(id);
    const entry = calls.get(actorId) ?? { count: 0, resetsAt: now + 60_000 };
    if (entry.count >= 10 || (calls.size >= 1000 && !calls.has(actorId)))
      throw new HttpError(429, 'Muse suggestion limit reached. Try again in a minute.');
    entry.count += 1;
    calls.set(actorId, entry);
  }
  app.post('/api/intents', async (request) =>
    createIntent(ctx, await ctx.requireActor(request, ['buyer']), request.body as Row),
  );
  app.get('/api/intents', async (request) => {
    const actor = await ctx.requireActor(request, ['buyer']);
    return {
      items: (
        await ctx.pool.query(
          'SELECT * FROM broker_intents WHERE buyer_id=$1 ORDER BY created_at DESC,id DESC LIMIT 30',
          [actor.id],
        )
      ).rows.map(intentView),
    };
  });
  app.get<{ Params: { id: string } }>('/api/intents/:id', async (request) =>
    getIntent(ctx, await ctx.requireActor(request, ['buyer']), request.params.id),
  );
  app.post<{ Params: { id: string } }>('/api/intents/:id/propose', async (request) => {
    const actor = await ctx.requireActor(request, ['buyer']);
    rateLimit(actor.id);
    return proposeCounteroffers(ctx, actor, request.params.id);
  });
  app.post<{ Params: { id: string; offerId: string } }>(
    '/api/intents/:id/offers/:offerId/accept',
    async (request) =>
      acceptCounteroffer(
        ctx,
        await ctx.requireActor(request, ['buyer']),
        request.params.id,
        request.params.offerId,
        request.body as Row,
      ),
  );
}
