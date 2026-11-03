import { expect, test, type Page } from './table-review';

// Navigation and first-run states only. No provider, model or payment calls.
async function buyer(page: Page, olderBudget = false) {
  const writes: string[] = [];
  await page.route('**/api/**', async (route) => {
    const url = new URL(route.request().url()),
      path = url.pathname;
    if (route.request().method() !== 'GET') writes.push(path);
    const catalog = {
      enabled: true,
      mode: 'fixture',
      models: [],
      routes: ['modal', 'baseten'].map((provider) => ({
        provider,
        mode: 'fixture',
        qualified: true,
        minimumInputReservation: 20,
        maximumOutputTokens: 8192,
        modelId: 'meta/muse-spark-open',
        modelName: 'Meta Muse Spark Open',
        reason: 'Fixture route',
      })),
    };
    const grant = {
      id: '11111111-1111-4111-8111-111111111111',
      name: 'Older active agent',
      status: 'active',
      mode: 'fixture',
      fundedCents: 500,
      availableCents: 500,
      spentCents: 0,
      heldCents: 0,
      returnedCents: 0,
      maxPurchaseCents: 500,
      allowedProviders: ['modal', 'baseten'],
      allowInstant: true,
      expiresAt: new Date(Date.now() + 86400000).toISOString(),
      createdAt: new Date().toISOString(),
      currency: 'USD',
    };
    const json =
      path === '/api/me'
        ? {
            user: {
              id: 'buyer-preview',
              role: 'buyer',
              name: 'Alex Morgan',
              email: 'buyer@fixture.invalid',
            },
            modes: { wick: 'fixture', muse: 'fixture' },
            catalog: [
              {
                id: 'small',
                approved: true,
                profile: 'small',
                name: 'Small Linux environment',
                cpu: 2,
                memoryGb: 4,
                region: 'us-east',
                durationMinutes: [30],
              },
            ],
          }
        : path === '/api/orders'
          ? { items: [], serverNow: new Date().toISOString() }
          : path === '/api/inference/grants' || path === '/api/inference/agents'
            ? {
                items: olderBudget && url.searchParams.has('cursor') ? [grant] : [],
                nextCursor: olderBudget && !url.searchParams.has('cursor') ? 'older' : null,
              }
            : path === `/api/inference/grants/${grant.id}`
              ? { grant, catalog, packs: [], requests: [], orders: [] }
              : path === '/api/inference/models'
                ? catalog
                : path === '/api/credits'
                  ? {
                      balanceCents: 10000,
                      availableCents: 10000,
                      reservedCents: 0,
                      currency: 'USD',
                    }
                  : undefined;
    return route.fulfill(
      json ? { json } : { status: 500, json: { error: `Unexpected fixture request ${path}` } },
    );
  });
  return writes;
}

test('new purchase separates VM setup from prepaid AI tokens without creating an order', async ({
  page,
}) => {
  const writes = await buyer(page);
  await page.goto('/new');
  await expect(page.getByRole('heading', { name: 'What do you need?' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Launch a VM', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Buy AI tokens', exact: true })).toBeVisible();
  await expect(page.getByLabel('Describe your environment')).toHaveCount(0);
  await page.getByRole('link', { name: 'Configure VM', exact: true }).click();
  await expect(page).toHaveURL(/\/new\/vm$/);
  await expect(page.getByRole('heading', { name: 'Launch a VM', exact: true })).toBeVisible();
  await expect(page.getByLabel('Describe your environment')).toBeVisible();
  await expect(page.getByLabel('Input tokens', { exact: true })).toHaveCount(0);
  await page.getByRole('link', { name: 'All purchase options', exact: true }).click();
  await expect(page).toHaveURL(/\/new$/);
  expect(writes).toHaveLength(0);
});

test('a buyer without an agent budget can configure a wallet purchase immediately', async ({
  page,
}) => {
  const writes = await buyer(page);
  await page.goto('/new');
  await page.getByRole('link', { name: 'Buy a token pack', exact: true }).click();
  await expect(page).toHaveURL(/\/token-orders\/new$/);
  await expect(page.getByLabel('Pay with', { exact: true })).toHaveValue('');
  await expect(page.getByLabel('Input tokens', { exact: true })).toHaveValue('2000000');
  await expect(
    page.getByText('Buy directly from your wallet. No agent setup is required.'),
  ).toBeVisible();
  await page.getByRole('checkbox', { name: /I understand/ }).check();
  await expect(page.getByRole('button', { name: 'Start 30-second auction' })).toBeEnabled();
  await expect(page.getByRole('heading', { name: 'Give your agent a budget first.' })).toHaveCount(
    0,
  );
  expect(writes).toHaveLength(0);
});

