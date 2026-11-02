import { expect, test } from './table-review';

const inventories = [
  { page: '/orders', endpoint: '/api/orders', empty: 'No orders in this view' },
  { page: '/vms', endpoint: '/api/vm-inventory', empty: 'Your first VM starts here' },
  { page: '/tokens', endpoint: '/api/inference/packs', empty: 'No token batches on this page' },
  { page: '/agents', endpoint: '/api/inference/agents', empty: 'Your first agent starts here' },
  { page: '/keys', endpoint: '/api/keys', empty: 'Connect your first client' },
  { page: '/studio', endpoint: '/api/studio/tasks', empty: 'Your first task starts with a brief.' },
  { page: '/studio/legacy', endpoint: '/api/coding/jobs', empty: 'Your next fix starts here.' },
];

for (const inventory of inventories) {
  test(`${inventory.page} distinguishes an unavailable list from an empty one and retries read-only`, async ({
    page,
  }) => {
    let available = false;
    const writes: string[] = [];
    await page.route('**/api/**', async (route) => {
      const path = new URL(route.request().url()).pathname;
      if (route.request().method() !== 'GET') writes.push(path);
      if (path === inventory.endpoint) {
        return available
          ? route.fulfill({ json: { items: [], serverNow: new Date().toISOString() } })
          : route.fulfill({ status: 503, json: { error: 'Inventory temporarily unavailable.' } });
      }
      const supporting: Record<string, unknown> = {
        '/api/me': {
          user: {
            id: 'buyer-fixture',
            name: 'Fixture buyer',
            role: 'buyer',
            email: 'fixture@invalid.test',
          },
          modes: { wick: 'fixture', muse: 'fixture' },
          catalog: [],
        },
        '/api/credits': {
          availableCents: 1000,
          balanceCents: 1000,
          reservedCents: 0,
          currency: 'USD',
        },
        '/api/inference/models': { enabled: true, mode: 'fixture', models: [], routes: [] },
        '/api/studio/options': { mode: 'fixture', available: true, reason: '' },
        '/api/coding/options': {
          mode: 'fixture',
          executionAvailable: true,
          requirements: '',
          vms: [],
          grants: [],
        },
      };
      return route.fulfill({ json: supporting[path] ?? { items: [] } });
    });
    await page.goto(inventory.page);
    const error = page.locator('.data-table-panel').getByRole('alert');
    await expect(error).toContainText('Inventory temporarily unavailable.');
    await expect(page.getByRole('heading', { name: inventory.empty, exact: true })).toHaveCount(0);
    await expect(page.locator('.data-table-count')).toHaveCount(0);
    available = true;
    await error.getByRole('button', { name: 'Try again', exact: true }).click();
    await expect(page.getByRole('heading', { name: inventory.empty, exact: true })).toBeVisible();
    await expect(page.locator('.data-table-count')).toContainText('0 ');
    await expect(page.locator('.data-table-panel').getByRole('alert')).toHaveCount(0);
    expect(writes).toEqual([]);
  });
}
