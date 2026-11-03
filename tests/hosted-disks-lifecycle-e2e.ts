/** Opt-in hosted Broker disk lifecycle: one disk, two 15-minute Micro rentals.
 * Requires RUN_HOSTED_DISK_E2E=1 and existing runtime credentials in memory.
 * Never invokes native create, changes provider settings, or buys model tokens.
 * Use RUN_HOSTED_DISK_E2E_CLEANUP=1 with HOSTED_DISK_E2E_RUN_ID to recover an
 * interrupted run from its private, fsynced verification-results journal.
 * HOSTED_DISK_E2E_OUTPUT_DIR selects an existing journal directory for recovery.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, mkdir, open, readFile, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium, expect } from '@playwright/test';
import { createWickAdapter } from '../src/server/integrations/wick.js';
import type { WickAdapter } from '../src/server/integrations/types.js';

type Json = Record<string, any>;
const routes = [
  { catalogId: 'e2b:micro:us', provider: 'e2b', region: 'us', folder: 'e2b' },
  { catalogId: 'modal:micro:auto', provider: 'modal', region: 'auto', folder: 'modal' },
] as const;
const runId = process.env.HOSTED_DISK_E2E_RUN_ID ?? randomUUID();
const output = resolve(
  process.env.HOSTED_DISK_E2E_OUTPUT_DIR ?? `verification-results/hosted-disks-lifecycle-${runId}`,
);
const journalPath = join(output, 'journal.jsonl');
const reportPath = join(output, 'report.json');
const recovering = process.env.RUN_HOSTED_DISK_E2E_CLEANUP === '1';
class ProbeFailure extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}
function requireThat(value: unknown, code: string): asserts value {
  if (!value) throw new ProbeFailure(code);
}
const report: Json = {
  runId,
  startedAt: new Date().toISOString(),
  passed: false,
  evidence: 'actual hosted Broker APIs and native commands on Broker-owned VMs',
  maximumRequests: 2,
  maximumQuoteCents: 50,
  durationMinutes: 15,
  noNativeCreate: true,
  stages: [],
  cleanup: { confirmed: false },
};
const requests = new Map<string, Json>();
const vms = new Map<string, Json>();
let diskId: string | undefined;
let cookie = '';
let base = '';
let ownerId = '';
let native: WickAdapter | undefined;
let nativeDriveId: string | undefined;
let header: Json | undefined;
const names = [`hosted-disk-${runId}`, `hosted-disk-${runId}-renamed`];
const descriptions = routes.map((route) => `Hosted disk lifecycle ${runId} ${route.provider}`);
const endOfWork = Date.now() + 8 * 60000;
async function journal(kind: string, fields: Json = {}) {
  const line = JSON.stringify({ kind, at: new Date().toISOString(), ...fields }) + '\n';
  requireThat(Buffer.byteLength(line) <= 32768, 'JOURNAL_RECORD_TOO_LARGE');
  const file = await open(
    journalPath,
    constants.O_APPEND | constants.O_WRONLY | constants.O_CREAT | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    await file.writeFile(line);
    await file.sync();
  } finally {
    await file.close();
  }
}
async function save() {
  await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
}
async function stage<T>(name: string, run: () => Promise<T>): Promise<T> {
  const started = Date.now();
  try {
    const result = await run();
    report.stages.push({ name, passed: true, elapsedMs: Date.now() - started });
    await save();
    return result;
  } catch (error) {
    const code = error instanceof ProbeFailure ? error.code : 'PROBE_STAGE_FAILED';
    report.stages.push({ name, passed: false, elapsedMs: Date.now() - started, code });
    await save();
    throw new ProbeFailure(code);
  }
}
async function api(path: string, method = 'GET', body?: Json): Promise<Json> {
  requireThat(path.startsWith('/api/') && !path.startsWith('//'), 'BROKER_PATH_INVALID');
  const response = await fetch(base + path, {
    method,
    redirect: 'error',
    signal: AbortSignal.timeout(20000),
    headers: {
      Cookie: cookie,
      Origin: base,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...(body?.operationKey ? { 'Idempotency-Key': body.operationKey } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new ProbeFailure(`BROKER_HTTP_${response.status}`);
  }
  const reader = response.body?.getReader();
  requireThat(reader, 'BROKER_BODY_MISSING');
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      length += part.value.length;
      requireThat(length <= 1024 * 1024, 'BROKER_RESPONSE_TOO_LARGE');
      chunks.push(part.value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  requireThat(
    value && typeof value === 'object' && !Array.isArray(value),
    'BROKER_RESPONSE_INVALID',
  );
  return value;
}
async function mutate(kind: string, path: string, method: string, body: Json) {
  await journal(`${kind}-intent`, { path, method, body });
  const value = await api(path, method, body);
  await journal(`${kind}-result`, { id: value.id ?? null, status: value.status ?? null });
  return value;
}
async function poll<T>(
  name: string,
  maximum: number,
  observe: () => Promise<T>,
  done: (value: T) => boolean,
  deadline = endOfWork,
): Promise<T> {
  const until = Math.min(deadline, Date.now() + maximum);
  while (Date.now() < until) {
    const value = await observe();
    if (done(value)) return value;
    await delay(2000);
  }
  throw new ProbeFailure(`${name}_TIMEOUT`);
}
async function list(path: string): Promise<Json[]> {
  const items: Json[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 3; page++) {
    const value = await api(
      path + '?limit=100' + (cursor ? '&cursor=' + encodeURIComponent(cursor) : ''),
    );
    requireThat(Array.isArray(value.items), 'BROKER_LIST_INVALID');
    items.push(...value.items);
    if (!value.nextCursor) return items;
    cursor = value.nextCursor;
  }
  throw new ProbeFailure('RESOURCE_DISCOVERY_BOUND');
}
function remember(detail: Json) {
  const request = detail.request;
  requireThat(request && descriptions.includes(request.description), 'REQUEST_NOT_OWNED_BY_RUN');
  const previous = requests.get(request.id);
  requireThat(!previous || previous.description === request.description, 'REQUEST_IDENTITY_DRIFT');
  requests.set(request.id, request);
  if (detail.vm) {
    requireThat(
      detail.vm.requestId === request.id &&
        detail.vm.buyerId === ownerId &&
        detail.vm.diskId === diskId,
      'VM_NOT_OWNED_BY_RUN',
    );
    vms.set(detail.vm.id, detail.vm);
  }
}
async function ownedVm(id: string) {
  const value = await api(`/api/vms/${encodeURIComponent(id)}`);
  requireThat(
    vms.has(id) && value.id === id && value.buyerId === ownerId && value.diskId === diskId,
    'VM_IDENTITY_DRIFT',
  );
  vms.set(id, value);
  return value;
}
async function command(
  vmId: string,
  provider: string,
  label: string,
  shell: string,
): Promise<string> {
  requireThat(Date.now() < endOfWork && native?.runCommand, 'NATIVE_COMMAND_UNAVAILABLE');
  const vm = await ownedVm(vmId);
  requireThat(vm.status === 'running' && typeof vm.environmentId === 'string', 'VM_NOT_RUNNING');
  const observed = await native.get(vm.environmentId);
  const disk = await api(`/api/disks/${encodeURIComponent(diskId!)}`);
  const attachment = disk.attachments?.find((item: Json) => item.vmId === vmId);
  requireThat(
    observed.id === vm.environmentId &&
      observed.status === 'running' &&
      observed.organizationId === process.env.WICK_ORGANIZATION_ID &&
      observed.groupId === process.env.WICK_GROUP_ID &&
      observed.provider === provider &&
      observed.profile === 'micro' &&
      observed.name === `wick-broker-${vm.id.slice(0, 8)}` &&
      observed.workspaceDrive?.status === 'mounted' &&
      observed.workspaceDrive.accessMode === 'mount' &&
      observed.workspaceDrive.attachmentMode === 'shared' &&
      (observed.workspaceDrive.workspacePath === undefined ||
        observed.workspaceDrive.workspacePath === '/workspace') &&
      attachment?.environmentId === vm.environmentId &&
      attachment.status === 'mounted' &&
      attachment.generation === observed.workspaceDrive.generation &&
      (!nativeDriveId || nativeDriveId === observed.workspaceDrive.driveId),
    'NATIVE_VM_OWNERSHIP_OR_MOUNT_INVALID',
  );
  nativeDriveId = observed.workspaceDrive!.driveId;
  await journal('native-command-intent', { vmId, environmentId: vm.environmentId, label });
  const result = await native.runCommand(vm.environmentId, { command: shell, cwd: '/workspace' });
  requireThat(
    result.exitCode === 0 && !result.simulated && Buffer.byteLength(result.stdout) <= 4096,
    'NATIVE_COMMAND_FAILED_OR_UNCERTAIN',
  );
  await journal('native-command-result', { vmId, label, exitCode: result.exitCode });
  return result.stdout;
}
async function terminate(vmId: string, cleanupDeadline: number) {
  const vm = await ownedVm(vmId);
  if (!vm.cleanupConfirmedAt) {
    await mutate('vm-terminate', `/api/vms/${encodeURIComponent(vmId)}/terminate`, 'POST', {
      operationKey: `disk-e2e:${runId}:terminate:${vmId}`,
    });
    await poll(
      'VM_CLEANUP',
      150000,
      () => ownedVm(vmId),
      (current) => !!current.cleanupConfirmedAt,
      cleanupDeadline,
    );
  }
}
async function discover() {
  if (!cookie || !header) return;
  if (!diskId) {
    const matches = (await list('/api/disks')).filter((disk) => names.includes(disk.name));
    requireThat(matches.length <= 1, 'AMBIGUOUS_RUN_DISK');
    diskId = matches[0]?.id;
  }
  const matching = (await list('/api/requests')).filter((request) =>
    descriptions.includes(request.description),
  );
  requireThat(
    matching.length <= 2 && new Set(matching.map((r) => r.description)).size === matching.length,
    'REQUEST_DISCOVERY_EXCEEDS_TWO',
  );
  for (const request of matching)
    remember(await api(`/api/requests/${encodeURIComponent(request.id)}`));
}
async function cleanup() {
  if (!cookie || !header) {
    report.cleanup = { confirmed: true, reason: 'no_authorized_mutations_started' };
    return;
  }
  const until = Date.now() + 5 * 60000;
  try {
    await discover();
    for (const request of requests.values()) {
      const detail = await api(`/api/requests/${encodeURIComponent(request.id)}`);
      remember(detail);
      if (detail.request.status === 'open')
        await mutate('request-cancel', `/api/requests/${request.id}/cancel`, 'POST', {
          operationKey: `disk-e2e:${runId}:cancel:${request.id}`,
        });
    }
    for (const id of vms.keys()) await terminate(id, until);
    if (diskId) {
      const detail = await api(`/api/disks/${encodeURIComponent(diskId)}`);
      requireThat(names.includes(detail.disk?.name), 'DISK_IDENTITY_DRIFT');
      await poll(
        'DISK_DETACH',
        60000,
        () => api(`/api/disks/${diskId}`),
        (current) => current.attachments?.length === 0,
        until,
      );
      if (detail.disk.status !== 'deleted') {
        await poll(
          'DISK_DELETE_READY',
          60000,
          () => api(`/api/disks/${diskId}`),
          (current) => current.disk?.canDelete === true || current.disk?.status === 'deleted',
          until,
        );
        const current = await api(`/api/disks/${diskId}`);
        if (current.disk.status !== 'deleted')
          await mutate('disk-delete', `/api/disks/${diskId}`, 'DELETE', {
            operationKey: `disk-e2e:${runId}:delete`,
          });
        await poll(
          'DISK_DELETE',
          150000,
          () => api(`/api/disks/${diskId}`),
          (current) => current.disk?.status === 'deleted',
          until,
        );
      }
    }
    await journal('cleanup-confirmed', {
      diskId: diskId ?? null,
      requests: requests.size,
      vms: vms.size,
    });
    report.cleanup = {
      confirmed: true,
      diskDeleted: !!diskId,
      requests: requests.size,
      vms: vms.size,
    };
  } catch (error) {
    report.cleanup = {
      confirmed: false,
      code: error instanceof ProbeFailure ? error.code : 'CLEANUP_UNCONFIRMED',
      journalPath,
    };
  }
  await save();
}
async function main() {
  requireThat(process.env.RUN_HOSTED_DISK_E2E === '1', 'EXPLICIT_HOSTED_DISK_OPT_IN_REQUIRED');
  requireThat(!recovering || process.env.HOSTED_DISK_E2E_RUN_ID, 'RECOVERY_RUN_ID_REQUIRED');
  requireThat(/^[a-f0-9-]{36}$/.test(runId), 'RUN_ID_INVALID');
  const supplied = process.env.HOSTED_E2E_BASE_URL;
  requireThat(supplied, 'HOSTED_E2E_BASE_URL_REQUIRED');
  const origin = new URL(supplied);
  requireThat(
    origin.protocol === 'https:' &&
      !origin.username &&
      !origin.password &&
      origin.pathname === '/' &&
      !origin.search &&
      !origin.hash,
    'HOSTED_ORIGIN_INVALID',
  );
  base = origin.origin;
  report.baseUrl = base;
  await mkdir(output, { recursive: true, mode: 0o700 });
  await save();
  const password = process.env.SEED_BUYER_PASSWORD;
  requireThat(password, 'EXISTING_BUYER_PASSWORD_REQUIRED');
  const signedIn = await fetch(base + '/api/auth/sign-in/email', {
    method: 'POST',
    redirect: 'error',
    signal: AbortSignal.timeout(20000),
    headers: { Origin: base, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: process.env.SEED_BUYER_EMAIL ?? 'buyer@demo.wick.local',
      password,
    }),
  });
  requireThat(signedIn.status === 200, 'HOSTED_BUYER_SIGN_IN_FAILED');
  await signedIn.body?.cancel();
  cookie = signedIn.headers
    .getSetCookie()
    .map((value) => value.split(';')[0])
    .join('; ');
  requireThat(cookie, 'HOSTED_SESSION_MISSING');
  const me = await api('/api/me');
  requireThat(
    me.user?.role === 'buyer' && me.modes?.wick === 'real',
    'REAL_BUYER_ACCOUNT_REQUIRED',
  );
  ownerId = me.user.id;
  native = createWickAdapter({
    wickMode: 'real',
    wickApiBase: process.env.WICK_API_BASE ?? 'https://app.wick-cloud.com/api',
    wickApiKey: process.env.WICK_API_KEY,
    wickOrganizationId: process.env.WICK_ORGANIZATION_ID!,
    wickGroupId: process.env.WICK_GROUP_ID!,
  });
  requireThat(
    process.env.WICK_API_KEY && process.env.WICK_ORGANIZATION_ID && process.env.WICK_GROUP_ID,
    'NATIVE_OPERATOR_CREDENTIALS_REQUIRED',
  );
  if (recovering) {
    const text = await readFile(journalPath, 'utf8');
    requireThat(
      text.endsWith('\n') && Buffer.byteLength(text) <= 1024 * 1024,
      'RECOVERY_JOURNAL_INVALID',
    );
    const records = text
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    header = records[0];
    requireThat(
      header?.kind === 'prepared' &&
        header.runId === runId &&
        header.baseUrl === base &&
        header.ownerId === ownerId,
      'RECOVERY_SCOPE_MISMATCH',
    );
    const created = records.find((entry) => entry.kind === 'disk-create-result');
    diskId = created?.id ?? undefined;
    report.recoveryOnly = true;
    return;
  }
  let exists = false;
  try {
    exists = (await stat(journalPath)).isFile();
  } catch {
    /* Fresh journal is required. */
  }
  requireThat(!exists, 'RUN_JOURNAL_EXISTS_USE_CLEANUP');
  const options = await api('/api/disks/options');
  requireThat(
    options.enabled === true &&
      options.mode === 'real' &&
      routes.every((route) => options.eligibleCatalogIds?.includes(route.catalogId)),
    'TWO_EXACT_QUALIFIED_ROUTES_REQUIRED',
  );
  for (const route of routes)
    requireThat(
      me.catalog?.some(
        (item: Json) =>
          item.id === route.catalogId &&
          item.approved &&
          item.provider === route.provider &&
          item.durationMinutes.includes(15),
      ),
      'APPROVED_MICRO_ROUTE_MISSING',
    );
  header = { runId, baseUrl: base, ownerId, maximumRequests: 2, maximumQuoteCents: 50 };
  await journal('prepared', header);
  const create = { name: names[0], operationKey: `disk-e2e:${runId}:create` };
  await stage('disk_create_replay_and_ready', async () => {
    const disk = await mutate('disk-create', '/api/disks', 'POST', create);
    requireThat(typeof disk.id === 'string', 'DISK_CREATE_ID_MISSING');
    diskId = disk.id;
    const replay = await mutate('disk-create-replay', '/api/disks', 'POST', create);
    requireThat(replay.id === diskId, 'DISK_CREATE_REPLAY_CHANGED_ID');
    await poll(
      'DISK_READY',
      150000,
      () => api(`/api/disks/${diskId}`),
      (detail) => {
        requireThat(detail.disk?.status !== 'failed', 'DISK_CREATE_FAILED');
        return detail.disk?.status === 'ready' && !detail.disk.cleanupPending;
      },
    );
    report.diskId = diskId;
  });
  await stage('disk_rename_confirmed', async () => {
    await mutate('disk-rename', `/api/disks/${diskId}`, 'PATCH', {
      name: names[1],
      operationKey: `disk-e2e:${runId}:rename`,
    });
    await poll(
      'DISK_RENAME',
      90000,
      () => api(`/api/disks/${diskId}`),
      (detail) =>
        detail.disk?.name === names[1] &&
        detail.disk.status === 'ready' &&
        detail.disk.canDelete === true,
    );
  });
  await stage('two_provider_rentals_and_mounts', async () => {
    for (const route of routes) {
      requireThat(requests.size < 2, 'REQUEST_LIMIT_EXCEEDED');
      const catalog = me.catalog.find((item: Json) => item.id === route.catalogId);
      const body = {
        description: descriptions[routes.indexOf(route)],
        catalogId: route.catalogId,
        region: route.region,
        durationMinutes: 15,
        maxPriceCents: 25,
        matchAcrossProviders: false,
        requirements: { cpu: catalog.cpu, memoryGb: catalog.memoryGb },
        diskId,
        operationKey: `disk-e2e:${runId}:vm:${route.provider}`,
      };
      const request = await mutate('request-create', '/api/requests', 'POST', body);
      requireThat(
        request.description === body.description && request.diskId === diskId,
        'REQUEST_SELECTION_MISMATCH',
      );
      requests.set(request.id, request);
    }
    for (const request of requests.values())
      await poll(
        'PROVIDER_VM_READY',
        180000,
        async () => {
          const detail = await api(`/api/requests/${request.id}`);
          remember(detail);
          requireThat(
            !['failed', 'cancelled', 'no_offers'].includes(detail.request.status),
            'BROKER_AUCTION_OR_PROVISION_FAILED',
          );
          return detail;
        },
        (detail) => detail.vm?.status === 'running',
      );
    requireThat(vms.size === 2, 'TWO_DISTINCT_VMS_REQUIRED');
    const amount = [...vms.values()].reduce((total, vm) => {
      requireThat(
        Number.isFinite(vm.priceCents) && vm.priceCents >= 0 && vm.priceCents <= 25,
        'QUOTE_EXCEEDS_REVIEWED_CEILING',
      );
      return total + vm.priceCents;
    }, 0);
    requireThat(amount <= 50, 'TOTAL_QUOTE_CEILING_EXCEEDED');
    report.compute = {
      requests: requests.size,
      vms: vms.size,
      acceptedQuoteCents: amount,
      maximumQuoteCents: 50,
      providers: routes.map((route) => route.provider),
    };
  });
  const byProvider = routes.map((route) => {
    const request = [...requests.values()].find(
      (item) => item.description === descriptions[routes.indexOf(route)],
    )!;
    const vm = [...vms.values()].find((item) => item.requestId === request.id)!;
    return { route, vm };
  });
  const nonce = randomBytes(16).toString('hex');
  const folder = `/workspace/broker-e2e-${nonce}`;
  requireThat(/^\/workspace\/broker-e2e-[a-f0-9]{32}$/.test(folder), 'PROBE_PATH_INVALID');
  const tokenA = `${nonce}:e2b`,
    tokenB = `${nonce}:modal`;
  await stage('cross_provider_shared_workspace_bytes', async () => {
    const first = byProvider[0],
      second = byProvider[1];
    requireThat(
      (await command(
        first.vm.id,
        first.route.provider,
        'write_e2b',
        `mkdir -p '${folder}/e2b' '${folder}/modal' && chmod 0777 '${folder}' '${folder}/e2b' '${folder}/modal' && printf '%s' '${tokenA}' > '${folder}/e2b/probe.txt' && chmod 0644 '${folder}/e2b/probe.txt' && sync && cat '${folder}/e2b/probe.txt'`,
      )) === tokenA,
      'FIRST_WRITE_NOT_CONFIRMED',
    );
    requireThat(
      (await command(
        second.vm.id,
        second.route.provider,
        'read_e2b_write_modal',
        `test "$(cat '${folder}/e2b/probe.txt')" = '${tokenA}' && printf '%s' '${tokenB}' > '${folder}/modal/probe.txt' && chmod 0644 '${folder}/modal/probe.txt' && sync && cat '${folder}/modal/probe.txt'`,
      )) === tokenB,
      'CROSS_PROVIDER_READ_WRITE_NOT_CONFIRMED',
    );
    requireThat(
      (await command(
        first.vm.id,
        first.route.provider,
        'read_modal',
        `cat '${folder}/modal/probe.txt'`,
      )) === tokenB,
      'CROSS_PROVIDER_RETURN_READ_NOT_CONFIRMED',
    );
    report.sharedFiles = {
      prefix: folder,
      separateFolders: ['e2b', 'modal'],
      crossReadBothDirections: true,
    };
  });
  if (process.env.HOSTED_DISK_E2E_BROWSER === '1')
    await stage('hosted_disk_detail_ui', async () => {
      const browser = await chromium.launch({ headless: true });
      try {
        const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
        await context.addCookies(
          cookie.split('; ').map((item) => {
            const separator = item.indexOf('=');
            return {
              name: item.slice(0, separator),
              value: item.slice(separator + 1),
              url: base,
              secure: true,
              httpOnly: true,
              sameSite: 'Lax' as const,
            };
          }),
        );
        const page = await context.newPage();
        await page.goto(`${base}/disks/${diskId}`, { waitUntil: 'networkidle' });
        await expect(
          page.getByRole('heading', { level: 1, name: names[1], exact: true }),
        ).toBeVisible();
        await expect(
          page.getByRole('table', { name: 'Attached VMs', exact: true }).locator('tbody tr'),
        ).toHaveCount(2);
        await expect(page.getByRole('heading', { name: 'Workspaces', exact: true })).toBeVisible();
        const path = join(output, 'disk-detail.png');
        await page.screenshot({ path, fullPage: true });
        await chmod(path, 0o600);
        report.browser = { realHostedPage: true, apiInterception: false, screenshot: path };
      } finally {
        await browser.close();
      }
    });
  await stage('independent_vm_cleanup_preserves_other_writer', async () => {
    await terminate(byProvider[0].vm.id, endOfWork);
    requireThat(
      (await command(
        byProvider[1].vm.id,
        byProvider[1].route.provider,
        'remaining_vm_reads_both',
        `printf '%s\n' "$(cat '${folder}/e2b/probe.txt')" "$(cat '${folder}/modal/probe.txt')"`,
      )) ===
        tokenA + '\n' + tokenB + '\n',
      'REMAINING_VM_LOST_DISK_BYTES',
    );
    await terminate(byProvider[1].vm.id, endOfWork);
    await poll(
      'ALL_DISK_ATTACHMENTS_RELEASED',
      60000,
      () => api(`/api/disks/${diskId}`),
      (detail) => detail.attachments?.length === 0,
    );
  });
  await stage('disk_delete_and_replay', async () => {
    const body = { operationKey: `disk-e2e:${runId}:delete` };
    await mutate('disk-delete', `/api/disks/${diskId}`, 'DELETE', body);
    await poll(
      'DISK_DELETED',
      150000,
      () => api(`/api/disks/${diskId}`),
      (detail) => detail.disk?.status === 'deleted',
    );
    const replay = await mutate('disk-delete-replay', `/api/disks/${diskId}`, 'DELETE', body);
    requireThat(
      replay.id === diskId && replay.status === 'deleted',
      'DISK_DELETE_REPLAY_CHANGED_IDENTITY',
    );
    report.diskDeleted = true;
  });
}
try {
  await main();
  report.functionalChecksPassed = !recovering;
} catch (error) {
  report.failureCode = error instanceof ProbeFailure ? error.code : 'HOSTED_DISK_LIFECYCLE_FAILED';
} finally {
  if (base) await cleanup();
  report.passed =
    !recovering && report.functionalChecksPassed === true && report.cleanup.confirmed === true;
  report.completedAt = new Date().toISOString();
  if (!report.passed && !recovering) process.exitCode = 1;
  if (recovering && (!report.cleanup.confirmed || report.failureCode)) process.exitCode = 1;
  await mkdir(output, { recursive: true, mode: 0o700 });
  await save();
  console.log(
    JSON.stringify({
      passed: report.passed,
      recoveryOnly: recovering,
      runId,
      functionalChecksPassed: report.functionalChecksPassed ?? false,
      failureCode: report.failureCode ?? null,
      cleanup: report.cleanup,
      reportPath,
      journalPath,
    }),
  );
}
