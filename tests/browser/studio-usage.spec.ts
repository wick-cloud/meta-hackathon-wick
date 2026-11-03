import { expect, test, type Page } from './table-review';
import type { StudioDetail } from '../../src/shared/studio';

const id = 'a1c62b8a-7a63-468b-bc1d-bbe9556f3244';
function detail(): StudioDetail {
  const now = new Date().toISOString();
  return {
    task: {
      id,
      goal: 'Add a greeting utility and verify its tests.',
      repositoryUrl: 'https://github.com/example/public',
      commitSha: 'a'.repeat(40),
      status: 'completed',
      mode: 'fixture',
      budgetCents: 100,
      spentCents: 25,
      reservedCents: 0,
      availableCents: 0,
      returnedCents: 75,
      computeChargedCents: 10,
      modelChargedCents: 15,
      blockedReason: null,
      plan: null,
      deadlineAt: now,
      createdAt: now,
      executionStartedAt: now,
      verifiedAt: now,
      completedAt: now,
      vmRequestId: null,
      codingJobId: null,
      summary: 'Implemented and tested.',
      hasPatch: false,
    },
    modelActivity: [],
    events: [],
    vm: null,
    computeAuction: null,
    modelPurchases: [],
    tests: null,
    patch: null,
    usage: {
      forecast: {
        version: 'studio-usage-v1',
        basis: 'cold_start',
        trainingSamples: 0,
        targetUtilization: 0.9,
        expectedInput: 20000,
        expectedOutput: 4500,
        expectedCalls: 10,
        headroom: { inputMultiplier: 1.5, outputMultiplier: 1.5 },
        validation: null,
      },
      purchaseRound: 0,
      purchaseInput: 1078576,
      purchaseOutput: 8798,
      inputReservationFloor: 1048576,
      outputReservationFloor: 2048,
      reservationLimited: true,
      settledInput: 19201,
      settledOutput: 4503,
      purchasedInput: 1078576,
      purchasedOutput: 8798,
      unresolvedCalls: 0,
    },
  };
}
function pendingPlan(): StudioDetail {
  const data = detail();
  const now = new Date().toISOString();
  Object.assign(data.task, {
    status: 'needs_attention',
    executionStartedAt: null,
    verifiedAt: null,
    completedAt: null,
    summary: null,
    returnedCents: 0,
    availableCents: 75,
    deadlineAt: new Date(Date.now() + 30 * 60000).toISOString(),
  });
  data.modelPurchases = [
    { id: 'model-order', status: 'awarded', provider: 'baseten', priceCents: 25, closesAt: now },
  ];
  data.events = [
    {
      id: 'planning-event',
      kind: 'meta',
      title: 'Planning needs review',
      message: 'The response could not be accepted. No VM has been purchased.',
      createdAt: now,
    },
  ];
  return data;
}
async function fixture(page: Page, data: StudioDetail) {
  const writes: string[] = [];
  await page.route('**/api/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (route.request().method() !== 'GET') writes.push(path);
    if (path === '/api/me')
      return route.fulfill({
        json: {
          user: { id: 'buyer', name: 'Alex', email: 'buyer@fixture.invalid', role: 'buyer' },
          modes: { wick: 'fixture', muse: 'fixture' },
          catalog: [],
        },
      });
    if (path === '/api/studio/tasks/' + id) return route.fulfill({ json: data });
    return route.fulfill({ status: 500, json: { error: 'Unexpected fixture request.' } });
  });
  await page.goto('/studio/tasks/' + id);
  return writes;
}
test('forecast, purchased quota and usage are distinct and the reservation limit is explicit', async ({
  page,
}, info) => {
  const writes = await fixture(page, detail());
  const card = page.getByRole('region', { name: 'Model usage estimate' });
  await expect(card.getByRole('heading', { name: 'Model usage' })).toBeVisible();
  await expect(card.getByText('Initial estimate', { exact: false })).toBeVisible();
  const usage = card.getByRole('table', { name: 'Token forecast and usage' });
  await expect(usage).toHaveJSProperty('tagName', 'TABLE');
  await expect(usage.getByRole('columnheader')).toHaveText(['Tokens', 'Input', 'Output']);
  await expect(card.getByRole('rowheader', { name: 'Expected task' })).toBeVisible();
  await expect(card.getByRole('rowheader', { name: 'Purchased', exact: true })).toBeVisible();
  await expect(card.getByRole('cell', { name: '1.8%', exact: true })).toBeVisible();
  await expect(
    card.getByText(/provider reservation minimum increased this purchase/),
  ).toBeVisible();
  await card.getByText('How this purchase was sized').click();
  await expect(card.getByText(/Not enough completed tasks/)).toBeVisible();
  await card.screenshot({ path: info.outputPath('usage-estimate-desktop.png') });
  expect(writes).toEqual([]);
});
test('new task purchases explain the small buffer and demand-triggered refill', async ({
  page,
}) => {
  const data = detail();
  Object.assign(data.usage!.forecast, {
    version: 'studio-usage-v3-small-packs',
    targetUtilization: 100 / 110,
    headroom: { inputMultiplier: 1.1, outputMultiplier: 1.1 },
  });
  Object.assign(data.usage!, {
    purchaseInput: 22000,
    purchasedInput: 22000,
    purchaseOutput: 4950,
    purchasedOutput: 4950,
    inputReservationFloor: 7000,
    outputReservationFloor: 256,
    reservationLimited: false,
  });
  const writes = await fixture(page, data);
  const card = page.getByRole('region', { name: 'Model usage estimate' });
  await expect(card.getByText('Initial +10%', { exact: true })).toBeVisible();
  await card.getByText('How this purchase was sized').click();
  await expect(card.getByText(/first purchase adds 10%/)).toBeVisible();
  await expect(card.getByText(/only when the next call cannot fit/)).toBeVisible();
  await expect(card.getByText(/Purchase floor: 7,000 input/)).toBeVisible();
  expect(writes).toEqual([]);
});
test('a pooled refill distinguishes existing quota from its shortfall purchase', async ({
  page,
}) => {
  const data = detail();
  Object.assign(data.usage!, {
    purchaseRound: 1,
    purchaseInput: 1,
    purchaseOutput: 2048,
    inputReservationFloor: 7000,
    outputReservationFloor: 1024,
    refillProvider: 'baseten',
    existingInput: 19000,
    existingOutput: 0,
  });
  await fixture(page, data);
  const card = page.getByRole('region', { name: 'Model usage estimate' });
  await card.getByText('How this purchase was sized').click();
  await expect(card.getByText(/Allowance 2: 1 input \/ 2,048 output/)).toBeVisible();
  await expect(
    card.getByText(/Existing Baseten quota before this refill: 19,000 input/),
  ).toBeVisible();
  await expect(card.getByText(/Only the shortfall is purchased/)).toBeVisible();
});
test('an owner can restrict Studio auctions to one model provider', async ({ page }) => {
  let submitted: Record<string, unknown> | undefined;
  await page.route('**/api/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/me')
      return route.fulfill({
        json: {
          user: { id: 'buyer', role: 'buyer', name: 'Alex' },
          modes: { wick: 'fixture', muse: 'fixture' },
          catalog: [],
        },
      });
    if (path === '/api/studio/options')
      return route.fulfill({ json: { available: true, mode: 'fixture', reason: '' } });
    if (path === '/api/credits') return route.fulfill({ json: { availableCents: 1000 } });
    if (path === '/api/studio/tasks' && route.request().method() === 'POST') {
      submitted = route.request().postDataJSON();
      return route.fulfill({ json: detail().task });
    }
    if (path === '/api/studio/tasks') return route.fulfill({ json: { items: [] } });
    if (path === '/api/studio/tasks/' + id) return route.fulfill({ json: detail() });
    return route.fulfill({ status: 500, json: { error: 'Unexpected fixture request.' } });
  });
  await page.goto('/studio?new=1');
  await page.getByLabel('Task', { exact: true }).fill('Add a greeting utility with tests.');
  await page
    .getByLabel('Public repository', { exact: true })
    .fill('https://github.com/example/public');
  await page.getByLabel('Maximum total spend · USD').fill('1.2345');
  await page.getByRole('combobox', { name: 'Time limit', exact: true }).selectOption('60');
  await page
    .getByRole('checkbox', { name: 'Use instant model pricing if an auction has no offers' })
    .uncheck();
  await page.getByText('Advanced · completion checks').click();
  await page.getByRole('combobox', { name: 'Model provider', exact: true }).selectOption('modal');
  await page.getByRole('button', { name: 'Review task · $1.2345 maximum' }).click();
  expect(submitted).toBeUndefined();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByText('Modal only', { exact: true })).toBeVisible();
  await dialog.getByRole('button', { name: 'Start within $1.2345' }).click();
  await expect(page).toHaveURL(new RegExp('/studio/tasks/' + id));
  expect(submitted?.allowedProviders).toEqual(['modal']);
  expect(submitted?.budgetCents).toBe(123.45);
  expect(submitted?.durationMinutes).toBe(60);
  expect(submitted?.allowInstant).toBe(false);
});
test('learned diagnostics and unresolved usage remain readable on a phone', async ({
  page,
}, info) => {
  const data = detail();
  data.usage!.forecast.basis = 'learned';
  data.usage!.forecast.trainingSamples = 50;
  data.usage!.forecast.validation = { samples: 10, inputError: 0.08, outputError: 0.12 };
  data.usage!.unresolvedCalls = 1;
  await page.setViewportSize({ width: 390, height: 844 });
  await fixture(page, data);
  const card = page.getByRole('region', { name: 'Model usage estimate' });
  await expect(card.getByText(/Learned from 50 completed tasks/)).toBeVisible();
  await expect(card.getByText(/1 model call has unresolved usage/)).toBeVisible();
  await card.getByText('How this purchase was sized').click();
  await expect(
    card.getByText(/Held-out check: 10 tasks; input error 8.0%, output error 12.0%/),
  ).toBeVisible();
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth - innerWidth),
  ).toBeLessThanOrEqual(1);
  const overflowing = await card
    .locator('[role="cell"]')
    .evaluateAll((cells) => cells.filter((c) => c.scrollWidth > c.clientWidth + 1).length);
  expect(overflowing).toBe(0);
  await card.screenshot({ path: info.outputPath('usage-estimate-phone.png') });
});

