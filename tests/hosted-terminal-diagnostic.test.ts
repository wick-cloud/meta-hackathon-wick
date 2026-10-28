import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({
  now: 0,
  dropInitial: false,
  stopAfterIntent: false,
  uncertainPost: false,
  journalPath: '',
  runId: '',
  envelope: {} as Record<string, unknown>,
  watchdogCleanups: 0,
  cleanupSawLiveFreshProducer: false,
  childModes: [] as string[],
  posts: [] as unknown[],
  inputs: [] as string[],
  get: vi.fn(),
  create: vi.fn(),
  list: vi.fn(),
  terminate: vi.fn(),
}));
vi.mock('../src/server/integrations/wick.js', () => ({
  createWickAdapter: () => ({
    get: fixture.get,
    create: fixture.create,
    list: fixture.list,
    terminate: fixture.terminate,
  }),
}));
vi.mock('node:child_process', async (original) => ({
  ...(await original<typeof import('node:child_process')>()),
  execFile: (
    _binary: string,
    args: string[],
    _options: unknown,
    done: (error: null, stdout: string) => void,
  ) => {
    const mode = ['prepare', 'watchdog', 'cleanup'].find((mode) => args.includes(mode))!;
    fixture.childModes.push(mode);
    expect(mode).toBe('prepare'); // Live/fresh producer must use the independent watchdog, never manual cleanup.
    writeFileSync(fixture.journalPath, JSON.stringify(fixture.envelope) + '\n', { mode: 0o600 });
    queueMicrotask(() => done(null, JSON.stringify({ runId: fixture.runId })));
  },
}));
vi.mock('node:timers/promises', () => ({
  setTimeout: async (milliseconds: number) => {
    fixture.now += milliseconds;
    writeFileSync(
      fixture.journalPath + '.watchdog-ready',
      JSON.stringify({
        runId: fixture.runId,
        pid: process.pid,
        at: new Date(fixture.now).toISOString(),
      }),
      { mode: 0o600 },
    );
    const records = readFileSync(fixture.journalPath, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    if (
      records.some((r) => r.kind === 'stop-requested') &&
      !existsSync(fixture.journalPath + '.watchdog-report.json')
    ) {
      const beat = JSON.parse(readFileSync(fixture.journalPath + '.heartbeat', 'utf8'));
      process.kill(beat.pid, 0);
      fixture.cleanupSawLiveFreshProducer =
        beat.pid === process.pid && fixture.now - Date.parse(beat.at) < 15000;
      fixture.watchdogCleanups++;
      const unresolved = fixture.uncertainPost || fixture.stopAfterIntent;
      writeFileSync(
        fixture.journalPath + '.watchdog-report.json',
        JSON.stringify({
          confirmed: !unresolved,
          unknown: unresolved ? 1 : 0,
          nativeConfirmed: unresolved ? 0 : 1,
          holdsReleased: !unresolved,
          finishedAt: new Date(fixture.now).toISOString(),
        }),
        { mode: 0o600 },
      );
    }
    await Promise.resolve();
  },
}));
vi.mock('../scripts/live-scale/safety.js', async (original) => {
  const actual = await original<typeof import('../scripts/live-scale/safety.js')>();
  return {
    ...actual,
    Journal: class extends actual.Journal {
      override append(kind: string, fields: Record<string, unknown> = {}) {
        const r = super.append(kind, fields);
        if (kind === 'request-intent' && fixture.stopAfterIntent)
          super.append('stop-requested', { reason: 'inert-post-intent-fence' });
        return r;
      }
    },
  };
});
vi.mock('ws', async () => {
  const { EventEmitter } = await import('node:events');
  return {
    default: class InertSocket extends EventEmitter {
      static OPEN = 1;
      readyState = 1;
      constructor(url: URL) {
        super();
        expect(url.hostname).toBe('one-terminal.invalid');
        queueMicrotask(() =>
          this.emit('message', Buffer.from(JSON.stringify({ type: 'ready', mode: 'real' }))),
        );
      }
      send(raw: string) {
        const frame = JSON.parse(raw);
        if (frame.type === 'ping')
          queueMicrotask(() => this.emit('message', Buffer.from(JSON.stringify({ type: 'pong' }))));
        if (frame.type !== 'input') return;
        fixture.inputs.push(frame.data);
        const probes = [
          ...String(frame.data).matchAll(
            /printf '\\nDIAG_%s%s_([A-Z_]+)\\n' '([a-f0-9]+)' '([a-f0-9]+)'/g,
          ),
        ];
        const output =
          'synthetic-shell$ ' +
          probes
            .filter(
              (p) =>
                !(fixture.dropInitial && p[1].startsWith('A_')) &&
                !/(?:NOTTY|BAD|UNAVAILABLE)$/.test(p[1]),
            )
            .map((p) => '\r\nDIAG_' + p[2] + p[3] + '_' + p[1] + '\r\n')
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

const providers = ['e2b', 'daytona', 'provider-blaxel', 'modal'].map((provider) => ({
  provider,
  profile: 'micro',
  catalogId: provider + ':micro:auto',
  region: 'auto',
  name: provider,
  cookie: 'inert-' + provider,
  capacity: 5,
  rateMicrosPerSecond: 23,
  baselineHeld: 0,
  baselineAvailable: 5,
}));
const settings = {
  baseUrl: 'https://one-terminal.invalid',
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
describe('single-provider hosted terminal diagnostic, with zero cloud calls', () => {
  let directory: string, settingsPath: string;
  const argv = [...process.argv],
    exitCode = process.exitCode;
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    fixture.now = Date.now();
    fixture.runId = randomUUID();
    fixture.dropInitial = false;
    fixture.stopAfterIntent = false;
    fixture.uncertainPost = false;
    fixture.watchdogCleanups = 0;
    fixture.cleanupSawLiveFreshProducer = false;
    fixture.childModes = [];
    fixture.posts = [];
    fixture.inputs = [];
    vi.spyOn(Date, 'now').mockImplementation(() => fixture.now);
    const control = resolve(process.cwd(), '../.broker-run/real-wick-20261028');
    mkdirSync(control, { recursive: true, mode: 0o700 });
    directory = mkdtempSync(resolve(control, 'offline-one-terminal-'));
    settingsPath = resolve(directory, 'settings.json');
    fixture.journalPath = resolve(directory, 'journal.jsonl');
    writeFileSync(settingsPath, JSON.stringify(settings), { mode: 0o600 });
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
    fixture.envelope = {
      kind: 'prepared',
      at: new Date().toISOString(),
      runId: fixture.runId,
      target: 20,
      maximumRunMs: 720000,
      baseUrl: settings.baseUrl,
      fingerprint,
    };
    writeFileSync(
      fixture.journalPath,
      JSON.stringify(fixture.envelope) +
        '\n' +
        JSON.stringify({
          kind: 'diagnostic-prepared',
          at: new Date().toISOString(),
          runId: fixture.runId,
          requestLimit: 1,
          maximumRunMs: 360000,
          provider: providers[2].provider,
          catalogId: providers[2].catalogId,
          region: 'auto',
        }) +
        '\n',
      { mode: 0o600 },
    );
    writeFileSync(fixture.journalPath + '.run-owner', '', { mode: 0o600 });
    writeFileSync(
      fixture.journalPath + '.watchdog-ready',
      JSON.stringify({
        runId: fixture.runId,
        pid: process.pid,
        at: new Date(fixture.now).toISOString(),
      }),
      { mode: 0o600 },
    );
    const requestId = randomUUID(),
      vmId = randomUUID(),
      createdAt = new Date().toISOString();
    let description = '';
    fixture.get.mockResolvedValue({
      id: 'inert-native',
      name: 'wick-broker-' + vmId.slice(0, 8),
      organizationId: settings.wick.organizationId,
      groupId: settings.wick.groupId,
      provider: providers[2].provider,
      profile: 'micro',
      status: 'running',
      billingMode: 'wick_managed',
      createdAt,
    });
    fixture.create.mockImplementation(() => {
      throw new Error('Native create is forbidden');
    });
    fixture.list.mockImplementation(() => {
      throw new Error('Broad native discovery is forbidden');
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: URL, init: RequestInit) => {
        expect(url.hostname).toBe('one-terminal.invalid');
        let body: unknown;
        if (url.pathname === '/health') body = { modes: { wick: 'real', muse: 'fixture' } };
        else if (url.pathname === '/api/catalog')
          body = {
            items: [
              {
                ...providers[2],
                id: providers[2].catalogId,
                approved: true,
                durationMinutes: [15],
                managedRouteVerification: 'execution-preview-managed',
                pricingMode: 'managed',
                rateSource: 'wick-customer-catalog',
                rateRetrievedAt: createdAt,
              },
            ],
          };
        else if (url.pathname === '/api/provider/dashboard')
          body = {
            capacity: { held: 0, available: 5 },
            policy: { autoBid: true, basePriceCents: 5, minimumPriceCents: 1 },
          };
        else if (url.pathname === '/api/requests' && init.method === 'POST') {
          const submitted = JSON.parse(String(init.body));
          fixture.posts.push(submitted);
          description = submitted.description;
          if (fixture.uncertainPost) throw new Error('Inert lost response');
          body = {
            id: requestId,
            description,
            createdAt,
            closesAt: new Date(Date.parse(createdAt) + 30000).toISOString(),
          };
        } else if (url.pathname === '/api/requests/' + requestId)
          body = {
            request: { id: requestId, description, status: 'ready', winningBidId: 'inert-bid' },
            vm: {
              id: vmId,
              requestId,
              environmentId: 'inert-native',
              status: 'running',
              createdAt,
            },
            bids: [
              {
                id: 'inert-bid',
                cloudProvider: providers[2].provider,
                catalogId: providers[2].catalogId,
                region: 'auto',
              },
            ],
          };
        else throw new Error('Unexpected inert route');
        return new Response(JSON.stringify(body));
      }),
    );
  });
  afterEach(() => {
    process.argv = argv;
    process.exitCode = exitCode;
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    rmSync(directory, { recursive: true, force: true });
  });
  async function invoke(mode = 'run') {
    process.argv = [
      'node',
      'hosted-terminal-diagnostic.ts',
      mode,
      '--settings',
      settingsPath,
      '--journal',
      fixture.journalPath,
      '--provider',
      'provider-blaxel',
    ];
    let finish!: (value: any) => void;
    const done = new Promise<any>((resolveResult) => {
      finish = resolveResult;
    });
    vi.spyOn(console, 'log').mockImplementation((line: string) => finish(JSON.parse(line)));
    vi.spyOn(console, 'error').mockImplementation(() => finish({ commandFailed: true }));
    await import('../scripts/hosted-terminal-diagnostic.js');
    return done;
  }
  it('uses one exact POST and waits for watchdog cleanup while producer is alive and heartbeat fresh', async () => {
    const result = await invoke();
    expect(fixture.posts).toHaveLength(1);
    expect(fixture.posts[0]).toMatchObject({
      catalogId: providers[2].catalogId,
      region: 'auto',
      matchAcrossProviders: false,
    });
    expect(result).toMatchObject({
      passed: true,
      fullPtyProofPassed: true,
      immediateReadyCorrect: true,
      attemptedRequests: 1,
      cleanup: { confirmed: true },
    });
    expect(fixture.watchdogCleanups).toBe(1);
    expect(fixture.cleanupSawLiveFreshProducer).toBe(true);
    expect(fixture.childModes).toEqual([]);
    expect(
      readFileSync(fixture.journalPath + '.owned-probe-output.bin').length,
    ).toBeLessThanOrEqual(8192);
    expect(fixture.create).not.toHaveBeenCalled();
    expect(fixture.list).not.toHaveBeenCalled();
  });
  it('records a missing immediate probe separately from later full PTY proof', async () => {
    fixture.dropInitial = true;
    const result = await invoke();
    expect(fixture.posts).toHaveLength(1);
    expect(result).toMatchObject({
      passed: false,
      fullPtyProofPassed: true,
      immediateReadyCorrect: false,
      possibleEarlyInputLoss: true,
      firstProbeCompleteBeforeSecondInput: false,
    });
    expect(result.proofs.A_END.exactLine).toBe(false);
    expect(result.proofs.B_END.exactLine).toBe(true);
    expect(fixture.watchdogCleanups).toBe(1);
  });
  it('fences the only POST after its durable intent and still requests watchdog cleanup', async () => {
    fixture.stopAfterIntent = true;
    const result = await invoke();
    expect(fixture.posts).toHaveLength(0);
    expect(result).toMatchObject({
      passed: false,
      attemptedRequests: 1,
      cleanup: { confirmed: false, unknown: 1 },
    });
    expect(fixture.watchdogCleanups).toBe(1);
    expect(fixture.get).not.toHaveBeenCalled();
  });
  it('never replays an uncertain POST and retains its unresolved admission', async () => {
    fixture.uncertainPost = true;
    const result = await invoke();
    expect(fixture.posts).toHaveLength(1);
    expect(result).toMatchObject({
      passed: false,
      failure: 'UNKNOWN_POST_NO_REPLAY',
      attemptedRequests: 1,
      cleanup: { confirmed: false, unknown: 1 },
    });
    expect(fixture.get).not.toHaveBeenCalled();
  });
  it('allocates nothing without a fresh watchdog', async () => {
    rmSync(fixture.journalPath + '.watchdog-ready');
    expect(await invoke()).toMatchObject({ commandFailed: true });
    expect(fixture.posts).toHaveLength(0);
  });
  it('prepares a one-request diagnostic and reserves the full-run owner fence without API calls', async () => {
    rmSync(fixture.journalPath);
    rmSync(fixture.journalPath + '.run-owner');
    expect(await invoke('prepare')).toMatchObject({
      requestLimit: 1,
      maximumRunMs: 360000,
      provider: 'provider-blaxel',
    });
    expect(existsSync(fixture.journalPath + '.run-owner')).toBe(true);
    expect(fixture.childModes).toEqual(['prepare']);
    expect(fetch).not.toHaveBeenCalled();
  });
});
