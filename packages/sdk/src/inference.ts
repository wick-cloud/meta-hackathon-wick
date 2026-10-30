/** Broker inference is separate from Wick VM routing and native provider credentials. */
export const INFERENCE_MODEL_ID = 'meta/muse-spark-open';
export const INFERENCE_MODEL_NAME = 'Meta Muse Spark Open';
export const INFERENCE_CONTRACT = 'muse-spark-open-text-v1';
export const INFERENCE_PROVIDERS = ['modal', 'baseten'] as const;
export type InferenceProvider = (typeof INFERENCE_PROVIDERS)[number];
export type InferenceMode = 'fixture' | 'real';
export type GrantStatus = 'active' | 'closing' | 'closed';
export interface InferenceGrantInput {
  operationKey: string;
  name: string;
  budgetCents: number;
  maxPurchaseCents?: number;
  allowedProviders?: InferenceProvider[];
  expiresAt?: string;
  allowInstant?: boolean;
}
export interface InferenceGrant {
  id: string;
  name: string;
  status: GrantStatus;
  mode: InferenceMode;
  fundedCents: number;
  availableCents: number;
  heldCents: number;
  spentCents: number;
  returnedCents: number;
  maxPurchaseCents: number;
  allowedProviders: InferenceProvider[];
  allowInstant: boolean;
  expiresAt: string;
  createdAt: string;
  currency: 'USD';
}
export interface InferenceRoute {
  provider: InferenceProvider;
  mode: InferenceMode;
  modelId: string;
  modelName: string;
  qualified: boolean;
  reason: string;
  minimumInputReservation: number;
  maximumOutputTokens: number;
}
export interface InferenceCatalog {
  enabled: boolean;
  mode: InferenceMode;
  models: { id: string; name: string; publisher: 'Meta'; contract: string }[];
  routes: InferenceRoute[];
}
/** OpenAI-compatible discovery; qualification details remain in InferenceCatalog. */
export interface InferenceModelList {
  object: 'list';
  data: { id: string; object: 'model'; created: number; owned_by: string }[];
}
export interface TokenOfferingInput {
  operationKey: string;
  expectedRevision: number;
  active: boolean;
  autoBid: boolean;
  inputRateMicrosPerMillion: number;
  outputRateMicrosPerMillion: number;
  instantMarkupBps: number;
  minimumPriceCents: number;
  maxOutstandingInputTokens: number;
  maxOutstandingOutputTokens: number;
}
export interface TokenOffering extends Omit<
  TokenOfferingInput,
  'operationKey' | 'expectedRevision'
> {
  provider: InferenceProvider;
  revision: number;
  route: InferenceRoute;
  costInputRateMicrosPerMillion: number;
  costOutputRateMicrosPerMillion: number;
  outstandingInputTokens: number;
  outstandingOutputTokens: number;
  providerCommissionBps: 1500;
}
export interface TokenQuote {
  quoteId: string;
  grantId: string;
  provider: InferenceProvider;
  modelId: string;
  inputTokens: number;
  outputTokens: number;
  priceCents: number;
  costFloorCents: number;
  expiresAt: string;
  mode: InferenceMode;
}
export interface TokenQuoteInput {
  grantId?: string;
  modelId?: string;
  inputTokens: number;
  outputTokens: number;
}
export interface TokenOrderInput extends TokenQuoteInput {
  operationKey: string;
  mode: 'auction' | 'instant';
  maxTotalCents: number;
  quoteId?: string;
}
export interface TokenBid {
  id: string;
  provider: InferenceProvider;
  priceCents: number;
  status: 'offered' | 'won' | 'lost';
  mode: InferenceMode;
  createdAt: string;
}
export interface TokenOrder {
  id: string;
  grantId: string;
  mode: 'auction' | 'instant';
  sourceMode: InferenceMode;
  status: 'open' | 'awarded' | 'no_offers' | 'cancelled' | 'expired';
  modelId: string;
  inputTokens: number;
  outputTokens: number;
  maxTotalCents: number;
  priceCents: number | null;
  provider: InferenceProvider | null;
  closesAt: string;
  expiresAt: string;
  createdAt: string;
  packId: string | null;
}
export interface TokenPack {
  id: string;
  orderId: string;
  grantId: string;
  provider: InferenceProvider;
  mode: InferenceMode;
  modelId: string;
  status: 'active' | 'retiring' | 'settled';
  inputTokens: number;
  outputTokens: number;
  availableInputTokens: number;
  availableOutputTokens: number;
  heldInputTokens: number;
  heldOutputTokens: number;
  consumedInputTokens: number;
  consumedOutputTokens: number;
  retiredInputTokens: number;
  retiredOutputTokens: number;
  priceCents: number;
  refundCents: number;
  expiresAt: string;
  createdAt: string;
  retirementReason: string | null;
  revenueShare: {
    commissionBps: 1500;
    grossCents: number;
    brokerFeeMicros: string;
    providerNetMicros: string;
  };
}
export interface TokenOrderDetail {
  order: TokenOrder;
  bids: TokenBid[];
  pack: TokenPack | null;
  grant: InferenceGrant;
}
export interface InferenceMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}
export interface InferenceCompletionInput {
  model: string;
  messages: InferenceMessage[];
  max_tokens: number;
  temperature?: number;
  top_p?: number;
  stream?: false;
}
export interface InferenceCompletion {
  id: string;
  object: 'chat.completion';
  created: number;
  model: string;
  choices: {
    index: number;
    message: { role: 'assistant'; content: string };
    finish_reason: string;
  }[];
  usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
  broker: { requestId: string; packId: string; provider: InferenceProvider; mode: InferenceMode };
}
export interface InferenceReceipt {
  id: string;
  grantId: string;
  packId: string;
  provider: InferenceProvider;
  mode: InferenceMode;
  status:
    | 'reserved'
    | 'dispatching'
    | 'settled'
    | 'rejected'
    | 'outcome_unknown'
    | 'needs_reconciliation';
  heldInputTokens: number;
  heldOutputTokens: number;
  inputTokens: number | null;
  outputTokens: number | null;
  failureCode: string | null;
  createdAt: string;
  completedAt: string | null;
}
export interface InferenceGrantDetail {
  grant: InferenceGrant;
  packs: TokenPack[];
  requests: InferenceReceipt[];
  orders: TokenOrder[];
  catalog: InferenceCatalog;
}
