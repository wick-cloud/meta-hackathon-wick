import type { Activity, Dashboard, EnvironmentRequest, Offering, ProviderEarning } from './api';
import type { InferenceCatalog, TokenOffering, TokenPack } from '../shared/inference';
import type { Receipt, SupplierPolicy } from '../shared/types';
import type { SalesReport } from '../shared/sales';
import { revenueShare } from '../shared/pricing';
import { isMoneyCents } from '../shared/money';
import { DemoError, demoCatalog, type DemoStore } from './demo-store';

const providerId = 'demo-provider';
const costFloorCents = 4;
const now = () => new Date().toISOString();
const after = (milliseconds: number) => new Date(Date.now() + milliseconds).toISOString();
const page = <T>(items: T[]) => ({ items, nextCursor: null, serverNow: now() });

export interface SellerDemoState {
  dashboard: Dashboard;
  requests: EnvironmentRequest[];
  offerings: Offering[];
  earnings: ProviderEarning[];
  inferenceCatalog: InferenceCatalog;
  inferenceOffering: TokenOffering;
  inferencePacks: TokenPack[];
  acceptedRequests: string[];
  operations: Record<string, unknown>;
}

function receipt(decision: string, observed: string[] = []): Receipt {
  return {
    observed: ['Sample marketplace data; no model or provider was called.', ...observed],
    decision,
    constraints: [
      'Keep the saved price floor.',
      'Protect spare capacity.',
      'Review changes before applying.',
    ],
  };
}

function earning(id: string, name: string, gross: number, createdAt: string): ProviderEarning {
  return {
    id,
    vmId: `vm-${id}`,
    catalogName: name,
    createdAt,
    totalCents: gross,
    revenueShare: revenueShare(gross),
    legacy: false,
    currency: 'USD',
    status: 'pilot-credit',
    label: 'Sample rental · no payout',
  };
}

