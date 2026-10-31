import { expect, test, type Page } from './table-review';
import type { TokenPack } from '../../src/shared/inference';

// Every API call is intercepted; this suite never creates a real key or consumes paid tokens.
const now = new Date('2026-10-30T20:00:00.000Z');
const a = '11111111-1111-4111-8111-111111111111',
  b = '22222222-2222-4222-8222-222222222222';
const grantId = '33333333-3333-4333-8333-333333333333';
const keyId = '44444444-4444-4444-8444-444444444444';
const secret = `wbk_${keyId}.${'x'.repeat(43)}`;
function pack(id: string, changes: Partial<TokenPack> = {}): TokenPack {
  return {
    id,
    orderId: id,
    grantId,
    provider: 'modal',
    mode: 'fixture',
    modelId: 'meta/muse-spark-open',
    status: 'active',
    inputTokens: 1048600,
    outputTokens: 512,
    availableInputTokens: 1048470,
    availableOutputTokens: 400,
    heldInputTokens: 100,
    heldOutputTokens: 64,
    consumedInputTokens: 30,
    consumedOutputTokens: 48,
    retiredInputTokens: 0,
    retiredOutputTokens: 0,
    priceCents: 173.31,
    refundCents: 0,
    expiresAt: new Date(+now + 7200000).toISOString(),
    createdAt: now.toISOString(),
    retirementReason: null,
    revenueShare: {
      commissionBps: 1500,
      grossCents: 173.31,
      brokerFeeMicros: '259965',
      providerNetMicros: '1473135',
    },
    ...changes,
  };
}
async function fixture(
  page: Page,
  options: { failOnce?: boolean; expiresIn?: number; paged?: boolean } = {},
) {
  const first = pack(a, {
      ...(options.expiresIn ? { expiresAt: new Date(+now + options.expiresIn).toISOString() } : {}),
    }),
    second = pack(b, { provider: 'baseten', createdAt: new Date(+now - 1000).toISOString() });
  const writes: { path: string; body: any }[] = [],
    reads: string[] = [];
  await page.clock.install({ time: new Date(+now - 1000) });
  await page.clock.pauseAt(now);
  await page.route('**/api/**', async (route) => {
    const r = route.request(),
      url = new URL(r.url()),
      path = url.pathname;
    if (r.method() !== 'GET') writes.push({ path, body: r.postDataJSON() });
    else reads.push(url.pathname + url.search);
    if (path === '/api/me')
      return route.fulfill({
        json: {
          user: {
            id: 'fixture-buyer',
            name: 'Fixture buyer',
            email: 'buyer@fixture.invalid',
            role: 'buyer',
          },
          modes: { wick: 'fixture', muse: 'fixture' },
          catalog: [],
        },
      });
    if (path === '/api/inference/packs') {
      const view = url.searchParams.get('view') ?? 'all';
      const active = (p: TokenPack) =>
        p.status !== 'settled' || p.heldInputTokens > 0 || p.heldOutputTokens > 0;
      const items = [first, second].filter(
        (p) => view === 'all' || (view === 'archive' ? !active(p) : active(p)),
      );
      return route.fulfill({
        json: {
          items: options.paged
            ? url.searchParams.has('cursor')
              ? items.slice(1)
              : items.slice(0, 1)
            : items,
          ...(options.paged && items.length > 1 && !url.searchParams.has('cursor')
            ? { nextCursor: 'older' }
            : {}),
        },
      });
    }
    if (path === `/api/inference/packs/${a}` || path === `/api/inference/packs/${b}`)
      return route.fulfill({ json: path.endsWith(a) ? first : second });
    if (path === `/api/inference/packs/${a}/keys`) {
      if (options.failOnce && writes.length === 1) return route.abort('failed');
      return route.fulfill({
        json: {
          key: {
            id: keyId,
            grantId,
            packId: a,
            name: 'Batch key',
            prefix: `wbk_${keyId}`,
            scopes: ['account:read', 'inference:read', 'inference:use'],
            limits: {},
            createdAt: now.toISOString(),
            expiresAt: first.expiresAt,
            lastUsedAt: null,
            revokedAt: null,
          },
          token: secret,
          connection: {
            packId: a,
            baseUrl: 'https://broker.example/api/v1',
            model: first.modelId,
            expiresAt: first.expiresAt,
          },
        },
      });
    }
    return route.fulfill({ status: 404, json: { error: 'No such fixture resource' } });
  });
  return { first, second, writes, reads };
}

