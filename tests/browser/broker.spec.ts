import { expect, test, type Page } from '@playwright/test';

const buyerEmail =
  process.env.E2E_BUYER_EMAIL ?? process.env.SEED_BUYER_EMAIL ?? 'buyer@demo.wick.local';
const buyerPassword = process.env.SEED_BUYER_PASSWORD;
const providerEmail =
  process.env.E2E_PROVIDER_EMAIL ??
  process.env.SEED_SUPPLIER_A_EMAIL ??
  'supplier-a@demo.wick.local';
const providerPassword = process.env.SEED_SUPPLIER_A_PASSWORD;
const adminEmail = process.env.SEED_ADMIN_EMAIL ?? 'admin@demo.wick.local';
const adminPassword = process.env.SEED_ADMIN_PASSWORD;

async function signIn(page: Page, email: string, password: string) {
  await page.goto('/');
  await page.getByLabel('Email', { exact: true }).fill(email);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect
    .poll(async () => {
      const response = await page.request.get('/api/me');
      return response.ok() ? (await response.json()).user?.email : null;
    })
    .toBe(email);
}

test('anonymous visitors cannot read customer environments or provider policy', async ({
  page,
}) => {
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeVisible();
  expect((await page.request.get('/api/vms')).status()).toBe(401);
  expect((await page.request.get('/api/provider/dashboard')).status()).toBe(401);
});

