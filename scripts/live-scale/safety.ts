import assert from 'node:assert/strict';
import {
  closeSync,
  constants,
  existsSync,
  fchmodSync,
  fsyncSync,
  openSync,
  readFileSync,
  statSync,
  writeSync,
} from 'node:fs';
import { resolve, dirname, relative } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { spawn } from 'node:child_process';
import type {
  CreateEnvironmentInput,
  WickAdapter,
  WickEnvironment,
} from '../../src/server/integrations/types.js';

export const CONTROL_DIRECTORY = resolve(process.cwd(), '../.broker-run/real-wick-20261028');
export const MAX_CREATES = 20;
const MAX_JOURNAL_BYTES = 4 * 1024 * 1024;
const MAX_RECORD_BYTES = 16 * 1024;
export type JournalRecord = { kind: string; at: string; [key: string]: unknown };
export type Approval = {
  organizationId: string;
  groupId: string;
  provider: string;
  profile: string;
  region: string;
  catalogId: string;
};
export type Header = JournalRecord & {
  kind: 'prepared';
  runId: string;
  appUrl: string;
  approval: Approval;
  maximumRunMs: number;
};

/** Private append-only, fsynced before mutations. Every record is bounded and contains no credentials. */
export class Journal {
  constructor(public readonly path: string) {
    assert(resolve(path) === path, 'Journal path must be absolute.');
    const child = relative(CONTROL_DIRECTORY, path);
    assert(
      child && !child.startsWith('..') && !child.startsWith('/'),
      'Journal must be in the dedicated control directory.',
    );
    assert(statSync(dirname(path)).isDirectory(), 'Create the private control directory first.');
    if (existsSync(path)) {
      const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        assert((statSync(path).mode & 0o077) === 0, 'Journal permissions must be private.');
      } finally {
        closeSync(fd);
      }
    }
  }
  append(kind: string, fields: Record<string, unknown> = {}) {
    assert(!('kind' in fields) && !('at' in fields));
    const record = { kind, at: new Date().toISOString(), ...fields };
    const line = `${JSON.stringify(record)}\n`;
    assert(Buffer.byteLength(line) <= MAX_RECORD_BYTES, 'Journal record exceeds its bound.');
    assert(
      !existsSync(this.path) ||
        statSync(this.path).size + Buffer.byteLength(line) <= MAX_JOURNAL_BYTES,
      'Journal exceeds its bound.',
    );
    const fd = openSync(
      this.path,
      constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      fchmodSync(fd, 0o600);
      assert.equal(writeSync(fd, line), Buffer.byteLength(line), 'Journal append was incomplete.');
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    return record;
  }
  read(): JournalRecord[] {
    assert(statSync(this.path).size <= MAX_JOURNAL_BYTES, 'Journal exceeds its bound.');
    const fd = openSync(this.path, constants.O_RDONLY | constants.O_NOFOLLOW);
    let text: string;
    try {
      text = readFileSync(fd, 'utf8');
    } finally {
      closeSync(fd);
    }
    // An interrupted append is never usable authorization for a create/replay.
    assert(text.endsWith('\n'), 'Journal has an incomplete append; manual inspection is required.');
    const records = text
      .trimEnd()
      .split('\n')
      .map((line) => JSON.parse(line) as JournalRecord);
    assert(
      records.length <= 20000 &&
        records.every((r) => typeof r.kind === 'string' && Number.isFinite(Date.parse(r.at))),
      'Invalid journal.',
    );
    return records;
  }
  header(): Header {
    const header = this.read()[0] as Header;
    assert(
      header?.kind === 'prepared' && /^[0-9a-f-]{36}$/.test(header.runId),
      'Invalid journal header.',
    );
    assert(header.maximumRunMs > 0 && header.maximumRunMs <= 12 * 60_000);
    return header;
  }
}

export function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.keys(value)
    .sort()
    .filter((k) => (value as Record<string, unknown>)[k] !== undefined)
    .map((k) => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`)
    .join(',')}}`;
}

