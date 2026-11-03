import { expect, test, type Page } from './table-review';

// Presentation fixtures intercept every API request; no account or billing writes occur.
async function finance(
  page: Page,
  mode: 'rows' | 'empty' | 'error' | 'historical' | 'wallet-error' = 'rows',
) {
  const writes: string[] = [];
  let fail = mode === 'error' || mode === 'wallet-error';
  const invoice = (id: string) => ({
    id,
    vmId: 'vm-fixture',
    number: `INV-${id}`,
    catalogName: 'Build environment',
    amountCents: 173.31,
    createdAt: '2026-11-02T12:00:00Z',
  });
  await page.route('**/api/**', async (route) => {
    const request = route.request(),
      url = new URL(request.url()),
      path = url.pathname;
    if (request.method() !== 'GET') writes.push(path);
    if (path === '/api/me')
      return route.fulfill({
        json: {
          user: {
            id: 'buyer',
            role: 'buyer',
            name: 'Fixture buyer',
            email: 'buyer@fixture.invalid',
          },
          modes: { wick: 'fixture', muse: 'fixture' },
          catalog: [],
        },
      });
    if (path === '/api/invoices') {
      if (fail)
        return route.fulfill({
          status: 503,
          json: { error: 'Invoices are temporarily unavailable.' },
        });
      return route.fulfill({
        json: {
          items: mode === 'empty' ? [] : [invoice(url.searchParams.has('cursor') ? '002' : '001')],
          ...(!url.searchParams.has('cursor') && mode !== 'empty' ? { nextCursor: 'older' } : {}),
        },
      });
    }
    if (path === '/api/agreement-charges')
      return route.fulfill({
        json: {
          items:
            mode === 'historical'
              ? [
                  {
                    id: 'legacy-charge',
                    agreementId: 'legacy-agreement',
                    windowId: 'legacy-window',
                    description: 'Historical build capacity',
                    providerName: 'Fixture provider',
                    quantity: 2,
                    startsAt: '2026-10-01T12:00:00Z',
                    discountEndsAt: '2026-10-01T13:00:00Z',
                    endsAt: '2026-10-01T14:00:00Z',
                    discountRateCentsPerHour: 40,
                    normalRateCentsPerHour: 50,
                    grossCents: 180,
                    creditCents: 6.69,
                    totalCents: 173.31,
                    feeCents: 0,
                    createdAt: '2026-10-01T14:00:00Z',
                    currency: 'USD',
                    status: 'pilot-credit',
                    label: 'Settled historical booking',
                  },
                ]
              : [],
        },
      });
    if (path === '/api/agreements/legacy-agreement')
      return route.fulfill({
        json: {
          agreement: {
            id: 'legacy-agreement',
            description: 'Historical build capacity',
            status: 'expired',
            reservedCents: 0,
            committedCents: 173.31,
            settledCents: 173.31,
            adjustmentCents: 6.69,
            timeZone: 'UTC',
            createdAt: '2026-10-01T10:00:00Z',
          },
          bookings: [
            {
              id: 'legacy-booking',
              providerName: 'Fixture provider',
              catalogId: 'fixture-small',
              quantity: 2,
              startsAt: '2026-10-01T12:00:00Z',
              endsAt: '2026-10-01T14:00:00Z',
              totalCents: 173.31,
              discountRateCentsPerHour: 40,
              normalRateCentsPerHour: 50,
            },
          ],
          activations: [
            {
              id: 'legacy-activation',
              vmId: 'vm-fixture',
              status: 'terminated',
              createdAt: '2026-10-01T12:00:00Z',
              endsAt: '2026-10-01T14:00:00Z',
            },
          ],
        },
      });
    if (path === '/api/credits')
      return route.fulfill({
        json: { balanceCents: 10000, reservedCents: 2000, availableCents: 8000, currency: 'USD' },
      });
    if (path === '/api/credits/history') {
      if (fail && mode === 'wallet-error')
        return route.fulfill({
          status: 503,
          json: { error: 'Credit history is temporarily unavailable.' },
        });
      return route.fulfill({
        json: {
          items: [
            {
              id: 'ledger-1',
              kind: 'agent_funding',
              description: 'Research agent budget',
              amountCents: 0,
              reservedDeltaCents: 173.31,
              createdAt: '2026-11-02T12:00:00Z',
            },
          ],
        },
      });
    }
    return route.fulfill({ status: 500, json: { error: `Unexpected fixture request ${path}` } });
  });
  return {
    writes,
    recover: () => {
      fail = false;
    },
  };
}

