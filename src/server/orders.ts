import type { FastifyInstance } from 'fastify';
import type { AppContext } from './context.js';
import { HttpError } from './context.js';
import type { OrderKind, OrderListItem, OrdersPage } from '../shared/orders.js';

type Row = Record<string, any>;
const kinds = ['all', 'auction', 'agreement', 'token'];
const statuses = ['all', 'active', 'history', 'attention'];
const periods = ['all', '24h', '7d', '30d'];
const idPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function orderFilters(query: unknown) {
  const q = (query ?? {}) as Record<string, string>;
  const kind = q.kind ?? 'all',
    status = q.status ?? 'all',
    created = q.created ?? 'all';
  const limit = q.limit === undefined ? 25 : Number(q.limit);
  if (!kinds.includes(kind) || !statuses.includes(status) || !periods.includes(created))
    throw new HttpError(400, 'Invalid order filter.');
  if (!Number.isInteger(limit) || limit < 1 || limit > 100)
    throw new HttpError(400, 'Page size must be between 1 and 100.');
  let cursor: [string, OrderKind, string] | undefined;
  if (q.cursor) {
    try {
      if (q.cursor.length > 768) throw new Error();
      const c = JSON.parse(Buffer.from(q.cursor, 'base64url').toString('utf8'));
      if (
        !Array.isArray(c) ||
        c.length !== 3 ||
        typeof c[0] !== 'string' ||
        c[0].length > 64 ||
        !Number.isFinite(Date.parse(c[0])) ||
        !['auction', 'agreement', 'token'].includes(c[1]) ||
        !idPattern.test(c[2])
      )
        throw new Error();
      cursor = c as [string, OrderKind, string];
    } catch {
      throw new HttpError(400, 'Invalid order cursor.');
    }
  }
  return { kind, status, created, limit, cursor };
}

const auctionHistory = `((r.status IN ('no_offers','failed','cancelled') AND (v.id IS NULL OR v.cleanup_confirmed_at IS NOT NULL)) OR v.cleanup_confirmed_at IS NOT NULL)`;
const auctionBounds = `r.buyer_id=$1 AND r.agreement_id IS NULL
 AND $7::text IN ('all','auction')
 AND ($2::timestamptz IS NULL OR (r.created_at,'auction'::text,r.id)<($2::timestamptz,$3::text,$4::uuid))
 AND ($6::timestamptz IS NULL OR r.created_at>=$6::timestamptz)`;

