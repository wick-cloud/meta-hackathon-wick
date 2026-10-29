import type { FastifyInstance } from 'fastify';
import { HttpError, type AppContext } from '../context.js';
import { transaction } from '../marketplace/db.js';
import { encodeCursor, getProvider, integer, pagination, uuid } from '../marketplace/data.js';
import { assertProviderCatalog } from '../marketplace/provider-identity.js';
import { managedPricing, requireFreshManagedRate } from '../../shared/pricing.js';
import { fingerprint } from './credits.js';
import { bookingView, globalLock, offeringView, deadlineEligible } from './data.js';
import { validateOffering } from './recurrence.js';

export async function registerProviderAgreementRoutes(app: FastifyInstance, ctx: AppContext) {
  app.get('/api/provider/scheduled-offerings', async (request) => {
    const provider = await getProvider(ctx.pool, await ctx.requireActor(request, ['provider'])),
      p = pagination(request.query);
    const rows = (
      await ctx.pool.query(
        'SELECT s.*,c.item,s.created_at::text AS cursor_created_at FROM broker_scheduled_offerings s JOIN broker_catalog c ON c.id=s.catalog_id WHERE s.provider_id=$1 AND ($2::timestamptz IS NULL OR(s.created_at,s.id)<($2,$3::uuid)) ORDER BY s.created_at DESC,s.id DESC LIMIT $4',
        [provider.id, p.cursor, p.cursorId, p.limit + 1],
      )
    ).rows;
    return {
      items: rows.slice(0, p.limit).map((r) => offeringView(ctx, r)),
      ...(rows.length > p.limit ? { nextCursor: encodeCursor(rows[p.limit - 1]) } : {}),
    };
  });
  app.post('/api/provider/scheduled-offerings', async (request) => {
    const provider = await getProvider(ctx.pool, await ctx.requireActor(request, ['provider'])),
      input = validateOffering(request.body),
      digest = fingerprint(input);
    return transaction(ctx.pool, async (db) => {
      await globalLock(db);
      const p = (
        await db.query('SELECT * FROM broker_providers WHERE id=$1 FOR UPDATE', [provider.id])
      ).rows[0];
      const prior = (
        await db.query(
          'SELECT s.*,c.item FROM broker_scheduled_offerings s JOIN broker_catalog c ON c.id=s.catalog_id WHERE s.provider_id=$1 AND s.operation_key=$2',
          [p.id, input.operationKey],
        )
      ).rows[0];
      if (prior) {
        if (prior.input_fingerprint !== digest)
          throw new HttpError(409, 'This operation key was used for another scheduled offering.');
        return offeringView(ctx, prior);
      }
      if (
        input.capacityQuantity > Math.max(0, p.total_capacity - Number(p.policy.reserveSlots ?? 0))
      )
        throw new HttpError(409, 'Scheduled quantity exceeds this provider’s usable capacity.');
      const catalog = (
        await db.query('SELECT * FROM broker_catalog WHERE id=$1 AND approved AND source_mode=$2', [
          input.catalogId,
          ctx.wick.mode,
        ])
      ).rows[0];
      if (!catalog) throw new HttpError(409, 'Choose a currently approved configuration.');
      if (!deadlineEligible(ctx, catalog.item))
        throw new HttpError(
          409,
          'This route does not attest native hard-deadline enforcement. It cannot publish strict scheduled availability.',
        );
      assertProviderCatalog(p, catalog.item);
      if (
        Array.isArray(p.policy.allowedCatalogIds) &&
        !p.policy.allowedCatalogIds.includes(input.catalogId)
      )
        throw new HttpError(
          409,
          'The provider policy excludes this configuration for new offerings.',
        );
      if (input.normalRateCentsPerHour < input.discountRateCentsPerHour)
        throw new HttpError(400, 'The published normal rate cannot be below the discounted rate.');
      if (ctx.wick.mode === 'real') {
        try {
          requireFreshManagedRate(catalog.item);
          const rate = managedPricing(catalog.item).rateMicrosPerSecond;
          for (const price of [input.discountRateCentsPerHour, input.normalRateCentsPerHour])
            if (BigInt(price) * 8500n < BigInt(rate) * 3600n)
              throw new Error('The provider’s 85% must cover the published Wick compute rate.');
        } catch (error) {
          throw new HttpError(
            409,
            error instanceof Error ? error.message : 'Refresh managed pricing.',
          );
        }
      }
      const r = (
        await db.query(
          `INSERT INTO broker_scheduled_offerings(provider_id,operation_key,input_fingerprint,catalog_id,name,kind,time_zone,weekdays,window_start,window_end,available_until,capacity_quantity,discount_rate_cents_per_hour,normal_rate_cents_per_hour) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *`,
          [
            p.id,
            input.operationKey,
            digest,
            input.catalogId,
            input.name,
            input.kind,
            input.timeZone,
            input.weekdays,
            input.windowStart,
            input.windowEnd,
            input.availableUntil,
            input.capacityQuantity,
            input.discountRateCentsPerHour,
            input.normalRateCentsPerHour,
          ],
        )
      ).rows[0];
      return offeringView(ctx, { ...r, item: catalog.item });
    });
  });
  app.patch('/api/provider/scheduled-offerings/:id', async (request) => {
    const provider = await getProvider(ctx.pool, await ctx.requireActor(request, ['provider'])),
      id = uuid((request.params as { id: string }).id),
      b = request.body as { active?: unknown; expectedRevision?: unknown };
    if (typeof b?.active !== 'boolean') throw new HttpError(400, 'Set active to true or false.');
    const revision = integer(b.expectedRevision, 'Offering revision', 1);
    return transaction(ctx.pool, async (db) => {
      await globalLock(db);
      await db.query('SELECT id FROM broker_providers WHERE id=$1 FOR UPDATE', [provider.id]);
      if (b.active) {
        const route = (
          await db.query(
            'SELECT c.item,c.approved,c.source_mode FROM broker_scheduled_offerings s JOIN broker_catalog c ON c.id=s.catalog_id WHERE s.id=$1 AND s.provider_id=$2',
            [id, provider.id],
          )
        ).rows[0];
        if (
          !route ||
          !route.approved ||
          route.source_mode !== ctx.wick.mode ||
          !deadlineEligible(ctx, route.item)
        )
          throw new HttpError(
            409,
            'This route does not attest native hard-deadline enforcement. It cannot publish strict scheduled availability.',
          );
      }
      const r = (
        await db.query(
          'UPDATE broker_scheduled_offerings SET active=$3,revision=revision+1 WHERE id=$1 AND provider_id=$2 AND revision=$4 RETURNING *',
          [id, provider.id, b.active, revision],
        )
      ).rows[0];
      if (!r)
        throw new HttpError(409, 'This offering changed or is unavailable. Reload before editing.');
      const catalog = (
        await db.query('SELECT item FROM broker_catalog WHERE id=$1', [r.catalog_id])
      ).rows[0];
      return offeringView(ctx, { ...r, item: catalog.item });
    });
  });
  app.get('/api/provider/agreement-demand', async (request) => {
    await getProvider(ctx.pool, await ctx.requireActor(request, ['provider']));
    const p = pagination(request.query);
    const rows = (
      await ctx.pool.query(
        `SELECT a.*,a.created_at::text cursor_created_at,COALESCE(w.approved,0)::int approved FROM broker_agreements a LEFT JOIN LATERAL(SELECT min(approved_quantity) approved FROM broker_agreement_windows WHERE agreement_id=a.id AND starts_at>clock_timestamp()) w ON true WHERE a.source_mode=$1 AND a.status IN('open','approved') AND a.accepting_topups AND a.expires_at>clock_timestamp() AND COALESCE(w.approved,0)<a.target_quantity AND ($2::timestamptz IS NULL OR(a.created_at,a.id)<($2,$3::uuid)) ORDER BY a.created_at DESC,a.id DESC LIMIT $4`,
        [ctx.wick.mode, p.cursor, p.cursorId, p.limit + 1],
      )
    ).rows;
    return {
      items: rows.slice(0, p.limit).map((r) => ({
        id: r.id,
        description: r.description,
        timeZone: r.time_zone,
        minimumQuantity: r.minimum_quantity,
        targetQuantity: r.target_quantity,
        approvedQuantity: r.approved,
        startsAt: new Date(r.starts_at).toISOString(),
        endsAt: new Date(r.expires_at).toISOString(),
        region: r.specification.region,
        requirements: r.specification.requirements,
        maxDiscountRateCentsPerHour: r.specification.maxDiscountRateCentsPerHour,
        maxNormalRateCentsPerHour: r.specification.continuation?.maxRateCentsPerHour ?? 0,
      })),
      ...(rows.length > p.limit ? { nextCursor: encodeCursor(rows[p.limit - 1]) } : {}),
    };
  });
  app.get('/api/provider/commitments', async (request) => {
    const provider = await getProvider(ctx.pool, await ctx.requireActor(request, ['provider'])),
      p = pagination(request.query),
      q = (request.query ?? {}) as { from?: string; to?: string };
    const now = (await ctx.pool.query('SELECT clock_timestamp() at')).rows[0].at.getTime(),
      from = q.from ?? new Date(now - 86400000).toISOString(),
      to = q.to ?? new Date(now + 37 * 86400000).toISOString();
    if (
      !Number.isFinite(Date.parse(from)) ||
      !Number.isFinite(Date.parse(to)) ||
      Date.parse(to) <= Date.parse(from) ||
      Date.parse(to) - Date.parse(from) > 62 * 86400000
    )
      throw new HttpError(400, 'Choose a commitment range no longer than 62 days.');
    const rows = (
      await ctx.pool.query(
        `SELECT b.*,a.description agreement_description,b.starts_at::text cursor_created_at,COALESCE(x.n,0)::int occupied FROM broker_agreement_bookings b JOIN broker_agreements a ON a.id=b.agreement_id LEFT JOIN LATERAL(SELECT count(*) n FROM broker_agreement_activations x WHERE x.booking_id=b.id AND x.cleaned_at IS NULL) x ON true WHERE b.provider_id=$1 AND b.starts_at>=$2::timestamptz-interval '24 hours' AND b.starts_at<$3 AND b.ends_at>$2 AND ($4::timestamptz IS NULL OR(b.starts_at,b.id)>($4,$5::uuid)) ORDER BY b.starts_at,b.id LIMIT $6`,
        [provider.id, from, to, p.cursor, p.cursorId, p.limit + 1],
      )
    ).rows;
    return {
      items: rows.slice(0, p.limit).map((r) => ({
        ...bookingView(r),
        agreementId: r.agreement_id,
        agreementDescription: r.agreement_description,
        runningQuantity: r.occupied,
      })),
      ...(rows.length > p.limit ? { nextCursor: encodeCursor(rows[p.limit - 1]) } : {}),
    };
  });
}
