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

test('Orders retains history and links to both purchase paths without creating an order', async ({
  page,
}) => {
  const writes = await buyer(page);
  await page.goto('/orders');
  await expect(page.getByRole('heading', { name: 'Orders', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Archive', exact: true })).toBeVisible();
  await expect(page.getByLabel('Order type')).toContainText('AI token packs');
  const purchase = page
    .locator('.orders-workspace > .page-heading')
    .getByRole('link', { name: 'New purchase', exact: true });
  await expect(purchase).toHaveAttribute('href', '/new');
  await purchase.click();
  await expect(page.getByRole('link', { name: 'Configure VM', exact: true })).toHaveAttribute(
    'href',
    '/new/vm',
  );
  await expect(page.getByRole('link', { name: 'Buy a token pack', exact: true })).toHaveAttribute(
    'href',
    '/token-orders/new',
  );
  expect(writes).toEqual([]);
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

  test(`purchase choices keep actions separate from their description at ${width}px`, async ({
    page,
  }) => {
    const writes = await buyer(page);
    await page.setViewportSize({ width, height: 1000 });
    await page.goto('/new');
    const cards = page.locator('.purchase-choices .purchase-choice');
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
    await expect(
      page.getByRole('heading', { name: 'What do you need?', exact: true }),
    ).toBeVisible();
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth - innerWidth),
    ).toBeLessThanOrEqual(1);
    expect(writes).toEqual([]);
    await page.screenshot({
      path: test.info().outputPath(`purchase-cards-${width}.png`),
      fullPage: true,
    });
  });
}

// Shared Describe/Review form flows use only intercepted APIs. The render must
// never translate a prompt or create a request before the buyer explicitly acts.
const linkedDiskId = '11111111-1111-4111-8111-111111111111';
async function environmentEntry(
  page: Page,
  options: {
    disk?: 'ready' | 'pending' | 'unavailable' | 'no-routes';
  } = {},
) {
  const writes: { path: string; body: any }[] = [];
  const unexpected: string[] = [];
  const reads: string[] = [];
  let releaseDisk!: () => void;
  const diskReady = new Promise<void>((resolve) => {
    releaseDisk = resolve;
  });
  const catalog = [
    {
      id: 'e2b:small:us',
      provider: 'e2b',
      profile: 'small',
      name: 'Small · E2B',
      description: 'Small Linux environment',
      cpu: 2,
      memoryGb: 4,
      region: 'us',
      durationMinutes: [15, 30, 60],
      approved: true,
    },
    {
      id: 'modal:large:auto',
      provider: 'modal',
      profile: 'large',
      name: 'Large · Modal',
      description: 'Larger Linux environment',
      cpu: 8,
      memoryGb: 16,
      gpu: 'A100',
      region: 'auto',
      durationMinutes: [15, 30, 60],
      approved: true,
    },
  ];
  await page.route('**/api/**', async (route) => {
    const request = route.request(),
      path = new URL(request.url()).pathname,
      method = request.method();
    if (method === 'GET') reads.push(path);
    else writes.push({ path, body: request.postDataJSON() });
    let json: unknown;
    if (path === '/api/me' && method === 'GET')
      json = {
        user: {
          id: 'form-buyer',
          name: 'Alex Morgan',
          email: 'buyer@fixture.invalid',
          role: 'buyer',
        },
        modes: { wick: 'fixture', muse: 'fixture' },
        catalog,
      };
    else if (path === '/api/credits' && method === 'GET')
      json = { balanceCents: 20000, availableCents: 20000, reservedCents: 0, currency: 'USD' };
    else if (path === '/api/disks/options' && method === 'GET') {
      if (options.disk === 'pending') await diskReady;
      json = {
        enabled: options.disk !== 'unavailable',
        mode: 'fixture',
        eligibleCatalogIds: options.disk === 'no-routes' ? [] : ['modal:large:auto'],
      };
    } else if (path === '/api/disks' && method === 'GET')
      json = {
        items: [
          { id: linkedDiskId, name: 'Research files', status: 'ready', cleanupPending: false },
        ],
      };
    else if (path === '/api/muse/translate' && method === 'POST')
      json = {
        proposal: {
          catalogId: 'modal:large:auto',
          region: 'us',
          durationMinutes: 30,
          requirements: { cpu: 4, memoryGb: 8, gpu: 'A100' },
        },
        receipt: {
          observed: ['4 vCPUs and 8 GiB memory'],
          constraints: ['Fixture response; no model call'],
          decision: 'Prepared an editable draft.',
        },
        mode: 'fixture',
      };
    else {
      unexpected.push(`${method} ${path}`);
      return route.fulfill({ status: 500, json: { error: 'Unexpected form fixture API' } });
    }
    return route.fulfill({ json });
  });
  return { writes, unexpected, reads, releaseDisk };
}
async function expectResourceCopy(page: Page) {
  await expect(page.locator('main')).not.toContainText(/\bregion\b/i);
  await expect(page.getByRole('combobox', { name: /region|configuration/i })).toHaveCount(0);
}
async function expectFormStep(page: Page, step: 1 | 2) {
  const header = page.locator('main .form-page > .page-heading');
  await expect(header.getByRole('heading', { level: 1 })).toBeVisible();
  await expect(header.getByText(`Step ${step} of 3`, { exact: true })).toHaveAttribute(
    'aria-current',
    'step',
  );
}
async function fillEnvironment(page: Page) {
  await page
    .getByLabel('Describe your environment', { exact: true })
    .fill('A Linux environment with 4 vCPUs and 8 GiB memory for 60 minutes, maximum total $2.50.');
  await expect(page.getByLabel('Your maximum total (USD)', { exact: true })).toHaveValue(
    /^2\.50?$/,
  );
  await page.getByLabel('Your maximum total (USD)', { exact: true }).fill('7.1234');
}

test('Describe and manual Review preserve explicit resources and edited budget with no API mutations', async ({
  page,
}) => {
  const fixture = await environmentEntry(page);
  await page.goto('/new/vm');
  await expectFormStep(page, 1);
  await expectResourceCopy(page);
  await fillEnvironment(page);
  const primary = page.getByRole('button', { name: 'Prepare with Muse', exact: true });
  await expect(page.locator('main .button.primary:visible')).toHaveCount(1);
  await expect(primary).toHaveClass(/primary/);
  await expect(page.getByRole('button', { name: 'Review manually', exact: true })).toHaveClass(
    /secondary/,
  );
  await expect(
    page
      .getByRole('button', { name: /alternatives/i })
      .or(page.getByRole('link', { name: /alternatives/i })),
  ).toBeVisible();
  expect(fixture.writes).toEqual([]);
  await page.getByRole('button', { name: 'Review manually', exact: true }).click();
  await expect(page).toHaveURL(/\/requests\/review$/);
  await expectFormStep(page, 2);
  await expectResourceCopy(page);
  await expect(page.getByLabel('Minimum vCPUs', { exact: true })).toHaveValue('4');
  await expect(page.getByLabel('Minimum memory (GiB)', { exact: true })).toHaveValue('8');
  await expect(page.getByRole('button', { name: '60 minutes', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(page.getByLabel('Maximum total price (USD)', { exact: true })).toHaveValue('7.1234');
  const saved = await page.evaluate(() => JSON.parse(sessionStorage.getItem('wick-draft')!));
  expect(saved).toMatchObject({
    region: 'any',
    matchAcrossProviders: true,
    maxPriceCents: 712.34,
    durationMinutes: 60,
    requirements: { cpu: 4, memoryGb: 8 },
  });
  expect(fixture.writes).toEqual([]);
  expect(fixture.unexpected).toEqual([]);
});

test('Muse is called only explicitly and its resource draft retains the buyer budget', async ({
  page,
}) => {
  const fixture = await environmentEntry(page);
  await page.goto('/new/vm');
  await fillEnvironment(page);
  await page
    .getByLabel('Describe your environment', { exact: true })
    .fill(
      'An A100 GPU environment with 4 vCPUs and 8 GiB memory for 30 minutes, maximum total $2.50.',
    );
  await expect(page.getByLabel('Your maximum total (USD)', { exact: true })).toHaveValue('7.1234');
  expect(fixture.writes).toEqual([]);
  await page.getByRole('button', { name: 'Prepare with Muse', exact: true }).click();
  await expect(page).toHaveURL(/\/requests\/review$/);
  await expect(page.getByLabel('Minimum vCPUs', { exact: true })).toHaveValue('4');
  await expect(page.getByLabel('Minimum memory (GiB)', { exact: true })).toHaveValue('8');
  await expect(page.getByRole('button', { name: '30 minutes', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(page.getByLabel('Maximum total price (USD)', { exact: true })).toHaveValue('7.1234');
  const saved = await page.evaluate(() => JSON.parse(sessionStorage.getItem('wick-draft')!));
  expect(saved).toMatchObject({
    region: 'any',
    matchAcrossProviders: true,
    maxPriceCents: 712.34,
    requirements: { cpu: 4, memoryGb: 8, gpu: 'A100' },
  });
  expect(fixture.writes.map((write) => write.path)).toEqual(['/api/muse/translate']);
  expect(fixture.unexpected).toEqual([]);
});

test('linked disk admission waits for compatible routes without calling Muse or creating an auction', async ({
  page,
}) => {
  const fixture = await environmentEntry(page, { disk: 'pending' });
  try {
    await page.goto('/new/vm?diskId=' + linkedDiskId);
    await expect(page.getByRole('status')).toContainText('Checking disk-compatible configurations');
    for (const name of ['Prepare with Muse', 'Review manually']) {
      const action = page.getByRole('button', { name, exact: true });
      expect((await action.count()) === 0 || (await action.isDisabled())).toBe(true);
    }
    expect(fixture.writes).toEqual([]);
    fixture.releaseDisk();
    await fillEnvironment(page);
    await page.getByRole('button', { name: 'Review manually', exact: true }).click();
    await expect(
      page.getByRole('button', { name: 'Start 30-second auction', exact: true }),
    ).toBeEnabled();
    const saved = await page.evaluate(() => JSON.parse(sessionStorage.getItem('wick-draft')!));
    expect(saved).toMatchObject({
      diskId: linkedDiskId,
      catalogId: 'modal:large:auto',
      requirements: { cpu: 4, memoryGb: 8 },
    });
    expect(fixture.writes).toEqual([]);
    expect(fixture.unexpected).toEqual([]);
  } finally {
    fixture.releaseDisk();
  }
});

for (const disk of ['unavailable', 'no-routes'] as const)
  test(`linked disk ${disk} keeps both preparation actions disabled`, async ({ page }) => {
    const fixture = await environmentEntry(page, { disk });
    await page.goto('/new/vm?diskId=' + linkedDiskId);
    await expect(page.getByRole('alert')).toBeVisible();
    await expect(
      page.getByRole('button', { name: 'Prepare with Muse', exact: true }),
    ).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Review manually', exact: true })).toBeDisabled();
    expect(fixture.writes).toEqual([]);
    expect(fixture.unexpected).toEqual([]);
  });

test('keyboard users can reach budget and manual review without invoking Muse', async ({
  page,
}) => {
  const fixture = await environmentEntry(page);
  await page.goto('/new/vm');
  await fillEnvironment(page);
  const description = page.getByLabel('Describe your environment', { exact: true });
  const budget = page.getByLabel('Your maximum total (USD)', { exact: true });
  const manual = page.getByRole('button', { name: 'Review manually', exact: true });
  await description.focus();
  let reachedBudget = false,
    reachedManual = false;
  for (let index = 0; index < 20; index++) {
    await page.keyboard.press('Tab');
    reachedBudget ||= await budget.evaluate((element) => document.activeElement === element);
    if (await manual.evaluate((element) => document.activeElement === element)) {
      reachedManual = true;
      break;
    }
  }
  expect(reachedBudget).toBe(true);
  expect(reachedManual).toBe(true);
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/\/requests\/review$/);
  const duration = page.getByRole('button', { name: '30 minutes', exact: true });
  await duration.focus();
  await page.keyboard.press('Space');
  await expect(duration).toHaveAttribute('aria-pressed', 'true');
  expect(fixture.writes).toEqual([]);
  expect(fixture.unexpected).toEqual([]);
});

for (const width of [375, 768, 1440])
  test(`Describe and Review share a readable form at ${width}px`, async ({ page }, info) => {
    const fixture = await environmentEntry(page);
    await page.setViewportSize({ width, height: width === 375 ? 812 : 1000 });
    await page.goto('/new/vm');
    await fillEnvironment(page);
    await expectFormStep(page, 1);
    await expectResourceCopy(page);
    await expect(page.locator('main .button.primary:visible')).toHaveCount(1);
    await page.evaluate(() => document.fonts.ready);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(
      true,
    );
    await page.evaluate(() => {
      (document.activeElement as HTMLElement)?.blur();
      window.scrollTo(0, 0);
    });
    await page.screenshot({ path: info.outputPath(`describe-${width}.png`), fullPage: true });
    await page.getByRole('button', { name: 'Review manually', exact: true }).click();
    await expectFormStep(page, 2);
    await expect(page.locator('main .button.primary:visible')).toHaveCount(1);
    await page.evaluate(() => document.fonts.ready);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(
      true,
    );
    await page.screenshot({ path: info.outputPath(`review-${width}.png`), fullPage: true });
    expect(fixture.writes).toEqual([]);
    expect(fixture.unexpected).toEqual([]);
  });