/** Each branch is authorized, filtered and bounded before the bounded union merge. */
export const ORDERS_QUERY = `
WITH eligible_auction_ids AS MATERIALIZED (
 SELECT id,created_at FROM (
   (SELECT r.id,r.created_at FROM broker_requests r WHERE ${auctionBounds}
    AND (($5::text='active' AND r.status IN ('open','provisioning')) OR ($5='attention' AND r.status IN ('no_offers','failed')))
    ORDER BY r.created_at DESC,r.id DESC LIMIT $8)
   UNION
   (SELECT r.id,r.created_at FROM broker_vms v JOIN broker_requests r ON r.id=v.request_id
    WHERE ${auctionBounds} AND v.buyer_id=$1 AND v.cleanup_confirmed_at IS NULL
    AND ($5::text='active' OR ($5='attention' AND v.termination_requested_at IS NOT NULL))
    ORDER BY r.created_at DESC,r.id DESC LIMIT $8)
 ) candidates ORDER BY created_at DESC,id DESC LIMIT $8
), auction_ids AS MATERIALIZED (
 SELECT id,created_at FROM (
   (SELECT r.id,r.created_at FROM broker_requests r LEFT JOIN broker_vms v ON v.request_id=r.id AND v.buyer_id=$1
    WHERE ${auctionBounds} AND ($5::text='all' OR ($5='history' AND ${auctionHistory}))
    ORDER BY r.created_at DESC,r.id DESC LIMIT $8)
   UNION ALL SELECT id,created_at FROM eligible_auction_ids WHERE $5::text IN ('active','attention')
 ) candidates ORDER BY created_at DESC,id DESC LIMIT $8
), auction_page AS MATERIALIZED (
 SELECT r.id,'auction'::text AS kind,r.created_at,r.created_at::text AS cursor_created_at,r.source_api_key_id,
 r.description AS title,
 CASE WHEN v.cleanup_confirmed_at IS NOT NULL AND r.status='ready' THEN 'completed'
      WHEN v.status IN ('running','provisioning','terminating','expired') THEN
        CASE WHEN v.status IN ('terminating','expired') THEN 'ending' ELSE v.status END
      WHEN r.status='open' AND r.closes_at<=clock_timestamp() THEN 'closing'
      ELSE r.status END AS status,
 r.status AS auction_status,v.status AS vm_status,(v.id IS NOT NULL AND v.cleanup_confirmed_at IS NULL) AS cleanup_pending,r.closes_at,v.expires_at,
 1::int AS target_quantity,CASE WHEN r.winning_bid_id IS NULL THEN 0 ELSE 1 END AS approved_quantity,
 CASE WHEN v.status='running' AND v.cleanup_confirmed_at IS NULL THEN 1 ELSE 0 END AS running_quantity,
 COALESCE(b.total_price_cents,r.max_price_cents) AS amount_cents,
 NULL::int AS committed_cents,NULL::int AS reserved_cents,v.id AS vm_id,
 (r.status IN ('no_offers','failed','cancelled') AND (v.id IS NULL OR v.cleanup_confirmed_at IS NOT NULL)) AS can_retry,
 NULL::uuid AS grant_id,NULL::int AS input_tokens,NULL::int AS output_tokens,NULL::text AS token_mode,NULL::text AS funding_source
 FROM auction_ids ids
 JOIN LATERAL (SELECT id,buyer_id,description,status,created_at,closes_at,winning_bid_id,max_price_cents,source_api_key_id
   FROM broker_requests WHERE id=ids.id OFFSET 0) r ON true
 LEFT JOIN broker_vms v ON v.request_id=r.id AND v.buyer_id=$1
 LEFT JOIN broker_bids b ON b.id=r.winning_bid_id
 ORDER BY r.created_at DESC,r.id DESC LIMIT $8
), agreement_page AS MATERIALIZED (
 SELECT a.id,'agreement'::text AS kind,a.created_at,a.created_at::text AS cursor_created_at,a.source_api_key_id,
 a.description AS title,
 CASE WHEN a.status='expired' AND a.reserved_cents>0 THEN 'credit_release_pending'
      WHEN a.status='approved' AND a.starts_at<=clock_timestamp() AND a.expires_at>clock_timestamp() THEN 'active'
      WHEN a.status='open' AND a.blocked_reason ILIKE '%credit%' THEN 'needs_credit'
      ELSE a.status END AS status,
 NULL::text AS auction_status,NULL::text AS vm_status,false AS cleanup_pending,NULL::timestamptz AS closes_at,a.expires_at,
 a.target_quantity,0::int AS approved_quantity,0::int AS running_quantity,
 a.max_amount_cents AS amount_cents,a.committed_cents,a.reserved_cents,NULL::uuid AS vm_id,false AS can_retry,
 NULL::uuid AS grant_id,NULL::int AS input_tokens,NULL::int AS output_tokens,NULL::text AS token_mode,NULL::text AS funding_source
 FROM broker_agreements a WHERE a.buyer_id=$1 AND $7::text IN ('all','agreement')
 AND ($2::timestamptz IS NULL OR (a.created_at,'agreement'::text,a.id)<($2::timestamptz,$3::text,$4::uuid))
 AND ($6::timestamptz IS NULL OR a.created_at>=$6::timestamptz)
 AND ($5::text='all' OR ($5='active' AND (a.status IN ('open','approved') OR a.reserved_cents>0))
      OR ($5='history' AND a.status IN ('expired','cancelled') AND a.reserved_cents=0)
      OR ($5='attention' AND (a.blocked_reason IS NOT NULL OR (a.status='expired' AND a.reserved_cents>0))))
 ORDER BY a.created_at DESC,a.id DESC LIMIT $8
), token_page AS MATERIALIZED (
 SELECT t.id,'token'::text AS kind,t.created_at,t.created_at::text AS cursor_created_at,t.source_key_id AS source_api_key_id,
 'Meta Muse Spark Open'::text AS title,t.status,NULL::text AS auction_status,NULL::text AS vm_status,
 false AS cleanup_pending,t.closes_at,t.expires_at,1::int AS target_quantity,
 CASE WHEN t.status='awarded' THEN 1 ELSE 0 END AS approved_quantity,0::int AS running_quantity,
 COALESCE(t.price_cents,t.max_total_cents) AS amount_cents,NULL::int AS committed_cents,NULL::int AS reserved_cents,
 NULL::uuid AS vm_id,false AS can_retry,t.grant_id,t.input_tokens,t.output_tokens,t.mode AS token_mode,t.funding_source
 FROM broker_token_orders t WHERE t.buyer_id=$1 AND $7::text IN ('all','token')
 AND ($2::timestamptz IS NULL OR(t.created_at,'token'::text,t.id)<($2::timestamptz,$3::text,$4::uuid))
 AND ($6::timestamptz IS NULL OR t.created_at>=$6::timestamptz)
 AND ($5::text='all' OR($5='active' AND t.status='open') OR($5='history' AND t.status<>'open')
   OR($5='attention' AND t.status IN('no_offers','expired')))
 ORDER BY t.created_at DESC,t.id DESC LIMIT $8
)
SELECT * FROM (SELECT * FROM auction_page UNION ALL SELECT * FROM agreement_page UNION ALL SELECT * FROM token_page) orders
ORDER BY created_at DESC,kind DESC,id DESC LIMIT $8`;

