import { expect, test, reviewTables, type Page } from './table-review';
import { revenueShare } from '../../src/shared/pricing';

// UI contract fixtures intercept every API request. These tests cannot allocate compute,
// call Muse, read credentials or change a running Broker database.
const id = '11111111-1111-4111-8111-111111111111';
const catalog = [
  {
    id: 'micro',
    name: 'Micro Linux',
    description: 'Fixture configuration',
    provider: 'e2b',
    profile: 'micro',
    region: 'us',
    cpu: 1,
    memoryGb: 1,
    durationMinutes: [15, 30, 60],
    approved: true,
    deadlineEnforcement: 'native',
  },
];
const now = Date.now(),
  iso = (delta: number) => new Date(now + delta).toISOString();
const wallet = {
  balanceCents: 20000,
  reservedCents: 0,
  availableCents: 20000,
  currency: 'USD',
  kind: 'broker-pilot-credit',
  wickComputeCreditsSeparate: true,
};
const request = {
  id,
  description: 'Original immutable request',
  catalogId: 'micro',
  region: 'us',
  durationMinutes: 15,
  maxPriceCents: 100,
  requirements: { cpu: 1, memoryGb: 1 },
  status: 'no_offers',
  closesAt: iso(-1000),
  createdAt: iso(-31000),
};
function detail() {
  return {
    agreement: {
      id,
      description: 'Seven-day fixture fleet',
      status: 'approved',
      targetQuantity: 20,
      minimumQuantity: 12,
      startsAt: iso(-60000),
      expiresAt: iso(7 * 86400000),
      timeZone: 'UTC',
      maxAmountCents: 14000,
      reservedCents: 14000,
      committedCents: 8400,
      settledCents: 0,
      adjustmentCents: 0,
      topUpAllowanceCents: 5600,
      acceptingTopUps: true,
      createdAt: iso(-120000),
      specification: {},
      activationMode: 'manual',
      deadlineEligible: true,
      windows: [
        {
          id: 'window-one',
          agreementId: id,
          startsAt: iso(-60000),
          discountEndsAt: iso(3600000),
          endsAt: iso(7200000),
          approvedQuantity: 12,
          runningQuantity: 0,
          availableToActivate: 3,
          committedCents: 1200,
        },
      ],
    },
    bookings: [],
    activations: [],
  };
}
type Handler = (path: string, method: string, body: any, url: URL) => unknown;
async function fixture(page: Page, role: 'buyer' | 'provider' | 'admin', handler: Handler) {
  const writes: { path: string; body: any }[] = [];
  await page.route('**/api/**', async (route) => {
    const req = route.request(),
      url = new URL(req.url()),
      path = url.pathname,
      method = req.method();
    const body = req.postDataJSON();
    if (method !== 'GET') writes.push({ path, body });
    const common: Record<string, unknown> = {
      '/api/me': {
        user: { id: 'user-one', name: 'Fixture User', email: `${role}@fixture.invalid`, role },
        modes: { wick: 'fixture', muse: 'fixture' },
        catalog,
      },
      '/api/credits': wallet,
      '/api/credits/history': { wallet, items: [] },
      '/api/provider/dashboard': {
        provider: {
          id: 'supplier-one',
          name: 'Fixture E2B',
          simulated: true,
          cloudProvider: 'e2b',
        },
        policy: {
          autoBid: true,
          minimumPriceCents: 1,
          basePriceCents: 10,
          allowedCatalogIds: ['micro'],
        },
        policyRevision: 1,
        capacity: { total: 20, held: 0, available: 20 },
        activity: [],
      },
    };
    let response = handler(path, method, body, url) ?? common[path];
    if (response === undefined) {
      await route.fulfill({ status: 500, json: { error: `Unmocked UI API: ${method} ${path}` } });
      return;
    }
    await route.fulfill({ json: response });
  });
  return writes;
}

