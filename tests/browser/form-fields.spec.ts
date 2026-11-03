import { expect, test, type Page } from './table-review';

// Exercise the shared field through a real form; every API call is intercepted.
async function fixture(page: Page) {
  const catalog = {
    id: 'sail:micro:auto',
    name: 'Micro · Sail',
    description: 'Temporary environment',
    provider: 'sail',
    profile: 'micro',
    region: 'auto',
    cpu: 1,
    memoryGb: 1,
    durationMinutes: [15, 30, 60],
    approved: true,
  };
  const writes: Record<string, unknown>[] = [],
    unexpected: string[] = [];
  await page.addInitScript((catalogId) => {
    sessionStorage.setItem(
      'wick-draft',
      JSON.stringify({
        description: 'Build a searchable research workspace',
        catalogId,
        region: 'any',
        matchAcrossProviders: true,
        durationMinutes: 15,
        maxPriceCents: 321,
        requirements: { cpu: 1, memoryGb: 1 },
      }),
    );
  }, catalog.id);
  await page.route('**/api/**', async (route) => {
    const request = route.request(),
      path = new URL(request.url()).pathname;
    let json: unknown;
    if (path === '/api/me')
      json = {
        user: {
          id: 'field-buyer',
          role: 'buyer',
          name: 'Alex Morgan',
          email: 'buyer@fixture.invalid',
        },
        modes: { wick: 'fixture', muse: 'fixture' },
        catalog: [catalog],
      };
    else if (path === '/api/credits')
      json = { availableCents: 20000, balanceCents: 20000, reservedCents: 0, currency: 'USD' };
    else if (path === '/api/disks/options')
      json = { enabled: false, mode: 'fixture', eligibleCatalogIds: [] };
    else if (path === '/api/disks') json = { items: [] };
    else if (path === '/api/requests' && request.method() === 'POST') {
      writes.push(request.postDataJSON());
      json = { ...request.postDataJSON(), id: 'field-auction', status: 'open' };
    } else if (path === '/api/requests/field-auction')
      json = {
        request: {
          ...writes[0],
          id: 'field-auction',
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
  return { writes, unexpected };
}

test('money errors are described inline without changing the label or retaining a stale price', async ({
  page,
}) => {
  const f = await fixture(page);
  await page.goto('/requests/review');
  const maximum = page.getByRole('textbox', { name: 'Maximum total price (USD)', exact: true }),
    submit = page.getByRole('button', { name: 'Start 30-second auction', exact: true });
  await expect(maximum).toHaveValue('3.21');

  for (const [spelling, message] of [
    ['0.0099', 'Enter at least $0.01.'],
    ['1.23456', 'Enter a USD amount with at most four decimal places.'],
  ]) {
    await maximum.fill(spelling);
    await expect(maximum).toHaveAttribute('aria-invalid', 'true');
    await expect(maximum).toHaveAttribute('aria-describedby', 'max-price-error');
    await expect(maximum).toHaveAccessibleName('Maximum total price (USD)');
    await expect(maximum).toHaveAccessibleDescription(message);
    await expect(page.locator('#max-price-error')).toBeVisible();
    await expect(submit).toBeDisabled();
    expect(f.writes).toHaveLength(0);
  }

  await maximum.fill('');
  await expect(page.locator('#max-price-error')).toHaveCount(0);
  await expect(maximum).not.toHaveAttribute('aria-describedby');
  await expect(submit).toBeDisabled();
  expect(await maximum.evaluate((input: HTMLInputElement) => input.validity.valueMissing)).toBe(
    true,
  );
  expect(f.writes).toHaveLength(0);

  await maximum.pressSequentially('0.0101');
  await expect(maximum).toHaveValue('0.0101');
  await expect(maximum).not.toHaveAttribute('aria-invalid');
  await expect(maximum).not.toHaveAttribute('aria-describedby');
  await submit.click();
  await expect.poll(() => f.writes.length).toBe(1);
  expect(f.writes[0].maxPriceCents).toBe(1.01);
  expect(f.unexpected).toEqual([]);
});

test('both VM auction steps use the Launch a VM workspace label', async ({ page }) => {
  const f = await fixture(page);
  for (const path of ['/new/vm', '/requests/review']) {
    await page.goto(path);
    await expect(page.locator('.topbar-location > strong')).toHaveText('Launch a VM');
  }
  expect(f.unexpected).toEqual([]);
});
