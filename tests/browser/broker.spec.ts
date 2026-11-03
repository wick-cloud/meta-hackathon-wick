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
  await page.goto('/login');
  await page.getByLabel('Email', { exact: true }).fill(email);
  await page.getByLabel('Password', { exact: true }).fill(password);
  const signedIn = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === '/api/auth/sign-in/email' &&
      response.request().method() === 'POST',
  );
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  expect(
    (await signedIn).status(),
    'Fixture UI sign-in must succeed before checking the session',
  ).toBe(200);
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
  await expect(page.getByRole('link', { name: 'Sign in', exact: true })).toBeVisible();
  expect((await page.request.get('/api/vms')).status()).toBe(401);
  expect((await page.request.get('/api/provider/dashboard')).status()).toBe(401);
  expect((await page.request.get('/api/provider/earnings')).status()).toBe(401);
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
  expect((await page.request.get('/api/provider/earnings')).status()).toBe(403);

  await page.goto('/new/vm');
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
    expect(charged[0].feeCents).toBe(0);
    expect(charged[0].revenueShare.commissionBps).toBe(1500);
    expect(charged[0].revenueShare.grossCents).toBe(charged[0].totalCents);
    expect(BigInt(charged[0].revenueShare.brokerFeeMicros) * 100n).toBe(
      BigInt(charged[0].totalCents) * 10000n * 15n,
    );
    await page.goto('/invoices');
    await expect(page.getByText('No payment due', { exact: false }).first()).toBeVisible();
  } finally {
    if (vmId) {
      await page.request.post(`/api/vms/${vmId}/terminate`);
      await expect
        .poll(
          async () =>
            (await (await page.request.get(`/api/vms/${vmId}`)).json()).cleanupConfirmedAt,
          { timeout: 30000, intervals: [500, 1000, 2000] },
        )
        .toBeTruthy();
      await page.goto(`/vms/${vmId}`);
      await expect(page.getByText('Terminated', { exact: true })).toBeVisible();
      await expect(
        page.getByText('Waiting for Wick to confirm environment cleanup.', { exact: true }),
      ).toHaveCount(0);
    } else await page.request.post(`/api/requests/${requestId}/cancel`);
  }
});

