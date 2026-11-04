import { expect, test, type Page } from '@playwright/test';

/** Fail on backend traffic, including on entry/exit; never stub a session to make the demo work. */
async function guardLocalDemo(page: Page) {
  const requests: string[] = [];
  const sockets: string[] = [];
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('**/api/**', (route) => {
    requests.push(`${route.request().method()} ${new URL(route.request().url()).pathname}`);
    return route.abort();
  });
  await page.routeWebSocket('**', (socket) => {
    const url = new URL(socket.url());
    // The frontend dev server's HMR socket is the only permitted WebSocket.
    if (url.host === '127.0.0.1:4317' && url.pathname === '/' && url.searchParams.has('token'))
      socket.connectToServer();
    else {
      sockets.push(socket.url());
      socket.close();
    }
  });
  return () => {
    expect(requests, 'local demo must never request a backend API').toEqual([]);
    expect(sockets, 'local terminal must never connect to a server').toEqual([]);
    expect(errors, 'local navigation must not crash').toEqual([]);
  };
}

async function expectChooser(page: Page) {
  await expect(
    page.getByRole('heading', { name: 'Explore Wick Broker', exact: true }),
  ).toBeVisible();
  await expect(page.getByRole('link', { name: 'Explore as a buyer', exact: true })).toHaveAttribute(
    'href',
    '/demo/buyer',
  );
  await expect(
    page.getByRole('link', { name: 'Explore as a seller', exact: true }),
  ).toHaveAttribute('href', '/demo/seller');
  await expect(
    page.getByRole('link', { name: 'Try the hosted live demo', exact: true }),
  ).toHaveAttribute('href', 'https://meta-hackathon-wick-production.up.railway.app/demos');
}

test('entry, legacy demo links and unsupported destinations stay backend-free', async ({
  page,
}) => {
  const assertLocal = await guardLocalDemo(page);
  await page.clock.install();
  for (const path of ['/', '/demos', '/demos/', '/login?intent=buy', '/orders', '/missing-page']) {
    await page.goto(path);
    await expectChooser(page);
    await page.clock.runFor(31_000);
  }
  await page.goto('/#live-demo');
  await expectChooser(page);
  await page.reload();
  await expectChooser(page);
  assertLocal();
});

for (const width of [1440, 390, 320]) {
  test(`chooser and both workspace exits work at ${width}px without auth requests`, async ({
    page,
  }, info) => {
    const assertLocal = await guardLocalDemo(page);
    await page.setViewportSize({ width, height: 960 });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto('/');
    await expectChooser(page);
    await expect(page.getByText(/sample data/i).first()).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.screenshot({ path: info.outputPath(`local-chooser-${width}.png`), fullPage: true });
    for (const role of ['buyer', 'seller'] as const) {
      const entry = page.getByRole('link', { name: `Explore as a ${role}`, exact: true });
      await entry.focus();
      await page.keyboard.press('Enter');
      await expect(page).toHaveURL(new RegExp(`/demo/${role}$`));
      await expect(page.locator('.main-content h1')).toHaveText(
        role === 'buyer' ? 'Orders' : 'Capacity',
      );
      await page.getByRole('link', { name: 'Exit demo', exact: true }).click();
      await expect(page).toHaveURL(/\/demos$/);
      await expectChooser(page);
      await page.reload();
      await expectChooser(page);
    }
    await page.clock.install();
    await page.clock.runFor(31_000);
    assertLocal();
  });
}

test('local home, deep links, refresh and browser history retain the demo boundary', async ({
  page,
}) => {
  const assertLocal = await guardLocalDemo(page);
  await page.goto('/demo/buyer/disks');
  await expect(page.locator('.main-content h1')).toHaveText('Disks');
  await page.reload();
  await expect(page.locator('.main-content h1')).toHaveText('Disks');
  await page.getByRole('link', { name: 'Seller', exact: true }).click();
  await expect(page.locator('.main-content h1')).toHaveText('Capacity');
  await page
    .getByRole('navigation', { name: 'Main navigation', exact: true })
    .getByRole('link', { name: 'Policy', exact: true })
    .click();
  await expect(page).toHaveURL(/\/demo\/seller\/provider\/policy$/);
  await page.reload();
  await expect(page.locator('.main-content h1')).toHaveText('Pricing & policy');
  await page.getByRole('link', { name: 'Exit demo', exact: true }).click();
  await expectChooser(page);
  await page.goBack();
  await expect(page.locator('.main-content h1')).toHaveText('Pricing & policy');
  await page.goForward();
  await expectChooser(page);
  await page.getByRole('link', { name: 'Explore as a buyer', exact: true }).click();
  await page.locator('.sidebar .broker-brand').click();
  await expectChooser(page);
  assertLocal();
});
