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
import { moneyUnits, MIN_ORDER_PRICE_CENTS } from '../shared/money';
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import {
  ArrowLeft,
  ArrowRight,
  Bot,
  Check,
  CheckCircle2,
  Clock3,
  Copy,
  KeyRound,
  LockKeyhole,
  Plus,
  RefreshCw,
  Radio,
  Search,
  ShieldCheck,
  Sparkles,
  Wallet,
  X,
} from 'lucide-react';
import {
  INFERENCE_MODEL_ID,
  WALLET_TOKEN_PACK_TTL_SECONDS,
  type InferenceCatalog,
  type InferenceGrant,
  type InferenceGrantDetail,
  type InferenceProvider,
  type TokenOffering,
  type TokenOfferingInput,
  type TokenOrder,
  type TokenOrderInput,
  type TokenOrderDetail,
  type TokenPack,
  type TokenQuote,
} from '../shared/inference';
import type { BrokerKeySummary } from '../shared/developer';
import type { CreditWallet } from '../shared/agreements';
import { api, ApiError, dateTime, money, moneyMicros, post, put, DEFAULT_PRICE_CENTS } from './api';
import {
  AuctionCountdown,
  DetailRow,
  EmptyState,
  ErrorBox,
  Link,
  LoadMore,
  MarketDialog,
  MoneyInput,
  PageHeader,
  Spinner,
  StatCard,
  SuccessBox,
  useNavigate,
  useNow,
  usePagedResource,
  useResource,
} from './components';
import './market.css';
import './inference.css';
import {
  FormPage,
  FormLayout,
  FormPanel,
  FormSection,
  FormSummary,
  FormTotal,
  FormDisclosure,
  FormActions,
} from './form-layout';
import { AgentBuying, BuyingReceipt } from './buying';
import { ProviderSupply, SupplyWindow } from './supply';
import type { AgentListItem } from '../shared/buying';

const count = (n: number) => n.toLocaleString('en-US');
const providerName = (provider: string) =>
  provider === 'modal' ? 'Modal' : provider === 'baseten' ? 'Baseten' : provider;
const message = (error: unknown) =>
  error instanceof Error ? error.message : 'The request could not be completed.';
const labels: Record<string, string> = {
  active: 'Active',
  closing: 'Closing',
  closed: 'Closed',
  open: 'Auction live',
  awarded: 'Pack purchased',
  no_offers: 'No offers',
  cancelled: 'Cancelled',
  expired: 'Expired',
  reserved: 'Reserved',
  dispatching: 'Generating',
  settled: 'Settled',
  rejected: 'Rejected',
  outcome_unknown: 'Outcome unknown',
  needs_reconciliation: 'Needs review',
  written_off: 'Written off by Wick',
  retiring: 'Retiring',
};
function State({ value }: { value: string }) {
  return (
    <TableStatus
      tone={
        ['active', 'awarded', 'settled'].includes(value)
          ? 'success'
          : [
                'open',
                'dispatching',
                'closing',
                'retiring',
                'outcome_unknown',
                'needs_reconciliation',
              ].includes(value)
            ? 'warning'
            : value === 'rejected'
              ? 'danger'
              : 'neutral'
      }
    >
      {labels[value] ?? value}
    </TableStatus>
  );
}
function useOperationKey() {
  const ref = useRef<{ fingerprint: string; key: string } | null>(null);
  return {
    next(input: unknown) {
      const fingerprint = JSON.stringify(input);
      if (ref.current?.fingerprint !== fingerprint)
        ref.current = { fingerprint, key: crypto.randomUUID() };
      return ref.current.key;
    },
    complete() {
      ref.current = null;
    },
  };
}
function Mode({ mode }: { mode: string }) {
  return (
    <span className="inference-mode">
      {mode === 'fixture' ? 'Fixture · simulated' : 'Live provider route'}
    </span>
  );
}
function Readiness({ catalog }: { catalog: InferenceCatalog }) {
  const title =
    catalog.mode === 'fixture'
      ? 'Fixture marketplace · no real model calls'
      : 'Provider availability';
  const healthy =
    catalog.enabled &&
    catalog.routes.length > 0 &&
    catalog.routes.every((route) => route.qualified);
  const details = (
    <>
      <p>
        {catalog.mode === 'fixture'
          ? 'Token purchases and responses are simulated. This workspace does not provision or call a live model.'
          : 'Purchases require an enabled marketplace and a qualified provider route.'}
      </p>
      {!catalog.enabled && (
        <p className="inference-warning">
          The inference marketplace is disabled. New purchases are unavailable.
        </p>
      )}
      <div className="inference-routes">
        {catalog.routes.map((route) => (
          <div key={route.provider}>
            <span>
              <strong>{providerName(route.provider)}</strong>
              <span
                className={`inference-readiness-dot ${route.qualified && catalog.enabled ? 'ready' : ''}`}
              />
              {route.qualified && catalog.enabled ? 'Ready' : 'Unavailable'}
            </span>
            <small>{route.reason}</small>
          </div>
        ))}
      </div>
    </>
  );
  return healthy ? (
    <FormDisclosure
      title={title}
      icon={<ShieldCheck size={16} />}
      className="inference-availability-details"
    >
      {details}
    </FormDisclosure>
  ) : (
    <section className="inference-readiness" aria-label="Inference availability">
      <div className="inference-inline">
        <ShieldCheck size={18} />
        <strong>{title}</strong>
      </div>
      {details}
    </section>
  );
}
function DialogHeading({
  id,
  children,
  close,
  busy,
}: {
  id: string;
  children: ReactNode;
  close: () => void;
  busy?: boolean;
}) {
  return (
    <div className="inference-section-heading">
      <h2 id={id}>{children}</h2>
      <button
        type="button"
        className="icon-button"
        aria-label="Close dialog"
        onClick={close}
        disabled={busy}
      >
        <X size={18} />
      </button>
    </div>
  );
}
function CopyButton({ text, label = 'Copy' }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false),
    [error, setError] = useState('');
  return (
    <>
      <button
        type="button"
        className="button secondary small"
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(text);
            setCopied(true);
            setError('');
          } catch {
            setError('Clipboard unavailable. Select the text and copy it manually.');
          }
        }}
      >
        {copied ? <Check size={14} /> : <Copy size={14} />}
        {copied ? 'Copied' : label}
      </button>
      <ErrorBox error={error} />
    </>
  );
}

