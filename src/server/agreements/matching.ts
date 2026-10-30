import { addCents, subtractCents, multiplyCents, moneyUnits } from '../../shared/money.js';
import type { PoolClient } from 'pg';
import type { AgreementInput, ScheduledOfferingInput } from '../../shared/agreements.js';
import type { CatalogItem } from '../../shared/types.js';
import { managedPricing, requireFreshManagedRate } from '../../shared/pricing.js';
import type { AppContext } from '../context.js';
import { transaction } from '../marketplace/db.js';
import { iso, type Row } from '../marketplace/data.js';
import { assertProviderCatalog } from '../marketplace/provider-identity.js';
import { sameCatalogAllocation } from '../marketplace/matching.js';
import { applyCreditEntry, lockedWallet } from './credits.js';
import { deadlineEligible, globalLock, offeringInput } from './data.js';
import { globalAvailableForInterval } from './calendar.js';
import { offeringCovers, windowCost, type WindowTimes } from './recurrence.js';

function eligible(ctx: AppContext, c: Row, spec: AgreementInput, w: WindowTimes) {
  const item = c.item as CatalogItem,
    offer = offeringInput(c) as ScheduledOfferingInput;
  if (
    !c.approved ||
    c.source_mode !== ctx.wick.mode ||
    !c.active ||
    (Array.isArray(c.policy.allowedCatalogIds) && !c.policy.allowedCatalogIds.includes(item.id))
  )
    return false;
  try {
    assertProviderCatalog(c, item);
  } catch {
    return false;
  }
  if (
    item.cpu < spec.requirements.cpu ||
    item.memoryGb < spec.requirements.memoryGb ||
    (spec.requirements.gpu &&
      (spec.requirements.gpu === 'any' ? !item.gpu : item.gpu !== spec.requirements.gpu)) ||
    (spec.region !== 'any' && spec.region !== item.region)
  )
    return false;
  if (
    offer.discountRateCentsPerHour > spec.maxDiscountRateCentsPerHour ||
    (spec.continuation?.enabled &&
      offer.normalRateCentsPerHour > spec.continuation.maxRateCentsPerHour) ||
    !offeringCovers(offer, w)
  )
    return false;
  const seconds = (Date.parse(w.endsAt) - Date.parse(w.startsAt)) / 1000;
  if (!deadlineEligible(ctx, item, seconds)) return false;
  if (ctx.wick.mode === 'real')
    try {
      requireFreshManagedRate(item);
      const pricing = managedPricing(item);
      if (
        moneyUnits(windowCost(w, offer.discountRateCentsPerHour, offer.normalRateCentsPerHour)) *
          85n <
        BigInt(pricing.rateMicrosPerSecond) * BigInt(seconds)
      )
        return false;
    } catch {
      return false;
    }
  return true;
}