test('provider reviews exact commission and historical earnings without buyer access', async ({
  page,
}) => {
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
  const me = await (await page.request.get('/api/me')).json();
  test.skip(me.modes.wick !== 'fixture' || me.modes.muse !== 'fixture', 'Isolated fixture only.');
  await page.goto('/provider/policy');
  await page.getByLabel('Base total price (USD)').fill('0.03');
  const breakdown = page.locator('[aria-label="Rental revenue breakdown"]');
  await expect(breakdown.getByText('$0.0045', { exact: true })).toBeVisible();
  await expect(breakdown.getByText('$0.0255', { exact: true })).toBeVisible();
  await expect(breakdown.getByText(/before compute costs/)).toBeVisible();
  // No policy is saved. These response fixtures exercise historic and paginated
  // presentation; the negotiated-rental case checks the real earnings API below.
  const common = {
    vmId: 'fixture-vm',
    catalogName: 'Fixture environment',
    currency: 'USD',
    status: 'demo',
    label: 'No payment due',
  };
  await page.route('**/api/provider/earnings*', (route) => {
    const more = new URL(route.request().url()).searchParams.has('cursor');
    return route.fulfill({
      json: more
        ? {
            items: [
              {
                ...common,
                id: 'tiny-two',
                createdAt: '2026-10-26T00:00:00Z',
                totalCents: 1,
                legacy: false,
                revenueShare: {
                  commissionBps: 1500,
                  grossCents: 1,
                  brokerFeeMicros: '1500',
                  providerNetMicros: '8500',
                },
              },
            ],
          }
        : {
            items: [
              {
                ...common,
                id: 'tiny-one',
                createdAt: '2026-10-28T00:00:00Z',
                totalCents: 3,
                legacy: false,
                revenueShare: {
                  commissionBps: 1500,
                  grossCents: 3,
                  brokerFeeMicros: '4500',
                  providerNetMicros: '25500',
                },
              },
              {
                ...common,
                id: 'legacy-one',
                createdAt: '2026-10-27T00:00:00Z',
                totalCents: 100,
                legacy: true,
              },
            ],
            nextCursor: 'fixture-next-page',
          },
    });
  });
  await page.getByRole('link', { name: 'Earnings', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Earnings', exact: true })).toBeVisible();
  const legacy = page.locator('[data-invoice-id="legacy-one"]');
  await expect(legacy.getByText('Not assessed', { exact: true })).toHaveCount(2);
  await expect(legacy.getByText('Historical · unchanged')).toBeVisible();
  await expect(
    page.locator('[data-invoice-id="tiny-one"]').getByText('$0.0045', { exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Load more', exact: true }).click();
  await expect(page.locator('[data-invoice-id="tiny-two"]')).toBeVisible();
  await expect(page.locator('.stats-grid').getByText('$0.04', { exact: true })).toBeVisible();
  await expect(page.locator('.stats-grid').getByText('$0.006', { exact: true })).toBeVisible();
  await expect(page.locator('.stats-grid').getByText('$0.034', { exact: true })).toBeVisible();
  await expect(page.getByText('Demo earnings · no payouts', { exact: true })).toBeVisible();
});

test('buyer Muse fixture prepares an editable review with an honest receipt', async ({ page }) => {
  test.skip(!buyerPassword, 'Set SEED_BUYER_PASSWORD to exercise actual seeded auth.');
  await signIn(page, buyerEmail, buyerPassword!);
  const me = await (await page.request.get('/api/me')).json();
  test.skip(me.modes.muse !== 'fixture', 'Browser tests do not call paid Muse.');
  await page.goto('/new/vm');
  await page
    .getByLabel('Describe your environment')
    .fill('A Linux environment with 2 vCPUs and 4 GB memory for 30 minutes.');
  await page.getByRole('button', { name: 'Prepare with Muse' }).click();
  await expect(page).toHaveURL(/\/requests\/review$/);
  await expect(page.getByRole('button', { name: '30 minutes', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(page.getByLabel('Minimum vCPUs')).toHaveValue('2');
  await expect(page.getByLabel('Minimum memory (GiB)')).toHaveValue('4');
  await page.getByText('How Muse prepared this request', { exact: true }).click();
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
    await page.getByLabel('Automatic bids and counteroffers', { exact: false }).uncheck();
    const changedPrice = original.policy.basePriceCents + 5;
    await page.getByLabel('Base total price (USD)').fill((changedPrice / 100).toFixed(2));
    // Apply commits, but the first response is lost: the UI must retry the same
    // reviewed operation even after the dashboard sees its new policy revision.
    let appliedBody: unknown;
    await page.route(
      '**/api/provider/policy',
      async (route) => {
        appliedBody = route.request().postDataJSON();
        expect((await route.fetch()).ok()).toBe(true);
        await route.abort('failed');
      },
      { times: 1 },
    );
    await page.getByRole('button', { name: 'Save policy', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Retry same apply', exact: true })).toBeEnabled();
    await expect(page.getByLabel('Base total price (USD)')).toBeDisabled();
    const afterApply = await (await page.request.get('/api/provider/dashboard')).json();
    const replay = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === '/api/provider/policy' &&
        response.request().method() === 'PUT',
    );
    await page.getByRole('button', { name: 'Retry same apply', exact: true }).click();
    const replayResponse = await replay;
    expect(replayResponse.ok()).toBe(true);
    expect(replayResponse.request().postDataJSON()).toEqual(appliedBody);
    await expect(page.getByText('Policy saved', { exact: true })).toBeVisible();
    const replayedDashboard = await (await page.request.get('/api/provider/dashboard')).json();
    expect(replayedDashboard.policyRevision).toBe(afterApply.policyRevision);
    // A preceding rental can finish cleanup between these reads. Replay must
    // preserve policy events, not freeze unrelated background lifecycle events.
    const policyEvents = (activity: { kind: string }[]) =>
      activity.filter((event) => event.kind === 'policy_changed');
    expect(policyEvents(afterApply.activity).length).toBeGreaterThan(0);
    expect(policyEvents(replayedDashboard.activity)).toEqual(policyEvents(afterApply.activity));
    const policy = replayedDashboard.policy;
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
    const offeringRow = page
      .getByRole('table', { name: 'Instant offerings', exact: true })
      .getByRole('row')
      .filter({ has: page.getByText(name, { exact: true }) });
    await expect(offeringRow).toBeVisible();
    await offeringRow.getByRole('button', { name: 'Manage offering', exact: true }).click();
    await expect(page.getByRole('heading', { name, exact: true })).toBeVisible();
  } finally {
    await page.request.put('/api/provider/capacity', { data: { total: original.capacity.total } });
    const currentPolicy = await (await page.request.get('/api/provider/dashboard')).json();
    await page.request.put('/api/provider/policy', {
      data: {
        ...original.policy,
        expectedRevision: currentPolicy.policyRevision,
        operationKey: crypto.randomUUID(),
      },
    });
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
  expect((await page.request.get('/api/provider/earnings')).status()).toBe(403);
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
