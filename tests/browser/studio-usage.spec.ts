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
