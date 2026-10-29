import { expect, test, type Browser, type Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

// Explicitly opted-in, localhost-only, actual auth + PostgreSQL + fixture adapters.
// No intercepted requests, reseeding, database clock edits or real provider allocations.
test.skip(
  !process.env.RUN_FUNDED_AGREEMENT_E2E,
  'Opt in against an isolated local fixture preview.',
);
test.use({ trace: 'off', screenshot: 'off' });
const roles = {
  buyer: [process.env.SEED_BUYER_EMAIL ?? 'buyer@demo.wick.local', process.env.SEED_BUYER_PASSWORD],
  provider: [
    process.env.SEED_SUPPLIER_A_EMAIL ?? 'supplier-a@demo.wick.local',
    process.env.SEED_SUPPLIER_A_PASSWORD,
  ],
  admin: [process.env.SEED_ADMIN_EMAIL ?? 'admin@demo.wick.local', process.env.SEED_ADMIN_PASSWORD],
} as const;
async function signIn(browser: Browser, role: keyof typeof roles, baseURL: string) {
  const context = await browser.newContext({ baseURL, viewport: { width: 1500, height: 1100 } }),
    page = await context.newPage();
  await page.goto('/');
  page.setDefaultTimeout(12000);
  const before = await (await page.request.get('/api/me')).json();
  expect(before.modes).toEqual({ wick: 'fixture', muse: 'fixture' });
  expect(roles[role][1], `Provide seeded ${role} credentials privately`).toBeTruthy();
  await page.getByLabel('Email', { exact: true }).fill(roles[role][0]);
  await page.getByLabel('Password', { exact: true }).fill(roles[role][1]!);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect
    .poll(async () => (await (await page.request.get('/api/me')).json()).user?.role)
    .toBe(role === 'provider' ? 'provider' : role);
  const me = await (await page.request.get('/api/me')).json();
  expect(me.modes).toEqual({ wick: 'fixture', muse: 'fixture' });
  return { context, page, me };
}
async function screenshot(page: Page, name: string) {
  if (!process.env.E2E_UI_SCREENSHOT_DIR) return;
  await expect(page.locator('.main-content h1')).toBeVisible();
  await expect(page.locator('.spinner-line')).toHaveCount(0);
  await page.evaluate(() => document.fonts.ready);
  await page.evaluate(() => window.scrollTo(0, 0));
  await mkdir(process.env.E2E_UI_SCREENSHOT_DIR, { recursive: true });
  await page.screenshot({
    path: join(process.env.E2E_UI_SCREENSHOT_DIR, `${name}.png`),
    fullPage: true,
    mask: [page.locator('.account-name'), page.locator('.account-avatar')],
    maskColor: '#edf2e9',
  });
}
async function jsonPost(page: Page, url: string, data: unknown) {
  const response = await page.request.post(url, { data });
  expect(response.ok(), `${url}: ${response.status()} ${await response.text()}`).toBe(true);
  return response.json();
}

test('actual fixture buyer/provider agreement flow, auction history, wallet and manual terminals', async ({
  browser,
  baseURL,
}) => {
  test.setTimeout(300000);
  expect(['127.0.0.1', 'localhost']).toContain(new URL(baseURL!).hostname);
  const buyer = await signIn(browser, 'buyer', baseURL!),
    provider = await signIn(browser, 'provider', baseURL!),
    admin = await signIn(browser, 'admin', baseURL!);
  const ownedVMs = new Set<string>();
  const ownedRequests = new Set<string>();
  let agreementId: string | undefined;
  try {
    const dashboard = await (await provider.page.request.get('/api/provider/dashboard')).json();
    const catalog = provider.me.catalog.find(
      (c: any) =>
        c.approved &&
        (!dashboard.provider.cloudProvider || c.provider === dashboard.provider.cloudProvider) &&
        (!dashboard.policy.allowedCatalogIds || dashboard.policy.allowedCatalogIds.includes(c.id)),
    );
    expect(catalog).toBeTruthy();
    // Capacity and wallet setup is scoped to this isolated, authenticated fixture app.
    expect(
      (await admin.page.request.put('/api/admin/config', { data: { maxConcurrentVms: 20 } })).ok(),
    ).toBe(true);
    expect(
      (await provider.page.request.put('/api/provider/capacity', { data: { total: 12 } })).ok(),
    ).toBe(true);
    await admin.page.goto('/admin');
    await admin.page.getByLabel('Buyer account', { exact: true }).selectOption(buyer.me.user.id);
    await admin.page.getByLabel('Credit amount (USD)', { exact: true }).fill('100.00');
    await admin.page
      .getByLabel('Grant reason', { exact: true })
      .fill('Scheduled agreement fixture demonstration');
    await admin.page.getByRole('button', { name: 'Review credit grant', exact: true }).click();
    await admin.page.getByRole('button', { name: 'Grant Broker credit', exact: true }).click();
    await expect(
      admin.page.getByText('Wick compute credit is unchanged.', { exact: false }),
    ).toBeVisible();

    console.info('Fixture auth and pilot-credit grant complete.');
    await buyer.page.goto('/new');
    await buyer.page
      .getByLabel('Describe your environment')
      .fill('Instant terminal check (fixture)');
    await buyer.page.getByRole('button', { name: 'Review manually', exact: true }).click();
    await buyer.page.getByLabel('Maximum total price (USD)').fill('10.00');
    const submitted = buyer.page.waitForResponse(
      (r) => new URL(r.url()).pathname === '/api/requests' && r.request().method() === 'POST',
    );
    await buyer.page.getByRole('button', { name: 'Start 30-second auction', exact: true }).click();
    const instant = await (await submitted).json();
    ownedRequests.add(instant.id);
    let instantVM: string | undefined;
    await expect
      .poll(
        async () => {
          const d = await (await buyer.page.request.get(`/api/requests/${instant.id}`)).json();
          if (d.vm?.id) {
            instantVM = d.vm.id;
            ownedVMs.add(d.vm.id);
          }
          return d.vm?.status;
        },
        { timeout: 75000, intervals: [1000] },
      )
      .toBe('running');
    console.info('Fixture 30-second instant auction reached running VM.');
    await buyer.page.goto('/orders');
    const instantRow = buyer.page
      .locator('tr')
      .filter({
        has: buyer.page.getByRole('link', {
          name: 'Instant terminal check (fixture)',
          exact: true,
        }),
      })
      .first();
    await expect(instantRow).toContainText('Accepted total price');
    let newAuctions = 0;
    buyer.page.on('request', (r) => {
      if (r.method() === 'POST' && new URL(r.url()).pathname === '/api/requests') newAuctions++;
    });
    await instantRow
      .getByRole('link', { name: 'Instant terminal check (fixture)', exact: true })
      .click();
    await expect(
      buyer.page.getByRole('link', { name: 'Open environment', exact: true }),
    ).toBeVisible();
    expect(newAuctions).toBe(0);
    await jsonPost(buyer.page, `/api/vms/${instantVM}/terminate`, {});
    await expect
      .poll(
        async () =>
          (await (await buyer.page.request.get(`/api/vms/${instantVM}`)).json()).cleanupPending,
        { timeout: 20000 },
      )
      .toBe(false);
    const retry = await jsonPost(buyer.page, '/api/requests', {
      description: 'Editable retry example (fixture)',
      catalogId: catalog.id,
      region: catalog.region,
      durationMinutes: catalog.durationMinutes.includes(15) ? 15 : catalog.durationMinutes[0],
      maxPriceCents: 1000,
      requirements: { cpu: catalog.cpu, memoryGb: catalog.memoryGb },
    });
    ownedRequests.add(retry.id);
    await jsonPost(buyer.page, `/api/requests/${retry.id}/cancel`, {});
    await buyer.page.goto(`/requests/${retry.id}`);
    const beforeRetry = newAuctions;
    await buyer.page.getByRole('link', { name: 'Try again · review first', exact: true }).click();
    await expect(
      buyer.page.getByRole('button', { name: 'Start 30-second auction', exact: true }),
    ).toBeVisible();
    expect(newAuctions).toBe(beforeRetry);

    const previous = (
      await (await buyer.page.request.get('/api/orders?kind=agreement&limit=25')).json()
    ).items.find(
      (o: any) => o.title === 'Nightly development fleet (fixture)' && o.status !== 'expired',
    );
    if (previous) agreementId = previous.id;
    else {
      // Book just ahead, then wait for the actual clock. No retroactive approval or PG edits.
      const starts = new Date(Math.ceil((Date.now() + 60000) / 60000) * 60000);
      const clock = (d: Date) => d.toISOString().slice(11, 16);
      const discount = new Date(starts.getTime() + 10 * 60000),
        ends = new Date(starts.getTime() + 20 * 60000);
      await provider.page.goto('/provider/scheduled');
      await provider.page
        .getByRole('button', { name: 'Publish scheduled offering', exact: true })
        .click();
      await provider.page
        .getByLabel('Offering name', { exact: true })
        .fill('Quiet-hour capacity (fixture)');
      await provider.page
        .getByLabel('Approved provider configuration', { exact: true })
        .selectOption(catalog.id);
      await provider.page.getByLabel('Schedule time zone (IANA)', { exact: true }).fill('UTC');
      await provider.page.getByLabel('Discount opens', { exact: true }).fill(clock(starts));
      await provider.page.getByLabel('Discount ends', { exact: true }).fill(clock(discount));
      await provider.page
        .getByLabel('Actual availability ends', { exact: false })
        .fill(clock(ends));
      await provider.page.getByLabel('Capacity slots', { exact: true }).fill('12');
      await provider.page.getByLabel('Normal rate (USD / VM-hour)', { exact: true }).fill('2.00');
      await provider.page
        .getByLabel('Discounted rate (USD / VM-hour)', { exact: true })
        .fill('1.00');
      await provider.page.getByRole('button', { name: 'Review publication', exact: true }).click();
      await provider.page
        .getByRole('button', { name: 'Publish scheduled offering', exact: true })
        .last()
        .click();
      await expect(
        provider.page.getByText('Scheduled offering published.', { exact: false }),
      ).toBeVisible();
      await screenshot(provider.page, 'provider-scheduled-offering');

      await buyer.page.goto('/agreements/new');
      await buyer.page
        .getByLabel('Agreement name', { exact: true })
        .fill('Nightly development fleet (fixture)');
      await buyer.page
        .getByLabel('Reference resource configuration', { exact: true })
        .selectOption(catalog.id);
      await buyer.page.getByLabel('Target slots per window', { exact: true }).fill('20');
      await buyer.page.getByLabel('Minimum approved per window', { exact: true }).fill('12');
      await buyer.page
        .getByLabel('First local date', { exact: true })
        .fill(starts.toISOString().slice(0, 10));
      await buyer.page.getByLabel('Schedule time zone (IANA)', { exact: true }).fill('UTC');
      await buyer.page.getByLabel('Window opens', { exact: true }).fill(clock(starts));
      await buyer.page.getByLabel('Discount ends', { exact: true }).fill(clock(discount));
      await buyer.page
        .getByLabel('Maximum discounted rate (USD / VM-hour)', { exact: true })
        .fill('1.00');
      await buyer.page.getByLabel('Reserve a normal-rate continuation').check();
      await buyer.page.getByLabel('Hard latest end', { exact: true }).fill(clock(ends));
      await buyer.page
        .getByLabel('Maximum normal rate (USD / VM-hour)', { exact: true })
        .fill('2.00');
      await buyer.page.getByRole('button', { name: 'Review agreement', exact: true }).click();
      await screenshot(buyer.page, 'buyer-agreement-review');
      await buyer.page.getByLabel('I accept the booked-capacity charges', { exact: false }).check();
      const agreementResponse = buyer.page.waitForResponse(
        (r) => new URL(r.url()).pathname === '/api/agreements' && r.request().method() === 'POST',
      );
      await buyer.page
        .getByRole('button', { name: 'Fund & request capacity', exact: true })
        .click();
      const response = await agreementResponse;
      expect(response.ok(), await response.text()).toBe(true);
      agreementId = (await response.json()).agreement.id;
    }
    await expect
      .poll(
        async () =>
          (await (await buyer.page.request.get(`/api/agreements/${agreementId}`)).json()).agreement
            .status,
        { timeout: 15000 },
      )
      .toBe('approved');
    console.info('Fixture seven-window agreement approved; awaiting booked start.');
    const agreed = await (await buyer.page.request.get(`/api/agreements/${agreementId}`)).json();
    expect(agreed.agreement.windows).toHaveLength(7);
    expect(agreed.agreement.windows.every((w: any) => w.approvedQuantity >= 12)).toBe(true);
    if (!previous) expect(agreed.activations).toHaveLength(0);
    expect(agreed.agreement.reservedCents).toBe(agreed.agreement.maxAmountCents);
    expect(agreed.agreement.committedCents).toBeLessThan(agreed.agreement.reservedCents);
    await buyer.page.goto('/orders');
    await expect(
      buyer.page.getByRole('link', { name: 'Nightly development fleet (fixture)', exact: true }),
    ).toBeVisible();
    await screenshot(buyer.page, 'buyer-orders');
    await buyer.page
      .getByRole('link', { name: 'Nightly development fleet (fixture)', exact: true })
      .click();
    await expect(buyer.page).toHaveURL(new RegExp(`/orders/${agreementId}`));
    await expect(
      buyer.page.getByRole('heading', { name: 'Nightly development fleet (fixture)', exact: true }),
    ).toBeVisible();
    await screenshot(buyer.page, 'buyer-approved-agreement');
    await provider.page.goto('/provider/scheduled');
    await provider.page.getByRole('button', { name: 'Capacity calendar', exact: true }).click();
    await expect(
      provider.page.getByText('Nightly development fleet (fixture)', { exact: true }).first(),
    ).toBeVisible();
    await screenshot(provider.page, 'provider-capacity-calendar');

    await expect
      .poll(
        async () => {
          const d = await (await buyer.page.request.get(`/api/agreements/${agreementId}`)).json();
          return d.agreement.windows.some(
            (w: any) =>
              Date.parse(w.startsAt) <= Date.now() &&
              Date.parse(w.endsAt) > Date.now() &&
              w.availableToActivate >= 2,
          );
        },
        { timeout: 135000, intervals: [1000] },
      )
      .toBe(true);
    await buyer.page.reload();
    await buyer.page.getByLabel('VMs to start manually', { exact: true }).fill('2');
    await buyer.page.getByRole('button', { name: 'Review VM starts', exact: true }).click();
    await expect(buyer.page.getByRole('dialog')).toBeVisible();
    await buyer.page.getByRole('button', { name: 'Start VMs', exact: true }).click();
    await expect
      .poll(
        async () => {
          const d = await (await buyer.page.request.get(`/api/agreements/${agreementId}`)).json();
          for (const a of d.activations) if (a.vmId) ownedVMs.add(a.vmId);
          return d.activations.filter((a: any) => a.status === 'running').length;
        },
        { timeout: 30000 },
      )
      .toBe(2);
    console.info('Fixture two manual scheduled VM starts reached running.');
    await buyer.page.reload();
    await screenshot(buyer.page, 'buyer-active-agreement');
    const active = await (await buyer.page.request.get(`/api/agreements/${agreementId}`)).json();
    const vmId = active.activations.find((a: any) => a.status === 'running').vmId;
    await buyer.page.goto(`/vms/${vmId}`);
    await expect(
      buyer.page.getByRole('heading', {
        name: 'Scheduled capacity · separate clocks',
        exact: true,
      }),
    ).toBeVisible();
    await expect(
      buyer.page.getByText('Part of your agreement · no additional VM charge', { exact: true }),
    ).toBeVisible();
    await buyer.page.getByRole('button', { name: 'Connect terminal', exact: true }).click();
    await expect(buyer.page.locator('.terminal-status')).toHaveText('Connected');
    await screenshot(buyer.page, 'buyer-scheduled-terminal');
    await buyer.page.goto('/credits');
    await expect(buyer.page.getByText('Reserved for agreements', { exact: true })).toBeVisible();
    await screenshot(buyer.page, 'buyer-wallet');
  } finally {
    for (const requestId of ownedRequests) {
      const response = await buyer.page.request.get(`/api/requests/${requestId}`);
      if (response.ok()) {
        const d = await response.json();
        if (d.vm?.id) ownedVMs.add(d.vm.id);
        if (d.request?.status === 'open')
          await buyer.page.request.post(`/api/requests/${requestId}/cancel`);
      }
    }
    if (agreementId) {
      const response = await buyer.page.request.get(`/api/agreements/${agreementId}`);
      if (response.ok())
        for (const a of (await response.json()).activations) if (a.vmId) ownedVMs.add(a.vmId);
    }
    for (const vmId of ownedVMs) {
      await buyer.page.request.post(`/api/vms/${vmId}/terminate`);
      await expect
        .poll(
          async () =>
            (await (await buyer.page.request.get(`/api/vms/${vmId}`)).json()).cleanupPending,
          { timeout: 20000 },
        )
        .toBe(false);
    }
    await buyer.context.close();
    await provider.context.close();
    await admin.context.close();
  }
});
