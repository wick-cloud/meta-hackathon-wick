import { expect, test, type Page } from './table-review';
import { managedPricing, sponsoredComputeQuote } from '../../src/shared/pricing';
import type { CatalogItem } from '../../src/shared/types';
import type { Bid } from '../../src/client/api';
import { compareComputeBids } from '../../src/client/api';

// Every API is intercepted. These fixtures neither allocate compute nor change supply.
const modal: CatalogItem = {
  id: 'modal:small:auto',
  name: 'Modal Small',
  description: 'Managed Linux environment',
  provider: 'modal',
  profile: 'small',
  region: 'auto',
  cpu: 2,
  memoryGb: 4,
  durationMinutes: [15, 30, 60],
  approved: true,
  pricingMode: 'managed',
  managedRouteVerification: 'organization-catalog-byok-disabled',
  rateMicrosPerSecond: 67,
  rateSource: 'wick-customer-catalog',
  rateRetrievedAt: new Date().toISOString(),
};
const sail: CatalogItem = {
  ...modal,
  id: 'sail:large:auto',
  name: 'Sail Large',
  provider: 'sail',
  profile: 'large',
  cpu: 8,
  memoryGb: 16,
};
const frozenQuote = sponsoredComputeQuote(managedPricing(modal), 15);
const notice = (page: Page) => page.getByRole('note', { name: 'Modal compute sponsorship' });

async function promotionFixture(
  page: Page,
  options: {
    enabled?: boolean;
    provider?: 'modal' | 'sail';
    catalog?: CatalogItem[];
    bids?: Bid[];
    policyMinimum?: number;
    disk?: boolean;
  } = {},
) {
  const writes: string[] = [],
    unexpected: string[] = [],
    sockets: string[] = [];
  page.on('websocket', (socket) => {
    if (new URL(socket.url()).pathname.startsWith('/api/')) sockets.push(socket.url());
  });
  const now = Date.now();
  const vm = {
    id: 'vm-sponsored',
    requestId: 'request-sponsored',
    buyerId: 'buyer',
    sourceMode: 'real',
    status: 'terminated',
    createdAt: new Date(now - 1200000).toISOString(),
    readyAt: new Date(now - 1190000).toISOString(),
    expiresAt: new Date(now - 300000).toISOString(),
    cleanupConfirmedAt: new Date(now - 299000).toISOString(),
    cleanupPending: false,
    catalogName: 'Modal Small',
    region: 'auto',
    durationMinutes: 15,
    priceCents: 1,
    pricing: frozenQuote,
    revenueShare: frozenQuote.revenueShare,
  };
  await page.addInitScript(
    (disk) =>
      sessionStorage.setItem(
        'wick-draft',
        JSON.stringify({
          description: 'Build a searchable research workspace',
          catalogId: 'modal:small:auto',
          region: 'any',
          matchAcrossProviders: true,
          durationMinutes: 15,
          maxPriceCents: 25,
          requirements: { cpu: 2, memoryGb: 4 },
          ...(disk ? { diskId: 'workspace-disk' } : {}),
        }),
      ),
    options.disk ?? false,
  );
  await page.route('**/api/**', async (route) => {
    const request = route.request(),
      path = new URL(request.url()).pathname;
    if (request.method() !== 'GET') writes.push(`${request.method()} ${path}`);
    let json: unknown;
    if (path === '/api/me')
      json = {
        user: {
          id: options.provider ? 'provider' : 'buyer',
          name: 'Fixture account',
          role: options.provider ? 'provider' : 'buyer',
          email: 'fixture@example.invalid',
        },
        modes: { wick: 'real', muse: 'fixture' },
        catalog: options.catalog ?? [modal, sail],
        ...(options.enabled === false
          ? {}
          : {
              computePromotion: {
                provider: 'modal',
                totalPriceCents: 1,
                tiePriority: 'modal',
                fundedBy: 'operator-wick-account',
              },
            }),
      };
    else if (path === '/api/credits')
      json = { balanceCents: 10000, availableCents: 10000, reservedCents: 0, currency: 'USD' };
    else if (path === '/api/disks/options')
      json = { enabled: !!options.disk, eligibleCatalogIds: [sail.id] };
    else if (path === '/api/disks')
      json = { items: [{ id: 'workspace-disk', name: 'workspace', status: 'ready' }] };
    else if (path === '/api/requests/request-sponsored')
      json = {
        request: {
          id: 'request-sponsored',
          description: 'A short build session',
          status: 'open',
          catalogId: modal.id,
          region: 'any',
          requirements: { cpu: 2, memoryGb: 4 },
          durationMinutes: 15,
          maxPriceCents: 25,
          createdAt: new Date(now).toISOString(),
          closesAt: new Date(now + 600000).toISOString(),
        },
        bids: options.bids ?? [],
      };
    else if (path === '/api/vms/vm-sponsored') json = vm;
    else if (path === '/api/invoices')
      json = {
        items: [
          {
            id: 'invoice-sponsored',
            vmId: vm.id,
            catalogName: vm.catalogName,
            totalCents: 1,
            createdAt: vm.readyAt,
            pricing: frozenQuote,
            revenueShare: frozenQuote.revenueShare,
          },
        ],
      };
    else if (path === '/api/provider/earnings')
      json = {
        items: [
          {
            id: 'invoice-sponsored',
            vmId: vm.id,
            catalogName: vm.catalogName,
            totalCents: 1,
            createdAt: vm.readyAt,
            pricing: frozenQuote,
            revenueShare: frozenQuote.revenueShare,
            legacy: false,
            currency: 'USD',
            status: 'recorded',
            label: 'Recorded',
          },
        ],
      };
    else if (path === '/api/agreement-charges' || path === '/api/provider/agreement-charges')
      json = { items: [] };
    else if (path === '/api/provider/dashboard')
      json = {
        provider: {
          id: 'provider',
          name: 'Fixture provider',
          simulated: false,
          cloudProvider: options.provider,
        },
        policy: {
          basePriceCents: 1,
          minimumPriceCents: options.policyMinimum ?? 1,
          maxPriceCents: 100,
          autoBid: false,
          reserveSlots: 0,
          allowedCatalogIds: [(options.provider === 'sail' ? sail : modal).id],
        },
        policyRevision: 1,
        capacity: { total: 1, held: 0, available: 1 },
        activity: [],
      };
    else if (path === '/api/provider/offerings') json = { items: [] };
    else {
      unexpected.push(`${request.method()} ${path}`);
      return route.fulfill({ status: 500, json: { error: 'Unmocked UI API' } });
    }
    return route.fulfill({ json });
  });
  return { writes, unexpected, sockets };
}

