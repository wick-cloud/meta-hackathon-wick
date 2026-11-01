import type { Pool, PoolClient } from 'pg';
import type { StudioUsage, UsageForecast } from '../../shared/studio-usage.js';
import type { AppContext } from '../context.js';
import { HttpError } from '../context.js';
import type { Row } from '../marketplace/data.js';
import {
  forecastUsage,
  sizeUsagePurchase,
  usageFeatures,
  MAX_TRAINING_SAMPLES,
  USAGE_ESTIMATOR_VERSION,
} from './usage-estimator.js';

type Db = Pool | PoolClient;
class UsageHistoryBoundsError extends HttpError {
  constructor() {
    super(409, 'Task usage exceeds the automatic estimator accounting bounds. Review is required.');
  }
}
/** Indexed grant reads; fail closed rather than silently computing from truncated history. */
export async function taskUsage(db: Db, t: Row) {
  const results = await Promise.all([
    db.query(
      `SELECT status,input_tokens,output_tokens,source_task_id,source_job_id FROM broker_inference_requests
       WHERE grant_id=$1 AND buyer_id=$2 ORDER BY created_at DESC,id DESC LIMIT 81`,
      [t.grant_id, t.buyer_id],
    ),
    db.query(
      `SELECT input_tokens,output_tokens FROM broker_token_packs
       WHERE grant_id=$1 AND buyer_id=$2 ORDER BY created_at DESC,id DESC LIMIT 43`,
      [t.grant_id, t.buyer_id],
    ),
  ]);
  if (results[0].rows.length > 80 || results[1].rows.length > 42)
    throw new UsageHistoryBoundsError();
  const receipts = results[0].rows,
    packs = results[1].rows;
  return {
    input: receipts.reduce((n, r) => n + (r.status === 'settled' ? Number(r.input_tokens) : 0), 0),
    output: receipts.reduce(
      (n, r) => n + (r.status === 'settled' ? Number(r.output_tokens) : 0),
      0,
    ),
    calls: receipts.filter((r) => r.status === 'settled').length,
    unresolved: receipts.filter((r) => !['settled', 'rejected'].includes(r.status)).length,
    foreign: receipts.some(
      (r) =>
        !(r.source_task_id === t.id || (t.coding_job_id && r.source_job_id === t.coding_job_id)),
    ),
    purchasedInput: packs.reduce((n, r) => n + Number(r.input_tokens), 0),
    purchasedOutput: packs.reduce((n, r) => n + Number(r.output_tokens), 0),
  };
}
export const TRAINING_SELECT = `SELECT features,input_tokens,output_tokens,model_calls
 FROM broker_studio_usage_samples WHERE buyer_id=$1 AND source_mode=$2 AND model_output=$3 AND estimator_version=$4
 ORDER BY completed_at DESC,task_id DESC LIMIT $5`;
export async function ensureUsageEstimate(ctx: AppContext, t: Row, inputFloor: number) {
  const existing = (
    await ctx.pool.query(
      'SELECT * FROM broker_studio_usage_estimates WHERE task_id=$1 AND purchase_round=$2',
      [t.id, t.purchase_round],
    )
  ).rows[0];
  if (existing) return existing;
  const features = t.usage_features ?? usageFeatures(t.goal);
  const [history, progress] = await Promise.all([
    ctx.pool.query(TRAINING_SELECT, [
      t.buyer_id,
      t.source_mode,
      t.model_output,
      USAGE_ESTIMATOR_VERSION,
      MAX_TRAINING_SAMPLES,
    ]),
    taskUsage(ctx.pool, t),
  ]);
  // Unknown usage must be reconciled, never replaced by another speculative purchase.
  if (progress.unresolved)
    throw new HttpError(
      409,
      'Model usage needs reconciliation before estimating another purchase.',
    );
  const forecast = forecastUsage(
    features,
    history.rows.reverse().map((r) => ({
      features: r.features,
      input: Number(r.input_tokens),
      output: Number(r.output_tokens),
      calls: Number(r.model_calls),
    })),
  );
  // New packs leave room for a useful coding response; existing residual quota
  // may still serve a smaller call through the gateway's hard native cap.
  const outputFloor = Math.min(t.model_output, 1024);
  const sized = sizeUsagePurchase(forecast, progress, inputFloor, outputFloor, t.purchase_round);
  const inserted = (
    await ctx.pool.query(
      `INSERT INTO broker_studio_usage_estimates(task_id,purchase_round,forecast,input_tokens,output_tokens,input_floor,output_floor,reservation_limited)
     SELECT id,$3,$4,$5,$6,$7,$8,$9 FROM broker_studio_tasks WHERE id=$1 AND lease_token=$2 AND lease_until>clock_timestamp()
     ON CONFLICT(task_id,purchase_round) DO NOTHING RETURNING *`,
      [
        t.id,
        t.lease_token,
        t.purchase_round,
        JSON.stringify(forecast),
        sized.inputTokens,
        sized.outputTokens,
        inputFloor,
        outputFloor,
        sized.reservationLimited,
      ],
    )
  ).rows[0];
  if (inserted) return inserted;
  const replay = (
    await ctx.pool.query(
      'SELECT * FROM broker_studio_usage_estimates WHERE task_id=$1 AND purchase_round=$2',
      [t.id, t.purchase_round],
    )
  ).rows[0];
  if (!replay) throw new HttpError(409, 'Task estimate lease expired.');
  return replay;
}
export async function studioUsage(db: Db, t: Row): Promise<StudioUsage | null> {
  const estimate = (
    await db.query(
      'SELECT * FROM broker_studio_usage_estimates WHERE task_id=$1 ORDER BY purchase_round DESC LIMIT 1',
      [t.id],
    )
  ).rows[0];
  if (!estimate) return null;
  const totals = await taskUsage(db, t);
  return {
    forecast: estimate.forecast as UsageForecast,
    purchaseRound: estimate.purchase_round,
    purchaseInput: estimate.input_tokens,
    purchaseOutput: estimate.output_tokens,
    inputReservationFloor: estimate.input_floor,
    outputReservationFloor: estimate.output_floor,
    reservationLimited: estimate.reservation_limited,
    settledInput: totals.input,
    settledOutput: totals.output,
    purchasedInput: totals.purchasedInput,
    purchasedOutput: totals.purchasedOutput,
    unresolvedCalls: totals.unresolved,
  };
}
/** Called with the task locked, after grant closure, in the same completion transaction. */
export async function recordUsageSample(db: PoolClient, t: Row) {
  if (t.outcome !== 'completed' || !t.usage_features) return;
  const u = await taskUsage(db, t).catch((error) => {
    // A training-ineligible history must not prevent confirmed cleanup completing.
    if (error instanceof UsageHistoryBoundsError) return null;
    throw error;
  });
  if (!u) return;
  if (u.unresolved || u.foreign || u.calls < 2 || u.input <= 0 || u.output <= 0) return;
  await db.query(
    `INSERT INTO broker_studio_usage_samples(task_id,buyer_id,source_mode,model_output,estimator_version,features,input_tokens,output_tokens,model_calls,completed_at)
     SELECT $1,$2,$3,$4,COALESCE(e.forecast->>'version',$5),$6,$7,$8,$9,clock_timestamp()
     FROM broker_studio_usage_estimates e WHERE e.task_id=$1 AND e.purchase_round=0
     ON CONFLICT(task_id) DO NOTHING`,
    [
      t.id,
      t.buyer_id,
      t.source_mode,
      t.model_output,
      USAGE_ESTIMATOR_VERSION,
      JSON.stringify(t.usage_features),
      u.input,
      u.output,
      u.calls,
    ],
  );
}
