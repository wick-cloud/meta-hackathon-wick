import type { Pool, PoolClient } from 'pg';
import type { Actor, CatalogItem } from '../../shared/types.js';
import { HttpError, type AppContext } from '../context.js';
import { fixedQuote } from '../../shared/pricing.js';
export type Row = Record<string, any>;
export const iso = (value: unknown): string | null =>
  value ? new Date(value as string).toISOString() : null;
export const requestView = (r: Row) => ({
  id: r.id,
  buyerId: r.buyer_id,
  ...(r.source_api_key_id
    ? { source: { kind: 'api_key' as const, keyId: r.source_api_key_id } }
    : {}),
  description: r.description,
  catalogId: r.catalog_id,
  catalogName: r.catalog_snapshot?.name,
  region: r.region,
  durationMinutes: r.duration_minutes,
  maxPriceCents: r.max_price_cents,
  matchAcrossProviders: r.catalog_snapshot?.matchMode === 'compatible',
  requirements: r.requirements,
  status: r.status,
  closesAt: iso(r.closes_at),
  createdAt: iso(r.created_at),
  winningBidId: r.winning_bid_id,
  failureReason: r.failure_reason,
  ...(r.catalog_snapshot?.pricing && r.catalog_snapshot?.matchMode !== 'compatible'
    ? { pricing: fixedQuote(r.catalog_snapshot.pricing, r.duration_minutes) }
    : {}),
});
export const bidView = (r: Row) => ({
  id: r.id,
  providerId: r.provider_id,
  providerName: r.provider_name,
  totalPriceCents: r.total_price_cents,
  status: r.status,
  createdAt: iso(r.created_at),
  source: r.offering_snapshot?.bidSource ?? null,
  simulated: r.offering_snapshot?.simulated ?? true,
  catalogId: r.offering_snapshot?.catalog?.id ?? r.offering_snapshot?.catalogId,
  catalogName: r.offering_snapshot?.catalog?.name,
  cloudProvider: r.offering_snapshot?.catalog?.provider,
  region: r.offering_snapshot?.catalog?.region,
  ...(r.offering_snapshot?.pricing ? { pricing: r.offering_snapshot.pricing } : {}),
  ...(r.offering_snapshot?.revenueShare ? { revenueShare: r.offering_snapshot.revenueShare } : {}),
});
export const offeringView = (r: Row) => ({
  id: r.id,
  providerId: r.provider_id,
  catalogId: r.catalog_id,
  name: r.name,
  description: r.description,
  priceCents: r.price_cents,
  active: r.active,
  revision: r.revision,
  ...(r.pricing ? { pricing: r.pricing, priceDurationMinutes: 30 } : {}),
  createdAt: iso(r.created_at),
  simulated: r.simulated ?? true,
  cloudProvider: r.cloud_provider ?? null,
});
export const vmView = (r: Row) => ({
  id: r.id,
  requestId: r.request_id,
  buyerId: r.buyer_id,
  sourceMode: r.catalog_snapshot?.sourceMode === 'real' ? ('real' as const) : ('fixture' as const),
  status: r.status,
  environmentId: r.environment_id,
  expiresAt: iso(r.expires_at),
  readyAt: iso(r.ready_at),
  createdAt: iso(r.created_at),
  admittedAt: iso(r.admitted_at),
  catalogName: r.catalog_snapshot?.name,
  region: r.catalog_snapshot?.region,
  durationMinutes: r.create_input?.ttlSeconds / 60,
  priceCents: r.quote_snapshot?.totalPriceCents,
  billingSource:
    r.quote_snapshot?.billingSource === 'scheduled_capacity' ? 'scheduled_capacity' : 'instant_vm',
  ...(r.quote_snapshot?.billingSource === 'scheduled_capacity'
    ? {
        agreementId: r.quote_snapshot.agreementId,
        ...(r.quote_snapshot.scheduledWindow
          ? {
              scheduledWindow: {
                windowId: r.quote_snapshot.scheduledWindow.windowId,
                startsAt: r.quote_snapshot.scheduledWindow.startsAt,
                discountEndsAt: r.quote_snapshot.scheduledWindow.discountEndsAt,
                endsAt: r.quote_snapshot.scheduledWindow.endsAt,
                discountRateCentsPerHour: r.quote_snapshot.scheduledWindow.discountRateCentsPerHour,
                normalRateCentsPerHour: r.quote_snapshot.scheduledWindow.normalRateCentsPerHour,
              },
            }
          : {}),
      }
    : {}),
  ...(r.quote_snapshot?.pricing ? { pricing: r.quote_snapshot.pricing } : {}),
  ...(r.quote_snapshot?.revenueShare ? { revenueShare: r.quote_snapshot.revenueShare } : {}),
  failureReason: r.failure_reason,
  cleanupPending:
    !r.cleanup_confirmed_at && ['terminating', 'failed', 'expired'].includes(r.status),
  cleanupConfirmedAt: iso(r.cleanup_confirmed_at),
});
export async function getCatalog(ctx: Pick<AppContext, 'pool' | 'wick'>): Promise<CatalogItem[]> {
  const result = await ctx.pool.query(
    `SELECT id,item,approved FROM broker_catalog WHERE source_mode=$1
      AND ($1 <> 'real' OR COALESCE(item->>'provider','') <> 'boat') ORDER BY id`,
    [ctx.wick.mode],
  );
  return result.rows.map((r) => ({ ...r.item, id: r.id, approved: r.approved }));
}
export async function syncCatalog(ctx: AppContext) {
  const db = await ctx.pool.connect();
  let locked = false;
  let transactionOpen = false;
  try {
    const lock = await db.query(
      "SELECT pg_try_advisory_lock(hashtext(current_schema()),hashtext('broker-catalog-sync')) AS acquired",
    );
    locked = lock.rows[0]?.acquired === true;
    if (!locked)
      throw new HttpError(409, 'A catalog refresh is already in progress. Try again shortly.');

    // Share the lock with manual syncs, but never hold a SQL transaction across the SDK call.
    const items = await ctx.wick.catalog();
    await db.query('BEGIN');
    transactionOpen = true;
    await db.query(
      'UPDATE broker_catalog SET approved=false,updated_at=now() WHERE source_mode=$2 AND NOT(id=ANY($1::text[]))',
      [items.map((item) => item.id), ctx.wick.mode],
    );
    for (const item of items)
      await db.query(
        'INSERT INTO broker_catalog(id,item,approved,source_mode) VALUES($1,$2,$3,$4) ON CONFLICT(id) DO UPDATE SET item=excluded.item,updated_at=now() WHERE broker_catalog.source_mode=excluded.source_mode',
        [item.id, item, item.approved, ctx.wick.mode],
      );
    await db.query('COMMIT');
    transactionOpen = false;
  } catch (error) {
    if (transactionOpen) await db.query('ROLLBACK');
    throw error;
  } finally {
    try {
      if (locked)
        await db.query(
          "SELECT pg_advisory_unlock(hashtext(current_schema()),hashtext('broker-catalog-sync'))",
        );
    } catch (error) {
      // Never return a connection that might still own the session lock to the pool.
      db.release(true);
      throw error;
    }
    db.release();
  }
  return getCatalog(ctx);
}
export async function getProvider(db: Pool | PoolClient, actor: Actor): Promise<Row> {
  const result = await db.query('SELECT * FROM broker_providers WHERE user_id=$1', [actor.id]);
  if (!result.rows[0]) throw new HttpError(403, 'Provider access is not configured.');
  return result.rows[0];
}
export function integer(value: unknown, label: string, min = 0, max = 100000000) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max)
    throw new HttpError(400, `${label} must be an integer between ${min} and ${max}.`);
  return value;
}
export function positiveNumber(value: unknown, label: string, max: number) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || value > max)
    throw new HttpError(400, `${label} must be a finite positive number no greater than ${max}.`);
  return value;
}
export function shortText(value: unknown, label: string, max = 2000) {
  if (typeof value !== 'string' || !value.trim() || value.length > max)
    throw new HttpError(400, `${label} is required and must be at most ${max} characters.`);
  return value.trim();
}
export function uuid(value: string) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value))
    throw new HttpError(400, 'Invalid resource ID.');
  return value;
}
export function pagination(query: unknown) {
  const q = (query || {}) as { limit?: string; cursor?: string };
  const limit = q.limit === undefined ? 30 : Number(q.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100)
    throw new HttpError(400, 'Page size must be an integer between 1 and 100.');
  let cursor: string | null = null,
    cursorId: string | null = null;
  if (q.cursor) {
    try {
      const parsed = JSON.parse(Buffer.from(q.cursor, 'base64url').toString('utf8'));
      if (
        !Array.isArray(parsed) ||
        parsed.length !== 2 ||
        typeof parsed[0] !== 'string' ||
        typeof parsed[1] !== 'string' ||
        !Number.isFinite(Date.parse(parsed[0])) ||
        !/^([0-9a-f-]{36}|[0-9]{1,20})$/i.test(parsed[1])
      )
        throw new Error('Invalid cursor');
      [cursor, cursorId] = parsed;
    } catch {
      throw new HttpError(400, 'Invalid pagination cursor.');
    }
  }
  return { limit, cursor, cursorId };
}
export function encodeCursor(row: Row) {
  return Buffer.from(
    JSON.stringify([row.cursor_created_at || iso(row.created_at), String(row.id)]),
  ).toString('base64url');
}
