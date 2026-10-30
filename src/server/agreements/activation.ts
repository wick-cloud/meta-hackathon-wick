import { subtractCents } from '../../shared/money.js';
import type { BrokerKeyAuthority } from '../../shared/developer.js';
import { enforceKeyLimit, recordKeyAction } from '../operations.js';
import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import type { ActivateAgreementInput, ActivateAgreementResult } from '../../shared/agreements.js';
import type { CatalogItem } from '../../shared/types.js';
import { revenueShare, managedPricing, requireFreshManagedRate } from '../../shared/pricing.js';
import { HttpError, type AppContext } from '../context.js';
import { enqueue, QUEUES, transaction } from '../marketplace/db.js';
import { integer, iso, uuid, syncCatalog, type Row } from '../marketplace/data.js';
import { assertProviderCatalog } from '../marketplace/provider-identity.js';
import { sameCatalogAllocation, assertManagedCustomerRoute } from '../marketplace/matching.js';
import { fingerprint, operationKey } from './credits.js';
import { activationView, deadlineEligible, globalLock, ownedAgreement } from './data.js';

export async function activateAgreement(
  ctx: AppContext,
  id: string,
  buyerId: string,
  raw: unknown,
  authority?: BrokerKeyAuthority,
): Promise<ActivateAgreementResult> {
  const b = (raw ?? {}) as ActivateAgreementInput;
  const key = operationKey(b.operationKey),
    windowId = uuid(b.windowId ?? ''),
    quantity = integer(b.quantity, 'Activation quantity', 1, 20),
    digest = fingerprint({ windowId, quantity });
  enforceKeyLimit(authority, 'maxActivationQuantity', quantity);
  if (ctx.wick.mode === 'real')
    await refreshActivationCatalog(ctx, id, buyerId, windowId, key, digest, quantity);
  const outcome = await transaction(ctx.pool, async (db) => {
    await globalLock(db);
    const a = await ownedAgreement(db, id, buyerId, true);
    await recordKeyAction(db, { id: buyerId, apiKey: authority }, 'agreements.activate', key, id);
    const prior = (
      await db.query(
        'SELECT * FROM broker_agreement_actions WHERE agreement_id=$1 AND operation_key=$2',
        [id, key],
      )
    ).rows[0];
    if (prior) {
      if (
        !['activate', 'activate_rejected'].includes(prior.kind) ||
        prior.input_fingerprint !== digest
      )
        throw new HttpError(
          409,
          'This operation key was already used for a different agreement action.',
        );
      const activations = (
        await db.query(
          'SELECT * FROM broker_agreement_activations WHERE agreement_id=$1 AND operation_key=$2 ORDER BY item_number',
          [id, key],
        )
      ).rows.map(activationView);
      return {
        activations,
        replayed: true,
        ...(prior.kind === 'activate_rejected' ? { rejection: rejectionMessage(activations) } : {}),
      };
    }
    if (a.status !== 'approved' || a.source_mode !== ctx.wick.mode)
      throw new HttpError(
        409,
        'Only an approved agreement in the current Wick mode can be activated.',
      );
    const w = (
      await db.query(
        'SELECT *,clock_timestamp() AS db_now FROM broker_agreement_windows WHERE id=$1 AND agreement_id=$2 FOR UPDATE',
        [windowId, id],
      )
    ).rows[0];
    if (
      !w ||
      w.settled_at ||
      new Date(w.db_now) < new Date(w.starts_at) ||
      new Date(w.db_now) >= new Date(w.ends_at)
    )
      throw new HttpError(409, 'Manual activation is available only inside this booked window.');
    const seconds = Math.floor(
      (new Date(w.ends_at).getTime() - new Date(w.db_now).getTime()) / 1000,
    );
    if (seconds < 60)
      throw new HttpError(409, 'Less than one minute remains before the immutable hard cutoff.');
    const configured =
      (await db.query("SELECT value FROM broker_settings WHERE key='maxConcurrentVms'")).rows[0]
        ?.value ?? ctx.config.maxConcurrentVms;
    const active = Number(
      (await db.query('SELECT count(*)::int n FROM broker_vms WHERE cleanup_confirmed_at IS NULL'))
        .rows[0].n,
    );
    // Include in-flight instant auctions, one global reservation per request.
    const held = Number(
      (
        await db.query(
          "SELECT count(*)::int n FROM broker_requests r WHERE r.agreement_id IS NULL AND r.status='open' AND NOT EXISTS(SELECT 1 FROM broker_vms v WHERE v.request_id=r.id) AND EXISTS(SELECT 1 FROM broker_bids b JOIN broker_holds h ON h.bid_id=b.id WHERE b.request_id=r.id AND h.released_at IS NULL)",
        )
      ).rows[0].n,
    );
    if (active + held + quantity > Number(configured))
      throw new HttpError(
        409,
        'The active VM limit includes allocations awaiting confirmed cleanup. Try again after cleanup.',
      );
    const bookings = (
      await db.query(
        `SELECT b.*,c.item||jsonb_build_object('id',c.id) current_catalog,c.approved,c.source_mode,p.cloud_provider FROM broker_agreement_bookings b JOIN broker_catalog c ON c.id=b.catalog_id JOIN broker_providers p ON p.id=b.provider_id WHERE b.window_id=$1 ORDER BY b.provider_id,b.id FOR UPDATE OF b`,
        [windowId],
      )
    ).rows;
    const providers = [...new Set<string>(bookings.map((b) => b.provider_id))].sort();
    const providerRows = providers.length
      ? (
          await db.query(
            'SELECT id,total_capacity,policy FROM broker_providers WHERE id=ANY($1::uuid[]) ORDER BY id FOR UPDATE',
            [providers],
          )
        ).rows
      : [];
    // Calendar rights do not release native runtime occupancy. Include instant
    // bids and every allocation still awaiting confirmed cleanup, in one batch.
    const physicalHolds = providers.length
      ? (
          await db.query(
            'SELECT provider_id,count(*)::int occupied FROM broker_holds WHERE provider_id=ANY($1::uuid[]) AND released_at IS NULL GROUP BY provider_id',
            [providers],
          )
        ).rows
      : [];
    const heldByProvider = new Map<string, number>(
      physicalHolds.map((row) => [row.provider_id, Number(row.occupied)]),
    );
    const physicalFree = new Map<string, number>(
      providerRows.map((row) => [
        row.id,
        Math.max(
          0,
          Number(row.total_capacity) -
            Number(row.policy.reserveSlots ?? 0) -
            (heldByProvider.get(row.id) ?? 0),
        ),
      ]),
    );
    const occupied = (
      await db.query(
        'SELECT booking_id,slot_index FROM broker_agreement_activations WHERE window_id=$1 AND cleaned_at IS NULL',
        [windowId],
      )
    ).rows;
    const taken = new Set(occupied.map((r) => `${r.booking_id}:${r.slot_index}`));
    const slots: { booking: Row; slot: number }[] = [];
    let unusedBookedSlots = 0;
    for (const booking of bookings)
      for (let slot = 1; slot <= booking.quantity; slot++) {
        if (taken.has(`${booking.id}:${slot}`)) continue;
        unusedBookedSlots++;
        const free = physicalFree.get(booking.provider_id) ?? 0;
        if (free < 1) continue;
        slots.push({ booking, slot });
        physicalFree.set(booking.provider_id, free - 1);
      }
    if (quantity > unusedBookedSlots)
      throw new HttpError(
        409,
        'Requested activations exceed the approved unused slots. Pending cleanup retains its slot.',
      );
    if (quantity > slots.length)
      throw new HttpError(
        409,
        'Booked capacity is temporarily occupied by supplier reservations awaiting confirmed cleanup. Your approved slots remain booked; try a smaller quantity or wait for cleanup.',
      );
    const selected = slots.slice(0, quantity);
    const denials = selected.flatMap((item, index) => {
      const failure = bookingAdmissionFailure(ctx, item.booking, seconds);
      return failure ? [{ ...item, index, failure }] : [];
    });
    if (denials.length) {
      await db.query(
        "INSERT INTO broker_agreement_actions(agreement_id,operation_key,kind,input_fingerprint) VALUES($1,$2,'activate_rejected',$3)",
        [id, key, digest],
      );
      const receipts = [];
      for (const { booking, slot, index, failure } of denials) {
        const receipt = (
          await db.query(
            "INSERT INTO broker_agreement_activations(agreement_id,window_id,booking_id,slot_index,operation_key,item_number,ends_at,status,cleaned_at,failure_reason) VALUES($1,$2,$3,$4,$5,$6,$7,'failed',clock_timestamp(),$8) RETURNING *",
            [
              id,
              windowId,
              booking.id,
              slot,
              key,
              index + 1,
              w.ends_at,
              `[${failure.code}] ${failure.reason}`,
            ],
          )
        ).rows[0];
        await creditUndeliveredSlot(db, {
          ...receipt,
          unit_price_cents: booking.unit_price_cents,
          buyer_id: buyerId,
        });
        receipts.push(activationView(receipt));
      }
      return { activations: receipts, replayed: false, rejection: rejectionMessage(receipts) };
    }
    await db.query(
      "INSERT INTO broker_agreement_actions(agreement_id,operation_key,kind,input_fingerprint) VALUES($1,$2,'activate',$3)",
      [id, key, digest],
    );
    const result = [];
    for (const [index, { booking, slot }] of selected.entries()) {
      const catalog = {
        ...booking.snapshot.catalog,
        deadlineEnforcement: booking.current_catalog.deadlineEnforcement,
        maxTtlSeconds: booking.current_catalog.maxTtlSeconds,
      } as CatalogItem;
      const activationId = randomUUID(),
        vmId = randomUUID();
      const act = (
        await db.query(
          'INSERT INTO broker_agreement_activations(id,agreement_id,window_id,booking_id,slot_index,operation_key,item_number,ends_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *',
          [activationId, id, windowId, booking.id, slot, key, index + 1, w.ends_at],
        )
      ).rows[0];
      const request = (
        await db.query(
          `INSERT INTO broker_requests(buyer_id,description,catalog_id,catalog_snapshot,region,duration_minutes,max_price_cents,requirements,status,closes_at,agreement_id,agreement_activation_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,'provisioning',clock_timestamp(),$9,$10) RETURNING *`,
          [
            buyerId,
            `${a.description} · manual scheduled activation`,
            booking.catalog_id,
            { ...catalog, sourceMode: ctx.wick.mode },
            catalog.region,
            Math.ceil(seconds / 60),
            booking.unit_price_cents,
            a.specification.requirements,
            id,
            activationId,
          ],
        )
      ).rows[0];
      // Existing lifecycle's bid FK is retained; this internal offering does not enter instant auctions.
      const offering = (
        await db.query(
          `INSERT INTO broker_offerings(provider_id,catalog_id,name,description,price_cents,active) VALUES($1,$2,$3,'Prebooked scheduled capacity; manual activation only',$4,false) ON CONFLICT(provider_id,catalog_id,name) DO UPDATE SET active=false RETURNING id`,
          [
            booking.provider_id,
            booking.catalog_id,
            `Scheduled ${booking.scheduled_offering_id}`,
            booking.unit_price_cents,
          ],
        )
      ).rows[0];
      const snapshot = {
        catalog,
        cloudProvider: booking.cloud_provider,
        providerName: booking.snapshot.providerName,
        simulated: ctx.wick.mode === 'fixture',
        billingSource: 'scheduled_capacity',
        agreementId: id,
        agreementActivationId: activationId,
      };
      const bid = (
        await db.query(
          "INSERT INTO broker_bids(request_id,provider_id,offering_id,offering_snapshot,total_price_cents,status) VALUES($1,$2,$3,$4,$5,'won') RETURNING *",
          [request.id, booking.provider_id, offering.id, snapshot, booking.unit_price_cents],
        )
      ).rows[0];
      await db.query('INSERT INTO broker_holds(bid_id,provider_id) VALUES($1,$2)', [
        bid.id,
        booking.provider_id,
      ]);
      const config = ctx.config;
      const createInput = {
        organizationId: catalog.organizationId || config.wickOrganizationId,
        groupId: catalog.groupId || config.wickGroupId,
        name: `${config.environmentNamePrefix || 'wick-broker'}-${vmId.slice(0, 8)}`,
        provider: catalog.provider,
        profile: catalog.profile,
        region: catalog.region,
        ttlSeconds: seconds,
        hardEndAt: iso(w.ends_at),
        visibility: 'private',
        ...(ctx.wick.mode === 'real'
          ? { maximumPriceMicrosPerSecond: booking.snapshot.catalog.rateMicrosPerSecond }
          : {}),
      };
      if (!createInput.organizationId || !createInput.groupId)
        throw new HttpError(503, 'The Wick organization and group must be configured.');
      await db.query(
        'INSERT INTO broker_vms(id,request_id,buyer_id,provider_id,bid_id,create_key,create_input,catalog_snapshot,quote_snapshot,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
        [
          vmId,
          request.id,
          buyerId,
          booking.provider_id,
          bid.id,
          `broker-v1:${vmId}`,
          createInput,
          { ...catalog, sourceMode: ctx.wick.mode },
          {
            totalPriceCents: booking.unit_price_cents,
            currency: 'USD',
            feeCents: 0,
            revenueShare: revenueShare(booking.unit_price_cents),
            billingSource: 'scheduled_capacity',
            agreementId: id,
            agreementActivationId: activationId,
            bookingId: booking.id,
            scheduledWindow: {
              windowId,
              startsAt: iso(w.starts_at),
              discountEndsAt: iso(w.discount_ends_at),
              endsAt: iso(w.ends_at),
              discountRateCentsPerHour: booking.snapshot.offering.discountRateCentsPerHour,
              normalRateCentsPerHour: booking.snapshot.offering.normalRateCentsPerHour,
            },
            offering: snapshot,
          },
          w.ends_at,
        ],
      );
      await db.query('UPDATE broker_requests SET winning_bid_id=$2 WHERE id=$1', [
        request.id,
        bid.id,
      ]);
      await db.query('UPDATE broker_agreement_activations SET request_id=$2,vm_id=$3 WHERE id=$1', [
        activationId,
        request.id,
        vmId,
      ]);
      await enqueue(ctx, db, QUEUES.provision, { vmId });
      result.push(activationView({ ...act, request_id: request.id, vm_id: vmId }));
    }
    return { activations: result, replayed: false };
  });
  // Reject only after the receipt and its once-per-slot adjustment are durable.
  if (outcome.rejection) throw new HttpError(409, outcome.rejection);
  return { activations: outcome.activations, replayed: outcome.replayed };
}
/** Authorize first, refresh once without a transaction, then the admission transaction rechecks everything. */
async function refreshActivationCatalog(
  ctx: AppContext,
  id: string,
  buyerId: string,
  windowId: string,
  key: string,
  digest: string,
  quantity: number,
) {
  const refresh = await transaction(ctx.pool, async (db) => {
    await globalLock(db);
    const a = await ownedAgreement(db, id, buyerId, true);
    const prior = (
      await db.query(
        'SELECT kind,input_fingerprint FROM broker_agreement_actions WHERE agreement_id=$1 AND operation_key=$2',
        [id, key],
      )
    ).rows[0];
    if (prior) {
      if (
        !['activate', 'activate_rejected'].includes(prior.kind) ||
        prior.input_fingerprint !== digest
      )
        throw new HttpError(
          409,
          'This operation key was already used for a different agreement action.',
        );
      return false;
    }
    if (a.status !== 'approved' || a.source_mode !== ctx.wick.mode)
      throw new HttpError(
        409,
        'Only an approved agreement in the current Wick mode can be activated.',
      );
    const w = (
      await db.query(
        'SELECT *,clock_timestamp() AS db_now FROM broker_agreement_windows WHERE id=$1 AND agreement_id=$2 FOR UPDATE',
        [windowId, id],
      )
    ).rows[0];
    if (
      !w ||
      w.settled_at ||
      new Date(w.db_now) < new Date(w.starts_at) ||
      new Date(w.db_now) >= new Date(w.ends_at)
    )
      throw new HttpError(409, 'Manual activation is available only inside this booked window.');
    if (new Date(w.ends_at).getTime() - new Date(w.db_now).getTime() < 60000)
      throw new HttpError(409, 'Less than one minute remains before the immutable hard cutoff.');
    const occupied = Number(
      (
        await db.query(
          'SELECT count(*)::int n FROM broker_agreement_activations WHERE window_id=$1 AND cleaned_at IS NULL',
          [windowId],
        )
      ).rows[0].n,
    );
    if (quantity > w.approved_quantity - occupied)
      throw new HttpError(
        409,
        'Requested activations exceed the approved unused slots. Pending cleanup retains its slot.',
      );
    return true;
  });
  if (!refresh) return;
  try {
    await syncCatalog(ctx);
  } catch {
    throw new HttpError(
      503,
      'Current native pricing could not be verified. No environment was created and no booked credit was changed. Retry the same operation after catalog access recovers.',
    );
  }
}
function rejectionMessage(receipts: ReturnType<typeof activationView>[]) {
  return `${receipts[0]?.failureReason ?? 'The booked route could not be admitted.'} No environments were created. A failed-start receipt is recorded; the undelivered slot adjustment applies at settlement unless the slot later becomes ready.`;
}
/** These are service admission fences for an already authorized, owned booked slot. */
function bookingAdmissionFailure(
  ctx: AppContext,
  b: Row,
  seconds: number,
): { code: string; reason: string } | undefined {
  const current = b.current_catalog as CatalogItem,
    frozen = b.snapshot.catalog as CatalogItem;
  if (!b.approved || b.source_mode !== ctx.wick.mode)
    return {
      code: 'booked_catalog_unavailable',
      reason: 'The booked configuration is no longer approved in the current Wick mode.',
    };
  if (!deadlineEligible(ctx, current, seconds))
    return {
      code: 'native_deadline_unavailable',
      reason:
        'This booked route no longer attests the required native hard deadline. No VM was started.',
    };
  try {
    assertProviderCatalog(b, current);
  } catch (error) {
    if (error instanceof HttpError)
      return { code: 'provider_route_changed', reason: error.message };
    throw error;
  }
  if (!sameCatalogAllocation(frozen, current))
    return {
      code: 'booked_configuration_changed',
      reason:
        'The booked provider route or scope changed. Administrative review is required before activation.',
    };
  if (ctx.wick.mode === 'real' && (current.providerKeyId || current.pricingMode !== 'managed'))
    return {
      code: 'managed_route_unavailable',
      reason: 'The booked route must still use managed Wick billing.',
    };
  if (ctx.wick.mode === 'real') {
    try {
      assertManagedCustomerRoute(current);
    } catch (error) {
      if (error instanceof HttpError)
        return { code: 'managed_route_unavailable', reason: error.message };
      throw error;
    }
    try {
      requireFreshManagedRate(current);
    } catch (error) {
      return {
        code: 'catalog_rate_unverified',
        reason: error instanceof Error ? error.message : 'Refresh managed pricing.',
      };
    }
    let rate: number, frozenRate: number;
    try {
      rate = managedPricing(current).rateMicrosPerSecond;
      frozenRate = managedPricing(frozen).rateMicrosPerSecond;
    } catch (error) {
      return {
        code: 'managed_pricing_unavailable',
        reason:
          error instanceof Error ? error.message : 'The managed pricing snapshot is unavailable.',
      };
    }
    if (rate > frozenRate)
      return {
        code: 'frozen_cost_ceiling_exceeded',
        reason:
          'The current Wick rate exceeds the frozen scheduled cost ceiling. No VM was started.',
      };
  }
  if (
    !(frozen.organizationId || ctx.config.wickOrganizationId) ||
    !(frozen.groupId || ctx.config.wickGroupId)
  )
    return {
      code: 'broker_scope_unconfigured',
      reason: 'The Wick organization and group must be configured.',
    };
}

