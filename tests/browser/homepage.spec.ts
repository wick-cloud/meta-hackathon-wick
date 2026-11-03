import { expect, test, type Page, type TestInfo } from '@playwright/test';

type Role = 'buyer' | 'provider' | 'admin';
async function marketplace(page: Page, options: { signedIn?: Role; signInAs?: Role } = {}) {
  let role = options.signedIn;
  const requests: { path: string; method: string; body: unknown }[] = [];
  await page.route('**/api/**', async (route) => {
    const request = route.request(),
      path = new URL(request.url()).pathname;
    requests.push({ path, method: request.method(), body: request.postDataJSON() });
    if (path === '/api/auth/sign-in/email') {
      role = options.signInAs ?? 'buyer';
      return route.fulfill({ json: { token: 'browser-fixture-only' } });
    }
    if (path === '/api/me')
      return route.fulfill({
        json: {
          user: role
            ? { id: `preview-${role}`, name: 'Alex Morgan', email: 'alex@fixture.invalid', role }
            : null,
          modes: { wick: 'fixture', muse: 'fixture' },
          catalog: [],
        },
      });
    if (path === '/api/demo')
      return route.fulfill({
        json: {
          enabled: false,
          available: false,
          reason: 'Live demo is currently unavailable.',
          mode: 'fixture',
          serverTime: new Date().toISOString(),
          cooldownUntil: null,
          limits: {
            durationMinutes: 15,
            cooldownMinutes: 20,
            maxRequests: 2,
            maxOutputTokens: 1024,
            inputTokens: 5000,
            outputTokens: 2048,
          },
          run: null,
        },
      });
    if (path === '/api/orders')
      return route.fulfill({ json: { items: [], serverNow: new Date().toISOString() } });
    if (path === '/api/vm-inventory')
      return route.fulfill({
        json: { items: [], nextCursor: null, serverNow: new Date().toISOString() },
      });
    if (path === '/api/provider/dashboard')
      return route.fulfill({
        json: {
          provider: { id: 'provider-preview', name: 'Preview provider', simulated: true },
          capacity: { total: 5, held: 0, available: 5 },
          policy: {
            reserveSlots: 0,
            autoBid: false,
            minimumPriceCents: 5,
            basePriceCents: 10,
            allowedCatalogIds: [],
          },
          policyRevision: 1,
          activity: [],
        },
      });
    // Redirect tests do not need admin configuration or any external service.
    return route.fulfill({
      status: 503,
      json: { error: 'Not loaded in this presentation fixture.' },
    });
  });
  return requests;
}

async function review(page: Page, info: TestInfo, name: string) {
  if (process.env.HOME_REVIEW !== '1') return;
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: info.outputPath(`${name}.png`), fullPage: true });
  await page.screenshot({ path: info.outputPath(`${name}-viewport.png`) });
}

