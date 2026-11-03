import type { BuyingPolicy, BuyingDecision } from '../../src/shared/buying';
import { expect, test, reviewTables, type Page } from './table-review';
import { revenueShare } from '../../src/shared/pricing';
import type {
  InferenceCatalog,
  InferenceGrant,
  TokenOffering,
  TokenBid,
  TokenOrder,
  TokenPack,
} from '../../src/shared/inference';

// Every API request is intercepted. These tests never create credentials or call a provider.
const grantId = '11111111-1111-4111-8111-111111111111';
const orderId = '22222222-2222-4222-8222-222222222222';
const keyId = '33333333-3333-4333-8333-333333333333';
const packId = '44444444-4444-4444-8444-444444444444';
const walletGrantId = '55555555-5555-4555-8555-555555555555';
const secret = `wbk_${keyId}.${'f'.repeat(43)}`;
const modelId = 'meta/muse-spark-open';
const future = () => new Date(Date.now() + 7 * 86400000).toISOString();

async function fixture(
  page: Page,
  options: {
    role?: 'buyer' | 'provider';
    empty?: boolean;
    qualified?: boolean;
    keyFailure?: boolean;
    purchaseFailureOnce?: boolean;
    configured?: boolean;
    minimumInputReservation?: number;
    walletCents?: number;
    walletFailure?: boolean;
    agentInstant?: boolean;
  } = {},
) {
  const role = options.role ?? 'buyer';
  const grant: InferenceGrant = {
    id: grantId,
    name: 'Research assistant',
    status: 'active',
    mode: 'fixture',
    fundedCents: 1000,
    availableCents: 1000,
    heldCents: 0,
    spentCents: 0,
    returnedCents: 0,
    maxPurchaseCents: 500,
    allowedProviders: ['modal', 'baseten'],
    allowInstant: options.agentInstant !== false,
    expiresAt: future(),
    createdAt: new Date().toISOString(),
    currency: 'USD',
  };
  const grants = options.empty ? [] : [grant];
  const orders: TokenOrder[] = [],
    bids: TokenBid[] = [],
    packs: TokenPack[] = [],
    writes: { path: string; body: any }[] = [];
  const catalog: InferenceCatalog = {
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
      qualified: options.qualified !== false,
      reason:
        options.qualified === false
          ? 'Exact tokenizer contract is not qualified.'
          : 'Fixture route; no real model calls.',
      minimumInputReservation: options.minimumInputReservation ?? 1000,
      maximumOutputTokens: 4096,
    })),
  };
  let offering: TokenOffering = {
    provider: 'modal',
    revision: 1,
    active: true,
    autoBid: true,
    inputRateMicrosPerMillion: 2000000,
    outputRateMicrosPerMillion: 6000000,
    instantMarkupBps: 1000,
    minimumPriceCents: 10,
    maxOutstandingInputTokens: 10000000,
    maxOutstandingOutputTokens: 5000000,
    route: catalog.routes[0]!,
    costInputRateMicrosPerMillion: 1250000,
    costOutputRateMicrosPerMillion: 4250000,
    outstandingInputTokens: 0,
    outstandingOutputTokens: 0,
    providerCommissionBps: 1500,
  };
  let buyingPolicy: BuyingPolicy | null = null;
  let walletQuoteExpiry: string | undefined;
  const buyingDecisions: BuyingDecision[] = [];
  await page.route('**/api/**', async (route) => {
    const request = route.request(),
      path = new URL(request.url()).pathname,
      method = request.method();
    const body = method === 'GET' ? undefined : request.postDataJSON();
    if (method !== 'GET') writes.push({ path, body });
    if (path === '/api/me')
      return route.fulfill({
        json: {
          user: {
            id: 'fixture-user',
            name: 'Fixture user',
            email: `${role}@fixture.invalid`,
            role,
          },
          modes: { wick: 'fixture', muse: 'fixture' },
          catalog: [],
        },
      });
    if (path === '/api/credits') {
      if (options.walletFailure)
        return route.fulfill({ status: 503, json: { error: 'Wallet temporarily unavailable' } });
      return route.fulfill({
        json: {
          balanceCents: (options.walletCents ?? 9000) + 1000,
          reservedCents: 1000,
          availableCents: options.walletCents ?? 9000,
          currency: 'USD',
          kind: 'broker-pilot-credit',
          wickComputeCreditsSeparate: true,
        },
      });
    }
    if (path === '/api/inference/agents')
      return route.fulfill({
        json: {
          items: grants.map((g) => ({
            ...g,
            buyingMode: buyingPolicy?.mode ?? null,
            buyingPaused: buyingPolicy?.paused ?? false,
            eligibleCalls: 0,
            outputPerCall: 512,
          })),
        },
      });
    if (path === `/api/token-orders/${orderId}/purchase-receipt`)
      return route.fulfill({
        json: { decision: buyingDecisions.find((d) => d.orderId === orderId) ?? null },
      });
    if (path === `/api/inference/grants/${grantId}/buying`) {
      if (method === 'PUT') {
        const { operationKey, expectedRevision, ...values } = body;
        buyingPolicy = {
          ...values,
          revision: expectedRevision + 1,
          modelCalls: 0,
          lastEvaluatedAt: null,
          nextEvaluationAt: new Date(Date.now() - 1000).toISOString(),
        };
        return route.fulfill({ json: buyingPolicy });
      }
      return route.fulfill({
        json: {
          policy: buyingPolicy,
          decisions: buyingDecisions,
          allowance: {
            availableInputTokens: 0,
            availableOutputTokens: 0,
            heldInputTokens: 0,
            heldOutputTokens: 0,
            eligibleCalls: 0,
            outputPerCall: 512,
            unresolvedRequests: 0,
            pendingOrders: 0,
          },
        },
      });
    }
    if (path === `/api/inference/grants/${grantId}/buying/evaluate`) {
      const d: BuyingDecision = {
        id: '66666666-6666-4666-8666-666666666666',
        status: 'recommended',
        reason: 'Fixture recommendation: one server-priced pack.',
        mode: 'fixture',
        modelCalled: false,
        policyRevision: buyingPolicy!.revision,
        candidate: {
          id: 'auction-1',
          mode: 'auction',
          inputTokens: 1048576,
          outputTokens: 512,
          calls: 1,
          maxTotalCents: 200,
          estimatedPriceCents: 173.31,
        },
        baseline: null,
        orderId: null,
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 60000).toISOString(),
      };
      buyingDecisions.unshift(d);
      return route.fulfill({ json: d });
    }
    if (path === '/api/inference/models') return route.fulfill({ json: catalog });
    if (path === '/api/inference/grants' && method === 'GET')
      return route.fulfill({ json: { items: grants } });
    if (path === '/api/inference/grants' && method === 'POST') {
      Object.assign(grant, {
        name: body.name,
        fundedCents: body.budgetCents,
        availableCents: body.budgetCents,
        maxPurchaseCents: body.maxPurchaseCents,
        allowedProviders: body.allowedProviders,
        allowInstant: body.allowInstant,
        expiresAt: body.expiresAt,
      });
      grants.push(grant);
      return route.fulfill({ json: grant });
    }
    if (path === `/api/inference/grants/${grantId}`)
      return route.fulfill({ json: { grant, packs, requests: [], orders, catalog } });
    if (path === `/api/inference/grants/${grantId}/fund`) {
      grant.fundedCents += body.amountCents;
      grant.availableCents += body.amountCents;
      return route.fulfill({ json: grant });
    }
    if (path === `/api/inference/grants/${grantId}/close`) {
      grant.status = 'closed';
      grant.returnedCents += grant.availableCents;
      grant.availableCents = 0;
      return route.fulfill({ json: grant });
    }
    if (path === `/api/inference/grants/${grantId}/keys`) {
      if (options.keyFailure) return route.abort('failed');
      return route.fulfill({
        json: {
          token: secret,
          key: {
            id: keyId,
            name: body.name,
            prefix: `wbk_${keyId}`,
            scopes: ['account:read', 'inference:read', 'inference:use', 'tokens:buy'],
            limits: {},
            grantId,
            createdAt: new Date().toISOString(),
            expiresAt: future(),
            revokedAt: null,
            lastUsedAt: null,
          },
        },
      });
    }
    if (path === '/api/inference/quotes') {
      walletQuoteExpiry = new Date(Date.now() + 7200000).toISOString();
      return route.fulfill({
        json: {
          items: [
            {
              quoteId: 'fixture-quote',
              grantId: body.grantId ?? null,
              fundingSource: body.grantId ? 'agent' : 'wallet',
              packExpiresAt: body.grantId ? grant.expiresAt : walletQuoteExpiry,
              provider: 'modal',
              modelId,
              inputTokens: body.inputTokens,
              outputTokens: body.outputTokens,
              priceCents: 250,
              costFloorCents: 200,
              expiresAt: new Date(Date.now() + 60000).toISOString(),
              mode: 'fixture',
            },
          ],
        },
      });
    }
    if (
      (path === '/api/token-orders' || path === `/api/inference/grants/${grantId}/buying/accept`) &&
      method === 'POST'
    ) {
      const decision = path.endsWith('/accept')
        ? buyingDecisions.find((d) => d.id === body.decisionId)
        : undefined;
      const purchase = decision?.candidate ?? body;
      const walletFunded = !decision && !body.grantId;
      const purchaseGrantId = walletFunded ? walletGrantId : grantId;
      const expiresAt = walletFunded
        ? purchase.mode === 'instant'
          ? walletQuoteExpiry!
          : new Date(Date.now() + 7200000).toISOString()
        : grant.expiresAt;
      if (decision) {
        decision.orderId = orderId;
        decision.status = 'ordered';
      }
      if (options.purchaseFailureOnce && writes.filter((write) => write.path === path).length === 1)
        return route.abort('failed');
      const order: TokenOrder = {
        id: orderId,
        grantId: purchaseGrantId,
        fundingSource: walletFunded ? 'wallet' : 'agent',
        mode: purchase.mode,
        sourceMode: 'fixture',
        status: purchase.mode === 'instant' ? 'awarded' : 'open',
        modelId,
        inputTokens: purchase.inputTokens,
        outputTokens: purchase.outputTokens,
        maxTotalCents: purchase.maxTotalCents,
        priceCents: purchase.mode === 'instant' ? 250 : null,
        provider: purchase.mode === 'instant' ? 'modal' : null,
        closesAt: new Date(Date.now() + 30000).toISOString(),
        expiresAt,
        createdAt: new Date().toISOString(),
        packId: purchase.mode === 'instant' ? packId : null,
      };
      orders.push(order);
      if (purchase.mode === 'instant')
        packs.push({
          id: packId,
          orderId,
          grantId: purchaseGrantId,
          fundingSource: walletFunded ? 'wallet' : 'agent',
          provider: 'modal',
          mode: 'fixture',
          modelId,
          status: 'active',
          inputTokens: purchase.inputTokens,
          outputTokens: purchase.outputTokens,
          availableInputTokens: purchase.inputTokens,
          availableOutputTokens: purchase.outputTokens,
          heldInputTokens: 0,
          heldOutputTokens: 0,
          consumedInputTokens: 0,
          consumedOutputTokens: 0,
          retiredInputTokens: 0,
          retiredOutputTokens: 0,
          priceCents: 250,
          refundCents: 0,
          expiresAt,
          createdAt: new Date().toISOString(),
          retirementReason: null,
          revenueShare: {
            commissionBps: 1500,
            grossCents: 250,
            brokerFeeMicros: '375000',
            providerNetMicros: '2125000',
          },
        });
      return route.fulfill({ json: order });
    }
    if (path === `/api/token-orders/${orderId}/cancel`) {
      orders[0]!.status = 'cancelled';
      return route.fulfill({ json: orders[0] });
    }
    if (path === `/api/token-orders/${orderId}`)
      return route.fulfill({
        json: {
          order: orders[0],
          bids,
          pack: packs[0] ?? null,
          grant:
            orders[0]?.fundingSource === 'wallet'
              ? { ...grant, id: walletGrantId, fundingSource: 'wallet', name: 'Wallet purchase' }
              : grant,
        },
      });
    if (path === '/api/orders')
      return route.fulfill({
        json: {
          serverNow: new Date().toISOString(),
          items: orders.map((order) => ({
            id: order.id,
            key: `token:${order.id}`,
            kind: 'token',
            reference: 'TOK-222222',
            title: 'Meta Muse Spark Open token pack',
            status: order.status,
            cleanupPending: false,
            createdAt: order.createdAt,
            closesAt: order.closesAt,
            expiresAt: order.expiresAt,
            requestedQuantity: 1,
            approvedQuantity: 0,
            runningQuantity: 0,
            bidCount: 0,
            amount: {
              label: order.priceCents === null ? 'budget' : 'accepted',
              amountCents: order.priceCents ?? order.maxTotalCents,
            },
            detailUrl: `/token-orders/${order.id}`,
            modelId,
            inputTokens: order.inputTokens,
            outputTokens: order.outputTokens,
            tokenMode: order.mode,
            grantId,
          })),
        },
      });
    if (path === '/api/provider/inference/propose')
      return route.fulfill({
        json: {
          mode: 'fixture',
          modelCalled: false,
          expectedRevision: offering.revision,
          explanation: 'Review these rates. Nothing has been published.',
          proposal: {
            inputTokens: 1048576,
            outputTokens: 512,
            calls: 2,
            estimatedPriceCents: 183.31,
            inputRateMicrosPerMillion: 2500000,
            outputRateMicrosPerMillion: 6000000,
          },
        },
      });
    if (path === '/api/provider/inference/offering' && method === 'GET')
      return route.fulfill({
        json: { offering: options.configured === false ? null : offering, catalog },
      });
    if (path === '/api/provider/inference/offering' && method === 'PUT') {
      const { operationKey: _key, expectedRevision: _revision, ...values } = body;
      offering = { ...offering, ...values, revision: offering.revision + 1 };
      return route.fulfill({ json: offering });
    }
    if (path === '/api/provider/inference/packs') return route.fulfill({ json: { items: packs } });
    return route.fulfill({
      status: 500,
      json: { error: `Unexpected fixture request ${method} ${path}` },
    });
  });
  return { writes, grant, orders, packs, bids, catalog };
}

