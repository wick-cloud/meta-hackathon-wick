import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { transaction } from '../marketplace/db.js';
import { uuid } from '../marketplace/data.js';
import { INFERENCE_MODEL_ID } from '../../shared/inference.js';
import { withOperation } from '../operations.js';
import {
  activeMode,
  authority,
  catalog,
  event,
  failure,
  grantView,
  lockedGrant,
  operationSchema,
} from './data.js';
import {
  closeGrant,
  createGrant,
  fundGrant,
  grantDetail,
  issueGrantKey,
  listGrants,
  scopedPacks,
} from './grants.js';
import {
  closeGrantLocked,
  closeTokenAuction,
  createTokenOrder,
  cancelTokenOrder,
  initializeInference,
  providerOffering,
  quotes,
  retirePackLocked,
  TOKEN_CLOSE_QUEUE,
  tokenOrderDetail,
  updateOffering,
} from './market.js';
import { complete, receipt, recoverRequest, resolveRequest } from './gateway.js';
import { proposeTokenSupply } from './supply.js';
import { issuePackKey, tokenPack } from './pack-access.js';
import {
  listAgents,
  buyingWorkspace,
  saveBuyingPolicy,
  evaluateBuying,
  acceptBuying,
  purchaseReceipt,
  maintainBuying,
} from './buying.js';

