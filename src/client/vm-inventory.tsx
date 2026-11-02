import {
  TableViewport,
  TablePanel,
  TableToolbar,
  TableTabs,
  TableFooter,
  TableIdentity,
  TableActions,
  TableState,
} from './table';
import { useEffect, useMemo, useState, type FormEvent } from 'react';
import {
  ArrowDownWideNarrow,
  ArrowLeft,
  ArrowRight,
  Check,
  Copy,
  Plus,
  RefreshCw,
  Search,
  Server,
  SquareTerminal,
  Trash2,
  X,
} from 'lucide-react';
import type { VMInventoryItem, VMInventoryPage } from '../shared/vm-inventory';
import { vmStatuses } from '../shared/vm-inventory';
import {
  ApiError,
  cloudRouteName,
  dateTime,
  money,
  post,
  regionName,
  rentalSourceLabel,
} from './api';
import {
  ErrorBox,
  Link,
  MarketDialog,
  Spinner,
  StatusPill,
  SuccessBox,
  remaining,
  useNavigate,
  useNow,
  useResource,
  useSession,
} from './components';
import './vm-inventory.css';
import { ArchiveNote, RecordViews } from './record-views';

export function MyVMs({ search = '' }: { search?: string }) {
  const navigate = useNavigate(),
    session = useSession(),
    now = useNow();
  const query = new URLSearchParams(search);
  const status = query.get('status') ?? 'all',
    provider = query.get('provider') ?? 'all';
  const sort = query.get('sort') === 'oldest' ? 'oldest' : 'newest',
    term = query.get('search') ?? '';
  const params = new URLSearchParams({ limit: '25', status, provider, sort });
  if (term) params.set('search', term);
  if (query.get('cursor')) params.set('cursor', query.get('cursor')!);
  if (query.get('before')) params.set('before', query.get('before')!);
  const list = useResource<VMInventoryPage>(`/api/vm-inventory?${params}`, 5000);
  const items = list.data?.items ?? [];
  const clockOffset = useMemo(
    () => (list.data ? Date.parse(list.data.serverNow) - Date.now() : 0),
    [list.data?.serverNow],
  );
  const displayNow = now + clockOffset;
  const [searchText, setSearchText] = useState(term),
    [copied, setCopied] = useState(''),
    [notice, setNotice] = useState('');
  const [confirm, setConfirm] = useState<{ vm: VMInventoryItem; operationKey: string } | null>(
      null,
    ),
    [busy, setBusy] = useState(false),
    [actionError, setActionError] = useState('');
  useEffect(() => {
    setSearchText(term);
  }, [term]);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(''), 2000);
    return () => clearTimeout(timer);
  }, [copied]);
  useEffect(() => {
    setConfirm(null);
    setActionError('');
  }, [search]);
  const providers = useMemo(
    () =>
      [
        ...new Set([
          ...session.catalog.map((c) => c.provider),
          ...items.map((v) => v.provider).filter((v): v is string => !!v),
          ...(provider !== 'all' ? [provider] : []),
        ]),
      ].sort(),
    [session.catalog, items, provider],
  );
  const filtered = status !== 'all' || provider !== 'all' || !!term;
  const paged = query.has('cursor') || query.has('before');
  function filter(changes: Record<string, string>) {
    const next = new URLSearchParams(search);
    next.delete('cursor');
    next.delete('before');
    for (const [key, value] of Object.entries(changes))
      value && value !== 'all' ? next.set(key, value) : next.delete(key);
    navigate(`/vms${next.size ? `?${next}` : ''}`);
  }
  function page(cursor: string, backwards = false) {
    const next = new URLSearchParams(search);
    next.delete('cursor');
    next.delete('before');
    next.set(backwards ? 'before' : 'cursor', cursor);
    navigate(`/vms?${next}`);
  }
  function submitSearch(event: FormEvent) {
    event.preventDefault();
    filter({ search: searchText.trim() });
  }
  async function copyId(vm: VMInventoryItem) {
    try {
      await navigator.clipboard.writeText(vm.id);
      setCopied(vm.id);
    } catch {
      setActionError('Could not copy the VM ID. Open the environment to select and copy it.');
    }
  }
  async function terminate() {
    if (!confirm || busy) return;
    setBusy(true);
    setActionError('');
    try {
      await post(`/api/vms/${confirm.vm.id}/terminate`, { operationKey: confirm.operationKey });
      setNotice('Termination requested. Capacity stays held until cleanup is confirmed.');
      setConfirm(null);
      list.reload();
    } catch (err) {
      setActionError(
        err instanceof ApiError && err.status < 500
          ? err.message
          : 'The response could not be confirmed. Refresh the list to check its state, or retry this same request.',
      );
      list.reload();
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="vm-workspace">
      <header className="vm-page-header">
        <div>
          <div className="vm-title-line">
            <h1>Virtual machines</h1>
            {list.data && <span className="vm-page-count">{items.length} shown</span>}
          </div>
          <p>Manage your environments, terminals and rental deadlines.</p>
        </div>
        <div className="vm-header-actions">
          <Link href="/orders" className="button secondary">
            View orders
          </Link>
          <Link href="/new/vm" className="button primary">
            <Plus size={16} />
            Create VM
          </Link>
        </div>
      </header>
      {notice && <SuccessBox>{notice}</SuccessBox>}
      <span className="sr-only" role="status">
        {copied ? 'VM ID copied.' : ''}
      </span>
      {!confirm && <ErrorBox error={actionError} />}
      <TablePanel className="vm-inventory-panel" label="VM inventory">
        <TableTabs
          actions={
            <button
              className="icon-button"
              aria-label="Refresh VMs"
              aria-busy={list.refreshing}
              disabled={list.refreshing}
              onClick={list.reload}
            >
              <RefreshCw size={16} className={list.refreshing ? 'spin' : undefined} />
            </button>
          }
        >
          <RecordViews
            label="VM views"
            value={
              status === 'past'
                ? 'archive'
                : status === 'all' || status === 'active'
                  ? status
                  : null
            }
            onChange={(view) => filter({ status: view === 'archive' ? 'past' : view })}
          />
        </TableTabs>
        {status === 'past' && (
          <ArchiveNote>
            Completed VMs and their rental history. VMs awaiting cleanup stay in Active.
          </ArchiveNote>
        )}
        <TableToolbar label="Search and filter virtual machines">
          <form className="vm-search" role="search" onSubmit={submitSearch}>
            <Search size={16} />
            <input
              type="search"
              aria-label="Search VMs"
              placeholder="Search by name or VM ID…"
              maxLength={100}
              value={searchText}
              onChange={(e) => setSearchText(e.target.value)}
            />
            {searchText && (
              <button
                type="button"
                aria-label="Clear VM search"
                onClick={() => {
                  setSearchText('');
                  filter({ search: '' });
                }}
              >
                <X size={14} />
              </button>
            )}
            <button type="submit" className="vm-search-submit">
              Search
            </button>
          </form>
          <div className="vm-table-filters">
            <select
              aria-label="Filter VMs by provider"
              value={provider}
              onChange={(e) => filter({ provider: e.target.value })}
            >
              <option value="all">All providers</option>
              {providers.map((p) => (
                <option value={p} key={p}>
                  {p === 'provider-blaxel' ? 'Baseten (Blaxel)' : cloudRouteName(p)}
                </option>
              ))}
            </select>
            <select
              aria-label="Filter VMs by status"
              value={status}
              onChange={(e) => filter({ status: e.target.value })}
            >
              <option value="all">All statuses</option>
              <option value="active">Active</option>
              <option value="past">Archive</option>
              {vmStatuses.map((s) => (
                <option value={s} key={s}>
                  {s[0]!.toUpperCase() + s.slice(1)}
                </option>
              ))}
            </select>
            <button
              className="button secondary small"
              onClick={() => filter({ sort: sort === 'newest' ? 'oldest' : 'newest' })}
            >
              <ArrowDownWideNarrow size={14} />
              {sort === 'newest' ? 'Newest first' : 'Oldest first'}
            </button>
            {filtered && (
              <button className="text-button" onClick={() => navigate('/vms')}>
                Clear filters
              </button>
            )}
          </div>
        </TableToolbar>
        <ErrorBox error={list.data ? list.error : ''} retry={list.reload} />
        {!list.data && list.error ? (
          <TableState error={list.error} onRetry={list.reload} />
        ) : list.loading ? (
          <div className="vm-list-empty">
            <TableState loading title="Loading VMs" />
          </div>
        ) : !items.length ? (
          <TableState
            title={
              paged
                ? 'No VMs on this page'
                : status === 'past'
                  ? 'No archived VMs yet'
                  : filtered
                    ? 'No VMs match these filters'
                    : 'Your first VM starts here'
            }
            description={
              paged
                ? 'Return to the first page to see the latest matching VMs.'
                : status === 'past'
                  ? 'Completed VMs appear here after cleanup is confirmed.'
                  : filtered
                    ? 'Try another name, ID, provider or status.'
                    : 'Launch an environment to access your own terminal and track it here.'
            }
          >
            {paged ? (
              <button className="button secondary" onClick={() => filter({})}>
                First page
              </button>
            ) : status === 'past' ? (
              <button className="button secondary" onClick={() => filter({ status: 'active' })}>
                View active VMs
              </button>
            ) : filtered ? (
              <button className="button secondary" onClick={() => navigate('/vms')}>
                Clear filters
              </button>
            ) : (
              <Link href="/new/vm" className="button primary">
                <Plus size={16} />
                Create VM
              </Link>
            )}
          </TableState>
        ) : (
          <>
            <TableViewport
              label="Virtual machines"
              minWidth={940}
              className="vm-table-scroll"
              tabIndex={0}
              role="region"
              aria-label="Virtual machines table"
            >
              <table className="vm-table">
                <caption className="sr-only">
                  Your virtual machines, with status, provider, resources, expiry and actions
                </caption>
                <thead>
                  <tr>
                    <th scope="col">Environment</th>
                    <th scope="col">Status</th>
                    <th scope="col">Location</th>
                    <th scope="col">Resources</th>
                    <th scope="col">Expires</th>
                    <th scope="col" className="numeric-cell">
                      Total price
                    </th>
                    <th scope="col" className="actions-cell">
                      Actions
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((vm) => {
                    const expired = !!vm.expiresAt && Date.parse(vm.expiresAt) <= displayNow;
                    const running = vm.status === 'running' && !expired && !vm.cleanupPending;
                    const canTerminate =
                      ['running', 'provisioning'].includes(vm.status) && !vm.cleanupPending;
                    const ongoing = ['running', 'provisioning'].includes(vm.status) && !expired;
                    const closingSoon =
                      ongoing && !!vm.expiresAt && Date.parse(vm.expiresAt) - displayNow <= 300000;
                    const route = vm.provider ? cloudRouteName(vm.provider) : '';
                    const showRoute =
                      route &&
                      vm.providerName &&
                      route.toLowerCase() !== vm.providerName.toLowerCase();
                    return (
                      <tr
                        key={vm.id}
                        className={!ongoing && !vm.cleanupPending ? 'vm-history-row' : undefined}
                      >
                        <td>
                          <TableIdentity
                            icon={<Server size={17} />}
                            title={
                              <Link href={`/vms/${vm.id}`} className="vm-name" title={vm.name}>
                                {vm.name}
                              </Link>
                            }
                            subtitle={
                              <div className="vm-id-line">
                                <code title={vm.id}>{vm.id.slice(0, 8)}</code>
                                <button
                                  className="vm-copy-id"
                                  aria-label={`Copy VM ID ${vm.id}`}
                                  onClick={() => void copyId(vm)}
                                >
                                  {copied === vm.id ? <Check size={12} /> : <Copy size={12} />}
                                </button>
                                <span aria-hidden="true">·</span>
                                <time
                                  dateTime={vm.createdAt}
                                  title={`Created ${dateTime(vm.createdAt)}`}
                                >
                                  {new Date(vm.createdAt).toLocaleDateString(undefined, {
                                    month: 'short',
                                    day: 'numeric',
                                  })}
                                </time>
                                {vm.sourceMode === 'fixture' ? (
                                  <span
                                    className="vm-demo-label"
                                    title={rentalSourceLabel(vm.sourceMode)}
                                  >
                                    Demo
                                  </span>
                                ) : (
                                  <span className="sr-only">
                                    {rentalSourceLabel(vm.sourceMode)}
                                  </span>
                                )}
                              </div>
                            }
                          />
                        </td>
                        <td>
                          <StatusPill
                            status={
                              expired && ['running', 'provisioning'].includes(vm.status)
                                ? 'expired'
                                : vm.status
                            }
                          />
                          {vm.cleanupPending && (
                            <small className="vm-cell-note">Cleanup pending</small>
                          )}
                        </td>
                        <td>
                          <strong
                            className="vm-cell-primary"
                            title={vm.providerName || route || undefined}
                          >
                            {vm.providerName || route || '—'}
                          </strong>
                          <small
                            className="vm-cell-note"
                            title={showRoute ? `Native route: ${route}` : undefined}
                          >
                            {vm.region ? regionName(vm.region) : '—'}
                            {showRoute ? ` · ${route}` : ''}
                          </small>
                        </td>
                        <td>
                          <span className="vm-resource-value">
                            {vm.cpu === null ? '—' : `${vm.cpu} vCPU`}
                          </span>
                          {vm.memoryGb !== null && (
                            <small className="vm-cell-note">{vm.memoryGb} GiB</small>
                          )}
                          {vm.gpu && (
                            <small className="vm-cell-note" title={vm.gpu}>
                              {vm.gpu}
                            </small>
                          )}
                        </td>
                        <td>
                          <span
                            className={`vm-time ${closingSoon ? 'expiring' : ''}`}
                            title={vm.expiresAt ? dateTime(vm.expiresAt) : undefined}
                          >
                            {ongoing
                              ? remaining(vm.expiresAt, displayNow)
                              : vm.expiresAt
                                ? 'Ended'
                                : '—'}
                          </span>
                          {vm.expiresAt && (
                            <small className="vm-cell-note">
                              {new Date(vm.expiresAt).toLocaleString(undefined, {
                                ...(ongoing ? {} : { month: 'short', day: 'numeric' }),
                                hour: '2-digit',
                                minute: '2-digit',
                              })}
                            </small>
                          )}
                        </td>
                        <td className="numeric-cell">
                          <span
                            className="vm-fixed-price"
                            title={
                              vm.billingSource === 'scheduled_capacity'
                                ? 'Booked capacity window'
                                : 'Fixed total for the full rental'
                            }
                          >
                            {vm.priceCents === null ? '—' : money(vm.priceCents)}
                          </span>
                          {vm.billingSource === 'scheduled_capacity' && (
                            <small className="vm-cell-note">Booked window</small>
                          )}
                        </td>
                        <td className="actions-cell">
                          <TableActions>
                            <Link
                              href={`/vms/${vm.id}`}
                              className={running ? 'button secondary small' : 'vm-details-link'}
                              aria-label={`${running ? 'Open terminal' : 'Open environment'} ${vm.name}`}
                            >
                              {running ? <SquareTerminal size={14} /> : <ArrowRight size={14} />}
                              <span>{running ? 'Terminal' : 'Details'}</span>
                            </Link>
                            {canTerminate && (
                              <button
                                className="icon-button vm-terminate"
                                aria-label={`Terminate ${vm.name}`}
                                title="Terminate VM"
                                onClick={() => {
                                  setActionError('');
                                  setConfirm({ vm, operationKey: crypto.randomUUID() });
                                }}
                              >
                                <Trash2 size={15} />
                              </button>
                            )}
                          </TableActions>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </TableViewport>
          </>
        )}
        {list.data && (
          <TableFooter count={items.length} noun={items.length === 1 ? 'VM' : 'VMs'}>
            <div>
              <button
                className="button secondary small"
                disabled={!list.data.previousCursor}
                onClick={() => page(list.data!.previousCursor!, true)}
              >
                <ArrowLeft size={14} />
                Previous
              </button>
              <button
                className="button secondary small"
                disabled={!list.data.nextCursor}
                onClick={() => page(list.data!.nextCursor!)}
              >
                Next
                <ArrowRight size={14} />
              </button>
            </div>
          </TableFooter>
        )}
      </TablePanel>
      {confirm && (
        <MarketDialog
          titleId="terminate-vm-title"
          busy={busy}
          onClose={() => {
            setConfirm(null);
            setActionError('');
          }}
        >
          <h2 id="terminate-vm-title">Terminate {confirm.vm.name}?</h2>
          <p className="vm-terminate-copy">
            Terminal access will end and this environment’s files will be deleted. Capacity remains
            held until cleanup is confirmed.
          </p>
          <ErrorBox error={actionError} />
          <div className="vm-dialog-actions">
            <button className="button secondary" disabled={busy} onClick={() => setConfirm(null)}>
              Cancel
            </button>
            <button className="button danger" disabled={busy} onClick={() => void terminate()}>
              {busy ? <Spinner label="Requesting termination" /> : 'Confirm termination'}
            </button>
          </div>
        </MarketDialog>
      )}
    </div>
  );
}
