import { PROVIDER_REGISTRY } from '../shared/providers.js';
import { demoLocation, getDemoStore } from './demo-store';
import { isSponsoredComputeQuote } from '../shared/pricing';
import { centsToUsd, formatMoney, formatMoneyMicros } from '../shared/money';
import type {
  Actor,
  CatalogItem,
  Mode,
  Receipt,
  Requirements,
  SupplierPolicy,
  Translation,
  FixedQuote,
  ManagedPricing,
  RevenueShare,
} from '../shared/types';
import { MUSE_DISPLAY_NAME, MUSE_PROVIDER } from '../shared/muse';
export { MUSE_DISPLAY_NAME, MUSE_MODEL, MUSE_PROVIDER } from '../shared/muse';
export const museLabel = `${MUSE_DISPLAY_NAME} · ${MUSE_PROVIDER}`;
// Starting values for new editable money fields; never replace saved or quoted prices.
export const DEFAULT_PRICE_CENTS = 10;
export const DEFAULT_PRICE_USD = centsToUsd(DEFAULT_PRICE_CENTS);

export interface Session {
  user: Actor | null;
  modes: { wick: Mode; muse: Mode };
  catalog: CatalogItem[];
  commissionBps?: number;
  computePromotion?: {
    provider: 'modal';
    totalPriceCents: 1;
    tiePriority: 'modal';
    fundedBy: 'operator-wick-account';
  };
}
export interface EnvironmentRequest {
  id: string;
  diskId?: string | null;
  description: string;
  catalogId: string;
  region: string;
  matchAcrossProviders?: boolean;
  durationMinutes: number;
  maxPriceCents: number;
  requirements: Requirements;
  status: 'open' | 'provisioning' | 'ready' | 'no_offers' | 'failed' | 'cancelled';
  closesAt: string;
  createdAt: string;
  winningBidId?: string | null;
  pricing?: FixedQuote;
  revenueShare?: RevenueShare;
}
export interface Bid {
  id: string;
  source?: 'manual' | 'auto' | null;
  providerId: string;
  providerName: string;
  totalPriceCents: number;
  status: string;
  createdAt: string;
  catalogId?: string;
  catalogName?: string;
  cloudProvider?: string;
  region?: string;
  simulated?: boolean;
  pricing?: FixedQuote;
}

export const isSponsoredModalBid = (bid: Bid) =>
  bid.cloudProvider === 'modal' &&
  bid.simulated === false &&
  bid.totalPriceCents === 1 &&
  isSponsoredComputeQuote(bid.pricing);

/** Keep API order for remaining ties: its accepted timestamps preserve database microseconds. */
export const compareComputeBids = (a: Bid, b: Bid) =>
  a.totalPriceCents - b.totalPriceCents ||
  Number(isSponsoredModalBid(b)) - Number(isSponsoredModalBid(a));
