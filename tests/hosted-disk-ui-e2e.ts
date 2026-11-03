/** Opt-in real hosted disk UI mutations. No VM, inference, fixture or SQL calls.
 * Run with RUN_HOSTED_DISK_UI_E2E=1 and existing SEED_BUYER_* credentials.
 * A private journal supports cleanup after interruption; ACTION=cleanup never creates.
 */
import { chromium, expect, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { dirname, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { Disk, DiskDetail, DiskOptions } from '../src/shared/disks.js';

class ProbeFailure extends Error {}
function check(value: unknown, code: string): asserts value {
  if (!value) throw new ProbeFailure(code);
}
check(process.env.RUN_HOSTED_DISK_UI_E2E === '1', 'EXPLICIT_HOSTED_UI_OPT_IN_REQUIRED');
const production = 'https://meta-hackathon-wick-production.up.railway.app';
const supplied = new URL(process.env.HOSTED_E2E_BASE_URL ?? production);
check(
  supplied.origin === production &&
    supplied.pathname === '/' &&
    !supplied.search &&
    !supplied.hash &&
    !supplied.username &&
    !supplied.password,
  'EXPECTED_PRODUCTION_ORIGIN_REQUIRED',
);
const baseUrl = supplied.origin;
const cleanupOnly = process.env.HOSTED_DISK_UI_E2E_ACTION === 'cleanup';
check(!process.env.HOSTED_DISK_UI_E2E_ACTION || cleanupOnly, 'UNSUPPORTED_PROBE_ACTION');
const email = process.env.SEED_BUYER_EMAIL ?? 'buyer@demo.wick.local';
const password = process.env.SEED_BUYER_PASSWORD;
check(password, 'EXISTING_BUYER_PASSWORD_REQUIRED');
const reportFile = resolve(
  process.env.HOSTED_DISK_UI_E2E_REPORT_FILE ?? 'verification-results/hosted-disk-ui-e2e.json',
);
const journalFile = reportFile.replace(/\.json$/, '') + '.journal.json';
const screenshotDirectory = reportFile.replace(/\.json$/, '') + '.screenshots';
mkdirSync(dirname(reportFile), { recursive: true, mode: 0o700 });

type Journal = {
  runId: string;
  baseUrl: string;
  ownerId: string;
  name: string;
  renamed: string;
  startedAt: string;
  createAttempted?: boolean;
  renameAttempted?: boolean;
  uiDeleteAttempted?: boolean;
  createKey?: string;
  renameKey?: string;
  uiDeleteKey?: string;
  cleanupDeleteKey: string;
  id?: string;
  deleted?: boolean;
};
const report = {
  passed: false,
  cleanupConfirmed: false,
  startedAt: new Date().toISOString(),
  completedAt: undefined as string | undefined,
  errorCode: undefined as string | undefined,
  cleanupError: undefined as string | undefined,
  events: [] as Record<string, unknown>[],
};
let journal: Journal | undefined;
let reportOwned = false;
let cookie = '';
let browser: Browser | undefined;
let context: BrowserContext | undefined;
let page: Page | undefined;

function durable(path: string, value: unknown, exclusive = false) {
  const target = exclusive ? path : path + '.tmp';
  const descriptor = openSync(target, exclusive ? 'wx' : 'w', 0o600);
  try {
    writeFileSync(descriptor, JSON.stringify(value, null, 2) + '\n');
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  if (!exclusive) renameSync(target, path);
}
function save() {
  if (!reportOwned) return;
  if (journal) durable(journalFile, journal);
  durable(reportFile, report);
}
function event(kind: string, values: Record<string, unknown> = {}) {
  report.events.push({ at: new Date().toISOString(), kind, ...values });
  save();
  console.log(JSON.stringify({ kind, ...values }));
}
function safe(error: unknown) {
  // Playwright failures can include filled inputs and request diagnostics.
  return error instanceof ProbeFailure ? error.message : 'HOSTED_UI_OPERATION_UNCONFIRMED';
}
function id(value: unknown): string {
  check(typeof value === 'string' && /^[a-f0-9-]{36}$/i.test(value), 'INVALID_BROKER_DISK_ID');
  return value;
}
async function json<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  check(path.startsWith('/api/') && !path.startsWith('//'), 'BROKER_API_PATH_REQUIRED');
  // Mutation calls are limited to fallback deletion of the validated run-owned disk.
  check(
    method === 'GET' || (method === 'DELETE' && journal?.id && path === '/api/disks/' + journal.id),
    'CLEANUP_DISK_DELETE_ONLY',
  );
  const response = await fetch(baseUrl + path, {
    method,
    redirect: 'error',
    signal: AbortSignal.timeout(15000),
    headers: {
      Origin: baseUrl,
      Cookie: cookie,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  check(response.ok, 'BROKER_HTTP_' + response.status);
  const text = await response.text();
  check(Buffer.byteLength(text) <= 1024 * 1024, 'BROKER_RESPONSE_TOO_LARGE');
  return JSON.parse(text) as T;
}
async function rememberCookies() {
  check(context, 'BROWSER_CONTEXT_REQUIRED');
  cookie = (await context.cookies(baseUrl))
    .map((value) => value.name + '=' + value.value)
    .join('; ');
  check(cookie, 'BUYER_SESSION_MISSING');
}
async function signInUi() {
  check(page, 'BROWSER_PAGE_REQUIRED');
  await page.goto(baseUrl + '/login');
  await page.getByLabel('Email', { exact: true }).fill(email);
  await page.getByLabel('Password', { exact: true }).fill(password!);
  const response = page.waitForResponse(
    (value) =>
      new URL(value.url()).pathname === '/api/auth/sign-in/email' &&
      value.request().method() === 'POST',
  );
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  check((await response).status() === 200, 'BUYER_UI_SIGN_IN_FAILED');
  await rememberCookies();
}
async function ownedDetail(): Promise<DiskDetail> {
  check(journal?.id, 'OWNED_DISK_ID_REQUIRED');
  const detail = await json<DiskDetail>('/api/disks/' + journal.id);
  check(
    detail.disk.id === journal.id &&
      [journal.name, journal.renamed].includes(detail.disk.name) &&
      detail.disk.sourceMode === 'real',
    'DISK_OWNERSHIP_OR_MODE_MISMATCH',
  );
  check(
    detail.attachments.length === 0 &&
      detail.workspaces.length === 0 &&
      detail.disk.attachmentCount === 0 &&
      detail.disk.workspaceCount === 0,
    'OWNED_DISK_HAS_UNEXPECTED_REFERENCES',
  );
  return detail;
}
async function findOwnDisk(): Promise<Disk | undefined> {
  check(journal, 'JOURNAL_REQUIRED');
  const matches: Disk[] = [];
  let cursor: string | undefined;
  for (let pages = 0; pages < 10; pages++) {
    const result = await json<{ items: Disk[]; nextCursor?: string }>(
      '/api/disks?limit=100' + (cursor ? '&cursor=' + encodeURIComponent(cursor) : ''),
    );
    matches.push(
      ...result.items.filter((disk) => [journal!.name, journal!.renamed].includes(disk.name)),
    );
    cursor = result.nextCursor;
    if (!cursor) break;
    check(pages < 9, 'OWNED_DISK_SEARCH_LIMIT_REACHED');
  }
  check(matches.length <= 1, 'AMBIGUOUS_RUN_DISK');
  const disk = matches[0];
  if (disk) {
    check(disk.sourceMode === 'real', 'RUN_DISK_MODE_MISMATCH');
    if (journal.id) check(disk.id === journal.id, 'RUN_DISK_ID_MISMATCH');
  }
  return disk;
}
async function screenshot(name: string) {
  check(page, 'BROWSER_PAGE_REQUIRED');
  mkdirSync(screenshotDirectory, { recursive: true, mode: 0o700 });
  // Screenshots are taken only after leaving the credential form. No trace/video is recorded.
  await page.screenshot({ path: resolve(screenshotDirectory, name + '.png'), fullPage: true });
}
function observeUiMutations() {
  check(page && journal, 'BROWSER_JOURNAL_REQUIRED');
  page.on('request', (request) => {
    if (!journal) return;
    const url = new URL(request.url());
    if (url.origin !== baseUrl || !['POST', 'PATCH', 'DELETE'].includes(request.method())) return;
    const path = url.pathname;
    if (path !== '/api/disks' && path !== '/api/disks/' + journal.id) return;
    try {
      const body = request.postDataJSON() as { name?: string; operationKey?: string };
      if (path === '/api/disks' && request.method() === 'POST' && body.name === journal.name)
        journal.createKey = body.operationKey;
      if (
        path === '/api/disks/' + journal.id &&
        request.method() === 'PATCH' &&
        body.name === journal.renamed
      )
        journal.renameKey = body.operationKey;
      if (path === '/api/disks/' + journal.id && request.method() === 'DELETE')
        journal.uiDeleteKey = body.operationKey;
      save();
    } catch {
      // The durable run marker written before clicking still supports read-only ID recovery.
    }
  });
}
async function runUi() {
  check(page && journal, 'BROWSER_JOURNAL_REQUIRED');
  observeUiMutations();
  await page.goto(baseUrl + '/disks');
  await expect(page.getByRole('heading', { name: 'Disks', exact: true })).toBeVisible();
  await expect(page.getByText('Only you can access these disks', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Create disk', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Disk name', { exact: true }).fill(journal.name);
  await screenshot('01-create-dialog');
  journal.createAttempted = true;
  save();
  await dialog.getByRole('button', { name: 'Create disk', exact: true }).click();
  await expect(page).toHaveURL(new RegExp('/disks/[a-f0-9-]{36}$'), { timeout: 30000 });
  journal.id = id(new URL(page.url()).pathname.split('/').at(-1));
  save();
  await expect(page.getByRole('heading', { name: journal.name, exact: true })).toBeVisible();
  await expect(page.getByText('Ready', { exact: true })).toBeVisible({ timeout: 120000 });
  check((await ownedDetail()).disk.status === 'ready', 'UI_READY_DISK_NOT_CONFIRMED');
  check(journal.createKey, 'UI_CREATE_IDENTITY_MISSING');
  event('ui-disk-created-ready', { diskId: journal.id });
  await screenshot('02-created-ready');

  await page.getByRole('button', { name: 'Rename', exact: true }).click();
  await dialog.getByLabel('Disk name', { exact: true }).fill(journal.renamed);
  journal.renameAttempted = true;
  save();
  await dialog.getByRole('button', { name: 'Save name', exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByRole('heading', { name: journal.renamed, exact: true })).toBeVisible();
  check((await ownedDetail()).disk.name === journal.renamed, 'UI_RENAME_NOT_CONFIRMED');
  check(journal.renameKey, 'UI_RENAME_IDENTITY_MISSING');
  event('ui-disk-renamed', { diskId: journal.id });
  await screenshot('03-renamed');

  const deleteButton = page.getByRole('button', { name: 'Delete disk', exact: true });
  await expect(deleteButton).toBeEnabled({ timeout: 120000 });
  await deleteButton.click();
  await expect(
    dialog.getByRole('heading', { name: 'Delete this disk?', exact: true }),
  ).toBeVisible();
  journal.uiDeleteAttempted = true;
  save();
  await dialog.getByRole('button', { name: 'Delete disk and files', exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByText('Deleted', { exact: true })).toBeVisible({ timeout: 120000 });
  const deleted = await ownedDetail();
  check(
    deleted.disk.status === 'deleted' && !deleted.disk.cleanupPending,
    'UI_DELETE_NOT_CONFIRMED',
  );
  check(journal.uiDeleteKey, 'UI_DELETE_IDENTITY_MISSING');
  journal.deleted = true;
  save();
  event('ui-disk-deleted', { diskId: journal.id });
  await screenshot('04-deleted');
  await page.getByRole('link', { name: 'All disks', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Disks', exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: journal.renamed, exact: true })).toHaveCount(0);
  check(!(await findOwnDisk()), 'DELETED_RUN_DISK_STILL_LISTED');
  await screenshot('05-owner-inventory');
  event('ui-owner-inventory-cleared');
}
async function cleanup() {
  check(journal, 'JOURNAL_REQUIRED');
  if (!journal.createAttempted) return;
  const until = Date.now() + 150000;
  if (!journal.id) {
    // An uncertain browser create is discovered by its unique durable marker; never replay it.
    for (;;) {
      const disk = await findOwnDisk();
      if (disk) {
        journal.id = id(disk.id);
        save();
        break;
      }
      check(Date.now() < until, 'CREATE_OUTCOME_UNCONFIRMED_CHECK_JOURNAL');
      await delay(3000);
    }
  }
  for (;;) {
    const detail = await ownedDetail();
    if (detail.disk.status === 'deleted' && !detail.disk.cleanupPending) {
      journal.deleted = true;
      save();
      check(!(await findOwnDisk()), 'DELETED_RUN_DISK_STILL_LISTED');
      return;
    }
    check(Date.now() < until, 'OWNED_DISK_CLEANUP_UNCONFIRMED_CHECK_JOURNAL');
    if (detail.disk.canDelete && detail.disk.status !== 'deleting') {
      event('fallback-delete-run-owned-disk', { diskId: journal.id });
      await json('/api/disks/' + journal.id, 'DELETE', {
        operationKey: journal.uiDeleteKey ?? journal.cleanupDeleteKey,
      });
    }
    await delay(3000);
  }
}

try {
  browser = await chromium.launch({
    headless: true,
    ...(process.env.HOSTED_DISK_UI_E2E_CHROMIUM_EXECUTABLE
      ? { executablePath: process.env.HOSTED_DISK_UI_E2E_CHROMIUM_EXECUTABLE }
      : {}),
  });
  context = await browser.newContext({ baseURL: baseUrl, viewport: { width: 1440, height: 1000 } });
  page = await context.newPage();
  page.setDefaultTimeout(20000);
  page.setDefaultNavigationTimeout(30000);
  await signInUi();
  const me = await json<{
    user: { id: string; role: string; email: string } | null;
    modes: { wick: string };
  }>('/api/me');
  check(
    me.user?.role === 'buyer' && me.user.email === email && me.modes.wick === 'real',
    'EXISTING_REAL_BUYER_REQUIRED',
  );
  const options = await json<DiskOptions>('/api/disks/options');
  check(options.enabled && options.mode === 'real', 'REAL_DISKS_MUST_BE_ENABLED');
  if (cleanupOnly) {
    check(existsSync(journalFile), 'CLEANUP_JOURNAL_REQUIRED');
    const saved = JSON.parse(readFileSync(journalFile, 'utf8')) as Journal;
    check(
      saved.baseUrl === baseUrl &&
        saved.ownerId === me.user.id &&
        /^[a-f0-9-]{36}$/i.test(saved.runId),
      'JOURNAL_SCOPE_MISMATCH',
    );
    check(
      saved.name === 'hosted-ui-disk-' + saved.runId && saved.renamed === saved.name + '-renamed',
      'JOURNAL_DISK_MARKER_MISMATCH',
    );
    id(saved.cleanupDeleteKey);
    if (saved.id) id(saved.id);
    journal = saved;
    reportOwned = true;
    event('cleanup-existing-ui-run', { diskId: journal.id });
  } else {
    const runId = randomUUID();
    const pending: Journal = {
      runId,
      baseUrl,
      ownerId: me.user.id,
      name: 'hosted-ui-disk-' + runId,
      renamed: 'hosted-ui-disk-' + runId + '-renamed',
      cleanupDeleteKey: randomUUID(),
      startedAt: new Date().toISOString(),
    };
    durable(journalFile, pending, true);
    journal = pending;
    reportOwned = true;
    event('ui-run-started', { runId });
    await runUi();
    report.passed = true;
  }
} catch (error) {
  report.errorCode = safe(error);
} finally {
  if (journal && cookie) {
    try {
      await cleanup();
      report.cleanupConfirmed = true;
    } catch (error) {
      report.cleanupError = safe(error);
    }
  }
  await browser?.close().catch(() => undefined);
  report.completedAt = new Date().toISOString();
  save();
}
if ((!cleanupOnly && !report.passed) || !report.cleanupConfirmed || report.errorCode) {
  console.error(
    JSON.stringify({
      errorCode: report.errorCode,
      cleanupError: report.cleanupError,
      cleanupConfirmed: report.cleanupConfirmed,
    }),
  );
  process.exitCode = 1;
} else {
  event(cleanupOnly ? 'ui-run-cleanup-confirmed' : 'hosted-disk-ui-passed', {
    cleanupConfirmed: true,
  });
}
