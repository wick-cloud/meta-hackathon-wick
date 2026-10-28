/** One owned VM, one request attempt, real terminal probes; no native create or replay. */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import {
  closeSync,
  existsSync,
  fsyncSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import WebSocket from 'ws';
import { Wick } from '@wick-cloud/sdk';
import { Journal } from './live-scale/safety.js';
import { TerminalMarkerProof } from './live-scale/terminal-proof.js';
import { createWickAdapter } from '../src/server/integrations/wick.js';
import { fixedQuote, managedPricing, requireFreshManagedRate } from '../src/shared/pricing.js';

type Json = Record<string, any>;
const RECEIPT_WIRE_LIMIT = 8192,
  RECEIPT_CONTENT_LIMIT = 4096;
const shellQuote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
function receiptPath(nonce: string) {
  assert(/^[a-f0-9]{32}$/.test(nonce), 'RECEIPT_NONCE_INVALID');
  return '/tmp/wick-broker-probe-' + nonce + '/receipt.log';
}
function assertReceiptPath(path: string) {
  assert(
    /^\/tmp\/wick-broker-probe-[a-f0-9]{32}\/receipt\.log$/.test(path),
    'RECEIPT_PATH_INVALID',
  );
}
/** One exact HTTPS SDK operation; arbitrary bodies and large responses never reach its parser. */
async function receiptOperation(
  id: string,
  path: string,
  setupCommand?: string,
  beforeFetch?: () => void,
): Promise<Json> {
  assertReceiptPath(path);
  const base = new URL(settings.wick.baseUrl);
  assert(
    base.protocol === 'https:' && !base.username && !base.password && !base.search && !base.hash,
    'RECEIPT_API_ORIGIN',
  );
  const expectedPath =
    base.pathname.replace(/\/$/, '') +
    '/v1/environments/' +
    encodeURIComponent(id) +
    (setupCommand ? '/commands' : '/files');
  let rejection = 'unavailable';
  const sdk = new Wick({
    baseUrl: base.toString().replace(/\/$/, ''),
    token: settings.wick.token,
    timeoutMs: 12000,
    statusRetry: false,
    fetch: async (input, init) => {
      const target = new URL(String(input));
      assert(
        target.origin === base.origin &&
          target.pathname === expectedPath &&
          !target.hash &&
          !target.username &&
          !target.password,
        'RECEIPT_API_SCOPE',
      );
      if (setupCommand) {
        assert(init?.method === 'POST' && target.search === '', 'RECEIPT_SETUP_SCOPE');
        assert.deepEqual(
          JSON.parse(String(init.body)),
          { command: setupCommand, cwd: '/tmp' },
          'RECEIPT_SETUP_BODY',
        );
      } else {
        assert(
          init?.method === 'GET' &&
            target.searchParams.get('path') === path &&
            target.searchParams.get('content') === 'true' &&
            [...target.searchParams].length === 2,
          'RECEIPT_READ_SCOPE',
        );
      }
      beforeFetch?.();
      const response = await fetch(target, { ...init, redirect: 'error' });
      if (!response.ok) {
        rejection = response.status === 404 ? 'missing' : 'unavailable';
        await response.body?.cancel();
        throw new Error('RECEIPT_HTTP_REJECTED');
      }
      const reader = response.body?.getReader();
      assert(reader, 'RECEIPT_BODY_MISSING');
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        while (true) {
          const part = await reader.read();
          if (part.done) break;
          size += part.value.byteLength;
          if (size > RECEIPT_WIRE_LIMIT) {
            rejection = 'too-large';
            await reader.cancel();
            throw new Error('RECEIPT_WIRE_BOUND');
          }
          chunks.push(part.value);
        }
      } finally {
        reader.releaseLock();
      }
      return new Response(Buffer.concat(chunks).toString('utf8'), {
        status: response.status,
        headers: { 'Content-Type': 'application/json' },
      });
    },
  });
  try {
    if (setupCommand)
      return await sdk.environments.runCommand({
        path: { id },
        body: { command: setupCommand, cwd: '/tmp' },
      });
    const response = await sdk.environments.readFiles({
      path: { id },
      query: { path, content: 'true' },
    });
    if (!('path' in response) || response.path !== path || typeof response.content !== 'string')
      return { status: 'path-rejected' };
    if (Buffer.byteLength(response.content) > RECEIPT_CONTENT_LIMIT) return { status: 'too-large' };
    return { status: 'verified', content: response.content };
  } catch {
    return { status: rejection };
  }
}
const command = process.argv[2];
assert(['prepare', 'run', 'watchdog', 'cleanup'].includes(command), 'INVALID_COMMAND');
function flag(name: string) {
  const index = process.argv.indexOf('--' + name);
  return index < 0 ? undefined : process.argv[index + 1];
}
function requiredPath(name: string) {
  const value = flag(name);
  assert(value && isAbsolute(value), 'ABSOLUTE_PRIVATE_PATHS_REQUIRED');
  return value;
}
const settingsPath = requiredPath('settings'),
  journalPath = requiredPath('journal');
