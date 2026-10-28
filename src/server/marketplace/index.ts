import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { fixedQuote, managedPricing, requireFreshManagedRate } from '../../shared/pricing.js';
import type { Actor, CatalogItem, SupplierPolicy, Mode } from '../../shared/types.js';
import { HttpError, type AppContext } from '../context.js';
import { transaction, enqueue, activity, QUEUES } from './db.js';
import { createRequest, submitBid, closeAuction, proposeBid } from './auction.js';
import { provisionVm, cleanupVm, terminateVm } from './lifecycle.js';
import { startCatalogRefresh } from './catalog-refresh.js';
import {
  requestView,
  bidView,
  offeringView,
  vmView,
  getProvider,
  getCatalog,
  syncCatalog,
  integer,
  shortText,
  uuid,
  pagination,
  encodeCursor,
  iso,
  type Row,
} from './data.js';
export {
  createRequest,
  submitBid,
  closeAuction,
  proposeBid,
  provisionVm,
  cleanupVm,
  getCatalog,
  getProvider,
  requestView,
  syncCatalog,
};
export { markReady, confirmCleanup } from './lifecycle.js';

export async function registerMarketplace(app: FastifyInstance, ctx: AppContext) {
  const proposalCalls = new Map<string, { count: number; resetsAt: number }>();
  app.post('/api/requests', async (request) =>
    createRequest(ctx, await ctx.requireActor(request, ['buyer']), request.body as Row),
  );
  app.get('/api/requests', async (request) => {
    const actor = await ctx.requireActor(request, ['buyer']);
    const { limit, cursor, cursorId } = pagination(request.query);
    const rows = (
      await ctx.pool.query(
        'SELECT *,created_at::text AS cursor_created_at FROM broker_requests WHERE buyer_id=$1 AND ($2::timestamptz IS NULL OR (created_at,id)<($2,$3::uuid)) ORDER BY created_at DESC,id DESC LIMIT $4',
        [actor.id, cursor, cursorId, limit + 1],
      )
    ).rows;
    return page(rows, limit, requestView);
  });
  app.get<{ Params: { id: string } }>('/api/requests/:id', async (request) => {
    const actor = await ctx.requireActor(request, ['buyer']);
    const id = uuid(request.params.id);
    const row = (
      await ctx.pool.query('SELECT * FROM broker_requests WHERE id=$1 AND buyer_id=$2', [
        id,
        actor.id,
      ])
    ).rows[0];
    if (!row) throw new HttpError(404, 'Request not found.');
    const bids = (
      await ctx.pool.query(
        'SELECT b.*,p.name AS provider_name FROM broker_bids b JOIN broker_providers p ON p.id=b.provider_id WHERE b.request_id=$1 ORDER BY b.total_price_cents,b.created_at,b.id',
        [id],
      )
    ).rows;
    const vm = (
      await ctx.pool.query('SELECT * FROM broker_vms WHERE request_id=$1 AND buyer_id=$2', [
        id,
        actor.id,
      ])
    ).rows[0];
    return { request: requestView(row), bids: bids.map(bidView), vm: vm ? vmView(vm) : null };
  });
  app.post<{ Params: { id: string } }>('/api/requests/:id/cancel', async (request) => {
    const actor = await ctx.requireActor(request, ['buyer']);
    const id = uuid(request.params.id);
    const result = await transaction(ctx.pool, async (db) => {
      const row = (
        await db.query('SELECT * FROM broker_requests WHERE id=$1 AND buyer_id=$2 FOR UPDATE', [
          id,
          actor.id,
        ])
      ).rows[0];
      if (!row) throw new HttpError(404, 'Request not found.');
      if (row.status === 'cancelled') return { cancelled: true };
      if (row.status !== 'open')
        throw new HttpError(
          409,
          'The auction has ended. Manage termination from the VM detail page.',
        );
      await db.query("UPDATE broker_requests SET status='cancelled' WHERE id=$1", [id]);
      await db.query("UPDATE broker_bids SET status='cancelled' WHERE request_id=$1", [id]);
      await db.query(
        "UPDATE broker_holds SET released_at=now(),release_reason='Buyer cancelled auction' WHERE bid_id IN(SELECT id FROM broker_bids WHERE request_id=$1) AND released_at IS NULL",
        [id],
      );
      return { cancelled: true };
    });
    return result;
  });
  app.post<{ Params: { id: string } }>('/api/requests/:id/retry', async (request) => {
    const actor = await ctx.requireActor(request, ['buyer']);
    const id = uuid(request.params.id);
    const row = (
      await ctx.pool.query('SELECT * FROM broker_requests WHERE id=$1 AND buyer_id=$2', [
        id,
        actor.id,
      ])
    ).rows[0];
    if (!row) throw new HttpError(404, 'Request not found.');
    if (!['no_offers', 'failed', 'cancelled'].includes(row.status))
      throw new HttpError(409, 'Only a finished unsuccessful attempt can be retried.');
    return createRequest(ctx, actor, requestView(row), id);
  });
  app.get('/api/vms', async (request) => {
    const actor = await ctx.requireActor(request, ['buyer']);
    const { limit, cursor, cursorId } = pagination(request.query);
    const rows = (
      await ctx.pool.query(
        'SELECT *,created_at::text AS cursor_created_at FROM broker_vms WHERE buyer_id=$1 AND ($2::timestamptz IS NULL OR (created_at,id)<($2,$3::uuid)) ORDER BY created_at DESC,id DESC LIMIT $4',
        [actor.id, cursor, cursorId, limit + 1],
      )
    ).rows;
    return page(rows, limit, vmView);
  });
  app.get<{ Params: { id: string } }>('/api/vms/:id', async (request) => {
    const actor = await ctx.requireActor(request, ['buyer']);
    const id = uuid(request.params.id);
    const vm = (
      await ctx.pool.query('SELECT * FROM broker_vms WHERE id=$1 AND buyer_id=$2', [id, actor.id])
    ).rows[0];
    if (!vm) throw new HttpError(404, 'VM not found.');
    return vmView(vm);
  });
  app.post<{ Params: { id: string } }>('/api/vms/:id/terminate', async (request) => {
    const actor = await ctx.requireActor(request, ['buyer']);
    if (!(await terminateVm(ctx, actor.id, uuid(request.params.id))))
      throw new HttpError(404, 'VM not found.');
    return {
      accepted: true,
      message:
        'Termination requested. The supplier slot stays reserved until Wick confirms cleanup.',
    };
  });
  app.get('/api/invoices', async (request) => {
    const actor = await ctx.requireActor(request, ['buyer']);
    const { limit, cursor, cursorId } = pagination(request.query);
    const rows = (
      await ctx.pool.query(
        `SELECT i.*,i.created_at::text AS cursor_created_at,v.catalog_snapshot,v.quote_snapshot FROM broker_invoices i JOIN broker_vms v ON v.id=i.vm_id WHERE i.buyer_id=$1 AND ($2::timestamptz IS NULL OR (i.created_at,i.id)<($2,$3::uuid)) ORDER BY i.created_at DESC,i.id DESC LIMIT $4`,
        [actor.id, cursor, cursorId, limit + 1],
      )
    ).rows;
    return page(rows, limit, (r) => ({
      id: r.id,
      vmId: r.vm_id,
      subtotalCents: r.subtotal_cents,
      feeCents: r.fee_cents,
      totalCents: r.total_cents,
      currency: r.currency,
      status: r.status,
      createdAt: iso(r.created_at),
      catalogName: r.catalog_snapshot.name,
      label: 'No payment due',
      ...(r.quote_snapshot.pricing ? { pricing: r.quote_snapshot.pricing } : {}),
      simulated: true,
    }));
  });

  app.get('/api/provider/dashboard', async (request) => {
    const p = await getProvider(ctx.pool, await ctx.requireActor(request, ['provider']));
    const held = Number(
      (
        await ctx.pool.query(
          'SELECT count(*)::int AS n FROM broker_holds WHERE provider_id=$1 AND released_at IS NULL',
          [p.id],
        )
      ).rows[0].n,
    );
    const events = (
      await ctx.pool.query(
        'SELECT * FROM broker_activity WHERE provider_id=$1 ORDER BY id DESC LIMIT 20',
        [p.id],
      )
    ).rows;
    return {
      provider: { id: p.id, name: p.name, simulated: true },
      policy: p.policy,
      capacity: { total: p.total_capacity, held, available: Math.max(0, p.total_capacity - held) },
      activity: events.map(activityView),
    };
  });
  app.put('/api/provider/capacity', async (request) => {
    const actor = await ctx.requireActor(request, ['provider']);
    const total = integer((request.body as Row)?.total, 'Total simulated capacity', 0, 10000);
    return transaction(ctx.pool, async (db) => {
      const p = await getProvider(db, actor);
      await db.query('UPDATE broker_providers SET total_capacity=$2 WHERE id=$1', [p.id, total]);
      await activity(
        db,
        p.id,
        null,
        'capacity_changed',
        `Simulated capacity set to ${total}. Existing reservations retained.`,
      );
      return { total };
    });
  });
  app.put('/api/provider/policy', async (request) => {
    const actor = await ctx.requireActor(request, ['provider']);
    const body = request.body as Row;
    if (typeof body?.autoBid !== 'boolean')
      throw new HttpError(400, 'Auto bid must be true or false.');
    const policy: SupplierPolicy = {
      autoBid: body.autoBid,
      minimumPriceCents: integer(body.minimumPriceCents, 'Minimum total price'),
      basePriceCents: integer(body.basePriceCents, 'Base total price'),
    };
    if (policy.basePriceCents < policy.minimumPriceCents)
      throw new HttpError(400, 'Base price must be at least the minimum price.');
    if (body.maxPriceCents !== undefined && body.maxPriceCents !== null) {
      policy.maxPriceCents = integer(body.maxPriceCents, 'Maximum total price');
      if (policy.maxPriceCents < policy.basePriceCents)
        throw new HttpError(400, 'Maximum price must be at least the base price.');
    }
    if (body.allowedCatalogIds !== undefined) {
      if (
        !Array.isArray(body.allowedCatalogIds) ||
        body.allowedCatalogIds.length > 100 ||
        body.allowedCatalogIds.some((id: unknown) => typeof id !== 'string')
      )
        throw new HttpError(400, 'Allowed configurations must be a list of catalog IDs.');
      policy.allowedCatalogIds = body.allowedCatalogIds;
    }
    return transaction(ctx.pool, async (db) => {
      const p = await getProvider(db, actor);
      await db.query('UPDATE broker_providers SET policy=$2 WHERE id=$1', [p.id, policy]);
      await activity(
        db,
        p.id,
        null,
        'policy_changed',
        'Pricing policy updated. Previously accepted bids and reservations remain binding.',
      );
      return policy;
    });
  });
  app.get('/api/provider/requests', async (request) => {
    await ctx.requireActor(request, ['provider']);
    const { limit, cursor, cursorId } = pagination(request.query);
    const rows = (
      await ctx.pool.query(
        "SELECT *,created_at::text AS cursor_created_at FROM broker_requests WHERE status='open' AND closes_at>clock_timestamp() AND ($1::timestamptz IS NULL OR (created_at,id)<($1,$2::uuid)) ORDER BY created_at DESC,id DESC LIMIT $3",
        [cursor, cursorId, limit + 1],
      )
    ).rows;
    return page(rows, limit, (r) => {
      const { buyerId, ...visible } = requestView(r);
      return visible;
    });
  });
  app.post<{ Params: { id: string } }>('/api/provider/requests/:id/bids', async (request) => {
    const actor = await ctx.requireActor(request, ['provider']);
    const body = request.body as Row;
    return submitBid(ctx, actor, uuid(request.params.id), {
      totalPriceCents: body?.totalPriceCents,
      offeringId: body?.offeringId ? uuid(body.offeringId) : undefined,
    });
  });
  app.post<{ Params: { id: string } }>('/api/provider/requests/:id/propose', async (request) => {
    const actor = await ctx.requireActor(request, ['provider']);
    const now = Date.now();
    if (proposalCalls.size > 10000)
      for (const [key, budget] of proposalCalls)
        if (budget.resetsAt <= now) proposalCalls.delete(key);
    const budget = proposalCalls.get(actor.id);
    if (budget && budget.resetsAt > now) {
      if (budget.count >= 10)
        throw new HttpError(
          429,
          'Proposal limit reached. Try again in a minute; manual bidding remains available.',
        );
      budget.count++;
    } else proposalCalls.set(actor.id, { count: 1, resetsAt: now + 60000 });
    return proposeBid(ctx, actor, uuid(request.params.id));
  });
  app.get('/api/provider/offerings', async (request) => {
    const p = await getProvider(ctx.pool, await ctx.requireActor(request, ['provider']));
    const { limit, cursor, cursorId } = pagination(request.query);
    return page(
      (
        await ctx.pool.query(
          'SELECT *,created_at::text AS cursor_created_at FROM broker_offerings WHERE provider_id=$1 AND ($2::timestamptz IS NULL OR (created_at,id)<($2,$3::uuid)) ORDER BY created_at DESC,id DESC LIMIT $4',
          [p.id, cursor, cursorId, limit + 1],
        )
      ).rows,
      limit,
      offeringView,
    );
  });
  app.post('/api/provider/offerings', async (request) => {
    const actor = await ctx.requireActor(request, ['provider']);
    const b = request.body as Row;
    const catalogId = shortText(b?.catalogId, 'Configuration', 160),
      name = shortText(b?.name, 'Offering name', 160),
      description = shortText(b?.description, 'Offering description', 2000);
    const fixturePrice =
      ctx.wick.mode === 'fixture' ? integer(b?.priceCents, 'Total price') : undefined;
    return transaction(ctx.pool, async (db) => {
      const p = await getProvider(db, actor);
      const c = (
        await db.query(
          'SELECT approved,item FROM broker_catalog WHERE id=$1 AND source_mode=$2 FOR SHARE',
          [catalogId, ctx.wick.mode],
        )
      ).rows[0];
      if (!c?.approved)
        throw new HttpError(
          400,
          'Offerings must use an administrator-approved existing Wick configuration.',
        );
      let pricing;
      if (ctx.wick.mode === 'real') {
        try {
          requireFreshManagedRate(c.item);
          pricing = managedPricing(c.item, ctx.config.targetMarkupBps);
        } catch (error) {
          throw new HttpError(400, (error as Error).message);
        }
      }
      const price = pricing ? fixedQuote(pricing, 30).totalPriceCents : fixturePrice!;
      if (
        price < p.policy.minimumPriceCents ||
        (p.policy.maxPriceCents !== undefined && price > p.policy.maxPriceCents)
      )
        throw new HttpError(400, 'Offering price is outside your pricing policy.');
      const duplicate = (
        await db.query(
          'SELECT id FROM broker_offerings WHERE provider_id=$1 AND catalog_id=$2 AND name=$3',
          [p.id, catalogId, name],
        )
      ).rows[0];
      if (duplicate)
        throw new HttpError(409, 'An offering with this name and configuration already exists.');
      const r = (
        await db.query(
          'INSERT INTO broker_offerings(provider_id,catalog_id,name,description,price_cents,pricing) VALUES($1,$2,$3,$4,$5,$6) RETURNING *',
          [p.id, catalogId, name, description, price, pricing ?? null],
        )
      ).rows[0];
      await activity(
        db,
        p.id,
        null,
        'offering_published',
        'Published an offering using an existing administrator-approved configuration.',
      );
      return offeringView(r);
    });
  });
  app.patch<{ Params: { id: string } }>('/api/provider/offerings/:id', async (request) => {
    const p = await getProvider(ctx.pool, await ctx.requireActor(request, ['provider']));
    const active = (request.body as Row)?.active;
    if (typeof active !== 'boolean') throw new HttpError(400, 'Active must be true or false.');
    const row = (
      await ctx.pool.query(
        'UPDATE broker_offerings SET active=$3,revision=revision+1 WHERE id=$1 AND provider_id=$2 RETURNING *',
        [uuid(request.params.id), p.id, active],
      )
    ).rows[0];
    if (!row) throw new HttpError(404, 'Offering not found.');
    return offeringView(row);
  });
  app.get('/api/provider/activity', async (request) => {
    const p = await getProvider(ctx.pool, await ctx.requireActor(request, ['provider']));
    const { limit, cursor, cursorId } = pagination(request.query);
    return page(
      (
        await ctx.pool.query(
          'SELECT *,created_at::text AS cursor_created_at FROM broker_activity WHERE provider_id=$1 AND ($2::timestamptz IS NULL OR (created_at,id)<($2,$3::bigint)) ORDER BY created_at DESC,id DESC LIMIT $4',
          [p.id, cursor, cursorId, limit + 1],
        )
      ).rows,
      limit,
      activityView,
    );
  });
  app.get('/api/admin/config', async (request) => {
    await ctx.requireActor(request, ['admin']);
    const providers = (
      await ctx.pool.query(
        `SELECT p.id,p.name,p.total_capacity,(SELECT count(*)::int FROM broker_holds h WHERE h.provider_id=p.id AND h.released_at IS NULL) AS held FROM broker_providers p ORDER BY p.name`,
      )
    ).rows.map((r) => ({
      id: r.id,
      name: r.name,
      total: r.total_capacity,
      held: r.held,
      simulated: true,
    }));
    const max =
      (await ctx.pool.query("SELECT value FROM broker_settings WHERE key='maxConcurrentVms'"))
        .rows[0]?.value ?? ctx.config.maxConcurrentVms;
    const unresolved = (
      await ctx.pool.query(
        "SELECT * FROM broker_vms WHERE cleanup_confirmed_at IS NULL AND (status IN ('failed','terminating','expired') OR poll_attempts>=60) ORDER BY created_at LIMIT 100",
      )
    ).rows.map(vmView);
    return {
      modes: { wick: ctx.wick.mode, muse: ctx.muse.mode },
      catalog: await getCatalog(ctx),
      providers,
      maxConcurrentVms: Number(max),
      feeCents: 0,
      unresolved,
    };
  });
  app.put('/api/admin/config', async (request) => {
    await ctx.requireActor(request, ['admin']);
    const max = integer((request.body as Row)?.maxConcurrentVms, 'Concurrent VM limit', 1, 20);
    await ctx.pool.query(
      "INSERT INTO broker_settings(key,value) VALUES('maxConcurrentVms',$1) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      [max],
    );
    return { maxConcurrentVms: max };
  });
  app.put<{ Params: { id: string } }>('/api/admin/catalog/:id', async (request) => {
    await ctx.requireActor(request, ['admin']);
    const approved = (request.body as Row)?.approved;
    if (typeof approved !== 'boolean') throw new HttpError(400, 'Approved must be true or false.');
    if (approved && ctx.wick.mode === 'real') {
      const row = (
        await ctx.pool.query('SELECT item FROM broker_catalog WHERE id=$1 AND source_mode=$2', [
          request.params.id,
          'real',
        ])
      ).rows[0];
      if (!row) throw new HttpError(404, 'Configuration not found.');
      try {
        requireFreshManagedRate(row.item);
        managedPricing(row.item, ctx.config.targetMarkupBps);
      } catch (error) {
        throw new HttpError(400, (error as Error).message);
      }
    }
    const result = await ctx.pool.query(
      'UPDATE broker_catalog SET approved=$2,updated_at=now() WHERE id=$1 RETURNING item',
      [request.params.id, approved],
    );
    if (!result.rows[0]) throw new HttpError(404, 'Configuration not found.');
    return { ...result.rows[0].item, approved };
  });
  app.post('/api/admin/catalog/sync', async (request) => {
    await ctx.requireActor(request, ['admin']);
    return { items: await syncCatalog(ctx) };
  });
  app.post<{ Params: { id: string } }>('/api/admin/vms/:id/reconcile', async (request) => {
    await ctx.requireActor(request, ['admin']);
    const vmId = uuid(request.params.id);
    await transaction(ctx.pool, async (db) => {
      const vm = (await db.query('SELECT * FROM broker_vms WHERE id=$1 FOR UPDATE', [vmId]))
        .rows[0];
      if (!vm) throw new HttpError(404, 'VM not found.');
      if (vm.cleanup_confirmed_at) return;
      await db.query('UPDATE broker_vms SET cleanup_attempts=0 WHERE id=$1', [vmId]);
      await enqueue(ctx, db, QUEUES.cleanup, { vmId });
    });
    return { accepted: true };
  });
}
function page(rows: Row[], limit: number, map: (r: Row) => unknown) {
  return {
    items: rows.slice(0, limit).map(map),
    ...(rows.length > limit ? { nextCursor: encodeCursor(rows[limit - 1]) } : {}),
  };
}
function activityView(r: Row) {
  return {
    id: String(r.id),
    kind: r.kind,
    message: r.message,
    createdAt: iso(r.created_at),
    ...(r.receipt ? { receipt: r.receipt, mode: r.mode, modelCalled: r.model_called } : {}),
  };
}

