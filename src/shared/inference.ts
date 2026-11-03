/** Broker inference is separate from Wick VM routing and native provider credentials. */
export const INFERENCE_MODEL_ID = 'meta/muse-spark-open';
export const INFERENCE_MODEL_NAME = 'Meta Muse Spark Open';
export const INFERENCE_CONTRACT = 'muse-spark-open-text-v1';
export const INFERENCE_PROVIDERS = ['modal', 'baseten'] as const;
/** Direct wallet purchases keep an isolated two-hour allowance, without an agent. */
export const WALLET_TOKEN_PACK_TTL_SECONDS = 2 * 60 * 60;
export type TokenFundingSource = 'agent' | 'wallet';
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
  /** Wallet purchase scopes are internal accounting records, not agent budgets. */
  fundingSource?: TokenFundingSource;
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
  /** Smallest standalone pack that can reserve one nonempty user message. */
  minimumPackInputTokens?: number;
  minimumOutputTokens?: number;
  inputAccounting?: 'utf8-bytes-v1';
  maximumInputReservation?: number;
  maximumOutputTokens: number;
}
export interface InferenceCatalog {
  enabled: boolean;
  mode: InferenceMode;
  models: { id: string; name: string; publisher: 'Meta'; contract: string }[];
  routes: InferenceRoute[];
}
export interface TokenOfferingInput {
  salesStartAt?: string | null;
  salesEndAt?: string | null;
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
  grantId: string | null;
  fundingSource?: TokenFundingSource;
  /** Signed expiry for a direct wallet purchase. */
  packExpiresAt?: string;
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
  /** Owner sessions omit this to use the wallet. Agent keys use their bound grant. */
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
  fundingSource?: TokenFundingSource;
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
  fundingSource?: TokenFundingSource;
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
/** The reviewed text envelope, shared by admission and the purchase estimator.
 * This is a reservation upper bound, not a tokenizer or a usage forecast. */
export function utf8InputReservation(
  messages: readonly InferenceMessage[],
  maximumInputReservation: number,
): number {
  const encoder = new TextEncoder();
  return Math.min(
    maximumInputReservation,
    4096 +
      messages.reduce((n, message) => {
        // Muse's system template expands these directive spellings. Bound the
        // rendered text while dispatch continues to send the original content.
        const rendered =
          message.role === 'system'
            ? message.content.replace(
                /Reasoning effort|Reasoning Effort|reasoning effort|REASONING EFFORT/g,
                (directive) => `${directive.slice(0, -6)}strength`,
              )
            : message.content;
        // Compatibility decomposition can expand Unicode substantially.
        const bytes = Math.max(
          encoder.encode(rendered).length,
          ...(['NFC', 'NFD', 'NFKC', 'NFKD'] as const).map(
            (form) => encoder.encode(rendered.normalize(form)).length,
          ),
        );
        return n + 32 + bytes;
      }, 0),
  );
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
    | 'needs_reconciliation'
    | 'written_off';
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
