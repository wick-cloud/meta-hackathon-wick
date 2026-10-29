import { expect, test, type Page } from '@playwright/test';
import { defaultScopes, type BrokerKeySummary } from '../../src/shared/developer';

// Every API request is intercepted. This suite cannot create real credentials or VMs.
const id = '22222222-2222-4222-8222-222222222222';
const token = `wbk_${id}.${'x'.repeat(43)}`;
async function fixture(page: Page, role: 'buyer' | 'provider') {
  const keys: BrokerKeySummary[] = [];
  const writes: { method: string; body: any }[] = [];
  await page.route('**/api/**', async (route) => {
    const request = route.request(),
      path = new URL(request.url()).pathname,
      method = request.method();
    if (path === '/api/me')
      return route.fulfill({
        json: {
          user: {
            id: 'fixture-user',
            name: 'Fixture user',
            email: `${role}@fixture.invalid`,
            role,
          },
          modes: { wick: 'fixture', muse: 'fixture' },
          catalog: [],
        },
      });
    if (path === '/api/keys' && method === 'GET') return route.fulfill({ json: { items: keys } });
    if (path === '/api/keys' && method === 'POST') {
      const body = request.postDataJSON();
      writes.push({ method, body });
      const key: BrokerKeySummary = {
        id,
        name: body.name,
        prefix: `wbk_${id}`,
        scopes: body.scopes,
        limits: body.limits,
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 30 * 86400000).toISOString(),
        lastUsedAt: null,
        revokedAt: null,
      };
      keys.push(key);
      return route.fulfill({ json: { key, token } });
    }
    if (path === `/api/keys/${id}` && method === 'DELETE') {
      writes.push({ method, body: request.postDataJSON() });
      keys[0].revokedAt = new Date().toISOString();
      return route.fulfill({ json: { key: keys[0] } });
    }
    return route.fulfill({
      status: 500,
      json: { error: `Unexpected fixture API ${method} ${path}` },
    });
  });
  return { keys, writes };
}
for (const role of ['buyer', 'provider'] as const)
  test(`${role} can create a read-only Broker key once and revoke it`, async ({ page }) => {
    const { writes } = await fixture(page, role);
    await page.goto('/keys');
    await expect(page.getByRole('heading', { name: 'API keys', exact: true })).toBeVisible();
    await expect(page.getByText('Broker keys are separate from Wick keys.')).toBeVisible();
    await page.getByRole('button', { name: 'Create key', exact: true }).first().click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByRole('checkbox', { name: 'Read account identity' })).toBeChecked();
    await expect(dialog.getByRole('checkbox', { name: 'Read account identity' })).toBeDisabled();
    await expect(dialog.getByText('Per-operation limits', { exact: true })).toHaveCount(0);
    await dialog.getByLabel('Name', { exact: true }).fill('Fixture client');
    await dialog.getByRole('button', { name: 'Create key', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Save your key', exact: true })).toBeVisible();
    await expect(page.getByLabel('New Broker API key')).toHaveValue(token);
    expect(writes[0].body.scopes).toEqual(defaultScopes(role));
    expect(writes[0].body.limits).toEqual({});
    await page.getByRole('button', { name: 'I’ve saved the key' }).click();
    await expect(page.getByLabel('New Broker API key')).toHaveCount(0);
    await expect(page.getByText(token, { exact: true })).toHaveCount(0);
    await expect(page.getByRole('cell', { name: 'Fixture client' })).toBeVisible();
    await page.getByRole('button', { name: 'Revoke', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Revoke Fixture client?' })).toBeVisible();
    await page.getByRole('dialog').getByRole('button', { name: 'Revoke key', exact: true }).click();
    await expect(page.getByRole('cell', { name: 'Revoked', exact: true })).toBeVisible();
    expect(writes).toHaveLength(2);
  });
test('buyer write permissions reveal required per-operation limits without enabling writes by default', async ({
  page,
}) => {
  await fixture(page, 'buyer');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/keys');
  await page.getByRole('button', { name: 'Create key', exact: true }).first().click();
  const dialog = page.getByRole('dialog');
  await expect(
    dialog.getByRole('checkbox', { name: /Create, cancel and retry orders/ }),
  ).not.toBeChecked();
  await dialog.getByRole('checkbox', { name: /Create, cancel and retry orders/ }).check();
  await expect(dialog.getByLabel('Maximum order budget · USD')).toBeVisible();
  await expect(dialog.getByLabel('Maximum order budget · USD')).toHaveAttribute('required', '');
  await expect(
    dialog.getByText(
      'These limits apply to each operation. Multiple operations can exceed these amounts in total.',
    ),
  ).toBeVisible();
  await expect(page.locator('body')).toHaveJSProperty('scrollWidth', 390);
});

test('key setup gives copyable direct downloads and contains mobile overflow', async ({ page }) => {
  await fixture(page, 'buyer');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/keys');
  const install = await page.locator('.key-setup > pre').innerText();
  expect(install.split('\n')).toHaveLength(4);
  expect(install).not.toContain('\\n');
  expect(install).toContain('/downloads/0.1.0/wick-cloud-broker-sdk-0.1.0.tgz');
  expect(install).toContain('/downloads/0.1.0/wick-cloud-broker-cli-0.1.0.tgz');
  expect(install).toContain('/downloads/0.1.0/wick-cloud-broker-mcp-0.1.0.tgz');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
});
