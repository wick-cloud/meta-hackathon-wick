export type Role = 'buyer' | 'provider' | 'admin';
export type Mode = 'fixture' | 'real';
export interface Actor {
  id: string;
  email: string;
  name: string;
  role: Role;
  providerId?: string;
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
}
export interface ManagedPricing {
  model: 'wick-managed-rate-v1';
  rateMicrosPerSecond: number;
  rateRetrievedAt: string;
  rateSource: 'wick-customer-catalog';
  markupBps: number;
}
export interface FixedQuote extends ManagedPricing {
  durationSeconds: number;
  upstreamEstimatedComputeMicros: string;
  totalPriceCents: number;
  /** Optional on historical snapshots. The target is a suggestion, not a mandatory bid. */
  targetTotalPriceCents?: number;
  upstreamCostFloorCents?: number;
  priceBasis?: 'target-markup' | 'provider-bid';
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
  receipt: Receipt;
  modelCalled?: boolean;
}
export interface SupplierPolicy {
  autoBid: boolean;
  minimumPriceCents: number;
  basePriceCents: number;
  maxPriceCents?: number;
  allowedCatalogIds?: string[];
}
export interface OfferingProposal {
  catalogId: string;
  name: string;
  description: string;
  priceCents: number;
}
