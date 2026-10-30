import { expect, test, type Page } from '@playwright/test';

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

test('a buyer without an agent budget gets an actionable first step instead of a disabled token form', async ({
  page,
}) => {
  const writes = await buyer(page);
  await page.goto('/new');
  await page.getByRole('link', { name: 'Buy a token pack', exact: true }).click();
  await expect(page).toHaveURL(/\/token-orders\/new$/);
  await expect(
    page.getByRole('heading', { name: 'Give your agent a budget first.' }),
  ).toBeVisible();
  await expect(page.getByLabel('Input tokens', { exact: true })).toHaveCount(0);
  await page.getByRole('link', { name: 'Create agent budget', exact: true }).click();
  await expect(page).toHaveURL(/\/agents\?create=1$/);
  await expect(page.getByRole('dialog')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Create an agent', exact: true })).toBeVisible();
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
  await buyer(page, true);
  await page.goto('/token-orders/new');
  await expect(
    page.getByRole('heading', { name: 'Choose or create an agent budget.' }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Load more', exact: true }).click();
  await expect(page.getByRole('combobox', { name: 'Agent budget', exact: true })).toContainText(
    'Older active agent',
  );
  await expect(page.getByLabel('Input tokens', { exact: true })).toBeVisible();
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
