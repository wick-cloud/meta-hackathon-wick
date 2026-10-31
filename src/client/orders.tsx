import { TableViewport } from './table';
import { useEffect, useMemo, useState } from 'react';
import {
  ArrowLeft,
  ArrowRight,
  CalendarClock,
  Clock3,
  Layers3,
  ListOrdered,
  Plus,
  Radio,
  RefreshCw,
  RotateCcw,
  SquareTerminal,
  Wallet,
  Sparkles,
} from 'lucide-react';
import type {
  OrderCreatedFilter,
  OrderListItem,
  OrdersPage,
  OrderStatusFilter,
} from '../shared/orders';
import { dateTime, money } from './api';
import {
  EmptyState,
  ErrorBox,
  Link,
  Spinner,
  StatusPill,
  remaining,
  useNavigate,
  useNow,
  useResource,
} from './components';
import './market.css';
import { PurchaseCards } from './purchases';
import { ArchiveNote, RecordViews } from './record-views';

const choices = <T extends string>(value: string | null, allowed: readonly T[], fallback: T): T =>
  allowed.includes(value as T) ? (value as T) : fallback;
const shortTime = (value: string, timeZone?: string) =>
  new Date(value).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZoneName: 'short',
    ...(timeZone ? { timeZone } : {}),
  });
const shortDay = (value: string) =>
  new Date(value).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
const liveAuction = (item: OrderListItem) =>
  item.kind === 'token'
    ? item.tokenMode === 'auction' && item.status === 'open'
    : item.kind === 'auction' && item.auctionStatus === 'open';

