import type { Pool, PoolClient } from 'pg';
import type {
  AgreementBooking,
  AgreementDetail,
  AgreementActivation,
  ScheduledOffering,
} from '../../shared/agreements.js';
import type { CatalogItem } from '../../shared/types.js';
import { HttpError, type AppContext } from '../context.js';
import { iso, type Row } from '../marketplace/data.js';
import { transaction } from '../marketplace/db.js';
import { addCents, multiplyCents, subtractCents } from '../../shared/money.js';

export const globalLock = (db: PoolClient) =>
  db.query("SELECT pg_advisory_xact_lock(hashtext('broker-global-vm-admission'))");
export const deadlineEligible = (ctx: Pick<AppContext, 'wick'>, item: CatalogItem, seconds = 60) =>
  ctx.wick.mode === 'fixture' ||
  (item.deadlineEnforcement === 'native' &&
    typeof item.maxTtlSeconds === 'number' &&
    item.maxTtlSeconds >= seconds);
export function offeringInput(r: Row) {
  return {
    operationKey: r.operation_key,
    catalogId: r.catalog_id,
    name: r.name,
    kind: r.kind,
    timeZone: r.time_zone,
    weekdays: r.weekdays,
    windowStart: r.window_start,
    windowEnd: r.window_end,
    availableUntil: r.available_until,
    capacityQuantity: r.capacity_quantity,
    discountRateCentsPerHour: r.discount_rate_cents_per_hour,
    normalRateCentsPerHour: r.normal_rate_cents_per_hour,
  };
}
export function offeringView(ctx: Pick<AppContext, 'wick'>, r: Row): ScheduledOffering {
  const eligible = deadlineEligible(ctx, r.item);
  return {
    ...offeringInput(r),
    id: r.id,
    providerId: r.provider_id,
    active: r.active,
    revision: r.revision,
    createdAt: iso(r.created_at)!,
    deadlineEligible: eligible,
    ...(!eligible
      ? {
          blockedReason:
            'Wick has not attested an independent native hard deadline for this configuration.',
        }
      : {}),
  };
}
export function bookingView(r: Row): AgreementBooking {
  return {
    id: r.id,
    windowId: r.window_id,
    providerId: r.provider_id,
    providerName: r.provider_name ?? r.snapshot.providerName,
    catalogId: r.catalog_id,
    quantity: r.quantity,
    unitPriceCents: r.unit_price_cents,
    totalCents: multiplyCents(r.unit_price_cents, r.quantity),
    startsAt: iso(r.starts_at)!,
    discountEndsAt: iso(r.discount_ends_at)!,
    endsAt: iso(r.ends_at)!,
    discountRateCentsPerHour: r.snapshot.offering.discountRateCentsPerHour,
    normalRateCentsPerHour: r.snapshot.offering.normalRateCentsPerHour,
  };
}
export function activationView(r: Row): AgreementActivation {
  return {
    id: r.id,
    windowId: r.window_id,
    status: r.status,
    requestId: r.request_id,
    vmId: r.vm_id,
    endsAt: iso(r.ends_at)!,
    createdAt: iso(r.created_at)!,
    ...(r.failure_reason ? { failureReason: r.failure_reason } : {}),
  };
}
export async function ownedAgreement(
  db: Pool | PoolClient,
  id: string,
  buyerId: string,
  lock = false,
) {
  const a = (
    await db.query(
      `SELECT * FROM broker_agreements WHERE id=$1 AND buyer_id=$2 ${lock ? 'FOR UPDATE' : ''}`,
      [id, buyerId],
    )
  ).rows[0];
  if (!a) throw new HttpError(404, 'Agreement not found.');
  return a;
}
/** One bounded seven-day resource, at most 140 booked slots and 20 live activations. */
export async function agreementDetail(
  ctx: Pick<AppContext, 'wick'>,
  db: Pool | PoolClient,
  id: string,
  buyerId: string,
): Promise<AgreementDetail> {
  if (typeof (db as PoolClient).release !== 'function')
    return transaction(db as Pool, async (client) => {
      await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
      return agreementDetail(ctx, client, id, buyerId);
    });
  const a = await ownedAgreement(db, id, buyerId);
  const wr = await db.query(
    `SELECT w.*,COALESCE(x.n,0)::int AS occupied FROM broker_agreement_windows w LEFT JOIN LATERAL(SELECT count(*) AS n FROM broker_agreement_activations a WHERE a.window_id=w.id AND a.cleaned_at IS NULL)x ON true WHERE w.agreement_id=$1 ORDER BY w.starts_at`,
    [id],
  );
  const br = await db.query(
    'SELECT b.*,p.name AS provider_name FROM broker_agreement_bookings b JOIN broker_providers p ON p.id=b.provider_id WHERE b.agreement_id=$1 ORDER BY b.starts_at,b.id',
    [id],
  );
  const ar = await db.query(
    'SELECT * FROM broker_agreement_activations WHERE agreement_id=$1 ORDER BY (cleaned_at IS NULL) DESC,created_at DESC,id DESC LIMIT 200',
    [id],
  );
  const remaining = wr.rows
    .filter((w) => !w.settled_at)
    .reduce((sum, w) => addCents(sum, w.committed_cents), 0);
  return {
    agreement: {
      id: a.id,
      ...(a.source_api_key_id
        ? { source: { kind: 'api_key' as const, keyId: a.source_api_key_id } }
        : {}),
      description: a.description,
      status: a.status,
      targetQuantity: a.target_quantity,
      minimumQuantity: a.minimum_quantity,
      startsAt: iso(a.starts_at)!,
      expiresAt: iso(a.expires_at)!,
      timeZone: a.time_zone,
      maxAmountCents: Number(a.max_amount_cents),
      reservedCents: Number(a.reserved_cents),
      committedCents: Number(a.committed_cents),
      settledCents: Number(a.settled_cents),
      adjustmentCents: Number(a.adjustment_cents),
      topUpAllowanceCents: Math.max(0, subtractCents(a.reserved_cents, remaining)),
      acceptingTopUps: a.accepting_topups,
      createdAt: iso(a.created_at)!,
      specification: a.specification,
      windows: wr.rows.map((w) => ({
        id: w.id,
        agreementId: id,
        startsAt: iso(w.starts_at)!,
        discountEndsAt: iso(w.discount_ends_at)!,
        endsAt: iso(w.ends_at)!,
        approvedQuantity: w.approved_quantity,
        runningQuantity: w.occupied,
        availableToActivate: Math.max(0, w.approved_quantity - w.occupied),
        committedCents: Number(w.committed_cents),
      })),
      activationMode: 'manual',
      deadlineEligible: a.blocked_code !== 'deadline_unsupported',
      ...(a.blocked_reason ? { blockedReason: a.blocked_reason } : {}),
      ...(a.blocked_code ? { blockedCode: a.blocked_code } : {}),
    },
    bookings: br.rows.map(bookingView),
    activations: ar.rows.map(activationView),
  };
}
