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
function studioReceipt(status: NonNullable<DemoRun['studio']>['status'] = 'generating') {
  const run = sponsoredReceipt('ready');
  run.kind = 'studio';
  run.message =
    status === 'passed'
      ? 'The guided task completed. Your workspace remains available.'
      : status === 'needs_attention'
        ? 'The guided task needs attention. Your workspace remains available.'
        : 'Your private disk is ready for the guided Studio task.';
  run.canIssueKey = false;
  run.studio = {
    status,
    filename: 'hello_world.py',
    source: ['running', 'passed', 'needs_attention'].includes(status)
      ? 'print("Hello, World!")\n'
      : null,
    stdout:
      status === 'passed'
        ? 'Hello, World!\n'
        : status === 'needs_attention'
          ? 'Execution could not be verified.\n'
          : null,
    exitCode: status === 'passed' ? 0 : status === 'needs_attention' ? 1 : null,
    requestsUsed: status === 'needs_attention' ? 2 : status === 'generating' ? 0 : 1,
    verifiedAt: status === 'passed' ? date() : null,
  };
  run.tokens!.requestsUsed = run.studio.requestsUsed;
  return run;
}
async function fixture(page: Page, initial = state()) {
  let current = initial,
    readFailure = false,
    keyFailure = false,
    startFailure = false;
  const writes: { path: string; body: Record<string, unknown> }[] = [];
  let reads = 0;
  let startHold: Promise<void> | null = null;
  let releaseStart: (() => void) | null = null;
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
      if (startFailure)
        return route.fulfill({ status: 503, json: { error: 'Start could not be confirmed.' } });
      current = state(receipt('auction'));
      current.run!.kind = request.postDataJSON().kind ?? 'terminal';
      current.run!.demoName = request.postDataJSON().demoName ?? '';
      if (current.run!.kind === 'studio') current.run!.studio = studioReceipt('waiting').studio;
      if (startHold) {
        const started = current;
        current = {
          ...current,
          available: false,
          run: null,
          reason: 'A demo is already active for this browser or connection.',
        };
        await startHold;
        current = started;
        startHold = null;
        releaseStart = null;
      }
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
    failStarts: (fail: boolean) => {
      startFailure = fail;
    },
    holdStart: () => {
      startHold = new Promise<void>((resolve) => {
        releaseStart = resolve;
      });
    },
    releaseStart: () => releaseStart?.(),
    reads: () => reads,
  };
}

test('demo page starts only on explicit action and supports legacy single-provider receipts inline', async ({
  page,
}) => {
  const f = await fixture(page);
  await page.goto('/demos');
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
    page.getByText('Every qualified Muse seller is invited; the lowest bid wins.', {
      exact: false,
    }),
  ).toHaveCount(1);
  await expect(
    page.getByRole('heading', {
      name: 'Meet the market. Then put it to work.',
    }),
  ).toBeVisible();
  expect(f.writes).toHaveLength(1);
  expect(f.writes[0]!.path).toBe('/api/demo/start');
  expect(f.writes[0]!.body.operationKey).toEqual(expect.any(String));
  expect(f.writes[0]!.body.kind).toBe('terminal');
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Your resources, going once…' })).toBeVisible();
  expect(f.writes).toHaveLength(1);
  await expect(page).toHaveURL(/\/demos$/);
});