const iso = (v: unknown) => (v == null ? null : new Date(v as string).toISOString());
export async function listOrders(
  ctx: AppContext,
  buyerId: string,
  query: unknown,
): Promise<OrdersPage> {
  const filters = orderFilters(query),
    now = new Date();
  const days = filters.created === '24h' ? 1 : filters.created === '7d' ? 7 : 30;
  const since =
    filters.created === 'all' ? null : new Date(now.getTime() - days * 86400000).toISOString();
  let rows: Row[];
  try {
    rows = (
      await ctx.pool.query(ORDERS_QUERY, [
        buyerId,
        ...(filters.cursor ?? [null, null, null]),
        filters.status,
        since,
        filters.kind,
        filters.limit + 1,
      ])
    ).rows;
  } catch (error) {
    if (['22007', '22008'].includes(String((error as { code?: string }).code)))
      throw new HttpError(400, 'Invalid order cursor.');
    throw error;
  }
  const selected = rows.slice(0, filters.limit);
  const auctions = selected.filter((r) => r.kind === 'auction').map((r) => r.id);
  const agreements = selected.filter((r) => r.kind === 'agreement').map((r) => r.id);
  const tokens = selected.filter((r) => r.kind === 'token').map((r) => r.id);
  const [bidRows, windowRows, runningRows, tokenBidRows] = await Promise.all([
    auctions.length
      ? ctx.pool.query(
          'SELECT request_id,count(*)::int AS n FROM broker_bids WHERE request_id=ANY($1::uuid[]) GROUP BY request_id',
          [auctions],
        )
      : { rows: [] },
    agreements.length
      ? ctx.pool.query(
          `SELECT DISTINCT ON(w.agreement_id) w.*,a.time_zone FROM broker_agreement_windows w JOIN broker_agreements a ON a.id=w.agreement_id
      WHERE a.buyer_id=$1 AND w.agreement_id=ANY($2::uuid[])
      ORDER BY w.agreement_id,(w.ends_at>clock_timestamp()) DESC,
      CASE WHEN w.ends_at>clock_timestamp() THEN w.starts_at END ASC,w.starts_at DESC`,
          [buyerId, agreements],
        )
      : { rows: [] },
    agreements.length
      ? ctx.pool.query(
          `SELECT r.agreement_id,count(*)::int AS n FROM broker_vms v JOIN broker_requests r ON r.id=v.request_id
      WHERE r.buyer_id=$1 AND r.agreement_id=ANY($2::uuid[]) AND v.cleanup_confirmed_at IS NULL AND v.status='running' GROUP BY r.agreement_id`,
          [buyerId, agreements],
        )
      : { rows: [] },
    tokens.length
      ? ctx.pool.query(
          'SELECT order_id,count(*)::int AS n FROM broker_token_bids WHERE order_id=ANY($1::uuid[]) GROUP BY order_id',
          [tokens],
        )
      : { rows: [] },
  ]);
  const bids = new Map([
    ...bidRows.rows.map((r: Row) => [r.request_id, r.n] as const),
    ...tokenBidRows.rows.map((r: Row) => [r.order_id, r.n] as const),
  ]);
  const windows = new Map(windowRows.rows.map((r: Row) => [r.agreement_id, r]));
  const running = new Map(runningRows.rows.map((r: Row) => [r.agreement_id, r.n]));
  const items: OrderListItem[] = selected.map((r) => {
    const agreement = r.kind === 'agreement',
      token = r.kind === 'token',
      w = windows.get(r.id);
    return {
      id: r.id,
      key: `${r.kind}:${r.id}`,
      kind: r.kind,
      reference: `${agreement ? 'AG' : token ? 'TK' : 'AU'}-${String(r.id).slice(0, 8).toUpperCase()}`,
      title: r.title,
      ...(token
        ? {
            modelId: 'meta/muse-spark-open',
            inputTokens: r.input_tokens,
            outputTokens: r.output_tokens,
            tokenMode: r.token_mode,
            grantId: r.grant_id,
            fundingSource: r.funding_source,
          }
        : {}),
      ...(r.source_api_key_id
        ? { source: { kind: 'api_key' as const, keyId: r.source_api_key_id } }
        : {}),
      status: r.status,
      ...(r.auction_status ? { auctionStatus: r.auction_status } : {}),
      ...(r.vm_status ? { vmStatus: r.vm_status } : {}),
      cleanupPending: Boolean(r.cleanup_pending),
      createdAt: iso(r.created_at)!,
      closesAt: iso(r.closes_at),
      expiresAt: iso(r.expires_at),
      requestedQuantity: Number(r.target_quantity),
      approvedQuantity: Number(w?.approved_quantity ?? r.approved_quantity),
      runningQuantity: Number(running.get(r.id) ?? r.running_quantity),
      bidCount: Number(bids.get(r.id) ?? 0),
      amount: {
        label: agreement ? 'reserved' : r.approved_quantity ? 'accepted' : 'budget',
        amountCents: Number(r.amount_cents),
        ...(agreement
          ? { committedCents: Number(r.committed_cents), reservedCents: Number(r.reserved_cents) }
          : {}),
      },
      ...(w
        ? {
            nextWindow: {
              startsAt: iso(w.starts_at)!,
              endsAt: iso(w.ends_at)!,
              timeZone: w.time_zone,
            },
          }
        : {}),
      detailUrl: agreement
        ? `/orders/${r.id}`
        : token
          ? `/token-orders/${r.id}`
          : `/requests/${r.id}`,
      ...(r.vm_id ? { vmUrl: `/vms/${r.vm_id}` } : {}),
      ...(r.can_retry ? { retryUrl: `/new?copy=${r.id}` } : {}),
    };
  });
  const last = selected.at(-1);
  return {
    items,
    serverNow: now.toISOString(),
    ...(rows.length > filters.limit && last
      ? {
          nextCursor: Buffer.from(
            JSON.stringify([last.cursor_created_at, last.kind, last.id]),
          ).toString('base64url'),
        }
      : {}),
  };
}

export function registerOrders(app: FastifyInstance, ctx: AppContext) {
  app.get('/api/orders', async (request) => {
    const actor = await ctx.requireActor(request, ['buyer']);
    return listOrders(ctx, actor.id, request.query);
  });
}