test('Describe and Review disclose sponsorship without changing the buyer budget', async ({
  page,
}) => {
  const fixture = await promotionFixture(page);
  await page.goto('/new/vm');
  await expect(notice(page)).toContainText('$0.01 total');
  await expect(notice(page)).toContainText('operator’s Wick account');
  await expect(notice(page)).toContainText('Compatibility and capacity still apply');
  await page.goto('/requests/review');
  await expect(notice(page)).toContainText('Equal-price ties favor sponsored Modal offers');
  await expect(page.getByLabel('Maximum total price (USD)', { exact: true })).toHaveValue('0.25');
  await page.getByLabel('Minimum vCPUs', { exact: true }).fill('4');
  await expect(notice(page)).toHaveCount(0);
  await expect(
    page.getByRole('button', { name: 'Start 30-second auction', exact: true }),
  ).toBeEnabled();
  await page.getByLabel('Minimum vCPUs', { exact: true }).fill('2');
  await expect(notice(page)).toBeVisible();
  expect(fixture).toEqual({ writes: [], unexpected: [], sockets: [] });
});

for (const scenario of ['disabled', 'unapproved', 'over-cap', 'disk'] as const) {
  test(`Review omits an unavailable promotion: ${scenario}`, async ({ page }) => {
    const fixture = await promotionFixture(page, {
      enabled: scenario !== 'disabled',
      disk: scenario === 'disk',
      catalog: [
        {
          ...modal,
          approved: scenario !== 'unapproved',
          rateMicrosPerSecond: scenario === 'over-cap' ? 2000 : 67,
        },
        sail,
      ],
    });
    await page.goto('/requests/review');
    await expect(page.getByRole('heading', { name: 'Review your auction' })).toBeVisible();
    await expect(notice(page)).toHaveCount(0);
    expect(fixture.writes).toEqual([]);
    expect(fixture.unexpected).toEqual([]);
  });
}

const bid = (id: string, overrides: Partial<Bid> = {}): Bid => ({
  id,
  providerId: id,
  providerName: id,
  totalPriceCents: 1,
  status: 'accepted',
  createdAt: '2026-11-03T12:00:00.000Z',
  cloudProvider: 'sail',
  simulated: false,
  ...overrides,
});

