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

export interface Session {
  user: Actor | null;
  modes: { wick: Mode; muse: Mode };
  catalog: CatalogItem[];
  commissionBps?: number;
}
export interface EnvironmentRequest {
  id: string;
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
}
export interface VM {
  id: string;
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
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export async function api<T>(url: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(url, {
    credentials: 'same-origin',
    ...options,
    headers: {
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...options.headers,
    },
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
    );
  return data as T;
}
export const post = <T>(url: string, body?: unknown) =>
  api<T>(url, { method: 'POST', body: JSON.stringify(body ?? {}) });
export const put = <T>(url: string, body: unknown) =>
  api<T>(url, { method: 'PUT', body: JSON.stringify(body) });
export const money = (cents: number | undefined) =>
  new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format((cents ?? 0) / 100);
/** Preserve the exact provider split, including fractions of a cent. */
export const moneyMicros = (value: string | bigint) => {
  const micros = BigInt(value);
  const whole = micros / 1000000n;
  const fraction = (micros % 1000000n)
    .toString()
    .padStart(6, '0')
    .replace(/0+$/, '')
    .padEnd(2, '0');
  return `$${new Intl.NumberFormat('en-US').format(whole)}.${fraction}`;
};
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
  try {
    return JSON.parse(sessionStorage.getItem('wick-draft') || 'null') as Draft | null;
  } catch {
    return null;
  }
};
export const saveDraft = (draft: Draft) =>
  sessionStorage.setItem('wick-draft', JSON.stringify(draft));

export const cloudRouteName = (provider: string) =>
  (
    ({ e2b: 'E2B', daytona: 'Daytona', modal: 'Modal', 'provider-blaxel': 'Blaxel' }) as Record<
      string,
      string
    >
  )[provider] || provider;
export const regionName = (region: string) =>
  region === 'any'
    ? 'Any available region'
    : region === 'auto'
      ? 'Provider-selected region'
      : region;