assert((statSync(settingsPath).mode & 0o077) === 0, 'PRIVATE_SETTINGS_REQUIRED');
const settings: Json = JSON.parse(readFileSync(settingsPath, 'utf8'));
const origin = new URL(settings.baseUrl);
assert(
  origin.protocol === 'https:' &&
    origin.pathname === '/' &&
    !origin.username &&
    !origin.password &&
    !origin.search &&
    !origin.hash,
  'INVALID_ORIGIN',
);
const journal = new Journal(journalPath);
const fingerprint = createHash('sha256')
  .update(
    JSON.stringify({
      baseUrl: origin.origin,
      scope: [settings.wick.organizationId, settings.wick.groupId],
      providers: settings.providers.map((p: Json) => [
        p.provider,
        p.catalogId,
        p.profile,
        p.region,
        p.rateMicrosPerSecond,
      ]),
    }),
  )
  .digest('hex');
const native = createWickAdapter({
  wickMode: 'real',
  wickApiBase: settings.wick.baseUrl,
  wickApiKey: settings.wick.token,
  wickOrganizationId: settings.wick.organizationId,
  wickGroupId: settings.wick.groupId,
});
const atomic = (path: string, value: unknown) => {
  const temporary = path + '.' + process.pid + '.tmp';
  writeFileSync(temporary, JSON.stringify(value), { mode: 0o600 });
  renameSync(temporary, path);
};
const exclusive = (path: string) => closeSync(openSync(path, 'wx', 0o600));
function alive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
function privateRead(path: string): Json | undefined {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return undefined;
  }
}
function header() {
  const records = journal.read(),
    h = records[0];
  assert(
    h?.kind === 'prepared' &&
      h.target === 20 &&
      h.maximumRunMs === 720000 &&
      h.fingerprint === fingerprint &&
      h.baseUrl === origin.origin,
    'CLEANUP_ENVELOPE_MISMATCH',
  );
  const diagnostic = records.find((r) => r.kind === 'diagnostic-prepared');
  assert(
    diagnostic &&
      diagnostic.runId === h.runId &&
      diagnostic.requestLimit === 1 &&
      diagnostic.maximumRunMs === 360000 &&
      ['provider-blaxel', 'modal'].includes(String(diagnostic.provider)),
    'DIAGNOSTIC_HEADER_MISMATCH',
  );
  const provider = settings.providers.find((p: Json) => p.provider === diagnostic.provider);
  assert(
    provider &&
      provider.profile === 'micro' &&
      provider.catalogId === diagnostic.catalogId &&
      provider.region === diagnostic.region,
    'DIAGNOSTIC_ROUTE_MISMATCH',
  );
  assert(existsSync(journalPath + '.run-owner'), 'FULL_RUN_MUST_BE_FENCED');
  return { h, diagnostic, provider };
}
/** Reuse the frozen controller only for preparation, independent watchdog and cleanup. */
function controller(mode: 'prepare' | 'watchdog' | 'cleanup'): Promise<Json> {
  const source = import.meta.url.endsWith('.ts');
  const path = fileURLToPath(
    new URL(source ? './hosted-scale.ts' : './hosted-scale.js', import.meta.url),
  );
  const args = [
    ...(source ? ['--import', 'tsx'] : []),
    path,
    mode,
    '--settings',
    settingsPath!,
    '--journal',
    journalPath!,
  ];
  return new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      args,
      {
        maxBuffer: 65536,
        ...(mode === 'watchdog' ? {} : { timeout: mode === 'prepare' ? 30000 : 210000 }),
      },
      (error, stdout) => {
        const lines = String(stdout).trim().split('\n').filter(Boolean);
        let result: Json = {};
        try {
          if (lines.length) result = JSON.parse(lines.at(-1)!);
        } catch {
          reject(new Error('CONTROLLER_RESPONSE_INVALID'));
          return;
        }
        if (error && !(mode === 'cleanup' && typeof result.confirmed === 'boolean'))
          reject(new Error('CONTROLLER_FAILED'));
        else resolve(result);
      },
    );
  });
}
async function api(
  path: string,
  method = 'GET',
  body?: unknown,
  cookie = settings.buyerCookie,
): Promise<Json> {
  const response = await fetch(new URL(path, origin), {
    method,
    redirect: 'error',
    signal: AbortSignal.timeout(15000),
    headers: {
      Cookie: cookie,
      Origin: origin.origin,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  assert(text.length <= 1048576, 'HTTP_RESPONSE_BOUND');
  assert([200, 201, 202].includes(response.status), 'HTTP_REQUEST_FAILED');
  return JSON.parse(text);
}

async function run() {
  const { h, diagnostic, provider } = header();
  exclusive(journalPath + '.diagnostic-run-owner');
  assert(
    !journal.read().some((r) => r.kind === 'runner-start' || r.kind === 'request-intent'),
    'NO_DIAGNOSTIC_RESTART',
  );
  const watchdogReady = () => {
    const r = privateRead(journalPath + '.watchdog-ready');
    return r && r.runId === h.runId && Date.now() - Date.parse(r.at) < 5000 && alive(r.pid);
  };
  assert(watchdogReady(), 'INDEPENDENT_WATCHDOG_REQUIRED');
  const capturePath = journalPath + '.owned-probe-output.bin';
  const capture = openSync(capturePath, 'wx', 0o600);
  const started = Date.now(),
    deadline = started + Number(diagnostic.maximumRunMs);
  journal.append('runner-start', { pid: process.pid, deadline, diagnostic: true });
  const beat = () =>
    atomic(journalPath + '.heartbeat', {
      pid: process.pid,
      runId: h.runId,
      at: new Date().toISOString(),
    });
  beat();
  const timer = setInterval(beat, 2000);
  let failure = '',
    intentional = false,
    ws: WebSocket | undefined;
  const stop = () => {
    failure ||= 'SIGNAL';
    journal.append('stop-requested', { reason: 'signal' });
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
  const check = () =>
    assert(
      !failure &&
        Date.now() < deadline &&
        watchdogReady() &&
        !journal.read().some((r) => ['stop-requested', 'watchdog-triggered'].includes(r.kind)),
      'DIAGNOSTIC_STOPPED',
    );
  async function wait(predicate: () => boolean, maximum: number) {
    const end = Math.min(deadline, Date.now() + maximum);
    while (Date.now() < end) {
      check();
      if (predicate()) return true;
      await delay(100);
    }
    return predicate();
  }
  let capturedBytes = 0,
    outputBytes = 0,
    readyAt: number | undefined,
    firstOutputAt: number | undefined;
  let inputFramesSent = 0,
    pongReceived = false,
    outputAfterReady = 0;
  let lastOutput = Buffer.alloc(0),
    shellErrorDetected = false;
  const probes = new Map<
    string,
    { marker: string; proof: TerminalMarkerProof; substring: boolean; at?: number }
  >();
  const state = randomBytes(12).toString('hex');
  const receiptFile = receiptPath(randomBytes(16).toString('hex'));
  let ownedVm: Json | undefined,
    receiptPrepared = false;
  let receiptEvidence: Json = { status: 'not-attempted', evidenceOnly: true, phases: {} };
  const record = (key: string, value: string) =>
    `printf '%s=%s\\n' '${key}' ${value} >>"$_broker_rp"`;
  function phaseStart(phase: string) {
    // Probe descriptors before redirecting any receipt printf: test -t 1 inside
    // a redirected group would test the receipt file instead of the PTY.
    return (
      `_broker_rp=${shellQuote(receiptFile)}; _broker_in=0; test -t 0 && _broker_in=1; _broker_out=0; test -t 1 && _broker_out=1; _broker_state=0; [ "\${BROKER_DIAG_STATE-}" = '${state}' ] && _broker_state=1; _broker_cwd=0; [ "$PWD" = '/tmp' ] && _broker_cwd=1; _broker_resize=0; if command -v stty >/dev/null 2>&1; then [ "$(stty size 2>/dev/null)" = '37 113' ] && _broker_resize=1; fi; ` +
      [
        `${phase}.START`,
        `${phase}.STDIN_TTY`,
        `${phase}.STDOUT_TTY`,
        `${phase}.STATE`,
        `${phase}.CWD`,
        `${phase}.RESIZE`,
      ]
        .map((key, index) =>
          record(
            key,
            [
              "'1'",
              '"$_broker_in"',
              '"$_broker_out"',
              '"$_broker_state"',
              '"$_broker_cwd"',
              '"$_broker_resize"',
            ][index]!,
          ),
        )
        .join('; ') +
      '; '
    );
  }
  function probe(name: string) {
    const nonce = randomBytes(12).toString('hex'),
      marker = 'DIAG_' + nonce + '_' + name;
    probes.set(name, { marker, proof: new TerminalMarkerProof(marker), substring: false });
    const print =
      "printf '\\nDIAG_%s%s_" +
      name +
      "\\n' '" +
      nonce.slice(0, 12) +
      "' '" +
      nonce.slice(12) +
      "'";
    return `{ ${print}; _broker_rc=$?; ${record(name[0] + '.PRINT_' + name, '"$_broker_rc"')}; }`;
  }
  const matched = (name: string) => probes.get(name)?.proof.matched === true;
  const tty = (prefix: string) =>
    `if test -t 0; then ${probe(prefix + '_STDIN_TTY')}; else ${probe(prefix + '_STDIN_NOTTY')}; fi; if test -t 1; then ${probe(prefix + '_STDOUT_TTY')}; else ${probe(prefix + '_STDOUT_NOTTY')}; fi`;
  const initial =
    phaseStart('A') +
    probe('A_BEGIN') +
    '; ' +
    tty('A') +
    '; ' +
    probe('A_END') +
    '; ' +
    record('A.END', "'1'");
  const second =
    phaseStart('B') +
    probe('B_BEGIN') +
    '; ' +
    tty('B') +
    `; if export BROKER_DIAG_STATE='${state}'; then ${record('B.EXPORT', "'1'")}; ${probe('B_EXPORT_OK')}; else ${record('B.EXPORT', "'0'")}; ${probe('B_EXPORT_BAD')}; fi; if cd /tmp; then ${record('B.CWD_SET', "'1'")}; ${probe('B_CWD_OK')}; else ${record('B.CWD_SET', "'0'")}; ${probe('B_CWD_BAD')}; fi; ` +
    probe('B_END') +
    '; ' +
    record('B.END', "'1'");
  const final =
    phaseStart('C') +
    probe('C_BEGIN') +
    `; test -t 0 && test -t 1 && [ "$BROKER_DIAG_STATE" = '${state}' ] && [ "$PWD" = '/tmp' ] && ` +
    probe('C_STATE_CWD_TTY') +
    `; if command -v stty >/dev/null 2>&1; then if [ "$(stty size 2>/dev/null)" = '37 113' ]; then ${probe('C_RESIZE_OK')}; else ${probe('C_RESIZE_BAD')}; fi; else ${probe('C_STTY_UNAVAILABLE')}; fi; ` +
    probe('C_END') +
    '; ' +
    record('C.END', "'1'");
  assert(
    [initial, second, final].every((value) => Buffer.byteLength(value) < 4096),
    'RECEIPT_PROBE_LINE_BOUND',
  );
  let secondAt = 0,
    firstCompleteBeforeSecond = false;
  const flushes: string[] = [];
  const sendInput = (data: string, phase: string) => {
    check();
    assert(ws?.readyState === WebSocket.OPEN, 'SOCKET_NOT_OPEN');
    ws.send(JSON.stringify({ type: 'input', data }));
    inputFramesSent++;
    journal.append('diagnostic-input-sent', {
      phase,
      bytes: Buffer.byteLength(data),
      elapsedMs: Date.now() - started,
    });
  };
  const proofSnapshot = () =>
    Object.fromEntries(
      [...probes].map(([name, p]) => [
        name,
        {
          exactLine: p.proof.matched,
          substringSeen: p.substring,
          ...(p.at === undefined ? {} : { elapsedMs: p.at - started }),
        },
      ]),
    );
  function verifyNative(vm: Json, observed: Json) {
    assert(
      observed.id === vm.environmentId &&
        observed.name === 'wick-broker-' + vm.id.slice(0, 8) &&
        observed.organizationId === settings.wick.organizationId &&
        observed.groupId === settings.wick.groupId &&
        observed.provider === provider.provider &&
        observed.profile === 'micro' &&
        observed.status === 'running' &&
        observed.billingMode === 'wick_managed' &&
        !observed.providerKeyId &&
        Date.parse(observed.createdAt ?? '') >= started - 5000 &&
        Date.parse(observed.createdAt ?? '') >= Date.parse(vm.createdAt) - 5000 &&
        Date.parse(observed.createdAt ?? '') <= Date.now() + 5000 &&
        Date.parse(vm.createdAt) >= started - 5000 &&
        Date.parse(vm.createdAt) <= deadline + 120000,
      'NATIVE_IDENTITY',
    );
  }
  async function collectReceipt() {
    if (!ownedVm || !receiptPrepared) return;
    const observationFence = () =>
      assert(
        failure !== 'SIGNAL' &&
          Date.now() + 25000 < deadline &&
          watchdogReady() &&
          !journal.read().some((r) => ['stop-requested', 'watchdog-triggered'].includes(r.kind)),
        'RECEIPT_OBSERVATION_STOPPED',
      );
    receiptEvidence = { status: 'unavailable', evidenceOnly: true, phases: {} };
    try {
      observationFence();
      verifyNative(ownedVm, await native.get(ownedVm.environmentId));
      observationFence();
      const read = await receiptOperation(
        ownedVm.environmentId,
        receiptFile,
        undefined,
        observationFence,
      );
      receiptEvidence.status = read.status;
      if (read.status !== 'verified') return;
      const values = new Map<string, number>();
      const fields = new Set(
        ['A', 'B', 'C'].flatMap((p) =>
          ['START', 'END', 'STDIN_TTY', 'STDOUT_TTY', 'STATE', 'CWD', 'RESIZE'].map(
            (k) => p + '.' + k,
          ),
        ),
      );
      fields.add('B.EXPORT');
      fields.add('B.CWD_SET');
      for (const name of probes.keys()) fields.add(name[0] + '.PRINT_' + name);
      assert(
        typeof read.content === 'string' &&
          Buffer.byteLength(read.content) <= RECEIPT_CONTENT_LIMIT,
        'RECEIPT_CONTENT_BOUND',
      );
      for (const line of read.content.split('\n').filter(Boolean)) {
        const match = /^([ABC]\.[A-Z_]+)=([0-9]{1,3})$/.exec(line);
        assert(match && fields.has(match[1]!) && !values.has(match[1]!), 'RECEIPT_CONTENT_INVALID');
        const value = Number(match[2]);
        assert(value <= (match[1]!.includes('.PRINT_') ? 255 : 1), 'RECEIPT_VALUE_INVALID');
        values.set(match[1]!, value);
      }
      const phases = Object.fromEntries(
        ['A', 'B', 'C'].map((phase) => {
          const stdoutMissing = [...probes]
            .filter(
              ([name, proof]) =>
                name.startsWith(phase + '_') &&
                values.get(phase + '.PRINT_' + name) === 0 &&
                !proof.proof.matched &&
                !proof.substring,
            )
            .map(([name]) => name);
          return [
            phase,
            {
              started: values.get(phase + '.START') === 1,
              completed: values.get(phase + '.END') === 1,
              stdinTty: values.get(phase + '.STDIN_TTY') ?? null,
              stdoutTty: values.get(phase + '.STDOUT_TTY') ?? null,
              state: values.get(phase + '.STATE') ?? null,
              cwd: values.get(phase + '.CWD') ?? null,
              resize: values.get(phase + '.RESIZE') ?? null,
              ...(phase === 'B'
                ? {
                    exportSet: values.get('B.EXPORT') ?? null,
                    cwdSet: values.get('B.CWD_SET') ?? null,
                  }
                : {}),
              printfExitCodes: Object.fromEntries(
                [...probes.keys()]
                  .filter(
                    (name) => name.startsWith(phase + '_') && values.has(phase + '.PRINT_' + name),
                  )
                  .map((name) => [name, values.get(phase + '.PRINT_' + name)]),
              ),
              printfReturnedZeroWithoutStdoutMarker: stdoutMissing,
            },
          ];
        }),
      );
      receiptEvidence = {
        status: 'verified',
        evidenceOnly: true,
        bytes: Buffer.byteLength(read.content),
        phases,
        executionObservedWithoutStdout: Object.values(phases).some(
          (p) => p.completed && p.printfReturnedZeroWithoutStdoutMarker.length > 0,
        ),
      };
    } catch (error) {
      receiptEvidence.status =
        error instanceof Error && error.message.startsWith('RECEIPT_')
          ? 'rejected'
          : 'identity-or-read-unavailable';
    }
  }
  let result: Json = {
    validationPassed: false,
    fullPtyProofPassed: false,
    immediateReadyCorrect: false,
  };
  try {
    assert.deepEqual((await api('/health')).modes, { wick: 'real', muse: 'fixture' });
    const catalog = (await api('/api/catalog')).items;
    const offer = catalog.find((o: Json) => o.id === provider.catalogId);
    assert(
      offer?.approved &&
        offer.provider === provider.provider &&
        offer.profile === 'micro' &&
        offer.region === provider.region &&
        offer.durationMinutes.includes(15) &&
        offer.rateMicrosPerSecond === provider.rateMicrosPerSecond &&
        offer.managedRouteVerification === 'execution-preview-managed',
      'CATALOG_ROUTE_CHANGED',
    );
    requireFreshManagedRate(offer);
    const dashboard = await api('/api/provider/dashboard', 'GET', undefined, provider.cookie);
    assert(
      dashboard.capacity.held === (provider.baselineHeld ?? 0) &&
        dashboard.capacity.available > 0 &&
        dashboard.policy.autoBid,
      'PROVIDER_CAPACITY_CHANGED',
    );
    const base = Math.ceil((Number(dashboard.policy.basePriceCents) * Math.max(15, 30)) / 30);
    const floor = fixedQuote(managedPricing(offer), 15).totalPriceCents;
    const budget = Math.max(floor, base, Number(dashboard.policy.minimumPriceCents));
    assert(Number.isInteger(budget) && budget > 0 && budget <= 10, 'BUDGET_BOUND');
    const description = 'Broker hosted scale ' + h.runId + ' item 1';
    const body = {
      description,
      catalogId: provider.catalogId,
      region: provider.region,
      matchAcrossProviders: false,
      durationMinutes: 15,
      maxPriceCents: budget,
      requirements: { cpu: 1, memoryGb: 2 },
    };
    check();
    assert(!journal.read().some((r) => r.kind === 'request-intent'), 'ONE_REQUEST_ATTEMPT_ONLY');
    journal.append('request-intent', { item: 1, body });
    check(); // Durable intent and the last stop/watchdog fence precede the only POST.
    let request: Json;
    try {
      request = await api('/api/requests', 'POST', body);
    } catch {
      throw new Error('UNKNOWN_POST_NO_REPLAY');
    }
    assert(request.description === description, 'REQUEST_IDENTITY');
    journal.append('request-result', {
      item: 1,
      requestId: request.id,
      createdAt: request.createdAt,
      closesAt: request.closesAt,
    });
    let detail: Json | undefined;
    const provisionEnd = Math.min(deadline, Date.now() + 150000);
    while (Date.now() < provisionEnd) {
      check();
      const d = await api('/api/requests/' + request.id);
      assert(
        d.request?.id === request.id && d.request.description === description,
        'REQUEST_DETAIL_IDENTITY',
      );
      const vm = d.vm;
      if (vm?.environmentId && !journal.read().some((r) => r.kind === 'vm-receipt')) {
        assert(vm.requestId === request.id, 'VM_REQUEST_IDENTITY');
        const winner = d.bids.find((b: Json) => b.id === d.request.winningBidId);
        // Preserve the known environment ID before rejecting an unexpected route.
        // The frozen cleanup controller independently verifies every receipt.
        journal.append('vm-receipt', {
          vmId: vm.id,
          requestId: request.id,
          environmentId: vm.environmentId,
          provider: winner?.cloudProvider ?? provider.provider,
          profile: typeof winner?.catalogId === 'string' ? winner.catalogId.split(':')[1] : 'micro',
          region: winner?.region ?? provider.region,
          createdAt: vm.createdAt,
        });
        assert(
          winner?.cloudProvider === provider.provider &&
            winner.catalogId === provider.catalogId &&
            winner.region === provider.region,
          'WINNING_ROUTE_CHANGED',
        );
      }
      assert(!['failed', 'cancelled', 'no_offers'].includes(d.request.status), 'PROVISION_FAILED');
      if (vm?.status === 'running') {
        detail = d;
        break;
      }
      await delay(1000);
    }
    assert(detail?.vm?.environmentId, 'PROVISION_TIMEOUT');
    const vm = detail.vm,
      observed = await native.get(vm.environmentId);
    verifyNative(vm, observed);
    ownedVm = vm;
    journal.append('diagnostic-native-verified', { vmId: vm.id, provider: provider.provider });
    const directory = receiptFile.slice(0, receiptFile.lastIndexOf('/'));
    const setup = `import os,stat\nos.umask(0o077)\nd=${JSON.stringify(directory)}\np=${JSON.stringify(receiptFile)}\nos.mkdir(d,0o700)\nfd=os.open(p,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)\ni=os.fstat(fd)\nassert stat.S_ISREG(i.st_mode) and stat.S_IMODE(i.st_mode)==0o600 and i.st_uid==os.geteuid() and i.st_nlink==1\nos.close(fd)\ni=os.lstat(d)\nassert stat.S_ISDIR(i.st_mode) and stat.S_IMODE(i.st_mode)==0o700 and i.st_uid==os.geteuid()\nprint('RECEIPT_SETUP_OK')`;
    check();
    const prepared = await receiptOperation(
      vm.environmentId,
      receiptFile,
      'python3 -I -S -c ' + shellQuote(setup),
      check,
    );
    assert(
      prepared.exitCode === 0 &&
        prepared.simulated !== true &&
        prepared.stdout === 'RECEIPT_SETUP_OK\n' &&
        prepared.stderr === '',
      'RECEIPT_SETUP_UNCONFIRMED',
    );
    receiptPrepared = true;
    journal.append('diagnostic-receipt-prepared', { vmId: vm.id, exclusive: true });
    check();
    const url = new URL('/api/vms/' + vm.id + '/terminal', origin);
    url.protocol = 'wss:';
    ws = new WebSocket(url, {
      headers: { Cookie: settings.buyerCookie, Origin: origin.origin },
      handshakeTimeout: 15000,
      maxPayload: 300000,
    });
    const terminalFailure = (classification: string) => {
      if (!intentional) {
        failure ||= 'TERMINAL_' + classification;
        journal.append('terminal-failure', { vmId: vm.id, classification });
      }
    };
    ws.on('error', () => terminalFailure('TRANSPORT'));
    ws.on('close', () => terminalFailure('CLOSE'));
    ws.on('message', (raw) => {
      if (intentional) return;
      try {
        const frame = JSON.parse(raw.toString());
        if (frame.type === 'ready' && readyAt === undefined) {
          assert.equal(frame.mode, 'real');
          readyAt = Date.now();
          journal.append('diagnostic-gateway-ready', {
            vmId: vm.id,
            elapsedMs: readyAt - started,
            outputBytesBeforeReady: outputBytes,
          });
          sendInput(initial + '\r', 'A_IMMEDIATE_CR');
          ws!.send(JSON.stringify({ type: 'ping' }));
        } else if (frame.type === 'output') {
          assert(typeof frame.data === 'string');
          const bytes = Buffer.from(frame.data, 'base64');
          outputBytes += bytes.length;
          firstOutputAt ??= Date.now();
          if (readyAt !== undefined) {
            outputAfterReady += bytes.length;
            const keep = bytes.subarray(0, Math.max(0, 8192 - capturedBytes));
            if (keep.length) {
              writeSync(capture, keep);
              capturedBytes += keep.length;
            }
          }
          lastOutput = Buffer.concat([lastOutput, bytes]).subarray(-2048);
          shellErrorDetected ||=
            /syntax error|command not found|permission denied|cannot (?:access|change)/i.test(
              lastOutput.toString('utf8'),
            );
          for (const p of probes.values()) {
            p.substring ||= lastOutput.includes(Buffer.from(p.marker));
            if (p.proof.push(bytes) && p.at === undefined) p.at = Date.now();
          }
          ws!.send(JSON.stringify({ type: 'ack', bytes: bytes.length }));
        } else if (frame.type === 'pong') pongReceived = true;
        else if (['exit', 'error'].includes(frame.type)) terminalFailure(frame.type.toUpperCase());
      } catch {
        terminalFailure('PROTOCOL');
      }
    });
    assert(await wait(() => readyAt !== undefined, 35000), 'GATEWAY_READY_TIMEOUT');
    assert(await wait(() => firstOutputAt !== undefined, 12000), 'INITIAL_OUTPUT_TIMEOUT');
    // Observe the already-sent immediate probe, rather than mistaking prompt/echo
    // for its completion. This does not postpone the first input after ready.
    await wait(() => matched('A_END'), 5000);
    firstCompleteBeforeSecond = matched('A_END');
    secondAt = Date.now();
    journal.append('diagnostic-initial-output-observed', {
      elapsedMs: secondAt - started,
      firstOutputElapsedMs: firstOutputAt! - started,
      firstProbeComplete: firstCompleteBeforeSecond,
      outputBytes,
      outputAfterReady,
    });
    sendInput(second + '\r', 'B_AFTER_OUTPUT_CR');
    if (!(await wait(() => matched('B_END'), 5000))) {
      flushes.push('B');
      sendInput('\n', 'B_LF_FLUSH_ONLY');
      assert(await wait(() => matched('B_END'), 5000), 'SECOND_PROBE_TIMEOUT');
    }
    ws.send(JSON.stringify({ type: 'resize', cols: 113, rows: 37 }));
    sendInput(final + '\r', 'C_STATE_CWD_RESIZE_CR');
    if (!(await wait(() => matched('C_END'), 5000))) {
      flushes.push('C');
      sendInput('\n', 'C_LF_FLUSH_ONLY');
      assert(await wait(() => matched('C_END'), 5000), 'FINAL_PROBE_TIMEOUT');
    }
    ws.send(JSON.stringify({ type: 'ping' }));
    assert(await wait(() => pongReceived, 2000), 'PONG_TIMEOUT');
    const fullPtyProofPassed = [
      'B_STDIN_TTY',
      'B_STDOUT_TTY',
      'B_EXPORT_OK',
      'B_CWD_OK',
      'C_STATE_CWD_TTY',
      'C_RESIZE_OK',
    ].every(matched);
    const immediateReadyCorrect =
      firstCompleteBeforeSecond &&
      ['A_STDIN_TTY', 'A_STDOUT_TTY'].every(matched) &&
      flushes.length === 0;
    result = {
      fullPtyProofPassed,
      immediateReadyCorrect,
      validationPassed: fullPtyProofPassed && immediateReadyCorrect,
    };
  } catch (error) {
    failure ||=
      error instanceof Error && /^[A-Z0-9_]+$/.test(error.message)
        ? error.message
        : 'DIAGNOSTIC_FAILED';
    result = { ...result, validationPassed: false, failure };
  } finally {
    // Read independently before the stop fence lets the watchdog delete the VM.
    // Keep the shell attached so close's interrupt cannot cut off its final append.
    // A complete file can corroborate execution, but never replaces stdout gates.
    await collectReceipt();
    if (failure) result = { ...result, validationPassed: false, failure };
    intentional = true;
    ws?.close();
    let evidenceWriteFailed = false;
    try {
      fsyncSync(capture);
    } catch {
      evidenceWriteFailed = true;
    } finally {
      try {
        closeSync(capture);
      } catch {
        evidenceWriteFailed = true;
      }
    }
    const metadata = {
      provider: provider.provider,
      gatewayReady: readyAt !== undefined,
      inputFramesSent,
      outputBytes,
      capturedBytes,
      captureTruncated: outputAfterReady > 8192,
      pongReceived,
      firstProbeCompleteBeforeSecondInput: firstCompleteBeforeSecond,
      possibleEarlyInputLoss: !matched('A_END') && matched('B_END'),
      newlineFlushPhases: flushes,
      shellErrorDetected,
      nonTtyObserved: ['A_STDIN_NOTTY', 'A_STDOUT_NOTTY', 'B_STDIN_NOTTY', 'B_STDOUT_NOTTY'].some(
        matched,
      ),
      exportUnavailable: matched('B_EXPORT_BAD'),
      tmpUnavailable: matched('B_CWD_BAD'),
      markerFramingObserved: [...probes.values()].some((p) => p.substring && !p.proof.matched),
      proofs: proofSnapshot(),
      receiptEvidence,
    };
    try {
      journal.append('diagnostic-checkpoint', metadata);
    } catch {
      evidenceWriteFailed = true;
    }
    try {
      journal.append('stop-requested', { reason: 'diagnostic-finished' });
    } catch {
      evidenceWriteFailed = true;
    }
    // The producer is still alive with an honest heartbeat. The frozen manual
    // cleanup CLI correctly refuses that state; its independent watchdog owns
    // cleanup after observing the durable stop fence instead.
    let cleanup: Json = { confirmed: false, unknown: 1 };
    try {
      const cleanupEnd = Date.now() + 240000;
      while (Date.now() < cleanupEnd) {
        const report = privateRead(journalPath + '.watchdog-report.json');
        if (
          report &&
          typeof report.confirmed === 'boolean' &&
          Date.parse(report.finishedAt) >= started - 5000 &&
          Date.parse(report.finishedAt) <= Date.now() + 5000
        ) {
          cleanup = report;
          break;
        }
        await delay(500);
      }
    } finally {
      clearInterval(timer);
      process.off('SIGTERM', stop);
      process.off('SIGINT', stop);
    }
    result = {
      ...result,
      ...metadata,
      evidenceWriteFailed,
      runId: h.runId,
      attemptedRequests: journal.read().filter((r) => r.kind === 'request-intent').length,
      cleanup,
      passed:
        result.validationPassed === true && cleanup.confirmed === true && !evidenceWriteFailed,
    };
    atomic(journalPath + '.diagnostic-report.json', result);
    journal.append('runner-finished', {
      passed: result.passed,
      cleanupConfirmed: cleanup.confirmed === true,
      diagnostic: true,
    });
    if (cleanup.confirmed) journal.append('complete', { diagnostic: true });
    console.log(JSON.stringify(result));
    if (!result.passed) process.exitCode = 1;
  }
}
async function main() {
  if (command === 'prepare') {
    const selected = flag('provider');
    assert(['provider-blaxel', 'modal'].includes(selected ?? ''), 'SELECT_BLAXEL_OR_MODAL');
    assert(!existsSync(journalPath), 'FRESH_JOURNAL_REQUIRED');
    await controller('prepare');
    const h = journal.read()[0],
      provider = settings.providers.find((p: Json) => p.provider === selected);
    assert(provider?.profile === 'micro', 'EXACT_MICRO_ROUTE_REQUIRED');
    exclusive(journalPath + '.run-owner'); // The full twenty-VM run cannot consume this journal.
    journal.append('diagnostic-prepared', {
      runId: h.runId,
      requestLimit: 1,
      maximumRunMs: 360000,
      provider: selected,
      catalogId: provider.catalogId,
      region: provider.region,
    });
    console.log(
      JSON.stringify({ runId: h.runId, requestLimit: 1, maximumRunMs: 360000, provider: selected }),
    );
  } else if (command === 'run') await run();
  else {
    header();
    const result = await controller(command as 'watchdog' | 'cleanup');
    if (command === 'cleanup') console.log(JSON.stringify(result));
  }
}
void main().catch(() => {
  console.error('DIAGNOSTIC_COMMAND_FAILED');
  process.exitCode = 1;
});
