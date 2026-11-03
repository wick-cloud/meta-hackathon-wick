import { expect, test, type Page } from './table-review';
import type { Disk, DiskWorkspace } from '../../src/shared/disks';
import type { CatalogItem } from '../../src/shared/types';

// Every API call is intercepted; these cases cannot purchase compute or create upstream storage.
const diskId = '11111111-1111-4111-8111-111111111111';
const idleId = '22222222-2222-4222-8222-222222222222';
const busyId = '33333333-3333-4333-8333-333333333333';
const taskId = '44444444-4444-4444-8444-444444444444';
const now = new Date().toISOString();
async function capture(page: Page, name: string) {
  if (process.env.DISK_UI_REVIEW !== '1') return;
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: test.info().outputPath(name + '-desktop.png'), fullPage: true });
  const previous = page.viewportSize();
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(
    true,
  );
  await page.screenshot({ path: test.info().outputPath(name + '-mobile.png'), fullPage: true });
  if (previous) await page.setViewportSize(previous);
}
const disk: Disk = {
  id: diskId,
  name: 'research-workspace',
  status: 'ready',
  sourceMode: 'fixture',
  createdAt: now,
  updatedAt: now,
  cleanupPending: false,
  failureReason: null,
  workspaceCount: 2,
  attachmentCount: 2,
  canDelete: false,
};
const workspaces: DiskWorkspace[] = [
  {
    id: idleId,
    diskId,
    name: 'prototype',
    repositoryUrl: 'https://github.com/acme/customer-portal',
    commitSha: 'a'.repeat(40),
    initialized: true,
    activeTaskId: null,
    status: 'available',
    createdAt: now,
    updatedAt: now,
  },
  {
    id: busyId,
    diskId,
    name: 'market-research',
    repositoryUrl: 'https://github.com/acme/research',
    commitSha: 'b'.repeat(40),
    initialized: true,
    activeTaskId: taskId,
    status: 'in_use',
    createdAt: now,
    updatedAt: now,
  },
];

async function fixture(
  page: Page,
  {
    failCreateOnce = false,
    enabled = true,
    catalog: catalogOverride,
    eligibleCatalogIds = ['sku-native'],
    diskOptionsReady,
    translationCatalogId,
  }: {
    failCreateOnce?: boolean;
    enabled?: boolean;
    catalog?: CatalogItem[];
    eligibleCatalogIds?: string[];
    diskOptionsReady?: Promise<void>;
    translationCatalogId?: string;
  } = {},
) {
  const writes: { path: string; method: string; body: any }[] = [];
  let createCalls = 0;
  await page.route('**/api/**', async (route) => {
    const request = route.request(),
      path = new URL(request.url()).pathname;
    const method = request.method();
    const catalog =
      catalogOverride ??
      ['sku-native', 'sku-temporary'].map((id, index) => ({
        id,
        name: index ? 'Temporary Linux' : 'Persistent Linux',
        description: 'Fixture Linux environment',
        provider: index ? 'modal' : 'e2b',
        profile: 'small',
        cpu: 2,
        memoryGb: 4,
        region: 'us-east',
        durationMinutes: [15, 30, 60],
        approved: true,
      }));
    if (path === '/api/me')
      return route.fulfill({
        json: {
          user: {
            id: 'test-buyer',
            name: 'Alex Morgan',
            email: 'buyer@fixture.invalid',
            role: 'buyer',
          },
          modes: { wick: 'fixture', muse: 'fixture' },
          catalog,
        },
      });
    if (path === '/api/disks/options') {
      await diskOptionsReady;
      return route.fulfill({
        json: { enabled, mode: 'fixture', eligibleCatalogIds },
      });
    }
    if (path === '/api/muse/translate' && translationCatalogId) {
      writes.push({ path, method, body: request.postDataJSON() });
      const selected = catalog.find((item) => item.id === translationCatalogId)!;
      return route.fulfill({
        json: {
          proposal: {
            catalogId: selected.id,
            region: selected.region,
            durationMinutes: 30,
            requirements: { cpu: selected.cpu, memoryGb: selected.memoryGb },
          },
          receipt: { observed: [], constraints: [], decision: 'Fixture translation' },
          mode: 'fixture',
        },
      });
    }
    if (path === '/api/disks' && method === 'GET')
      return route.fulfill({ json: { items: [disk] } });
    if (path === '/api/disks' && method === 'POST') {
      writes.push({ path, method, body: request.postDataJSON() });
      createCalls++;
      if (failCreateOnce && createCalls === 1)
        return route.fulfill({
          status: 503,
          json: { error: 'Creation outcome is being reconciled. Retry with the same request.' },
        });
      return route.fulfill({
        json: { ...disk, name: request.postDataJSON().name, status: 'creating' },
      });
    }
    if (path === '/api/disks/' + diskId + '/workspaces')
      return route.fulfill({ json: { items: workspaces } });
    if (path === '/api/disks/' + diskId + '/files')
      return route.fulfill({ json: { prefix: '', entries: [] } });
    if (path === '/api/disks/' + diskId)
      return route.fulfill({
        json: {
          disk,
          workspaces,
          attachments: [
            {
              vmId: 'vm-e2b',
              environmentId: 'env-e2b',
              status: 'mounted',
              generation: 'gen-a',
              provider: 'e2b',
              vmName: 'Research agent',
              createdAt: now,
            },
            {
              vmId: 'vm-daytona',
              environmentId: 'env-daytona',
              status: 'mounted',
              generation: 'gen-b',
              provider: 'daytona',
              vmName: 'Report agent',
              createdAt: now,
            },
          ],
        },
      });
    if (path === '/api/studio/options')
      return route.fulfill({ json: { available: true, reason: '', mode: 'fixture' } });
    if (path === '/api/credits') return route.fulfill({ json: { availableCents: 1000 } });
    if (path === '/api/studio/tasks' && method === 'GET')
      return route.fulfill({ json: { items: [], nextCursor: null } });
    if (path === '/api/studio/tasks' && method === 'POST') {
      writes.push({ path, method, body: request.postDataJSON() });
      return route.fulfill({ json: { id: taskId } });
    }
    if (path === '/api/requests' && method === 'POST') {
      writes.push({ path, method, body: request.postDataJSON() });
      return route.fulfill({ json: { id: 'new-request' } });
    }
    return route.fulfill({ status: 404, json: { error: 'Fixture resource unavailable.' } });
  });
  return writes;
}

