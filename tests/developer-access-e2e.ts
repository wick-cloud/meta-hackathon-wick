/**
 * Opt-in actual HTTP/PostgreSQL integration of the three packaged clients.
 * Run: npm run build:packages && npx tsx tests/developer-access-e2e.ts
 * Only the dedicated loopback broker_developer_e2e_test database is accepted.
 * Both infrastructure and Muse are fixtures; no native allocation or paid call occurs.
 */
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { resolve } from 'node:path';
import { Pool } from 'pg';
import { hashPassword } from 'better-auth/crypto';
import { BrokerClient, type BrokerScope } from '@wick-cloud/broker-sdk';
import { buildApp } from '../src/server/app.js';
import { loadConfig } from '../src/server/config.js';
import { migrate } from '../src/server/db.js';
import { createWickAdapter } from '../src/server/integrations/wick.js';
import { seedMarketplace } from '../src/server/marketplace/index.js';
import type { Actor } from '../src/shared/types.js';
import { applyCreditEntry } from '../src/server/agreements/credits.js';
import { transaction } from '../src/server/marketplace/db.js';
import type { InferenceGrant } from '../src/shared/inference.js';

const databaseUrl =
  process.env.DEVELOPER_E2E_DATABASE_URL ??
  'postgresql://broker_test@127.0.0.1:55439/broker_developer_e2e_test';
const database = new URL(databaseUrl);
assert(['127.0.0.1', 'localhost'].includes(database.hostname), 'Use a loopback fixture database.');
assert.equal(
  database.pathname,
  '/broker_developer_e2e_test',
  'Use the dedicated fixture database.',
);
const port = 3310,
  baseUrl = `http://127.0.0.1:${port}`;
const runId = randomUUID(),
  buyerId = randomUUID(),
  providerUserId = randomUUID();
const actors: Actor[] = [
  {
    id: buyerId,
    email: `buyer-${runId}@developer-fixture.invalid`,
    name: 'Developer fixture buyer',
    role: 'buyer',
  },
  {
    id: providerUserId,
    email: `provider-${runId}@developer-fixture.invalid`,
    name: 'Developer fixture provider',
    role: 'provider',
  },
];
const secrets = new Set<string>();
const passwords = actors.map(() => randomBytes(24).toString('base64url'));
passwords.forEach((p) => secrets.add(p));
const config = loadConfig({
  NODE_ENV: 'test',
  PORT: String(port),
  HOST: '127.0.0.1',
  APP_URL: baseUrl,
  DATABASE_URL: databaseUrl,
  BETTER_AUTH_SECRET: randomBytes(32).toString('base64url'),
  WICK_MODE: 'fixture',
  MUSE_MODE: 'fixture',
  INFERENCE_MARKET_MODE: 'fixture',
  LOG_LEVEL: 'silent',
});
const pool = new Pool({ connectionString: databaseUrl, max: 5 });
let app: Awaited<ReturnType<typeof buildApp>>['app'] | undefined;
let buyerCookie = '',
  providerCookie = '';
const ownedRequests = new Set<string>(),
  ownedVMs = new Set<string>(),
  ownedGrants = new Set<string>(),
  issued: { cookie: string; keyId: string }[] = [];
