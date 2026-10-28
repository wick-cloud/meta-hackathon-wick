import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CreateEnvironmentInput, WickAdapter } from '../src/server/integrations/types.js';
import {
  CONTROL_DIRECTORY,
  Journal,
  cleanupJournal,
  createScaleGuard,
  percentiles,
  replayIntents,
  type Header,
} from '../scripts/live-scale/safety.js';

const directories: string[] = [];
const approval = {
  organizationId: 'org_fixture',
  groupId: 'group_fixture',
  provider: 'boat',
  profile: 'small',
  region: 'auto',
  catalogId: 'boat:small:auto',
};
const unscopedInput: CreateEnvironmentInput = {
  ...approval,
  name: 'wick-broker-fixture',
  ttlSeconds: 900,
  visibility: 'private',
  maximumPriceMicrosPerSecond: 5,
};
delete (unscopedInput as unknown as Record<string, unknown>).catalogId;
function setup() {
  mkdirSync(CONTROL_DIRECTORY, { recursive: true, mode: 0o700 });
  const dir = mkdtempSync(join(CONTROL_DIRECTORY, 'offline-scale-'));
  directories.push(dir);
  const journal = new Journal(join(dir, 'journal.jsonl'));
  journal.append('prepared', {
    runId: randomUUID(),
    appUrl: 'http://127.0.0.1:49123',
    approval,
    maximumRunMs: 60_000,
  });
  const header = journal.header();
  const create = vi.fn(async (_body: CreateEnvironmentInput, key: string) => ({
    environment: {
      id: `fixture_${key}`,
      status: 'running' as const,
      expiresAt: new Date(Date.now() + 900_000).toISOString(),
    },
  }));
  const adapter = {
    mode: 'real',
    create,
    list: vi.fn(async () => ({ items: [] })),
    get: vi.fn(async (id: string) => ({ id, status: 'terminated', expiresAt: null })),
    terminate: vi.fn(async () => undefined),
  } as unknown as WickAdapter;
  const guard = createScaleGuard({
    adapter,
    journal,
    header,
    owns: async (key) => ({ vmId: key, requestId: `request_${key}` }),
    watchdogReady: () => true,
    deadline: Date.now() + 60_000,
    approvedRate: () => 5,
  });
  return {
    journal,
    header,
    adapter,
    create,
    guard,
    input: { ...unscopedInput, name: `broker-scale-${header.runId}-fixture-` },
  };
}
afterEach(() => {
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('offline live-scale admission safety; all adapters are local fakes', () => {
  it('durably writes exact key/body before calling create and excludes credentials', async () => {
    const { journal, header, create, guard, input } = setup();
    create.mockImplementation(async (body, key) => {
      const records = journal.read();
      expect(records.find((r) => r.kind === 'create-intent')).toMatchObject({ key, body });
      expect(records.at(-1)).toMatchObject({ kind: 'create-start', key });
      expect(body.name).toContain(header.runId);
      expect(JSON.stringify(records)).not.toMatch(/token|password|apiKey/);
      return {
        environment: {
          id: 'fixture_only',
          status: 'running',
          expiresAt: new Date(Date.now() + 900000).toISOString(),
        },
      };
    });
    await guard.adapter.create(input, 'fixture-key-1');
    expect(statSync(journal.path).mode & 0o077).toBe(0);
  });
  it('blocks every allocation when watchdog readiness is absent', async () => {
    const { journal, header, adapter, create, input } = setup();
    const guard = createScaleGuard({
      adapter,
      journal,
      header,
      owns: async () => ({ vmId: 'fixture-', requestId: 'request' }),
      watchdogReady: () => false,
      deadline: Date.now() + 10000,
      approvedRate: () => 5,
    });
    await expect(guard.adapter.create(input, 'fixture-key-1')).rejects.toThrow('guard');
    expect(create).not.toHaveBeenCalled();
  });
  it('blocks foreign ownership, wrong pin, TTL, workload, and rate before transport', async () => {
    for (const bad of [
      { ...unscopedInput, ttlSeconds: 1800 },
      { ...unscopedInput, provider: 'other' },
      { ...unscopedInput, organizationId: 'foreign' },
      { ...unscopedInput, command: 'whoami' },
      { ...unscopedInput, maximumPriceMicrosPerSecond: 6 },
    ]) {
      const { create, guard, input } = setup();
      await expect(
        guard.adapter.create({ ...bad, name: input.name }, 'fixture-key-bad'),
      ).rejects.toThrow();
      expect(create).not.toHaveBeenCalled();
    }
    const { journal, header, adapter, create, input } = setup();
    const guard = createScaleGuard({
      adapter,
      journal,
      header,
      owns: async () => {
        assert.fail('Foreign key');
      },
      watchdogReady: () => true,
      deadline: Date.now() + 10000,
      approvedRate: () => 5,
    });
    await expect(guard.adapter.create(input, 'fixture-key-foreign')).rejects.toThrow();
    expect(create).not.toHaveBeenCalled();
  });
  it('admits at most twenty distinct keys and never allocates a twenty-first', async () => {
    const { create, guard, input } = setup();
    for (let index = 0; index < 20; index++)
      await guard.adapter.create(input, `fixture-key-${index}`);
    await expect(guard.adapter.create(input, 'fixture-key-21')).rejects.toThrow('guard');
    expect(create).toHaveBeenCalledTimes(20);
    expect(guard.keyCount).toBe(20);
  }, 10000);
  it('blocks ALL retries after stop, including the original exact key/body', async () => {
    const { create, guard, input } = setup();
    await guard.adapter.create(input, 'fixture-key-1');
    guard.stop();
    await expect(guard.adapter.create(input, 'fixture-key-1')).rejects.toThrow('guard');
    await expect(guard.adapter.create(input, 'fixture-key-2')).rejects.toThrow();
    expect(create).toHaveBeenCalledTimes(1);
  });
  it('checks stop again after pacing an already-started retry', async () => {
    const { create, guard, input } = setup();
    for (let index = 0; index < 5; index++)
      await guard.adapter.create(input, `fixture-key-${index}`);
    const retry = guard.adapter.create(input, 'fixture-key-0');
    await new Promise<void>((resolve) => setImmediate(resolve));
    guard.stop();
    await expect(retry).rejects.toThrow();
    expect(create).toHaveBeenCalledTimes(5);
  });
  it('checks persistent stop markers on retries even when the readiness callback is stale', async () => {
    const { journal, create, guard, input } = setup();
    await guard.adapter.create(input, 'fixture-key-1');
    journal.append('stop-requested', { reason: 'offline-test' });
    await expect(guard.adapter.create(input, 'fixture-key-1')).rejects.toThrow();
    expect(create).toHaveBeenCalledTimes(1);
  });
  it.each(['watchdog', 'deadline'])(
    'fences an existing-key retry when %s expires',
    async (reason) => {
      const { journal, header, adapter, create, input } = setup();
      let ready = true;
      let deadline = Date.now() + 60_000;
      const guard = createScaleGuard({
        adapter,
        journal,
        header,
        owns: async (key) => ({ vmId: key, requestId: key }),
        watchdogReady: () => ready,
        get deadline() {
          return deadline;
        },
        approvedRate: () => 5,
      });
      await guard.adapter.create(input, 'fixture-key-1');
      if (reason === 'watchdog') ready = false;
      else deadline = Date.now() - 1;
      await expect(guard.adapter.create(input, 'fixture-key-1')).rejects.toThrow();
      expect(create).toHaveBeenCalledTimes(1);
    },
  );
  it('rechecks admission after the durable start write before invoking transport', async () => {
    const { journal, guard, create, input } = setup();
    const append = journal.append.bind(journal);
    vi.spyOn(journal, 'append').mockImplementation((kind, fields) => {
      const result = append(kind, fields);
      if (kind === 'create-start') guard.stop();
      return result;
    });
    await expect(guard.adapter.create(input, 'fixture-before-transport')).rejects.toThrow();
    expect(create).not.toHaveBeenCalled();
    expect(journal.read().some((record) => record.kind === 'create-start')).toBe(true);
  });
  it('never labels post-dispatch assertions or journal failures conclusive admission rejection', async () => {
    for (const failure of ['assertion', 'write']) {
      const { journal, guard, create, input } = setup();
      const append = journal.append.bind(journal);
      vi.spyOn(journal, 'append').mockImplementation((kind, fields) => {
        if (kind === 'create-result') {
          if (failure === 'assertion') assert.fail('Synthetic receipt assertion.');
          throw new Error('Synthetic disk write failure.');
        }
        return append(kind, fields);
      });
      let caught: unknown;
      try {
        await guard.adapter.create(input, 'fixture-uncertain');
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(Error);
      expect(caught).not.toHaveProperty('admissionRejected', true);
      expect(create).toHaveBeenCalledTimes(1);
      expect(journal.read().some((record) => record.kind === 'create-start')).toBe(true);
    }
  });
  it('never mistakes a queued unstarted intent for permission to allocate after stop', async () => {
    const { journal, create, guard, input } = setup();
    for (let index = 0; index < 5; index++)
      await guard.adapter.create(input, `fixture-key-${index}`);
    const queued = guard.adapter.create(input, 'fixture-key-queued');
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(
      journal.read().some((r) => r.kind === 'create-intent' && r.key === 'fixture-key-queued'),
    ).toBe(false);
    guard.stop();
    await expect(queued).rejects.toThrow();
    await expect(guard.adapter.create(input, 'fixture-key-queued')).rejects.toThrow();
    expect(create).toHaveBeenCalledTimes(5);
  });
  it('stops new keys on SDK failure and on later observed upstream failure', async () => {
    const { adapter, create, guard, input } = setup();
    vi.mocked(adapter.get).mockResolvedValue({
      id: 'fixture_failed',
      status: 'failed',
      expiresAt: null,
    });
    await guard.adapter.get('fixture_failed');
    await expect(guard.adapter.create(input, 'fixture-key-after-failure')).rejects.toThrow();
    expect(create).not.toHaveBeenCalled();
  });
  it('does not turn expected cleanup termination into a validation failure', async () => {
    const { journal, header, adapter, input } = setup();
    const failure = vi.fn();
    const guard = createScaleGuard({
      adapter,
      journal,
      header,
      owns: async () => ({ vmId: 'fixture-', requestId: 'request' }),
      watchdogReady: () => true,
      deadline: Date.now() + 10000,
      approvedRate: () => 5,
      onFailure: failure,
    });
    guard.stop();
    await guard.adapter.get('fixture_terminated');
    expect(failure).not.toHaveBeenCalled();
  });
  it('does not grant reconciliation permission when the durable start write fails', async () => {
    const { journal, guard, create, input } = setup();
    const append = journal.append.bind(journal);
    const failing = vi.spyOn(journal, 'append').mockImplementation((kind, fields) => {
      if (kind === 'create-start') throw new Error('Synthetic disk write failure.');
      return append(kind, fields);
    });
    await expect(guard.adapter.create(input, 'fixture-unwritten-start')).rejects.toThrow();
    failing.mockRestore();
    await expect(guard.adapter.create(input, 'fixture-unwritten-start')).rejects.toThrow();
    expect(create).not.toHaveBeenCalled();
  });
  it('shares the five-starts-per-second gate across independent guard instances', async () => {
    const { journal, header, adapter, guard, input } = setup();
    const second = createScaleGuard({
      adapter,
      journal,
      header,
      owns: async (key) => ({ vmId: key, requestId: key }),
      watchdogReady: () => true,
      deadline: Date.now() + 30000,
      approvedRate: () => 5,
    });
    await Promise.all(
      Array.from({ length: 12 }, (_, index) =>
        (index % 2 ? guard : second).adapter.create(input, `fixture-shared-${index}`),
      ),
    );
    const starts = journal
      .read()
      .filter((record) => record.kind === 'create-start')
      .map((record) => Date.parse(record.at));
    expect(starts).toHaveLength(12);
    for (const start of starts)
      expect(
        starts.filter((time) => time >= start && time < start + 1000).length,
      ).toBeLessThanOrEqual(5);
    expect(starts.at(-1)! - starts[0]).toBeGreaterThanOrEqual(2000);
  }, 10000);
});

describe('offline exact-resource cleanup journal', () => {
  it('never creates during cleanup: crash before transport and missing result both remain UNKNOWN', async () => {
    const { journal, header, adapter, create, input } = setup();
    for (const key of ['fixture-started', 'fixture-unstarted']) {
      journal.append('create-intent', {
        key,
        body: { ...input, name: `broker-scale-${header.runId}-${key}` },
        vmId: key,
        requestId: key,
      });
      if (key === 'fixture-started') journal.append('create-start', { key });
    }
    expect(await cleanupJournal(journal, adapter, 1000)).toEqual([
      'fixture-started',
      'fixture-unstarted',
    ]);
    expect(create).not.toHaveBeenCalled();
    expect(adapter.terminate).not.toHaveBeenCalled();
    expect(journal.read().at(-1)).toMatchObject({ intents: 2, confirmed: 0 });
  });
  it('discovers missing receipts through bounded exact run list matches without replay', async () => {
    const { journal, header, adapter, create, input } = setup();
    const key = 'fixture-lost-result';
    const body = { ...input, name: `broker-scale-${header.runId}-lost` };
    journal.append('create-intent', { key, body, vmId: key, requestId: key });
    journal.append('create-start', { key });
    const match = {
      ...body,
      id: 'fixture_found',
      status: 'running' as const,
      expiresAt: null,
      createdAt: new Date().toISOString(),
    };
    vi.mocked(adapter.list!).mockResolvedValue({
      items: [
        { ...match, id: 'fixture_foreign', groupId: 'foreign-group' },
        { ...match, id: 'fixture_old', createdAt: '2020-01-01T00:00:00.000Z' },
        match,
      ],
    });
    expect(await cleanupJournal(journal, adapter, 1000)).toEqual([]);
    expect(create).not.toHaveBeenCalled();
    expect(adapter.get).toHaveBeenCalledExactlyOnceWith('fixture_found');
    expect(adapter.list).toHaveBeenCalledTimes(2);
    expect(adapter.list).toHaveBeenCalledWith({
      organizationId: approval.organizationId,
      groupId: approval.groupId,
      search: `broker-scale-${header.runId}-`,
      provider: 'boat',
      limit: 50,
      newest: true,
      archived: false,
    });
    expect(journal.read().at(-1)).toMatchObject({ intents: 1, confirmed: 1, unresolved: [] });
  });
  it('bounds discovery to six pages and leaves missing or mismatched metadata unresolved', async () => {
    const { journal, header, adapter, create, input } = setup();
    const key = 'fixture-missing-metadata';
    const body = { ...input, name: `broker-scale-${header.runId}-lost` };
    journal.append('create-intent', { key, body, vmId: key, requestId: key });
    journal.append('create-start', { key });
    let pages = 0;
    vi.mocked(adapter.list!).mockImplementation(async () => ({
      items: [
        {
          ...body,
          id: 'fixture_not_owned',
          status: 'running',
          expiresAt: null,
        },
      ],
      nextCursor: `page-${++pages}`,
    }));
    expect(await cleanupJournal(journal, adapter, 1000)).toEqual([key]);
    expect(adapter.list).toHaveBeenCalledTimes(6);
    expect(create).not.toHaveBeenCalled();
    expect(adapter.terminate).not.toHaveBeenCalled();
  });
  it('does not treat an empty recorded-ID list as complete when any intent exists', async () => {
    const { journal, header, adapter, input } = setup();
    journal.append('create-intent', {
      key: 'fixture-no-start',
      body: { ...input, name: `broker-scale-${header.runId}-no-start` },
      vmId: 'vm',
      requestId: 'request',
    });
    expect(await cleanupJournal(journal, adapter, 1000)).toEqual(['fixture-no-start']);
    expect(journal.read().at(-1)).toMatchObject({ intents: 1, confirmed: 0 });
  });
  it('terminates later exact IDs even if the first resource never confirms cleanup', async () => {
    const { journal, header, adapter, input } = setup();
    for (const key of ['fixture-stuck', 'fixture-healthy']) {
      journal.append('create-intent', {
        key,
        body: { ...input, name: `broker-scale-${header.runId}-${key}` },
        vmId: key,
        requestId: key,
      });
      journal.append('create-start', { key });
      journal.append('create-result', { key, environmentId: key });
    }
    const terminated = new Set<string>();
    vi.mocked(adapter.terminate).mockImplementation(async (id) => {
      terminated.add(id);
    });
    vi.mocked(adapter.get).mockImplementation(async (id) => ({
      id,
      status: id === 'fixture-healthy' && terminated.has(id) ? 'terminated' : 'running',
      expiresAt: null,
    }));
    expect(await cleanupJournal(journal, adapter, 50)).toEqual(['fixture-stuck']);
    expect(terminated).toEqual(new Set(['fixture-stuck', 'fixture-healthy']));
  });
  it('rejects conflicting bodies and ambiguity instead of broad environment deletion', () => {
    const { journal, header, input } = setup();
    for (const rate of [5, 6])
      journal.append('create-intent', {
        key: 'fixture-key-conflict',
        body: {
          ...input,
          maximumPriceMicrosPerSecond: rate,
          name: `broker-scale-${header.runId}-vm`,
        },
        vmId: 'vm',
        requestId: 'request',
      });
    expect(() => replayIntents(journal.read(), header as Header)).toThrow('changed');
  });
  it('retries termination after a transient initial read failure without abandoning the ID', async () => {
    const { journal, header, adapter, input } = setup();
    journal.append('create-intent', {
      key: 'fixture-retry',
      body: { ...input, name: `broker-scale-${header.runId}-retry` },
      vmId: 'vm',
      requestId: 'request',
    });
    journal.append('create-start', { key: 'fixture-retry' });
    journal.append('create-result', { key: 'fixture-retry', environmentId: 'fixture_retry' });
    let reads = 0;
    vi.mocked(adapter.get).mockImplementation(async (id) => {
      if (++reads === 1) throw new Error('Synthetic transient read failure.');
      return {
        id,
        status: vi.mocked(adapter.terminate).mock.calls.length ? 'terminated' : 'running',
        expiresAt: null,
      };
    });
    expect(await cleanupJournal(journal, adapter, 2000)).toEqual([]);
    expect(adapter.terminate).toHaveBeenCalledExactlyOnceWith('fixture_retry');
  });
  it('reports nearest-rank p50/p95/max from measured values only', () => {
    expect(percentiles(Array.from({ length: 20 }, (_, i) => i + 1))).toEqual({
      p50: 10,
      p95: 19,
      max: 20,
    });
    expect(() => percentiles([])).toThrow();
  });
});