export async function startMarketplaceWorkers(ctx: AppContext) {
  const mismatched = (
    await ctx.pool.query(
      "SELECT id FROM broker_vms WHERE cleanup_confirmed_at IS NULL AND COALESCE(catalog_snapshot->>'sourceMode','fixture')<>$1 LIMIT 1",
      [ctx.wick.mode],
    )
  ).rows[0];
  if (mismatched)
    throw new Error(
      'Cannot switch Wick mode while a prior-mode rental still awaits confirmed cleanup. Start with the original mode and finish cleanup first.',
    );
  for (const name of Object.values(QUEUES))
    await ctx.boss.createQueue(name, { retryLimit: 3, retryDelay: 5, expireInSeconds: 120 });
  // A single app instance owns these leases. Restart recovery never changes keys or expiry.
  await ctx.pool.query('UPDATE broker_vms SET lease_until=NULL WHERE lease_until IS NOT NULL');
  await ctx.pool.query(
    "INSERT INTO broker_settings(key,value) VALUES('maxConcurrentVms',$1) ON CONFLICT(key) DO NOTHING",
    [ctx.config.maxConcurrentVms],
  );
  await transaction(ctx.pool, async (db) => {
    const open = (
      await db.query(
        "SELECT id,closes_at FROM broker_requests WHERE status='open' ORDER BY closes_at LIMIT 1000",
      )
    ).rows;
    for (const request of open)
      await enqueue(
        ctx,
        db,
        QUEUES.close,
        { requestId: request.id },
        Math.max(0, Math.ceil((new Date(request.closes_at).getTime() - Date.now()) / 1000)),
      );
    const vms = (
      await db.query(
        'SELECT * FROM broker_vms WHERE cleanup_confirmed_at IS NULL ORDER BY created_at LIMIT 1000',
      )
    ).rows;
    for (const vm of vms) {
      if (vm.status === 'provisioning' && vm.poll_attempts < 60)
        await enqueue(ctx, db, QUEUES.provision, { vmId: vm.id });
      else if (vm.cleanup_attempts < 60)
        await enqueue(
          ctx,
          db,
          QUEUES.cleanup,
          { vmId: vm.id },
          vm.status === 'running' && vm.expires_at
            ? Math.max(0, Math.ceil((new Date(vm.expires_at).getTime() - Date.now()) / 1000))
            : 0,
        );
    }
  });
  await ctx.boss.work<{ requestId: string }>(
    QUEUES.close,
    { localConcurrency: 2, pollingIntervalSeconds: 1 },
    async (jobs) => {
      for (const job of jobs) await closeAuction(ctx, job.data.requestId);
    },
  );
  await ctx.boss.work<{ requestId: string; providerId: string }>(
    QUEUES.auto,
    { localConcurrency: 4, pollingIntervalSeconds: 1 },
    async (jobs) => {
      for (const job of jobs) {
        const { requestId, providerId } = job.data;
        const p = (await ctx.pool.query('SELECT * FROM broker_providers WHERE id=$1', [providerId]))
          .rows[0];
        if (!p?.policy.autoBid) continue;
        const actor: Actor = {
          id: p.user_id,
          name: p.name,
          email: '',
          role: 'provider',
          providerId: p.id,
        };
        try {
          const proposal = await proposeBid(ctx, actor, requestId);
          await transaction(ctx.pool, (db) =>
            activity(
              db,
              p.id,
              requestId,
              'proposal',
              `Proposal ${proposal.decision === 'bid' ? 'offered a fixed-price bid' : 'declined'}. ${ctx.muse.mode === 'fixture' ? 'Fixture simulation; no model call.' : 'Real integration selected; see constraints receipt.'}`,
              { receipt: proposal.receipt, mode: ctx.muse.mode, modelCalled: proposal.modelCalled },
            ),
          );
          if (proposal.decision === 'bid')
            await submitBid(
              ctx,
              actor,
              requestId,
              { totalPriceCents: proposal.totalPriceCents! },
              'auto',
            );
          else
            await transaction(ctx.pool, (db) =>
              activity(
                db,
                p.id,
                requestId,
                'declined',
                `Proposal declined: ${proposal.receipt.decision.slice(0, 300)}`,
              ),
            );
        } catch (error) {
          await transaction(ctx.pool, (db) =>
            activity(
              db,
              p.id,
              requestId,
              'bid_unavailable',
              error instanceof Error
                ? error.message.slice(0, 400)
                : 'Bid proposal failed. Manual bidding remains available.',
            ),
          );
        }
      }
    },
  );
  await ctx.boss.work<{ vmId: string }>(
    QUEUES.provision,
    { localConcurrency: 2, pollingIntervalSeconds: 1 },
    async (jobs) => {
      for (const job of jobs) await provisionVm(ctx, job.data.vmId);
    },
  );
  await ctx.boss.work<{ vmId: string }>(
    QUEUES.cleanup,
    { localConcurrency: 2, pollingIntervalSeconds: 1 },
    async (jobs) => {
      for (const job of jobs) await cleanupVm(ctx, job.data.vmId);
    },
  );
  await startCatalogRefresh(ctx);
}

