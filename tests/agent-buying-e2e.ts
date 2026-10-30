/** Actual local HTTP, auth, packaged SDK, Postgres and PgBoss. No paid upstream calls. */
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { hashPassword } from 'better-auth/crypto';
import { BrokerClient } from '@wick-cloud/broker-sdk';
import { buildApp } from '../src/server/app.js';
import { loadConfig } from '../src/server/config.js';
import { migrate } from '../src/server/db.js';
import { createWickAdapter } from '../src/server/integrations/wick.js';
import { seedMarketplace } from '../src/server/marketplace/index.js';
import { applyCreditEntry } from '../src/server/agreements/credits.js';
import { transaction } from '../src/server/marketplace/db.js';
import type { Actor } from '../src/shared/types.js';
import type { BuyingPolicy, BuyingWorkspace } from '../src/shared/buying.js';
import type { InferenceGrant } from '../src/shared/inference.js';

const connectionString = process.env.BUYING_E2E_DATABASE_URL!;
const database = new URL(connectionString);
assert(['localhost', '127.0.0.1'].includes(database.hostname));
assert.equal(database.pathname, '/broker_buying_e2e_test');
const port = 3349,
  baseUrl = `http://127.0.0.1:${port}`;
const config = loadConfig({
  NODE_ENV: 'test',
  PORT: String(port),
  HOST: '127.0.0.1',
  APP_URL: baseUrl,
  DATABASE_URL: connectionString,
  BETTER_AUTH_SECRET: randomBytes(32).toString('base64url'),
  WICK_MODE: 'fixture',
  MUSE_MODE: 'fixture',
  INFERENCE_MARKET_MODE: 'fixture',
  LOG_LEVEL: 'silent',
});
const pool = new Pool({ connectionString, max: 5 });
const runId = randomUUID(),
  password = randomBytes(24).toString('base64url');
const actors: Actor[] = ['buyer', 'provider', 'provider'].map((role, i) => ({
  id: randomUUID(),
  name: `Autopilot fixture ${i}`,
  role: role as Actor['role'],
  email: `buying-${i}-${runId}@fixture.invalid`,
}));
let app: Awaited<ReturnType<typeof buildApp>>['app'] | undefined,
  cookie = '',
  grantId = '';
let policy: BuyingPolicy;
const started = Date.now();
const emit = (step: string, extra: Record<string, unknown> = {}) =>
  console.log(
    JSON.stringify({ step, elapsedSeconds: Math.round((Date.now() - started) / 1000), ...extra }),
  );