test('purchased batches show separate input/output availability, pending usage, four-decimal prices and live expiry', async ({
  page,
}) => {
  const f = await fixture(page);
  await page.goto('/tokens');
  await expect(page.getByRole('heading', { name: 'Purchased tokens', exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Purchased tokens', exact: true })).toHaveAttribute(
    'aria-current',
    'page',
  );
  const row = page.getByRole('row').filter({ hasText: '#11111111' });
  await expect(row).toContainText('1,048,470');
  await expect(row).toContainText('400');
  await expect(row).toContainText('100 pending');
  await expect(row).toContainText('64 pending');
  await expect(row).toContainText('$1.7331');
  await expect(row).toContainText('2h 0m left');
  await expect(row.getByRole('link', { name: 'View purchase' })).toHaveAttribute(
    'href',
    `/token-orders/${a}`,
  );
  await page.clock.fastForward(61000);
  await expect(row).toContainText('1h 58m left');
  expect(f.writes).toHaveLength(0);
  expect(f.reads.filter((path) => path.startsWith('/api/inference/packs/'))).toHaveLength(0);
  expect(
    await page
      .locator('.token-inventory-scroll')
      .evaluate((el) => el.scrollWidth <= el.clientWidth),
  ).toBe(true);
  await page.screenshot({
    path: test.info().outputPath('purchased-tokens-desktop.png'),
    fullPage: true,
  });
});

test('a batch connection reveals its key once without placing that secret into setup examples, URLs or storage', async ({
  page,
}) => {
  const f = await fixture(page);
  await page.goto(`/tokens?connect=${a}`);
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('heading', { name: 'Connect this token batch' })).toBeVisible();
  expect(f.writes).toHaveLength(0);
  await dialog.getByRole('button', { name: 'Create or replace batch key' }).click();
  await expect(dialog.getByLabel('New batch API key')).toHaveValue(secret);
  await expect(dialog.getByLabel('New batch API key')).toHaveAttribute('type', 'password');
  await expect(dialog.getByLabel('OpenAI-compatible base URL')).toHaveValue(
    'https://broker.example/api/v1',
  );
  await expect(dialog.getByRole('link', { name: 'Open your VMs' })).toHaveAttribute('href', '/vms');
  const code = await dialog.locator('pre').innerText();
  expect(code).toContain('OPENAI_API_KEY="<your batch key>"');
  expect(code).toContain('Idempotency-Key: $BROKER_OPERATION_KEY');
  expect(code).not.toContain(secret);
  expect(page.url()).not.toContain(secret);
  expect(await page.evaluate(() => JSON.stringify([localStorage, sessionStorage]))).not.toContain(
    secret,
  );
  expect(f.writes).toHaveLength(1);
  expect(f.writes[0].body.operationKey).toBeTruthy();
  await dialog.getByRole('button', { name: 'Close connection details' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByLabel('New batch API key')).toHaveCount(0);
  await expect(page).toHaveURL(/\/tokens$/);
});

test('expiry removes usable availability immediately without disguising held quota as available', async ({
  page,
}) => {
  await fixture(page, { expiresIn: 30000 });
  await page.goto('/tokens');
  const row = page.getByRole('row').filter({ hasText: '#11111111' });
  await expect(row).toContainText('30s left');
  await page.clock.fastForward(31000);
  await expect(row).toContainText('Expired');
  await expect(row.getByRole('button', { name: 'Connect', exact: true })).toBeDisabled();
  expect(await row.locator('.token-inventory-quota > strong').allTextContents()).toEqual([
    '0',
    '0',
  ]);
  await expect(row).toContainText('100 pending');
  await expect(row).toContainText('1,048,470 retired');
});

test('older pages have URL-backed navigation and refresh only their visible page', async ({
  page,
}) => {
  const f = await fixture(page, { paged: true });
  await page.goto('/tokens');
  await page.getByRole('link', { name: 'Older purchases' }).click();
  await expect(page).toHaveURL(/\/tokens\?cursor=older$/);
  await expect(page.getByRole('row').filter({ hasText: '#22222222' })).toBeVisible();
  const before = f.reads.length;
  f.second.availableOutputTokens = 300;
  f.second.consumedOutputTokens = 148;
  await page.clock.runFor(5000);
  await expect(page.getByRole('row').filter({ hasText: '#22222222' })).toContainText('300');
  expect(f.reads.slice(before)).toEqual(['/api/inference/packs?limit=25&cursor=older']);
  await page.goBack();
  await expect(page).toHaveURL(/\/tokens$/);
  await expect(page.getByRole('row').filter({ hasText: '#11111111' })).toBeVisible();
});

test('an uncertain key response does not retry or rotate until the owner explicitly requests a replacement', async ({
  page,
}) => {
  const f = await fixture(page, { failOnce: true });
  await page.goto(`/tokens?connect=${a}`);
  await page.getByRole('button', { name: 'Create or replace batch key' }).click();
  await expect(page.getByText(/No automatic retry was made/)).toBeVisible();
  expect(f.writes).toHaveLength(1);
  await page.getByRole('button', { name: 'Create replacement key', exact: true }).click();
  await expect(page.getByLabel('New batch API key')).toHaveValue(secret);
  expect(f.writes).toHaveLength(2);
  expect(f.writes[0].body.operationKey).not.toBe(f.writes[1].body.operationKey);
});

test('Archive preserves closed batch receipts and pagination while unresolved quota remains active', async ({
  page,
}) => {
  const f = await fixture(page, { paged: true });
  for (const p of [f.first, f.second]) {
    Object.assign(p, {
      status: 'settled',
      heldInputTokens: 0,
      heldOutputTokens: 0,
      availableInputTokens: 0,
      availableOutputTokens: 0,
      retirementReason: 'expired',
      expiresAt: new Date(+now - 1000).toISOString(),
      refundCents: 0.12,
    });
  }
  await page.goto('/tokens?cursor=older');
  await page.getByRole('button', { name: 'Archive', exact: true }).click();
  await expect(page).toHaveURL(/view=archive/);
  expect(new URL(page.url()).searchParams.has('cursor')).toBe(false);
  await expect(page.getByRole('row').filter({ hasText: '#11111111' })).toContainText('$1.7331');
  await expect(page.getByRole('row').filter({ hasText: '#11111111' })).toContainText(
    '$0.0012 refunded',
  );
  await expect(page.getByRole('link', { name: 'View purchase' })).toHaveAttribute(
    'href',
    `/token-orders/${a}`,
  );
  await page.getByRole('link', { name: 'Older purchases' }).click();
  await expect(page).toHaveURL(/view=archive.*cursor=older/);
  await page.reload();
  await expect(page.getByRole('row').filter({ hasText: '#22222222' })).toBeVisible();
  await page.getByRole('link', { name: 'Newest purchases' }).click();
  await expect(page).toHaveURL(/view=archive$/);
  Object.assign(f.first, { status: 'retiring', heldInputTokens: 100, heldOutputTokens: 64 });
  await page.getByRole('button', { name: 'Active', exact: true }).click();
  await expect(page.getByRole('row').filter({ hasText: '#11111111' })).toContainText(
    'Usage pending',
  );
  await expect(page.getByRole('row').filter({ hasText: '#11111111' })).toContainText('100 pending');
  await expect(page.getByRole('row').filter({ hasText: '#22222222' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Archive', exact: true }).click();
  await expect(page.getByRole('row').filter({ hasText: '#22222222' })).toBeVisible();
  expect(f.writes).toHaveLength(0);
});

test('the inventory scrolls within its table on mobile and connection links remain keyboard accessible', async ({
  page,
}) => {
  await fixture(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/tokens');
  await expect(page.getByRole('heading', { name: 'Purchased tokens', exact: true })).toBeVisible();
  await page.clock.runFor(100);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  const connect = page.getByRole('link', { name: 'Connect Modal batch 11111111' });
  await connect.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { name: 'Connect this token batch' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await page.screenshot({
    path: test.info().outputPath('batch-connection-mobile.png'),
    fullPage: true,
  });
});

test('large pack totals stay readable beside their connection action', async ({ page }) => {
  const f = await fixture(page);
  f.first.priceCents = 99999999.99;
  await page.setViewportSize({ width: 1024, height: 900 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/tokens');
  await page
    .getByRole('button', { name: 'Purchased token batches: scroll right', exact: true })
    .click();
  const row = page.getByRole('row').filter({ hasText: '#11111111' });
  await expect(row).toContainText('$999,999.9999');
  const total = await row.locator('td.numeric-cell').last().boundingBox();
  const action = await row.locator('td.actions-cell').boundingBox();
  expect(total!.x + total!.width).toBeLessThanOrEqual(action!.x + 1);
  expect(f.writes).toHaveLength(0);
});
