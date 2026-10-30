import { expect, test, type Page } from '@playwright/test';
import type { VMInventoryItem } from '../../src/shared/vm-inventory';

// All API requests are intercepted. These tests cannot allocate or terminate real VMs.
const ids = Array.from(
  { length: 5 },
  (_, i) => `11111111-1111-4111-8111-${String(i + 1).padStart(12, '0')}`,
);
async function fixture(
  page: Page,
  options: { smallPages?: boolean; failTerminateOnce?: boolean; empty?: boolean } = {},
) {
  const now = Date.now(),
    future = new Date(now + 30 * 60000).toISOString();
  const rows: VMInventoryItem[] = (
    [
      {
        name: 'Research workspace',
        status: 'running',
        provider: 'e2b',
        providerName: 'E2B',
        cleanupPending: false,
      },
      {
        name: 'Build environment',
        status: 'provisioning',
        provider: 'daytona',
        providerName: 'Daytona',
        cleanupPending: false,
      },
      {
        name: 'Failed cleanup',
        status: 'failed',
        provider: 'modal',
        providerName: 'Modal',
        cleanupPending: true,
      },
      {
        name: 'Old training VM',
        status: 'expired',
        provider: 'modal',
        providerName: 'Modal',
        cleanupPending: false,
      },
      {
        name: 'Archived worker',
        status: 'terminated',
        provider: 'provider-blaxel',
        providerName: 'Baseten',
        cleanupPending: false,
      },
    ] as const
  ).map((row, i) => ({
    ...row,
    id: ids[i]!,
    requestId: ids[i]!,
    sourceMode: 'fixture',
    cpu: 2,
    memoryGb: 4,
    gpu: null,
    region: 'us-east',
    priceCents: 173.31,
    billingSource: 'instant_vm',
    createdAt: new Date(now - i * 3600000).toISOString(),
    expiresAt: i < 3 ? future : new Date(now - 3600000).toISOString(),
  }));
  if (options.empty) rows.length = 0;
  const reads: URL[] = [],
    writes: { path: string; body: any }[] = [];
  let failRefresh = false;
  await page.route('**/api/**', async (route) => {
    const request = route.request(),
      url = new URL(request.url()),
      path = url.pathname;
    if (path === '/api/me')
      return route.fulfill({
        json: {
          user: {
            id: 'fixture-buyer',
            name: 'Preview buyer',
            email: 'preview@fixture.invalid',
            role: 'buyer',
          },
          modes: { wick: 'fixture', muse: 'fixture' },
          catalog: ['e2b', 'daytona', 'modal', 'provider-blaxel'].map((provider, i) => ({
            id: 'sku' + i,
            name: 'Small Linux',
            provider,
            cpu: 2,
            memoryGb: 4,
            region: 'us-east',
            durationMinutes: [30],
            approved: true,
          })),
        },
      });
    if (path === '/api/vm-inventory') {
      reads.push(url);
      if (failRefresh)
        return route.fulfill({ status: 503, json: { error: 'Inventory refresh unavailable.' } });
      const status = url.searchParams.get('status') ?? 'all',
        provider = url.searchParams.get('provider') ?? 'all',
        term = (url.searchParams.get('search') ?? '').toLowerCase();
      const active = (r: VMInventoryItem) =>
        ['running', 'provisioning', 'terminating'].includes(r.status) || r.cleanupPending;
      let shown = rows.filter(
        (r) =>
          (status === 'all' ||
            (status === 'active'
              ? active(r)
              : status === 'past'
                ? !active(r)
                : r.status === status)) &&
          (provider === 'all' || r.provider === provider) &&
          (!term || r.name.toLowerCase().includes(term) || r.id.includes(term)),
      );
      if (url.searchParams.get('sort') === 'oldest') shown = [...shown].reverse();
      const limit = options.smallPages ? 2 : 25,
        start = url.searchParams.has('cursor')
          ? Number(url.searchParams.get('cursor'))
          : url.searchParams.has('before')
            ? Math.max(0, Number(url.searchParams.get('before')) - limit)
            : 0;
      return route.fulfill({
        json: {
          items: shown.slice(start, start + limit),
          ...(start + limit < shown.length ? { nextCursor: String(start + limit) } : {}),
          ...(start > 0 ? { previousCursor: String(start) } : {}),
          serverNow: new Date().toISOString(),
        },
      });
    }
    if (path.endsWith('/terminate') && request.method() === 'POST') {
      writes.push({ path, body: request.postDataJSON() });
      if (options.failTerminateOnce && writes.length === 1) return route.abort('failed');
      const vm = rows.find((r) => path.includes(r.id));
      if (vm) {
        vm.status = 'terminating';
        vm.cleanupPending = true;
      }
      return route.fulfill({ json: { accepted: true } });
    }
    return route.fulfill({ status: 500, json: { error: `Unexpected fixture API ${path}` } });
  });
  return {
    rows,
    reads,
    writes,
    failRefresh: () => {
      failRefresh = true;
    },
  };
}