test('Orders retains history and exposes both purchase paths on the buyer landing page', async ({
  page,
}) => {
  await buyer(page);
  await page.goto('/orders');
  await expect(page.getByRole('heading', { name: 'Orders', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Order history', exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Configure VM', exact: true })).toHaveAttribute(
    'href',
    '/new/vm',
  );
  await expect(page.getByRole('link', { name: 'Buy a token pack', exact: true })).toHaveAttribute(
    'href',
    '/token-orders/new',
  );
  await expect(page.getByLabel('Order type')).toContainText('AI token packs');
});

test('an active budget on a later page stays reachable from token setup', async ({ page }) => {
  const writes = await buyer(page, true);
  await page.goto('/token-orders/new');
  await expect(page.getByLabel('Pay with', { exact: true })).toHaveValue('');
  await page.getByRole('checkbox', { name: /I understand/ }).check();
  await expect(page.getByRole('button', { name: 'Start 30-second auction' })).toBeEnabled();
  await page.getByRole('button', { name: 'Load more', exact: true }).click();
  await expect(page.getByRole('combobox', { name: 'Pay with', exact: true })).toContainText(
    'Older active agent',
  );
  await expect(page.getByLabel('Pay with', { exact: true })).toHaveValue('');
  await page
    .getByLabel('Pay with', { exact: true })
    .selectOption('11111111-1111-4111-8111-111111111111');
  await expect(
    page.getByText('This purchase uses the selected agent’s budget and buying limits.'),
  ).toBeVisible();
  await expect(page.getByLabel('Input tokens', { exact: true })).toBeVisible();
  expect(writes).toEqual([]);
});

test('resource choices fit mobile and remain reachable with keyboard navigation', async ({
  page,
}) => {
  await buyer(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/new');
  await expect(page.getByRole('heading', { name: 'What do you need?' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await page.getByRole('link', { name: 'Configure VM', exact: true }).focus();
  await page.keyboard.press('Enter');
  await expect(page.getByLabel('Describe your environment')).toBeVisible();
  await page.getByRole('button', { name: 'Open navigation', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Workspace navigation' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Agents', exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog', { name: 'Workspace navigation' })).toHaveCount(0);
});

for (const width of [1440, 1280, 390]) {
  test(`wallet token purchase fits at ${width}px without requiring an agent`, async ({
    page,
  }, testInfo) => {
    const writes = await buyer(page);
    await page.setViewportSize({ width, height: 1000 });
    await page.goto('/token-orders/new');
    await expect(page.getByLabel('Pay with', { exact: true })).toHaveValue('');
    await expect(page.getByLabel('Input tokens', { exact: true })).toBeVisible();
    await page.getByRole('checkbox', { name: /I understand/ }).check();
    await expect(page.getByRole('button', { name: 'Start 30-second auction' })).toBeEnabled();
    await page.evaluate(() => document.fonts.ready);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    await page.screenshot({
      path: testInfo.outputPath(`wallet-composer-${width}.png`),
      fullPage: true,
    });
    expect(writes).toEqual([]);
  });

  test(`compact purchase actions stay separate from their description at ${width}px`, async ({
    page,
  }) => {
    const writes = await buyer(page);
    await page.setViewportSize({ width, height: 1000 });
    await page.goto('/orders');
    const cards = page.locator('.purchase-choices.is-compact .purchase-choice');
    await expect(cards).toHaveCount(2);
    await page.evaluate(() => document.fonts.ready);
    for (const card of await cards.all()) {
      const paragraph = await card.locator(':scope > p').boundingBox();
      const action = await card.locator('.purchase-choice-actions').boundingBox();
      const bounds = await card.boundingBox();
      expect(paragraph).not.toBeNull();
      expect(action).not.toBeNull();
      expect(bounds).not.toBeNull();
      const horizontalOverlap =
        Math.min(paragraph!.x + paragraph!.width, action!.x + action!.width) -
        Math.max(paragraph!.x, action!.x);
      const verticalOverlap =
        Math.min(paragraph!.y + paragraph!.height, action!.y + action!.height) -
        Math.max(paragraph!.y, action!.y);
      expect(
        horizontalOverlap <= 0 || verticalOverlap <= 0,
        'description and purchase action do not overlap',
      ).toBe(true);
      expect(action!.x).toBeGreaterThanOrEqual(bounds!.x);
      expect(action!.x + action!.width).toBeLessThanOrEqual(bounds!.x + bounds!.width);
      expect(action!.y + action!.height).toBeLessThanOrEqual(bounds!.y + bounds!.height);
    }
    await expect(page.getByRole('heading', { name: 'Orders', exact: true })).toHaveCSS(
      'font-size',
      '28px',
    );
    expect(writes).toEqual([]);
    await page.screenshot({
      path: test.info().outputPath(`purchase-cards-${width}.png`),
      fullPage: true,
    });
  });
}