/** Fixed query count per requested window; rows are aggregated per candidate provider/offering. */
async function capacities(db: PoolClient, ids: string[], start: string, end: string) {
  const peaks = (
    await db.query(
      `WITH relevant AS MATERIALIZED(SELECT provider_id,scheduled_offering_id,quantity,GREATEST(starts_at,$2::timestamptz) s,LEAST(ends_at,$3::timestamptz) e FROM broker_agreement_bookings WHERE provider_id=ANY($1::uuid[]) AND tstzrange(starts_at,ends_at,'[)')&&tstzrange($2::timestamptz,$3::timestamptz,'[)')),
 events AS(SELECT 'provider:'||provider_id::text k,s at,quantity d FROM relevant UNION ALL SELECT 'provider:'||provider_id::text,e,-quantity FROM relevant UNION ALL SELECT 'offering:'||scheduled_offering_id::text,s,quantity FROM relevant UNION ALL SELECT 'offering:'||scheduled_offering_id::text,e,-quantity FROM relevant), grouped AS(SELECT k,at,sum(d) d FROM events GROUP BY k,at), running AS(SELECT k,sum(d) OVER(PARTITION BY k ORDER BY at) n FROM grouped) SELECT k,max(n)::int n FROM running GROUP BY k`,
      [ids, start, end],
    )
  ).rows;
  const held = (
    await db.query(
      `SELECT h.provider_id,count(*)::int n FROM broker_holds h JOIN broker_bids b ON b.id=h.bid_id JOIN broker_requests r ON r.id=b.request_id LEFT JOIN broker_vms v ON v.bid_id=b.id WHERE h.provider_id=ANY($1::uuid[]) AND h.released_at IS NULL AND ((r.agreement_id IS NULL AND ((v.id IS NULL AND r.closes_at+make_interval(mins=>r.duration_minutes)+interval '7 minutes'>$2) OR(v.id IS NOT NULL AND v.cleanup_confirmed_at IS NULL AND(v.status NOT IN('running','provisioning') OR v.environment_id IS NULL OR v.expires_at IS NULL OR v.expires_at+interval '120 seconds'>$2)))) OR(r.agreement_id IS NOT NULL AND v.expires_at<=$2 AND v.cleanup_confirmed_at IS NULL)) GROUP BY h.provider_id`,
      [ids, start],
    )
  ).rows;
  return {
    peaks: new Map<string, number>(peaks.map((r) => [r.k, Number(r.n)])),
    held: new Map<string, number>(held.map((r) => [r.provider_id, Number(r.n)])),
  };
}
export async function matchAgreement(ctx: AppContext, id: string) {
  return transaction(ctx.pool, async (db) => {
    await globalLock(db);
    const a = (
      await db.query(
        'SELECT *,clock_timestamp() AS db_now FROM broker_agreements WHERE id=$1 FOR UPDATE',
        [id],
      )
    ).rows[0];
    if (
      !a ||
      !a.accepting_topups ||
      !['open', 'approved'].includes(a.status) ||
      a.source_mode !== ctx.wick.mode
    )
      return;
    await db.query(
      "UPDATE broker_agreements SET next_match_at=now()+interval '60 seconds' WHERE id=$1",
      [id],
    );
    const windows = (
      await db.query(
        'SELECT * FROM broker_agreement_windows WHERE agreement_id=$1 ORDER BY starts_at FOR UPDATE',
        [id],
      )
    ).rows;
    const spec = a.specification as AgreementInput;
    // First approval covers all seven occurrences. Late minimum approval is not retroactive.
    if (a.status === 'open' && windows.some((w) => new Date(w.starts_at) <= new Date(a.db_now))) {
      await block(
        db,
        id,
        'awaiting_capacity',
        'The first window started before the seven-day minimum could be approved. Cancel the unmatched order and choose a new term.',
      );
      return;
    }
    const wallet = await lockedWallet(db, a.buyer_id);
    if (
      a.status === 'open' &&
      subtractCents(wallet.balance_cents, wallet.reserved_cents) < Number(a.max_amount_cents)
    ) {
      await block(
        db,
        id,
        'needs_credit',
        'Add enough Broker pilot credits to reserve the full maximum seven-day amount. Wick compute credits are separate.',
      );
      return;
    }
    // Keep each provider's cheapest sufficient unbooked supply before the shared
    // frontier limit; duplicate offers must not hide another provider's capacity.
    // Retain booked offers separately: a frozen revision can make one unusable
    // for top-ups, so it must not displace alternative unbooked supply.
    const candidates = (
      await db.query(
        `WITH wanted AS MATERIALIZED(SELECT * FROM jsonb_to_recordset($8::jsonb) AS w(id uuid,s timestamptz,d timestamptz,e timestamptz)),
         overlapping AS MATERIALIZED(SELECT w.s window_at,b.provider_id,b.scheduled_offering_id,b.quantity,GREATEST(b.starts_at,w.s) starts_at,LEAST(b.ends_at,w.e) ends_at
           FROM wanted w JOIN broker_agreement_bookings b ON tstzrange(b.starts_at,b.ends_at,'[)')&&tstzrange(w.s,w.e,'[)')),
         events AS(SELECT window_at,'provider' kind,provider_id id,starts_at at,quantity delta FROM overlapping
           UNION ALL SELECT window_at,'provider',provider_id,ends_at,-quantity FROM overlapping
           UNION ALL SELECT window_at,'offering',scheduled_offering_id,starts_at,quantity FROM overlapping
           UNION ALL SELECT window_at,'offering',scheduled_offering_id,ends_at,-quantity FROM overlapping),
         grouped AS(SELECT window_at,kind,id,at,sum(delta) delta FROM events GROUP BY window_at,kind,id,at),
         running AS(SELECT window_at,kind,id,sum(delta) OVER(PARTITION BY window_at,kind,id ORDER BY at) quantity FROM grouped),
         peaks AS MATERIALIZED(SELECT window_at,kind,id,max(quantity)::int quantity FROM running GROUP BY window_at,kind,id),
         physical_holds AS MATERIALIZED(SELECT w.s window_at,h.provider_id,count(*)::int quantity FROM wanted w CROSS JOIN broker_holds h
           JOIN broker_bids b ON b.id=h.bid_id JOIN broker_requests r ON r.id=b.request_id LEFT JOIN broker_vms v ON v.bid_id=b.id
           WHERE h.released_at IS NULL AND((r.agreement_id IS NULL AND
             ((v.id IS NULL AND r.closes_at+make_interval(mins=>r.duration_minutes)+interval '7 minutes'>w.s)
              OR(v.id IS NOT NULL AND v.cleanup_confirmed_at IS NULL AND(v.status NOT IN('running','provisioning') OR v.environment_id IS NULL OR v.expires_at IS NULL OR v.expires_at+interval '120 seconds'>w.s))))
             OR(r.agreement_id IS NOT NULL AND v.expires_at<=w.s AND v.cleanup_confirmed_at IS NULL)) GROUP BY w.s,h.provider_id)
         SELECT DISTINCT ON(x.id) x.* FROM wanted w
         CROSS JOIN LATERAL(SELECT ranked.* FROM(
         SELECT available.*,COALESCE(sum(CASE WHEN prior_booking_id IS NULL THEN offering_free ELSE 0 END)
           OVER(PARTITION BY provider_id ORDER BY block_cost,created_at,id ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING),0) earlier_capacity
         FROM(SELECT s.*,to_char(s.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') offer_created_at,c.item||jsonb_build_object('id',c.id) item,c.approved,c.source_mode,p.name provider_name,p.total_capacity,p.policy,p.cloud_provider,
         p.total_capacity-COALESCE((p.policy->>'reserveSlots')::int,0)-COALESCE(pp.quantity,0)-COALESCE(ph.quantity,0) provider_free,
         s.capacity_quantity-COALESCE(op.quantity,0) offering_free,prior.id prior_booking_id,
         (ceil((extract(epoch FROM w.d-w.s)*s.discount_rate_cents_per_hour+extract(epoch FROM w.e-w.d)*s.normal_rate_cents_per_hour)/36)/100) block_cost
         FROM broker_scheduled_offerings s JOIN broker_catalog c ON c.id=s.catalog_id JOIN broker_providers p ON p.id=s.provider_id
         LEFT JOIN peaks pp ON pp.window_at=w.s AND pp.kind='provider' AND pp.id=p.id
         LEFT JOIN peaks op ON op.window_at=w.s AND op.kind='offering' AND op.id=s.id
         LEFT JOIN physical_holds ph ON ph.window_at=w.s AND ph.provider_id=p.id
         LEFT JOIN broker_agreement_bookings prior ON prior.window_id=w.id AND prior.scheduled_offering_id=s.id
         WHERE s.active AND c.approved AND c.source_mode=$1 AND($2='any' OR c.item->>'region'=$2)
         AND(c.item->>'cpu')::numeric>=$3 AND(c.item->>'memoryGb')::numeric>=$4
         AND($5::text IS NULL OR($5='any' AND COALESCE(c.item->>'gpu','')<>'') OR c.item->>'gpu'=$5)
         AND s.discount_rate_cents_per_hour<=$6 AND($7::numeric IS NULL OR s.normal_rate_cents_per_hour<=$7)
         AND(p.policy->'allowedCatalogIds' IS NULL OR p.policy->'allowedCatalogIds' ? s.catalog_id)
         AND(p.cloud_provider IS NULL OR p.cloud_provider=c.item->>'provider')
         AND p.total_capacity-COALESCE((p.policy->>'reserveSlots')::int,0)-COALESCE(pp.quantity,0)-COALESCE(ph.quantity,0)>0
         AND s.capacity_quantity>COALESCE(op.quantity,0)
         AND($1='fixture' OR(c.item->>'deadlineEnforcement'='native' AND(c.item->>'maxTtlSeconds')::int>=extract(epoch FROM w.e-w.s)
           AND c.item->>'pricingMode'='managed' AND COALESCE(c.item->>'providerKeyId','')=''
           AND c.item->>'provider'=ANY(ARRAY['e2b','daytona','provider-blaxel','modal'])
           AND(c.item->>'rateRetrievedAt')::timestamptz BETWEEN clock_timestamp()-interval '15 minutes' AND clock_timestamp()+interval '60 seconds'
           AND (ceil((extract(epoch FROM w.d-w.s)*s.discount_rate_cents_per_hour+extract(epoch FROM w.e-w.d)*s.normal_rate_cents_per_hour)/36)/100)*8500>=(c.item->>'rateMicrosPerSecond')::numeric*extract(epoch FROM w.e-w.s)))
         AND EXISTS(SELECT 1 FROM generate_series(-1,1) n CROSS JOIN LATERAL(SELECT(w.s AT TIME ZONE s.time_zone)::date+n AS day) local
           WHERE extract(dow FROM local.day)::int=ANY(s.weekdays)
           AND(local.day+s.window_start::time) AT TIME ZONE s.time_zone<=w.s
           AND(local.day+CASE WHEN s.window_end<=s.window_start THEN 1 ELSE 0 END+s.window_end::time) AT TIME ZONE s.time_zone>=w.d
           AND(local.day+CASE WHEN s.window_end<=s.window_start THEN 1 ELSE 0 END+CASE WHEN s.available_until<s.window_end THEN 1 ELSE 0 END+s.available_until::time) AT TIME ZONE s.time_zone>=w.e)
         )available)ranked
         WHERE prior_booking_id IS NOT NULL OR earlier_capacity<provider_free
         ORDER BY block_cost,created_at,id LIMIT 64)x ORDER BY x.id`,
        [
          ctx.wick.mode,
          spec.region,
          spec.requirements.cpu,
          spec.requirements.memoryGb,
          spec.requirements.gpu ?? null,
          spec.maxDiscountRateCentsPerHour,
          spec.continuation?.enabled ? spec.continuation.maxRateCentsPerHour : null,
          JSON.stringify(
            windows
              .filter((w) => !w.settled_at && new Date(w.starts_at) > new Date(a.db_now))
              .map((w) => ({
                id: w.id,
                s: iso(w.starts_at),
                d: iso(w.discount_ends_at),
                e: iso(w.ends_at),
              })),
          ),
        ],
      )
    ).rows;
    const providerIds = [...new Set<string>(candidates.map((c) => c.provider_id))].sort();
    if (providerIds.length)
      await db.query(
        'SELECT id FROM broker_providers WHERE id=ANY($1::uuid[]) ORDER BY id FOR UPDATE',
        [providerIds],
      );
    type Plan = { window: Row; candidate: Row; quantity: number; unit: number };
    const plans: Plan[] = [];
    const existing = (
      await db.query(
        'SELECT window_id,scheduled_offering_id,unit_price_cents,snapshot FROM broker_agreement_bookings WHERE agreement_id=$1',
        [id],
      )
    ).rows;
    let allowance =
      a.status === 'open'
        ? Number(a.max_amount_cents)
        : Math.max(
            0,
            subtractCents(
              Number(a.reserved_cents),
              windows
                .filter((w) => !w.settled_at)
                .reduce((sum, w) => addCents(sum, Number(w.committed_cents)), 0),
            ),
          );
    for (const w of windows) {
      if (w.settled_at || new Date(w.starts_at) <= new Date(a.db_now)) continue;
      const times = {
        startsAt: iso(w.starts_at)!,
        discountEndsAt: iso(w.discount_ends_at)!,
        endsAt: iso(w.ends_at)!,
      };
      let needed = a.target_quantity - w.approved_quantity;
      if (needed <= 0) continue;
      const cap = await capacities(db, providerIds, times.startsAt, times.endsAt);
      let global = await globalAvailableForInterval(ctx, db, times.startsAt, times.endsAt);
      const providerUsed = new Map<string, number>();
      const choices = candidates
        .filter((c) => eligible(ctx, c, spec, times))
        .map((c) => ({
          c,
          unit: windowCost(times, c.discount_rate_cents_per_hour, c.normal_rate_cents_per_hour),
        }))
        .sort(
          (x, y) =>
            x.unit - y.unit ||
            x.c.offer_created_at.localeCompare(y.c.offer_created_at) ||
            x.c.id.localeCompare(y.c.id),
        );
      for (const { c, unit } of choices) {
        const prior = existing.find(
          (b) => b.window_id === w.id && b.scheduled_offering_id === c.id,
        );
        if (
          prior &&
          (prior.unit_price_cents !== unit ||
            Number(prior.snapshot.revision) !== c.revision ||
            !sameCatalogAllocation(prior.snapshot.catalog, c.item))
        )
          continue;
        const free = Math.max(
          0,
          Number(c.total_capacity) -
            Number(c.policy.reserveSlots ?? 0) -
            (cap.peaks.get(`provider:${c.provider_id}`) ?? 0) -
            (cap.held.get(c.provider_id) ?? 0) -
            (providerUsed.get(c.provider_id) ?? 0),
        );
        const offerFree = Math.max(
          0,
          c.capacity_quantity - (cap.peaks.get(`offering:${c.id}`) ?? 0),
        );
        const quantity = Math.min(
          needed,
          free,
          offerFree,
          global,
          Number(moneyUnits(allowance) / moneyUnits(unit)),
        );
        if (quantity <= 0) continue;
        plans.push({ window: w, candidate: c, quantity, unit });
        needed -= quantity;
        global -= quantity;
        allowance = subtractCents(allowance, multiplyCents(unit, quantity));
        providerUsed.set(c.provider_id, (providerUsed.get(c.provider_id) ?? 0) + quantity);
        if (!needed) break;
      }
      if (a.status === 'open' && a.target_quantity - needed < a.minimum_quantity) {
        const supported =
          ctx.wick.mode === 'fixture' ||
          candidates.some((c) =>
            deadlineEligible(
              ctx,
              c.item,
              (Date.parse(times.endsAt) - Date.parse(times.startsAt)) / 1000,
            ),
          );
        await block(
          db,
          id,
          supported ? 'awaiting_capacity' : 'deadline_unsupported',
          supported
            ? 'Waiting for the minimum approved capacity in every chosen window.'
            : 'No eligible route attests native enforcement of the requested hard cutoff.',
        );
        return;
      }
    }
    if (a.status === 'open') {
      await applyCreditEntry(db, a.buyer_id, {
        operationKey: `agreement:${id}:reserve`,
        kind: 'reserve',
        balanceDeltaCents: 0,
        reservedDeltaCents: Number(a.max_amount_cents),
        agreementId: id,
        description:
          'Reserved maximum seven-day scheduled capacity credit; no compute starts automatically.',
      });
      await db.query(
        "UPDATE broker_agreements SET status='approved',reserved_cents=max_amount_cents WHERE id=$1",
        [id],
      );
    }
    for (const p of plans) {
      const c = p.candidate;
      const snapshot = {
        catalog: c.item,
        providerName: c.provider_name,
        cloudProvider: c.cloud_provider,
        offering: offeringInput(c),
        revision: c.revision,
        sourceMode: ctx.wick.mode,
      };
      await db.query(
        `INSERT INTO broker_agreement_bookings(agreement_id,window_id,provider_id,scheduled_offering_id,catalog_id,snapshot,quantity,unit_price_cents,starts_at,discount_ends_at,ends_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT(window_id,scheduled_offering_id) DO UPDATE SET quantity=broker_agreement_bookings.quantity+excluded.quantity`,
        [
          id,
          p.window.id,
          c.provider_id,
          c.id,
          c.catalog_id,
          snapshot,
          p.quantity,
          p.unit,
          p.window.starts_at,
          p.window.discount_ends_at,
          p.window.ends_at,
        ],
      );
      await db.query(
        'UPDATE broker_agreement_windows SET approved_quantity=approved_quantity+$2,committed_cents=committed_cents+$3 WHERE id=$1',
        [p.window.id, p.quantity, multiplyCents(p.unit, p.quantity)],
      );
      await db.query(
        'UPDATE broker_agreements SET committed_cents=committed_cents+$2 WHERE id=$1',
        [id, multiplyCents(p.unit, p.quantity)],
      );
    }
    await db.query(
      'UPDATE broker_agreements SET blocked_reason=NULL,blocked_code=NULL WHERE id=$1',
      [id],
    );
    await db.query(
      'UPDATE broker_agreements SET accepting_topups=false WHERE id=$1 AND NOT EXISTS(SELECT 1 FROM broker_agreement_windows WHERE agreement_id=$1 AND settled_at IS NULL AND approved_quantity<$2)',
      [id, a.target_quantity],
    );
  });
}
async function block(db: PoolClient, id: string, code: string, reason: string) {
  await db.query('UPDATE broker_agreements SET blocked_code=$2,blocked_reason=$3 WHERE id=$1', [
    id,
    code,
    reason,
  ]);
}