test('an existing guest demo resumes on the dedicated page while the marketing homepage stops polling', async ({
  page,
}) => {
  const f = await fixture(page, state(receipt('ready')));
  await page.goto('/demos');
  await expect(page.getByRole('heading', { name: 'Your live workspace is ready.' })).toBeVisible();
  await page.getByRole('link', { name: 'Wick Broker home', exact: true }).click();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(
    'Compute and AI. On your terms.',
  );
  const reads = f.reads();
  await page.waitForTimeout(3000);
  expect(f.reads()).toBe(reads);
  await expect(page.locator('#live-demo')).toHaveCount(0);
  await page.getByRole('link', { name: 'Explore live demos', exact: true }).click();
  await expect(page).toHaveURL(/\/demos$/);
  await expect(page.getByRole('heading', { name: 'Your live workspace is ready.' })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Your live workspace is ready.' })).toBeVisible();
  expect(f.writes).toEqual([]);
});

for (const anchor of ['live-demo', 'demo-overview']) {
  test(`legacy homepage #${anchor} links open the same guest demo on /demos`, async ({ page }) => {
    const f = await fixture(page, state(receipt('ready')));
    await page.goto(`/#${anchor}`);
    await expect(page).toHaveURL(new RegExp(`/demos#${anchor}$`));
    await expect(
      page.getByRole('heading', { name: 'Your live workspace is ready.' }),
    ).toBeVisible();
    expect(f.writes).toEqual([]);
  });
}

test('a late start resumes after home navigation by polling the blocked no-run state without buying again', async ({
  page,
}) => {
  const f = await fixture(page);
  f.holdStart();
  try {
    await page.goto('/demos');
    await page.getByRole('button', { name: 'Start Muse Studio demo', exact: true }).click();
    await expect(
      page.getByRole('button', { name: 'Starting your demo', exact: true }),
    ).toBeDisabled();
    await page.getByRole('link', { name: 'Wick Broker home', exact: true }).click();
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(
      'Compute and AI. On your terms.',
    );
    const homeReads = f.reads();
    await page.waitForTimeout(3000);
    expect(f.reads()).toBe(homeReads);
    await page.getByRole('link', { name: 'Explore live demos', exact: true }).click();
    await expect(
      page.getByText('A demo is already active for this browser or connection.', { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole('button', { name: 'Check demo status', exact: true }),
    ).toBeEnabled();
    await expect(page.getByRole('button', { name: 'Try live demo', exact: true })).toBeDisabled();
    await expect(
      page.getByRole('button', { name: 'Start Muse Studio demo', exact: true }),
    ).toBeDisabled();
    f.releaseStart();
    await expect(page.getByRole('link', { name: 'Return to Muse Studio demo' })).toBeVisible();
    expect(f.writes).toHaveLength(1);
    expect(f.writes[0]!.path).toBe('/api/demo/start');
    expect(f.writes[0]!.body.kind).toBe('studio');
  } finally {
    f.releaseStart();
  }
});

test('the no-run status check discovers a saved run without starting a purchase', async ({
  page,
}) => {
  const f = await fixture(page);
  await page.goto('/demos');
  await expect(page.getByRole('button', { name: 'Check demo status', exact: true })).toBeEnabled();
  f.set(state(studioReceipt('passed')));
  await page.getByRole('button', { name: 'Check demo status', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Your guided Studio workspace.' })).toBeVisible();
  expect(f.writes).toEqual([]);
});

test('fixture demos are explicitly simulated before either demo starts', async ({ page }) => {
  const f = await fixture(page);
  await page.goto('/demos');
  await expect(
    page.getByText('Fixture preview · Resources, model responses, and execution are simulated.', {
      exact: true,
    }),
  ).toBeVisible();
  await expect(page.getByText(/A simulated VM\. Fixture model responses\./)).toBeVisible();
  await expect(
    page.getByText(/Preview a Python Hello World task with fixture source, simulated VM execution/),
  ).toBeVisible();
  await expect(page.getByText(/A real VM\. Real Meta inference\./)).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Try live demo', exact: true })).toBeEnabled();
  await expect(
    page.getByRole('button', { name: 'Start Muse Studio demo', exact: true }),
  ).toBeEnabled();
  expect(f.writes).toEqual([]);
});

test('Studio starts explicitly with its mode and an uncertain retry keeps the same operation', async ({
  page,
}) => {
  const f = await fixture(page);
  f.failStarts(true);
  await page.goto('/demos');
  await expect(
    page.getByRole('button', { name: 'Start Muse Studio demo', exact: true }),
  ).toBeEnabled();
  expect(f.writes).toEqual([]);
  await page.getByRole('button', { name: 'Start Muse Studio demo', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Start could not be confirmed.');
  await expect(page.getByRole('button', { name: 'Try live demo', exact: true })).toBeDisabled();
  f.failStarts(false);
  await page.getByRole('button', { name: 'Start Muse Studio demo', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Your resources, going once…' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Another demo is active' })).toBeDisabled();
  await expect(page.getByRole('link', { name: 'Return to Muse Studio demo' })).toBeVisible();
  expect(f.writes).toHaveLength(2);
  expect(f.writes[0]!.body).toEqual(f.writes[1]!.body);
  expect(f.writes[0]!.body.kind).toBe('studio');
  await page.reload();
  await expect(page.getByRole('link', { name: 'Return to Muse Studio demo' })).toBeVisible();
  expect(f.writes).toHaveLength(2);
});

test('guided Studio displays saved generation and execution receipts as text without model key controls', async ({
  page,
}) => {
  const f = await fixture(page, state(studioReceipt('generating')));
  await page.goto('/demos');
  await expect(page.getByText('Muse is writing Python', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Get demo key' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Connect terminal', exact: true })).toHaveCount(0);
  const running = studioReceipt('running');
  running.studio!.source =
    'print("Hello, World!")\n# <script>window.demoInjected = true</script>\n';
  f.set(state(running));
  await page.getByRole('button', { name: 'Refresh demo status' }).click();
  await expect(page.getByText('Running and checking in the VM', { exact: true })).toBeVisible();
  await expect(
    page.getByRole('region', { name: 'Generated Python source' }).locator('pre'),
  ).toHaveText(running.studio!.source);
  await expect(page.getByRole('button', { name: 'Copy run command' })).toHaveCount(0);
  expect(
    await page.evaluate(() => (window as Window & { demoInjected?: boolean }).demoInjected),
  ).toBeUndefined();
  const incomplete = studioReceipt('passed');
  incomplete.studio!.verifiedAt = null;
  f.set(state(incomplete));
  await page.getByRole('button', { name: 'Refresh demo status' }).click();
  await expect(page.getByText('Fixture check passed', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Copy run command' })).toHaveCount(0);
  const passed = studioReceipt('passed');
  passed.studio!.source = running.studio!.source;
  f.set(state(passed));
  await page.getByRole('button', { name: 'Refresh demo status' }).click();
  await expect(page.getByText('Fixture check passed', { exact: true })).toBeVisible();
  await expect(page.getByText('Simulated execution', { exact: true })).toBeVisible();
  await expect(
    page.getByRole('region', { name: 'Python execution result' }).locator('pre'),
  ).toHaveText('Hello, World!\n');
  await expect(page.getByRole('button', { name: 'Copy run command' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Connect terminal', exact: true })).toBeVisible();
  // Real-mode receipt labels are also checked with explicit, presentation-only API fixtures.
  const real = state(passed);
  real.mode = 'real';
  f.set(real);
  await page.getByRole('button', { name: 'Refresh demo status' }).click();
  await expect(page.getByText('Native check passed', { exact: true })).toBeVisible();
  await expect(page.getByText('Native VM execution', { exact: true })).toBeVisible();
  const ended = state({ ...passed, status: 'ended', endedAt: date() });
  f.set(ended);
  await page.getByRole('button', { name: 'Refresh demo status' }).click();
  await expect(
    page.getByRole('region', { name: 'Generated Python source' }).locator('pre'),
  ).toHaveText(running.studio!.source);
  await expect(page.getByRole('button', { name: 'Copy run command' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Connect terminal', exact: true })).toHaveCount(0);
  expect(f.writes).toEqual([]);
});

test('an unverified Studio result offers the remaining terminal lease without claiming an installed file', async ({
  page,
}) => {
  const f = await fixture(page, state(studioReceipt('needs_attention')));
  let input = '';
  await page.routeWebSocket('**/api/vms/*/terminal', (ws) => {
    let ready = false;
    ws.onMessage((data) => {
      const frame = JSON.parse(String(data));
      if (frame.type === 'resize' && !ready) {
        ready = true;
        ws.send(JSON.stringify({ type: 'ready' }));
      }
      if (frame.type === 'input') input += frame.data;
    });
  });
  await page.goto('/demos');
  await expect(page.getByText('Needs attention', { exact: true })).toBeVisible();
  await expect(
    page.getByText(/The task is unverified, and the generated file may not have been installed/),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: 'Copy run command' })).toHaveCount(0);
  await expect(page.getByText('Native check passed', { exact: true })).toHaveCount(0);
  await expect(
    page.getByRole('button', { name: /^(Get demo key|Replace key|Copy key)$/ }),
  ).toHaveCount(0);
  await page.getByRole('button', { name: 'Connect terminal', exact: true }).click();
  await expect(page.locator('.terminal-status')).toHaveText('Connected');
  await page.locator('.xterm-helper-textarea').focus();
  await page.keyboard.type('pwd');
  await page.keyboard.press('Enter');
  await expect.poll(() => input).toBe('pwd\r');
  expect(f.writes).toEqual([]);
});

test('compute auction renders only accepted bids, ranks sponsorship honestly, and waits for the actual award', async ({
  page,
}) => {
  const pending = sponsoredReceipt('auction');
  pending.vm!.bids = [];
  const f = await fixture(page, state(pending));
  await page.goto('/demos');
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

test('an operator-sponsored provider price shows the promotion without inventing another demo credit', async ({
  page,
}) => {
  const promoted = sponsoredReceipt('provisioning');
  promoted.vm!.grossPriceCents = 1;
  promoted.vm!.sponsorCreditCents = 0;
  promoted.vm!.operatorSponsored = true;
  const modal = promoted.vm!.bids.find((bid) => bid.provider === 'modal')!;
  modal.grossPriceCents = 1;
  modal.sponsorCreditCents = 0;
  modal.operatorSponsored = true;
  const f = await fixture(page, state(promoted));
  await page.goto('/demos');
  const compute = page.getByRole('article', { name: 'Compute auction' });
  const rows = compute.locator('.demo-provider-bid');
  await expect(rows).toHaveCount(2);
  await expect(rows.first()).toContainText('Modal');
  await expect(rows.first()).toContainText('1¢provider promotion');
  await expect(rows.first()).toContainText('Selected');
  await expect(rows.nth(1)).toContainText('E2B');
  await expect(rows.nth(1)).toContainText('$0.05');
  await expect(compute.getByText('after demo sponsorship', { exact: true })).toHaveCount(0);
  await expect(compute.locator('.demo-bid-sponsorship')).toHaveCount(0);
  await page.getByText('Auction receipts & resource status', { exact: true }).click();
  const receiptGrid = page.locator('.demo-receipt-grid');
  await expect(
    receiptGrid
      .locator('div')
      .filter({ has: page.getByText('Provider compute price', { exact: true }) }),
  ).toContainText('$0.01');
  await expect(
    receiptGrid
      .locator('div')
      .filter({ has: page.getByText('Demo sponsorship credit', { exact: true }) }),
  ).toContainText('$0.00');
  await expect(
    receiptGrid
      .locator('div')
      .filter({ has: page.getByText('Accepted compute bid', { exact: true }) }),
  ).toContainText('1¢operator-sponsored provider price');
  await expect(receiptGrid.getByText('after demo sponsorship', { exact: true })).toHaveCount(0);
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
  await page.goto('/demos');
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
  await page.goto('/demos');
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
  await page.goto('/demos');
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
  await page.goto('/demos');
  await expect(page.getByRole('button', { name: 'Try live demo' })).toBeDisabled();
  await expect(page.getByText(disabled.reason)).toBeVisible();
  const initialReads = f.reads();
  await page.waitForTimeout(3000);
  expect(f.reads()).toBe(initialReads);
  await expect(
    page.getByRole('link', { name: 'Join buyer beta (opens in a new tab)', exact: true }),
  ).toHaveAttribute('href', 'https://app.wick-cloud.com/waitlist');
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
  await page.goto('/demos');
  await expect(page.getByRole('heading', { name: 'Your demo has finished' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Try live demo' })).toHaveCount(0);
  f.set(state(receipt('ended')));
  await expect(page.getByRole('button', { name: 'Try live demo' }).first()).toBeEnabled();
  expect(f.writes).toEqual([]);
});

for (const width of [1440, 320]) {
  test(`guided Studio source and receipts fit ${width}px`, async ({ page }, info) => {
    const run = studioReceipt('passed');
    run.studio!.source = `print("Hello, World!")\n# ${'long-model-output-'.repeat(30)}\n`;
    const f = await fixture(page, state(run));
    await page.setViewportSize({ width, height: 1000 });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto('/demos');
    await expect(page.getByText('Fixture check passed', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Connect terminal', exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    f.set(state(studioReceipt('passed')));
    await page.getByRole('button', { name: 'Refresh demo status' }).click();
    await expect(
      page.getByRole('region', { name: 'Generated Python source' }).locator('pre'),
    ).toHaveText('print("Hello, World!")\n');
    await page
      .locator('#live-demo')
      .screenshot({ path: info.outputPath(`studio-fixture-panel-${width}.png`) });
    expect(f.writes).toEqual([]);
  });
}

for (const width of [1440, 390, 320]) {
  test(`inline demo states fit ${width}px and keep keyboard actions reachable`, async ({
    page,
  }, info) => {
    const f = await fixture(page);
    await page.setViewportSize({ width, height: 1000 });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto('/demos');
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

test('Studio offers Hello World and an optional name while the task stays read-only', async ({
  page,
}) => {
  const f = await fixture(page);
  await page.goto('/demos');
  await expect(page.getByLabel('Choose a task')).toHaveValue('hello-world');
  await page.getByLabel('Your name (optional)').fill('Alex');
  await expect(page.getByRole('textbox', { name: 'Your Muse task', exact: true })).toHaveValue(
    'Create hello_world.py that prints Hello, Alex! Run it and verify the output.',
  );
  await expect(page.getByRole('textbox', { name: 'Your Muse task', exact: true })).toHaveAttribute(
    'readonly',
    '',
  );
  await page.screenshot({ path: 'verification-results/demo-pool/name-task.png', fullPage: true });
  await page.getByRole('button', { name: 'Start Muse Studio demo', exact: true }).click();
  await expect(
    page.locator('#live-demo').getByRole('textbox', { name: 'Your Muse task', exact: true }),
  ).toHaveValue('Create hello_world.py that prints Hello, Alex! Run it and verify the output.');
  expect(f.writes).toHaveLength(1);
  expect(f.writes[0]!.body.demoName).toBe('Alex');
  await expect(page.getByLabel('Your name (optional)')).toBeDisabled();
});
