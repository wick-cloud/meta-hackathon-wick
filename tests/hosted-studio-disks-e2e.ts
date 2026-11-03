/** Opt-in hosted paid diagnostic: two real Studio tasks share one run-owned disk.
 * No fixture configuration, seeding, SQL, funding, or native VM creation is used.
 * Requires the production Studio compute allowlist to be exactly E2B Micro.
 */
import { createHash, randomUUID } from 'node:crypto';
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
import { createWickAdapter } from '../src/server/integrations/wick.js';
import type { WickAdapter } from '../src/server/integrations/types.js';
import type { StudioDetail, StudioTask } from '../src/shared/studio.js';
import type { DiskDetail, DiskWorkspace } from '../src/shared/disks.js';
import type { CatalogItem } from '../src/shared/types.js';

class ProbeFailure extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}
function check(value: unknown, code: string): asserts value {
  if (!value) throw new ProbeFailure(code);
}
check(process.env.RUN_HOSTED_STUDIO_DISK_E2E === '1', 'EXPLICIT_PAID_OPT_IN_REQUIRED');
const production = 'https://meta-hackathon-wick-production.up.railway.app';
let supplied: URL;
try {
  supplied = new URL(process.env.HOSTED_E2E_BASE_URL ?? production);
} catch {
  throw new ProbeFailure('INVALID_HOSTED_ORIGIN');
}
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
const repository = 'https://github.com/octocat/Hello-World';
const catalogId = 'e2b:micro:us';
const cleanupOnly = process.env.HOSTED_STUDIO_DISK_E2E_ACTION === 'cleanup';
check(!process.env.HOSTED_STUDIO_DISK_E2E_ACTION || cleanupOnly, 'UNSUPPORTED_PROBE_ACTION');
const budgetCents = Number(process.env.HOSTED_STUDIO_DISK_E2E_BUDGET_CENTS ?? 50);
check(
  Number.isInteger(budgetCents) && budgetCents >= 1 && budgetCents <= 50,
  'TASK_BUDGET_MUST_BE_1_TO_50_CENTS',
);
const file = resolve(
  process.env.HOSTED_STUDIO_DISK_E2E_REPORT_FILE ??
    'verification-results/hosted-studio-disks-e2e.json',
);
const journalFile = file.replace(/\.json$/, '') + '.journal.json';
mkdirSync(dirname(file), { recursive: true, mode: 0o700 });