for (const width of [1440, 768, 375]) {
  test(`financial inventories retain exact prices and fit ${width}px`, async ({ page }, info) => {
    const { writes } = await finance(page);
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/invoices');
    const invoices = page.getByRole('table', { name: 'Instant rental invoices', exact: true });
    await expect(invoices.getByRole('cell', { name: '$1.7331', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Load more', exact: true }).click();
    await expect(invoices.locator('tbody tr')).toHaveCount(2);
    await expect(page.getByRole('region', { name: 'Loaded invoice summary' })).toContainText(
      '$3.4662',
    );
    await expect(
      page.getByText('Totals cover loaded invoices only.', { exact: false }),
    ).toBeVisible();
    await expect(page.getByText('2 invoices shown', { exact: true })).toBeVisible();
    await expect(invoices.getByRole('link', { name: 'Build environment' }).first()).toHaveAttribute(
      'href',
      '/vms/vm-fixture',
    );
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.screenshot({ path: info.outputPath(`invoices-${width}.png`), fullPage: true });
    await page.goto('/credits');
    const ledger = page.getByRole('table', { name: 'Wallet ledger', exact: true });
    await expect(ledger.getByRole('cell', { name: '+$1.7331', exact: true })).toBeVisible();
    await expect(page.getByText('1 entry shown', { exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.screenshot({ path: info.outputPath(`wallet-${width}.png`), fullPage: true });
    expect(writes).toEqual([]);
  });
}

test('empty invoices explain when records appear', async ({ page }) => {
  await finance(page, 'empty');
  await page.goto('/invoices');
  await expect(page.getByRole('heading', { name: 'Nothing to account for yet' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Historical capacity charges' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Load more' })).toHaveCount(0);
});

test('failed invoice reads can recover without creating a financial record', async ({ page }) => {
  const f = await finance(page, 'error');
  await page.goto('/invoices');
  await expect(
    page.getByText('Invoices are temporarily unavailable.', { exact: true }),
  ).toBeVisible();
  f.recover();
  await page.getByRole('button', { name: 'Try again', exact: true }).click();
  await expect(
    page.getByRole('table', { name: 'Instant rental invoices', exact: true }),
  ).toBeVisible();
  expect(f.writes).toEqual([]);
});

test('historical capacity records retain prices and environment links without scheduling controls', async ({
  page,
}) => {
  const { writes } = await finance(page, 'historical');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/invoices');
  const charges = page.getByRole('table', { name: 'Historical capacity charges', exact: true });
  await expect(charges.getByText('$1.7331', { exact: true })).toBeVisible();
  await expect(page.getByText('1 charge shown', { exact: true })).toBeVisible();
  await expect(charges.getByRole('link', { name: 'Historical build capacity' })).toHaveAttribute(
    'href',
    '/orders/legacy-agreement',
  );
  await charges.getByRole('link', { name: 'Historical build capacity' }).click();
  await expect(page.getByRole('heading', { name: 'Historical build capacity' })).toBeVisible();
  await expect(page.getByText(/This read-only record preserves your bookings/)).toBeVisible();
  const bookings = page.getByRole('table', { name: 'Historical capacity bookings', exact: true });
  await expect(bookings.locator('tbody tr').first().locator('td').nth(3)).toContainText('$1.7331');
  await expect(bookings.getByRole('columnheader')).toHaveText([
    'Provider',
    'Access window',
    'Quantity',
    'Accepted total',
  ]);
  const environments = page.getByRole('table', {
    name: 'Historical booking environments',
    exact: true,
  });
  await expect(environments.getByRole('link', { name: 'Open environment' })).toHaveAttribute(
    'href',
    '/vms/vm-fixture',
  );
  await expect(
    page.getByRole('button', { name: /Start VMs|Cancel unmatched|Activate/ }),
  ).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(writes).toEqual([]);
});

test('wallet history errors remain distinct from an empty wallet and can recover', async ({
  page,
}) => {
  const fixture = await finance(page, 'wallet-error');
  await page.goto('/credits');
  await expect(
    page.getByText('Credit history is temporarily unavailable.', { exact: true }),
  ).toBeVisible();
  await expect(page.getByRole('heading', { name: 'No credit entries yet' })).toHaveCount(0);
  await expect(page.getByText('0 entries shown', { exact: true })).toHaveCount(0);
  fixture.recover();
  await page.getByRole('button', { name: 'Try again', exact: true }).click();
  await expect(page.getByRole('table', { name: 'Wallet ledger', exact: true })).toBeVisible();
  await expect(page.getByText('1 entry shown', { exact: true })).toBeVisible();
  expect(fixture.writes).toEqual([]);
});
