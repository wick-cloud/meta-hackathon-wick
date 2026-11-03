import { expect, test, type Page } from './table-review';

const desired = {
  cpu: 8,
  memoryGb: 16,
  gpu: 'H100',
  region: 'moon-1',
  durationMinutes: 45,
  maxPriceCents: 100,
};
const flexibility = {
  minCPU: 2,
  minMemoryGb: 4,
  allowedRegions: ['us'],
  allowedDurations: [30],
  hardMaxPriceCents: 90,
  gpu: 'none',
};

// Every API request is mocked; these checks cannot allocate a VM or alter an account.
async function alternatives(
  page: Page,
  options: { lostSave?: boolean; failedRead?: boolean; accepted?: boolean } = {},
) {
  let intent = {
    id: 'review-intent',
    description: 'A research workspace with an explicit unsupported region and GPU',
    desired,
    flexibility,
    status: options.accepted ? 'accepted' : 'open',
    sourceMode: 'fixture',
    createdAt: '2026-11-03T12:00:00Z',
  };
  const offers = [1, 2].map((n) => ({
    id: `offer-${n}`,
    providerName: `Provider ${n}`,
    catalogName: `CPU workspace ${n}`,
    before: desired,
    after: { ...desired, cpu: 2, memoryGb: 4, gpu: undefined, region: 'us', durationMinutes: 30 },
    totalPriceCents: 75 + n,
    tradeoffs: ['CPU-only alternative within your reviewed permissions.'],
    expiresAt: new Date(Date.now() + 600000).toISOString(),
    mode: 'fixture',
    modelCalled: false,
  }));
  const writes: { path: string; body: Record<string, any> }[] = [],
    unexpected: string[] = [];
  await page.addInitScript(
    ({ desired, description }) => {
      sessionStorage.setItem(
        'wick-intent:alternative-buyer:',
        JSON.stringify({
          operationKey: '00000000-0000-4000-8000-000000000001',
          description,
          desired,
          flexible: false,
          flexibility: {
            minCPU: desired.cpu,
            minMemoryGb: desired.memoryGb,
            allowedRegions: [],
            allowedDurations: [],
            hardMaxPriceCents: desired.maxPriceCents,
            gpu: 'preserve',
          },
        }),
      );
    },
    { desired, description: intent.description },
  );
  await page.route('**/api/**', async (route) => {
    const request = route.request(),
      path = new URL(request.url()).pathname;
    if (request.method() !== 'GET') writes.push({ path, body: request.postDataJSON() ?? {} });
    let json: unknown;
    if (path === '/api/me')
      json = {
        user: { id: 'alternative-buyer', name: 'Alex Morgan', role: 'buyer' },
        modes: { wick: 'fixture', muse: 'fixture' },
        catalog: [
          {
            id: 'micro',
            name: 'Micro',
            provider: 'e2b',
            profile: 'micro',
            region: 'us',
            cpu: 2,
            memoryGb: 4,
            durationMinutes: [15, 30, 60],
            approved: true,
          },
        ],
      };
    else if (path === '/api/credits')
      json = { availableCents: 10000, balanceCents: 10000, reservedCents: 0, currency: 'USD' };
    else if (path === '/api/requests/source-auction')
      json = {
        request: {
          id: 'source-auction',
          description: intent.description,
          status: 'no_offers',
          requirements: { cpu: desired.cpu, memoryGb: desired.memoryGb, gpu: desired.gpu },
          region: desired.region,
          durationMinutes: desired.durationMinutes,
          maxPriceCents: desired.maxPriceCents,
        },
      };
    else if (path === '/api/intents' && request.method() === 'POST') {
      if (options.lostSave && writes.filter((item) => item.path === path).length === 1)
        return route.fulfill({ status: 503, json: { error: 'The save response was lost.' } });
      intent = { ...intent, ...request.postDataJSON() };
      json = intent;
    } else if (path === '/api/intents') json = { items: [intent] };
    else if (path === '/api/intents/review-intent') {
      if (options.failedRead)
        return route.fulfill({
          status: 503,
          json: { error: 'Alternatives temporarily unavailable.' },
        });
      json = { intent, offers };
    } else if (/\/offers\/offer-[12]\/accept$/.test(path))
      return route.fulfill({ status: 503, json: { error: 'The acceptance result is unknown.' } });
    else if (path === '/api/intents/review-intent/propose') json = { offers };
    else {
      unexpected.push(`${request.method()} ${path}`);
      return route.fulfill({ status: 500, json: { error: 'Unmocked alternatives API' } });
    }
    return route.fulfill({ json });
  });
  return { writes, unexpected };
}