export function Orders({ search }: { search: string }) {
  const navigate = useNavigate(),
    now = useNow(),
    query = new URLSearchParams(search);
  const kind = choices(query.get('kind'), ['all', 'auction', 'agreement', 'token'] as const, 'all');
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
  const live = items.some(liveAuction);
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
  const filtered = kind !== 'all' || status !== 'all' || created !== 'all';
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
    <div className="orders-workspace">
      <header className="orders-header">
        <div>
          <div className="orders-title-line">
            <h1>Orders</h1>
            {list.data && (
              <span
                className="orders-count"
                aria-label={`${items.length} orders shown on this page`}
              >
                {items.length} shown
              </span>
            )}
          </div>
          <p>Your VMs and AI token packs, from first bid to completion.</p>
        </div>
        <div className="orders-header-actions">
          <Link href="/credits" className="orders-wallet">
            <Wallet size={15} />
            Broker wallet
          </Link>
          <Link href="/new" className="button primary">
            <Plus size={16} />
            New purchase
          </Link>
        </div>
      </header>
      {!filtered && !cursor && list.data && !items.length && <PurchaseCards compact />}
      <div className="purchase-history-heading">
        <h2>Order history</h2>
        <p>Track purchases, live auctions and scheduled VM bookings.</p>
      </div>
      <section className="card market-orders">
        <div className="record-view-bar">
          <RecordViews
            label="Order views"
            value={status === 'history' ? 'archive' : status === 'attention' ? null : status}
            onChange={(view) => filter('status', view === 'archive' ? 'history' : view)}
          />
        </div>
        {status === 'history' && (
          <ArchiveNote>
            Completed, cancelled and unmatched purchases. Order details and billing history remain
            available.
          </ArchiveNote>
        )}
        <div className="market-filterbar orders-filters">
          <div className="orders-filter-fields">
            <label className="field">
              <span>Type</span>
              <select
                aria-label="Order type"
                value={kind}
                onChange={(e) => filter('kind', e.target.value)}
              >
                <option value="all">All types</option>
                <option value="auction">VM auctions</option>
                <option value="agreement">Scheduled VMs</option>
                <option value="token">AI token packs</option>
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
                <option value="history">Archive</option>
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
            {filtered && (
              <button className="text-button orders-clear" onClick={() => navigate('/orders')}>
                Clear filters
              </button>
            )}
          </div>
          <button
            className="button secondary small orders-refresh"
            disabled={list.refreshing}
            aria-busy={list.refreshing}
            onClick={list.reload}
          >
            <RefreshCw size={14} className={list.refreshing ? 'spin' : undefined} />
            Refresh
          </button>
        </div>
        {list.error && (
          <div className="orders-error">
            <ErrorBox error={list.error} retry={list.reload} />
          </div>
        )}
        {list.loading ? (
          <div className="orders-loading">
            <span className="sr-only">
              <Spinner label="Loading orders" />
            </span>
            <div aria-hidden="true">
              {Array.from({ length: 4 }, (_, i) => (
                <div className="orders-skeleton-row" key={i}>
                  <span />
                  <div>
                    <i />
                    <i />
                  </div>
                  <span />
                  <span />
                </div>
              ))}
            </div>
          </div>
        ) : items.length ? (
          <>
            <TableViewport
              label="Orders"
              minWidth={920}
              className="market-table-scroll orders-table-scroll"
              tabIndex={0}
              role="region"
              aria-label="Orders table, scroll horizontally for more columns"
            >
              <table className="market-table orders-table">
                <caption className="sr-only">
                  Orders on this page, newest first. Opening an order is read-only.
                </caption>
                <thead>
                  <tr>
                    <th scope="col">Order</th>
                    <th scope="col">Status</th>
                    <th scope="col" className="orders-amount-head numeric-cell">
                      Price / credit · USD
                    </th>
                    <th scope="col">Timing</th>
                    <th className="actions-cell" scope="col">
                      <span className="sr-only">Open</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((item) => (
                    <tr key={item.key}>
                      <td className="orders-identity-cell">
                        <div className="orders-identity">
                          <span className={`orders-kind-icon ${item.kind}`} aria-hidden="true">
                            {item.kind === 'agreement' ? (
                              <Layers3 size={16} />
                            ) : item.kind === 'token' ? (
                              <Sparkles size={16} />
                            ) : (
                              <Radio size={16} />
                            )}
                          </span>
                          <div className="orders-identity-copy">
                            <Link
                              href={item.detailUrl}
                              className="market-order-title"
                              title={item.title}
                            >
                              {item.title || 'Environment order'}
                            </Link>
                            <div className="orders-reference">
                              <span>
                                {item.kind === 'agreement'
                                  ? '7-day agreement'
                                  : item.kind === 'token'
                                    ? `AI tokens · ${item.tokenMode === 'instant' ? 'Instant' : 'Auction'}`
                                    : 'Instant auction'}
                              </span>
                              {item.source?.kind === 'api_key' && (
                                <span title={`Created through Broker API key ${item.source.keyId}`}>
                                  API
                                </span>
                              )}
                              <code title={`Created ${dateTime(item.createdAt)}`}>
                                {item.reference}
                              </code>
                            </div>
                            {item.kind === 'token' && (
                              <div className="orders-created">
                                {item.modelId} · {(item.inputTokens ?? 0).toLocaleString()} input /{' '}
                                {(item.outputTokens ?? 0).toLocaleString()} output
                              </div>
                            )}
                            <time
                              className="orders-created"
                              dateTime={item.createdAt}
                              title={dateTime(item.createdAt)}
                            >
                              Created {shortDay(item.createdAt)}
                            </time>
                          </div>
                        </div>
                      </td>
                      <td>
                        <div className="orders-status-cell">
                          {item.kind === 'agreement' && item.status === 'open' ? (
                            <span className="status-pill status-open">
                              <span />
                              Pending matching
                            </span>
                          ) : (
                            <StatusPill status={item.status} />
                          )}
                          <div className="orders-status-meta">
                            {item.kind === 'agreement' ? (
                              <>
                                <span>
                                  {item.approvedQuantity} approved{' '}
                                  <span className="orders-separator">/</span>{' '}
                                  {item.requestedQuantity} target
                                </span>
                                <span>{item.runningQuantity} running</span>
                              </>
                            ) : (
                              <>
                                <span>
                                  {item.bidCount} {item.bidCount === 1 ? 'bid' : 'bids'}
                                </span>
                                {item.kind !== 'token' && item.vmStatus && (
                                  <span>VM {item.vmStatus}</span>
                                )}
                              </>
                            )}
                            {(item.status === 'ending' ||
                              (item.vmStatus === 'failed' && item.cleanupPending)) && (
                              <span className="orders-cleanup">Cleanup pending</span>
                            )}
                          </div>
                        </div>
                      </td>
                      <td className="orders-amount-cell numeric-cell">
                        <strong>
                          {money(
                            item.amount.label === 'reserved'
                              ? (item.amount.reservedCents ?? item.amount.amountCents)
                              : item.amount.amountCents,
                          )}
                        </strong>
                        <div className="orders-amount-label">
                          {item.amount.label === 'budget'
                            ? 'Maximum total budget'
                            : item.amount.label === 'accepted'
                              ? 'Accepted total price'
                              : 'Broker credit reserved'}
                        </div>
                        {item.amount.label === 'reserved' && (
                          <div className="orders-amount-detail">
                            Full-term maximum {money(item.amount.amountCents)}
                          </div>
                        )}
                        {item.amount.committedCents !== undefined && (
                          <div className="orders-amount-detail">
                            {money(item.amount.committedCents)} committed
                          </div>
                        )}
                      </td>
                      <td className="orders-timing-cell">
                        {liveAuction(item) ? (
                          <>
                            <span className="orders-time-label">Auction closes in</span>
                            <strong className="market-live orders-countdown">
                              <Clock3 size={13} />
                              {item.closesAt
                                ? remaining(item.closesAt, now + serverOffset)
                                : 'Closing'}
                            </strong>
                            {item.closesAt && (
                              <time dateTime={item.closesAt}>{shortTime(item.closesAt)}</time>
                            )}
                          </>
                        ) : item.nextWindow ? (
                          <>
                            <span className="orders-time-label">
                              <CalendarClock size={12} />
                              Next window
                            </span>
                            <time
                              className="orders-time-primary"
                              dateTime={item.nextWindow.startsAt}
                              title={item.nextWindow.timeZone}
                            >
                              {shortTime(item.nextWindow.startsAt, item.nextWindow.timeZone)}
                            </time>
                            <span className="orders-time-note">{item.nextWindow.timeZone}</span>
                          </>
                        ) : (
                          <>
                            <span className="orders-time-label">
                              {item.expiresAt
                                ? item.kind === 'agreement'
                                  ? 'Agreement expiry'
                                  : item.kind === 'token'
                                    ? 'Pack expiry'
                                    : 'Rental expiry'
                                : 'Created'}
                            </span>
                            <time
                              className="orders-time-primary"
                              dateTime={item.expiresAt ?? item.createdAt}
                            >
                              {shortTime(item.expiresAt ?? item.createdAt)}
                            </time>
                          </>
                        )}
                      </td>
                      <td className="orders-actions-cell actions-cell">
                        <div className="market-row-actions">
                          <Link
                            href={item.detailUrl}
                            className="button secondary small orders-view"
                          >
                            View
                            <ArrowRight size={13} />
                          </Link>
                          {item.kind !== 'token' && item.vmUrl && (
                            <Link href={item.vmUrl} className="text-link orders-secondary-action">
                              <SquareTerminal size={12} />
                              Environment
                            </Link>
                          )}
                          {item.kind !== 'token' && item.retryUrl && (
                            <Link
                              href={item.retryUrl}
                              className="text-link orders-secondary-action"
                            >
                              <RotateCcw size={12} />
                              Try again · review
                            </Link>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableViewport>
          </>
        ) : (
          <div className="orders-empty">
            <EmptyState
              icon={<ListOrdered size={22} />}
              title={status === 'history' ? 'No archived orders yet' : 'No orders in this view'}
              description={
                status === 'history'
                  ? 'Completed orders appear here. Live auctions and pending cleanup stay in Active.'
                  : filtered
                    ? 'No orders match these filters. Clear them to return to the full list.'
                    : 'Your VM auctions, scheduled agreements and AI token orders will appear here.'
              }
            >
              {status === 'history' ? (
                <button className="button secondary" onClick={() => filter('status', 'active')}>
                  View active orders
                </button>
              ) : filtered ? (
                <button className="button secondary" onClick={() => navigate('/orders')}>
                  Clear filters
                </button>
              ) : (
                <Link href="/new" className="button primary">
                  <Plus size={15} />
                  New purchase
                </Link>
              )}
            </EmptyState>
          </div>
        )}
        <footer className="market-pagination orders-pagination">
          <div className="orders-page-summary">
            <span>
              {items.length} orders on this page <span className="orders-separator">·</span> Newest
              first
            </span>
            <span className="orders-update-status">
              {list.error
                ? 'Refresh needed'
                : list.refreshing
                  ? 'Refreshing…'
                  : list.updatedAt
                    ? `Updated ${new Date(list.updatedAt).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', timeZoneName: 'short' })}`
                    : 'Loading…'}
              {!list.error && !list.refreshing && changing && (
                <span className="orders-auto-update"> · Auto refresh {live ? '2s' : '5s'}</span>
              )}
            </span>
          </div>
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
        </footer>
      </section>
    </div>
  );
}
