import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { Pool, PoolClient } from 'pg';
import type { CatalogItem } from '../../shared/types.js';
import { managedPricing } from '../../shared/pricing.js';
import { HttpError, type AppContext } from '../context.js';
import { clientOperationKey, withOperation } from '../operations.js';
import { modalComputePromotionQuote } from './compute-promotion.js';
import { integer, offeringView, type Row } from './data.js';
import { activity, transaction } from './db.js';
import { normalizedPolicy } from './policy.js';

const path = '/api/admin/compute-promotion/modal';
const operation = 'admin.modal-compute-promotion.configure';

async function modalProvider(db: Pool | PoolClient, lock = false): Promise<Row> {
  const rows = (
    await db.query(
      `SELECT * FROM broker_providers WHERE cloud_provider='modal' AND simulated=false
       ORDER BY id LIMIT 2${lock ? ' FOR UPDATE' : ''}`,
    )
  ).rows;
  if (!rows.length) throw new HttpError(404, 'A real Modal provider account is not configured.');
  if (rows.length !== 1)
    throw new HttpError(409, 'The promotion requires exactly one real Modal provider account.');
  return rows[0];
}

async function providerView(db: Pool | PoolClient, provider: Row) {
  const held = Number(
    (
      await db.query(
        'SELECT count(*)::int AS n FROM broker_holds WHERE provider_id=$1 AND released_at IS NULL',
        [provider.id],
      )
    ).rows[0].n,
  );
  return {
    id: provider.id,
    name: provider.name,
    cloudProvider: provider.cloud_provider,
    simulated: provider.simulated,
    totalCapacity: provider.total_capacity,
    held,
    policy: normalizedPolicy(provider.policy),
    policyRevision: provider.policy_revision,
  };
}

