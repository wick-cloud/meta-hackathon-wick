import { expect, test, type Page } from '@playwright/test';

// All API calls are intercepted; these tests never publish supply or call a provider.
async function fixture(page: Page, mode: 'fixture' | 'real', allowed: boolean) {
  const writes: Record<string, unknown>[] = [];
  let releaseDashboard!: () => void;
  const dashboardReady = new Promise<void>((resolve) => (releaseDashboard = resolve));
  const catalog = ['e2b', 'daytona'].map((provider) => ({
    id: `${provider}-micro`,
    name: `${provider} Micro`,
    provider,
    profile: 'micro',
    region: 'us',
    cpu: 1,
    memoryGb: 1,
    durationMinutes: [15, 30, 60],
    approved: true,
    pricingMode: 'managed',
    rateMicrosPerSecond: 1,
    rateSource: 'wick-customer-catalog',
    rateRetrievedAt: new Date().toISOString(),
    managedRouteVerification: 'execution-preview-managed',
  }));
  await page.route('**/api/**', async (route) => {
    const req = route.request();
    const path = new URL(req.url()).pathname;
    if (path === '/api/me')
      return route.fulfill({
        json: {
          user: { id: 'provider-test', name: 'Daytona', role: 'provider' },
          modes: { wick: mode, muse: 'fixture' },
          catalog,
        },
      });
    if (path === '/api/provider/dashboard') {
      await dashboardReady;
      return route.fulfill({
        json: {
          provider: { id: 'daytona', name: 'Daytona', cloudProvider: 'daytona', simulated: false },
          policy: { allowedCatalogIds: allowed ? ['daytona-micro'] : [], minimumPriceCents: 1 },
          policyRevision: 1,
          capacity: { total: 5, held: 0, available: 5 },
          activity: [],
        },
      });
    }
    if (path === '/api/provider/offerings') {
      if (req.method() === 'POST') {
        writes.push(req.postDataJSON());
        return route.fulfill({ json: { id: 'created-offering' } });
      }
      return route.fulfill({ json: { items: [] } });
    }
    return route.fulfill({ status: 500, json: { error: `Unmocked API: ${path}` } });
  });
  return { writes, releaseDashboard };
}

for (const mode of ['fixture', 'real'] as const) {
  test(`${mode} offering waits for provider policy and selects its permitted route`, async ({
    page,
  }) => {
    const { writes, releaseDashboard } = await fixture(page, mode, true);
    try {
      await page.goto('/provider/offerings');
      await page.getByRole('button', { name: 'New offering', exact: true }).first().click();
      const select = page.getByLabel('Approved configuration');
      const publish = page.getByRole('button', { name: 'Publish offering', exact: true });
      await expect(select).toBeDisabled();
      await expect(publish).toBeDisabled();
      releaseDashboard();
      await expect(select).toHaveValue('daytona-micro');
      await expect(select.locator('option')).toHaveCount(1);
      await page.getByLabel('Offering name').fill('My Daytona offering');
      await page.getByLabel('Description', { exact: true }).fill('An approved environment');
      await expect(publish).toBeEnabled();
      await publish.click();
      await expect(
        page.getByText('Offering published. New bids can use this revision.'),
      ).toBeVisible();
      expect(writes).toHaveLength(1);
      expect(writes[0].catalogId).toBe('daytona-micro');
    } finally {
      releaseDashboard();
    }
  });
}

test('provider with no permitted configurations sees an explicit unavailable state', async ({
  page,
}) => {
  const { writes, releaseDashboard } = await fixture(page, 'fixture', false);
  releaseDashboard();
  await page.goto('/provider/offerings');
  await page.getByRole('button', { name: 'New offering', exact: true }).first().click();
  await expect(page.getByLabel('Approved configuration')).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Publish offering', exact: true })).toBeDisabled();
  await expect(
    page.getByText('No configurations are available under your current provider policy.'),
  ).toBeVisible();
  expect(writes).toHaveLength(0);
});
