import type { PoolClient } from 'pg';
import type { Actor } from '../../shared/types.js';
import type { BuyingAllowance, BuyingDecision, BuyingPolicy } from '../../shared/buying.js';
import type { Row } from '../marketplace/data.js';
import { iso } from '../marketplace/data.js';
import { clock, failure } from './data.js';
import { MAX_API_BODY_BYTES } from '../http-limits.js';

// Fixture input counts bytes plus framing. The complete JSON body is always larger.
// Its minimum (20) is not an upper bound for a non-empty agent task.
export const FIXTURE_BUYING_INPUT_BOUND = MAX_API_BODY_BYTES;

export const policyView = (r: Row): BuyingPolicy => ({
  revision: r.revision,
  mode: r.mode,
  paused: r.paused,
  maxPurchaseCents: Number(r.max_purchase_cents),
  outputPerCall: r.output_per_call,
  targetCalls: r.target_calls,
  refillAtCalls: r.refill_at_calls,
  allowInstant: r.allow_instant,
  modelCalls: r.model_calls,
  lastEvaluatedAt: iso(r.last_evaluated_at),
  nextEvaluationAt: iso(r.next_evaluation_at)!,
});
export const decisionView = (r: Row): BuyingDecision => ({
  id: r.id,
  status: r.status,
  reason: r.reason,
  mode: r.source_mode,
  modelCalled: r.model_called,
  policyRevision: r.policy_revision,
  candidate: r.candidate,
  baseline: r.baseline,
  orderId: r.order_id,
  createdAt: iso(r.created_at)!,
  expiresAt: iso(r.expires_at)!,
});

/** At most ten unsettled packs per grant; never load its settled history. */
export async function allowance(
  db: PoolClient,
  grant: Row,
  outputPerCall = 512,
): Promise<BuyingAllowance> {
  const packs = (
    await db.query(
      `SELECT p.available_input,p.available_output,p.held_input,p.held_output,
    p.source_mode,p.status,p.expires_at,p.route_fingerprint,p.snapshot,r.fingerprint,r.qualified,r.quarantined_at,r.max_output_tokens
    FROM (SELECT * FROM broker_token_packs WHERE grant_id=$1 AND status<>'settled' ORDER BY id LIMIT 10) p
    JOIN broker_inference_routes r ON r.provider=p.provider`,
      [grant.id],
    )
  ).rows;
  const now = await clock(db);
  const result: BuyingAllowance = {
    availableInputTokens: 0,
    availableOutputTokens: 0,
    heldInputTokens: 0,
    heldOutputTokens: 0,
    eligibleCalls: 0,
    outputPerCall,
    unresolvedRequests: 0,
    pendingOrders: 0,
  };
  for (const p of packs) {
    result.heldInputTokens += Number(p.held_input);
    result.heldOutputTokens += Number(p.held_output);
    if (p.status !== 'active' || new Date(p.expires_at) <= now) continue;
    result.availableInputTokens += Number(p.available_input);
    result.availableOutputTokens += Number(p.available_output);
    const bound =
      p.source_mode === 'fixture'
        ? FIXTURE_BUYING_INPUT_BOUND
        : Number(p.snapshot.minimumInputReservation);
    if (
      p.qualified &&
      !p.quarantined_at &&
      p.route_fingerprint === p.fingerprint &&
      bound > 0 &&
      outputPerCall <= p.max_output_tokens
    )
      result.eligibleCalls += Math.min(
        Math.floor(Number(p.available_input) / bound),
        Math.floor(Number(p.available_output) / outputPerCall),
      );
  }
  const counts = (
    await db.query(
      `SELECT
    (SELECT count(*)::int FROM (SELECT 1 FROM broker_token_orders WHERE grant_id=$1 AND status='open' LIMIT 5) o) pending,
    (SELECT count(*)::int FROM (SELECT 1 FROM broker_inference_requests WHERE grant_id=$1 AND status IN('outcome_unknown','needs_reconciliation') LIMIT 2) r) unresolved`,
      [grant.id],
    )
  ).rows[0];
  result.pendingOrders = counts.pending;
  result.unresolvedRequests = counts.unresolved;
  return result;
}

/** Invoked inside the existing purchase transaction, after locking the grant. */
export async function admitBuyingDecision(
  db: PoolClient,
  actor: Actor,
  grant: Row,
  input: Row,
  decisionId: string,
  automatic: boolean,
) {
  if (actor.apiKey) failure(403, 'owner_required', 'Buying policies are managed by the owner.');
  const policy = (
    await db.query('SELECT * FROM broker_inference_buying_policies WHERE grant_id=$1 FOR UPDATE', [
      grant.id,
    ])
  ).rows[0];
  const decision = (
    await db.query(
      'SELECT * FROM broker_inference_buying_decisions WHERE id=$1 AND grant_id=$2 FOR UPDATE',
      [decisionId, grant.id],
    )
  ).rows[0];
  if (
    !policy ||
    !decision ||
    policy.paused ||
    policy.revision !== decision.policy_revision ||
    decision.status !== 'recommended' ||
    new Date(decision.expires_at) <= (await clock(db))
  )
    failure(
      409,
      'recommendation_changed',
      'The recommendation expired or its policy changed. Request a fresh recommendation.',
    );
  if (automatic && policy.mode !== 'automatic')
    failure(409, 'automatic_buying_disabled', 'Automatic purchasing is not enabled.');
  const candidate = decision.candidate;
  if (
    !candidate ||
    input.operationKey !== `buying:${decisionId}` ||
    input.inputTokens !== candidate.inputTokens ||
    input.outputTokens !== candidate.outputTokens ||
    input.maxTotalCents !== candidate.maxTotalCents ||
    input.mode !== candidate.mode ||
    input.quoteId !== candidate.quoteId ||
    input.maxTotalCents > Number(policy.max_purchase_cents) ||
    (input.mode === 'instant' && !policy.allow_instant)
  )
    failure(409, 'recommendation_changed', 'The purchase must match the approved recommendation.');
  const current = await allowance(db, grant, policy.output_per_call);
  if (
    current.pendingOrders ||
    current.unresolvedRequests ||
    (input.mode === 'instant' && current.eligibleCalls > 0) ||
    current.eligibleCalls > policy.refill_at_calls
  )
    failure(
      409,
      'purchase_not_needed',
      'A purchase is pending, usage needs reconciliation, or sufficient allowance is available.',
    );
}