test('frozen sponsored Modal wins equal-price display ties while API order remains stable', async ({
  page,
}) => {
  const ordinary = bid('z-ordinary-first');
  const invalid = bid('a-invalid-metadata', {
    cloudProvider: 'modal',
    pricing: {
      ...frozenQuote,
      promotion: { ...frozenQuote.promotion!, estimatedSubsidyMicros: '0' },
    },
  });
  const sponsored = bid('sponsored-modal', { cloudProvider: 'modal', pricing: frozenQuote });
  const samePrice = [
    ordinary,
    invalid,
    bid('ordinary-modal', { cloudProvider: 'modal' }),
    sponsored,
  ];
  const fixture = await promotionFixture(page, { enabled: false, bids: samePrice });
  await page.goto('/requests/request-sponsored');
  await expect(page.locator('.bid-row .bid-provider > strong')).toHaveText([
    'sponsored-modal',
    'z-ordinary-first',
    'a-invalid-metadata',
    'ordinary-modal',
  ]);
  await expect(page.locator('.bid-row .compute-promotion-badge')).toHaveCount(1);
  await expect(notice(page)).toContainText('Sponsorship is recorded with this offer');
  const simulated = bid('simulated-modal', {
    cloudProvider: 'modal',
    simulated: true,
    pricing: frozenQuote,
  });
  expect([simulated, sponsored].sort(compareComputeBids).map((item) => item.id)).toEqual([
    'sponsored-modal',
    'simulated-modal',
  ]);
  const cheaper = bid('lower-price', { totalPriceCents: 0.9 });
  expect([sponsored, cheaper].sort(compareComputeBids).map((item) => item.id)).toEqual([
    'lower-price',
    'sponsored-modal',
  ]);
  expect(fixture).toEqual({ writes: [], unexpected: [], sockets: [] });
});

for (const width of [375, 768, 1440]) {
  test(`review and saved sponsorship fit ${width}px`, async ({ page }, info) => {
    const fixture = await promotionFixture(page);
    await page.setViewportSize({ width, height: width === 375 ? 812 : 1000 });
    await page.goto('/requests/review');
    await expect(notice(page)).toBeVisible();
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth - innerWidth),
    ).toBeLessThanOrEqual(1);
    await page.screenshot({
      path: info.outputPath(`sponsored-review-${width}.png`),
      fullPage: true,
    });
    // A new authenticated session without the flag must still explain immutable records.
    await page.route('**/api/me', (route) =>
      route.fulfill({
        json: {
          user: { id: 'buyer', role: 'buyer', name: 'Fixture buyer' },
          modes: { wick: 'real', muse: 'fixture' },
          catalog: [modal, sail],
        },
      }),
    );
    await page.goto('/vms/vm-sponsored');
    await expect(notice(page)).toContainText('$0.01 total');
    await expect(notice(page)).toContainText('recorded with this offer');
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth - innerWidth),
    ).toBeLessThanOrEqual(1);
    await page.screenshot({ path: info.outputPath(`sponsored-vm-${width}.png`), fullPage: true });
    await page.goto('/invoices');
    const invoice = page
      .getByRole('table', { name: 'Instant rental invoices', exact: true })
      .locator('tbody tr');
    await expect(invoice).toContainText('$0.01');
    await expect(invoice).toContainText('Operator-sponsored Modal');
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth - innerWidth),
    ).toBeLessThanOrEqual(1);
    await page.screenshot({
      path: info.outputPath(`sponsored-invoice-${width}.png`),
      fullPage: true,
    });
    expect(fixture).toEqual({ writes: [], unexpected: [], sockets: [] });
  });
}

for (const provider of ['modal', 'sail'] as const) {
  test(`${provider} provider sees the correct publication preview and cost-floor explanation`, async ({
    page,
  }) => {
    const fixture = await promotionFixture(page, { provider });
    await page.goto('/provider/policy');
    await expect(page.getByRole('heading', { name: 'Pricing & policy' })).toBeVisible();
    await expect(notice(page)).toHaveCount(provider === 'modal' ? 1 : 0);
    await page.goto('/provider/offerings');
    await expect(notice(page)).toHaveCount(provider === 'modal' ? 1 : 0);
    await page.getByRole('button', { name: 'New offering', exact: true }).first().click();
    const preview = page
      .locator('.field')
      .filter({ has: page.getByText('Reviewed 30 minute example', { exact: true }) });
    await expect(preview.locator('strong')).toHaveText(provider === 'modal' ? '$0.01' : '$0.15');
    if (provider === 'modal') await expect(preview).toContainText('operator’s Wick account');
    else await expect(preview).toContainText('85% share must cover');
    expect(fixture).toEqual({ writes: [], unexpected: [], sockets: [] });
  });
}