test('strict intent preserves its exact unsupported region, GPU, duration, and decimal budget', async ({
  page,
}) => {
  const f = await alternatives(page);
  await page.goto('/alternatives/new');
  await expect(page.getByLabel('Requested region')).toHaveValue('moon-1');
  await expect(page.getByLabel('Allow only the alternatives I specify below')).not.toBeChecked();
  await page.getByLabel('Original maximum total (USD)', { exact: true }).fill('0.1234');
  await page.getByRole('button', { name: 'Save reviewed intent', exact: true }).click();
  await expect.poll(() => f.writes.length).toBe(1);
  expect(f.writes[0].body.desired).toEqual({ ...desired, maxPriceCents: 12.34 });
  expect(f.writes[0].body).not.toHaveProperty('flexibility');
  expect(f.unexpected).toEqual([]);
});

test('flexibility requires explicit supported regions and durations without rewriting original intent', async ({
  page,
}) => {
  const f = await alternatives(page);
  await page.goto('/alternatives/new');
  await page.getByLabel('Allow only the alternatives I specify below').check();
  const save = page.getByRole('button', { name: 'Save reviewed intent', exact: true });
  await expect(save).toBeDisabled();
  await page.getByLabel('Lowest acceptable vCPUs').fill('2');
  await page.getByLabel('Lowest acceptable memory (GiB)').fill('4');
  await page
    .getByRole('group', { name: 'Allowed supported regions' })
    .getByLabel('us', { exact: true })
    .check();
  await page
    .getByRole('group', { name: 'Allowed rental durations' })
    .getByLabel('30 minutes', { exact: true })
    .check();
  await page.getByLabel('GPU permission').selectOption('none');
  await page.getByLabel('Hard maximum alternative total (USD)', { exact: true }).fill('0.9');
  await save.click();
  await expect.poll(() => f.writes.length).toBe(1);
  expect(f.writes[0].body).toMatchObject({ desired, flexibility });
  expect(f.unexpected).toEqual([]);
});

test('linked auction requirements remain disabled while flexibility stays editable', async ({
  page,
}) => {
  const f = await alternatives(page);
  await page.goto('/alternatives/from/source-auction');
  await expect(page.getByLabel('Requested region')).toHaveValue('moon-1');
  for (const id of [
    'intent-description',
    'intent-cpu',
    'intent-memory',
    'intent-gpu',
    'intent-region',
    'intent-duration',
    'intent-budget',
  ])
    await expect(page.locator(`#${id}`)).toBeDisabled();
  await expect(page.getByLabel('Allow only the alternatives I specify below')).toBeEnabled();
  expect(f.writes).toEqual([]);
  expect(f.unexpected).toEqual([]);
});

test('an unknown save keeps its reviewed snapshot locked and retries the same operation', async ({
  page,
}) => {
  const f = await alternatives(page, { lostSave: true });
  await page.goto('/alternatives/new');
  await page.getByRole('button', { name: 'Save reviewed intent', exact: true }).click();
  await expect(page.getByText('The save response was lost.', { exact: true })).toBeVisible();
  await expect(page.getByLabel('Requested region')).toBeDisabled();
  await expect(page.getByLabel('Allow only the alternatives I specify below')).toBeDisabled();
  await page.getByRole('button', { name: 'Retry saving reviewed intent', exact: true }).click();
  await expect.poll(() => f.writes.length).toBe(2);
  expect(f.writes[1]).toEqual(f.writes[0]);
  expect(f.unexpected).toEqual([]);
});

