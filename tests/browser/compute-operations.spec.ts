import { expect, test, type Page } from './table-review';

// All requests are local presentation fixtures. Rendering and review do not allocate resources.
async function compute(page: Page, options: { cleanup?: boolean; unavailable?: boolean } = {}) {
  const writes: string[] = [];
  const sockets: string[] = [];
  page.on('websocket', (socket) => {
    if (new URL(socket.url()).pathname.startsWith('/api/')) sockets.push(socket.url());
  });
  const now = Date.now();
  const vm = {
    id: 'vm-fixture',
    requestId: 'request-fixture',
    buyerId: 'buyer',
    catalogName: 'Development environment',
    region: 'auto',
    sourceMode: 'fixture',
    status: options.cleanup ? 'terminating' : 'running',
    createdAt: new Date(now - 60000).toISOString(),
    readyAt: new Date(now - 30000).toISOString(),
    expiresAt: new Date(now + 840000).toISOString(),
    durationMinutes: 15,
    priceCents: 173.31,
    cleanupPending: options.cleanup ?? false,
    cleanupConfirmedAt: null,
    pricing: { model: 'wick-managed-bid-v1', upstreamEstimatedComputeMicros: 10000 },
  };
  await page.route('**/api/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (route.request().method() !== 'GET') writes.push(path);
    if (path === '/api/me')
      return route.fulfill({
        json: {
          user: { id: 'buyer', role: 'buyer', name: 'Alex Morgan', email: 'buyer@fixture.invalid' },
          modes: { wick: 'fixture', muse: 'fixture' },
          catalog: [],
        },
      });
    if (path === '/api/requests/request-fixture')
      return route.fulfill({
        json: {
          request: {
            id: 'request-fixture',
            buyerId: 'buyer',
            description: 'A Linux environment for a short build and test session.',
            status: 'ready',
            region: 'any',
            requirements: { cpu: 4, memoryGb: 8, gpu: null },
            durationMinutes: 15,
            maxPriceCents: 250,
            closesAt: new Date(now - 50000).toISOString(),
            winningBidId: 'bid-fixture',
          },
          bids: [
            {
              id: 'bid-fixture',
              providerId: 'provider',
              providerName: 'Fixture provider',
              totalPriceCents: 173.31,
              createdAt: new Date(now - 55000).toISOString(),
              status: 'won',
              catalogName: 'Development environment',
              region: 'auto',
              simulated: true,
            },
          ],
          vm,
        },
      });
    if (path === '/api/vms/vm-fixture')
      return route.fulfill(
        options.unavailable
          ? { status: 503, json: { error: 'Environment lookup is temporarily unavailable.' } }
          : { json: vm },
      );
    if (path === '/api/coding/options')
      return route.fulfill({
        json: {
          vms: [
            {
              id: vm.id,
              name: vm.catalogName,
              provider: 'Fixture provider',
              expires_at: vm.expiresAt,
            },
          ],
          grants: [
            {
              id: 'grant-fixture',
              name: 'Development agent',
              available_cents: 500,
              expires_at: vm.expiresAt,
            },
          ],
          mode: 'fixture',
          executionAvailable: true,
          requirements: 'Commands run in a private job clone.',
        },
      });
    if (path === '/api/coding/jobs')
      return route.fulfill({ json: { items: [], nextCursor: null } });
    return route.fulfill({ status: 500, json: { error: 'Unexpected fixture request ' + path } });
  });
  return { writes, sockets };
}