export async function registerInference(app: FastifyInstance, ctx: AppContext) {
  await initializeInference(ctx);
  const id = (request: FastifyRequest) => uuid((request.params as { id: string }).id);
  async function buyer(request: FastifyRequest, mutation = false) {
    const actor = await ctx.requireActor(request, ['buyer']);
    if (!actor.apiKey && mutation && request.headers.origin !== new URL(ctx.config.appUrl).origin)
      failure(403, 'origin_required', 'Browser purchases require the application origin.');
    return actor;
  }
  async function owner(request: FastifyRequest, mutation = false) {
    if (request.headers.authorization !== undefined)
      failure(403, 'owner_required', 'Manage agent funding from a signed-in owner session.');
    const actor = await buyer(request, mutation);
    if (actor.apiKey)
      failure(403, 'owner_required', 'Only the owner can manage grant funding and agent keys.');
    return actor;
  }
  app.get('/api/inference/agents', async (r) => listAgents(ctx, await owner(r), r.query));
  app.get('/api/inference/grants/:id/buying', async (r) =>
    buyingWorkspace(ctx, await owner(r), id(r)),
  );
  app.put('/api/inference/grants/:id/buying', async (r) =>
    saveBuyingPolicy(ctx, await owner(r, true), id(r), r.body),
  );
  app.post('/api/inference/grants/:id/buying/evaluate', async (r) =>
    evaluateBuying(ctx, await owner(r, true), id(r)),
  );
  app.post('/api/inference/grants/:id/buying/accept', async (r) => {
    const body = z.object({ decisionId: z.uuid() }).strict().parse(r.body);
    return acceptBuying(ctx, await owner(r, true), id(r), body.decisionId);
  });
  app.get('/api/token-orders/:id/purchase-receipt', async (r) =>
    purchaseReceipt(ctx, await owner(r), id(r)),
  );
  app.get('/api/inference/grants', async (r) => listGrants(ctx, await owner(r), r.query));
  app.post('/api/inference/grants', async (r) => createGrant(ctx, await owner(r, true), r.body));
  app.get('/api/inference/grants/:id', async (r) => grantDetail(ctx, await owner(r), id(r)));
  app.post('/api/inference/grants/:id/fund', async (r) =>
    fundGrant(ctx, await owner(r, true), id(r), r.body),
  );
  app.post('/api/inference/grants/:id/close', async (r) =>
    closeGrant(ctx, await owner(r, true), id(r), r.body),
  );
  app.post('/api/inference/grants/:id/keys', async (r) =>
    issueGrantKey(ctx, await owner(r, true), id(r), r.body),
  );
  app.get('/api/inference/models', async (r) => {
    const actor = await buyer(r);
    if (actor.apiKey)
      await transaction(ctx.pool, async (db) => {
        await authority(db, actor, 'inference:read');
        if (!actor.apiKey?.grantId)
          failure(403, 'grant_key_required', 'Use a grant-bound agent key.');
        await lockedGrant(db, actor, actor.apiKey.grantId);
      });
    return catalog(ctx);
  });
  app.get('/api/inference/grant', async (r) => {
    const actor = await buyer(r);
    if (!actor.apiKey?.grantId) failure(403, 'grant_key_required', 'Use a grant-bound agent key.');
    return transaction(ctx.pool, async (db) => {
      await authority(db, actor, 'inference:read');
      return grantView(await lockedGrant(db, actor, actor.apiKey!.grantId!));
    });
  });
  app.get('/api/inference/packs', async (r) => scopedPacks(ctx, await buyer(r), r.query));
  app.get('/api/inference/packs/:id', async (r) => tokenPack(ctx, await buyer(r), id(r)));
  app.post('/api/inference/packs/:id/keys', async (r) =>
    issuePackKey(ctx, await buyer(r, true), id(r), r.body),
  );
  app.post('/api/inference/quotes', async (r) => quotes(ctx, await buyer(r, true), r.body));
  app.post('/api/token-orders', async (r) => createTokenOrder(ctx, await buyer(r, true), r.body));
  app.get('/api/token-orders/:id', async (r) => tokenOrderDetail(ctx, await buyer(r), id(r)));
  app.post('/api/token-orders/:id/cancel', async (r) =>
    cancelTokenOrder(ctx, await buyer(r, true), id(r), r.body),
  );
  app.get('/api/inference/requests/:id', async (r) => receipt(ctx, await buyer(r), id(r)));
  app.get('/api/v1/models', async (r) => {
    const actor = await buyer(r);
    if (!actor.apiKey?.grantId) failure(403, 'grant_key_required', 'Use a grant-bound agent key.');
    const available = await transaction(ctx.pool, async (db) => {
      await authority(db, actor, 'inference:read');
      const grant = await lockedGrant(db, actor, actor.apiKey!.grantId!, true);
      activeMode(ctx, grant);
      const view = await catalog(ctx, db);
      return (
        view.enabled &&
        view.routes.some(
          (route) => route.qualified && grant.allowed_providers.includes(route.provider),
        )
      );
    });
    return {
      object: 'list',
      data: available
        ? [{ id: INFERENCE_MODEL_ID, object: 'model', created: 0, owned_by: 'Meta' }]
        : [],
    };
  });
  app.post('/api/v1/chat/completions', async (r) => complete(ctx, await buyer(r, true), r.body));
  app.post('/api/provider/inference/propose', async (r) => {
    if (
      r.headers.authorization !== undefined ||
      r.headers.origin !== new URL(ctx.config.appUrl).origin
    )
      failure(403, 'owner_required', 'Use the signed-in provider workspace.');
    return proposeTokenSupply(ctx, await ctx.requireActor(r, ['provider']));
  });
  app.get('/api/provider/inference/offering', async (r) => ({
    offering: await providerOffering(ctx, await ctx.requireActor(r, ['provider'])),
    catalog: await catalog(ctx),
  }));
  app.put('/api/provider/inference/offering', async (r) =>
    updateOffering(ctx, await ctx.requireActor(r, ['provider']), r.body),
  );
  app.get('/api/provider/inference/packs', async (r) =>
    scopedPacks(ctx, await ctx.requireActor(r, ['provider']), r.query, true),
  );
  async function operator(r: FastifyRequest) {
    if (
      r.headers.authorization !== undefined ||
      r.headers.origin !== new URL(ctx.config.appUrl).origin
    )
      failure(
        403,
        'operator_required',
        'Use a signed-in operator session from the application origin.',
      );
    return ctx.requireActor(r, ['admin']);
  }
  app.post('/api/admin/inference/requests/:id/resolve', async (r) =>
    resolveRequest(ctx, await operator(r), id(r), r.body),
  );
  app.post('/api/admin/inference/packs/:id/provider-failure', async (r) => {
    const actor = await operator(r),
      packId = id(r);
    const input = z
      .object({ operationKey: operationSchema, evidence: z.string().trim().min(20).max(2000) })
      .strict()
      .parse(r.body);
    const meta = (
      await ctx.pool.query('SELECT grant_id FROM broker_token_packs WHERE id=$1', [packId])
    ).rows[0];
    if (!meta) failure(404, 'not_found', 'Token pack not found.');
    return transaction(ctx.pool, async (db) => {
      await authority(db, actor);
      await db.query('SELECT id FROM broker_inference_grants WHERE id=$1 FOR UPDATE', [
        meta.grant_id,
      ]);
      return withOperation(
        db,
        actor,
        `inference.provider-failure:${packId}`,
        input.operationKey,
        input,
        async () => {
          await db.query(
            'SELECT provider FROM broker_inference_routes ORDER BY provider FOR UPDATE',
          );
          const pack = (
            await db.query('SELECT * FROM broker_token_packs WHERE id=$1 FOR UPDATE', [packId])
          ).rows[0];
          if (pack.status !== 'active')
            failure(
              409,
              'pack_already_retired',
              'This pack already has a terminal retirement decision.',
            );
          await event(
            db,
            pack.grant_id,
            `provider-failure:${packId}`,
            'provider_failure_verified',
            packId,
            actor.id,
            { evidence: input.evidence },
          );
          await retirePackLocked(db, pack, 'provider_failure', input.evidence);
          return { packId, status: 'retiring', evidenceRecorded: true };
        },
      );
    });
  });
}
export async function maintainInference(ctx: AppContext) {
  // Indexed due scans and sequential, bounded recovery; never resend provider requests.
  const orders = (
    await ctx.pool.query(
      `SELECT id FROM broker_token_orders WHERE status='open' AND closes_at<=statement_timestamp() ORDER BY closes_at,id LIMIT 100`,
    )
  ).rows;
  for (const order of orders) await closeTokenAuction(ctx, order.id);
  const requests = (
    await ctx.pool.query(
      `SELECT id FROM broker_inference_requests WHERE status IN('reserved','dispatching','outcome_unknown') AND deadline_at<=statement_timestamp() ORDER BY deadline_at,id LIMIT 100`,
    )
  ).rows;
  for (const request of requests) await recoverRequest(ctx, request.id);
  const grants = (
    await ctx.pool.query(
      `SELECT id FROM broker_inference_grants WHERE status='active' AND expires_at<=statement_timestamp() ORDER BY expires_at,id LIMIT 100`,
    )
  ).rows;
  for (const row of grants)
    await transaction(ctx.pool, async (db) => {
      const grant = (
        await db.query('SELECT * FROM broker_inference_grants WHERE id=$1 FOR UPDATE', [row.id])
      ).rows[0];
      if (grant.status !== 'active') return;
      await closeGrantLocked(db, grant, 'expired');
      await event(db, grant.id, 'expiry:closed', 'grant_expired', grant.id);
    });
}
export async function startInferenceWorkers(ctx: AppContext) {
  const maintenance = 'broker-inference-maintenance';
  const buying = 'broker-inference-buying';
  await ctx.boss.createQueue(buying);
  await ctx.boss.work(buying, { localConcurrency: 1 }, async () => maintainBuying(ctx));
  await ctx.boss.schedule(buying, '* * * * *', {}, { tz: 'UTC' });
  await ctx.boss.createQueue(TOKEN_CLOSE_QUEUE);
  await ctx.boss.createQueue(maintenance);
  await ctx.boss.work<{ id: string }>(
    TOKEN_CLOSE_QUEUE,
    { localConcurrency: 1, pollingIntervalSeconds: 1 },
    async (jobs) => {
      for (const job of jobs) await closeTokenAuction(ctx, uuid(job.data.id));
    },
  );
  await ctx.boss.work(maintenance, { localConcurrency: 1 }, async () => maintainInference(ctx));
  await ctx.boss.schedule(maintenance, '* * * * *', {}, { tz: 'UTC' });
  await maintainInference(ctx);
}