test('a settled legacy planning failure offers an explicit existing-quota repair', async ({
  page,
}) => {
  const data = pendingPlan();
  data.task.status = 'needs_attention';
  data.task.blockedReason =
    'The planning call settled, but its response is unavailable for recovery. No VM has been purchased.';
  data.planning = {
    attempt: 1,
    requestId: 'request',
    requestStatus: 'settled',
    finishReason: null,
    outputTokens: 2048,
    maximumOutputTokens: 2048,
    failureCode: 'missing_response',
    canRetry: true,
    hasSavedResponse: false,
  };
  await fixture(page, data);
  const card = page.getByRole('region', { name: 'Planning recovery' });
  await expect(card.getByText('Attempt 1 of 2', { exact: true })).toBeVisible();
  await expect(card.getByText(/2,048 output tokens used/)).toBeVisible();
  await expect(
    card.getByRole('button', { name: 'Retry planning with existing quota', exact: true }),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: 'Resume after review', exact: true })).toHaveCount(
    0,
  );
  const writes: string[] = [];
  await page.route('**/api/studio/tasks/' + id + '/retry-plan', async (route) => {
    writes.push(route.request().method());
    data.task.status = 'planning';
    data.task.blockedReason = null;
    data.planning = null;
    await route.fulfill({ json: data });
  });
  await card
    .getByRole('button', { name: 'Retry planning with existing quota', exact: true })
    .click();
  await expect(page.getByRole('region', { name: 'Planning recovery' })).toHaveCount(0);
  expect(writes).toEqual(['POST']);
});

