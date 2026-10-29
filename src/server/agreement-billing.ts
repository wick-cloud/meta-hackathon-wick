import type { FastifyInstance } from 'fastify';
import type { AppContext } from './context.js';
import { encodeCursor, getProvider, iso, pagination } from './marketplace/data.js';

/** Charged capacity is separate from instant VM invoices and unused wallet holds. */
export function registerAgreementBilling(app: FastifyInstance, ctx: AppContext) {
  for (const provider of [false, true]) {
    app.get(
      provider ? '/api/provider/agreement-charges' : '/api/agreement-charges',
      async (request) => {
        const actor = await ctx.requireActor(request, provider ? ['provider'] : ['buyer']);
        const owner = provider ? (await getProvider(ctx.pool, actor)).id : actor.id;
        const p = pagination(request.query);
        const rows = (
          await ctx.pool.query(
            `SELECT c.*,c.created_at::text AS cursor_created_at,
        a.description,p.name AS provider_name,b.quantity,b.starts_at,b.discount_ends_at,b.ends_at,
        b.snapshot->'offering'->>'discountRateCentsPerHour' AS discount_rate,
        b.snapshot->'offering'->>'normalRateCentsPerHour' AS normal_rate
        FROM broker_agreement_charges c JOIN broker_agreements a ON a.id=c.agreement_id
        JOIN broker_agreement_bookings b ON b.id=c.booking_id JOIN broker_providers p ON p.id=c.provider_id
        WHERE c.${provider ? 'provider_id' : 'buyer_id'}=$1
        AND ($2::timestamptz IS NULL OR (c.created_at,c.id)<($2,$3::uuid))
        ORDER BY c.created_at DESC,c.id DESC LIMIT $4`,
            [owner, p.cursor, p.cursorId, p.limit + 1],
          )
        ).rows;
        return {
          items: rows.slice(0, p.limit).map((r) => ({
            id: r.id,
            agreementId: r.agreement_id,
            windowId: r.window_id,
            description: r.description,
            providerName: r.provider_name,
            quantity: r.quantity,
            startsAt: iso(r.starts_at),
            discountEndsAt: iso(r.discount_ends_at),
            endsAt: iso(r.ends_at),
            discountRateCentsPerHour: Number(r.discount_rate),
            normalRateCentsPerHour: Number(r.normal_rate),
            grossCents: Number(r.gross_cents),
            creditCents: Number(r.credit_cents),
            totalCents: Number(r.total_cents),
            feeCents: 0,
            revenueShare: r.revenue_share,
            createdAt: iso(r.created_at),
            currency: 'USD',
            status: 'pilot-credit',
            label:
              'Booked capacity settled with Broker pilot credit; no external payment or payout.',
          })),
          ...(rows.length > p.limit ? { nextCursor: encodeCursor(rows[p.limit - 1]) } : {}),
        };
      },
    );
  }
}
