import type { Requirements } from './types.js';

export type AgreementStatus = 'open' | 'approved' | 'expired' | 'cancelled';
export type ScheduledOfferingKind = 'discount_schedule' | 'capacity_window';
export interface AgreementInput {
  operationKey: string;
  description: string;
  startDate: string; // YYYY-MM-DD, seven consecutive local dates, within the next 30 days.
  timeZone: string;
  windowStart: string; // HH:mm
  windowEnd: string; // Discount ends at this local time; overnight windows are supported.
  minimumQuantity: number;
  targetQuantity: number;
  requirements: Requirements;
  region: string;
  maxDiscountRateCentsPerHour: number;
  /** Reviewed maximum hold; omitted by legacy clients. Server never reserves above it. */
  maxReservationCents?: number;
  continuation?: { enabled: boolean; until: string; maxRateCentsPerHour: number };
}
export interface AgreementPreview {
  maxAmountCents: number;
  minimumAmountCents: number;
  windows: { startsAt: string; discountEndsAt: string; endsAt: string }[];
  timeZone: string;
}
export interface AgreementWindow {
  id: string;
  agreementId: string;
  startsAt: string;
  discountEndsAt: string;
  endsAt: string;
  approvedQuantity: number;
  runningQuantity: number;
  availableToActivate: number;
  committedCents: number;
}
export interface Agreement {
  id: string;
  description: string;
  status: AgreementStatus;
  targetQuantity: number;
  minimumQuantity: number;
  startsAt: string;
  expiresAt: string;
  timeZone: string;
  maxAmountCents: number;
  reservedCents: number;
  committedCents: number;
  settledCents: number;
  adjustmentCents: number;
  topUpAllowanceCents: number;
  acceptingTopUps: boolean;
  createdAt: string;
  specification: AgreementInput;
  windows: AgreementWindow[];
  activationMode: 'manual';
  deadlineEligible: boolean;
  blockedReason?: string;
  blockedCode?: 'needs_credit' | 'awaiting_capacity' | 'deadline_unsupported';
}
export interface AgreementBooking {
  id: string;
  windowId: string;
  providerId: string;
  providerName: string;
  catalogId: string;
  quantity: number;
  unitPriceCents: number;
  totalCents: number;
  startsAt: string;
  discountEndsAt: string;
  endsAt: string;
  discountRateCentsPerHour: number;
  normalRateCentsPerHour: number;
}
export interface AgreementActivation {
  id: string;
  windowId: string;
  status: 'provisioning' | 'running' | 'terminating' | 'terminated' | 'failed';
  requestId: string | null;
  vmId: string | null;
  endsAt: string;
  createdAt: string;
  failureReason?: string;
}
export interface AgreementDetail {
  agreement: Agreement;
  bookings: AgreementBooking[];
  activations: AgreementActivation[];
}
export interface ActivateAgreementInput {
  operationKey: string;
  windowId: string;
  quantity: number;
}
export interface ActivateAgreementResult {
  activations: AgreementActivation[];
  replayed: boolean;
}
export interface CreditWallet {
  balanceCents: number;
  reservedCents: number;
  availableCents: number;
  currency: 'USD';
  kind: 'broker-pilot-credit';
  wickComputeCreditsSeparate: true;
}
export interface CreditEntry {
  id: string;
  kind:
    | 'grant'
    | 'reserve'
    | 'book'
    | 'settle'
    | 'release'
    | 'failed_start_credit'
    | 'agent_fund'
    | 'token_purchase'
    | 'studio_compute'
    | 'agent_release'
    | 'token_refund';
  amountCents: number;
  reservedDeltaCents: number;
  agreementId?: string;
  grantId?: string;
  operationKey: string;
  createdAt: string;
  description: string;
}
export interface CreditHistory {
  wallet: CreditWallet;
  items: CreditEntry[];
  nextCursor?: string;
}
export interface ScheduledOfferingInput {
  operationKey: string;
  catalogId: string;
  name: string;
  kind: ScheduledOfferingKind;
  timeZone: string;
  weekdays: number[]; // Sunday=0 through Saturday=6.
  windowStart: string;
  windowEnd: string; // Discounted interval ends here.
  availableUntil: string; // Published final availability / hard physical capacity cutoff.
  capacityQuantity: number;
  discountRateCentsPerHour: number;
  normalRateCentsPerHour: number;
}
export interface ScheduledOffering extends ScheduledOfferingInput {
  id: string;
  providerId: string;
  active: boolean;
  revision: number;
  createdAt: string;
  deadlineEligible: boolean;
  blockedReason?: string;
}
export interface AgreementDemand {
  id: string;
  description: string;
  timeZone: string;
  minimumQuantity: number;
  targetQuantity: number;
  approvedQuantity: number;
  startsAt: string;
  endsAt: string;
  region: string;
  requirements: Requirements;
  maxDiscountRateCentsPerHour: number;
  maxNormalRateCentsPerHour: number;
}
export interface ProviderCommitment extends AgreementBooking {
  agreementId: string;
  agreementDescription: string;
  timeZone?: string;
  runningQuantity: number;
}
export interface AgreementDraftResult<T> {
  draft: Partial<T>;
  mode: 'fixture' | 'real';
  modelCalled: boolean;
  explanation: string;
}