test('unknown planning usage offers inspection without another generation', async ({ page }) => {
  const data = pendingPlan();
  data.task.status = 'needs_attention';
  data.task.blockedReason = 'The planning call has unresolved usage. It will not be resent.';
  data.planning = {
    attempt: 1,
    requestId: 'request',
    requestStatus: 'outcome_unknown',
    finishReason: null,
    outputTokens: null,
    maximumOutputTokens: 2048,
    failureCode: 'unresolved',
    canRetry: false,
    hasSavedResponse: false,
  };
  await fixture(page, data);
  await expect(page.getByText(/a replacement call will not be sent/)).toBeVisible();
  await expect(
    page.getByRole('button', { name: /Retry planning|Resume after review/ }),
  ).toHaveCount(0);
});

test('an exhausted planning repair shows its finish reason and remains readable on a phone', async ({
  page,
}, info) => {
  const data = pendingPlan();
  data.task.status = 'needs_attention';
  data.task.blockedReason =
    'Muse reached the 2,048-token planning response limit. The single planning repair has been used.';
  data.planning = {
    attempt: 2,
    requestId: 'request',
    requestStatus: 'settled',
    finishReason: 'length',
    outputTokens: 2048,
    maximumOutputTokens: 2048,
    failureCode: 'truncated',
    canRetry: false,
    hasSavedResponse: false,
  };
  await page.setViewportSize({ width: 390, height: 844 });
  await fixture(page, data);
  await expect(page.getByText(/Finish reason: length/)).toBeVisible();
  await expect(page.getByText('Attempt 2 of 2', { exact: true })).toBeVisible();
  await expect(
    page.getByRole('button', { name: /Retry planning|Resume after review/ }),
  ).toHaveCount(0);
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth - innerWidth),
  ).toBeLessThanOrEqual(1);
  await page.screenshot({ path: info.outputPath('planning-recovery-phone.png'), fullPage: true });
});

