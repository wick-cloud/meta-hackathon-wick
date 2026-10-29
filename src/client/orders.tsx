import { useEffect, useMemo, useState } from 'react';
import { ArrowLeft, ArrowRight, CalendarClock, ListOrdered, Plus, RefreshCw } from 'lucide-react';
import type {
  OrderCreatedFilter,
  OrderKind,
  OrdersPage,
  OrderStatusFilter,
} from '../shared/orders';
import { dateTime, money } from './api';
import {
  EmptyState,
  ErrorBox,
  Link,
  PageHeader,
  Spinner,
  StatusPill,
  remaining,
  useNavigate,
  useNow,
  useResource,
} from './components';
import './market.css';

const choices = <T extends string>(value: string | null, allowed: readonly T[], fallback: T): T =>
  allowed.includes(value as T) ? (value as T) : fallback;

export function Orders({ search }: { search: string }) {
  const navigate = useNavigate(),
    now = useNow(),
    query = new URLSearchParams(search);
  const kind = choices(query.get('kind'), ['all', 'auction', 'agreement'] as const, 'all');
  const status = choices<OrderStatusFilter>(
    query.get('status'),
    ['all', 'active', 'history', 'attention'],
    'all',
  );
  const created = choices<OrderCreatedFilter>(
    query.get('created'),
    ['all', '24h', '7d', '30d'],
    'all',
  );
  const cursor = query.get('cursor');
  const params = new URLSearchParams({ kind, status, created, limit: '25' });
  if (cursor) params.set('cursor', cursor);
  const [poll, setPoll] = useState(0);
  const list = useResource<OrdersPage>(`/api/orders?${params}`, poll);
  // The API owns ordering and the opaque cursor. Never sort or merge source IDs here.
  const items = list.data?.items ?? [];
  const serverOffset = useMemo(
    () => (list.data ? new Date(list.data.serverNow).getTime() - Date.now() : 0),
    [list.data?.serverNow],
  );
  const live = items.some((item) => item.kind === 'auction' && item.auctionStatus === 'open');
  const changing =
    live ||
    items.some((item) =>
      item.kind === 'agreement'
        ? ['open', 'approved', 'active', 'needs_credit', 'credit_release_pending'].includes(
            item.status,
          )
        : item.cleanupPending ||
          ['provisioning', 'running', 'ending', 'closing'].includes(item.status),
    );
  useEffect(() => {
    setPoll(live ? 2000 : changing ? 5000 : 0);
  }, [live, changing]);
  function filter(name: string, value: string) {
    const next = new URLSearchParams(search);
    next.set(name, value);
    next.delete('cursor');
    navigate(`/orders?${next}`);
  }
  function page(nextCursor?: string) {
    const next = new URLSearchParams(search);
    if (nextCursor) next.set('cursor', nextCursor);
    else next.delete('cursor');
    navigate(`/orders?${next}`);
  }
  return (
    <>
      <PageHeader
        eyebrow="YOUR MARKETPLACE"
        title="Every order. One place."
        description="Follow instant auctions and scheduled capacity from first request to final credit release."
      >
        <Link href="/new" className="button primary">
          <Plus size={16} /> New order
        </Link>
      </PageHeader>
      <div className="market-order-intro">
        <span className="icon-tile emerald">
          <ListOrdered size={20} />
        </span>
        <div>
          <strong>Your order history stays here.</strong>
          <p>
            Opening an order only shows its details. Starting a new auction or launching scheduled
            VMs always needs your explicit review.
          </p>
        </div>
        <Link className="text-link" href="/credits">
          Broker wallet <ArrowRight size={14} />
        </Link>
      </div>
      <section className="card market-orders">
        <div className="market-filterbar">
          <label className="field">
            <span>Order type</span>
            <select
              aria-label="Order type"
              value={kind}
              onChange={(e) => filter('kind', e.target.value)}
            >
              <option value="all">All types</option>
              <option value="auction">Instant auctions</option>
              <option value="agreement">Scheduled agreements</option>
            </select>
          </label>
          <label className="field">
            <span>Status</span>
            <select
              aria-label="Order status"
              value={status}
              onChange={(e) => filter('status', e.target.value)}
            >
              <option value="all">All statuses</option>
              <option value="active">Active</option>
              <option value="attention">Needs attention</option>
              <option value="history">History</option>
            </select>
          </label>
          <label className="field">
            <span>Created</span>
            <select
              aria-label="Order created"
              value={created}
              onChange={(e) => filter('created', e.target.value)}
            >
              <option value="all">Any time</option>
              <option value="24h">Last 24 hours</option>
              <option value="7d">Last 7 days</option>
              <option value="30d">Last 30 days</option>
            </select>
          </label>
          <button className="button secondary small" onClick={list.reload}>
            <RefreshCw size={14} />
            Refresh
          </button>
        </div>
        <ErrorBox error={list.error} retry={list.reload} />
        {list.loading ? (
          <Spinner label="Loading orders" />
        ) : items.length ? (
          <div className="market-table-scroll">
            <table className="market-table">
              <thead>
                <tr>
                  <th>Order</th>
                  <th>Status & capacity</th>
                  <th>Price / credit</th>
                  <th>Timing</th>
                  <th>
                    <span className="sr-only">Open</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {items.map((item) => (
                  <tr key={item.key}>
                    <td>
                      <Link href={item.detailUrl} className="market-order-title">
                        {item.title || 'Environment order'}
                      </Link>
                      <div className="market-meta">
                        {item.kind === 'auction' ? 'Instant auction' : '7-day agreement'} ·{' '}
                        {item.reference}
                      </div>
                      <div className="market-meta">Created {dateTime(item.createdAt)}</div>
                    </td>
                    <td>
                      {item.kind === 'agreement' && item.status === 'open' ? (
                        <span className="status-pill status-open">
                          <span />
                          Pending matching
                        </span>
                      ) : (
                        <StatusPill status={item.status} />
                      )}
                      <div className="market-meta">
                        {item.kind === 'agreement'
                          ? `${item.approvedQuantity} approved · target ${item.requestedQuantity} · ${item.runningQuantity} running`
                          : `${item.bidCount} ${item.bidCount === 1 ? 'bid' : 'bids'}${item.vmStatus ? ` · VM ${item.vmStatus}` : ''}`}
                      </div>
                    </td>
                    <td>
                      <strong>
                        {money(
                          item.amount.label === 'reserved'
                            ? (item.amount.reservedCents ?? item.amount.amountCents)
                            : item.amount.amountCents,
                        )}
                      </strong>
                      <div className="market-meta">
                        {item.amount.label === 'budget'
                          ? 'Maximum total budget'
                          : item.amount.label === 'accepted'
                            ? 'Accepted total price'
                            : 'Broker credit reserved'}
                      </div>
                      {item.amount.label === 'reserved' && (
                        <div className="market-meta">
                          Full-term maximum {money(item.amount.amountCents)}
                        </div>
                      )}
                      {item.amount.committedCents !== undefined && (
                        <div className="market-meta">
                          {money(item.amount.committedCents)} committed
                        </div>
                      )}
                    </td>
                    <td>
                      {item.kind === 'auction' && item.auctionStatus === 'open' ? (
                        <>
                          <strong className="market-live">
                            {remaining(item.closesAt, now + serverOffset)}
                          </strong>
                          <div className="market-meta">Auction closes</div>
                        </>
                      ) : item.nextWindow ? (
                        <>
                          <CalendarClock size={14} />
                          <div className="market-meta">
                            Next {dateTime(item.nextWindow.startsAt)}
                            <br />
                            Schedule: {item.nextWindow.timeZone}
                          </div>
                        </>
                      ) : (
                        <span className="market-meta">
                          {item.expiresAt
                            ? `Ends ${dateTime(item.expiresAt)}`
                            : 'See order for full timing'}
                        </span>
                      )}
                    </td>
                    <td>
                      <div className="market-row-actions">
                        <Link href={item.detailUrl} className="button secondary small">
                          View <ArrowRight size={13} />
                        </Link>
                        {item.vmUrl && (
                          <Link href={item.vmUrl} className="text-link">
                            Environment
                          </Link>
                        )}
                        {item.retryUrl && (
                          <Link href={item.retryUrl} className="text-link">
                            Try again · review
                          </Link>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <EmptyState
            icon={<ListOrdered size={26} />}
            title="No orders in this view"
            description="Adjust the filters or create your first instant auction or scheduled agreement."
          >
            <Link href="/new" className="button primary">
              New order <ArrowRight size={15} />
            </Link>
          </EmptyState>
        )}
        <div className="market-pagination">
          <span>{items.length} orders on this page · newest first</span>
          <div>
            {cursor && (
              <button className="button secondary small" onClick={() => page()}>
                <ArrowLeft size={14} />
                Newest
              </button>
            )}
            {list.data?.nextCursor && (
              <button
                className="button secondary small"
                onClick={() => page(list.data?.nextCursor)}
              >
                Older orders
                <ArrowRight size={14} />
              </button>
            )}
          </div>
        </div>
      </section>
    </>
  );
}
