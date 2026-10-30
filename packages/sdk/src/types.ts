/** Public Broker DTOs. Wick credentials and native provider-key identifiers are not part of this contract. */
export type Role = 'buyer' | 'provider' | 'admin';
export type Mode = 'fixture' | 'real';
export type BrokerScope =
  | 'account:read'
  | 'catalog:read'
  | 'muse:propose'
  | 'orders:read'
  | 'orders:write'
  | 'agreements:read'
  | 'agreements:write'
  | 'agreements:activate'
  | 'vms:read'
  | 'vms:terminal'
  | 'vms:terminate'
  | 'billing:read'
  | 'inference:read'
  | 'inference:use'
  | 'tokens:buy'
  | 'provider:read'
  | 'provider:bids:write'
  | 'provider:capacity:write'
  | 'provider:policy:write'
  | 'provider:offerings:write';
export interface BrokerKeyLimits {
  maxAuctionCents?: number;
  maxAgreementReservationCents?: number;
  maxActivationQuantity?: number;
}
export interface BrokerKeyAuthority {
  id: string;
  grantId?: string;
  packId?: string;
  scopes: BrokerScope[];
  limits: BrokerKeyLimits;
}
export interface Actor {
  id: string;
  email: string;
  name: string;
  role: Role;
  providerId?: string | null;
  apiKey?: BrokerKeyAuthority;
}
export interface Requirements {
  cpu: number;
  memoryGb: number;
  gpu?: string;
}
export interface CatalogItem extends Requirements {
  id: string;
  name: string;
  description: string;
  provider: string;
  profile: string;
  region: string;
  durationMinutes: number[];
  approved: boolean;
  rateMicrosPerSecond?: number;
  rateRetrievedAt?: string;
  rateSource?: 'wick-customer-catalog';
  pricingMode?: 'managed' | 'byok';
  managedRouteVerification?: 'organization-catalog-byok-disabled' | 'execution-preview-managed';
  resources?: Requirements & { diskGb?: number };
  maxTtlSeconds?: number;
  deadlineEnforcement?: 'native' | 'supervised' | 'none';
}
export interface Session {
  user: Actor | null;
  modes: { wick: Mode; muse: Mode };
  catalog: CatalogItem[];
  commissionBps?: number;
}
export interface RevenueShare {
  commissionBps: 1500;
  grossCents: number;
  brokerFeeMicros: string;
  providerNetMicros: string;
}
export interface ManagedPricing {
  model: 'wick-managed-rate-v1' | 'wick-provider-commission-v1';
  rateMicrosPerSecond: number;
  rateRetrievedAt: string;
  rateSource: 'wick-customer-catalog';
  markupBps?: number;
  commissionBps?: number;
}
export interface FixedQuote extends ManagedPricing {
  durationSeconds: number;
  upstreamEstimatedComputeMicros: string;
  totalPriceCents: number;
  targetTotalPriceCents?: number;
  upstreamCostFloorCents?: number;
  priceBasis?: 'target-markup' | 'provider-commission-floor' | 'provider-bid';
  revenueShare?: RevenueShare;
  currency: 'USD';
  rounding: 'ceil-once-to-cent-minimum-one-cent';
}
export interface Receipt {
  observed: string[];
  decision: string;
  constraints: string[];
}
export interface Translation {
  catalogId: string;
  region: string;
  durationMinutes: number;
  requirements: Requirements;
  maxPriceCents?: number;
}
export interface TranslationResult {
  proposal: Translation;
  receipt: Receipt;
  mode: Mode;
  modelCalled?: boolean;
}
export interface CreateOrderInput {
  description: string;
  catalogId: string;
  region: string;
  matchAcrossProviders?: boolean;
  durationMinutes: 15 | 30 | 60;
  maxPriceCents: number;
  requirements: Requirements;
}
export interface EnvironmentRequest extends Omit<CreateOrderInput, 'durationMinutes'> {
  id: string;
  buyerId: string;
  catalogName?: string;
  failureReason?: string | null;
  source?: { kind: 'api_key'; keyId: string };
  durationMinutes: number;
  status: 'open' | 'provisioning' | 'ready' | 'no_offers' | 'failed' | 'cancelled';
  closesAt: string;
  createdAt: string;
  winningBidId?: string | null;
  pricing?: FixedQuote;
  revenueShare?: RevenueShare;
}
export type ProviderRequest = Omit<EnvironmentRequest, 'buyerId' | 'source'>;
export interface Bid {
  id: string;
  requestId?: string;
  source?: 'manual' | 'auto' | null;
  pricing?: FixedQuote | ManagedPricing;
  revenueShare?: RevenueShare;
  providerId: string;
  providerName?: string;
  totalPriceCents: number;
  status: string;
  createdAt: string;
  catalogId?: string;
  catalogName?: string;
  cloudProvider?: string;
  region?: string;
  simulated?: boolean;
}
export interface VM {
  id: string;
  requestId: string;
  buyerId: string;
  sourceMode: Mode;
  status: 'provisioning' | 'running' | 'terminating' | 'terminated' | 'failed' | 'expired';
  environmentId?: string | null;
  admittedAt?: string | null;
  expiresAt?: string | null;
  readyAt?: string | null;
  createdAt: string;
  catalogName: string;
  region: string;
  durationMinutes: number;
  priceCents: number;
  failureReason?: string | null;
  cleanupPending?: boolean;
  cleanupConfirmedAt?: string | null;
  pricing?: FixedQuote;
  revenueShare?: RevenueShare;
  billingSource?: 'instant_vm' | 'scheduled_capacity';
  agreementId?: string;
  scheduledWindow?: {
    windowId: string;
    startsAt: string;
    discountEndsAt: string;
    endsAt: string;
    discountRateCentsPerHour: number;
    normalRateCentsPerHour: number;
  };
}
export interface OrderDetail {
  request: EnvironmentRequest;
  bids: Bid[];
  vm: VM | null;
}
export interface Page<T> {
  items: T[];
  nextCursor?: string;
}
export interface Pagination {
  limit?: number;
  cursor?: string;
}
export interface Invoice {
  id: string;
  vmId: string;
  subtotalCents: number;
  feeCents: number;
  totalCents: number;
  currency: string;
  status: string;
  createdAt: string;
  catalogName: string;
  label: string;
  revenueShare?: RevenueShare;
  pricing?: FixedQuote;
}
export interface SupplierPolicy {
  autoBid: boolean;
  minimumPriceCents: number;
  basePriceCents: number;
  maxPriceCents?: number;
  allowedCatalogIds?: string[];
  reserveSlots?: number;
}
export interface Activity {
  id: string;
  requestId?: string | null;
  kind: string;
  message: string;
  createdAt: string;
  receipt?: Receipt;
  mode?: Mode;
  modelCalled?: boolean;
}
export interface Capacity {
  total: number;
  held: number;
  available: number;
  free?: number;
  reserveSlots?: number;
}
export interface ProviderDashboard {
  provider: { id: string; name: string; simulated: boolean; cloudProvider?: string | null };
  policy: SupplierPolicy;
  policyRevision: number;
  capacity: Capacity;
  activity: Activity[];
}
export interface PolicyProposal {
  policy: SupplierPolicy;
  baseRevision: number;
  capacity: Capacity;
  receipt: Receipt;
  mode: Mode;
  modelCalled: boolean;
}
export interface ApplyPolicyInput extends SupplierPolicy {
  expectedRevision: number;
}
export interface PolicyResult {
  policy: SupplierPolicy;
  policyRevision: number;
}
export interface Offering {
  id: string;
  providerId: string;
  catalogId: string;
  name: string;
  description: string;
  priceCents: number;
  active: boolean;
  revision: number;
  simulated?: boolean;
  cloudProvider?: string | null;
  priceDurationMinutes?: 30;
  pricing?: ManagedPricing;
  createdAt: string;
}
export interface OfferingInput {
  catalogId: string;
  name: string;
  description: string;
  priceCents: number;
  durationMinutes?: 30;
  priceBasis?: 'server-priced-candidate';
}
export interface OfferingProposal {
  catalogId: string;
  name: string;
  description: string;
  priceCents: number;
  durationMinutes?: number;
  priceBasis?: 'server-priced-candidate';
}
export interface OfferingsProposal {
  proposals: OfferingProposal[];
  receipt: Receipt;
  mode: Mode;
}
export interface BidProposal {
  decision: 'bid' | 'decline';
  totalPriceCents?: number;
  catalogId?: string;
  offeringId?: string;
  receipt: Receipt;
  modelCalled?: boolean;
}
export interface BidInput {
  totalPriceCents: number;
  offeringId?: string;
}
export interface ProviderEarning {
  id: string;
  vmId: string;
  catalogName: string;
  createdAt: string;
  totalCents: number;
  revenueShare?: RevenueShare;
  legacy: boolean;
  currency: string;
  status: string;
  label: string;
}
export interface Desired extends Requirements {
  region: string;
  durationMinutes: number;
  maxPriceCents: number;
}
export interface Flexibility {
  minCPU: number;
  minMemoryGb: number;
  allowedRegions: string[];
  allowedDurations: number[];
  hardMaxPriceCents: number;
  gpu: 'preserve' | 'none' | 'any';
}
export interface IntentInput {
  description: string;
  desired: Desired;
  flexibility?: Flexibility;
  sourceRequestId?: string;
}
export interface Intent extends Omit<IntentInput, 'sourceRequestId'> {
  id: string;
  flexibility: Flexibility;
  status: 'open' | 'accepted' | 'resolved';
  sourceMode: Mode;
  sourceRequestId?: string | null;
  acceptedOfferId?: string | null;
  acceptedRequestId?: string | null;
  createdAt: string;
}
export interface AlternativeOffer {
  id: string;
  providerName: string;
  catalogName: string;
  before: Desired;
  after: Desired;
  totalPriceCents: number;
  tradeoffs: string[];
  expiresAt: string;
  mode: Mode;
  modelCalled: boolean;
}
export interface IntentDetail {
  intent: Intent;
  offers: AlternativeOffer[];
}
export type AlternativesResult = IntentDetail;
export interface AcceptAlternativeResult {
  requestId: string;
  vmId: string;
  winningBidId: string;
}
export interface AgreementCharge {
  id: string;
  agreementId: string;
  windowId: string;
  description: string;
  providerName: string;
  quantity: number;
  startsAt: string;
  discountEndsAt: string;
  endsAt: string;
  discountRateCentsPerHour: number;
  normalRateCentsPerHour: number;
  grossCents: number;
  creditCents: number;
  totalCents: number;
  feeCents: 0;
  revenueShare: RevenueShare;
  createdAt: string;
  currency: 'USD';
  status: 'pilot-credit';
  label: string;
}
