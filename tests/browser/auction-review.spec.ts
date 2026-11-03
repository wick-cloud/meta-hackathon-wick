import { expect, test, type Page } from './table-review';
import type { CatalogItem } from '../../src/shared/types';

// All API traffic is intercepted: no models, compute, credentials, or database writes.
const diskId = '11111111-1111-4111-8111-111111111111';
const tiny: CatalogItem = {
  id: 'e2b:micro:us',
  name: 'Micro · E2B',
  description: 'Small temporary environment',
  provider: 'e2b',
  profile: 'micro',
  region: 'us',
  cpu: 1,
  memoryGb: 1,
  durationMinutes: [15],
  approved: true,
};
const large: CatalogItem = {
  ...tiny,
  id: 'sail:large:auto',
  name: 'Large · Sail',
  provider: 'sail',
  profile: 'large',
  region: 'auto',
  cpu: 8,
  memoryGb: 16,
  durationMinutes: [15, 30, 60],
};
const baseDraft = {
  description: 'Build a searchable research workspace',
  catalogId: tiny.id,
  region: 'us',
  matchAcrossProviders: false,
  durationMinutes: 15,
  maxPriceCents: 321,
  requirements: { cpu: 1, memoryGb: 1 },
};
async function review(
  page: Page,
  options: {
    catalog?: CatalogItem[];
    draft?: Partial<typeof baseDraft> & {
      diskId?: string;
      requirements?: { cpu: number; memoryGb: number; gpu?: string };
    };
    eligibleCatalogIds?: string[];
  } = {},
) {
  const catalog = options.catalog ?? [tiny, large];
  const draft = { ...baseDraft, ...options.draft };
  const writes: Record<string, any>[] = [],
    unexpected: string[] = [];
  await page.addInitScript(
    (value) => sessionStorage.setItem('wick-draft', JSON.stringify(value)),
    draft,
  );
  await page.route('**/api/**', async (route) => {
    const request = route.request(),
      path = new URL(request.url()).pathname;
    let json: unknown;
    if (path === '/api/me')
      json = {
        user: {
          id: 'review-buyer',
          role: 'buyer',
          name: 'Alex Morgan',
          email: 'buyer@fixture.invalid',
        },
        modes: { wick: 'real', muse: 'fixture' },
        catalog,
      };
    else if (path === '/api/credits')
      json = { availableCents: 20000, balanceCents: 20000, reservedCents: 0, currency: 'USD' };
    else if (path === '/api/disks/options')
      json = {
        enabled: true,
        mode: 'fixture',
        eligibleCatalogIds: options.eligibleCatalogIds ?? [],
      };
    else if (path === '/api/disks')
      json = {
        items: [{ id: diskId, name: 'research-workspace', status: 'ready', cleanupPending: false }],
      };
    else if (path === '/api/requests' && request.method() === 'POST') {
      writes.push(request.postDataJSON());
      json = { ...request.postDataJSON(), id: 'reviewed-auction', status: 'open' };
    } else if (path === '/api/requests/reviewed-auction')
      json = {
        request: {
          ...writes[0],
          id: 'reviewed-auction',
          status: 'open',
          createdAt: new Date().toISOString(),
          closesAt: new Date(Date.now() + 30000).toISOString(),
        },
        bids: [],
      };
    else {
      unexpected.push(`${request.method()} ${path}`);
      return route.fulfill({ status: 500, json: { error: 'Unmocked UI API' } });
    }
    return route.fulfill({ json });
  });
  await page.goto('/requests/review');
  await expect(page.getByLabel('Minimum vCPUs', { exact: true })).toBeVisible();
  return { writes, unexpected };
}
const submit = (page: Page) =>
  page.getByRole('button', { name: 'Start 30-second auction', exact: true });
async function assertResourceOnly(page: Page) {
  await expect(page.getByRole('combobox', { name: /configuration|region/i })).toHaveCount(0);
  await expect(page.getByRole('checkbox', { name: /compatible providers/i })).toHaveCount(0);
  await expect(page.getByText('Reference configuration', { exact: true })).toHaveCount(0);
  await expect(page.getByText(/^region$/i)).toHaveCount(0);
}

test('raising resource minimums finds a larger configuration on another provider', async ({
  page,
}) => {
  const fixture = await review(page);
  await assertResourceOnly(page);
  await page.getByLabel('Minimum vCPUs', { exact: true }).fill('4');
  await page.getByLabel('Minimum memory (GiB)', { exact: true }).fill('8');
  await expect(submit(page)).toBeEnabled();
  await submit(page).click();
  await expect.poll(() => fixture.writes.length).toBe(1);
  expect(fixture.writes[0]).toMatchObject({
    catalogId: large.id,
    region: 'any',
    matchAcrossProviders: true,
    requirements: { cpu: 4, memoryGb: 8 },
  });
  expect(fixture.unexpected).toEqual([]);
});

test('an unapproved original anchor and old region do not block compatible alternatives', async ({
  page,
}) => {
  const fixture = await review(page, {
    catalog: [{ ...tiny, approved: false }, large],
    draft: { region: 'moon-1' },
  });
  await assertResourceOnly(page);
  await expect(submit(page)).toBeEnabled();
  await submit(page).click();
  await expect.poll(() => fixture.writes.length).toBe(1);
  expect(fixture.writes[0]).toMatchObject({
    catalogId: large.id,
    region: 'any',
    matchAcrossProviders: true,
  });
  expect(fixture.unexpected).toEqual([]);
});