export function validateCreate(body: CreateEnvironmentInput, approval: Approval, runId: string) {
  const allowed = new Set([
    'organizationId',
    'groupId',
    'name',
    'provider',
    'profile',
    'region',
    'ttlSeconds',
    'visibility',
    'maximumPriceMicrosPerSecond',
    'providerKeyId',
  ]);
  assert(
    Object.keys(body).every((key) => allowed.has(key)),
    'Scale guard rejected unsupported create fields.',
  );
  for (const field of ['organizationId', 'groupId', 'provider', 'profile', 'region'] as const)
    assert.equal(body[field], approval[field], `Scale guard rejected ${field}.`);
  assert.equal(body.ttlSeconds, 900, 'Scale guard permits only the approved 15-minute TTL.');
  assert.equal(body.visibility, 'private');
  assert(
    body.providerKeyId === undefined ||
      (typeof body.providerKeyId === 'string' &&
        body.providerKeyId.length > 0 &&
        body.providerKeyId.length <= 200),
    'Invalid provider key identity.',
  );
  assert(
    body.name.startsWith(`broker-scale-${runId}-`),
    'Scale environment name must be scoped to the run.',
  );
  const rate = (body as unknown as Record<string, unknown>).maximumPriceMicrosPerSecond;
  assert(
    (typeof rate === 'number' && Number.isSafeInteger(rate) && rate > 0) ||
      (typeof rate === 'string' && /^[1-9][0-9]*$/.test(rate)),
    'Scale create requires a frozen maximum rate.',
  );
}

export type CreateIntent = {
  key: string;
  body: CreateEnvironmentInput;
  vmId: string;
  requestId: string;
};
export function replayIntents(records: JournalRecord[], header: Header): Map<string, CreateIntent> {
  const entries = new Map<string, CreateIntent>();
  for (const record of records.filter((r) => r.kind === 'create-intent')) {
    const intent = record as unknown as CreateIntent;
    assert(typeof intent.key === 'string' && intent.key.length >= 8 && intent.key.length <= 200);
    assert(typeof intent.vmId === 'string' && typeof intent.requestId === 'string');
    validateCreate(intent.body, header.approval, header.runId);
    const previous = entries.get(intent.key);
    if (previous)
      assert.equal(
        canonical(previous),
        canonical({
          key: intent.key,
          body: intent.body,
          vmId: intent.vmId,
          requestId: intent.requestId,
        }),
        'Persisted create body changed.',
      );
    entries.set(intent.key, {
      key: intent.key,
      body: intent.body,
      vmId: intent.vmId,
      requestId: intent.requestId,
    });
  }
  assert(entries.size <= MAX_CREATES, 'Journal exceeds the independent allocation ceiling.');
  return entries;
}

function intentTimes(records: JournalRecord[], key: string) {
  const intentAt = Math.min(
    ...records
      .filter((record) => record.kind === 'create-intent' && record.key === key)
      .map((record) => Date.parse(record.at)),
  );
  const starts = records.filter((record) => record.kind === 'create-start' && record.key === key);
  return {
    earliest: intentAt - 5000,
    latest: Math.max(intentAt, ...starts.map((record) => Date.parse(record.at))) + 120_000,
  };
}
function environmentOwned(
  environment: WickEnvironment,
  body: CreateEnvironmentInput,
  times: { earliest: number; latest: number },
) {
  return (
    environment.name === body.name &&
    environment.organizationId === body.organizationId &&
    environment.groupId === body.groupId &&
    environment.provider === body.provider &&
    environment.profile === body.profile &&
    (body.providerKeyId === undefined || environment.providerKeyId === body.providerKeyId) &&
    typeof environment.createdAt === 'string' &&
    Date.parse(environment.createdAt) >= times.earliest &&
    Date.parse(environment.createdAt) <= times.latest &&
    Date.parse(environment.createdAt) <= Date.now() + 5000
  );
}

