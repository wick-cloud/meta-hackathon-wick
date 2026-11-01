import { moneyAmount } from './data.js';
import { studioGrantOpen, studioAuthority, type StudioSource } from '../coding/studio-budget.js';
import { admitBuyingDecision } from './buying-guard.js';
import { centsFromUnits, moneyUnits, MIN_ORDER_PRICE_CENTS } from '../../shared/money.js';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import type { PoolClient } from 'pg';
import type { Actor } from '../../shared/types.js';
import {
  INFERENCE_MODEL_ID,
  INFERENCE_PROVIDERS,
  type InferenceProvider,
  type TokenQuote,
} from '../../shared/inference.js';
import type { AppContext } from '../context.js';
import { applyCreditEntry } from '../agreements/credits.js';
import { enqueue, transaction } from '../marketplace/db.js';
import type { Row } from '../marketplace/data.js';
import { operationFingerprint, withOperation } from '../operations.js';
import { minimumInputReservation, type RuntimeRoute } from './runtime.js';
import {
  activeMode,
  assertRoute,
  authority,
  bidView,
  clock,
  event,
  failure,
  grantView,
  integer,
  lockedGrant,
  offeringView,
  operationSchema,
  orderView,
  packView,
  runtime,
} from './data.js';

export const TOKEN_CLOSE_QUEUE = 'broker-token-auction-close';
export const OFFER_SELECT = `SELECT r.*,o.revision,o.active,o.auto_bid,o.input_rate,o.output_rate,o.instant_markup_bps,
  o.minimum_price_cents,o.max_outstanding_input,o.max_outstanding_output,o.sales_start_at,o.sales_end_at FROM broker_inference_routes r
  JOIN broker_token_offerings o USING(provider)`;
const quantities = z.object({
  grantId: z.uuid().optional(),
  modelId: z.literal(INFERENCE_MODEL_ID).optional(),
  inputTokens: integer(10_000_000),
  outputTokens: integer(1_000_000),
});
const createOrderSchema = quantities
  .extend({
    operationKey: operationSchema,
    mode: z.enum(['auction', 'instant']),
    maxTotalCents: moneyAmount(100_000_000, MIN_ORDER_PRICE_CENTS),
    quoteId: z.string().max(4000).optional(),
  })
  .strict();