test('marketing home explains the platform without demo polling or private reads and writes', async ({
  page,
}) => {
  const requests = await marketplace(page);
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(
    'Compute and AI. On your terms.',
  );
  await expect(page.getByRole('heading', { name: 'Virtual machines', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'AI token packs', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'For buyers', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'For sellers', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Scheduled capacity', exact: true })).toHaveCount(
    0,
  );
  await expect(page.getByText('Wick compute', { exact: true })).toBeVisible();
  await expect(page.getByText('Meta Muse tokens', { exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Explore live demos', exact: true })).toHaveAttribute(
    'href',
    '/demos',
  );
  await expect(
    page.getByRole('link', { name: 'Join buyer beta (opens in a new tab)', exact: true }),
  ).toHaveAttribute('href', 'https://app.wick-cloud.com/waitlist');
  await expect(page.getByRole('button', { name: 'Try live demo' })).toHaveCount(0);
  await expect(
    page.getByRole('link', { name: 'Buy resources', exact: true }).first(),
  ).toHaveAttribute('href', '/login?intent=buy');
  await expect(
    page.getByRole('link', { name: 'Sell capacity', exact: true }).first(),
  ).toHaveAttribute('href', '/login?intent=sell');
  await expect(page.getByRole('link', { name: 'Sign in', exact: true })).toHaveAttribute(
    'href',
    '/login',
  );
  expect(requests.length).toBeGreaterThan(0);
  expect(requests.every((request) => request.method === 'GET' && request.path === '/api/me')).toBe(
    true,
  );
});

for (const intent of ['buy', 'sell'] as const) {
  test(`${intent} entry leads to contextual invite-only sign-in without changing account role`, async ({
    page,
  }) => {
    const requests = await marketplace(page, {
      signInAs: intent === 'sell' ? 'buyer' : 'provider',
    });
    await page.goto('/');
    await page
      .getByRole('link', {
        name: intent === 'sell' ? 'Sell capacity' : 'Buy resources',
        exact: true,
      })
      .first()
      .click();
    await expect(page).toHaveURL(new RegExp(`/login\\?intent=${intent}$`));
    await expect(
      page.getByRole('heading', {
        name: intent === 'sell' ? 'Sign in to sell capacity.' : 'Sign in to buy resources.',
      }),
    ).toBeVisible();
    await expect(
      page.getByText('Invite-only access. Ask your administrator for an account.'),
    ).toBeVisible();
    expect(requests.filter((request) => request.method !== 'GET')).toHaveLength(0);
    await page.getByLabel('Email', { exact: true }).fill('alex@fixture.invalid');
    await page.getByLabel('Password', { exact: true }).fill('fixture-password');
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect(page).toHaveURL(intent === 'sell' ? /\/orders$/ : /\/provider\/capacity$/);
    const writes = requests.filter((request) => request.method !== 'GET');
    expect(writes).toHaveLength(1);
    expect(writes[0]).toEqual({
      path: '/api/auth/sign-in/email',
      method: 'POST',
      body: { email: 'alex@fixture.invalid', password: 'fixture-password' },
    });
  });
}

for (const [role, destination] of [
  ['buyer', '/orders'],
  ['provider', '/provider/capacity'],
  ['admin', '/admin'],
] as const) {
  test(`signed-in ${role} retains the existing home destination`, async ({ page }) => {
    await marketplace(page, { signedIn: role });
    await page.goto('/');
    await expect(page).toHaveURL(new RegExp(`${destination}$`));
    await expect(
      page.getByRole('heading', {
        name: 'Compute and AI. On your terms.',
      }),
    ).toHaveCount(0);
  });
}

test('an anonymous protected deep link stays intact through sign-in', async ({ page }) => {
  const requests = await marketplace(page, { signInAs: 'buyer' });
  await page.goto('/vms?view=active');
  await expect(page.getByRole('heading', { name: 'Welcome back.' })).toBeVisible();
  expect(requests.every((request) => request.path === '/api/me')).toBe(true);
  await page.getByLabel('Email', { exact: true }).fill('alex@fixture.invalid');
  await page.getByLabel('Password', { exact: true }).fill('fixture-password');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page).toHaveURL(/\/vms\?view=active$/);
  await expect(page.getByRole('heading', { name: 'Virtual machines', exact: true })).toBeVisible();
});

test('the demos page is public for signed-in visitors without a workspace sidebar', async ({
  page,
}) => {
  const requests = await marketplace(page, { signedIn: 'buyer' });
  await page.goto('/demos');
  await expect(page).toHaveURL(/\/demos$/);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(
    'Meet the market. Then put it to work.',
  );
  await expect(page.getByRole('button', { name: 'Start Muse Studio demo' })).toBeDisabled();
  await expect(
    page.getByText(
      'A guided Hello World task with visible source and execution results. Then explore the files in your terminal. No API key to copy.',
    ),
  ).toBeVisible();
  await expect(page.locator('.app-shell')).toHaveCount(0);
  expect(
    requests.every(
      (request) => request.method === 'GET' && ['/api/me', '/api/demo'].includes(request.path),
    ),
  ).toBe(true);
});

for (const width of [1440, 1280, 390, 320]) {
  test(`marketplace and sign-in fit ${width}px with keyboard-accessible controls`, async ({
    page,
  }, info) => {
    const requests = await marketplace(page);
    await page.setViewportSize({ width, height: 960 });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto('/');
    await expect(page.getByRole('link', { name: 'Explore live demos', exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await review(page, info, `home-${width}`);
    await page.getByRole('link', { name: 'Sell capacity', exact: true }).first().focus();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('heading', { name: 'Sign in to sell capacity.' })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await review(page, info, `login-${width}`);
    await page.getByRole('link', { name: 'Back to marketplace' }).click();
    await expect(page).toHaveURL(/\/$/);
    expect(requests.filter((request) => request.method !== 'GET')).toHaveLength(0);
  });
}