/** Called inside the lifecycle transaction. Never matches, bills runtime or calls the network. */
export async function scheduledActivationReady(_ctx: AppContext, db: PoolClient, vm: Row) {
  if (vm.quote_snapshot?.billingSource !== 'scheduled_capacity') return;
  const a = (
    await db.query(
      'SELECT * FROM broker_agreement_activations WHERE id=$1 AND vm_id=$2 AND cleaned_at IS NULL FOR UPDATE',
      [vm.quote_snapshot.agreementActivationId, vm.id],
    )
  ).rows[0];
  if (!a) return;
  await db.query('SELECT id FROM broker_agreements WHERE id=$1 FOR UPDATE', [a.agreement_id]);
  if (
    (
      await db.query(
        'SELECT 1 FROM broker_agreement_windows WHERE id=$1 AND(settled_at IS NOT NULL OR ends_at<=clock_timestamp())',
        [a.window_id],
      )
    ).rowCount
  )
    throw new HttpError(409, 'The immutable scheduled hard end elapsed before readiness.');
  await db.query(
    "UPDATE broker_agreement_activations SET status='running',first_ready_at=COALESCE(first_ready_at,clock_timestamp()) WHERE id=$1 AND vm_id=$2 AND cleaned_at IS NULL",
    [vm.quote_snapshot.agreementActivationId, vm.id],
  );
  // A booked slot that eventually delivers a ready VM is payable once, even after a failed retry.
  const adjustment = (
    await db.query(
      'DELETE FROM broker_agreement_adjustments WHERE booking_id=$1 AND slot_index=$2 RETURNING amount_cents',
      [a.booking_id, a.slot_index],
    )
  ).rows[0];
  if (adjustment) {
    const amount = Number(adjustment.amount_cents);
    await db.query(
      'UPDATE broker_agreement_bookings SET adjustment_cents=adjustment_cents-$2 WHERE id=$1',
      [a.booking_id, amount],
    );
    await db.query(
      'UPDATE broker_agreement_windows SET adjustment_cents=adjustment_cents-$2 WHERE id=$1',
      [a.window_id, amount],
    );
    await db.query(
      'UPDATE broker_agreements SET adjustment_cents=adjustment_cents-$2 WHERE id=$1',
      [a.agreement_id, amount],
    );
  }
}
export async function scheduledActivationCleaned(
  _ctx: AppContext,
  db: PoolClient,
  vm: Row,
  options: { admissionRejected?: boolean } = {},
) {
  if (vm.quote_snapshot?.billingSource !== 'scheduled_capacity') return;
  const a = (
    await db.query(
      'SELECT a.*,b.unit_price_cents,g.buyer_id,w.settled_at FROM broker_agreement_activations a JOIN broker_agreement_bookings b ON b.id=a.booking_id JOIN broker_agreements g ON g.id=a.agreement_id JOIN broker_agreement_windows w ON w.id=a.window_id WHERE a.id=$1 AND a.vm_id=$2 FOR UPDATE OF a',
      [vm.quote_snapshot.agreementActivationId, vm.id],
    )
  ).rows[0];
  if (!a || a.cleaned_at) return;
  const failed = !vm.ready_at && !a.first_ready_at;
  await db.query(
    'UPDATE broker_agreement_activations SET status=$2,cleaned_at=clock_timestamp(),failure_reason=$3 WHERE id=$1',
    [
      a.id,
      failed ? 'failed' : 'terminated',
      failed
        ? options.admissionRejected
          ? 'Admission rejected before native creation.'
          : vm.failure_reason || 'The environment failed to start.'
        : null,
    ],
  );
  if (!failed) return;
  await creditUndeliveredSlot(db, a);
}
async function creditUndeliveredSlot(db: PoolClient, a: Row) {
  // Settlement and cleanup serialize on the agreement row; once per booked slot/day.
  await db.query('SELECT id FROM broker_agreements WHERE id=$1 FOR UPDATE', [a.agreement_id]);
  if (
    (
      await db.query(
        'SELECT 1 FROM broker_agreement_activations WHERE booking_id=$1 AND slot_index=$2 AND first_ready_at IS NOT NULL LIMIT 1',
        [a.booking_id, a.slot_index],
      )
    ).rowCount
  )
    return;
  const inserted = await db.query(
    'INSERT INTO broker_agreement_adjustments(agreement_id,window_id,booking_id,slot_index,activation_id,amount_cents) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(booking_id,slot_index) DO NOTHING RETURNING id',
    [a.agreement_id, a.window_id, a.booking_id, a.slot_index, a.id, a.unit_price_cents],
  );
  if (!inserted.rowCount) return;
  await db.query(
    'UPDATE broker_agreement_bookings SET adjustment_cents=adjustment_cents+$2 WHERE id=$1',
    [a.booking_id, a.unit_price_cents],
  );
  await db.query(
    'UPDATE broker_agreement_windows SET adjustment_cents=adjustment_cents+$2 WHERE id=$1',
    [a.window_id, a.unit_price_cents],
  );
  await db.query('UPDATE broker_agreements SET adjustment_cents=adjustment_cents+$2 WHERE id=$1', [
    a.agreement_id,
    a.unit_price_cents,
  ]);
  const window = (
    await db.query('SELECT settled_at FROM broker_agreement_windows WHERE id=$1', [a.window_id])
  ).rows[0];
  if (window.settled_at) {
    const { applyCreditEntry } = await import('./credits.js');
    await applyCreditEntry(db, a.buyer_id, {
      operationKey: `agreement:${a.agreement_id}:failed:${a.id}`,
      kind: 'failed_start_credit',
      balanceDeltaCents: a.unit_price_cents,
      reservedDeltaCents: 0,
      agreementId: a.agreement_id,
      description: 'Credit adjustment for a booked slot whose VM never became ready.',
    });
    const charge = (
      await db.query('SELECT * FROM broker_agreement_charges WHERE booking_id=$1 FOR UPDATE', [
        a.booking_id,
      ])
    ).rows[0];
    if (charge)
      await db.query(
        'UPDATE broker_agreement_charges SET credit_cents=credit_cents+$2,total_cents=total_cents-$2,revenue_share=$3 WHERE id=$1',
        [
          charge.id,
          a.unit_price_cents,
          revenueShare(subtractCents(Number(charge.total_cents), a.unit_price_cents)),
        ],
      );
    await db.query('UPDATE broker_agreements SET settled_cents=settled_cents-$2 WHERE id=$1', [
      a.agreement_id,
      a.unit_price_cents,
    ]);
    await db.query(
      'UPDATE broker_agreement_windows SET settled_cents=settled_cents-$2 WHERE id=$1',
      [a.window_id, a.unit_price_cents],
    );
  }
}