test('before/after review requires fresh consent and unknown acceptance locks the exact offer', async ({
  page,
}) => {
  const f = await alternatives(page);
  await page.goto('/alternatives/review-intent');
  const review = page.getByRole('button', { name: 'Review this exact offer', exact: true });
  await review.first().click();
  const final = page.getByRole('region', { name: 'Final counteroffer review', exact: true });
  await expect(final.getByRole('cell', { name: 'moon-1', exact: true })).toBeVisible();
  await expect(
    final
      .getByRole('row')
      .filter({ has: page.getByRole('rowheader', { name: 'GPU', exact: true }) }),
  ).toContainText('H100');
  const consent = page.getByLabel('I accept these exact changes, provider and fixed total.', {
    exact: true,
  });
  const accept = page.getByRole('button', { name: 'Accept reviewed offer', exact: true });
  await expect(accept).toBeDisabled();
  await consent.check();
  await review.last().click();
  await expect(consent).not.toBeChecked();
  await expect(accept).toBeDisabled();
  expect(f.writes).toEqual([]);
  await consent.check();
  await accept.click();
  await expect(page.getByText('The acceptance result is unknown.', { exact: true })).toBeVisible();
  await expect(review.first()).toBeDisabled();
  await expect(
    page.getByRole('button', { name: 'Suggest reviewed alternatives', exact: true }),
  ).toBeDisabled();
  await page.getByRole('button', { name: 'Retry this acceptance', exact: true }).click();
  await expect.poll(() => f.writes.length).toBe(2);
  expect(f.writes[0].path).toBe('/api/intents/review-intent/offers/offer-2/accept');
  expect(f.writes[0].body.operationKey).toBeTruthy();
  expect(f.writes[1]).toEqual(f.writes[0]);
  expect(f.unexpected).toEqual([]);
});

test('failed detail retains its page frame and accepted intent exposes no acceptance controls', async ({
  page,
}) => {
  await alternatives(page, { failedRead: true });
  await page.goto('/alternatives/review-intent');
  await expect(
    page.getByRole('heading', { name: 'Review alternative', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText('Alternatives temporarily unavailable.', { exact: true }),
  ).toBeVisible();
  await page.unroute('**/api/**');
  const f = await alternatives(page, { accepted: true });
  await page.reload();
  await expect(page.getByText('This intent is accepted.', { exact: false })).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Accept reviewed offer', exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole('button', { name: 'Review this exact offer', exact: true }).first(),
  ).toBeDisabled();
  expect(f.writes).toEqual([]);
});

for (const width of [375, 768, 1440])
  test(`alternatives compose, inventory, and exact review fit ${width}px`, async ({
    page,
  }, info) => {
    const f = await alternatives(page);
    await page.setViewportSize({ width, height: 960 });
    for (const [name, path] of [
      ['compose', '/alternatives/new'],
      ['inventory', '/alternatives'],
      ['review', '/alternatives/review-intent'],
    ]) {
      await page.goto(path);
      await expect(page.locator('.negotiation-page')).toBeVisible();
      if (name === 'compose')
        await page.getByLabel('Allow only the alternatives I specify below').check();
      if (name === 'inventory')
        await expect(
          page.getByRole('table', { name: 'Saved alternatives', exact: true }),
        ).toBeVisible();
      if (name === 'review')
        await page
          .getByRole('button', { name: 'Review this exact offer', exact: true })
          .first()
          .click();
      await expect
        .poll(() => page.evaluate(() => document.documentElement.scrollWidth - innerWidth))
        .toBeLessThanOrEqual(1);
      await page.screenshot({
        path: info.outputPath(`alternatives-${name}-${width}.png`),
        fullPage: true,
      });
    }
    expect(f.writes).toEqual([]);
    expect(f.unexpected).toEqual([]);
  });
