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
  receiptRows: [] as string[],
  receiptPath: '',
  setupCalls: 0,
  fileReads: [] as string[],
  readMode: 'ok',
  dropReceiptInitial: false,
  identityDrift: false,
  readCancelled: false,
  uncertainSetup: false,
  failDuringReceiptRead: false,
  terminalFault: undefined as undefined | (() => void),
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
        fixture.terminalFault = () =>
          this.emit('message', Buffer.from(JSON.stringify({ type: 'error' })));
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
        const phase = /_broker_rp='[^']*';/.test(frame.data) ? probes[0]?.[1]?.[0] : undefined;
        const executed = probes.filter((p) => !/(?:NOTTY|BAD|UNAVAILABLE)$/.test(p[1]));
        if (phase && !(fixture.dropReceiptInitial && phase === 'A')) {
          expect(frame.data.indexOf('test -t 1')).toBeLessThan(
            frame.data.indexOf('>>"$_broker_rp"'),
          );
          fixture.receiptRows.push(
            `${phase}.START=1`,
            `${phase}.STDIN_TTY=1`,
            `${phase}.STDOUT_TTY=1`,
            `${phase}.STATE=${phase === 'C' ? 1 : 0}`,
            `${phase}.CWD=${phase === 'C' ? 1 : 0}`,
            `${phase}.RESIZE=${phase === 'C' ? 1 : 0}`,
            ...(phase === 'B' ? ['B.EXPORT=1', 'B.CWD_SET=1'] : []),
            ...executed.map((p) => `${phase}.PRINT_${p[1]}=0`),
            `${phase}.END=1`,
          );
        }
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
    fixture.receiptRows = [];
    fixture.receiptPath = '';
    fixture.setupCalls = 0;
    fixture.fileReads = [];
    fixture.readMode = 'ok';
    fixture.dropReceiptInitial = false;
    fixture.identityDrift = false;
    fixture.readCancelled = false;
    fixture.uncertainSetup = false;
    fixture.failDuringReceiptRead = false;
    fixture.terminalFault = undefined;
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
    const nativeRow = {
      id: 'inert-native',
      name: 'wick-broker-' + vmId.slice(0, 8),
      organizationId: settings.wick.organizationId,
      groupId: settings.wick.groupId,
      provider: providers[2].provider,
      profile: 'micro',
      status: 'running',
      billingMode: 'wick_managed',
      createdAt,
    };
    fixture.get.mockImplementation(async () =>
      fixture.identityDrift && fixture.get.mock.calls.length > 1
        ? { ...nativeRow, organizationId: 'foreign-inert-org' }
        : nativeRow,
    );
    fixture.create.mockImplementation(() => {
      throw new Error('Native create is forbidden');
    });
    fixture.list.mockImplementation(() => {
      throw new Error('Broad native discovery is forbidden');
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: URL, init: RequestInit) => {
        if (url.hostname === 'wick.invalid') {
          expect(new Headers(init.headers).get('Authorization')).toBe('Bearer inert-token');
          if (url.pathname === '/v1/environments/inert-native/commands') {
            expect(init.method).toBe('POST');
            fixture.setupCalls++;
            const command = JSON.parse(String(init.body)).command as string;
            expect(command).toContain('os.mkdir(d,0o700)');
            expect(command).toContain('os.O_EXCL|os.O_NOFOLLOW,0o600');
            fixture.receiptPath =
              command.match(/\/tmp\/wick-broker-probe-[a-f0-9]{32}\/receipt\.log/)?.[0] ?? '';
            expect(fixture.receiptPath).toMatch(
              /^\/tmp\/wick-broker-probe-[a-f0-9]{32}\/receipt\.log$/,
            );
            if (fixture.uncertainSetup) throw new Error('Inert setup response lost');
            return Response.json({ stdout: 'RECEIPT_SETUP_OK\n', stderr: '', exitCode: 0 });
          }
          expect(url.pathname).toBe('/v1/environments/inert-native/files');
          expect(init.method).toBe('GET');
          expect(url.searchParams.get('content')).toBe('true');
          expect(url.searchParams.get('path')).toBe(fixture.receiptPath);
          fixture.fileReads.push(url.searchParams.get('path')!);
          if (fixture.failDuringReceiptRead) fixture.terminalFault?.();
          if (fixture.readMode === 'missing')
            return new Response('private-error-body-never-reported', { status: 404 });
          if (fixture.readMode === 'oversize')
            return new Response(
              new ReadableStream({
                start(controller) {
                  controller.enqueue(new Uint8Array(9000));
                },
                cancel() {
                  fixture.readCancelled = true;
                },
              }),
            );
          return Response.json({
            path:
              fixture.readMode === 'unsafe-path' ? '/etc/private-inert-file' : fixture.receiptPath,
            content:
              fixture.readMode === 'content-oversize'
                ? 'x'.repeat(4097)
                : fixture.readMode === 'malformed'
                  ? 'private-untrusted-file-content'
                  : fixture.receiptRows.join('\n') + '\n',
          });
        }
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
    expect(fixture.setupCalls).toBe(1);
    expect(fixture.fileReads).toEqual([fixture.receiptPath]);
    expect(fixture.get).toHaveBeenCalledTimes(2);
    expect(result.receiptEvidence).toMatchObject({
      status: 'verified',
      evidenceOnly: true,
      executionObservedWithoutStdout: false,
      phases: {
        B: { exportSet: 1, cwdSet: 1, printfExitCodes: { B_EXPORT_OK: 0, B_CWD_OK: 0 } },
        C: {
          started: true,
          completed: true,
          stdinTty: 1,
          stdoutTty: 1,
          state: 1,
          cwd: 1,
          resize: 1,
        },
      },
    });
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
    expect(result.receiptEvidence).toMatchObject({
      status: 'verified',
      evidenceOnly: true,
      executionObservedWithoutStdout: true,
      phases: {
        A: {
          started: true,
          completed: true,
          printfReturnedZeroWithoutStdoutMarker: [
            'A_BEGIN',
            'A_STDIN_TTY',
            'A_STDOUT_TTY',
            'A_END',
          ],
        },
      },
    });
    expect(JSON.stringify(result)).not.toContain(fixture.receiptPath);
    expect(fixture.watchdogCleanups).toBe(1);
  });
  it('keeps missing execution receipts distinct from completed execution with missing stdout', async () => {
    fixture.dropInitial = true;
    fixture.dropReceiptInitial = true;
    const result = await invoke();
    expect(result.passed).toBe(false);
    expect(result.receiptEvidence).toMatchObject({
      status: 'verified',
      executionObservedWithoutStdout: false,
      phases: {
        A: {
          started: false,
          completed: false,
          stdinTty: null,
          printfReturnedZeroWithoutStdoutMarker: [],
        },
        B: { completed: true },
      },
    });
  });
  it.each([
    ['missing', 'missing'],
    ['unsafe-path', 'path-rejected'],
    ['oversize', 'too-large'],
    ['content-oversize', 'too-large'],
    ['malformed', 'rejected'],
  ])(
    'bounds and redacts independent receipt read mode %s without changing failed stdout gates',
    async (mode, status) => {
      fixture.dropInitial = true;
      fixture.readMode = mode;
      const result = await invoke();
      expect(result).toMatchObject({
        passed: false,
        immediateReadyCorrect: false,
        receiptEvidence: { status, evidenceOnly: true },
      });
      expect(fixture.fileReads).toEqual([fixture.receiptPath]);
      expect(fixture.posts).toHaveLength(1);
      expect(fixture.setupCalls).toBe(1);
      expect(fixture.watchdogCleanups).toBe(1);
      expect(JSON.stringify(result)).not.toMatch(
        /private-error-body|private-untrusted-file|\/etc\/private-inert-file/,
      );
      if (mode === 'oversize') expect(fixture.readCancelled).toBe(true);
    },
  );
  it('rechecks exact native identity and refuses file access after an ownership mismatch', async () => {
    fixture.dropInitial = true;
    fixture.identityDrift = true;
    const result = await invoke();
    expect(result).toMatchObject({
      passed: false,
      receiptEvidence: { status: 'identity-or-read-unavailable' },
    });
    expect(fixture.get).toHaveBeenCalledTimes(2);
    expect(fixture.fileReads).toHaveLength(0);
    expect(fixture.watchdogCleanups).toBe(1);
  });
  it('does not retry an uncertain exclusive receipt setup and still cleans up the known VM', async () => {
    fixture.uncertainSetup = true;
    const result = await invoke();
    expect(result).toMatchObject({
      passed: false,
      failure: 'RECEIPT_SETUP_UNCONFIRMED',
      cleanup: { confirmed: true },
    });
    expect(fixture.setupCalls).toBe(1);
    expect(fixture.fileReads).toHaveLength(0);
    expect(fixture.inputs).toHaveLength(0);
    expect(fixture.posts).toHaveLength(1);
    expect(fixture.watchdogCleanups).toBe(1);
  });
  it('does not retain a pass after a terminal failure during independent receipt collection', async () => {
    fixture.failDuringReceiptRead = true;
    const result = await invoke();
    expect(result).toMatchObject({
      passed: false,
      fullPtyProofPassed: true,
      failure: 'TERMINAL_ERROR',
    });
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
