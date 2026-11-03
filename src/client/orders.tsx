import {
  TableViewport,
  TablePanel,
  TableToolbar,
  TableTabs,
  TableFooter,
  TableActions,
  TableIdentity,
  TableState,
  TableStatus,
} from './table';
import { useEffect, useMemo, useState } from 'react';
import {
  ArrowLeft,
  ArrowRight,
  CalendarClock,
  Clock3,
  Layers3,
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
  ErrorBox,
  Link,
  PageHeader,
  StatusPill,
  remaining,
  useNavigate,
  useNow,
  useResource,
} from './components';
import './market.css';
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
  const kind = choices(query.get('kind'), ['all', 'auction', 'token'] as const, 'all');
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
    <div className="inventory-page orders-workspace">
      <PageHeader
        eyebrow="PURCHASES"
        title="Orders"
        description="Your VMs and AI token packs, from first bid to completion."
      >
        <Link href="/credits" className="button secondary">
          <Wallet size={15} />
          Broker wallet
        </Link>
        <Link href="/new" className="button primary">
          <Plus size={16} />
          New purchase
        </Link>
      </PageHeader>
      <TablePanel className="market-orders" label="Orders">
        <TableTabs
          actions={
            <button
              className="icon-button"
              aria-label="Refresh"
              title="Refresh orders"
              disabled={list.refreshing}
              aria-busy={list.refreshing}
              onClick={list.reload}
            >
              <RefreshCw size={16} className={list.refreshing ? 'spin' : undefined} />
            </button>
          }
        >
          <RecordViews
            label="Order views"
            value={status === 'history' ? 'archive' : status === 'attention' ? null : status}
            onChange={(view) => filter('status', view === 'archive' ? 'history' : view)}
          />
        </TableTabs>
        {status === 'history' && (
          <ArchiveNote>
            Completed, cancelled and unmatched purchases. Order details and billing history remain
            available.
          </ArchiveNote>
        )}
        <TableToolbar label="Filter orders">
          <div className="orders-filter-fields">
            <select
              aria-label="Order type"
              value={kind}
              onChange={(e) => filter('kind', e.target.value)}
            >
              <option value="all">All types</option>
              <option value="auction">VM auctions</option>
              <option value="token">AI token packs</option>
            </select>
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
            {filtered && (
              <button className="text-button orders-clear" onClick={() => navigate('/orders')}>
                Clear filters
              </button>
            )}
          </div>
        </TableToolbar>
        {list.error && list.data && (
          <div className="orders-error">
            <ErrorBox error={list.error} retry={list.reload} />
          </div>
        )}
        {list.loading ? (
          <TableState loading title="Loading orders" />
        ) : !list.data && list.error ? (
          <TableState error={list.error} onRetry={list.reload} />
        ) : items.length ? (
          <>
            <TableViewport
              label="Orders"
              minWidth={1120}
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
                    <th scope="col">Created</th>
                    <th className="actions-cell" scope="col">
                      <span className="sr-only">Open</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((item) => (
                    <tr key={item.key}>
                      <td className="orders-identity-cell">
                        <TableIdentity
                          icon={
                            item.kind === 'agreement' ? (
                              <Layers3 size={17} />
                            ) : item.kind === 'token' ? (
                              <Sparkles size={17} />
                            ) : (
                              <Radio size={17} />
                            )
                          }
                          title={
                            <Link
                              href={item.detailUrl}
                              className="market-order-title"
                              title={item.title}
                            >
                              {item.title || 'Environment order'}
                            </Link>
                          }
                          subtitle={
                            <>
                              <div className="orders-reference">
                                <span className="orders-kind">
                                  {item.kind === 'agreement'
                                    ? 'Historical capacity booking'
                                    : item.kind === 'token'
                                      ? `AI tokens · ${item.tokenMode === 'instant' ? 'Instant' : 'Auction'}`
                                      : 'VM auction'}
                                </span>
                                {item.source?.kind === 'api_key' && (
                                  <span
                                    title={`Created through Broker API key ${item.source.keyId}`}
                                  >
                                    API
                                  </span>
                                )}
                                <code title={`Created ${dateTime(item.createdAt)}`}>
                                  {item.reference}
                                </code>
                              </div>
                              {item.kind === 'token' && (
                                <div className="orders-token-spec">
                                  <span className="orders-model" title={item.modelId}>
                                    {item.modelId}
                                  </span>
                                  <span>
                                    {(item.inputTokens ?? 0).toLocaleString()} in /{' '}
                                    {(item.outputTokens ?? 0).toLocaleString()} out
                                  </span>
                                </div>
                              )}
                            </>
                          }
                        />
                      </td>
                      <td>
                        <div className="orders-status-cell">
                          {item.kind === 'agreement' && item.status === 'open' ? (
                            <TableStatus tone="warning">Legacy record</TableStatus>
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
                            <strong
                              className="market-live orders-countdown"
                              title={item.closesAt ? dateTime(item.closesAt) : undefined}
                            >
                              <Clock3 size={13} />
                              {item.closesAt
                                ? remaining(item.closesAt, now + serverOffset)
                                : 'Closing'}
                            </strong>
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
                      <td>
                        <time dateTime={item.createdAt} title={dateTime(item.createdAt)}>
                          {shortDay(item.createdAt)}
                        </time>
                      </td>
                      <td className="orders-actions-cell actions-cell">
                        <TableActions>
                          <Link href={item.detailUrl} className="table-open-link">
                            View
                            <ArrowRight size={13} />
                          </Link>
                          {item.kind !== 'token' && item.vmUrl && (
                            <Link
                              href={item.vmUrl}
                              className="icon-button orders-secondary-action"
                              aria-label="Environment"
                              title="Open environment"
                            >
                              <SquareTerminal size={15} />
                            </Link>
                          )}
                          {item.kind !== 'token' && item.retryUrl && (
                            <Link
                              href={item.retryUrl}
                              className="icon-button orders-secondary-action"
                              aria-label="Try again · review"
                              title="Review another auction"
                            >
                              <RotateCcw size={15} />
                            </Link>
                          )}
                        </TableActions>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableViewport>
          </>
        ) : (
          <div className="orders-empty">
            <TableState
              title={status === 'history' ? 'No archived orders yet' : 'No orders in this view'}
              description={
                status === 'history'
                  ? 'Completed orders appear here. Live auctions and pending cleanup stay in Active.'
                  : filtered
                    ? 'No orders match these filters. Clear them to return to the full list.'
                    : 'Your VM auctions and AI token orders will appear here.'
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
            </TableState>
          </div>
        )}
        <TableFooter count={list.data?.items.length} noun="orders">
          <div className="orders-page-summary">
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
        </TableFooter>
      </TablePanel>
    </div>
  );
}
