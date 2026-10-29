export type OrderKind = 'auction' | 'agreement';
export type OrderStatusFilter = 'all' | 'active' | 'history' | 'attention';
export type OrderCreatedFilter = 'all' | '24h' | '7d' | '30d';

/** Read-only history projection; source records retain their original lifecycle. */
export interface OrderListItem {
  id: string;
  key: string;
  kind: OrderKind;
  reference: string;
  title: string;
  source?: { kind: 'api_key'; keyId: string };
  status: string;
  auctionStatus?: string;
  vmStatus?: string;
  cleanupPending: boolean;
  createdAt: string;
  closesAt: string | null;
  expiresAt: string | null;
  requestedQuantity: number;
  approvedQuantity: number;
  runningQuantity: number;
  bidCount: number;
  amount: {
    label: 'budget' | 'accepted' | 'reserved';
    amountCents: number;
    committedCents?: number;
    reservedCents?: number;
  };
  nextWindow?: { startsAt: string; endsAt: string; timeZone: string };
  detailUrl: string;
  vmUrl?: string;
  retryUrl?: string;
}

export interface OrdersPage {
  items: OrderListItem[];
  nextCursor?: string;
  serverNow: string;
}
