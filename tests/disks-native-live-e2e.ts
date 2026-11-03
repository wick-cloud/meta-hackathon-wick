/** Opt-in, bounded native shared-mount qualification. Never changes Broker data or flags. */
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import {
  mkdirSync,
  readFileSync,
  existsSync,
  openSync,
  writeFileSync,
  fsyncSync,
  closeSync,
  renameSync,
} from 'node:fs';
import { dirname, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createWickAdapter, parseCreateResult } from '../src/server/integrations/wick.js';
import { driveRequest } from '../src/server/integrations/drives.js';
import type { CreateEnvironmentInput, WickEnvironment } from '../src/server/integrations/types.js';

assert.equal(
  process.env.RUN_NATIVE_DISK_E2E,
  '1',
  'Set RUN_NATIVE_DISK_E2E=1 for the bounded paid probe.',
);
const config = {
  wickMode: 'real' as const,
  wickApiBase: process.env.WICK_API_BASE!,
  wickApiKey: process.env.WICK_API_KEY!,
  wickOrganizationId: process.env.WICK_ORGANIZATION_ID!,
  wickGroupId: process.env.WICK_GROUP_ID!,
};
assert(
  config.wickApiKey && config.wickOrganizationId && config.wickGroupId,
  'Native runtime configuration required.',
);
const adapter = createWickAdapter(config),
  drives = adapter.drives!;
const file = resolve(
  process.env.DISK_NATIVE_E2E_REPORT_FILE ?? 'test-results/disks-native-live-e2e.json',
);
const journalFile = file.replace(/\.json$/, '') + '.journal.json';
mkdirSync(dirname(file), { recursive: true });
type Allocation = {
  name: string;
  key: string;
  provider: string;
  input: CreateEnvironmentInput;
  id?: string;
  generation?: string;
  rejected?: boolean;
  terminated?: boolean;
};
type Journal = {
  runId: string;
  createdAt: string;
  organizationId: string;
  groupId: string;
  apiBase: string;
  driveName: string;
  driveKey: string;
  driveId?: string;
  deleteKey: string;
  deletionAccepted?: boolean;
  driveDeleted?: boolean;
  vms: Allocation[];
};
const cleanupOnly = process.env.DISK_NATIVE_E2E_ACTION === 'cleanup';
assert(
  cleanupOnly || !existsSync(journalFile),
  'Existing native journal: use DISK_NATIVE_E2E_ACTION=cleanup or a new report filename.',
);
const runId = randomUUID();
const journal: Journal = cleanupOnly
  ? JSON.parse(readFileSync(journalFile, 'utf8'))
  : {
      runId,
      createdAt: new Date().toISOString(),
      organizationId: config.wickOrganizationId,
      groupId: config.wickGroupId,
      apiBase: config.wickApiBase,
      driveName: `broker-disk-e2e-${runId}`,
      driveKey: `broker-disk-e2e:${runId}`,
      deleteKey: `broker-disk-e2e-delete:${runId}`,
      vms: [],
    };
