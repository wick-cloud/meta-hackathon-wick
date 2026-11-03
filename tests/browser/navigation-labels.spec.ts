import { expect, test } from '@playwright/test';

// Every API call is intercepted. These cases only inspect workspace navigation labels.
for (const [path, label, role] of [
  ['/token-orders/new', 'Buy AI tokens', 'buyer'],
  ['/alternatives', 'Alternatives', 'buyer'],
  ['/alternatives/new', 'Alternatives', 'buyer'],
  ['/agreements/new', 'Historical orders', 'buyer'],
  ['/provider/scheduled', 'Historical orders', 'provider'],
  ['/provider/requests', 'Requests', 'provider'],
] as const) {
  test(`${path} uses its own workspace label`, async ({ page }) => {
    const writes: string[] = [];
    await page.route('**/api/**', async (route) => {
      const request = route.request();
      if (request.method() !== 'GET') writes.push(request.url());
      if (new URL(request.url()).pathname === '/api/me') {
        return route.fulfill({
          json: {
            user: {
              id: 'fixture-user',
              name: 'Fixture user',
              email: 'fixture@example.invalid',
              role,
            },
            modes: { wick: 'fixture', muse: 'fixture' },
            catalog: [],
          },
        });
      }
      return route.fulfill({ status: 503, json: { error: 'Fixture data unavailable.' } });
    });
    await page.goto(path);
    await expect(page.locator('.topbar-location strong')).toHaveText(label);
    expect(writes).toEqual([]);
  });
}
