import { expect, test, type Page, type Route } from './table-review';
import type { Disk, DiskFilePage, DiskFilePreview } from '../../src/shared/disks';

// All APIs are intercepted. These UI cases never allocate storage or VMs.
const diskId = '11111111-1111-4111-8111-111111111111';
const disk: Disk = {
  id: diskId,
  name: 'research-workspace',
  status: 'ready',
  sourceMode: 'fixture',
  createdAt: '2026-11-03T00:00:00Z',
  updatedAt: '2026-11-03T00:00:00Z',
  cleanupPending: false,
  failureReason: null,
  workspaceCount: 0,
  attachmentCount: 0,
  canDelete: true,
};
type Reply = { status?: number; json: unknown };

async function fixture(
  page: Page,
  {
    listing,
    preview = async (key: string) => ({
      json: { key, size: 5, content: 'hello', truncated: false, binary: false },
    }),
    diskOverride = {},
  }: {
    listing: (prefix: string, token: string | null) => Promise<Reply> | Reply;
    preview?: (key: string) => Promise<Reply> | Reply;
    diskOverride?: Partial<Disk>;
  },
) {
  const requests: { path: string; method: string; prefix: string | null; key: string | null }[] =
    [];
  await page.route('**/api/**', async (route: Route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    requests.push({
      path,
      method: request.method(),
      prefix: url.searchParams.get('prefix'),
      key: url.searchParams.get('key'),
    });
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
          catalog: [],
        },
      });
    if (path === '/api/disks/options')
      return route.fulfill({ json: { enabled: true, mode: 'fixture', eligibleCatalogIds: [] } });
    if (path === '/api/disks/' + diskId)
      return route.fulfill({
        json: { disk: { ...disk, ...diskOverride }, attachments: [], workspaces: [] },
      });
    if (path === '/api/disks/' + diskId + '/files')
      return route
        .fulfill(
          await listing(
            url.searchParams.get('prefix') ?? '',
            url.searchParams.get('continuationToken'),
          ),
        )
        .catch(() => undefined);
    if (path === '/api/disks/' + diskId + '/file')
      return route.fulfill(await preview(url.searchParams.get('key')!)).catch(() => undefined);
    return route.fulfill({ status: 404, json: { error: 'Fixture resource unavailable.' } });
  });
  return requests;
}

function pageOf(
  prefix: string,
  entries: DiskFilePage['entries'],
  nextContinuationToken?: string,
): Reply {
  return { json: { prefix, entries, ...(nextContinuationToken ? { nextContinuationToken } : {}) } };
}

function fileOf(key: string, values: Partial<DiskFilePreview> = {}): Reply {
  return { json: { key, size: 5, content: 'hello', truncated: false, binary: false, ...values } };
}

async function capture(page: Page) {
  if (process.env.DISK_UI_REVIEW !== '1') return;
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: test.info().outputPath('disk-files-desktop.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth - innerWidth),
  ).toBeLessThanOrEqual(1);
  await page.screenshot({ path: test.info().outputPath('disk-files-mobile.png'), fullPage: true });
}

