/**
 * Explicitly opt-in paid inference diagnostic against a disposable loopback app.
 * Requires independently reviewed qualification and private server credentials.
 * Never changes Railway, creates endpoints or provisions a VM. At most three
 * upstream completion attempts; unknown outcomes are never retried.
 */
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { Pool } from 'pg';
import { hashPassword } from 'better-auth/crypto';
import { chromium, type Browser } from '@playwright/test';
import { BrokerClient } from '@wick-cloud/broker-sdk';
import { buildApp } from '../src/server/app.js';
import { loadConfig } from '../src/server/config.js';
import { migrate } from '../src/server/db.js';
import { createWickAdapter } from '../src/server/integrations/wick.js';
import { seedMarketplace } from '../src/server/marketplace/index.js';
import { createInferenceRuntime } from '../src/server/inference/runtime.js';
import type { Actor } from '../src/shared/types.js';
import type { InferenceGrant, TokenOffering, TokenOrderDetail } from '../src/shared/inference.js';

assert.equal(process.env.RUN_INFERENCE_LIVE_TEST, '1', 'Explicit live-test opt-in is required.');
const databaseUrl = process.env.INFERENCE_LIVE_DATABASE_URL!;
const database = new URL(databaseUrl);
assert(['127.0.0.1', 'localhost'].includes(database.hostname), 'Use a loopback database.');
assert.equal(
  database.pathname,
  '/broker_inference_live_test',
  'Use the dedicated disposable database.',
);
const selectedProvider = process.env.INFERENCE_LIVE_PROVIDER ?? 'baseten';
assert(selectedProvider === 'baseten' || selectedProvider === 'modal');
const provider: 'baseten' | 'modal' = selectedProvider;
const port = 3340,
  baseUrl = `http://127.0.0.1:${port}`,
  runId = randomUUID();
const actors: Actor[] = ['buyer', 'provider', 'provider', 'admin'].map((role, i) => ({
  id: randomUUID(),
  role: role as Actor['role'],
  email: `live-${i}-${runId}@inference-test.invalid`,
  name: ['Live test buyer', 'Baseten test supplier', 'Modal test supplier', 'Live test operator'][
    i
  ]!,
}));
const passwords = actors.map(() => randomBytes(24).toString('base64url'));
const config = loadConfig({
  ...process.env,
  NODE_ENV: 'test',
  HOST: '127.0.0.1',
  PORT: String(port),
  APP_URL: baseUrl,
  DATABASE_URL: databaseUrl,
  BETTER_AUTH_SECRET: randomBytes(32).toString('base64url'),
  WICK_MODE: 'fixture',
  MUSE_MODE: 'fixture',
  INFERENCE_MARKET_MODE: 'real',
  LOG_LEVEL: 'silent',
  INFERENCE_BASETEN_PROVIDER_EMAIL: actors[1]!.email,
  INFERENCE_MODAL_PROVIDER_EMAIL: actors[2]!.email,
});
const pool = new Pool({ connectionString: databaseUrl, max: 5 });
let app: Awaited<ReturnType<typeof buildApp>>['app'] | undefined, ui: Browser | undefined;
let buyerCookie = '',
  grantId = '',
  attempts = 0;
const keys: string[] = [],
  issuedTokens: string[] = [],
  peers: ReturnType<typeof mcp>[] = [];
const usage: { provider: string; elapsedMs: number; inputTokens: number; outputTokens: number }[] =
  [];