type Input = {
  operationKey: string;
  goal: string;
  repositoryUrl: string;
  budgetCents: number;
  durationMinutes: 15;
  allowInstant: true;
  allowedProviders: ('baseten' | 'modal')[];
  testCommand: string;
  diskId: string;
  workspaceId?: string;
};
type TaskReceipt = {
  stage: 'first' | 'continuation';
  marker: string;
  input: Input;
  id?: string;
  vmId?: string;
  environmentId?: string;
  workspaceId?: string;
  codingJobId?: string;
  commitSha?: string;
  completed?: boolean;
};
type Journal = {
  runId: string;
  baseUrl: string;
  ownerId: string;
  startedAt: string;
  nativeScope: { apiBase: string; organizationId: string; groupId: string };
  disk: {
    name: string;
    createKey: string;
    deleteKey: string;
    attempted?: boolean;
    id?: string;
    nativeId?: string;
    deleteAttempted?: boolean;
    deleted?: boolean;
  };
  tasks: TaskReceipt[];
};
const report: {
  runId?: string;
  passed: boolean;
  cleanupConfirmed: boolean;
  startedAt: string;
  completedAt?: string;
  errorCode?: string;
  cleanupErrors: string[];
  events: Record<string, unknown>[];
} = {
  passed: false,
  cleanupConfirmed: false,
  startedAt: new Date().toISOString(),
  cleanupErrors: [],
  events: [],
};
let journal: Journal | undefined;
let reportOwned = false;
let cookie = '';
let native: WickAdapter | undefined;
let nativeScope: Journal['nativeScope'];
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
  durable(file, report);
}
function event(kind: string, data: Record<string, unknown> = {}) {
  report.events.push({ at: new Date().toISOString(), kind, ...data });
  save();
  console.log(JSON.stringify({ kind, ...data }));
}
function safe(error: unknown) {
  return error instanceof ProbeFailure ? error.code : 'PROBE_OPERATION_UNCONFIRMED';
}
function id(value: unknown): string {
  check(typeof value === 'string' && /^[a-f0-9-]{36}$/i.test(value), 'INVALID_BROKER_RESOURCE_ID');
  return value;
}
async function json<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  check(path.startsWith('/api/') && !path.startsWith('//'), 'BROKER_API_PATH_REQUIRED');
  const response = await fetch(baseUrl + path, {
    method,
    redirect: 'error',
    signal: AbortSignal.timeout(20000),
    headers: {
      Origin: baseUrl,
      ...(cookie ? { Cookie: cookie } : {}),
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new ProbeFailure(`BROKER_HTTP_${response.status}`);
  }
  const reader = response.body?.getReader();
  check(reader, 'MISSING_RESPONSE_BODY');
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      bytes += part.value.length;
      check(bytes <= 1024 * 1024, 'BROKER_RESPONSE_TOO_LARGE');
      chunks.push(part.value);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as T;
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}
async function authenticate() {
  const password = process.env.SEED_BUYER_PASSWORD;
  check(password, 'EXISTING_BUYER_PASSWORD_REQUIRED');
  const response = await fetch(baseUrl + '/api/auth/sign-in/email', {
    method: 'POST',
    redirect: 'error',
    signal: AbortSignal.timeout(15000),
    headers: { Origin: baseUrl, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: process.env.SEED_BUYER_EMAIL ?? 'buyer@demo.wick.local',
      password,
    }),
  });
  check(response.ok, 'BUYER_SIGN_IN_FAILED');
  cookie = response.headers
    .getSetCookie()
    .map((entry) => entry.split(';')[0])
    .join('; ');
  await response.body?.cancel();
  check(cookie, 'BUYER_SESSION_MISSING');
  return json<{
    user: { id: string; role: string };
    modes: { wick: string; muse: string };
    catalog: CatalogItem[];
  }>('/api/me');
}
async function diskDetail() {
  check(journal?.disk.id, 'RUN_DISK_ID_MISSING');
  return json<DiskDetail>(`/api/disks/${id(journal.disk.id)}`);
}
async function taskDetail(task: TaskReceipt, strict = true): Promise<StudioDetail> {
  check(task.id && journal, 'RUN_TASK_ID_MISSING');
  const detail = await json<StudioDetail>(`/api/studio/tasks/${id(task.id)}`);
  check(
    detail.task.id === task.id &&
      detail.task.goal.startsWith(task.marker) &&
      detail.task.repositoryUrl === repository &&
      detail.task.diskId === journal.disk.id,
    'TASK_RUN_OWNERSHIP_MISMATCH',
  );
  if (strict) {
    check(
      detail.task.budgetCents === task.input.budgetCents &&
        detail.task.spentCents <= task.input.budgetCents,
      'TASK_SPEND_BOUND_VIOLATED',
    );
    if (detail.task.plan)
      check(detail.task.plan.catalogId === catalogId, 'TASK_LEFT_E2B_MICRO_ALLOWLIST');
  }
  return detail;
}
async function discoverVm(task: TaskReceipt, detail: StudioDetail) {
  if (!detail.vm || !journal || !native) return;
  task.vmId = id(detail.vm.id);
  const vm = await json<{
    id: string;
    buyerId: string;
    diskId?: string;
    requestId: string;
    environmentId?: string;
  }>(`/api/vms/${task.vmId}`);
  check(
    vm.buyerId === journal.ownerId &&
      vm.diskId === journal.disk.id &&
      vm.requestId === detail.task.vmRequestId,
    'VM_RUN_OWNERSHIP_MISMATCH',
  );
  if (!vm.environmentId || task.environmentId) {
    save();
    return;
  }
  const request = await json<{ request: { catalogId: string } }>(
    `/api/requests/${id(vm.requestId)}`,
  );
  check(request.request.catalogId === catalogId, 'VM_LEFT_E2B_MICRO_ALLOWLIST');
  const environment = await native.get(vm.environmentId);
  check(
    environment.id === vm.environmentId &&
      environment.organizationId === nativeScope.organizationId &&
      environment.groupId === nativeScope.groupId &&
      environment.provider === 'e2b' &&
      environment.profile === 'micro',
    'NATIVE_VM_IDENTITY_MISMATCH',
  );
  if (!environment.workspaceDrive?.driveId) return;
  check(
    environment.workspaceDrive.accessMode === 'mount' &&
      environment.workspaceDrive.attachmentMode === 'shared',
    'NATIVE_SHARED_MOUNT_REQUIRED',
  );
  if (journal.disk.nativeId)
    check(journal.disk.nativeId === environment.workspaceDrive.driveId, 'NATIVE_DISK_CHANGED');
  journal.disk.nativeId = environment.workspaceDrive.driveId;
  task.environmentId = environment.id;
  save();
}
async function recoverTask(task: TaskReceipt) {
  if (task.id || !journal) return;
  let cursor: string | undefined;
  const matches: StudioTask[] = [];
  for (let page = 0; page < 10; page++) {
    const data = await json<{ items: StudioTask[]; nextCursor?: string }>(
      `/api/studio/tasks?limit=100${cursor ? '&cursor=' + encodeURIComponent(cursor) : ''}`,
    );
    matches.push(
      ...data.items.filter(
        (t) =>
          t.goal.startsWith(task.marker) &&
          t.repositoryUrl === repository &&
          t.diskId === journal!.disk.id,
      ),
    );
    cursor = data.nextCursor;
    if (!cursor) break;
  }
  check(matches.length === 1, 'TASK_ADMISSION_UNKNOWN_RETAIN_ORIGINAL_JOURNAL');
  task.id = id(matches[0]!.id);
  save();
}
async function waitForTask(task: TaskReceipt) {
  const until = Date.now() + 9 * 60000;
  let previous = '';
  for (;;) {
    const detail = await taskDetail(task);
    await discoverVm(task, detail);
    if (previous !== detail.task.status) {
      previous = detail.task.status;
      event('task-status', { stage: task.stage, taskId: task.id, status: previous });
    }
    if (['completed', 'failed', 'stopped'].includes(detail.task.status)) return detail;
    check(
      !['needs_budget', 'needs_attention'].includes(detail.task.status),
      'TASK_REQUIRES_REVIEW_NO_AUTOMATIC_FUNDING_OR_RETRY',
    );
    check(Date.now() < until, 'TASK_TIME_BOUND_EXCEEDED');
    await delay(2000);
  }
}
const quote = (text: string) => "'" + text.replaceAll("'", "'\\''") + "'";
function command(first: string, second?: string) {
  const checks = [
    `from pathlib import Path`,
    `assert Path("broker_disk_probe.txt").read_text() == ${JSON.stringify(first + '\n')}`,
  ];
  if (second)
    checks.push(
      `assert Path("broker_disk_continued.txt").read_text() == ${JSON.stringify(second + '\n')}`,
    );
  checks.push(`print("${second ? 'disk-continuation-pass' : 'disk-first-pass'}")`);
  const result = 'python3 -c ' + quote(checks.join('; '));
  check(result.length <= 500, 'TEST_COMMAND_TOO_LONG');
  return result;
}
async function startTask(stage: TaskReceipt['stage'], first: string, second?: string) {
  check(journal?.disk.id && journal.tasks.length < 2, 'TWO_TASK_LIMIT_EXCEEDED');
  const marker = `[disk-e2e:${journal.runId}:${stage}]`;
  const previous = journal.tasks[0];
  const task: TaskReceipt = {
    stage,
    marker,
    input: {
      operationKey: `hosted-studio-disk:${journal.runId}:${stage}`,
      repositoryUrl: repository,
      goal: second
        ? `${marker} Continue this saved workspace. Read broker_disk_probe.txt and preserve its exact existing contents ${JSON.stringify(first + '\n')}. Add only broker_disk_continued.txt containing exactly ${JSON.stringify(second + '\n')}. Run the supplied test and finish.`
        : `${marker} Add only broker_disk_probe.txt containing exactly ${JSON.stringify(first + '\n')}. Preserve existing files. Run the supplied test and finish.`,
      budgetCents,
      durationMinutes: 15,
      allowInstant: true,
      allowedProviders: qualifiedModelProviders,
      testCommand: command(first, second),
      diskId: journal.disk.id,
      ...(second ? { workspaceId: previous.workspaceId } : {}),
    },
  };
  if (second)
    check(previous.completed && previous.workspaceId, 'COMPLETED_FIRST_WORKSPACE_REQUIRED');
  journal.tasks.push(task);
  save(); // Persist the exact request before any paid task admission.
  const started = await json<StudioTask>('/api/studio/tasks', 'POST', task.input);
  task.id = id(started.id);
  task.workspaceId = id(started.workspaceId);
  save();
  return task;
}
async function fileText(key: string) {
  check(native?.drives && journal?.disk.nativeId, 'NATIVE_DISK_READ_IDENTITY_MISSING');
  const value = await native.drives.readFile(journal.disk.nativeId, key);
  check(value.size <= 65536, 'PERSISTED_ARTIFACT_TOO_LARGE');
  return Buffer.from(value.contentBase64, 'base64').toString('utf8');
}
async function verifyCompletion(task: TaskReceipt, detail: StudioDetail, expected: string) {
  check(journal && native?.drives, 'NATIVE_DISK_READ_ACCESS_REQUIRED');
  check(
    detail.task.status === 'completed' &&
      detail.task.mode === 'real' &&
      detail.task.executionStartedAt &&
      detail.task.verifiedAt &&
      detail.task.completedAt,
    'TASK_DID_NOT_COMPLETE_REAL_EXECUTION',
  );
  check(
    detail.vm?.cleanupConfirmedAt &&
      ['terminated', 'expired'].includes(detail.vm.status) &&
      detail.task.reservedCents === 0,
    'TASK_CLEANUP_OR_ACCOUNTING_UNCONFIRMED',
  );
  check(
    detail.tests?.exitCode === 0 &&
      detail.tests.output.includes(
        task.stage === 'first' ? 'disk-first-pass' : 'disk-continuation-pass',
      ),
    'TASK_TEST_RECEIPT_MISSING',
  );
  task.workspaceId = id(detail.task.workspaceId);
  task.codingJobId = id(detail.task.codingJobId);
  task.commitSha = detail.task.commitSha;
  check(detail.task.diskId === journal.disk.id, 'TASK_DISK_CHANGED');
  if (task.stage === 'continuation')
    check(
      detail.task.continuingWorkspace &&
        task.workspaceId === journal.tasks[0].workspaceId &&
        task.commitSha === journal.tasks[0].commitSha &&
        task.id !== journal.tasks[0].id &&
        task.vmId !== journal.tasks[0].vmId,
      'WORKSPACE_CONTINUATION_IDENTITY_MISMATCH',
    );
  const current = await diskDetail();
  const workspace = current.workspaces.find((w: DiskWorkspace) => w.id === task.workspaceId);
  check(
    workspace?.initialized &&
      workspace.activeTaskId === null &&
      current.attachments.length === 0 &&
      current.disk.status === 'ready',
    'WORKSPACE_NOT_RELEASED_AFTER_TASK',
  );
  const prefix = `workspaces/${task.workspaceId}/`;
  check(
    (await fileText(
      prefix +
        'repository/' +
        (task.stage === 'first' ? 'broker_disk_probe.txt' : 'broker_disk_continued.txt'),
    )) ===
      expected + '\n',
    'PERSISTED_WORKSPACE_CONTENT_MISMATCH',
  );
  const patchKey = prefix + `artifacts/${task.codingJobId}.patch`;
  const metadataKey = prefix + `artifacts/${task.codingJobId}.json`;
  const patch = await fileText(patchKey);
  check(patch.includes(expected), 'PERSISTED_PATCH_MISSING_EXPECTED_CHANGE');
  const metadata = JSON.parse(await fileText(metadataKey));
  check(
    metadata.jobId === task.codingJobId && metadata.baseCommit === task.commitSha,
    'PERSISTED_JOB_METADATA_MISMATCH',
  );
  const page = await native.drives.listFiles(journal.disk.nativeId!, {
    prefix: prefix + 'artifacts/',
  });
  const tests = page.data
    .filter(
      (entry) =>
        entry.key.startsWith(prefix + `artifacts/${task.codingJobId}.test.`) &&
        entry.key.endsWith('.json'),
    )
    .sort(
      (a, b) =>
        Number(/\.test\.(\d+)\.json$/.exec(b.key)?.[1] ?? -1) -
        Number(/\.test\.(\d+)\.json$/.exec(a.key)?.[1] ?? -1),
    )
    .slice(0, 20);
  let persistedTest = false;
  for (const entry of tests) {
    const receipt = JSON.parse(await fileText(entry.key));
    if (
      receipt.jobId === task.codingJobId &&
      receipt.result?.exitCode === 0 &&
      receipt.result.output?.includes(
        task.stage === 'first' ? 'disk-first-pass' : 'disk-continuation-pass',
      )
    )
      persistedTest = true;
  }
  check(persistedTest, 'PERSISTED_PASSING_TEST_RECEIPT_MISSING');
  task.completed = true;
  save();
  event('task-verified', {
    stage: task.stage,
    taskId: task.id,
    workspaceId: task.workspaceId,
    spentCents: detail.task.spentCents,
    patchSha256: createHash('sha256').update(patch).digest('hex'),
    nativeReadOnlyArtifactsVerified: true,
  });
  return {
    patchKey,
    metadataKey,
    patchSha256: createHash('sha256').update(patch).digest('hex'),
    metadataSha256: createHash('sha256')
      .update(await fileText(metadataKey))
      .digest('hex'),
  };
}
async function cleanup() {
  if (!journal) return;
  for (const task of journal.tasks) {
    try {
      await recoverTask(task);
      const detail = await taskDetail(task, false);
      if (!['completed', 'failed', 'stopped'].includes(detail.task.status))
        await json(`/api/studio/tasks/${id(task.id)}/stop`, 'POST', {});
      if (detail.vm && !detail.vm.cleanupConfirmedAt)
        await json(`/api/vms/${id(detail.vm.id)}/terminate`, 'POST', {
          operationKey: `hosted-studio-cleanup:${journal.runId}:${task.stage}`,
        });
    } catch (error) {
      report.cleanupErrors.push(safe(error));
    }
  }
  const until = Date.now() + 5 * 60000;
  let pending = journal.tasks.filter((task) => task.id);
  while (pending.length && Date.now() < until) {
    const next: TaskReceipt[] = [];
    for (const task of pending) {
      try {
        const detail = await taskDetail(task, false);
        if (
          !['completed', 'failed', 'stopped'].includes(detail.task.status) ||
          (detail.vm && !detail.vm.cleanupConfirmedAt) ||
          detail.task.reservedCents !== 0
        )
          next.push(task);
      } catch {
        next.push(task);
      }
    }
    pending = next;
    if (pending.length) await delay(2000);
  }
  if (pending.length) report.cleanupErrors.push('RUN_TASK_CLEANUP_UNCONFIRMED');
  if (!journal.disk.id && journal.disk.attempted) {
    let cursor: string | undefined;
    const matches: { id: string; name: string }[] = [];
    for (let page = 0; page < 10; page++) {
      const data = await json<{ items: { id: string; name: string }[]; nextCursor?: string }>(
        `/api/disks?limit=100${cursor ? '&cursor=' + encodeURIComponent(cursor) : ''}`,
      );
      matches.push(...data.items.filter((d) => d.name === journal!.disk.name));
      cursor = data.nextCursor;
      if (!cursor) break;
    }
    if (matches.length === 1) {
      journal.disk.id = id(matches[0].id);
      save();
    } else report.cleanupErrors.push('DISK_ADMISSION_UNKNOWN_RETAIN_ORIGINAL_JOURNAL');
  }
  if (journal.disk.id && !journal.disk.deleted) {
    try {
      const current = await diskDetail();
      check(current.disk.name === journal.disk.name, 'CLEANUP_DISK_RUN_IDENTITY_MISMATCH');
      if (current.disk.status !== 'deleted') {
        check(
          current.disk.canDelete || journal.disk.deleteAttempted,
          'RUN_DISK_HAS_UNRESOLVED_REFERENCES',
        );
        journal.disk.deleteAttempted = true;
        save();
        await json(`/api/disks/${id(journal.disk.id)}`, 'DELETE', {
          operationKey: journal.disk.deleteKey,
        });
        for (const expires = Date.now() + 120000; Date.now() < expires;) {
          const observed = await diskDetail();
          if (observed.disk.status === 'deleted') break;
          await delay(2000);
        }
      }
      journal.disk.deleted = (await diskDetail()).disk.status === 'deleted';
      save();
      check(journal.disk.deleted, 'RUN_DISK_DELETION_UNCONFIRMED');
    } catch (error) {
      report.cleanupErrors.push(safe(error));
    }
  }
  report.cleanupConfirmed =
    report.cleanupErrors.length === 0 && (!journal.disk.attempted || journal.disk.deleted === true);
  save();
}
let qualifiedModelProviders: ('baseten' | 'modal')[] = [];
try {
  check(
    cleanupOnly || !existsSync(journalFile),
    'EXISTING_JOURNAL_USE_CLEANUP_ACTION_OR_NEW_REPORT_PATH',
  );
  const owner = await authenticate();
  check(
    owner.user?.role === 'buyer' && owner.modes?.wick === 'real' && owner.modes.muse === 'real',
    'REAL_OWNER_SESSION_REQUIRED',
  );
  check(
    process.env.WICK_API_BASE &&
      process.env.WICK_API_KEY &&
      process.env.WICK_ORGANIZATION_ID &&
      process.env.WICK_GROUP_ID,
    'NATIVE_READ_ONLY_RUNTIME_REQUIRED_FOR_ARTIFACT_VERIFICATION',
  );
  nativeScope = {
    apiBase: process.env.WICK_API_BASE,
    organizationId: process.env.WICK_ORGANIZATION_ID,
    groupId: process.env.WICK_GROUP_ID,
  };
  native = createWickAdapter({
    wickMode: 'real',
    wickApiBase: nativeScope.apiBase,
    wickApiKey: process.env.WICK_API_KEY,
    wickOrganizationId: nativeScope.organizationId,
    wickGroupId: nativeScope.groupId,
  });
  if (cleanupOnly) {
    const saved = JSON.parse(readFileSync(journalFile, 'utf8')) as Journal;
    check(
      saved.baseUrl === baseUrl &&
        saved.ownerId === owner.user.id &&
        JSON.stringify(saved.nativeScope) === JSON.stringify(nativeScope) &&
        saved.tasks.length <= 2,
      'JOURNAL_RUNTIME_SCOPE_CHANGED',
    );
    journal = saved;
    reportOwned = true;
    report.runId = journal.runId;
    event('cleanup-recovery');
  } else {
    // The public Studio API has no per-task compute selector. This attests the
    // deployed operator allowlist; actual plans and VM requests are checked too.
    check(
      process.env.STUDIO_APPROVED_COMPUTE_CATALOG_IDS?.split(',')
        .map((value) => value.trim())
        .join(',') === catalogId,
      'DEPLOYED_STUDIO_ALLOWLIST_MUST_BE_E2B_MICRO_ONLY',
    );
    const [options, disks, credits, models] = await Promise.all([
      json<{ available: boolean; mode: string }>('/api/studio/options'),
      json<{ enabled: boolean; mode: string; eligibleCatalogIds: string[] }>('/api/disks/options'),
      json<{ availableCents: number }>('/api/credits'),
      json<{
        enabled: boolean;
        mode: string;
        routes: { provider: string; mode: string; qualified: boolean }[];
      }>('/api/inference/models'),
    ]);
    check(
      options.available &&
        options.mode === 'real' &&
        disks.enabled &&
        disks.mode === 'real' &&
        disks.eligibleCatalogIds.includes(catalogId),
      'HOSTED_STUDIO_DISK_SUPPORT_NOT_READY',
    );
    const route = owner.catalog.find((item) => item.id === catalogId);
    check(
      route?.approved &&
        route.provider === 'e2b' &&
        route.profile === 'micro' &&
        route.durationMinutes.includes(15) &&
        route.capabilities?.includes('persistent-drives'),
      'EXPECTED_E2B_MICRO_ROUTE_NOT_AVAILABLE',
    );
    qualifiedModelProviders = models.routes
      .filter(
        (item) =>
          item.mode === 'real' && item.qualified && ['baseten', 'modal'].includes(item.provider),
      )
      .map((item) => item.provider as 'baseten' | 'modal');
    check(
      models.enabled &&
        models.mode === 'real' &&
        qualifiedModelProviders.length > 0 &&
        qualifiedModelProviders.length <= 2,
      'QUALIFIED_REAL_MODEL_ROUTE_REQUIRED',
    );
    check(
      credits.availableCents >= budgetCents * 2,
      'INSUFFICIENT_EXISTING_WALLET_CREDIT_NO_AUTOMATIC_FUNDING',
    );
    const runId = randomUUID();
    const initial: Journal = {
      runId,
      baseUrl,
      ownerId: owner.user.id,
      startedAt: report.startedAt,
      nativeScope,
      disk: {
        name: `broker-studio-disk-e2e-${runId}`,
        createKey: `hosted-studio-disk:${runId}`,
        deleteKey: `hosted-studio-disk-delete:${runId}`,
      },
      tasks: [],
    };
    durable(journalFile, initial, true);
    journal = initial;
    reportOwned = true;
    report.runId = runId;
    event('preflight-passed', {
      maximumTasks: 2,
      maximumBudgetPerTaskCents: budgetCents,
      maximumTotalBudgetCents: budgetCents * 2,
      catalogId,
      allowlistEvidence: 'operator_runtime_attestation_and_actual_task_plan',
    });
    journal.disk.attempted = true;
    save();
    const created = await json<{ id: string }>('/api/disks', 'POST', {
      name: journal.disk.name,
      operationKey: journal.disk.createKey,
    });
    journal.disk.id = id(created.id);
    save();
    let ready = false;
    for (const until = Date.now() + 120000; Date.now() < until;) {
      const observed = await diskDetail();
      if (observed.disk.status === 'ready') {
        ready = true;
        break;
      }
      check(observed.disk.status !== 'failed', 'RUN_DISK_CREATION_FAILED');
      await delay(2000);
    }
    check(ready, 'RUN_DISK_CREATION_UNCONFIRMED');
    const firstValue = `persisted-${runId}`,
      secondValue = `continued-${runId}`;
    const first = await startTask('first', firstValue);
    const retained = await verifyCompletion(first, await waitForTask(first), firstValue);
    const second = await startTask('continuation', firstValue, secondValue);
    await verifyCompletion(second, await waitForTask(second), secondValue);
    check(
      (await fileText(`workspaces/${first.workspaceId}/repository/broker_disk_probe.txt`)) ===
        firstValue + '\n',
      'FIRST_TASK_FILE_CHANGED_DURING_CONTINUATION',
    );
    check(
      createHash('sha256')
        .update(await fileText(retained.patchKey))
        .digest('hex') === retained.patchSha256 &&
        createHash('sha256')
          .update(await fileText(retained.metadataKey))
          .digest('hex') === retained.metadataSha256,
      'FIRST_TASK_ARTIFACTS_CHANGED_DURING_CONTINUATION',
    );
    report.passed = true;
    event('continuation-verified', {
      diskId: journal.disk.id,
      workspaceId: first.workspaceId,
      priorFilesAndArtifactsPreserved: true,
    });
  }
} catch (error) {
  report.errorCode = safe(error);
} finally {
  if (journal) {
    try {
      await cleanup();
    } catch (error) {
      report.cleanupErrors.push(safe(error));
      save();
    }
  }
  report.completedAt = new Date().toISOString();
  if (!report.cleanupConfirmed) report.passed = false;
  save();
  console.log(
    JSON.stringify({
      runId: report.runId,
      passed: report.passed,
      cleanupConfirmed: report.cleanupConfirmed,
      errorCode: report.errorCode,
      cleanupErrors: report.cleanupErrors,
    }),
  );
  if (report.errorCode || report.cleanupErrors.length || !report.cleanupConfirmed)
    process.exitCode = 1;
}
