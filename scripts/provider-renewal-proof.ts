/** Optional direct-SDK observer for already-owned canary VMs. Never creates or deletes VMs. */
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { constants, closeSync, fstatSync, openSync, readFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import WebSocket from 'ws';
import { Wick } from '@wick-cloud/sdk';
import { Journal } from './live-scale/safety.js';
import { TerminalMarkerProof } from './live-scale/terminal-proof.js';
import {
  CANARY_HOLD_MS,
  CANARY_QUOTE_CEILING_CENTS,
  validateCanaryRoutes,
  type CanaryMode,
  type CanaryRoute,
} from './live-scale/provider-canary.js';

type Json = Record<string, any>;
interface Settings {
  baseUrl: string;
  mode: CanaryMode;
  target: number;
  providers: (CanaryRoute & { rateMicrosPerSecond: number; basePriceCents?: number })[];
  wick: { baseUrl: string; token: string; organizationId: string; groupId: string };
}
const LIMIT_MS = 160_000;
const STOP_KINDS = ['stop-requested', 'normal-cleanup-start', 'watchdog-triggered', 'complete'];
const MAX_RESPONSE_BYTES = 1024 * 1024;

/** The SDK transport cannot escape the one-owned-VM observation/session surface. */
export function renewalRequestAllowed(base: URL, environmentId: string, url: URL, method: string) {
  const path = `${base.pathname.replace(/\/$/, '')}/v1/environments/${encodeURIComponent(environmentId)}`;
  return (
    url.origin === base.origin &&
    !url.username &&
    !url.password &&
    !url.search &&
    !url.hash &&
    ((method === 'GET' && url.pathname === path) ||
      (method === 'POST' && url.pathname === `${path}/sessions`))
  );
}

export function renewalOwnershipMatches(
  environment: Json,
  receipt: Json,
  settings: Settings,
  start: Json,
  now = Date.now(),
) {
  const created = Date.parse(environment.createdAt ?? '');
  const brokerCreated = Date.parse(receipt.createdAt ?? '');
  const started = Date.parse(start.at ?? '');
  return (
    environment.id === receipt.environmentId &&
    environment.name === `wick-broker-${String(receipt.vmId).slice(0, 8)}` &&
    environment.organizationId === settings.wick.organizationId &&
    environment.groupId === settings.wick.groupId &&
    environment.provider === receipt.provider &&
    environment.profile === receipt.profile &&
    (environment.region === undefined ||
      (receipt.region === 'auto'
        ? typeof environment.region === 'string' && environment.region.trim().length > 0
        : environment.region === receipt.region)) &&
    environment.billingMode === 'wick_managed' &&
    environment.providerKeyId == null &&
    Number.isFinite(started) &&
    Number.isFinite(brokerCreated) &&
    Number.isFinite(created) &&
    brokerCreated >= started - 5000 &&
    brokerCreated <= Number(start.deadline) &&
    created >= started - 5000 &&
    created >= brokerCreated - 5000 &&
    created <= now + 5000 &&
    created <= Number(start.deadline)
  );
}

function safeBase(value: string) {
  const url = new URL(value);
  assert(
    url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash,
    'INVALID_HTTPS_BASE',
  );
  return url;
}
function markerCommand(marker: string) {
  // The echoed command contains octal escapes, never the plain proof marker.
  return `printf '\\n${[...marker].map((char) => '\\' + char.charCodeAt(0).toString(8).padStart(3, '0')).join('')}\\n'`;
}
async function observe(settings: Settings, journal: Journal, receipt: Json, start: Json) {
  const result = {
    path: 'direct-sdk-scoped-renewal',
    vmId: String(receipt.vmId),
    provider: String(receipt.provider),
    ready: false,
    initialPty: false,
    renewed: false,
    postRenewalPty: false,
    sessionRequests: 0,
    passed: false,
    terminalClosed: false,
    outcome: 'unconfirmed',
  };
  const remaining = Math.min(LIMIT_MS, Number(start.deadline) - Date.now() - 2000);
  if (remaining < 125_000) return { ...result, outcome: 'insufficient-run-time' };
  const controller = new AbortController();
  const sockets: WebSocket[] = [];
  const timer = setTimeout(() => controller.abort(), remaining);
  const stopTimer = setInterval(() => {
    try {
      if (journal.read().some((r) => STOP_KINDS.includes(r.kind))) controller.abort();
    } catch {
      controller.abort();
    }
  }, 1000);
  let terminal: Awaited<ReturnType<Wick['environments']['terminal']>> | undefined;
  let phase = 'ownership';
  try {
    const base = safeBase(settings.wick.baseUrl);
    const sdk = new Wick({
      baseUrl: base.toString().replace(/\/$/, ''),
      token: settings.wick.token,
      statusRetry: false,
      timeoutMs: 12000,
      fetch: async (input, init) => {
        const request = input instanceof Request ? input : undefined;
        const url = new URL(request?.url ?? String(input));
        const method = init?.method ?? request?.method ?? 'GET';
        assert(renewalRequestAllowed(base, receipt.environmentId, url, method), 'REQUEST_SCOPE');
        const response = await fetch(input, {
          ...init,
          redirect: 'error',
          signal: AbortSignal.any([
            controller.signal,
            ...(init?.signal ? [init.signal] : request?.signal ? [request.signal] : []),
          ]),
        });
        assert(response.ok, 'SCOPED_REQUEST_FAILED');
        const reader = response.body?.getReader();
        assert(reader, 'MISSING_RESPONSE_BODY');
        const chunks: Uint8Array[] = [];
        let size = 0;
        try {
          while (true) {
            const part = await reader.read();
            if (part.done) break;
            size += part.value.byteLength;
            if (size > MAX_RESPONSE_BYTES) {
              await reader.cancel();
              throw new Error('RESPONSE_BOUND');
            }
            chunks.push(part.value);
          }
        } finally {
          reader.releaseLock();
        }
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (method === 'POST') {
          assert(
            body.session?.environmentId === receipt.environmentId &&
              typeof body.token === 'string' &&
              body.token !== settings.wick.token,
            'SESSION_SCOPE',
          );
          assert(Date.parse(body.session.expiresAt) > Date.now() + 5000, 'SESSION_EXPIRY');
          safeBase(body.terminalWebsocketUrl.replace(/^wss:/, 'https:'));
          assert(body.terminalWebsocketUrl.startsWith('wss:'), 'SESSION_WEBSOCKET');
          result.sessionRequests++;
        }
        return new Response(JSON.stringify(body), {
          status: response.status,
          headers: { 'Content-Type': 'application/json' },
        });
      },
      webSocket: (endpoint) => {
        const url = new URL(endpoint);
        assert(
          url.protocol === 'wss:' && !url.username && !url.password && !url.search && !url.hash,
          'WEBSOCKET_SCOPE',
        );
        const socket = new WebSocket(endpoint, {
          maxPayload: 256 * 1024,
          perMessageDeflate: false,
          followRedirects: false,
          handshakeTimeout: 12000,
        });
        socket.on('error', () => undefined);
        sockets.push(socket);
        return socket as unknown as globalThis.WebSocket;
      },
    });
    const environment = await sdk.environments.get({
      path: { id: receipt.environmentId },
      signal: controller.signal,
    });
    assert(renewalOwnershipMatches(environment, receipt, settings, start), 'OWNERSHIP_MISMATCH');
    if (environment.status !== 'running') {
      result.outcome = `skipped-${['provisioning', 'terminating', 'terminated', 'failed'].includes(environment.status) ? environment.status : 'not-running'}`;
      return result;
    }
    assert(Date.parse(environment.expiresAt ?? '') > Date.now() + 125000, 'RENTAL_EXPIRING');
    phase = 'terminal';
    terminal = await sdk.environments.terminal(receipt.environmentId, {
      signal: controller.signal,
      timeoutMs: 12000,
      cols: 113,
      rows: 37,
    });
    const state = randomBytes(16).toString('hex');
    // Retain only bounded marker readers and aggregate booleans, never a terminal transcript.
    const initialMarker = `RENEW_INITIAL_${randomBytes(16).toString('hex')}`;
    const initialProof = new TerminalMarkerProof(initialMarker);
    let postProof: TerminalMarkerProof | undefined;
    for await (const event of terminal) {
      if (event.type === 'ready') {
        assert(!result.ready && event.environmentId === receipt.environmentId, 'READY_SCOPE');
        result.ready = true;
        terminal.input(
          `BROKER_RENEW_STATE=${state}; test -t 0 && test -t 1 && ${markerCommand(initialMarker)}\r`,
        );
      } else if (event.type === 'output') {
        terminal.ack(event.data.byteLength);
        if (!result.initialPty) result.initialPty = initialProof.push(event.data);
        if (postProof && postProof.push(event.data)) {
          result.postRenewalPty = true;
          result.passed = result.initialPty && result.renewed;
          result.outcome = result.passed ? 'passed' : 'initial-proof-missing';
          break;
        }
      } else if (event.type === 'renewed') {
        assert(
          result.ready &&
            result.sessionRequests >= 2 &&
            Number.isFinite(Date.parse(event.expiresAt)) &&
            Date.parse(event.expiresAt) > Date.now(),
          'RENEWAL_RECEIPT',
        );
        assert(result.initialPty, 'INITIAL_PTY_REQUIRED');
        result.renewed = true;
        phase = 'post-renewal';
        const marker = `RENEW_FRESH_${randomBytes(16).toString('hex')}`;
        postProof = new TerminalMarkerProof(marker);
        terminal.input(
          `test "$BROKER_RENEW_STATE" = '${state}' && test -t 0 && test -t 1 && ${markerCommand(marker)}\r`,
        );
      } else if (event.type === 'exit') {
        result.outcome = 'shell-exited';
        break;
      } else assert(event.type === 'pong', 'UNEXPECTED_TERMINAL_EVENT');
    }
    if (!result.passed && result.outcome === 'unconfirmed')
      result.outcome = 'terminal-ended-before-proof';
  } catch {
    result.outcome = controller.signal.aborted ? 'cancelled-or-timeout' : `${phase}-unconfirmed`;
  } finally {
    clearTimeout(timer);
    clearInterval(stopTimer);
    terminal?.close();
    controller.abort();
    for (const socket of sockets) {
      if (socket.readyState !== WebSocket.CLOSED) {
        await new Promise<void>((resolve) => {
          const force = setTimeout(() => {
            socket.terminate();
            resolve();
          }, 1500);
          socket.once('close', () => {
            clearTimeout(force);
            resolve();
          });
          socket.close();
        });
      }
    }
    result.terminalClosed = sockets.every((socket) => socket.readyState === WebSocket.CLOSED);
  }
  return result;
}

export async function runRenewalObservers(settings: Settings, journal: Journal, vmId?: string) {
  assert(
    settings.mode === 'provider-canary' ||
      settings.mode === 'provider-size-canary' ||
      settings.mode === 'provider-size-retry-canary',
    'CANARY_SETTINGS_REQUIRED',
  );
  validateCanaryRoutes(settings.target, settings.providers, settings.mode);
  const records = journal.read(),
    header = records[0],
    start = records.find((r) => r.kind === 'runner-start');
  const origin = safeBase(settings.baseUrl);
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
      }),
    )
    .digest('hex');
  assert(
    header?.kind === 'prepared' &&
      header.mode === settings.mode &&
      header.target === settings.target &&
      header.maximumRunMs === 720000 &&
      header.baseUrl === origin.origin &&
      header.fingerprint === fingerprint &&
      start,
    'JOURNAL_SCOPE',
  );
  assert(!records.some((r) => STOP_KINDS.includes(r.kind)), 'RUN_ALREADY_STOPPED');
  const receipts = [
    ...new Map(
      records.filter((r) => r.kind === 'vm-receipt').map((r) => [String(r.vmId), r]),
    ).values(),
  ];
  assert(
    receipts.length > 0 &&
      receipts.length <= settings.target &&
      new Set(receipts.map((r) => r.environmentId)).size === receipts.length,
    'RECEIPT_BOUND',
  );
  const chosen = vmId ? receipts.filter((r) => r.vmId === vmId) : receipts;
  assert(chosen.length > 0, 'OWNED_RECEIPT_REQUIRED');
  for (const receipt of chosen) {
    assert(
      /^[0-9a-f-]{36}$/i.test(String(receipt.vmId)) &&
        typeof receipt.environmentId === 'string' &&
        receipt.environmentId.length <= 256,
      'RECEIPT_ID',
    );
    const route = settings.providers.find((p) => p.provider === receipt.provider);
    const request = records.find(
      (r) => r.kind === 'request-result' && r.requestId === receipt.requestId,
    );
    const intent = records.find((r) => r.kind === 'request-intent' && r.item === request?.item);
    assert(
      route &&
        receipt.profile === route.profile &&
        receipt.region === route.region &&
        request &&
        intent &&
        (intent.body as Json)?.description ===
          `Broker hosted scale ${header.runId} item ${request.item}` &&
        (intent.body as Json)?.catalogId === route.catalogId &&
        (intent.body as Json)?.durationMinutes === 15,
      'RECEIPT_ROUTE',
    );
    assert(
      !records.some((r) => r.kind === 'sdk-renewal-start' && r.vmId === receipt.vmId),
      'OBSERVER_ALREADY_ATTEMPTED',
    );
    journal.append('sdk-renewal-start', {
      vmId: receipt.vmId,
      provider: receipt.provider,
      path: 'direct-sdk',
      maximumMs: LIMIT_MS,
    });
  }
  return Promise.all(
    chosen.map(async (receipt) => {
      const result = await observe(settings, journal, receipt, start!);
      journal.append('sdk-renewal-result', result);
      return result;
    }),
  );
}

async function main() {
  const value = (name: string) => {
    const at = process.argv.indexOf(`--${name}`);
    return at < 0 ? undefined : process.argv[at + 1];
  };
  const settingsPath = value('settings'),
    journalPath = value('journal');
  assert(
    settingsPath && isAbsolute(settingsPath) && journalPath && isAbsolute(journalPath),
    'PRIVATE_ABSOLUTE_PATHS_REQUIRED',
  );
  const fd = openSync(settingsPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  let settings: Settings;
  try {
    const stats = fstatSync(fd);
    assert(
      stats.isFile() && (stats.mode & 0o077) === 0 && stats.size <= 1024 * 1024,
      'PRIVATE_SETTINGS_REQUIRED',
    );
    settings = JSON.parse(readFileSync(fd, 'utf8'));
  } finally {
    closeSync(fd);
  }
  console.log(
    JSON.stringify({
      path: 'direct-sdk-scoped-renewal',
      results: await runRenewalObservers(settings, new Journal(journalPath), value('vm')),
    }),
  );
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  void main().catch(() => {
    console.error(
      'Scoped renewal observer refused or failed; no native VM mutations were performed.',
    );
    process.exitCode = 1;
  });