export function createSellerDemoState(): SellerDemoState {
  const catalog = demoCatalog;
  const primary = catalog[0]!;
  const secondary = catalog[1] ?? primary;
  const policy: SupplierPolicy = {
    autoBid: false,
    minimumPriceCents: 6,
    basePriceCents: 10,
    maxPriceCents: 30,
    reserveSlots: 2,
    allowedCatalogIds: catalog.map((item) => item.id),
  };
  const activity: Activity[] = [
    {
      id: 'sample-activity-3',
      kind: 'vm_ready',
      message: 'Python development became ready. Your $0.0850 share was recorded.',
      createdAt: after(-15 * 60_000),
      mode: 'fixture',
      modelCalled: false,
    },
    {
      id: 'sample-activity-2',
      kind: 'offering_published',
      message: 'General purpose Linux published for new buyer requests.',
      createdAt: after(-40 * 60_000),
      mode: 'fixture',
      modelCalled: false,
    },
    {
      id: 'sample-activity-1',
      kind: 'capacity_updated',
      message: 'Allocation set to 8 VM slots with 2 spare slots protected.',
      createdAt: after(-60 * 60_000),
      mode: 'fixture',
      modelCalled: false,
    },
  ];
  const inferenceCatalog: InferenceCatalog = {
    enabled: true,
    mode: 'fixture',
    models: [
      {
        id: 'meta/muse-spark-open',
        name: 'Meta Muse Spark Open',
        publisher: 'Meta',
        contract: 'muse-spark-open-text-v1',
      },
    ],
    routes: (['modal', 'baseten'] as const).map((provider) => ({
      provider,
      mode: 'fixture',
      modelId: 'meta/muse-spark-open',
      modelName: 'Meta Muse Spark Open',
      qualified: true,
      reason: 'Sample route · no real model calls.',
      minimumInputReservation: 1000,
      minimumPackInputTokens: 1000,
      minimumOutputTokens: 1,
      maximumOutputTokens: 4096,
    })),
  };
  const inferenceOffering: TokenOffering = {
    provider: 'modal',
    revision: 1,
    active: true,
    autoBid: true,
    inputRateMicrosPerMillion: 2_000_000,
    outputRateMicrosPerMillion: 6_000_000,
    instantMarkupBps: 1000,
    minimumPriceCents: 5,
    maxOutstandingInputTokens: 10_000_000,
    maxOutstandingOutputTokens: 5_000_000,
    outstandingInputTokens: 24_000,
    outstandingOutputTokens: 4_000,
    costInputRateMicrosPerMillion: 1_250_000,
    costOutputRateMicrosPerMillion: 4_250_000,
    route: inferenceCatalog.routes[0]!,
    providerCommissionBps: 1500,
    salesStartAt: null,
    salesEndAt: null,
  };
  const pack: TokenPack = {
    id: 'sample-token-commitment',
    orderId: 'sample-token-order',
    grantId: 'sample-agent',
    provider: 'modal',
    mode: 'fixture',
    modelId: 'meta/muse-spark-open',
    status: 'active',
    inputTokens: 25_000,
    outputTokens: 4096,
    availableInputTokens: 24_000,
    availableOutputTokens: 4000,
    heldInputTokens: 0,
    heldOutputTokens: 0,
    consumedInputTokens: 1000,
    consumedOutputTokens: 96,
    retiredInputTokens: 0,
    retiredOutputTokens: 0,
    priceCents: 10,
    refundCents: 0,
    expiresAt: after(2 * 60 * 60_000),
    createdAt: after(-10 * 60_000),
    retirementReason: null,
    revenueShare: revenueShare(10),
  };
  return {
    dashboard: {
      provider: { id: providerId, name: 'Sample Cloud', simulated: true },
      policy,
      policyRevision: 1,
      capacity: { total: 8, held: 2, available: 4, free: 6, reserveSlots: 2 },
      activity,
    },
    requests: [
      {
        id: 'sample-request-python',
        description: 'API integration tests',
        catalogId: primary.id,
        region: primary.region,
        requirements: { cpu: 2, memoryGb: 4 },
        durationMinutes: 30,
        maxPriceCents: 20,
        status: 'open',
        closesAt: after(30_000),
        createdAt: now(),
        matchAcrossProviders: true,
      },
      {
        id: 'sample-request-node',
        description: 'Node.js preview environment',
        catalogId: secondary.id,
        region: secondary.region,
        requirements: { cpu: 2, memoryGb: 4 },
        durationMinutes: 30,
        maxPriceCents: 25,
        status: 'open',
        closesAt: after(30_000),
        createdAt: after(-60_000),
        matchAcrossProviders: true,
      },
    ],
    offerings: [
      {
        id: 'sample-offering-micro',
        providerId,
        catalogId: primary.id,
        name: 'General purpose Linux',
        description: 'Private Linux workspace for development, testing and agent workloads.',
        priceCents: 10,
        active: true,
        revision: 1,
        createdAt: after(-40 * 60_000),
      },
      {
        id: 'sample-offering-build',
        providerId,
        catalogId: secondary.id,
        name: 'Build and test workspace',
        description: 'A flexible environment for Python and Node.js projects.',
        priceCents: 12,
        active: true,
        revision: 1,
        createdAt: after(-30 * 60_000),
      },
    ],
    earnings: [
      earning('sample-invoice-1042', 'Python development', 10, after(-15 * 60_000)),
      earning('sample-invoice-1041', 'Node.js test runner', 8, after(-55 * 60_000)),
    ],
    inferenceCatalog,
    inferenceOffering,
    inferencePacks: [pack],
    acceptedRequests: [],
    operations: {},
  };
}

function updateCapacity(state: SellerDemoState) {
  const { capacity, policy } = state.dashboard;
  capacity.free = Math.max(0, capacity.total - capacity.held);
  capacity.reserveSlots = policy.reserveSlots ?? 0;
  capacity.available = Math.max(0, capacity.free - capacity.reserveSlots);
}

function log(state: SellerDemoState, kind: string, message: string, decision?: Receipt) {
  state.dashboard.activity.unshift({
    id: crypto.randomUUID(),
    kind,
    message,
    createdAt: now(),
    mode: 'fixture',
    modelCalled: false,
    ...(decision ? { receipt: decision } : {}),
  });
}

function expectRevision(current: number, expected: unknown) {
  if (expected !== undefined && expected !== current)
    throw new DemoError('Your saved settings changed. Refresh and review the latest values.', 409);
}

function validPrice(value: unknown, label = 'Price'): number {
  if (typeof value !== 'number' || !isMoneyCents(value) || value < 0.01 || value > 100_000_000)
    throw new DemoError(`${label} must be positive with at most four decimal places in USD.`);
  return value;
}

