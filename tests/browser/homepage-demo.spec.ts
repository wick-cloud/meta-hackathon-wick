import { expect, test, type Page } from '@playwright/test';
import type { DemoState, DemoRun } from '../../src/shared/demo';

// Presentation-only fixtures: these tests never allocate VMs or call a model.
const limits = {
  durationMinutes: 15,
  cooldownMinutes: 20,
  maxRequests: 2,
  maxOutputTokens: 1024,
  inputTokens: 5000,
  outputTokens: 2048,
};
const date = (seconds = 0) => new Date(Date.now() + seconds * 1000).toISOString();
function receipt(status: DemoRun['status']): DemoRun {
  const ready = ['ready', 'ending', 'ended'].includes(status);
  return {
    id: 'demo-browser-fixture',
    status,
    message:
      status === 'ready'
        ? 'The native disk mount and hello_muse.py are ready.'
        : status === 'ended'
          ? 'VM and disk cleanup are confirmed.'
          : 'Your compute and token orders are being prepared.',
    createdAt: date(-40),
    expiresAt: date(860),
    endedAt: status === 'ended' ? date() : null,
    vm: {
      id: ready ? '11111111-1111-4111-8111-111111111111' : null,
      status: ready ? 'running' : 'open',
      provider: 'modal',
      catalogId: 'modal:micro:auto',
      terminalPath: ready ? '/api/vms/11111111-1111-4111-8111-111111111111/terminal' : null,
      priceCents: ready ? 3 : null,
      auctionEndsAt: date(25),
      bids: [{ provider: 'modal', priceCents: 3, acceptedAt: date(-4) }],
      cleanupConfirmed: status === 'ended',
    },
    tokens: {
      orderId: 'order-fixture',
      status: ready ? 'awarded' : 'open',
      provider: 'baseten',
      packId: ready ? 'pack-fixture' : null,
      inputTokens: 5000,
      outputTokens: 2048,
      availableInput: ready ? 4800 : 0,
      availableOutput: ready ? 1984 : 0,
      requestsUsed: ready ? 1 : 0,
      priceCents: ready ? 2 : null,
      auctionEndsAt: date(20),
      bids: [{ provider: 'baseten', priceCents: 2, acceptedAt: date(-5) }],
    },
    disk: {
      id: 'disk-fixture',
      name: 'demo-disk',
      status: status === 'ended' ? 'deleted' : ready ? 'ready' : 'creating',
    },
    canIssueKey: status === 'ready',
    keyIssued: false,
  };
}
function state(run: DemoRun | null = null): DemoState {
  return {
    enabled: true,
    available: !run || ['ended', 'failed'].includes(run.status),
    reason: null,
    mode: 'fixture',
    serverTime: date(),
    cooldownUntil: null,
    limits,
    run,
  };
}
function sponsoredReceipt(status: 'auction' | 'provisioning' | 'ready') {
  const run = receipt(status === 'auction' ? 'auction' : 'ready');
  run.status = status;
  run.vm!.bids = [
    {
      provider: 'e2b',
      catalogId: 'e2b:micro:us',
      priceCents: 5,
      grossPriceCents: 5,
      sponsorCreditCents: 0,
      acceptedAt: date(-5),
    },
    {
      provider: 'modal',
      catalogId: 'modal:micro:auto',
      priceCents: 1,
      grossPriceCents: 7,
      sponsorCreditCents: 6,
      acceptedAt: date(-4),
    },
  ];
  if (status !== 'auction') {
    run.vm!.priceCents = 1;
    run.vm!.grossPriceCents = 7;
    run.vm!.sponsorCreditCents = 6;
  }
  if (status === 'provisioning') {
    run.vm!.status = 'provisioning';
    run.vm!.terminalPath = null;
    run.canIssueKey = false;
  }
  return run;
}
async function fixture(page: Page, initial = state()) {
  let current = initial,
    readFailure = false,
    keyFailure = false;
  const writes: { path: string; body: Record<string, unknown> }[] = [];
  let reads = 0;
  await page.route('**/api/**', async (route) => {
    const request = route.request(),
      path = new URL(request.url()).pathname;
    if (path === '/api/me')
      return route.fulfill({
        json: { user: null, modes: { wick: 'fixture', muse: 'fixture' }, catalog: [] },
      });
    if (request.method() !== 'GET') writes.push({ path, body: request.postDataJSON() });
    if (path === '/api/demo') {
      reads++;
      return readFailure
        ? route.fulfill({ status: 503, json: { error: 'Demo status is temporarily unavailable.' } })
        : route.fulfill({ json: current });
    }
    if (path === '/api/demo/start') {
      current = state(receipt('auction'));
      return route.fulfill({ json: current });
    }
    if (path === '/api/demo/end') {
      current = state(receipt('ending'));
      return route.fulfill({ json: current });
    }
    if (path === '/api/demo/key') {
      if (current.run) current.run.keyIssued = true;
      return keyFailure
        ? route.fulfill({ status: 503, json: { error: 'Key issuance could not be confirmed.' } })
        : route.fulfill({
            json: {
              token: 'browser-fixture-secret-never-a-real-key',
              connection: {
                packId: 'pack-fixture',
                model: 'meta/muse-spark-open',
                baseUrl: 'https://broker.fixture.invalid/api/v1',
                expiresAt: date(600),
              },
            },
          });
    }
    return route.fulfill({
      status: 403,
      json: { error: 'This route is not part of the demo fixture.' },
    });
  });
  return {
    writes,
    set: (next: DemoState) => {
      current = next;
    },
    failReads: (fail: boolean) => {
      readFailure = fail;
    },
    failKeys: (fail: boolean) => {
      keyFailure = fail;
    },
    reads: () => reads,
  };
}

