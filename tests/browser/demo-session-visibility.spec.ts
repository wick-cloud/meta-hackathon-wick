import { expect, test, type Page } from '@playwright/test';
import type { DemoState } from '../../src/shared/demo';

// These browser checks mock every API; they never start a real demo or allocate resources.
async function blockedSession(page: Page, reason: string, cooldownSeconds?: number) {
  let current: DemoState = {
    enabled: true,
    available: false,
    reason,
    mode: 'real',
    serverTime: new Date().toISOString(),
    cooldownUntil:
      cooldownSeconds === undefined
        ? null
        : new Date(Date.now() + cooldownSeconds * 1000).toISOString(),
    limits: {
      durationMinutes: 15,
      cooldownMinutes: 20,
      maxRequests: 2,
      maxOutputTokens: 1024,
      inputTokens: 5000,
      outputTokens: 2048,
    },
    run: null,
  };
  const writes: string[] = [];
  await page.route('**/api/**', (route) => {
    const request = route.request();
    if (request.method() !== 'GET') {
      writes.push(new URL(request.url()).pathname);
      return route.fulfill({ status: 500, json: { error: 'Unexpected demo mutation.' } });
    }
    if (new URL(request.url()).pathname === '/api/me')
      return route.fulfill({
        json: { user: null, modes: { wick: 'real', muse: 'real' }, catalog: [] },
      });
    if (new URL(request.url()).pathname === '/api/demo')
      return route.fulfill({ json: { ...current, serverTime: new Date().toISOString() } });
    return route.fulfill({ status: 404, json: { error: 'Unexpected fixture request.' } });
  });
  return {
    writes,
    release: () => {
      current = { ...current, available: true, reason: null, cooldownUntil: null };
    },
  };
}

test('a network cooldown explains the missing session and never starts a demo when it expires', async ({
  page,
}) => {
  const fixture = await blockedSession(page, 'Your next demo is available after the cooldown.', 3);
  await page.goto('/demos');
  const availability = page.locator('.demo-availability');
  await expect(availability).toContainText(
    'Another browser session on this network used the demo allowance.',
  );
  await expect(availability).toContainText(/Next demo in \d\d:\d\d/);
  await expect(page.getByRole('button', { name: 'Try live demo', exact: true })).toBeDisabled();
  await expect(page.locator('#live-demo')).toHaveCount(0);
  fixture.release();
  await expect(availability).toContainText('Ready when you are');
  await expect(page.getByRole('button', { name: 'Try live demo', exact: true })).toBeEnabled();
  expect(fixture.writes).toEqual([]);
});

test('a legacy active network session points visitors to the original browser', async ({
  page,
}) => {
  const fixture = await blockedSession(
    page,
    'A demo is already active for this browser or connection.',
  );
  await page.goto('/demos');
  await expect(page.locator('.demo-availability')).toHaveText(
    'A demo is active in another browser session on this network. Open the browser or profile where it was started to view it.',
  );
  await expect(page.locator('#live-demo')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Try live demo', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Check demo status', exact: true }).click();
  expect(fixture.writes).toEqual([]);
});

test('the network allowance reason is preserved with session recovery guidance', async ({
  page,
}) => {
  const reason =
    'This network has used its demo allowance. Please try again after a demo ends or cools down.';
  const fixture = await blockedSession(page, reason);
  await page.goto('/demos');
  await expect(page.locator('.demo-availability')).toHaveText(
    `${reason} If you started a demo, open its original browser or profile to view it.`,
  );
  await expect(page.locator('#live-demo')).toHaveCount(0);
  expect(fixture.writes).toEqual([]);
});
