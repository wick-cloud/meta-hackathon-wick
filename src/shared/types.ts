import type { BrokerKeyAuthority } from './developer.js';
export type Role = 'buyer' | 'provider' | 'admin';
export type Mode = 'fixture' | 'real';
export interface Actor {
  id: string;
  email: string;
  name: string;
  role: Role;
  providerId?: string;
  apiKey?: BrokerKeyAuthority;
}
export interface CatalogItem {
  id: string;
  name: string;
  description: string;
  provider: string;
  profile: string;
  region: string;
  cpu: number;
  memoryGb: number;
  gpu?: string;
  durationMinutes: number[];
  approved: boolean;
  organizationId?: string;
  groupId?: string;
  providerKeyId?: string;
  /** Optional for historical fixture records; supplied only by the real catalog. */
  rateMicrosPerSecond?: number;
  rateRetrievedAt?: string;
  rateSource?: 'wick-customer-catalog';
  pricingMode?: 'managed' | 'byok';
  managedRouteVerification?: 'organization-catalog-byok-disabled' | 'execution-preview-managed';
  resources?: { cpu: number; memoryGb: number; diskGb?: number; gpu?: string };
  capabilities?: string[];
  maxTtlSeconds?: number;
  /** Explicit upstream attestation; absence never grants scheduled physical cutoff support. */
  deadlineEnforcement?: 'native' | 'supervised' | 'none';
}
export interface ManagedPricing {
  model: 'wick-managed-rate-v1' | 'wick-provider-commission-v1';
  rateMicrosPerSecond: number;
  rateRetrievedAt: string;
  rateSource: 'wick-customer-catalog';
  /** Present only on immutable historical markup snapshots. */
  markupBps?: number;
  commissionBps?: number;
}
export interface FixedQuote extends ManagedPricing {
  durationSeconds: number;
  upstreamEstimatedComputeMicros: string;
  totalPriceCents: number;
  /** Optional on historical snapshots. The target is a suggestion, not a mandatory bid. */
  targetTotalPriceCents?: number;
  upstreamCostFloorCents?: number;
  priceBasis?: 'target-markup' | 'provider-commission-floor' | 'provider-bid';
  revenueShare?: RevenueShare;
  currency: 'USD';
  rounding: 'ceil-once-to-cent-minimum-one-cent';
}
export interface Requirements {
  cpu: number;
  memoryGb: number;
  gpu?: string;
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
}
export interface BidProposal {
  decision: 'bid' | 'decline';
  totalPriceCents?: number;
  catalogId?: string;
  offeringId?: string;
  receipt: Receipt;
  modelCalled?: boolean;
}
export interface SupplierPolicy {
  autoBid: boolean;
  minimumPriceCents: number;
  basePriceCents: number;
  maxPriceCents?: number;
  allowedCatalogIds?: string[];
  /** Slots kept unavailable to new bids. Older approved policies default to zero. */
  reserveSlots?: number;
}
export interface OfferingProposal {
  catalogId: string;
  name: string;
  description: string;
  priceCents: number;
  durationMinutes?: number;
  priceBasis?: 'server-priced-candidate';
}

/** Gross buyer quote split exactly in micro-USD; provider net is before compute costs. */
export interface RevenueShare {
  commissionBps: 1500;
  grossCents: number;
  brokerFeeMicros: string;
  providerNetMicros: string;
}
