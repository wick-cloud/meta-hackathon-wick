import { expect, test, type Page } from '@playwright/test';
import type {
  InferenceCatalog,
  InferenceGrant,
  TokenOffering,
  TokenOrder,
  TokenPack,
} from '../../src/shared/inference';

// Every API request is intercepted. These tests never create credentials or call a provider.
const grantId = '11111111-1111-4111-8111-111111111111';
const orderId = '22222222-2222-4222-8222-222222222222';
const keyId = '33333333-3333-4333-8333-333333333333';
const packId = '44444444-4444-4444-8444-444444444444';
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
    allowInstant: true,
    expiresAt: future(),
    createdAt: new Date().toISOString(),
    currency: 'USD',
  };
  const grants = options.empty ? [] : [grant];
  const orders: TokenOrder[] = [],
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
      minimumInputReservation: 1000,
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
    if (path === '/api/credits')
      return route.fulfill({
        json: {
          balanceCents: 10000,
          reservedCents: 1000,
          availableCents: 9000,
          currency: 'USD',
          kind: 'broker-pilot-credit',
          wickComputeCreditsSeparate: true,
        },
      });
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
    if (path === '/api/inference/quotes')
      return route.fulfill({
        json: {
          items: [
            {
              quoteId: 'fixture-quote',
              grantId,
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
    if (path === '/api/token-orders' && method === 'POST') {
      if (options.purchaseFailureOnce && writes.filter((write) => write.path === path).length === 1)
        return route.abort('failed');
      const order: TokenOrder = {
        id: orderId,
        grantId,
        mode: body.mode,
        sourceMode: 'fixture',
        status: body.mode === 'instant' ? 'awarded' : 'open',
        modelId,
        inputTokens: body.inputTokens,
        outputTokens: body.outputTokens,
        maxTotalCents: body.maxTotalCents,
        priceCents: body.mode === 'instant' ? 250 : null,
        provider: body.mode === 'instant' ? 'modal' : null,
        closesAt: new Date(Date.now() + 30000).toISOString(),
        expiresAt: future(),
        createdAt: new Date().toISOString(),
        packId: body.mode === 'instant' ? packId : null,
      };
      orders.push(order);
      if (body.mode === 'instant')
        packs.push({
          id: packId,
          orderId,
          grantId,
          provider: 'modal',
          mode: 'fixture',
          modelId,
          status: 'active',
          inputTokens: body.inputTokens,
          outputTokens: body.outputTokens,
          availableInputTokens: body.inputTokens,
          availableOutputTokens: body.outputTokens,
          heldInputTokens: 0,
          heldOutputTokens: 0,
          consumedInputTokens: 0,
          consumedOutputTokens: 0,
          retiredInputTokens: 0,
          retiredOutputTokens: 0,
          priceCents: 250,
          refundCents: 0,
          expiresAt: future(),
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
      return route.fulfill({ json: { order: orders[0], bids: [], pack: packs[0] ?? null, grant } });
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
  return { writes, grant, orders, catalog };
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
    maxPurchaseCents: 500,
    allowedProviders: ['modal', 'baseten'],
  });
  expect(f.writes[0]!.body.operationKey).toBeTruthy();
  expect(Date.parse(f.writes[0]!.body.expiresAt) - Date.now()).toBeLessThanOrEqual(86400000);
  expect(Date.parse(f.writes[0]!.body.expiresAt) - Date.now()).toBeGreaterThan(86300000);
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

test('instant quotes are invalidated on quantity edits and a purchase reveals separate prepaid quotas', async ({
  page,
}) => {
  const f = await fixture(page);
  await page.goto(`/token-orders/new?grantId=${grantId}`);
  await page.getByRole('radio', { name: /Buy at an instant price/ }).check();
  await page.getByRole('button', { name: 'Get instant prices' }).click();
  await expect(page.getByRole('radio', { name: /Modal/ })).toBeVisible();
  await page.getByLabel('Input tokens', { exact: true }).fill('2000000');
  await expect(page.getByRole('radio', { name: /Modal/ })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Buy pack', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Get instant prices' }).click();
  await page.getByRole('checkbox', { name: /I understand/ }).check();
  await page.getByRole('button', { name: 'Buy pack · $2.50' }).click();
  await expect(page.getByRole('heading', { name: 'Purchased quota' })).toBeVisible();
  await expect(page.getByRole('progressbar', { name: 'Input tokens available' })).toHaveAttribute(
    'value',
    '2000000',
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
  const purchases = f.writes.filter((write) => write.path === '/api/token-orders');
  expect(purchases).toHaveLength(2);
  expect(purchases[1]!.body).toEqual(purchases[0]!.body);
});

test('provider edits quoted rates and sees explicit commission without provisioning', async ({
  page,
}) => {
  const f = await fixture(page, { role: 'provider' });
  await page.goto('/provider/inference');
  await expect(page.getByRole('heading', { name: 'AI token supply', exact: true })).toBeVisible();
  await expect(page.getByText('15% Broker commission on charged purchases')).toBeVisible();
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
  await page.getByRole('link', { name: /Research assistant/ }).click();
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
  await expect(page.getByRole('heading', { name: 'Buy a token pack', exact: true })).toBeVisible();
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
