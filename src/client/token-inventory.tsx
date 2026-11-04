import {
  TableViewport,
  TablePanel,
  TableToolbar,
  TableTabs,
  TableFooter,
  TableIdentity,
  TableState,
  TableStatus,
} from './table';
import { useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, Copy, KeyRound, RefreshCw, Sparkles, X } from 'lucide-react';
import { utf8InputReservation, type InferenceCatalog, type TokenPack } from '../shared/inference';
import {
  buildInferenceJavaScriptExample,
  exampleOutputBudget,
  OUTPUT_LIMIT_GUIDANCE,
  INFERENCE_STARTER_PROMPT,
} from './inference-examples';
import type { BrokerKeySummary } from '../shared/developer';
import { ApiError, dateTime, money, post } from './api';
import {
  ErrorBox,
  Link,
  MarketDialog,
  PageHeader,
  Spinner,
  useNavigate,
  useNow,
  useResource,
} from './components';
import './token-inventory.css';
import { ArchiveNote, RecordViews, type RecordView } from './record-views';

const count = (value: number) => value.toLocaleString('en-US');
const provider = (value: string) =>
  value === 'baseten' ? 'Baseten' : value === 'modal' ? 'Modal' : value;
function timeLeft(expiresAt: string, now: number) {
  const seconds = Math.max(0, Math.ceil((Date.parse(expiresAt) - now) / 1000));
  if (!seconds) return 'Expired';
  const days = Math.floor(seconds / 86400),
    hours = Math.floor((seconds % 86400) / 3600),
    minutes = Math.floor((seconds % 3600) / 60);
  return days
    ? `${days}d ${hours}h left`
    : hours
      ? `${hours}h ${minutes}m left`
      : minutes
        ? `${minutes}m ${seconds % 60}s left`
        : `${seconds}s left`;
}
function status(pack: TokenPack, now: number) {
  if (pack.retirementReason === 'provider_failure') return 'Provider unavailable';
  if (pack.status === 'retiring') return 'Usage pending';
  if (Date.parse(pack.expiresAt) <= now || pack.retirementReason === 'expired') return 'Expired';
  if (pack.retirementReason === 'quota_exhausted') return 'Used up';
  return pack.status === 'active' ? 'Active' : 'Closed';
}
function Quota({ pack, input, usable }: { pack: TokenPack; input: boolean; usable: boolean }) {
  const total = input ? pack.inputTokens : pack.outputTokens;
  const available = input ? pack.availableInputTokens : pack.availableOutputTokens;
  const held = input ? pack.heldInputTokens : pack.heldOutputTokens;
  const used = input ? pack.consumedInputTokens : pack.consumedOutputTokens;
  const retired =
    (input ? pack.retiredInputTokens : pack.retiredOutputTokens) + (usable ? 0 : available);
  return (
    <div className="token-inventory-quota">
      <strong>{count(usable ? available : 0)}</strong>
      <span title={`${count(total)} purchased tokens`}>of {count(total)}</span>
      <small>
        {count(used)} used
        {held > 0 && (
          <>
            {' '}
            · <b>{count(held)} pending</b>
          </>
        )}
        {retired > 0 && <> · {count(retired)} retired</>}
      </small>
    </div>
  );
}
export function TokenInventory({ search }: { search: string }) {
  const query = new URLSearchParams(search),
    cursor = query.get('cursor'),
    connect = query.get('connect'),
    navigate = useNavigate(),
    now = useNow();
  const params = new URLSearchParams({ limit: '25' });
  const view =
    query.get('view') === 'archive' ? 'archive' : query.get('view') === 'active' ? 'active' : 'all';
  if (view !== 'all') params.set('view', view);
  if (cursor) params.set('cursor', cursor);
  const list = useResource<{ items: TokenPack[]; nextCursor?: string }>(
    `/api/inference/packs?${params}`,
    5000,
  );
  function connectUrl(id?: string) {
    const q = new URLSearchParams(search);
    if (id) q.set('connect', id);
    else q.delete('connect');
    return `/tokens${q.size ? `?${q}` : ''}`;
  }
  function listUrl(cursor?: string, selectedView: RecordView = view) {
    const q = new URLSearchParams(search);
    q.delete('cursor');
    q.delete('connect');
    if (cursor) q.set('cursor', cursor);
    if (selectedView === 'all') q.delete('view');
    else q.set('view', selectedView);
    return `/tokens${q.size ? `?${q}` : ''}`;
  }
  return (
    <div className="inventory-page token-inventory">
      <PageHeader
        eyebrow="AI TOKEN INVENTORY"
        title="Purchased tokens"
        description="Every purchased batch, its remaining input and output quota, and the time left to use it."
      >
        <Link href="/token-orders/new" className="button primary">
          <Sparkles size={15} />
          Buy token pack
        </Link>
      </PageHeader>
      <ErrorBox error={list.data ? list.error : ''} retry={list.reload} />
      {list.loading ? (
        <TablePanel label="Purchased token batches">
          <TableState loading title="Loading purchased tokens" />
        </TablePanel>
      ) : !list.data && list.error ? (
        <TablePanel label="Purchased token batches">
          <TableState error={list.error} onRetry={list.reload} />
        </TablePanel>
      ) : (
        list.data && (
          <TablePanel className="token-inventory-card" label="Purchased token batches">
            <TableTabs
              actions={
                <button
                  className="icon-button"
                  aria-label="Refresh token batches"
                  title="Refresh token batches"
                  disabled={list.refreshing}
                  aria-busy={list.refreshing}
                  onClick={list.reload}
                >
                  <RefreshCw size={16} className={list.refreshing ? 'spin' : undefined} />
                </button>
              }
            >
              <RecordViews
                label="Token pack views"
                value={view}
                onChange={(value) => navigate(listUrl(undefined, value))}
              />
            </TableTabs>
            {view === 'archive' && (
              <ArchiveNote>
                Expired, used-up and closed batches after usage settlement. Pending usage stays in
                Active; purchase and refund records remain available.
              </ArchiveNote>
            )}
            <TableToolbar label="Token batch ordering">
              <h2>{view === 'archive' ? 'Archived token batches' : 'Your token batches'}</h2>
              <span>Newest purchases first · 25 per page</span>
            </TableToolbar>
            {list.data.items.length ? (
              <>
                <TableViewport
                  label="Purchased token batches"
                  minWidth={940}
                  className="table-scroll token-inventory-scroll"
                  tabIndex={0}
                  aria-label="Purchased token batches table"
                >
                  <table className="token-inventory-table">
                    <caption className="sr-only">Purchased token batches</caption>
                    <thead>
                      <tr>
                        <th scope="col">Batch</th>
                        <th className="numeric-cell" scope="col">
                          Input available
                        </th>
                        <th className="numeric-cell" scope="col">
                          Output available
                        </th>
                        <th scope="col">Status</th>
                        <th scope="col">Time left</th>
                        <th className="numeric-cell" scope="col">
                          Paid
                        </th>
                        <th className="actions-cell" scope="col">
                          Actions
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {list.data.items.map((pack) => {
                        const usable = pack.status === 'active' && Date.parse(pack.expiresAt) > now;
                        const label = status(pack, now);
                        return (
                          <tr key={pack.id}>
                            <td>
                              <TableIdentity
                                title={provider(pack.provider)}
                                subtitle={
                                  <>
                                    #{pack.id.slice(0, 8)} ·{' '}
                                    {pack.mode === 'fixture'
                                      ? 'Fixture · simulated'
                                      : 'Live provider route'}
                                  </>
                                }
                              />
                              <div className="token-inventory-links">
                                <Link href={`/token-orders/${pack.orderId}`}>View purchase</Link>
                                {pack.fundingSource === 'wallet' ? (
                                  <span>Wallet purchase</span>
                                ) : (
                                  <Link href={`/agents/${pack.grantId}`}>Agent budget</Link>
                                )}
                              </div>
                            </td>
                            <td className="numeric-cell">
                              <Quota pack={pack} input usable={usable} />
                            </td>
                            <td className="numeric-cell">
                              <Quota pack={pack} input={false} usable={usable} />
                            </td>
                            <td>
                              <TableStatus
                                tone={
                                  usable
                                    ? 'success'
                                    : pack.status === 'retiring'
                                      ? 'warning'
                                      : 'neutral'
                                }
                              >
                                {label}
                              </TableStatus>
                            </td>
                            <td>
                              <strong
                                className={
                                  usable && Date.parse(pack.expiresAt) - now <= 900000
                                    ? 'token-expiring'
                                    : ''
                                }
                              >
                                {pack.status === 'settled' && Date.parse(pack.expiresAt) > now
                                  ? 'Closed'
                                  : timeLeft(pack.expiresAt, now)}
                              </strong>
                              <small>
                                <time
                                  dateTime={pack.expiresAt}
                                  title={dateTime(pack.expiresAt)}
                                  aria-label={dateTime(pack.expiresAt)}
                                >
                                  {new Date(pack.expiresAt).toLocaleString(undefined, {
                                    month: 'short',
                                    day: 'numeric',
                                    hour: 'numeric',
                                    minute: '2-digit',
                                  })}
                                </time>
                              </small>
                            </td>
                            <td className="numeric-cell">
                              <strong>{money(pack.priceCents)}</strong>
                              {pack.refundCents > 0 && (
                                <small>{money(pack.refundCents)} refunded</small>
                              )}
                            </td>
                            <td className="actions-cell">
                              {usable ? (
                                <Link
                                  href={connectUrl(pack.id)}
                                  className="button secondary small"
                                  aria-label={`Connect ${provider(pack.provider)} batch ${pack.id.slice(0, 8)}`}
                                >
                                  <KeyRound size={14} />
                                  Connect
                                </Link>
                              ) : (
                                <button
                                  className="button secondary small"
                                  disabled
                                  title="This batch is closed or expired"
                                >
                                  Connect
                                </button>
                              )}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </TableViewport>
                <p className="token-inventory-note">
                  Available excludes tokens reserved for in-flight or unresolved requests. Each
                  batch has its own expiry; unused prepaid quota is not automatically refunded.
                </p>
              </>
            ) : (
              <TableState
                title={
                  view === 'archive' && !cursor
                    ? 'No archived token batches yet'
                    : 'No token batches on this page'
                }
                description={
                  cursor
                    ? 'Return to your newest purchases.'
                    : view === 'archive'
                      ? 'Expired, used-up and closed batches appear here after pending usage settles.'
                      : view === 'active'
                        ? 'No active batches. Previous purchases are available in Archive.'
                        : 'Purchased token packs will appear here after an auction or instant purchase.'
                }
              >
                <Link
                  href={
                    cursor
                      ? listUrl()
                      : view === 'archive'
                        ? listUrl(undefined, 'active')
                        : '/token-orders/new'
                  }
                  className="button primary"
                >
                  {cursor
                    ? 'Newest purchases'
                    : view === 'archive'
                      ? 'View active token packs'
                      : 'Buy token pack'}
                  <ArrowRight size={15} />
                </Link>
              </TableState>
            )}
            <TableFooter count={list.data.items.length} noun="batches">
              {cursor ? (
                <Link href={listUrl()} className="button secondary small">
                  <ArrowLeft size={14} />
                  Newest purchases
                </Link>
              ) : (
                <span />
              )}
              {list.data.nextCursor && (
                <Link href={listUrl(list.data.nextCursor)} className="button secondary small">
                  Older purchases
                  <ArrowRight size={14} />
                </Link>
              )}
            </TableFooter>
          </TablePanel>
        )
      )}
      {connect && (
        <ConnectBatch key={connect} id={connect} onClose={() => navigate(connectUrl())} />
      )}
    </div>
  );
}
interface BatchAccess {
  key: BrokerKeySummary;
  token: string;
  connection: { packId: string; baseUrl: string; model: string; expiresAt: string };
}
function CopyValue({ value, label }: { value: string; label: string }) {
  const [message, setMessage] = useState('');
  return (
    <>
      <button
        type="button"
        className="button secondary small"
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(value);
            setMessage('Copied');
          } catch {
            setMessage('Select the value and copy it manually.');
          }
        }}
      >
        <Copy size={13} />
        {label}
      </button>
      <span className="token-copy-message" role="status">
        {message}
      </span>
    </>
  );
}
function ConnectBatch({ id, onClose }: { id: string; onClose: () => void }) {
  const resource = useResource<TokenPack>(`/api/inference/packs/${encodeURIComponent(id)}`),
    catalog = useResource<InferenceCatalog>('/api/inference/models'),
    now = useNow();
  const [access, setAccess] = useState<BatchAccess | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [uncertain, setUncertain] = useState(false),
    [show, setShow] = useState(false);
  const operation = useRef(crypto.randomUUID()),
    pack = resource.data,
    usable = pack?.status === 'active' && Date.parse(pack.expiresAt) > now;
  async function issue(replacement = false) {
    if (!usable || busy) return;
    if (replacement) operation.current = crypto.randomUUID();
    setBusy(true);
    setError('');
    try {
      const result = await post<BatchAccess>(`/api/inference/packs/${id}/keys`, {
        operationKey: operation.current,
      });
      setAccess(result);
      setUncertain(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The key response could not be confirmed.');
      if (!(err instanceof ApiError) || err.status >= 500 || err.code === 'secret_already_issued')
        setUncertain(true);
    } finally {
      setBusy(false);
    }
  }
  const baseUrl = access?.connection.baseUrl ?? `${window.location.origin}/api/v1`,
    model = access?.connection.model ?? pack?.modelId ?? 'meta/muse-spark-open';
  const route = catalog.data?.routes.find((route) => route.provider === pack?.provider);
  const requiredInput =
    route?.inputAccounting === 'utf8-bytes-v1'
      ? utf8InputReservation(
          [{ role: 'user', content: INFERENCE_STARTER_PROMPT }],
          route.maximumInputReservation ?? route.minimumInputReservation,
        )
      : route?.minimumInputReservation;
  const hasInputQuota =
    pack && requiredInput !== undefined && pack.availableInputTokens >= requiredInput;
  const maxTokens =
    pack && route?.qualified && hasInputQuota
      ? exampleOutputBudget({
          availableOutputTokens: pack.availableOutputTokens,
          minimumOutputTokens: route.minimumOutputTokens,
          maximumOutputTokens: route.maximumOutputTokens,
        })
      : null;
  const setup =
    maxTokens === null
      ? null
      : buildInferenceJavaScriptExample({
          baseURL: baseUrl,
          model,
          maxOutputTokens: maxTokens,
        });
  return (
    <MarketDialog titleId="connect-batch-title" onClose={onClose} busy={busy}>
      <div className="token-connect-heading">
        <h2 id="connect-batch-title">Connect this token batch</h2>
        <button
          type="button"
          className="icon-button"
          aria-label="Close connection details"
          disabled={busy}
          onClick={onClose}
        >
          <X size={18} />
        </button>
      </div>
      <ErrorBox error={resource.error} retry={resource.reload} />
      {resource.loading && <Spinner label="Loading batch connection" />}
      {pack && (
        <>
          <p className="token-connect-summary">
            {provider(pack.provider)} · {count(pack.availableInputTokens)} input /{' '}
            {count(pack.availableOutputTokens)} output available · {timeLeft(pack.expiresAt, now)}
          </p>
          <p>
            Use this key in your app, script, VM or agent to redeem only this batch’s prepaid quota.
            It cannot buy tokens, add funding or access VM controls.
          </p>
          {pack.fundingSource !== 'wallet' && (
            <p className="token-connect-note">
              To combine remaining quota from compatible batches, use your{' '}
              <Link href={`/agents/${pack.grantId}`}>agent’s API key</Link>. A batch key stays
              limited to this batch.
            </p>
          )}
          <label className="field">
            <span>OpenAI-compatible base URL</span>
            <input readOnly value={baseUrl} />
          </label>
          <CopyValue value={baseUrl} label="Copy connection URL" />
          <label className="field">
            <span>Model</span>
            <input readOnly value={model} />
          </label>
          <p>{OUTPUT_LIMIT_GUIDANCE}</p>
          <ErrorBox error={catalog.error} retry={catalog.reload} />
          {!catalog.loading && !setup && (
            <p role="status">
              {route?.qualified
                ? hasInputQuota
                  ? 'Insufficient output allowance for a valid call. Buy another batch or use an agent key with compatible quota.'
                  : 'Insufficient input allowance for the example prompt. Buy another batch or use an agent key with compatible quota.'
                : 'Provider limits are unavailable or this route is not qualified. Refresh provider availability before calling.'}
            </p>
          )}
          <ErrorBox error={error} />
          {access ? (
            <>
              <label className="field">
                <span>Batch API key · shown once</span>
                <input
                  aria-label="New batch API key"
                  type={show ? 'text' : 'password'}
                  readOnly
                  autoComplete="off"
                  spellCheck={false}
                  value={access.token}
                />
              </label>
              <div className="token-connect-actions">
                <CopyValue value={access.token} label="Copy batch key" />
                <button
                  type="button"
                  className="button secondary small"
                  onClick={() => setShow(!show)}
                >
                  {show ? 'Hide key' : 'Show key'}
                </button>
              </div>
              <p>
                Save it before closing this dialog. The key expires at{' '}
                {dateTime(access.connection.expiresAt)} and retains this batch’s original token
                allowance.
              </p>
              {setup && (
                <details className="token-connect-code" open>
                  <summary>JavaScript setup example</summary>
                  <p>
                    Install <code>openai</code>, save this example as <code>example.mjs</code>, set{' '}
                    <code>BROKER_API_KEY</code> to your batch key, and run{' '}
                    <code>node example.mjs</code>.
                  </p>
                  <p>
                    This example allows up to {count(maxTokens!)} output tokens from this batch.
                    Refresh its remaining quota before another call.
                  </p>
                  <pre tabIndex={0}>{setup}</pre>
                  <CopyValue value={setup} label="Copy setup example" />
                </details>
              )}
            </>
          ) : (
            <>
              <p className="token-connect-note">
                Creating a replacement revokes the existing key for this batch. Other batches keep
                their access.
              </p>
              {uncertain && (
                <p role="status">
                  No automatic retry was made. The previous key may have been issued; a replacement
                  explicitly revokes it.
                </p>
              )}
              <button
                type="button"
                className="button primary"
                disabled={!usable || busy}
                onClick={() => void issue(uncertain)}
              >
                {busy ? (
                  <Spinner label="Creating batch key" />
                ) : uncertain ? (
                  'Create replacement key'
                ) : (
                  'Create or replace batch key'
                )}
              </button>
              {!usable && (
                <p>This batch is closed or expired. You can still review its purchase history.</p>
              )}
            </>
          )}
          <div className="token-connect-actions">
            <Link href="/vms" className="button secondary">
              Open your VMs
              <ArrowRight size={14} />
            </Link>
            <Link href={`/token-orders/${pack.orderId}`} className="text-link">
              View purchase
            </Link>
          </div>
        </>
      )}
    </MarketDialog>
  );
}
