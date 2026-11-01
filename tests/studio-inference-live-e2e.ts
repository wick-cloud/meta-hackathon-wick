/** Opt-in paid diagnostic: real Muse providers and one disposable native Wick VM.
 * Uses a fresh loopback database; never deploys or changes production records. */
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { Pool } from 'pg';
import { hashPassword } from 'better-auth/crypto';
import { chromium, expect, type Browser } from '@playwright/test';
import { buildApp } from '../src/server/app.js';
import { loadConfig } from '../src/server/config.js';
import { migrate, transaction } from '../src/server/db.js';
import { createWickAdapter } from '../src/server/integrations/wick.js';
import { configureProviderMarketplace } from '../src/server/marketplace/configure-real.js';
import { applyCreditEntry } from '../src/server/agreements/credits.js';
import { fixedQuote, managedPricing } from '../src/shared/pricing.js';
import { addCents } from '../src/shared/money.js';
import { INFERENCE_MODEL_ID } from '../src/shared/inference.js';
import { parseCodingResponse } from '../src/server/coding/contracts.js';
import { controlStudio, studioDetail } from '../src/server/coding/studio.js';
import { inputReservation, InferenceUpstreamError } from '../src/server/inference/runtime.js';
import type { StudioDetail, StudioTask } from '../src/shared/studio.js';
import type { Actor } from '../src/shared/types.js';

assert.equal(process.env.RUN_STUDIO_LIVE_TEST, '1', 'Explicit paid-test opt-in is required.');
const provider = process.env.STUDIO_LIVE_PROVIDER;
assert(provider === 'baseten' || provider === 'modal');
const db = new URL(process.env.STUDIO_LIVE_DATABASE_URL ?? '');
assert(['127.0.0.1', 'localhost'].includes(db.hostname));
assert(/^\/broker_studio_live_test_[a-z0-9_]+$/.test(db.pathname));
const probe = createServer();
await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
const port = (probe.address() as { port: number }).port;
await new Promise<void>((resolve, reject) =>
  probe.close((error) => (error ? reject(error) : resolve())),
);
const baseUrl = `http://127.0.0.1:${port}`;
const runId = randomUUID(),
  password = randomBytes(24).toString('base64url');
const owner: Actor = {
  id: randomUUID(),
  role: 'buyer',
  email: `studio-${runId}@test.invalid`,
  name: 'Live Studio buyer',
};
const seller: Actor = {
  id: randomUUID(),
  role: 'provider',
  email: `model-${runId}@test.invalid`,
  name: `${provider} live test seller`,
};
const computeEmail = `compute-${runId}@test.invalid`;
const config = loadConfig({
  ...process.env,
  DATABASE_URL: db.href,
  APP_URL: baseUrl,
  HOST: '127.0.0.1',
  PORT: String(port),
  NODE_ENV: 'test',
  LOG_LEVEL: 'silent',
  WICK_MODE: 'real',
  MUSE_MODE: 'real',
  INFERENCE_MARKET_MODE: 'real',
  BETTER_AUTH_SECRET: randomBytes(32).toString('base64url'),
  INFERENCE_BASETEN_PROVIDER_EMAIL:
    provider === 'baseten' ? seller.email : 'unused-baseten@test.invalid',
  INFERENCE_MODAL_PROVIDER_EMAIL: provider === 'modal' ? seller.email : 'unused-modal@test.invalid',
});
const pool = new Pool({ connectionString: db.href, max: 5 });
let built: Awaited<ReturnType<typeof buildApp>> | undefined,
  browser: Browser | undefined,
  taskId = '';
let attempts = 0;
const creates = new Set<string>(),
  nativeIds = new Set<string>();
