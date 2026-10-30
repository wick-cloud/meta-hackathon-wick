import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test, type Browser, type Page } from '@playwright/test';

// Actual app, browser sessions, queue and Postgres. No intercepted requests or clock edits.
test.skip(!process.env.RUN_INFERENCE_E2E, 'Opt in against an isolated loopback fixture app.');
test.use({ trace: 'off', screenshot: 'off' });

async function signedIn(browser: Browser, baseURL: string, email: string, password: string) {
  const context = await browser.newContext({ baseURL, viewport: { width: 1440, height: 1050 } });
  const page = await context.newPage();
  const result = await page.request.post('/api/auth/sign-in/email', { data: { email, password } });
  expect(result.ok()).toBe(true);
  return { context, page };
}
async function picture(page: Page, name: string) {
  if (!process.env.E2E_UI_SCREENSHOT_DIR) return;
  await mkdir(process.env.E2E_UI_SCREENSHOT_DIR, { recursive: true });
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({
    path: join(process.env.E2E_UI_SCREENSHOT_DIR, `${name}.png`),
    fullPage: true,
  });
}
test('owner funds agent → saved 30-second token auction → prepaid inference → supplier commitments', async ({
  browser,
  baseURL,
}) => {
  test.setTimeout(120000);
  expect(['localhost', '127.0.0.1']).toContain(new URL(baseURL!).hostname);
  const buyer = await signedIn(
    browser,
    baseURL!,
    process.env.SEED_BUYER_EMAIL ?? 'buyer@demo.wick.local',
    process.env.SEED_BUYER_PASSWORD!,
  );
  const admin = await signedIn(
    browser,
    baseURL!,
    process.env.SEED_ADMIN_EMAIL ?? 'admin@demo.wick.local',
    process.env.SEED_ADMIN_PASSWORD!,
  );
  const suppliers: Awaited<ReturnType<typeof signedIn>>[] = [];
  let grantId: string | undefined, keyId: string | undefined;
  try {
    const me = await (await buyer.page.request.get('/api/me')).json();
    expect(me.modes).toEqual({ wick: 'fixture', muse: 'fixture' });
    const catalog = await (await buyer.page.request.get('/api/inference/models')).json();
    expect(catalog).toMatchObject({ enabled: true, mode: 'fixture' });
    const credit = await admin.page.request.post('/api/admin/credits', {
      data: {
        buyerId: me.user.id,
        amountCents: 2000,
        operationKey: randomUUID(),
        description: 'Disposable inference browser test',
      },
    });
    expect(credit.ok()).toBe(true);
    const page = buyer.page;
    await page.goto('/agents');
    await page.getByRole('button', { name: 'Create agent', exact: true }).first().click();
    const name = `Browser task ${randomUUID().slice(0, 8)}`;
    await page.getByLabel('Agent name').fill(name);
    await page.getByLabel('Initial budget').fill('10');
    await page.getByRole('button', { name: 'Reserve $10.00 and create' }).click();
    await expect(page.getByRole('heading', { name, exact: true })).toBeVisible();
    grantId = new URL(page.url()).pathname.split('/').at(-1)!;
    await picture(page, 'agent-real-postgres-desktop');
    await page.getByRole('link', { name: 'Connection', exact: true }).click();
    await page.getByRole('button', { name: 'Create or replace API key', exact: true }).click();
    const keyResponse = page.waitForResponse(
      (r) =>
        r.url().endsWith(`/api/inference/grants/${grantId}/keys`) &&
        r.request().method() === 'POST',
    );
    await page.getByRole('button', { name: 'Issue replacement key' }).click();
    const key = await (await keyResponse).json();
    keyId = key.key.id;
    await expect(page.getByLabel('New agent API key')).toHaveValue(key.token);
    await page.getByRole('button', { name: 'I’ve saved the key' }).click();
    expect(await page.evaluate(() => JSON.stringify([localStorage, sessionStorage]))).not.toContain(
      key.token,
    );
    await page.goto(`/token-orders/new?grantId=${grantId}`);
    await page.getByLabel('Input tokens', { exact: true }).fill('10000');
    await page.getByLabel('Output tokens', { exact: true }).fill('2000');
    await page.getByLabel('Maximum total price').fill('1');
    await page.getByRole('checkbox', { name: /I understand/ }).check();
    await page.getByRole('button', { name: 'Start 30-second auction' }).click();
    await expect(page).toHaveURL(/\/token-orders\/[a-f0-9-]+$/);
    const orderUrl = new URL(page.url()).pathname;
    const initial = await (await page.request.get(`/api${orderUrl}`)).json();
    expect(initial.bids).toHaveLength(2);
    expect(initial.order.status).toBe('open');
    await picture(page, 'token-auction-real-postgres');
    await page.goto('/orders?kind=token');
    await expect(page.locator(`a[href="${orderUrl}"]`).first()).toBeVisible();
    await page.reload();
    // Stay in Orders: the table must observe the auction award without manual refresh.
    await expect(
      page
        .locator('tr')
        .filter({ has: page.locator(`a[href="${orderUrl}"]`).first() })
        .getByText('Pack purchased', { exact: true }),
    ).toBeVisible({ timeout: 45000 });
    await page.locator(`a[href="${orderUrl}"]`).first().click();
    await expect
      .poll(async () => (await (await page.request.get(`/api${orderUrl}`)).json()).order.status, {
        timeout: 45000,
        intervals: [1000],
      })
      .toBe('awarded');
    await page.reload();
    await expect(page.getByRole('heading', { name: 'Purchased quota' })).toBeVisible();
    const completion = await page.request.post('/api/v1/chat/completions', {
      headers: { authorization: `Bearer ${key.token}`, 'Idempotency-Key': randomUUID() },
      data: {
        model: 'meta/muse-spark-open',
        messages: [{ role: 'user', content: 'Browser fixture token proof' }],
        max_tokens: 64,
      },
    });
    expect(completion.ok()).toBe(true);
    const result = await completion.json();
    expect(result.broker.mode).toBe('fixture');
    await page.goto(`/agents/${grantId}?tab=activity`);
    await expect(page.getByText(result.id.slice(0, 12), { exact: false })).toBeVisible();
    await picture(page, 'agent-consumed-real-postgres');
    await page.setViewportSize({ width: 390, height: 844 });
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1),
    ).toBe(true);
    await picture(page, 'agent-real-postgres-mobile');
    let verifiedSupplier = false;
    for (const role of ['A', 'B', 'C']) {
      const email =
        process.env[`SEED_SUPPLIER_${role}_EMAIL`] ??
        `supplier-${role.toLowerCase()}@demo.wick.local`;
      const supplier = await signedIn(
        browser,
        baseURL!,
        email,
        process.env[`SEED_SUPPLIER_${role}_PASSWORD`]!,
      );
      suppliers.push(supplier);
      const offering = await (
        await supplier.page.request.get('/api/provider/inference/offering')
      ).json();
      if (offering.offering?.provider !== result.broker.provider) continue;
      await supplier.page.goto('/provider/inference?tab=commitments');
      await expect(
        supplier.page.getByRole('heading', { name: 'AI capacity', exact: true }),
      ).toBeVisible();
      await expect(
        supplier.page.getByRole('cell', { name: result.broker.packId.slice(0, 12), exact: false }),
      ).toBeVisible();
      await picture(supplier.page, 'provider-token-commitments-real-postgres');
      verifiedSupplier = true;
      break;
    }
    expect(verifiedSupplier).toBe(true);
  } finally {
    if (grantId)
      expect(
        (
          await buyer.page.request.post(`/api/inference/grants/${grantId}/close`, {
            headers: { origin: baseURL! },
            data: { operationKey: randomUUID() },
          })
        ).ok(),
      ).toBe(true);
    if (keyId)
      expect(
        (
          await buyer.page.request.delete(`/api/keys/${keyId}`, { headers: { origin: baseURL! } })
        ).ok(),
      ).toBe(true);
    await Promise.all(
      [buyer.context, admin.context, ...suppliers.map((s) => s.context)].map((c) => c.close()),
    );
  }
});