test('Orders preserves server order across identical source IDs and URL filters; opening is read-only', async ({
  page,
}) => {
  const writes = await fixture(page, 'buyer', (path) =>
    path === '/api/orders'
      ? {
          serverNow: iso(0),
          nextCursor: 'opaque-cursor',
          items: [
            {
              id,
              key: `agreement:${id}`,
              kind: 'agreement',
              reference: 'AGR-1111',
              title: 'Historical first',
              status: 'open',
              createdAt: iso(-1000),
              closesAt: null,
              expiresAt: iso(86400000),
              requestedQuantity: 20,
              approvedQuantity: 12,
              runningQuantity: 0,
              bidCount: 0,
              amount: { label: 'reserved', amountCents: 14000, committedCents: 8400 },
              detailUrl: `/orders/${id}`,
            },
            {
              id,
              key: `auction:${id}`,
              kind: 'auction',
              reference: 'AUC-1111',
              title: 'Auction second',
              status: 'no_offers',
              auctionStatus: 'no_offers',
              createdAt: iso(-1000),
              closesAt: iso(-1000),
              expiresAt: null,
              requestedQuantity: 1,
              approvedQuantity: 0,
              runningQuantity: 0,
              bidCount: 0,
              amount: { label: 'budget', amountCents: 100 },
              detailUrl: `/requests/${id}`,
              retryUrl: `/new?copy=${id}`,
            },
          ],
        }
      : path === `/agreements/${id}` || path === `/api/agreements/${id}`
        ? detail()
        : undefined,
  );
  await page.goto('/orders');
  await expect(page.locator('.market-order-title')).toHaveText([
    'Historical first',
    'Auction second',
  ]);
  await expect(page.getByText('Legacy record', { exact: true })).toBeVisible();
  // The header keeps purchase entry available alongside a populated, filtered history.
  const purchase = page
    .locator('.orders-workspace > .page-heading')
    .getByRole('link', { name: 'New purchase', exact: true });
  await expect(purchase).toHaveAttribute('href', '/new');
  await page.getByLabel('Order type', { exact: true }).selectOption('auction');
  await expect(page).toHaveURL(/kind=auction/);
  await page.getByRole('button', { name: 'Older orders' }).click();
  await expect(page).toHaveURL(/cursor=opaque-cursor/);
  await expect(purchase).toBeVisible();
  await page.goBack();
  await expect(page).not.toHaveURL(/cursor=/);
  await page.getByRole('button', { name: 'Clear filters', exact: true }).click();
  await expect(page).toHaveURL(/\/orders$/);
  await page.getByRole('link', { name: 'Historical first', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Seven-day fixture fleet' })).toBeVisible();
  expect(writes).toHaveLength(0);
});

test('Archive keeps completed order links and billing available across filters, pagination and Back', async ({
  page,
}) => {
  const reads: URL[] = [];
  const row = {
    id,
    key: `auction:${id}`,
    kind: 'auction',
    reference: 'AU-1111',
    title: 'Completed rental',
    status: 'completed',
    auctionStatus: 'ready',
    vmStatus: 'terminated',
    cleanupPending: false,
    createdAt: iso(-60000),
    closesAt: iso(-30000),
    expiresAt: iso(-1000),
    requestedQuantity: 1,
    approvedQuantity: 1,
    runningQuantity: 0,
    bidCount: 2,
    amount: { label: 'accepted', amountCents: 173.31 },
    detailUrl: `/requests/${id}`,
    vmUrl: `/vms/${id}`,
  };
  const writes = await fixture(page, 'buyer', (path, _method, _body, url) => {
    if (path !== '/api/orders') return;
    reads.push(url);
    return {
      serverNow: iso(0),
      nextCursor: url.searchParams.has('cursor') ? undefined : 'older-archive',
      items: url.searchParams.get('status') === 'history' ? [row] : [],
    };
  });
  await page.goto('/orders?kind=auction&cursor=old');
  await page.getByRole('button', { name: 'Archive', exact: true }).click();
  await expect(page).toHaveURL(/status=history/);
  expect(new URL(page.url()).searchParams.get('kind')).toBe('auction');
  expect(new URL(page.url()).searchParams.has('cursor')).toBe(false);
  await expect(page.getByRole('table')).toContainText('$1.7331');
  await expect(page.getByRole('link', { name: 'Completed rental', exact: true })).toHaveAttribute(
    'href',
    `/requests/${id}`,
  );
  await expect(page.getByRole('link', { name: 'Environment', exact: true })).toHaveAttribute(
    'href',
    `/vms/${id}`,
  );
  await page.getByRole('button', { name: 'Older orders' }).click();
  await expect(page).toHaveURL(/cursor=older-archive/);
  await page.reload();
  await expect(page.getByRole('button', { name: 'Archive', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await page.getByRole('button', { name: 'Active', exact: true }).click();
  await expect(page.getByRole('table')).toHaveCount(0);
  await page.goBack();
  await expect(page.getByRole('link', { name: 'Completed rental', exact: true })).toBeVisible();
  expect(reads.at(-1)?.searchParams.get('status')).toBe('history');
  expect(writes).toHaveLength(0);
});

test('Try again only GETs the original request and requires a new explicit auction submit', async ({
  page,
}) => {
  const writes = await fixture(page, 'buyer', (path, method) =>
    path === `/api/requests/${id}`
      ? { request, bids: [] }
      : path === '/api/requests' && method === 'POST'
        ? { ...request, id: 'new-request', status: 'open' }
        : path === '/api/requests/new-request'
          ? { request: { ...request, id: 'new-request', status: 'open' }, bids: [] }
          : undefined,
  );
  await page.goto(`/new?copy=${id}`);
  await expect(page).toHaveURL(/requests\/review/);
  await expect(page.getByText('Original immutable request', { exact: true }).first()).toBeVisible();
  expect(writes).toHaveLength(0);
  await page.getByRole('button', { name: 'Start 30-second auction', exact: true }).click();
  await expect(page).toHaveURL(/requests\/new-request/);
  expect(writes).toHaveLength(1);
  expect(writes[0].path).toBe('/api/requests');
  expect(writes[0].body).toMatchObject({ region: 'any', matchAcrossProviders: true });
});

test('Retrying a revoked configuration finds compatible providers without choosing a replacement', async ({
  page,
}) => {
  const writes = await fixture(page, 'buyer', (path, method) =>
    path === `/api/requests/${id}`
      ? { request: { ...request, catalogId: 'revoked-configuration' }, bids: [] }
      : path === '/api/requests' && method === 'POST'
        ? { ...request, id: 'replacement-request', status: 'open' }
        : path === '/api/requests/replacement-request'
          ? { request: { ...request, id: 'replacement-request', status: 'open' }, bids: [] }
          : undefined,
  );
  await page.goto(`/new?copy=${id}`);
  await expect(page).toHaveURL(/requests\/review/);
  await expect(page.getByRole('combobox', { name: /configuration|region/i })).toHaveCount(0);
  await expect(
    page.getByRole('button', { name: 'Start 30-second auction', exact: true }),
  ).toBeEnabled();
  expect(writes).toHaveLength(0);
  await page.getByRole('button', { name: 'Start 30-second auction', exact: true }).click();
  await expect(page).toHaveURL(/requests\/replacement-request/);
  expect(writes).toHaveLength(1);
  expect(writes[0].body.catalogId).toBe('micro');
  expect(writes[0].body).toMatchObject({ region: 'any', matchAcrossProviders: true });
});

test('Returning to the description preserves the manually reviewed environment choices', async ({
  page,
}) => {
  const writes = await fixture(page, 'buyer', (path, method) =>
    path === '/api/me'
      ? {
          user: {
            id: 'user-one',
            name: 'Fixture User',
            email: 'buyer@fixture.invalid',
            role: 'buyer',
          },
          modes: { wick: 'real', muse: 'fixture' },
          catalog: [
            ...catalog,
            {
              ...catalog[0],
              id: 'large',
              name: 'Large Linux',
              profile: 'large',
              cpu: 8,
              memoryGb: 16,
              region: 'eu',
            },
          ],
        }
      : path === '/api/requests' && method === 'POST'
        ? { ...request, id: 'edited-request', status: 'open' }
        : path === '/api/requests/edited-request'
          ? { request: { ...request, id: 'edited-request', status: 'open' }, bids: [] }
          : undefined,
  );
  await page.goto('/new/vm');
  await page.getByLabel('Describe your environment').fill('My environment');
  await page.getByRole('button', { name: 'Review manually', exact: true }).click();
  await page.getByRole('button', { name: '60 minutes', exact: true }).click();
  await page.getByLabel('Minimum vCPUs', { exact: true }).fill('4');
  await page.getByLabel('Minimum memory (GiB)', { exact: true }).fill('8');
  await page.getByLabel('Maximum total price (USD)', { exact: false }).fill('3.21');
  await page.getByRole('link', { name: 'Back to description', exact: true }).click();
  await page.getByLabel('Describe your environment').fill('My updated environment');
  await page.getByRole('button', { name: 'Review manually', exact: true }).click();

  await expect(page.getByRole('combobox', { name: /configuration|region/i })).toHaveCount(0);
  await expect(page.getByRole('checkbox', { name: /compatible providers/i })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '60 minutes', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(page.getByLabel('Minimum vCPUs', { exact: true })).toHaveValue('4');
  await expect(page.getByLabel('Minimum memory (GiB)', { exact: true })).toHaveValue('8');
  await expect(page.getByLabel('Maximum total price (USD)', { exact: false })).toHaveValue('3.21');
  expect(writes).toHaveLength(0);
  await page.getByRole('button', { name: 'Start 30-second auction', exact: true }).click();
  await expect(page).toHaveURL(/requests\/edited-request/);
  expect(writes).toHaveLength(1);
  expect(writes[0].body).toMatchObject({
    description: 'My updated environment',
    catalogId: 'large',
    region: 'any',
    matchAcrossProviders: true,
    durationMinutes: 60,
    requirements: { cpu: 4, memoryGb: 8 },
    maxPriceCents: 321,
  });
});

test('Auction history shows the completed rental and preserves the winning offer', async ({
  page,
}, testInfo) => {
  let reads = 0;
  await page.clock.install();
  const writes = await fixture(page, 'buyer', (path) =>
    path === `/api/requests/${id}`
      ? (reads++,
        {
          request: { ...request, status: 'ready', winningBidId: 'winning-bid' },
          bids: [
            {
              id: 'winning-bid',
              providerId: 'provider-one',
              providerName: 'Fixture E2B',
              totalPriceCents: 42,
              status: 'won',
              createdAt: iso(-30000),
            },
          ],
          vm: {
            id: 'completed-vm',
            requestId: id,
            status: 'terminated',
            catalogName: 'Micro Linux',
            expiresAt: iso(-1000),
            cleanupPending: false,
            cleanupConfirmedAt: iso(0),
          },
        })
      : undefined,
  );
  await page.goto(`/requests/${id}`);
  await expect(page.getByRole('heading', { name: 'Rental completed', exact: true })).toBeVisible();
  await expect(page.getByText('Winning offer', { exact: true })).toBeVisible();
  await expect(page.locator('.bid-price')).toContainText('$0.42');
  await expect(
    page.getByRole('link', { name: 'View environment history', exact: true }),
  ).toHaveAttribute('href', '/vms/completed-vm');
  await expect(
    page.getByRole('heading', { name: 'Environment ready', exact: true }),
  ).not.toBeVisible();
  await page.waitForTimeout(100);
  const settledReads = reads;
  await page.clock.fastForward(6000);
  expect(reads).toBe(settledReads);
  expect(writes).toHaveLength(0);
  await page.screenshot({
    path: testInfo.outputPath('completed-auction-desktop.png'),
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({
    path: testInfo.outputPath('completed-auction-mobile.png'),
    fullPage: true,
  });
});

test('Auction polling continues after rental expiry until cleanup is confirmed', async ({
  page,
}) => {
  const testNow = Date.now();
  await page.clock.install({ time: testNow });
  let reads = 0;
  let cleaned = false;
  await fixture(page, 'buyer', (path) =>
    path === `/api/requests/${id}`
      ? (reads++,
        {
          request: { ...request, status: 'ready' },
          bids: [],
          vm: {
            id: 'ending-vm',
            requestId: id,
            status: cleaned ? 'terminated' : 'running',
            catalogName: 'Micro Linux',
            expiresAt: new Date(testNow + 5000).toISOString(),
            cleanupPending: !cleaned,
            cleanupConfirmedAt: cleaned ? new Date(testNow + 8000).toISOString() : null,
          },
        })
      : undefined,
  );
  await page.goto(`/requests/${id}`);
  await expect(page.getByRole('heading', { name: 'Environment ready', exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Open environment', exact: true })).toBeVisible();
  await page.clock.fastForward(5500);
  await expect(
    page.getByRole('heading', { name: 'Environment ending', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText('Your browser terminal is available.', { exact: true }),
  ).not.toBeVisible();
  const endingReads = reads;
  await page.clock.fastForward(2500);
  await expect.poll(() => reads).toBeGreaterThan(endingReads);
  cleaned = true;
  await page.clock.fastForward(2500);
  await expect(page.getByRole('heading', { name: 'Rental completed', exact: true })).toBeVisible();
  await page.waitForTimeout(100);
  const settledReads = reads;
  await page.clock.fastForward(6000);
  expect(reads).toBe(settledReads);
});

test('counteroffer comparison makes every changed resource visible before acceptance', async ({
  page,
}) => {
  const desired = {
    catalogId: 'micro',
    cpu: 4,
    memoryGb: 8,
    region: 'us',
    durationMinutes: 30,
    maxPriceCents: 500,
  };
  const writes = await fixture(page, 'buyer', (path) =>
    path === `/api/intents/${id}`
      ? {
          intent: {
            id,
            description: 'A research environment',
            status: 'open',
            sourceMode: 'fixture',
            desired,
            flexibility: {
              minCPU: 2,
              minMemoryGb: 4,
              allowedRegions: ['us'],
              allowedDurations: [15, 30],
              hardMaxPriceCents: 500,
              gpu: 'preserve',
            },
            createdAt: iso(0),
          },
          offers: [
            {
              id: 'offer-one',
              providerName: 'Fixture supplier',
              catalogName: 'Small Linux',
              before: desired,
              after: { ...desired, cpu: 2, memoryGb: 4 },
              totalPriceCents: 123.45,
              tradeoffs: ['Less CPU and memory at a lower fixed price.'],
              expiresAt: iso(600000),
              mode: 'fixture',
              modelCalled: false,
            },
          ],
        }
      : undefined,
  );
  await page.goto(`/alternatives/${id}`);
  await page.getByRole('button', { name: 'Review this exact offer', exact: true }).click();
  const table = page.getByRole('table', { name: 'Alternative comparison', exact: true });
  await expect(table).toContainText('Originally requested');
  await expect(table.getByRole('rowheader', { name: 'Memory (GiB)', exact: true })).toBeVisible();
  expect(writes).toHaveLength(0);
});

test('Orders mobile layout keeps overflow inside the table', async ({ page }, testInfo) => {
  const tokenTitle =
      'Production language-model token capacity for a long-running multilingual document indexing service',
    tokenModel = 'provider/very-long-model-family-for-multilingual-document-indexing-2026-11',
    tokenUrl = '/token-orders/22222222-2222-4222-8222-222222222222';
  await fixture(page, 'buyer', (path) =>
    path === '/api/orders'
      ? {
          serverNow: iso(0),
          items: [
            {
              id,
              key: `agreement:${id}`,
              kind: 'agreement',
              reference: 'AG-11111111',
              title: 'Nightly development fleet with reserved continuation',
              status: 'approved',
              cleanupPending: false,
              createdAt: iso(-60000),
              closesAt: null,
              expiresAt: iso(7 * 86400000),
              requestedQuantity: 20,
              approvedQuantity: 12,
              runningQuantity: 0,
              bidCount: 0,
              amount: {
                label: 'reserved',
                amountCents: 14000,
                reservedCents: 14000,
                committedCents: 8400,
              },
              nextWindow: { startsAt: iso(3600000), endsAt: iso(28800000), timeZone: 'UTC' },
              detailUrl: `/orders/${id}`,
            },
            {
              id,
              key: `auction:${id}`,
              kind: 'auction',
              reference: 'AU-11111111',
              title: 'Completed instant environment with a frozen accepted quote',
              status: 'completed',
              auctionStatus: 'ready',
              vmStatus: 'terminated',
              cleanupPending: false,
              createdAt: iso(-120000),
              closesAt: iso(-90000),
              expiresAt: iso(-1000),
              requestedQuantity: 1,
              approvedQuantity: 1,
              runningQuantity: 0,
              bidCount: 4,
              amount: { label: 'accepted', amountCents: 120 },
              detailUrl: `/requests/${id}`,
              vmUrl: '/vms/mobile-fixture-vm',
            },
            {
              id: '22222222-2222-4222-8222-222222222222',
              key: 'token:22222222-2222-4222-8222-222222222222',
              kind: 'token',
              tokenMode: 'instant',
              reference: 'TOK-22222222',
              title: tokenTitle,
              modelId: tokenModel,
              inputTokens: 23456789,
              outputTokens: 1234567,
              status: 'completed',
              createdAt: iso(-180000),
              closesAt: null,
              expiresAt: iso(86400000),
              bidCount: 0,
              amount: { label: 'accepted', amountCents: 12345.67 },
              detailUrl: tokenUrl,
            },
          ],
        }
      : undefined,
  );
  for (const width of [1440, 1280, 390]) {
    await test.step(`${width}px Orders layout`, async () => {
      await page.setViewportSize({ width, height: 900 });
      await page.goto('/orders');
      await expect(page.getByRole('heading', { name: 'Orders' })).toBeVisible();
      await expect(page.locator('.market-table tbody tr')).toHaveCount(3);
      await expect(page.getByRole('columnheader', { name: 'Open', exact: true })).toHaveCount(1);
      await page.evaluate(() => document.fonts.ready);

      const title = page.getByRole('link', { name: tokenTitle, exact: true });
      await expect(title).toHaveAttribute('href', tokenUrl);
      await expect(title).toHaveAttribute('title', tokenTitle);
      const tokenRow = page.getByRole('row').filter({ has: title });
      await expect(tokenRow.locator('.orders-model')).toHaveAttribute('title', tokenModel);
      const quantities = tokenRow.getByText('23,456,789 in / 1,234,567 out', { exact: true });
      const price = tokenRow.locator('.orders-amount-cell > strong');
      await expect(quantities).toBeVisible();
      await expect(price).toHaveText('$123.4567');
      for (const value of [quantities, price]) {
        const geometry = await value.evaluate((element) => {
          const text = document.createRange();
          text.selectNodeContents(element);
          const content = text.getBoundingClientRect();
          const box = element.getBoundingClientRect();
          const cell = element.closest('td')!;
          const cellBox = cell.getBoundingClientRect();
          const cellStyle = getComputedStyle(cell);
          return {
            textWidth: content.width,
            availableWidth: box.width,
            left: content.left,
            right: content.right,
            cellLeft: cellBox.left + parseFloat(cellStyle.paddingLeft),
            cellRight: cellBox.right - parseFloat(cellStyle.paddingRight),
          };
        });
        expect(
          geometry.textWidth,
          `${width}px: numerical text fits its element`,
        ).toBeLessThanOrEqual(geometry.availableWidth + 1);
        expect(
          geometry.left,
          `${width}px: numerical text stays inside its cell`,
        ).toBeGreaterThanOrEqual(geometry.cellLeft - 1);
        expect(
          geometry.right,
          `${width}px: numerical text is not clipped by the next column`,
        ).toBeLessThanOrEqual(geometry.cellRight + 1);
      }

      const wrapper = page.locator('.market-table-scroll');
      const widths = await wrapper.evaluate((element) => ({
        visible: element.clientWidth,
        scroll: element.scrollWidth,
        table: element.querySelector('table')!.getBoundingClientRect().width,
      }));
      if (width === 390) {
        expect(widths.table).toBeGreaterThan(widths.visible);
        expect(widths.scroll).toBeGreaterThan(widths.visible);
      }
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
        `${width}px: horizontal overflow stays inside the table`,
      ).toBe(true);
      if (process.env.TABLE_REVIEW === '1') {
        await page.locator('.market-orders').screenshot({
          path: testInfo.outputPath(`orders-panel-${width}.png`),
        });
      }
      await wrapper.scrollIntoViewIfNeeded();
      await wrapper.evaluate((element) => {
        element.scrollLeft = element.scrollWidth;
      });
      if (widths.scroll > widths.visible) {
        expect(await wrapper.evaluate((element) => element.scrollLeft)).toBeGreaterThan(0);
      }
      for (const action of await page.locator('.orders-actions-cell a').all()) {
        await expect(action).toBeInViewport({ ratio: 1 });
        await action.focus();
        await expect(action).toBeFocused();
      }
      expect(await page.evaluate(() => window.scrollX)).toBe(0);
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      ).toBe(true);
    });
  }
});

test('Orders distinguishes the maximum reservation ceiling from actual credit held', async ({
  page,
}) => {
  await fixture(page, 'buyer', (path) =>
    path === '/api/orders'
      ? {
          serverNow: iso(0),
          items: [
            {
              id,
              key: `agreement:${id}`,
              kind: 'agreement',
              reference: 'AG-1111',
              title: 'Needs funding',
              status: 'needs_credit',
              createdAt: iso(0),
              closesAt: null,
              expiresAt: iso(86400000),
              requestedQuantity: 20,
              approvedQuantity: 0,
              runningQuantity: 0,
              bidCount: 0,
              amount: {
                label: 'reserved',
                amountCents: 14000,
                reservedCents: 0,
                committedCents: 0,
              },
              detailUrl: `/orders/${id}`,
            },
          ],
        }
      : undefined,
  );
  await page.goto('/orders');
  const price = page.locator('.market-table tbody tr td').nth(2);
  await expect(price.locator('strong')).toHaveText('$0.00');
  await expect(price).toContainText('Broker credit reserved');
  await expect(price).toContainText('Full-term maximum $140.00');
});

test('Admin pilot credit grant is reviewed and distinct from Wick compute funding', async ({
  page,
}) => {
  const writes = await fixture(page, 'admin', (path, method) =>
    path === '/api/admin/config'
      ? { catalog, providers: [], unresolved: [], maxConcurrentVms: 20 }
      : path === '/api/admin/credit-buyers'
        ? { items: [{ id: 'buyer-one', name: 'Pilot Buyer', email: 'buyer@fixture.invalid' }] }
        : path === '/api/admin/credits' && method === 'POST'
          ? wallet
          : undefined,
  );
  await page.goto('/admin');
  await page.getByLabel('Buyer account', { exact: true }).selectOption('buyer-one');
  await page.getByLabel('Credit amount (USD)', { exact: true }).fill('140.00');
  await page.getByLabel('Grant reason', { exact: true }).fill('Seven-day pilot');
  await page.getByRole('button', { name: 'Review credit grant', exact: true }).click();
  expect(writes).toHaveLength(0);
  await page.getByRole('button', { name: 'Grant Broker credit', exact: true }).click();
  await expect(page.getByText('Wick compute credit is unchanged.', { exact: false })).toBeVisible();
  expect(writes).toHaveLength(1);
  expect(writes[0].body).toMatchObject({
    buyerId: 'buyer-one',
    amountCents: 14000,
    description: 'Seven-day pilot',
  });
  expect(writes[0].body.operationKey).toBeTruthy();
});

test('Live Orders pauses polling in a hidden tab and refreshes when visible', async ({ page }) => {
  let reads = 0;
  await fixture(page, 'buyer', (path) =>
    path === '/api/orders'
      ? (reads++,
        {
          serverNow: iso(0),
          items: [
            {
              id,
              key: `auction:${id}`,
              kind: 'auction',
              reference: 'AUC-1111',
              title: 'Live fixture',
              status: 'open',
              auctionStatus: 'open',
              createdAt: iso(0),
              closesAt: iso(30000),
              expiresAt: null,
              requestedQuantity: 1,
              approvedQuantity: 0,
              runningQuantity: 0,
              bidCount: 0,
              amount: { label: 'budget', amountCents: 100 },
              detailUrl: `/requests/${id}`,
            },
          ],
        })
      : undefined,
  );
  await page.goto('/orders');
  await expect(page.getByText('Live fixture', { exact: true })).toBeVisible();
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await page.waitForTimeout(150);
  const hiddenReads = reads;
  await page.waitForTimeout(2200);
  expect(reads).toBe(hiddenReads);
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await expect.poll(() => reads).toBe(hiddenReads + 1);
});

test('Scheduled VM details use explicit attribution and never describe an additional rental charge', async ({
  page,
}) => {
  await fixture(page, 'buyer', (path) =>
    path === '/api/vms/scheduled-vm'
      ? {
          id: 'scheduled-vm',
          requestId: 'scheduled-request',
          buyerId: 'user-one',
          sourceMode: 'fixture',
          status: 'running',
          expiresAt: iso(7200000),
          readyAt: iso(-1000),
          createdAt: iso(-10000),
          catalogName: 'Micro Linux',
          region: 'us',
          durationMinutes: 120,
          priceCents: 100,
          cleanupPending: false,
          billingSource: 'scheduled_capacity',
          agreementId: id,
          scheduledWindow: {
            windowId: 'window-one',
            startsAt: iso(-60000),
            discountEndsAt: iso(3600000),
            endsAt: iso(7200000),
            discountRateCentsPerHour: 10,
            normalRateCentsPerHour: 20,
          },
        }
      : undefined,
  );
  await page.goto('/vms/scheduled-vm');
  await expect(
    page.getByRole('heading', { name: 'Historical booking · access deadlines', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText('Part of your agreement · no additional VM charge', { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('link', { name: 'View historical booking', exact: true }),
  ).toHaveAttribute('href', `/orders/${id}`);
  await expect(
    page.getByText('Only charged after confirmed readiness', { exact: true }),
  ).not.toBeVisible();
});

test('Settled capacity charges render without VM IDs and assess 15% after failed-start credit', async ({
  page,
}) => {
  const charge = {
    id: 'charge-one',
    agreementId: id,
    windowId: 'window-one',
    description: 'Settled scheduled fleet',
    providerName: 'Fixture E2B',
    quantity: 12,
    startsAt: iso(-7200000),
    discountEndsAt: iso(-3600000),
    endsAt: iso(-1000),
    discountRateCentsPerHour: 10,
    normalRateCentsPerHour: 20,
    grossCents: 1000,
    creditCents: 200,
    totalCents: 800,
    feeCents: 0,
    revenueShare: {
      commissionBps: 1500,
      grossCents: 800,
      brokerFeeMicros: '1200000',
      providerNetMicros: '6800000',
    },
    createdAt: iso(0),
    currency: 'USD',
    status: 'pilot-credit',
    label: 'Booked capacity settled with Broker pilot credit; no external payment or payout.',
  };
  await fixture(page, 'provider', (path) =>
    path === '/api/provider/earnings'
      ? { items: [] }
      : path === '/api/provider/agreement-charges'
        ? { items: [charge] }
        : undefined,
  );
  await page.goto('/provider/earnings');
  await expect(
    page.getByRole('heading', { name: 'Historical capacity charges', exact: true }),
  ).toBeVisible();
  const row = page.locator('.market-table tr').filter({ hasText: 'Settled scheduled fleet' });
  await expect(row).toContainText('$8.00');
  await expect(row.getByRole('cell', { name: '$1.20', exact: true })).toBeVisible();
  await expect(row).toContainText('$6.80');
  await expect(row).toContainText('Buyer fee $0.00');
  await expect(row).toContainText('no external payment or payout');
});

test('A fully terminal Orders page stops polling while preserving explicit refresh', async ({
  page,
}) => {
  await page.clock.install({ time: new Date(now) });
  let reads = 0;
  await fixture(page, 'buyer', (path) =>
    path === '/api/orders'
      ? (reads++,
        {
          serverNow: iso(0),
          items: [
            {
              id,
              key: `auction:${id}`,
              kind: 'auction',
              reference: 'AU-1111',
              title: 'Completed order',
              status: 'completed',
              auctionStatus: 'ready',
              vmStatus: 'terminated',
              cleanupPending: false,
              createdAt: iso(-60000),
              closesAt: iso(-30000),
              expiresAt: iso(-1000),
              requestedQuantity: 1,
              approvedQuantity: 1,
              runningQuantity: 0,
              bidCount: 2,
              amount: { label: 'accepted', amountCents: 100 },
              detailUrl: `/requests/${id}`,
            },
          ],
        })
      : undefined,
  );
  await page.goto('/orders?status=history');
  await expect(page.getByText('Completed order', { exact: true })).toBeVisible();
  const initial = reads;
  await page.clock.fastForward(15000);
  expect(reads).toBe(initial);
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect.poll(() => reads).toBe(initial + 1);
  await page.clock.fastForward(15000);
  expect(reads).toBe(initial + 1);
});

test('Environment mode explains fixture compute and Muse honestly and closes on Escape', async ({
  page,
}) => {
  const writes = await fixture(page, 'buyer', (path) =>
    path === '/api/orders' ? { items: [], serverNow: iso(0) } : undefined,
  );
  await page.goto('/orders');
  const mode = page.locator('summary[aria-label="Environment mode"]');
  await expect(mode).toContainText('Demo environment');
  await expect(page.getByText('Simulated environments', { exact: true })).not.toBeVisible();
  await mode.click();
  await expect(page.getByText('Simulated environments', { exact: true })).toBeVisible();
  await expect(
    page.getByText('VMs and terminals use fixtures. No real compute is allocated.', {
      exact: true,
    }),
  ).toBeVisible();
  await expect(page.getByText('Muse fixture · no model calls', { exact: true })).toBeVisible();
  await expect(
    page.getByText('Pilot pricing · no payment collected', { exact: true }),
  ).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('.environment-status')).not.toHaveAttribute('open');
  await expect(mode).toBeFocused();
  expect(writes).toHaveLength(0);
});

test('Mobile navigation traps focus, locks background and restores the toggle on Escape', async ({
  page,
}) => {
  const writes = await fixture(page, 'buyer', (path) =>
    path === '/api/orders' ? { items: [], serverNow: iso(0) } : undefined,
  );
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/orders');
  await expect(page.getByRole('heading', { name: 'Orders', exact: true })).toBeVisible();
  const toggle = page.getByRole('button', { name: 'Open navigation', exact: true });
  const originalOverflow = await page.evaluate(() => document.body.style.overflow);
  await expect(page.locator('.sidebar')).toHaveCSS('visibility', 'hidden');
  await toggle.click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Close navigation', exact: true })).toBeFocused();
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  await expect(page.locator('.main-shell')).toHaveAttribute('inert');
  expect(await page.evaluate(() => document.body.style.overflow)).toBe('hidden');
  const focusable = dialog.locator('a[href], button:not([disabled])');
  await focusable.last().focus();
  await page.keyboard.press('Tab');
  await expect(focusable.first()).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(focusable.last()).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.locator('.main-shell')).not.toHaveAttribute('inert');
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await expect(toggle).toBeFocused();
  expect(await page.evaluate(() => document.body.style.overflow)).toBe(originalOverflow);
  await expect(page.locator('.sidebar')).toHaveCSS('visibility', 'hidden');
  await page.keyboard.press('Tab');
  expect(await page.evaluate(() => document.activeElement?.closest('.sidebar') === null)).toBe(
    true,
  );
  expect(writes).toHaveLength(0);
});

test('Real Muse policy proposal identifies Spark Open on Baseten and remains an unapplied draft', async ({
  page,
}) => {
  const writes = await fixture(page, 'provider', (path, method) =>
    path === '/api/me'
      ? {
          user: {
            id: 'user-one',
            name: 'Fixture Provider',
            email: 'provider@fixture.invalid',
            role: 'provider',
          },
          modes: { wick: 'fixture', muse: 'real' },
          catalog,
        }
      : path === '/api/provider/policy/propose' && method === 'POST'
        ? {
            policy: {
              autoBid: true,
              minimumPriceCents: 100,
              basePriceCents: 200,
              maxPriceCents: 300,
              allowedCatalogIds: ['micro'],
              reserveSlots: 1,
            },
            baseRevision: 1,
            capacity: { total: 20, held: 0, available: 20 },
            mode: 'real',
            modelCalled: true,
            receipt: {
              observed: ['Keep one slot spare.'],
              decision: 'Review the proposed limits before applying them.',
              constraints: ['No policy or capacity changed.'],
            },
            reasoning_content: 'PRIVATE_REASONING_MUST_NOT_RENDER',
          }
        : undefined,
  );
  await page.goto('/provider/policy');
  await page.locator('summary[aria-label="Environment mode"]').click();
  await expect(page.locator('.environment-popover')).toContainText('Muse Spark Open · Baseten');
  await expect(page.locator('.environment-popover')).toContainText(
    'meta-models/muse-spark-open-1026',
  );
  await page.keyboard.press('Escape');
  await page
    .getByLabel('Natural-language selling strategy')
    .fill('Keep one slot spare and prepare editable pricing limits.');
  await page.getByRole('button', { name: 'Propose editable limits', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Proposed limits · not active', exact: true }),
  ).toBeVisible();
  await expect(page.locator('.muse-receipt .tiny-label')).toHaveText('Muse Spark Open · Baseten');
  await expect(page.locator('#reserve-slots')).toHaveValue('1');
  expect(Number(await page.locator('#base-price').inputValue())).toBe(2);
  await expect(page.getByText('PRIVATE_REASONING_MUST_NOT_RENDER', { exact: false })).toHaveCount(
    0,
  );
  expect(writes.map((write) => write.path)).toEqual(['/api/provider/policy/propose']);
});

test('VM purchase options no longer advertise schedules and retired deep links cannot create orders', async ({
  page,
}) => {
  const reads: string[] = [];
  const writes = await fixture(page, 'buyer', (path) => {
    reads.push(path);
    return undefined;
  });
  await page.goto('/new');
  await expect(page.getByRole('link', { name: 'Configure VM', exact: true })).toBeVisible();
  await expect(page.locator('a[href="/agreements/new"]')).toHaveCount(0);
  await expect(page.getByText(/Schedule bulk capacity|Scheduled VMs · bulk agreement/)).toHaveCount(
    0,
  );
  await page.goto('/new/vm');
  await expect(page.getByRole('heading', { name: 'Launch a VM', exact: true })).toBeVisible();
  await expect(page.getByLabel('Choose order type')).toHaveCount(0);
  await page.goto('/agreements/new');
  await expect(
    page.getByRole('heading', { name: 'Scheduled VMs have been removed' }),
  ).toBeVisible();
  await expect(page.getByRole('link', { name: 'Launch a VM', exact: true })).toHaveAttribute(
    'href',
    '/new/vm',
  );
  await expect(page.locator('form')).toHaveCount(0);
  expect(reads.filter((path) => path.startsWith('/api/agreements'))).toEqual([]);
  expect(writes).toEqual([]);
});

test('provider workspace removes scheduled navigation, publication and calendar controls', async ({
  page,
}) => {
  const reads: string[] = [];
  const writes = await fixture(page, 'provider', (path) => {
    reads.push(path);
    return undefined;
  });
  await page.goto('/provider/capacity');
  await expect(page.getByRole('heading', { name: 'Capacity', exact: true })).toBeVisible();
  await expect(page.locator('a[href="/provider/scheduled"]')).toHaveCount(0);
  await expect(page.getByText('View booked windows', { exact: true })).toHaveCount(0);
  await page.goto('/provider/scheduled');
  await expect(
    page.getByRole('heading', { name: 'Scheduled VMs have been removed' }),
  ).toBeVisible();
  await expect(page.getByRole('link', { name: 'Manage VM offers', exact: true })).toHaveAttribute(
    'href',
    '/provider/offerings',
  );
  await expect(page.locator('form')).toHaveCount(0);
  expect(reads.filter((path) => path.startsWith('/api/provider/scheduled'))).toEqual([]);
  expect(writes).toEqual([]);
});

test('existing booking history remains read-only and retains accepted prices and environment links', async ({
  page,
}) => {
  const data = detail();
  data.bookings = [
    {
      id: 'booking-one',
      windowId: 'window-one',
      providerId: 'supplier-one',
      providerName: 'Original supplier',
      catalogId: 'micro',
      quantity: 12,
      unitPriceCents: 100,
      totalCents: 1200,
      startsAt: iso(-10000),
      discountEndsAt: iso(-5000),
      endsAt: iso(10000),
      discountRateCentsPerHour: 10,
      normalRateCentsPerHour: 20,
    },
  ] as any;
  data.activations = [
    {
      id: 'activation-one',
      windowId: 'window-one',
      status: 'terminated',
      requestId: 'request-one',
      vmId: 'historical-vm',
      endsAt: iso(-1000),
      createdAt: iso(-10000),
    },
  ] as any;
  const writes = await fixture(page, 'buyer', (path) =>
    path === `/api/agreements/${id}` ? data : undefined,
  );
  await page.goto(`/orders/${id}`);
  await expect(page.getByRole('heading', { name: 'Booking history', exact: true })).toBeVisible();
  await expect(page.getByRole('table', { name: 'Historical capacity bookings' })).toContainText(
    '$12.00',
  );
  await expect(page.getByRole('link', { name: 'Open environment', exact: true })).toHaveAttribute(
    'href',
    '/vms/historical-vm',
  );
  await expect(
    page.getByRole('button', { name: /Start|Activate|Cancel unmatched|Draft with Muse/ }),
  ).toHaveCount(0);
  await expect(page.locator('form')).toHaveCount(0);
  expect(writes).toEqual([]);
});

test('Broker wallet keeps agent funding and historical ledger links without schedule marketing', async ({
  page,
}) => {
  const writes = await fixture(page, 'buyer', (path) =>
    path === '/api/credits/history'
      ? {
          wallet,
          items: [
            {
              id: 'ledger-one',
              kind: 'reserve',
              amountCents: 0,
              reservedDeltaCents: 100,
              agreementId: id,
              operationKey: 'historical-reserve',
              createdAt: iso(-1000),
              description: 'Original accepted booking reserve',
            },
          ],
        }
      : undefined,
  );
  await page.goto('/credits');
  await expect(page.getByRole('heading', { name: 'Broker wallet', exact: true })).toBeVisible();
  await expect(
    page.getByRole('link', { name: 'Manage agent budgets', exact: true }),
  ).toHaveAttribute('href', '/agents');
  await expect(
    page.getByRole('link', { name: 'View historical booking', exact: true }),
  ).toHaveAttribute('href', `/orders/${id}`);
  await expect(page.getByText(/scheduled VM bookings|reserve scheduled VM capacity/)).toHaveCount(
    0,
  );
  expect(writes).toEqual([]);
});