test('creates a private disk and preserves the operation identity after an uncertain response', async ({
  page,
}) => {
  const writes = await fixture(page, { failCreateOnce: true });
  await page.goto('/disks');
  await expect(page.getByText('Only you can access these disks')).toBeVisible();
  await capture(page, 'disk-inventory');
  await page.getByRole('button', { name: 'Create disk', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await dialog.getByLabel('Disk name').fill('customer-support');
  await capture(page, 'disk-create');
  await dialog.getByRole('button', { name: 'Create disk', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('reconciled');
  await dialog.getByRole('button', { name: 'Create disk', exact: true }).click();
  await expect(page).toHaveURL(new RegExp('/disks/' + diskId));
  expect(writes).toHaveLength(2);
  expect(writes[0]!.body).toEqual(writes[1]!.body);
  expect(writes[0]!.body.name).toBe('customer-support');
  expect(Object.keys(writes[0]!.body).sort()).toEqual(['name', 'operationKey']);
});

test('shows simultaneous provider attachments and continues only an idle workspace', async ({
  page,
}) => {
  await fixture(page);
  await page.goto('/disks/' + diskId);
  const attached = page.getByRole('table', { name: 'Attached VMs', exact: true });
  await expect(attached).toContainText('Research agent');
  await expect(attached).toContainText('Report agent');
  await expect(page.getByRole('button', { name: 'Delete disk', exact: true })).toBeDisabled();
  await capture(page, 'disk-detail');
  const busy = page
    .getByRole('table', { name: 'Agent workspaces', exact: true })
    .getByRole('row')
    .filter({ hasText: 'market-research' });
  await expect(busy.getByRole('button', { name: 'Continue', exact: true })).toBeDisabled();
  await page.getByRole('link', { name: 'Continue in Studio' }).click();
  await expect(page).toHaveURL(new RegExp('workspaceId=' + idleId));
  await expect(page.getByLabel('Agent workspace')).toHaveValue(idleId);
  await expect(page.getByLabel('Public repository')).toHaveValue(workspaces[0]!.repositoryUrl);
  await expect(page.getByLabel('Public repository')).toHaveAttribute('readonly', '');
  await capture(page, 'studio-continuation');
});

test('includes the disk and existing workspace in the reviewed Studio start', async ({ page }) => {
  const writes = await fixture(page);
  await page.goto('/studio?new=1&diskId=' + diskId + '&workspaceId=' + idleId);
  await expect(page.getByLabel('Agent workspace')).toHaveValue(idleId);
  await expect(page.getByLabel('Public repository')).toHaveValue(workspaces[0]!.repositoryUrl);
  await page
    .getByLabel('Task', { exact: true })
    .fill('Continue the existing onboarding flow and validate its tests.');
  await page.getByRole('button', { name: /^Review task/ }).click();
  await expect(page.getByRole('dialog')).toContainText('Continue prototype');
  await page
    .getByRole('dialog')
    .getByRole('button', { name: /^Start within/ })
    .click();
  await expect.poll(() => writes.length).toBe(1);
  expect(writes[0]!.body).toMatchObject({
    diskId,
    workspaceId: idleId,
    repositoryUrl: workspaces[0]!.repositoryUrl,
  });
});

test('matches only disk-qualified routes and sends the selected disk', async ({ page }) => {
  const writes = await fixture(page);
  await page.addInitScript(() =>
    sessionStorage.setItem(
      'wick-draft',
      JSON.stringify({
        description: 'Persistent development environment',
        catalogId: 'sku-native',
        region: 'us-east',
        durationMinutes: 30,
        maxPriceCents: 100,
        requirements: { cpu: 2, memoryGb: 4 },
      }),
    ),
  );
  await page.goto('/requests/review');
  await page.getByLabel('Workspace disk · optional').selectOption(diskId);
  await expect(page.getByRole('combobox', { name: /configuration|region/i })).toHaveCount(0);
  await page.getByRole('button', { name: 'Start 30-second auction' }).click();
  await expect.poll(() => writes.length).toBe(1);
  expect(writes[0]!.body).toMatchObject({
    diskId,
    catalogId: 'sku-native',
    region: 'any',
    matchAcrossProviders: true,
  });
});

const shapeCatalog: CatalogItem[] = [
  {
    id: 'daytona:small:us',
    name: 'Small · Daytona',
    description: 'Temporary filesystem',
    provider: 'daytona',
    profile: 'small',
    cpu: 2,
    memoryGb: 4,
    region: 'us',
    durationMinutes: [15, 30, 60],
    approved: true,
    capabilities: ['shared-files'],
  },
  {
    id: 'e2b:small:us',
    name: 'Small · E2B',
    description: 'Native shared mount',
    provider: 'e2b',
    profile: 'small',
    cpu: 2,
    memoryGb: 4,
    region: 'us',
    durationMinutes: [15, 30, 60],
    approved: true,
    capabilities: ['persistent-drives'],
  },
  {
    id: 'modal:large:auto',
    name: 'Large · Modal',
    description: 'Larger native shared mount',
    provider: 'modal',
    profile: 'large',
    cpu: 8,
    memoryGb: 16,
    region: 'auto',
    durationMinutes: [15, 30, 60],
    approved: true,
    capabilities: ['persistent-drives'],
  },
];
const diskShapes = shapeCatalog.slice(1).map((item) => item.id);

test('waits for disk routes and defaults a new disk-linked rental to a supported shape', async ({
  page,
}) => {
  let releaseOptions!: () => void;
  const diskOptionsReady = new Promise<void>((resolve) => {
    releaseOptions = resolve;
  });
  const writes = await fixture(page, {
    catalog: shapeCatalog,
    eligibleCatalogIds: diskShapes,
    diskOptionsReady,
  });
  try {
    await page.goto('/new/vm?diskId=' + diskId);
    await expect(page.getByRole('status')).toHaveText('Checking disk-compatible configurations');
    await expect(page.getByRole('button', { name: 'Review manually', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Review manually', exact: true })).toBeDisabled();
    releaseOptions();
    await page.getByRole('button', { name: 'Review manually', exact: true }).click();
    await expect(page).toHaveURL(/\/requests\/review$/);
    await expect(page.getByRole('combobox', { name: /configuration|region/i })).toHaveCount(0);
    await expect(page.getByLabel('Workspace disk · optional')).toHaveValue(diskId);
    await expect(page.getByLabel('Minimum vCPUs', { exact: true })).toHaveValue('2');
    await expect(page.getByLabel('Minimum memory (GiB)', { exact: true })).toHaveValue('4');
    await expect(page.getByRole('alert')).toHaveCount(0);
    expect(writes).toEqual([]);
    await page.getByRole('button', { name: 'Start 30-second auction' }).click();
    await expect.poll(() => writes.length).toBe(1);
    expect(writes[0]!.body).toMatchObject({
      catalogId: 'e2b:small:us',
      diskId,
      region: 'any',
      matchAcrossProviders: true,
      requirements: { cpu: 2, memoryGb: 4 },
    });
  } finally {
    releaseOptions();
  }
});

test('adding a disk preserves reviewed resources and finds a qualified provider', async ({
  page,
}) => {
  const previous = {
    ...shapeCatalog[0]!,
    id: 'daytona:large:us',
    name: 'Large · Daytona',
    profile: 'large',
    cpu: 8,
    memoryGb: 16,
  };
  const writes = await fixture(page, {
    catalog: [...shapeCatalog, previous],
    eligibleCatalogIds: diskShapes,
  });
  await page.addInitScript(() =>
    sessionStorage.setItem(
      'wick-draft',
      JSON.stringify({
        description: 'Previously reviewed larger environment',
        catalogId: 'daytona:large:us',
        region: 'us',
        durationMinutes: 60,
        maxPriceCents: 200,
        requirements: { cpu: 4, memoryGb: 12 },
      }),
    ),
  );
  await page.goto('/new/vm?diskId=' + diskId);
  await page.getByRole('button', { name: 'Review manually', exact: true }).click();
  await expect(page.getByRole('combobox', { name: /configuration|region/i })).toHaveCount(0);
  await expect(page.getByLabel('Minimum vCPUs', { exact: true })).toHaveValue('4');
  await expect(page.getByLabel('Minimum memory (GiB)', { exact: true })).toHaveValue('12');
  await expect(page.getByRole('alert')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Start 30-second auction' })).toBeEnabled();
  const saved = await page.evaluate(() => JSON.parse(sessionStorage.getItem('wick-draft')!));
  expect(saved).toMatchObject({
    diskId,
    durationMinutes: 60,
    requirements: { cpu: 4, memoryGb: 12 },
  });
  expect(writes).toEqual([]);
  await page.getByRole('button', { name: 'Start 30-second auction' }).click();
  await expect.poll(() => writes.length).toBe(1);
  expect(writes[0]!.body).toMatchObject({
    catalogId: 'modal:large:auto',
    diskId,
    region: 'any',
    matchAcrossProviders: true,
    durationMinutes: 60,
    requirements: { cpu: 4, memoryGb: 12 },
  });
});

test('reconciles a Muse disk proposal through a qualified provider without changing its resources', async ({
  page,
}) => {
  const writes = await fixture(page, {
    catalog: shapeCatalog,
    eligibleCatalogIds: diskShapes,
    translationCatalogId: 'daytona:small:us',
  });
  await page.goto('/new/vm?diskId=' + diskId);
  await page.getByLabel('Describe your environment').fill('A shared disk environment');
  await page.getByRole('button', { name: 'Prepare with Muse' }).click();
  await expect(page).toHaveURL(/\/requests\/review$/);
  await expect(page.getByRole('alert')).toHaveCount(0);
  await expect(page.getByLabel('Minimum vCPUs', { exact: true })).toHaveValue('2');
  await expect(page.getByLabel('Minimum memory (GiB)', { exact: true })).toHaveValue('4');
  await expect(page.getByRole('button', { name: 'Start 30-second auction' })).toBeEnabled();
  expect(writes.map((write) => write.path)).toEqual(['/api/muse/translate']);
  await page.getByRole('button', { name: 'Start 30-second auction' }).click();
  await expect.poll(() => writes.length).toBe(2);
  expect(writes[1]!.body).toMatchObject({
    catalogId: 'e2b:small:us',
    diskId,
    region: 'any',
    matchAcrossProviders: true,
    durationMinutes: 30,
    requirements: { cpu: 2, memoryGb: 4 },
  });
});

test('shows disk unavailability before preparing a linked VM rental', async ({ page }) => {
  const writes = await fixture(page, {
    catalog: shapeCatalog,
    enabled: false,
    eligibleCatalogIds: diskShapes,
  });
  await page.goto('/new/vm?diskId=' + diskId);
  await expect(page.getByRole('alert')).toContainText('Disk support is currently unavailable');
  await expect(page.getByRole('button', { name: 'Review manually', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Prepare with Muse' })).toBeDisabled();
  expect(writes).toEqual([]);
});

test('keeps the drawer within a narrow viewport and closes it with Escape', async ({ page }) => {
  await fixture(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/disks');
  await page.getByRole('button', { name: 'Create disk', exact: true }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(
    true,
  );
  const box = await page.getByRole('dialog').boundingBox();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.width).toBeLessThanOrEqual(390);
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
});

test('shows a clear unavailable state when the operator has disabled disks', async ({ page }) => {
  await fixture(page, { enabled: false });
  await page.goto('/disks');
  await expect(page.getByRole('heading', { name: 'Disk support is not enabled' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Create disk', exact: true })).toHaveCount(0);
});
