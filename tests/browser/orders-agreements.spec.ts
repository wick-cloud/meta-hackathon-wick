import { expect, test, type Page } from '@playwright/test';

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
type Handler = (path: string, method: string, body: any) => unknown;
async function fixture(page: Page, role: 'buyer' | 'provider' | 'admin', handler: Handler) {
  const writes: { path: string; body: any }[] = [];
  await page.route('**/api/**', async (route) => {
    const req = route.request(),
      path = new URL(req.url()).pathname,
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
    const response = handler(path, method, body) ?? common[path];
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
              title: 'Scheduled first',
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
    'Scheduled first',
    'Auction second',
  ]);
  await expect(page.getByText('Pending matching', { exact: true })).toBeVisible();
  await page.getByLabel('Order type', { exact: true }).selectOption('agreement');
  await expect(page).toHaveURL(/kind=agreement/);
  await page.getByRole('button', { name: 'Older orders' }).click();
  await expect(page).toHaveURL(/cursor=opaque-cursor/);
  await page.goBack();
  await expect(page).not.toHaveURL(/cursor=/);
  await page.getByRole('link', { name: 'Scheduled first', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Seven-day fixture fleet' })).toBeVisible();
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
});

test('Agreement review reserves the full target maximum and does not start VMs', async ({
  page,
}) => {
  const writes = await fixture(page, 'buyer', (path, method) =>
    path === '/api/agreements' && method === 'POST'
      ? detail()
      : path === `/api/agreements/${id}`
        ? detail()
        : undefined,
  );
  await page.goto('/agreements/new');
  await page.getByLabel('Agreement name', { exact: true }).fill('Nightly fleet');
  await page.getByLabel('Target slots per window', { exact: true }).fill('20');
  await page.getByLabel('Minimum approved per window', { exact: true }).fill('12');
  await page.getByLabel('Reserve a normal-rate continuation').check();
  await page.getByRole('button', { name: 'Review agreement', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Review your seven-day agreement.' }),
  ).toBeVisible();
  await expect(page.getByText('$140.00 maximum', { exact: true })).toBeVisible();
  expect(writes).toHaveLength(0);
  await page.getByLabel('I accept the booked-capacity charges', { exact: false }).check();
  await page.getByRole('button', { name: 'Fund & request capacity', exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/orders/${id}`));
  expect(writes).toHaveLength(1);
  expect(writes[0].body).toMatchObject({
    minimumQuantity: 12,
    targetQuantity: 20,
    continuation: { enabled: true, until: '08:00', maxRateCentsPerHour: 20 },
  });
  expect(writes[0].body.operationKey).toBeTruthy();
});

test('Manual VM starts use the authoritative available slots and a separate confirmation', async ({
  page,
}) => {
  const writes = await fixture(page, 'buyer', (path, method) =>
    path === `/api/agreements/${id}`
      ? detail()
      : path.endsWith('/activate') && method === 'POST'
        ? { activations: [{ id: 'activation-one' }, { id: 'activation-two' }], replayed: false }
        : undefined,
  );
  await page.goto(`/orders/${id}`);
  const quantity = page.getByLabel('VMs to start manually', { exact: true });
  await expect(quantity).toHaveAttribute('max', '3');
  await quantity.fill('4');
  await expect(page.getByRole('button', { name: 'Review VM starts' })).toBeDisabled();
  await quantity.fill('2');
  await page.getByRole('button', { name: 'Review VM starts' }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  expect(writes).toHaveLength(0);
  await page.getByRole('button', { name: 'Start VMs', exact: true }).click();
  await expect(page.getByRole('dialog')).not.toBeVisible();
  expect(writes).toHaveLength(1);
  expect(writes[0].body).toMatchObject({ windowId: 'window-one', quantity: 2 });
  expect(writes[0].body.operationKey).toBeTruthy();
});

test('Provider schedule separates location from clock and requires publication review', async ({
  page,
}) => {
  const writes = await fixture(page, 'provider', (path, method, body) =>
    path === '/api/provider/scheduled-offerings'
      ? method === 'POST'
        ? { ...body, id, active: true, revision: 1, deadlineEligible: true }
        : { items: [] }
      : path === '/api/provider/commitments' || path === '/api/provider/agreement-demand'
        ? { items: [] }
        : undefined,
  );
  await page.goto('/provider/scheduled');
  await page.getByRole('button', { name: 'Publish scheduled offering', exact: true }).click();
  await page.getByLabel('Offering name', { exact: true }).fill('Quiet hours');
  await page.getByLabel('Schedule time zone (IANA)', { exact: true }).fill('Asia/Singapore');
  await page.getByRole('button', { name: 'Review publication', exact: true }).click();
  await expect(page.getByText('Asia/Singapore · Sun, Mon, Tue, Wed, Thu, Fri, Sat')).toBeVisible();
  await expect(page.getByText('Compute region', { exact: true })).toBeVisible();
  expect(writes).toHaveLength(0);
  await page
    .getByRole('button', { name: 'Publish scheduled offering', exact: true })
    .last()
    .click();
  await expect(page.getByText('Scheduled offering published.', { exact: false })).toBeVisible();
  expect(writes).toHaveLength(1);
  expect(writes[0].body).toMatchObject({
    catalogId: 'micro',
    timeZone: 'Asia/Singapore',
    windowEnd: '06:00',
    availableUntil: '08:00',
  });
  expect(writes[0].body.operationKey).toBeTruthy();
});

test('Orders mobile layout keeps overflow inside the table', async ({ page }) => {
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
          ],
        }
      : undefined,
  );
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/orders');
  await expect(page.getByRole('heading', { name: 'Every order. One place.' })).toBeVisible();
  await expect(page.locator('.market-table tbody tr')).toHaveCount(2);
  await expect(page.getByRole('columnheader', { name: 'Open', exact: true })).toHaveCount(1);
  const wrapper = page.locator('.market-table-scroll');
  const widths = await wrapper.evaluate((element) => ({
    visible: element.clientWidth,
    scroll: element.scrollWidth,
    table: element.querySelector('table')!.getBoundingClientRect().width,
  }));
  expect(widths.table).toBeGreaterThan(widths.visible);
  expect(widths.scroll).toBeGreaterThan(widths.visible);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await wrapper.evaluate((element) => {
    element.scrollLeft = element.scrollWidth;
  });
  expect(await wrapper.evaluate((element) => element.scrollLeft)).toBeGreaterThan(0);
  expect(await page.evaluate(() => window.scrollX)).toBe(0);
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

test('Muse prepares an honest fixture draft without creating an agreement', async ({ page }) => {
  const writes = await fixture(page, 'buyer', (path) =>
    path === '/api/agreements/draft'
      ? {
          draft: {
            description: 'Prepared quiet-hours fleet',
            targetQuantity: 20,
            minimumQuantity: 12,
            timeZone: 'UTC',
            region: 'us',
            requirements: { cpu: 1, memoryGb: 1 },
          },
          mode: 'fixture',
          modelCalled: false,
          explanation: 'Parsed local fixture fields; review them before submitting.',
        }
      : undefined,
  );
  await page.goto('/agreements/new');
  await page
    .getByLabel('Describe your schedule', { exact: true })
    .fill('20 slots, minimum 12, overnight in UTC');
  await page.getByRole('button', { name: 'Prepare draft', exact: true }).click();
  await expect(page.getByText('Fixture draft · no model call', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Use draft in form', exact: true }).click();
  await expect(page.getByLabel('Agreement name', { exact: true })).toHaveValue(
    'Prepared quiet-hours fleet',
  );
  await expect(page.getByLabel('Target slots per window', { exact: true })).toHaveValue('20');
  expect(writes.map((w) => w.path)).toEqual(['/api/agreements/draft']);
});

test('A credit-blocked agreement cannot start VMs even when a stale slot count exists', async ({
  page,
}) => {
  const blocked = detail();
  Object.assign(blocked.agreement, {
    status: 'open',
    blockedCode: 'needs_credit',
    blockedReason: 'Add Broker credit to reserve this agreement.',
    reservedCents: 0,
  });
  const writes = await fixture(page, 'buyer', (path) =>
    path === `/api/agreements/${id}` ? blocked : undefined,
  );
  await page.goto(`/orders/${id}`);
  await expect(page.getByRole('button', { name: 'Review VM starts' })).toBeDisabled();
  await expect(
    page.getByText('Add Broker credit to reserve this agreement.', { exact: true }),
  ).toBeVisible();
  expect(writes).toHaveLength(0);
});

test('An active window changes only its displayed billing segment at the discount boundary', async ({
  page,
}) => {
  await page.clock.install({ time: new Date(now) });
  const active = detail();
  active.agreement.windows[0]!.discountEndsAt = iso(5000);
  const response = {
    ...active,
    bookings: [
      {
        id: 'booking-one',
        windowId: 'window-one',
        providerId: 'supplier-one',
        providerName: 'Fixture E2B',
        catalogId: 'micro',
        quantity: 12,
        unitPriceCents: 100,
        totalCents: 1200,
        startsAt: iso(-60000),
        discountEndsAt: iso(5000),
        endsAt: iso(7200000),
        discountRateCentsPerHour: 10,
        normalRateCentsPerHour: 20,
      },
    ],
  };
  const writes = await fixture(page, 'buyer', (path) =>
    path === `/api/agreements/${id}` ? response : undefined,
  );
  await page.goto(`/orders/${id}`);
  await expect(
    page.getByText('Current matched rate: $0.10 / VM-hour', { exact: true }),
  ).toBeVisible();
  await page.clock.fastForward(6000);
  await expect(
    page.getByText('Current matched rate: $0.20 / VM-hour', { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText('Reserved continuation · matched normal rate now applies.', { exact: false }),
  ).toBeVisible();
  expect(writes).toHaveLength(0);
});

test('Cancelling unmatched capacity requires explicit review and preserves the cancellation key', async ({
  page,
}) => {
  const writes = await fixture(page, 'buyer', (path, method) =>
    path === `/api/agreements/${id}` || (path.endsWith('/cancel-unmatched') && method === 'POST')
      ? detail()
      : undefined,
  );
  await page.goto(`/orders/${id}`);
  await page.getByRole('button', { name: 'Cancel unmatched remainder', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText('Booked capacity remains payable');
  expect(writes).toHaveLength(0);
  await page
    .getByRole('dialog')
    .getByRole('button', { name: 'Cancel unmatched remainder', exact: true })
    .click();
  await expect(page.getByRole('dialog')).not.toBeVisible();
  expect(writes).toHaveLength(1);
  expect(writes[0]).toMatchObject({ path: `/api/agreements/${id}/cancel-unmatched` });
  expect(writes[0].body.operationKey).toBeTruthy();
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
    page.getByRole('heading', { name: 'Scheduled capacity · separate clocks', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText('Part of your agreement · no additional VM charge', { exact: true }),
  ).toBeVisible();
  await expect(page.getByRole('link', { name: 'View agreement', exact: true })).toHaveAttribute(
    'href',
    `/orders/${id}`,
  );
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
    page.getByRole('heading', { name: 'Scheduled agreement charges', exact: true }),
  ).toBeVisible();
  const row = page.locator('.market-table tr').filter({ hasText: 'Settled scheduled fleet' });
  await expect(row).toContainText('$8.00');
  await expect(row.getByRole('cell', { name: '$1.20', exact: true })).toBeVisible();
  await expect(row).toContainText('$6.80');
  await expect(row).toContainText('Buyer fee $0.00');
  await expect(row).toContainText('no external payment or payout');
});

test('Committed admission rejection refreshes one failed receipt without a VM link or premature credit', async ({
  page,
}) => {
  let rejected = false;
  const denied = {
    id: 'rejected-receipt',
    windowId: 'window-one',
    status: 'failed',
    requestId: null,
    vmId: null,
    createdAt: iso(0),
    endsAt: iso(7200000),
    failureReason:
      '[ROUTE_ADMISSION_DENIED] The booked provider route no longer permits admission.',
  };
  await fixture(page, 'buyer', (path) =>
    path === `/api/agreements/${id}`
      ? { ...detail(), activations: rejected ? [denied] : [] }
      : undefined,
  );
  const attempts: any[] = [];
  await page.route(`**/api/agreements/${id}/activate`, async (route) => {
    rejected = true;
    attempts.push(route.request().postDataJSON());
    await route.fulfill({ status: 409, json: { error: denied.failureReason } });
  });
  await page.goto(`/orders/${id}`);
  await page.getByRole('button', { name: 'Review VM starts', exact: true }).click();
  await page.getByRole('button', { name: 'Start VMs', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText('ROUTE_ADMISSION_DENIED');
  // A retry of the still-open review keeps its operation key and the committed receipt.
  await page.getByRole('button', { name: 'Start VMs', exact: true }).click();
  await expect.poll(() => attempts.length).toBe(2);
  expect(attempts[0].operationKey).toBe(attempts[1].operationKey);
  await page.getByRole('dialog').getByRole('button', { name: 'Back', exact: true }).click();
  const receipt = page.locator('.market-activation').filter({ hasText: 'VM start rejected' });
  await expect(receipt).toHaveCount(1);
  await expect(receipt).toContainText('No environment created');
  await expect(receipt).toContainText('ROUTE_ADMISSION_DENIED');
  await expect(receipt).toContainText('adjustments are finalized when the window settles');
  await expect(receipt.locator('a')).toHaveCount(0);
  await expect(page.locator('a[href="/vms/null"], a[href="/requests/null"]')).toHaveCount(0);
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

test('Provider capacity calendar orders loaded windows by start time then ID and labels runtime holds', async ({
  page,
}) => {
  const base = {
    agreementId: id,
    providerId: 'supplier-one',
    providerName: 'Fixture E2B',
    catalogId: 'micro',
    windowId: 'window-one',
    quantity: 12,
    unitPriceCents: 100,
    totalCents: 1200,
    discountEndsAt: iso(7200000),
    endsAt: iso(10800000),
    discountRateCentsPerHour: 10,
    normalRateCentsPerHour: 20,
    runningQuantity: 2,
  };
  const items = [
    {
      ...base,
      id: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
      startsAt: iso(3600000),
      agreementDescription: 'Earlier window, higher ID',
    },
    {
      ...base,
      id: '11111111-1111-4111-8111-111111111111',
      startsAt: iso(7200000),
      agreementDescription: 'Later window, lower ID',
    },
    {
      ...base,
      id: '00000000-0000-4000-8000-000000000000',
      startsAt: iso(3600000),
      agreementDescription: 'Earlier window, lower ID',
    },
  ];
  await fixture(page, 'provider', (path) =>
    path === '/api/provider/commitments'
      ? { items }
      : path === '/api/provider/scheduled-offerings' || path === '/api/provider/agreement-demand'
        ? { items: [] }
        : undefined,
  );
  await page.goto('/provider/scheduled');
  await page.getByRole('button', { name: 'Capacity calendar', exact: true }).click();
  await expect(page.locator('.market-table tbody tr td:first-child > strong')).toHaveText([
    'Earlier window, lower ID',
    'Earlier window, higher ID',
    'Later window, lower ID',
  ]);
  await expect(
    page.getByText('2 runtime slots held · idle slots remain paid', { exact: true }),
  ).toHaveCount(3);
});
