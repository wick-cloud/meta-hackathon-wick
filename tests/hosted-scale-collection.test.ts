import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  now: 0,
  dropProvider: 'provider-blaxel',
  rows: [] as Record<string, any>[],
  inputs: [] as { vmId: string; provider: string; data: string; at: number }[],
  opened: [] as string[],
  nativeRunningSeen: new Set<string>(),
  ageFinalCohort: false,
  agedFinalCohort: false,
  finalHoldPolls: 0,
  finalAgedAt: 0,
  sockets: new Map<string, { readyState: number; lastInputAt: number; close(): void }>(),
  onDelay: undefined as (() => void) | undefined,
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
vi.mock('node:timers/promises', () => ({
  setTimeout: async (milliseconds: number) => {
    state.now += milliseconds;
    state.onDelay?.();
    await Promise.resolve();
  },
}));
vi.mock('ws', async () => {
  const { EventEmitter } = await import('node:events');
  return {
    default: class Socket extends EventEmitter {
      static OPEN = 1;
      static CLOSED = 3;
      readyState = 1;
      lastInputAt = state.now;
      readonly vmId: string;
      readonly provider: string;
      constructor(url: URL) {
        super();
        expect(url.hostname).toBe('collection-scale.invalid');
        this.vmId = url.pathname.split('/')[3];
        const row = state.rows.find((r) => r.vmId === this.vmId);
        expect(row).toBeDefined();
        this.provider = row!.provider.provider;
        state.opened.push(this.vmId);
        state.sockets.set(this.vmId, this);
        queueMicrotask(() =>
          this.emit('message', Buffer.from(JSON.stringify({ type: 'ready', mode: 'real' }))),
        );
      }
      send(raw: string) {
        const frame = JSON.parse(raw);
        if (frame.type === 'ping') {
          // Broker pongs are local transport health and cannot refresh native shell idle time.
          queueMicrotask(() => this.emit('message', Buffer.from(JSON.stringify({ type: 'pong' }))));
          return;
        }
        if (frame.type !== 'input') return;
        expect(this.readyState).toBe(1);
        this.lastInputAt = state.now;
        state.inputs.push({
          vmId: this.vmId,
          provider: this.provider,
          data: frame.data,
          at: state.now,
        });
        const markers = [
          ...String(frame.data).matchAll(
            /printf '\\nHOSTED_%s%s_(T0|T1|RESIZE)\\n' '([a-f0-9]+)' '([a-f0-9]+)'/g,
          ),
        ];
        if (this.provider === state.dropProvider && markers.some((m) => m[1] === 'T0')) return;
        const output =
          'synthetic-shell$ ' +
          markers.map((m) => '\r\nHOSTED_' + m[2] + m[3] + '_' + m[1] + '\r\n').join('');
        queueMicrotask(() =>
          this.emit(
            'message',
            Buffer.from(
              JSON.stringify({
                type: 'output',
                data: Buffer.from(output).toString('base64'),
              }),
            ),
          ),
        );
      }
      close() {
        if (this.readyState === 3) return;
        this.readyState = 3;
        queueMicrotask(() => this.emit('close'));
      }
    },
  };
});

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
  cookie: 'inert-' + provider,
  catalogId: `${provider}:micro:${region}`,
  rateMicrosPerSecond: 23,
  capacity: 5,
}));
const settings = {
  baseUrl: 'https://collection-scale.invalid',
  buyerCookie: 'inert-buyer',
  adminCookie: 'inert-admin',
  target: 20,
  providers,
  wick: {
    baseUrl: 'https://wick.invalid',
    token: 'inert-token',
    organizationId: 'inert-org',
    groupId: 'inert-group',
  },
};
const commission = {
  commissionBps: 1500,
  grossCents: 5,
  brokerFeeMicros: '7500',
  providerNetMicros: '42500',
};

