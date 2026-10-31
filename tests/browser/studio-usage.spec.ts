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
  await expect(card.getByRole('rowheader', { name: 'Expected task' })).toBeVisible();
  await expect(card.getByRole('rowheader', { name: 'Purchased', exact: true })).toBeVisible();
  await expect(card.getByRole('cell', { name: '1.8%', exact: true })).toBeVisible();
  await expect(card.getByText(/90% target cannot be reached/)).toBeVisible();
  await card.getByText('How this purchase was sized').click();
  await expect(card.getByText(/Not enough completed tasks/)).toBeVisible();
  await card.screenshot({ path: info.outputPath('usage-estimate-desktop.png') });
  expect(writes).toEqual([]);
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
