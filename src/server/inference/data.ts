import { z } from 'zod';
import type { Pool, PoolClient } from 'pg';
import type { Actor } from '../../shared/types.js';
import {
  INFERENCE_MODEL_ID,
  INFERENCE_MODEL_NAME,
  INFERENCE_CONTRACT,
  type InferenceCatalog,
  type InferenceGrant,
  type InferenceReceipt,
  type TokenOrder,
  type TokenPack,
  type TokenOffering,
  type TokenBid,
  type InferenceProvider,
} from '../../shared/inference.js';
import { revenueShare } from '../../shared/pricing.js';
import { HttpError, type AppContext } from '../context.js';
import { routeView } from './runtime.js';
import type { InferenceRuntime } from './runtime.js';
import { iso, type Row } from '../marketplace/data.js';
import { isMoneyCents, subtractCents } from '../../shared/money.js';

export type Db = Pool | PoolClient;
export const operationSchema = z.string().regex(/^[-A-Za-z0-9_:./]{8,160}$/);
export const integer = (max: number, min = 1) => z.number().int().min(min).max(max);
export const moneyAmount = (max: number, min = 0.01) =>
  z.number().min(min).max(max).refine(isMoneyCents, 'Use at most four decimal places in USD.');
export function failure(status: number, code: string, message: string): never {
  throw Object.assign(new HttpError(status, message), { code });
}
export function runtime(ctx: AppContext): InferenceRuntime {
  if (!ctx.inference?.enabled)
    failure(409, 'inference_disabled', 'The token marketplace is disabled.');
  return ctx.inference;
}
export async function clock(db: Db): Promise<Date> {
  return (await db.query('SELECT clock_timestamp() AS at')).rows[0].at;
}
/** Serializes against account changes, key revocation, and owner key rotation. */
export async function authority(db: PoolClient, actor: Actor, scope?: string): Promise<void> {
  const owner = (await db.query('SELECT role FROM "user" WHERE id=$1 FOR SHARE', [actor.id]))
    .rows[0];
  if (!owner || owner.role !== actor.role)
    failure(403, 'authority_changed', 'Account access has changed.');
  if (actor.apiKey) {
    const key = (
      await db.query('SELECT * FROM broker_api_keys WHERE id=$1 AND user_id=$2 FOR SHARE', [
        actor.apiKey.id,
        actor.id,
      ])
    ).rows[0];
    const now = await clock(db);
    if (
      !key ||
      key.revoked_at ||
      new Date(key.expires_at) <= now ||
      key.issued_role !== owner.role ||
      (key.grant_id ?? undefined) !== actor.apiKey.grantId ||
      (key.pack_id ?? undefined) !== actor.apiKey.packId ||
      (scope && !key.scopes.includes(scope))
    )
      failure(403, 'key_unavailable', 'The API key is revoked, expired, or lacks permission.');
    if (key.parent_key_id) {
      const parent = (
        await db.query('SELECT * FROM broker_api_keys WHERE id=$1 FOR SHARE', [key.parent_key_id])
      ).rows[0];
      if (
        !parent ||
        parent.user_id !== actor.id ||
        parent.pack_id ||
        parent.grant_id !== key.grant_id ||
        parent.revoked_at ||
        new Date(parent.expires_at) <= now ||
        parent.issued_role !== owner.role ||
        !parent.scopes.includes('tokens:buy')
      )
        failure(403, 'key_unavailable', 'The batch key’s issuing agent key is no longer active.');
    }
  }
}
export async function lockedGrant(
  db: PoolClient,
  actor: Actor,
  id: string,
  active = false,
): Promise<Row> {
  if (actor.apiKey && actor.apiKey.grantId !== id)
    failure(403, 'grant_scope', 'This API key can access only its funded grant.');
  const grant = (
    await db.query('SELECT * FROM broker_inference_grants WHERE id=$1 AND buyer_id=$2 FOR UPDATE', [
      id,
      actor.id,
    ])
  ).rows[0];
  if (!grant) failure(404, 'not_found', 'Agent grant not found.');
  if (active && (grant.status !== 'active' || new Date(grant.expires_at) <= (await clock(db))))
    failure(409, 'grant_closed', 'This grant has closed or expired.');
  return grant;
}
export function activeMode(ctx: AppContext, grant: Row): void {
  if (runtime(ctx).mode !== grant.source_mode)
    failure(409, 'mode_changed', 'The grant belongs to a different inference mode.');
}
export async function event(
  db: PoolClient,
  grantId: string,
  key: string,
  kind: string,
  resourceId: string,
  actorId?: string,
  details: object = {},
): Promise<void> {
  await db.query(
    `INSERT INTO broker_inference_events(grant_id,operation_key,kind,resource_id,actor_id,details)
    VALUES($1,$2,$3,$4,$5,$6)`,
    [grantId, key, kind, resourceId, actorId ?? null, details],
  );
}
export const grantView = (r: Row): InferenceGrant => ({
  id: r.id,
  name: r.name,
  status: r.status,
  mode: r.source_mode,
  fundedCents: Number(r.funded_cents),
  availableCents: Number(r.available_cents),
  heldCents: Number(r.held_cents),
  spentCents: Number(r.spent_cents),
  returnedCents: Number(r.returned_cents),
  maxPurchaseCents: r.max_purchase_cents,
  allowedProviders: r.allowed_providers,
  allowInstant: r.allow_instant,
  expiresAt: iso(r.expires_at)!,
  createdAt: iso(r.created_at)!,
  currency: 'USD',
});
export const orderView = (r: Row): TokenOrder => ({
  id: r.id,
  grantId: r.grant_id,
  mode: r.mode,
  sourceMode: r.source_mode,
  status: r.status,
  modelId: INFERENCE_MODEL_ID,
  inputTokens: Number(r.input_tokens),
  outputTokens: Number(r.output_tokens),
  maxTotalCents: r.max_total_cents,
  priceCents: r.price_cents,
  provider: r.provider,
  closesAt: iso(r.closes_at)!,
  expiresAt: iso(r.expires_at)!,
  createdAt: iso(r.created_at)!,
  packId: r.pack_id ?? null,
});
export const packView = (r: Row): TokenPack => ({
  id: r.id,
  orderId: r.order_id,
  grantId: r.grant_id,
  provider: r.provider,
  mode: r.source_mode,
  modelId: INFERENCE_MODEL_ID,
  status: r.status,
  inputTokens: Number(r.input_tokens),
  outputTokens: Number(r.output_tokens),
  availableInputTokens: Number(r.available_input),
  availableOutputTokens: Number(r.available_output),
  heldInputTokens: Number(r.held_input),
  heldOutputTokens: Number(r.held_output),
  consumedInputTokens: Number(r.consumed_input),
  consumedOutputTokens: Number(r.consumed_output),
  retiredInputTokens: Number(r.retired_input),
  retiredOutputTokens: Number(r.retired_output),
  priceCents: r.price_cents,
  refundCents: r.refund_cents,
  expiresAt: iso(r.expires_at)!,
  createdAt: iso(r.created_at)!,
  retirementReason: r.retirement_reason,
  revenueShare: revenueShare(subtractCents(r.price_cents, r.refund_cents)),
});
/** Public inventory projection; do not load private accounting snapshots for table rows. */
export const PACK_VIEW_COLUMNS = `id,order_id,grant_id,provider,source_mode,status,input_tokens,output_tokens,
available_input,available_output,held_input,held_output,consumed_input,consumed_output,retired_input,retired_output,
price_cents,refund_cents,expires_at,created_at,retirement_reason`;
export const receiptView = (r: Row): InferenceReceipt => ({
  id: r.id,
  grantId: r.grant_id,
  packId: r.pack_id,
  provider: r.provider,
  mode: r.source_mode,
  status: r.status,
  heldInputTokens: ['settled', 'rejected'].includes(r.status) ? 0 : r.reserved_input,
  heldOutputTokens: ['settled', 'rejected'].includes(r.status) ? 0 : r.reserved_output,
  inputTokens: r.input_tokens,
  outputTokens: r.output_tokens,
  failureCode: r.failure_code,
  createdAt: iso(r.created_at)!,
  completedAt: iso(r.completed_at),
});
export const bidView = (r: Row): TokenBid => ({
  id: r.id,
  provider: r.provider,
  priceCents: r.price_cents,
  status: r.status,
  mode: r.snapshot.sourceMode,
  createdAt: iso(r.created_at)!,
});
export async function catalog(ctx: AppContext, db: Db = ctx.pool): Promise<InferenceCatalog> {
  const rt = ctx.inference;
  const rows = (
    await db.query(
      'SELECT provider,quarantined_at,fingerprint,qualified,blocked_reason FROM broker_inference_routes',
    )
  ).rows;
  return {
    enabled: Boolean(rt?.enabled),
    mode: rt?.mode ?? 'fixture',
    models: [
      {
        id: INFERENCE_MODEL_ID,
        name: INFERENCE_MODEL_NAME,
        publisher: 'Meta',
        contract: INFERENCE_CONTRACT,
      },
    ],
    routes: rt
      ? [...rt.routes.values()].map((r) => {
          const row = rows.find((d) => d.provider === r.provider),
            view = routeView(r, Boolean(row?.quarantined_at));
          return {
            ...view,
            qualified:
              view.qualified && Boolean(row?.qualified) && row?.fingerprint === r.fingerprint,
            reason: row && !row.qualified ? row.blocked_reason : view.reason,
          };
        })
      : [],
  };
}
export function offeringView(ctx: AppContext, row: Row): TokenOffering {
  const route = runtime(ctx).routes.get(row.provider as InferenceProvider)!;
  return {
    provider: row.provider,
    revision: row.revision,
    active: row.active,
    autoBid: row.auto_bid,
    inputRateMicrosPerMillion: Number(row.input_rate),
    outputRateMicrosPerMillion: Number(row.output_rate),
    instantMarkupBps: row.instant_markup_bps,
    minimumPriceCents: row.minimum_price_cents,
    maxOutstandingInputTokens: Number(row.max_outstanding_input),
    maxOutstandingOutputTokens: Number(row.max_outstanding_output),
    outstandingInputTokens: Number(row.outstanding_input),
    outstandingOutputTokens: Number(row.outstanding_output),
    costInputRateMicrosPerMillion: Number(row.cost_input_rate),
    costOutputRateMicrosPerMillion: Number(row.cost_output_rate),
    providerCommissionBps: 1500,
    route: {
      ...routeView(route, Boolean(row.quarantined_at)),
      qualified:
        routeView(route, Boolean(row.quarantined_at)).qualified &&
        row.qualified &&
        row.fingerprint === route.fingerprint,
      reason: !row.qualified
        ? row.blocked_reason
        : routeView(route, Boolean(row.quarantined_at)).reason,
    },
  };
}
export async function assertRoute(ctx: AppContext, row: Row, mode: string): Promise<void> {
  const rt = runtime(ctx).routes.get(row.provider as InferenceProvider);
  if (
    !rt ||
    !routeView(rt, Boolean(row.quarantined_at)).qualified ||
    !row.qualified ||
    row.fingerprint !== rt.fingerprint ||
    row.source_mode !== mode
  )
    failure(
      409,
      'route_unavailable',
      'This inference route has not qualified for the current accounting contract.',
    );
}
