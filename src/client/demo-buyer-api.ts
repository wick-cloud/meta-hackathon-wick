import { demoCatalog, DemoError, type DemoStore } from './demo-store';
import type { InferenceCatalog } from '../shared/inference';

// This adapter is only selected inside /demo/*. All records live in one tab's memory.
type RecordData = Record<string, any>;
const modelId = 'meta/muse-spark-open';
const timestamp = () => new Date().toISOString();
const future = (minutes = 120) => new Date(Date.now() + minutes * 60_000).toISOString();
const past = (minutes = 15) => new Date(Date.now() - minutes * 60_000).toISOString();
const copy = <T>(value: T): T => structuredClone(value);
const split = (grossCents: number) => ({
  commissionBps: 1500,
  grossCents,
  brokerFeeMicros: String(Math.round(grossCents * 1500)),
  providerNetMicros: String(Math.round(grossCents * 8500)),
});
export const demoInferenceCatalog: InferenceCatalog = {
  enabled: true,
  mode: 'fixture',
  models: [
    {
      id: modelId,
      name: 'Meta Muse Spark Open',
      publisher: 'Meta',
      contract: 'muse-spark-open-text-v1',
    },
  ],
  routes: ['modal', 'baseten'].map((provider) => ({
    provider: provider as 'modal' | 'baseten',
    mode: 'fixture',
    modelId,
    modelName: 'Meta Muse Spark Open',
    qualified: true,
    reason: 'Demo route. Model responses and usage are simulated.',
    minimumInputReservation: 1000,
    minimumPackInputTokens: 1000,
    minimumOutputTokens: 1,
    maximumInputReservation: 100_000,
    maximumOutputTokens: 4096,
  })),
};
function grant(id: string, name: string, fundingSource = 'agent'): RecordData {
  return {
    id,
    name,
    fundingSource,
    status: 'active',
    mode: 'fixture',
    fundedCents: 200,
    availableCents: 175,
    heldCents: 0,
    spentCents: 25,
    returnedCents: 0,
    maxPurchaseCents: 50,
    allowedProviders: ['modal', 'baseten'],
    allowInstant: true,
    expiresAt: future(),
    createdAt: past(35),
    currency: 'USD',
  };
}
function pack(
  id: string,
  orderId: string,
  grantId: string,
  fundingSource: string,
  priceCents = 5,
  inputTokens = 50_000,
  outputTokens = 10_000,
): RecordData {
  return {
    id,
    orderId,
    grantId,
    fundingSource,
    provider: 'baseten',
    mode: 'fixture',
    modelId,
    status: 'active',
    inputTokens,
    outputTokens,
    availableInputTokens: inputTokens,
    availableOutputTokens: outputTokens,
    heldInputTokens: 0,
    heldOutputTokens: 0,
    consumedInputTokens: 0,
    consumedOutputTokens: 0,
    retiredInputTokens: 0,
    retiredOutputTokens: 0,
    priceCents,
    refundCents: 0,
    expiresAt: future(),
    createdAt: timestamp(),
    retirementReason: null,
    revenueShare: split(priceCents),
  };
}
function initialState(): RecordData {
  const request = {
    id: 'demo-request-1',
    description: 'API development workspace',
    catalogId: 'demo-micro-modal',
    region: 'us-east-1',
    matchAcrossProviders: true,
    durationMinutes: 30,
    maxPriceCents: 20,
    requirements: { cpu: 2, memoryGb: 4 },
    status: 'ready',
    closesAt: past(4),
    createdAt: past(5),
    winningBidId: 'demo-bid-1',
    diskId: 'demo-disk-1',
  };
  const vm = {
    id: 'demo-vm-1',
    requestId: request.id,
    buyerId: 'demo-buyer',
    name: request.description,
    sourceMode: 'fixture',
    status: 'running',
    environmentId: 'demo-environment-1',
    expiresAt: future(25),
    readyAt: past(4),
    createdAt: past(5),
    catalogName: 'Micro VM',
    region: 'us-east-1',
    durationMinutes: 30,
    priceCents: 8,
    cleanupPending: false,
    cleanupConfirmedAt: null,
    provider: 'modal',
    providerName: 'Modal',
    cpu: 2,
    memoryGb: 4,
    gpu: null,
    billingSource: 'instant_vm',
    diskId: 'demo-disk-1',
    revenueShare: split(8),
  };
  const archivedRequest = {
    ...request,
    id: 'demo-request-0',
    description: 'Documentation preview',
    createdAt: past(90),
    closesAt: past(89),
    diskId: undefined,
    winningBidId: 'demo-bid-0',
  };
  const archivedVm = {
    ...vm,
    id: 'demo-vm-0',
    requestId: archivedRequest.id,
    name: archivedRequest.description,
    status: 'terminated',
    createdAt: past(90),
    readyAt: past(89),
    expiresAt: past(60),
    cleanupConfirmedAt: past(65),
    diskId: undefined,
    provider: 'daytona',
    providerName: 'Daytona',
    priceCents: 10,
    revenueShare: split(10),
  };
  const tokenOrder = {
    id: 'demo-token-order-1',
    grantId: 'demo-wallet-grant',
    fundingSource: 'wallet',
    mode: 'instant',
    sourceMode: 'fixture',
    status: 'awarded',
    modelId,
    inputTokens: 50_000,
    outputTokens: 10_000,
    maxTotalCents: 5,
    priceCents: 5,
    provider: 'baseten',
    closesAt: past(15),
    expiresAt: future(),
    createdAt: past(15),
    packId: 'demo-pack-1',
  };
  const firstPack = {
    ...pack('demo-pack-1', tokenOrder.id, tokenOrder.grantId, 'wallet'),
    createdAt: tokenOrder.createdAt,
    availableInputTokens: 46_800,
    availableOutputTokens: 9200,
    consumedInputTokens: 3200,
    consumedOutputTokens: 800,
  };
  return {
    next: 2,
    balanceCents: 2500,
    grants: [grant('demo-agent', 'Research assistant')],
    walletGrant: {
      ...grant('demo-wallet-grant', 'Direct wallet purchase', 'wallet'),
      fundedCents: 5,
      availableCents: 0,
      spentCents: 5,
    },
    requests: [request, archivedRequest],
    vms: [vm, archivedVm],
    bids: {
      'demo-request-1': [
        {
          id: 'demo-bid-1',
          providerId: 'demo-modal',
          providerName: 'Modal',
          cloudProvider: 'modal',
          totalPriceCents: 8,
          status: 'won',
          createdAt: past(5),
          catalogId: 'demo-micro-modal',
          catalogName: 'Micro VM',
          region: 'us-east-1',
          simulated: true,
        },
        {
          id: 'demo-bid-2',
          providerId: 'demo-daytona',
          providerName: 'Daytona',
          cloudProvider: 'daytona',
          totalPriceCents: 10,
          status: 'lost',
          createdAt: past(5),
          catalogId: 'demo-micro-daytona',
          catalogName: 'Micro VM',
          region: 'us-east-1',
          simulated: true,
        },
      ],
      'demo-request-0': [],
    },
    disks: [
      {
        id: 'demo-disk-1',
        name: 'Project workspace',
        status: 'ready',
        sourceMode: 'fixture',
        createdAt: past(120),
        updatedAt: past(5),
        cleanupPending: false,
        failureReason: null,
        workspaceCount: 1,
        attachmentCount: 1,
        canDelete: false,
      },
      {
        id: 'demo-disk-2',
        name: 'Scratch files',
        status: 'ready',
        sourceMode: 'fixture',
        createdAt: past(60),
        updatedAt: past(60),
        cleanupPending: false,
        failureReason: null,
        workspaceCount: 0,
        attachmentCount: 0,
        canDelete: true,
      },
    ],
    workspaces: [
      {
        id: 'demo-workspace-1',
        diskId: 'demo-disk-1',
        name: 'api-project',
        repositoryUrl: 'https://github.com/octocat/Hello-World',
        commitSha: 'd'.repeat(40),
        initialized: true,
        activeTaskId: null,
        status: 'available',
        createdAt: past(120),
        updatedAt: past(5),
      },
    ],
    tokenOrders: [tokenOrder],
    packs: [firstPack],
    quotes: [],
    tasks: [],
    buying: {},
    intents: [],
    ledger: [
      {
        id: 'demo-credit-1',
        kind: 'grant',
        amountCents: 2500,
        reservedDeltaCents: 0,
        operationKey: 'demo-seed',
        createdAt: past(120),
        description: 'Sample workspace credit',
      },
      {
        id: 'demo-credit-2',
        kind: 'agent_fund',
        amountCents: 0,
        reservedDeltaCents: 175,
        operationKey: 'demo-seed-agent',
        createdAt: past(35),
        description: 'Research assistant budget',
      },
    ],
  };
}
function wallet(state: RecordData) {
  const reservedCents =
    state.grants.reduce(
      (sum: number, item: RecordData) =>
        sum + (item.status === 'active' ? item.availableCents + item.heldCents : 0),
      0,
    ) +
    state.tasks
      .filter((item: RecordData) => !['completed', 'stopped', 'failed'].includes(item.status))
      .reduce((sum: number, item: RecordData) => sum + item.budgetCents, 0);
  return {
    balanceCents: state.balanceCents,
    reservedCents,
    availableCents: Math.max(0, state.balanceCents - reservedCents),
    currency: 'USD',
    kind: 'broker-pilot-credit',
    wickComputeCreditsSeparate: true,
  };
}
function required(items: RecordData[], id: string, title: string) {
  const item = items.find((record) => record.id === id);
  if (!item) throw new DemoError(`${title} not found in this demo.`, 404);
  return item;
}
function checkMoney(value: unknown, minimum = 1, maximum = 1_000_000) {
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    value < minimum ||
    value > maximum ||
    Math.abs(value * 100 - Math.round(value * 100)) > 1e-6
  )
    throw new DemoError('Enter a valid amount within the available demo budget.');
  return value;
}
function finalize(state: RecordData, store: DemoStore) {
  for (const request of state.requests) {
    if (request.status !== 'open' || Date.parse(request.closesAt) > Date.now()) continue;
    const bids = state.bids[request.id] ?? [];
    const winner = bids[0];
    request.status = winner ? 'ready' : 'no_offers';
    if (!winner) continue;
    bids.forEach((bid: RecordData, index: number) => {
      bid.status = index === 0 ? 'won' : 'lost';
    });
    request.winningBidId = winner.id;
    const item = demoCatalog.find((entry) => entry.id === winner.catalogId) ?? demoCatalog[0]!;
    state.vms.unshift({
      id: `demo-vm-${state.next++}`,
      requestId: request.id,
      buyerId: 'demo-buyer',
      name: request.description,
      sourceMode: 'fixture',
      status: 'running',
      environmentId: `demo-environment-${state.next}`,
      expiresAt: future(request.durationMinutes),
      readyAt: timestamp(),
      createdAt: timestamp(),
      catalogName: item.name,
      region: item.region,
      durationMinutes: request.durationMinutes,
      priceCents: winner.totalPriceCents,
      cleanupPending: false,
      cleanupConfirmedAt: null,
      provider: item.provider,
      providerName: winner.providerName,
      cpu: item.cpu,
      memoryGb: item.memoryGb,
      gpu: item.gpu ?? null,
      billingSource: 'instant_vm',
      diskId: request.diskId,
      revenueShare: split(winner.totalPriceCents),
    });
    if (!store.completed.includes('vm')) store.completed.push('vm');
  }
  for (const order of state.tokenOrders) {
    if (order.status !== 'open' || Date.parse(order.closesAt) > Date.now()) continue;
    completeTokenOrder(state, order, store);
  }
  for (const task of state.tasks) {
    if (task.status !== 'running' || Date.now() - Date.parse(task.createdAt) < 4000) continue;
    task.status = 'completed';
    task.spentCents = Math.min(task.budgetCents, 13);
    task.computeChargedCents = Math.min(task.spentCents, 8);
    task.modelChargedCents = task.spentCents - task.computeChargedCents;
    task.reservedCents = 0;
    task.availableCents = 0;
    task.returnedCents = task.budgetCents - task.spentCents;
    task.verifiedAt = timestamp();
    task.completedAt = timestamp();
    task.summary =
      'Sample result only: no repository was read or modified. The greeting change passed the simulated Python check.';
    task.hasPatch = true;
    state.balanceCents -= task.spentCents;
    state.ledger.unshift({
      id: `demo-ledger-${state.next++}`,
      kind: 'studio_compute',
      amountCents: -task.spentCents,
      reservedDeltaCents: -task.budgetCents,
      operationKey: task.id,
      createdAt: timestamp(),
      description: 'Sample Studio compute and model allowance',
    });
    if (!store.completed.includes('studio')) store.completed.push('studio');
  }
  for (const disk of state.disks) {
    disk.attachmentCount = state.vms.filter(
      (vm: RecordData) => vm.diskId === disk.id && vm.status === 'running',
    ).length;
    disk.canDelete = disk.status === 'ready' && disk.attachmentCount === 0;
  }
}
function completeTokenOrder(state: RecordData, order: RecordData, store: DemoStore) {
  const amount = order.priceCents ?? 5;
  if (order.maxTotalCents < amount) {
    order.status = 'no_offers';
    order.priceCents = null;
    return;
  }
  const agent =
    order.fundingSource === 'agent' ? required(state.grants, order.grantId, 'Agent') : null;
  if ((agent?.availableCents ?? wallet(state).availableCents) < amount)
    throw new DemoError('There is not enough sample credit for this purchase.');
  if (agent) {
    agent.availableCents -= amount;
    agent.spentCents += amount;
  }
  state.balanceCents -= amount;
  order.status = 'awarded';
  order.provider = order.provider ?? 'baseten';
  order.priceCents = amount;
  order.packId = `demo-pack-${state.next++}`;
  const item = pack(
    order.packId,
    order.id,
    order.grantId,
    order.fundingSource,
    amount,
    order.inputTokens,
    order.outputTokens,
  );
  item.provider = order.provider;
  item.expiresAt = order.expiresAt;
  state.packs.unshift(item);
  state.ledger.unshift({
    id: `demo-ledger-${state.next++}`,
    kind: 'token_purchase',
    amountCents: -amount,
    reservedDeltaCents: agent ? -amount : 0,
    operationKey: order.id,
    createdAt: timestamp(),
    description: 'Meta Muse token pack',
  });
  if (!store.completed.includes('tokens')) store.completed.push('tokens');
}
function createTokenOrder(body: RecordData, state: RecordData, store: DemoStore) {
  const direct = !body.grantId;
  const selectedGrant = direct ? state.walletGrant : required(state.grants, body.grantId, 'Agent');
  if (
    !direct &&
    (selectedGrant.status !== 'active' || Date.parse(selectedGrant.expiresAt) <= Date.now())
  )
    throw new DemoError('This demo agent is closed or expired.');
  const maxTotalCents = checkMoney(
    body.maxTotalCents,
    1,
    direct
      ? wallet(state).availableCents
      : Math.min(selectedGrant.availableCents, selectedGrant.maxPurchaseCents),
  );
  if (
    !Number.isInteger(body.inputTokens) ||
    !Number.isInteger(body.outputTokens) ||
    body.inputTokens < 1000 ||
    body.outputTokens < 1 ||
    body.inputTokens > 10_000_000 ||
    body.outputTokens > 1_000_000
  )
    throw new DemoError('Choose valid input and output token quantities.');
  const quote = body.quoteId
    ? state.quotes.find((item: RecordData) => item.quoteId === body.quoteId)
    : null;
  if (body.mode === 'instant' && (!quote || Date.parse(quote.expiresAt) <= Date.now()))
    throw new DemoError('Refresh the instant quotes before purchasing.');
  const order = {
    id: `demo-token-order-${state.next++}`,
    grantId: selectedGrant.id,
    fundingSource: direct ? 'wallet' : 'agent',
    mode: body.mode === 'instant' ? 'instant' : 'auction',
    sourceMode: 'fixture',
    status: 'open',
    modelId,
    inputTokens: body.inputTokens,
    outputTokens: body.outputTokens,
    maxTotalCents,
    priceCents: quote?.priceCents ?? null,
    provider: quote?.provider ?? null,
    closesAt: future(0.5),
    expiresAt: direct ? future() : selectedGrant.expiresAt,
    createdAt: timestamp(),
    packId: null,
  };
  state.tokenOrders.unshift(order);
  if (order.mode === 'instant') completeTokenOrder(state, order, store);
  return order;
}
function demoKey(store: DemoStore, name: string, extras: RecordData = {}) {
  const key = {
    id: `demo-key-${store.keys.length + 1}`,
    name,
    prefix: 'demo_only',
    scopes: [
      'account:read',
      'inference:read',
      'inference:use',
      ...(extras.grantId ? ['tokens:buy'] : []),
    ],
    limits: {},
    createdAt: timestamp(),
    expiresAt: future(),
    lastUsedAt: null,
    revokedAt: null,
    ...extras,
  };
  store.keys.unshift(key);
  return { key, token: `demo_not_a_real_api_key_${key.id}` };
}
function orders(state: RecordData) {
  return [
    ...state.requests.map((request: RecordData) => {
      const vm = state.vms.find((item: RecordData) => item.requestId === request.id);
      return {
        id: request.id,
        key: `auction:${request.id}`,
        kind: 'auction',
        reference: request.id,
        title: request.description,
        status: vm ? vm.status : request.status,
        auctionStatus: request.status,
        vmStatus: vm?.status,
        cleanupPending: false,
        createdAt: request.createdAt,
        closesAt: request.closesAt,
        expiresAt: vm?.expiresAt ?? null,
        requestedQuantity: 1,
        approvedQuantity: vm ? 1 : 0,
        runningQuantity: vm?.status === 'running' ? 1 : 0,
        bidCount: (state.bids[request.id] ?? []).length,
        amount: {
          label: vm ? 'accepted' : 'budget',
          amountCents: vm?.priceCents ?? request.maxPriceCents,
        },
        detailUrl: `/requests/${request.id}`,
        ...(vm ? { vmUrl: `/vms/${vm.id}` } : {}),
        retryUrl: `/new/vm?copy=${request.id}`,
      };
    }),
    ...state.tokenOrders.map((order: RecordData) => ({
      id: order.id,
      key: `token:${order.id}`,
      kind: 'token',
      reference: order.id,
      title: 'Meta Muse token pack',
      status: order.status,
      tokenMode: order.mode,
      modelId,
      inputTokens: order.inputTokens,
      outputTokens: order.outputTokens,
      fundingSource: order.fundingSource,
      grantId: order.grantId,
      cleanupPending: false,
      createdAt: order.createdAt,
      closesAt: order.closesAt,
      expiresAt: order.expiresAt,
      requestedQuantity: 1,
      approvedQuantity: order.status === 'awarded' ? 1 : 0,
      runningQuantity: 0,
      bidCount: order.status === 'awarded' ? 2 : 0,
      amount: {
        label: order.priceCents !== null ? 'accepted' : 'budget',
        amountCents: order.priceCents ?? order.maxTotalCents,
      },
      detailUrl: `/token-orders/${order.id}`,
    })),
  ].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
function buyingWorkspace(state: RecordData, id: string) {
  state.buying[id] ??= { policy: null, decisions: [] };
  const packs = state.packs.filter(
    (item: RecordData) => item.grantId === id && item.status === 'active',
  );
  const input = packs.reduce((n: number, item: RecordData) => n + item.availableInputTokens, 0),
    output = packs.reduce((n: number, item: RecordData) => n + item.availableOutputTokens, 0);
  return {
    ...state.buying[id],
    allowance: {
      availableInputTokens: input,
      availableOutputTokens: output,
      heldInputTokens: 0,
      heldOutputTokens: 0,
      eligibleCalls: Math.floor(Math.min(input / 1000, output / 512)),
      outputPerCall: 512,
      unresolvedRequests: 0,
      pendingOrders: state.tokenOrders.filter(
        (item: RecordData) => item.grantId === id && item.status === 'open',
      ).length,
    },
  };
}

export function handleBuyerDemo(
  method: string,
  path: string,
  body: RecordData,
  store: DemoStore,
): unknown | undefined {
  if (!store.buyer) store.buyer = initialState();
  const state: RecordData = store.buyer;
  finalize(state, store);
  const url = new URL(path, 'https://demo.invalid'),
    pathname = url.pathname;
  const query = url.searchParams;
  const id = (prefix: string) =>
    decodeURIComponent(pathname.slice(prefix.length).split('/')[0] ?? '');
  const result = (value: unknown) => copy(value);
  if (method === 'GET' && pathname === '/api/catalog')
    return { items: copy(demoCatalog), catalog: copy(demoCatalog) };
  if (method === 'GET' && pathname === '/api/credits') return result(wallet(state));
  if (method === 'GET' && pathname === '/api/agreement-charges')
    return { items: [], nextCursor: null };
  if (method === 'GET' && pathname === '/api/credits/history')
    return result({ wallet: wallet(state), items: state.ledger, nextCursor: null });
  if (method === 'GET' && pathname === '/api/orders') {
    let items = orders(state);
    const kind = query.get('kind'),
      status = query.get('status');
    if (kind && kind !== 'all') items = items.filter((item) => item.kind === kind);
    if (status === 'active')
      items = items.filter((item) =>
        ['open', 'running', 'provisioning', 'awarded'].includes(item.status),
      );
    if (status === 'history')
      items = items.filter((item) =>
        ['terminated', 'expired', 'cancelled', 'no_offers', 'completed'].includes(item.status),
      );
    if (status === 'attention')
      items = items.filter((item) => ['failed', 'no_offers'].includes(item.status));
    const days =
      query.get('created') === '24h'
        ? 1
        : query.get('created') === '7d'
          ? 7
          : query.get('created') === '30d'
            ? 30
            : 0;
    if (days)
      items = items.filter((item) => Date.parse(item.createdAt) >= Date.now() - days * 86400_000);
    return result({ items, nextCursor: null, serverNow: timestamp() });
  }
  if (method === 'GET' && pathname === '/api/vm-inventory') {
    let items = [...state.vms];
    const status = query.get('status'),
      provider = query.get('provider'),
      search = query.get('search')?.toLowerCase();
    if (status && status !== 'all')
      items = items.filter((item) =>
        status === 'active'
          ? ['running', 'provisioning', 'terminating'].includes(item.status)
          : status === 'archive'
            ? ['terminated', 'expired', 'failed'].includes(item.status)
            : item.status === status,
      );
    if (provider && provider !== 'all') items = items.filter((item) => item.provider === provider);
    if (search)
      items = items.filter((item) => `${item.name} ${item.id}`.toLowerCase().includes(search));
    items.sort(
      (a, b) => (query.get('sort') === 'oldest' ? 1 : -1) * a.createdAt.localeCompare(b.createdAt),
    );
    return result({ items, nextCursor: null, previousCursor: null, serverNow: timestamp() });
  }
  if (pathname.startsWith('/api/vms/')) {
    const vm = required(state.vms, id('/api/vms/'), 'Virtual machine');
    if (method === 'POST' && pathname.endsWith('/terminate')) {
      vm.status = 'terminated';
      vm.cleanupConfirmedAt = timestamp();
      vm.cleanupPending = false;
      return result(vm);
    }
    if (method === 'GET' && pathname === `/api/vms/${vm.id}`) return result(vm);
  }
  if (method === 'GET' && pathname === '/api/invoices')
    return result({
      items: state.vms.map((vm: RecordData) => ({
        id: `demo-invoice-${vm.id}`,
        vmId: vm.id,
        amountCents: vm.priceCents,
        totalPriceCents: vm.priceCents,
        createdAt: vm.readyAt,
        catalogName: vm.catalogName,
        number: `INV-${vm.id.split('-').at(-1)}`,
        status: 'recorded',
        revenueShare: vm.revenueShare,
      })),
      nextCursor: null,
    });
  if (method === 'POST' && pathname === '/api/muse/translate')
    return result({
      proposal: {
        catalogId: demoCatalog[0]!.id,
        region: demoCatalog[0]!.region,
        durationMinutes: /15\s*min/i.test(body.description)
          ? 15
          : /60\s*min/i.test(body.description)
            ? 60
            : 30,
        requirements: { cpu: 2, memoryGb: 4 },
      },
      receipt: {
        observed: [
          'A lightweight Linux workspace was requested.',
          'Three sample providers offer compatible capacity.',
        ],
        decision: 'Prepare a 2 vCPU, 4 GiB workspace for your review.',
        constraints: [
          'The reviewed maximum is never exceeded.',
          'No auction starts until you confirm.',
        ],
      },
      mode: 'fixture',
      modelCalled: false,
    });
  if (method === 'GET' && pathname === '/api/requests') return result({ items: state.requests });
  if (method === 'POST' && pathname === '/api/requests') {
    const max = checkMoney(body.maxPriceCents);
    const item = demoCatalog.find((entry) => entry.id === body.catalogId);
    if (
      !item ||
      ![15, 30, 60].includes(body.durationMinutes) ||
      !body.requirements ||
      body.requirements.cpu < 1 ||
      body.requirements.memoryGb <= 0
    )
      throw new DemoError('Choose a valid demo configuration and rental duration.');
    const request = {
      id: `demo-request-${state.next++}`,
      description: String(body.description || 'Development workspace').slice(0, 4000),
      catalogId: item.id,
      region: body.region ?? 'any',
      matchAcrossProviders: body.matchAcrossProviders !== false,
      durationMinutes: body.durationMinutes,
      maxPriceCents: max,
      requirements: copy(body.requirements),
      status: 'open',
      closesAt: future(0.5),
      createdAt: timestamp(),
      diskId: body.diskId,
    };
    state.requests.unshift(request);
    state.bids[request.id] = demoCatalog
      .filter(
        (entry) =>
          entry.cpu >= request.requirements.cpu &&
          entry.memoryGb >= request.requirements.memoryGb &&
          (request.matchAcrossProviders || entry.id === item.id),
      )
      .map((entry, index) => ({
        id: `demo-bid-${state.next++}`,
        providerId: `demo-${entry.provider}`,
        providerName:
          entry.provider === 'modal' ? 'Modal' : entry.provider === 'daytona' ? 'Daytona' : 'E2B',
        cloudProvider: entry.provider,
        totalPriceCents: ((8 + index * 2) * body.durationMinutes) / 30,
        status: 'offered',
        createdAt: timestamp(),
        catalogId: entry.id,
        catalogName: entry.name,
        region: entry.region,
        simulated: true,
      }))
      .filter((bid) => bid.totalPriceCents <= max);
    return result(request);
  }
  if (pathname.startsWith('/api/requests/')) {
    const request = required(state.requests, id('/api/requests/'), 'Request');
    if (method === 'POST' && pathname.endsWith('/cancel')) {
      if (request.status !== 'open') throw new DemoError('Only an open auction can be cancelled.');
      request.status = 'cancelled';
      return result(request);
    }
    if (method === 'GET')
      return result({
        request,
        bids: state.bids[request.id] ?? [],
        vm: state.vms.find((vm: RecordData) => vm.requestId === request.id) ?? null,
      });
  }
  if (method === 'GET' && pathname === '/api/disks/options')
    return {
      enabled: true,
      mode: 'fixture',
      eligibleCatalogIds: demoCatalog.map((item) => item.id),
    };
  if (method === 'GET' && pathname === '/api/disks')
    return result({
      items: state.disks.filter((disk: RecordData) => disk.status !== 'deleted'),
      nextCursor: null,
    });
  if (method === 'POST' && pathname === '/api/disks') {
    if (!String(body.name ?? '').trim()) throw new DemoError('Name your disk.');
    const disk = {
      id: `demo-disk-${state.next++}`,
      name: String(body.name).trim().slice(0, 80),
      status: 'ready',
      sourceMode: 'fixture',
      createdAt: timestamp(),
      updatedAt: timestamp(),
      cleanupPending: false,
      failureReason: null,
      workspaceCount: 0,
      attachmentCount: 0,
      canDelete: true,
    };
    state.disks.unshift(disk);
    return result(disk);
  }
  if (pathname.startsWith('/api/disks/')) {
    const disk = required(state.disks, id('/api/disks/'), 'Disk');
    if (method === 'GET' && pathname.endsWith('/workspaces'))
      return result({
        items: state.workspaces.filter((workspace: RecordData) => workspace.diskId === disk.id),
      });
    if (method === 'GET' && pathname.endsWith('/files'))
      return {
        prefix: query.get('prefix') ?? '',
        entries: query.get('prefix')
          ? [{ key: 'src/hello.py', name: 'hello.py', kind: 'file', size: 27 }]
          : [
              { key: 'src/', name: 'src', kind: 'directory' },
              { key: 'README.md', name: 'README.md', kind: 'file', size: 68 },
            ],
      };
    if (method === 'GET' && pathname.endsWith('/file'))
      return {
        key: query.get('key'),
        size: 68,
        content: query.get('key')?.endsWith('.py')
          ? 'print("Hello from Wick!")\n'
          : '# Demo workspace\n\nThese sample files live only in the browser demo.\n',
        truncated: false,
        binary: false,
      };
    if (method === 'PATCH') {
      if (!String(body.name ?? '').trim()) throw new DemoError('Name your disk.');
      disk.name = String(body.name).trim();
      disk.updatedAt = timestamp();
      return result(disk);
    }
    if (method === 'DELETE') {
      if (!disk.canDelete)
        throw new DemoError('Terminate the attached demo VM before deleting this disk.');
      disk.status = 'deleted';
      return result(disk);
    }
    if (method === 'GET')
      return result({
        disk,
        workspaces: state.workspaces.filter(
          (workspace: RecordData) => workspace.diskId === disk.id,
        ),
        attachments: state.vms
          .filter((vm: RecordData) => vm.diskId === disk.id && vm.status === 'running')
          .map((vm: RecordData) => ({
            vmId: vm.id,
            environmentId: vm.environmentId,
            status: 'attached',
            generation: '1',
            provider: vm.provider,
            vmName: vm.name,
            createdAt: vm.createdAt,
          })),
      });
  }
  if (method === 'GET' && pathname === '/api/inference/models') return result(demoInferenceCatalog);
  if (method === 'GET' && ['/api/inference/agents', '/api/inference/grants'].includes(pathname)) {
    let items = state.grants.map((item: RecordData) => ({
      ...item,
      buyingMode: state.buying[item.id]?.policy?.mode ?? null,
      buyingPaused: state.buying[item.id]?.policy?.paused ?? false,
      eligibleCalls: buyingWorkspace(state, item.id).allowance.eligibleCalls,
      outputPerCall: 512,
    }));
    const status = query.get('status'),
      search = query.get('search')?.toLowerCase();
    if (status && status !== 'all')
      items = items.filter((item: RecordData) => item.status === status);
    if (search)
      items = items.filter((item: RecordData) => item.name.toLowerCase().includes(search));
    return result({ items, nextCursor: null });
  }
  if (method === 'POST' && pathname === '/api/inference/grants') {
    const budget = checkMoney(body.budgetCents, 1, wallet(state).availableCents);
    const item = {
      ...grant(`demo-agent-${state.next++}`, String(body.name || 'My assistant')),
      fundedCents: budget,
      availableCents: budget,
      spentCents: 0,
      maxPurchaseCents: checkMoney(body.maxPurchaseCents ?? budget, 1, budget),
      allowedProviders: body.allowedProviders?.length
        ? body.allowedProviders
        : ['modal', 'baseten'],
      allowInstant: body.allowInstant !== false,
      expiresAt: body.expiresAt ?? future(),
      createdAt: timestamp(),
    };
    state.grants.unshift(item);
    return result(item);
  }
  if (pathname.startsWith('/api/inference/grants/')) {
    const item = required(state.grants, id('/api/inference/grants/'), 'Agent');
    if (pathname.endsWith('/buying')) {
      if (method === 'GET') return result(buyingWorkspace(state, item.id));
      if (method === 'PUT') {
        buyingWorkspace(state, item.id);
        const policy: RecordData = {
          ...body,
          revision: (state.buying[item.id].policy?.revision ?? 0) + 1,
          modelCalls: 0,
          lastEvaluatedAt: null,
          nextEvaluationAt: future(5),
        };
        delete policy.operationKey;
        delete policy.expectedRevision;
        state.buying[item.id].policy = policy;
        return result(policy);
      }
    }
    if (method === 'POST' && pathname.endsWith('/buying/evaluate')) {
      buyingWorkspace(state, item.id);
      const policy = state.buying[item.id].policy;
      if (!policy) throw new DemoError('Save a buying policy first.');
      const decision = {
        id: `demo-decision-${state.next++}`,
        status: 'recommended',
        reason: 'A small sample token pack keeps your agent ready within its reviewed budget.',
        mode: 'fixture',
        modelCalled: false,
        policyRevision: policy.revision,
        candidate: {
          id: 'demo-candidate',
          mode: 'auction',
          inputTokens: 10_000,
          outputTokens: 2048,
          maxTotalCents: Math.min(10, policy.maxPurchaseCents),
          estimatedPriceCents: 5,
          calls: 4,
        },
        baseline: null,
        orderId: null,
        createdAt: timestamp(),
        expiresAt: future(5),
      };
      state.buying[item.id].decisions.unshift(decision);
      return result(decision);
    }
    if (method === 'POST' && pathname.endsWith('/buying/accept')) {
      const decision =
        state.buying[item.id]?.decisions.find(
          (entry: RecordData) => entry.id === body.decisionId,
        ) ?? state.buying[item.id]?.decisions[0];
      if (!decision?.candidate) throw new DemoError('Request a recommendation first.');
      const order = createTokenOrder({ ...decision.candidate, grantId: item.id }, state, store);
      decision.status = 'ordered';
      decision.orderId = order.id;
      return result(order);
    }
    if (method === 'POST' && pathname.endsWith('/fund')) {
      const amount = checkMoney(body.amountCents, 1, wallet(state).availableCents);
      if (item.status !== 'active') throw new DemoError('This agent is closed.');
      item.fundedCents += amount;
      item.availableCents += amount;
      return result(item);
    }
    if (method === 'POST' && pathname.endsWith('/close')) {
      item.status = 'closed';
      item.returnedCents += item.availableCents;
      item.availableCents = 0;
      state.packs
        .filter((entry: RecordData) => entry.grantId === item.id)
        .forEach((entry: RecordData) => {
          entry.status = 'settled';
          entry.retirementReason = 'agent_closed';
        });
      return result(item);
    }
    if (method === 'POST' && pathname.endsWith('/keys'))
      return result(demoKey(store, String(body.name || `${item.name} key`), { grantId: item.id }));
    if (method === 'GET' && pathname === `/api/inference/grants/${item.id}`)
      return result({
        grant: item,
        packs: state.packs.filter((entry: RecordData) => entry.grantId === item.id),
        requests: [],
        orders: state.tokenOrders.filter((entry: RecordData) => entry.grantId === item.id),
        catalog: demoInferenceCatalog,
      });
  }
  if (method === 'GET' && pathname === '/api/inference/packs') {
    let items = [...state.packs];
    const status = query.get('status'),
      provider = query.get('provider'),
      grantId = query.get('grantId');
    if (status && status !== 'all')
      items = items.filter((entry) =>
        status === 'expired'
          ? Date.parse(entry.expiresAt) <= Date.now()
          : status === 'usable'
            ? entry.status === 'active'
            : entry.status === status,
      );
    if (provider && provider !== 'all')
      items = items.filter((entry) => entry.provider === provider);
    if (grantId) items = items.filter((entry) => entry.grantId === grantId);
    return result({ items, nextCursor: null });
  }
  if (pathname.startsWith('/api/inference/packs/')) {
    const item = required(state.packs, id('/api/inference/packs/'), 'Token pack');
    if (method === 'POST' && pathname.endsWith('/keys'))
      return result({
        ...demoKey(store, 'Token pack access', { packId: item.id }),
        connection: {
          packId: item.id,
          baseUrl: 'https://demo.invalid/api/v1',
          model: modelId,
          expiresAt: item.expiresAt,
        },
      });
    if (method === 'GET') return result(item);
  }
  if (method === 'POST' && pathname === '/api/inference/quotes') {
    state.quotes = ['baseten', 'modal'].map((provider, index) => ({
      quoteId: `demo-quote-${state.next++}`,
      grantId: body.grantId ?? null,
      fundingSource: body.grantId ? 'agent' : 'wallet',
      packExpiresAt: future(),
      provider,
      modelId,
      inputTokens: body.inputTokens,
      outputTokens: body.outputTokens,
      priceCents: 5 + index,
      costFloorCents: 4,
      expiresAt: future(5),
      mode: 'fixture',
    }));
    return result({ items: state.quotes });
  }
  if (method === 'POST' && pathname === '/api/token-orders')
    return result(createTokenOrder(body, state, store));
  if (pathname.startsWith('/api/token-orders/')) {
    const order = required(state.tokenOrders, id('/api/token-orders/'), 'Token order');
    if (method === 'GET' && pathname.endsWith('/purchase-receipt')) return { decision: null };
    if (method === 'POST' && pathname.endsWith('/cancel')) {
      if (order.status !== 'open')
        throw new DemoError('Only open token auctions can be cancelled.');
      order.status = 'cancelled';
      return result(order);
    }
    if (method === 'GET')
      return result({
        order,
        bids: ['baseten', 'modal']
          .map((provider, i) => ({
            id: `${order.id}-bid-${i}`,
            provider,
            priceCents: 5 + i,
            status:
              order.status === 'open'
                ? 'offered'
                : order.status === 'awarded' && provider === order.provider
                  ? 'won'
                  : 'lost',
            mode: 'fixture',
            createdAt: order.createdAt,
          }))
          .filter((entry) => entry.priceCents <= order.maxTotalCents),
        pack: state.packs.find((entry: RecordData) => entry.id === order.packId) ?? null,
        grant:
          order.fundingSource === 'wallet'
            ? state.walletGrant
            : required(state.grants, order.grantId, 'Agent'),
      });
  }
  if (method === 'GET' && pathname === '/api/studio/options')
    return {
      mode: 'fixture',
      available: true,
      reason: 'Simulated execution in the interactive demo.',
    };
  if (method === 'GET' && pathname === '/api/studio/tasks')
    return result({ items: state.tasks, nextCursor: null });
  if (method === 'POST' && pathname === '/api/studio/tasks') {
    const budget = checkMoney(body.budgetCents, 1, wallet(state).availableCents);
    const task = {
      id: `demo-studio-${state.next++}`,
      goal: String(body.goal || 'Add a greeting utility'),
      repositoryUrl: String(body.repositoryUrl || 'https://github.com/octocat/Hello-World'),
      commitSha: 'd'.repeat(40),
      status: 'running',
      mode: 'fixture',
      budgetCents: budget,
      spentCents: 0,
      reservedCents: Math.min(13, budget),
      availableCents: Math.max(0, budget - 13),
      returnedCents: 0,
      computeChargedCents: 0,
      modelChargedCents: 0,
      blockedReason: null,
      plan: {
        catalogId: demoCatalog[0]!.id,
        testCommand: body.testCommand || 'python3 hello.py',
        explanation: 'Use a lightweight Linux workspace and verify the sample greeting.',
      },
      deadlineAt: future(body.durationMinutes || 30),
      createdAt: timestamp(),
      executionStartedAt: timestamp(),
      verifiedAt: null,
      completedAt: null,
      vmRequestId: null,
      codingJobId: null,
      summary: null,
      hasPatch: false,
      diskId: body.diskId,
      workspaceId: body.workspaceId,
    };
    state.tasks.unshift(task);
    return result(task);
  }
  if (pathname.startsWith('/api/studio/tasks/')) {
    const task = required(state.tasks, id('/api/studio/tasks/'), 'Studio task');
    if (method === 'POST' && pathname.endsWith('/stop')) {
      if (!['completed', 'failed', 'stopped'].includes(task.status)) {
        task.status = 'stopped';
        task.returnedCents = task.budgetCents;
        task.availableCents = 0;
        task.reservedCents = 0;
        task.completedAt = timestamp();
        task.summary = 'Demo task stopped and its unspent sample budget released.';
      }
      return result(task);
    }
    if (method === 'POST' && pathname.endsWith('/fund')) {
      const amount = checkMoney(body.amountCents, 1, wallet(state).availableCents);
      task.budgetCents += amount;
      task.availableCents += amount;
      return result(task);
    }
    if (method === 'GET' && pathname.endsWith('/patch'))
      return '--- /dev/null\n+++ b/hello.py\n@@ -0,0 +1 @@\n+print("Hello from Wick!")\n';
    if (method === 'GET')
      return result({
        task,
        modelActivity: [
          {
            id: `${task.id}-model`,
            provider: 'baseten',
            status: 'settled',
            phase: 'execution',
            createdAt: task.createdAt,
          },
        ],
        events: [
          {
            id: `${task.id}-plan`,
            kind: 'plan',
            title: 'Task planned',
            message: 'A lightweight workspace and a Python completion check were selected.',
            createdAt: task.createdAt,
          },
          {
            id: `${task.id}-execute`,
            kind: 'execution',
            title: task.status === 'completed' ? 'Verification passed' : 'Running sample task',
            message:
              task.status === 'completed'
                ? 'The simulated greeting check passed. Resources were cleaned up.'
                : 'The demo is showing a sample execution, with no real model or VM call.',
            createdAt: task.completedAt ?? task.createdAt,
          },
        ],
        vm:
          task.status === 'completed'
            ? {
                id: `demo-studio-vm-${task.id}`,
                status: 'terminated',
                cleanupConfirmedAt: task.completedAt,
              }
            : null,
        computeAuction: {
          id: `demo-studio-auction-${task.id}`,
          status: 'ready',
          closesAt: task.createdAt,
          bids: [
            { provider: 'modal', priceCents: task.computeChargedCents || 8, status: 'won' },
            { provider: 'daytona', priceCents: 10, status: 'lost' },
          ],
        },
        modelPurchases: [
          {
            id: `demo-studio-tokens-${task.id}`,
            status: 'awarded',
            provider: 'baseten',
            priceCents: task.modelChargedCents || 5,
            closesAt: task.createdAt,
          },
        ],
        tests:
          task.status === 'completed'
            ? {
                output: 'Hello from Wick!\n\nDemo verification: expected greeting matched.',
                exitCode: 0,
                completedAt: task.completedAt,
              }
            : null,
        patch: task.hasPatch
          ? '--- /dev/null\n+++ b/hello.py\n@@ -0,0 +1 @@\n+print("Hello from Wick!")\n'
          : null,
        usage: null,
      });
  }
  if (method === 'GET' && pathname === '/api/intents') return result({ items: state.intents });
  return undefined;
}