async function owner<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  const response = await fetch(baseUrl + path, {
    method,
    headers: { cookie, Origin: baseUrl, 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(15000),
  });
  const value = await response.json();
  assert(response.ok, `${method} ${path}: ${response.status} ${value.code}`);
  return value as T;
}
async function waitFor<T>(
  label: string,
  read: () => Promise<T>,
  done: (value: T) => boolean,
  timeout = 130000,
): Promise<T> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await read();
    if (done(value)) return value;
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`Timed out: ${label}`);
}
async function savePolicy(paused: boolean) {
  policy = await owner<BuyingPolicy>(`/api/inference/grants/${grantId}/buying`, 'PUT', {
    operationKey: randomUUID(),
    expectedRevision: policy?.revision ?? 0,
    mode: 'automatic',
    paused,
    maxPurchaseCents: 20,
    outputPerCall: 512,
    targetCalls: 1,
    refillAtCalls: 0,
    allowInstant: true,
  });
}
const task = {
  model: 'meta/muse-spark-open' as const,
  messages: [{ role: 'user' as const, content: 'Summarize a release note in one sentence.' }],
  max_tokens: 512,
};
try {
  await migrate(pool);
  assert.equal(
    Number((await pool.query('SELECT count(*) n FROM "user"')).rows[0].n),
    0,
    'Use a fresh disposable database.',
  );
  for (const actor of actors) {
    await pool.query(
      'INSERT INTO "user"(id,email,name,role,"emailVerified") VALUES($1,$2,$3,$4,true)',
      [actor.id, actor.email, actor.name, actor.role],
    );
    await pool.query(
      `INSERT INTO account(id,"accountId","providerId","userId",password) VALUES($1,$2,'credential',$2,$3)`,
      [randomUUID(), actor.id, await hashPassword(password)],
    );
  }
  await seedMarketplace(pool, actors, await createWickAdapter(config, pool).catalog(), 'fixture');
  await pool.query(
    'UPDATE "user" u SET "providerId"=p.id::text FROM broker_providers p WHERE p.user_id=u.id',
  );
  await transaction(pool, (db) =>
    applyCreditEntry(db, actors[0].id, {
      operationKey: runId,
      kind: 'grant',
      balanceDeltaCents: 100,
      reservedDeltaCents: 0,
      description: 'Disposable local test funding',
    }),
  );
  app = (await buildApp(config)).app;
  await app.listen({ host: '127.0.0.1', port });
  const login = await fetch(baseUrl + '/api/auth/sign-in/email', {
    method: 'POST',
    headers: { Origin: baseUrl, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: actors[0].email, password }),
  });
  assert.equal(login.status, 200);
  cookie = login.headers
    .getSetCookie()
    .map((c) => c.split(';')[0])
    .join('; ');
  const grant = await owner<InferenceGrant>('/api/inference/grants', 'POST', {
    operationKey: randomUUID(),
    name: 'Release-note agent',
    budgetCents: 100,
    maxPurchaseCents: 20,
  });
  grantId = grant.id;
  const key = await owner<{ token: string }>(`/api/inference/grants/${grantId}/keys`, 'POST', {});
  let agent = new BrokerClient({ baseUrl, apiKey: key.token });
  assert.equal((await agent.inference.grant()).availableCents, 100);
  for (const path of [
    `/api/inference/grants/${grantId}/fund`,
    `/api/inference/grants/${grantId}/buying/evaluate`,
    '/api/requests',
    '/api/muse/translate',
  ]) {
    const response = await fetch(baseUrl + path, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key.token}`, 'Content-Type': 'application/json' },
      body: '{}',
    });
    assert.equal(response.status, 403, path);
  }
  emit('restricted agent connected', { ownerFundingCents: 100, unauthorizedActionsBlocked: 4 });
  await savePolicy(false);
  const workspace = () => owner<BuyingWorkspace>(`/api/inference/grants/${grantId}/buying`);
  const first = await waitFor('automatic auction', workspace, (w) =>
    w.decisions.some((d) => d.status === 'ordered'),
  );
  const orderId = first.decisions.find((d) => d.status === 'ordered')!.orderId!;
  const bidding = await agent.inference.orders.get(orderId);
  assert.equal(bidding.order.outputTokens, 512);
  assert.equal(bidding.bids.length, 2);
  assert.equal(Date.parse(bidding.order.closesAt) - Date.parse(bidding.order.createdAt), 30000);
  emit('automatic 30-second auction', {
    providers: bidding.bids.map((b) => b.provider),
    inputTokens: bidding.order.inputTokens,
    outputTokens: 512,
  });
  const winResult = await agent.inference.orders.wait(orderId, {
    timeoutMs: 45000,
    pollIntervalMs: 1000,
  });
  assert.equal(winResult.state, 'complete');
  const won = winResult.resource!;
  assert.equal(won.order.status, 'awarded');
  assert(won.pack);
  assert.equal(won.pack.expiresAt, grant.expiresAt);
  const balance = await agent.inference.grant();
  assert.equal(balance.heldCents, 0);
  emit('auction awarded', { provider: won.pack.provider, priceCents: won.pack.priceCents });
  const op = randomUUID();
  const answer = await agent.inference.complete(task, { operationKey: op });
  assert(answer.choices[0].message.content);
  assert.equal((await agent.inference.receipt(answer.id)).status, 'settled');
  assert.equal((await agent.inference.grant()).spentCents, balance.spentCents);
  await assert.rejects(() => agent.inference.complete(task, { operationKey: op }), {
    status: 409,
    code: 'completed_without_result',
  });
  emit('agent task completed', {
    answer: answer.choices[0].message.content,
    usage: answer.usage,
    noSecondCharge: true,
    replayBlocked: true,
  });
  // Let the real minute scheduler replenish consumed allowance; never edit deadlines or invoke worker functions directly.
  const second = await waitFor(
    'automatic refill',
    workspace,
    (w) => w.decisions.some((d) => d.status === 'ordered' && d.orderId !== orderId),
    150000,
  );
  const refillId = second.decisions.find(
    (d) => d.status === 'ordered' && d.orderId !== orderId,
  )!.orderId!;
  const refillResult = await agent.inference.orders.wait(refillId, {
    timeoutMs: 45000,
    pollIntervalMs: 1000,
  });
  assert.equal(refillResult.state, 'complete');
  const refill = refillResult.resource!;
  assert.equal(refill.order.status, 'awarded');
  emit('automatic refill awarded', {
    provider: refill.pack!.provider,
    priceCents: refill.pack!.priceCents,
  });
  await savePolicy(true);
  const pausedPolicy = (await workspace()).policy!;
  assert.equal(pausedPolicy.paused, true);
  await agent.inference.complete(task, { operationKey: randomUUID() });
  const priorCount = Number(
    (await pool.query('SELECT count(*) n FROM broker_token_orders WHERE grant_id=$1', [grantId]))
      .rows[0].n,
  );
  const grantAfterPause = await agent.inference.grant();
  // Owner pause stops the autopilot. Explicit agent purchases remain subject to the original grant.
  await new Promise((r) => setTimeout(r, 65000));
  assert.equal(
    Number(
      (await pool.query('SELECT count(*) n FROM broker_token_orders WHERE grant_id=$1', [grantId]))
        .rows[0].n,
    ),
    priorCount,
  );
  assert.equal((await agent.inference.grant()).spentCents, grantAfterPause.spentCents);
  emit('pause held across the next worker cycle', { orderCount: priorCount });
  const amounts = { inputTokens: 1000, outputTokens: 512 };
  await assert.rejects(
    () =>
      agent.inference.orders.create(
        { ...amounts, mode: 'auction', maxTotalCents: 21 },
        { operationKey: randomUUID() },
      ),
    { status: 409 },
  );
  const quote = (await agent.inference.quote(amounts)).items[0];
  assert(quote);
  const instant = await agent.inference.orders.create(
    { ...amounts, mode: 'instant', quoteId: quote.quoteId, maxTotalCents: 20 },
    { operationKey: randomUUID() },
  );
  assert.equal(instant.status, 'awarded');
  await agent.inference.complete(task, { operationKey: randomUUID() });
  const replaced = await owner<{ token: string }>(
    `/api/inference/grants/${grantId}/keys`,
    'POST',
    {},
  );
  await assert.rejects(() => agent.inference.grant(), { status: 401 });
  agent = new BrokerClient({ baseUrl, apiKey: replaced.token });
  const after = await agent.inference.grant();
  assert.equal(
    after.fundedCents,
    after.availableCents + after.heldCents + after.spentCents + after.returnedCents,
  );
  emit('manual instant purchase and rotation passed', {
    spentCents: after.spentCents,
    remainingCents: after.availableCents,
    overBudgetBlocked: true,
  });
  await owner(`/api/inference/grants/${grantId}/close`, 'POST', { operationKey: randomUUID() });
  await assert.rejects(() => agent.inference.complete(task, { operationKey: randomUUID() }), {
    status: 409,
  });
  assert.equal((await workspace()).policy!.paused, true);
  emit('passed', {
    modes: { muse: 'fixture', inference: 'fixture' },
    actualHttp: true,
    actualMinuteScheduler: true,
    paidRequests: 0,
  });
} finally {
  if (app && cookie && grantId)
    await owner(`/api/inference/grants/${grantId}/close`, 'POST', {
      operationKey: randomUUID(),
    }).catch(() => {});
  await app?.close();
  await pool.end();
}
