import { expect, test, type Page, type TestInfo } from '@playwright/test';

type Role = 'buyer' | 'seller';
const navigation = {
  buyer: [
    ['Orders', '/orders', 'Orders'],
    ['Muse Studio', '/studio', 'Create a Studio task'],
    ['Virtual machines', '/vms', 'Virtual machines'],
    ['Disks', '/disks', 'Disks'],
    ['Purchased tokens', '/tokens', 'Purchased tokens'],
    ['Agents', '/agents', 'Agents'],
    ['Broker wallet', '/credits', 'Broker wallet'],
    ['Invoices', '/invoices', 'Billing'],
    ['API keys', '/keys', 'API keys'],
  ],
  seller: [
    ['Capacity', '/provider/capacity', 'Capacity'],
    ['Improve my sales', '/provider/sales', 'Improve my sales'],
    ['Policy', '/provider/policy', 'Pricing & policy'],
    ['Requests', '/provider/requests', 'Buyer requests'],
    ['Offerings', '/provider/offerings', 'Instant offerings'],
    ['AI capacity', '/provider/inference', 'AI capacity'],
    ['Earnings', '/provider/earnings', 'Earnings'],
    ['Activity', '/provider/activity', 'Activity'],
    ['API keys', '/keys', 'API keys'],
  ],
} as const;
const walkthroughPaths = {
  buyer: ['/new/vm', '/vms', '/studio?new=1'],
  seller: ['/provider/capacity', '/provider/requests', '/provider/earnings'],
} as const;

function walkthroughStep(page: Page, role: Role, step: number) {
  return page
    .locator('#demo-console-guide')
    .locator(`a[href="/demo/${role}${walkthroughPaths[role][step]}"]`);
}

/** Demo traffic must stay inside its local transport, not be fulfilled by these tests. */
async function guardDemo(page: Page) {
  const requests: string[] = [],
    sockets: string[] = [],
    errors: string[] = [];
  let allowExit = false;
  page.on('pageerror', (error) => errors.push(error.message));
  await page.routeWebSocket('**', (socket) => {
    const url = new URL(socket.url());
    if (url.pathname === '/' && url.searchParams.has('token')) socket.connectToServer();
    else {
      sockets.push(socket.url());
      socket.close();
    }
  });
  await page.route('**/api/**', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    requests.push(`${request.method()} ${path}`);
    if (allowExit && path === '/api/me')
      return route.fulfill({
        json: { user: null, modes: { wick: 'fixture', muse: 'fixture' }, catalog: [] },
      });
    if (allowExit && path === '/api/demo')
      return route.fulfill({
        json: {
          enabled: false,
          available: false,
          reason: 'Live resources disabled in this browser test.',
          mode: 'fixture',
          serverTime: new Date().toISOString(),
          cooldownUntil: null,
          run: null,
          limits: {
            durationMinutes: 15,
            cooldownMinutes: 20,
            maxRequests: 2,
            maxOutputTokens: 1024,
            inputTokens: 5000,
            outputTokens: 2048,
          },
        },
      });
    return route.abort();
  });
  return {
    requests,
    allowExit: () => {
      allowExit = true;
    },
    assertLocal: () => {
      expect(requests).toEqual([]);
      expect(sockets).toEqual([]);
      expect(errors).toEqual([]);
    },
  };
}

async function navigate(page: Page, name: string) {
  const toggle = page.getByRole('button', { name: 'Open navigation', exact: true });
  if (await toggle.isVisible()) await toggle.click();
  await page
    .getByRole('navigation', { name: 'Main navigation', exact: true })
    .getByRole('link', { name, exact: true })
    .click();
}
async function settled(page: Page) {
  await expect(page.locator('.main-content .spinner-line')).toHaveCount(0);
  await expect(page.locator('.main-content .error-box')).toHaveCount(0);
}
async function capture(page: Page, info: TestInfo, name: string) {
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: info.outputPath(`${name}.png`), fullPage: true });
}
async function fits(page: Page) {
  const layout = await page.evaluate(() => ({
    path: location.pathname,
    width: innerWidth,
    scrollWidth: document.documentElement.scrollWidth,
  }));
  expect(layout.scrollWidth, `${layout.path} at ${layout.width}px`).toBeLessThanOrEqual(
    layout.width + 1,
  );
  if (layout.width <= 600) {
    const heading = await page.locator('.main-content h1').boundingBox();
    expect(heading?.width, `${layout.path} heading at ${layout.width}px`).toBeGreaterThanOrEqual(
      140,
    );
  }
}

