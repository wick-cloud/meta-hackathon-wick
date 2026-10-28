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
import { Journal } from './live-scale/safety.js';
import { TerminalMarkerProof } from './live-scale/terminal-proof.js';
import { createWickAdapter } from '../src/server/integrations/wick.js';
import { fixedQuote, managedPricing, requireFreshManagedRate } from '../src/shared/pricing.js';

type Json = Record<string, any>;
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
  function probe(name: string) {
    const nonce = randomBytes(12).toString('hex'),
      marker = 'DIAG_' + nonce + '_' + name;
    probes.set(name, { marker, proof: new TerminalMarkerProof(marker), substring: false });
    return (
      "printf '\\nDIAG_%s%s_" + name + "\\n' '" + nonce.slice(0, 12) + "' '" + nonce.slice(12) + "'"
    );
  }
  const matched = (name: string) => probes.get(name)?.proof.matched === true;
  const tty = (prefix: string) =>
    `if test -t 0; then ${probe(prefix + '_STDIN_TTY')}; else ${probe(prefix + '_STDIN_NOTTY')}; fi; if test -t 1; then ${probe(prefix + '_STDOUT_TTY')}; else ${probe(prefix + '_STDOUT_NOTTY')}; fi`;
  const initial = probe('A_BEGIN') + '; ' + tty('A') + '; ' + probe('A_END');
  const second =
    probe('B_BEGIN') +
    '; ' +
    tty('B') +
    `; if export BROKER_DIAG_STATE='${state}'; then ${probe('B_EXPORT_OK')}; else ${probe('B_EXPORT_BAD')}; fi; if cd /tmp; then ${probe('B_CWD_OK')}; else ${probe('B_CWD_BAD')}; fi; ` +
    probe('B_END');
  const final =
    probe('C_BEGIN') +
    `; test -t 0 && test -t 1 && [ "$BROKER_DIAG_STATE" = '${state}' ] && [ "$PWD" = '/tmp' ] && ` +
    probe('C_STATE_CWD_TTY') +
    `; if command -v stty >/dev/null 2>&1; then if [ "$(stty size 2>/dev/null)" = '37 113' ]; then ${probe('C_RESIZE_OK')}; else ${probe('C_RESIZE_BAD')}; fi; else ${probe('C_STTY_UNAVAILABLE')}; fi; ` +
    probe('C_END');
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
    journal.append('diagnostic-native-verified', { vmId: vm.id, provider: provider.provider });
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