/** flock is released by the OS on process death; every active create attempt shares this gate. */
async function creationGate<T>(journal: Journal, action: () => Promise<T>): Promise<T> {
  const lock = spawn(
    'flock',
    ['-x', '-w', '10', `${journal.path}.create-lock`, 'sh', '-c', 'printf locked; read release'],
    { stdio: ['pipe', 'pipe', 'ignore'] },
  );
  let released = false;
  const release = () => {
    if (!released && !lock.stdin.destroyed && !lock.stdin.writableEnded) lock.stdin.end('\n');
    released = true;
  };
  // A killed child can close its pipe before release; report acquisition failure without uncaught EPIPE.
  lock.stdin.on('error', () => undefined);
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        release();
        reject(new Error('Shared creation gate timed out.'));
      }, 12_000);
      lock.once('error', () => {
        clearTimeout(timer);
        reject(new Error('Shared creation gate unavailable.'));
      });
      lock.once('exit', () => {
        clearTimeout(timer);
        reject(new Error('Shared creation gate exited before acquisition.'));
      });
      lock.stdout.once('data', () => {
        clearTimeout(timer);
        resolve();
      });
    });
    return await action();
  } finally {
    release();
  }
}

/** Closing admission uses the same OS lock as the journal-write/SDK-invocation boundary. */
export async function closeAdmission(
  journal: Journal,
  kind: 'watchdog-triggered' | 'stop-requested',
  fields: Record<string, unknown>,
) {
  await creationGate(journal, async () => {
    journal.append(kind, fields);
  });
}

async function sharedCreate<T>(
  journal: Journal,
  fields: Record<string, unknown>,
  check: () => void,
  operation: () => Promise<T>,
): Promise<T> {
  const pending = await creationGate(journal, async () => {
    const starts = journal
      .read()
      .filter((record) => record.kind === 'create-start')
      .map((record) => Date.parse(record.at))
      .filter((at) => Date.now() - at < 1000);
    if (starts.length >= 5)
      await delay(Math.max(1, 1001 - (Date.now() - starts[starts.length - 5])));
    check();
    journal.append('create-start', fields);
    check(); // Recheck after durable writes, immediately before invoking transport.
    // Invoke transport while holding the gate, then release without waiting for its response.
    const result = operation();
    void result.catch(() => undefined);
    return { result };
  });
  return pending.result;
}

function guardError() {
  // A guard failure may occur after dispatch or after a lost journal write. Never claim
  // conclusive upstream rejection: lifecycle must retain the hold until reconciliation.
  return new Error(
    'Independent live-scale guard stopped the allocation; admission may be uncertain.',
  );
}
export function createScaleGuard(options: {
  adapter: WickAdapter;
  journal: Journal;
  header: Header;
  owns: (key: string) => Promise<{ vmId: string; requestId: string }>;
  watchdogReady: () => boolean;
  deadline: number;
  approvedRate: () => string | number | undefined;
  onFailure?: () => void;
}) {
  const { adapter, journal, header } = options;
  assert.equal(adapter.mode, 'real');
  const intents = replayIntents(journal.read(), header);
  let stopped = false;
  function stop() {
    stopped = true;
  }
  const stopForFailure = () => {
    if (!stopped) {
      stopped = true;
      options.onFailure?.();
    }
  };
  const wrapped: WickAdapter = {
    ...adapter,
    async get(id) {
      try {
        const environment = await adapter.get(id);
        if (['failed', 'terminating', 'terminated'].includes(environment.status)) {
          stopForFailure();
        }
        return environment;
      } catch (error) {
        stopForFailure();
        throw error;
      }
    },
    async create(input, key) {
      try {
        const owner = await options.owns(key);
        const body = { ...input };
        assert.equal(
          body.name,
          `broker-scale-${header.runId}-${owner.vmId.slice(0, 8)}`,
          'Scale name must match the durable Broker create input.',
        );
        assert(!body.providerKeyId, 'Scale guard permits only managed offerings.');
        validateCreate(body, header.approval, header.runId);
        assert.equal(
          String((body as unknown as Record<string, unknown>).maximumPriceMicrosPerSecond),
          String(options.approvedRate()),
          'Guard rate differs from the approved offering.',
        );
        const result = await sharedCreate(
          journal,
          { key },
          () => {
            // This check is inside the cross-process gate AFTER the rate wait and applies
            // to every dispatch, including retries of a previously started exact key.
            assert(
              !stopped &&
                Date.now() < options.deadline &&
                options.watchdogReady() &&
                !journal
                  .read()
                  .some((record) => ['watchdog-triggered', 'stop-requested'].includes(record.kind)),
              'Admission barrier is closed.',
            );
            const persisted = replayIntents(journal.read(), header);
            const prior = persisted.get(key);
            if (prior)
              assert.equal(
                canonical(prior.body),
                canonical(body),
                'Same create key cannot change body.',
              );
            else {
              assert(persisted.size < MAX_CREATES, 'Independent allocation ceiling reached.');
              const intent = { key, body, ...owner };
              journal.append('create-intent', intent);
              persisted.set(key, intent);
            }
            intents.clear();
            for (const [persistedKey, intent] of persisted) intents.set(persistedKey, intent);
          },
          () => adapter.create(body, key),
        );
        assert(
          environmentOwned(result.environment, body, intentTimes(journal.read(), key)),
          'Create result ownership was not established.',
        );
        const observed = journal.read().filter((r) => r.kind === 'create-result' && r.key === key);
        assert(
          observed.every((r) => r.environmentId === result.environment.id),
          'Same key returned multiple environments.',
        );
        journal.append('create-result', {
          key,
          environmentId: result.environment.id,
          status: result.environment.status,
          expiresAt: result.environment.expiresAt,
        });
        if (['failed', 'terminating', 'terminated'].includes(result.environment.status)) {
          stopForFailure();
        }
        return result;
      } catch (error) {
        stopForFailure();
        if (error instanceof assert.AssertionError) throw guardError();
        throw error;
      }
    },
  };
  return {
    adapter: wrapped,
    stop,
    get stopped() {
      return stopped;
    },
    get keyCount() {
      return intents.size;
    },
  };
}