for (const role of ['buyer', 'seller'] as const) {
  test(`${role} demo renders the regular console shell and every navigation screen without a backend`, async ({
    page,
  }, info) => {
    const guard = await guardDemo(page);
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto(`/demo/${role}`);
    await expect(page.locator('.app-shell')).toBeVisible();
    await expect(page.locator('.sidebar .broker-brand')).toBeVisible();
    await expect(page.locator('.topbar')).toBeVisible();
    await expect(page.locator('.main-content h1')).toHaveText(
      role === 'buyer' ? 'Orders' : 'Capacity',
    );
    await settled(page);
    await capture(page, info, `regular-console-${role}`);
    const menu = page.getByRole('navigation', { name: 'Main navigation', exact: true });
    for (const [label, path, heading] of navigation[role]) {
      await expect(menu.getByRole('link', { name: label, exact: true })).toHaveAttribute(
        'href',
        `/demo/${role}${path}`,
      );
      await navigate(page, label);
      await expect(page).toHaveURL(new RegExp(`/demo/${role}${path}$`));
      await expect(page.locator('.main-content h1')).toHaveText(heading);
      await settled(page);
      await fits(page);
    }
    await page.clock.install();
    await page.clock.runFor(31_000);
    guard.assertLocal();
  });
}

for (const role of ['buyer', 'seller'] as const) {
  test(`${role} walkthrough opens real screens, navigates steps, and can finish and replay`, async ({
    page,
  }, info) => {
    const guard = await guardDemo(page);
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto(`/demo/${role}`);
    const guide = page.locator('#demo-console-guide');
    await expect(guide).toBeVisible();
    await expect(page.getByRole('button', { name: 'Hide guide', exact: true })).toHaveAttribute(
      'aria-expanded',
      'true',
    );
    await expect(page.locator('.main-content h1')).toHaveText(
      role === 'buyer' ? 'Orders' : 'Capacity',
    );
    await expect(guide.getByRole('button', { name: 'Previous step', exact: true })).toBeDisabled();
    await guide.screenshot({ path: info.outputPath(`walkthrough-${role}-step-1-1440.png`) });
    await walkthroughStep(page, role, 0).click();
    await expect(page).toHaveURL(
      new URL(`/demo/${role}${walkthroughPaths[role][0]}`, page.url()).href,
    );
    await guide.getByRole('button', { name: 'Next step', exact: true }).click();
    await expect(page).toHaveURL(
      new URL(`/demo/${role}${walkthroughPaths[role][1]}`, page.url()).href,
    );
    await expect(walkthroughStep(page, role, 1)).toBeVisible();
    await expect(guide.getByRole('heading', { level: 2 })).toBeFocused();
    await guide.screenshot({ path: info.outputPath(`walkthrough-${role}-step-2-1440.png`) });
    await navigate(page, role === 'buyer' ? 'Disks' : 'Policy');
    await expect(walkthroughStep(page, role, 1)).toBeVisible();
    await walkthroughStep(page, role, 1).click();
    await expect(page).toHaveURL(
      new URL(`/demo/${role}${walkthroughPaths[role][1]}`, page.url()).href,
    );
    await guide.getByRole('button', { name: 'Previous step', exact: true }).click();
    await expect(page).toHaveURL(
      new URL(`/demo/${role}${walkthroughPaths[role][0]}`, page.url()).href,
    );
    await expect(walkthroughStep(page, role, 0)).toBeVisible();
    await expect(guide.getByRole('heading', { level: 2 })).toBeFocused();
    await guide.getByRole('button', { name: 'Next step', exact: true }).click();
    await guide.getByRole('button', { name: 'Next step', exact: true }).click();
    await expect(page).toHaveURL(
      new URL(`/demo/${role}${walkthroughPaths[role][2]}`, page.url()).href,
    );
    await guide.screenshot({ path: info.outputPath(`walkthrough-${role}-step-3-1440.png`) });
    await walkthroughStep(page, role, 2).click();
    await settled(page);
    await guide.getByRole('button', { name: 'Finish walkthrough', exact: true }).click();
    await expect(guide.getByRole('heading', { level: 2 })).toHaveText('You’re ready to explore');
    await expect(guide.getByRole('heading', { level: 2 })).toBeFocused();
    await expect(
      guide.getByRole('button', { name: 'Replay walkthrough', exact: true }),
    ).toBeVisible();
    await expect(page).toHaveURL(
      new URL(`/demo/${role}${walkthroughPaths[role][2]}`, page.url()).href,
    );
    await guide.screenshot({ path: info.outputPath(`walkthrough-${role}-complete-1440.png`) });
    await guide.getByRole('button', { name: 'Keep exploring', exact: true }).click();
    await expect(guide).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Show guide', exact: true })).toBeFocused();
    await page.getByRole('button', { name: 'Show guide', exact: true }).click();
    await guide.getByRole('button', { name: 'Replay walkthrough', exact: true }).click();
    await expect(walkthroughStep(page, role, 0)).toBeVisible();
    await expect(guide.getByRole('heading', { level: 2 })).toBeFocused();
    await expect(page).toHaveURL(
      new URL(`/demo/${role}${walkthroughPaths[role][0]}`, page.url()).href,
    );
    await guide.getByRole('button', { name: 'Dismiss walkthrough', exact: true }).click();
    await expect(guide).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Show guide', exact: true })).toBeFocused();
    await page.getByRole('button', { name: 'Show guide', exact: true }).click();
    await expect(walkthroughStep(page, role, 0)).toBeVisible();
    guard.assertLocal();
  });
}

