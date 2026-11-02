import type { FastifyInstance } from 'fastify';
import { HttpError, type AppContext } from '../context.js';
import { encodeCursor, getProvider, pagination } from '../marketplace/data.js';
import { bookingView, offeringView } from './data.js';

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
  for (const [method, path] of [
    ['POST', '/api/provider/scheduled-offerings'],
    ['PATCH', '/api/provider/scheduled-offerings/:id'],
    ['POST', '/api/provider/scheduled-offerings/draft'],
  ] as const)
    app.route({
      method,
      url: path,
      handler: async (request) => {
        await ctx.requireActor(request, ['provider']);
        throw new HttpError(410, 'Scheduled VM supply has been removed. Use instant VM offerings.');
      },
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
        `SELECT b.*,a.description agreement_description,a.time_zone,b.starts_at::text cursor_created_at,COALESCE(x.n,0)::int occupied FROM broker_agreement_bookings b JOIN broker_agreements a ON a.id=b.agreement_id LEFT JOIN LATERAL(SELECT count(*) n FROM broker_agreement_activations x WHERE x.booking_id=b.id AND x.cleaned_at IS NULL) x ON true WHERE b.provider_id=$1 AND b.starts_at>=$2::timestamptz-interval '24 hours' AND b.starts_at<$3 AND b.ends_at>$2 AND ($4::timestamptz IS NULL OR(b.starts_at,b.id)>($4,$5::uuid)) ORDER BY b.starts_at,b.id LIMIT $6`,
        [provider.id, from, to, p.cursor, p.cursorId, p.limit + 1],
      )
    ).rows;
    return {
      items: rows.slice(0, p.limit).map((r) => ({
        ...bookingView(r),
        agreementId: r.agreement_id,
        agreementDescription: r.agreement_description,
        timeZone: r.time_zone,
        runningQuantity: r.occupied,
      })),
      ...(rows.length > p.limit ? { nextCursor: encodeCursor(rows[p.limit - 1]) } : {}),
    };
  });
}