test('a saved response offers recovery before another paid generation', async ({ page }) => {
  const data = pendingPlan();
  data.planning = {
    attempt: 2,
    requestId: 'request',
    requestStatus: 'settled',
    finishReason: 'stop',
    outputTokens: 300,
    maximumOutputTokens: 2048,
    failureCode: null,
    canRetry: true,
    hasSavedResponse: true,
  };
  await fixture(page, data);
  await expect(
    page.getByText(/Recovery validates it before considering another model call/),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Resume saved planning response', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Retry planning with existing quota', exact: true }),
  ).toHaveCount(0);
});

async function composerFixture(page: Page, historyFailure = false) {
  const writes: string[] = [];
  await page.route('**/api/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (route.request().method() !== 'GET') writes.push(path);
    if (path === '/api/me')
      return route.fulfill({
        json: {
          user: { id: 'buyer', role: 'buyer', name: 'Alex Morgan' },
          modes: { wick: 'fixture', muse: 'fixture' },
          catalog: [],
        },
      });
    if (path === '/api/studio/options')
      return route.fulfill({ json: { available: true, mode: 'fixture', reason: '' } });
    if (path === '/api/credits') return route.fulfill({ json: { availableCents: 1000 } });
    if (path === '/api/disks/options')
      return route.fulfill({ json: { enabled: false, eligibleCatalogIds: [] } });
    if (path === '/api/studio/tasks')
      return route.fulfill(
        historyFailure
          ? { status: 503, json: { error: 'Saved tasks are temporarily unavailable.' } }
          : { json: { items: [], nextCursor: null } },
      );
    if (path === '/api/studio/tasks/' + id) return route.fulfill({ json: detail() });
    return route.fulfill({
      status: 500,
      json: { error: 'Unexpected presentation fixture request.' },
    });
  });
  await page.goto(historyFailure ? '/studio' : '/studio?new=1');
  return writes;
}