test('walkthrough progress and visibility belong to each role, and reset restores both guides and sample workspaces', async ({
  page,
}) => {
  const guard = await guardDemo(page);
  const guide = page.locator('#demo-console-guide');
  await page.goto('/demo/buyer/disks');
  await page.getByRole('button', { name: 'Create disk', exact: true }).first().click();
  await page
    .getByRole('dialog')
    .getByLabel('Disk name', { exact: true })
    .fill('walkthrough-temporary-disk');
  await page.getByRole('dialog').getByRole('button', { name: 'Create disk', exact: true }).click();
  await expect(page.locator('.main-content')).toContainText('walkthrough-temporary-disk');
  await guide.getByRole('button', { name: 'Next step', exact: true }).click();
  await expect(walkthroughStep(page, 'buyer', 1)).toBeVisible();
  await guide.getByRole('button', { name: 'Dismiss walkthrough', exact: true }).click();
  await page.getByRole('link', { name: 'Seller', exact: true }).click();
  await expect(walkthroughStep(page, 'seller', 0)).toBeVisible();
  const initialCapacity = await page.getByLabel('Total VM slots').inputValue();
  await page.getByLabel('Total VM slots').fill('15');
  await page.getByRole('button', { name: 'Save capacity', exact: true }).click();
  await expect(page.getByText('Capacity updated.', { exact: true })).toBeVisible();
  await guide.getByRole('button', { name: 'Next step', exact: true }).click();
  await guide.getByRole('button', { name: 'Next step', exact: true }).click();
  await guide.getByRole('button', { name: 'Finish walkthrough', exact: true }).click();
  await page.getByRole('link', { name: 'Buyer', exact: true }).click();
  await expect(guide).toHaveCount(0);
  await page.getByRole('button', { name: 'Show guide', exact: true }).click();
  await expect(walkthroughStep(page, 'buyer', 1)).toBeVisible();
  await guide.getByRole('button', { name: 'Next step', exact: true }).click();
  await page.getByRole('link', { name: 'Seller', exact: true }).click();
  await expect(
    guide.getByRole('button', { name: 'Replay walkthrough', exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Reset demo', exact: true }).click();
  await expect(walkthroughStep(page, 'seller', 0)).toBeVisible();
  await walkthroughStep(page, 'seller', 0).click();
  await expect(page.getByLabel('Total VM slots')).toHaveValue(initialCapacity);
  await page.getByRole('link', { name: 'Buyer', exact: true }).click();
  await expect(walkthroughStep(page, 'buyer', 0)).toBeVisible();
  await navigate(page, 'Disks');
  await settled(page);
  await expect(page.locator('.main-content')).not.toContainText('walkthrough-temporary-disk');
  await guide.getByRole('button', { name: 'Next step', exact: true }).click();
  await guide.getByRole('button', { name: 'Dismiss walkthrough', exact: true }).click();
  await page.reload();
  await expect(walkthroughStep(page, 'buyer', 0)).toBeVisible();
  guard.assertLocal();
});

test('buyer follows the regular VM purchase and terminal flow without changing the real draft or connecting a socket', async ({
  page,
}, info) => {
  const guard = await guardDemo(page);
  await page.clock.install();
  await page.addInitScript(() =>
    sessionStorage.setItem('wick-draft', 'existing-real-workspace-draft'),
  );
  await page.goto('/demo/buyer');
  await page.locator('.buyer-new-purchase').click();
  await expect(page).toHaveURL(/\/demo\/buyer\/new$/);
  await page.getByRole('link', { name: 'Configure VM', exact: true }).click();
  await page
    .getByRole('textbox', { name: 'Describe your environment', exact: true })
    .fill(
      'A Linux environment for my local demo build with 2 vCPUs and 4 GB memory for 30 minutes.',
    );
  await page.getByLabel('Your maximum total (USD)', { exact: true }).fill('0.20');
  await page.getByRole('button', { name: 'Review manually', exact: true }).click();
  await expect(page).toHaveURL(/\/demo\/buyer\/requests\/review$/);
  await page.getByLabel('Maximum total price (USD)', { exact: true }).fill('0');
  await expect(
    page.getByRole('button', { name: 'Start 30-second auction', exact: true }),
  ).toBeDisabled();
  await page.getByLabel('Maximum total price (USD)', { exact: true }).fill('0.20');
  await page.getByRole('button', { name: 'Start 30-second auction', exact: true }).click();
  await expect(page).toHaveURL(/\/demo\/buyer\/requests\/(?!review)[^/?]+$/);
  await page.clock.runFor(32_000);
  await settled(page);
  const openTerminal = page
    .getByRole('link', { name: /Open (?:terminal|environment|workspace)/i })
    .first();
  await expect(openTerminal).toBeVisible();
  await openTerminal.click();
  await expect(page).toHaveURL(/\/demo\/buyer\/vms\/[^/?]+$/);
  await settled(page);
  const connect = page.getByRole('button', { name: /Connect terminal|Open terminal|Connect$/i });
  if (await connect.count()) await connect.first().click();
  const terminal = page.locator('.xterm-helper-textarea');
  await expect(terminal).toBeAttached();
  await terminal.pressSequentially('pwd');
  await terminal.press('Enter');
  await expect(page.locator('.xterm-screen')).toContainText('/workspace');
  await capture(page, info, 'regular-console-demo-terminal');
  expect(await page.evaluate(() => sessionStorage.getItem('wick-draft'))).toBe(
    'existing-real-workspace-draft',
  );
  guard.assertLocal();
});

test('buyer can create a disk and a harmless sample key through the regular dialogs', async ({
  page,
}) => {
  const guard = await guardDemo(page);
  await page.goto('/demo/buyer/disks');
  await page.getByRole('button', { name: 'Create disk', exact: true }).first().click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Disk name', { exact: true }).fill('demo-created-workspace');
  await dialog.getByRole('button', { name: 'Create disk', exact: true }).click();
  await expect(page.locator('.main-content')).toContainText('demo-created-workspace');
  await settled(page);
  await navigate(page, 'API keys');
  await page.getByRole('button', { name: 'Create key', exact: true }).first().click();
  await page.getByRole('dialog').getByLabel('Name', { exact: true }).fill('Demo only key');
  await page.getByRole('dialog').getByRole('button', { name: 'Create key', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Save your key', exact: true })).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'New Broker API key', exact: true })).toHaveValue(
    /demo/i,
  );
  guard.assertLocal();
});

test('seller updates capacity and bidding policy, bids on demand, and sees the regular earnings receipt', async ({
  page,
}, info) => {
  const guard = await guardDemo(page);
  await page.goto('/demo/seller');
  await page.getByLabel('Total VM slots').fill('12');
  await page.getByRole('button', { name: 'Save capacity', exact: true }).click();
  await expect(page.getByText('Capacity updated.', { exact: true })).toBeVisible();
  await expect(page.getByLabel('Total VM slots')).toHaveValue('12');
  await navigate(page, 'Policy');
  await page.getByLabel('Slots to keep spare').fill('2');
  await page.getByLabel('Minimum total price (USD)', { exact: true }).fill('0.04');
  await page.getByLabel('Base total price (USD)', { exact: true }).fill('0.1001');
  await page.getByLabel('Maximum total price (USD)', { exact: true }).fill('0.20');
  await page.getByRole('button', { name: 'Save policy', exact: true }).click();
  await settled(page);
  await navigate(page, 'Requests');
  await page.getByRole('button', { name: 'Review bid', exact: true }).first().click();
  await page.getByLabel('Your total bid (USD)', { exact: true }).first().fill('0.1001');
  await page.getByRole('button', { name: 'Submit bid', exact: true }).first().click();
  await expect(
    page.getByText('Your bid is accepted and capacity is reserved.', { exact: true }),
  ).toBeVisible();
  await navigate(page, 'Earnings');
  await settled(page);
  const revenue = page.getByRole('table', { name: 'Rental revenue', exact: true });
  await expect(revenue).toContainText('$0.1001');
  await expect(revenue).toContainText('$0.015');
  await expect(revenue).toContainText('$0.0851');
  await capture(page, info, 'regular-console-demo-earnings');
  guard.assertLocal();
});

test('roles retain their own data, all internal links keep the demo prefix, and reset/reload restore samples', async ({
  page,
}) => {
  const guard = await guardDemo(page);
  await page.goto('/demo/seller/provider/capacity');
  const initialCapacity = await page.getByLabel('Total VM slots').inputValue();
  await page.getByLabel('Total VM slots').fill('15');
  await page.getByRole('button', { name: 'Save capacity', exact: true }).click();
  await expect(page.getByText('Capacity updated.', { exact: true })).toBeVisible();
  await page.getByRole('link', { name: 'Buyer', exact: true }).click();
  await expect(page.locator('.main-content h1')).toHaveText('Orders');
  await page.getByLabel('Order type', { exact: true }).selectOption('token');
  await expect(page).toHaveURL(/\/demo\/buyer\/orders\?.*kind=token/);
  await settled(page);
  const unscoped = await page
    .locator('.main-content a[href^="/"]')
    .evaluateAll((links) =>
      links.map((link) => link.getAttribute('href')).filter((href) => !href?.startsWith('/demo/')),
    );
  expect(unscoped).toEqual([]);
  await page.getByRole('link', { name: 'Seller', exact: true }).click();
  await navigate(page, 'Capacity');
  await expect(page.getByLabel('Total VM slots')).toHaveValue('15');
  await page.getByRole('button', { name: 'Reset demo', exact: true }).click();
  await navigate(page, 'Capacity');
  await expect(page.getByLabel('Total VM slots')).toHaveValue(initialCapacity);
  await page.getByLabel('Total VM slots').fill('16');
  await page.getByRole('button', { name: 'Save capacity', exact: true }).click();
  await expect(page.getByText('Capacity updated.', { exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByLabel('Total VM slots')).toHaveValue(initialCapacity);
  guard.assertLocal();
});

test('mobile console uses the regular navigation drawer and keeps content within the screen', async ({
  page,
}, info) => {
  const guard = await guardDemo(page);
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    for (const role of ['buyer', 'seller'] as const) {
      await page.goto(`/demo/${role}`);
      await settled(page);
      await fits(page);
      await capture(page, info, `regular-console-${role}-${width}`);
      for (const [label, , heading] of navigation[role]) {
        await navigate(page, label);
        await expect(page.locator('.main-content h1')).toHaveText(heading);
        await settled(page);
        await fits(page);
      }
      const guide = page.locator('#demo-console-guide');
      for (let step = 0; step < walkthroughPaths[role].length; step++) {
        await expect(walkthroughStep(page, role, step)).toBeVisible();
        await guide.screenshot({
          path: info.outputPath(`walkthrough-${role}-step-${step + 1}-${width}.png`),
        });
        const card = await guide.boundingBox();
        expect(card?.x).toBeGreaterThanOrEqual(0);
        expect(card!.x + card!.width).toBeLessThanOrEqual(width);
        await fits(page);
        await guide
          .getByRole('button', {
            name: step < 2 ? 'Next step' : 'Finish walkthrough',
            exact: true,
          })
          .click();
        await settled(page);
      }
      await expect(
        guide.getByRole('button', { name: 'Replay walkthrough', exact: true }),
      ).toBeVisible();
      await fits(page);
      await capture(page, info, `walkthrough-${role}-complete-${width}`);
    }
  }
  guard.assertLocal();
});

test('deep links, browser history, dismissible guide and exit preserve the real auth boundary', async ({
  page,
}) => {
  const guard = await guardDemo(page);
  await page.addInitScript(() =>
    sessionStorage.setItem('wick-draft', 'existing-real-workspace-draft'),
  );
  await page.goto('/demo');
  await expect(page.locator('.main-content h1')).toHaveText('Orders');
  await expect(page.getByRole('button', { name: 'Hide guide', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Hide guide', exact: true }).click();
  await expect(page.locator('#demo-console-guide')).toHaveCount(0);
  await page.getByRole('button', { name: 'Show guide', exact: true }).click();
  await expect(walkthroughStep(page, 'buyer', 0)).toBeVisible();
  await page.getByRole('link', { name: 'Seller', exact: true }).click();
  await navigate(page, 'Policy');
  await expect(page).toHaveURL(/\/demo\/seller\/provider\/policy$/);
  await page.goBack();
  await expect(page.locator('.main-content h1')).toHaveText('Capacity');
  await page.goForward();
  await expect(page.locator('.main-content h1')).toHaveText('Pricing & policy');
  guard.assertLocal();
  expect(await page.context().cookies()).toEqual([]);
  expect(await page.evaluate(() => sessionStorage.getItem('wick-draft'))).toBe(
    'existing-real-workspace-draft',
  );
  guard.allowExit();
  await page.getByRole('link', { name: 'Exit demo', exact: true }).click();
  await expect(page).toHaveURL(/\/demos$/);
  await expect(
    page.getByRole('heading', { name: 'See both sides of the market.', exact: true }),
  ).toBeVisible();
  expect(
    guard.requests.every((request) => ['GET /api/me', 'GET /api/demo'].includes(request)),
  ).toBe(true);
  expect(guard.requests).toContain('GET /api/me');
  expect(await page.evaluate(() => sessionStorage.getItem('wick-draft'))).toBe(
    'existing-real-workspace-draft',
  );
  await page.getByRole('link', { name: /Explore as a buyer/ }).click();
  guard.requests.length = 0;
  await page.clock.install();
  await page.clock.runFor(31_000);
  guard.assertLocal();
});

test('Studio uses the regular task composer and downloads only a local sample patch', async ({
  page,
}, info) => {
  const guard = await guardDemo(page);
  await page.clock.install();
  await page.goto('/demo/buyer/studio');
  await settled(page);
  await page
    .getByRole('textbox', { name: 'Task', exact: true })
    .fill('Write a greeting utility and verify its output.');
  await page
    .getByRole('textbox', { name: 'Public repository', exact: true })
    .fill('https://github.com/octocat/Hello-World');
  await page.getByRole('textbox', { name: 'Maximum total spend · USD', exact: true }).fill('0.20');
  await page.getByRole('button', { name: 'Review task · $0.20 maximum', exact: true }).click();
  await page
    .getByRole('dialog')
    .getByRole('button', { name: 'Start within $0.20', exact: true })
    .click();
  await expect(page).toHaveURL(/\/demo\/buyer\/studio\/tasks\/[^/]+$/);
  await page.clock.runFor(6_000);
  await settled(page);
  await page.getByRole('tab', { name: 'Changes', exact: true }).click();
  const patch = page.getByRole('link', { name: 'Download patch', exact: true });
  await expect(patch).toHaveAttribute('href', /^data:text\/plain/);
  const href = await patch.getAttribute('href');
  expect(decodeURIComponent(href!)).toContain('+++ b/hello.py');
  await page.getByRole('tab', { name: 'Tests', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Checks passed', exact: true })).toBeVisible();
  await capture(page, info, 'regular-console-demo-studio');
  guard.assertLocal();
});