const report: Record<string, any> = {
  provider,
  runId,
  database: db.pathname.slice(1),
  application: baseUrl,
  modelMode: 'real',
  wickMode: 'real',
  paidCallLimit: 30,
  nativeVmLimit: 1,
  pilotBudgetCents: 100,
  calls: [],
  statuses: [],
  scenario: 'real prepaid-allowance exhaustion during a small coding task',
  auxiliaryCalls: [],
};
const save = async () => {
  if (process.env.STUDIO_LIVE_REPORT_FILE)
    await writeFile(process.env.STUDIO_LIVE_REPORT_FILE, JSON.stringify(report, null, 2) + '\n', {
      mode: 0o600,
    });
};
async function api(cookie: string, path: string, method = 'GET', body?: unknown): Promise<any> {
  const response = await fetch(baseUrl + path, {
    method,
    signal: AbortSignal.timeout(20000),
    headers: {
      cookie,
      origin: baseUrl,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const value = await response.json();
  assert(response.ok, `${method} ${path}: HTTP ${response.status}; ${value.error ?? ''}`);
  return value;
}
async function login(actor: Actor) {
  const response = await fetch(baseUrl + '/api/auth/sign-in/email', {
    method: 'POST',
    signal: AbortSignal.timeout(15000),
    headers: { origin: baseUrl, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: actor.email, password }),
  });
  assert.equal(response.status, 200);
  return response.headers
    .getSetCookie()
    .map((c) => c.split(';')[0])
    .join('; ');
}
try {
  assert.equal(
    (
      await pool.query(
        "SELECT count(*)::int n FROM information_schema.tables WHERE table_schema='public'",
      )
    ).rows[0].n,
    0,
    'Use a fresh dedicated database.',
  );
  await migrate(pool);
  for (const actor of [owner, seller]) {
    await pool.query(
      'INSERT INTO "user"(id,email,name,role,"emailVerified") VALUES($1,$2,$3,$4,true)',
      [actor.id, actor.email, actor.name, actor.role],
    );
    await pool.query(
      'INSERT INTO account(id,"accountId","providerId","userId",password) VALUES($1,$2,\'credential\',$2,$3)',
      [randomUUID(), actor.id, await hashPassword(password)],
    );
  }
  const modelSeller = (
    await pool.query(
      'INSERT INTO broker_providers(user_id,name,total_capacity,policy,simulated) VALUES($1,$2,0,$3,false) RETURNING id',
      [seller.id, seller.name, { autoBid: false }],
    )
  ).rows[0];
  seller.providerId = modelSeller.id;
  await pool.query('UPDATE "user" SET "providerId"=$2 WHERE id=$1', [seller.id, modelSeller.id]);
  const native = createWickAdapter(config, pool);
  const catalog = (await native.catalog())
    .filter(
      (c) =>
        config.studioApprovedComputeCatalogIds.includes(c.id) &&
        c.provider === 'e2b' &&
        c.durationMinutes.includes(15) &&
        !c.gpu &&
        fixedQuote(managedPricing(c), 15).totalPriceCents <= 10,
    )
    .sort(
      (a, b) =>
        fixedQuote(managedPricing(a), 15).totalPriceCents -
        fixedQuote(managedPricing(b), 15).totalPriceCents,
    );
  assert(
    catalog[0],
    'Set STUDIO_APPROVED_COMPUTE_CATALOG_IDS to an execution-qualified low-cost E2B route for this bounded test.',
  );
  await configureProviderMarketplace(pool, catalog, {
    providers: [
      {
        cloudProvider: 'e2b',
        name: 'Live test E2B compute',
        email: computeEmail,
        password,
        catalogIds: [catalog[0].id],
        capacity: 1,
        autoBid: true,
      },
    ],
    retireSupplierEmails: [],
  });
  await transaction(pool, (client) =>
    applyCreditEntry(client, owner.id, {
      operationKey: randomUUID(),
      kind: 'grant',
      balanceDeltaCents: 100,
      reservedDeltaCents: 0,
      description: 'Disposable live-test pilot credit',
    }),
  );
  built = await buildApp(config, {
    wrapWick: (adapter) => ({
      ...adapter,
      async create(input, key) {
        assert(
          creates.has(key) || creates.size < 1,
          'Only one logical native VM allocation is allowed.',
        );
        creates.add(key);
        const result = await adapter.create(input, key);
        nativeIds.add(result.environment.id);
        report.nativeEnvironmentIds = [...nativeIds];
        await save();
        return result;
      },
    }),
    wrapInference: (runtime) => ({
      ...runtime,
      async dispatch(route, input, id, options) {
        assert.equal(route.provider, provider);
        assert.equal(route.mode, 'real');
        if (attempts >= 30) throw new InferenceUpstreamError('diagnostic_call_limit', true);
        attempts++;
        const start = Date.now(),
          result = await runtime.dispatch(route, input, id, options);
        assert(result.inputTokens <= inputReservation(route, input));
        assert(result.outputTokens <= input.max_tokens);
        report.calls.push({
          requestId: id,
          provider: route.provider,
          inputTokens: result.inputTokens,
          outputTokens: result.outputTokens,
          reservedInput: inputReservation(route, input),
          reservedOutput: input.max_tokens,
          finishReason: result.finishReason,
          elapsedMs: Date.now() - start,
          action: parseCodingResponse(result.content)?.action ?? null,
          jsonMode: options?.jsonObject === true,
        });
        await save();
        return result;
      },
    }),
  });
  await built.app.listen({ host: '127.0.0.1', port });
  const buyerCookie = await login(owner),
    sellerCookie = await login(seller);
  const offering = (await api(sellerCookie, '/api/provider/inference/offering')).offering;
  await api(sellerCookie, '/api/provider/inference/offering', 'PUT', {
    operationKey: randomUUID(),
    expectedRevision: offering.revision,
    active: true,
    autoBid: true,
    inputRateMicrosPerMillion: 1700000,
    outputRateMicrosPerMillion: 5600000,
    instantMarkupBps: 1000,
    minimumPriceCents: 1,
    maxOutstandingInputTokens: 1000000,
    maxOutstandingOutputTokens: 100000,
  });
  const started = (await api(buyerCookie, '/api/studio/tasks', 'POST', {
    operationKey: randomUUID(),
    repositoryUrl: 'https://github.com/octocat/Hello-World',
    durationMinutes: 15,
    budgetCents: 100,
    allowInstant: false,
    goal: 'Add broker_greeting.py with greet(name): trim surrounding whitespace and return "Hello, NAME!" using that name. Raise ValueError for empty or whitespace-only input. Add broker_tests/test_greeting.py with stdlib unittest coverage for a normal name, trimming, and empty input. Run the supplied test command and return the verified patch.',
    testCommand: 'python3 -m unittest discover -s broker_tests',
  })) as StudioTask;
  taskId = started.id;
  report.taskId = taskId;
  await save();
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ baseURL: baseUrl, viewport: { width: 1440, height: 1000 } });
  await page.request.post('/api/auth/sign-in/email', { data: { email: owner.email, password } });
  await page.goto('/studio/tasks/' + taskId);
  let detail: StudioDetail | undefined;
  let loadApplied = false;
  for (const deadline = Date.now() + 13 * 60000; Date.now() < deadline;) {
    detail = await api(buyerCookie, '/api/studio/tasks/' + taskId);
    if (!loadApplied && detail!.task.status === 'compute_auction') {
      loadApplied = true;
      const grantId = (
        await pool.query('SELECT grant_id FROM broker_studio_tasks WHERE id=$1', [taskId])
      ).rows[0].grant_id;
      const issued = await api(buyerCookie, `/api/inference/grants/${grantId}/keys`, 'POST', {
        name: 'Disposable metered load',
      });
      const before = detail!.task.modelChargedCents;
      // Consume actual prepaid quota through the authenticated public gateway.
      // This forces a refill without modifying balances, usage or auction deadlines.
      for (let call = 0; call < 8; call++) {
        const balance = await api(buyerCookie, `/api/inference/grants/${grantId}`);
        const remaining = balance.packs.reduce(
          (n: number, p: any) => n + (p.status === 'active' ? p.availableOutputTokens : 0),
          0,
        );
        if (remaining < 256) break;
        const response = await fetch(baseUrl + '/api/v1/chat/completions', {
          method: 'POST',
          signal: AbortSignal.timeout(100000),
          headers: { Authorization: `Bearer ${issued.token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            operationKey: randomUUID(),
            model: INFERENCE_MODEL_ID,
            messages: [
              {
                role: 'system',
                content:
                  'Reasoning strength: 8.\nFollow the user request literally. Do not shorten, summarize, omit items, use ranges, or abbreviate the requested numbered list. Output the requested full list.',
              },
              {
                role: 'user',
                content:
                  'Print a numbered list of the integers 1 through 3000, one integer per line. Continue until the output limit.',
              },
            ],
            max_tokens: Math.min(2048, remaining),
          }),
        });
        const value = await response.json();
        assert(response.ok, `Metered load: HTTP ${response.status}; ${value.error?.code ?? ''}`);
        report.auxiliaryCalls.push({
          requestId: value.id,
          input: value.usage.prompt_tokens,
          output: value.usage.completion_tokens,
        });
      }
      const balance = await api(buyerCookie, `/api/inference/grants/${grantId}`);
      report.usableOutputAfterLoad = balance.packs.reduce(
        (n: number, p: any) => n + (p.status === 'active' ? p.availableOutputTokens : 0),
        0,
      );
      assert.equal(
        (await api(buyerCookie, '/api/studio/tasks/' + taskId)).task.modelChargedCents,
        before,
        'Inference consumes quota without a second monetary charge.',
      );
      await save();
    }
    const last = report.statuses.at(-1);
    if (last?.status !== detail!.task.status) {
      report.statuses.push({ status: detail!.task.status, at: new Date().toISOString() });
      console.log(
        JSON.stringify({
          provider,
          status: detail!.task.status,
          calls: attempts,
          purchases: detail!.modelPurchases.length,
          spentCents: detail!.task.spentCents,
        }),
      );
      await save();
    }
    if (
      ['completed', 'failed', 'stopped', 'needs_attention', 'needs_budget'].includes(
        detail!.task.status,
      )
    )
      break;
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  report.final = detail?.task;
  report.usage = detail?.usage;
  assert.equal(
    detail?.task.status,
    'completed',
    detail?.task.blockedReason ?? 'Task did not complete.',
  );
  assert(detail.task.executionStartedAt && detail.task.verifiedAt && detail.task.completedAt);
  assert(detail.vm?.cleanupConfirmedAt);
  assert.equal(detail.tests?.exitCode, 0);
  assert.match(detail.patch ?? '', /broker_greeting\.py/);
  assert((detail.patch ?? '').includes('broker_tests/test_greeting.py'));
  assert(detail.modelActivity.every((r) => r.provider === provider && r.status === 'settled'));
  assert.equal(detail.task.reservedCents, 0);
  assert.equal(detail.task.availableCents, 0);
  assert.equal(addCents(detail.task.spentCents, detail.task.returnedCents), 100);
  assert.equal(nativeIds.size, 1);
  assert.equal(
    detail.task.deadlineAt,
    started.deadlineAt,
    'Refills never extend the task deadline.',
  );
  const orders = (
    await built.ctx.pool.query(
      'SELECT input_tokens,output_tokens,created_at,closes_at,status,provider,price_cents FROM broker_token_orders WHERE grant_id=(SELECT grant_id FROM broker_studio_tasks WHERE id=$1) ORDER BY created_at,id',
      [taskId],
    )
  ).rows;
  assert(
    orders.every(
      (o) =>
        o.status === 'awarded' &&
        o.provider === provider &&
        +new Date(o.closes_at) - +new Date(o.created_at) >= 29900,
    ),
  );
  const first = (
    await built.ctx.pool.query(
      'SELECT * FROM broker_studio_usage_estimates WHERE task_id=$1 ORDER BY purchase_round LIMIT 1',
      [taskId],
    )
  ).rows[0];
  assert.equal(
    first.input_tokens,
    Math.max(Math.ceil((first.forecast.expectedInput * 110) / 100), first.input_floor),
  );
  assert.equal(
    first.output_tokens,
    Math.max(Math.ceil((first.forecast.expectedOutput * 110) / 100), first.output_floor),
  );
  assert(first.input_tokens < 100000, 'No full-context pack should be purchased.');
  report.orders = orders;
  assert.equal(detail.task.modelChargedCents, addCents(...orders.map((o) => o.price_cents)));
  report.firstEstimate = {
    forecast: first.forecast,
    inputTokens: first.input_tokens,
    outputTokens: first.output_tokens,
    inputFloor: first.input_floor,
    outputFloor: first.output_floor,
  };
  report.refills = orders.length - 1;
  assert(report.refills > 0, 'This workload should exercise a real demand-triggered refill.');
  report.nativeDeletionAcknowledged = true;
  await page.reload();
  await expect(page.getByText('Initial +10%', { exact: true })).toBeVisible();
  if (process.env.STUDIO_LIVE_SCREENSHOT_FILE)
    await page.screenshot({ path: process.env.STUDIO_LIVE_SCREENSHOT_FILE, fullPage: true });
  report.result = 'passed';
  console.log(
    JSON.stringify({
      provider,
      result: 'passed',
      calls: attempts,
      purchases: orders.length,
      modelChargedCents: detail.task.modelChargedCents,
      computeChargedCents: detail.task.computeChargedCents,
      refills: report.refills,
    }),
  );
} catch (error) {
  report.result = 'failed';
  report.error = error instanceof Error ? error.message : 'Unknown failure';
  throw error;
} finally {
  await browser?.close();
  if (taskId && built) {
    await controlStudio(built.ctx, owner, taskId, 'stop', {}).catch(() => {});
    for (const until = Date.now() + 180000; Date.now() < until;) {
      const d = await studioDetail(built.ctx, owner, taskId);
      if (!d.vm || d.vm.cleanupConfirmedAt) {
        report.cleanupConfirmed = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  }
  await save();
  await built?.app.close();
  await pool.end();
}