const report: Record<string, unknown> = {
  provider,
  environment: 'isolated loopback app and Postgres',
  runId,
};
const operation = () => randomUUID();
async function browser<T = any>(
  cookie: string,
  path: string,
  method = 'GET',
  body?: unknown,
): Promise<T> {
  const r = await fetch(baseUrl + path, {
    method,
    signal: AbortSignal.timeout(15000),
    headers: {
      cookie,
      origin: baseUrl,
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  assert(r.ok, `${method} ${path}: HTTP ${r.status}`);
  return r.json() as Promise<T>;
}
async function login(i: number) {
  const r = await fetch(baseUrl + '/api/auth/sign-in/email', {
    method: 'POST',
    headers: { origin: baseUrl, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: actors[i]!.email, password: passwords[i] }),
    signal: AbortSignal.timeout(15000),
  });
  assert.equal(r.status, 200);
  return r.headers
    .getSetCookie()
    .map((c) => c.split(';')[0])
    .join('; ');
}
function childEnv(token: string) {
  // Native credentials and database access never reach the agent clients.
  return {
    PATH: process.env.PATH,
    WICK_BROKER_API_KEY: token,
    WICK_BROKER_API_URL: baseUrl,
    NO_COLOR: '1',
  };
}
function noSecret(value: string) {
  for (const secret of [
    ...passwords,
    config.inferenceBasetenApiKey,
    config.inferenceModalProxyToken,
    ...issuedTokens,
  ])
    if (secret) assert(!value.includes(secret), 'A diagnostic leaked a server credential.');
  assert(!/wbr_[A-Za-z0-9_-]+\./.test(value), 'A diagnostic leaked an agent key.');
}
async function cli(token: string, args: string[], input?: unknown) {
  const child = spawn(process.execPath, [resolve('packages/cli/dist/index.js'), ...args], {
    env: childEnv(token),
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stdout = '',
    stderr = '';
  const timer = setTimeout(() => child.kill('SIGKILL'), 100000);
  child.stdout.on('data', (d) => {
    stdout += d;
    if (Buffer.byteLength(stdout) > 1048576) child.kill('SIGKILL');
  });
  child.stderr.on('data', (d) => {
    stderr += d;
    if (Buffer.byteLength(stderr) > 65536) child.kill('SIGKILL');
  });
  child.stdin.end(input === undefined ? '' : JSON.stringify(input));
  try {
    const code = await new Promise<number | null>((yes, no) => {
      child.once('close', yes);
      child.once('error', no);
    });
    noSecret(stdout + stderr);
    assert.equal(code, 0, `CLI ${args.slice(0, 2).join(' ')} failed.`);
    assert.equal(stderr, '');
    return JSON.parse(stdout);
  } finally {
    clearTimeout(timer);
  }
}
function mcp(token: string) {
  const child = spawn(process.execPath, [resolve('packages/mcp/dist/index.js')], {
    env: childEnv(token),
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let next = 0,
    buffer = '',
    outputBytes = 0,
    stderr = '';
  const pending = new Map<
    number,
    { yes: (v: any) => void; no: (e: Error) => void; timer: ReturnType<typeof setTimeout> }
  >();
  const exit = new Promise<void>((yes) =>
    child.once('close', () => {
      for (const entry of pending.values()) {
        clearTimeout(entry.timer);
        entry.no(Error('MCP exited.'));
      }
      pending.clear();
      yes();
    }),
  );
  child.stdout.on('data', (d) => {
    outputBytes += Buffer.byteLength(d);
    buffer += d;
    if (outputBytes > 1048576) return void child.kill('SIGKILL');
    for (;;) {
      const end = buffer.indexOf('\n');
      if (end < 0) break;
      const line = buffer.slice(0, end);
      buffer = buffer.slice(end + 1);
      if (!line.trim()) continue;
      try {
        noSecret(line);
        const value = JSON.parse(line);
        assert.equal(value.jsonrpc, '2.0');
        const entry = pending.get(value.id);
        if (entry) {
          clearTimeout(entry.timer);
          pending.delete(value.id);
          entry.yes(value);
        }
      } catch {
        child.kill('SIGKILL');
      }
    }
  });
  child.stderr.on('data', (d) => {
    stderr += d;
    if (Buffer.byteLength(stderr) > 65536) child.kill('SIGKILL');
  });
  child.on('error', () => {
    for (const e of pending.values()) e.no(Error('MCP failed.'));
  });
  async function call(method: string, params: unknown = {}) {
    const id = ++next;
    return new Promise<any>((yes, no) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        no(Error(`MCP ${method} timed out.`));
      }, 100000);
      pending.set(id, { yes, no, timer });
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  }
  return {
    async initialize() {
      const r = await call('initialize', {
        protocolVersion: '2025-11-25',
        capabilities: {},
        clientInfo: { name: 'live-diagnostic', version: '1' },
      });
      assert.equal(r.result.serverInfo.name, 'wick-broker');
      child.stdin.write(
        JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n',
      );
      const tools = (await call('tools/list')).result.tools.map((t: { name: string }) => t.name);
      assert(tools.includes('inference_complete') && !tools.includes('terminal_open'));
    },
    async tool(name: string, args: unknown = {}) {
      const r = await call('tools/call', { name, arguments: args });
      assert(!r.error && !r.result.isError, `MCP ${name} failed.`);
      return r.result.structuredContent.data;
    },
    async close() {
      child.stdin.end();
      child.kill('SIGTERM');
      const timer = setTimeout(() => child.kill('SIGKILL'), 2000);
      await exit;
      clearTimeout(timer);
      noSecret(stderr);
    },
  };
}
async function main() {
  const preflight = (await createInferenceRuntime(config)).routes.get(provider)!;
  assert(
    preflight.qualified && preflight.mode === 'real',
    'Independently qualify the selected native route first.',
  );
  await migrate(pool);
  for (let i = 0; i < actors.length; i++) {
    const a = actors[i]!;
    await pool.query(
      'INSERT INTO "user"(id,email,name,role,"emailVerified") VALUES($1,$2,$3,$4,true)',
      [a.id, a.email, a.name, a.role],
    );
    await pool.query(
      'INSERT INTO account(id,"accountId","providerId","userId",password) VALUES($1,$2,\'credential\',$2,$3)',
      [operation(), a.id, await hashPassword(passwords[i]!)],
    );
  }
  await seedMarketplace(pool, actors, await createWickAdapter(config, pool).catalog(), 'fixture');
  await pool.query(
    'UPDATE "user" u SET "providerId"=p.id::text FROM broker_providers p WHERE p.user_id=u.id AND u.id=ANY($1::text[])',
    [actors.map((a) => a.id)],
  );
  const built = await buildApp(config, {
    wrapInference(runtime) {
      const route = runtime.routes.get(provider)!;
      assert(
        route.qualified && route.mode === 'real',
        'Independently qualify the selected native route first.',
      );
      return {
        ...runtime,
        async dispatch(route, input, id) {
          assert(attempts < 3, 'The three-attempt paid-call cap was reached.');
          attempts++;
          const start = Date.now();
          const result = await runtime.dispatch(route, input, id);
          usage.push({
            provider: route.provider,
            elapsedMs: Date.now() - start,
            inputTokens: result.inputTokens,
            outputTokens: result.outputTokens,
          });
          return result;
        },
      };
    },
  });
  app = built.app;
  await app.listen({ host: '127.0.0.1', port });
  buyerCookie = await login(0);
  const providerCookie = await login(provider === 'baseten' ? 1 : 2),
    adminCookie = await login(3);
  await browser(adminCookie, '/api/admin/credits', 'POST', {
    buyerId: actors[0]!.id,
    amountCents: 2000,
    operationKey: operation(),
    description: 'Disposable live inference pilot credit',
  });
  const offering = (
    await browser<{ offering: TokenOffering }>(providerCookie, '/api/provider/inference/offering')
  ).offering;
  assert.equal(offering.route.mode, 'real');
  await browser(providerCookie, '/api/provider/inference/offering', 'PUT', {
    operationKey: operation(),
    expectedRevision: offering.revision,
    active: true,
    autoBid: true,
    inputRateMicrosPerMillion: 1600000,
    outputRateMicrosPerMillion: 5200000,
    instantMarkupBps: 1000,
    minimumPriceCents: 1,
    maxOutstandingInputTokens: 10000000,
    maxOutstandingOutputTokens: 100000,
  });
  const grant = await browser<InferenceGrant>(buyerCookie, '/api/inference/grants', 'POST', {
    operationKey: operation(),
    name: 'Real Muse end-to-end diagnostic',
    budgetCents: 400,
    allowedProviders: [provider],
    expiresAt: new Date(Date.now() + 3600000).toISOString(),
  });
  grantId = grant.id;
  const mint = async () => {
    const key = await browser(buyerCookie, `/api/inference/grants/${grantId}/keys`, 'POST', {});
    keys.push(key.key.id);
    issuedTokens.push(key.token);
    return key.token as string;
  };
  let token = await mint(),
    agent = new BrokerClient({ baseUrl, apiKey: token, requestTimeoutMs: 100000 });
  const catalog = await agent.inference.catalog();
  report.routes = catalog.routes;
  const input = { inputTokens: 2000000, outputTokens: 512 };
  const completionInput = {
    model: 'meta/muse-spark-open',
    messages: [{ role: 'user' as const, content: 'Reply with the number 7 only.' }],
    max_tokens: 512,
  };
  ui = await chromium.launch({ headless: true });
  const page = await ui.newPage({ baseURL: baseUrl, viewport: { width: 1440, height: 1000 } });
  assert(
    (
      await page.request.post('/api/auth/sign-in/email', {
        data: { email: actors[0]!.email, password: passwords[0] },
      })
    ).ok(),
  );
  await page.goto(`/token-orders/new?grantId=${grantId}`);
  await page.getByLabel('Input tokens', { exact: true }).fill(String(input.inputTokens));
  await page.getByLabel('Output tokens', { exact: true }).fill(String(input.outputTokens));
  await page.getByLabel('Maximum total price').fill('4');
  await page.getByRole('checkbox', { name: /I understand/ }).check();
  const auctionStart = Date.now();
  await page.getByRole('button', { name: 'Start 30-second auction' }).click();
  await page.waitForURL(/\/token-orders\/[a-f0-9-]+$/);
  const orderPath = new URL(page.url()).pathname,
    auctionId = orderPath.split('/').at(-1)!;
  const live = await agent.inference.orders.get(auctionId);
  assert.equal(live.order.status, 'open');
  assert.equal(live.bids.length, 1);
  assert.equal(live.bids[0]!.provider, provider);
  assert.equal(live.bids[0]!.mode, 'real');
  report.realPolicyBid = true;
  await page.goto('/orders?kind=token');
  await page.reload();
  const row = page.locator('tr').filter({ has: page.locator(`a[href="${orderPath}"]`).first() });
  await row.getByText('Pack purchased', { exact: true }).waitFor({ timeout: 45000 });
  report.auctionElapsedMs = Date.now() - auctionStart;
  const awarded = await agent.inference.orders.get(auctionId);
  assert.equal(awarded.order.status, 'awarded');
  assert.equal(awarded.pack?.mode, 'real');
  assert(
    new Date(awarded.order.closesAt).getTime() - new Date(awarded.order.createdAt).getTime() >=
      29900,
  );
  report.orderId = auctionId;
  const firstInput = provider === 'modal' ? { ...completionInput, max_tokens: 8 } : completionInput;
  const operationKey = operation(),
    spent = (await agent.inference.grant()).spentCents;
  const result = await agent.inference.complete(firstInput, { operationKey });
  assert.equal(result.broker.mode, 'real');
  assert.equal(result.broker.provider, provider);
  if (provider === 'modal') {
    assert.equal(result.choices[0]!.finish_reason, 'length');
    assert.equal(result.usage.completion_tokens, 8);
  } else assert.equal(result.choices[0]!.message.content.trim(), '7');
  assert.equal((await agent.inference.receipt(result.id)).status, 'settled');
  assert.equal((await agent.inference.grant()).spentCents, spent, 'Inference charged money twice.');
  await assert.rejects(() => agent.inference.complete(firstInput, { operationKey }), {
    status: 409,
  });
  assert.equal(attempts, 1, 'Replay dispatched another native call.');
  await assert.rejects(
    () =>
      agent.inference.complete(
        { ...completionInput, max_tokens: 513 },
        { operationKey: operation() },
      ),
    { status: 409 },
  );
  assert.equal(attempts, 1, 'Rejected allowance dispatched a native call.');
  const quote = (await agent.inference.quote(input)).items[0]!;
  await assert.rejects(
    () =>
      agent.inference.orders.create(
        { ...input, mode: 'instant', quoteId: quote.quoteId, maxTotalCents: 400 },
        { operationKey: operation() },
      ),
    { status: 409 },
  );
  const forbidden = await fetch(baseUrl + `/api/inference/grants/${grantId}/fund`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ amountCents: 100, operationKey: operation() }),
  });
  assert.equal(forbidden.status, 403);
  report.replayQuotaAndBudgetAdmission = true;
  const previous = agent;
  token = await mint();
  agent = new BrokerClient({ baseUrl, apiKey: token, requestTimeoutMs: 100000 });
  await assert.rejects(() => previous.inference.grant(), { status: 401 });
  assert.equal((await agent.inference.grant()).spentCents, spent);
  await browser(buyerCookie, `/api/inference/grants/${grantId}/fund`, 'POST', {
    amountCents: 1000,
    operationKey: operation(),
  });
  const cliQuote = (await cli(token, ['inference', 'quote', '--file', '-', '--json'], input))
    .items[0];
  const cliOrder = await cli(
    token,
    ['tokens', 'create', '--file', '-', '--operation-key', operation(), '--json'],
    { ...input, mode: 'instant', quoteId: cliQuote.quoteId, maxTotalCents: 400 },
  );
  assert.equal(cliOrder.status, 'awarded');
  const cliResult = await cli(
    token,
    ['inference', 'complete', '--file', '-', '--operation-key', operation(), '--json'],
    completionInput,
  );
  assert.equal(cliResult.broker.mode, 'real');
  assert.equal(cliResult.choices[0].message.content.trim(), '7');
  assert.equal((await agent.inference.receipt(cliResult.id)).status, 'settled');
  const peer = mcp(token);
  peers.push(peer);
  await peer.initialize();
  const mcpQuote = (await peer.tool('inference_quotes_get', { input })).items[0];
  const mcpOrder = await peer.tool('token_order_create', {
    operationKey: operation(),
    input: { ...input, mode: 'instant', quoteId: mcpQuote.quoteId, maxTotalCents: 400 },
  });
  assert.equal(mcpOrder.status, 'awarded');
  const mcpResult = await peer.tool('inference_complete', {
    operationKey: operation(),
    input: completionInput,
  });
  assert.equal(mcpResult.broker.mode, 'real');
  assert.equal(mcpResult.choices[0].message.content.trim(), '7');
  assert.equal((await peer.tool('inference_receipt_get', { id: mcpResult.id })).status, 'settled');
  await page.goto(`/agents/${grantId}`);
  await page.getByText(result.id.slice(0, 12), { exact: false }).waitFor();
  if (process.env.INFERENCE_LIVE_SCREENSHOT_DIR) {
    await mkdir(process.env.INFERENCE_LIVE_SCREENSHOT_DIR, { recursive: true });
    await page.screenshot({
      path: join(process.env.INFERENCE_LIVE_SCREENSHOT_DIR, 'buyer-real-usage.png'),
      fullPage: true,
    });
  }
  const supplier = await ui.newPage({ baseURL: baseUrl });
  const i = provider === 'baseten' ? 1 : 2;
  assert(
    (
      await supplier.request.post('/api/auth/sign-in/email', {
        data: { email: actors[i]!.email, password: passwords[i] },
      })
    ).ok(),
  );
  await supplier.goto('/provider/inference');
  await supplier
    .getByRole('cell', { name: result.broker.packId.slice(0, 12), exact: false })
    .waitFor();
  report.providerCommitmentsAndBrowserHistory = true;
  const detail = await browser<{ grant: InferenceGrant; packs: TokenOrderDetail['pack'][] }>(
    buyerCookie,
    `/api/inference/grants/${grantId}`,
  );
  for (const pack of detail.packs) {
    assert(pack);
    assert.equal(pack.heldInputTokens + pack.heldOutputTokens, 0);
    assert.equal(pack.revenueShare.commissionBps, 1500);
    assert.equal(
      BigInt(pack.revenueShare.brokerFeeMicros) + BigInt(pack.revenueShare.providerNetMicros),
      BigInt(pack.priceCents) * 10000n,
    );
  }
  assert.equal(
    detail.grant.fundedCents,
    detail.grant.availableCents +
      detail.grant.heldCents +
      detail.grant.spentCents +
      detail.grant.returnedCents,
  );
  report.clientCompletions = ['SDK', 'CLI', 'MCP'];
  report.platformAbsorbedOutputTokens = Number(
    (
      await pool.query(
        "SELECT coalesce(sum((details->>'outputTokens')::int),0)::int n FROM broker_inference_events WHERE grant_id=$1 AND kind='platform_output_absorbed'",
        [grantId],
      )
    ).rows[0].n,
  );
  if (provider === 'modal') assert((report.platformAbsorbedOutputTokens as number) >= 1);
  report.keyRotation = true;
  report.pilotCreditSpentCents = detail.grant.spentCents;
  report.noDoubleCharge = true;
  const closed = await browser<InferenceGrant>(
    buyerCookie,
    `/api/inference/grants/${grantId}/close`,
    'POST',
    { operationKey: operation() },
  );
  assert.equal(closed.status, 'closed');
  await assert.rejects(
    () => agent.inference.complete(completionInput, { operationKey: operation() }),
    { status: 409 },
  );
  assert.equal(attempts, 3);
  report.result = 'passed';
}
try {
  await main();
} catch (e) {
  report.result = 'failed';
  report.failure = e instanceof Error ? e.message : 'Unknown diagnostic failure';
  process.exitCode = 1;
} finally {
  for (const peer of peers) await peer.close();
  if (buyerCookie && app) {
    if (grantId)
      await browser(buyerCookie, `/api/inference/grants/${grantId}/close`, 'POST', {
        operationKey: operation(),
      }).catch(() => {});
    for (const id of keys) await browser(buyerCookie, `/api/keys/${id}`, 'DELETE');
  }
  if (grantId) {
    const status = (
      await pool.query('SELECT status,held_cents FROM broker_inference_grants WHERE id=$1', [
        grantId,
      ])
    ).rows[0];
    report.cleanup = {
      grantStatus: status.status,
      purchaseHoldsCents: Number(status.held_cents),
      unresolvedCalls: Number(
        (
          await pool.query(
            "SELECT count(*)::int n FROM broker_inference_requests WHERE grant_id=$1 AND status NOT IN ('settled','rejected')",
            [grantId],
          )
        ).rows[0].n,
      ),
      keysRevoked: true,
    };
    if (
      status.status !== 'closed' ||
      Number(status.held_cents) !== 0 ||
      (report.cleanup as { unresolvedCalls: number }).unresolvedCalls !== 0
    ) {
      report.cleanupIncomplete = true;
      process.exitCode = 1;
    }
  }
  await ui?.close();
  await app?.close();
  await pool.end();
  report.nativeAttempts = attempts;
  report.usage = usage;
  report.paidVmAllocations = 0;
  const output = JSON.stringify(report, null, 2);
  noSecret(output);
  if (process.env.INFERENCE_LIVE_REPORT_FILE)
    await writeFile(process.env.INFERENCE_LIVE_REPORT_FILE, output, { mode: 0o600 });
  console.log(output);
}
