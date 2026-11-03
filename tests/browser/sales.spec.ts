import { expect, test, type Page } from './table-review';
import type { SalesReport } from '../../src/shared/sales';

const policy = {
  autoBid: false,
  minimumPriceCents: 5,
  basePriceCents: 10,
  maxPriceCents: 30,
  reserveSlots: 2,
  allowedCatalogIds: ['e2b-micro'],
};
const report: SalesReport = {
  generatedAt: '2026-11-03T16:00:00Z',
  baseRevision: 7,
  currentPolicy: policy,
  capacity: { total: 10, held: 3, available: 5 },
  mode: 'fixture',
  sourceMode: 'fixture',
  modelCalled: false,
  summary:
    'Automatic bidding is paused. Your published configuration matches recent buyer requests.',
  catalogNames: { 'e2b-micro': 'E2B Linux Micro' },
  evidence: [
    {
      id: 'automation',
      label: 'Automatic bidding',
      detail: 'Your current policy has automatic bids and counteroffers turned off.',
    },
    {
      id: 'demand',
      label: 'Recent demand',
      detail: 'Two of five recent requests fit your base price and published configuration.',
    },
  ],
  recommendations: [
    {
      id: 'enable-bids',
      title: 'Respond automatically to eligible requests',
      description: 'Enable automatic bids within your existing price and capacity limits.',
      policy: { ...policy, autoBid: true },
      comparison: { sampledRequests: 5, currentMatches: 2, proposedMatches: 2 },
      evidenceIds: ['automation', 'demand'],
      explanation:
        'You have available slots and suitable demand. Automatic bidding can submit eligible offers while retaining two spare slots.',
    },
    {
      id: 'lower-base',
      title: 'Review a lower base price',
      description: 'Reduce your base price by 10% while keeping your minimum price.',
      policy: { ...policy, basePriceCents: 9 },
      comparison: { sampledRequests: 5, currentMatches: 2, proposedMatches: 4 },
      evidenceIds: ['demand'],
      explanation:
        'A lower base price matches two additional requests in this sample. These matches are not predicted wins.',
    },
  ],
  limitations: [
    'This review uses a bounded seven-day sample.',
    'Configured slots are not upstream utilization.',
  ],
};

async function seller(
  page: Page,
  options: { apply?: 'uncertain' | 'stale'; modelError?: boolean; empty?: boolean } = {},
) {
  const applies: Record<string, unknown>[] = [];
  const analyses: Record<string, unknown>[] = [];
  await page.route('**/api/**', async (route) => {
    const req = route.request();
    const path = new URL(req.url()).pathname;
    if (path === '/api/me')
      return route.fulfill({
        json: {
          user: { id: 'sales-provider', role: 'provider', name: 'E2B seller' },
          modes: { wick: 'fixture', muse: 'fixture' },
          catalog: [],
        },
      });
    if (path === '/api/provider/sales/propose') {
      analyses.push(req.postDataJSON());
      if (options.modelError)
        return route.fulfill({
          status: 503,
          json: { error: 'Muse could not complete a validated recommendation. Try again.' },
        });
      return route.fulfill({
        json: options.empty
          ? {
              ...report,
              recommendations: [],
              summary: 'No supported policy change improves the current sample.',
            }
          : report,
      });
    }
    if (path === '/api/provider/policy' && req.method() === 'PUT') {
      applies.push(req.postDataJSON());
      if (options.apply === 'uncertain' && applies.length === 1)
        return route.fulfill({
          status: 500,
          json: { error: 'The connection ended before a response was available.' },
        });
      if (options.apply === 'stale')
        return route.fulfill({ status: 409, json: { error: 'Policy changed.' } });
      return route.fulfill({ json: { policy: { ...policy, autoBid: true }, policyRevision: 8 } });
    }
    return route.fulfill({
      status: 500,
      json: { error: `Unexpected mocked request: ${req.method()} ${path}` },
    });
  });
  return { applies, analyses };
}