describe('explicit Blaxel timeout collection with inert full-run fixtures', () => {
  let directory: string, journalPath: string, settingsPath: string, runId: string;
  let records: Record<string, any>[];
  const argv = [...process.argv],
    originalExitCode = process.exitCode;
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    state.now = Date.now();
    state.dropProvider = 'provider-blaxel';
    state.rows = [];
    state.inputs = [];
    state.opened = [];
    state.nativeRunningSeen = new Set();
    state.ageFinalCohort = false;
    state.agedFinalCohort = false;
    state.finalHoldPolls = 0;
    state.finalAgedAt = 0;
    state.sockets = new Map();
    vi.spyOn(Date, 'now').mockImplementation(() => state.now);
    state.create.mockImplementation(() => {
      throw new Error('No native create allowed');
    });
    state.list.mockImplementation(() => {
      throw new Error('No broad native discovery allowed');
    });
    const control = resolve(process.cwd(), '../.broker-run/real-wick-20261028');
    mkdirSync(control, { recursive: true, mode: 0o700 });
    directory = mkdtempSync(resolve(control, 'offline-collection-'));
    journalPath = resolve(directory, 'journal.jsonl');
    settingsPath = resolve(directory, 'settings.json');
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
        at: new Date(state.now).toISOString(),
        target: 20,
        maximumRunMs: 720000,
        baseUrl: settings.baseUrl,
        fingerprint,
      },
    ];
    const refreshWatchdog = () => {
      if (state.ageFinalCohort && !state.agedFinalCohort && existsSync(journalPath)) {
        const rows = readFileSync(journalPath, 'utf8')
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line));
        if (rows.some((r) => r.kind === 'wave-confirmed' && r.cumulativeRequests === 20)) {
          state.finalHoldPolls++;
          if (state.finalHoldPolls === 30) {
            // Simulate elapsed host work immediately before final proof. Every healthy
            // shell is now due for maintenance, but must receive only its final challenge.
            state.now += 61000;
            state.finalAgedAt = state.now;
            state.agedFinalCohort = true;
          }
        }
      }
      writeFileSync(
        journalPath + '.watchdog-ready',
        JSON.stringify({ runId, pid: process.pid, at: new Date(state.now).toISOString() }),
        { mode: 0o600 },
      );
      for (const socket of state.sockets.values()) {
        if (socket.readyState === 1 && state.now - socket.lastInputAt >= 180000) socket.close();
      }
    };
    refreshWatchdog();
    state.onDelay = refreshWatchdog;
    const findNative = (id: string) => {
      const row = state.rows.find((r) => r.environmentId === id);
      expect(row).toBeDefined();
      return row!;
    };
    state.get.mockImplementation(async (id: string) => {
      const r = findNative(id);
      if (!r.terminated) state.nativeRunningSeen.add(id);
      return {
        id,
        name: 'wick-broker-' + r.vmId.slice(0, 8),
        organizationId: settings.wick.organizationId,
        groupId: settings.wick.groupId,
        provider: r.provider.provider,
        profile: 'micro',
        status: r.terminated ? 'terminated' : 'running',
        createdAt: r.createdAt,
        billingMode: 'wick_managed',
      };
    });
    state.terminate.mockImplementation(async (id: string) => {
      findNative(id).terminated = true;
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: URL, init: RequestInit) => {
        expect(url.hostname).toBe('collection-scale.invalid');
        const cookie = new Headers(init.headers).get('cookie');
        const requestView = (r: Record<string, any>) => ({
          id: r.id,
          ...r.body,
          createdAt: r.createdAt,
          closesAt: r.closesAt,
          status: 'ready',
          winningBidId: r.bidId,
        });
        const vmView = (r: Record<string, any>) => ({
          id: r.vmId,
          requestId: r.id,
          environmentId: r.environmentId,
          status: r.terminated ? 'terminated' : 'running',
          createdAt: r.createdAt,
          readyAt: r.createdAt,
          cleanupPending: false,
        });
        let body: unknown;
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
              rateRetrievedAt: new Date(state.now).toISOString(),
            })),
          };
        else if (url.pathname === '/api/provider/dashboard') {
          const p = providers.find((p) => p.cookie === cookie);
          expect(p).toBeDefined();
          const held = state.rows.filter(
            (r) => r.provider.provider === p!.provider && !r.terminated,
          ).length;
          body = {
            provider: { cloudProvider: p!.provider },
            capacity: { total: 5, held, available: 5 - held },
            policy: { autoBid: true, basePriceCents: 5, minimumPriceCents: 1 },
          };
        } else if (url.pathname === '/api/requests' && init.method === 'POST') {
          const submitted = JSON.parse(String(init.body));
          const p = submitted.matchAcrossProviders
            ? [...providers].sort(
                (a, b) =>
                  state.rows.filter((r) => r.provider.provider === a.provider).length -
                  state.rows.filter((r) => r.provider.provider === b.provider).length,
              )[0]
            : providers.find((p) => p.catalogId === submitted.catalogId);
          expect(p).toBeDefined();
          expect(state.rows.length).toBeLessThan(20);
          const persisted = readFileSync(journalPath, 'utf8')
            .trim()
            .split('\n')
            .map((s) => JSON.parse(s));
          expect(
            persisted.some(
              (r) => r.kind === 'request-intent' && r.body.description === submitted.description,
            ),
          ).toBe(true);
          const row = {
            id: randomUUID(),
            vmId: randomUUID(),
            environmentId: 'inert-native-' + state.rows.length,
            bidId: 'inert-bid-' + state.rows.length,
            provider: p!,
            body: submitted,
            terminated: false,
            createdAt: new Date(state.now).toISOString(),
            closesAt: new Date(state.now + 30000).toISOString(),
          };
          state.rows.push(row);
          body = requestView(row);
        } else if (url.pathname === '/api/requests') body = { items: state.rows.map(requestView) };
        else if (url.pathname.startsWith('/api/requests/')) {
          const row = state.rows.find((r) => r.id === url.pathname.split('/')[3]);
          expect(row).toBeDefined();
          body = {
            request: requestView(row!),
            vm: vmView(row!),
            bids: [
              {
                id: row!.bidId,
                cloudProvider: row!.provider.provider,
                catalogId: row!.provider.catalogId,
                region: row!.provider.region,
                totalPriceCents: 5,
                pricing: { rateMicrosPerSecond: 23 },
                revenueShare: commission,
              },
            ],
          };
        } else if (url.pathname === '/api/vms') body = { items: state.rows.map(vmView) };
        else if (url.pathname === '/api/invoices')
          body = {
            items: state.rows.map((r) => ({
              id: 'invoice-' + r.id,
              vmId: r.vmId,
              totalCents: 5,
              feeCents: 0,
              revenueShare: commission,
            })),
          };
        else if (url.pathname.endsWith('/terminate')) {
          const row = state.rows.find((r) => r.vmId === url.pathname.split('/')[3]);
          expect(row).toBeDefined();
          row!.terminated = true;
          body = { accepted: true };
        } else throw new Error('Unexpected inert route: ' + url.pathname);
        return new Response(JSON.stringify(body), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }),
    );
  });
  afterEach(() => {
    process.argv = argv;
    process.exitCode = originalExitCode;
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    rmSync(directory, { recursive: true, force: true });
  });
  const journalRecords = (path: string) =>
    readFileSync(path, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
  async function run(policy?: 'collect-blaxel-timeouts', requestedPolicy?: 'strict') {
    if (!existsSync(journalPath)) {
      if (policy) records[0].terminalPolicy = policy;
      writeFileSync(journalPath, records.map((r) => JSON.stringify(r)).join('\n') + '\n', {
        mode: 0o600,
      });
    }
    process.argv = [
      'node',
      'hosted-scale.ts',
      'run',
      '--settings',
      settingsPath,
      '--journal',
      journalPath,
      ...(requestedPolicy ? ['--terminal-policy', requestedPolicy] : []),
    ];
    let finish!: (value: Record<string, any>) => void, fail!: (error: Error) => void;
    const done = new Promise<Record<string, any>>((resolve, reject) => {
      finish = resolve;
      fail = reject;
    });
    vi.spyOn(console, 'log').mockImplementation((line: string) => {
      const r = JSON.parse(line);
      if ('cleanup' in r) finish(r);
    });
    vi.spyOn(console, 'error').mockImplementation(() =>
      fail(new Error('Inert runner command failed before report')),
    );
    await import('../scripts/hosted-scale.js');
    return done;
  }
  function assertBoundedCleanup(count: number) {
    expect(state.rows).toHaveLength(count);
    expect(state.rows.every((r) => r.terminated)).toBe(true);
    expect(journalRecords(journalPath).filter((r) => r.kind === 'request-intent')).toHaveLength(
      count,
    );
    expect(state.create).not.toHaveBeenCalled();
    expect(state.list).not.toHaveBeenCalled();
  }

  it('keeps the absent-policy default strict and stops after four attempts on a Blaxel T0 timeout', async () => {
    const result = await run();
    expect(result).toMatchObject({ validationPassed: false, passed: false, attemptedRequests: 4 });
    assertBoundedCleanup(4);
    expect(journalRecords(journalPath).some((r) => r.kind === 'four-canaries-confirmed')).toBe(
      false,
    );
  });

  it('collects five Blaxel timeouts while proving twenty compute allocations and fifteen healthy terminals without claiming a pass', async () => {
    const result = await run('collect-blaxel-timeouts');
    expect(result).toMatchObject({
      computeValidationPassed: true,
      validationPassed: false,
      passed: false,
      attemptedRequests: 20,
    });
    expect(result.knownBlaxelTerminalFailures).toBe(5);
    expect(result.peakRunning).toBe(20);
    expect(result.shellStateAndCwdProofs).toBe(15);
    expect(result.invoiceCount).toBe(20);
    expect(state.nativeRunningSeen.size).toBe(20);
    expect(result.terminalHoldMs).toBeGreaterThanOrEqual(30000);
    expect(result.simultaneousTerminals).toBe(15);
    expect(
      Object.fromEntries(
        providers.map((p) => [
          p.provider,
          state.rows.filter((r) => r.provider.provider === p.provider).length,
        ]),
      ),
    ).toEqual({ e2b: 5, daytona: 5, modal: 5, 'provider-blaxel': 5 });
    assertBoundedCleanup(20);
    for (const provider of ['e2b', 'daytona', 'modal'])
      expect(result.terminalResults[provider]).toMatchObject({
        attempted: 5,
        proven: 5,
        failedProofs: 0,
      });
    expect(result.terminalResults['provider-blaxel']).toMatchObject({
      attempted: 5,
      proven: 0,
      failedProofs: 5,
      closedAfterKnownFailure: 5,
    });
    const collected = journalRecords(journalPath).filter((r) => r.kind === 'terminal-proof-failed');
    expect(collected).toHaveLength(5);
    expect(collected.every((r) => r.provider === 'provider-blaxel' && r.collected === true)).toBe(
      true,
    );
    expect(result.cleanup).toMatchObject({
      confirmed: true,
      pending: 0,
      unknown: 0,
      holdsReleased: true,
      nativeConfirmed: 20,
    });
    const firstHealthy = state.rows.find((r) => r.provider.provider === 'e2b')!;
    const refreshes = state.inputs.filter(
      (i) => i.vmId === firstHealthy.vmId && i.data.includes('_T1'),
    );
    expect(refreshes.length).toBeGreaterThan(2); // Initial, real liveness refresh, final proof.
    expect(new Set(refreshes.map((i) => i.data)).size).toBe(refreshes.length);
    expect(
      Math.max(...refreshes.map((i) => i.at)) - Math.min(...refreshes.map((i) => i.at)),
    ).toBeGreaterThan(60000);
  });

  it('never collects an E2B proof timeout even when Blaxel collection is explicitly selected', async () => {
    state.dropProvider = 'e2b';
    const result = await run('collect-blaxel-timeouts');
    expect(result).toMatchObject({ validationPassed: false, passed: false, attemptedRequests: 4 });
    assertBoundedCleanup(4);
    expect(journalRecords(journalPath).some((r) => r.kind === 'four-canaries-confirmed')).toBe(
      false,
    );
  });

  it('rejects a terminal policy that differs from the prepared journal before any allocation', async () => {
    await expect(run('collect-blaxel-timeouts', 'strict')).rejects.toThrow('before report');
    expect(state.rows).toHaveLength(0);
    expect(journalRecords(journalPath).filter((r) => r.kind === 'request-intent')).toHaveLength(0);
    expect(state.create).not.toHaveBeenCalled();
  });

  it('cannot reuse a completed collection journal to allocate another cohort', async () => {
    await run('collect-blaxel-timeouts');
    const before = readFileSync(journalPath, 'utf8');
    vi.resetModules();
    await expect(run('collect-blaxel-timeouts')).rejects.toThrow('before report');
    expect(state.rows).toHaveLength(20);
    expect(readFileSync(journalPath, 'utf8')).toBe(before);
    assertBoundedCleanup(20);
  });

  it('reserves the whole aged final cohort before maintenance can start overlapping challenges', async () => {
    state.ageFinalCohort = true;
    const result = await run('collect-blaxel-timeouts');
    expect(state.agedFinalCohort).toBe(true);
    expect(result).toMatchObject({
      computeValidationPassed: true,
      validationPassed: false,
      passed: false,
      simultaneousTerminals: 15,
      knownBlaxelTerminalFailures: 5,
    });
    const final = journalRecords(journalPath).filter(
      (r) => r.kind === 'terminal-state-proof-refreshed' && r.phase === 'final',
    );
    expect(final).toHaveLength(15);
    expect(new Set(final.map((r) => r.vmId)).size).toBe(15);
    const finalInputs = state.inputs.filter(
      (i) => i.at >= state.finalAgedAt && i.data.includes('_T1'),
    );
    expect(finalInputs).toHaveLength(15);
    expect(new Set(finalInputs.map((i) => i.vmId)).size).toBe(15);
    assertBoundedCleanup(20);
  });
});