/** This endpoint can configure only the bounded, operator-funded Modal promotion. */
export function registerComputePromotionAdmin(app: FastifyInstance, ctx: AppContext) {
  app.get(path, async (request) => {
    await ctx.requireActor(request, ['admin']);
    const provider = await modalProvider(ctx.pool);
    const rows = (
      await ctx.pool.query(
        'SELECT * FROM broker_offerings WHERE provider_id=$1 ORDER BY active DESC,catalog_id,created_at DESC,id LIMIT 101',
        [provider.id],
      )
    ).rows;
    return {
      enabled: ctx.config.modalComputePromotionEnabled === true,
      mode: ctx.wick.mode,
      provider: await providerView(ctx.pool, provider),
      offerings: rows.slice(0, 100).map((row) =>
        offeringView({
          ...row,
          simulated: provider.simulated,
          cloud_provider: provider.cloud_provider,
        }),
      ),
      offeringsTruncated: rows.length > 100,
    };
  });

  app.post(path, async (request) => {
    const actor = await ctx.requireActor(request, ['admin']);
    const body = request.body;
    if (!body || typeof body !== 'object' || Array.isArray(body))
      throw new HttpError(400, 'Provide the reviewed promotion configuration.');
    const input = body as Row;
    if (
      Object.keys(input).some(
        (key) => !['operationKey', 'expectedRevision', 'catalogIds'].includes(key),
      )
    )
      throw new HttpError(400, 'Promotion configuration contains an unsupported field.');
    const key = clientOperationKey(input.operationKey, true)!;
    const expectedRevision = integer(input.expectedRevision, 'Expected policy revision', 1);
    if (
      !Array.isArray(input.catalogIds) ||
      input.catalogIds.length < 1 ||
      input.catalogIds.length > 16 ||
      input.catalogIds.some(
        (id: unknown) => typeof id !== 'string' || !id.trim() || id.length > 160,
      ) ||
      new Set(input.catalogIds).size !== input.catalogIds.length
    )
      throw new HttpError(400, 'Choose 1–16 unique, approved native Modal configuration IDs.');
    const catalogIds = [...input.catalogIds].sort() as string[];
    return transaction(ctx.pool, (db) =>
      withOperation(db, actor, operation, key, { expectedRevision, catalogIds }, async () => {
        if (ctx.config.modalComputePromotionEnabled !== true || ctx.wick.mode !== 'real')
          throw new HttpError(409, 'The Modal compute promotion must be enabled in real mode.');
        await db.query("SELECT pg_advisory_xact_lock(hashtext('broker-global-vm-admission'))");
        const provider = await modalProvider(db, true);
        if (provider.policy_revision !== expectedRevision)
          throw new HttpError(409, 'Modal capacity or policy changed. Reload before applying.');
        const catalogs = (
          await db.query(
            "SELECT id,item,approved FROM broker_catalog WHERE id=ANY($1::text[]) AND source_mode='real' ORDER BY id FOR SHARE",
            [catalogIds],
          )
        ).rows;
        if (catalogs.length !== catalogIds.length)
          throw new HttpError(400, 'Every selected configuration must exist in the real catalog.');
        const verified = catalogs.map((row) => {
          const item = { ...row.item, approved: row.approved } as CatalogItem;
          if (
            item.id !== row.id ||
            item.provider !== 'modal' ||
            !item.approved ||
            !Array.isArray(item.durationMinutes) ||
            !item.durationMinutes.length ||
            item.durationMinutes.some((duration) => ![15, 30, 60].includes(duration))
          )
            throw new HttpError(400, 'Only approved native Modal configurations can be enabled.');
          try {
            const pricing = managedPricing(item);
            for (const duration of item.durationMinutes)
              if (!modalComputePromotionQuote(ctx, provider, item, pricing, duration))
                throw new Error('An advertised duration exceeds the promotion upstream cost cap.');
            return { item, pricing };
          } catch (error) {
            throw new HttpError(400, (error as Error).message);
          }
        });
        const policy = {
          ...provider.policy,
          autoBid: true,
          minimumPriceCents: 1,
          basePriceCents: 1,
          maxPriceCents: 1,
          allowedCatalogIds: catalogIds,
        };
        const previousOfferings = (
          await db.query(
            'SELECT * FROM broker_offerings WHERE provider_id=$1 AND catalog_id=ANY($2::text[]) AND active ORDER BY catalog_id,id FOR UPDATE',
            [provider.id, catalogIds],
          )
        ).rows.map((row) =>
          offeringView({
            ...row,
            simulated: provider.simulated,
            cloud_provider: provider.cloud_provider,
          }),
        );
        const updated = (
          await db.query('UPDATE broker_providers SET policy=$2 WHERE id=$1 RETURNING *', [
            provider.id,
            policy,
          ])
        ).rows[0];
        const offerings: Row[] = [];
        for (const { item, pricing } of verified) {
          const active = (
            await db.query(
              'UPDATE broker_offerings SET price_cents=1,pricing=$3,revision=revision+1 WHERE provider_id=$1 AND catalog_id=$2 AND active RETURNING *',
              [provider.id, item.id, pricing],
            )
          ).rows;
          if (active.length) offerings.push(...active);
          else {
            const id = randomUUID();
            offerings.push(
              (
                await db.query(
                  'INSERT INTO broker_offerings(id,provider_id,catalog_id,name,description,price_cents,pricing,active) VALUES($1,$2,$3,$4,$5,1,$6,true) RETURNING *',
                  [
                    id,
                    provider.id,
                    item.id,
                    `Modal ${item.profile} promotion · ${id.slice(0, 8)}`,
                    'One-cent fixed compute rental. The operator Wick account funds upstream compute.',
                    pricing,
                  ],
                )
              ).rows[0],
            );
          }
        }
        await activity(
          db,
          provider.id,
          null,
          'promotion_configured',
          `Administrator ${actor.id} configured Modal one-cent compute pricing at policy revision ${updated.policy_revision}. The operator Wick account funds upstream compute, capped at $1 estimated upstream compute per rental.`,
          {
            mode: 'real',
            modelCalled: false,
            receipt: {
              observed: [
                `Previous policy revision ${provider.policy_revision}: ${JSON.stringify(provider.policy)}`,
                `Selected approved configurations: ${catalogIds.join(', ')}.`,
              ],
              decision:
                'Enable automatic one-cent Modal bids on the explicitly selected configurations.',
              constraints: [
                'Capacity, held reservations, reserved spare slots and existing rental quotes are preserved.',
                'Only fresh managed rates and advertised durations within the upstream cap are enabled.',
                'No VM allocation or model call is performed by this configuration operation.',
              ],
            },
          },
        );
        return {
          enabled: true,
          mode: ctx.wick.mode,
          previousPolicy: provider.policy,
          previousPolicyRevision: provider.policy_revision,
          previousOfferings,
          provider: await providerView(db, updated),
          offerings: offerings.map((row) =>
            offeringView({
              ...row,
              simulated: provider.simulated,
              cloud_provider: provider.cloud_provider,
            }),
          ),
        };
      }),
    );
  });
}
