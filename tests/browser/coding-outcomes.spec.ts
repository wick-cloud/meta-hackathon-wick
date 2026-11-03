import { expect, test, type Page } from './table-review';
import {
  completedCodingDetail,
  codingJobId,
  studioTaskId,
  uncertainStep,
} from '../fixtures/coding-detail';
import type { CodingDetail } from '../../src/shared/coding';

async function fixture(page: Page, getDetail: () => CodingDetail | null) {
  const writes: string[] = [];
  let reads = 0;
  await page.route('**/api/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (route.request().method() !== 'GET') writes.push(path);
    if (path === '/api/me')
      return route.fulfill({
        json: {
          user: { id: 'buyer', role: 'buyer', name: 'Alex Morgan', email: 'buyer@fixture.invalid' },
          modes: { wick: 'fixture', muse: 'fixture' },
          catalog: [],
        },
      });
    if (path === '/api/coding/jobs/' + codingJobId) {
      reads++;
      const data = getDetail();
      return route.fulfill(
        data ? { json: data } : { status: 404, json: { error: 'Coding job not found.' } },
      );
    }
    return route.fulfill({ status: 500, json: { error: 'Unexpected fixture request: ' + path } });
  });
  await page.goto('/studio/jobs/' + codingJobId);
  return { writes, reads: () => reads };
}

test('completed execution leads with retained success and keeps the initial traceback collapsed', async ({
  page,
}) => {
  const detail = completedCodingDetail(),
    f = await fixture(page, () => detail);
  await expect(
    page.getByRole('heading', { name: 'Add a greeting utility and tests.', exact: true }),
  ).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Completed', exact: true })).toBeVisible();
  await expect(page.getByText('Original deadline', { exact: false })).toBeVisible();
  await expect(
    page.getByRole('link', { name: 'Back to Studio task', exact: true }),
  ).toHaveAttribute('href', '/studio/tasks/' + studioTaskId);
  await expect(page.getByRole('link', { name: 'Open VM terminal', exact: true })).toHaveCount(0);
  await expect(page.getByText('The patch is in the job clone', { exact: false })).toHaveCount(0);
  await page.getByRole('tab', { name: 'Test output', exact: true }).click();
  await expect(page.getByText('Ran 3 tests\nOK', { exact: true })).toBeVisible();
  await expect(page.getByText(/ImportError: Start directory/)).not.toBeVisible();
  await page.getByText('Earlier test runs (1)', { exact: true }).click();
  await expect(page.getByText(/ImportError: Start directory/)).toBeVisible();
  await expect(page.getByText('Could not start', { exact: true })).toBeVisible();
  await page.getByText('Execution history · 5 recorded steps', { exact: true }).click();
  await expect(page.locator('.coding-timeline li.warning')).toContainText('Could not start');
  expect(f.writes).toEqual([]);
});

