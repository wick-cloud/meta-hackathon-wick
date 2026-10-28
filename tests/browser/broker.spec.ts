import { expect, test, type Page } from '@playwright/test';

const buyerEmail = process.env.E2E_BUYER_EMAIL ?? process.env.SEED_BUYER_EMAIL ?? 'buyer@demo.wick.local';
const buyerPassword = process.env.SEED_BUYER_PASSWORD;
const providerEmail = process.env.E2E_PROVIDER_EMAIL ?? process.env.SEED_SUPPLIER_A_EMAIL ?? 'supplier-a@demo.wick.local';
const providerPassword = process.env.SEED_SUPPLIER_A_PASSWORD;

async function signIn(page: Page, email: string, password: string) {
  await page.goto('/');
  await page.getByLabel('Email', { exact: true }).fill(email);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect.poll(async () => {
    const response = await page.request.get('/api/me');
    return response.ok() ? (await response.json()).user?.email : null;
  }).toBe(email);
}

test('anonymous visitors cannot read customer environments or provider policy', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeVisible();
  expect((await page.request.get('/api/vms')).status()).toBe(401);
  expect((await page.request.get('/api/provider/dashboard')).status()).toBe(401);
});

test('buyer manually reviews an immutable request, receives a VM and one demo invoice', async ({ page }) => {
  test.skip(!buyerPassword, 'Set SEED_BUYER_PASSWORD to exercise actual seeded auth.');
  await signIn(page, buyerEmail, buyerPassword!);
  const me = await (await page.request.get('/api/me')).json();
  test.skip(me.modes.wick !== 'fixture' || me.modes.muse !== 'fixture', 'Browser tests never allocate real Wick compute or call paid Muse.');
  expect((await page.request.get('/api/provider/dashboard')).status()).toBe(403);

  await page.goto('/new');
  await page.getByLabel('Describe your environment').fill('A small Linux environment for an interactive command line.');
  await page.getByRole('button', { name: 'Review manually', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Start 30-second auction', exact: true })).toBeVisible();
  await page.getByLabel('Maximum total price (USD)').fill('10.00');
  await page.getByRole('button', { name: 'Start 30-second auction', exact: true }).click();
  await page.waitForURL(/\/requests\/[^/]+$/);
  const requestId = new URL(page.url()).pathname.split('/').at(-1)!;
  let vmId: string | undefined;
  try {
    const created = await (await page.request.get(`/api/requests/${requestId}`)).json();
    expect(created.request.description).toBe('A small Linux environment for an interactive command line.');
    expect(created.request.maxPriceCents).toBe(1000);
    expect([15, 30, 60]).toContain(created.request.durationMinutes);
    expect(new Date(created.request.closesAt).getTime()).toBeGreaterThan(Date.now());

    await expect.poll(async () => {
      const detail = await (await page.request.get(`/api/requests/${requestId}`)).json();
      vmId = detail.vm?.id;
      return detail.vm?.status;
    }, { timeout: 60_000, intervals: [500, 1000, 2000] }).toBe('running');

    await page.getByRole('link', { name: 'Open environment', exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/vms/${vmId}$`));
    await expect(page.getByRole('button', { name: 'Connect terminal', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Connect terminal', exact: true }).click();
    await expect(page.locator('.xterm')).toBeVisible();

    const vm = await (await page.request.get(`/api/vms/${vmId}`)).json();
    expect(vm.expiresAt).toBeTruthy();
    const expiry = vm.expiresAt;
    await page.reload();
    const reconnectedVm = await (await page.request.get(`/api/vms/${vmId}`)).json();
    expect(reconnectedVm.expiresAt).toBe(expiry);

    const invoices = await (await page.request.get('/api/invoices')).json();
    const charged = invoices.items.filter((invoice: { vmId: string }) => invoice.vmId === vmId);
    expect(charged).toHaveLength(1);
    await page.goto('/invoices');
    await expect(page.getByText('No payment due', { exact: false }).first()).toBeVisible();
  } finally {
    if (vmId) await page.request.post(`/api/vms/${vmId}/terminate`);
    else await page.request.post(`/api/requests/${requestId}/cancel`);
  }
});

test('provider sees simulated supply and cannot use buyer endpoints', async ({ page }) => {
  test.skip(!providerPassword, 'Set SEED_SUPPLIER_A_PASSWORD to exercise actual seeded provider auth.');
  await signIn(page, providerEmail, providerPassword!);
  expect((await page.request.get('/api/vms')).status()).toBe(403);
  const dashboard = await page.request.get('/api/provider/dashboard');
  expect(dashboard.ok()).toBe(true);
  await expect(page.getByRole('link', { name: 'Capacity', exact: true })).toBeVisible();
  await page.getByRole('link', { name: 'Capacity', exact: true }).click();
  await expect(page.getByText(/simulated demo supply/i).first()).toBeVisible();
});
