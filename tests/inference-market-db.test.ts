import {
  buyingWorkspace,
  saveBuyingPolicy,
  evaluateBuying,
  acceptBuying,
  maintainBuying,
  listAgents,
  purchaseReceipt,
} from '../src/server/inference/buying.js';
import { FIXTURE_BUYING_INPUT_BOUND } from '../src/server/inference/buying-guard.js';
import { proposeTokenSupply } from '../src/server/inference/supply.js';
import { createMuseAdapter } from '../src/server/integrations/muse.js';
import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import { Pool } from 'pg';
import { hashPassword } from 'better-auth/crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { migrate } from '../src/server/db.js';
import { loadConfig } from '../src/server/config.js';
import {
  createAuth,
  createRequireActor,
  registerAuth,
  registerBrokerKeyAccess,
} from '../src/server/auth.js';
import { HttpError, type AppContext } from '../src/server/context.js';
import type { Actor } from '../src/shared/types.js';
import { INFERENCE_MODEL_ID } from '../src/shared/inference.js';
import {
  createInferenceRuntime,
  dispatchReal,
  fixtureInputTokens,
  InferenceUpstreamError,
} from '../src/server/inference/runtime.js';
import {
  createGrant,
  closeGrant,
  fundGrant,
  issueGrantKey,
  grantDetail,
  listGrants,
  scopedPacks,
} from '../src/server/inference/grants.js';
import {
  createTokenOrder,
  closeTokenAuction,
  initializeInference,
  quotes,
  tokenOrderDetail,
  cancelTokenOrder,
  retirePackLocked,
  updateOffering,
} from '../src/server/inference/market.js';
import {
  complete,
  receipt,
  recoverRequest,
  resolveRequest,
  settleRequest,
} from '../src/server/inference/gateway.js';
import { registerInference, maintainInference } from '../src/server/inference/index.js';
import { transaction } from '../src/server/marketplace/db.js';
import { applyCreditEntry, creditWalletView } from '../src/server/agreements/credits.js';
import { listOrders, ORDERS_QUERY, registerOrders } from '../src/server/orders.js';
import { registerOpenApi } from '../src/server/openapi.js';
import { BrokerClient } from '../packages/sdk/src/index.js';
import { registerDeveloperKeys } from '../src/server/developer-keys.js';
import { issuePackKey } from '../src/server/inference/pack-access.js';
import { PACK_ACTIVE_PREDICATE, PACK_VIEW_COLUMNS } from '../src/server/inference/data.js';