export function Agents({ search = '' }: { search?: string }) {
  const navigate = useNavigate(),
    query = new URLSearchParams(search);
  const q = query.get('q') ?? '',
    status = query.get('status') ?? 'all',
    cursor = query.get('cursor');
  const params = new URLSearchParams({ q, status, limit: '25' });
  if (cursor) params.set('cursor', cursor);
  const list = useResource<{ items: AgentListItem[]; nextCursor?: string }>(
      `/api/inference/agents?${params}`,
      10000,
    ),
    catalog = useResource<InferenceCatalog>('/api/inference/models'),
    wallet = useResource<CreditWallet>('/api/credits');
  function filter(key: string, value: string) {
    const p = new URLSearchParams(search);
    p.delete('cursor');
    if (value) p.set(key, value);
    else p.delete(key);
    navigate(`/agents?${p}`);
  }
  function page(value?: string) {
    const p = new URLSearchParams(search);
    if (value) p.set('cursor', value);
    else p.delete('cursor');
    navigate(`/agents?${p}`);
  }
  const [creating, setCreating] = useState(false),
    [name, setName] = useState(''),
    [budget, setBudget] = useState(DEFAULT_PRICE_CENTS),
    [maximum, setMaximum] = useState(DEFAULT_PRICE_CENTS),
    [hours, setHours] = useState(2),
    [providers, setProviders] = useState<InferenceProvider[]>(['modal', 'baseten']),
    [instant, setInstant] = useState(true),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const operation = useOperationKey(),
    creationExpiry = useRef<string | null>(null);
  function openCreate() {
    creationExpiry.current = null;
    setError('');
    setCreating(true);
  }
  useEffect(() => {
    if (new URLSearchParams(search).get('create') === '1') openCreate();
  }, [search]);
  async function create(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError('');
    creationExpiry.current ??= new Date(Date.now() + hours * 3600000).toISOString();
    const input = {
      name: name.trim(),
      budgetCents: budget,
      maxPurchaseCents: maximum,
      allowedProviders: providers,
      allowInstant: instant,
      expiresAt: creationExpiry.current,
    };
    try {
      const grant = await post<InferenceGrant>('/api/inference/grants', {
        ...input,
        operationKey: operation.next(input),
      });
      navigate(`/agents/${grant.id}`);
    } catch (err) {
      setError(message(err));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="inference-workspace inventory-page">
      <PageHeader
        title="Agents"
        description="Manage your agents’ budgets, token allowance, and buying policies."
      >
        <Link href="/credits" className="button secondary">
          <Wallet size={16} />
          Broker wallet
        </Link>
        <button className="button primary" onClick={openCreate}>
          <Plus size={16} />
          Create agent
        </button>
      </PageHeader>
      <ErrorBox error={catalog.error} retry={catalog.reload} />
      <ErrorBox error={list.data ? list.error : ''} retry={list.reload} />
      <TablePanel className="agent-table-shell" label="Agents">
        <TableTabs>
          <h2>Agent budgets</h2>
        </TableTabs>
        <TableToolbar label="Search and filter agents">
          <form
            className="agent-search"
            onSubmit={(e) => {
              e.preventDefault();
              filter('q', String(new FormData(e.currentTarget).get('q') ?? ''));
            }}
          >
            <label className="field agent-search-input">
              <span className="sr-only">Find an agent</span>
              <Search size={16} aria-hidden="true" />
              <input
                type="search"
                key={q}
                name="q"
                defaultValue={q}
                placeholder="Search agent names"
                maxLength={80}
              />
            </label>
            <button className="button secondary">Search</button>
          </form>
          <label className="field agent-status-filter">
            <span className="sr-only">Status</span>
            <select value={status} onChange={(e) => filter('status', e.target.value)}>
              <option value="all">All statuses</option>
              <option value="active">Active</option>
              <option value="closing">Closing</option>
              <option value="closed">Closed</option>
            </select>
          </label>
        </TableToolbar>
        {list.loading ? (
          <TableState loading title="Loading agents" />
        ) : !list.data && list.error ? (
          <TableState error={list.error} onRetry={list.reload} />
        ) : list.data?.items.length ? (
          <TableViewport label="Agent budgets" minWidth={940} className="table-scroll">
            <table className="agent-table" aria-label="Agent budgets and token allowance">
              <caption className="sr-only">Agent budgets and token allowance</caption>
              <thead>
                <tr>
                  <th scope="col">Agent</th>
                  <th scope="col">Status</th>
                  <th scope="col" className="money-column numeric-cell">
                    Available budget
                  </th>
                  <th className="numeric-cell" scope="col">
                    Calls available
                  </th>
                  <th scope="col">Expires</th>
                  <th className="actions-cell" scope="col">
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {list.data.items.map((grant) => (
                  <tr key={grant.id}>
                    <td>
                      <TableIdentity
                        icon={<Bot size={17} />}
                        title={
                          <Link
                            className="agent-name-link"
                            title={grant.name}
                            href={`/agents/${grant.id}`}
                          >
                            {grant.name}
                          </Link>
                        }
                        subtitle={
                          <>
                            {grant.buyingPaused
                              ? 'Buying paused'
                              : grant.buyingMode === 'automatic'
                                ? 'Automatic buying'
                                : grant.buyingMode
                                  ? grant.buyingMode === 'suggest'
                                    ? 'Suggestions only'
                                    : 'Review purchases'
                                  : 'Manual buying'}{' '}
                            {grant.mode === 'fixture' && ' · Demo'}
                          </>
                        }
                      />
                    </td>
                    <td>
                      <State
                        value={
                          grant.status === 'active' && Date.parse(grant.expiresAt) <= Date.now()
                            ? 'expired'
                            : grant.status
                        }
                      />
                    </td>
                    <td className="money-column numeric-cell">
                      {money(grant.availableCents)}
                      <small>{money(grant.heldCents)} held</small>
                    </td>
                    <td className="numeric-cell">
                      <strong>{count(grant.eligibleCalls)}</strong> calls
                      <small>At {count(grant.outputPerCall)} output / call</small>
                    </td>
                    <td>
                      <time dateTime={grant.expiresAt} title={dateTime(grant.expiresAt)}>
                        {new Date(grant.expiresAt).toLocaleDateString('en-US', {
                          month: 'short',
                          day: 'numeric',
                          year: 'numeric',
                        })}
                        <small>
                          {new Date(grant.expiresAt).toLocaleTimeString('en-US', {
                            hour: 'numeric',
                            minute: '2-digit',
                            timeZoneName: 'short',
                          })}
                        </small>
                      </time>
                    </td>
                    <td className="actions-cell">
                      <Link
                        href={`/agents/${grant.id}`}
                        className="table-open-link"
                        aria-label={`Open ${grant.name}`}
                      >
                        Open <ArrowRight size={13} />
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableViewport>
        ) : (
          <TableState
            title={
              q || status !== 'all'
                ? 'No agents match these filters'
                : 'Your first agent starts here'
            }
            description="Fund an agent, choose its buying limits, and connect its private key."
          />
        )}
        <TableFooter count={list.data?.items.length} noun="agents">
          <div className="buying-actions" style={{ margin: 0 }}>
            {cursor && (
              <button className="button secondary" onClick={() => page()}>
                Newest
              </button>
            )}
            {list.data?.nextCursor && (
              <button className="button secondary" onClick={() => page(list.data?.nextCursor)}>
                Next page
              </button>
            )}
          </div>
        </TableFooter>
      </TablePanel>
      {creating && (
        <MarketDialog titleId="create-agent-title" onClose={() => setCreating(false)} busy={busy}>
          <form onSubmit={create}>
            <DialogHeading id="create-agent-title" close={() => setCreating(false)} busy={busy}>
              Create an agent
            </DialogHeading>
            <p className="inference-muted">
              Reserve a budget from your Broker wallet. Funding is not a token purchase.
            </p>
            <fieldset disabled={busy} className="inference-fieldset">
              <label className="field">
                <span>Agent name</span>
                <input
                  required
                  maxLength={64}
                  autoFocus
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Research assistant"
                />
              </label>
              <div className="inference-form-grid">
                <MoneyInput
                  id="agent-budget"
                  label="Initial budget"
                  value={budget}
                  min={0.01}
                  onChange={setBudget}
                />
                <MoneyInput
                  id="agent-purchase-limit"
                  label="Maximum per purchase"
                  value={maximum}
                  min={0.01}
                  onChange={setMaximum}
                />
              </div>
              {wallet.data && (
                <p className="inference-muted">
                  Wallet available: {money(wallet.data.availableCents)}
                </p>
              )}
              <label className="field">
                <span>Budget expires in</span>
                <select
                  value={hours}
                  onChange={(e) => {
                    setHours(Number(e.target.value));
                    creationExpiry.current = null;
                  }}
                >
                  {[1, 2, 6, 24].map((n) => (
                    <option key={n} value={n}>
                      {n} {n === 1 ? 'hour' : 'hours'}
                    </option>
                  ))}
                </select>
              </label>
              <fieldset className="inference-provider-picker">
                <legend>Allowed providers</legend>
                {(['modal', 'baseten'] as const).map((provider) => (
                  <label key={provider}>
                    <input
                      type="checkbox"
                      checked={providers.includes(provider)}
                      onChange={(e) =>
                        setProviders((old) =>
                          e.target.checked ? [...old, provider] : old.filter((p) => p !== provider),
                        )
                      }
                    />
                    {providerName(provider)}
                  </label>
                ))}
              </fieldset>
              <label className="inference-checkbox">
                <input
                  type="checkbox"
                  checked={instant}
                  onChange={(e) => setInstant(e.target.checked)}
                />
                Allow instant purchases alongside auctions
              </label>
            </fieldset>
            <ErrorBox error={error} />
            <div className="inference-dialog-actions">
              <button
                type="button"
                className="button secondary"
                disabled={busy}
                onClick={() => setCreating(false)}
              >
                Cancel
              </button>
              <button
                className="button primary"
                disabled={
                  busy ||
                  !providers.length ||
                  budget < 0.01 ||
                  maximum < 0.01 ||
                  maximum > budget ||
                  (!!wallet.data && budget > wallet.data.availableCents)
                }
              >
                {busy ? <Spinner label="Creating agent" /> : `Reserve ${money(budget)} and create`}
              </button>
            </div>
          </form>
        </MarketDialog>
      )}
    </div>
  );
}

function PackCard({ pack }: { pack: TokenPack }) {
  const retirementMessage =
    pack.retirementReason === 'quota_exhausted'
      ? 'This pack cannot cover another request’s required token reservation. Unused quota has been retired.'
      : pack.retirementReason === 'owner_closed'
        ? pack.fundingSource === 'wallet'
          ? 'This purchase was closed. Unused quota has been retired.'
          : 'The agent budget was closed. Unused quota has been retired.'
        : pack.retirementReason === 'expired'
          ? 'This pack has expired. Unused quota has been retired.'
          : pack.retirementReason === 'provider_failure'
            ? 'The provider could not fulfill this pack. See its refund and reconciliation status.'
            : pack.retirementReason
              ? 'This pack has been retired and cannot accept new requests.'
              : '';
  return (
    <article className="inference-pack">
      <div className="inference-section-heading">
        <div>
          <strong>{providerName(pack.provider)}</strong>
          <Mode mode={pack.mode} />
        </div>
        <State value={pack.status} />
      </div>
      <p className="inference-model">{pack.modelId}</p>
      {(['Input', 'Output'] as const).map((kind) => {
        const input = kind === 'Input',
          total = input ? pack.inputTokens : pack.outputTokens,
          available = input ? pack.availableInputTokens : pack.availableOutputTokens,
          held = input ? pack.heldInputTokens : pack.heldOutputTokens;
        return (
          <div className="inference-quota" key={kind}>
            <div>
              <span>{kind} tokens</span>
              <strong>
                {count(available)} <small>/ {count(total)} available</small>
              </strong>
            </div>
            <progress
              value={available}
              max={Math.max(1, total)}
              aria-label={`${kind} tokens available`}
            />
            <small>
              {count(held)} held for requests ·{' '}
              {count(input ? pack.consumedInputTokens : pack.consumedOutputTokens)} consumed
              {(input ? pack.retiredInputTokens : pack.retiredOutputTokens) > 0 && (
                <> · {count(input ? pack.retiredInputTokens : pack.retiredOutputTokens)} retired</>
              )}
            </small>
          </div>
        );
      })}
      <div className="inference-card-footer">
        <span>
          {money(pack.priceCents)} prepaid
          {pack.refundCents ? ` · ${money(pack.refundCents)} refunded` : ''}
        </span>
        <Link href={`/token-orders/${pack.orderId}`} className="text-link">
          View order <ArrowRight size={13} />
        </Link>
      </div>
      <p className="inference-muted">Expires {dateTime(pack.expiresAt)}</p>
      {retirementMessage && <p className="inference-warning">{retirementMessage}</p>}
    </article>
  );
}

export function AgentDetail({ id, search = '' }: { id: string; search?: string }) {
  const selectedTab = new URLSearchParams(search).get('tab') ?? 'overview';
  const tab = ['overview', 'policy', 'activity', 'connection'].includes(selectedTab)
    ? selectedTab
    : 'overview';
  const resource = useResource<InferenceGrantDetail>(
    `/api/inference/grants/${encodeURIComponent(id)}`,
    5000,
  );
  const [dialog, setDialog] = useState<'fund' | 'close' | 'key' | null>(null),
    [amount, setAmount] = useState(DEFAULT_PRICE_CENTS),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [notice, setNotice] = useState(''),
    [created, setCreated] = useState<{ key: BrokerKeySummary; token: string } | null>(null);
  const operation = useOperationKey();
  const detail = resource.data,
    grant = detail?.grant;
  const active = grant?.status === 'active' && Date.parse(grant.expiresAt) > Date.now();
  const baseURL = `${window.location.origin}/api/v1`;
  const setup = `import OpenAI from 'openai';\n\nconst client = new OpenAI({\n  apiKey: process.env.BROKER_API_KEY,\n  baseURL: '${baseURL}',\n  maxRetries: 0,\n});\n\n// Keep this ID unchanged when recovering this request.\nconst requestId = crypto.randomUUID();\nconst response = await client.chat.completions.create({\n  model: '${INFERENCE_MODEL_ID}',\n  messages: [{ role: 'user', content: 'Hello!' }],\n  max_tokens: 256,\n  stream: false,\n}, { headers: { 'Idempotency-Key': requestId } });\nconsole.log(response.choices[0].message.content);`;
  function open(next: 'fund' | 'close' | 'key') {
    setError('');
    setNotice('');
    setDialog(next);
  }
  async function mutate(event?: FormEvent) {
    event?.preventDefault();
    if (!dialog) return;
    setBusy(true);
    setError('');
    try {
      if (dialog === 'key') {
        const key = await post<{ key: BrokerKeySummary; token: string }>(
          `/api/inference/grants/${id}/keys`,
          { name: `${grant?.name} agent key`.slice(0, 64) },
        );
        setCreated(key);
      } else {
        const input = dialog === 'fund' ? { amountCents: amount } : {};
        await post(`/api/inference/grants/${id}/${dialog}`, {
          ...input,
          operationKey: operation.next({ action: dialog, ...input }),
        });
        setNotice(
          dialog === 'fund'
            ? `${money(amount)} added to the agent budget.`
            : 'Agent closing requested. Uncommitted cash returns to your wallet.',
        );
      }
      operation.complete();
      setDialog(null);
      resource.reload();
    } catch (err) {
      setError(
        dialog === 'key' && (!(err instanceof ApiError) || err.status >= 500)
          ? 'Key creation could not be confirmed. A key may have been created. No automatic retry was made. Choose Create or replace API key again to explicitly revoke any prior key and issue a replacement.'
          : message(err),
      );
      if (dialog === 'key') setDialog(null);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="inference-workspace agent-detail detail-page">
      <Link href="/agents" className="back-link">
        <ArrowLeft size={15} />
        All agents
      </Link>
      <PageHeader
        title={grant?.name ?? 'Agent'}
        description="Token allowance and spending controls for this agent."
      >
        <button
          className="button secondary"
          onClick={resource.reload}
          disabled={resource.refreshing}
        >
          <RefreshCw size={15} />
          Refresh
        </button>
        {active && (
          <>
            <button className="button secondary" onClick={() => open('fund')}>
              <Plus size={15} />
              Add funds
            </button>
            <Link href={`/token-orders/new?grantId=${id}`} className="button primary">
              <Sparkles size={15} />
              Buy token pack
            </Link>
          </>
        )}
      </PageHeader>
      <ErrorBox error={resource.error} retry={resource.reload} />
      <ErrorBox error={!dialog ? error : ''} />
      {notice && <SuccessBox>{notice}</SuccessBox>}
      {resource.loading && <Spinner label="Loading agent" />}
      {detail && grant && (
        <>
          <div className="inference-inline agent-detail-meta">
            <State value={grant.status === 'active' && !active ? 'expired' : grant.status} />
            <Mode mode={grant.mode} />
            <span className="inference-muted">
              {active ? 'Expires' : 'Expiry'} {dateTime(grant.expiresAt)}
            </span>
          </div>
          <div className="inference-stats">
            <StatCard
              label="Available to purchase"
              value={money(grant.availableCents)}
              note={`${money(grant.maxPurchaseCents)} maximum per purchase`}
              icon={<Wallet size={17} />}
            />
            <StatCard
              label="Net spent on packs"
              value={money(grant.spentCents)}
              note="Inference uses prepaid tokens"
            />
            <StatCard
              label="Held for purchases"
              value={money(grant.heldCents)}
              note="Included in your funded budget"
            />
            <StatCard
              label="Total funded"
              value={money(grant.fundedCents)}
              note={`${money(grant.returnedCents)} returned to wallet`}
            />
          </div>
          <nav className="buying-tabs" aria-label="Agent sections">
            {[
              ['overview', 'Overview'],
              ['policy', 'Buying policy'],
              ['activity', 'Activity & receipts'],
              ['connection', 'Connection'],
            ].map(([value, label]) => (
              <Link
                key={value}
                href={`/agents/${id}?tab=${value}`}
                aria-current={tab === value ? 'page' : undefined}
              >
                {label}
              </Link>
            ))}
          </nav>
          {tab !== 'connection' && (
            <AgentBuying
              key={id}
              detail={detail}
              tab={tab}
              onChanged={() => {
                void resource.reload();
              }}
            />
          )}
          {tab === 'connection' && (
            <>
              <Readiness catalog={detail.catalog} />
              <div className="inference-detail-grid">
                <section className="card inference-setup">
                  <div className="inference-section-heading">
                    <h2>
                      <KeyRound size={18} />
                      Connect this agent
                    </h2>
                    {active && (
                      <button className="button secondary small" onClick={() => open('key')}>
                        Create or replace API key
                      </button>
                    )}
                  </div>
                  <p>
                    Use the same private key to purchase packs and call the inference gateway. A
                    replacement key keeps this agent’s balance and revokes its previous keys.
                  </p>
                  <div className="inference-endpoint">
                    <span>OpenAI-compatible base URL</span>
                    <code>{baseURL}</code>
                    <CopyButton text={baseURL} label="Copy URL" />
                  </div>
                  <details className="inference-code-details">
                    <summary>JavaScript setup example</summary>
                    <p>
                      Install <code>openai</code> and supply <code>BROKER_API_KEY</code> through
                      your secret manager. Purchase a pack first.
                    </p>
                    <pre tabIndex={0}>{setup}</pre>
                    <CopyButton text={setup} label="Copy example" />
                  </details>
                  <p className="inference-muted">
                    Text chat · buffered responses · explicit output limit. Keep request IDs stable
                    across retries.{' '}
                    {detail.catalog.mode === 'fixture'
                      ? 'This agent returns fixture responses.'
                      : 'Calls require a qualified route and sufficient token quota.'}
                  </p>
                </section>
                <section className="card">
                  <h2>Budget controls</h2>
                  <dl className="inference-definitions">
                    <div>
                      <dt>Providers</dt>
                      <dd>{grant.allowedProviders.map(providerName).join(', ')}</dd>
                    </div>
                    <div>
                      <dt>Purchasing</dt>
                      <dd>
                        {grant.allowInstant
                          ? '30-second auction or instant price'
                          : '30-second auction only'}
                      </dd>
                    </div>
                    <div>
                      <dt>Budget changes</dt>
                      <dd>Owner only</dd>
                    </div>
                  </dl>
                  <p className="inference-muted">
                    Purchased packs are prepaid. Unused or expired tokens are not automatically
                    refunded. Verified provider-failure refunds restore an active budget; closed
                    budgets return refunds to your wallet.
                  </p>
                  {grant.status === 'active' && (
                    <button className="button secondary" onClick={() => open('close')}>
                      Close agent budget
                    </button>
                  )}
                </section>
              </div>
            </>
          )}
          {tab === 'activity' && (
            <>
              <section className="card">
                <div className="inference-section-heading">
                  <h2>Token packs</h2>
                  <span className="inference-muted">Input and output quotas are separate</span>
                </div>
                {detail.packs.length ? (
                  <div className="inference-pack-grid">
                    {detail.packs.map((pack) => (
                      <PackCard pack={pack} key={pack.id} />
                    ))}
                  </div>
                ) : (
                  <EmptyState
                    icon={<Sparkles size={24} />}
                    title="No token packs yet"
                    description="Buy a prepaid pack to give your agent input and output tokens."
                  />
                )}
              </section>
              <TablePanel embedded label="Recent token orders">
                <TableToolbar>
                  <h2>Recent token orders</h2>
                </TableToolbar>
                {detail.orders.length ? (
                  <TableViewport
                    label="Recent token orders"
                    embedded
                    minWidth={720}
                    className="table-scroll"
                  >
                    <table>
                      <caption className="sr-only">Recent token orders</caption>
                      <thead>
                        <tr>
                          <th scope="col">Order</th>
                          <th className="numeric-cell" scope="col">
                            Tokens
                          </th>
                          <th scope="col">Status</th>
                          <th className="numeric-cell" scope="col">
                            Price / ceiling
                          </th>
                        </tr>
                      </thead>
                      <tbody>
                        {detail.orders.map((order) => (
                          <tr key={order.id}>
                            <td>
                              <Link href={`/token-orders/${order.id}`} className="text-link">
                                {order.mode === 'auction'
                                  ? '30-second auction'
                                  : 'Instant purchase'}{' '}
                                <ArrowRight size={12} />
                              </Link>
                              <small>{dateTime(order.createdAt)}</small>
                            </td>
                            <td className="numeric-cell">
                              {count(order.inputTokens)} input · {count(order.outputTokens)} output
                            </td>
                            <td>
                              <State value={order.status} />
                            </td>
                            <td className="numeric-cell">
                              {money(order.priceCents ?? order.maxTotalCents)}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </TableViewport>
                ) : (
                  <p className="inference-muted">
                    Purchases made by you or this agent appear here.
                  </p>
                )}
              </TablePanel>
              <TablePanel embedded label="Recent inference requests">
                <TableToolbar>
                  <h2>Recent inference requests</h2>
                </TableToolbar>
                {detail.requests.length ? (
                  <TableViewport
                    label="Recent inference requests"
                    embedded
                    minWidth={720}
                    className="table-scroll"
                  >
                    <table>
                      <caption className="sr-only">Recent inference requests</caption>
                      <thead>
                        <tr>
                          <th scope="col">Request</th>
                          <th scope="col">Provider</th>
                          <th scope="col">Status</th>
                          <th className="numeric-cell" scope="col">
                            Input / output
                          </th>
                        </tr>
                      </thead>
                      <tbody>
                        {detail.requests.map((request) => (
                          <tr key={request.id}>
                            <td>
                              <code>{request.id.slice(0, 12)}</code>
                              <small>{dateTime(request.createdAt)}</small>
                            </td>
                            <td>
                              {providerName(request.provider)}
                              <Mode mode={request.mode} />
                            </td>
                            <td>
                              <State value={request.status} />
                              {request.failureCode && <small>{request.failureCode}</small>}
                            </td>
                            <td className="numeric-cell">
                              {request.inputTokens !== null
                                ? `${count(request.inputTokens)} / ${count(request.outputTokens ?? 0)} used`
                                : request.status === 'written_off'
                                  ? 'Usage unknown · Wick covers provider liability'
                                  : `${count(request.heldInputTokens)} / ${count(request.heldOutputTokens)} held`}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </TableViewport>
                ) : (
                  <p className="inference-muted">
                    Request usage and any unresolved token holds appear here.
                  </p>
                )}
                <p className="inference-muted">
                  Unknown outcomes keep their token reservation until reconciled. Retrying the same
                  request ID never starts another generation.
                </p>
              </TablePanel>
            </>
          )}
        </>
      )}
      {dialog && (
        <MarketDialog titleId="agent-action-title" onClose={() => setDialog(null)} busy={busy}>
          <form onSubmit={mutate}>
            <DialogHeading id="agent-action-title" close={() => setDialog(null)} busy={busy}>
              {dialog === 'fund'
                ? 'Add funds to agent'
                : dialog === 'close'
                  ? 'Close this agent budget?'
                  : 'Create or replace API key?'}
            </DialogHeading>
            {dialog === 'fund' ? (
              <>
                <p>
                  Only you can increase this budget. The amount is reserved from your Broker wallet.
                </p>
                <MoneyInput
                  id="agent-add-funds"
                  label="Amount to add"
                  value={amount}
                  min={0.01}
                  onChange={setAmount}
                  disabled={busy}
                />
              </>
            ) : dialog === 'close' ? (
              <p>
                New purchases and inference stop. Uncommitted funds return to your wallet. Existing
                request holds remain until resolved; purchased tokens follow the pack’s refund
                policy.
              </p>
            ) : (
              <p>
                All previous keys for this agent will be revoked. Its budget and purchased packs
                remain. The new secret will be shown once.
              </p>
            )}
            <ErrorBox error={error} />
            <div className="inference-dialog-actions">
              <button
                type="button"
                className="button secondary"
                disabled={busy}
                onClick={() => setDialog(null)}
              >
                Cancel
              </button>
              <button
                className="button primary"
                disabled={busy || (dialog === 'fund' && amount < 0.01)}
              >
                {busy ? (
                  <Spinner label="Saving" />
                ) : dialog === 'fund' ? (
                  `Add ${money(amount)}`
                ) : dialog === 'close' ? (
                  'Close budget'
                ) : (
                  'Issue replacement key'
                )}
              </button>
            </div>
          </form>
        </MarketDialog>
      )}
      {created && (
        <MarketDialog titleId="agent-secret-title" onClose={() => setCreated(null)}>
          <DialogHeading id="agent-secret-title" close={() => setCreated(null)}>
            Save your agent key
          </DialogHeading>
          <p>
            This secret is shown once. Store it in your agent’s secret manager. It cannot be
            recovered.
          </p>
          <label className="field">
            <span>New agent API key</span>
            <input
              readOnly
              value={created.token}
              autoComplete="off"
              spellCheck={false}
              onFocus={(e) => e.target.select()}
            />
          </label>
          <CopyButton text={created.token} label="Copy key" />
          <div className="inference-dialog-actions">
            <button className="button primary" onClick={() => setCreated(null)}>
              I’ve saved the key
            </button>
          </div>
        </MarketDialog>
      )}
    </div>
  );
}

export function TokenComposer({ search }: { search: string }) {
  const initial = new URLSearchParams(search).get('grantId') ?? '',
    navigate = useNavigate();
  const grants = usePagedResource<InferenceGrant>('/api/inference/grants'),
    catalog = useResource<InferenceCatalog>('/api/inference/models'),
    wallet = useResource<CreditWallet>('/api/credits', 5000);
  const [grantId, setGrantId] = useState(initial),
    [inputTokens, setInputTokens] = useState(2000000),
    [outputTokens, setOutputTokens] = useState(100000),
    [mode, setMode] = useState<'auction' | 'instant'>('auction'),
    [maximum, setMaximum] = useState(DEFAULT_PRICE_CENTS),
    [quotes, setQuotes] = useState<TokenQuote[]>([]),
    [quoteId, setQuoteId] = useState(''),
    [quoting, setQuoting] = useState(false),
    [uncertainOrder, setUncertainOrder] = useState<TokenOrderInput | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [accepted, setAccepted] = useState(false);
  const operation = useOperationKey(),
    quoteRevision = useRef(0),
    now = useNow();
  const selectedDetail = useResource<InferenceGrantDetail>(
    grantId
      ? `/api/inference/grants/${encodeURIComponent(grantId)}`
      : '/api/inference/grants?limit=1',
  );
  const walletFunding = !grantId;
  const grant = grantId
    ? (selectedDetail.data?.grant ?? grants.data?.items.find((item) => item.id === grantId))
    : undefined;
  const activeGrants =
    grants.data?.items.filter(
      (item) =>
        item.fundingSource !== 'wallet' &&
        item.status === 'active' &&
        Date.parse(item.expiresAt) > now,
    ) ?? [];
  const routes =
    catalog.data?.routes.filter(
      (route) => route.qualified && (!grant || grant.allowedProviders.includes(route.provider)),
    ) ?? [];
  const fundingReady = walletFunding
    ? !!wallet.data && !wallet.error
    : grant?.fundingSource !== 'wallet' &&
      grant?.status === 'active' &&
      Date.parse(grant.expiresAt) > now &&
      !selectedDetail.error;
  const availableCents = walletFunding ? wallet.data?.availableCents : grant?.availableCents;
  const purchaseLimit = walletFunding
    ? (availableCents ?? 0)
    : Math.min(availableCents ?? 0, grant?.maxPurchaseCents ?? 0);
  const allowInstant = walletFunding || !!grant?.allowInstant;
  const eligible = !!catalog.data?.enabled && routes.length > 0 && fundingReady;
  const minimumInputTokens = routes.length
    ? Math.min(...routes.map((route) => route.minimumInputReservation))
    : 1;
  const selected = quotes.find((quote) => quote.quoteId === quoteId),
    quoteFresh = !!selected && Date.parse(selected.expiresAt) > now;
  function invalidate() {
    quoteRevision.current++;
    setQuotes([]);
    setQuoteId('');
    setError('');
    setAccepted(false);
  }
  async function getQuotes() {
    if (
      !Number.isSafeInteger(inputTokens) ||
      !Number.isSafeInteger(outputTokens) ||
      inputTokens < minimumInputTokens ||
      inputTokens > 10_000_000 ||
      outputTokens < 1 ||
      outputTokens > 1_000_000
    ) {
      setError(
        `Enter ${count(minimumInputTokens)}–10,000,000 input tokens and 1–1,000,000 output tokens, in whole numbers.`,
      );
      return;
    }
    const revision = ++quoteRevision.current;
    setQuoting(true);
    setError('');
    try {
      const result = await post<{ items: TokenQuote[] }>('/api/inference/quotes', {
        ...(grantId ? { grantId } : {}),
        modelId: INFERENCE_MODEL_ID,
        inputTokens,
        outputTokens,
      });
      if (revision === quoteRevision.current) {
        setQuotes(result.items);
        setQuoteId(result.items[0]?.quoteId ?? '');
      }
    } catch (err) {
      if (revision === quoteRevision.current) setError(message(err));
    } finally {
      setQuoting(false);
    }
  }
  async function purchase(event: FormEvent) {
    event.preventDefault();
    if (uncertainOrder) {
      await submitOrder(uncertainOrder);
      return;
    }
    const price = mode === 'instant' ? selected?.priceCents : maximum;
    if (
      !eligible ||
      !accepted ||
      !Number.isSafeInteger(inputTokens) ||
      !Number.isSafeInteger(outputTokens) ||
      inputTokens < minimumInputTokens ||
      inputTokens > 10_000_000 ||
      outputTokens < 1 ||
      outputTokens > 1_000_000 ||
      !price ||
      price < MIN_ORDER_PRICE_CENTS ||
      price > purchaseLimit ||
      (mode === 'instant' && (!quoteFresh || !allowInstant))
    )
      return;
    setBusy(true);
    setError('');
    const input = {
      ...(grantId ? { grantId } : {}),
      modelId: INFERENCE_MODEL_ID,
      inputTokens,
      outputTokens,
      mode,
      maxTotalCents: mode === 'instant' ? selected!.priceCents : maximum,
      ...(mode === 'instant' ? { quoteId } : {}),
    };
    await submitOrder({ ...input, operationKey: operation.next(input) });
  }
  async function submitOrder(input: TokenOrderInput) {
    setBusy(true);
    setError('');
    try {
      const order = await post<TokenOrder>('/api/token-orders', input);
      navigate(`/token-orders/${order.id}`);
    } catch (err) {
      if (!(err instanceof ApiError) || err.status >= 500) {
        setUncertainOrder(input);
        setError(
          'The order response could not be confirmed. Recover this request using the same operation ID, or check your saved orders. No automatic retry was made.',
        );
      } else setError(message(err));
    } finally {
      setBusy(false);
    }
  }
  return (
    <FormPage
      className="inference-workspace token-compose-page"
      eyebrow="AI INFERENCE"
      title="Buy AI tokens"
      description="Choose your token pack and let providers compete, or review an instant price."
      back={{ href: '/new', label: 'All purchase options' }}
      step="Step 1 · Choose your pack"
      actions={
        <Link href="/tokens" className="button secondary">
          <Sparkles size={15} />
          Purchased tokens
        </Link>
      }
    >
      {catalog.data && <Readiness catalog={catalog.data} />}
      <ErrorBox
        error={catalog.error || (walletFunding ? wallet.error : selectedDetail.error)}
        retry={() => {
          catalog.reload();
          wallet.reload();
          selectedDetail.reload();
        }}
      />
      <form onSubmit={purchase}>
        <FormLayout
          aside={
            <FormSummary title="Your token purchase" className="token-purchase-summary">
              <div className="token-pack-quantity">
                {count(inputTokens)} input
                <br />
                <span>+ {count(outputTokens)} output tokens</span>
              </div>
              <dl className="inference-definitions">
                <div>
                  <dt>Model</dt>
                  <dd>Meta Muse Spark Open</dd>
                </div>
                <div>
                  <dt>Pay with</dt>
                  <dd>
                    {walletFunding ? 'Broker wallet' : (grant?.name ?? 'Loading agent budget…')}
                  </dd>
                </div>
                <div>
                  <dt>{walletFunding ? 'Available wallet credit' : 'Available budget'}</dt>
                  <dd>{availableCents === undefined ? 'Loading…' : money(availableCents)}</dd>
                </div>
                {!walletFunding && (
                  <div>
                    <dt>Per-purchase limit</dt>
                    <dd>{money(grant?.maxPurchaseCents)}</dd>
                  </div>
                )}
              </dl>
              <FormTotal
                label={mode === 'auction' ? 'Maximum hold' : 'Fixed pack price'}
                value={
                  mode === 'auction'
                    ? money(maximum)
                    : selected
                      ? money(selected.priceCents)
                      : 'Get a quote'
                }
              />
              <p className="inference-muted">
                Charged once when purchased. Using prepaid tokens does not charge you again.{' '}
                {walletFunding
                  ? mode === 'instant' && selected?.packExpiresAt
                    ? `This quoted pack expires at ${dateTime(selected.packExpiresAt)}. Its expiry is fixed when quoted.`
                    : `Wallet packs expire ${WALLET_TOKEN_PACK_TTL_SECONDS / 3600} hours after the auction starts or the instant quote is issued, including time spent buying.`
                  : 'The pack expires by the agent’s budget expiry.'}
              </p>
              <label className="inference-checkbox">
                <input
                  type="checkbox"
                  checked={accepted}
                  disabled={busy || !!uncertainOrder}
                  onChange={(e) => setAccepted(e.target.checked)}
                />
                <span>
                  I understand that purchased tokens are prepaid and unused or expired tokens are
                  not automatically refundable.
                </span>
              </label>
              {!eligible && (
                <p className="inference-warning">
                  {walletFunding
                    ? !fundingReady
                      ? 'Your wallet balance must be available before you can purchase.'
                      : 'A qualified provider route must be available to purchase.'
                    : 'Select an active funded agent with a qualified provider route to purchase.'}
                </p>
              )}
              {eligible &&
                (mode === 'auction' ? maximum : (selected?.priceCents ?? 0)) > purchaseLimit && (
                  <p className="inference-warning" role="status">
                    {walletFunding
                      ? 'This purchase exceeds your available wallet credit.'
                      : 'This purchase exceeds the available agent budget or per-purchase limit.'}
                  </p>
                )}
              <ErrorBox error={error} />
              <FormActions>
                <button
                  className="button primary full-width"
                  disabled={
                    busy ||
                    (!uncertainOrder &&
                      (!eligible ||
                        !accepted ||
                        !Number.isSafeInteger(inputTokens) ||
                        !Number.isSafeInteger(outputTokens) ||
                        inputTokens < minimumInputTokens ||
                        inputTokens > 10_000_000 ||
                        outputTokens < 1 ||
                        outputTokens > 1_000_000 ||
                        (mode === 'instant'
                          ? !quoteFresh || !allowInstant || selected!.priceCents > purchaseLimit
                          : maximum < 0.01 || maximum > purchaseLimit)))
                  }
                >
                  {busy ? (
                    <Spinner label="Placing order" />
                  ) : uncertainOrder ? (
                    'Recover saved order'
                  ) : mode === 'auction' ? (
                    'Start 30-second auction'
                  ) : (
                    `Buy pack${selected ? ` · ${money(selected.priceCents)}` : ''}`
                  )}
                </button>
              </FormActions>
            </FormSummary>
          }
        >
          <FormPanel>
            <fieldset disabled={busy || !!uncertainOrder} className="inference-fieldset">
              <FormSection
                title="Funding"
                description="Use your wallet or an optional agent budget."
              >
                <label className="field">
                  <span>Pay with</span>
                  <select
                    aria-label="Pay with"
                    value={grantId}
                    onChange={(e) => {
                      setGrantId(e.target.value);
                      invalidate();
                    }}
                  >
                    <option value="">
                      Broker wallet
                      {wallet.data ? ` · ${money(wallet.data.availableCents)} available` : ''}
                    </option>
                    {grant && !activeGrants.some((item) => item.id === grant.id) && (
                      <option value={grant.id}>{grant.name}</option>
                    )}
                    {activeGrants.map((item) => (
                      <option key={item.id} value={item.id}>
                        {item.name} · {money(item.availableCents)} available
                      </option>
                    ))}
                  </select>
                </label>
                <p className="inference-muted">
                  {walletFunding
                    ? 'Buy directly from your wallet. No agent setup is required.'
                    : 'This purchase uses the selected agent’s budget and buying limits.'}
                </p>
                <ErrorBox error={grants.error} retry={grants.reload} />
                <LoadMore
                  available={!!grants.nextCursor}
                  loading={grants.loadingMore}
                  onLoad={() => void grants.loadMore()}
                  error={grants.moreError}
                />
                <Link href="/agents" className="text-link">
                  Manage optional agent budgets <ArrowRight size={13} />
                </Link>
              </FormSection>
              <FormSection
                title="Token allowance"
                description="Choose the prepaid input and output quota your workload needs."
              >
                <div className="inference-fixed-model">
                  <Sparkles size={20} />
                  <div>
                    <strong>Meta Muse Spark Open</strong>
                    <code>{INFERENCE_MODEL_ID}</code>
                  </div>
                </div>
                <div className="inference-form-grid">
                  <label className="field">
                    <span>Input tokens</span>
                    <input
                      type="number"
                      required
                      min={minimumInputTokens}
                      max={10000000}
                      step={1}
                      value={inputTokens}
                      onChange={(e) => {
                        setInputTokens(Number(e.target.value));
                        invalidate();
                      }}
                    />
                  </label>
                  <label className="field">
                    <span>Output tokens</span>
                    <input
                      type="number"
                      required
                      min={1}
                      max={1000000}
                      step={1}
                      value={outputTokens}
                      onChange={(e) => {
                        setOutputTokens(Number(e.target.value));
                        invalidate();
                      }}
                    />
                  </label>
                </div>
                {routes.length > 0 && (
                  <p className="inference-muted">
                    Routes reserve at least{' '}
                    {count(Math.min(...routes.map((route) => route.minimumInputReservation)))} input
                    tokens per request. Output tokens include all charged generation.
                  </p>
                )}
              </FormSection>
              <FormSection title="Purchase method">
                <fieldset className="inference-buy-modes">
                  <legend>How to buy</legend>
                  <label className={mode === 'auction' ? 'selected' : ''}>
                    <input
                      type="radio"
                      name="purchase-mode"
                      checked={mode === 'auction'}
                      onChange={() => {
                        setMode('auction');
                        setAccepted(false);
                      }}
                    />
                    <span>
                      <strong>30-second reverse auction</strong>
                      <small>
                        Providers compete for your exact pack. Lowest eligible fixed price wins.
                      </small>
                    </span>
                    <Clock3 size={18} />
                  </label>
                  <label className={mode === 'instant' ? 'selected' : ''}>
                    <input
                      type="radio"
                      name="purchase-mode"
                      checked={mode === 'instant'}
                      disabled={!allowInstant}
                      onChange={() => {
                        setMode('instant');
                        setAccepted(false);
                      }}
                    />
                    <span>
                      <strong>Buy at an instant price</strong>
                      <small>
                        {allowInstant
                          ? 'Review a current provider quote and purchase immediately.'
                          : 'Instant purchases are disabled for this agent.'}
                      </small>
                    </span>
                    <ArrowRight size={18} />
                  </label>
                </fieldset>
                {mode === 'auction' ? (
                  <MoneyInput
                    id="token-auction-max"
                    label="Maximum total price"
                    value={maximum}
                    min={MIN_ORDER_PRICE_CENTS}
                    onChange={(value) => {
                      setMaximum(value);
                      setAccepted(false);
                    }}
                  />
                ) : (
                  <>
                    <button
                      type="button"
                      className="button secondary"
                      disabled={
                        quoting ||
                        !eligible ||
                        !Number.isSafeInteger(inputTokens) ||
                        !Number.isSafeInteger(outputTokens) ||
                        inputTokens < minimumInputTokens ||
                        inputTokens > 10_000_000 ||
                        outputTokens < 1 ||
                        outputTokens > 1_000_000
                      }
                      onClick={() => void getQuotes()}
                    >
                      {quoting ? <Spinner label="Getting prices" /> : 'Get instant prices'}
                    </button>
                    <div className="inference-quotes">
                      {quotes.map((quote) => (
                        <label
                          key={quote.quoteId}
                          className={quoteId === quote.quoteId ? 'selected' : ''}
                        >
                          <input
                            type="radio"
                            name="quote"
                            checked={quoteId === quote.quoteId}
                            disabled={Date.parse(quote.expiresAt) <= now}
                            onChange={() => {
                              setQuoteId(quote.quoteId);
                              setAccepted(false);
                            }}
                          />
                          <span>
                            <strong>{providerName(quote.provider)}</strong>
                            <small>
                              {Date.parse(quote.expiresAt) <= now
                                ? 'Quote expired · refresh prices'
                                : `Valid until ${dateTime(quote.expiresAt)}`}
                            </small>
                          </span>
                          <strong>{money(quote.priceCents)}</strong>
                        </label>
                      ))}
                    </div>
                  </>
                )}
              </FormSection>
            </fieldset>
          </FormPanel>
        </FormLayout>
      </form>
    </FormPage>
  );
}

export function TokenOrderPage({ id }: { id: string }) {
  const [poll, setPoll] = useState(2000);
  const resource = useResource<TokenOrderDetail>(
      `/api/token-orders/${encodeURIComponent(id)}`,
      poll,
    ),
    now = useNow(),
    operation = useOperationKey();
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const order = resource.data?.order;
  useEffect(() => {
    setPoll(
      !order || order.status === 'open'
        ? 2000
        : order.status === 'awarded' && resource.data?.pack?.status !== 'settled'
          ? 5000
          : 0,
    );
  }, [order?.status, resource.data?.pack?.status]);
  async function cancel() {
    setBusy(true);
    setError('');
    try {
      await post(`/api/token-orders/${id}/cancel`, {
        operationKey: operation.next({ id, action: 'cancel' }),
      });
      resource.reload();
    } catch (err) {
      setError(message(err));
    } finally {
      setBusy(false);
    }
  }
  const open = order?.status === 'open',
    awarded = order?.status === 'awarded',
    instant = order?.mode === 'instant',
    walletFunded = order?.fundingSource === 'wallet';
  const bids = [...(resource.data?.bids ?? [])].sort(
    (a, b) =>
      a.priceCents - b.priceCents ||
      a.createdAt.localeCompare(b.createdAt) ||
      a.id.localeCompare(b.id),
  );
  const leading = bids.find((b) => b.status === 'offered');
  return (
    <div className="inference-workspace detail-page">
      <Link href="/orders?kind=token" className="back-link">
        <ArrowLeft size={15} />
        Token orders
      </Link>
      <PageHeader
        eyebrow="AI TOKEN ORDER"
        title={instant ? 'Instant token purchase' : 'Token pack auction'}
        description={
          open
            ? 'Providers are competing for your pack. The lowest eligible fixed price wins automatically.'
            : awarded
              ? 'Your token pack and purchase price are locked in.'
              : 'Your saved order, provider offers and purchase outcome.'
        }
      >
        {order && <State value={order.status} />}
        {resource.data && (
          <Link
            href={walletFunded ? '/tokens' : `/agents/${resource.data.grant.id}`}
            className="button secondary"
          >
            {walletFunded ? 'Purchased tokens' : 'View agent'} <ArrowRight size={15} />
          </Link>
        )}
      </PageHeader>
      <ErrorBox error={resource.error} retry={resource.reload} />
      <ErrorBox error={error} />
      {resource.loading && <Spinner label="Loading token order" />}
      {order && resource.data && (
        <>
          {order.sourceMode === 'fixture' && (
            <p className="inference-readiness">
              Fixture order · simulated bids and token usage. No real model is called.
            </p>
          )}
          <div className="auction-grid token-auction-grid">
            <div>
              <section className={`card auction-card ${open && !instant ? 'is-live' : ''}`}>
                <div className="auction-top">
                  <div className="auction-live-label">
                    <Radio size={17} />
                    {instant ? 'INSTANT PURCHASE' : open ? 'LIVE AUCTION' : 'AUCTION RESULT'}
                  </div>
                  <span className="small-muted">Order {order.id.slice(0, 8)}</span>
                </div>
                {open && !instant ? (
                  <AuctionCountdown closesAt={order.closesAt} now={now} />
                ) : (
                  <div className="auction-outcome">
                    <span className={`icon-tile ${awarded ? 'emerald' : 'neutral'}`}>
                      {awarded ? <Check size={24} /> : <X size={24} />}
                    </span>
                    <div>
                      <h2>
                        {awarded
                          ? 'Your token pack is purchased'
                          : order.status === 'no_offers'
                            ? 'No eligible bids were received'
                            : order.status === 'cancelled'
                              ? 'Auction cancelled'
                              : 'The order has expired'}
                      </h2>
                      <p>
                        {awarded
                          ? 'Charged once. Redeeming your prepaid quota does not charge your budget again.'
                          : 'No token pack was purchased. The unspent purchase hold has been released.'}
                      </p>
                    </div>
                  </div>
                )}
                <div className="bid-section-title">
                  <h3>
                    Provider offers <span>{bids.length}</span>
                  </h3>
                  <span>Total price · USD</span>
                </div>
                {bids.length ? (
                  <div className="bid-list" role="list" aria-label="Provider offers">
                    {bids.map((bid, index) => (
                      <div
                        className={`bid-row ${bid.status === 'won' ? 'winning' : ''}`}
                        role="listitem"
                        key={bid.id}
                      >
                        <div className={`provider-avatar provider-${index % 3}`}>
                          {providerName(bid.provider).slice(0, 1)}
                        </div>
                        <div className="bid-provider">
                          <strong>{providerName(bid.provider)}</strong>
                          <span>
                            {bid.status === 'won'
                              ? 'Winning provider'
                              : bid.status === 'lost'
                                ? 'Not selected'
                                : open && bid.id === leading?.id
                                  ? 'Current lowest offer'
                                  : 'Binding offer'}
                          </span>
                          <span>
                            {bid.mode === 'fixture' ? 'Simulated provider' : 'Live provider route'}
                          </span>
                        </div>
                        <div className="bid-price">
                          <strong>{money(bid.priceCents)}</strong>
                          <span>
                            {bid.status === 'won' ? (
                              <CheckCircle2 size={15} />
                            ) : open && bid.id === leading?.id ? (
                              <span className="best-badge">Best price</span>
                            ) : null}
                          </span>
                        </div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="waiting-bids">
                    <div className="waiting-pulse">
                      <Radio size={22} />
                    </div>
                    <strong>{open ? 'Waiting for the first offer' : 'No offers recorded'}</strong>
                    <p>
                      {open
                        ? 'Available providers can bid during this 30-second window.'
                        : 'Review your pack and budget before starting a new purchase.'}
                    </p>
                  </div>
                )}
                <div className="auction-footnote">
                  <ShieldCheck size={15} />
                  Prices cover the full token pack. Ties use accepted time, then bid ID.
                </div>
              </section>
              <BuyingReceipt order={order} />
              {resource.data.pack && (
                <section className="card token-auction-quota">
                  <div className="inference-section-heading">
                    <h2>Purchased quota</h2>
                    <Link
                      href={`/tokens?connect=${resource.data.pack.id}`}
                      className="button secondary small"
                    >
                      Connect token batch <ArrowRight size={14} />
                    </Link>
                  </div>
                  <PackCard pack={resource.data.pack} />
                  <p className="inference-muted">
                    {walletFunded ? (
                      <>Connect this batch to get its API key for your app, script, VM or agent.</>
                    ) : (
                      <>
                        Use a batch key for this pack, or this agent’s API key at{' '}
                        <code>/api/v1</code> to combine compatible packs from the same provider.
                      </>
                    )}{' '}
                    Token redemption is included in the prepaid price.
                  </p>
                </section>
              )}
              {['no_offers', 'cancelled', 'expired'].includes(order.status) && (
                <div className="auction-retry">
                  <Link
                    href={
                      walletFunded
                        ? '/token-orders/new'
                        : `/token-orders/new?grantId=${order.grantId}`
                    }
                    className="button primary"
                  >
                    <RefreshCw size={15} />
                    Review a new purchase
                  </Link>
                </div>
              )}
            </div>
            <aside>
              <section className="card request-summary">
                <h2>Your token pack</h2>
                <p className="request-description">Meta Muse Spark Open</p>
                <div className="token-auction-price">
                  <span>{awarded ? 'Paid once for this pack' : 'Maximum total price'}</span>
                  <strong>{money(order.priceCents ?? order.maxTotalCents)}</strong>
                </div>
                <DetailRow label="Input tokens">{count(order.inputTokens)}</DetailRow>
                <DetailRow label="Output tokens">{count(order.outputTokens)}</DetailRow>
                <DetailRow label="Funding source">
                  {walletFunded ? (
                    <Link href="/credits">Broker wallet</Link>
                  ) : (
                    <Link href={`/agents/${order.grantId}`}>{resource.data.grant.name}</Link>
                  )}
                </DetailRow>
                <DetailRow label="Maximum total">{money(order.maxTotalCents)}</DetailRow>
                <DetailRow label="Buyer fee">{money(0)}</DetailRow>
                {open && (
                  <DetailRow label="Reserved for this order">
                    {money(order.maxTotalCents)}
                  </DetailRow>
                )}
                {!instant && (
                  <DetailRow label="Auction closes">{dateTime(order.closesAt)}</DetailRow>
                )}
                <DetailRow label="Pack expiry">{dateTime(order.expiresAt)}</DetailRow>
                <DetailRow label="Created">{dateTime(order.createdAt)}</DetailRow>
                <div className="immutable-note">
                  <LockKeyhole size={14} />
                  These pack requirements are fixed.
                </div>
                {open && !instant && (
                  <button
                    className="button secondary full-width"
                    disabled={busy || Date.parse(order.closesAt) <= now}
                    onClick={() => void cancel()}
                  >
                    {busy ? <Spinner label="Cancelling" /> : 'Cancel open auction'}
                  </button>
                )}
              </section>
              <div className="info-note">
                <Clock3 size={17} />
                <p>
                  {walletFunded
                    ? `This pack expires at ${dateTime(order.expiresAt)}.`
                    : 'The pack expires with its agent budget.'}{' '}
                  Unused or expired prepaid tokens are not automatically refundable.
                </p>
              </div>
            </aside>
          </div>
        </>
      )}
    </div>
  );
}

export function ProviderInference({ search = '' }: { search?: string }) {
  const tab = new URLSearchParams(search).get('tab') === 'commitments' ? 'commitments' : 'supply';
  const resource = useResource<{ offering: TokenOffering | null; catalog: InferenceCatalog }>(
    '/api/provider/inference/offering',
  );
  const [draft, setDraft] = useState<TokenOfferingInput | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [saved, setSaved] = useState(false),
    operation = useOperationKey();
  const offering = resource.data?.offering;
  useEffect(() => {
    if (offering)
      setDraft({
        operationKey: '',
        expectedRevision: offering.revision,
        active: offering.active,
        autoBid: offering.autoBid,
        salesStartAt: offering.salesStartAt ?? null,
        salesEndAt: offering.salesEndAt ?? null,
        inputRateMicrosPerMillion: offering.inputRateMicrosPerMillion,
        outputRateMicrosPerMillion: offering.outputRateMicrosPerMillion,
        instantMarkupBps: offering.instantMarkupBps,
        minimumPriceCents: Math.max(MIN_ORDER_PRICE_CENTS, offering.minimumPriceCents),
        maxOutstandingInputTokens: offering.maxOutstandingInputTokens,
        maxOutstandingOutputTokens: offering.maxOutstandingOutputTokens,
      });
  }, [offering]);
  function change<K extends keyof TokenOfferingInput>(field: K, value: TokenOfferingInput[K]) {
    setSaved(false);
    setDraft((old) => (old ? { ...old, [field]: value } : old));
  }
  async function save(event: FormEvent) {
    event.preventDefault();
    if (!draft) return;
    setBusy(true);
    setError('');
    setSaved(false);
    const { operationKey: _key, ...input } = draft;
    try {
      await put('/api/provider/inference/offering', {
        ...input,
        operationKey: operation.next(input),
      });
      operation.complete();
      setSaved(true);
      resource.reload();
    } catch (err) {
      setError(message(err));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="inference-workspace form-page provider-inference-page">
      <PageHeader
        eyebrow="PROVIDER MARKET"
        title="AI capacity"
        description="Set the supply you offer. Protect existing commitments."
      >
        <button
          className="button secondary"
          onClick={() => {
            resource.reload();
          }}
        >
          <RefreshCw size={15} />
          Refresh
        </button>
      </PageHeader>
      <ErrorBox error={resource.error} retry={resource.reload} />
      {resource.loading && <Spinner label="Loading token supply" />}
      {resource.data && <Readiness catalog={resource.data.catalog} />}
      {resource.data && !offering && (
        <section className="card">
          <EmptyState
            icon={<ShieldCheck size={24} />}
            title="Inference provider is not configured"
            description="This account has no Modal or Baseten route assignment. An operator must configure the provider identity before you can publish token supply."
          />
        </section>
      )}
      {offering && (
        <nav className="buying-tabs" aria-label="Provider AI capacity views">
          <Link
            href="/provider/inference"
            className={tab === 'supply' ? 'active' : ''}
            aria-current={tab === 'supply' ? 'page' : undefined}
          >
            Supply & pricing
          </Link>
          <Link
            href="/provider/inference?tab=commitments"
            className={tab === 'commitments' ? 'active' : ''}
            aria-current={tab === 'commitments' ? 'page' : undefined}
          >
            Commitments
          </Link>
        </nav>
      )}
      {offering && draft && tab === 'supply' && (
        <>
          <div className="buying-provider-summary">
            <span>
              {providerName(offering.provider)} · Revision {offering.revision}
            </span>
            <span>Provider share 85% · 15% Broker commission on charged purchases</span>
          </div>
          <ProviderSupply
            offering={offering}
            onApply={(rates) => {
              change('inputRateMicrosPerMillion', rates.inputRateMicrosPerMillion);
              change('outputRateMicrosPerMillion', rates.outputRateMicrosPerMillion);
            }}
          />
          <form className="form-panel" onSubmit={save}>
            <h2>Token offering</h2>
            <p className="inference-muted">
              Prices below are buyer-facing USD per million tokens. The server enforces provider
              cost coverage after the 15% commission. Accepted packs keep their original terms.
            </p>
            <fieldset className="inference-fieldset" disabled={busy}>
              <div className="inference-form-grid">
                <div>
                  <MoneyInput
                    id="provider-input-rate"
                    label="Input price · USD / million"
                    min={0.01}
                    value={draft.inputRateMicrosPerMillion / 10000}
                    onChange={(value) =>
                      change('inputRateMicrosPerMillion', Number(moneyUnits(value) * 100n))
                    }
                  />
                  <small className="inference-muted">
                    Provider cost: {moneyMicros(BigInt(offering.costInputRateMicrosPerMillion))} /
                    million
                  </small>
                </div>
                <div>
                  <MoneyInput
                    id="provider-output-rate"
                    label="Output price · USD / million"
                    min={0.01}
                    value={draft.outputRateMicrosPerMillion / 10000}
                    onChange={(value) =>
                      change('outputRateMicrosPerMillion', Number(moneyUnits(value) * 100n))
                    }
                  />
                  <small className="inference-muted">
                    Provider cost: {moneyMicros(BigInt(offering.costOutputRateMicrosPerMillion))} /
                    million
                  </small>
                </div>
                <label className="field">
                  <span>Instant price premium · %</span>
                  <input
                    type="number"
                    min={0}
                    step={0.01}
                    required
                    value={draft.instantMarkupBps / 100}
                    onChange={(e) =>
                      change('instantMarkupBps', Math.round(Number(e.target.value) * 100))
                    }
                  />
                </label>
                <MoneyInput
                  id="provider-token-minimum"
                  label="Minimum pack price"
                  min={MIN_ORDER_PRICE_CENTS}
                  value={draft.minimumPriceCents}
                  onChange={(value) => change('minimumPriceCents', value)}
                />
                <label className="field">
                  <span>Maximum outstanding input tokens</span>
                  <input
                    type="number"
                    min={Math.max(1, offering.outstandingInputTokens)}
                    step={1}
                    required
                    value={draft.maxOutstandingInputTokens}
                    onChange={(e) => change('maxOutstandingInputTokens', Number(e.target.value))}
                  />
                </label>
                <label className="field">
                  <span>Maximum outstanding output tokens</span>
                  <input
                    type="number"
                    min={Math.max(1, offering.outstandingOutputTokens)}
                    step={1}
                    required
                    value={draft.maxOutstandingOutputTokens}
                    onChange={(e) => change('maxOutstandingOutputTokens', Number(e.target.value))}
                  />
                </label>
              </div>
              <div className="inference-inline">
                <label className="inference-checkbox">
                  <input
                    type="checkbox"
                    checked={draft.active}
                    onChange={(e) => change('active', e.target.checked)}
                    disabled={!offering.route.qualified && !draft.active}
                  />
                  Publish offering
                </label>
                <label className="inference-checkbox">
                  <input
                    type="checkbox"
                    checked={draft.autoBid}
                    onChange={(e) => change('autoBid', e.target.checked)}
                  />
                  Automatically bid on eligible auctions
                </label>
              </div>
              <SupplyWindow draft={draft} onChange={(key, value) => change(key, value)} />
            </fieldset>
            <ErrorBox error={error} />
            {saved && (
              <SuccessBox>
                Offering saved. Existing token packs retain their purchased terms.
              </SuccessBox>
            )}
            <div className="inference-dialog-actions">
              <button className="button primary" disabled={busy}>
                {busy ? <Spinner label="Saving offering" /> : 'Save token offering'}
              </button>
            </div>
          </form>
        </>
      )}
      {offering && tab === 'commitments' && <ProviderCommitments />}
    </div>
  );
}

function ProviderCommitments() {
  const packs = usePagedResource<TokenPack>('/api/provider/inference/packs', 10000);
  return (
    <TablePanel label="Token commitments and earnings">
      <TableTabs>
        <h2>Token commitments and earnings</h2>
      </TableTabs>
      <TableToolbar>
        <p className="inference-muted">
          Revenue comes from charged pack purchases. Unallocated buyer funds incur no fee. Verified
          refunds reverse the corresponding provider share and commission; no payout is collected
          here.
        </p>
      </TableToolbar>
      <ErrorBox error={packs.data ? packs.error : ''} retry={packs.reload} />
      {packs.loading ? (
        <TableState loading title="Loading commitments" />
      ) : !packs.data && packs.error ? (
        <TableState error={packs.error} onRetry={packs.reload} />
      ) : packs.data?.items.length ? (
        <TableViewport label="Provider token commitments" minWidth={1040} className="table-scroll">
          <table>
            <caption className="sr-only">Provider token commitments</caption>
            <thead>
              <tr>
                <th scope="col">Pack</th>
                <th className="numeric-cell" scope="col">
                  Outstanding quota
                </th>
                <th scope="col">Status</th>
                <th className="numeric-cell" scope="col">
                  Charged / refunded
                </th>
                <th className="numeric-cell" scope="col">
                  Provider net
                </th>
                <th className="numeric-cell" scope="col">
                  Broker fee
                </th>
              </tr>
            </thead>
            <tbody>
              {packs.data.items.map((pack) => (
                <tr key={pack.id}>
                  <td>
                    <code>{pack.id.slice(0, 12)}</code>
                    <Mode mode={pack.mode} />
                    <small>{dateTime(pack.expiresAt)}</small>
                  </td>
                  <td className="numeric-cell">
                    {count(pack.availableInputTokens + pack.heldInputTokens)} input
                    <br />
                    {count(pack.availableOutputTokens + pack.heldOutputTokens)} output
                    {(pack.heldInputTokens > 0 || pack.heldOutputTokens > 0) && (
                      <small>
                        {count(pack.heldInputTokens)} input / {count(pack.heldOutputTokens)} output
                        pending
                      </small>
                    )}
                  </td>
                  <td>
                    <State value={pack.status} />
                  </td>
                  <td className="numeric-cell">
                    <strong>{money(pack.priceCents)}</strong>
                    {pack.refundCents > 0 && <small>{money(pack.refundCents)} refunded</small>}
                  </td>
                  <td className="numeric-cell">
                    {moneyMicros(pack.revenueShare.providerNetMicros)}
                  </td>
                  <td className="numeric-cell">{moneyMicros(pack.revenueShare.brokerFeeMicros)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableViewport>
      ) : (
        <TableState
          title="No token commitments yet"
          description="Purchased packs and their exact commission shares will appear here."
        />
      )}
      <TableFooter count={packs.data?.items.length} noun="commitments">
        {' '}
        <LoadMore
          available={!!packs.nextCursor}
          loading={packs.loadingMore}
          onLoad={() => void packs.loadMore()}
          error={packs.moreError}
        />
      </TableFooter>
    </TablePanel>
  );
}