async function analyze(page: Page) {
  await page.goto('/provider/sales');
  await page.getByRole('button', { name: 'Reach more buyers', exact: true }).click();
  await page.getByRole('button', { name: 'Get recommendations', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Options worth reviewing' })).toBeVisible();
}

test('seller reviews evidence and exact policy changes before applying one recommendation', async ({
  page,
}, info) => {
  const { applies, analyses } = await seller(page);
  await analyze(page);
  expect(analyses).toEqual([{ goal: 'Help me reach more suitable buyer requests.' }]);
  expect(applies).toHaveLength(0);
  await expect(
    page.getByText('Fixture recommendations · no Meta call', { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('link', { name: 'Recent demand', exact: true }).first(),
  ).toHaveAttribute('href', '#sales-evidence-demand');
  await page.getByRole('button', { name: 'Review changes', exact: true }).first().click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toContainText('Current');
  await expect(dialog).toContainText('Proposed');
  await expect(dialog).toContainText('Applying enables automatic bids and counteroffers');
  await expect(dialog.getByRole('row', { name: /Spare slots/ })).toContainText('2');
  await expect(dialog.getByRole('row', { name: /Minimum rental price/ })).toContainText('$0.05');
  expect(applies).toHaveLength(0);
  await page.screenshot({ path: info.outputPath('sales-review-desktop.png') });
  await dialog.getByRole('button', { name: 'Back to recommendations' }).click();
  expect(applies).toHaveLength(0);
  await page.getByRole('button', { name: 'Review changes', exact: true }).first().click();
  await page.getByRole('button', { name: 'Apply this change', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Your selling policy is updated.');
  expect(applies).toHaveLength(1);
  expect(applies[0]).toMatchObject({ ...policy, autoBid: true, expectedRevision: 7 });
  expect(applies[0].operationKey).toMatch(/^[0-9a-f-]{36}$/);
  await expect(page.getByRole('button', { name: 'Review changes', exact: true })).toHaveCount(0);
});

test('uncertain Apply freezes the review and retries the same operation and settings', async ({
  page,
}) => {
  const { applies } = await seller(page, { apply: 'uncertain' });
  await analyze(page);
  await page.getByRole('button', { name: 'Review changes', exact: true }).first().click();
  await page.getByRole('button', { name: 'Apply this change', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('alert')).toContainText('result of Apply is not confirmed');
  await expect(dialog.getByRole('button', { name: 'Back to recommendations' })).toBeDisabled();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Refresh recommendations', includeHidden: true }),
  ).toBeDisabled();
  await expect(
    page.getByRole('button', { name: 'Review changes', exact: true, includeHidden: true }).last(),
  ).toBeDisabled();
  await dialog.getByRole('button', { name: 'Retry same change' }).click();
  await expect(page.getByRole('status')).toContainText('Your selling policy is updated.');
  expect(applies).toHaveLength(2);
  expect(applies[1]).toEqual(applies[0]);
});

test('stale policy rejects Apply and removes recommendations until a fresh review', async ({
  page,
}) => {
  const { applies } = await seller(page, { apply: 'stale' });
  await analyze(page);
  await page.getByRole('button', { name: 'Review changes', exact: true }).first().click();
  await page.getByRole('button', { name: 'Apply this change', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Generate fresh recommendations');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Review changes', exact: true })).toHaveCount(0);
  expect(applies).toHaveLength(1);
  await expect(
    page.getByRole('button', { name: 'Get recommendations', exact: true }),
  ).toBeEnabled();
});

test('model failures remain visible and do not create policy changes', async ({ page }) => {
  const { applies } = await seller(page, { modelError: true });
  await page.goto('/provider/sales');
  await page.getByLabel('Your selling goal').fill('Help my spare capacity sell.');
  await page.getByRole('button', { name: 'Get recommendations', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Muse could not complete');
  await expect(page.getByRole('button', { name: 'Review changes', exact: true })).toHaveCount(0);
  expect(applies).toHaveLength(0);
});

test('an empty recommendation keeps evidence available without an Apply action', async ({
  page,
}) => {
  const { applies } = await seller(page, { empty: true });
  await page.goto('/provider/sales');
  await page.getByLabel('Your selling goal').fill('Review my current policy.');
  await page.getByRole('button', { name: 'Get recommendations', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'No policy change recommended' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Evidence behind this review' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Review changes', exact: true })).toHaveCount(0);
  expect(applies).toHaveLength(0);
});

test('recommendations and policy review fit a narrow screen', async ({ page }, info) => {
  await seller(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await analyze(page);
  await page.screenshot({ path: info.outputPath('sales-mobile.png'), fullPage: true });
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth - innerWidth),
  ).toBeLessThanOrEqual(1);
  await page.getByRole('button', { name: 'Review changes', exact: true }).first().click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  expect(
    await dialog.evaluate((element) => element.scrollWidth - element.clientWidth),
  ).toBeLessThanOrEqual(1);
  await page.screenshot({ path: info.outputPath('sales-review-mobile.png') });
  await expect(
    dialog.getByRole('button', { name: 'Apply this change', exact: true }),
  ).toBeVisible();
});