function validatePolicy(input: Record<string, any>, state: SellerDemoState): SupplierPolicy {
  const minimum = validPrice(input.minimumPriceCents, 'Minimum price');
  const base = validPrice(input.basePriceCents, 'Base price');
  const max =
    input.maxPriceCents == null ? undefined : validPrice(input.maxPriceCents, 'Maximum price');
  const spare = input.reserveSlots ?? 0;
  if (minimum < costFloorCents || base < minimum || (max !== undefined && max < base))
    throw new DemoError(
      'Keep the sample cost floor of $0.0400, set the base at or above your floor, and keep the maximum at or above the base.',
    );
  if (!Number.isInteger(spare) || spare < 0 || spare > state.dashboard.capacity.total)
    throw new DemoError('Spare slots must be a whole number within your configured allocation.');
  const ids = input.allowedCatalogIds ?? demoCatalog.map((item) => item.id);
  if (
    !Array.isArray(ids) ||
    !ids.length ||
    ids.some((id) => !demoCatalog.some((item) => item.id === id))
  )
    throw new DemoError('Select at least one approved sample configuration.');
  return {
    autoBid: input.autoBid === true,
    minimumPriceCents: minimum,
    basePriceCents: base,
    ...(max === undefined ? {} : { maxPriceCents: max }),
    reserveSlots: spare,
    allowedCatalogIds: [...ids],
  };
}

function sampleRecommendations(state: SellerDemoState): SalesReport {
  const { policy, capacity, policyRevision } = state.dashboard;
  const proposedBase = Math.max(
    policy.minimumPriceCents,
    Math.round(policy.basePriceCents * 90) / 100,
  );
  return {
    providerId,
    generatedAt: now(),
    baseRevision: policyRevision,
    currentPolicy: { ...policy },
    capacity: { ...capacity },
    mode: 'fixture',
    sourceMode: 'fixture',
    modelCalled: false,
    summary:
      'Your sample offering matches recent development workloads. Review options that keep your price floor and spare slots intact.',
    catalogNames: Object.fromEntries(demoCatalog.map((item) => [item.id, item.name])),
    evidence: [
      {
        id: 'demand',
        label: 'Recent demand',
        detail: 'Six of ten sample requests match the current configuration and base price.',
      },
      {
        id: 'capacity',
        label: 'Available allocation',
        detail: `${capacity.available} slots are available after ${policy.reserveSlots ?? 0} spare slots are protected.`,
      },
      {
        id: 'automation',
        label: 'Automatic bidding',
        detail: policy.autoBid
          ? 'Automatic bidding is enabled within your saved limits.'
          : 'Automatic bidding is paused; eligible requests require a manual response.',
      },
    ],
    recommendations: [
      ...(!policy.autoBid
        ? [
            {
              id: 'enable-bids',
              title: 'Respond automatically to eligible requests',
              description:
                'Enable automatic bidding while keeping your current prices and spare slots.',
              policy: { ...policy, autoBid: true },
              comparison: { sampledRequests: 10, currentMatches: 6, proposedMatches: 6 },
              evidenceIds: ['automation', 'capacity'],
              explanation:
                'Respond to suitable sample requests while keeping every existing price and capacity guard.',
            },
          ]
        : []),
      ...(proposedBase < policy.basePriceCents
        ? [
            {
              id: 'lower-base',
              title: 'Review a lower base price',
              description: 'Reduce the base by up to 10% without moving your price floor.',
              policy: { ...policy, basePriceCents: proposedBase },
              comparison: { sampledRequests: 10, currentMatches: 6, proposedMatches: 8 },
              evidenceIds: ['demand', 'capacity'],
              explanation:
                'This sample comparison adds two base-price matches. It does not predict wins or revenue.',
            },
          ]
        : []),
    ],
    limitations: [
      'Illustrative data only. No model was called and no policy changed yet.',
      'Base-price matches are not predicted wins or revenue.',
      'Configured capacity is not a measurement of upstream utilization.',
    ],
  };
}

