import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  now: 0,
  stopAfterIntent: false,
  stopAtItem: 0,
  shellOpens: [] as string[],
  shellInputs: [] as string[],
  provenShells: new Set<string>(),
  onDelay: undefined as (() => void) | undefined,
  get: vi.fn(),
  terminate: vi.fn(),
  create: vi.fn(),
  list: vi.fn(),
}));
vi.mock('ws', async () => {
  const { EventEmitter } = await import('node:events');
  return {
    default: class InertSocket extends EventEmitter {
      static OPEN = 1;
      static CLOSED = 3;
      readyState = 1;
      vmId: string;
      constructor(url: URL) {
        super();
        expect(url.hostname).toBe('hosted-scale.invalid');
        this.vmId = url.pathname.split('/')[3];
        state.shellOpens.push(this.vmId);
        queueMicrotask(() =>
          this.emit('message', Buffer.from(JSON.stringify({ type: 'ready', mode: 'real' }))),
        );
      }
      send(raw: string) {
        const frame = JSON.parse(raw);
        if (frame.type === 'ping')
          queueMicrotask(() => this.emit('message', Buffer.from(JSON.stringify({ type: 'pong' }))));
        if (frame.type !== 'input') return;
        state.shellInputs.push(frame.data);
        expect(frame.data).toContain('test -t 0 && test -t 1');
        const matches = [
          ...String(frame.data).matchAll(
            /printf '\\nHOSTED_%s%s_(T0|T1|RESIZE)\\n' '([a-f0-9]+)' '([a-f0-9]+)'/g,
          ),
        ];
        if (matches.some((match) => match[1] === 'T1')) state.provenShells.add(this.vmId);
        // An echo-off shell need not end its prompt line before command output.
        // Only the command's own leading newline separates each proof marker.
        const output =
          'synthetic-shell$ ' +
          matches
            .map((match) => '\r\nHOSTED_' + match[2] + match[3] + '_' + match[1] + '\r\n')
            .join('');
        queueMicrotask(() =>
          this.emit(
            'message',
            Buffer.from(
              JSON.stringify({ type: 'output', data: Buffer.from(output).toString('base64') }),
            ),
          ),
        );
      }
      close() {
        this.readyState = 3;
        queueMicrotask(() => this.emit('close'));
      }
    },
  };
});
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
    state.onDelay?.();
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
        if (
          kind === 'request-intent' &&
          (state.stopAfterIntent || fields.item === state.stopAtItem)
        )
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
    state.stopAtItem = 0;
    state.shellOpens = [];
    state.shellInputs = [];
    state.provenShells = new Set();
    state.onDelay = undefined;
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
  function canaryFixture(releaseFourth: boolean) {
    const at = new Date().toISOString();
    const requests: Record<string, any>[] = [];
    let fourthReleasedAfterProofs = 0;
    const refreshWatchdog = () =>
      writeFileSync(
        journalPath + '.watchdog-ready',
        JSON.stringify({ runId, pid: process.pid, at: new Date(state.now).toISOString() }),
        { mode: 0o600 },
      );
    refreshWatchdog();
    state.onDelay = refreshWatchdog;
    const running = (r: Record<string, any>) =>
      r.index < 3 || (releaseFourth && state.provenShells.size >= 3);
    const vm = (r: Record<string, any>) => ({
      id: r.vmId,
      requestId: r.id,
      environmentId: r.environmentId,
      status: r.terminated ? 'terminated' : running(r) ? 'running' : 'provisioning',
      createdAt: at,
      readyAt: at,
      cleanupPending: false,
    });
    const requestView = (r: Record<string, any>) => ({
      id: r.id,
      ...r.body,
      createdAt: at,
      closesAt: new Date(Date.parse(at) + 30_000).toISOString(),
      status: r.terminated || running(r) ? 'ready' : 'provisioning',
      winningBidId: r.bidId,
    });
    state.get.mockImplementation(async (id: string) => {
      const r = requests.find((r) => r.environmentId === id)!;
      expect(r).toBeDefined();
      return {
        id,
        name: 'wick-broker-' + r.vmId.slice(0, 8),
        organizationId: settings.wick.organizationId,
        groupId: settings.wick.groupId,
        provider: r.provider.provider,
        profile: 'micro',
        status: r.terminated ? 'terminated' : 'running',
        createdAt: at,
        billingMode: 'wick_managed',
      };
    });
    state.terminate.mockImplementation(async (id: string) => {
      const r = requests.find((r) => r.environmentId === id)!;
      expect(r).toBeDefined();
      r.terminated = true;
    });
    const fetcher = vi.fn(async (url: URL, init: RequestInit) => {
      expect(url.hostname).toBe('hosted-scale.invalid');
      const cookie = new Headers(init.headers).get('cookie');
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
            rateRetrievedAt: at,
          })),
        };
      else if (url.pathname === '/api/provider/dashboard') {
        const p = providers.find((p) => p.cookie === cookie)!;
        expect(p).toBeDefined();
        const held = requests.filter(
          (r) => r.provider.provider === p.provider && !r.terminated,
        ).length;
        body = {
          provider: { cloudProvider: p.provider },
          capacity: { total: 5, held, available: 5 - held },
          policy: { autoBid: true, basePriceCents: 5, minimumPriceCents: 1 },
        };
      } else if (url.pathname === '/api/requests' && init.method === 'POST') {
        const submitted = JSON.parse(String(init.body));
        const p = providers.find((p) => p.catalogId === submitted.catalogId)!;
        expect(p).toBeDefined();
        const r = {
          id: randomUUID(),
          vmId: randomUUID(),
          environmentId: 'fixture-native-' + requests.length,
          bidId: 'fixture-bid-' + requests.length,
          index: requests.length,
          provider: p,
          body: submitted,
          terminated: false,
        };
        requests.push(r);
        body = requestView(r);
      } else if (url.pathname === '/api/requests') body = { items: requests.map(requestView) };
      else if (url.pathname.startsWith('/api/requests/')) {
        const r = requests.find((r) => r.id === url.pathname.split('/')[3])!;
        expect(r).toBeDefined();
        if (r.index === 3 && running(r) && !fourthReleasedAfterProofs)
          fourthReleasedAfterProofs = state.provenShells.size;
        body = {
          request: requestView(r),
          vm: vm(r),
          bids: [
            {
              id: r.bidId,
              cloudProvider: r.provider.provider,
              catalogId: r.provider.catalogId,
              region: r.provider.region,
              pricing: { rateMicrosPerSecond: 23 },
              revenueShare: { commissionBps: 1500 },
            },
          ],
        };
      } else if (url.pathname === '/api/vms') body = { items: requests.map(vm) };
      else if (url.pathname.endsWith('/terminate')) {
        const r = requests.find((r) => r.vmId === url.pathname.split('/')[3])!;
        expect(r).toBeDefined();
        r.terminated = true;
        body = { accepted: true };
      } else throw new Error('Unexpected inert route');
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });
    vi.stubGlobal('fetch', fetcher);
    return {
      fetcher,
      requests,
      get fourthReleasedAfterProofs() {
        return fourthReleasedAfterProofs;
      },
    };
  }
  it('proves three ready canary PTYs while a fourth remains provisioning, without starting bulk requests', async () => {
    const fixture = canaryFixture(false);
    const result = await invoke('run');
    expect(fixture.requests).toHaveLength(4);
    expect(state.shellOpens).toHaveLength(3);
    expect(state.provenShells.size).toBe(3);
    expect(result).toMatchObject({
      validationPassed: false,
      attemptedRequests: 4,
      provenT0Terminals: 3,
      provenT1Terminals: 3,
    });
    const journal = readFileSync(journalPath, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(journal.filter((r) => r.kind === 'terminal-proof-confirmed')).toHaveLength(3);
    const checkpoints = journal.filter((r) => r.kind === 'terminal-checkpoint');
    expect(checkpoints).toHaveLength(3);
    expect(checkpoints[0]).toMatchObject({
      reason: 'bounded-wait-timeout',
      ready: true,
      inputSent: true,
      inputFramesSent: 2,
      pongReceived: true,
      t0: true,
      t1: true,
      resize: true,
    });
    expect(checkpoints[0].outputBytes).toBeGreaterThan(0);
    expect(checkpoints.every((r) => !('data' in r) && !('state' in r))).toBe(true);
    expect(journal.some((r) => r.kind === 'four-canaries-confirmed')).toBe(false);
    expect(journal.some((r) => r.kind === 'request-intent' && r.item > 4)).toBe(false);
    expect(state.create).not.toHaveBeenCalled();
    expect(state.list).not.toHaveBeenCalled();
  });
  it('opens the bulk gate only after the delayed fourth canary also proves its PTY', async () => {
    state.stopAtItem = 5;
    const fixture = canaryFixture(true);
    const result = await invoke('run');
    expect(fixture.fourthReleasedAfterProofs).toBe(3);
    expect(fixture.requests).toHaveLength(4); // The fifth intent is fenced before dispatch.
    expect(state.shellOpens).toHaveLength(4);
    expect(new Set(state.shellOpens).size).toBe(4);
    const journal = readFileSync(journalPath, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    const bulkGate = journal.findIndex((r) => r.kind === 'four-canaries-confirmed');
    expect(bulkGate).toBeGreaterThan(0);
    expect(
      journal.slice(0, bulkGate).filter((r) => r.kind === 'terminal-proof-confirmed'),
    ).toHaveLength(4);
    expect(journal.findIndex((r) => r.kind === 'request-intent' && r.item === 5)).toBeGreaterThan(
      bulkGate,
    );
    expect(result).toMatchObject({
      validationPassed: false,
      attemptedRequests: 5,
      provenT0Terminals: 4,
      provenT1Terminals: 4,
    });
    expect(state.create).not.toHaveBeenCalled();
    expect(state.list).not.toHaveBeenCalled();
  });

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
