import { expect, test, type Page } from './table-review';

// Every API is mocked: exercise the console without accounts, paid APIs or supply changes.
async function providerConsole(page: Page, closed = false) {
  const writes: { path: string; body: Record<string, unknown> }[] = [];
  let active = true;
  const catalog = [
    {
      id: 'micro',
      name: 'Linux Micro',
      provider: 'e2b',
      profile: 'micro',
      region: 'us',
      cpu: 2,
      memoryGb: 4,
      durationMinutes: [15, 30, 60],
      approved: true,
    },
  ];
  await page.route('**/api/**', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path === '/api/me')
      return route.fulfill({
        json: {
          user: { id: 'provider-console', name: 'Test provider', role: 'provider' },
          modes: { wick: 'fixture', muse: 'fixture' },
          catalog,
        },
      });
    if (path === '/api/provider/dashboard')
      return route.fulfill({
        json: {
          provider: { id: 'provider-console', name: 'Test provider', simulated: true },
          policy: {
            basePriceCents: 10,
            minimumPriceCents: 1,
            autoBid: false,
            reserveSlots: 0,
            allowedCatalogIds: ['micro'],
          },
          policyRevision: 1,
          capacity: { total: 5, held: 0, available: 5 },
          activity: [],
        },
      });
    if (path === '/api/provider/requests')
      return route.fulfill({
        json: {
          items: [
            {
              id: 'request-one',
              description: 'Build a public repository',
              catalogId: 'micro',
              region: 'us',
              requirements: { cpu: 2, memoryGb: 4 },
              durationMinutes: 30,
              maxPriceCents: 50,
              status: closed ? 'no_offers' : 'open',
              closesAt: new Date(Date.now() + (closed ? -60000 : 600000)).toISOString(),
              createdAt: new Date().toISOString(),
            },
          ],
        },
      });
    if (path === '/api/provider/requests/request-one/bids' && request.method() === 'POST') {
      writes.push({ path, body: request.postDataJSON() });
      return route.fulfill({ json: { id: 'bid-one' } });
    }
    if (path === '/api/provider/offerings')
      return route.fulfill({
        json: {
          items: [
            {
              id: 'offering-one',
              providerId: 'provider-console',
              catalogId: 'micro',
              name: 'Build environment',
              description: 'A private Linux environment for repository builds.',
              priceCents: 12.34,
              active,
              revision: 2,
              createdAt: new Date().toISOString(),
            },
          ],
        },
      });
    if (path === '/api/provider/offerings/offering-one' && request.method() === 'PATCH') {
      const body = request.postDataJSON();
      writes.push({ path, body });
      active = body.active;
      return route.fulfill({ json: { active } });
    }
    return route.fulfill({ status: 500, json: { error: `Unexpected mocked API: ${path}` } });
  });
  return writes;
}

test('request row expands without bidding and retains a four-decimal bid across collapse', async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 960 });
  const writes = await providerConsole(page);
  await page.goto('/provider/requests');
  await expect(page.getByRole('table', { name: 'Buyer requests', exact: true })).toBeVisible();
  const review = page.getByRole('button', { name: 'Review bid', exact: true });
  await expect(review).toHaveAttribute('aria-expanded', 'false');
  await expect(page.getByLabel('Your total bid (USD)')).not.toBeVisible();
  await review.click();
  await page.getByLabel('Your total bid (USD)').fill('0.1234');
  await page.getByRole('button', { name: 'Hide bid', exact: true }).click();
  await review.click();
  await expect(page.getByLabel('Your total bid (USD)')).toHaveValue('0.1234');
  expect(writes).toHaveLength(0);
  await page.getByRole('button', { name: 'Submit bid', exact: true }).click();
  await expect(page.getByText('Your bid is accepted and capacity is reserved.')).toBeVisible();
  expect(writes).toEqual([
    { path: '/api/provider/requests/request-one/bids', body: { totalPriceCents: 12.34 } },
  ]);
  await page.screenshot({
    path: testInfo.outputPath('provider-requests-1440.png'),
    fullPage: true,
  });
});