function bid(state: SellerDemoState, request: EnvironmentRequest, total: number) {
  const policy = state.dashboard.policy;
  if (state.acceptedRequests.includes(request.id) || request.status !== 'open')
    throw new DemoError('This sample auction has already closed.', 409);
  if (!state.dashboard.capacity.available)
    throw new DemoError(
      'No slots are available. Increase capacity or reduce protected spare slots before bidding.',
      409,
    );
  if (
    total < Math.max(costFloorCents, policy.minimumPriceCents) ||
    total > request.maxPriceCents ||
    (policy.maxPriceCents !== undefined && total > policy.maxPriceCents)
  )
    throw new DemoError(
      'The bid must respect your saved floor and maximum, and fit the buyer’s total budget.',
    );
  if (
    !state.offerings.some(
      (offering) =>
        offering.active &&
        policy.allowedCatalogIds?.includes(offering.catalogId) &&
        (request.matchAcrossProviders || offering.catalogId === request.catalogId),
    )
  )
    throw new DemoError('Publish a compatible offering under your saved policy before bidding.');
  const id = crypto.randomUUID();
  state.acceptedRequests.push(request.id);
  request.status = 'ready';
  request.closesAt = now();
  const won = total < 12;
  if (won) {
    request.winningBidId = id;
    state.dashboard.capacity.held += 1;
    updateCapacity(state);
    state.earnings.unshift(earning(`demo-${id}`, request.description, total, now()));
    log(
      state,
      'vm_ready',
      `${request.description}: sample auction awarded at $${(total / 100).toFixed(4)}. Simulated VM readiness confirmed; your 85% share is recorded.`,
      receipt('Winning bid recorded; one slot remains reserved.', [
        'An illustrative competing bid was $0.1200.',
        'No real VM was allocated.',
      ]),
    );
  } else {
    log(
      state,
      'bid_lost',
      `${request.description}: an earlier $0.1200 sample bid won. Your capacity hold was released.`,
      receipt('Competing bid won; no earnings were recorded.', [
        'Lowest eligible total wins; the earlier accepted bid wins a tie.',
      ]),
    );
  }
  return { id, requestId: request.id, totalPriceCents: total, status: won ? 'won' : 'lost' };
}