test('owner creates a funded agent, saves a key once, adds funds and closes its budget', async ({
  page,
}) => {
  const f = await fixture(page, { empty: true });
  await page.goto('/agents');
  await page.getByRole('button', { name: 'Create agent', exact: true }).first().click();
  await page.getByLabel('Agent name').fill('Writing assistant');
  await page.getByLabel('Initial budget').fill('12');
  await page.getByRole('button', { name: 'Reserve $12.00 and create' }).click();
  await expect(page.getByRole('heading', { name: 'Writing assistant', exact: true })).toBeVisible();
  await page.screenshot({ path: test.info().outputPath('agent-desktop.png'), fullPage: true });
  expect(f.writes[0]!.body).toMatchObject({
    budgetCents: 1200,
    maxPurchaseCents: 10,
    allowedProviders: ['modal', 'baseten'],
  });
  expect(f.writes[0]!.body.operationKey).toBeTruthy();
  expect(Date.parse(f.writes[0]!.body.expiresAt) - Date.now()).toBeLessThanOrEqual(7200000);
  expect(Date.parse(f.writes[0]!.body.expiresAt) - Date.now()).toBeGreaterThan(7190000);
  await page.getByRole('link', { name: 'Connection', exact: true }).click();
  await page.getByRole('button', { name: 'Create or replace API key', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText(
    'All previous keys for this agent will be revoked',
  );
  await page.getByRole('button', { name: 'Issue replacement key' }).click();
  await expect(page.getByLabel('New agent API key')).toHaveValue(secret);
  expect(await page.evaluate(() => JSON.stringify([localStorage, sessionStorage]))).not.toContain(
    secret,
  );
  await page.getByRole('button', { name: 'I’ve saved the key' }).click();
  await expect(page.getByLabel('New agent API key')).toHaveCount(0);
  await page.getByRole('button', { name: 'Add funds', exact: true }).click();
  await page.getByLabel('Amount to add').fill('3.50');
  await page.getByRole('button', { name: 'Add $3.50', exact: true }).click();
  await expect(page.getByText('$3.50 added to the agent budget.')).toBeVisible();
  expect(f.grant.fundedCents).toBe(1550);
  await page.getByRole('button', { name: 'Add funds', exact: true }).click();
  await page.getByRole('button', { name: 'Add $3.50', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(f.grant.fundedCents).toBe(1900);
  const fundingWrites = f.writes.filter((write) => write.path.endsWith('/fund'));
  expect(fundingWrites[0]!.body.operationKey).not.toBe(fundingWrites[1]!.body.operationKey);
  await page.getByRole('button', { name: 'Close agent budget', exact: true }).click();
  await page.getByRole('button', { name: 'Close budget', exact: true }).click();
  await expect(page.getByText('Closed', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Add funds', exact: true })).toHaveCount(0);
  await expect(
    page.getByRole('button', { name: 'Create or replace API key', exact: true }),
  ).toHaveCount(0);
});

test('uncertain key creation never retries automatically or exposes a recoverable secret', async ({
  page,
}) => {
  const f = await fixture(page, { keyFailure: true });
  await page.goto(`/agents/${grantId}`);
  await page.getByRole('link', { name: 'Connection', exact: true }).click();
  await page.getByRole('button', { name: 'Create or replace API key', exact: true }).click();
  await page.getByRole('button', { name: 'Issue replacement key' }).click();
  await expect(page.getByRole('alert')).toContainText('No automatic retry was made');
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Research assistant', exact: true }),
  ).toBeVisible();
  expect(f.writes.filter((write) => write.path.endsWith('/keys'))).toHaveLength(1);
  await expect(page.getByLabel('New agent API key')).toHaveCount(0);
});

test('four-decimal funding and auction limits are displayed and submitted without cent rounding', async ({
  page,
}) => {
  const f = await fixture(page, { empty: true });
  await page.goto('/agents');
  await page.getByRole('button', { name: 'Create agent', exact: true }).first().click();
  await page.getByLabel('Agent name').fill('Precise budget');
  const budget = page.getByLabel('Initial budget');
  await expect(budget).toHaveAttribute('step', '0.0001');
  await budget.fill('1.2345');
  await expect(budget).toHaveValue('1.2345');
  await page.getByLabel('Maximum per purchase').fill('0.1234');
  await page.getByRole('button', { name: 'Reserve $1.2345 and create', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Precise budget', exact: true })).toBeVisible();
  expect(f.writes[0].body.budgetCents).toBe(123.45);
  await expect(page.getByText('$1.2345', { exact: true }).first()).toBeVisible();
  await page.screenshot({
    path: test.info().outputPath('four-decimal-budget.png'),
    fullPage: true,
  });
  await page.goto(`/token-orders/new?grantId=${grantId}`);
  const maximum = page.getByLabel('Maximum total price');
  await maximum.fill('0.01');
  await expect(maximum).toHaveValue('0.01');
  // A fifth meaningful digit must never be silently rounded and charged.
  await maximum.fill('0.00019');
  await expect(maximum).toHaveValue('0.00019');
  expect(await maximum.evaluate((e: HTMLInputElement) => e.validity.valid)).toBe(false);
  await maximum.fill('0.1234');
  await page.getByRole('checkbox', { name: /I understand/ }).check();
  await page.getByRole('button', { name: 'Start 30-second auction' }).click();
  await expect(
    page.getByRole('heading', { name: 'Token pack auction', exact: true }),
  ).toBeVisible();
  expect(f.writes.find((w) => w.path === '/api/token-orders')!.body.maxTotalCents).toBe(12.34);
});

test('an order accepts one cent typed normally without losing the decimal', async ({ page }) => {
  const f = await fixture(page);
  await page.goto(`/token-orders/new?grantId=${grantId}`);
  const maximum = page.getByLabel('Maximum total price');
  await maximum.fill('');
  await maximum.pressSequentially('0.01');
  await expect(maximum).toHaveValue('0.01');
  await page.getByRole('checkbox', { name: /I understand/ }).check();
  await page.getByRole('button', { name: 'Start 30-second auction' }).click();
  await expect(
    page.getByRole('heading', { name: 'Token pack auction', exact: true }),
  ).toBeVisible();
  expect(f.writes.find((w) => w.path === '/api/token-orders')!.body.maxTotalCents).toBe(1);
});

test('prices below one cent and excess precision cannot submit an old price', async ({ page }) => {
  const f = await fixture(page);
  await page.goto(`/token-orders/new?grantId=${grantId}`);
  const maximum = page.getByLabel('Maximum total price');
  for (const spelling of ['0.0099', '1.23456', '']) {
    await maximum.fill(spelling);
    await page.getByRole('checkbox', { name: /I understand/ }).check();
    const submit = page.getByRole('button', { name: 'Start 30-second auction' });
    if (await submit.isEnabled()) await submit.click();
    else await expect(submit).toBeDisabled();
    expect(await maximum.evaluate((e: HTMLInputElement) => e.validity.valid)).toBe(false);
    expect(f.writes.filter((w) => w.path === '/api/token-orders')).toHaveLength(0);
  }
  await maximum.pressSequentially('0.0101');
  await expect(maximum).toHaveValue('0.0101');
  await page.getByRole('checkbox', { name: /I understand/ }).check();
  await page.getByRole('button', { name: 'Start 30-second auction' }).click();
  await expect(
    page.getByRole('heading', { name: 'Token pack auction', exact: true }),
  ).toBeVisible();
  expect(f.writes.find((w) => w.path === '/api/token-orders')!.body.maxTotalCents).toBe(1.01);
});

test('providers can publish rates and minimum pack prices with four USD decimals', async ({
  page,
}) => {
  const f = await fixture(page, { role: 'provider' });
  await page.goto('/provider/inference');
  await page.getByLabel('Input price · USD / million').fill('2.3456');
  await page.getByLabel('Output price · USD / million').fill('6.7891');
  await page.getByLabel('Minimum pack price').fill('0.0101');
  await page.getByRole('button', { name: 'Save token offering', exact: true }).click();
  await expect(
    page.getByText('Offering saved. Existing token packs retain their purchased terms.'),
  ).toBeVisible();
  expect(f.writes.find((w) => w.path === '/api/provider/inference/offering')!.body).toMatchObject({
    inputRateMicrosPerMillion: 2345600,
    outputRateMicrosPerMillion: 6789100,
    minimumPriceCents: 1.01,
  });
});

test('auction purchase produces a saved token order and cancels without VM actions', async ({
  page,
}) => {
  const f = await fixture(page);
  await page.goto(`/token-orders/new?grantId=${grantId}`);
  await expect(page.getByText('Fixture marketplace · no real model calls')).toBeVisible();
  await page.getByLabel('Input tokens', { exact: true }).fill('200000');
  await page.getByLabel('Output tokens', { exact: true }).fill('50000');
  await page.getByLabel('Maximum total price').fill('4');
  await page.getByRole('checkbox', { name: /I understand/ }).check();
  await page.getByRole('button', { name: 'Start 30-second auction' }).click();
  await expect(
    page.getByRole('heading', { name: 'Token pack auction', exact: true }),
  ).toBeVisible();
  expect(f.writes.find((write) => write.path === '/api/token-orders')!.body).toMatchObject({
    mode: 'auction',
    inputTokens: 200000,
    outputTokens: 50000,
    maxTotalCents: 400,
    grantId,
  });
  await page.getByRole('button', { name: 'Cancel open auction' }).click();
  await expect(page.getByText('Cancelled', { exact: true })).toBeVisible();
  await page.getByRole('link', { name: 'Token orders', exact: true }).click();
  await expect(page.getByLabel('Order type')).toHaveValue('token');
  await expect(page.getByText('AI tokens · Auction')).toBeVisible();
  await expect(page.getByRole('link', { name: 'Environment', exact: true })).toHaveCount(0);
  await page.getByRole('link', { name: 'View', exact: true }).click();
  await expect(page.getByText('Cancelled', { exact: true })).toBeVisible();
});

test('packs default above the real input reserve and smaller quantities cannot start an auction or quote', async ({
  page,
}) => {
  const f = await fixture(page, { minimumInputReservation: 1048576 });
  await page.goto(`/token-orders/new?grantId=${grantId}`);
  const input = page.getByLabel('Input tokens', { exact: true });
  await expect(input).toHaveValue('2000000');
  await input.fill('1000000');
  await page.getByRole('checkbox', { name: /I understand/ }).check();
  await expect(page.getByRole('button', { name: 'Start 30-second auction' })).toBeDisabled();
  await page.getByRole('radio', { name: /Buy at an instant price/ }).check();
  await expect(page.getByRole('button', { name: 'Get instant prices' })).toBeDisabled();
  expect(f.writes).toHaveLength(0);
  await input.fill('2000000');
  await page.getByRole('button', { name: 'Get instant prices' }).click();
  await expect(page.getByRole('radio', { name: /Modal/ })).toBeVisible();
});

test('instant quotes are invalidated on quantity edits and a purchase reveals separate prepaid quotas', async ({
  page,
}) => {
  const f = await fixture(page);
  await page.goto(`/token-orders/new?grantId=${grantId}`);
  await page.getByRole('radio', { name: /Buy at an instant price/ }).check();
  await page.getByRole('button', { name: 'Get instant prices' }).click();
  await expect(page.getByRole('radio', { name: /Modal/ })).toBeVisible();
  await page.getByLabel('Input tokens', { exact: true }).fill('3000000');
  await expect(page.getByRole('radio', { name: /Modal/ })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Buy pack', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Get instant prices' }).click();
  await page.getByRole('checkbox', { name: /I understand/ }).check();
  await page.getByRole('button', { name: 'Buy pack · $2.50' }).click();
  await expect(page.getByRole('heading', { name: 'Purchased quota' })).toBeVisible();
  await expect(page.getByRole('timer')).toHaveCount(0);
  await expect(page.getByText('INSTANT PURCHASE', { exact: true })).toBeVisible();
  await expect(page.getByRole('progressbar', { name: 'Input tokens available' })).toHaveAttribute(
    'value',
    '3000000',
  );
  await expect(page.getByRole('progressbar', { name: 'Output tokens available' })).toHaveAttribute(
    'value',
    '100000',
  );
  expect(f.writes.find((write) => write.path === '/api/token-orders')!.body).toMatchObject({
    mode: 'instant',
    quoteId: 'fixture-quote',
    maxTotalCents: 250,
  });
  await expect(page.getByText('Paid once for this pack')).toBeVisible();
});

test('unqualified providers block purchases and keep unavailable reasons visible', async ({
  page,
}) => {
  const f = await fixture(page, { qualified: false });
  await page.goto(`/token-orders/new?grantId=${grantId}`);
  await expect(page.getByText('Exact tokenizer contract is not qualified.')).toHaveCount(2);
  await page.getByRole('checkbox', { name: /I understand/ }).check();
  await expect(page.getByRole('button', { name: 'Start 30-second auction' })).toBeDisabled();
  await page.getByRole('radio', { name: /Buy at an instant price/ }).check();
  await expect(page.getByRole('button', { name: 'Get instant prices' })).toBeDisabled();
  expect(f.writes).toHaveLength(0);
});

test('an uncertain purchase recovers the original operation even after its quote expires', async ({
  page,
}) => {
  const f = await fixture(page, { purchaseFailureOnce: true });
  await page.clock.install({ time: new Date() });
  await page.goto(`/token-orders/new?grantId=${grantId}`);
  await page.getByRole('radio', { name: /Buy at an instant price/ }).check();
  await page.getByRole('button', { name: 'Get instant prices' }).click();
  await page.getByRole('checkbox', { name: /I understand/ }).check();
  await page.getByRole('button', { name: 'Buy pack · $2.50' }).click();
  await expect(page.getByRole('alert')).toContainText('No automatic retry was made');
  await expect(page.getByLabel('Input tokens', { exact: true })).toBeDisabled();
  await page.clock.fastForward(120000);
  expect(f.writes.filter((write) => write.path === '/api/token-orders')).toHaveLength(1);
  await page.getByRole('button', { name: 'Recover saved order' }).click();
  await expect(page.getByRole('heading', { name: 'Purchased quota' })).toBeVisible();
  await expect(page.getByRole('timer')).toHaveCount(0);
  await expect(page.getByText('INSTANT PURCHASE', { exact: true })).toBeVisible();
  const purchases = f.writes.filter((write) => write.path === '/api/token-orders');
  expect(purchases).toHaveLength(2);
  expect(purchases[1]!.body).toEqual(purchases[0]!.body);
});

test('a buyer with no agents buys an auction from the wallet and retries without an agent', async ({
  page,
}) => {
  const f = await fixture(page, { empty: true });
  await page.goto('/token-orders/new');
  await expect(page.getByLabel('Pay with', { exact: true })).toHaveValue('');
  await expect(page.getByText('Available wallet credit', { exact: true })).toBeVisible();
  await expect(
    page.getByText(/Wallet packs expire 2 hours after the auction starts/),
  ).toBeVisible();
  await page.getByLabel('Maximum total price').fill('1.2345');
  await page.getByRole('checkbox', { name: /I understand/ }).check();
  await page.getByRole('button', { name: 'Start 30-second auction' }).click();
  await expect(
    page.getByRole('heading', { name: 'Token pack auction', exact: true }),
  ).toBeVisible();
  const purchase = f.writes.find((write) => write.path === '/api/token-orders')!.body;
  expect(purchase).not.toHaveProperty('grantId');
  expect(purchase).toMatchObject({ mode: 'auction', maxTotalCents: 123.45 });
  expect(f.orders[0]!.fundingSource).toBe('wallet');
  await expect(page.locator('a[href^="/agents/"]')).toHaveCount(0);
  await expect(
    page.getByRole('link', { name: 'Broker wallet', exact: true }).last(),
  ).toHaveAttribute('href', '/credits');
  await page.getByRole('button', { name: 'Cancel open auction' }).click();
  await expect(page.getByRole('link', { name: 'Review a new purchase' })).toHaveAttribute(
    'href',
    '/token-orders/new',
  );
  expect(f.writes.some((write) => write.path === '/api/inference/grants')).toBe(false);
});

test('wallet remains the default with existing agents and an instant pack exposes its own connection', async ({
  page,
}) => {
  const f = await fixture(page);
  await page.goto('/token-orders/new');
  await expect(page.getByLabel('Pay with', { exact: true })).toContainText('Research assistant');
  await expect(page.getByLabel('Pay with', { exact: true })).toHaveValue('');
  await page.getByRole('radio', { name: /Buy at an instant price/ }).check();
  await page.getByRole('button', { name: 'Get instant prices' }).click();
  await expect(page.getByText(/This quoted pack expires at/)).toBeVisible();
  expect(f.writes.find((write) => write.path === '/api/inference/quotes')!.body).not.toHaveProperty(
    'grantId',
  );
  await page.getByRole('checkbox', { name: /I understand/ }).check();
  await page.getByRole('button', { name: 'Buy pack · $2.50' }).click();
  await expect(page.getByRole('heading', { name: 'Purchased quota' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Connect token batch' })).toHaveAttribute(
    'href',
    `/tokens?connect=${packId}`,
  );
  await expect(page.locator('a[href^="/agents/"]')).toHaveCount(0);
  await expect(page.getByText(/This pack expires at/)).toBeVisible();
  expect(f.packs[0]!.fundingSource).toBe('wallet');
  expect(f.writes.find((write) => write.path === '/api/token-orders')!.body).not.toHaveProperty(
    'grantId',
  );
  expect(f.writes.map((write) => write.path)).toEqual([
    '/api/inference/quotes',
    '/api/token-orders',
  ]);
});

test('changing wallet or agent funding invalidates the quote and purchase consent', async ({
  page,
}) => {
  const f = await fixture(page);
  await page.goto('/token-orders/new');
  await page.getByRole('radio', { name: /Buy at an instant price/ }).check();
  await page.getByRole('button', { name: 'Get instant prices' }).click();
  await page.getByRole('checkbox', { name: /I understand/ }).check();
  await page.getByLabel('Pay with', { exact: true }).selectOption(grantId);
  await expect(page.getByRole('radio', { name: /Modal/ })).toHaveCount(0);
  await expect(page.getByRole('checkbox', { name: /I understand/ })).not.toBeChecked();
  await expect(page.getByRole('button', { name: 'Buy pack', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Get instant prices' }).click();
  expect(f.writes.at(-1)!.body.grantId).toBe(grantId);
  await page.getByLabel('Pay with', { exact: true }).selectOption('');
  await expect(page.getByRole('radio', { name: /Modal/ })).toHaveCount(0);
  await page.getByRole('button', { name: 'Get instant prices' }).click();
  expect(f.writes.at(-1)!.body).not.toHaveProperty('grantId');
  expect(f.writes.filter((write) => write.path === '/api/token-orders')).toHaveLength(0);
});

test('an explicit agent keeps its instant and spending limits even with an empty wallet', async ({
  page,
}) => {
  const f = await fixture(page, { walletCents: 0, agentInstant: false });
  await page.goto(`/token-orders/new?grantId=${grantId}`);
  await expect(page.getByLabel('Pay with', { exact: true })).toHaveValue(grantId);
  await expect(page.getByRole('radio', { name: /Buy at an instant price/ })).toBeDisabled();
  await page.getByLabel('Maximum total price').fill('6');
  await page.getByRole('checkbox', { name: /I understand/ }).check();
  await expect(page.getByRole('button', { name: 'Start 30-second auction' })).toBeDisabled();
  await page.getByLabel('Maximum total price').fill('4');
  await page.getByRole('checkbox', { name: /I understand/ }).check();
  await page.getByRole('button', { name: 'Start 30-second auction' }).click();
  await expect(
    page.getByRole('heading', { name: 'Token pack auction', exact: true }),
  ).toBeVisible();
  expect(f.writes.find((write) => write.path === '/api/token-orders')!.body.grantId).toBe(grantId);
  await expect(page.getByRole('link', { name: 'View agent', exact: true })).toHaveAttribute(
    'href',
    `/agents/${grantId}`,
  );
});

test('wallet read failure and insufficient exact credit prevent purchases until corrected', async ({
  page,
}) => {
  const options = { empty: true, walletCents: 1.01, walletFailure: true };
  const f = await fixture(page, options);
  await page.goto('/token-orders/new');
  await expect(page.getByRole('alert')).toContainText('Wallet temporarily unavailable');
  await page.getByLabel('Maximum total price').fill('0.0101');
  await page.getByRole('checkbox', { name: /I understand/ }).check();
  await expect(page.getByRole('button', { name: 'Start 30-second auction' })).toBeDisabled();
  options.walletFailure = false;
  await page.getByRole('button', { name: 'Try again', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Start 30-second auction' })).toBeEnabled();
  await page.getByLabel('Maximum total price').fill('0.0102');
  await page.getByRole('checkbox', { name: /I understand/ }).check();
  await expect(page.getByRole('button', { name: 'Start 30-second auction' })).toBeDisabled();
  await expect(page.getByText('This purchase exceeds your available wallet credit.')).toBeVisible();
  await page.getByRole('radio', { name: /Buy at an instant price/ }).check();
  await page.getByRole('button', { name: 'Get instant prices' }).click();
  await page.getByRole('checkbox', { name: /I understand/ }).check();
  await expect(page.getByRole('button', { name: 'Buy pack · $2.50' })).toBeDisabled();
  expect(f.writes.filter((write) => write.path === '/api/token-orders')).toHaveLength(0);
});

test('retrying optional agent budgets never submits a wallet purchase', async ({ page }) => {
  const f = await fixture(page, { empty: true });
  let fail = true;
  await page.route(/\/api\/inference\/grants(?:\?|$)/, (route) =>
    fail
      ? route.fulfill({ status: 503, json: { error: 'Agent budgets temporarily unavailable' } })
      : route.fallback(),
  );
  await page.goto('/token-orders/new');
  await expect(page.getByRole('alert')).toContainText('Agent budgets temporarily unavailable');
  await page.getByRole('checkbox', { name: /I understand/ }).check();
  await expect(page.getByRole('button', { name: 'Start 30-second auction' })).toBeEnabled();
  fail = false;
  await page.getByRole('button', { name: 'Try again', exact: true }).click();
  await expect(page.getByRole('alert')).toHaveCount(0);
  expect(f.writes).toEqual([]);
});

test('an uncertain wallet purchase freezes funding and recovers the unchanged request', async ({
  page,
}) => {
  const f = await fixture(page, { empty: true, purchaseFailureOnce: true });
  await page.clock.install({ time: new Date() });
  await page.goto('/token-orders/new');
  await page.getByRole('radio', { name: /Buy at an instant price/ }).check();
  await page.getByRole('button', { name: 'Get instant prices' }).click();
  await page.getByRole('checkbox', { name: /I understand/ }).check();
  await page.getByRole('button', { name: 'Buy pack · $2.50' }).click();
  await expect(page.getByRole('alert')).toContainText('No automatic retry was made');
  await expect(page.getByLabel('Pay with', { exact: true })).toBeDisabled();
  await page.clock.fastForward(120000);
  expect(f.writes.filter((write) => write.path === '/api/token-orders')).toHaveLength(1);
  await page.getByRole('button', { name: 'Recover saved order' }).click();
  await expect(page.getByRole('heading', { name: 'Purchased quota' })).toBeVisible();
  const purchases = f.writes.filter((write) => write.path === '/api/token-orders');
  expect(purchases).toHaveLength(2);
  expect(purchases[1]!.body).toEqual(purchases[0]!.body);
  expect(purchases[0]!.body).not.toHaveProperty('grantId');
});

test('token quantity maxima match the API for both wallet auctions and quotes', async ({
  page,
}) => {
  const f = await fixture(page, { empty: true });
  await page.goto('/token-orders/new');
  const input = page.getByLabel('Input tokens', { exact: true });
  const output = page.getByLabel('Output tokens', { exact: true });
  await expect(input).toHaveAttribute('max', '10000000');
  await expect(output).toHaveAttribute('max', '1000000');
  await input.fill('10000001');
  await page.getByRole('checkbox', { name: /I understand/ }).check();
  await expect(page.getByRole('button', { name: 'Start 30-second auction' })).toBeDisabled();
  await page.getByRole('radio', { name: /Buy at an instant price/ }).check();
  await expect(page.getByRole('button', { name: 'Get instant prices' })).toBeDisabled();
  await input.fill('2000000');
  await output.fill('1000001');
  await expect(page.getByRole('button', { name: 'Get instant prices' })).toBeDisabled();
  expect(f.writes).toHaveLength(0);
});

test('provider edits quoted rates and sees explicit commission without provisioning', async ({
  page,
}) => {
  const f = await fixture(page, { role: 'provider' });
  await page.goto('/provider/inference');
  await expect(page.getByRole('heading', { name: 'AI capacity', exact: true })).toBeVisible();
  await expect(
    page.getByText('15% Broker commission on charged purchases', { exact: false }),
  ).toBeVisible();
  await page.getByLabel('Input price · USD / million').fill('3.5');
  await page.getByRole('button', { name: 'Save token offering' }).click();
  await expect(
    page.getByText('Offering saved. Existing token packs retain their purchased terms.'),
  ).toBeVisible();
  expect(f.writes[0]!.body).toMatchObject({
    inputRateMicrosPerMillion: 3500000,
    expectedRevision: 1,
  });
  expect(f.writes[0]!.body.operationKey).toBeTruthy();
});

test('unassigned provider sees configuration state and cannot publish an offering', async ({
  page,
}) => {
  await fixture(page, { role: 'provider', configured: false });
  await page.goto('/provider/inference');
  await expect(
    page.getByRole('heading', { name: 'Inference provider is not configured' }),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: 'Save token offering' })).toHaveCount(0);
});

test('agent setup and purchase form fit a narrow viewport and preserve back navigation', async ({
  page,
}) => {
  await fixture(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/agents');
  await page.getByRole('link', { name: 'Research assistant', exact: true }).click();
  await page.getByRole('link', { name: 'Connection', exact: true }).click();
  await page.getByText('JavaScript setup example', { exact: true }).click();
  await expect(page.locator('.inference-code-details pre')).toContainText('/api/v1');
  await expect(page.locator('.inference-code-details pre')).toContainText(
    "'Idempotency-Key': requestId",
  );
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await page.screenshot({ path: test.info().outputPath('agent-mobile.png'), fullPage: true });
  await page.getByRole('link', { name: 'Buy token pack', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Buy AI tokens', exact: true })).toBeVisible();
  await page.screenshot({
    path: test.info().outputPath('token-composer-mobile.png'),
    fullPage: true,
  });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await page.goBack();
  await expect(
    page.getByRole('heading', { name: 'Research assistant', exact: true }),
  ).toBeVisible();
});

test('agent receipts and provider commitments keep pending usage and exact earnings readable', async ({
  page,
}) => {
  const f = await fixture(page);
  const pack: TokenPack = {
    id: packId,
    orderId,
    grantId,
    provider: 'modal',
    mode: 'fixture',
    modelId,
    status: 'active',
    inputTokens: 1048600,
    outputTokens: 512,
    availableInputTokens: 1048470,
    availableOutputTokens: 400,
    heldInputTokens: 100,
    heldOutputTokens: 64,
    consumedInputTokens: 30,
    consumedOutputTokens: 48,
    retiredInputTokens: 0,
    retiredOutputTokens: 0,
    priceCents: 173.31,
    refundCents: 0,
    expiresAt: future(),
    createdAt: new Date().toISOString(),
    retirementReason: null,
    revenueShare: revenueShare(173.31),
  };
  f.packs.push(pack);
  f.orders.push({ ...liveOrder('awarded'), provider: 'modal', priceCents: 173.31, packId });
  await page.route(`**/api/inference/grants/${grantId}`, (route) =>
    route.fulfill({
      json: {
        grant: f.grant,
        packs: f.packs,
        orders: f.orders,
        catalog: f.catalog,
        requests: [
          {
            id: keyId,
            packId,
            provider: 'modal',
            mode: 'fixture',
            status: 'outcome_unknown',
            createdAt: new Date().toISOString(),
            failureCode: 'provider_timeout',
            inputTokens: null,
            outputTokens: null,
            heldInputTokens: 100,
            heldOutputTokens: 64,
          },
        ],
      },
    }),
  );
  await page.goto(`/agents/${grantId}`);
  await page.getByRole('link', { name: 'Activity & receipts', exact: true }).click();
  await expect(page.getByRole('table', { name: 'Recent token orders', exact: true })).toContainText(
    '$1.7331',
  );
  await expect(
    page.getByRole('table', { name: 'Recent inference requests', exact: true }),
  ).toContainText('100 / 64 held');
  await reviewTables(page, test.info());
  const provider = await fixture(page, { role: 'provider' });
  provider.packs.push(pack);
  await page.goto('/provider/inference');
  await page.getByRole('link', { name: 'Commitments', exact: true }).click();
  const commitments = page.getByRole('table', { name: 'Provider token commitments', exact: true });
  await expect(commitments).toContainText('$1.7331');
  await expect(commitments).toContainText('100 input / 64 output pending');
  expect([...f.writes, ...provider.writes]).toHaveLength(0);
});

function liveOrder(status: TokenOrder['status'] = 'open'): TokenOrder {
  return {
    id: orderId,
    grantId,
    mode: 'auction',
    sourceMode: 'fixture',
    status,
    modelId,
    inputTokens: 1048600,
    outputTokens: 512,
    maxTotalCents: 190.01,
    priceCents: null,
    provider: null,
    closesAt: '2026-10-30T20:00:30.000Z',
    expiresAt: '2026-10-30T22:00:00.000Z',
    createdAt: '2026-10-30T20:00:00.000Z',
    packId: null,
  };
}
function liveBids(): TokenBid[] {
  return [
    {
      id: 'baseten-bid',
      provider: 'baseten',
      priceCents: 178.55,
      status: 'offered',
      mode: 'fixture',
      createdAt: '2026-10-30T20:00:01Z',
    },
    {
      id: 'modal-bid',
      provider: 'modal',
      priceCents: 173.31,
      status: 'offered',
      mode: 'fixture',
      createdAt: '2026-10-30T20:00:02Z',
    },
  ];
}

test('token auctions share the VM countdown, retain the deadline on refresh, and await a confirmed award', async ({
  page,
}) => {
  await page.clock.install({ time: new Date('2026-10-30T19:59:59Z') });
  await page.clock.pauseAt(new Date('2026-10-30T20:00:00Z'));
  const f = await fixture(page);
  f.orders.push(liveOrder());
  f.bids.push(...liveBids());
  await page.goto(`/token-orders/${orderId}`);
  const timer = page.getByRole('timer', { name: 'Auction countdown' });
  await expect(timer.locator(':scope > span')).toHaveText('30');
  await expect(page.getByRole('progressbar', { name: 'Auction time elapsed' })).toHaveAttribute(
    'aria-valuenow',
    '0',
  );
  const rows = page.getByRole('list', { name: 'Provider offers' }).getByRole('listitem');
  await expect(rows.first()).toContainText('Modal');
  await expect(rows.first()).toContainText('$1.7331');
  await expect(rows.first()).toContainText('Best price');
  await expect(rows.nth(1)).toContainText('$1.7855');
  await page.clock.runFor(5000);
  await expect(timer.locator(':scope > span')).toHaveText('25');
  await page.reload();
  await expect(timer.locator(':scope > span')).toHaveText('25');
  await page.clock.fastForward(25000);
  await expect(timer).toContainText('Selecting your match');
  await expect(page.getByRole('button', { name: 'Cancel open auction' })).toBeDisabled();
  await expect(page.getByRole('heading', { name: 'Your token pack is purchased' })).toHaveCount(0);
  await page.screenshot({
    path: test.info().outputPath('token-auction-closing.png'),
    fullPage: true,
  });
  f.orders[0] = {
    ...f.orders[0],
    status: 'awarded',
    priceCents: 173.31,
    provider: 'modal',
    packId,
  };
  f.bids.forEach((b) => {
    b.status = b.provider === 'modal' ? 'won' : 'lost';
  });
  f.packs.push({
    id: packId,
    orderId,
    grantId,
    provider: 'modal',
    mode: 'fixture',
    modelId,
    status: 'settled',
    inputTokens: 1048600,
    outputTokens: 512,
    availableInputTokens: 0,
    availableOutputTokens: 0,
    heldInputTokens: 0,
    heldOutputTokens: 0,
    consumedInputTokens: 153,
    consumedOutputTokens: 131,
    retiredInputTokens: 1048447,
    retiredOutputTokens: 381,
    priceCents: 173.31,
    refundCents: 0,
    expiresAt: f.orders[0].expiresAt,
    createdAt: f.orders[0].createdAt,
    retirementReason: 'quota_exhausted',
    revenueShare: {
      commissionBps: 1500,
      grossCents: 173.31,
      brokerFeeMicros: '259965',
      providerNetMicros: '1473135',
    },
  });
  await page.clock.runFor(2500);
  await expect(page.getByRole('heading', { name: 'Your token pack is purchased' })).toBeVisible();
  await expect(timer).toHaveCount(0);
  await expect(rows.first()).toHaveClass(/winning/);
  await expect(rows.first()).toContainText('Winning provider');
  await expect(page.getByText('Paid once for this pack', { exact: true })).toBeVisible();
  await expect(
    page.getByText(
      'This pack cannot cover another request’s required token reservation. Unused quota has been retired.',
    ),
  ).toBeVisible();
  await expect(page.getByText(/381 retired/)).toBeVisible();
  await page.screenshot({
    path: test.info().outputPath('token-auction-awarded.png'),
    fullPage: true,
  });
  expect(f.writes).toHaveLength(0);
});

for (const status of ['no_offers', 'cancelled', 'expired'] as const)
  test(`token auction ${status} has a clear result and a deliberate retry`, async ({ page }) => {
    const f = await fixture(page);
    f.orders.push(liveOrder(status));
    await page.goto(`/token-orders/${orderId}`);
    await expect(page.getByRole('timer')).toHaveCount(0);
    await expect(
      page.getByText('No token pack was purchased. The unspent purchase hold has been released.'),
    ).toBeVisible();
    await expect(page.getByRole('link', { name: 'Review a new purchase' })).toHaveAttribute(
      'href',
      `/token-orders/new?grantId=${grantId}`,
    );
    expect(f.writes).toHaveLength(0);
  });

test('live token offers and the full purchase summary fit a phone', async ({ page }) => {
  await page.clock.install({ time: new Date('2026-10-30T20:00:10Z') });
  const f = await fixture(page);
  f.orders.push(liveOrder());
  f.bids.push(...liveBids());
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/token-orders/${orderId}`);
  await expect(page.getByRole('timer')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Your token pack', exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({
    path: test.info().outputPath('token-auction-mobile.png'),
    fullPage: true,
  });
  expect(f.writes).toHaveLength(0);
});

test('owner reviews buying policy before enabling, reviews a recommendation, and can pause buying', async ({
  page,
}) => {
  const f = await fixture(page);
  await page.goto(`/agents/${grantId}?tab=policy`);
  await page.getByLabel('Automatic within limits', { exact: false }).check();
  await page.getByRole('button', { name: 'Review changes', exact: true }).click();
  expect(f.writes.filter((w) => w.path.endsWith('/buying'))).toHaveLength(0);
  await expect(page.getByRole('dialog')).toContainText('Saving authorizes the buying worker');
  await page.getByRole('button', { name: 'Save buying policy', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(
    page.getByText('The policy changed while you were editing.', { exact: false }),
  ).toHaveCount(0);
  expect(f.writes.find((w) => w.path.endsWith('/buying'))?.body.mode).toBe('automatic');
  await page.getByRole('link', { name: 'Overview', exact: true }).click();
  await page.getByRole('button', { name: 'Get Muse recommendation', exact: true }).click();
  await page.getByRole('button', { name: 'Review purchase', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText('1,048,576');
  await expect(page.getByRole('dialog')).toContainText('$2.00');
  expect(f.writes.filter((w) => w.path.endsWith('/accept'))).toHaveLength(0);
  await page.getByRole('dialog').getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.getByRole('button', { name: 'Pause buying', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Resume buying', exact: true })).toBeVisible();
  const saved = f.writes.filter((w) => w.path.endsWith('/buying')).at(-1)!.body;
  expect(saved.paused).toBe(true);
  expect(saved).not.toHaveProperty('modelCalls');
  await page.screenshot({ path: test.info().outputPath('buying-overview.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('agent inventory keeps long names contained and search filters in the URL', async ({
  page,
}) => {
  const f = await fixture(page);
  f.grant.name = 'Research assistant for a very long customer project with a detailed name';
  await page.goto('/agents');
  const table = page.getByRole('table', { name: 'Agent budgets and token allowance' });
  await expect(table).toBeVisible();
  await expect(page.getByRole('link', { name: f.grant.name, exact: true })).toHaveAttribute(
    'title',
    f.grant.name,
  );
  await page.getByLabel('Find an agent').fill('Research');
  await page.getByRole('button', { name: 'Search', exact: true }).click();
  await expect(page).toHaveURL(/\/agents\?q=Research$/);
  await page.getByRole('combobox', { name: 'Status', exact: true }).selectOption('active');
  await expect(page).toHaveURL(/q=Research&status=active/);
  await page.screenshot({
    path: test.info().outputPath('agents-table-desktop.png'),
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect
    .poll(() =>
      page.evaluate(() => ({
        width: innerWidth,
        scrollWidth: document.documentElement.scrollWidth,
      })),
    )
    .toEqual({ width: 390, scrollWidth: 390 });
  await page.screenshot({
    path: test.info().outputPath('agents-table-mobile.png'),
    fullPage: true,
  });
  expect(f.writes).toHaveLength(0);
});

for (const state of ['closed', 'closing', 'expired'] as const) {
  test(`${state} agent shows history and read-only policy instead of buying controls`, async ({
    page,
  }) => {
    const f = await fixture(page);
    if (state === 'expired') f.grant.expiresAt = new Date(Date.now() - 1000).toISOString();
    else f.grant.status = state;
    await page.goto(`/agents/${grantId}`);
    await expect(
      page.getByRole('heading', {
        name: `This agent ${state === 'closing' ? 'is closing' : state === 'closed' ? 'is closed' : 'has expired'}`,
      }),
    ).toBeVisible();
    await expect(
      page.getByRole('link', { name: 'View activity & receipts', exact: true }),
    ).toBeVisible();
    await expect(page.getByRole('link', { name: 'Buy manually', exact: true })).toHaveCount(0);
    await page.getByRole('link', { name: 'Buying policy', exact: true }).click();
    await expect(
      page.getByRole('heading', { name: 'Purchasing is disabled', exact: true }),
    ).toBeVisible();
    await expect(page.getByText('Draft changes', { exact: true })).toHaveCount(0);
    await expect(page.getByRole('radio')).toHaveCount(0);
    await page.screenshot({
      path: test.info().outputPath('agent-readonly-policy.png'),
      fullPage: true,
    });
    expect(f.writes).toHaveLength(0);
  });
}

test('a reviewed Muse purchase opens its permanent countdown and receipt without duplicate submission', async ({
  page,
}) => {
  const f = await fixture(page);
  await page.goto(`/agents/${grantId}?tab=policy`);
  await page.getByRole('button', { name: 'Review changes', exact: true }).click();
  await page.getByRole('button', { name: 'Save buying policy', exact: true }).click();
  await page.getByRole('link', { name: 'Overview', exact: true }).click();
  await page.getByRole('button', { name: 'Get Muse recommendation', exact: true }).click();
  await page.getByRole('button', { name: 'Review purchase', exact: true }).click();
  await page.getByRole('button', { name: 'Start 30-second auction', exact: true }).click();
  await expect(page).toHaveURL(`/token-orders/${orderId}`);
  await expect(page.getByRole('heading', { name: 'Purchase receipt', exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Purchase receipt', exact: true })).toBeVisible();
  expect(f.writes.filter((w) => w.path.endsWith('/accept'))).toHaveLength(1);
  expect(f.writes.filter((w) => w.path.endsWith('/accept'))[0].body).toEqual({
    decisionId: '66666666-6666-4666-8666-666666666666',
  });
});

test('provider reviews Muse rates, publishes a selling window, and switches to commitments', async ({
  page,
}) => {
  const f = await fixture(page, { role: 'provider' });
  await page.goto('/provider/inference');
  await page.getByRole('button', { name: 'Draft with Muse', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Fixture supply proposal' })).toBeVisible();
  expect(f.writes.filter((w) => w.path.endsWith('/offering'))).toHaveLength(0);
  await page.getByRole('button', { name: 'Apply rates to draft', exact: true }).click();
  await expect(page.getByLabel('Input price · USD / million')).toHaveValue('2.5');
  await page.getByLabel('Start accepting sales').fill('2026-11-01T00:00');
  await page.getByLabel('Stop accepting sales').fill('2026-11-01T06:00');
  await page.getByRole('button', { name: 'Save token offering', exact: true }).click();
  const save = f.writes.find((w) => w.path.endsWith('/offering'))!;
  // Datetime-local fields preserve the chosen wall times, including a DST transition.
  const expectedWindow = await page.evaluate(() => ({
    start: new Date('2026-11-01T00:00').toISOString(),
    end: new Date('2026-11-01T06:00').toISOString(),
  }));
  expect(save.body.salesStartAt).toBe(expectedWindow.start);
  expect(save.body.salesEndAt).toBe(expectedWindow.end);
  await page.getByRole('link', { name: 'Commitments', exact: true }).click();
  await expect(page).toHaveURL('/provider/inference?tab=commitments');
  await expect(
    page.getByRole('heading', { name: 'Token commitments and earnings', exact: true }),
  ).toBeVisible();
  await expect(page.getByLabel('Input price · USD / million')).toHaveCount(0);
  await page.getByRole('link', { name: 'Supply & pricing', exact: true }).click();
  await page.evaluate(() => scrollTo(0, 0));
  await page.screenshot({ path: test.info().outputPath('provider-supply.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

for (const width of [375, 768, 1440]) {
  test(`token review and agent connection remain usable at ${width}px`, async ({ page }, info) => {
    const f = await fixture(page);
    await page.setViewportSize({ width, height: 1000 });
    await page.goto('/token-orders/new');
    await expect(page.getByRole('heading', { name: 'Buy AI tokens', exact: true })).toBeVisible();
    await expect(page.getByText('Fixture marketplace · no real model calls')).toBeVisible();
    const availability = page.locator('details').filter({ hasText: 'Fixture marketplace' });
    await expect(availability).not.toHaveAttribute('open', '');
    await expect(
      page.getByRole('checkbox', { name: /I understand that purchased tokens/ }),
    ).toBeVisible();
    await expect(page.getByRole('button', { name: 'Start 30-second auction' })).toBeDisabled();
    await page.getByLabel('Maximum total price').fill('1.2345');
    await expect(page.getByText('$1.2345', { exact: true })).toBeVisible();
    await page.getByLabel('Maximum total price').focus();
    if (width < 900)
      expect(
        await page
          .getByLabel('Maximum total price')
          .evaluate((el) => getComputedStyle(el).fontSize),
      ).toBe('16px');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(
      true,
    );
    await page.getByLabel('Maximum total price').blur();
    await page.evaluate(() => scrollTo(0, 0));
    await page.screenshot({ path: info.outputPath(`token-compose-${width}.png`), fullPage: true });
    await page.goto(`/agents/${grantId}?tab=connection`);
    await expect(
      page.getByRole('heading', { name: 'Connect this agent', exact: true }),
    ).toBeVisible();
    await expect(page.getByRole('button', { name: 'Create or replace API key' })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(
      true,
    );
    await page.screenshot({
      path: info.outputPath(`agent-connection-${width}.png`),
      fullPage: true,
    });
    expect(f.writes).toHaveLength(0);
  });
}