assert(
  journal.organizationId === config.wickOrganizationId &&
    journal.groupId === config.wickGroupId &&
    journal.apiBase === config.wickApiBase,
  'Journal runtime scope changed.',
);
const report: {
  runId: string;
  startedAt: string;
  phase: string;
  success: boolean;
  qualificationPassed: boolean;
  completedAt?: string;
  events: Record<string, unknown>[];
  error?: string;
  cleanupErrors: string[];
} = {
  runId: journal.runId,
  startedAt: new Date().toISOString(),
  phase: 'preflight',
  success: false,
  qualificationPassed: false,
  events: [],
  cleanupErrors: [],
};
if (cleanupOnly && existsSync(file)) {
  const previous = JSON.parse(readFileSync(file, 'utf8')) as typeof report;
  Object.assign(report, previous, {
    phase: 'cleanup',
    success: false,
    cleanupErrors: [],
    qualificationPassed:
      previous.qualificationPassed ??
      previous.events.some((e) => e.kind === 'reattach-persistence'),
    events: [
      ...previous.events,
      {
        at: new Date().toISOString(),
        kind: 'cleanup-recovery',
        previousErrors: previous.cleanupErrors,
      },
    ],
  });
}
function durable(path: string, value: unknown) {
  const temp = path + '.tmp';
  const fd = openSync(temp, 'w', 0o600);
  try {
    writeFileSync(fd, JSON.stringify(value, null, 2) + '\n');
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(temp, path);
}
function save() {
  durable(journalFile, journal);
  durable(file, report);
}
function event(kind: string, data: Record<string, unknown> = {}) {
  report.events.push({ at: new Date().toISOString(), kind, ...data });
  save();
  console.log(JSON.stringify({ kind, ...data }));
}
function safe(error: unknown) {
  const message = error instanceof Error ? error.message : '';
  const status = /HTTP (\d{3})/.exec(message);
  return status
    ? `NATIVE_HTTP_${status[1]}`
    : error instanceof assert.AssertionError
      ? String(error.message).slice(0, 200)
      : 'Native operation failed; inspect phase and original resource identities.';
}
async function poll<T>(
  work: () => Promise<T>,
  done: (value: T) => boolean,
  label: string,
  seconds = 150,
): Promise<T> {
  const until = Date.now() + seconds * 1000;
  for (;;) {
    const value = await work();
    if (done(value)) return value;
    if (Date.now() >= until) throw new Error(`${label} remained unconfirmed`);
    await delay(2000);
  }
}
const quote = (s: string) => "'" + s.replaceAll("'", "'\\''") + "'";
async function command(environmentId: string, source: string) {
  const result = await adapter.runCommand!(environmentId, {
    command: `python3 -c ${quote(source)}`,
    cwd: '/workspace',
  });
  assert.equal(result.exitCode, 0, 'Guest probe command failed.');
  assert(!result.simulated, 'Guest probe returned simulated execution.');
  return result.stdout.trim();
}
async function recoverAllocation(a: Allocation) {
  if (a.id || a.rejected) return;
  assert(adapter.list);
  const matches: WickEnvironment[] = [];
  for (const archived of [false, true]) {
    let cursor: string | undefined;
    for (let page = 0; page < 4; page++) {
      const result = await adapter.list({
        organizationId: journal.organizationId,
        groupId: journal.groupId,
        search: a.name,
        provider: a.provider,
        limit: 50,
        newest: true,
        archived,
        ...(cursor ? { cursor } : {}),
      });
      matches.push(
        ...result.items.filter(
          (e) =>
            e.name === a.name &&
            e.organizationId === journal.organizationId &&
            e.groupId === journal.groupId,
        ),
      );
      cursor = result.nextCursor;
      if (!cursor) break;
    }
  }
  const ids = [...new Set(matches.map((e) => e.id))];
  assert.equal(
    ids.length,
    1,
    'Uncertain admission could not be uniquely discovered; retain its original journal.',
  );
  a.id = ids[0];
  save();
}
async function stop(a: Allocation) {
  await recoverAllocation(a);
  if (!a.id || a.terminated) return;
  let env = await adapter.get(a.id);
  assert.equal(env.name, a.name, 'Cleanup environment name mismatch.');
  assert.equal(env.organizationId, journal.organizationId, 'Cleanup organization mismatch.');
  assert.equal(env.groupId, journal.groupId, 'Cleanup group mismatch.');
  if (env.status !== 'terminated') await adapter.terminate(a.id);
  await poll(
    () => adapter.get(a.id!),
    (e) => e.status === 'terminated',
    'VM termination',
  );
  a.terminated = true;
  save();
  event('vm-terminated', { provider: a.provider, id: a.id });
}
async function cleanup() {
  for (const a of journal.vms) {
    try {
      await stop(a);
    } catch (e) {
      report.cleanupErrors.push(safe(e));
      save();
    }
  }
  if (!journal.driveId) {
    try {
      const page = (await driveRequest(
        config,
        `v1/organizations/${encodeURIComponent(journal.organizationId)}/drives?limit=200`,
      )) as { data: { id: string; name: string; groupId: string }[] };
      const matches = page.data.filter(
        (d) => d.name === journal.driveName && d.groupId === journal.groupId,
      );
      if (matches.length === 1) {
        journal.driveId = matches[0].id;
        save();
      } else if (matches.length > 1) throw new Error('Drive discovery ambiguous.');
    } catch (e) {
      report.cleanupErrors.push(safe(e));
    }
  }
  if (!journal.driveId || journal.driveDeleted) return;
  if (journal.vms.some((a) => !a.rejected && !a.terminated)) {
    report.cleanupErrors.push('Unresolved VM admission; drive retained.');
    save();
    return;
  }
  try {
    await poll(
      () => drives.get(journal.driveId!),
      (r) => r.drive.attachments.length === 0 && !r.drive.cleanupPending,
      'Drive detach',
    );
    if (!journal.deletionAccepted) {
      const first = await drives.delete(journal.driveId, journal.deleteKey);
      journal.deletionAccepted = true;
      save();
      event('delete-accepted', {
        status: first.drive.status,
        operationStatus: first.operation.status,
      });
      await delay(1000);
      const replay = await drives.delete(journal.driveId, journal.deleteKey);
      event('delete-replayed', {
        status: replay.drive.status,
        operationStatus: replay.operation.status,
      });
    }
    await poll(
      () => drives.get(journal.driveId!),
      (r) => r.drive.status === 'deleted' && !r.drive.cleanupPending,
      'Drive deletion',
    );
    journal.driveDeleted = true;
    save();
    event('drive-deleted', { driveId: journal.driveId });
  } catch (e) {
    report.cleanupErrors.push(safe(e));
    save();
  }
}
save();
try {
  if (!cleanupOnly) {
    const catalog = await adapter.catalog();
    const routes = ['e2b', 'modal'].map((provider) => {
      const item = catalog.find(
        (c) =>
          c.provider === provider &&
          c.profile === 'micro' &&
          c.capabilities?.includes('persistent-drives'),
      );
      assert(item, `No native micro mount route for ${provider}.`);
      return item;
    });
    assert(
      routes.reduce(
        (sum, r) => sum + Number(r.rateMicrosPerSecond) * 600,
        Number(routes[0].rateMicrosPerSecond) * 600,
      ) <= 100000,
      'Estimated compute exceeds $0.10 ceiling.',
    );
    event('preflight', {
      routes: routes.map((r) => ({ id: r.id, rateMicrosPerSecond: r.rateMicrosPerSecond })),
      maximumAdmissions: 3,
      ttlSeconds: 600,
    });
    report.phase = 'drive-create';
    save();
    const created = await drives.create({ name: journal.driveName }, journal.driveKey);
    journal.driveId = created.drive.id;
    save();
    const replay = await drives.create({ name: journal.driveName }, journal.driveKey);
    assert.equal(replay.drive.id, journal.driveId, 'Drive create replay changed identity.');
    await poll(
      () => drives.get(journal.driveId!),
      (r) => r.drive.status === 'ready' && !r.drive.cleanupPending,
      'Drive create',
    );
    event('drive-ready', { driveId: journal.driveId });
    async function launch(index: number, route: (typeof routes)[number]) {
      report.phase = `launch-${index}`;
      const input: CreateEnvironmentInput = {
        organizationId: journal.organizationId,
        groupId: journal.groupId,
        name: `broker-disk-e2e-${journal.runId}-${index}`,
        provider: route.provider,
        profile: route.profile,
        region: route.region,
        ttlSeconds: 600,
        maximumPriceMicrosPerSecond: route.rateMicrosPerSecond,
        visibility: 'private',
        workspaceDrive: { driveId: journal.driveId!, accessMode: 'mount' },
      };
      const execution = (await driveRequest(config, 'v1/execution-preview', 'POST', {
        kind: 'environment',
        input,
      })) as { eligible?: boolean; selectedOffer?: { provider?: string; billingMode?: string } };
      assert.equal(execution.eligible, true, 'Native execution preview is ineligible.');
      assert.equal(
        execution.selectedOffer?.provider,
        route.provider,
        'Native preview changed provider.',
      );
      assert.equal(
        execution.selectedOffer?.billingMode,
        'wick_managed',
        'Native preview is not managed.',
      );
      const preview = (await driveRequest(config, 'v1/environments/preview', 'POST', input)) as {
        eligible?: boolean;
      };
      assert.equal(preview.eligible, true, 'Native mounted VM preview is ineligible.');
      const a: Allocation = {
        name: input.name,
        key: `broker-disk-e2e-vm:${journal.runId}:${index}`,
        provider: route.provider,
        input,
      };
      journal.vms.push(a);
      save();
      try {
        const result = parseCreateResult(
          await driveRequest(config, 'v1/environments', 'POST', input, a.key),
        );
        a.id = result.environment.id;
        save();
      } catch (e) {
        if (/HTTP (400|422)/.test(e instanceof Error ? e.message : '')) {
          a.rejected = true;
          save();
        }
        throw e;
      }
      const env = await poll(
        () => adapter.get(a.id!),
        (e) => e.status === 'running' || e.status === 'failed' || e.status === 'terminated',
        'VM readiness',
      );
      assert.equal(env.status, 'running', 'Native VM did not reach running.');
      assert.equal(env.organizationId, journal.organizationId, 'Native VM organization mismatch.');
      assert.equal(env.groupId, journal.groupId, 'Native VM group mismatch.');
      assert.equal(env.provider, route.provider, 'Native VM route drift.');
      assert.equal(env.workspaceDrive?.driveId, journal.driveId, 'Native VM drive mismatch.');
      assert.equal(env.workspaceDrive?.status, 'mounted', 'Native VM mount is not confirmed.');
      assert.equal(env.workspaceDrive?.accessMode, 'mount', 'Native VM is not using mount access.');
      assert.equal(
        env.workspaceDrive?.attachmentMode,
        'shared',
        'Native VM is not sharing its mount.',
      );
      assert(
        env.workspaceDrive?.workspacePath === undefined ||
          env.workspaceDrive.workspacePath === '/workspace',
        'Native VM mount path differs from /workspace.',
      );
      assert(env.workspaceDrive?.generation, 'Native mount generation missing.');
      assert(
        journal.vms.every(
          (other) => other === a || other.generation !== env.workspaceDrive!.generation,
        ),
        'Native mount generation was reused by a different VM.',
      );
      a.generation = env.workspaceDrive.generation;
      save();
      event('vm-mounted', { provider: a.provider, id: a.id, workspaceDrive: env.workspaceDrive });
      return a;
    }
    const a = await launch(0, routes[0]);
    const b = await launch(1, routes[1]);
    const prefix = `qualification/${journal.runId}`,
      pathA = `${prefix}/a.txt`,
      pathB = `${prefix}/b.txt`,
      valueA = `provider-a-${journal.runId}`,
      valueB = `provider-b-${journal.runId}`;
    const write = async (vm: Allocation, path: string, value: string) =>
      command(
        vm.id!,
        `import os,json,hashlib;from pathlib import Path;p=Path('/workspace')/${JSON.stringify(path)};p.parent.mkdir(parents=True,exist_ok=True);t=p.with_suffix('.tmp');f=open(t,'w');f.write(${JSON.stringify(value)});f.flush();os.fsync(f.fileno());f.close();os.replace(t,p);d=os.open(str(p.parent),os.O_RDONLY);os.fsync(d);os.close(d);print(hashlib.sha256(p.read_bytes()).hexdigest())`,
      );
    const read = async (vm: Allocation, path: string) =>
      command(
        vm.id!,
        `from pathlib import Path;print((Path('/workspace')/${JSON.stringify(path)}).read_text())`,
      );
    report.phase = 'shared-files';
    save();
    await Promise.all([write(a, pathA, valueA), write(b, pathB, valueB)]);
    assert.equal(
      await read(b, pathA),
      valueA,
      'Provider B cannot read acknowledged provider A writes.',
    );
    assert.equal(
      await read(a, pathB),
      valueB,
      'Provider A cannot read acknowledged provider B writes.',
    );
    const https = await drives.readFile(journal.driveId!, pathA);
    assert.equal(
      Buffer.from(https.contentBase64, 'base64').toString(),
      valueA,
      'Shared HTTPS reads diverge from mounted bytes.',
    );
    event('cross-provider-files', {
      paths: [pathA, pathB],
      sha256: [valueA, valueB].map((v) => createHash('sha256').update(v).digest('hex')),
      httpsReadMatches: true,
    });
    report.phase = 'independent-detachment';
    save();
    await stop(a);
    await poll(
      () => drives.get(journal.driveId!),
      (r) => !r.drive.attachments.some((x) => x.environmentId === a.id),
      'First VM detach',
    );
    assert.equal(await read(b, pathA), valueA, 'Surviving VM lost mounted files.');
    await write(b, `${prefix}/after-detach.txt`, 'survived');
    await stop(b);
    await poll(
      () => drives.get(journal.driveId!),
      (r) => r.drive.attachments.length === 0,
      'Both VMs detach',
    );
    report.phase = 'reattach';
    save();
    const c = await launch(2, routes[0]);
    assert.equal(await read(c, pathA), valueA, 'Provider A file was lost across reattachment.');
    assert.equal(await read(c, pathB), valueB, 'Provider B file was lost across reattachment.');
    assert.equal(
      await read(c, `${prefix}/after-detach.txt`),
      'survived',
      'Post-detach write was lost.',
    );
    event('reattach-persistence', { provider: c.provider, verifiedFiles: 3 });
    report.qualificationPassed = true;
  }
} catch (error) {
  report.error = safe(error);
  event('qualification-failed', { phase: report.phase, error: report.error });
} finally {
  report.phase = 'cleanup';
  save();
  await cleanup();
  report.success =
    report.qualificationPassed &&
    !!journal.driveDeleted &&
    !report.error &&
    report.cleanupErrors.length === 0;
  report.completedAt = new Date().toISOString();
  save();
}
console.log(
  JSON.stringify({
    runId: journal.runId,
    success: report.success,
    driveDeleted: journal.driveDeleted ?? false,
    cleanupErrors: report.cleanupErrors,
    report: file,
  }),
);
if (!report.success && !cleanupOnly) process.exitCode = 1;
if (report.cleanupErrors.length) process.exitCode = 1;