test('closed request stays readable while bid and Muse controls remain disabled', async ({
  page,
}) => {
  const writes = await providerConsole(page, true);
  await page.goto('/provider/requests');
  await page.getByRole('button', { name: 'Review bid', exact: true }).click();
  await expect(page.getByLabel('Your total bid (USD)')).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Submit bid', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Ask Muse', exact: true })).toBeDisabled();
  expect(writes).toHaveLength(0);
});

test('offering row exposes publication controls without changing the saved offering', async ({
  page,
}, testInfo) => {
  const writes = await providerConsole(page);
  await page.goto('/provider/offerings');
  const table = page.getByRole('table', { name: 'Instant offerings', exact: true });
  await expect(table.locator('td.numeric-cell')).toContainText('$0.1234');
  await expect(page.getByRole('button', { name: 'Unpublish', exact: true })).not.toBeVisible();
  await page.getByRole('button', { name: 'Manage offering', exact: true }).click();
  expect(writes).toHaveLength(0);
  await page.getByRole('button', { name: 'Unpublish', exact: true }).click();
  await expect(table.getByText('Inactive', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Publish', exact: true })).toBeVisible();
  expect(writes).toEqual([
    { path: '/api/provider/offerings/offering-one', body: { active: false } },
  ]);
  await page.screenshot({
    path: testInfo.outputPath('provider-offerings-1280.png'),
    fullPage: true,
  });
});

test('provider inventory keeps overflow inside the table on narrow screens', async ({
  page,
}, testInfo) => {
  await providerConsole(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/provider/offerings');
  const viewport = page.locator('.data-table-scroll[aria-label="Instant offerings"]');
  await expect(viewport).toBeVisible();
  const measurements = await viewport.evaluate((element) => ({
    tableOverflow: element.scrollWidth > element.clientWidth,
    pageOverflow: document.documentElement.scrollWidth > innerWidth + 1,
  }));
  expect(measurements).toEqual({ tableOverflow: true, pageOverflow: false });
  await page.screenshot({
    path: testInfo.outputPath('provider-offerings-390.png'),
    fullPage: true,
  });
  await page.getByRole('button', { name: 'Manage offering', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Unpublish', exact: true })).toBeVisible();
  const expanded = page.getByRole('region', { name: 'Build environment details', exact: true });
  const bounds = await expanded.boundingBox();
  expect(bounds!.x).toBeGreaterThanOrEqual(0);
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(390);
  await page.screenshot({
    path: testInfo.outputPath('provider-offerings-expanded-390.png'),
    fullPage: true,
  });
});

for (const screen of [
  {
    route: 'requests',
    panel: 'Buyer requests',
    record: 'Build a public repository',
    refresh: 'Refresh requests',
  },
  {
    route: 'offerings',
    panel: 'Instant offerings',
    record: 'Build environment',
    refresh: 'Refresh',
  },
  { route: 'earnings', panel: 'Rental revenue', record: 'Invoice workspace', refresh: 'Refresh' },
  {
    route: 'activity',
    panel: 'Provider activity',
    record: 'Capacity updated by operator.',
    refresh: 'Refresh',
  },
]) {
  test(`${screen.route} distinguishes initial failure from empty data and retains records on refresh failure`, async ({
    page,
  }) => {
    await providerConsole(page);
    let unavailable = true;
    await page.route('**/api/provider/**', async (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path === '/api/provider/agreement-charges') return route.fulfill({ json: { items: [] } });
      if (path !== `/api/provider/${screen.route}`) return route.fallback();
      if (unavailable)
        return route.fulfill({
          status: 503,
          json: { error: 'Provider records temporarily unavailable.' },
        });
      if (screen.route === 'earnings')
        return route.fulfill({
          json: {
            items: [
              {
                id: 'invoice-one',
                vmId: 'vm-one',
                catalogName: 'Invoice workspace',
                totalCents: 12.34,
                createdAt: new Date().toISOString(),
              },
            ],
          },
        });
      if (screen.route === 'activity')
        return route.fulfill({
          json: {
            items: [
              {
                id: 'event-one',
                kind: 'capacity_changed',
                message: 'Capacity updated by operator.',
                createdAt: new Date().toISOString(),
              },
            ],
          },
        });
      return route.fallback();
    });
    await page.goto(`/provider/${screen.route}`);
    const panel = page.locator('.data-table-panel').filter({
      has: page.getByRole('heading', {
        name:
          screen.panel === 'Buyer requests'
            ? 'Open requests'
            : screen.panel === 'Instant offerings'
              ? 'Published supply'
              : screen.panel,
        exact: true,
      }),
    });
    await expect(panel.getByText('Unable to load records', { exact: true })).toBeVisible();
    await expect(panel.locator('.data-table-count')).toHaveCount(0);
    if (screen.route === 'earnings')
      await expect(page.locator('.stats-grid')).not.toContainText('$0.00');
    unavailable = false;
    await panel.getByRole('button', { name: 'Try again', exact: true }).click();
    await expect(panel.getByText(screen.record, { exact: true }).first()).toBeVisible();
    await expect(panel.locator('.data-table-count')).toContainText('1 ');
    unavailable = true;
    await page.getByRole('button', { name: screen.refresh, exact: true }).first().click();
    await expect(
      page.getByText('Provider records temporarily unavailable.', { exact: true }),
    ).toBeVisible();
    await expect(panel.getByText(screen.record, { exact: true }).first()).toBeVisible();
    await expect(panel.getByText('Unable to load records', { exact: true })).toHaveCount(0);
    await expect(panel.locator('.data-table-count')).toContainText('1 ');
  });
}

test('provider setup uses instant supply and the retired schedule URL exposes no scheduling controls', async ({
  page,
}) => {
  await providerConsole(page);
  const requests: { path: string; method: string }[] = [];
  page.on('request', (request) => {
    const path = new URL(request.url()).pathname;
    if (path.startsWith('/api/')) requests.push({ path, method: request.method() });
  });
  await page.goto('/provider/capacity');
  await expect(page.getByRole('heading', { name: 'Capacity', exact: true })).toBeVisible();
  const setup = page.getByRole('navigation', { name: 'Provider setup', exact: true });
  await expect(setup.getByRole('link', { name: '1 Publish an offering' })).toHaveAttribute(
    'href',
    '/provider/offerings',
  );
  await expect(setup.getByRole('link', { name: '2 Set bidding policy' })).toHaveAttribute(
    'href',
    '/provider/policy',
  );
  await expect(setup.getByRole('link', { name: '3 Review buyer requests' })).toHaveAttribute(
    'href',
    '/provider/requests',
  );
  await expect(page.locator('a[href="/provider/scheduled"]')).toHaveCount(0);
  await page.goto('/provider/scheduled');
  await expect(
    page.getByRole('heading', { name: 'Scheduled VMs have been removed', exact: true }),
  ).toBeVisible();
  await expect(page.getByRole('link', { name: 'Scheduled market', exact: true })).toHaveCount(0);
  await expect(
    page.getByRole('button', { name: 'Publish scheduled offering', exact: true }),
  ).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Manage VM offers', exact: true })).toHaveAttribute(
    'href',
    '/provider/offerings',
  );
  await expect(page.getByRole('link', { name: 'View earnings', exact: true })).toHaveAttribute(
    'href',
    '/provider/earnings',
  );
  await page.getByRole('link', { name: 'Manage VM offers', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Instant offerings', exact: true })).toBeVisible();
  expect(requests.every((request) => request.method === 'GET')).toBe(true);
  expect(
    requests.some((request) =>
      /\/(scheduled-offerings|commitments|agreement-demand)(\/|$)/.test(request.path),
    ),
  ).toBe(false);
});