export interface VM {
  id: string;
  diskId?: string | null;
  requestId: string;
  buyerId: string;
  sourceMode: Mode;
  status: 'provisioning' | 'running' | 'terminating' | 'terminated' | 'failed' | 'expired';
  environmentId?: string | null;
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
export interface Invoice {
  id: string;
  vmId: string;
  amountCents?: number;
  totalPriceCents?: number;
  totalCents?: number;
  priceCents?: number;
  feeCents?: number;
  createdAt: string;
  status?: string;
  catalogName?: string;
  number?: string;
  pricing?: FixedQuote;
  revenueShare?: RevenueShare;
}
export interface ProviderEarning {
  pricing?: FixedQuote;
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
export interface Offering {
  id: string;
  providerId: string;
  catalogId: string;
  name: string;
  description: string;
  priceCents: number;
  active: boolean;
  revision: number;
  pricing?: ManagedPricing;
  createdAt: string;
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
export interface Dashboard {
  provider: { id: string; name: string; simulated: boolean; cloudProvider?: string | null };
  policy: SupplierPolicy;
  policyRevision: number;
  capacity: {
    total: number;
    held: number;
    available: number;
    free?: number;
    reserveSlots?: number;
  };
  activity: Activity[];
}
export interface PolicyProposal {
  policy: SupplierPolicy;
  baseRevision: number;
  capacity: Dashboard['capacity'];
  receipt: Receipt;
  mode: Mode;
  modelCalled: boolean;
}
export interface Proposal {
  proposal: Translation;
  receipt: Receipt;
  mode: Mode;
  modelCalled?: boolean;
}
export interface Draft {
  description: string;
  diskId?: string;
  catalogId: string;
  region: string;
  matchAcrossProviders?: boolean;
  durationMinutes: number;
  maxPriceCents: number;
  requirements: Requirements;
  receipt?: Receipt;
  museMode?: Mode;
}

export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public code?: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export async function api<T>(url: string, options: RequestInit = {}): Promise<T> {
  const demo = demoLocation();
  if (demo) {
    const store = getDemoStore(demo.role);
    const { demoRequest } = await import('./demo-api');
    if (demoLocation()?.role !== demo.role || getDemoStore(demo.role) !== store)
      throw new DOMException('Demo workspace changed', 'AbortError');
    try {
      return demoRequest(demo.role, url, options) as T;
    } catch (error) {
      if (error instanceof Error && 'status' in error)
        throw new ApiError(error.message, Number(error.status));
      throw error;
    }
  }
  const headers = new Headers(options.headers);
  if (options.body) headers.set('Content-Type', 'application/json');
  if (
    !['GET', 'HEAD', 'OPTIONS'].includes((options.method ?? 'GET').toUpperCase()) &&
    !headers.has('Idempotency-Key')
  ) {
    let operationKey: string | undefined;
    if (typeof options.body === 'string') {
      try {
        const b = JSON.parse(options.body);
        if (typeof b?.operationKey === 'string') operationKey = b.operationKey;
      } catch {
        /* server validates malformed JSON */
      }
    }
    headers.set('Idempotency-Key', operationKey ?? crypto.randomUUID());
  }
  const response = await fetch(url, {
    credentials: 'same-origin',
    ...options,
    headers,
  });
  const data = await response.json().catch(() => null);
  if (!response.ok)
    throw new ApiError(
      typeof data?.error === 'string'
        ? data.error
        : data?.error?.message ||
            data?.message ||
            `Request failed (${response.status}). Please try again.`,
      response.status,
      typeof data?.code === 'string' ? data.code : undefined,
    );
  return data as T;
}
export const post = <T>(url: string, body?: unknown) =>
  api<T>(url, { method: 'POST', body: JSON.stringify(body ?? {}) });
export const put = <T>(url: string, body: unknown) =>
  api<T>(url, { method: 'PUT', body: JSON.stringify(body) });
export const money = (cents: number | undefined) => formatMoney(cents ?? 0);
export const moneyMicros = formatMoneyMicros;
export const dateTime = (value: string | undefined | null) =>
  value
    ? new Date(value).toLocaleString(undefined, {
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        timeZoneName: 'short',
      })
    : 'Awaiting Wick admission';
export const shortDate = (value: string) =>
  new Date(value).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
export const statusLabel = (status: string) =>
  ({
    open: 'Auction live',
    no_offers: 'No offers',
    ready: 'Environment ready',
    provisioning: 'Provisioning',
    running: 'Running',
    terminating: 'Terminating',
    terminated: 'Terminated',
    failed: 'Failed',
    expired: 'Expired',
    cancelled: 'Cancelled',
    accepted: 'Accepted',
    won: 'Awarded',
    awarded: 'Pack purchased',
    lost: 'Released',
    approved: 'Approved',
    active: 'Active',
    closing: 'Selecting match',
    completed: 'Completed',
    ending: 'Ending · cleanup pending',
    needs_credit: 'Needs credit',
    credit_release_pending: 'Credit release pending',
  })[status] || status.replaceAll('_', ' ');
export const rentalSourceLabel = (mode: Mode | undefined) =>
  mode === 'real' ? 'Real Wick VM' : 'Fixture simulation';
export const loadDraft = (): Draft | null => {
  const demo = demoLocation();
  if (demo) return (getDemoStore(demo.role).draft as Draft | undefined) ?? null;
  try {
    return JSON.parse(sessionStorage.getItem('wick-draft') || 'null') as Draft | null;
  } catch {
    return null;
  }
};
export const saveDraft = (draft: Draft) => {
  const demo = demoLocation();
  if (demo) getDemoStore(demo.role).draft = structuredClone(draft);
  else sessionStorage.setItem('wick-draft', JSON.stringify(draft));
};
export const clearDraft = () => {
  const demo = demoLocation();
  if (demo) delete getDemoStore(demo.role).draft;
  else sessionStorage.removeItem('wick-draft');
};

export const cloudRouteName = (provider: string) =>
  provider === 'provider-blaxel'
    ? 'Blaxel'
    : (PROVIDER_REGISTRY.find(({ id }) => id === provider)?.name ?? provider);
const regionLabels = new Map([
  ['any', 'Any available region'],
  ['auto', 'Provider-selected region'],
  ['us', 'United States'],
  ['eu', 'Europe'],
  ['sg', 'Singapore'],
  ['us-east', 'US East'],
  ['us-west', 'US West'],
  ['eu-west', 'Europe West'],
]);
export const regionName = (region: string) => regionLabels.get(region) ?? region;