test('VMs use a compact table with frozen provider/resources, exact price and safe row actions', async ({
  page,
}) => {
  const f = await fixture(page);
  await page.goto('/vms');
  await expect(page.getByRole('heading', { name: 'Virtual machines', exact: true })).toBeVisible();
  const table = page.getByRole('table');
  await expect(table.getByRole('columnheader')).toHaveCount(9);
  await expect(table.locator('tbody tr')).toHaveCount(5);
  await expect(page.locator('.vm-grid')).toHaveCount(0);
  const running = table
    .getByRole('row')
    .filter({ has: page.getByRole('link', { name: 'Research workspace', exact: true }) });
  await expect(running).toContainText('2 vCPU · 4 GiB');
  await expect(running).toContainText('$1.7331');
  await expect(running).toContainText('E2B');
  await expect(
    running.getByRole('link', { name: 'Open terminal Research workspace' }),
  ).toHaveAttribute('href', `/vms/${ids[0]}`);
  const held = table
    .getByRole('row')
    .filter({ has: page.getByRole('link', { name: 'Failed cleanup', exact: true }) });
  await expect(held).toContainText('Cleanup pending');
  await expect(held.getByRole('button', { name: /Terminate/ })).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'View orders', exact: true })).toHaveAttribute(
    'href',
    '/orders',
  );
  expect(f.writes).toHaveLength(0);
  expect(f.reads[0]!.searchParams.get('limit')).toBe('25');
  await page.screenshot({ path: test.info().outputPath('vm-table-desktop.png'), fullPage: true });
});

test('search, filters, sorting and both pagination directions are URL backed', async ({ page }) => {
  const f = await fixture(page, { smallPages: true });
  await page.goto('/vms');
  await page.getByRole('button', { name: 'Next', exact: true }).click();
  await expect(page).toHaveURL(/cursor=2/);
  await expect(page.getByRole('link', { name: 'Old training VM', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Previous', exact: true }).click();
  await expect(page).toHaveURL(/before=2/);
  await expect(page.getByRole('link', { name: 'Research workspace', exact: true })).toBeVisible();
  await page.getByRole('searchbox', { name: 'Search VMs' }).fill('Archived worker');
  await page.getByRole('button', { name: 'Search', exact: true }).click();
  await expect(page).toHaveURL(/search=Archived\+worker/);
  await expect(page.getByRole('link', { name: 'Archived worker', exact: true })).toBeVisible();
  expect(new URL(page.url()).searchParams.has('cursor')).toBe(false);
  expect(new URL(page.url()).searchParams.has('before')).toBe(false);
  await page.reload();
  await expect(page.getByRole('searchbox', { name: 'Search VMs' })).toHaveValue('Archived worker');
  await page.getByRole('button', { name: 'Clear VM search' }).click();
  await page.getByRole('combobox', { name: 'Filter VMs by provider' }).selectOption('modal');
  await expect(page.getByRole('table').locator('tbody tr')).toHaveCount(2);
  await page.getByRole('button', { name: 'History', exact: true }).click();
  await expect(page.getByRole('table').locator('tbody tr')).toHaveCount(1);
  await expect(page.getByRole('link', { name: 'Old training VM', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Newest first' }).click();
  await expect(page).toHaveURL(/sort=oldest/);
  await page.goBack();
  await expect(page.getByRole('button', { name: 'Newest first' })).toBeVisible();
  expect(f.writes).toHaveLength(0);
});

test('termination requires confirmation and an uncertain retry preserves its operation key', async ({
  page,
}) => {
  const f = await fixture(page, { failTerminateOnce: true });
  await page.goto('/vms');
  await page.getByRole('button', { name: 'Terminate Research workspace', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toContainText('files will be deleted');
  expect(f.writes).toHaveLength(0);
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  expect(f.writes).toHaveLength(0);
  await page.getByRole('button', { name: 'Terminate Research workspace', exact: true }).click();
  await dialog.getByRole('button', { name: 'Confirm termination' }).click();
  await expect(dialog).toContainText('response could not be confirmed');
  await dialog.getByRole('button', { name: 'Confirm termination' }).click();
  await expect(dialog).toHaveCount(0);
  expect(f.writes).toHaveLength(2);
  expect(f.writes[0]!.body.operationKey).toBeTruthy();
  expect(f.writes[0]!.body.operationKey).toBe(f.writes[1]!.body.operationKey);
  const row = page
    .getByRole('row')
    .filter({ has: page.getByRole('link', { name: 'Research workspace', exact: true }) });
  await expect(row).toContainText('Cleanup pending');
  await expect(row.getByRole('link', { name: 'Open terminal Research workspace' })).toHaveCount(0);
});

test('the table fits a phone and supports keyboard access to offscreen columns', async ({
  page,
}) => {
  await fixture(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/vms');
  const scroll = page.getByRole('region', { name: 'Virtual machines table' });
  await expect(scroll).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await scroll.focus();
  await page.keyboard.press('ArrowRight');
  await expect.poll(() => scroll.evaluate((e) => e.scrollLeft)).toBeGreaterThan(0);
  await page.screenshot({ path: test.info().outputPath('vm-table-mobile.png'), fullPage: true });
});

test('a refresh failure keeps the last visible rows and gives an explicit retry', async ({
  page,
}) => {
  const f = await fixture(page);
  await page.goto('/vms');
  await expect(page.getByRole('table').locator('tbody tr')).toHaveCount(5);
  f.failRefresh();
  await page.getByRole('button', { name: 'Refresh VMs' }).click();
  await expect(page.getByRole('alert')).toContainText('Inventory refresh unavailable.');
  await expect(page.getByRole('table').locator('tbody tr')).toHaveCount(5);
  expect(f.writes).toHaveLength(0);
});

test('empty inventory makes the next step clear without creating a VM', async ({ page }) => {
  const f = await fixture(page, { empty: true });
  await page.goto('/vms');
  await expect(page.getByRole('heading', { name: 'Your first VM starts here' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Create VM', exact: true }).first()).toHaveAttribute(
    'href',
    '/new/vm',
  );
  expect(f.writes).toHaveLength(0);
});
