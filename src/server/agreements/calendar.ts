import type { PoolClient } from 'pg';
import type { AppContext } from '../context.js';
import { HttpError } from '../context.js';

/** Callers hold the global admission lock, then the affected provider row locks. */
async function bookedPeak(
  db: PoolClient,
  start: string,
  end: string,
  providerId?: string,
  excludeWindowId?: string,
) {
  const row = (
    await db.query(
      `WITH overlapping AS MATERIALIZED (
    SELECT quantity,GREATEST(starts_at,$1::timestamptz) AS starts_at,LEAST(ends_at,$2::timestamptz) AS ends_at
    FROM broker_agreement_bookings WHERE tstzrange(starts_at,ends_at,'[)') && tstzrange($1::timestamptz,$2::timestamptz,'[)')
    AND ($3::uuid IS NULL OR provider_id=$3) AND ($4::uuid IS NULL OR window_id<>$4)
  ), events AS (SELECT starts_at AS at,quantity AS delta FROM overlapping UNION ALL SELECT ends_at,-quantity FROM overlapping),
  summed AS (SELECT at,sum(delta) AS delta FROM events GROUP BY at),
  running AS (SELECT sum(delta) OVER(ORDER BY at) AS occupied FROM summed)
  SELECT COALESCE(max(occupied),0)::int AS peak FROM running`,
      [start, end, providerId ?? null, excludeWindowId ?? null],
    )
  ).rows[0];
  return Number(row.peak);
}
export async function availableForInterval(
  ctx: AppContext,
  db: PoolClient,
  providerId: string,
  start: string,
  end: string,
  excludeWindowId?: string,
  excludeRequestId?: string,
): Promise<number> {
  const provider = (
    await db.query('SELECT total_capacity,policy FROM broker_providers WHERE id=$1', [providerId])
  ).rows[0];
  if (!provider) return 0;
  const occupied = Number(
    (
      await db.query(
        `SELECT count(*)::int AS n FROM broker_holds h
    JOIN broker_bids b ON b.id=h.bid_id JOIN broker_requests r ON r.id=b.request_id
    LEFT JOIN broker_vms v ON v.bid_id=b.id
    WHERE h.provider_id=$1 AND h.released_at IS NULL
    AND ($3::uuid IS NULL OR r.id<>$3)
    AND ((r.agreement_id IS NULL AND (
      (v.id IS NULL AND r.closes_at+make_interval(mins=>r.duration_minutes)+interval '7 minutes'>$2)
      OR (v.id IS NOT NULL AND v.cleanup_confirmed_at IS NULL AND
       (v.status NOT IN('running','provisioning') OR v.environment_id IS NULL OR v.expires_at IS NULL OR v.expires_at+interval '120 seconds'>$2))))
      OR (r.agreement_id IS NOT NULL AND v.expires_at<=$2 AND v.cleanup_confirmed_at IS NULL))`,
        [providerId, start, excludeRequestId ?? null],
      )
    ).rows[0].n,
  );
  return Math.max(
    0,
    Number(provider.total_capacity) -
      Number(provider.policy.reserveSlots ?? 0) -
      occupied -
      (await bookedPeak(db, start, end, providerId, excludeWindowId)),
  );
}
export async function globalAvailableForInterval(
  ctx: AppContext,
  db: PoolClient,
  start: string,
  end: string,
  excludeWindowId?: string,
  excludeRequestId?: string,
): Promise<number> {
  const configured =
    (await db.query("SELECT value FROM broker_settings WHERE key='maxConcurrentVms'")).rows[0]
      ?.value ?? ctx.config.maxConcurrentVms;
  const occupied = Number(
    (
      await db.query(
        `SELECT count(*)::int AS n FROM(
          SELECT v.request_id FROM broker_vms v JOIN broker_requests r ON r.id=v.request_id
          WHERE v.cleanup_confirmed_at IS NULL AND($2::uuid IS NULL OR v.request_id<>$2)
          AND((r.agreement_id IS NULL AND(v.status NOT IN('running','provisioning') OR v.environment_id IS NULL OR v.expires_at IS NULL OR v.expires_at+interval '120 seconds'>$1))
           OR(r.agreement_id IS NOT NULL AND v.expires_at<=$1))
          UNION ALL
          SELECT r.id FROM broker_requests r WHERE r.status='open' AND r.agreement_id IS NULL
          AND($2::uuid IS NULL OR r.id<>$2) AND r.closes_at+make_interval(mins=>r.duration_minutes)+interval '7 minutes'>$1
          AND NOT EXISTS(SELECT 1 FROM broker_vms v WHERE v.request_id=r.id)
          AND EXISTS(SELECT 1 FROM broker_bids b JOIN broker_holds h ON h.bid_id=b.id WHERE b.request_id=r.id AND h.released_at IS NULL)
        ) occupied`,
        [start, excludeRequestId ?? null],
      )
    ).rows[0].n,
  );
  return Math.max(
    0,
    Number(configured) - occupied - (await bookedPeak(db, start, end, undefined, excludeWindowId)),
  );
}
export async function assertProviderFutureCapacity(
  db: PoolClient,
  providerId: string,
  total: number,
  reserveSlots: number,
) {
  const now = (await db.query('SELECT clock_timestamp()::text AS at')).rows[0].at;
  const end = new Date(Date.parse(now) + 38 * 86400000).toISOString();
  if ((await bookedPeak(db, now, end, providerId)) > Math.max(0, total - reserveSlots))
    throw new HttpError(
      409,
      'Booked agreement capacity must be retained until its published windows end.',
    );
}
export async function assertGlobalFutureCapacity(db: PoolClient, maximum: number) {
  const now = (await db.query('SELECT clock_timestamp()::text AS at')).rows[0].at;
  if (
    (await bookedPeak(db, now, new Date(Date.parse(now) + 38 * 86400000).toISOString())) > maximum
  )
    throw new HttpError(
      409,
      'The VM limit must retain already booked agreement capacity until its windows end.',
    );
}