export function percentiles(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  assert(sorted.length > 0 && sorted.every((n) => Number.isFinite(n) && n >= 0));
  return {
    p50: sorted[Math.ceil(sorted.length * 0.5) - 1],
    p95: sorted[Math.ceil(sorted.length * 0.95) - 1],
    max: sorted.at(-1)!,
  };
}

/** Read-only discovery is bounded and requires exact run ownership; cleanup never invokes create. */
export async function cleanupJournal(journal: Journal, adapter: WickAdapter, timeoutMs = 120_000) {
  await closeAdmission(journal, 'stop-requested', { reason: 'cleanup-only-fence' });
  const header = journal.header();
  const records = journal.read();
  const intents = replayIntents(records, header);
  const deadline = Date.now() + timeoutMs;
  const unresolved = new Set<string>();
  const owned: {
    key: string;
    id: string;
    confirmed: boolean;
    terminateAttempts: number;
    lastTerminateAt: number;
    body: CreateEnvironmentInput;
    times: { earliest: number; latest: number };
  }[] = [];
  async function bounded<T>(items: T[], operation: (item: T) => Promise<void>) {
    let next = 0;
    await Promise.all(
      Array.from({ length: Math.min(4, items.length) }, async () => {
        while (next < items.length) await operation(items[next++]);
      }),
    );
  }
  // This list is for recovery only: at most three pages in each of the active and
  // archived views. A missing match is UNKNOWN, never proof that no VM was admitted.
  const discovered: Awaited<ReturnType<NonNullable<WickAdapter['list']>>>['items'] = [];
  const needsDiscovery = [...intents.keys()].some(
    (key) => !records.some((record) => record.kind === 'create-result' && record.key === key),
  );
  if (needsDiscovery && adapter.list) {
    for (const archived of [false, true]) {
      let cursor: string | undefined;
      for (let page = 0; page < 3 && Date.now() < deadline; page++) {
        try {
          const response: Awaited<ReturnType<NonNullable<WickAdapter['list']>>> =
            await adapter.list({
              organizationId: header.approval.organizationId,
              groupId: header.approval.groupId,
              search: `broker-scale-${header.runId}-`,
              provider: header.approval.provider,
              limit: 50,
              newest: true,
              archived,
              ...(cursor ? { cursor } : {}),
            });
          assert(response.items.length <= 50, 'Environment page exceeded recovery bound.');
          discovered.push(...response.items);
          if (!response.nextCursor || response.nextCursor === cursor) break;
          cursor = response.nextCursor;
        } catch {
          break;
        }
      }
    }
  }
  await bounded([...intents], async ([key, intent]) => {
    const times = intentTimes(records, key);
    const outcomes = records.filter(
      (record) => record.kind === 'create-result' && record.key === key,
    );
    let ids = [...new Set(outcomes.map((record) => record.environmentId))];
    assert(
      ids.every((value) => typeof value === 'string' && value.length > 0),
      'Invalid environment receipt.',
    );
    if (!ids.length) {
      const matches = discovered.filter(
        (environment) =>
          environmentOwned(environment, intent.body, times) &&
          (environment.providerKeyId ?? undefined) === intent.body.providerKeyId,
      );
      ids = [...new Set(matches.map((environment) => environment.id))];
      if (ids.length === 1) {
        const match = matches.find((environment) => environment.id === ids[0])!;
        journal.append('create-result', {
          key,
          environmentId: match.id,
          status: match.status,
          expiresAt: match.expiresAt,
          discovery: 'bounded-exact-run-list',
        });
      }
    }
    // Multiple exact matches cannot establish which ID belongs to this create.
    // Do not delete any ambiguous match, and retain every intent in the accounting.
    if (ids.length !== 1) {
      unresolved.add(key);
      journal.append('cleanup-intent-unresolved', {
        key,
        classification: 'unknown-admission',
        ttlSeconds: 900,
      });
      return;
    }
    const id = ids[0] as string;
    const ownedItem = {
      key,
      id,
      body: intent.body,
      times,
      confirmed: false,
      terminateAttempts: 0,
      lastTerminateAt: 0,
    };
    owned.push(ownedItem);
    try {
      const environment = await adapter.get(id);
      assert.equal(environment.id, id);
      assert(
        environmentOwned(environment, intent.body, times),
        'Known receipt ownership was not confirmed.',
      );
      if (environment.status === 'terminated') {
        ownedItem.confirmed = true;
        return;
      }
      journal.append('cleanup-terminate', { key, environmentId: id });
      ownedItem.terminateAttempts++;
      ownedItem.lastTerminateAt = Date.now();
      await adapter.terminate(id);
    } catch {
      /* Uncertain reads never authorize releasing a hold. */
    }
  });
  while (owned.some((item) => !item.confirmed) && Date.now() < deadline) {
    await bounded(
      owned.filter((item) => !item.confirmed),
      async (item) => {
        try {
          const environment = await adapter.get(item.id);
          assert.equal(environment.id, item.id);
          assert(
            environmentOwned(environment, item.body, item.times),
            'Known receipt ownership was not confirmed.',
          );
          if (environment.status === 'terminated') item.confirmed = true;
          else if (item.terminateAttempts < 5 && Date.now() - item.lastTerminateAt >= 5000) {
            journal.append('cleanup-terminate', { key: item.key, environmentId: item.id });
            item.terminateAttempts++;
            item.lastTerminateAt = Date.now();
            await adapter.terminate(item.id);
          }
        } catch {
          /* A 404 or failed read never confirms cleanup. */
        }
      },
    );
    if (owned.some((item) => !item.confirmed))
      await delay(Math.min(1000, Math.max(1, deadline - Date.now())));
  }
  for (const item of owned) {
    if (item.confirmed)
      journal.append('upstream-cleanup-confirmed', { key: item.key, environmentId: item.id });
    else unresolved.add(item.id);
  }
  // The admission gate is already closed by callers. Still account for any intent
  // written at the boundary instead of letting an empty result list imply success.
  const latest = replayIntents(journal.read(), header);
  for (const key of latest.keys()) if (!intents.has(key)) unresolved.add(key);
  journal.append('cleanup-summary', {
    intents: latest.size,
    confirmed: owned.filter((item) => item.confirmed).length,
    unresolved: [...unresolved],
  });
  return [...unresolved];
}
