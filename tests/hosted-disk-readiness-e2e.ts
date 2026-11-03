/** Read-only hosted rollout probe. Only authentication sessions are created.
 * Run with HOSTED_E2E_BASE_URL and existing SEED_BUYER_EMAIL/PASSWORD in memory.
 * No response fixtures, orders, disks, keys, model calls or configuration writes.
 */
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { chromium, expect, type Browser, type BrowserContext, type Page } from '@playwright/test';

const execute = promisify(execFile);
const release = '0.5.0';
const methods = ['options', 'list', 'create', 'get', 'workspaces', 'rename', 'delete'];
const runId = randomUUID();
const artifacts = resolve('test-results', `hosted-disk-readiness-${runId}`);
const reportPath = process.env.HOSTED_E2E_REPORT_FILE ?? join(artifacts, 'report.json');
class ProbeFailure extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}
function requireThat(value: unknown, code: string): asserts value {
  if (!value) throw new ProbeFailure(code);
}
function record(value: unknown): Record<string, any> {
  requireThat(
    value !== null && typeof value === 'object' && !Array.isArray(value),
    'INVALID_JSON_OBJECT',
  );
  return value as Record<string, any>;
}
const report: Record<string, any> = {
  runId,
  startedAt: new Date().toISOString(),
  release,
  passed: false,
  evidence: 'actual hosted HTTP and browser responses; no mocked APIs',
  mutationBoundary: 'authentication sessions only',
  nativeDiskLifecycle: 'not_exercised_by_read_only_probe',
  checks: [],
};
async function check<T>(name: string, run: () => Promise<T>): Promise<T> {
  const started = Date.now();
  try {
    const value = await run();
    report.checks.push({ name, passed: true, elapsedMs: Date.now() - started });
    return value;
  } catch (error) {
    const code = error instanceof ProbeFailure ? error.code : 'PROBE_OPERATION_FAILED';
    report.checks.push({ name, passed: false, elapsedMs: Date.now() - started, code });
    throw new ProbeFailure(code);
  }
}
async function boundedBytes(response: Response, maximum: number): Promise<Buffer> {
  const declared = response.headers.get('content-length');
  if (declared !== null && Number(declared) > maximum) {
    await response.body?.cancel();
    throw new ProbeFailure('RESPONSE_SIZE_EXCEEDED');
  }
  const reader = response.body?.getReader();
  requireThat(reader, 'RESPONSE_BODY_MISSING');
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      requireThat(size <= maximum, 'RESPONSE_SIZE_EXCEEDED');
      chunks.push(part.value);
    }
    return Buffer.concat(chunks);
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}
async function run() {
  requireThat(isAbsolute(reportPath), 'REPORT_PATH_MUST_BE_ABSOLUTE');
  const supplied = process.env.HOSTED_E2E_BASE_URL;
  requireThat(supplied, 'HOSTED_E2E_BASE_URL_REQUIRED');
  const url = new URL(supplied);
  requireThat(
    url.protocol === 'https:' &&
      !url.username &&
      !url.password &&
      url.pathname === '/' &&
      !url.search &&
      !url.hash,
    'HOSTED_ORIGIN_MUST_BE_CREDENTIAL_FREE_HTTPS',
  );
  const base = url.origin;
  report.baseUrl = base;
  const buyerEmail = process.env.SEED_BUYER_EMAIL ?? 'buyer@demo.wick.local';
  const buyerPassword = process.env.SEED_BUYER_PASSWORD;
  requireThat(buyerPassword, 'EXISTING_BUYER_PASSWORD_REQUIRED');
  await mkdir(artifacts, { recursive: true, mode: 0o700 });
  async function response(path: string) {
    requireThat(path.startsWith('/') && !path.startsWith('//'), 'RELATIVE_HOSTED_PATH_REQUIRED');
    return fetch(base + path, { redirect: 'error', signal: AbortSignal.timeout(20000) });
  }
  async function json(path: string, status = 200): Promise<Record<string, any>> {
    const result = await response(path);
    requireThat(result.status === status, `HOSTED_HTTP_${result.status}`);
    const bytes = await boundedBytes(result, 1024 * 1024);
    return record(JSON.parse(bytes.toString('utf8')));
  }
  await check('health_and_readiness', async () => {
    const [health, ready] = await Promise.all([json('/health'), json('/ready')]);
    requireThat(health.status === 'ok' && health.service === 'wick-broker', 'LIVENESS_NOT_READY');
    requireThat(ready.status === 'ready' && ready.queue === 'running', 'DATABASE_QUEUE_NOT_READY');
    requireThat(
      ['real', 'fixture'].includes(health.modes?.wick) &&
        ['real', 'fixture'].includes(health.modes?.muse),
      'INVALID_ADAPTER_MODES',
    );
    report.modes = { wick: health.modes.wick, muse: health.modes.muse };
  });
  await check('anonymous_tenant_resources_denied', async () => {
    await Promise.all(
      ['/api/vms', '/api/disks', '/api/disks/options'].map(async (path) => {
        const result = await response(path);
        await result.body?.cancel();
        requireThat(result.status === 401, 'ANONYMOUS_RESOURCE_ACCESS_NOT_DENIED');
      }),
    );
  });
  await check('public_disk_api_contract', async () => {
    const document = await json('/api/openapi.json');
    const paths = record(document.paths);
    const expected = [
      ['get', '/api/disks/options', 'disks:read'],
      ['get', '/api/disks', 'disks:read'],
      ['post', '/api/disks', 'disks:write'],
      ['get', '/api/disks/{id}', 'disks:read'],
      ['get', '/api/disks/{id}/workspaces', 'disks:read'],
      ['patch', '/api/disks/{id}', 'disks:write'],
      ['delete', '/api/disks/{id}', 'disks:write'],
    ];
    for (const [verb, path, scope] of expected) {
      const operation = record(paths[path]?.[verb]);
      requireThat(operation['x-broker-scope'] === scope, 'DISK_API_SCOPE_MISMATCH');
      requireThat(
        Array.isArray(operation.security) &&
          operation.security.some((entry: any) => Array.isArray(entry.BrokerBearer)),
        'DISK_API_AUTH_CONTRACT_MISSING',
      );
    }
    requireThat(
      document.components?.schemas?.CreateOrder?.properties?.diskId,
      'ORDER_DISK_SELECTION_CONTRACT_MISSING',
    );
    report.apiContract = { diskOperations: expected.length, orderDiskSelection: true };
  });
  await check('published_clients_verified_and_installed', async () => {
    const manifest = await json(`/downloads/${release}/manifest.json`);
    const expected = JSON.parse(
      await readFile(resolve(`client-releases/${release}/manifest.json`), 'utf8'),
    );
    requireThat(
      manifest.version === release && Array.isArray(manifest.files) && manifest.files.length === 5,
      'RELEASE_MANIFEST_INVALID',
    );
    const directory = await mkdtemp(join(tmpdir(), 'wick-hosted-disk-clients-'));
    const archives: string[] = [];
    const verified: { name: string; size: number; sha256: string }[] = [];
    try {
      for (const entry of expected.files as { name: string; size: number; sha256: string }[]) {
        const published = manifest.files.find((item: any) => item.name === entry.name);
        requireThat(
          published?.sha256 === entry.sha256 && published?.size === entry.size,
          'PUBLISHED_RELEASE_DIFFERS_FROM_REVIEWED_RELEASE',
        );
        const result = await response(`/downloads/${release}/${entry.name}`);
        requireThat(result.status === 200, 'RELEASE_DOWNLOAD_UNAVAILABLE');
        const bytes = await boundedBytes(result, 16 * 1024 * 1024);
        requireThat(
          bytes.length === entry.size &&
            createHash('sha256').update(bytes).digest('hex') === entry.sha256,
          'RELEASE_DIGEST_MISMATCH',
        );
        verified.push(entry);
        if (entry.name.endsWith('.tgz')) {
          const path = join(directory, entry.name);
          await writeFile(path, bytes, { mode: 0o600 });
          archives.push(path);
        }
      }
      requireThat(archives.length === 3, 'RELEASE_ARCHIVES_MISSING');
      // Native service credentials, passwords and cookies never enter npm or the installed clients.
      const environment = {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        TMPDIR: process.env.TMPDIR,
        NO_COLOR: '1',
      };
      await execute(
        'npm',
        [
          'install',
          '--prefix',
          directory,
          '--ignore-scripts',
          '--no-audit',
          '--no-fund',
          ...archives,
        ],
        {
          env: environment,
          maxBuffer: 1024 * 1024,
          timeout: 120000,
        },
      );
      for (const name of ['sdk', 'cli', 'mcp']) {
        const metadata = JSON.parse(
          await readFile(
            join(directory, `node_modules/@wick-cloud/broker-${name}/package.json`),
            'utf8',
          ),
        );
        requireThat(metadata.version === release, 'INSTALLED_CLIENT_VERSION_MISMATCH');
      }
      const cli = await execute(
        process.execPath,
        [join(directory, 'node_modules/@wick-cloud/broker-cli/dist/index.js'), '--version'],
        {
          cwd: directory,
          env: environment,
          maxBuffer: 65536,
          timeout: 15000,
        },
      );
      requireThat(cli.stdout.trim() === release, 'INSTALLED_CLI_VERSION_MISMATCH');
      const sdk = await execute(
        process.execPath,
        [
          '--input-type=module',
          '-e',
          "import { BrokerClient } from '@wick-cloud/broker-sdk'; const c = new BrokerClient({ baseUrl: 'https://broker.example', apiKey: 'wbk_fixture.secret' }); console.log(JSON.stringify(Object.keys(c.disks).sort()));",
        ],
        {
          cwd: directory,
          env: environment,
          maxBuffer: 65536,
          timeout: 15000,
        },
      );
      requireThat(
        JSON.stringify(JSON.parse(sdk.stdout)) === JSON.stringify([...methods].sort()),
        'INSTALLED_SDK_DISK_METHODS_MISSING',
      );
      report.packages = {
        version: release,
        verifiedFiles: verified,
        installedClients: ['sdk', 'cli', 'mcp'],
        cliVersion: release,
        sdkDiskMethods: methods,
      };
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  let browser: Browser | undefined;
  let pageErrors = 0;
  let serverErrors = 0;
  const mutations: string[] = [];
  async function login(context: BrowserContext, email: string, password: string) {
    const page = await context.newPage();
    page.on('pageerror', () => {
      pageErrors++;
    });
    page.on('response', (value) => {
      if (new URL(value.url()).origin === base && value.status() >= 500) serverErrors++;
    });
    page.on('request', (request) => {
      if (
        new URL(request.url()).origin !== base ||
        ['GET', 'HEAD', 'OPTIONS'].includes(request.method())
      )
        return;
      const path = new URL(request.url()).pathname;
      mutations.push(
        `${request.method()} ${path === '/api/auth/sign-in/email' ? path : 'unexpected'}`,
      );
    });
    await page.goto(base + '/login', { waitUntil: 'domcontentloaded' });
    await page.getByLabel('Email', { exact: true }).fill(email);
    await page.getByLabel('Password', { exact: true }).fill(password);
    const signedIn = page.waitForResponse(
      (value) =>
        new URL(value.url()).pathname === '/api/auth/sign-in/email' &&
        value.request().method() === 'POST',
    );
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    requireThat((await signedIn).status() === 200, 'HOSTED_SIGN_IN_FAILED');
    await expect
      .poll(
        async () => {
          const result = await context.request.get(base + '/api/me');
          return result.ok() ? (await result.json()).user?.email : null;
        },
        { timeout: 15000 },
      )
      .toBe(email);
    return page;
  }
  async function ownerJson(context: BrowserContext, path: string) {
    const result = await context.request.get(base + path, { timeout: 20000 });
    requireThat(result.status() === 200, `OWNER_HTTP_${result.status()}`);
    const bytes = await result.body();
    requireThat(bytes.length <= 1024 * 1024, 'OWNER_RESPONSE_SIZE_EXCEEDED');
    return record(JSON.parse(bytes.toString('utf8')));
  }
  async function screenshot(page: Page, name: string) {
    await page.evaluate(() => document.fonts.ready);
    const path = join(artifacts, `${name}.png`);
    await page.screenshot({ path, fullPage: true });
    await chmod(path, 0o600);
  }
  try {
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    const page = await check('existing_owner_hosted_browser_sign_in', () =>
      login(context, buyerEmail, buyerPassword),
    );
    const diskOptions = await check('owner_read_api_and_disk_feature_state', async () => {
      const me = await ownerJson(context, '/api/me');
      requireThat(
        me.user?.role === 'buyer' && me.user?.email === buyerEmail && Array.isArray(me.catalog),
        'OWNER_ACCOUNT_SCOPE_INVALID',
      );
      const options = await ownerJson(context, '/api/disks/options');
      requireThat(
        typeof options.enabled === 'boolean' &&
          ['real', 'fixture'].includes(options.mode) &&
          Array.isArray(options.eligibleCatalogIds),
        'DISK_OPTIONS_INVALID',
      );
      const [disks, studio, orders, vms] = await Promise.all([
        ownerJson(context, '/api/disks?limit=5'),
        ownerJson(context, '/api/studio/options'),
        ownerJson(context, '/api/orders?limit=5'),
        ownerJson(context, '/api/vms?limit=5'),
      ]);
      requireThat(
        Array.isArray(disks.items) &&
          Array.isArray(orders.items) &&
          Array.isArray(vms.items) &&
          typeof studio.available === 'boolean',
        'OWNER_READ_MODEL_INVALID',
      );
      report.featureState = {
        enabled: options.enabled,
        mode: options.mode,
        eligibleRouteCount: options.eligibleCatalogIds.length,
        nativeQualification: options.enabled
          ? 'separate_native_probe_required'
          : 'feature_disabled_no_live_disk_claim',
      };
      report.ownerReads = {
        role: 'buyer',
        diskCountInPage: disks.items.length,
        orderCountInPage: orders.items.length,
        vmCountInPage: vms.items.length,
        studioAvailable: studio.available,
      };
      return options;
    });
    await check('hosted_disks_studio_keys_ui_desktop_and_mobile', async () => {
      const pages = [
        { path: '/disks', title: 'Disks', screenshot: 'disks-desktop' },
        { path: '/studio', title: 'Give it a task. Set a budget.', screenshot: 'studio-desktop' },
        { path: '/keys', title: 'API keys', screenshot: 'keys-desktop' },
      ];
      for (const target of pages) {
        const navigation = await page.goto(base + target.path, {
          waitUntil: 'networkidle',
          timeout: 30000,
        });
        requireThat(navigation?.ok(), 'HOSTED_UI_DOCUMENT_UNAVAILABLE');
        await expect(
          page.getByRole('heading', { level: 1, name: target.title, exact: true }),
        ).toBeVisible();
        if (target.path === '/disks') {
          if (diskOptions.enabled)
            await expect(
              page.getByRole('heading', { name: 'Your disks', exact: true }),
            ).toBeVisible();
          else {
            await expect(
              page.getByText('Disk support is not enabled', { exact: true }),
            ).toBeVisible();
            await expect(
              page.getByRole('button', { name: 'Create disk', exact: true }),
            ).toHaveCount(0);
          }
        }
        if (target.path === '/keys') {
          const install = await page.locator('.key-setup > pre').innerText();
          for (const name of ['sdk', 'cli', 'mcp'])
            requireThat(
              install.includes(`/downloads/${release}/wick-cloud-broker-${name}-${release}.tgz`),
              'HOSTED_UI_DOWNLOAD_VERSION_STALE',
            );
        }
        await screenshot(page, target.screenshot);
      }
      await page.setViewportSize({ width: 390, height: 844 });
      await page.goto(base + '/disks', { waitUntil: 'networkidle' });
      await expect(
        page.getByRole('heading', { level: 1, name: 'Disks', exact: true }),
      ).toBeVisible();
      requireThat(
        await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1),
        'HOSTED_MOBILE_OVERFLOW',
      );
      await screenshot(page, 'disks-mobile');
      report.browser = {
        actualHostedLogin: true,
        apiInterception: false,
        desktopPages: pages.map((target) => target.path),
        mobilePages: ['/disks'],
        screenshots: pages
          .map((target) => join(artifacts, `${target.screenshot}.png`))
          .concat(join(artifacts, 'disks-mobile.png')),
      };
    });
    const adminPassword = process.env.SEED_ADMIN_PASSWORD;
    if (adminPassword)
      await check('admin_role_cannot_read_buyer_disks', async () => {
        const adminContext = await browser!.newContext();
        try {
          await login(
            adminContext,
            process.env.SEED_ADMIN_EMAIL ?? 'admin@demo.wick.local',
            adminPassword,
          );
          const me = await ownerJson(adminContext, '/api/me');
          requireThat(me.user?.role === 'admin', 'ADMIN_ACCOUNT_SCOPE_INVALID');
          const result = await adminContext.request.get(base + '/api/disks');
          requireThat(result.status() === 403, 'ADMIN_BUYER_DISK_ACCESS_NOT_DENIED');
        } finally {
          await adminContext.close();
        }
      });
    requireThat(pageErrors === 0 && serverErrors === 0, 'HOSTED_BROWSER_RUNTIME_OR_SERVER_ERROR');
    requireThat(
      mutations.every((entry) => entry === 'POST /api/auth/sign-in/email'),
      'UNEXPECTED_HOSTED_MUTATION',
    );
    report.browser = {
      ...report.browser,
      pageErrors,
      serverErrors,
      authenticationSessionsCreated: mutations.length,
      unexpectedMutations: 0,
    };
  } finally {
    await browser?.close();
  }
}
try {
  await run();
  report.passed = true;
} catch (error) {
  report.failureCode = error instanceof ProbeFailure ? error.code : 'HOSTED_PROBE_FAILED';
  process.exitCode = 1;
} finally {
  report.completedAt = new Date().toISOString();
  await mkdir(dirname(reportPath), { recursive: true, mode: 0o700 });
  await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  // Only sanitized summary metadata reaches stdout. Cookies and responses stay in memory.
  console.log(
    JSON.stringify({
      passed: report.passed,
      runId,
      checksPassed: report.checks.filter((entry: any) => entry.passed).length,
      failureCode: report.failureCode ?? null,
      featureState: report.featureState ?? null,
      reportPath,
    }),
  );
}