test('a rental length supported by another provider is available beyond the original anchor', async ({
  page,
}) => {
  const fixture = await review(page);
  await page.getByRole('button', { name: '30 minutes', exact: true }).click();
  await expect(submit(page)).toBeEnabled();
  await submit(page).click();
  await expect.poll(() => fixture.writes.length).toBe(1);
  expect(fixture.writes[0]).toMatchObject({
    catalogId: large.id,
    durationMinutes: 30,
    region: 'any',
    matchAcrossProviders: true,
  });
  expect(fixture.unexpected).toEqual([]);
});

test('editing CPU and memory preserves a GPU requirement and chooses its compatible provider', async ({
  page,
}) => {
  const gpu = {
    ...large,
    id: 'modal:gpu:auto',
    provider: 'modal',
    name: 'GPU · Modal',
    gpu: 'A100',
  };
  const fixture = await review(page, {
    catalog: [tiny, large, gpu],
    draft: { requirements: { cpu: 2, memoryGb: 4, gpu: 'A100' } },
  });
  await page.getByLabel('Minimum vCPUs', { exact: true }).fill('4');
  await page.getByLabel('Minimum memory (GiB)', { exact: true }).fill('8');
  await expect(submit(page)).toBeEnabled();
  await submit(page).click();
  await expect.poll(() => fixture.writes.length).toBe(1);
  expect(fixture.writes[0]).toMatchObject({
    catalogId: gpu.id,
    requirements: { cpu: 4, memoryGb: 8, gpu: 'A100' },
  });
  expect(fixture.unexpected).toEqual([]);
});

test('a GPU requirement with no compatible provider remains visible and cannot submit', async ({
  page,
}) => {
  const fixture = await review(page, {
    draft: { requirements: { cpu: 2, memoryGb: 4, gpu: 'A100' } },
  });
  await expect(submit(page)).toBeDisabled();
  await expect(page.getByText(/A100/).first()).toBeVisible();
  const saved = await page.evaluate(() => JSON.parse(sessionStorage.getItem('wick-draft')!));
  expect(saved.requirements.gpu).toBe('A100');
  expect(fixture.writes).toEqual([]);
});

test('a disk only admits qualified routes that also satisfy the resource minimums', async ({
  page,
}) => {
  const fixture = await review(page, {
    draft: { diskId, requirements: { cpu: 4, memoryGb: 8 } },
    eligibleCatalogIds: [tiny.id],
  });
  await expect(submit(page)).toBeDisabled();
  expect(fixture.writes).toEqual([]);
  expect(fixture.unexpected).toEqual([]);
});

test('a disk can move an obsolete anchor to a qualified compatible provider', async ({ page }) => {
  const fixture = await review(page, {
    draft: { diskId, requirements: { cpu: 4, memoryGb: 8 } },
    eligibleCatalogIds: [large.id],
  });
  await expect(submit(page)).toBeEnabled();
  await submit(page).click();
  await expect.poll(() => fixture.writes.length).toBe(1);
  expect(fixture.writes[0]).toMatchObject({
    diskId,
    catalogId: large.id,
    region: 'any',
    matchAcrossProviders: true,
    requirements: { cpu: 4, memoryGb: 8 },
  });
  expect(fixture.unexpected).toEqual([]);
});

test('no compatible CPU and memory shape disables the auction without reducing requirements', async ({
  page,
}) => {
  const fixture = await review(page, { draft: { requirements: { cpu: 16, memoryGb: 32 } } });
  await expect(page.getByLabel('Minimum vCPUs', { exact: true })).toHaveValue('16');
  await expect(page.getByLabel('Minimum memory (GiB)', { exact: true })).toHaveValue('32');
  await expect(submit(page)).toBeDisabled();
  expect(fixture.writes).toEqual([]);
});

for (const width of [375, 768, 1440])
  test(`resource-first auction review fits at ${width}px`, async ({ page }, testInfo) => {
    const fixture = await review(page, {
      draft: { durationMinutes: 30, requirements: { cpu: 4, memoryGb: 8 } },
    });
    await page.setViewportSize({ width, height: width === 375 ? 812 : 1000 });
    await assertResourceOnly(page);
    await expect(page.getByText('Step 2 of 3', { exact: true })).toBeVisible();
    await expect(page.locator('main .button.primary:visible')).toHaveCount(1);
    await expect(
      page.getByRole('textbox', { name: 'Your requirement', exact: true }),
    ).toBeVisible();
    await expect(page.getByLabel('Maximum total price (USD)', { exact: false })).toBeVisible();
    await expect(submit(page)).toBeEnabled();
    await page.evaluate(() => document.fonts.ready);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(
      true,
    );
    await page.screenshot({
      path: testInfo.outputPath(`auction-review-${width}.png`),
      fullPage: true,
    });
    expect(fixture.writes).toEqual([]);
    expect(fixture.unexpected).toEqual([]);
  });
