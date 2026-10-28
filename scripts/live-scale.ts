/**
 * Explicitly authorized TEST-only live runner. Importing helpers or running offline tests never allocates.
 * Commands: prepare, run, watchdog, cleanup. See docs/live-scale.md before a paid invocation.
 */
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Pool } from 'pg';
import { hashPassword } from 'better-auth/crypto';
import WebSocket from 'ws';
import { buildApp } from '../src/server/app.js';
import { loadConfig } from '../src/server/config.js';
import { migrate } from '../src/server/db.js';
import { createWickAdapter } from '../src/server/integrations/wick.js';
import type { WickAdapter } from '../src/server/integrations/types.js';
import {
  CONTROL_DIRECTORY,
  Journal,
  cleanupJournal,
  closeAdmission,
  createScaleGuard,
  percentiles,
  type Header,
} from './live-scale/safety.js';
import { TerminalMarkerProof } from './live-scale/terminal-proof.js';

async function main() {
  type Json = Record<string, any>;
  const command = process.argv[2];
  assert(
    ['prepare', 'run', 'watchdog', 'cleanup'].includes(command),
    'Use prepare, run, watchdog, or cleanup.',
  );
  assert.equal(process.env.WICK_MODE, 'real', 'Explicit WICK_MODE=real is required.');
  assert.equal(process.env.MUSE_MODE, 'fixture', 'Scale testing never invokes real Meta.');
  const required = (key: string) => {
    const value = process.env[key];
    assert(value, `Supply ${key}.`);
    return value;
  };
  const appUrl = new URL(required('SCALE_APP_URL'));
  assert(
    appUrl.protocol === 'http:' &&
      ['localhost', '127.0.0.1'].includes(appUrl.hostname) &&
      !appUrl.username &&
      !appUrl.password &&
      appUrl.pathname === '/' &&
      !appUrl.search &&
      !appUrl.hash,
  );
  assert(
    appUrl.port && Number(appUrl.port) !== 3000,
    'Scale runner must never use preview port 3000.',
  );
  const journalPath = resolve(required('SCALE_JOURNAL'));
  const journal = new Journal(journalPath);
  const readyPath = `${journalPath}.watchdog-ready`;
  const heartbeatPath = `${journalPath}.heartbeat`;
  const reportPath = `${journalPath}.report.json`;
  function atomicPrivate(path: string, data: unknown) {
    const temporary = `${path}.${process.pid}.tmp`;
    writeFileSync(temporary, JSON.stringify(data), { mode: 0o600 });
    renameSync(temporary, path);
  }
  function readPrivate(path: string): Json | undefined {
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
  const approval = {
    organizationId: required('WICK_ORGANIZATION_ID'),
    groupId: required('WICK_GROUP_ID'),
    provider: process.env.SCALE_APPROVED_PROVIDER ?? 'e2b',
    profile: process.env.SCALE_APPROVED_PROFILE ?? 'micro',
    region: process.env.SCALE_APPROVED_REGION ?? 'us',
    catalogId: process.env.SCALE_APPROVED_CATALOG_ID ?? 'e2b:micro:us',
  };

  if (command === 'prepare' || command === 'run')
    assert.notEqual(
      approval.provider,
      'boat',
      'Boat customer allocations are excluded from this integration.',
    );

  if (command === 'prepare') {
    assert(!existsSync(journalPath), 'Use a new journal path for every run.');
    const runId = randomUUID();
    journal.append('prepared', {
      runId,
      appUrl: appUrl.origin,
      approval,
      maximumRunMs: 10 * 60_000,
    });
    console.log(
      'Private run journal prepared. Start the separate watchdog before the runner. No VM was allocated.',
    );
  } else {
    const header = journal.header();
    assert.equal(header.appUrl, appUrl.origin);
    assert.deepEqual(
      header.approval,
      approval,
      'Environment does not match the reviewed run approval.',
    );
    const nativeConfig = {
      wickMode: 'real' as const,
      wickApiBase: process.env.WICK_API_BASE ?? 'https://app.wick-cloud.com/api',
      wickApiKey: required('WICK_API_KEY'),
      wickOrganizationId: approval.organizationId,
      wickGroupId: approval.groupId,
    };
    if (command === 'watchdog' || command === 'cleanup') {
      const wick = createWickAdapter(nativeConfig);
      if (command === 'watchdog') await watchdog(header, wick);
      else {
        assert(
          !alive(Number(readPrivate(heartbeatPath)?.pid)) ||
            Date.now() - Date.parse(String(readPrivate(heartbeatPath)?.at)) > 15_000,
          'Stop the runner or let its heartbeat expire before independent cleanup.',
        );
        await closeAdmission(journal, 'stop-requested', { reason: 'operator-cleanup' });
        const unresolved = await cleanupJournal(journal, wick, 180_000);
        console.log(
          JSON.stringify({
            upstreamCleanup: unresolved.length ? 'unresolved' : 'confirmed',
            brokerHoldRelease: 'unverified',
            unresolvedCount: unresolved.length,
          }),
        );
        if (unresolved.length) process.exitCode = 1;
      }
    } else {
      assert.equal(
        process.env.SCALE_LIVE_APPROVED,
        '20-real-vms-15-minutes',
        'Parent approval is required before paid live execution.',
      );
      await run(header);
    }
  }

  async function watchdog(header: Header, wick: WickAdapter) {
    assert(
      !journal.read().some((r) => r.kind === 'watchdog-start'),
      'One watchdog owns this journal; use cleanup mode for manual recovery.',
    );
    journal.append('watchdog-start', { pid: process.pid });
    let triggered = false;
    const waitingDeadline = Date.now() + 30 * 60_000;
    while (Date.now() < waitingDeadline) {
      atomicPrivate(readyPath, {
        runId: header.runId,
        pid: process.pid,
        at: new Date().toISOString(),
      });
      const records = journal.read();
      if (records.some((r) => r.kind === 'complete')) {
        console.log('Runner completed and confirmed cleanup; watchdog exited.');
        return;
      }
      const start = records.find((r) => r.kind === 'runner-start');
      const heartbeat = readPrivate(heartbeatPath);
      const stale =
        start &&
        Date.now() - Date.parse(start.at) > 15_000 &&
        (!heartbeat ||
          heartbeat.runId !== header.runId ||
          Date.now() - Date.parse(heartbeat.at) > 15_000 ||
          !alive(heartbeat.pid));
      const expired = start && Date.now() > Number(start.deadline);
      if (stale || expired || records.some((r) => r.kind === 'stop-requested')) {
        triggered = true;
        break;
      }
      await delay(1000);
    }
    await closeAdmission(journal, 'watchdog-triggered', {
      triggered,
      reason: 'runner-stopped-stale-or-deadline',
    });
    // Cleanup only discovers exact run-owned environments and terminates them; it never creates.
    const unresolved = await cleanupJournal(journal, wick, 180_000);
    console.log(
      JSON.stringify({
        upstreamCleanup: unresolved.length ? 'unresolved' : 'confirmed',
        brokerHoldRelease: 'unverified',
        unresolvedCount: unresolved.length,
      }),
    );
    if (unresolved.length) process.exitCode = 1;
  }

  async function run(header: Header) {
    assert(
      !journal.read().some((r) => r.kind === 'runner-start'),
      'A run cannot be restarted; use cleanup for recovery.',
    );
    const watchdogReady = () => {
      const ready = readPrivate(readyPath);
      return Boolean(
        ready &&
        ready.runId === header.runId &&
        Date.now() - Date.parse(ready.at) < 5000 &&
        alive(ready.pid) &&
        !journal.read().some((r) => ['watchdog-triggered', 'stop-requested'].includes(r.kind)),
      );
    };
    assert(watchdogReady(), 'Detached cleanup watchdog must be ready before any runner mutation.');
    const testDatabase = new URL(required('TEST_DATABASE_URL'));
    const databaseName = decodeURIComponent(testDatabase.pathname.slice(1));
    assert(
      databaseName === required('SCALE_ISOLATED_DATABASE_NAME') &&
        /(?:^|_)scale_[a-z0-9_]+$/i.test(databaseName),
      'Use an explicitly named isolated *_scale_* test database.',
    );
    assert(
      ['localhost', '127.0.0.1', '[::1]'].includes(testDatabase.hostname),
      'Live runner test database must be local.',
    );
    if (process.env.DATABASE_URL) {
      const preview = new URL(process.env.DATABASE_URL);
      assert(
        testDatabase.hostname !== preview.hostname ||
          databaseName !== decodeURIComponent(preview.pathname.slice(1)),
        'TEST_DATABASE_URL must not share the preview database.',
      );
    }
    let occupied = false;
    try {
      await fetch(new URL('/health', appUrl), { signal: AbortSignal.timeout(1000) });
      occupied = true;
    } catch {
      /* No process at the test origin. */
    }
    assert(
      !occupied,
      'Exactly one test Broker process is allowed; test origin is already occupied.',
    );
    const runnerApplicationName = `broker-scale-${header.runId}`;
    const pool = new Pool({
      connectionString: testDatabase.toString(),
      application_name: runnerApplicationName,
      max: 3,
      connectionTimeoutMillis: 5000,
      statement_timeout: 10000,
    });
    const lock = await pool.connect();
    const lockResult = await lock.query(
      "SELECT pg_try_advisory_lock(hashtext('broker-live-scale-single-app')) AS acquired",
    );
    assert(lockResult.rows[0].acquired, 'Another scale runner owns this test database.');
    const deadline = Date.now() + header.maximumRunMs;
    journal.append('runner-start', { pid: process.pid, deadline });
    const heartbeat = () =>
      atomicPrivate(heartbeatPath, {
        runId: header.runId,
        pid: process.pid,
        at: new Date().toISOString(),
      });
    heartbeat();
    const heartbeats = setInterval(heartbeat, 2000);
    let instance: Awaited<ReturnType<typeof buildApp>> | undefined;
    let guard: ReturnType<typeof createScaleGuard> | undefined;
    let original: WickAdapter | undefined;
    let approvedRate: string | number | undefined;
    let failed = false;
    let buyerId = '';
    let providerId = '';
    let quoteCents = 0;
    let peakRunning = 0;
    let peakConnections = 0;
    let terminalConnections = 0;
    let providerProbe = false;
    let globalProbe = false;
    let terminalHoldMs = 0;
    let upstreamConfirmed = false;
    let holdsReleased = false;
    const cookies = new Map<string, string>();
    const terminals: WebSocket[] = [];
    let intentionalTerminalCleanup = false;
    const requests: Json[] = [];
    const observedRunning = new Set<string>();
    const stop = () => {
      failed = true;
      guard?.stop();
    };
    const interrupt = () => {
      stop();
      journal.append('stop-requested', { reason: 'process-signal' });
    };
    process.on('SIGTERM', interrupt);
    process.on('SIGINT', interrupt);
    function requireRunning() {
      if (failed || guard?.stopped || Date.now() >= deadline || !watchdogReady()) {
        stop();
        throw new Error('Run stopped or admission deadline/barrier closed.');
      }
    }
    async function api(
      role: string,
      path: string,
      method = 'GET',
      body?: unknown,
      expected = 200,
    ): Promise<Json> {
      if (method !== 'GET')
        journal.append('http-intent', {
          role,
          method,
          path,
          ...(body === undefined ? {} : { body }),
        });
      const response = await fetch(new URL(path, appUrl), {
        method,
        redirect: 'error',
        signal: AbortSignal.timeout(12_000),
        headers: {
          Cookie: cookies.get(role) ?? '',
          Origin: appUrl.origin,
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const text = await response.text();
      assert(text.length <= 1024 * 1024, 'Broker response exceeded bound.');
      assert.equal(
        response.status,
        expected,
        `Broker ${method} ${path.split('?')[0]} returned unexpected HTTP status.`,
      );
      return JSON.parse(text);
    }
    async function list(role: string, path: string): Promise<Json[]> {
      const result: Json[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < 5; page++) {
        const response = await api(
          role,
          `${path}?limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
        );
        result.push(...response.items);
        if (!response.nextCursor) return result;
        cursor = response.nextCursor;
      }
      throw new Error('Broker listing exceeded the reconciliation bound.');
    }
    async function until<T>(
      operation: () => Promise<T | undefined>,
      timeoutMs = 120_000,
      enforceRun = true,
    ): Promise<T> {
      const end = Date.now() + timeoutMs;
      while (Date.now() < end) {
        if (enforceRun) requireRunning();
        const result = await operation();
        if (result !== undefined) return result;
        await delay(500);
      }
      stop();
      throw new Error('Bounded operation timed out.');
    }
    async function createRequest(item: number) {
      requireRunning();
      const description = `Broker live scale ${header.runId} item ${item}`;
      const body = {
        description,
        catalogId: approval.catalogId,
        region: approval.region,
        durationMinutes: 15,
        maxPriceCents: quoteCents,
        requirements: { cpu: 1, memoryGb: 1 },
      };
      journal.append('request-intent', { item, body });
      let request: Json;
      try {
        request = await api('buyer', '/api/requests', 'POST', body);
      } catch {
        // POST /requests has no idempotency key. NEVER retry it: reconcile the unique description.
        const matches = (await list('buyer', '/api/requests')).filter(
          (r) => r.description === description,
        );
        assert(matches.length === 1, 'Request outcome is uncertain; no POST retry is allowed.');
        request = matches[0];
      }
      assert(
        Date.parse(request.closesAt) - Date.parse(request.createdAt) === 30_000,
        'The fixed auction deadline must remain 30 seconds.',
      );
      journal.append('request-result', {
        item,
        requestId: request.id,
        createdAt: request.createdAt,
        closesAt: request.closesAt,
      });
      requests.push({ ...request, runItem: item });
      return request;
    }
    async function bid(request: Json, expected = 200) {
      return api(
        'provider',
        `/api/provider/requests/${request.id}/bids`,
        'POST',
        { totalPriceCents: quoteCents },
        expected,
      );
    }
    async function runningSample() {
      const vms = await list('buyer', '/api/vms');
      const running = vms.filter((vm) => vm.status === 'running');
      peakRunning = Math.max(peakRunning, running.length);
      for (const vm of running) observedRunning.add(vm.id);
      const bad = vms.some((vm) =>
        ['failed', 'terminated', 'expired', 'terminating'].includes(vm.status),
      );
      assert(!bad, 'A rental failed or ended before the simultaneous-running checkpoint.');
      return vms;
    }
    function openTerminal(vm: Json, index: number) {
      const marker = `BROKER_SCALE_${header.runId.replaceAll('-', '')}_${index}`;
      const url = new URL(`/api/vms/${vm.id}/terminal`, appUrl);
      url.protocol = 'ws:';
      journal.append('terminal-open-intent', { vmId: vm.id, item: index });
      const ws = new WebSocket(url, {
        headers: { Cookie: cookies.get('buyer')!, Origin: appUrl.origin },
        handshakeTimeout: 12_000,
        maxPayload: 300_000,
      });
      terminals.push(ws);
      let ready = false,
        output = false,
        pong = false,
        completed = false,
        intentionalClose = false,
        lastPongAt = 0;
      const markerProof = new TerminalMarkerProof(marker);
      let rejectReady!: (error: Error) => void;
      const proof = new Promise<void>((resolve, reject) => {
        rejectReady = reject;
        const timer = setTimeout(() => reject(new Error('Terminal proof timed out.')), 30_000);
        ws.on('message', (raw) => {
          if (intentionalClose || intentionalTerminalCleanup) return;
          try {
            const frame = JSON.parse(raw.toString());
            if (frame.type === 'ready') {
              assert.equal(frame.mode, 'real');
              if (!ready) {
                ready = true;
                terminalConnections++;
                peakConnections = Math.max(peakConnections, terminalConnections);
                // Authorized bounded diagnostic, only in this isolated test run. No transcript is retained.
                journal.append('terminal-diagnostic-intent', {
                  vmId: vm.id,
                  classification: 'bounded-unique-marker-print',
                });
                ws.send(JSON.stringify({ type: 'input', data: `printf '%s\\n' '${marker}'\r` }));
                ws.send(JSON.stringify({ type: 'ping' }));
              }
            } else if (frame.type === 'output') {
              assert.equal(typeof frame.data, 'string');
              const bytes = Buffer.from(frame.data, 'base64');
              // ANSI controls can span frames; only an exact decoded complete line proves output.
              if (markerProof.push(bytes)) output = true;
              ws.send(JSON.stringify({ type: 'ack', bytes: bytes.length }));
            } else if (frame.type === 'pong') {
              pong = true;
              lastPongAt = Date.now();
            } else if (frame.type === 'error' || frame.type === 'exit')
              throw new Error('Terminal ended before the diagnostic completed.');
            if (ready && output && pong && !completed) {
              completed = true;
              clearTimeout(timer);
              resolve();
            }
          } catch {
            stop();
            clearTimeout(timer);
            reject(new Error('Terminal proof failed.'));
          }
        });
        ws.on('error', () => {
          if (!intentionalClose && !intentionalTerminalCleanup) stop();
          clearTimeout(timer);
          reject(new Error('Broker terminal transport failed.'));
        });
        ws.on('close', () => {
          if (ready) terminalConnections--;
          if (!intentionalClose && !intentionalTerminalCleanup) stop();
          if (!completed) {
            clearTimeout(timer);
            reject(new Error('Terminal closed before proof.'));
          }
        });
      });
      // Ensure early failures remain handled while other sockets are being constructed.
      void proof.catch(() => undefined);
      return {
        ws,
        proof,
        get lastPongAt() {
          return lastPongAt;
        },
        close() {
          intentionalClose = true;
          ws.close();
        },
        cancel: () => rejectReady(new Error('Terminal cancelled.')),
      };
    }
    try {
      journal.append('database-bootstrap-intent', { isolated: true, freshOnly: true });
      // Refuse all existing users/data; never reseed, clear sessions, or share the preview DB.
      const exists = await pool.query(
        "SELECT to_regclass('public.broker_requests') AS requests,to_regclass('public.user') AS users",
      );
      if (exists.rows[0].requests)
        assert.equal(
          Number((await pool.query('SELECT count(*) AS n FROM broker_requests')).rows[0].n),
          0,
        );
      if (exists.rows[0].users)
        assert.equal(Number((await pool.query('SELECT count(*) AS n FROM "user"')).rows[0].n), 0);
      const peers = await pool.query(
        "SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() AND backend_type='client backend' AND application_name<>$1",
        [runnerApplicationName],
      );
      assert(
        Number(peers.rows[0].n) === 0,
        'Unexpected application connection to the isolated test database.',
      );
      await migrate(pool);
      const passwords = new Map<string, string>();
      const emails = new Map<string, string>();
      for (const role of ['buyer', 'provider', 'admin']) {
        const id = randomUUID(),
          email = `${role}.${header.runId}@broker-scale.invalid`,
          password = randomBytes(24).toString('base64url');
        const hash = await hashPassword(password);
        journal.append('identity-bootstrap-intent', { role, id });
        await pool.query(
          'INSERT INTO "user"(id,email,name,role,"emailVerified") VALUES($1,$2,$3,$4,true)',
          [id, email, `Scale ${role} ${header.runId}`, role],
        );
        await pool.query(
          'INSERT INTO account(id,"accountId","providerId","userId",password) VALUES($1,$2,\'credential\',$2,$3)',
          [randomUUID(), id, hash],
        );
        if (role === 'buyer') buyerId = id;
        if (role === 'provider') {
          const row = await pool.query(
            'INSERT INTO broker_providers(user_id,name,total_capacity,policy) VALUES($1,$2,0,$3) RETURNING id',
            [
              id,
              `Demo Wick allocation ${header.runId}`,
              { autoBid: false, minimumPriceCents: 1, basePriceCents: 1 },
            ],
          );
          providerId = row.rows[0].id;
          await pool.query('UPDATE "user" SET "providerId"=$2 WHERE id=$1', [id, providerId]);
        }
        passwords.set(role, password);
        emails.set(role, email);
      }
      const config = loadConfig({
        ...process.env,
        DATABASE_URL: testDatabase.toString(),
        NODE_ENV: 'test',
        APP_URL: appUrl.origin,
        PORT: appUrl.port,
        HOST: '127.0.0.1',
        WICK_MODE: 'real',
        MUSE_MODE: 'fixture',
        LOG_LEVEL: 'silent',
        MAX_CONCURRENT_VMS: '20',
      });
      instance = await buildApp(
        { ...config, environmentNamePrefix: `broker-scale-${header.runId}` },
        {
          clientRoot: '.verify-dist/client',
          wrapWick(adapter) {
            original = adapter;
            guard = createScaleGuard({
              adapter,
              journal,
              header,
              deadline,
              watchdogReady,
              approvedRate: () => approvedRate,
              onFailure: stop,
              async owns(key) {
                const rows = await pool.query(
                  'SELECT v.id,v.request_id FROM broker_vms v JOIN broker_requests r ON r.id=v.request_id WHERE v.create_key=$1 AND v.buyer_id=$2 AND r.description LIKE $3',
                  [key, buyerId, `Broker live scale ${header.runId} item %`],
                );
                assert.equal(rows.rowCount, 1, 'Create key is outside this test run.');
                return { vmId: rows.rows[0].id, requestId: rows.rows[0].request_id };
              },
            });
            return guard.adapter;
          },
        },
      );
      await instance.app.listen({ port: Number(appUrl.port), host: '127.0.0.1' });
      for (const role of ['buyer', 'provider', 'admin']) {
        journal.append('sign-in-intent', { role });
        const response = await fetch(new URL('/api/auth/sign-in/email', appUrl), {
          method: 'POST',
          redirect: 'error',
          signal: AbortSignal.timeout(12_000),
          headers: { Origin: appUrl.origin, 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: emails.get(role), password: passwords.get(role) }),
        });
        assert(response.ok, 'Isolated test identity sign-in failed.');
        const cookie = response.headers
          .getSetCookie()
          .map((value) => value.split(';')[0])
          .join('; ');
        assert(cookie);
        cookies.set(role, cookie);
        await response.body?.cancel();
      }
      passwords.clear();
      emails.clear();
      const health = await api('buyer', '/health');
      assert.deepEqual(health.modes, { wick: 'real', muse: 'fixture' });
      await api('admin', '/api/admin/config', 'PUT', { maxConcurrentVms: 20 });
      const catalog = (await api('admin', '/api/admin/catalog/sync', 'POST')).items.find(
        (item: Json) => item.id === approval.catalogId,
      );
      assert(
        catalog &&
          catalog.provider === approval.provider &&
          catalog.profile === approval.profile &&
          catalog.region === approval.region &&
          !catalog.providerKeyId &&
          catalog.durationMinutes.includes(15),
        'Approved managed offering is unavailable. No fallback is permitted.',
      );
      approvedRate = catalog.rateMicrosPerSecond;
      assert(approvedRate !== undefined, 'Published rate is required.');
      await api('admin', `/api/admin/catalog/${encodeURIComponent(catalog.id)}`, 'PUT', {
        approved: true,
      });
      await api('provider', '/api/provider/policy', 'PUT', {
        operationKey: `scale-policy:${header.runId}`,
        expectedRevision: (await api('provider', '/api/provider/dashboard')).policyRevision,
        autoBid: false,
        reserveSlots: 0,
        minimumPriceCents: 1,
        basePriceCents: 1,
        allowedCatalogIds: [catalog.id],
      });
      await api('provider', '/api/provider/capacity', 'PUT', { total: 20 });
      const offering = await api('provider', '/api/provider/offerings', 'POST', {
        catalogId: catalog.id,
        name: `Demo allocation ${header.runId}`,
        description: 'Dedicated test demo supplier allocation backed by Wick. No payment due.',
        priceCents: 1,
      });
      const pricing = offering.pricing;
      assert(
        pricing?.model === 'wick-provider-commission-v1' &&
          pricing.commissionBps === 1500 &&
          String(pricing.rateMicrosPerSecond) === String(approvedRate),
        'Offering must freeze the managed published rate.',
      );
      const cents = (BigInt(pricing.rateMicrosPerSecond) * 900n + 8499n) / 8500n;
      quoteCents = Math.max(1, Number(cents));
      assert(Number.isSafeInteger(quoteCents));
      const configured = await api('admin', '/api/admin/config');
      assert.equal(configured.maxConcurrentVms, 20, 'Persisted global limit must be 20.');
      journal.append('configuration-complete', {
        fixedQuoteCents: quoteCents,
        publishedRate: approvedRate,
        commissionBps: pricing.commissionBps,
        capacity: 20,
        maxConcurrentVms: 20,
      });
      const canary = await createRequest(1);
      await bid(canary);
      const canaryVm = await until(async () => {
        const detail = await api('buyer', `/api/requests/${canary.id}`);
        assert(
          !['failed', 'no_offers', 'cancelled'].includes(detail.request.status),
          'Canary auction or provisioning failed.',
        );
        return detail.vm?.status === 'running' ? (detail.vm as Json) : undefined;
      }, 150_000);
      const canaryTerminal = openTerminal(canaryVm, 1);
      await canaryTerminal.proof;
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Canary terminal did not close.')), 5000);
        canaryTerminal.ws.once('close', () => {
          clearTimeout(timer);
          resolve();
        });
        canaryTerminal.close();
      });
      journal.append('canary-running-terminal-confirmed');
      await Promise.all(
        Array.from({ length: 19 }, async (_, index) => {
          requireRunning();
          const request = await createRequest(index + 2);
          requireRunning();
          await bid(request);
        }),
      );
      const vms = await until(async () => {
        const rows = await runningSample();
        return rows.length === 20 && rows.every((vm) => vm.status === 'running') ? rows : undefined;
      }, 240_000);
      // Confirm simultaneous native running status, not just accepted creates or cached Broker state.
      const native = await Promise.all(vms.map((vm) => original!.get(vm.environmentId)));
      assert(native.every((vm) => vm.status === 'running'));
      assert.equal(new Set(native.map((vm) => vm.id)).size, 20);
      journal.append('peak-running-observed', { count: 20 });
      const proofs = vms.map((vm, index) => openTerminal(vm, index));
      await Promise.all(proofs.map((p) => p.proof));
      assert.equal(terminalConnections, 20);
      const holdStarted = Date.now();
      while (Date.now() - holdStarted < 30_000) {
        requireRunning();
        assert.equal(terminalConnections, 20);
        assert(proofs.every((p) => p.ws.readyState === WebSocket.OPEN));
        for (const proof of proofs) proof.ws.send(JSON.stringify({ type: 'ping' }));
        await runningSample();
        await delay(1000);
      }
      const finalPingAt = Date.now();
      for (const proof of proofs) proof.ws.send(JSON.stringify({ type: 'ping' }));
      await until(
        async () => (proofs.every((proof) => proof.lastPongAt >= finalPingAt) ? true : undefined),
        5000,
      );
      requireRunning();
      assert.equal(terminalConnections, 20);
      assert(proofs.every((proof) => proof.ws.readyState === WebSocket.OPEN));
      terminalHoldMs = Date.now() - holdStarted;
      journal.append('terminal-checkpoint', {
        decodedOutputAndPong: 20,
        simultaneousConnections: 20,
        holdMs: terminalHoldMs,
      });
      const probe = await createRequest(21);
      const rejected = await bid(probe, 409);
      assert(
        /slot|capacit|reserved/i.test(String(rejected.error)),
        'Capacity probe must fail for supplier capacity.',
      );
      providerProbe = true;
      await api('provider', '/api/provider/capacity', 'PUT', { total: 21 });
      await bid(probe);
      const result = await until(async () => {
        const detail = await api('buyer', `/api/requests/${probe.id}`);
        return detail.request.status !== 'open' ? detail : undefined;
      }, 55_000);
      assert.equal(result.request.status, 'failed');
      assert.match(result.request.failureReason, /concurrent VM limit/i);
      assert.equal(result.vm, null);
      assert.equal((await list('buyer', '/api/vms')).length, 20);
      assert.equal(guard!.keyCount, 20);
      globalProbe = true;
      journal.append('limit-probes-confirmed', {
        supplierCapacityRejection: true,
        globalAdmissionRejection: true,
        allocationKeys: 20,
      });
      const invoices = await list('buyer', '/api/invoices');
      assert.equal(invoices.length, 20);
      assert.equal(new Set(invoices.map((i) => i.vmId)).size, 20);
      assert(
        invoices.every(
          (invoice) => invoice.totalCents === quoteCents && invoice.label === 'No payment due',
        ),
      );
      const details = await Promise.all(
        requests.slice(0, 20).map((r) => api('buyer', `/api/requests/${r.id}`)),
      );
      const timestamps = details.map((d, index) => ({
        item: requests[index].runItem,
        requestedAt: d.request.createdAt,
        auctionClosesAt: d.request.closesAt,
        vmCreatedAt: d.vm.createdAt,
        admittedAt: d.vm.admittedAt,
        readyAt: d.vm.readyAt,
      }));
      const timing = {
        auctionQueueMs: percentiles(
          details.map((d) =>
            Math.max(0, Date.parse(d.vm.createdAt) - Date.parse(d.request.closesAt)),
          ),
        ),
        provisionMs: percentiles(
          details.map((d) => Date.parse(d.vm.readyAt) - Date.parse(d.vm.createdAt)),
        ),
        requestToReadyMs: percentiles(
          details.map((d) => Date.parse(d.vm.readyAt) - Date.parse(d.request.createdAt)),
        ),
      };
      atomicPrivate(reportPath, {
        runId: header.runId,
        status: 'validation-passed-cleanup-pending',
        modes: { wick: 'real', muse: 'fixture' },
        peakRunning,
        peakConnections,
        terminalHoldMs,
        providerProbe,
        globalProbe,
        invoiceCount: invoices.length,
        invoiceQuoteMatches: true,
        timing,
        timestamps,
        workerConcurrency: { close: 2, autoBid: 4, provision: 2, cleanup: 2 },
      });
    } catch {
      stop();
      journal.append('validation-failed', { classification: 'bounded-run-failure' });
      process.exitCode = 1;
    } finally {
      guard?.stop();
      intentionalTerminalCleanup = true;
      for (const ws of terminals) ws.close();
      journal.append('normal-cleanup-start');
      // Cancel all still-open run requests before closing the app/worker process.
      if (instance && cookies.has('buyer')) {
        try {
          for (const request of await list('buyer', '/api/requests'))
            if (
              request.description.startsWith(`Broker live scale ${header.runId} item `) &&
              request.status === 'open'
            )
              await api('buyer', `/api/requests/${request.id}/cancel`, 'POST');
          const vms = await list('buyer', '/api/vms');
          for (const vm of vms) await api('buyer', `/api/vms/${vm.id}/terminate`, 'POST');
          await until(
            async () => {
              const state = await pool.query(
                'SELECT count(*)::int AS n FROM broker_vms WHERE buyer_id=$1 AND cleanup_confirmed_at IS NULL',
                [buyerId],
              );
              return state.rows[0].n === 0 ? true : undefined;
            },
            150_000,
            false,
          );
          const dashboard = await api('provider', '/api/provider/dashboard');
          assert.equal(dashboard.capacity.held, 0);
          holdsReleased = true;
          journal.append('broker-holds-confirmed', { providerHolds: 0 });
        } catch {
          failed = true;
          journal.append('broker-cleanup-unresolved');
        }
      }
      // A separate watchdog remains responsible after process death. This fallback uses exact run-owned IDs only.
      let unresolved: string[] = [];
      if (original) {
        try {
          unresolved = await cleanupJournal(journal, original, 120_000);
          // Every intent, including lost-response and pre-transport crashes, is accounted for.
          upstreamConfirmed = unresolved.length === 0;
        } catch {
          unresolved = ['journal-reconciliation-required'];
        }
      }
      const report = readPrivate(reportPath) ?? {
        runId: header.runId,
        peakRunning,
        peakConnections,
        terminalHoldMs,
        providerProbe,
        globalProbe,
      };
      atomicPrivate(reportPath, {
        ...report,
        status: !failed && upstreamConfirmed && holdsReleased ? 'passed' : 'failed',
        cleanup: { upstreamConfirmed, holdsReleased, unresolvedCount: unresolved.length },
        finishedAt: new Date().toISOString(),
      });
      journal.append('runner-finished', {
        passed: !failed && upstreamConfirmed && holdsReleased,
        upstreamConfirmed,
        holdsReleased,
        unresolved,
      });
      if (upstreamConfirmed && holdsReleased)
        journal.append('complete', { validationPassed: !failed });
      else {
        journal.append('stop-requested', { reason: 'cleanup-unresolved' });
        process.exitCode = 1;
      }
      clearInterval(heartbeats);
      process.off('SIGTERM', interrupt);
      process.off('SIGINT', interrupt);
      if (instance) await instance.app.close();
      await lock.query("SELECT pg_advisory_unlock(hashtext('broker-live-scale-single-app'))");
      lock.release();
      await pool.end();
      console.log(
        JSON.stringify({
          validation: !failed ? 'passed' : 'failed',
          cleanup: upstreamConfirmed && holdsReleased ? 'confirmed' : 'requires-reconciliation',
          report: 'Private report written alongside the journal.',
        }),
      );
    }
  }
}

void main().catch(() => {
  console.error(
    'Live-scale command failed. Check the private journal and required configuration; no error payload is logged.',
  );
  process.exitCode = 1;
});
