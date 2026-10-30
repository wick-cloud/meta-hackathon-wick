import { addCents, subtractCents, multiplyCents } from '../../shared/money.js';
import type { BrokerKeyAuthority } from '../../shared/developer.js';
import { enforceKeyLimit, recordKeyAction, operationFingerprint } from '../operations.js';
import type { AppContext } from '../context.js';
import { HttpError } from '../context.js';
import { transaction } from '../marketplace/db.js';
import { agreementDetail, globalLock, ownedAgreement } from './data.js';
import { applyCreditEntry, fingerprint, operationKey } from './credits.js';
import { validateAgreement } from './recurrence.js';
import { windowCost } from './recurrence.js';
import type { AgreementPreview } from '../../shared/agreements.js';
import { matchAgreement } from './matching.js';

/** Authoritative calendar/rounding preview: one DB-clock read, no transaction or mutations. */
export async function previewAgreement(
  ctx: Pick<AppContext, 'pool'>,
  raw: unknown,
): Promise<AgreementPreview> {
  const now = (await ctx.pool.query('SELECT clock_timestamp() at')).rows[0].at;
  const { input, windows, maxAmountCents } = validateAgreement(raw, new Date(now).getTime());
  const minimumAmountCents = windows.reduce(
    (sum, w) =>
      addCents(
        sum,
        multiplyCents(
          windowCost(w, input.maxDiscountRateCentsPerHour, input.continuation?.maxRateCentsPerHour),
          input.minimumQuantity,
        ),
      ),
    0,
  );
  return { maxAmountCents, minimumAmountCents, windows, timeZone: input.timeZone };
}

export async function createAgreement(
  ctx: AppContext,
  buyerId: string,
  raw: unknown,
  authority?: BrokerKeyAuthority,
) {
  const key = operationKey((raw as { operationKey?: unknown })?.operationKey),
    digest = operationFingerprint(raw);
  const id = await transaction(ctx.pool, async (db) => {
    await globalLock(db);
    const prior = (
      await db.query('SELECT * FROM broker_agreements WHERE buyer_id=$1 AND operation_key=$2', [
        buyerId,
        key,
      ])
    ).rows[0];
    if (prior) {
      if (prior.input_fingerprint !== digest && prior.input_fingerprint !== fingerprint(raw))
        throw new HttpError(409, 'This operation key was already used for another order.');
      enforceKeyLimit(authority, 'maxAgreementReservationCents', Number(prior.max_amount_cents));
      return prior.id as string;
    }
    const now = (await db.query('SELECT clock_timestamp() at')).rows[0].at;
    const { input, windows, maxAmountCents } = validateAgreement(raw, new Date(now).getTime());
    enforceKeyLimit(authority, 'maxAgreementReservationCents', maxAmountCents);
    const a = (
      await db.query(
        `INSERT INTO broker_agreements(buyer_id,operation_key,input_fingerprint,description,specification,target_quantity,minimum_quantity,starts_at,expires_at,time_zone,source_mode,max_amount_cents,source_api_key_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id`,
        [
          buyerId,
          key,
          digest,
          input.description,
          input,
          input.targetQuantity,
          input.minimumQuantity,
          windows[0].startsAt,
          windows[6].endsAt,
          input.timeZone,
          ctx.wick.mode,
          maxAmountCents,
          authority?.id ?? null,
        ],
      )
    ).rows[0];
    await db.query(
      `INSERT INTO broker_agreement_windows(agreement_id,starts_at,discount_ends_at,ends_at) SELECT $1,x.s::timestamptz,x.d::timestamptz,x.e::timestamptz FROM jsonb_to_recordset($2::jsonb) AS x(s text,d text,e text)`,
      [
        a.id,
        JSON.stringify(windows.map((w) => ({ s: w.startsAt, d: w.discountEndsAt, e: w.endsAt }))),
      ],
    );
    await recordKeyAction(db, { id: buyerId, apiKey: authority }, 'agreements.create', key, a.id);
    return a.id as string;
  });
  await matchAgreement(ctx, id);
  return agreementDetail(ctx, ctx.pool, id, buyerId);
}
export async function cancelUnmatched(
  ctx: AppContext,
  id: string,
  buyerId: string,
  raw: unknown,
  authority?: BrokerKeyAuthority,
) {
  const key = operationKey((raw as { operationKey?: unknown })?.operationKey),
    digest = fingerprint({ kind: 'cancel-unmatched' });
  await transaction(ctx.pool, async (db) => {
    await globalLock(db);
    const a = await ownedAgreement(db, id, buyerId, true);
    const prior = (
      await db.query(
        'SELECT * FROM broker_agreement_actions WHERE agreement_id=$1 AND operation_key=$2',
        [id, key],
      )
    ).rows[0];
    if (prior) {
      if (prior.kind !== 'cancel-unmatched' || prior.input_fingerprint !== digest)
        throw new HttpError(409, 'This operation key was already used for another action.');
      return;
    }
    const remaining = Number(
      (
        await db.query(
          'SELECT COALESCE(sum(committed_cents),0) n FROM broker_agreement_windows WHERE agreement_id=$1 AND settled_at IS NULL',
          [id],
        )
      ).rows[0].n,
    );
    const expired = (
      await db.query('SELECT $1::timestamptz<=clock_timestamp() expired', [a.expires_at])
    ).rows[0].expired;
    const pending =
      expired &&
      Boolean(
        (
          await db.query(
            'SELECT 1 FROM broker_agreement_activations WHERE agreement_id=$1 AND cleaned_at IS NULL LIMIT 1',
            [id],
          )
        ).rowCount,
      );
    const release = pending ? 0 : Math.max(0, subtractCents(Number(a.reserved_cents), remaining));
    if (release)
      await applyCreditEntry(db, buyerId, {
        operationKey: `agreement:${id}:cancel-release`,
        kind: 'release',
        balanceDeltaCents: 0,
        reservedDeltaCents: -release,
        agreementId: id,
        description: 'Released unmatched capacity credit; already booked capacity remains payable.',
      });
    await db.query(
      "UPDATE broker_agreements SET accepting_topups=false,reserved_cents=reserved_cents-$2,status=CASE WHEN $3 THEN 'expired' WHEN committed_cents=0 THEN 'cancelled' ELSE status END,blocked_reason=CASE WHEN $3 THEN 'The term expired. Unmatched credit release is pending confirmed VM cleanup.' ELSE NULL END,blocked_code=NULL WHERE id=$1",
      [id, release, pending],
    );
    await recordKeyAction(
      db,
      { id: buyerId, apiKey: authority },
      'agreements.cancelUnmatched',
      key,
      id,
    );
    await db.query(
      "INSERT INTO broker_agreement_actions(agreement_id,operation_key,kind,input_fingerprint) VALUES($1,$2,'cancel-unmatched',$3)",
      [id, key, digest],
    );
  });
  return agreementDetail(ctx, ctx.pool, id, buyerId);
}
