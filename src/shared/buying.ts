import type { InferenceGrant, InferenceMode, TokenOrderInput, TokenQuote } from './inference.js';

export type BuyingMode = 'suggest' | 'review' | 'automatic';
export interface BuyingPolicy {
  revision: number;
  mode: BuyingMode;
  paused: boolean;
  maxPurchaseCents: number;
  outputPerCall: number;
  targetCalls: number;
  refillAtCalls: number;
  allowInstant: boolean;
  modelCalls: number;
  lastEvaluatedAt: string | null;
  nextEvaluationAt: string;
}
export interface BuyingPolicyInput extends Pick<
  BuyingPolicy,
  | 'mode'
  | 'paused'
  | 'maxPurchaseCents'
  | 'outputPerCall'
  | 'targetCalls'
  | 'refillAtCalls'
  | 'allowInstant'
> {
  operationKey: string;
  expectedRevision: number;
}
export interface BuyingCandidate {
  id: string;
  mode: 'auction' | 'instant';
  inputTokens: number;
  outputTokens: number;
  maxTotalCents: number;
  estimatedPriceCents: number;
  calls: number;
  quoteId?: string;
}
export interface BuyingDecision {
  id: string;
  status:
    'evaluating' | 'recommended' | 'skipped' | 'blocked' | 'failed' | 'superseded' | 'ordered';
  reason: string;
  mode: InferenceMode;
  modelCalled: boolean;
  policyRevision: number;
  candidate: BuyingCandidate | null;
  baseline:
    | (Pick<TokenQuote, 'provider' | 'priceCents' | 'inputTokens' | 'outputTokens'> & {
        capturedAt: string;
        packExpiresAt: string;
      })
    | null;
  orderId: string | null;
  createdAt: string;
  expiresAt: string;
}
export interface BuyingAllowance {
  availableInputTokens: number;
  availableOutputTokens: number;
  heldInputTokens: number;
  heldOutputTokens: number;
  eligibleCalls: number;
  outputPerCall: number;
  unresolvedRequests: number;
  pendingOrders: number;
}
export interface BuyingWorkspace {
  policy: BuyingPolicy | null;
  allowance: BuyingAllowance;
  decisions: BuyingDecision[];
}
export interface AgentListItem extends InferenceGrant {
  buyingMode: BuyingMode | null;
  buyingPaused: boolean;
  eligibleCalls: number;
  outputPerCall: number;
}
export interface MuseBuyingInput {
  kind: 'purchase' | 'supply';
  availableCalls: number;
  expiresInMinutes: number;
  candidates: Array<
    Pick<
      BuyingCandidate,
      'id' | 'mode' | 'inputTokens' | 'outputTokens' | 'estimatedPriceCents' | 'calls'
    >
  >;
}
export interface MuseBuyingSelection {
  candidateId: string | null;
  reason: 'refill' | 'small_pack' | 'immediate_need' | 'wait';
  modelCalled: boolean;
  mode: InferenceMode;
}
export function purchaseInput(
  grantId: string,
  decision: Pick<BuyingDecision, 'id' | 'candidate'>,
): TokenOrderInput {
  const c = decision.candidate!;
  return {
    grantId,
    operationKey: `buying:${decision.id}`,
    mode: c.mode,
    inputTokens: c.inputTokens,
    outputTokens: c.outputTokens,
    maxTotalCents: c.maxTotalCents,
    ...(c.quoteId ? { quoteId: c.quoteId } : {}),
  };
}