test('provider preview falls back to the normal floor when saved limits exclude sponsorship', async ({
  page,
}) => {
  const fixture = await promotionFixture(page, { provider: 'modal', policyMinimum: 2 });
  await page.goto('/provider/offerings');
  await page.getByRole('button', { name: 'New offering', exact: true }).first().click();
  const preview = page
    .locator('.field')
    .filter({ has: page.getByText('Reviewed 30 minute example', { exact: true }) });
  await expect(preview.locator('strong')).toHaveText('$0.15');
  expect(fixture.writes).toEqual([]);
});

test('provider earnings preserve frozen sponsorship and exact revenue split after the flag is off', async ({
  page,
}) => {
  const fixture = await promotionFixture(page, { provider: 'modal', enabled: false });
  await page.goto('/provider/earnings');
  const row = page.locator('tr[data-invoice-id="invoice-sponsored"]');
  await expect(row).toContainText('Operator-sponsored Modal');
  await expect(row.locator('.numeric-cell')).toHaveText([
    '$0.01Operator-sponsored Modal',
    '$0.0015',
    '$0.0085',
  ]);
  expect(fixture).toEqual({ writes: [], unexpected: [], sockets: [] });
});

test('a sponsored alternative still requires exact buyer consent and retains uncertain acceptance locks', async ({
  page,
}) => {
  const fixture = await promotionFixture(page, { enabled: false });
  const attempts: unknown[] = [];
  const desired = { cpu: 2, memoryGb: 4, region: 'auto', durationMinutes: 15, maxPriceCents: 25 };
  await page.route('**/api/intents/**', async (route) => {
    const request = route.request();
    if (request.method() === 'POST') {
      attempts.push(request.postDataJSON());
      return route.fulfill({ status: 503, json: { error: 'Acceptance result is not confirmed.' } });
    }
    return route.fulfill({
      json: {
        intent: {
          id: 'intent-sponsored',
          description: 'Reviewed research workspace',
          desired,
          flexibility: {
            minCPU: 2,
            minMemoryGb: 4,
            allowedRegions: ['auto'],
            allowedDurations: [15],
            hardMaxPriceCents: 25,
            gpu: 'preserve',
          },
          status: 'open',
          sourceMode: 'real',
          createdAt: new Date().toISOString(),
        },
        offers: [
          {
            id: 'offer-sponsored',
            providerName: 'Modal provider',
            catalogName: 'Modal Small',
            before: desired,
            after: desired,
            totalPriceCents: 1,
            pricing: frozenQuote,
            tradeoffs: ['Requested resources and duration are preserved.'],
            expiresAt: new Date(Date.now() + 600000).toISOString(),
            mode: 'fixture',
            modelCalled: false,
          },
        ],
      },
    });
  });
  await page.goto('/alternatives/intent-sponsored');
  await page.getByRole('button', { name: 'Review this exact offer' }).click();
  const review = page.getByRole('region', { name: 'Final counteroffer review' });
  await expect(review.getByRole('note', { name: 'Modal compute sponsorship' })).toContainText(
    '$0.01 total',
  );
  const accept = page.getByRole('button', { name: 'Accept reviewed offer', exact: true });
  await expect(accept).toBeDisabled();
  expect(attempts).toEqual([]);
  await page.getByLabel('I accept these exact changes, provider and fixed total.').check();
  await expect(accept).toBeEnabled();
  expect(attempts).toEqual([]);
  await accept.click();
  await expect(
    page.getByText('Acceptance result is not confirmed.', { exact: true }),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: 'Review this exact offer' })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Suggest reviewed alternatives' })).toBeDisabled();
  const retry = page.getByRole('button', { name: 'Retry this acceptance' });
  await expect(retry).toBeEnabled();
  await retry.click();
  await expect.poll(() => attempts.length).toBe(2);
  expect(attempts[0]).toEqual(attempts[1]);
  expect(attempts[0]).toMatchObject({ operationKey: expect.any(String) });
  expect(fixture).toEqual({ writes: [], unexpected: [], sockets: [] });
});