for (const width of [375, 768, 1440]) {
  test(`compute results, terminal, and advanced composer fit ${width}px`, async ({
    page,
  }, info) => {
    const fixture = await compute(page);
    await page.setViewportSize({ width, height: width === 375 ? 812 : 1000 });
    await page.goto('/requests/request-fixture');
    await expect(
      page.getByRole('heading', { name: 'Environment ready', exact: true }),
    ).toBeVisible();
    await expect(page.getByText('Step 3 of 3', { exact: true })).toHaveAttribute(
      'aria-current',
      'step',
    );
    await expect(page.locator('.bid-price')).toContainText('$1.7331');
    await expect(page.getByRole('link', { name: 'Open environment', exact: true })).toHaveAttribute(
      'href',
      '/vms/vm-fixture',
    );
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth - innerWidth),
    ).toBeLessThanOrEqual(1);
    await page.screenshot({ path: info.outputPath(`auction-${width}.png`), fullPage: true });

    await page.goto('/vms/vm-fixture');
    const summary = page.getByRole('region', { name: 'Rental summary', exact: true });
    await expect(summary).toContainText('$1.7331');
    await expect(summary).toContainText('Exact expiry');
    await expect(page.getByText('Browser terminal', { exact: true })).toBeVisible();
    if (width === 375) {
      const heading = await page.getByRole('heading', { level: 1 }).boundingBox();
      expect(heading!.width).toBeGreaterThan(300);
    }
    await expect(page.getByText('Wick compute estimate', { exact: true })).not.toBeVisible();
    const terminalTop = await page
      .locator('.terminal-panel')
      .evaluate((el) => el.getBoundingClientRect().top);
    expect(terminalTop).toBeLessThan(width === 375 ? 650 : 520);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth - innerWidth),
    ).toBeLessThanOrEqual(1);
    await page.screenshot({ path: info.outputPath(`environment-${width}.png`), fullPage: true });
    await page.getByText('Rental details', { exact: true }).click();
    await expect(page.getByText('Wick compute estimate', { exact: true })).toBeVisible();
    await expect(
      page.getByRole('link', { name: 'View auction & winning offer', exact: true }),
    ).toHaveAttribute('href', '/requests/request-fixture');

    await page.goto('/studio/legacy?new=1');
    await expect(
      page.getByRole('heading', { name: 'Coding with your resources', exact: true }),
    ).toBeVisible();
    await expect(page.getByText('ADVANCED · EXISTING RESOURCES', { exact: true })).toBeVisible();
    await expect(
      page.getByRole('button', { name: 'Review coding task', exact: true }),
    ).toBeEnabled();
    await expect(page.locator('main .button.primary:visible')).toHaveCount(1);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth - innerWidth),
    ).toBeLessThanOrEqual(1);
    await page.screenshot({
      path: info.outputPath(`coding-composer-${width}.png`),
      fullPage: true,
    });
    expect(fixture.writes).toEqual([]);
    expect(fixture.sockets).toEqual([]);
  });
}

test('VM cleanup remains visible while rental guidance is collapsed', async ({ page }) => {
  const fixture = await compute(page, { cleanup: true });
  await page.goto('/vms/vm-fixture');
  await expect(
    page.getByRole('status').filter({ hasText: 'Wick cleanup is pending.' }),
  ).toBeVisible();
  await expect(
    page.getByText('Provider capacity remains reserved until cleanup is confirmed.', {
      exact: false,
    }),
  ).toBeVisible();
  await expect(
    page.getByText('Terminal contents are not retained or sent to Muse.', { exact: false }),
  ).not.toBeVisible();
  expect(fixture.writes).toEqual([]);
  expect(fixture.sockets).toEqual([]);
});

test('unavailable VM retains its page frame and offers only a read retry', async ({ page }) => {
  const fixture = await compute(page, { unavailable: true });
  await page.goto('/vms/vm-fixture');
  await expect(page.getByRole('heading', { name: 'Your environment', exact: true })).toBeVisible();
  await expect(
    page.getByText('Environment lookup is temporarily unavailable.', { exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Try again', exact: true }).click();
  expect(fixture.writes).toEqual([]);
  expect(fixture.sockets).toEqual([]);
});

test('advanced coding review preserves existing resources and requires explicit start', async ({
  page,
}) => {
  const fixture = await compute(page);
  await page.goto('/studio/legacy?new=1');
  await page
    .getByLabel('Public repository URL', { exact: true })
    .fill('https://github.com/example/project');
  await page
    .getByLabel('Task', { exact: true })
    .fill('Fix the parser and verify the regression tests.');
  await page.getByLabel('Base branch or commit', { exact: true }).fill('main');
  await page.getByRole('button', { name: 'Review coding task', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('heading', { name: 'Review this coding task' })).toBeVisible();
  await expect(dialog).toContainText('Existing purchased agent quota');
  await expect(
    dialog.getByRole('button', { name: 'Start coding task', exact: true }),
  ).toBeEnabled();
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(page.getByRole('combobox', { name: 'Running Wick VM', exact: true })).toHaveValue(
    'vm-fixture',
  );
  await expect(page.getByRole('combobox', { name: 'Funded agent', exact: true })).toHaveValue(
    'grant-fixture',
  );
  await expect(page.getByRole('textbox', { name: 'Task', exact: true })).toHaveValue(
    'Fix the parser and verify the regression tests.',
  );
  expect(fixture.writes).toEqual([]);
});
