import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  now: 0,
  stopAfterIntent: false,
  get: vi.fn(),
  terminate: vi.fn(),
  create: vi.fn(),
  list: vi.fn(),
}));
vi.mock('../src/server/integrations/wick.js', () => ({
  createWickAdapter: () => ({
    get: state.get,
    terminate: state.terminate,
    create: state.create,
    list: state.list,
  }),
}));
// Advance only the runner's bounded polling clock; no test waits three real minutes.
vi.mock('node:timers/promises', () => ({
  setTimeout: async (milliseconds: number) => {
    state.now += milliseconds;
    await Promise.resolve();
  },
}));
vi.mock('../scripts/live-scale/safety.js', async (original) => {
  const actual = await original<typeof import('../scripts/live-scale/safety.js')>();
  return {
    ...actual,
    Journal: class extends actual.Journal {
      override append(kind: string, fields: Record<string, unknown> = {}) {
        const record = super.append(kind, fields);
        if (state.stopAfterIntent && kind === 'request-intent')
          super.append('stop-requested', { reason: 'offline-post-intent-fence' });
        return record;
      }
    },
  };
});

const control = resolve(process.cwd(), '../.broker-run/real-wick-20261028');
const providers = [
  ['e2b', 'us'],
  ['daytona', 'us'],
  ['modal', 'auto'],
  ['provider-blaxel', 'us-pdx-1'],
].map(([provider, region]) => ({
  provider,
  region,
  profile: 'micro',
  name: provider,
  cookie: `fixture-${provider}`,
  catalogId: `${provider}:micro:${region}`,
  rateMicrosPerSecond: 23,
  capacity: 5,
}));
const settings = {
  baseUrl: 'https://hosted-scale.invalid',
  buyerCookie: 'fixture-buyer',
  adminCookie: 'fixture-admin',
  target: 20,
  providers,
  wick: {
    baseUrl: 'https://wick-hosted-scale.invalid/api',
    token: 'inert-fixture-token',
    organizationId: 'fixture-organization',
    groupId: 'fixture-group',
  },
};