for (const width of [375, 768, 1440])
  test(`Studio composer and saved result share readable panels at ${width}px`, async ({
    page,
  }, info) => {
    await page.setViewportSize({ width, height: width === 375 ? 812 : 1000 });
    const writes = await composerFixture(page);
    await page
      .getByRole('textbox', { name: 'Task', exact: true })
      .fill('Fix the parser and verify the regression tests.');
    await page
      .getByRole('textbox', { name: 'Public repository', exact: true })
      .fill('https://github.com/example/project');
    await page.getByLabel('Maximum total spend · USD', { exact: true }).fill('2.3456');
    await expect(page.locator('main .button.primary:visible')).toHaveCount(1);
    const actionBounds = await page.getByRole('button', { name: /^Review task/ }).boundingBox();
    expect(actionBounds!.height).toBeGreaterThanOrEqual(42);
    expect(actionBounds!.height).toBeLessThanOrEqual(52);
    await expect(page.getByRole('region', { name: 'Before you start', exact: true })).toContainText(
      '$2.3456',
    );
    await expect(
      page.getByRole('link', { name: 'Use existing resources (advanced)', exact: true }),
    ).toHaveAttribute('href', '/studio/legacy');
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth - innerWidth),
    ).toBeLessThanOrEqual(1);
    await page.evaluate(() => {
      (document.activeElement as HTMLElement)?.blur();
      window.scrollTo(0, 0);
    });
    await page.screenshot({
      path: info.outputPath(`studio-composer-${width}.png`),
      fullPage: true,
    });
    await page.goto('/studio/tasks/' + id);
    await expect(page.getByRole('heading', { level: 1 })).toContainText('Add a greeting utility');
    await expect(page.locator('.page-heading [role="status"]')).toHaveText('Completed');
    await expect(page.getByText('Preparing the task', { exact: true })).toHaveCount(0);
    await expect(page.getByText('Implemented and tested.', { exact: true })).toBeVisible();
    await expect(page.getByRole('region', { name: 'Task budget', exact: true })).toContainText(
      'Returned',
    );
    await expect(
      page.getByRole('region', { name: 'Model usage estimate', exact: true }),
    ).toBeVisible();
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth - innerWidth),
    ).toBeLessThanOrEqual(1);
    await page.screenshot({ path: info.outputPath(`studio-task-${width}.png`), fullPage: true });
    expect(writes).toEqual([]);
  });

test('Studio rejects an over-budget draft before any purchase authorization', async ({ page }) => {
  const writes = await composerFixture(page);
  await page
    .getByRole('textbox', { name: 'Task', exact: true })
    .fill('Fix the parser and verify the regression tests.');
  await page
    .getByRole('textbox', { name: 'Public repository', exact: true })
    .fill('https://github.com/example/project');
  await page.getByLabel('Maximum total spend · USD', { exact: true }).fill('10.0001');
  await page.getByRole('button', { name: 'Review task · $10.0001 maximum', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText(
    'Add available Broker credit before starting this task.',
  );
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(writes).toEqual([]);
});

test('an initial Studio history failure still allows a new task to be reviewed without purchasing', async ({
  page,
}) => {
  const writes = await composerFixture(page, true);
  await expect(
    page.getByText('Saved tasks are temporarily unavailable.', { exact: true }),
  ).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Task', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'New task', exact: true }).click();
  await page
    .getByRole('textbox', { name: 'Task', exact: true })
    .fill('Fix the parser and verify the regression tests.');
  await page
    .getByRole('textbox', { name: 'Public repository', exact: true })
    .fill('https://github.com/example/project');
  await page.getByLabel('Maximum total spend · USD', { exact: true }).fill('2.3456');
  await page.getByRole('button', { name: 'Review task · $2.3456 maximum', exact: true }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await expect(
    page.getByRole('dialog').getByRole('button', { name: 'Start within $2.3456', exact: true }),
  ).toBeEnabled();
  expect(writes).toEqual([]);
});