const ceil = (a: bigint, b: bigint) => (a + b - 1n) / b;
/** Rates are microUSD / million tokens. Round once, after combining both dimensions. */
export function packPrice(row: Row, input: number, output: number, instant = false) {
  const native =
    BigInt(input) * BigInt(row.cost_input_rate) + BigInt(output) * BigInt(row.cost_output_rate);
  const ask = BigInt(input) * BigInt(row.input_rate) + BigInt(output) * BigInt(row.output_rate);
  const floor = centsFromUnits(ceil(native, 85_000_000n));
  const price = centsFromUnits(
    ceil(ask * BigInt(instant ? 10000 + row.instant_markup_bps : 10000), 1_000_000_000_000n),
  );
  return {
    priceCents: Math.max(MIN_ORDER_PRICE_CENTS, floor, price, row.minimum_price_cents),
    costFloorCents: floor,
  };
}
export async function initializeInference(ctx: AppContext) {
  if (!ctx.inference) return;
  await transaction(ctx.pool, async (db) => {
    for (const [i, provider] of [...INFERENCE_PROVIDERS].sort().entries()) {
      const route = ctx.inference!.routes.get(provider)!;
      const email =
        provider === 'baseten'
          ? ctx.config.inferenceBasetenProviderEmail
          : ctx.config.inferenceModalProviderEmail;
      const seller =
        route.mode === 'fixture'
          ? (await db.query('SELECT id FROM broker_providers ORDER BY id LIMIT 1 OFFSET $1', [i]))
              .rows[0]
          : (
              await db.query(
                'SELECT p.id FROM broker_providers p JOIN "user" u ON u.id=p.user_id WHERE lower(u.email)=lower($1)',
                [email],
              )
            ).rows[0];
      const prior = (
        await db.query('SELECT * FROM broker_inference_routes WHERE provider=$1 FOR UPDATE', [
          provider,
        ])
      ).rows[0];
      const changed =
        prior &&
        (prior.provider_id !== (seller?.id ?? null) ||
          prior.source_mode !== route.mode ||
          prior.fingerprint !== route.fingerprint);
      if (
        changed &&
        (Number(prior.outstanding_input) || Number(prior.outstanding_output) || prior.held_calls)
      ) {
        await db.query(
          "UPDATE broker_inference_routes SET qualified=false,blocked_reason='Retire outstanding packs before changing the seller, mode or accounting contract.' WHERE provider=$1",
          [provider],
        );
        continue;
      }
      if (changed && prior.provider_id)
        await db.query(
          'UPDATE broker_token_offerings SET active=false,auto_bid=false,revision=revision+1 WHERE provider=$1',
          [provider],
        );
      await db.query(
        `INSERT INTO broker_inference_routes(provider,provider_id,source_mode,fingerprint,qualified,blocked_reason,input_bound,max_output_tokens,cost_input_rate,cost_output_rate)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,1250000,4250000) ON CONFLICT(provider) DO UPDATE SET
        provider_id=EXCLUDED.provider_id,
        source_mode=EXCLUDED.source_mode,fingerprint=EXCLUDED.fingerprint,qualified=EXCLUDED.qualified,blocked_reason=EXCLUDED.blocked_reason,
        input_bound=EXCLUDED.input_bound,max_output_tokens=EXCLUDED.max_output_tokens,
        quarantined_at=CASE WHEN broker_inference_routes.fingerprint=EXCLUDED.fingerprint THEN broker_inference_routes.quarantined_at ELSE NULL END,updated_at=clock_timestamp()`,
        [
          provider,
          seller?.id ?? null,
          route.mode,
          route.fingerprint,
          route.qualified && Boolean(seller),
          seller ? route.reason : 'A provider account must be mapped to this inference route.',
          route.inputBound,
          route.maximumOutputTokens,
        ],
      );
      await db.query(
        `INSERT INTO broker_token_offerings(provider,input_rate,output_rate,active,auto_bid,minimum_price_cents) VALUES($1,$2,$3,$4,$4,$5) ON CONFLICT DO NOTHING`,
        [
          provider,
          provider === 'modal' ? 1_650_000 : 1_700_000,
          provider === 'modal' ? 5_500_000 : 5_600_000,
          route.mode === 'fixture',
          MIN_ORDER_PRICE_CENTS,
        ],
      );
    }
  });
}
function grantIdFor(actor: Actor, requested?: string): string {
  if (actor.apiKey) {
    if (!actor.apiKey.grantId || (requested && requested !== actor.apiKey.grantId))
      failure(403, 'grant_scope', 'Use the grant bound to this agent key.');
    return actor.apiKey.grantId;
  }
  if (!requested) failure(400, 'grant_required', 'Select a funded agent grant.');
  return requested;
}
export function offeringOpen(row: Row, at: Date) {
  return (
    row.active &&
    (!row.sales_start_at || new Date(row.sales_start_at) <= at) &&
    (!row.sales_end_at || new Date(row.sales_end_at) > at)
  );
}
function hasCapacity(row: Row, input: number, output: number) {
  return (
    Number(row.outstanding_input) + input <= Number(row.max_outstanding_input) &&
    Number(row.outstanding_output) + output <= Number(row.max_outstanding_output)
  );
}
function snapshot(row: Row, native: RuntimeRoute) {
  return {
    currencyDecimals: 4,
    provider: row.provider,
    providerId: row.provider_id,
    sourceMode: row.source_mode,
    fingerprint: row.fingerprint,
    revision: row.revision,
    minimumInputReservation: minimumInputReservation(native),
    ...(native.minimumOutputTokens ? { minimumOutputTokens: native.minimumOutputTokens } : {}),
    ...(native.inputAccounting
      ? { inputAccounting: native.inputAccounting, maximumInputReservation: native.inputBound }
      : {}),
    inputRate: Number(row.input_rate),
    outputRate: Number(row.output_rate),
    costInputRate: Number(row.cost_input_rate),
    costOutputRate: Number(row.cost_output_rate),
  };
}
function signQuote(ctx: AppContext, payload: object) {
  const text = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${text}.${createHmac('sha256', ctx.config.authSecret).update(`token-quote:${text}`).digest('base64url')}`;
}
function verifyQuote(ctx: AppContext, quoteId: string): Row {
  try {
    const [text, signature, extra] = quoteId.split('.');
    if (!text || !signature || extra) throw Error();
    const actual = Buffer.from(signature, 'base64url'),
      expected = createHmac('sha256', ctx.config.authSecret).update(`token-quote:${text}`).digest();
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw Error();
    const value = JSON.parse(Buffer.from(text, 'base64url').toString('utf8'));
    if (!value || typeof value !== 'object') throw Error();
    return value;
  } catch {
    failure(400, 'invalid_quote', 'The instant quote is invalid. Request a fresh quote.');
  }
}
export async function quotes(
  ctx: AppContext,
  actor: Actor,
  raw: unknown,
): Promise<{ items: TokenQuote[] }> {
  const input = quantities.strict().parse(raw),
    grantId = grantIdFor(actor, input.grantId);
  return transaction(ctx.pool, async (db) => {
    await authority(db, actor, 'inference:read');
    const grant = await lockedGrant(db, actor, grantId, true);
    activeMode(ctx, grant);
    if (!grant.allow_instant)
      failure(403, 'instant_disabled', 'The owner disabled instant purchases for this grant.');
    const now = await clock(db),
      expiresAt = new Date(
        Math.min(now.getTime() + 60000, new Date(grant.expires_at).getTime()),
      ).toISOString();
    const rows = (
      await db.query(`${OFFER_SELECT} WHERE r.provider=ANY($1::text[]) ORDER BY r.provider`, [
        grant.allowed_providers,
      ])
    ).rows;
    const items: TokenQuote[] = [];
    for (const row of rows) {
      try {
        await assertRoute(ctx, row, grant.source_mode);
      } catch {
        continue;
      }
      const native = runtime(ctx).routes.get(row.provider as InferenceProvider)!;
      if (
        !offeringOpen(row, now) ||
        input.inputTokens < minimumInputReservation(native) ||
        input.outputTokens < (native.minimumOutputTokens ?? 1) ||
        native.validUntil < new Date(grant.expires_at).getTime() ||
        !hasCapacity(row, input.inputTokens, input.outputTokens)
      )
        continue;
      const price = packPrice(row, input.inputTokens, input.outputTokens, true);
      if (price.priceCents > 100_000_000) continue;
      const payload = {
        buyerId: actor.id,
        grantId,
        provider: row.provider,
        inputTokens: input.inputTokens,
        outputTokens: input.outputTokens,
        priceCents: price.priceCents,
        revision: row.revision,
        fingerprint: row.fingerprint,
        expiresAt,
      };
      items.push({
        ...price,
        quoteId: signQuote(ctx, payload),
        grantId,
        provider: row.provider,
        modelId: INFERENCE_MODEL_ID,
        inputTokens: input.inputTokens,
        outputTokens: input.outputTokens,
        expiresAt,
        mode: grant.source_mode,
      });
    }
    return {
      items: items.sort(
        (a, b) => a.priceCents - b.priceCents || a.provider.localeCompare(b.provider),
      ),
    };
  });
}
/** Shared by auction awards and instant purchases. Grant/order/routes are already locked. */
async function purchase(db: PoolClient, grant: Row, order: Row, route: Row, bid: Row) {
  const price = bid.price_cents;
  if (price < MIN_ORDER_PRICE_CENTS)
    failure(409, 'quote_stale', 'The minimum order price is $0.01. Request a new quote.');
  await db.query(
    `UPDATE broker_inference_grants SET held_cents=held_cents-$2,available_cents=available_cents+$2-$3,spent_cents=spent_cents+$3 WHERE id=$1`,
    [grant.id, order.max_total_cents, price],
  );
  await applyCreditEntry(db, grant.buyer_id, {
    operationKey: `token-purchase:${order.id}`,
    kind: 'token_purchase',
    grantId: grant.id,
    balanceDeltaCents: -price,
    reservedDeltaCents: -price,
    description: 'Prepaid input/output token pack',
  });
  if (new Date(grant.expires_at) <= (await clock(db)))
    failure(
      409,
      'grant_closed',
      'The grant expired while its purchase was waiting for wallet credit.',
    );
  await db.query(
    `UPDATE broker_inference_routes SET outstanding_input=outstanding_input+$2,outstanding_output=outstanding_output+$3 WHERE provider=$1`,
    [route.provider, order.input_tokens, order.output_tokens],
  );
  const pack = (
    await db.query(
      `INSERT INTO broker_token_packs(order_id,grant_id,buyer_id,provider,source_mode,route_fingerprint,snapshot,input_tokens,output_tokens,available_input,available_output,price_cents,expires_at,provider_id)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$8,$9,$10,$11,$12) RETURNING *`,
      [
        order.id,
        grant.id,
        grant.buyer_id,
        route.provider,
        order.source_mode,
        route.fingerprint,
        bid.snapshot,
        order.input_tokens,
        order.output_tokens,
        price,
        grant.expires_at,
        route.provider_id,
      ],
    )
  ).rows[0];
  await db.query(
    `UPDATE broker_token_orders SET status='awarded',price_cents=$2,provider=$3 WHERE id=$1`,
    [order.id, price, route.provider],
  );
  await db.query(
    `UPDATE broker_token_bids SET status=CASE WHEN id=$2 THEN 'won' ELSE 'lost' END WHERE order_id=$1`,
    [order.id, bid.id],
  );
  await event(db, grant.id, `purchase:${order.id}`, 'pack_purchased', pack.id, grant.buyer_id, {
    priceCents: price,
    inputTokens: order.input_tokens,
    outputTokens: order.output_tokens,
  });
  return pack;
}
export async function createTokenOrder(
  ctx: AppContext,
  actor: Actor,
  raw: unknown,
  buying?: { decisionId: string; automatic: boolean },
  studio?: StudioSource,
) {
  const input = createOrderSchema.parse(raw),
    grantId = grantIdFor(actor, input.grantId),
    digest = operationFingerprint(input);
  return transaction(ctx.pool, async (db) => {
    await authority(db, actor, 'tokens:buy');
    const grant = await lockedGrant(db, actor, grantId);
    if (studio) await studioAuthority(db, studio, actor);
    if (!(await studioGrantOpen(db, grantId)))
      failure(409, 'task_stopped', 'This Studio task no longer authorizes purchases.');
    const prior = (
      await db.query(
        `SELECT o.*,p.id pack_id FROM broker_token_orders o LEFT JOIN broker_token_packs p ON p.order_id=o.id WHERE o.grant_id=$1 AND o.operation_key=$2`,
        [grantId, input.operationKey],
      )
    ).rows[0];
    if (prior) {
      if (prior.input_fingerprint !== digest)
        failure(
          409,
          'operation_conflict',
          'This operation key belongs to a different token purchase.',
        );
      if (studio)
        await db.query('UPDATE broker_studio_tasks SET model_order_id=$2 WHERE id=$1', [
          studio.id,
          prior.id,
        ]);
      return orderView(prior);
    }
    const now = await clock(db);
    if (
      grant.status !== 'active' ||
      new Date(grant.expires_at).getTime() <= now.getTime() + (input.mode === 'auction' ? 30000 : 0)
    )
      failure(409, 'grant_closed', 'The grant cannot cover this purchase deadline.');
    activeMode(ctx, grant);
    if (
      input.maxTotalCents > grant.max_purchase_cents ||
      input.maxTotalCents > Number(grant.available_cents)
    )
      failure(
        409,
        'budget_exceeded',
        'The purchase ceiling exceeds the available grant budget or per-purchase limit.',
      );
    if (buying)
      await admitBuyingDecision(db, actor, grant, input, buying.decisionId, buying.automatic);
    const bounds = (
      await db.query(
        `SELECT
      (SELECT count(*) FROM (SELECT 1 FROM broker_token_orders WHERE grant_id=$1 AND status='open' LIMIT 5) x)::int pending,
      (SELECT count(*) FROM (SELECT 1 FROM broker_token_packs WHERE grant_id=$1 AND status<>'settled' LIMIT 10) x)::int packs,
          (SELECT count(*) FROM (SELECT 1 FROM broker_token_orders WHERE grant_id=$1 AND created_at>$2::timestamptz-interval '1 minute' LIMIT 5) x)::int recent`,
        [grantId, now],
      )
    ).rows[0];
    if (bounds.pending >= 5 || bounds.packs >= 10 || bounds.recent >= 5)
      failure(
        429,
        'purchase_limit',
        'The grant reached its pending orders, active packs, or purchase rate limit.',
      );
    const rows = (
      await db.query(
        `${OFFER_SELECT} WHERE r.provider=ANY($1::text[]) ORDER BY r.provider FOR UPDATE OF r,o`,
        [grant.allowed_providers],
      )
    ).rows;
    let accountingCompatible = false;
    for (const row of rows) {
      try {
        await assertRoute(ctx, row, grant.source_mode);
      } catch {
        continue;
      }
      const native = runtime(ctx).routes.get(row.provider as InferenceProvider)!;
      if (
        input.inputTokens >= minimumInputReservation(native) &&
        input.outputTokens >= (native.minimumOutputTokens ?? 1) &&
        native.validUntil >= new Date(grant.expires_at).getTime()
      )
        accountingCompatible = true;
    }
    if (!accountingCompatible)
      failure(
        409,
        'route_unavailable',
        'No qualified route can supply a usable pack through this grant’s expiry. Check its minimum input/output reservations and qualification.',
      );
    let quote: Row | undefined;
    if (input.mode === 'instant') {
      if (!grant.allow_instant || !input.quoteId)
        failure(
          400,
          'quote_required',
          'Instant purchases require owner permission and a current quote.',
        );
      quote = verifyQuote(ctx, input.quoteId);
      if (
        quote.buyerId !== actor.id ||
        quote.grantId !== grantId ||
        quote.inputTokens !== input.inputTokens ||
        quote.outputTokens !== input.outputTokens ||
        Date.parse(quote.expiresAt) <= (await clock(db)).getTime()
      )
        failure(409, 'quote_expired', 'The quote expired or does not match this purchase.');
    } else if (input.quoteId)
      failure(400, 'invalid_request', 'An auction cannot include an instant quote.');
    const eligible: { row: Row; price: number }[] = [];
    for (const row of rows) {
      try {
        await assertRoute(ctx, row, grant.source_mode);
      } catch {
        continue;
      }
      const native = runtime(ctx).routes.get(row.provider as InferenceProvider)!;
      if (
        !offeringOpen(row, now) ||
        input.inputTokens < minimumInputReservation(native) ||
        input.outputTokens < (native.minimumOutputTokens ?? 1) ||
        native.validUntil < new Date(grant.expires_at).getTime() ||
        !hasCapacity(row, input.inputTokens, input.outputTokens)
      )
        continue;
      const price = packPrice(
        row,
        input.inputTokens,
        input.outputTokens,
        input.mode === 'instant',
      ).priceCents;
      if (price > input.maxTotalCents) continue;
      if (
        quote &&
        (row.provider !== quote.provider ||
          row.revision !== quote.revision ||
          row.fingerprint !== quote.fingerprint ||
          price !== quote.priceCents)
      )
        continue;
      if (!quote && !row.auto_bid) continue;
      eligible.push({ row, price });
    }
    if (quote && !eligible.length)
      failure(
        409,
        'quote_unavailable',
        'The quoted route, supply or price changed. Request another quote.',
      );
    // Re-read the DB clock after lock waits; never extend a previously published deadline.
    const admitted = await clock(db);
    if (
      new Date(grant.expires_at).getTime() <=
      admitted.getTime() + (input.mode === 'auction' ? 30000 : 0)
    )
      failure(409, 'grant_closed', 'The grant expires before the purchase can complete.');
    const order = (
      await db.query(
        `INSERT INTO broker_token_orders(grant_id,buyer_id,source_key_id,operation_key,input_fingerprint,mode,source_mode,input_tokens,output_tokens,max_total_cents,closes_at,expires_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
        [
          grantId,
          actor.id,
          actor.apiKey?.id ?? null,
          input.operationKey,
          digest,
          input.mode,
          grant.source_mode,
          input.inputTokens,
          input.outputTokens,
          input.maxTotalCents,
          new Date(admitted.getTime() + (input.mode === 'auction' ? 30000 : 0)),
          grant.expires_at,
        ],
      )
    ).rows[0];
    if (studio)
      await db.query('UPDATE broker_studio_tasks SET model_order_id=$2 WHERE id=$1', [
        studio.id,
        order.id,
      ]);
    if (buying)
      await db.query(
        "UPDATE broker_inference_buying_decisions SET status='ordered',order_id=$2 WHERE id=$1",
        [buying.decisionId, order.id],
      );
    await db.query(
      'UPDATE broker_inference_grants SET available_cents=available_cents-$2,held_cents=held_cents+$2 WHERE id=$1',
      [grantId, input.maxTotalCents],
    );
    const bids: { row: Row; bid: Row }[] = [];
    for (const { row, price } of eligible) {
      const bid = (
        await db.query(
          `INSERT INTO broker_token_bids(order_id,provider,price_cents,snapshot) VALUES($1,$2,$3,$4) RETURNING *`,
          [order.id, row.provider, price, snapshot(row, runtime(ctx).routes.get(row.provider)!)],
        )
      ).rows[0];
      bids.push({ row, bid });
    }
    await event(db, grantId, `order:${order.id}`, 'purchase_hold', order.id, actor.id, {
      amountCents: input.maxTotalCents,
    });
    if (input.mode === 'instant') {
      const selected = bids[0];
      const pack = await purchase(db, grant, order, selected.row, selected.bid);
      return orderView({
        ...order,
        status: 'awarded',
        price_cents: selected.bid.price_cents,
        provider: selected.row.provider,
        pack_id: pack.id,
      });
    }
    await enqueue(ctx, db, TOKEN_CLOSE_QUEUE, { id: order.id }, 30);
    return orderView(order);
  });
}
async function releaseOrder(db: PoolClient, grant: Row, order: Row, status: string) {
  if (order.status !== 'open') return;
  await db.query(
    'UPDATE broker_inference_grants SET held_cents=held_cents-$2,available_cents=available_cents+$2 WHERE id=$1',
    [grant.id, order.max_total_cents],
  );
  await db.query('UPDATE broker_token_orders SET status=$2 WHERE id=$1', [order.id, status]);
  await db.query("UPDATE broker_token_bids SET status='lost' WHERE order_id=$1", [order.id]);
  await event(db, grant.id, `release:${order.id}`, 'purchase_hold_released', order.id, undefined, {
    reason: status,
  });
}
export async function closeTokenAuction(ctx: AppContext, id: string) {
  const meta = (
    await ctx.pool.query(
      "SELECT buyer_id,grant_id,source_key_id FROM broker_token_orders WHERE id=$1 AND status='open'",
      [id],
    )
  ).rows[0];
  if (!meta) return;
  await transaction(ctx.pool, async (db) => {
    const owner = (await db.query('SELECT role FROM "user" WHERE id=$1 FOR SHARE', [meta.buyer_id]))
      .rows[0];
    const key = meta.source_key_id
      ? (
          await db.query('SELECT * FROM broker_api_keys WHERE id=$1 FOR SHARE', [
            meta.source_key_id,
          ])
        ).rows[0]
      : null;
    const grant = (
      await db.query('SELECT * FROM broker_inference_grants WHERE id=$1 FOR UPDATE', [
        meta.grant_id,
      ])
    ).rows[0];
    const order = (await db.query('SELECT * FROM broker_token_orders WHERE id=$1 FOR UPDATE', [id]))
      .rows[0];
    if (!order || order.status !== 'open') return;
    const now = await clock(db);
    if (new Date(order.closes_at) > now) return;
    if (
      owner?.role !== 'buyer' ||
      !(await studioGrantOpen(db, grant.id)) ||
      grant.status !== 'active' ||
      new Date(grant.expires_at) <= now ||
      (meta.source_key_id &&
        (!key ||
          key.revoked_at ||
          new Date(key.expires_at) <= now ||
          key.grant_id !== grant.id ||
          !key.scopes.includes('tokens:buy')))
    ) {
      await releaseOrder(db, grant, order, 'cancelled');
      return;
    }
    const rows = (
      await db.query(
        `${OFFER_SELECT} WHERE r.provider=ANY($1::text[]) ORDER BY r.provider FOR UPDATE OF r,o`,
        [grant.allowed_providers],
      )
    ).rows;
    const bids = (
      await db.query(
        `SELECT * FROM broker_token_bids WHERE order_id=$1 AND status='offered' ORDER BY price_cents,created_at,id LIMIT 2`,
        [id],
      )
    ).rows;
    const packs = (
      await db.query(
        "SELECT count(*)::int n FROM (SELECT 1 FROM broker_token_packs WHERE grant_id=$1 AND status<>'settled' LIMIT 10) p",
        [grant.id],
      )
    ).rows[0].n;
    for (const bid of bids) {
      const row = rows.find((r) => r.provider === bid.provider);
      if (
        bid.price_cents < MIN_ORDER_PRICE_CENTS ||
        !row ||
        !offeringOpen(row, now) ||
        !row.auto_bid ||
        row.fingerprint !== bid.snapshot.fingerprint ||
        row.revision !== bid.snapshot.revision ||
        packs >= 10 ||
        !hasCapacity(row, order.input_tokens, order.output_tokens) ||
        !grant.allowed_providers.includes(row.provider)
      )
        continue;
      try {
        await assertRoute(ctx, row, grant.source_mode);
      } catch {
        continue;
      }
      const native = runtime(ctx).routes.get(row.provider as InferenceProvider)!;
      if (
        order.input_tokens < minimumInputReservation(native) ||
        order.output_tokens < (native.minimumOutputTokens ?? 1) ||
        native.validUntil < new Date(grant.expires_at).getTime()
      )
        continue;
      if (bid.price_cents < packPrice(row, order.input_tokens, order.output_tokens).costFloorCents)
        continue;
      if (new Date(grant.expires_at) <= (await clock(db))) break;
      await purchase(db, grant, order, row, bid);
      return;
    }
    await releaseOrder(db, grant, order, 'no_offers');
  });
}
export async function cancelTokenOrder(ctx: AppContext, actor: Actor, id: string, raw: unknown) {
  const input = z.object({ operationKey: operationSchema }).strict().parse(raw);
  const meta = (
    await ctx.pool.query('SELECT grant_id FROM broker_token_orders WHERE id=$1 AND buyer_id=$2', [
      id,
      actor.id,
    ])
  ).rows[0];
  if (!meta) failure(404, 'not_found', 'Token order not found.');
  return transaction(ctx.pool, async (db) => {
    await authority(db, actor, 'tokens:buy');
    const grant = await lockedGrant(db, actor, meta.grant_id);
    return withOperation(
      db,
      actor,
      `token.order.cancel:${id}`,
      input.operationKey,
      input,
      async () => {
        const order = (
          await db.query('SELECT * FROM broker_token_orders WHERE id=$1 FOR UPDATE', [id])
        ).rows[0];
        if (order.status === 'awarded')
          failure(409, 'prepaid_nonrefundable', 'An awarded prepaid pack cannot be cancelled.');
        if (order.status === 'open' && new Date(order.closes_at) <= (await clock(db)))
          failure(
            409,
            'auction_closed',
            'The auction deadline has passed. Reopen its order to see the result.',
          );
        await releaseOrder(db, grant, order, 'cancelled');
        return orderView({
          ...order,
          status: order.status === 'open' ? 'cancelled' : order.status,
        });
      },
    );
  });
}
export async function tokenOrderDetail(ctx: AppContext, actor: Actor, id: string) {
  const meta = (
    await ctx.pool.query('SELECT grant_id FROM broker_token_orders WHERE id=$1 AND buyer_id=$2', [
      id,
      actor.id,
    ])
  ).rows[0];
  if (!meta) failure(404, 'not_found', 'Token order not found.');
  return transaction(ctx.pool, async (db) => {
    await authority(db, actor, 'inference:read');
    const grant = await lockedGrant(db, actor, meta.grant_id);
    const order = (await db.query('SELECT * FROM broker_token_orders WHERE id=$1', [id])).rows[0];
    const bids = (
      await db.query(
        'SELECT * FROM broker_token_bids WHERE order_id=$1 ORDER BY price_cents,created_at,id LIMIT 2',
        [id],
      )
    ).rows;
    const pack = (await db.query('SELECT * FROM broker_token_packs WHERE order_id=$1', [id]))
      .rows[0];
    return {
      order: orderView({ ...order, pack_id: pack?.id }),
      bids: bids.map(bidView),
      pack: pack ? packView(pack) : null,
      grant: grantView(grant),
    };
  });
}
/** Grant is locked before ordered routes and packs. Holds survive retirement until resolved. */
export async function retirePackLocked(
  db: PoolClient,
  pack: Row,
  reason: string,
  evidence?: string,
) {
  if (pack.status === 'settled') return;
  if (pack.status === 'active') {
    await db.query(
      `UPDATE broker_inference_routes SET outstanding_input=outstanding_input-$2,outstanding_output=outstanding_output-$3 WHERE provider=$1`,
      [pack.provider, pack.available_input, pack.available_output],
    );
    await db.query(
      `UPDATE broker_token_packs SET retired_input=retired_input+available_input,retired_output=retired_output+available_output,
      available_input=0,available_output=0,status='retiring',retirement_reason=$2,refund_evidence=$3 WHERE id=$1`,
      [pack.id, reason, evidence ?? null],
    );
    pack = {
      ...pack,
      status: 'retiring',
      retirement_reason: reason,
      refund_evidence: evidence ?? null,
      retired_input: Number(pack.retired_input) + Number(pack.available_input),
      retired_output: Number(pack.retired_output) + Number(pack.available_output),
      available_input: 0,
      available_output: 0,
    };
  }
  if (Number(pack.held_input) || Number(pack.held_output)) return;
  if (pack.retirement_reason === 'provider_failure' && pack.refund_evidence) {
    const s = pack.snapshot;
    const issuedValue =
      BigInt(pack.input_tokens) * BigInt(s.inputRate) +
      BigInt(pack.output_tokens) * BigInt(s.outputRate);
    const unusedValue =
      BigInt(pack.retired_input) * BigInt(s.inputRate) +
      BigInt(pack.retired_output) * BigInt(s.outputRate);
    const refund =
      s.currencyDecimals === 4
        ? centsFromUnits((moneyUnits(pack.price_cents) * unusedValue) / issuedValue)
        : Number((BigInt(pack.price_cents) * unusedValue) / issuedValue);
    if (refund > 0) {
      const grant = (
        await db.query('SELECT * FROM broker_inference_grants WHERE id=$1', [pack.grant_id])
      ).rows[0];
      const active = grant.status === 'active' && new Date(grant.expires_at) > (await clock(db));
      await applyCreditEntry(db, pack.buyer_id, {
        operationKey: `token-refund:${pack.id}`,
        kind: 'token_refund',
        grantId: pack.grant_id,
        balanceDeltaCents: refund,
        reservedDeltaCents: active ? refund : 0,
        description: 'Verified provider failure: unused prepaid quota',
      });
      await db.query(
        `UPDATE broker_inference_grants SET spent_cents=spent_cents-$2,${active ? 'available_cents=available_cents+$2' : 'returned_cents=returned_cents+$2'} WHERE id=$1`,
        [pack.grant_id, refund],
      );
      await db.query('UPDATE broker_token_packs SET refund_cents=$2 WHERE id=$1', [
        pack.id,
        refund,
      ]);
      await event(db, pack.grant_id, `refund:${pack.id}`, 'pack_refunded', pack.id, undefined, {
        refundCents: refund,
        evidence: pack.refund_evidence,
      });
    }
  }
  await db.query("UPDATE broker_token_packs SET status='settled' WHERE id=$1", [pack.id]);
}
export async function closeGrantLocked(db: PoolClient, grant: Row, reason: string) {
  if (grant.status === 'closed') return;
  await db.query('UPDATE broker_inference_buying_policies SET paused=true WHERE grant_id=$1', [
    grant.id,
  ]);
  await db.query(
    `UPDATE broker_inference_buying_decisions SET status='superseded',reason='The grant was closed or expired.' WHERE grant_id=$1 AND status IN('evaluating','recommended')`,
    [grant.id],
  );
  const orders = (
    await db.query(
      "SELECT * FROM broker_token_orders WHERE grant_id=$1 AND status='open' ORDER BY id FOR UPDATE",
      [grant.id],
    )
  ).rows;
  for (const order of orders)
    await releaseOrder(db, grant, order, reason === 'expired' ? 'expired' : 'cancelled');
  await db.query('SELECT provider FROM broker_inference_routes ORDER BY provider FOR UPDATE');
  const packs = (
    await db.query(
      "SELECT * FROM broker_token_packs WHERE grant_id=$1 AND status<>'settled' ORDER BY id FOR UPDATE",
      [grant.id],
    )
  ).rows;
  for (const pack of packs) await retirePackLocked(db, pack, reason);
  const state = (await db.query('SELECT * FROM broker_inference_grants WHERE id=$1', [grant.id]))
    .rows[0];
  const amount = Number(state.available_cents);
  if (amount)
    await applyCreditEntry(db, grant.buyer_id, {
      operationKey: `agent-release:${grant.id}`,
      kind: 'agent_release',
      grantId: grant.id,
      balanceDeltaCents: 0,
      reservedDeltaCents: -amount,
      description: 'Return unspent agent grant funding',
    });
  const held = (
    await db.query(
      "SELECT 1 FROM broker_inference_requests WHERE grant_id=$1 AND status NOT IN('settled','rejected') LIMIT 1",
      [grant.id],
    )
  ).rowCount;
  await db.query(
    'UPDATE broker_inference_grants SET available_cents=0,returned_cents=returned_cents+$2,status=$3 WHERE id=$1',
    [grant.id, amount, held || Number(state.held_cents) > 0 ? 'closing' : 'closed'],
  );
}
export async function providerOffering(ctx: AppContext, actor: Actor) {
  runtime(ctx);
  const row = (
    await ctx.pool.query(
      `${OFFER_SELECT} JOIN broker_providers p ON p.id=r.provider_id WHERE p.user_id=$1`,
      [actor.id],
    )
  ).rows[0];
  return row ? offeringView(ctx, row) : null;
}
export async function updateOffering(ctx: AppContext, actor: Actor, raw: unknown) {
  const input = z
    .object({
      operationKey: operationSchema,
      expectedRevision: integer(2_000_000_000),
      active: z.boolean(),
      autoBid: z.boolean(),
      inputRateMicrosPerMillion: integer(1_000_000_000_000, 100).multipleOf(100),
      outputRateMicrosPerMillion: integer(1_000_000_000_000, 100).multipleOf(100),
      instantMarkupBps: integer(100_000, 0),
      minimumPriceCents: moneyAmount(100_000_000, MIN_ORDER_PRICE_CENTS),
      maxOutstandingInputTokens: integer(100_000_000),
      maxOutstandingOutputTokens: integer(10_000_000),
      salesStartAt: z.string().datetime().nullable().optional(),
      salesEndAt: z.string().datetime().nullable().optional(),
    })
    .strict()
    .parse(raw);
  runtime(ctx);
  return transaction(ctx.pool, async (db) => {
    await authority(db, actor, 'provider:offerings:write');
    return withOperation(
      db,
      actor,
      'inference.offering.update',
      input.operationKey,
      input,
      async () => {
        const row = (
          await db.query(
            `${OFFER_SELECT} JOIN broker_providers p ON p.id=r.provider_id WHERE p.user_id=$1 FOR UPDATE OF r,o`,
            [actor.id],
          )
        ).rows[0];
        if (!row) failure(403, 'provider_unavailable', 'This account has no inference route.');
        if (row.revision !== input.expectedRevision)
          failure(409, 'revision_conflict', 'The offering changed. Reload before saving.');
        if (
          Number(row.outstanding_input) > input.maxOutstandingInputTokens ||
          Number(row.outstanding_output) > input.maxOutstandingOutputTokens
        )
          failure(
            409,
            'commitments_exceed_capacity',
            'Capacity cannot be reduced below outstanding prepaid commitments.',
          );
        const salesStart =
          input.salesStartAt === undefined ? row.sales_start_at : input.salesStartAt;
        const salesEnd = input.salesEndAt === undefined ? row.sales_end_at : input.salesEndAt;
        if (
          Boolean(salesStart) !== Boolean(salesEnd) ||
          (salesStart && new Date(salesStart) >= new Date(salesEnd))
        )
          failure(
            400,
            'invalid_sales_window',
            'Provide a start and later end, or clear both selling times.',
          );
        await db.query(
          `UPDATE broker_token_offerings SET active=$2,auto_bid=$3,input_rate=$4,output_rate=$5,instant_markup_bps=$6,
        minimum_price_cents=$7,max_outstanding_input=$8,max_outstanding_output=$9,sales_start_at=$10,sales_end_at=$11,revision=revision+1,updated_at=clock_timestamp() WHERE provider=$1`,
          [
            row.provider,
            input.active,
            input.autoBid,
            input.inputRateMicrosPerMillion,
            input.outputRateMicrosPerMillion,
            input.instantMarkupBps,
            input.minimumPriceCents,
            input.maxOutstandingInputTokens,
            input.maxOutstandingOutputTokens,
            salesStart,
            salesEnd,
          ],
        );
        return offeringView(
          ctx,
          (await db.query(`${OFFER_SELECT} WHERE r.provider=$1`, [row.provider])).rows[0],
        );
      },
    );
  });
}
