/**
 * Explicitly authorized, bounded live test of the existing hosted Broker.
 * This script never calls native create, starts a Broker, or accesses its database.
 */
import assert from 'node:assert/strict';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import {
  existsSync,
  openSync,
  closeSync,
  readFileSync,
  writeFileSync,
  renameSync,
  statSync,
} from 'node:fs';
import { isAbsolute } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import WebSocket from 'ws';
import { Journal, CONTROL_DIRECTORY, percentiles } from './live-scale/safety.js';
import { TerminalMarkerProof } from './live-scale/terminal-proof.js';
import { createWickAdapter } from '../src/server/integrations/wick.js';
import type { WickEnvironment } from '../src/server/integrations/types.js';
import { fixedQuote, managedPricing, revenueShare } from '../src/shared/pricing.js';
import {
  CANARY_HOLD_MS,
  CANARY_QUOTE_CEILING_CENTS,
  canaryQuote,
  validateCanaryRoutes,
  type CanaryMode,
} from './live-scale/provider-canary.js';

type Json = Record<string, any>;
interface Provider {
  provider: string;
  name: string;
  cookie: string;
  catalogId: string;
  profile: string;
  region: string;
  rateMicrosPerSecond: number;
  capacity: number;
  baselineHeld?: number;
  baselineAvailable?: number;
  basePriceCents?: number;
  minimumPriceCents?: number;
  offeringId?: string;
  cpu?: number;
  memoryGb?: number;
  diskGb?: number;
}
interface Settings {
  baseUrl: string;
  buyerCookie: string;
  adminCookie: string;
  target: number;
  mode?: CanaryMode;
  providers: Provider[];
  wick: { baseUrl: string; token: string; organizationId: string; groupId: string };
}
interface Header {
  kind: 'prepared';
  runId: string;
  maximumRunMs: number;
  target: number;
  baseUrl: string;
  fingerprint: string;
  at: string;
  terminalPolicy?: 'strict' | 'collect-blaxel-timeouts' | 'compute-with-blaxel-diagnostics';
  mode?: CanaryMode;
}
const IDS = ['e2b', 'daytona', 'modal', 'provider-blaxel'];
const command = process.argv[2];
const policyIndex = process.argv.indexOf('--terminal-policy');
const requestedPolicy = policyIndex < 0 ? undefined : process.argv[policyIndex + 1];
assert(
  policyIndex < 0 ||
    ['strict', 'collect-blaxel-timeouts', 'compute-with-blaxel-diagnostics'].includes(
      requestedPolicy ?? '',
    ),
  'Use a reviewed --terminal-policy.',
);
assert(
  ['prepare', 'run', 'watchdog', 'cleanup'].includes(command),
  'Use prepare, run, watchdog, or cleanup.',
);
const flag = (name: string) => {
  const index = process.argv.indexOf('--' + name);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  assert(value && isAbsolute(value), 'Supply an absolute --' + name + ' path.');
  return value;
};
const settingsPath = flag('settings'),
  journalPath = flag('journal');
assert((statSync(settingsPath).mode & 0o077) === 0, 'Settings must have private permissions.');
const settings: Settings = JSON.parse(readFileSync(settingsPath, 'utf8'));
const canaryMode =
  settings.mode === 'provider-canary' ||
  settings.mode === 'provider-size-canary' ||
  settings.mode === 'provider-size-retry-canary';
assert(settings.mode === undefined || canaryMode, 'Unknown run mode.');
const origin = new URL(settings.baseUrl);
assert(
  origin.protocol === 'https:' &&
    !origin.username &&
    !origin.password &&
    origin.pathname === '/' &&
    !origin.search &&
    !origin.hash,
  'Use an approved credential-free HTTPS origin.',
);
if (canaryMode) {
  validateCanaryRoutes(settings.target, settings.providers, settings.mode);
  assert(
    requestedPolicy === undefined || requestedPolicy === 'strict',
    'Canaries require strict terminals.',
  );
} else {
  assert.equal(settings.target, 20, 'This reviewed run permits twenty request attempts.');
  assert.deepEqual(
    settings.providers.map((p) => p.provider).sort(),
    IDS.slice().sort(),
    'Exactly the four reviewed providers are required.',
  );
  assert(
    settings.providers.every(
      (p) => p.capacity === 5 && p.profile === 'micro' && p.cookie && p.catalogId && p.region,
    ),
    'Use five Micro slots per provider.',
  );
}
assert(
  settings.providers.every((p) => p.cookie),
  'Provider credentials are required.',
);
assert(
  settings.buyerCookie && settings.adminCookie && settings.wick.token,
  'Private authenticated settings are required.',
);
const fingerprint = createHash('sha256')
  .update(
    JSON.stringify({
      baseUrl: origin.origin,
      scope: [settings.wick.organizationId, settings.wick.groupId],
      providers: settings.providers.map((p) => [
        p.provider,
        p.catalogId,
        p.profile,
        p.region,
        p.rateMicrosPerSecond,
      ]),
      ...(canaryMode
        ? {
            mode: settings.mode,
            target: settings.target,
            quoteCeilingCents: CANARY_QUOTE_CEILING_CENTS,
            terminalHoldMs: CANARY_HOLD_MS,
            canaries: settings.providers.map((p) => [
              p.provider,
              p.offeringId,
              p.cpu,
              p.memoryGb,
              p.diskGb,
              p.capacity,
              p.basePriceCents,
            ]),
          }
        : {}),
    }),
  )
  .digest('hex');