const peers: McpPeer[] = [];
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
function childEnv(apiKey: string): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH,
    WICK_BROKER_API_KEY: apiKey,
    WICK_BROKER_API_URL: baseUrl,
    NO_COLOR: '1',
  };
}
async function browser<T>(
  cookie: string,
  path: string,
  method = 'GET',
  body?: unknown,
): Promise<T> {
  const result = await fetch(baseUrl + path, {
    method,
    headers: {
      cookie,
      Origin: baseUrl,
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(15000),
  });
  assert(result.ok, `Browser fixture ${method} ${path} failed HTTP ${result.status}.`);
  return result.json() as Promise<T>;
}
async function login(index: number) {
  const r = await fetch(baseUrl + '/api/auth/sign-in/email', {
    method: 'POST',
    headers: { Origin: baseUrl, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: actors[index]!.email, password: passwords[index] }),
    signal: AbortSignal.timeout(15000),
  });
  assert.equal(r.status, 200, 'Fixture login failed.');
  return r.headers
    .getSetCookie()
    .map((c) => c.split(';')[0])
    .join('; ');
}
async function mint(cookie: string, scopes: BrokerScope[], limits: Record<string, number> = {}) {
  const result = await browser<{ key: { id: string }; token: string }>(
    cookie,
    '/api/keys',
    'POST',
    { name: `Developer integration ${runId}`, scopes, limits },
  );
  secrets.add(result.token);
  secrets.add(result.token.split('.')[1]!);
  issued.push({ cookie, keyId: result.key.id });
  return result;
}
function noSecret(text: string) {
  for (const secret of secrets) assert(!text.includes(secret), 'A client leaked a credential.');
}
async function cli(apiKey: string, args: string[], body?: unknown) {
  const child = spawn(process.execPath, [resolve('packages/cli/dist/index.js'), ...args], {
    env: childEnv(apiKey),
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stdout = '',
    stderr = '';
  const deadline = setTimeout(() => child.kill('SIGKILL'), 15000);
  child.stdout.on('data', (data) => {
    stdout += data.toString();
    if (Buffer.byteLength(stdout) > 1048576) child.kill('SIGKILL');
  });
  child.stderr.on('data', (data) => {
    stderr += data.toString();
    if (Buffer.byteLength(stderr) > 65536) child.kill('SIGKILL');
  });
  child.stdin.end(body === undefined ? '' : JSON.stringify(body));
  const code = await new Promise<number | null>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', resolve);
  });
  clearTimeout(deadline);
  noSecret(stdout + stderr);
  assert.equal(code, 0, `CLI fixture failed for ${args.slice(0, 3).join(' ')}.`);
  assert.equal(stderr, '', 'CLI JSON mode emitted diagnostics on a successful command.');
  return JSON.parse(stdout) as any;
}
class McpPeer {
  readonly child: ChildProcessWithoutNullStreams;
  readonly exited: Promise<void>;
  next = 0;
  stdout = '';
  stderr = '';
  buffer = '';
  pending = new Map<
    number,
    { resolve: (v: any) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }
  >();
  constructor(apiKey: string) {
    this.child = spawn(process.execPath, [resolve('packages/mcp/dist/index.js')], {
      env: childEnv(apiKey),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.exited = new Promise((resolve) =>
      this.child.once('close', () => {
        for (const entry of this.pending.values()) {
          clearTimeout(entry.timer);
          entry.reject(Error('MCP fixture process exited.'));
        }
        this.pending.clear();
        resolve();
      }),
    );
    this.child.stdout.on('data', (chunk) => {
      this.stdout += chunk.toString();
      this.buffer += chunk.toString();
      if (Buffer.byteLength(this.stdout) > 1048576) {
        this.child.kill('SIGKILL');
        return;
      }
      for (;;) {
        const end = this.buffer.indexOf('\n');
        if (end < 0) break;
        const line = this.buffer.slice(0, end);
        this.buffer = this.buffer.slice(end + 1);
        if (!line.trim()) continue;
        try {
          const message = JSON.parse(line);
          assert.equal(message.jsonrpc, '2.0');
          const entry = this.pending.get(message.id);
          if (entry) {
            clearTimeout(entry.timer);
            this.pending.delete(message.id);
            entry.resolve(message);
          }
        } catch {
          for (const entry of this.pending.values()) {
            clearTimeout(entry.timer);
            entry.reject(Error('MCP stdout contained non-protocol content.'));
          }
          this.pending.clear();
          this.child.kill('SIGKILL');
        }
      }
    });
    this.child.stderr.on('data', (chunk) => {
      this.stderr += chunk.toString();
      if (Buffer.byteLength(this.stderr) > 65536) this.child.kill('SIGKILL');
    });
    this.child.on('error', () => {
      for (const entry of this.pending.values()) entry.reject(Error('MCP process failed.'));
    });
  }
  call(method: string, params: unknown = {}) {
    return new Promise<any>((resolve, reject) => {
      const id = ++this.next,
        timer = setTimeout(() => {
          this.pending.delete(id);
          reject(Error(`MCP ${method} exceeded its bounded deadline.`));
        }, 15000);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  }
  async initialize() {
    const result = await this.call('initialize', {
      protocolVersion: '2025-11-25',
      capabilities: {},
      clientInfo: { name: 'broker-fixture-integration', version: '1.0.0' },
    });
    assert.equal(result.result.serverInfo.name, 'wick-broker');
    this.child.stdin.write(
      JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n',
    );
  }
  async tool(name: string, args: Record<string, unknown> = {}) {
    const response = await this.call('tools/call', { name, arguments: args });
    assert(!response.error, `MCP ${name} returned protocol error.`);
    assert(!response.result.isError, `MCP ${name} returned an operation error.`);
    return response.result.structuredContent.data as any;
  }
  async close() {
    for (const entry of this.pending.values()) clearTimeout(entry.timer);
    this.pending.clear();
    this.child.stdin.end();
    this.child.kill('SIGTERM');
    const timer = setTimeout(() => this.child.kill('SIGKILL'), 2000);
    await this.exited;
    clearTimeout(timer);
    noSecret(this.stdout + this.stderr);
    for (const line of this.stdout.trim().split('\n'))
      if (line) assert.equal(JSON.parse(line).jsonrpc, '2.0');
  }
}

async function main() {
  await migrate(pool);
  // Fresh per-run identities only: never reset or repurpose an existing account.
  for (let i = 0; i < actors.length; i++) {
    const actor = actors[i]!;
    await pool.query(
      'INSERT INTO "user"(id,email,name,role,"emailVerified") VALUES($1,$2,$3,$4,true)',
      [actor.id, actor.email, actor.name, actor.role],
    );
    await pool.query(
      'INSERT INTO account(id,"accountId","providerId","userId",password) VALUES($1,$2,\'credential\',$2,$3)',
      [randomUUID(), actor.id, await hashPassword(passwords[i]!)],
    );
  }
  const catalog = await createWickAdapter(config, pool).catalog();
  await seedMarketplace(pool, actors, catalog, 'fixture');
  await pool.query(
    'UPDATE "user" u SET "providerId"=p.id::text FROM broker_providers p WHERE p.user_id=u.id AND u.id=$1',
    [providerUserId],
  );
  await pool.query(
    "UPDATE broker_providers SET policy=jsonb_set(policy,'{autoBid}','false') WHERE user_id=$1",
    [providerUserId],
  );
  app = (await buildApp(config)).app;
  await app.listen({ host: '127.0.0.1', port });
  assert.deepEqual((await browser<{ modes: unknown }>('', '/health')).modes, {
    wick: 'fixture',
    muse: 'fixture',
  });
  buyerCookie = await login(0);
  providerCookie = await login(1);
  const buyerKey = await mint(
    buyerCookie,
    [
      'account:read',
      'catalog:read',
      'orders:read',
      'orders:write',
      'agreements:read',
      'vms:read',
      'vms:terminal',
      'vms:terminate',
      'billing:read',
      'muse:propose',
    ],
    { maxAuctionCents: 1000 },
  );
  const identityKey = await mint(buyerCookie, ['account:read']);
  const identity = new BrokerClient({ baseUrl, apiKey: identityKey.token });
  const identityMe = await identity.me();
  assert.equal(identityMe.user?.id, buyerId);
  assert.deepEqual(identityMe.catalog, []);
  await assert.rejects(() => identity.catalog.list(), { status: 403 });
  await browser(buyerCookie, `/api/keys/${identityKey.key.id}`, 'DELETE');
  await assert.rejects(() => identity.me(), { status: 401 });
  const providerKey = await mint(providerCookie, [
    'account:read',
    'catalog:read',
    'provider:read',
    'provider:capacity:write',
    'provider:bids:write',
    'muse:propose',
  ]);
  const buyer = new BrokerClient({ baseUrl, apiKey: buyerKey.token }),
    provider = new BrokerClient({ baseUrl, apiKey: providerKey.token });
  assert.equal((await buyer.me()).user?.id, buyerId);
  assert.equal((await provider.me()).user?.id, providerUserId);
  const before = await provider.provider.dashboard();
  const capacityInput = { total: 5, expectedRevision: before.policyRevision },
    capacityKey = `capacity-${runId}`;
  const changed = await cli(
    providerKey.token,
    ['provider', 'capacity', 'set', '--file', '-', '--operation-key', capacityKey, '--json'],
    capacityInput,
  );
  const replay = await cli(
    providerKey.token,
    ['provider', 'capacity', 'set', '--file', '-', '--operation-key', capacityKey, '--json'],
    capacityInput,
  );
  assert.deepEqual(replay, changed);
  const after = await provider.provider.dashboard();
  assert.equal(after.capacity.total, 5);
  assert.equal(after.policyRevision, before.policyRevision + 1);
  const receipts = await pool.query(
    'SELECT count(*)::int n FROM broker_operation_receipts WHERE owner_id=$1 AND operation_key=$2',
    [providerUserId, capacityKey],
  );
  assert.equal(receipts.rows[0].n, 1);
  const proposal = await provider.provider.policy.propose(
    'Keep one slot spare; preserve prices and leave automatic bidding disabled.',
  );
  assert.equal(proposal.mode, 'fixture');
  assert.equal(proposal.modelCalled, false);
  const item = (await buyer.catalog.list()).items.find(
    (c) => c.approved && !c.gpu && c.durationMinutes.includes(30),
  );
  assert(item, 'Fixture needs an approved 30-minute configuration.');
  const requestBody = {
    description: 'Actual SDK/CLI/MCP fixture integration',
    catalogId: item.id,
    region: item.region,
    durationMinutes: 30 as const,
    maxPriceCents: 1000,
    requirements: { cpu: item.cpu, memoryGb: item.memoryGb },
  };
  const createKey = `auction-${runId}`;
  const [order, duplicate] = await Promise.all([
    buyer.orders.create(requestBody, { operationKey: createKey }),
    buyer.orders.create(requestBody, { operationKey: createKey }),
  ]);
  assert.equal(order.id, duplicate.id);
  ownedRequests.add(order.id);
  assert.equal(
    (await pool.query('SELECT count(*)::int n FROM broker_requests WHERE buyer_id=$1', [buyerId]))
      .rows[0].n,
    1,
  );
  assert.equal(
    (await provider.provider.requests()).items.some((r) => r.id === order.id),
    true,
  );
  const bid = await provider.provider.bids.submit(
    order.id,
    { totalPriceCents: 125 },
    { operationKey: `bid-${runId}` },
  );
  assert.equal(bid.totalPriceCents, 125);
  const pending = await buyer.orders.wait(order.id, { timeoutMs: 150, pollIntervalMs: 100 });
  assert.equal(pending.state, 'pending');
  const awaited = await buyer.orders.wait(order.id, { timeoutMs: 75000, pollIntervalMs: 1000 });
  assert.equal(awaited.state, 'complete');
  assert.equal(awaited.resource?.request.status, 'ready');
  const vm = awaited.resource?.vm;
  assert(vm, 'Winning fixture auction must expose its VM.');
  ownedVMs.add(vm.id);
  assert.equal(vm.status, 'running');
  const fromBrowser = await browser<{ request: { id: string } }>(
    buyerCookie,
    `/api/requests/${order.id}`,
  );
  assert.equal(fromBrowser.request.id, order.id);
  assert((await buyer.orders.list()).items.some((row) => row.id === order.id));
  const cliOrders = await cli(buyerKey.token, ['orders', 'list', '--json']);
  assert(cliOrders.items.some((row: { id: string }) => row.id === order.id));
  const terminal = await buyer.vms.terminal(vm.id, {
    timeoutMs: 10000,
    signal: AbortSignal.timeout(10000),
  });
  let output = '';
  try {
    terminal.write('echo SDK_TERMINAL_PROOF\r');
    for await (const event of terminal) {
      if (event.type === 'output') {
        output += Buffer.from(event.data).toString('utf8');
        terminal.ack(event.data.byteLength);
        if (output.includes('\r\nSDK_TERMINAL_PROOF\r\n')) break;
      }
    }
    assert(output.includes('\r\nSDK_TERMINAL_PROOF\r\n'), 'SDK terminal proof missing.');
  } finally {
    terminal.close();
  }
  // Both roles use the real packaged stdio process against this actual HTTP server.
  const buyerMcp = new McpPeer(buyerKey.token);
  peers.push(buyerMcp);
  await buyerMcp.initialize();
  const buyerTools = (await buyerMcp.call('tools/list')).result.tools.map(
    (t: { name: string }) => t.name,
  );
  assert(buyerTools.includes('terminal_open'));
  assert(!buyerTools.includes('provider_capacity_set'));
  assert(
    (await buyerMcp.tool('orders_list')).items.some((row: { id: string }) => row.id === order.id),
  );
  const handle = await buyerMcp.tool('terminal_open', { vmId: vm.id });
  await buyerMcp.tool('terminal_resize', { sessionId: handle.sessionId, cols: 91, rows: 26 });
  await buyerMcp.tool('terminal_write', {
    sessionId: handle.sessionId,
    data: 'echo MCP_TERMINAL_PROOF\r',
  });
  let mcpOutput = '';
  for (let i = 0; i < 10 && !mcpOutput.includes('\r\nMCP_TERMINAL_PROOF\r\n'); i++) {
    const read = await buyerMcp.tool('terminal_read', { sessionId: handle.sessionId, waitMs: 500 });
    mcpOutput += read.output;
  }
  assert(mcpOutput.includes('\r\nMCP_TERMINAL_PROOF\r\n'), 'MCP terminal proof missing.');
  assert.equal(
    (await buyerMcp.tool('terminal_close', { sessionId: handle.sessionId })).vmTerminated,
    false,
  );
  assert.equal(
    (await buyer.vms.get(vm.id)).status,
    'running',
    'Closing terminal must preserve the VM.',
  );
  const providerMcp = new McpPeer(providerKey.token);
  peers.push(providerMcp);
  await providerMcp.initialize();
  const providerTools = (await providerMcp.call('tools/list')).result.tools.map(
    (t: { name: string }) => t.name,
  );
  assert(providerTools.includes('provider_capacity_set'));
  assert(!providerTools.includes('auction_create'));
  assert.equal((await providerMcp.tool('provider_dashboard_get')).capacity.total, 5);
  await assert.rejects(
    () =>
      buyer.agreements.preview({
        operationKey: `preview-${runId}`,
        description: 'Nonbinding agreement preview',
        startDate: new Date(Date.now() + 86400000).toISOString().slice(0, 10),
        timeZone: 'UTC',
        windowStart: '00:00',
        windowEnd: '06:00',
        minimumQuantity: 1,
        targetQuantity: 2,
        requirements: { cpu: item.cpu, memoryGb: item.memoryGb },
        region: item.region,
        maxDiscountRateCentsPerHour: 10,
      }),
    { status: 410 },
  );
  assert.equal(
    (await pool.query('SELECT count(*)::int n FROM broker_agreements WHERE buyer_id=$1', [buyerId]))
      .rows[0].n,
    0,
  );
  // Same app and database: each packaged client buys prepaid inference and uses quota.
  await transaction(pool, (db) =>
    applyCreditEntry(db, buyerId, {
      operationKey: `fund-inference-e2e-${runId}`,
      kind: 'grant',
      balanceDeltaCents: 1000,
      reservedDeltaCents: 0,
      description: 'Disposable inference client test credit',
    }),
  );
  const agentGrant = await browser<InferenceGrant>(buyerCookie, '/api/inference/grants', 'POST', {
    operationKey: `agent-e2e-${runId}`,
    name: 'Three-client inference task',
    budgetCents: 1000,
  });
  ownedGrants.add(agentGrant.id);
  const agentKey = await browser<{ key: { id: string }; token: string }>(
    buyerCookie,
    `/api/inference/grants/${agentGrant.id}/keys`,
    'POST',
    {},
  );
  secrets.add(agentKey.token);
  issued.push({ cookie: buyerCookie, keyId: agentKey.key.id });
  const agent = new BrokerClient({ baseUrl, apiKey: agentKey.token });
  const tokenInput = { inputTokens: 10000, outputTokens: 2000 };
  const inferenceInput = {
    model: 'meta/muse-spark-open',
    messages: [{ role: 'user' as const, content: 'Client fixture proof' }],
    max_tokens: 64,
  };
  const auction = await agent.inference.orders.create(
    { ...tokenInput, mode: 'auction', maxTotalCents: 100 },
    { operationKey: `sdk-tokens-${runId}` },
  );
  const tokenResult = await agent.inference.orders.wait(auction.id, {
    timeoutMs: 45000,
    pollIntervalMs: 1000,
  });
  assert.equal(tokenResult.resource?.order.status, 'awarded');
  const sdkCompletion = await agent.inference.complete(inferenceInput, {
    operationKey: `sdk-completion-${runId}`,
  });
  assert.equal(sdkCompletion.broker.mode, 'fixture');
  assert.equal((await agent.inference.receipt(sdkCompletion.id)).status, 'settled');
  const cliQuote = await cli(
    agentKey.token,
    ['inference', 'quote', '--file', '-', '--json'],
    tokenInput,
  );
  const cliOrder = await cli(
    agentKey.token,
    ['tokens', 'create', '--file', '-', '--operation-key', `cli-tokens-${runId}`, '--json'],
    { ...tokenInput, mode: 'instant', quoteId: cliQuote.items[0].quoteId, maxTotalCents: 100 },
  );
  assert.equal(cliOrder.status, 'awarded');
  const cliCompletion = await cli(
    agentKey.token,
    [
      'inference',
      'complete',
      '--file',
      '-',
      '--operation-key',
      `cli-completion-${runId}`,
      '--json',
    ],
    inferenceInput,
  );
  assert.equal(cliCompletion.broker.mode, 'fixture');
  const agentMcp = new McpPeer(agentKey.token);
  peers.push(agentMcp);
  await agentMcp.initialize();
  const agentTools = (await agentMcp.call('tools/list')).result.tools.map(
    (t: { name: string }) => t.name,
  );
  assert(agentTools.includes('inference_complete'));
  assert(!agentTools.includes('terminal_open') && !agentTools.includes('auction_create'));
  const mcpQuote = await agentMcp.tool('inference_quotes_get', { input: tokenInput });
  const mcpOrder = await agentMcp.tool('token_order_create', {
    operationKey: `mcp-tokens-${runId}`,
    input: {
      ...tokenInput,
      mode: 'instant',
      quoteId: mcpQuote.items[0].quoteId,
      maxTotalCents: 100,
    },
  });
  assert.equal(mcpOrder.status, 'awarded');
  const mcpCompletion = await agentMcp.tool('inference_complete', {
    operationKey: `mcp-completion-${runId}`,
    input: inferenceInput,
  });
  assert.equal(mcpCompletion.broker.mode, 'fixture');
  assert.equal(
    (await agentMcp.tool('inference_receipt_get', { id: mcpCompletion.id })).status,
    'settled',
  );
  assert((await buyer.orders.list({ kind: 'token' })).items.some((r) => r.id === auction.id));
  await browser(buyerCookie, `/api/inference/grants/${agentGrant.id}/close`, 'POST', {
    operationKey: `close-agent-${runId}`,
  });
  await assert.rejects(
    () => agent.inference.complete(inferenceInput, { operationKey: `closed-agent-${runId}` }),
    { status: 409 },
  );
  assert.equal((await buyer.billing.invoices()).items.filter((i) => i.vmId === vm.id).length, 1);
  await buyer.vms.terminate(vm.id, { operationKey: `terminate-${runId}` });
  for (let i = 0; i < 45; i++) {
    const current = await buyer.vms.get(vm.id);
    if (current.cleanupConfirmedAt) break;
    await sleep(500);
  }
  assert((await buyer.vms.get(vm.id)).cleanupConfirmedAt, 'Fixture cleanup was not confirmed.');
  for (const entry of issued) await browser(entry.cookie, `/api/keys/${entry.keyId}`, 'DELETE');
  await assert.rejects(() => buyer.me(), { status: 401 });
  await assert.rejects(() => provider.me(), { status: 401 });
  return {
    result: 'passed',
    adapters: { wick: 'fixture', muse: 'fixture' },
    actualHttp: true,
    realBrowserSessionAuth: true,
    postgres: true,
    scopedBrokerKeys: true,
    identityOnlyCatalogIsolation: true,
    concurrentCreateSingleAuction: true,
    thirtySecondAuction: true,
    manualSdkProviderBid: true,
    cliJsonRead: true,
    cliProviderMutationReplay: true,
    sdkTerminal: true,
    mcpBuyerAndProvider: true,
    mcpTerminalLifecycle: true,
    nonbindingAgreementPreview: true,
    revocationVerified: true,
    cleanupConfirmed: true,
    inferenceGrantIsolation: true,
    inferenceThirtySecondAuction: true,
    inferenceSdkCliMcpPurchasesAndCompletions: true,
    inferenceClosureVerified: true,
    paidNativeAllocations: 0,
  };
}
async function cleanup() {
  let failure: unknown;
  try {
    for (const peer of peers) {
      try {
        await peer.close();
      } catch (error) {
        failure ??= error;
      }
    }
    if (app && buyerCookie) {
      for (const id of ownedGrants)
        await browser(buyerCookie, `/api/inference/grants/${id}/close`, 'POST', {
          operationKey: `cleanup-agent-${runId}-${id}`,
        }).catch(() => {});
      // Recover a lost create response by the original owner/operation key, never by allocating a replacement.
      const receipt = (
        await pool.query(
          "SELECT response->>'id' id FROM broker_operation_receipts WHERE owner_id=$1 AND operation='orders.create' AND operation_key=$2",
          [buyerId, `auction-${runId}`],
        )
      ).rows[0];
      if (typeof receipt?.id === 'string') ownedRequests.add(receipt.id);
      // Stop any still-open auction before resolving its VM; an already-closed auction
      // returns a conflict, after which its committed VM can be found below.
      for (const id of ownedRequests)
        await browser(buyerCookie, `/api/requests/${id}/cancel`, 'POST', {
          operationKey: `cancel-${runId}-${id}`,
        }).catch(() => {});
      // Resolve by the durable owned auction IDs, including uncertain provisioning responses.
      if (ownedRequests.size) {
        const rows = (
          await pool.query(
            'SELECT id FROM broker_vms WHERE buyer_id=$1 AND request_id=ANY($2::uuid[])',
            [buyerId, [...ownedRequests]],
          )
        ).rows;
        for (const row of rows) ownedVMs.add(row.id);
      }
      for (const id of ownedVMs) {
        await browser(buyerCookie, `/api/vms/${id}/terminate`, 'POST', {
          operationKey: `cleanup-${runId}-${id}`,
        }).catch(() => {});
      }
      for (let i = 0; i < 45 && ownedVMs.size; i++) {
        const n = Number(
          (
            await pool.query(
              'SELECT count(*)::int n FROM broker_vms WHERE buyer_id=$1 AND id=ANY($2::uuid[]) AND cleanup_confirmed_at IS NULL',
              [buyerId, [...ownedVMs]],
            )
          ).rows[0].n,
        );
        if (!n) break;
        await sleep(500);
      }
      const unresolved = ownedVMs.size
        ? Number(
            (
              await pool.query(
                'SELECT count(*)::int n FROM broker_vms WHERE buyer_id=$1 AND id=ANY($2::uuid[]) AND cleanup_confirmed_at IS NULL',
                [buyerId, [...ownedVMs]],
              )
            ).rows[0].n,
          )
        : 0;
      assert.equal(unresolved, 0, 'Fixture environment cleanup remains unresolved.');
      for (const entry of issued)
        await browser(entry.cookie, `/api/keys/${entry.keyId}`, 'DELETE').catch(() => {});
      await browser(buyerCookie, '/api/auth/sign-out', 'POST', {}).catch(() => {});
      await browser(providerCookie, '/api/auth/sign-out', 'POST', {}).catch(() => {});
    }
  } catch (error) {
    failure ??= error;
  } finally {
    try {
      await app?.close();
    } catch (error) {
      failure ??= error;
    }
    try {
      await pool.end();
    } catch (error) {
      failure ??= error;
    }
  }
  if (failure) throw failure;
}
let report: Awaited<ReturnType<typeof main>> | undefined;
try {
  report = await main();
} catch (error) {
  let message = error instanceof Error ? error.message : 'Unknown integration failure.';
  for (const secret of secrets) message = message.replaceAll(secret, '[redacted]');
  console.error(JSON.stringify({ result: 'failed', message, paidNativeAllocations: 0 }));
  process.exitCode = 1;
} finally {
  try {
    await cleanup();
  } catch {
    console.error(JSON.stringify({ result: 'cleanup_failed', paidNativeAllocations: 0 }));
    process.exitCode = 1;
  }
}

if (!process.exitCode && report) console.log(JSON.stringify(report));
