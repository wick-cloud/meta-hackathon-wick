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