export async function seedMarketplace(
  pool: Pool,
  actors: Actor[],
  catalog: CatalogItem[],
  mode: Mode = 'fixture',
) {
  if (mode === 'real')
    throw new Error('Real catalog setup requires the explicit configure-real command.');
  await transaction(pool, async (db) => {
    await db.query(
      'UPDATE broker_catalog SET approved=false,updated_at=now() WHERE NOT(id=ANY($1::text[])) OR source_mode<>$2',
      [catalog.map((item) => item.id), mode],
    );
    for (const item of catalog)
      await db.query(
        'INSERT INTO broker_catalog(id,item,approved,source_mode) VALUES($1,$2,$3,$4) ON CONFLICT(id) DO UPDATE SET item=excluded.item,approved=CASE WHEN broker_catalog.source_mode=excluded.source_mode THEN broker_catalog.approved ELSE false END,source_mode=excluded.source_mode,updated_at=now()',
        [item.id, item, item.approved, mode],
      );
    const providers = actors.filter((a) => a.role === 'provider');
    for (let i = 0; i < providers.length; i++) {
      const actor = providers[i];
      const capacities = [3, 2, 0];
      const base = [120, 150, 100][i] ?? 120;
      const policy = {
        autoBid: true,
        minimumPriceCents: Math.max(0, base - 40),
        basePriceCents: base,
        maxPriceCents: 10000,
        allowedCatalogIds: catalog.map((c) => c.id),
      };
      const p = (
        await db.query(
          'INSERT INTO broker_providers(user_id,name,total_capacity,policy) VALUES($1,$2,$3,$4) ON CONFLICT(user_id) DO UPDATE SET name=excluded.name RETURNING *',
          [actor.id, actor.name, capacities[i] ?? 0, policy],
        )
      ).rows[0];
      for (const item of catalog.filter((c) => c.approved))
        await db.query(
          'INSERT INTO broker_offerings(provider_id,catalog_id,name,description,price_cents) VALUES($1,$2,$3,$4,$5) ON CONFLICT(provider_id,catalog_id,name) DO NOTHING',
          [
            p.id,
            item.id,
            `${item.name} · ${actor.name}`,
            'Simulated demo supply using an approved existing Wick configuration. Fixed rental quote; no payment due.',
            base,
          ],
        );
    }
  });
}