test('a failed verification is visible and routes a Studio user to its owning task', async ({
  page,
}) => {
  const detail = completedCodingDetail();
  detail.job.status = 'paused';
  detail.job.testsPassed = false;
  detail.job.blockedReason = 'The verification command failed.';
  detail.parentTask!.status = 'needs_attention';
  detail.vm!.status = 'running';
  detail.vm!.cleanupConfirmedAt = null;
  detail.steps[3]!.result = {
    state: 'completed',
    result: { exitCode: 1, output: 'AssertionError: wrong greeting' },
  };
  const f = await fixture(page, () => detail);
  await expect(page.getByRole('heading', { name: 'Needs attention', exact: true })).toBeVisible();
  await expect(page.getByText('The verification command failed.', { exact: true })).toBeVisible();
  await page.getByRole('tab', { name: 'Test output', exact: true }).click();
  await expect(page.getByText('AssertionError: wrong greeting', { exact: true })).toBeVisible();
  await expect(page.getByText('Failed', { exact: true })).toBeVisible();
  await expect(page.getByText('Passed after last edit', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Resume execution', exact: true })).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'View Studio task', exact: true })).toBeVisible();
  expect(f.writes).toEqual([]);
});

test('uncertain inference preserves its held quota and presents inspection without replacement generation', async ({
  page,
}) => {
  const detail = completedCodingDetail();
  detail.job.status = 'uncertain';
  detail.job.testsPassed = false;
  detail.parentTask!.status = 'needs_attention';
  detail.steps = [uncertainStep()];
  const f = await fixture(page, () => detail);
  await expect(
    page.getByRole('heading', { name: 'Result needs reconciliation', exact: true }),
  ).toBeVisible();
  await expect(page.getByText(/do not send a replacement request/)).toBeVisible();
  await expect(page.getByText(/Usage reservations stay held/)).toBeVisible();
  await page.getByRole('tab', { name: 'Meta activity', exact: true }).click();
  await page.getByText('Model request', { exact: true }).click();
  await expect(page.getByText(/Held output 2,048/)).toBeVisible();
  await expect(page.getByRole('button', { name: /Resume|Retry|Start/ })).toHaveCount(0);
  expect(f.writes).toEqual([]);
});

test('a ready coding job continues polling while Studio cleans up and stops after parent completion', async ({
  page,
}) => {
  const detail = completedCodingDetail();
  detail.parentTask!.status = 'cleaning_up';
  detail.vm!.status = 'terminating';
  detail.vm!.cleanupConfirmedAt = null;
  const f = await fixture(page, () => detail);
  await expect(
    page.getByRole('heading', { name: 'Cleanup in progress', exact: true }),
  ).toBeVisible();
  detail.parentTask!.status = 'completed';
  detail.vm!.status = 'terminated';
  detail.vm!.cleanupConfirmedAt = new Date().toISOString();
  await expect(page.getByRole('heading', { name: 'Completed', exact: true })).toBeVisible({
    timeout: 8000,
  });
  const count = f.reads();
  await page.waitForTimeout(4000);
  expect(f.reads()).toBe(count);
  expect(f.writes).toEqual([]);
});

test('an unavailable saved job has a read-only recovery action', async ({ page }) => {
  let visible = false;
  const f = await fixture(page, () => (visible ? completedCodingDetail() : null));
  await expect(
    page.getByRole('heading', { name: 'Could not load execution details', exact: true }),
  ).toBeVisible();
  visible = true;
  await page.getByRole('button', { name: 'Reload details', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Completed', exact: true })).toBeVisible();
  expect(f.writes).toEqual([]);
});

test('expired artifacts and stale test passes never advertise a current downloadable verified patch', async ({
  page,
}) => {
  const detail = completedCodingDetail();
  detail.artifactsExpired = true;
  detail.steps = [];
  await fixture(page, () => detail);
  await expect(
    page.getByRole('heading', { name: 'Patch retention ended', exact: true }),
  ).toBeVisible();
  await expect(page.getByRole('link', { name: 'Download patch', exact: true })).toHaveCount(0);
  await page.getByRole('tab', { name: 'Test output', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Test output retention ended', exact: true }),
  ).toBeVisible();
});

test('a passing run before a later edit is explicitly marked as needing fresh verification', async ({
  page,
}) => {
  const detail = completedCodingDetail();
  detail.parentTask = null;
  detail.job.status = 'paused';
  detail.job.testsPassed = false;
  detail.steps.push({ ...detail.steps[1]!, id: 'later-write', sequence: 6 });
  await fixture(page, () => detail);
  await page.getByRole('tab', { name: 'Test output', exact: true }).click();
  await expect(page.getByText('Fresh verification needed', { exact: true })).toBeVisible();
  await expect(page.getByText('Passed after last edit', { exact: true })).toHaveCount(0);
});

for (const width of [375, 768, 1440])
  test(`completed execution remains readable at ${width}px`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: width === 375 ? 812 : 1000 });
    await fixture(page, completedCodingDetail);
    await page.getByRole('tab', { name: 'Test output', exact: true }).click();
    await expect(page.getByText('Ran 3 tests\nOK', { exact: true })).toBeVisible();
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth - innerWidth),
    ).toBeLessThanOrEqual(1);
    await page.screenshot({
      path: info.outputPath(`coding-execution-${width}.png`),
      fullPage: true,
    });
  });

test('an inspection error offers a read-only refresh and never starts a replacement job', async ({
  page,
}) => {
  const detail = completedCodingDetail();
  detail.parentTask = null;
  detail.job.status = 'uncertain';
  detail.job.testsPassed = false;
  detail.vm!.status = 'running';
  detail.vm!.cleanupConfirmedAt = null;
  detail.steps = [{ ...detail.steps[1]!, kind: 'command', status: 'dispatching', result: null }];
  const f = await fixture(page, () => detail);
  await page.getByRole('button', { name: 'Inspect existing command', exact: true }).click();
  await expect(page.getByText('Could not update execution', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Reload details', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Result needs reconciliation', exact: true }),
  ).toBeVisible();
  expect(f.writes).toEqual(['/api/coding/jobs/' + codingJobId + '/reconcile']);
});