test('browses nested saved folders and safely previews a file with no VMs attached', async ({
  page,
}) => {
  const content =
    '<script>window.__diskPreviewExecuted = true</script>\nShared file from the E2B VM.\n';
  const requests = await fixture(page, {
    listing: (prefix) =>
      prefix === ''
        ? pageOf(prefix, [{ key: 'workspaces/', name: 'workspaces', kind: 'directory' }])
        : prefix === 'workspaces/'
          ? pageOf(prefix, [{ key: 'workspaces/project/', name: 'project', kind: 'directory' }])
          : pageOf(prefix, [
              {
                key: 'workspaces/project/probe.txt',
                name: 'probe.txt',
                kind: 'file',
                size: content.length,
              },
            ]),
    preview: (key) => fileOf(key, { content, size: content.length }),
  });
  await page.goto('/disks/' + diskId);
  await expect(page.getByRole('heading', { name: 'No attached VMs' })).toBeVisible();
  await page.getByRole('button', { name: 'Open folder workspaces' }).click();
  await page.getByRole('button', { name: 'Open folder project' }).click();
  await expect(page.getByRole('navigation', { name: 'Disk folders' })).toContainText('project');
  await page.getByRole('button', { name: 'Preview probe.txt' }).click();
  const preview = page.getByRole('region', { name: 'File preview' });
  await expect(preview.getByLabel('File contents')).toHaveText(content);
  await expect(preview).toContainText('/workspace/workspaces/project/probe.txt');
  expect(
    await page.evaluate(() => (window as unknown as Record<string, unknown>).__diskPreviewExecuted),
  ).toBeUndefined();
  await capture(page);
  await page.getByRole('button', { name: 'Close file preview' }).click();
  await expect(page.getByRole('button', { name: 'Preview probe.txt' })).toBeFocused();
  await page.getByRole('button', { name: 'Up one folder' }).click();
  await expect(page.getByRole('button', { name: 'Open folder project' })).toBeVisible();
  await page.getByRole('button', { name: '/workspace', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Open folder workspaces' })).toBeVisible();
  expect(requests.every((request) => request.method === 'GET')).toBe(true);
  expect(
    requests.some(
      (request) => request.path.endsWith('/files') && request.prefix === 'workspaces/project/',
    ),
  ).toBe(true);
});

test('retries list failures and refreshes an empty folder', async ({ page }) => {
  let phase = 0;
  await fixture(page, {
    listing: (prefix) => {
      if (phase === 0)
        return { status: 503, json: { error: 'Disk files are temporarily unavailable.' } };
      return pageOf(
        prefix,
        phase === 1 ? [] : [{ key: 'new.txt', name: 'new.txt', kind: 'file', size: 0 }],
      );
    },
    preview: (key) => fileOf(key, { size: 0, content: '' }),
  });
  await page.goto('/disks/' + diskId);
  const panel = page.getByRole('region', { name: 'Disk files', exact: true });
  await expect(panel.getByRole('alert')).toContainText('temporarily unavailable');
  phase = 1;
  await panel.getByRole('button', { name: 'Try again', exact: true }).click();
  await expect(panel.getByRole('heading', { name: 'This folder is empty' })).toBeVisible();
  phase = 2;
  await panel.getByRole('button', { name: 'Refresh files' }).click();
  await panel.getByRole('button', { name: 'Preview new.txt' }).click();
  await expect(panel.getByRole('heading', { name: 'This file is empty' })).toBeVisible();
});

test('shows binary, oversized and truncated preview states without rendering old content', async ({
  page,
}) => {
  await fixture(page, {
    listing: (prefix) =>
      pageOf(
        prefix,
        ['image.bin', 'large.bin', 'notes.txt'].map((name) => ({
          key: name,
          name,
          kind: 'file',
          size: name === 'large.bin' ? 2 * 1024 * 1024 : 100000,
        })),
      ),
    preview: (key) =>
      key === 'large.bin'
        ? {
            status: 413,
            json: { error: 'This file is too large to preview. Open it from an attached VM.' },
          }
        : fileOf(
            key,
            key === 'image.bin'
              ? { content: null, binary: true }
              : { size: 100000, content: 'The first part of a long text file.', truncated: true },
          ),
  });
  await page.goto('/disks/' + diskId);
  await page.getByRole('button', { name: 'Preview image.bin' }).click();
  await expect(page.getByRole('heading', { name: 'No text preview' })).toBeVisible();
  await page.getByRole('button', { name: 'Preview large.bin' }).click();
  const preview = page.getByRole('region', { name: 'File preview' });
  await expect(preview.getByRole('alert')).toContainText('too large');
  await expect(preview.getByRole('heading', { name: 'No text preview' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Preview notes.txt' }).click();
  await expect(preview).toContainText('Showing the first 64 KiB');
  await expect(preview.getByLabel('File contents')).toHaveText(
    'The first part of a long text file.',
  );
});

test('paginates files without duplicate folders and retries a failed next page', async ({
  page,
}) => {
  let nextCalls = 0;
  const folder = { key: 'project/', name: 'project', kind: 'directory' as const };
  await fixture(page, {
    listing: (prefix, token) => {
      if (!token) return pageOf(prefix, [folder], 'page-two');
      expect(token).toBe('page-two');
      nextCalls++;
      if (nextCalls === 1)
        return { status: 503, json: { error: 'The next file page is unavailable.' } };
      return pageOf(prefix, [
        folder,
        { key: 'saved.txt', name: 'saved.txt', kind: 'file', size: 5 },
      ]);
    },
  });
  await page.goto('/disks/' + diskId);
  await page.getByRole('button', { name: 'Load more files' }).click();
  const panel = page.getByRole('region', { name: 'Disk files', exact: true });
  await expect(panel.getByRole('alert')).toContainText('next file page');
  await panel.getByRole('button', { name: 'Try loading more again' }).click();
  await expect(panel.getByRole('button', { name: 'Preview saved.txt' })).toBeVisible();
  await expect(panel.getByRole('button', { name: 'Open folder project' })).toHaveCount(1);
  await expect(panel.getByRole('button', { name: 'Load more files' })).toHaveCount(0);
});

test('ignores a late preview response after another file is selected', async ({ page }) => {
  let release!: () => void;
  const delayed = new Promise<void>((resolve) => {
    release = resolve;
  });
  let firstStarted = false;
  await fixture(page, {
    listing: (prefix) =>
      pageOf(
        prefix,
        ['first.txt', 'second.txt'].map((name) => ({ key: name, name, kind: 'file', size: 5 })),
      ),
    preview: async (key) => {
      if (key === 'first.txt') {
        firstStarted = true;
        await delayed;
      }
      return fileOf(key, {
        content: key === 'first.txt' ? 'stale first file' : 'current second file',
      });
    },
  });
  await page.goto('/disks/' + diskId);
  await page.getByRole('button', { name: 'Preview first.txt' }).click();
  await expect.poll(() => firstStarted).toBe(true);
  await page.getByRole('button', { name: 'Preview second.txt' }).click();
  const preview = page.getByRole('region', { name: 'File preview' });
  await expect(preview.getByLabel('File contents')).toHaveText('current second file');
  release();
  await expect(preview.getByRole('heading', { name: 'second.txt', exact: true })).toBeVisible();
  await expect(preview.getByLabel('File contents')).toHaveText('current second file');
});

test('reloads the selected file when clicked again during and after a pending preview', async ({
  page,
}) => {
  let release!: () => void;
  const delayed = new Promise<void>((resolve) => {
    release = resolve;
  });
  let calls = 0;
  await fixture(page, {
    listing: (prefix) =>
      pageOf(prefix, [{ key: 'probe.txt', name: 'probe.txt', kind: 'file', size: 5 }]),
    preview: async (key) => {
      const call = ++calls;
      if (call === 1) await delayed;
      return fileOf(key, { content: `Saved version ${call}` });
    },
  });
  await page.goto('/disks/' + diskId);
  const button = page.getByRole('button', { name: 'Preview probe.txt' });
  await button.click();
  await expect.poll(() => calls).toBe(1);
  await button.click();
  const content = page.getByRole('region', { name: 'File preview' }).getByLabel('File contents');
  await expect(content).toHaveText('Saved version 2');
  release();
  await button.click();
  await expect(content).toHaveText('Saved version 3');
});

test('ignores a late folder page after navigating back to the disk root', async ({ page }) => {
  let release!: () => void;
  const delayed = new Promise<void>((resolve) => {
    release = resolve;
  });
  let nestedStarted = false;
  await fixture(page, {
    listing: async (prefix) => {
      if (!prefix) return pageOf('', [{ key: 'project/', name: 'project', kind: 'directory' }]);
      nestedStarted = true;
      await delayed;
      return pageOf(prefix, [
        { key: 'project/stale.txt', name: 'stale.txt', kind: 'file', size: 5 },
      ]);
    },
  });
  await page.goto('/disks/' + diskId);
  await page.getByRole('button', { name: 'Open folder project' }).click();
  await expect.poll(() => nestedStarted).toBe(true);
  await page.getByRole('button', { name: '/workspace', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Open folder project' })).toBeVisible();
  release();
  await expect(page.getByRole('button', { name: 'Preview stale.txt' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Open folder project' })).toBeVisible();
});

test('does not fetch files while the disk is creating', async ({ page }) => {
  const requests = await fixture(page, {
    listing: () => pageOf('', []),
    diskOverride: { status: 'creating' },
  });
  await page.goto('/disks/' + diskId);
  await expect(page.getByRole('heading', { name: 'Files are unavailable' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Refresh files' })).toBeDisabled();
  expect(requests.filter((request) => request.path.endsWith('/files'))).toHaveLength(0);
});