/** All seller data and writes are held only in this tab's demo store. */
export function handleSellerDemo(
  method: string,
  path: string,
  body: Record<string, any>,
  store: DemoStore,
): unknown | undefined {
  const state = (store.seller ??= createSellerDemoState()) as SellerDemoState;
  const pathname = new URL(path, 'https://demo.invalid').pathname;
  const operationKey =
    typeof body.operationKey === 'string' ? `${pathname}:${body.operationKey}` : '';
  if (method !== 'GET' && operationKey && Object.hasOwn(state.operations, operationKey))
    return state.operations[operationKey];
  const remember = (result: unknown) => {
    if (operationKey) state.operations[operationKey] = structuredClone(result);
    return result;
  };
  if (method === 'GET' && pathname === '/api/provider/dashboard') {
    updateCapacity(state);
    return state.dashboard;
  }
  if (method === 'GET' && pathname === '/api/provider/activity')
    return page(state.dashboard.activity);
  if (method === 'GET' && pathname === '/api/provider/earnings') return page(state.earnings);
  if (method === 'GET' && pathname === '/api/provider/agreement-charges') return page([]);
  if (method === 'GET' && pathname === '/api/provider/offerings') return page(state.offerings);
  if (method === 'GET' && pathname === '/api/provider/requests') {
    // An unbid sample request repeats each cycle, so visitors can explore other pages first.
    for (const request of state.requests)
      if (request.status === 'open' && Date.parse(request.closesAt) < Date.now())
        request.closesAt = after(30_000);
    return page(state.requests);
  }
  if (method === 'PUT' && pathname === '/api/provider/capacity') {
    expectRevision(state.dashboard.policyRevision, body.expectedRevision);
    if (
      !Number.isInteger(body.total) ||
      body.total < state.dashboard.capacity.held ||
      body.total > 100
    )
      throw new DemoError(
        `Total capacity must be a whole number between ${state.dashboard.capacity.held} and 100. Existing holds must fit.`,
      );
    state.dashboard.capacity.total = body.total;
    state.dashboard.policyRevision += 1;
    updateCapacity(state);
    log(
      state,
      'capacity_updated',
      `Configured allocation updated to ${body.total} slots. Existing reservations are preserved.`,
    );
    store.completed.push('capacity');
    return remember({
      ...state.dashboard.capacity,
      policyRevision: state.dashboard.policyRevision,
    });
  }
  if (method === 'PUT' && pathname === '/api/provider/policy') {
    expectRevision(state.dashboard.policyRevision, body.expectedRevision);
    if (body.expectedProviderId && body.expectedProviderId !== providerId)
      throw new DemoError('This proposal belongs to another account.', 409);
    state.dashboard.policy = validatePolicy(body, state);
    state.dashboard.policyRevision += 1;
    updateCapacity(state);
    log(
      state,
      'policy_updated',
      'Saved bidding policy updated. Accepted prices and reservations are unchanged.',
    );
    store.completed.push('policy');
    return remember({
      policy: state.dashboard.policy,
      policyRevision: state.dashboard.policyRevision,
    });
  }
  if (method === 'POST' && pathname === '/api/provider/policy/propose') {
    const policy = { ...state.dashboard.policy, autoBid: true };
    const spare = /(?:keep|reserve)\s+(\d+)\s+(?:slots?|machines?)/i.exec(
      String(body.strategy ?? ''),
    );
    if (spare) policy.reserveSlots = Math.min(state.dashboard.capacity.total, Number(spare[1]));
    const floor = /(?:below|floor|minimum)\s*\$([\d.]+)/i.exec(String(body.strategy ?? ''));
    if (floor)
      policy.minimumPriceCents = Math.max(
        costFloorCents,
        Math.round(Number(floor[1]) * 10_000) / 100,
      );
    policy.basePriceCents = Math.max(policy.minimumPriceCents, policy.basePriceCents);
    if (policy.maxPriceCents !== undefined)
      policy.maxPriceCents = Math.max(policy.basePriceCents, policy.maxPriceCents);
    return {
      policy,
      baseRevision: state.dashboard.policyRevision,
      capacity: state.dashboard.capacity,
      mode: 'fixture',
      modelCalled: false,
      receipt: receipt('Enable automatic bidding within the reviewed price and capacity limits.', [
        `Requested strategy: ${String(body.strategy ?? '').slice(0, 1000)}`,
      ]),
    };
  }
  if (method === 'POST' && pathname === '/api/provider/sales/propose')
    return sampleRecommendations(state);
  if (method === 'POST' && pathname === '/api/provider/offerings/propose') {
    const selected = demoCatalog.find((item) =>
      state.dashboard.policy.allowedCatalogIds?.includes(item.id),
    );
    return {
      proposals: selected
        ? [
            {
              catalogId: selected.id,
              name: 'Agent development workspace',
              description: 'A private Linux environment for bounded development and test tasks.',
              priceCents: state.dashboard.policy.basePriceCents,
            },
          ]
        : [],
      mode: 'fixture',
      modelCalled: false,
      receipt: receipt('Offer an approved configuration at your current base price.'),
    };
  }
  if (method === 'POST' && pathname === '/api/provider/offerings') {
    if (
      !demoCatalog.some((item) => item.id === body.catalogId) ||
      !state.dashboard.policy.allowedCatalogIds?.includes(body.catalogId)
    )
      throw new DemoError('Choose an approved configuration allowed by your policy.');
    const price = validPrice(body.priceCents);
    if (price < Math.max(costFloorCents, state.dashboard.policy.minimumPriceCents))
      throw new DemoError('The offering price must meet your saved floor.');
    if (!String(body.name ?? '').trim() || !String(body.description ?? '').trim())
      throw new DemoError('Enter a name and description for the offering.');
    const offering: Offering = {
      id: crypto.randomUUID(),
      providerId,
      catalogId: body.catalogId,
      name: String(body.name).trim(),
      description: String(body.description).trim(),
      priceCents: price,
      active: true,
      revision: 1,
      createdAt: now(),
    };
    state.offerings.unshift(offering);
    log(state, 'offering_published', `${offering.name} published for compatible sample requests.`);
    store.completed.push('offerings');
    return remember(offering);
  }
  const offeringId = /^\/api\/provider\/offerings\/([^/]+)$/.exec(pathname)?.[1];
  if (method === 'PATCH' && offeringId) {
    const offering = state.offerings.find((item) => item.id === offeringId);
    if (!offering) throw new DemoError('Sample offering not found.', 404);
    if (typeof body.active !== 'boolean')
      throw new DemoError('Choose whether to publish this offering.');
    offering.active = body.active;
    offering.revision += 1;
    log(
      state,
      'offering_updated',
      `${offering.name} ${offering.active ? 'published' : 'unpublished'}. Existing accepted terms are unchanged.`,
    );
    return remember(offering);
  }
  const requestMatch = /^\/api\/provider\/requests\/([^/]+)\/(bids|propose)$/.exec(pathname);
  if (method === 'POST' && requestMatch) {
    const request = state.requests.find((item) => item.id === requestMatch[1]);
    if (!request) throw new DemoError('Sample request not found.', 404);
    if (requestMatch[2] === 'bids') {
      const result = bid(state, request, validPrice(body.totalPriceCents, 'Bid'));
      store.completed.push('requests');
      return remember(result);
    }
    const policy = state.dashboard.policy;
    const total = Math.max(policy.basePriceCents, costFloorCents);
    const eligible =
      state.dashboard.capacity.available > 0 &&
      request.status === 'open' &&
      total <= request.maxPriceCents &&
      state.offerings.some(
        (offering) => offering.active && policy.allowedCatalogIds?.includes(offering.catalogId),
      );
    return {
      decision: eligible ? 'bid' : 'decline',
      ...(eligible ? { totalPriceCents: total, catalogId: request.catalogId } : {}),
      mode: 'fixture',
      modelCalled: false,
      receipt: receipt(
        eligible
          ? 'Offer your saved base price. Review it before submitting.'
          : 'No eligible bid under the current saved limits.',
        [
          `Available slots: ${state.dashboard.capacity.available}.`,
          `Buyer maximum: $${(request.maxPriceCents / 100).toFixed(4)}.`,
        ],
      ),
    };
  }
  if (method === 'GET' && pathname === '/api/provider/inference/offering')
    return { offering: state.inferenceOffering, catalog: state.inferenceCatalog };
  if (method === 'GET' && pathname === '/api/provider/inference/packs')
    return page(state.inferencePacks);
  if (method === 'POST' && pathname === '/api/provider/inference/propose') {
    const offering = state.inferenceOffering;
    return {
      mode: 'fixture',
      modelCalled: false,
      expectedRevision: offering.revision,
      explanation:
        'Sample suggestion using your configured rates and uncommitted supply. Applying the rates only changes your draft until you save.',
      proposal: {
        inputTokens: 10_000,
        outputTokens: 2048,
        calls: Math.floor(
          Math.min(
            (offering.maxOutstandingInputTokens - offering.outstandingInputTokens) / 10_000,
            (offering.maxOutstandingOutputTokens - offering.outstandingOutputTokens) / 2048,
          ),
        ),
        estimatedPriceCents: 5,
        inputRateMicrosPerMillion: Math.max(2_500_000, offering.inputRateMicrosPerMillion),
        outputRateMicrosPerMillion: Math.max(6_000_000, offering.outputRateMicrosPerMillion),
      },
    };
  }
  if (method === 'PUT' && pathname === '/api/provider/inference/offering') {
    const offering = state.inferenceOffering;
    expectRevision(offering.revision, body.expectedRevision);
    for (const [field, minimum] of [
      ['maxOutstandingInputTokens', offering.outstandingInputTokens],
      ['maxOutstandingOutputTokens', offering.outstandingOutputTokens],
      ['inputRateMicrosPerMillion', Math.ceil(offering.costInputRateMicrosPerMillion / 0.85)],
      ['outputRateMicrosPerMillion', Math.ceil(offering.costOutputRateMicrosPerMillion / 0.85)],
      ['instantMarkupBps', 0],
    ] as const) {
      if (!Number.isSafeInteger(body[field]) || body[field] < minimum)
        throw new DemoError(
          `${field} must preserve existing commitments and cover provider costs.`,
        );
    }
    validPrice(body.minimumPriceCents, 'Minimum pack price');
    const start = body.salesStartAt ? Date.parse(body.salesStartAt) : null;
    const end = body.salesEndAt ? Date.parse(body.salesEndAt) : null;
    if (
      (start !== null && !Number.isFinite(start)) ||
      (end !== null && !Number.isFinite(end)) ||
      (start !== null && end !== null && end <= start)
    )
      throw new DemoError('Choose a valid selling window with its end after its start.');
    for (const field of [
      'active',
      'autoBid',
      'salesStartAt',
      'salesEndAt',
      'inputRateMicrosPerMillion',
      'outputRateMicrosPerMillion',
      'instantMarkupBps',
      'minimumPriceCents',
      'maxOutstandingInputTokens',
      'maxOutstandingOutputTokens',
    ] as const)
      Object.assign(offering, { [field]: body[field] });
    offering.revision += 1;
    log(
      state,
      'inference_offering_updated',
      'Token supply updated. Existing purchased packs retain their original terms.',
    );
    return remember(offering);
  }
  return undefined;
}