test('homepage starts only on explicit action and supports legacy single-provider receipts inline', async ({
  page,
}) => {
  const f = await fixture(page);
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Try live demo' })).toBeEnabled();
  await expect(page.getByRole('heading', { name: 'From auction to “Hello, Muse.”' })).toBeVisible();
  expect(f.writes).toEqual([]);
  await page.getByRole('button', { name: 'Try live demo' }).click();
  await expect(page.getByRole('heading', { name: 'Your resources, going once…' })).toBeVisible();
  await expect(
    page.getByRole('article', { name: 'Compute auction' }).getByText('Modal', { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('article', { name: 'Token auction' }).getByText('Baseten', { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText('One eligible token provider in this demo.', { exact: false }),
  ).toHaveCount(1);
  await expect(
    page.getByRole('heading', {
      name: 'Compute and AI tokens. Providers compete for your workload.',
    }),
  ).toBeVisible();
  expect(f.writes).toHaveLength(1);
  expect(f.writes[0]!.path).toBe('/api/demo/start');
  expect(f.writes[0]!.body.operationKey).toEqual(expect.any(String));
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Your resources, going once…' })).toBeVisible();
  expect(f.writes).toHaveLength(1);
  await expect(page).toHaveURL(/\/$/);
});

test('compute auction renders only accepted bids, ranks sponsorship honestly, and waits for the actual award', async ({
  page,
}) => {
  const pending = sponsoredReceipt('auction');
  pending.vm!.bids = [];
  const f = await fixture(page, state(pending));
  await page.goto('/');
  const compute = page.getByRole('article', { name: 'Compute auction' });
  const rows = compute.locator('.demo-provider-bid');
  await expect(compute.getByText('Waiting for accepted provider bids.')).toBeVisible();
  await expect(rows).toHaveCount(0);
  await page.getByText('Auction receipts & resource status', { exact: true }).click();
  const receiptGrid = page.locator('.demo-receipt-grid');
  await expect(
    receiptGrid.locator('div').filter({ has: page.getByText('Compute provider', { exact: true }) }),
  ).toContainText('Not awarded');

  const firstBid = sponsoredReceipt('auction');
  firstBid.vm!.bids = firstBid.vm!.bids.filter((bid) => bid.provider === 'e2b');
  f.set(state(firstBid));
  await page.getByRole('button', { name: 'Refresh demo status' }).click();
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText('E2B');
  await expect(rows.first()).toContainText('Lowest bid');
  await expect(compute.getByText('Modal', { exact: true })).toHaveCount(0);

  f.set(state(sponsoredReceipt('auction')));
  await page.getByRole('button', { name: 'Refresh demo status' }).click();
  await expect(rows).toHaveCount(2);
  await expect(rows.first()).toContainText('Modal');
  await expect(rows.first()).toContainText('1¢');
  await expect(rows.first()).toContainText('after demo sponsorship');
  await expect(rows.first()).toContainText('$0.07 provider price − $0.06 demo sponsorship');
  await expect(rows.nth(1)).toContainText('E2B');
  await expect(rows.nth(1)).toContainText('$0.05');
  await expect(compute.getByText('Selected', { exact: true })).toHaveCount(0);

  // Equal prices retain the disclosed Modal sponsorship priority, but no winner is invented.
  const tied = sponsoredReceipt('auction');
  tied.vm!.bids[0]!.priceCents = 1;
  tied.vm!.bids[0]!.grossPriceCents = 1;
  tied.vm!.auctionEndsAt = date(-1);
  f.set(state(tied));
  await page.getByRole('button', { name: 'Refresh demo status' }).click();
  await expect(rows.first()).toContainText('Modal');
  await expect(compute.getByText('Awaiting result', { exact: true })).toBeVisible();
  await expect(compute.getByText('Selected', { exact: true })).toHaveCount(0);
  await expect(compute.getByText(/Modal has sponsored priority on equal bids/)).toBeVisible();

  f.set(state(sponsoredReceipt('provisioning')));
  await page.getByRole('button', { name: 'Refresh demo status' }).click();
  await expect(compute.getByText('Awarded', { exact: true })).toBeVisible();
  await expect(rows.first()).toContainText('Selected');
  await expect(rows.nth(1)).toContainText('Not selected');
  await expect(
    receiptGrid.locator('div').filter({ has: page.getByText('Compute provider', { exact: true }) }),
  ).toContainText('Modal');
  await expect(
    receiptGrid
      .locator('div')
      .filter({ has: page.getByText('Provider compute price', { exact: true }) }),
  ).toContainText('$0.07');
  await expect(
    receiptGrid
      .locator('div')
      .filter({ has: page.getByText('Demo sponsorship credit', { exact: true }) }),
  ).toContainText('−$0.06');
  await expect(
    receiptGrid
      .locator('div')
      .filter({ has: page.getByText('Accepted compute bid', { exact: true }) }),
  ).toContainText('1¢after demo sponsorship');
  expect(f.writes).toEqual([]);
});

test('ready demo opens the existing owned terminal and keeps a revealed key out of browser storage', async ({
  page,
}) => {
  const f = await fixture(page, state(receipt('ready')));
  await page.routeWebSocket('**/api/vms/*/terminal', (ws) => {
    ws.onMessage((data) => {
      const frame = JSON.parse(String(data));
      if (frame.type === 'resize') {
        ws.send(JSON.stringify({ type: 'ready' }));
        ws.send(
          JSON.stringify({
            type: 'output',
            data: Buffer.from('fixture guest $ ').toString('base64'),
          }),
        );
      }
    });
  });
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Your live workspace is ready.' })).toBeVisible();
  await page.getByRole('button', { name: 'Connect terminal', exact: true }).click();
  await expect(page.locator('.terminal-status')).toHaveText('Connected');
  await page.getByRole('button', { name: 'Get demo key' }).click();
  await expect(page.getByRole('button', { name: 'Copy key', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Reveal key' }).click();
  await expect(page.getByLabel('Your demo token key')).toHaveValue(
    'browser-fixture-secret-never-a-real-key',
  );
  expect(
    await page.evaluate(() =>
      JSON.stringify({
        local: { ...localStorage },
        session: { ...sessionStorage },
        href: location.href,
      }),
    ),
  ).not.toContain('browser-fixture-secret');
  await expect(page.getByText('python3 /workspace/hello_muse.py', { exact: true })).toBeVisible();
  await expect(page.getByText('4,800 input left')).toBeVisible();
  expect(f.writes.map((w) => w.path)).toEqual(['/api/demo/key']);
  await page.reload();
  await expect(page.getByRole('button', { name: 'Replace key', exact: true })).toBeVisible();
  await expect(page.getByLabel('Your demo token key')).toHaveCount(0);
  expect(f.writes).toHaveLength(1);
});

test('using both Muse calls keeps the connected terminal usable for the remaining rental', async ({
  page,
}) => {
  const ready = receipt('ready');
  const f = await fixture(page, state(ready));
  let connections = 0;
  let terminalInput = '';
  await page.routeWebSocket('**/api/vms/*/terminal', (ws) => {
    connections++;
    let announced = false;
    ws.onMessage((data) => {
      const frame = JSON.parse(String(data));
      if (frame.type === 'resize' && !announced) {
        announced = true;
        ws.send(JSON.stringify({ type: 'ready' }));
      }
      if (frame.type === 'input') {
        terminalInput += frame.data;
        if (terminalInput.endsWith('\r')) {
          ws.send(
            JSON.stringify({
              type: 'output',
              data: Buffer.from('\r\nterminal remains usable\r\n').toString('base64'),
            }),
          );
        }
      }
    });
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Connect terminal', exact: true }).click();
  await expect(page.locator('.terminal-status')).toHaveText('Connected');
  await page.getByRole('button', { name: 'Get demo key' }).click();
  await expect(page.getByRole('button', { name: 'Copy key', exact: true })).toBeVisible();

  const exhausted = structuredClone(ready);
  exhausted.tokens!.requestsUsed = 2;
  exhausted.canIssueKey = false;
  f.set(state(exhausted));

  // The normal status poll must update allowance without replacing or ending the terminal.
  await expect(page.getByText('Muse calls used. Your terminal is still available.')).toBeVisible();
  await expect(page.getByText('0 calls left', { exact: true })).toBeVisible();
  await expect(
    page.getByText(/run Python and shell commands until the session timer expires/),
  ).toBeVisible();
  await expect(page.locator('.terminal-status')).toHaveText('Connected');
  await expect(
    page.getByRole('button', { name: /^(Get demo key|Replace key|Copy key|Reveal key)$/ }),
  ).toHaveCount(0);
  await page.locator('.xterm-helper-textarea').focus();
  await page.keyboard.type('echo terminal remains usable');
  await page.keyboard.press('Enter');
  await expect.poll(() => terminalInput).toBe('echo terminal remains usable\r');
  await expect(page.locator('.xterm-rows')).toContainText('terminal remains usable');
  expect(connections).toBe(1);
  expect(f.writes.map((w) => w.path)).toEqual(['/api/demo/key']);
});

test('an uncertain key requires explicit replacement and ending waits for cleanup before a server-clock cooldown', async ({
  page,
}) => {
  const f = await fixture(page, state(receipt('ready')));
  f.failKeys(true);
  await page.goto('/');
  await page.getByRole('button', { name: 'Get demo key' }).click();
  await expect(page.getByRole('alert')).toContainText('Key issuance could not be confirmed.');
  await page.getByRole('button', { name: 'Replace key', exact: true }).click();
  await expect(page.getByRole('group', { name: 'Replace demo key' })).toBeVisible();
  expect(f.writes).toHaveLength(1);
  f.failKeys(false);
  await page.getByRole('button', { name: 'Replace demo key', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Copy key', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'End demo', exact: true }).click();
  expect(f.writes).toHaveLength(2);
  await page.getByRole('button', { name: 'Confirm end demo' }).click();
  await expect(page.getByRole('heading', { name: 'Confirming resource cleanup' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Connect terminal', exact: true })).toHaveCount(0);
  const complete = state(receipt('ended'));
  complete.serverTime = date(3600); // The UI must use the server clock, not this machine's clock.
  complete.cooldownUntil = date(4800);
  complete.available = false;
  f.set(complete);
  await page.getByRole('button', { name: 'Refresh demo status' }).click();
  await expect(page.getByRole('heading', { name: 'Your demo has finished' })).toBeVisible();
  await expect(page.locator('.demo-cooldown strong')).toHaveText(/^(20:00|19:5\d)$/);
  await expect(page.getByRole('button', { name: 'Try live demo' })).toHaveCount(0);
  expect(f.writes.map((w) => w.path)).toEqual(['/api/demo/key', '/api/demo/key', '/api/demo/end']);
});

test('disabled demo stays readable without polling or purchasing and retry only reads status', async ({
  page,
}) => {
  const disabled = state();
  disabled.enabled = false;
  disabled.available = false;
  disabled.reason = 'The live demo is paused. Please try again later.';
  const f = await fixture(page, disabled);
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Try live demo' })).toBeDisabled();
  await expect(page.getByText(disabled.reason)).toBeVisible();
  const initialReads = f.reads();
  await page.waitForTimeout(3000);
  expect(f.reads()).toBe(initialReads);
  await expect(
    page.getByRole('link', { name: 'Buy resources', exact: true }).first(),
  ).toHaveAttribute('href', '/login?intent=buy');
  expect(f.writes).toEqual([]);
  f.failReads(true);
  await page.reload();
  await expect(page.getByRole('alert')).toContainText('Demo status is temporarily unavailable.');
  f.failReads(false);
  await page.getByRole('button', { name: 'Check demo status' }).click();
  await expect(page.getByText(disabled.reason)).toBeVisible();
  expect(f.writes).toEqual([]);
});

test('cooldown expiry checks server availability without starting another run', async ({
  page,
}) => {
  const cooling = state(receipt('ended'));
  cooling.available = false;
  cooling.cooldownUntil = date(3);
  const f = await fixture(page, cooling);
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Your demo has finished' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Try live demo' })).toHaveCount(0);
  f.set(state(receipt('ended')));
  await expect(page.getByRole('button', { name: 'Try live demo' }).first()).toBeEnabled();
  expect(f.writes).toEqual([]);
});

for (const width of [1440, 390, 320]) {
  test(`inline demo states fit ${width}px and keep keyboard actions reachable`, async ({
    page,
  }, info) => {
    const f = await fixture(page);
    await page.setViewportSize({ width, height: 1000 });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto('/');
    await expect(page.getByRole('button', { name: 'Try live demo' })).toBeEnabled();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.screenshot({ path: info.outputPath(`demo-landing-${width}.png`), fullPage: true });
    await page.screenshot({ path: info.outputPath(`demo-landing-viewport-${width}.png`) });
    await page.getByRole('button', { name: 'Try live demo' }).focus();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('heading', { name: 'Your resources, going once…' })).toBeVisible();
    f.set(state(sponsoredReceipt('auction')));
    await page.getByRole('button', { name: 'Refresh demo status' }).click();
    await expect(
      page.getByRole('article', { name: 'Compute auction' }).locator('.demo-provider-bid'),
    ).toHaveCount(2);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({ path: info.outputPath(`demo-auction-${width}.png`), fullPage: true });
    await page
      .locator('#live-demo')
      .screenshot({ path: info.outputPath(`demo-auction-panel-${width}.png`) });
    f.set(state(sponsoredReceipt('ready')));
    await page.getByRole('button', { name: 'Refresh demo status' }).click();
    await expect(
      page.getByRole('heading', { name: 'Your live workspace is ready.' }),
    ).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.getByRole('button', { name: 'Copy command', exact: true }).focus();
    await expect(page.getByRole('button', { name: 'Copy command', exact: true })).toBeFocused();
    await expect(page.getByRole('button', { name: 'Connect terminal', exact: true })).toBeVisible();
    await page.getByText('Auction receipts & resource status', { exact: true }).click();
    await expect(page.getByText('Demo sponsorship credit', { exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({ path: info.outputPath(`demo-terminal-${width}.png`), fullPage: true });
    await page
      .locator('#live-demo')
      .screenshot({ path: info.outputPath(`demo-terminal-panel-${width}.png`) });
    expect(f.writes.map((w) => w.path)).toEqual(['/api/demo/start']);
  });
}