const url = process.env.TEST_DATABASE_URL;
describe.skipIf(!url)(
  'funded inference marketplace (disposable PostgreSQL, no paid providers)',
  () => {
    const schema = `inference_${randomUUID().replaceAll('-', '')}`,
      origin = 'http://localhost:3000';
    const owner: Actor = {
      id: randomUUID(),
      role: 'buyer',
      name: 'Owner',
      email: 'owner@tokens.invalid',
    };
    const other: Actor = {
      id: randomUUID(),
      role: 'buyer',
      name: 'Other owner',
      email: 'other@tokens.invalid',
    };
    const operator: Actor = {
      id: randomUUID(),
      role: 'admin',
      name: 'Operator',
      email: 'admin@tokens.invalid',
    };
    const providers: Actor[] = [0, 1].map((i) => ({
      id: randomUUID(),
      role: 'provider',
      name: `Provider ${i}`,
      email: `p${i}@tokens.invalid`,
    }));
    let admin: Pool,
      pool: Pool,
      ctx: AppContext,
      app: FastifyInstance,
      cookie: string,
      baseUrl: string;
    const call = {
      model: INFERENCE_MODEL_ID,
      messages: [{ role: 'user' as const, content: 'Hello' }],
      max_tokens: 64,
    };
    const inputBound = fixtureInputTokens(call);
    async function grant(budgetCents = 1000) {
      return createGrant(ctx, owner, {
        operationKey: randomUUID(),
        name: 'Agent task',
        budgetCents,
      });
    }
    async function agent(grantId: string) {
      const issued = await issueGrantKey(ctx, owner, grantId, {});
      return {
        actor: {
          ...owner,
          apiKey: { id: issued.key.id, grantId, scopes: issued.key.scopes, limits: {} },
        } as Actor,
        ...issued,
      };
    }
    async function buy(grantId: string, quantities = { inputTokens: 10000, outputTokens: 1000 }) {
      const quote = (await quotes(ctx, owner, { grantId, ...quantities })).items[0];
      expect(quote).toBeDefined();
      const order = await createTokenOrder(ctx, owner, {
        ...quantities,
        grantId,
        mode: 'instant',
        quoteId: quote.quoteId,
        maxTotalCents: quote.priceCents,
        operationKey: randomUUID(),
      });
      return (await tokenOrderDetail(ctx, owner, order.id)).pack!;
    }
    beforeAll(async () => {
      admin = new Pool({ connectionString: url });
      await admin.query(`CREATE SCHEMA ${schema}`);
      pool = new Pool({
        connectionString: url,
        max: 16,
        options: `-c search_path=${schema},public`,
      });
      await migrate(pool);
      for (const actor of [owner, other, operator, ...providers]) {
        await pool.query(
          'INSERT INTO "user"(id,email,name,role,"emailVerified") VALUES($1,$2,$3,$4,true)',
          [actor.id, actor.email, actor.name, actor.role],
        );
      }
      await pool.query(
        `INSERT INTO account(id,"accountId","providerId","userId",password) VALUES($1,$2,'credential',$2,$3)`,
        [randomUUID(), owner.id, await hashPassword('fixture-token-password-123')],
      );
      for (const provider of providers) {
        const row = (
          await pool.query(
            'INSERT INTO broker_providers(user_id,name,total_capacity,policy) VALUES($1,$2,5,$3) RETURNING id',
            [provider.id, provider.name, { autoBid: false }],
          )
        ).rows[0];
        provider.providerId = row.id;
        await pool.query('UPDATE "user" SET "providerId"=$2 WHERE id=$1', [provider.id, row.id]);
      }
      const config = loadConfig({
        DATABASE_URL: url!,
        APP_URL: origin,
        NODE_ENV: 'test',
        WICK_MODE: 'fixture',
        MUSE_MODE: 'fixture',
        INFERENCE_MARKET_MODE: 'fixture',
        BETTER_AUTH_SECRET: 'fixture-token-market-secret-at-least-32-characters',
      });
      const auth = createAuth(config, pool);
      ctx = {
        config,
        pool,
        boss: { send: vi.fn(async () => randomUUID()) },
        wick: { mode: 'fixture' },
        muse: { mode: 'fixture' },
        inference: await createInferenceRuntime(config),
        requireActor: createRequireActor(auth, pool),
      } as unknown as AppContext;
      app = Fastify({ logger: false });
      app.setErrorHandler((error, _r, reply) => {
        const e = error as HttpError & { code?: string; inferenceRequestId?: string };
        return reply
          .code(e.statusCode ?? (e.name === 'ZodError' ? 400 : 500))
          .send({ error: e.message, code: e.code, inferenceRequestId: e.inferenceRequestId });
      });
      registerBrokerKeyAccess(app, ctx.requireActor);
      await registerAuth(app, auth, config);
      await registerInference(app, ctx);
      await registerDeveloperKeys(app, ctx);
      registerOrders(app, ctx);
      registerOpenApi(app);
      for (const path of ['/api/requests', '/api/muse/translate'])
        app.post(path, async (r) => {
          await ctx.requireActor(r);
          return { shouldNeverBeAccessibleToAgent: true };
        });
      await app.listen({ host: '127.0.0.1', port: 0 });
      const address = app.server.address();
      if (!address || typeof address === 'string') throw Error();
      baseUrl = `http://127.0.0.1:${address.port}`;
      const login = await app.inject({
        method: 'POST',
        url: '/api/auth/sign-in/email',
        headers: { origin },
        payload: { email: owner.email, password: 'fixture-token-password-123' },
      });
      expect(login.statusCode).toBe(200);
      cookie = login.cookies.map((c) => `${c.name}=${c.value}`).join('; ');
    });
    beforeEach(async () => {
      await pool.query(
        'TRUNCATE broker_inference_grants,broker_inference_routes,broker_credit_wallets,broker_operation_receipts CASCADE',
      );
      ctx.inference = await createInferenceRuntime(ctx.config);
      ctx.muse = createMuseAdapter({ museMode: 'fixture' });
      await initializeInference(ctx);
      for (const actor of [owner, other])
        await transaction(pool, (db) =>
          applyCreditEntry(db, actor.id, {
            operationKey: randomUUID(),
            kind: 'grant',
            balanceDeltaCents: 5000,
            reservedDeltaCents: 0,
            description: 'Disposable test credit',
          }),
        );
    });
    afterAll(async () => {
      await app?.close();
      await pool?.end();
      if (admin) {
        await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
        await admin.end();
      }
    });

    async function buyingPolicy(grantId: string, extra: Record<string, unknown> = {}) {
      return saveBuyingPolicy(ctx, owner, grantId, {
        operationKey: randomUUID(),
        expectedRevision: 0,
        mode: 'review',
        paused: false,
        maxPurchaseCents: 20,
        outputPerCall: 512,
        targetCalls: 1,
        refillAtCalls: 1,
        allowInstant: false,
        ...extra,
      });
    }
    it('defaults new grants to two hours and keeps buying policies owner-only', async () => {
      const g = await grant();
      expect(Date.parse(g.expiresAt) - Date.parse(g.createdAt)).toBeGreaterThan(7199000);
      expect(Date.parse(g.expiresAt) - Date.parse(g.createdAt)).toBeLessThanOrEqual(7200000);
      const key = await agent(g.id);
      await expect(saveBuyingPolicy(ctx, key.actor, g.id, {})).rejects.toMatchObject({
        statusCode: 403,
      });
      await expect(buyingWorkspace(ctx, other, g.id)).rejects.toMatchObject({ statusCode: 404 });
      await buyingPolicy(g.id);
      const denied = await app.inject({
        method: 'POST',
        url: `/api/inference/grants/${g.id}/buying/evaluate`,
        headers: { authorization: `Bearer ${key.token}` },
        payload: {},
      });
      expect(denied.statusCode).toBe(403);
    });
    it('reviews a bounded recommendation, commits once under concurrency, and captures a comparable receipt', async () => {
      const g = await grant();
      await buyingPolicy(g.id);
      const recommendation = await evaluateBuying(ctx, owner, g.id);
      expect(recommendation.status).toBe('recommended');
      expect(recommendation.mode).toBe('fixture');
      expect(recommendation.modelCalled).toBe(false);
      expect(recommendation.baseline?.inputTokens).toBe(recommendation.candidate?.inputTokens);
      const orders = await Promise.all([
        acceptBuying(ctx, owner, g.id, recommendation.id),
        acceptBuying(ctx, owner, g.id, recommendation.id),
      ]);
      expect(orders[0].id).toBe(orders[1].id);
      expect((await grantDetail(ctx, owner, g.id)).grant.heldCents).toBe(20);
      await pool.query(
        "UPDATE broker_token_orders SET closes_at=clock_timestamp()-interval '1 second' WHERE id=$1",
        [orders[0].id],
      );
      await closeTokenAuction(ctx, orders[0].id);
      const detail = await tokenOrderDetail(ctx, owner, orders[0].id);
      expect(detail.order.status).toBe('awarded');
      expect(detail.pack).not.toBeNull();
      const agentKey = await agent(g.id);
      const completion = await complete(ctx, agentKey.actor, {
        ...call,
        operationKey: randomUUID(),
        max_tokens: 512,
      });
      expect(completion.choices[0].message.content).toBeTruthy();
      expect(completion.usage.prompt_tokens).toBeLessThan(FIXTURE_BUYING_INPUT_BOUND);
      expect((await purchaseReceipt(ctx, owner, orders[0].id)).decision?.id).toBe(
        recommendation.id,
      );
      expect(
        (
          await pool.query('SELECT count(*)::int n FROM broker_token_orders WHERE grant_id=$1', [
            g.id,
          ])
        ).rows[0].n,
      ).toBe(1);
    });
    it('invalidates recommendations on pause or policy revision and rejects stale acceptance', async () => {
      const g = await grant();
      await buyingPolicy(g.id);
      const d = await evaluateBuying(ctx, owner, g.id);
      await buyingPolicy(g.id, { expectedRevision: 1, paused: true });
      await expect(acceptBuying(ctx, owner, g.id, d.id)).rejects.toMatchObject({
        code: 'recommendation_changed',
      });
      expect((await grantDetail(ctx, owner, g.id)).grant.heldCents).toBe(0);
      const h = await grant();
      await buyingPolicy(h.id);
      const expired = await evaluateBuying(ctx, owner, h.id);
      await pool.query(
        "UPDATE broker_inference_buying_decisions SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",
        [expired.id],
      );
      await expect(acceptBuying(ctx, owner, h.id, expired.id)).rejects.toMatchObject({
        code: 'recommendation_changed',
      });
    });
    it('automatic workers share a durable claim and never make concurrent duplicate purchases', async () => {
      const g = await grant();
      await buyingPolicy(g.id, { mode: 'automatic' });
      await Promise.all([maintainBuying(ctx), maintainBuying(ctx)]);
      const data = await buyingWorkspace(ctx, owner, g.id);
      expect(data.policy?.modelCalls).toBe(1);
      expect(data.decisions).toHaveLength(1);
      expect(data.decisions[0].status).toBe('ordered');
      expect(data.allowance.pendingOrders).toBe(1);
      await maintainBuying(ctx);
      expect((await grantDetail(ctx, owner, g.id)).orders).toHaveLength(1);
    });
    it('does not buy when allowance covers the trigger, or when an unresolved request exists', async () => {
      const g = await grant();
      await buy(g.id, { inputTokens: FIXTURE_BUYING_INPUT_BOUND, outputTokens: 1000 });
      await buyingPolicy(g.id, { refillAtCalls: 0 });
      expect((await evaluateBuying(ctx, owner, g.id)).status).toBe('blocked');
      expect((await buyingWorkspace(ctx, owner, g.id)).policy?.modelCalls).toBe(0);
      const h = await grant();
      const pack = await buy(h.id),
        key = await agent(h.id);
      await buyingPolicy(h.id, { mode: 'automatic' });
      await pool.query(
        `INSERT INTO broker_inference_requests(grant_id,pack_id,buyer_id,source_key_id,provider,source_mode,operation_key,input_fingerprint,status,reserved_input,reserved_output,deadline_at)
        VALUES($1,$2,$3,$4,$5,'fixture',$6,'test','needs_reconciliation',20,512,clock_timestamp())`,
        [h.id, pack.id, owner.id, key.key.id, pack.provider, randomUUID()],
      );
      const d = await evaluateBuying(ctx, owner, h.id);
      expect(d.reason).toContain('reconciliation');
      expect((await buyingWorkspace(ctx, owner, h.id)).policy?.paused).toBe(true);
    });
    it('bounds agent search and keyset pages while isolating tenants', async () => {
      const a = await grant(),
        b = await grant();
      await buyingPolicy(a.id);
      await buyingPolicy(b.id);
      const first = await listAgents(ctx, owner, { limit: '1', q: 'Agent' });
      expect(first.items).toHaveLength(1);
      expect(first.nextCursor).toBeTruthy();
      const second = await listAgents(ctx, owner, {
        limit: '1',
        q: 'Agent',
        cursor: first.nextCursor,
      });
      expect(second.items[0].id).not.toBe(first.items[0].id);
      expect((await listAgents(ctx, other, {})).items).toEqual([]);
      expect((await listAgents(ctx, owner, { q: 'not-present' })).items).toEqual([]);
    });
    it('provider suggestions are reviewed, scoped, and rate limited', async () => {
      const provider = providers[0];
      const proposed = await proposeTokenSupply(ctx, provider);
      expect(proposed.mode).toBe('fixture');
      expect(proposed.proposal).not.toBeNull();
      await expect(proposeTokenSupply(ctx, provider)).rejects.toMatchObject({ statusCode: 429 });
      await expect(proposeTokenSupply(ctx, owner)).rejects.toMatchObject({ statusCode: 403 });
      expect(
        (
          await pool.query('SELECT revision FROM broker_token_offerings ORDER BY provider')
        ).rows.every((r) => r.revision === 1),
      ).toBe(true);
    });
    it('selling windows gate new quotes without cutting off already purchased packs', async () => {
      const g = await grant(),
        pack = await buy(g.id);
      await pool.query(
        "UPDATE broker_token_offerings SET sales_start_at=clock_timestamp()+interval '1 hour',sales_end_at=clock_timestamp()+interval '2 hours'",
      );
      expect(
        (await quotes(ctx, owner, { grantId: g.id, inputTokens: 10000, outputTokens: 1000 })).items,
      ).toHaveLength(0);
      const key = await agent(g.id);
      const result = await complete(ctx, key.actor, { ...call, operationKey: randomUUID() });
      expect(result.broker.packId).toBe(pack.id);
    });

    it('supports instant-only supply only when the owner allows fallback and no usable call remains', async () => {
      await pool.query('UPDATE broker_token_offerings SET auto_bid=false');
      const g = await grant();
      await buyingPolicy(g.id, { allowInstant: true });
      const d = await evaluateBuying(ctx, owner, g.id);
      expect(d.status).toBe('recommended');
      expect(d.candidate?.mode).toBe('instant');
      const order = await acceptBuying(ctx, owner, g.id, d.id);
      expect(order.status).toBe('awarded');
      const h = await grant();
      await buyingPolicy(h.id);
      expect((await evaluateBuying(ctx, owner, h.id)).status).toBe('blocked');
    });
    it('closes and pauses a grant while Muse is in flight without creating a purchase', async () => {
      const g = await grant();
      await buyingPolicy(g.id, { mode: 'automatic' });
      ctx.muse.selectTokenPurchase = async (input) => {
        await closeGrant(ctx, owner, g.id, { operationKey: randomUUID() });
        return {
          candidateId: input.candidates[0].id,
          reason: 'refill',
          mode: 'fixture',
          modelCalled: false,
        };
      };
      expect((await evaluateBuying(ctx, owner, g.id)).status).toBe('superseded');
      const result = await buyingWorkspace(ctx, owner, g.id);
      expect(result.policy?.paused).toBe(true);
      expect(result.allowance.pendingOrders).toBe(0);
      expect((await grantDetail(ctx, owner, g.id)).grant.status).toBe('closed');
    });
    it('preserves funds on model failure and expires a recommendation that completes late', async () => {
      const g = await grant();
      await buyingPolicy(g.id);
      ctx.muse = { ...ctx.muse, mode: 'real' };
      ctx.muse.selectTokenPurchase = async () => {
        throw new Error('fixture model failure');
      };
      const failed = await evaluateBuying(ctx, owner, g.id);
      expect(failed.status).toBe('failed');
      expect(failed.modelCalled).toBe(true);
      ctx.muse = { ...ctx.muse, mode: 'fixture' };
      expect((await grantDetail(ctx, owner, g.id)).grant.heldCents).toBe(0);
      const h = await grant();
      await buyingPolicy(h.id);
      ctx.muse.selectTokenPurchase = async (input) => {
        await pool.query(
          "UPDATE broker_inference_buying_decisions SET expires_at=clock_timestamp()-interval '1 second' WHERE grant_id=$1",
          [h.id],
        );
        return {
          candidateId: input.candidates[0].id,
          reason: 'refill',
          mode: 'fixture',
          modelCalled: false,
        };
      };
      expect((await evaluateBuying(ctx, owner, h.id)).status).toBe('superseded');
      expect((await grantDetail(ctx, owner, h.id)).grant.heldCents).toBe(0);
    });
    it('preserves the lifetime evaluation cap through policy edits and recovers expired claims', async () => {
      const g = await grant();
      await buyingPolicy(g.id);
      await pool.query(
        'UPDATE broker_inference_buying_policies SET model_calls=20 WHERE grant_id=$1',
        [g.id],
      );
      await buyingPolicy(g.id, { expectedRevision: 1 });
      const d = await evaluateBuying(ctx, owner, g.id);
      expect(d.status).toBe('blocked');
      expect(d.reason).toContain('20-decision');
      const h = await grant();
      await buyingPolicy(h.id);
      await pool.query(
        `INSERT INTO broker_inference_buying_decisions(grant_id,policy_revision,status,reason,source_mode,expires_at)
        VALUES($1,1,'evaluating','interrupted local fixture','fixture',clock_timestamp()-interval '1 second')`,
        [h.id],
      );
      expect((await evaluateBuying(ctx, owner, h.id)).status).toBe('recommended');
      expect(
        (await buyingWorkspace(ctx, owner, h.id)).decisions.filter(
          (d) => d.status === 'superseded',
        ),
      ).toHaveLength(1);
    });
    it('rechecks manual spending and instant allowance before accepting a recommendation', async () => {
      const g = await grant(20);
      await buyingPolicy(g.id);
      const d = await evaluateBuying(ctx, owner, g.id);
      await createTokenOrder(ctx, owner, {
        grantId: g.id,
        mode: 'auction',
        inputTokens: 20,
        outputTokens: 512,
        maxTotalCents: 20,
        operationKey: randomUUID(),
      });
      await expect(acceptBuying(ctx, owner, g.id, d.id)).rejects.toMatchObject({ statusCode: 409 });
      expect((await grantDetail(ctx, owner, g.id)).grant.heldCents).toBe(20);
      await pool.query('UPDATE broker_token_offerings SET auto_bid=false');
      const h = await grant();
      await buyingPolicy(h.id, { allowInstant: true, refillAtCalls: 8 });
      const instant = await evaluateBuying(ctx, owner, h.id);
      await buy(h.id, { inputTokens: FIXTURE_BUYING_INPUT_BOUND, outputTokens: 1000 });
      await expect(acceptBuying(ctx, owner, h.id, instant.id)).rejects.toMatchObject({
        code: 'purchase_not_needed',
      });
    });

    it('keeps agent page enrichment and the buying due scan bounded with substantial history', async () => {
      const g = await grant();
      await buy(g.id);
      await buyingPolicy(g.id, { mode: 'automatic', refillAtCalls: 0 });
      await pool.query(
        `INSERT INTO broker_inference_grants(buyer_id,name,status,source_mode,funded_cents,available_cents,returned_cents,max_purchase_cents,allowed_providers,expires_at,created_at)
        SELECT CASE WHEN n<=4000 THEN $1 ELSE $2 END,'Archived agent '||n,'closed','fixture',1,0,1,1,'["modal","baseten"]',
        clock_timestamp()-interval '1 day',clock_timestamp()-interval '2 days'-n*interval '1 second' FROM generate_series(1,14000)n`,
        [owner.id, other.id],
      );
      await pool.query(`INSERT INTO broker_inference_buying_policies(grant_id,mode,paused,max_purchase_cents,output_per_call,target_calls,refill_at_calls)
        SELECT id,'automatic',true,1,512,1,0 FROM broker_inference_grants WHERE status='closed'`);
      await pool.query('ANALYZE broker_inference_grants');
      await pool.query('ANALYZE broker_inference_buying_policies');
      const spy = vi.spyOn(pool, 'query');
      let pageCalls: unknown[][] = [],
        dueCalls: unknown[][] = [];
      try {
        expect((await listAgents(ctx, owner, { limit: '5' })).items).toHaveLength(5);
        pageCalls = spy.mock.calls.map((args) => [...args]);
        spy.mockClear();
        await maintainBuying(ctx);
        dueCalls = spy.mock.calls.map((args) => [...args]);
      } finally {
        spy.mockRestore();
      }
      expect(pageCalls).toHaveLength(2);
      expect((pageCalls[1][1] as string[][])[0]).toHaveLength(5);
      const due = dueCalls.find((args) =>
        String(args[0]).includes('SELECT p.grant_id,g.buyer_id'),
      )!;
      expect(due).toBeDefined();
      await pool.query(
        "UPDATE broker_inference_buying_policies SET next_evaluation_at=clock_timestamp()-interval '1 second' WHERE grant_id=$1",
        [g.id],
      );
      const walk = (node: any): any[] => [node, ...(node.Plans ?? []).flatMap(walk)];
      const evidence = [];
      for (const [label, args] of [
        ['agents', pageCalls[0]],
        ['allowance', pageCalls[1]],
        ['worker', due],
      ] as const) {
        const plan = (
          await pool.query(`EXPLAIN(ANALYZE,BUFFERS,FORMAT JSON) ${args[0]}`, args[1] as unknown[])
        ).rows[0]['QUERY PLAN'][0];
        const nodes = walk(plan.Plan);
        expect(plan.Plan['Actual Rows']).toBeLessThanOrEqual(
          label === 'agents' ? 6 : label === 'worker' ? 4 : 5,
        );
        expect(nodes.some((n) => String(n['Sort Method']).includes('external'))).toBe(false);
        if (label === 'agents')
          expect(nodes.some((n) => n['Index Name'] === 'broker_inference_grants_owner')).toBe(true);
        if (label === 'worker')
          expect(nodes.some((n) => n['Index Name'] === 'broker_inference_buying_due')).toBe(true);
        evidence.push({
          query: label,
          rows: plan.Plan['Actual Rows'],
          buffers: plan.Plan['Shared Hit Blocks'],
          milliseconds: plan['Execution Time'],
          indexes: nodes.map((n) => n['Index Name']).filter(Boolean),
        });
      }
      if (process.env.BUYING_QUERY_EVIDENCE)
        process.stdout.write(
          'Local buying query evidence: 14,000 closed grants ' + JSON.stringify(evidence) + '\n',
        );
    });

    it('lists the owner’s purchased batches across grants with stable pages and retains agent scoping', async () => {
      const first = await grant(100),
        second = await grant(100);
      const a = await buy(first.id),
        b = await buy(second.id),
        key = await agent(first.id);
      const outsider = await createGrant(ctx, other, {
        operationKey: randomUUID(),
        name: 'Other agent',
        budgetCents: 100,
      });
      const quantities = { inputTokens: 10000, outputTokens: 1000 };
      const quote = (await quotes(ctx, other, { grantId: outsider.id, ...quantities })).items[0];
      await createTokenOrder(ctx, other, {
        grantId: outsider.id,
        ...quantities,
        mode: 'instant',
        quoteId: quote.quoteId,
        maxTotalCents: quote.priceCents,
        operationKey: randomUUID(),
      });
      const one = await app.inject({ url: '/api/inference/packs?limit=1', headers: { cookie } });
      expect(one.statusCode).toBe(200);
      expect(one.json().items).toHaveLength(1);
      const two = await app.inject({
        url: `/api/inference/packs?limit=1&cursor=${encodeURIComponent(one.json().nextCursor)}`,
        headers: { cookie },
      });
      expect(two.statusCode).toBe(200);
      expect(two.json().nextCursor).toBeUndefined();
      expect(new Set([one.json().items[0].id, two.json().items[0].id])).toEqual(
        new Set([a.id, b.id]),
      );
      expect((await scopedPacks(ctx, key.actor, {})).items.map((p) => p.id)).toEqual([a.id]);
      await closeGrant(ctx, owner, first.id, { operationKey: randomUUID() });
      expect((await scopedPacks(ctx, owner, {})).items).toHaveLength(2);
      expect(
        (await app.inject({ url: '/api/inference/packs?limit=101', headers: { cookie } }))
          .statusCode,
      ).toBe(400);
    });
    it('archives only settled batches, filters before pagination, and retains owner and agent scope', async () => {
      const g = await grant(),
        a = await buy(g.id),
        b = await buy(g.id),
        c = await buy(g.id),
        d = await buy(g.id),
        key = await agent(g.id);
      await pool.query(
        `UPDATE broker_token_packs SET status='settled',available_input=0,available_output=0,retired_input=input_tokens,retired_output=output_tokens,retirement_reason='expired',expires_at=clock_timestamp()-interval '1 second' WHERE id=ANY($1::uuid[])`,
        [[b.id, d.id]],
      );
      await pool.query(
        `UPDATE broker_token_packs SET status='retiring',available_input=0,available_output=0,held_input=100,held_output=10,retired_input=input_tokens-100,retired_output=output_tokens-10,retirement_reason='expired',expires_at=clock_timestamp()-interval '1 second' WHERE id=$1`,
        [c.id],
      );
      const wallet = await creditWalletView(pool, owner.id);
      const active = await scopedPacks(ctx, owner, { view: 'active' });
      expect(new Set(active.items.map((p) => p.id))).toEqual(new Set([a.id, c.id]));
      const first = await scopedPacks(ctx, owner, { view: 'archive', limit: 1 });
      expect(first.items).toHaveLength(1);
      const second = await scopedPacks(ctx, owner, {
        view: 'archive',
        limit: 1,
        cursor: first.nextCursor,
      });
      expect(new Set([...first.items, ...second.items].map((p) => p.id))).toEqual(
        new Set([b.id, d.id]),
      );
      expect(second.nextCursor).toBeUndefined();
      expect(
        (await scopedPacks(ctx, key.actor, { view: 'active' })).items.map((p) => p.id),
      ).toEqual(active.items.map((p) => p.id));
      expect((await scopedPacks(ctx, other, { view: 'archive' })).items).toEqual([]);
      expect(await creditWalletView(pool, owner.id)).toEqual(wallet);
      expect(
        (await app.inject({ url: '/api/inference/packs?view=deleted', headers: { cookie } }))
          .statusCode,
      ).toBe(400);
      expect((await scopedPacks(ctx, owner, {})).items).toHaveLength(4);
    });

    it('bounds active inventory independently of a large settled archive', async () => {
      const g = await grant(),
        sample = await buy(g.id);
      await pool.query(
        `WITH orders AS(
        INSERT INTO broker_token_orders(grant_id,buyer_id,operation_key,input_fingerprint,mode,source_mode,status,input_tokens,output_tokens,max_total_cents,price_cents,provider,closes_at,expires_at,created_at)
        SELECT $1,$2,gen_random_uuid()::text,'archive-fixture','instant','fixture','awarded',10000,1000,$4,$4,$5,
          clock_timestamp()-n*interval '1 minute',clock_timestamp()+interval '1 day',clock_timestamp()-n*interval '1 minute'
          FROM generate_series(1,5000)n RETURNING id,created_at)
        INSERT INTO broker_token_packs(order_id,grant_id,buyer_id,provider,provider_id,source_mode,route_fingerprint,snapshot,status,input_tokens,output_tokens,available_input,available_output,retired_input,retired_output,price_cents,expires_at,created_at)
        SELECT o.id,$1,$2,p.provider,p.provider_id,'fixture',p.route_fingerprint,p.snapshot,'settled',10000,1000,0,0,10000,1000,p.price_cents,p.expires_at,o.created_at
          FROM orders o CROSS JOIN broker_token_packs p WHERE p.id=$3`,
        [g.id, owner.id, sample.id, sample.priceCents, sample.provider],
      );
      await pool.query('ANALYZE broker_token_packs');
      const plan = (
        await pool.query(
          `EXPLAIN(ANALYZE,BUFFERS,FORMAT JSON) SELECT ${PACK_VIEW_COLUMNS} FROM broker_token_packs WHERE buyer_id=$1 AND ${PACK_ACTIVE_PREDICATE} ORDER BY created_at DESC,id DESC LIMIT 26`,
          [owner.id],
        )
      ).rows[0]['QUERY PLAN'][0];
      const nodes = (p: any): any[] => [p, ...(p.Plans ?? []).flatMap(nodes)];
      expect(
        nodes(plan.Plan).some((p) => p['Index Name'] === 'broker_token_packs_buyer_active_page'),
      ).toBe(true);
      expect(plan.Plan['Actual Rows']).toBe(1);
      expect(
        nodes(plan.Plan)
          .filter((p) => p['Relation Name'] === 'broker_token_packs')
          .every((p) => (p['Rows Removed by Filter'] ?? 0) === 0),
      ).toBe(true);
      expect((await scopedPacks(ctx, owner, { view: 'active' })).items.map((p) => p.id)).toEqual([
        sample.id,
      ]);
      expect((await scopedPacks(ctx, owner, { view: 'archive', limit: 25 })).items).toHaveLength(
        25,
      );
    });

    it('binds each batch key to its own quota and history, without buying, funding or falling back to another batch', async () => {
      const g = await grant(100),
        parent = await agent(g.id),
        a = await buy(g.id),
        b = await buy(g.id);
      const wallet = await creditWalletView(pool, owner.id);
      const operationKey = randomUUID();
      const purchasingClient = new BrokerClient({ baseUrl, apiKey: parent.token });
      const issued = await purchasingClient.request<Awaited<ReturnType<typeof issuePackKey>>>(
        'POST',
        `/api/inference/packs/${a.id}/keys`,
        { operationKey },
      );
      const childHeaders = { authorization: `Bearer ${issued.token}` };
      expect(issued.key.packId).toBe(a.id);
      expect(issued.connection.expiresAt).toBe(a.expiresAt);
      expect(issued.connection.baseUrl).toBe(`${origin}/api/v1`);
      expect(issued.key.scopes).not.toContain('tokens:buy');
      const own = await app.inject({ url: '/api/inference/packs', headers: childHeaders });
      expect(own.statusCode).toBe(200);
      expect(own.json().items.map((p: any) => p.id)).toEqual([a.id]);
      expect(
        (await app.inject({ url: `/api/inference/packs/${b.id}`, headers: childHeaders }))
          .statusCode,
      ).toBe(404);
      for (const path of ['/api/inference/grant', `/api/token-orders/${b.orderId}`])
        expect((await app.inject({ url: path, headers: childHeaders })).statusCode).toBe(403);
      for (const path of [
        '/api/token-orders',
        `/api/inference/packs/${b.id}/keys`,
        '/api/requests',
        '/api/inference/grants',
      ])
        expect(
          (
            await app.inject({
              method: 'POST',
              url: path,
              headers: childHeaders,
              payload: { operationKey: randomUUID() },
            })
          ).statusCode,
        ).toBe(403);
      await expect(issuePackKey(ctx, parent.actor, a.id, { operationKey })).rejects.toMatchObject({
        code: 'secret_already_issued',
      });
      const callKey = randomUUID();
      const completed = await app.inject({
        method: 'POST',
        url: '/api/v1/chat/completions',
        headers: childHeaders,
        payload: { ...call, operationKey: callKey },
      });
      expect(completed.statusCode).toBe(200);
      expect(completed.json().broker.packId).toBe(a.id);
      const rotation = await issuePackKey(ctx, owner, a.id, { operationKey: randomUUID() });
      expect(
        (await app.inject({ url: `/api/inference/packs/${a.id}`, headers: childHeaders }))
          .statusCode,
      ).toBe(401);
      const headers = { authorization: `Bearer ${rotation.token}` };
      expect(
        (
          await app.inject({ url: `/api/inference/requests/${completed.json().id}`, headers })
        ).json().status,
      ).toBe('settled');
      const replay = await app.inject({
        method: 'POST',
        url: '/api/v1/chat/completions',
        headers,
        payload: { ...call, operationKey: callKey },
      });
      expect(replay.statusCode).toBe(409);
      expect(replay.json().code).toBe('completed_without_result');
      const otherKey = await issuePackKey(ctx, owner, b.id, { operationKey: randomUUID() });
      const foreign = await app.inject({
        method: 'POST',
        url: '/api/v1/chat/completions',
        headers: { authorization: `Bearer ${otherKey.token}` },
        payload: { ...call, operationKey: callKey },
      });
      expect(foreign.statusCode).toBe(403);
      expect(foreign.json().inferenceRequestId).toBeUndefined();
      expect(
        (
          await app.inject({
            url: `/api/inference/requests/${completed.json().id}`,
            headers: { authorization: `Bearer ${otherKey.token}` },
          })
        ).statusCode,
      ).toBe(404);
      await transaction(pool, async (db) => {
        await db.query('SELECT id FROM broker_inference_grants WHERE id=$1 FOR UPDATE', [g.id]);
        await db.query('SELECT provider FROM broker_inference_routes ORDER BY provider FOR UPDATE');
        const row = (
          await db.query('SELECT * FROM broker_token_packs WHERE id=$1 FOR UPDATE', [a.id])
        ).rows[0];
        await retirePackLocked(db, row, 'quota_exhausted');
      });
      const denied = await app.inject({
        method: 'POST',
        url: '/api/v1/chat/completions',
        headers,
        payload: { ...call, operationKey: randomUUID() },
      });
      expect(denied.statusCode).toBe(409);
      expect(denied.json().code).toBe('token_allowance_exceeded');
      const detail = await grantDetail(ctx, owner, g.id);
      expect(detail.packs.find((p) => p.id === b.id)).toMatchObject({
        availableInputTokens: 10000,
        availableOutputTokens: 1000,
      });
      expect(detail.requests).toHaveLength(1);
      expect(await creditWalletView(pool, owner.id)).toEqual(wallet);
      expect(
        (
          await pool.query('SELECT secret_digest FROM broker_api_keys WHERE id=$1', [
            rotation.key.id,
          ])
        ).rows[0].secret_digest,
      ).not.toBe(rotation.token);
    });
    it('revokes delegated batch access with its parent, rotates only one batch, and never reissues a secret on duplicate operations', async () => {
      const g = await grant(),
        parent = await agent(g.id),
        a = await buy(g.id),
        b = await buy(g.id);
      const input = { operationKey: randomUUID() };
      const results = await Promise.allSettled([
        issuePackKey(ctx, parent.actor, a.id, input),
        issuePackKey(ctx, parent.actor, a.id, input),
      ]);
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      const issued = (
        results.find((r) => r.status === 'fulfilled') as PromiseFulfilledResult<
          Awaited<ReturnType<typeof issuePackKey>>
        >
      ).value;
      const independent = await issuePackKey(ctx, owner, b.id, { operationKey: randomUUID() });
      const revoke = await app.inject({
        method: 'DELETE',
        url: `/api/keys/${parent.key.id}`,
        headers: { cookie, origin },
      });
      expect(revoke.statusCode).toBe(200);
      expect(
        (
          await app.inject({
            url: `/api/inference/packs/${a.id}`,
            headers: { authorization: `Bearer ${issued.token}` },
          })
        ).statusCode,
      ).toBe(401);
      expect(
        (
          await app.inject({
            url: `/api/inference/packs/${b.id}`,
            headers: { authorization: `Bearer ${independent.token}` },
          })
        ).statusCode,
      ).toBe(200);
      expect(
        (await pool.query('SELECT revoked_at FROM broker_api_keys WHERE id=$1', [issued.key.id]))
          .rows[0].revoked_at,
      ).not.toBeNull();
      await pool.query(
        "UPDATE broker_token_packs SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",
        [a.id],
      );
      await expect(
        issuePackKey(ctx, owner, a.id, { operationKey: randomUUID() }),
      ).rejects.toMatchObject({ code: 'pack_closed' });
      const evidence = (
        await pool.query("SELECT details FROM broker_inference_events WHERE kind='pack_key_issued'")
      ).rows;
      expect(JSON.stringify(evidence)).not.toContain(issued.token);
    });
    it('cannot overspend one batch through concurrent usage keys or spill into another purchased batch', async () => {
      const g = await grant(),
        a = await buy(g.id, { inputTokens: 10000, outputTokens: 64 }),
        b = await buy(g.id);
      const issued = await issuePackKey(ctx, owner, a.id, { operationKey: randomUUID() });
      const headers = { authorization: `Bearer ${issued.token}` };
      const results = await Promise.all(
        [0, 1].map(() =>
          app.inject({
            method: 'POST',
            url: '/api/v1/chat/completions',
            headers,
            payload: { ...call, operationKey: randomUUID() },
          }),
        ),
      );
      expect(results.filter((r) => r.statusCode === 200)).toHaveLength(1);
      expect(results.filter((r) => r.statusCode === 409)).toHaveLength(1);
      const detail = await grantDetail(ctx, owner, g.id);
      expect(detail.requests).toHaveLength(1);
      expect(detail.requests[0].packId).toBe(a.id);
      expect(detail.packs.find((p) => p.id === b.id)).toMatchObject({
        availableInputTokens: 10000,
        availableOutputTokens: 1000,
      });
    });
    it('indexes the owner’s visible page without scanning unrelated purchased-batch history', async () => {
      const g = await grant(),
        sample = await buy(g.id);
      const outsider = await createGrant(ctx, other, {
        operationKey: randomUUID(),
        name: 'History fixture',
        budgetCents: 100,
      });
      await pool.query(
        `WITH orders AS(
        INSERT INTO broker_token_orders(grant_id,buyer_id,operation_key,input_fingerprint,mode,source_mode,status,input_tokens,output_tokens,max_total_cents,price_cents,provider,closes_at,expires_at,created_at)
        SELECT $1,$2,gen_random_uuid()::text,'synthetic-history','instant','fixture','awarded',10000,1000,$4,$4,$5,
          clock_timestamp()-n*interval '1 minute',clock_timestamp()+interval '1 day',clock_timestamp()-n*interval '1 minute'
          FROM generate_series(1,5000)n RETURNING id,created_at)
        INSERT INTO broker_token_packs(order_id,grant_id,buyer_id,provider,provider_id,source_mode,route_fingerprint,snapshot,status,input_tokens,output_tokens,available_input,available_output,retired_input,retired_output,price_cents,expires_at,created_at)
        SELECT o.id,$1,$2,p.provider,p.provider_id,'fixture',p.route_fingerprint,p.snapshot,'settled',10000,1000,0,0,10000,1000,p.price_cents,p.expires_at,o.created_at
          FROM orders o CROSS JOIN broker_token_packs p WHERE p.id=$3`,
        [outsider.id, other.id, sample.id, sample.priceCents, sample.provider],
      );
      await pool.query('ANALYZE broker_token_packs');
      const explained = (
        await pool.query(
          `EXPLAIN(ANALYZE,BUFFERS,FORMAT JSON) SELECT ${PACK_VIEW_COLUMNS},created_at::text cursor_created_at
        FROM broker_token_packs WHERE buyer_id=$1::text AND($5::uuid IS NULL OR grant_id=$5)
        AND($2::timestamptz IS NULL OR(created_at,id)<($2,$3::uuid)) ORDER BY created_at DESC,id DESC LIMIT $4`,
          [owner.id, null, null, 26, null],
        )
      ).rows[0]['QUERY PLAN'][0];
      const nodes = (p: any): any[] => [p, ...(p.Plans ?? []).flatMap(nodes)];
      expect(
        nodes(explained.Plan).some((p) => p['Index Name'] === 'broker_token_packs_buyer_page'),
      ).toBe(true);
      expect(explained.Plan['Actual Rows']).toBe(1);
      expect(
        nodes(explained.Plan)
          .filter((p) => p['Relation Name'] === 'broker_token_packs')
          .every((p) => (p['Rows Removed by Filter'] ?? 0) === 0),
      ).toBe(true);
      expect((await scopedPacks(ctx, owner, {})).items.map((p) => p.id)).toEqual([sample.id]);
    });
    it('settles concurrent sub-cent purchases without overspending or losing the 15% split', async () => {
      const g = await grant(0.03),
        key = await agent(g.id);
      const quantities = { inputTokens: 100, outputTokens: 1 };
      const quote = (await quotes(ctx, key.actor, quantities)).items[0]!;
      expect(quote.priceCents).toBe(0.02);
      const bodies = [0, 1].map(() => ({
        ...quantities,
        mode: 'instant',
        quoteId: quote.quoteId,
        maxTotalCents: 0.02,
        operationKey: randomUUID(),
      }));
      const attempts = await Promise.allSettled(
        bodies.map((input) => createTokenOrder(ctx, key.actor, input)),
      );
      expect(attempts.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      const winnerIndex = attempts.findIndex((r) => r.status === 'fulfilled');
      const awarded = await createTokenOrder(ctx, key.actor, bodies[winnerIndex]);
      const detail = await tokenOrderDetail(ctx, key.actor, awarded.id);
      expect(detail.grant).toMatchObject({
        fundedCents: 0.03,
        availableCents: 0.01,
        heldCents: 0,
        spentCents: 0.02,
      });
      expect(detail.pack!.revenueShare).toMatchObject({
        grossCents: 0.02,
        brokerFeeMicros: '30',
        providerNetMicros: '170',
      });
      expect(await creditWalletView(pool, owner.id)).toMatchObject({
        balanceCents: 4999.98,
        reservedCents: 0.01,
        availableCents: 4999.97,
      });
      expect(
        (
          await pool.query(
            "SELECT count(*)::int n FROM broker_credit_ledger WHERE grant_id=$1 AND kind='token_purchase'",
            [g.id],
          )
        ).rows[0].n,
      ).toBe(1);
      await closeGrant(ctx, owner, g.id, { operationKey: randomUUID() });
      expect(await creditWalletView(pool, owner.id)).toMatchObject({
        balanceCents: 4999.98,
        reservedCents: 0,
        availableCents: 4999.98,
      });
    });
    it('rejects excess currency precision at both the HTTP owner and database boundary', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/inference/grants',
        headers: { cookie, origin },
        payload: { operationKey: randomUUID(), name: 'Too precise', budgetCents: 0.001 },
      });
      expect(response.statusCode).toBe(400);
      await expect(
        pool.query('UPDATE broker_credit_wallets SET balance_cents=$2 WHERE buyer_id=$1', [
          owner.id,
          0.001,
        ]),
      ).rejects.toMatchObject({ code: '23514' });
      expect(await creditWalletView(pool, owner.id)).toMatchObject({
        balanceCents: 5000,
        reservedCents: 0,
      });
    });
    it('reserves owner cash once, awards the cheapest bid, and exposes permanent order history', async () => {
      const g = await grant(100),
        key = await agent(g.id);
      expect(await creditWalletView(pool, owner.id)).toMatchObject({
        balanceCents: 5000,
        reservedCents: 100,
      });
      const input = {
        operationKey: randomUUID(),
        mode: 'auction',
        inputTokens: 100000,
        outputTokens: 20000,
        maxTotalCents: 80,
      };
      const order = await createTokenOrder(ctx, key.actor, input);
      expect(
        new Date(order.closesAt).getTime() - new Date(order.createdAt).getTime(),
      ).toBeGreaterThan(29000);
      let detail = await tokenOrderDetail(ctx, key.actor, order.id);
      expect(detail.bids).toHaveLength(2);
      expect(detail.grant).toMatchObject({ availableCents: 20, heldCents: 80, spentCents: 0 });
      expect((await pool.query('SELECT count(*)::int n FROM broker_vms')).rows[0].n).toBe(0);
      await closeTokenAuction(ctx, order.id); // cannot close early
      expect((await tokenOrderDetail(ctx, key.actor, order.id)).order.status).toBe('open');
      await pool.query(
        "UPDATE broker_token_orders SET closes_at=clock_timestamp()-interval '1 second' WHERE id=$1",
        [order.id],
      );
      await Promise.all([closeTokenAuction(ctx, order.id), closeTokenAuction(ctx, order.id)]);
      detail = await tokenOrderDetail(ctx, key.actor, order.id);
      expect(detail.order).toMatchObject({
        status: 'awarded',
        priceCents: detail.bids[0].priceCents,
      });
      expect(detail.grant).toMatchObject({
        availableCents: 100 - detail.order.priceCents!,
        heldCents: 0,
        spentCents: detail.order.priceCents,
      });
      expect(await creditWalletView(pool, owner.id)).toMatchObject({
        balanceCents: 5000 - detail.order.priceCents!,
        reservedCents: 100 - detail.order.priceCents!,
      });
      expect((await createTokenOrder(ctx, key.actor, input)).packId).toBe(detail.pack!.id);
      expect(
        (
          await pool.query(
            "SELECT count(*)::int n FROM broker_credit_ledger WHERE kind='token_purchase'",
          )
        ).rows[0].n,
      ).toBe(1);
      const history = await listOrders(ctx, owner.id, { kind: 'token' });
      expect(history.items[0]).toMatchObject({
        kind: 'token',
        detailUrl: `/token-orders/${order.id}`,
        inputTokens: 100000,
        bidCount: 2,
      });
      expect(history.items[0].vmUrl).toBeUndefined();
      expect((await listOrders(ctx, other.id, {})).items).toEqual([]);
    });
    it('serializes spending, grants and holds across concurrent operations', async () => {
      const g = await grant(100),
        key = await agent(g.id);
      await expect(
        fundGrant(ctx, key.actor, g.id, { operationKey: randomUUID(), amountCents: 100 }),
      ).rejects.toMatchObject({ code: 'owner_required' });
      await expect(
        closeGrant(ctx, key.actor, g.id, { operationKey: randomUUID() }),
      ).rejects.toMatchObject({ code: 'owner_required' });
      const pending = await Promise.allSettled(
        [1, 2].map(() =>
          createTokenOrder(ctx, key.actor, {
            operationKey: randomUUID(),
            mode: 'auction',
            inputTokens: 10000,
            outputTokens: 2000,
            maxTotalCents: 60,
          }),
        ),
      );
      expect(pending.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      expect((await grantDetail(ctx, owner, g.id)).grant).toMatchObject({
        availableCents: 40,
        heldCents: 60,
      });
      const funded = await Promise.allSettled(
        [1, 2].map(() =>
          fundGrant(ctx, owner, g.id, { operationKey: randomUUID(), amountCents: 3000 }),
        ),
      );
      expect(funded.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      expect(await creditWalletView(pool, owner.id)).toMatchObject({ reservedCents: 3100 });
    });
    it('uses signed expiring instant quotes and one atomic charge for duplicate purchases', async () => {
      const g = await grant(),
        key = await agent(g.id),
        quote = (await quotes(ctx, key.actor, { inputTokens: 10000, outputTokens: 1000 })).items[0];
      const input = {
        operationKey: randomUUID(),
        mode: 'instant',
        inputTokens: 10000,
        outputTokens: 1000,
        maxTotalCents: 100,
        quoteId: quote.quoteId,
      };
      const [a, b] = await Promise.all([
        createTokenOrder(ctx, key.actor, input),
        createTokenOrder(ctx, key.actor, input),
      ]);
      expect(a.id).toBe(b.id);
      expect(a.priceCents).toBe(quote.priceCents);
      await expect(
        createTokenOrder(ctx, key.actor, { ...input, inputTokens: 10001 }),
      ).rejects.toMatchObject({ code: 'operation_conflict' });
      await expect(
        createTokenOrder(ctx, key.actor, {
          ...input,
          operationKey: randomUUID(),
          quoteId: `${quote.quoteId.slice(0, -8)}tampered`,
        }),
      ).rejects.toMatchObject({ code: 'invalid_quote' });
      await pool.query('UPDATE broker_token_offerings SET revision=revision+1');
      await expect(
        createTokenOrder(ctx, key.actor, { ...input, operationKey: randomUUID() }),
      ).rejects.toMatchObject({ code: 'quote_unavailable' });
    });
    it('returns cancelled and unmatched auction holds without spending or automatic instant fallback', async () => {
      const g = await grant(100),
        key = await agent(g.id);
      await pool.query('UPDATE broker_token_offerings SET auto_bid=false');
      const order = await createTokenOrder(ctx, key.actor, {
        operationKey: randomUUID(),
        mode: 'auction',
        inputTokens: 10000,
        outputTokens: 1000,
        maxTotalCents: 50,
      });
      const cancel = { operationKey: randomUUID() };
      await cancelTokenOrder(ctx, key.actor, order.id, cancel);
      await cancelTokenOrder(ctx, key.actor, order.id, cancel);
      expect((await tokenOrderDetail(ctx, key.actor, order.id)).grant).toMatchObject({
        availableCents: 100,
        spentCents: 0,
        heldCents: 0,
      });
      const noOffers = await createTokenOrder(ctx, key.actor, {
        operationKey: randomUUID(),
        mode: 'auction',
        inputTokens: 10000,
        outputTokens: 1000,
        maxTotalCents: 50,
      });
      await pool.query(
        "UPDATE broker_token_orders SET closes_at=clock_timestamp()-interval '1 second' WHERE id=$1",
        [noOffers.id],
      );
      await closeTokenAuction(ctx, noOffers.id);
      expect((await tokenOrderDetail(ctx, key.actor, noOffers.id)).order.status).toBe('no_offers');
      expect((await grantDetail(ctx, owner, g.id)).grant).toMatchObject({
        availableCents: 100,
        spentCents: 0,
        heldCents: 0,
      });
    });
    it('reserves both token dimensions, bounds concurrency, and charges money only for the pack', async () => {
      const g = await grant(),
        key = await agent(g.id),
        pack = await buy(g.id, { inputTokens: inputBound, outputTokens: 64 });
      const original = ctx.inference!.dispatch;
      let release!: () => void, entered!: () => void;
      const gate = new Promise<void>((r) => {
          release = r;
        }),
        started = new Promise<void>((r) => {
          entered = r;
        });
      ctx.inference!.dispatch = vi.fn(async (route, input, id) => {
        entered();
        await gate;
        return original(route, input, id);
      });
      const operationKey = randomUUID(),
        first = complete(ctx, key.actor, { ...call, operationKey });
      await started;
      const during = (await grantDetail(ctx, owner, g.id)).packs[0];
      expect(during).toMatchObject({
        heldInputTokens: inputBound,
        heldOutputTokens: 64,
        availableInputTokens: 0,
      });
      await expect(
        complete(ctx, key.actor, { ...call, operationKey: randomUUID() }),
      ).rejects.toMatchObject({ code: 'token_allowance_exceeded' });
      await expect(complete(ctx, key.actor, { ...call, operationKey })).rejects.toMatchObject({
        code: 'inference_pending',
      });
      release();
      const result = await first;
      expect(result.broker.packId).toBe(pack.id);
      expect((await grantDetail(ctx, owner, g.id)).packs[0]).toMatchObject({
        heldInputTokens: 0,
        heldOutputTokens: 0,
        consumedInputTokens: inputBound,
      });
      expect(
        (
          await pool.query(
            "SELECT count(*)::int n FROM broker_credit_ledger WHERE kind='token_purchase'",
          )
        ).rows[0].n,
      ).toBe(1);
      await expect(complete(ctx, key.actor, { ...call, operationKey })).rejects.toMatchObject({
        code: 'completed_without_result',
      });
      expect(ctx.inference!.dispatch).toHaveBeenCalledTimes(1);
    });
    it('keeps uncertain usage reserved across restart recovery, then resolves exactly once', async () => {
      const g = await grant(),
        key = await agent(g.id);
      await buy(g.id);
      ctx.inference!.dispatch = vi.fn(async () => {
        throw new InferenceUpstreamError('transport_outcome_unknown', false);
      });
      const operationKey = randomUUID();
      await expect(complete(ctx, key.actor, { ...call, operationKey })).rejects.toMatchObject({
        code: 'inference_outcome_unknown',
      });
      const request = (await pool.query('SELECT * FROM broker_inference_requests')).rows[0];
      expect(await receipt(ctx, key.actor, request.id)).toMatchObject({
        status: 'outcome_unknown',
        heldInputTokens: inputBound,
        heldOutputTokens: 64,
      });
      await pool.query(
        "UPDATE broker_inference_requests SET deadline_at=clock_timestamp()-interval '1 second' WHERE id=$1",
        [request.id],
      );
      await recoverRequest(ctx, request.id);
      expect((await receipt(ctx, key.actor, request.id)).status).toBe('needs_reconciliation');
      await expect(complete(ctx, key.actor, { ...call, operationKey })).rejects.toMatchObject({
        code: 'inference_pending',
      });
      const input = {
        operationKey: randomUUID(),
        providerRequestId: 'fixture-provider-receipt',
        evidence: 'Verified fixture provider usage receipt for reconciliation.',
        inputTokens: 10,
        outputTokens: 5,
        rejected: false,
      };
      await resolveRequest(ctx, operator, request.id, input);
      await resolveRequest(ctx, operator, request.id, input);
      expect(await receipt(ctx, key.actor, request.id)).toMatchObject({
        status: 'settled',
        heldInputTokens: 0,
        heldOutputTokens: 0,
        inputTokens: 10,
        outputTokens: 5,
      });
      expect(
        (
          await pool.query('SELECT held_calls FROM broker_inference_routes WHERE provider=$1', [
            request.provider,
          ])
        ).rows[0].held_calls,
      ).toBe(0);
      expect(ctx.inference!.dispatch).toHaveBeenCalledTimes(1);
    });
    it('releases definite rejections but quarantines missing or out-of-bounds accounting', async () => {
      const g = await grant(),
        key = await agent(g.id);
      await buy(g.id);
      ctx.inference!.dispatch = async () => {
        throw new InferenceUpstreamError('upstream_429', true);
      };
      await expect(
        complete(ctx, key.actor, { ...call, operationKey: randomUUID() }),
      ).rejects.toMatchObject({ code: 'inference_rejected' });
      expect((await grantDetail(ctx, owner, g.id)).packs[0]).toMatchObject({
        heldInputTokens: 0,
        consumedInputTokens: 0,
      });
      ctx.inference!.dispatch = async () => ({
        id: 'overrun',
        content: 'Synthetic',
        finishReason: 'stop',
        inputTokens: inputBound + 1,
        outputTokens: 1,
      });
      await expect(
        complete(ctx, key.actor, { ...call, operationKey: randomUUID() }),
      ).rejects.toMatchObject({ code: 'inference_outcome_unknown' });
      await initializeInference(ctx);
      expect(
        (
          await pool.query(
            'SELECT count(*)::int n FROM broker_inference_routes WHERE quarantined_at IS NOT NULL',
          )
        ).rows[0].n,
      ).toBe(1);
      expect((await grantDetail(ctx, owner, g.id)).packs[0]).toMatchObject({
        heldInputTokens: inputBound,
        heldOutputTokens: 64,
      });
    });
    it('records one platform-paid Modal token atomically without consuming extra agent quota', async () => {
      const g = await createGrant(ctx, owner, {
        operationKey: randomUUID(),
        name: 'Modal platform-paid marker',
        budgetCents: 1000,
        allowedProviders: ['modal'],
      });
      const key = await agent(g.id),
        pack = await buy(g.id);
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
        new Response(
          JSON.stringify({
            id: 'offline-modal-platform-receipt',
            choices: [{ message: { content: '' }, finish_reason: 'length' }],
            usage: {
              prompt_tokens: 12,
              completion_tokens: 8,
              total_tokens: 20,
              reasoning_tokens: 9,
            },
          }),
        ),
      );
      ctx.inference!.dispatch = (route, input, id) =>
        dispatchReal(
          {
            ...route,
            apiKey: 'offline-modal-proxy-token',
            nativeModel: 'offline-muse.modal.direct',
          },
          input,
          id,
          fetcher,
        );
      const result = await complete(ctx, key.actor, {
        ...call,
        max_tokens: 8,
        operationKey: randomUUID(),
      });
      await settleRequest(ctx, result.id, {
        id: 'offline-modal-platform-receipt',
        content: '',
        finishReason: 'length',
        inputTokens: 12,
        outputTokens: 8,
        platformOutputTokens: 1,
      });
      const detail = await grantDetail(ctx, owner, g.id);
      expect(detail.requests[0]).toMatchObject({
        status: 'settled',
        outputTokens: 8,
        heldOutputTokens: 0,
      });
      expect(detail.packs[0]).toMatchObject({
        consumedOutputTokens: 8,
        availableOutputTokens: pack.outputTokens - 8,
        heldOutputTokens: 0,
      });
      const events = await pool.query(
        "SELECT details FROM broker_inference_events WHERE grant_id=$1 AND kind='platform_output_absorbed'",
        [g.id],
      );
      expect(events.rows).toHaveLength(1);
      expect(events.rows[0].details).toMatchObject({ provider: 'modal', outputTokens: 1 });
      expect(fetcher).toHaveBeenCalledTimes(1);
      expect(detail.grant.spentCents).toBe(pack.priceCents);
    });
    it('holds quota and quarantines Modal when reasoning exceeds the one-token platform allowance', async () => {
      const g = await createGrant(ctx, owner, {
        operationKey: randomUUID(),
        name: 'Modal accounting regression',
        budgetCents: 1000,
        allowedProviders: ['modal'],
      });
      const key = await agent(g.id),
        pack = await buy(g.id);
      expect(pack.provider).toBe('modal');
      // More than the observed one-token discrepancy must fail closed. No native call here.
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
        new Response(
          JSON.stringify({
            id: 'offline-modal-accounting-receipt',
            choices: [{ message: { content: '' }, finish_reason: 'length' }],
            usage: {
              prompt_tokens: 161,
              completion_tokens: 8,
              total_tokens: 169,
              reasoning_tokens: 10,
            },
          }),
        ),
      );
      ctx.inference!.dispatch = (route, input, id) =>
        dispatchReal(
          {
            ...route,
            apiKey: 'offline-modal-proxy-token',
            nativeModel: 'offline-muse.modal.direct',
          },
          input,
          id,
          fetcher,
        );
      const operationKey = randomUUID();
      await expect(
        complete(ctx, key.actor, { ...call, max_tokens: 8, operationKey }),
      ).rejects.toMatchObject({ code: 'inference_outcome_unknown' });
      const detail = await grantDetail(ctx, owner, g.id);
      expect(detail.requests[0]).toMatchObject({
        status: 'outcome_unknown',
        failureCode: 'inconsistent_usage',
        heldInputTokens: inputBound,
        heldOutputTokens: 8,
      });
      expect(detail.packs[0]).toMatchObject({ heldInputTokens: inputBound, heldOutputTokens: 8 });
      await initializeInference(ctx);
      expect(
        (
          await pool.query(
            "SELECT quarantined_at FROM broker_inference_routes WHERE provider='modal'",
          )
        ).rows[0].quarantined_at,
      ).not.toBeNull();
      expect(
        (await quotes(ctx, owner, { grantId: g.id, inputTokens: 10000, outputTokens: 1000 })).items,
      ).toHaveLength(0);
      await expect(
        complete(ctx, key.actor, { ...call, max_tokens: 8, operationKey }),
      ).rejects.toMatchObject({ code: 'inference_pending' });
      expect(fetcher).toHaveBeenCalledTimes(1);
    });
    it('rotates keys without resetting budget, cancels revoked pending orders, and isolates tenants', async () => {
      const g = await grant(),
        a = await agent(g.id),
        pack = await buy(g.id);
      const order = await createTokenOrder(ctx, a.actor, {
        operationKey: randomUUID(),
        mode: 'auction',
        inputTokens: 10000,
        outputTokens: 1000,
        maxTotalCents: 50,
      });
      const b = await agent(g.id);
      await expect(
        complete(ctx, a.actor, { ...call, operationKey: randomUUID() }),
      ).rejects.toMatchObject({ code: 'key_unavailable' });
      expect(
        (await complete(ctx, b.actor, { ...call, operationKey: randomUUID() })).broker.packId,
      ).toBe(pack.id);
      await pool.query(
        "UPDATE broker_token_orders SET closes_at=clock_timestamp()-interval '1 second' WHERE id=$1",
        [order.id],
      );
      await closeTokenAuction(ctx, order.id);
      expect((await tokenOrderDetail(ctx, b.actor, order.id)).order.status).toBe('cancelled');
      await expect(grantDetail(ctx, other, g.id)).rejects.toMatchObject({ code: 'not_found' });
      const another = await grant();
      await expect(grantDetail(ctx, b.actor, another.id)).rejects.toMatchObject({
        code: 'grant_scope',
      });
    });
    it('closes unused funding, keeps prepaid quota non-refundable, and waits for unknown usage', async () => {
      const g = await grant(100),
        key = await agent(g.id),
        pack = await buy(g.id);
      ctx.inference!.dispatch = async () => {
        throw new InferenceUpstreamError('timeout', false);
      };
      await expect(
        complete(ctx, key.actor, { ...call, operationKey: randomUUID() }),
      ).rejects.toThrow();
      const closed = await closeGrant(ctx, owner, g.id, { operationKey: randomUUID() });
      expect(closed).toMatchObject({
        status: 'closing',
        availableCents: 0,
        heldCents: 0,
        spentCents: pack.priceCents,
        returnedCents: 100 - pack.priceCents,
      });
      expect((await grantDetail(ctx, owner, g.id)).packs[0]).toMatchObject({
        status: 'retiring',
        refundCents: 0,
        heldInputTokens: inputBound,
      });
      const request = (await pool.query('SELECT id FROM broker_inference_requests')).rows[0];
      await resolveRequest(ctx, operator, request.id, {
        operationKey: randomUUID(),
        evidence: 'Verified no-generation fixture provider evidence.',
        providerRequestId: 'not-generated',
        inputTokens: 0,
        outputTokens: 0,
        rejected: true,
      });
      expect((await grantDetail(ctx, owner, g.id)).grant.status).toBe('closed');
      expect(
        (await pool.query('SELECT sum(outstanding_input)::int n FROM broker_inference_routes'))
          .rows[0].n,
      ).toBe(0);
      expect(await creditWalletView(pool, owner.id)).toMatchObject({
        balanceCents: 5000 - pack.priceCents,
        reservedCents: 0,
      });
    });
    it('refunds verified provider failure once using unused weighted quota, including closed grants', async () => {
      const g = await grant(100),
        key = await agent(g.id),
        pack = await buy(g.id);
      const result = await complete(ctx, key.actor, { ...call, operationKey: randomUUID() });
      await transaction(pool, async (db) => {
        await db.query('SELECT id FROM broker_inference_grants WHERE id=$1 FOR UPDATE', [g.id]);
        await db.query('SELECT provider FROM broker_inference_routes ORDER BY provider FOR UPDATE');
        const current = (
          await db.query('SELECT * FROM broker_token_packs WHERE id=$1 FOR UPDATE', [pack.id])
        ).rows[0];
        await retirePackLocked(
          db,
          current,
          'provider_failure',
          'Verified fixture provider outage evidence.',
        );
      });
      await maintainInference(ctx);
      const detail = await grantDetail(ctx, owner, g.id),
        updated = detail.packs[0];
      expect(updated.status).toBe('settled');
      expect(updated.refundCents).toBeGreaterThan(0);
      expect(updated.refundCents).toBeLessThan(pack.priceCents);
      expect(updated.refundCents).toBe(2.38);
      expect(detail.grant.spentCents).toBe(
        Number((pack.priceCents - updated.refundCents).toFixed(2)),
      );
      expect(updated.revenueShare.grossCents).toBe(
        Number((pack.priceCents - updated.refundCents).toFixed(2)),
      );
      expect(
        (
          await pool.query(
            "SELECT count(*)::int n FROM broker_credit_ledger WHERE kind='token_refund'",
          )
        ).rows[0].n,
      ).toBe(1);
      expect(result.usage.prompt_tokens).toBe(inputBound);
    });
    it('preserves whole-cent refund terms for packs purchased before four-decimal pricing', async () => {
      await pool.query('UPDATE broker_token_offerings SET minimum_price_cents=100');
      const g = await grant(200),
        key = await agent(g.id),
        pack = await buy(g.id);
      expect(pack.priceCents).toBe(100);
      await pool.query(
        "UPDATE broker_token_packs SET snapshot=snapshot-'currencyDecimals' WHERE id=$1",
        [pack.id],
      );
      await complete(ctx, key.actor, { ...call, operationKey: randomUUID() });
      await transaction(pool, async (db) => {
        await db.query('SELECT id FROM broker_inference_grants WHERE id=$1 FOR UPDATE', [g.id]);
        await db.query('SELECT provider FROM broker_inference_routes ORDER BY provider FOR UPDATE');
        const current = (
          await db.query('SELECT * FROM broker_token_packs WHERE id=$1 FOR UPDATE', [pack.id])
        ).rows[0];
        await retirePackLocked(db, current, 'provider_failure', 'Verified fixture outage.');
      });
      await maintainInference(ctx);
      await maintainInference(ctx);
      const row = (await pool.query('SELECT * FROM broker_token_packs WHERE id=$1', [pack.id]))
        .rows[0];
      const s = row.snapshot;
      const unused =
        BigInt(row.retired_input) * BigInt(s.inputRate) +
        BigInt(row.retired_output) * BigInt(s.outputRate);
      const issued =
        BigInt(row.input_tokens) * BigInt(s.inputRate) +
        BigInt(row.output_tokens) * BigInt(s.outputRate);
      const legacyRefund = Number((100n * unused) / issued);
      expect(row.refund_cents).toBe(legacyRefund);
      expect(legacyRefund).toBeGreaterThan(0);
      expect(legacyRefund).toBeLessThan(100);
      expect(
        (
          await pool.query(
            "SELECT count(*)::int n FROM broker_credit_ledger WHERE kind='token_refund' AND grant_id=$1",
            [g.id],
          )
        ).rows[0].n,
      ).toBe(1);
    });
    it('enforces expiry in admissions and restart maintenance; preserves history and counters', async () => {
      const g = await grant(),
        key = await agent(g.id);
      await buy(g.id);
      await pool.query(
        "UPDATE broker_inference_grants SET expires_at=clock_timestamp()-interval '1 second',created_at=clock_timestamp()-interval '1 day' WHERE id=$1",
        [g.id],
      );
      await expect(
        complete(ctx, key.actor, { ...call, operationKey: randomUUID() }),
      ).rejects.toMatchObject({ code: 'grant_closed' });
      await maintainInference(ctx);
      await maintainInference(ctx);
      expect((await grantDetail(ctx, owner, g.id)).grant.status).toBe('closed');
      expect((await listOrders(ctx, owner.id, { kind: 'token' })).items).toHaveLength(1);
      expect(await creditWalletView(pool, owner.id)).toMatchObject({ reservedCents: 0 });
    });
    it('bounds listings with stable keyset pagination and seller capacity', async () => {
      for (let i = 0; i < 3; i++) await grant(100);
      const one = await listGrants(ctx, owner, { limit: 2 });
      const two = await listGrants(ctx, owner, { limit: 2, cursor: one.nextCursor });
      expect(one.items).toHaveLength(2);
      expect(two.items).toHaveLength(1);
      expect(new Set([...one.items, ...two.items].map((g) => g.id)).size).toBe(3);
      await pool.query(
        'UPDATE broker_token_offerings SET max_outstanding_input=10000,max_outstanding_output=1000',
      );
      const g = one.items[0];
      await buy(g.id);
      await buy(g.id);
      expect(
        (await quotes(ctx, owner, { grantId: g.id, inputTokens: 10000, outputTokens: 1000 })).items,
      ).toEqual([]);
      const seller = (await pool.query('SELECT provider_id FROM broker_inference_routes LIMIT 1'))
        .rows[0];
      const actor = providers.find((p) => p.providerId === seller.provider_id)!;
      await expect(
        updateOffering(ctx, actor, {
          operationKey: randomUUID(),
          expectedRevision: 1,
          active: true,
          autoBid: true,
          inputRateMicrosPerMillion: 100,
          outputRateMicrosPerMillion: 100,
          instantMarkupBps: 0,
          minimumPriceCents: 1,
          maxOutstandingInputTokens: 1,
          maxOutstandingOutputTokens: 1,
        }),
      ).rejects.toMatchObject({ code: 'commitments_exceed_capacity' });
    });
    it('runs owner session → grant key → SDK quote/purchase → completion → receipt over HTTP', async () => {
      const created = await app.inject({
        method: 'POST',
        url: '/api/inference/grants',
        headers: { cookie, origin },
        payload: { operationKey: randomUUID(), name: 'SDK HTTP test', budgetCents: 100 },
      });
      expect(created.statusCode, created.body).toBe(200);
      const issued = await app.inject({
        method: 'POST',
        url: `/api/inference/grants/${created.json().id}/keys`,
        headers: { cookie, origin },
        payload: {},
      });
      expect(issued.statusCode, issued.body).toBe(200);
      const token = issued.json().token;
      const client = new BrokerClient({ baseUrl, apiKey: token });
      const models = await client.inference.catalog();
      expect(models.enabled).toBe(true);
      // Direct HTTP verifies OpenAI-compatible header-only operation key injection.
      const q = await app.inject({
        method: 'POST',
        url: '/api/inference/quotes',
        headers: { authorization: `Bearer ${token}` },
        payload: { inputTokens: 10000, outputTokens: 1000 },
      });
      expect(q.statusCode, q.body).toBe(200);
      const order = await app.inject({
        method: 'POST',
        url: '/api/token-orders',
        headers: { authorization: `Bearer ${token}`, 'idempotency-key': randomUUID() },
        payload: {
          mode: 'instant',
          inputTokens: 10000,
          outputTokens: 1000,
          maxTotalCents: 100,
          quoteId: q.json().items[0].quoteId,
        },
      });
      expect(order.statusCode, order.body).toBe(200);
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/chat/completions',
        headers: { authorization: `Bearer ${token}`, 'idempotency-key': randomUUID() },
        payload: call,
      });
      expect(response.statusCode, response.body).toBe(200);
      expect(response.json().broker.mode).toBe('fixture');
      const read = await app.inject({
        url: `/api/inference/requests/${response.json().id}`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(read.json().status).toBe('settled');
      ctx.inference!.dispatch = async () => {
        throw new InferenceUpstreamError('missing_authoritative_usage', false);
      };
      let uncertain: { inferenceRequestId?: string; code?: string } | undefined;
      try {
        await client.inference.complete(call, { operationKey: randomUUID() });
      } catch (error) {
        uncertain = error as typeof uncertain;
      }
      expect(uncertain?.code).toBe('inference_outcome_unknown');
      expect(uncertain?.inferenceRequestId).toMatch(/^[a-f0-9-]{36}$/);
      expect((await client.inference.receipt(uncertain!.inferenceRequestId!)).status).toBe(
        'outcome_unknown',
      );
      for (const path of [
        '/api/inference/grants',
        `/api/inference/grants/${created.json().id}/fund`,
        '/api/requests',
        '/api/muse/translate',
      ]) {
        const forbidden = await app.inject({
          method: 'POST',
          url: path,
          headers: { authorization: `Bearer ${token}`, 'idempotency-key': randomUUID() },
          payload: {},
        });
        expect(forbidden.statusCode).toBe(403);
      }
      const noOrigin = await app.inject({
        method: 'POST',
        url: '/api/inference/grants',
        headers: { cookie },
        payload: { operationKey: randomUUID(), name: 'No CSRF', budgetCents: 1 },
      });
      expect(noOrigin.statusCode).toBe(403);
      const unsupported = await app.inject({
        method: 'POST',
        url: '/api/v1/chat/completions',
        headers: { authorization: `Bearer ${token}`, 'idempotency-key': randomUUID() },
        payload: { ...call, stream: true },
      });
      expect(unsupported.statusCode).toBe(400);
    });
    it('serializes the owner grant ceiling without scanning historical grants', async () => {
      for (let i = 0; i < 19; i++) await grant(1);
      const last = await Promise.allSettled([grant(1), grant(1)]);
      expect(last.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      expect((await listGrants(ctx, owner, { limit: 100 })).items).toHaveLength(20);
    });
    it('permits refilling after ten exhausted packs without retaining unusable commitments', async () => {
      const g = await grant(),
        key = await agent(g.id);
      for (let i = 0; i < 10; i++) {
        await buy(g.id, { inputTokens: inputBound, outputTokens: call.max_tokens });
        await complete(ctx, key.actor, { ...call, operationKey: randomUUID() });
        // Advance only the purchase-rate fixture clock; quotas remain real DB counters.
        await pool.query(
          "UPDATE broker_token_orders SET created_at=created_at-interval '2 minutes' WHERE grant_id=$1",
          [g.id],
        );
      }
      const next = await buy(g.id);
      expect(next.status).toBe('active');
      expect(
        (
          await pool.query(
            "SELECT count(*)::int n FROM broker_token_packs WHERE grant_id=$1 AND status='settled'",
            [g.id],
          )
        ).rows[0].n,
      ).toBe(10);
      expect(
        (await pool.query('SELECT sum(outstanding_input)::int n FROM broker_inference_routes'))
          .rows[0].n,
      ).toBe(next.inputTokens);
    });
    it('refuses unusably small packs and qualifications that expire before the grant', async () => {
      const g = await grant();
      expect(
        (await quotes(ctx, owner, { grantId: g.id, inputTokens: 1, outputTokens: 1 })).items,
      ).toEqual([]);
      await expect(
        createTokenOrder(ctx, owner, {
          grantId: g.id,
          operationKey: randomUUID(),
          mode: 'auction',
          inputTokens: 1,
          outputTokens: 1,
          maxTotalCents: 10,
        }),
      ).rejects.toMatchObject({ code: 'route_unavailable' });
      for (const native of ctx.inference!.routes.values()) native.validUntil = Date.now() + 3600000;
      expect(
        (await quotes(ctx, owner, { grantId: g.id, inputTokens: 10000, outputTokens: 1000 })).items,
      ).toEqual([]);
      await expect(
        createTokenOrder(ctx, owner, {
          grantId: g.id,
          operationKey: randomUUID(),
          mode: 'auction',
          inputTokens: 10000,
          outputTokens: 1000,
          maxTotalCents: 10,
        }),
      ).rejects.toMatchObject({ code: 'route_unavailable' });
    });
    it('rolls back a purchase whose grant expires while waiting for its wallet lock', async () => {
      const g = await grant(100);
      await pool.query(
        "UPDATE broker_inference_grants SET expires_at=clock_timestamp()+interval '1 second' WHERE id=$1",
        [g.id],
      );
      const q = (
        await quotes(ctx, owner, { grantId: g.id, inputTokens: 10000, outputTokens: 1000 })
      ).items[0];
      const blocker = await pool.connect();
      try {
        await blocker.query('BEGIN');
        await blocker.query(
          'SELECT buyer_id FROM broker_credit_wallets WHERE buyer_id=$1 FOR UPDATE',
          [owner.id],
        );
        const pending = createTokenOrder(ctx, owner, {
          grantId: g.id,
          operationKey: randomUUID(),
          mode: 'instant',
          inputTokens: 10000,
          outputTokens: 1000,
          quoteId: q.quoteId,
          maxTotalCents: 100,
        });
        const result = pending.then(
          () => null,
          (e: unknown) => e,
        );
        await new Promise((r) => setTimeout(r, 1200));
        await blocker.query('COMMIT');
        expect(await result).toMatchObject({ code: 'grant_closed' });
      } finally {
        await blocker.query('ROLLBACK');
        blocker.release();
      }
      expect(
        (
          await pool.query(
            "SELECT count(*)::int n FROM broker_credit_ledger WHERE kind='token_purchase'",
          )
        ).rows[0].n,
      ).toBe(0);
      expect((await pool.query('SELECT count(*)::int n FROM broker_token_orders')).rows[0].n).toBe(
        0,
      );
      expect(await creditWalletView(pool, owner.id)).toMatchObject({
        balanceCents: 5000,
        reservedCents: 100,
      });
    });
    it('blocks route replacement with outstanding quota and freezes seller history', async () => {
      const g = await grant(),
        pack = await buy(g.id);
      const before = (
        await pool.query('SELECT * FROM broker_inference_routes WHERE provider=$1', [pack.provider])
      ).rows[0];
      ctx.inference!.routes.get(pack.provider)!.fingerprint = 'changed-accounting-contract';
      await initializeInference(ctx);
      const after = (
        await pool.query('SELECT * FROM broker_inference_routes WHERE provider=$1', [pack.provider])
      ).rows[0];
      expect(after).toMatchObject({
        fingerprint: before.fingerprint,
        provider_id: before.provider_id,
        qualified: false,
      });
      const view = (await grantDetail(ctx, owner, g.id)).catalog.routes.find(
        (r) => r.provider === pack.provider,
      )!;
      expect(view.qualified).toBe(false);
      const seller = providers.find((p) => p.providerId === before.provider_id)!;
      const successor = providers.find((p) => p.providerId !== before.provider_id)!;
      await pool.query('UPDATE broker_inference_routes SET provider_id=$2 WHERE provider=$1', [
        pack.provider,
        successor.providerId,
      ]);
      expect((await scopedPacks(ctx, successor, {}, true)).items).toEqual([]);
      expect((await scopedPacks(ctx, seller, {}, true)).items[0].id).toBe(pack.id);
    });
    it('refunds a provider failure only after unknown usage resolves, without reviving a closed grant', async () => {
      const g = await grant(100),
        key = await agent(g.id),
        pack = await buy(g.id);
      ctx.inference!.dispatch = async () => {
        throw new InferenceUpstreamError('timeout', false);
      };
      await expect(
        complete(ctx, key.actor, { ...call, operationKey: randomUUID() }),
      ).rejects.toThrow();
      await transaction(pool, async (db) => {
        await db.query('SELECT id FROM broker_inference_grants WHERE id=$1 FOR UPDATE', [g.id]);
        await db.query('SELECT provider FROM broker_inference_routes ORDER BY provider FOR UPDATE');
        await retirePackLocked(
          db,
          (await db.query('SELECT * FROM broker_token_packs WHERE id=$1 FOR UPDATE', [pack.id]))
            .rows[0],
          'provider_failure',
          'Verified outage evidence for pending fixture generation.',
        );
      });
      expect((await grantDetail(ctx, owner, g.id)).packs[0]).toMatchObject({
        status: 'retiring',
        refundCents: 0,
      });
      await closeGrant(ctx, owner, g.id, { operationKey: randomUUID() });
      const request = (await pool.query('SELECT id FROM broker_inference_requests')).rows[0];
      await resolveRequest(ctx, operator, request.id, {
        operationKey: randomUUID(),
        evidence: 'Verified upstream did not generate or charge any tokens.',
        providerRequestId: 'fixture-failed-zero',
        inputTokens: 0,
        outputTokens: 0,
        rejected: true,
      });
      const detail = await grantDetail(ctx, owner, g.id);
      expect(detail.grant).toMatchObject({
        status: 'closed',
        availableCents: 0,
        spentCents: 0,
        returnedCents: 100,
      });
      expect(detail.packs[0]).toMatchObject({ status: 'settled', refundCents: pack.priceCents });
      expect(await creditWalletView(pool, owner.id)).toMatchObject({
        balanceCents: 5000,
        reservedCents: 0,
      });
    });
    it('bounds token history and selective filters using indexes with 15,000 historical orders', async () => {
      const g = await grant(1),
        another = await createGrant(ctx, other, {
          operationKey: randomUUID(),
          name: 'Other history',
          budgetCents: 1,
        });
      await pool.query(
        `INSERT INTO broker_token_orders(grant_id,buyer_id,operation_key,input_fingerprint,mode,source_mode,status,input_tokens,output_tokens,max_total_cents,closes_at,expires_at,created_at)
        SELECT $1,$2,'history-'||n,'fixture','auction','fixture',CASE WHEN n%101=0 THEN 'open' WHEN n%53=0 THEN 'no_offers' ELSE 'cancelled' END,
        1000,100,10,clock_timestamp()+interval '30 seconds',clock_timestamp()+interval '1 day',clock_timestamp()-n*interval '1 second' FROM generate_series(1,$3::int) n`,
        [g.id, owner.id, 10000],
      );
      await pool.query(
        `INSERT INTO broker_token_orders(grant_id,buyer_id,operation_key,input_fingerprint,mode,source_mode,status,input_tokens,output_tokens,max_total_cents,closes_at,expires_at)
        SELECT $1,$2,'other-history-'||n,'fixture','auction','fixture','cancelled',1000,100,10,clock_timestamp(),clock_timestamp()+interval '1 day' FROM generate_series(1,5000) n`,
        [another.id, other.id],
      );
      await pool.query('ANALYZE broker_token_orders');
      const first = await listOrders(ctx, owner.id, {
        kind: 'token',
        status: 'attention',
        limit: 5,
      });
      const second = await listOrders(ctx, owner.id, {
        kind: 'token',
        status: 'attention',
        limit: 5,
        cursor: first.nextCursor,
      });
      expect(first.items).toHaveLength(5);
      expect(second.items).toHaveLength(5);
      expect(new Set([...first.items, ...second.items].map((r) => r.id)).size).toBe(10);
      const plan = (
        await pool.query(`EXPLAIN(ANALYZE,BUFFERS,FORMAT JSON) ${ORDERS_QUERY}`, [
          owner.id,
          null,
          null,
          null,
          'attention',
          null,
          'token',
          26,
        ])
      ).rows[0]['QUERY PLAN'][0];
      const scans: Record<string, any>[] = [];
      const walk = (node: Record<string, any>) => {
        if (node['Relation Name'] === 'broker_token_orders') scans.push(node);
        for (const child of node.Plans ?? []) walk(child);
      };
      walk(plan.Plan);
      expect(scans).toHaveLength(1);
      expect(scans[0]['Index Name']).toBe('broker_token_orders_owner_attention');
      expect(scans[0]['Actual Rows']).toBeLessThanOrEqual(26);
      expect(scans[0]['Rows Removed by Filter'] ?? 0).toBe(0);
      expect(scans[0]['Shared Hit Blocks']).toBeLessThan(100);
    });
  },
);