test('buyer manually reviews an immutable request, receives a VM and one demo invoice', async ({
  page,
}) => {
  test.skip(!buyerPassword, 'Set SEED_BUYER_PASSWORD to exercise actual seeded auth.');
  await signIn(page, buyerEmail, buyerPassword!);
  const me = await (await page.request.get('/api/me')).json();
  test.skip(
    me.modes.wick !== 'fixture' || me.modes.muse !== 'fixture',
    'Browser tests never allocate real Wick compute or call paid Muse.',
  );
  expect((await page.request.get('/api/provider/dashboard')).status()).toBe(403);

  await page.goto('/new');
  await page
    .getByLabel('Describe your environment')
    .fill('A small Linux environment for an interactive command line.');
  await page.getByRole('button', { name: 'Review manually', exact: true }).click();
  await expect(
    page.getByRole('button', { name: 'Start 30-second auction', exact: true }),
  ).toBeVisible();
  await page.getByLabel('Maximum total price (USD)').fill('10.00');
  const submitted = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === '/api/requests' &&
      response.request().method() === 'POST',
  );
  await page.getByRole('button', { name: 'Start 30-second auction', exact: true }).click();
  const submission = await submitted;
  expect(submission.ok()).toBe(true);
  const requestId: string = (await submission.json()).id;
  let vmId: string | undefined;
  try {
    await page.waitForURL(new RegExp(`/requests/${requestId}$`));
    const created = await (await page.request.get(`/api/requests/${requestId}`)).json();
    expect(created.request.description).toBe(
      'A small Linux environment for an interactive command line.',
    );
    expect(created.request.maxPriceCents).toBe(1000);
    expect([15, 30, 60]).toContain(created.request.durationMinutes);
    expect(new Date(created.request.closesAt).getTime()).toBeGreaterThan(Date.now());

    await expect
      .poll(
        async () => {
          const detail = await (await page.request.get(`/api/requests/${requestId}`)).json();
          vmId = detail.vm?.id;
          return detail.vm?.status;
        },
        { timeout: 60_000, intervals: [500, 1000, 2000] },
      )
      .toBe('running');

    await page.getByRole('link', { name: 'Open environment', exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/vms/${vmId}$`));
    await expect(page.getByRole('button', { name: 'Connect terminal', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Connect terminal', exact: true }).click();
    await expect(page.locator('.xterm')).toBeVisible();
    await expect(page.locator('.terminal-status')).toHaveText('Connected');

    const vm = await (await page.request.get(`/api/vms/${vmId}`)).json();
    expect(vm.expiresAt).toBeTruthy();
    const expiry = vm.expiresAt;
    await page.reload();
    await page.getByRole('button', { name: 'Connect terminal', exact: true }).click();
    await expect(page.locator('.terminal-status')).toHaveText('Connected');
    const reconnectedVm = await (await page.request.get(`/api/vms/${vmId}`)).json();
    expect(reconnectedVm.expiresAt).toBe(expiry);
    expect(reconnectedVm.environmentId).toBe(vm.environmentId);

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
  test.skip(
    !providerPassword,
    'Set SEED_SUPPLIER_A_PASSWORD to exercise actual seeded provider auth.',
  );
  await signIn(page, providerEmail, providerPassword!);
  expect((await page.request.get('/api/vms')).status()).toBe(403);
  const dashboard = await page.request.get('/api/provider/dashboard');
  expect(dashboard.ok()).toBe(true);
  await expect(page.getByRole('link', { name: 'Capacity', exact: true })).toBeVisible();
  await page.getByRole('link', { name: 'Capacity', exact: true }).click();
  await expect(page.getByText(/simulated demo supply/i).first()).toBeVisible();
});

test('buyer Muse fixture prepares an editable review with an honest receipt', async ({ page }) => {
  test.skip(!buyerPassword, 'Set SEED_BUYER_PASSWORD to exercise actual seeded auth.');
  await signIn(page, buyerEmail, buyerPassword!);
  const me = await (await page.request.get('/api/me')).json();
  test.skip(me.modes.muse !== 'fixture', 'Browser tests do not call paid Muse.');
  await page.goto('/new');
  await page
    .getByLabel('Describe your environment')
    .fill('A Linux environment with 2 vCPUs and 4 GB memory for 30 minutes.');
  await page.getByRole('button', { name: 'Prepare with Muse' }).click();
  await expect(page).toHaveURL(/\/requests\/review$/);
  await expect(page.getByLabel('Rental duration')).toHaveValue('30');
  await expect(page.getByLabel('Minimum vCPUs')).toHaveValue('2');
  await expect(page.getByLabel('Minimum memory (GiB)')).toHaveValue('4');
  await expect(page.getByText(/no Meta model call was made/i)).toBeVisible();
  await page.getByLabel('Maximum total price (USD)').fill('7.50');
  await expect(page.getByLabel('Maximum total price (USD)')).toHaveValue(/^7\.50?$/);
  await expect(
    page.getByRole('button', { name: 'Start 30-second auction', exact: true }),
  ).toBeEnabled();
});

test('provider saves capacity and policy, then publishes a reviewed offering', async ({ page }) => {
  test.skip(
    !providerPassword,
    'Set SEED_SUPPLIER_A_PASSWORD to exercise actual seeded provider auth.',
  );
  await signIn(page, providerEmail, providerPassword!);
  const me = await (await page.request.get('/api/me')).json();
  test.skip(
    me.modes.wick !== 'fixture' || me.modes.muse !== 'fixture',
    'Provider browser mutations are restricted to the explicit fixture application.',
  );
  const original = await (await page.request.get('/api/provider/dashboard')).json();
  let offeringId: string | undefined;
  try {
    await page.goto('/provider/capacity');
    await page.getByLabel('Total VM slots').fill(String(original.capacity.total + 1));
    await page.getByRole('button', { name: 'Save capacity', exact: true }).click();
    await expect(page.getByText('Capacity updated.', { exact: true })).toBeVisible();
    expect((await (await page.request.get('/api/provider/dashboard')).json()).capacity.total).toBe(
      original.capacity.total + 1,
    );

    await page.goto('/provider/policy');
    await page.getByLabel('Automatic bidding', { exact: false }).uncheck();
    const changedPrice = original.policy.basePriceCents + 5;
    await page.getByLabel('Base total price (USD)').fill((changedPrice / 100).toFixed(2));
    await page.getByRole('button', { name: 'Save policy', exact: true }).click();
    await expect(page.getByText('Policy saved', { exact: true })).toBeVisible();
    const policy = (await (await page.request.get('/api/provider/dashboard')).json()).policy;
    expect(policy.autoBid).toBe(false);
    expect(policy.basePriceCents).toBe(changedPrice);

    await page.goto('/provider/offerings');
    await page.getByRole('button', { name: 'New offering', exact: true }).first().click();
    const name = `Browser verification ${Date.now()}`;
    await page.getByLabel('Offering name').fill(name);
    await page
      .getByLabel('Description', { exact: true })
      .fill('Explicit browser fixture test using an existing approved configuration.');
    await page.getByLabel('Fixed rental price (USD)').fill((changedPrice / 100).toFixed(2));
    const published = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === '/api/provider/offerings' &&
        response.request().method() === 'POST',
    );
    await page.getByRole('button', { name: 'Publish offering', exact: true }).click();
    const response = await published;
    expect(response.ok()).toBe(true);
    offeringId = (await response.json()).id;
    await expect(page.getByRole('heading', { name, exact: true })).toBeVisible();
  } finally {
    await page.request.put('/api/provider/capacity', { data: { total: original.capacity.total } });
    await page.request.put('/api/provider/policy', { data: original.policy });
    if (offeringId)
      await page.request.patch(`/api/provider/offerings/${offeringId}`, {
        data: { active: false },
      });
  }
});

test('admin changes catalog approval and concurrent limit with server role enforcement', async ({
  page,
}) => {
  test.skip(!adminPassword, 'Set SEED_ADMIN_PASSWORD to exercise actual seeded admin auth.');
  await signIn(page, adminEmail, adminPassword!);
  const original = await (await page.request.get('/api/admin/config')).json();
  test.skip(
    original.modes.wick !== 'fixture' || original.modes.muse !== 'fixture',
    'Admin browser mutations are restricted to the explicit fixture application.',
  );
  expect((await page.request.get('/api/provider/dashboard')).status()).toBe(403);
  expect((await page.request.get('/api/vms')).status()).toBe(403);
  const catalog = original.catalog.find((item: { approved: boolean }) => item.approved);
  expect(catalog).toBeTruthy();
  try {
    await page.goto('/admin');
    const row = page.getByRole('row').filter({ hasText: catalog.name });
    await row.getByRole('button', { name: 'Approved', exact: true }).click();
    await expect(row.getByRole('button', { name: 'Approve', exact: true })).toBeVisible();
    const configuration = await (await page.request.get('/api/admin/config')).json();
    expect(
      configuration.catalog.find((item: { id: string }) => item.id === catalog.id).approved,
    ).toBe(false);
    await row.getByRole('button', { name: 'Approve', exact: true }).click();
    await expect(row.getByRole('button', { name: 'Approved', exact: true })).toBeVisible();
    await page.getByLabel('Maximum concurrent VMs').fill('3');
    await page.getByRole('button', { name: 'Save limit', exact: true }).click();
    await expect(page.getByText('Customer VM limit updated.', { exact: true })).toBeVisible();
    expect((await (await page.request.get('/api/admin/config')).json()).maxConcurrentVms).toBe(3);
  } finally {
    await page.request.put(`/api/admin/catalog/${encodeURIComponent(catalog.id)}`, {
      data: { approved: catalog.approved },
    });
    await page.request.put('/api/admin/config', {
      data: { maxConcurrentVms: original.maxConcurrentVms },
    });
  }
});