describe('hosted live-run safety with inert settings and zero external calls', () => {
  let directory: string;
  let settingsPath: string;
  let journalPath: string;
  let runId: string;
  let records: Record<string, unknown>[];
  const originalArgv = [...process.argv];
  const originalExitCode = process.exitCode;
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    state.now = Date.now();
    state.stopAfterIntent = false;
    vi.spyOn(Date, 'now').mockImplementation(() => state.now);
    state.create.mockImplementation(() => {
      throw new Error('No native creates permitted');
    });
    state.list.mockImplementation(() => {
      throw new Error('No broad native discovery permitted');
    });
    mkdirSync(control, { recursive: true, mode: 0o700 });
    directory = mkdtempSync(resolve(control, 'offline-hosted-'));
    settingsPath = resolve(directory, 'settings.json');
    journalPath = resolve(directory, 'journal.jsonl');
    writeFileSync(settingsPath, JSON.stringify(settings), { mode: 0o600 });
    runId = randomUUID();
    const fingerprint = createHash('sha256')
      .update(
        JSON.stringify({
          baseUrl: settings.baseUrl,
          scope: [settings.wick.organizationId, settings.wick.groupId],
          providers: providers.map((p) => [
            p.provider,
            p.catalogId,
            p.profile,
            p.region,
            p.rateMicrosPerSecond,
          ]),
        }),
      )
      .digest('hex');
    records = [
      {
        kind: 'prepared',
        runId,
        target: 20,
        maximumRunMs: 720000,
        baseUrl: settings.baseUrl,
        fingerprint,
        at: new Date().toISOString(),
      },
    ];
  });
  afterEach(() => {
    process.argv = originalArgv;
    process.exitCode = originalExitCode;
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    rmSync(directory, { recursive: true, force: true });
  });
  async function invoke(command: 'run' | 'cleanup') {
    writeFileSync(journalPath, records.map((r) => JSON.stringify(r)).join('\n') + '\n', {
      mode: 0o600,
    });
    process.argv = [
      'node',
      'hosted-scale.ts',
      command,
      '--settings',
      settingsPath,
      '--journal',
      journalPath,
    ];
    let finish!: (result: Record<string, any>) => void;
    const done = new Promise<Record<string, any>>((resolveResult) => {
      finish = resolveResult;
    });
    vi.spyOn(console, 'log').mockImplementation((line: string) => {
      const result = JSON.parse(line);
      if ('confirmed' in result || 'cleanup' in result) finish(result);
    });
    await import('../scripts/hosted-scale.js');
    return done;
  }

  it('cleans later exact native receipts when Broker and an earlier native lookup fail', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: URL) => {
        expect(url.hostname).toBe('hosted-scale.invalid');
        throw new Error('Fixture Broker outage');
      }),
    );
    const at = new Date().toISOString();
    records.push({ kind: 'runner-start', at, pid: process.pid, deadline: state.now + 720000 });
    const receipts = [0, 1].map((index) => ({
      vmId: randomUUID(),
      requestId: randomUUID(),
      environmentId: `fixture-native-${index}`,
      provider: providers[index].provider,
      profile: 'micro',
      region: providers[index].region,
      createdAt: at,
    }));
    for (const [index, receipt] of receipts.entries()) {
      const description = `Broker hosted scale ${runId} item ${index + 1}`;
      records.push({ kind: 'request-intent', at, item: index + 1, body: { description } });
      records.push({
        kind: 'request-result',
        at,
        item: index + 1,
        requestId: receipt.requestId,
        description,
        createdAt: at,
        closesAt: new Date(state.now + 30000).toISOString(),
      });
      records.push({ kind: 'vm-receipt', at, ...receipt });
    }
    let terminated = false;
    state.get.mockImplementation(async (id: string) => {
      if (id === receipts[0].environmentId) throw new Error('Fixture first native lookup failure');
      expect(id).toBe(receipts[1].environmentId);
      return {
        id,
        name: 'wick-broker-' + receipts[1].vmId.slice(0, 8),
        organizationId: settings.wick.organizationId,
        groupId: settings.wick.groupId,
        provider: receipts[1].provider,
        profile: 'micro',
        createdAt: at,
        status: terminated ? 'terminated' : 'running',
      };
    });
    state.terminate.mockImplementation(async (id: string) => {
      expect(id).toBe(receipts[1].environmentId);
      terminated = true;
    });
    const result = await invoke('cleanup');
    expect(state.terminate).toHaveBeenCalledWith(receipts[1].environmentId);
    expect(state.terminate).not.toHaveBeenCalledWith(receipts[0].environmentId);
    expect(result).toMatchObject({ confirmed: false, holdsReleased: false, nativeConfirmed: 1 });
    expect(state.create).not.toHaveBeenCalled();
    expect(state.list).not.toHaveBeenCalled();
    expect(state.get.mock.calls.length).toBeLessThanOrEqual(100);
  });

  it('rechecks the stop barrier after intent persistence and before any request POST', async () => {
    state.stopAfterIntent = true;
    writeFileSync(
      journalPath + '.watchdog-ready',
      JSON.stringify({ runId, pid: process.pid, at: new Date().toISOString() }),
      { mode: 0o600 },
    );
    const posts: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: URL, init: RequestInit) => {
        expect(url.hostname).toBe('hosted-scale.invalid');
        const cookie = new Headers(init.headers).get('cookie');
        let body: unknown;
        if (init.method === 'POST') {
          posts.push(url.pathname);
          throw new Error('No paid request dispatch permitted');
        }
        if (url.pathname === '/health') body = { modes: { wick: 'real', muse: 'fixture' } };
        else if (url.pathname === '/api/admin/config') body = { maxConcurrentVms: 20 };
        else if (url.pathname === '/api/catalog')
          body = {
            items: providers.map((p) => ({
              ...p,
              id: p.catalogId,
              approved: true,
              cpu: 1,
              memoryGb: 2,
              durationMinutes: [15],
              pricingMode: 'managed',
              managedRouteVerification: 'execution-preview-managed',
              rateSource: 'wick-customer-catalog',
              rateRetrievedAt: new Date().toISOString(),
            })),
          };
        else if (url.pathname === '/api/provider/dashboard') {
          const p = providers.find((p) => p.cookie === cookie)!;
          expect(p).toBeDefined();
          body = {
            provider: { cloudProvider: p.provider },
            capacity: { total: 5, held: 0, available: 5 },
            policy: { autoBid: true, basePriceCents: 5, minimumPriceCents: 1 },
          };
        } else if (url.pathname === '/api/vms' || url.pathname === '/api/requests')
          body = { items: [] };
        else throw new Error('Unexpected fixture route');
        return new Response(JSON.stringify(body), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }),
    );
    const result = await invoke('run');
    expect(posts).toEqual([]);
    const journal = readFileSync(journalPath, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(journal.filter((r) => r.kind === 'request-intent')).toHaveLength(1);
    expect(result).toMatchObject({ validationPassed: false, attemptedRequests: 1, passed: false });
    expect(state.create).not.toHaveBeenCalled();
    expect(state.terminate).not.toHaveBeenCalled();
  });
});