const journal = new Journal(journalPath);
const paths = {
  ready: journalPath + '.watchdog-ready',
  heartbeat: journalPath + '.heartbeat',
  report: journalPath + '.report.json',
};
const atomic = (path: string, value: unknown) => {
  const temporary = path + '.' + process.pid + '.tmp';
  writeFileSync(temporary, JSON.stringify(value), { mode: 0o600 });
  renameSync(temporary, path);
};
function privateRead(path: string): Json | undefined {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return undefined;
  }
}
function alive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
function exclusive(path: string) {
  const fd = openSync(path, 'wx', 0o600);
  closeSync(fd);
}
function header(): Header {
  const h = journal.read()[0] as unknown as Header;
  assert(h.kind === 'prepared' && /^[0-9a-f-]{36}$/.test(h.runId), 'Invalid run journal.');
  assert(
    h.target === settings.target &&
      h.mode === settings.mode &&
      h.maximumRunMs === 12 * 60_000 &&
      h.fingerprint === fingerprint &&
      h.baseUrl === origin.origin,
    'Settings do not match the prepared run.',
  );
  assert(
    !canaryMode || (h.terminalPolicy ?? 'strict') === 'strict',
    'Canaries require strict terminals.',
  );
  assert(
    h.terminalPolicy === undefined ||
      ['strict', 'collect-blaxel-timeouts', 'compute-with-blaxel-diagnostics'].includes(
        h.terminalPolicy,
      ),
    'Invalid prepared terminal policy.',
  );
  assert(
    requestedPolicy === undefined || requestedPolicy === (h.terminalPolicy ?? 'strict'),
    'Terminal policy differs from the fresh prepared journal.',
  );
  return h;
}
const native = createWickAdapter({
  wickMode: 'real',
  wickApiBase: settings.wick.baseUrl,
  wickApiKey: settings.wick.token,
  wickOrganizationId: settings.wick.organizationId,
  wickGroupId: settings.wick.groupId,
});
async function api(
  cookie: string,
  path: string,
  method = 'GET',
  body?: unknown,
  accepted = [200],
): Promise<Json> {
  const response = await fetch(new URL(path, origin), {
    method,
    redirect: 'error',
    signal: AbortSignal.timeout(15_000),
    headers: {
      Cookie: cookie,
      Origin: origin.origin,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  assert(text.length <= 1024 * 1024, 'HTTP response exceeded its bound.');
  if (!accepted.includes(response.status)) throw new Error('HTTP_' + response.status);
  return { ...JSON.parse(text), _httpStatus: response.status };
}
async function bounded<T, R>(
  values: T[],
  work: (value: T, index: number) => Promise<R>,
  concurrency = 4,
): Promise<R[]> {
  const result: R[] = [];
  for (let offset = 0; offset < values.length; offset += concurrency)
    result.push(
      ...(await Promise.all(
        values
          .slice(offset, offset + concurrency)
          .map((value, index) => work(value, offset + index)),
      )),
    );
  return result;
}
async function cleanupBatch<T, R>(values: T[], work: (value: T) => Promise<R>) {
  const results: PromiseSettledResult<R>[] = [];
  for (let offset = 0; offset < values.length; offset += 4)
    results.push(...(await Promise.allSettled(values.slice(offset, offset + 4).map(work))));
  return results;
}
async function list(path: string): Promise<Json[]> {
  let cursor: string | undefined;
  const result: Json[] = [];
  for (let page = 0; page < 3; page++) {
    const response = await api(
      settings.buyerCookie,
      path + '?limit=100' + (cursor ? '&cursor=' + encodeURIComponent(cursor) : ''),
    );
    assert(Array.isArray(response.items), 'Invalid bounded listing.');
    result.push(...response.items);
    if (!response.nextCursor) return result;
    cursor = response.nextCursor;
  }
  throw new Error('LISTING_BOUND');
}
const description = (h: Header, item: number) => 'Broker hosted scale ' + h.runId + ' item ' + item;
function intents() {
  return journal.read().filter((r) => r.kind === 'request-intent');
}
function runStart() {
  return journal.read().find((r) => r.kind === 'runner-start');
}
function ownership(environment: WickEnvironment, vm: Json, provider: Provider, h: Header) {
  const created = Date.parse(environment.createdAt ?? '');
  const start = runStart();
  const startedAt = Date.parse(String(start?.at ?? ''));
  const brokerCreated = Date.parse(vm.createdAt);
  return (
    environment.id === vm.environmentId &&
    environment.name === 'wick-broker-' + vm.id.slice(0, 8) &&
    environment.organizationId === settings.wick.organizationId &&
    environment.groupId === settings.wick.groupId &&
    environment.provider === provider.provider &&
    environment.profile === provider.profile &&
    Number.isFinite(startedAt) &&
    Number.isFinite(brokerCreated) &&
    brokerCreated >= startedAt - 5000 &&
    brokerCreated <= Number(start?.deadline) + 120_000 &&
    Number.isFinite(created) &&
    created >= startedAt - 5000 &&
    created >= Date.parse(vm.createdAt) - 5000 &&
    created <= Date.now() + 5000 &&
    created <= Number(start?.deadline ?? Date.parse(h.at) + h.maximumRunMs) + 120_000
  );
}
function canaryNativeTiming(environment: WickEnvironment, vm: Json, provider: Provider) {
  const raw = environment.raw as Json | undefined;
  assert(Date.parse(environment.expiresAt ?? '') > Date.now(), 'CANARY_NATIVE_EXPIRY');
  assert.equal(vm.durationMinutes, 15, 'CANARY_FROZEN_DURATION');
  assert(
    raw?.region === undefined || provider.region === 'auto' || raw.region === provider.region,
    'CANARY_NATIVE_REGION',
  );
  return {
    durationMinutes: vm.durationMinutes,
    brokerCreatedAt: vm.createdAt,
    brokerReadyAt: vm.readyAt,
    nativeCreatedAt: environment.createdAt,
    nativeExpiresAt: environment.expiresAt,
    ...(raw?.region === undefined ? {} : { nativeRegion: raw.region }),
  };
}
async function ownedRequests(h: Header): Promise<{ requests: Json[]; unknown: number }> {
  const attempts = intents();
  assert(
    attempts.length <= settings.target &&
      new Set(attempts.map((r) => r.item)).size === attempts.length,
    'Request attempt cap exceeded.',
  );
  const allowed = new Set(attempts.map((r) => description(h, Number(r.item))));
  const matches = (await list('/api/requests')).filter((r) => allowed.has(r.description));
  assert(new Set(matches.map((r) => r.description)).size === matches.length, 'AMBIGUOUS_REQUEST');
  return { requests: matches, unknown: allowed.size - matches.length };
}
async function detail(request: Json) {
  const response = await api(settings.buyerCookie, '/api/requests/' + request.id);
  assert(
    response.request?.id === request.id && response.request?.description === request.description,
    'REQUEST_DETAIL_IDENTITY',
  );
  return response;
}
function providerFor(detail: Json, cleanupOnly = false): Provider {
  const bid = detail.bids?.find((b: Json) => b.id === detail.request.winningBidId);
  assert(bid, 'WINNING_BID_MISSING');
  const provider = settings.providers.find((p) => p.provider === bid.cloudProvider);
  if (cleanupOnly) {
    assert(
      provider && typeof bid.catalogId === 'string' && typeof bid.region === 'string',
      'CLEANUP_ROUTE_MISSING',
    );
    const prefix = provider.provider + ':';
    const suffix = ':' + bid.region;
    assert(
      bid.catalogId.startsWith(prefix) && bid.catalogId.endsWith(suffix),
      'CLEANUP_ROUTE_MISMATCH',
    );
    const profile = bid.catalogId.slice(prefix.length, -suffix.length);
    assert(['micro', 'small', 'medium', 'large'].includes(profile), 'CLEANUP_PROFILE_UNKNOWN');
    return { ...provider, profile, region: bid.region };
  }
  assert(
    provider && bid.catalogId === provider.catalogId && bid.region === provider.region,
    'WRONG_WINNING_ROUTE',
  );
  return provider;
}
function rememberVm(d: Json) {
  if (!d.vm?.environmentId) return;
  assert(d.vm.requestId === d.request.id, 'VM_REQUEST_IDENTITY');
  const p = providerFor(d, true);
  const attempt = intents().find(
    (r) =>
      r.body &&
      typeof r.body === 'object' &&
      (r.body as Json).description === d.request.description,
  );
  assert(
    attempt &&
      Number.isInteger(attempt.item) &&
      Number(attempt.item) >= 1 &&
      Number(attempt.item) <= settings.target,
    'RECEIPT_REQUEST_INTENT',
  );
  if (!journal.read().some((r) => r.kind === 'request-result' && r.requestId === d.request.id))
    journal.append('request-result', {
      item: attempt.item,
      requestId: d.request.id,
      createdAt: d.request.createdAt,
      closesAt: d.request.closesAt,
      reconciled: true,
    });
  const existing = journal.read().filter((r) => r.kind === 'vm-receipt');
  if (existing.some((r) => r.vmId === d.vm.id && r.environmentId === d.vm.environmentId)) return;
  assert(new Set(existing.map((r) => r.environmentId)).size < settings.target, 'RECEIPT_BOUND');
  journal.append('vm-receipt', {
    vmId: d.vm.id,
    requestId: d.request.id,
    environmentId: d.vm.environmentId,
    provider: p.provider,
    profile: p.profile,
    region: p.region,
    createdAt: d.vm.createdAt,
  });
}
async function cleanupNativeReceipts(h: Header, confirmed: Set<string>) {
  const records = journal.read().filter((r) => r.kind === 'vm-receipt');
  const unique = [...new Map(records.map((r) => [String(r.environmentId), r])).values()];
  assert(unique.length <= settings.target, 'RECEIPT_BOUND');
  const outcomes = await cleanupBatch(
    unique.filter((r) => !confirmed.has(String(r.environmentId))),
    async (record) => {
      const result = journal
        .read()
        .find((r) => r.kind === 'request-result' && r.requestId === record.requestId);
      const intent = result && intents().find((r) => r.item === result.item);
      assert(
        result &&
          intent &&
          intent.body &&
          typeof intent.body === 'object' &&
          (intent.body as Json).description === description(h, Number(result.item)),
        'RECEIPT_RUN_IDENTITY',
      );
      const base = settings.providers.find((p) => p.provider === record.provider);
      assert(
        base && ['micro', 'small', 'medium', 'large'].includes(String(record.profile)),
        'RECEIPT_ROUTE',
      );
      const p = { ...base, profile: String(record.profile), region: String(record.region) };
      const vm = {
        id: record.vmId,
        environmentId: record.environmentId,
        createdAt: record.createdAt,
      };
      const observed = await native.get(String(record.environmentId));
      assert(ownership(observed, vm, p, h), 'CLEANUP_OWNERSHIP');
      if (observed.status !== 'terminated') await native.terminate(observed.id);
      const after = observed.status === 'terminated' ? observed : await native.get(observed.id);
      assert(ownership(after, vm, p, h), 'CLEANUP_OWNERSHIP');
      if (after.status === 'terminated') confirmed.add(after.id);
    },
  );
  return { total: unique.length, failed: outcomes.filter((r) => r.status === 'rejected').length };
}
async function providerOfferings(p: Provider) {
  const response = await api(p.cookie, '/api/provider/offerings?limit=100');
  assert(Array.isArray(response.items) && !response.nextCursor, 'CANARY_OFFERINGS_BOUND');
  return response.items as Json[];
}
async function restoreCanaryAvailability(only?: Provider): Promise<boolean> {
  if (!canaryMode) return true;
  const baselines = journal.read().filter((r) => r.kind === 'canary-listing-baseline');
  const selected = settings.providers.filter((p) => !only || p.provider === only.provider);
  const outcomes = await cleanupBatch(selected, async (p) => {
    const baseline = baselines.find((r) => r.provider === p.provider);
    if (!baseline) return;
    assert(
      baseline.catalogId === p.catalogId &&
        baseline.offeringId === p.offeringId &&
        baseline.catalogApproved === false &&
        baseline.offeringActive === false &&
        baseline.autoBid === false,
      'CANARY_RESTORE_BASELINE',
    );
    // Independent credentials/routes: failure restoring one flag must not skip the other.
    const restored = await Promise.allSettled([
      (async () => {
        const offering = (await providerOfferings(p)).find((o) => o.id === p.offeringId);
        assert(offering?.catalogId === p.catalogId, 'CANARY_RESTORE_OFFERING');
        if (offering.active)
          await api(p.cookie, '/api/provider/offerings/' + p.offeringId, 'PATCH', {
            active: false,
          });
      })(),
      (async () => {
        const catalog = (await api(settings.adminCookie, '/api/admin/config')).catalog;
        const item = catalog.find((c: Json) => c.id === p.catalogId);
        assert(item?.provider === p.provider, 'CANARY_RESTORE_CATALOG');
        if (item.approved)
          await api(
            settings.adminCookie,
            '/api/admin/catalog/' + encodeURIComponent(p.catalogId),
            'PUT',
            { approved: false },
          );
      })(),
    ]);
    assert(
      restored.every((r) => r.status === 'fulfilled'),
      'CANARY_FLAG_RESTORE',
    );
    const [after, config, dashboard] = await Promise.all([
      providerOfferings(p),
      api(settings.adminCookie, '/api/admin/config'),
      api(p.cookie, '/api/provider/dashboard'),
    ]);
    assert(after.find((o) => o.id === p.offeringId)?.active === false, 'CANARY_OFFERING_RESTORE');
    assert(
      config.catalog.find((c: Json) => c.id === p.catalogId)?.approved === false,
      'CANARY_CATALOG_RESTORE',
    );
    assert(dashboard.policy.autoBid === false, 'CANARY_AUTOBID_CHANGED');
    journal.append('canary-listing-restored', {
      provider: p.provider,
      offeringId: p.offeringId,
      catalogId: p.catalogId,
    });
  });
  return outcomes.every((outcome) => outcome.status === 'fulfilled');
}
async function cleanup(h: Header, duration = 180_000) {
  if (!journal.read().some((r) => r.kind === 'stop-requested'))
    journal.append('stop-requested', { reason: 'cleanup' });
  const end = Date.now() + duration;
  let unknown = intents().length,
    pending = intents().length;
  const nativeConfirmed = new Set<string>();
  let lastCount = -1;
  while (Date.now() < end) {
    // Restore temporary exposure independently of uncertain request/VM discovery.
    const listingsRestored = await restoreCanaryAvailability().catch(() => false);
    let brokerVerified = false,
      holdsReleased = false;
    try {
      const owned = await ownedRequests(h);
      unknown = owned.unknown;
      pending = unknown;
      await cleanupBatch(
        owned.requests.filter((r) => r.status === 'open'),
        (request) =>
          api(
            settings.buyerCookie,
            '/api/requests/' + request.id + '/cancel',
            'POST',
            {},
            [200, 409],
          ),
      );
      const found = await cleanupBatch(owned.requests, detail);
      pending += found.filter((r) => r.status === 'rejected').length;
      const details = found
        .filter((r): r is PromiseFulfilledResult<Json> => r.status === 'fulfilled')
        .map((r) => r.value);
      const actions = await cleanupBatch(details, async (d) => {
        const vm = d.vm;
        if (!vm) {
          if (!['cancelled', 'failed', 'no_offers'].includes(d.request.status)) pending++;
          return;
        }
        assert(vm.requestId === d.request.id, 'CLEANUP_REQUEST_IDENTITY');
        try {
          rememberVm(d);
        } catch {
          pending++;
          journal.append('cleanup-receipt-unresolved', { vmId: vm.id });
        }
        if (!['failed', 'expired', 'terminated'].includes(vm.status) || vm.cleanupPending)
          await api(settings.buyerCookie, '/api/vms/' + vm.id + '/terminate', 'POST', {});
        if (!vm.environmentId && (vm.status !== 'failed' || vm.cleanupPending)) pending++;
        if (!['failed', 'expired', 'terminated'].includes(vm.status) || vm.cleanupPending)
          pending++;
      });
      pending += actions.filter((r) => r.status === 'rejected').length;
      const dashboards = await cleanupBatch(settings.providers, (p) =>
        api(p.cookie, '/api/provider/dashboard'),
      );
      holdsReleased = dashboards.every(
        (r, i) =>
          r.status === 'fulfilled' &&
          r.value.capacity.held === (settings.providers[i].baselineHeld ?? 0),
      );
      brokerVerified = true;
    } catch {
      journal.append('cleanup-retry', { classification: 'bounded-broker-cleanup-error' });
    }
    let nativePending = 1;
    try {
      const state = await cleanupNativeReceipts(h, nativeConfirmed);
      nativePending = state.total - nativeConfirmed.size + state.failed;
    } catch {
      journal.append('cleanup-retry', { classification: 'bounded-native-cleanup-error' });
    }
    if (brokerVerified) {
      if (pending !== lastCount) {
        journal.append('cleanup-progress', {
          unresolved: pending,
          unknown,
          nativeConfirmed: nativeConfirmed.size,
        });
        lastCount = pending;
      }
      const exposuresSettled =
        !canaryMode ||
        journal
          .read()
          .filter((r) => r.kind === 'canary-exposure-mutation')
          .every((r) => Date.now() - Date.parse(r.at) >= 60_000);
      if (!pending && !nativePending && holdsReleased && listingsRestored && exposuresSettled) {
        const result = {
          confirmed: true,
          unknown: 0,
          pending: 0,
          holdsReleased: true,
          nativeConfirmed: nativeConfirmed.size,
          ...(canaryMode ? { listingsRestored: true } : {}),
        };
        journal.append('cleanup-confirmed', result);
        return result;
      }
    }
    await delay(2000);
  }
  return {
    confirmed: false,
    unknown,
    pending,
    holdsReleased: false,
    nativeConfirmed: nativeConfirmed.size,
    ...(canaryMode ? { listingsRestored: false } : {}),
  };
}
interface Shell {
  ws: WebSocket;
  vmId: string;
  t0: TerminalMarkerProof;
  t1: TerminalMarkerProof;
  resize: TerminalMarkerProof;
  noStty: TerminalMarkerProof;
  ready: boolean;
  inputFramesSent: number;
  outputBytes: number;
  lastPong: number;
  state: string;
  lastProofAt: number;
  proofInFlight: boolean;
  initialProofPassed: boolean;
  diagnosticClosed: boolean;
  proofFailure?: { phase: string; classification: 'known-blaxel-proof-timeout' };
  canaryFailure?: string;
}
async function run(h: Header) {
  exclusive(journalPath + '.run-owner');
  assert(!runStart(), 'A live run cannot be restarted.');
  const watchdogReady = () => {
    const r = privateRead(paths.ready);
    return r?.runId === h.runId && Date.now() - Date.parse(r.at) < 5000 && alive(r.pid);
  };
  assert(watchdogReady(), 'Independent cleanup watchdog is required.');
  const deadline = Date.now() + h.maximumRunMs;
  journal.append('runner-start', {
    pid: process.pid,
    deadline,
    terminalPolicy: h.terminalPolicy ?? 'strict',
  });
  const heartbeat = () =>
    atomic(paths.heartbeat, { pid: process.pid, runId: h.runId, at: new Date().toISOString() });
  heartbeat();
  const timer = setInterval(heartbeat, 2000);
  const shells: Shell[] = [];
  const diagnosticBlaxel = h.terminalPolicy === 'compute-with-blaxel-diagnostics';
  const collectBlaxel = h.terminalPolicy === 'collect-blaxel-timeouts' || diagnosticBlaxel;
  let refreshing = false;
  const scheduledProofs = new Set<Shell>();
  let timeoutReview = Promise.resolve();
  let intentional = false,
    failure = '',
    peakRunning = 0,
    terminalHoldMs = 0;
  const observations = new Map<string, Json>();
  let budget = 0;
  const stop = (reason: string) => {
    failure ||= reason;
  };
  const check = () => {
    assert(
      !failure &&
        Date.now() < deadline &&
        watchdogReady() &&
        !journal.read().some((r) => ['stop-requested', 'watchdog-triggered'].includes(r.kind)),
      'RUN_STOPPED',
    );
  };
  const signals = () => {
    stop('SIGNAL');
    journal.append('stop-requested', { reason: 'signal' });
  };
  process.on('SIGTERM', signals);
  process.on('SIGINT', signals);
  async function until<T>(work: () => Promise<T | undefined>, maximum: number): Promise<T> {
    const end = Math.min(deadline, Date.now() + maximum);
    while (Date.now() < end) {
      check();
      await refreshDue();
      const result = await work();
      if (result !== undefined) return result;
      await delay(1000);
    }
    for (const shell of shells)
      journal.append('terminal-checkpoint', {
        vmId: shell.vmId,
        reason: 'bounded-wait-timeout',
        ready: shell.ready,
        inputSent: shell.inputFramesSent > 0,
        inputFramesSent: shell.inputFramesSent,
        outputBytes: shell.outputBytes,
        pongReceived: shell.lastPong > 0,
        socketOpen: shell.ws.readyState === WebSocket.OPEN,
        t0: shell.t0.matched,
        t1: shell.t1.matched,
        resize: shell.resize.matched,
        resizeUnavailable: shell.noStty.matched,
      });
    throw new Error('BOUNDED_WAIT_TIMEOUT');
  }
  function shell(vm: Json): Shell {
    const nonce = randomBytes(12).toString('hex'),
      prefix = 'HOSTED_' + nonce;
    const url = new URL('/api/vms/' + vm.id + '/terminal', origin);
    url.protocol = 'wss:';
    const ws = new WebSocket(url, {
      headers: { Cookie: settings.buyerCookie, Origin: origin.origin },
      handshakeTimeout: 15_000,
      maxPayload: 300_000,
    });
    const s: Shell = {
      ws,
      vmId: vm.id,
      t0: new TerminalMarkerProof(prefix + '_T0'),
      t1: new TerminalMarkerProof(prefix + '_T1'),
      resize: new TerminalMarkerProof(prefix + '_RESIZE'),
      noStty: new TerminalMarkerProof(prefix + '_NO_STTY'),
      ready: false,
      inputFramesSent: 0,
      outputBytes: 0,
      lastPong: 0,
      state: nonce,
      lastProofAt: 0,
      proofInFlight: false,
      initialProofPassed: false,
      diagnosticClosed: false,
    };
    shells.push(s);
    journal.append('terminal-open-intent', { vmId: vm.id });
    const terminalFailure = (classification: string) => {
      journal.append('terminal-failure', { vmId: vm.id, classification });
      if (canaryMode) {
        s.canaryFailure ||= classification;
        return;
      }
      stop(classification === 'protocol-or-proof' ? 'TERMINAL_PROOF' : 'TERMINAL_ENDED');
    };
    ws.on('message', (raw) => {
      if (intentional || s.proofFailure || s.diagnosticClosed) return;
      try {
        const frame = JSON.parse(raw.toString());
        if (frame.type === 'ready' && !s.ready) {
          assert.equal(frame.mode, 'real');
          s.ready = true;
          ws.send(JSON.stringify({ type: 'resize', cols: 113, rows: 37 }));
          ws.send(
            JSON.stringify({
              type: 'input',
              data:
                "test -t 0 && test -t 1 && export BROKER_PROBE_STATE='" +
                nonce +
                "' && cd /tmp && printf '\\nHOSTED_%s%s_T0\\n' '" +
                nonce.slice(0, 12) +
                "' '" +
                nonce.slice(12) +
                "'\r",
            }),
          );
          s.inputFramesSent++;
          ws.send(JSON.stringify({ type: 'ping' }));
        } else if (frame.type === 'output') {
          assert(typeof frame.data === 'string');
          const bytes = Buffer.from(frame.data, 'base64');
          s.outputBytes += bytes.length;
          for (const proof of [s.t0, s.t1, s.resize, s.noStty]) proof.push(bytes);
          ws.send(JSON.stringify({ type: 'ack', bytes: bytes.length }));
        } else if (frame.type === 'pong') s.lastPong = Date.now();
        else if (frame.type === 'exit' || frame.type === 'error') terminalFailure(frame.type);
      } catch {
        terminalFailure('protocol-or-proof');
      }
    });
    ws.on('close', () => {
      if (!intentional && !s.proofFailure && !s.diagnosticClosed) terminalFailure('close');
    });
    ws.on('error', () => {
      if (!intentional && !s.proofFailure && !s.diagnosticClosed) terminalFailure('transport');
    });
    return s;
  }
  async function fullProof(selected: Shell[], phase = 'initial') {
    assert(
      selected.every((s) => !s.proofInFlight && !s.proofFailure && !s.diagnosticClosed),
      'TERMINAL_PROOF_OVERLAP',
    );
    for (const shell of selected) shell.proofInFlight = true;
    try {
      const pingAt = Date.now();
      for (const shell of selected) {
        const nonce = randomBytes(12).toString('hex'),
          prefix = 'HOSTED_' + nonce;
        shell.t1 = new TerminalMarkerProof(prefix + '_T1');
        shell.resize = new TerminalMarkerProof(prefix + '_RESIZE');
        shell.noStty = new TerminalMarkerProof(prefix + '_NO_STTY');
        const print = (suffix: string) =>
          "printf '\\nHOSTED_%s%s_" +
          suffix +
          "\\n' '" +
          nonce.slice(0, 12) +
          "' '" +
          nonce.slice(12) +
          "'";
        shell.ws.send(JSON.stringify({ type: 'resize', cols: 113, rows: 37 }));
        shell.ws.send(
          JSON.stringify({
            type: 'input',
            data:
              'test -t 0 && test -t 1 && [ "$BROKER_PROBE_STATE" = \'' +
              shell.state +
              "' ] && [ \"$PWD\" = '/tmp' ] && " +
              print('T1') +
              '; if command -v stty >/dev/null 2>&1; then [ "$(stty size 2>/dev/null)" = \'37 113\' ] && ' +
              print('RESIZE') +
              '; else ' +
              print('NO_STTY') +
              '; fi\r',
          }),
        );
        shell.inputFramesSent++;
        shell.ws.send(JSON.stringify({ type: 'ping' }));
      }
      await until(
        async () =>
          selected.every(
            (shell) =>
              shell.t1.matched &&
              (shell.resize.matched || (!canaryMode && shell.noStty.matched)) &&
              !shell.canaryFailure &&
              shell.lastPong >= pingAt &&
              shell.ws.readyState === WebSocket.OPEN,
          )
            ? true
            : undefined,
        35_000,
      );
      for (const shell of selected) {
        shell.lastProofAt = Date.now();
        if (phase !== 'initial')
          journal.append('terminal-state-proof-refreshed', { vmId: shell.vmId, phase });
      }
    } finally {
      for (const shell of selected) shell.proofInFlight = false;
    }
  }
  const healthyShells = () =>
    shells.filter((s) => !s.proofFailure && !s.diagnosticClosed && !s.canaryFailure);
  function confirmed(shell: Shell) {
    const d = observations.get(shell.vmId)!;
    journal.append('terminal-proof-confirmed', {
      vmId: shell.vmId,
      provider: providerFor(d).provider,
      t0: true,
      t1: true,
      pty: true,
      shellStateAndCwd: true,
      resize: shell.resize.matched ? 'confirmed' : 'unavailable',
    });
    shell.initialProofPassed = true;
  }
  async function collectionProof(selected: Shell[], phase: 'initial' | 'refresh' | 'final') {
    assert(
      selected.every((s) => !scheduledProofs.has(s)),
      'TERMINAL_PROOF_OVERLAP',
    );
    for (const shell of selected) scheduledProofs.add(shell);
    try {
      const outcomes = await Promise.allSettled(
        selected.map(async (s) => {
          let stage: string = phase;
          try {
            if (phase === 'initial') {
              stage = 't0';
              await until(
                async () =>
                  s.ready && s.t0.matched && s.lastPong > 0 && s.ws.readyState === WebSocket.OPEN
                    ? true
                    : undefined,
                35_000,
              );
              stage = 't1';
            }
            await fullProof([s], phase);
            if (phase === 'initial') {
              const d = observations.get(s.vmId)!,
                p = providerFor(d);
              if (diagnosticBlaxel && p.provider === 'provider-blaxel') {
                const observed = await native.get(d.vm.environmentId);
                assert(
                  ownership(observed, d.vm, p, h) &&
                    observed.status === 'running' &&
                    observed.billingMode === 'wick_managed' &&
                    !observed.providerKeyId,
                  'NATIVE_RUNNING_SCOPE',
                );
                check(); // An error/revocation before our deliberate close remains fatal.
                confirmed(s); // Durable real initial proof precedes the expected-close flag.
                journal.append('terminal-diagnostic-completed', {
                  vmId: s.vmId,
                  provider: p.provider,
                  initialProofPassed: true,
                  retainedForOverlap: false,
                });
                s.diagnosticClosed = true;
                s.ws.close();
              } else confirmed(s);
            }
            return undefined;
          } catch (error) {
            const provider = providerFor(observations.get(s.vmId)!).provider;
            if (!(
              error instanceof Error &&
              error.message === 'BOUNDED_WAIT_TIMEOUT' &&
              provider === 'provider-blaxel' &&
              s.ready &&
              s.lastPong > 0 &&
              s.ws.readyState === WebSocket.OPEN &&
              !failure
            )) {
              stop('UNEXPECTED_TERMINAL_PROOF_FAILURE');
              throw error;
            }
            return { shell: s, phase: stage };
          }
        }),
      );
      const fatal = outcomes.find((r) => r.status === 'rejected');
      if (fatal?.status === 'rejected') throw fatal.reason;
      const timeouts = outcomes
        .filter(
          (r): r is PromiseFulfilledResult<{ shell: Shell; phase: string } | undefined> =>
            r.status === 'fulfilled',
        )
        .map((r) => r.value)
        .filter((r): r is { shell: Shell; phase: string } => r !== undefined);
      if (!timeouts.length) return;
      // A readiness cohort and disjoint liveness maintenance can finish together.
      // Serialize their API rechecks so bounded native batches stay at four calls.
      const previousReview = timeoutReview;
      let releaseReview!: () => void;
      timeoutReview = new Promise<void>((resolve) => {
        releaseReview = resolve;
      });
      await previousReview;
      try {
        check();
        await sample(); // A proof timeout must never conceal an ended rental.
        await bounded(timeouts, async ({ shell, phase }) => {
          const d = observations.get(shell.vmId)!,
            p = providerFor(d),
            observed = await native.get(d.vm.environmentId);
          assert(
            ownership(observed, d.vm, p, h) &&
              observed.status === 'running' &&
              observed.billingMode === 'wick_managed' &&
              !observed.providerKeyId,
            'NATIVE_RUNNING_SCOPE',
          );
          check();
          shell.proofFailure = { phase, classification: 'known-blaxel-proof-timeout' };
          journal.append('terminal-proof-failed', {
            vmId: shell.vmId,
            provider: p.provider,
            phase,
            classification: shell.proofFailure.classification,
            collected: true,
          });
          // This close is expected only after the exact timeout and native checks above.
          shell.ws.close();
        });
      } finally {
        releaseReview();
      }
    } finally {
      for (const shell of selected) scheduledProofs.delete(shell);
    }
  }
  async function refreshDue() {
    if (refreshing) return;
    const due = healthyShells().filter(
      (s) =>
        s.lastProofAt > 0 &&
        !s.proofInFlight &&
        !scheduledProofs.has(s) &&
        Date.now() - s.lastProofAt > 60_000,
    );
    if (!due.length) return;
    refreshing = true;
    try {
      if (canaryMode)
        await cleanupBatch(due, async (s) => {
          try {
            await fullProof([s], 'refresh');
          } catch {
            s.canaryFailure ||= 'REFRESH_PROOF_FAILED';
          }
        });
      else if (collectBlaxel) await collectionProof(due, 'refresh');
      else await fullProof(due, 'refresh');
    } finally {
      refreshing = false;
    }
  }
  async function sample() {
    const all = await list('/api/vms');
    const requestIds = new Set(
      journal
        .read()
        .filter((r) => r.kind === 'request-result')
        .map((r) => r.requestId),
    );
    const own = all.filter((v) => requestIds.has(v.requestId));
    peakRunning = Math.max(peakRunning, own.filter((v) => v.status === 'running').length);
    assert(
      canaryMode ||
        own.every((v) => !['failed', 'terminated', 'terminating', 'expired'].includes(v.status)),
      'RENTAL_ENDED',
    );
    return own;
  }
  async function request(item: number, provider?: Provider) {
    check();
    assert(intents().length < settings.target, 'CUMULATIVE_REQUEST_CAP');
    assert(
      Number.isInteger(item) &&
        item >= 1 &&
        item <= settings.target &&
        !intents().some((r) => r.item === item),
      'REQUEST_ITEM_IDENTITY',
    );
    const ref = provider ?? settings.providers[0];
    if (canaryMode)
      assert(provider && settings.providers[item - 1] === provider, 'CANARY_ITEM_ROUTE');
    const body = {
      description: description(h, item),
      catalogId: ref.catalogId,
      region: provider ? ref.region : 'any',
      matchAcrossProviders: !provider,
      durationMinutes: 15,
      maxPriceCents: canaryMode ? ref.basePriceCents : budget,
      requirements: canaryMode ? { cpu: ref.cpu, memoryGb: ref.memoryGb } : { cpu: 1, memoryGb: 2 },
    };
    journal.append('request-intent', { item, body });
    check(); // Recheck the admission fence after the durable intent, immediately before dispatch.
    let result: Json;
    try {
      result = await api(settings.buyerCookie, '/api/requests', 'POST', body);
    } catch {
      const matches = (await ownedRequests(h)).requests.filter(
        (r) => r.description === body.description,
      );
      assert.equal(matches.length, 1, 'UNKNOWN_POST_NO_REPLAY');
      result = matches[0];
    }
    assert.equal(
      Date.parse(result.closesAt) - Date.parse(result.createdAt),
      30_000,
      'AUCTION_DEADLINE',
    );
    assert.equal(result.description, body.description, 'REQUEST_RESULT_IDENTITY');
    journal.append('request-result', {
      item,
      requestId: result.id,
      createdAt: result.createdAt,
      closesAt: result.closesAt,
    });
    return result;
  }
  async function canaryRequest(item: number, p: Provider) {
    check();
    const baseline = journal
      .read()
      .find((r) => r.kind === 'canary-listing-baseline' && r.provider === p.provider);
    assert(
      baseline?.catalogId === p.catalogId && baseline.offeringId === p.offeringId,
      'CANARY_BASELINE_MISSING',
    );
    journal.append('canary-exposure-intent', {
      provider: p.provider,
      catalogId: p.catalogId,
      offeringId: p.offeringId,
    });
    try {
      check();
      journal.append('canary-exposure-mutation', { provider: p.provider, flag: 'catalogApproved' });
      check();
      await api(
        settings.adminCookie,
        '/api/admin/catalog/' + encodeURIComponent(p.catalogId),
        'PUT',
        { approved: true },
      );
      check();
      journal.append('canary-exposure-mutation', { provider: p.provider, flag: 'offeringActive' });
      check();
      await api(p.cookie, '/api/provider/offerings/' + p.offeringId, 'PATCH', { active: true });
      check();
      const dashboard = await api(p.cookie, '/api/provider/dashboard');
      assert(
        dashboard.policy.autoBid === false &&
          dashboard.policy.basePriceCents === baseline.configuredBasePriceCents &&
          canaryQuote(
            settings.mode!,
            dashboard.policy.basePriceCents,
            dashboard.policy.minimumPriceCents,
            fixedQuote(managedPricing(baseline.catalog as any), 15).upstreamCostFloorCents ?? 0,
            dashboard.policy.maxPriceCents,
          ) === p.basePriceCents,
        'CANARY_POLICY_CHANGED',
      );
      const created = await request(item, p);
      journal.append('canary-manual-bid-intent', {
        item,
        requestId: created.id,
        provider: p.provider,
        offeringId: p.offeringId,
        basePriceCents: p.basePriceCents,
      });
      check();
      let bid: Json;
      try {
        bid = await api(p.cookie, '/api/provider/requests/' + created.id + '/bids', 'POST', {
          totalPriceCents: p.basePriceCents,
          offeringId: p.offeringId,
        });
      } catch {
        const observed = await detail(created);
        const matches = observed.bids.filter(
          (b: Json) =>
            b.providerId === baseline.providerId &&
            b.cloudProvider === p.provider &&
            b.catalogId === p.catalogId &&
            b.totalPriceCents === p.basePriceCents,
        );
        assert.equal(matches.length, 1, 'UNKNOWN_BID_NO_REPLAY');
        bid = matches[0];
      }
      assert(
        bid.cloudProvider === p.provider &&
          bid.catalogId === p.catalogId &&
          bid.totalPriceCents === p.basePriceCents,
        'CANARY_BINDING_BID',
      );
      journal.append('canary-manual-bid-confirmed', {
        item,
        requestId: created.id,
        bidId: bid.id,
        provider: p.provider,
        basePriceCents: p.basePriceCents,
      });
      return created;
    } finally {
      if (!(await restoreCanaryAvailability(p))) {
        stop('CANARY_IMMEDIATE_RESTORE_FAILED');
        journal.append('stop-requested', { reason: 'CANARY_IMMEDIATE_RESTORE_FAILED' });
        throw new Error('CANARY_IMMEDIATE_RESTORE_FAILED');
      }
    }
  }
  async function ready(requests: Json[], expected?: Provider[]) {
    return until(async () => {
      const details = await bounded(requests, detail);
      for (const d of details) rememberVm(d);
      assert(
        details.every((d) => !['failed', 'cancelled', 'no_offers'].includes(d.request.status)),
        'AUCTION_OR_CREATE_FAILED',
      );
      await sample();
      const newlyReady = details
        .map((d, index) => ({ detail: d, requestIndex: index }))
        .filter(({ detail: d }) => d.vm?.status === 'running' && !observations.has(d.vm.id));
      await bounded(newlyReady, async ({ detail: d, requestIndex: index }) => {
        const p = providerFor(d);
        if (expected) assert.equal(p.provider, expected[index].provider, 'CANARY_ROUTE_CHANGED');
        const vm = d.vm;
        const observed = await native.get(vm.environmentId);
        assert(
          ownership(observed, vm, p, h) &&
            observed.status === 'running' &&
            observed.billingMode === 'wick_managed' &&
            !observed.providerKeyId,
          'NATIVE_RUNNING_SCOPE',
        );
        const winning = d.bids.find((b: Json) => b.id === d.request.winningBidId);
        assert(
          winning.pricing?.rateMicrosPerSecond === p.rateMicrosPerSecond &&
            winning.revenueShare?.commissionBps === 1500,
          'FROZEN_PRICE_MISMATCH',
        );
        observations.set(vm.id, d);
        journal.append('vm-observed', {
          vmId: vm.id,
          requestId: d.request.id,
          environmentId: vm.environmentId,
          provider: p.provider,
          profile: p.profile,
          region: p.region,
          createdAt: vm.createdAt,
          ...(canaryMode ? canaryNativeTiming(observed, vm, p) : {}),
        });
        if (!shells.some((s) => s.vmId === vm.id)) shell(vm);
      });
      const newShells = shells.filter((shell) =>
        newlyReady.some(({ detail: d }) => d.vm.id === shell.vmId),
      );
      if (newShells.length) {
        if (collectBlaxel) await collectionProof(newShells, 'initial');
        else {
          await until(
            async () =>
              newShells.every(
                (shell) =>
                  shell.ready &&
                  shell.t0.matched &&
                  shell.lastPong > 0 &&
                  shell.ws.readyState === WebSocket.OPEN,
              )
                ? true
                : undefined,
            35_000,
          );
          await fullProof(newShells);
          for (const shell of newShells) confirmed(shell);
        }
      }
      if (
        !details.every(
          (d) =>
            d.vm?.status === 'running' &&
            observations.has(d.vm.id) &&
            shells.some(
              (shell) =>
                shell.vmId === d.vm.id &&
                ((diagnosticBlaxel && shell.diagnosticClosed && shell.initialProofPassed) ||
                  (collectBlaxel && shell.proofFailure !== undefined) ||
                  (shell.t0.matched && shell.t1.matched && shell.ws.readyState === WebSocket.OPEN)),
            ),
        )
      )
        return undefined;
      return details;
    }, 180_000);
  }
  function terminalResults() {
    return Object.fromEntries(
      settings.providers.map((p) => {
        const own = shells.filter(
          (s) => providerFor(observations.get(s.vmId)!).provider === p.provider,
        );
        return [
          p.provider,
          {
            attempted: own.length,
            initialProofs: own.filter((s) => s.initialProofPassed).length,
            diagnosticClosed: own.filter((s) => s.diagnosticClosed).length,
            proven: own.filter(
              (s) =>
                !s.proofFailure &&
                !s.diagnosticClosed &&
                !s.canaryFailure &&
                s.lastProofAt > 0 &&
                s.t0.matched &&
                s.t1.matched &&
                s.ws.readyState === WebSocket.OPEN,
            ).length,
            failedProofs: own.filter((s) => s.proofFailure).length,
            closedAfterKnownFailure: own.filter(
              (s) => s.proofFailure && s.ws.readyState === WebSocket.CLOSED,
            ).length,
          },
        ];
      }),
    );
  }
  let result: Json = {};
  let observedModes = { wick: 'real', muse: 'fixture' };
  try {
    const health = await api(settings.buyerCookie, '/health');
    if (canaryMode)
      assert(
        health.modes.wick === 'real' && ['real', 'fixture'].includes(health.modes.muse),
        'CANARY_MODES',
      );
    else assert.deepEqual(health.modes, { wick: 'real', muse: 'fixture' });
    observedModes = health.modes;
    const config = await api(settings.adminCookie, '/api/admin/config');
    assert.equal(config.maxConcurrentVms, 20);
    if (canaryMode) {
      assert(
        Array.isArray(config.unresolved) && config.unresolved.length === 0,
        'CANARY_UNRESOLVED_CLEANUP',
      );
      assert(
        config.providers.reduce((n: number, p: Json) => n + p.held, 0) <=
          config.maxConcurrentVms - settings.target,
        'CANARY_GLOBAL_CAPACITY',
      );
    }
    const catalog = (await api(settings.buyerCookie, '/api/catalog')).items;
    const dashboards = await bounded(settings.providers, (p) =>
      api(p.cookie, '/api/provider/dashboard'),
    );
    for (let i = 0; i < settings.providers.length; i++) {
      const p = settings.providers[i],
        d = dashboards[i],
        c = catalog.find((c: Json) => c.id === p.catalogId);
      assert(
        d.provider.cloudProvider === p.provider &&
          d.capacity.total === p.capacity &&
          d.capacity.held === 0 &&
          d.capacity.available === p.capacity &&
          d.policy.autoBid === !canaryMode,
        'PROVIDER_PREFLIGHT',
      );
      assert(
        c &&
          c.approved === !canaryMode &&
          c.provider === p.provider &&
          c.profile === p.profile &&
          c.region === p.region &&
          c.rateMicrosPerSecond === p.rateMicrosPerSecond,
        'CATALOG_PREFLIGHT',
      );
      if (canaryMode) {
        assert(
          c.cpu === p.cpu && c.memoryGb === p.memoryGb && c.resources?.diskGb === p.diskGb,
          'CANARY_EXACT_RESOURCES',
        );
        assert(
          c.capabilities?.includes('interactive-terminal') && c.durationMinutes.includes(15),
          'CANARY_CAPABILITIES',
        );
        const offerings = await providerOfferings(p);
        const offering = offerings.find((o) => o.id === p.offeringId);
        assert(
          offering?.catalogId === p.catalogId && offering.active === false,
          'CANARY_INACTIVE_OFFERING',
        );
        const quote = canaryQuote(
          settings.mode!,
          d.policy.basePriceCents,
          d.policy.minimumPriceCents,
          fixedQuote(managedPricing(c), 15).upstreamCostFloorCents ?? 0,
          d.policy.maxPriceCents,
        );
        if (p.basePriceCents !== undefined)
          assert.equal(p.basePriceCents, quote, 'CANARY_REVIEWED_BASE');
        p.basePriceCents = quote;
        journal.append('canary-listing-baseline', {
          provider: p.provider,
          providerId: d.provider.id,
          catalogId: p.catalogId,
          offeringId: p.offeringId,
          catalogApproved: false,
          offeringActive: false,
          autoBid: false,
          policyRevision: d.policyRevision,
          basePriceCents: quote,
          configuredBasePriceCents: d.policy.basePriceCents,
          capacity: d.capacity,
          catalog: c,
          offering,
        });
      }
      budget = Math.max(
        budget,
        d.policy.basePriceCents,
        d.policy.minimumPriceCents,
        fixedQuote(managedPricing(c), 15).upstreamCostFloorCents ?? 0,
      );
    }
    assert(
      budget > 0 && budget <= (canaryMode ? CANARY_QUOTE_CEILING_CENTS : 10),
      'REVIEWED_QUOTE_CEILING',
    );
    const before = await list('/api/vms');
    assert(
      canaryMode ||
        before.every(
          (v) => ['failed', 'expired', 'terminated'].includes(v.status) && !v.cleanupPending,
        ),
      'EXISTING_ACTIVE_BUYER_RENTAL',
    );
    if (canaryMode)
      journal.append('canary-buyer-baseline', {
        activeVmIds: before
          .filter(
            (v) => !['failed', 'expired', 'terminated'].includes(v.status) || v.cleanupPending,
          )
          .map((v) => v.id),
      });
    journal.append('preflight-passed', {
      providers: settings.providers.length,
      target: settings.target,
      maximumBuyerQuoteCents: budget,
    });
    if (canaryMode) {
      const outcomes: Record<string, Json> = Object.fromEntries(
        settings.providers.map((p) => [
          p.provider,
          { nativeRunning: false, terminalPassed: false, invoicePassed: false },
        ]),
      );
      await cleanupBatch(settings.providers, async (p) => {
        try {
          const created = await canaryRequest(settings.providers.indexOf(p) + 1, p);
          await ready([created], [p]);
          outcomes[p.provider].initialTerminalPassed = true;
        } catch (error) {
          outcomes[p.provider].failure =
            error instanceof Error && /^[A-Z0-9_]+$/.test(error.message)
              ? error.message
              : 'CANARY_INITIAL_FAILED';
          for (const s of shells.filter(
            (s) => providerFor(observations.get(s.vmId)!).provider === p.provider,
          ))
            s.canaryFailure ||= outcomes[p.provider].failure;
        }
      });
      const holdStart = Date.now();
      while (
        healthyShells().some((s) => s.initialProofPassed) &&
        Date.now() - holdStart < CANARY_HOLD_MS
      ) {
        check();
        await refreshDue();
        for (const s of healthyShells().filter((s) => s.initialProofPassed))
          s.ws.send(JSON.stringify({ type: 'ping' }));
        await sample();
        await delay(1000);
      }
      terminalHoldMs = Date.now() - holdStart;
      // Final proofs own every shell; do not schedule overlapping maintenance proofs.
      refreshing = true;
      try {
        await cleanupBatch(settings.providers, async (p) => {
          const own = [...observations.values()].find(
            (d) => providerFor(d).provider === p.provider,
          );
          if (!own) return;
          try {
            const observed = await native.get(own.vm.environmentId);
            assert(
              ownership(observed, own.vm, p, h) &&
                observed.status === 'running' &&
                observed.billingMode === 'wick_managed' &&
                !observed.providerKeyId,
              'CANARY_FINAL_NATIVE',
            );
            outcomes[p.provider].timing = canaryNativeTiming(observed, own.vm, p);
            outcomes[p.provider].nativeRunning = true;
            journal.append('canary-native-final', {
              provider: p.provider,
              vmId: own.vm.id,
              environmentId: own.vm.environmentId,
              ...outcomes[p.provider].timing,
            });
            const s = shells.find((s) => s.vmId === own.vm.id);
            assert(
              s && !s.canaryFailure && s.initialProofPassed && terminalHoldMs >= CANARY_HOLD_MS,
              'CANARY_TERMINAL_HOLD',
            );
            await fullProof([s], 'final');
            assert(s.resize.matched, 'CANARY_RESIZE');
            outcomes[p.provider].terminalPassed = true;
          } catch (error) {
            outcomes[p.provider].failure ||=
              error instanceof Error && /^[A-Z0-9_]+$/.test(error.message)
                ? error.message
                : 'CANARY_FINAL_FAILED';
          }
        });
      } finally {
        refreshing = false;
      }
      const invoices = (await list('/api/invoices')).filter((i) => observations.has(i.vmId));
      for (const p of settings.providers) {
        const own = [...observations.values()].find((d) => providerFor(d).provider === p.provider);
        if (!own) continue;
        try {
          const matched = invoices.filter((i) => i.vmId === own.vm.id);
          assert.equal(matched.length, 1, 'CANARY_INVOICE_COUNT');
          assert.equal(matched[0].totalCents, p.basePriceCents, 'CANARY_INVOICE_PRICE');
          assert.equal(matched[0].feeCents, 0, 'CANARY_BUYER_FEE');
          assert.deepEqual(
            matched[0].revenueShare,
            revenueShare(p.basePriceCents!),
            'CANARY_COMMISSION',
          );
          outcomes[p.provider].invoicePassed = true;
        } catch {
          outcomes[p.provider].failure ||= 'CANARY_INVOICE_FAILED';
        }
      }
      const valid = Object.values(outcomes).every(
        (o) => o.nativeRunning && o.terminalPassed && o.invoicePassed,
      );
      result = {
        computeValidationPassed: Object.values(outcomes).every((o) => o.nativeRunning),
        validationPassed: valid,
        providerResults: outcomes,
        peakRunning,
        terminalHoldMs,
        simultaneousTerminals: healthyShells().filter((s) => s.initialProofPassed).length,
        invoiceCount: invoices.length,
        invoiceQuoteAndCommissionMatches: Object.values(outcomes).every((o) => o.invoicePassed),
        renewalEvidence:
          'Broker sockets maintained for at least 130 seconds when terminalPassed; no explicit SDK renewal acknowledgment captured by this runner.',
      };
    } else {
      const canaries = await bounded(settings.providers, (p, index) => request(index + 1, p));
      await ready(canaries, settings.providers);
      if (collectBlaxel) {
        assert(
          ['e2b', 'daytona', 'modal'].every((provider) => terminalResults()[provider].proven === 1),
          'HEALTHY_CANARY_TERMINAL_REQUIRED',
        );
        journal.append('four-native-canaries-confirmed', {
          realVms: 4,
          terminalProofs: healthyShells().length,
          knownBlaxelTerminalFailures: shells.filter((s) => s.proofFailure).length,
        });
      } else journal.append('four-canaries-confirmed', { realVms: 4, terminalProofs: 4 });
      let next = 5;
      while (next <= 20) {
        check();
        await refreshDue();
        const state = await bounded(settings.providers, (p) =>
          api(p.cookie, '/api/provider/dashboard'),
        );
        const free = state.map((d) => d.capacity.available).filter((n) => n > 0);
        assert(free.length > 0, 'NO_CAPACITY_BEFORE_TARGET');
        const count = Math.min(4, 21 - next, ...free);
        const start = next;
        next += count;
        const wave = await bounded(
          Array.from({ length: count }, (_, i) => start + i),
          (item) => request(item),
        );
        await ready(wave);
        await refreshDue();
        journal.append('wave-confirmed', { requests: count, cumulativeRequests: intents().length });
      }
      const vms = await sample();
      assert.equal(vms.length, 20);
      assert(vms.every((v) => v.status === 'running'));
      assert.equal(observations.size, 20);
      assert.equal(new Set(vms.map((v) => v.environmentId)).size, 20);
      const requiredHealthy = diagnosticBlaxel
        ? shells.filter(
            (s) => providerFor(observations.get(s.vmId)!).provider !== 'provider-blaxel',
          )
        : undefined;
      if (requiredHealthy)
        assert(
          requiredHealthy.length === 15 &&
            ['e2b', 'daytona', 'modal'].every(
              (provider) => terminalResults()[provider].proven === 5,
            ),
          'REQUIRED_HEALTHY_TERMINALS',
        );
      const holdStart = Date.now();
      while (Date.now() - holdStart < 30_000) {
        check();
        await refreshDue();
        const healthy = requiredHealthy ?? healthyShells();
        assert(
          shells.length === 20 &&
            healthy.length >= (collectBlaxel ? 15 : 20) &&
            healthy.every(
              (s) => s.ws.readyState === WebSocket.OPEN && s.t0.matched && s.t1.matched,
            ),
          'SIMULTANEOUS_TERMINAL_COUNT',
        );
        if (requiredHealthy)
          assert(
            ['e2b', 'daytona', 'modal'].every(
              (provider) => terminalResults()[provider].proven === 5,
            ),
            'REQUIRED_HEALTHY_TERMINALS',
          );
        for (const s of healthy) s.ws.send(JSON.stringify({ type: 'ping' }));
        await sample();
        await delay(1000);
      }
      if (collectBlaxel) await collectionProof(requiredHealthy ?? healthyShells(), 'final');
      else await fullProof(shells, 'final');
      terminalHoldMs = Date.now() - holdStart;
      await bounded([...observations.values()], async (d) => {
        const p = providerFor(d),
          observed = await native.get(d.vm.environmentId);
        assert(
          ownership(observed, d.vm, p, h) &&
            observed.status === 'running' &&
            observed.billingMode === 'wick_managed' &&
            !observed.providerKeyId,
          'FINAL_NATIVE_CHECKPOINT',
        );
      });
      const invoices = (await list('/api/invoices')).filter((i) => observations.has(i.vmId));
      assert.equal(invoices.length, 20);
      assert.equal(new Set(invoices.map((i) => i.vmId)).size, 20);
      for (const invoice of invoices) {
        const d = observations.get(invoice.vmId)!;
        const bid = d.bids.find((b: Json) => b.id === d.request.winningBidId);
        assert.equal(invoice.totalCents, bid.totalPriceCents);
        assert.equal(invoice.feeCents, 0);
        assert.deepEqual(invoice.revenueShare, revenueShare(bid.totalPriceCents));
      }
      const distribution = Object.fromEntries(
        settings.providers.map((p) => [
          p.provider,
          [...observations.values()].filter((d) => providerFor(d).provider === p.provider).length,
        ]),
      );
      assert(
        Object.values(distribution).every((n) => n === 5),
        'PER_PROVIDER_SIMULTANEOUS_COUNT',
      );
      const proven = healthyShells();
      const terminalValidationPassed = !diagnosticBlaxel && proven.length === 20;
      if (diagnosticBlaxel) check();
      assert(
        ['e2b', 'daytona', 'modal'].every((provider) => terminalResults()[provider].proven === 5),
        'HEALTHY_PROVIDER_TERMINAL_COUNT',
      );
      result = {
        computeValidationPassed: true,
        validationPassed: terminalValidationPassed,
        ...(!terminalValidationPassed
          ? {
              validationFailure: diagnosticBlaxel
                ? 'ALL_PROVIDER_TERMINAL_OVERLAP_NOT_VALIDATED'
                : 'TERMINAL_PROOFS_INCOMPLETE',
            }
          : {}),
        peakRunning,
        simultaneousTerminals: proven.length,
        terminalHoldMs,
        shellStateAndCwdProofs: proven.length,
        resizeProofs: proven.filter((s) => s.resize.matched).length,
        resizeUnavailable: proven.filter((s) => s.noStty.matched).length,
        distribution,
        invoiceCount: 20,
        invoiceQuoteAndCommissionMatches: true,
        timings: {
          requestToReadyMs: percentiles(
            [...observations.values()].map(
              (d) => Date.parse(d.vm.readyAt) - Date.parse(d.request.createdAt),
            ),
          ),
        },
      };
    }
  } catch (error) {
    stop(
      error instanceof Error && /^[A-Z0-9_]+$/.test(error.message)
        ? error.message
        : 'LIVE_VALIDATION_FAILED',
    );
    result = {
      computeValidationPassed: false,
      validationPassed: false,
      failure,
      peakRunning,
      provenT0Terminals: shells.filter((s) => s.t0.matched).length,
      provenT1Terminals: shells.filter((s) => s.t1.matched).length,
    };
  } finally {
    const terminals = terminalResults();
    intentional = true;
    for (const s of shells) s.ws.close();
    clearInterval(timer);
    process.off('SIGTERM', signals);
    process.off('SIGINT', signals);
    journal.append('normal-cleanup-start', { validationPassed: result.validationPassed === true });
    const cleanupResult = await cleanup(h).catch(() => ({
      confirmed: false,
      unknown: intents().length,
      pending: intents().length,
      holdsReleased: false,
    }));
    result = {
      ...result,
      terminalPolicy: h.terminalPolicy ?? 'strict',
      terminalResults: terminals,
      knownBlaxelTerminalFailures: shells.filter((s) => s.proofFailure).length,
      successfulBlaxelDiagnostics: shells.filter((s) => s.diagnosticClosed).length,
      runId: h.runId,
      modes: observedModes,
      ...(canaryMode ? { mode: settings.mode } : {}),
      attemptedRequests: intents().length,
      cleanup: cleanupResult,
      finishedAt: new Date().toISOString(),
      passed: !failure && result.validationPassed === true && cleanupResult.confirmed,
    };
    atomic(paths.report, result);
    journal.append('runner-finished', {
      passed: result.passed,
      cleanupConfirmed: cleanupResult.confirmed,
    });
    if (cleanupResult.confirmed)
      journal.append('complete', { validationPassed: result.validationPassed === true });
    console.log(JSON.stringify(result));
    if (!result.passed) process.exitCode = 1;
  }
}
async function watchdog(h: Header) {
  exclusive(journalPath + '.watchdog-owner');
  journal.append('watchdog-start', { pid: process.pid });
  const waitingDeadline = Date.now() + 30 * 60_000;
  while (Date.now() < waitingDeadline) {
    atomic(paths.ready, { runId: h.runId, pid: process.pid, at: new Date().toISOString() });
    const records = journal.read();
    if (records.some((r) => r.kind === 'complete')) return;
    const start = records.find((r) => r.kind === 'runner-start'),
      beat = privateRead(paths.heartbeat);
    if (
      records.some((r) => r.kind === 'stop-requested') ||
      (start &&
        (Date.now() >= Number(start.deadline) ||
          (Date.now() - Date.parse(start.at) > 15_000 &&
            (!beat ||
              beat.runId !== h.runId ||
              Date.now() - Date.parse(beat.at) > 15_000 ||
              !alive(beat.pid)))))
    )
      break;
    await delay(1000);
  }
  journal.append('watchdog-triggered', { reason: 'runner-stale-stopped-or-deadline' });
  const cleaned = await cleanup(h);
  atomic(journalPath + '.watchdog-report.json', {
    ...cleaned,
    finishedAt: new Date().toISOString(),
  });
  if (!cleaned.confirmed) process.exitCode = 1;
}
async function main() {
  if (command === 'prepare') {
    assert(!existsSync(journalPath), 'Use a fresh journal for each bounded run.');
    exclusive(journalPath + '.prepare-owner');
    journal.append('prepared', {
      runId: randomUUID(),
      target: settings.target,
      ...(canaryMode ? { mode: settings.mode } : {}),
      maximumRunMs: 12 * 60_000,
      baseUrl: origin.origin,
      fingerprint,
      terminalPolicy: requestedPolicy ?? 'strict',
    });
    console.log(
      JSON.stringify({
        prepared: true,
        target: settings.target,
        ...(canaryMode ? { mode: settings.mode } : {}),
        allocated: 0,
        controlDirectory: CONTROL_DIRECTORY,
        terminalPolicy: requestedPolicy ?? 'strict',
      }),
    );
    return;
  }
  const h = header();
  if (command === 'run') return run(h);
  if (command === 'watchdog') return watchdog(h);
  const start = runStart(),
    beat = privateRead(paths.heartbeat);
  assert(
    !start || !beat || !alive(beat.pid) || Date.now() - Date.parse(beat.at) > 15_000,
    'Stop the live runner before manual cleanup.',
  );
  const result = await cleanup(h);
  console.log(JSON.stringify(result));
  if (!result.confirmed) process.exitCode = 1;
}
main().catch(() => {
  console.error('Hosted scale command failed; retain private journal and run cleanup.');
  process.exitCode = 1;
});
