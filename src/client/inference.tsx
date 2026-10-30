import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import {
  ArrowLeft,
  ArrowRight,
  Bot,
  Check,
  Clock3,
  Copy,
  KeyRound,
  Plus,
  RefreshCw,
  ShieldCheck,
  Sparkles,
  Wallet,
  X,
} from 'lucide-react';
import {
  INFERENCE_MODEL_ID,
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
import { api, ApiError, dateTime, money, moneyMicros, post, put } from './api';
import {
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
  remaining,
  useNavigate,
  useNow,
  usePagedResource,
  useResource,
} from './components';
import './market.css';
import './inference.css';

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
  retiring: 'Retiring',
};
function State({ value }: { value: string }) {
  return (
    <span className={`inference-state inference-state-${value}`}>{labels[value] ?? value}</span>
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
  return (
    <section className="inference-readiness" aria-label="Inference availability">
      <div className="inference-inline">
        <ShieldCheck size={18} />
        <strong>
          {catalog.mode === 'fixture'
            ? 'Fixture marketplace · no real model calls'
            : 'Provider availability'}
        </strong>
      </div>
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

export function Agents() {
  const list = usePagedResource<InferenceGrant>('/api/inference/grants', 10000),
    catalog = useResource<InferenceCatalog>('/api/inference/models'),
    wallet = useResource<CreditWallet>('/api/credits'),
    navigate = useNavigate();
  const [creating, setCreating] = useState(false),
    [name, setName] = useState(''),
    [budget, setBudget] = useState(1000),
    [maximum, setMaximum] = useState(500),
    [days, setDays] = useState(1),
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
  async function create(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError('');
    creationExpiry.current ??= new Date(Date.now() + days * 86400000).toISOString();
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
    <div className="inference-workspace">
      <PageHeader
        eyebrow="AGENT WORKSPACE"
        title="Agents"
        description="Give each agent a funded budget and one key for buying and using Meta model tokens."
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
      <div className="inference-intro">
        <span className="inference-agent-icon">
          <Bot size={26} />
        </span>
        <div>
          <h2>A budget you control. Tokens your agent can buy.</h2>
          <p>
            Fund an agent from your Broker wallet. It can repurchase input and output token packs
            within that balance; only you can add funds.
          </p>
        </div>
      </div>
      {catalog.data && <Readiness catalog={catalog.data} />}
      <ErrorBox error={catalog.error} retry={catalog.reload} />
      <ErrorBox error={list.error} retry={list.reload} />
      {list.loading ? (
        <Spinner label="Loading agents" />
      ) : !list.data?.items.length ? (
        <section className="card">
          <EmptyState
            icon={<Bot size={28} />}
            title="Your first agent starts here"
            description="Choose its budget, purchase limit and providers. Create its private API key after funding."
          >
            <button className="button primary" onClick={openCreate}>
              Create agent
            </button>
          </EmptyState>
        </section>
      ) : (
        <div className="inference-agent-grid">
          {list.data.items.map((grant) => (
            <Link href={`/agents/${grant.id}`} key={grant.id} className="card inference-agent-card">
              <div className="inference-section-heading">
                <span className="inference-agent-icon">
                  <Bot size={22} />
                </span>
                <State value={grant.status} />
              </div>
              <h2>{grant.name}</h2>
              <Mode mode={grant.mode} />
              <div className="inference-agent-balance">
                <strong>{money(grant.availableCents)}</strong>
                <span>available to purchase</span>
              </div>
              <div
                className="inference-budget-track"
                aria-label={`${money(grant.spentCents)} spent of ${money(grant.fundedCents)} funded`}
              >
                <span
                  style={{
                    width: `${Math.min(100, (grant.spentCents / Math.max(1, grant.fundedCents)) * 100)}%`,
                  }}
                />
              </div>
              <div className="inference-card-meta">
                <span>{money(grant.spentCents)} net spent</span>
                <span>{money(grant.fundedCents)} funded</span>
              </div>
              <div className="inference-card-footer">
                <span>Expires {dateTime(grant.expiresAt)}</span>
                <ArrowRight size={16} />
              </div>
            </Link>
          ))}
        </div>
      )}
      <LoadMore
        available={!!list.nextCursor}
        loading={list.loadingMore}
        onLoad={() => void list.loadMore()}
        error={list.moreError}
      />
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
                  min={1}
                  onChange={setBudget}
                />
                <MoneyInput
                  id="agent-purchase-limit"
                  label="Maximum per purchase"
                  value={maximum}
                  min={1}
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
                  value={days}
                  onChange={(e) => {
                    setDays(Number(e.target.value));
                    creationExpiry.current = null;
                  }}
                >
                  {[1, 3, 7].map((n) => (
                    <option key={n} value={n}>
                      {n} {n === 1 ? 'day' : 'days'}
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
                  budget < 1 ||
                  maximum < 1 ||
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
      {pack.retirementReason && <p className="inference-warning">{pack.retirementReason}</p>}
    </article>
  );
}

export function AgentDetail({ id }: { id: string }) {
  const resource = useResource<InferenceGrantDetail>(
    `/api/inference/grants/${encodeURIComponent(id)}`,
    5000,
  );
  const [dialog, setDialog] = useState<'fund' | 'close' | 'key' | null>(null),
    [amount, setAmount] = useState(1000),
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
    <div className="inference-workspace">
      <Link href="/agents" className="back-link">
        <ArrowLeft size={15} />
        All agents
      </Link>
      <PageHeader
        eyebrow="FUNDED AGENT"
        title={grant?.name ?? 'Agent'}
        description="Your agent buys and uses tokens within the budget you fund."
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
          <div className="inference-inline">
            <State value={grant.status} />
            <Mode mode={grant.mode} />
            <span className="inference-muted">Expires {dateTime(grant.expiresAt)}</span>
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
                  Install <code>openai</code> and supply <code>BROKER_API_KEY</code> through your
                  secret manager. Purchase a pack first.
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
                refunded. Verified provider-failure refunds restore an active budget; closed budgets
                return refunds to your wallet.
              </p>
              {grant.status === 'active' && (
                <button className="button secondary" onClick={() => open('close')}>
                  Close agent budget
                </button>
              )}
            </section>
          </div>
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
          <section className="card">
            <h2>Recent token orders</h2>
            {detail.orders.length ? (
              <div className="table-scroll">
                <table>
                  <thead>
                    <tr>
                      <th>Order</th>
                      <th>Tokens</th>
                      <th>Status</th>
                      <th>Price / ceiling</th>
                    </tr>
                  </thead>
                  <tbody>
                    {detail.orders.map((order) => (
                      <tr key={order.id}>
                        <td>
                          <Link href={`/token-orders/${order.id}`} className="text-link">
                            {order.mode === 'auction' ? '30-second auction' : 'Instant purchase'}{' '}
                            <ArrowRight size={12} />
                          </Link>
                          <small>{dateTime(order.createdAt)}</small>
                        </td>
                        <td>
                          {count(order.inputTokens)} input · {count(order.outputTokens)} output
                        </td>
                        <td>
                          <State value={order.status} />
                        </td>
                        <td>{money(order.priceCents ?? order.maxTotalCents)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="inference-muted">Purchases made by you or this agent appear here.</p>
            )}
          </section>
          <section className="card">
            <h2>Recent inference requests</h2>
            {detail.requests.length ? (
              <div className="table-scroll">
                <table>
                  <thead>
                    <tr>
                      <th>Request</th>
                      <th>Provider</th>
                      <th>Status</th>
                      <th>Input / output</th>
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
                        <td>
                          {request.inputTokens !== null
                            ? `${count(request.inputTokens)} / ${count(request.outputTokens ?? 0)} used`
                            : `${count(request.heldInputTokens)} / ${count(request.heldOutputTokens)} held`}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="inference-muted">
                Request usage and any unresolved token holds appear here.
              </p>
            )}
            <p className="inference-muted">
              Unknown outcomes keep their token reservation until reconciled. Retrying the same
              request ID never starts another generation.
            </p>
          </section>
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
                  min={1}
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
                disabled={busy || (dialog === 'fund' && amount < 1)}
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
    catalog = useResource<InferenceCatalog>('/api/inference/models');
  const [grantId, setGrantId] = useState(initial),
    [inputTokens, setInputTokens] = useState(1000000),
    [outputTokens, setOutputTokens] = useState(100000),
    [mode, setMode] = useState<'auction' | 'instant'>('auction'),
    [maximum, setMaximum] = useState(500),
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
  const grant =
    selectedDetail.data?.grant ?? grants.data?.items.find((item) => item.id === grantId);
  const activeGrants =
    grants.data?.items.filter(
      (item) => item.status === 'active' && Date.parse(item.expiresAt) > now,
    ) ?? [];
  const routes =
    catalog.data?.routes.filter(
      (route) => route.qualified && (!grant || grant.allowedProviders.includes(route.provider)),
    ) ?? [];
  const eligible =
    !!catalog.data?.enabled &&
    routes.length > 0 &&
    grant?.status === 'active' &&
    Date.parse(grant.expiresAt) > now;
  const selected = quotes.find((quote) => quote.quoteId === quoteId),
    quoteFresh = !!selected && Date.parse(selected.expiresAt) > now;
  useEffect(() => {
    if (!grantId && activeGrants.length) setGrantId(activeGrants[0]!.id);
  }, [grants.data, grantId]);
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
      inputTokens < 1 ||
      outputTokens < 1
    ) {
      setError('Enter a positive whole number of input and output tokens.');
      return;
    }
    const revision = ++quoteRevision.current;
    setQuoting(true);
    setError('');
    try {
      const result = await post<{ items: TokenQuote[] }>('/api/inference/quotes', {
        grantId,
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
      inputTokens < 1 ||
      outputTokens < 1 ||
      !price ||
      price > Math.min(grant?.availableCents ?? 0, grant?.maxPurchaseCents ?? 0) ||
      (mode === 'instant' && (!quoteFresh || !grant?.allowInstant))
    )
      return;
    setBusy(true);
    setError('');
    const input = {
      grantId,
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
    <div className="inference-workspace">
      <Link href={initial ? `/agents/${initial}` : '/orders'} className="back-link">
        <ArrowLeft size={15} />
        {initial ? 'Back to agent' : 'All orders'}
      </Link>
      <PageHeader
        eyebrow="NEW ORDER · AI TOKENS"
        title="Buy a token pack"
        description="Prepay for Meta Muse Spark Open. Use your agent’s key for every request."
      />
      <div className="inference-order-switch">
        <Link href="/new">VM auction</Link>
        <Link href="/agreements/new">Scheduled VMs</Link>
        <span>AI tokens</span>
      </div>
      {catalog.data && <Readiness catalog={catalog.data} />}
      <ErrorBox
        error={catalog.error || grants.error || selectedDetail.error}
        retry={() => {
          catalog.reload();
          grants.reload();
          selectedDetail.reload();
        }}
      />
      <form className="inference-composer-grid" onSubmit={purchase}>
        <section className="card">
          <h2>Choose your pack</h2>
          <fieldset disabled={busy || !!uncertainOrder} className="inference-fieldset">
            <label className="field">
              <span>Funded agent</span>
              <select
                value={grantId}
                onChange={(e) => {
                  setGrantId(e.target.value);
                  invalidate();
                }}
                required
              >
                <option value="">Choose an agent</option>
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
            <LoadMore
              available={!!grants.nextCursor}
              loading={grants.loadingMore}
              onLoad={() => void grants.loadMore()}
              error={grants.moreError}
            />
            <Link href="/agents" className="text-link">
              Create or fund an agent <ArrowRight size={13} />
            </Link>
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
                  min={1}
                  max={1000000000}
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
                  max={1000000000}
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
                  disabled={!grant?.allowInstant}
                  onChange={() => {
                    setMode('instant');
                    setAccepted(false);
                  }}
                />
                <span>
                  <strong>Buy at an instant price</strong>
                  <small>
                    {grant?.allowInstant
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
                min={1}
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
                  disabled={quoting || !eligible || inputTokens < 1 || outputTokens < 1}
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
          </fieldset>
        </section>
        <aside className="card inference-purchase-summary">
          <span className="eyebrow">YOUR PURCHASE</span>
          <h2>
            {count(inputTokens)} input
            <br />
            <span>+ {count(outputTokens)} output tokens</span>
          </h2>
          <dl className="inference-definitions">
            <div>
              <dt>Model</dt>
              <dd>Meta Muse Spark Open</dd>
            </div>
            <div>
              <dt>Agent</dt>
              <dd>{grant?.name ?? 'Choose an agent'}</dd>
            </div>
            <div>
              <dt>Available budget</dt>
              <dd>{money(grant?.availableCents)}</dd>
            </div>
            <div>
              <dt>Per-purchase limit</dt>
              <dd>{money(grant?.maxPurchaseCents)}</dd>
            </div>
            <div>
              <dt>{mode === 'auction' ? 'Maximum hold' : 'Fixed pack price'}</dt>
              <dd>
                {mode === 'auction'
                  ? money(maximum)
                  : selected
                    ? money(selected.priceCents)
                    : 'Get a quote'}
              </dd>
            </div>
          </dl>
          <p className="inference-muted">
            Whole-cent price, charged once when purchased. Using prepaid tokens does not charge the
            budget again. The pack expires by the agent’s budget expiry.
          </p>
          <label className="inference-checkbox">
            <input
              type="checkbox"
              checked={accepted}
              disabled={busy || !!uncertainOrder}
              onChange={(e) => setAccepted(e.target.checked)}
            />
            <span>
              I understand that purchased tokens are prepaid and unused or expired tokens are not
              automatically refundable.
            </span>
          </label>
          {!eligible && (
            <p className="inference-warning">
              Select an active funded agent with a qualified provider route to purchase.
            </p>
          )}
          <ErrorBox error={error} />
          <button
            className="button primary full-width"
            disabled={
              busy ||
              (!uncertainOrder &&
                (!eligible ||
                  !accepted ||
                  inputTokens < 1 ||
                  outputTokens < 1 ||
                  (mode === 'instant'
                    ? !quoteFresh ||
                      !grant?.allowInstant ||
                      selected!.priceCents >
                        Math.min(grant?.availableCents ?? 0, grant?.maxPurchaseCents ?? 0)
                    : maximum < 1 ||
                      maximum >
                        Math.min(grant?.availableCents ?? 0, grant?.maxPurchaseCents ?? 0))))
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
        </aside>
      </form>
    </div>
  );
}

export function TokenOrderPage({ id }: { id: string }) {
  const resource = useResource<TokenOrderDetail>(
      `/api/token-orders/${encodeURIComponent(id)}`,
      2000,
    ),
    now = useNow(),
    operation = useOperationKey();
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const order = resource.data?.order;
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
  return (
    <div className="inference-workspace">
      <Link href="/orders?kind=token" className="back-link">
        <ArrowLeft size={15} />
        Token orders
      </Link>
      <PageHeader
        eyebrow="AI TOKEN ORDER"
        title={order?.mode === 'instant' ? 'Instant token purchase' : 'Token pack auction'}
        description="A saved order for input and output tokens."
      >
        {resource.data && (
          <Link href={`/agents/${resource.data.grant.id}`} className="button secondary">
            View agent <ArrowRight size={15} />
          </Link>
        )}
      </PageHeader>
      <ErrorBox error={resource.error} retry={resource.reload} />
      <ErrorBox error={error} />
      {resource.loading && <Spinner label="Loading token order" />}
      {order && resource.data && (
        <>
          <section className="card inference-order-hero">
            <div>
              <div className="inference-inline">
                <State value={order.status} />
                <Mode mode={order.sourceMode} />
              </div>
              <h2>
                {count(order.inputTokens)} input + {count(order.outputTokens)} output
              </h2>
              <p>{order.modelId}</p>
              <code className="inference-muted">{order.id}</code>
            </div>
            <div className="inference-order-price">
              <span>
                {order.priceCents !== null ? 'Paid once for this pack' : 'Maximum total price'}
              </span>
              <strong>{money(order.priceCents ?? order.maxTotalCents)}</strong>
              {order.status === 'open' && (
                <span className="inference-inline">
                  <Clock3 size={15} />
                  {remaining(order.closesAt, now)} remaining
                </span>
              )}
            </div>
          </section>
          {order.sourceMode === 'fixture' && (
            <p className="inference-readiness">
              Fixture order · simulated bids and token usage. No real model is called.
            </p>
          )}
          <div className="inference-detail-grid">
            <section className="card">
              <h2>Provider bids</h2>
              {resource.data.bids.length ? (
                <div className="inference-bids">
                  {resource.data.bids.map((bid) => (
                    <div key={bid.id}>
                      <span>
                        <strong>{providerName(bid.provider)}</strong>
                        <small>
                          {bid.status === 'won'
                            ? 'Winning provider'
                            : bid.status === 'lost'
                              ? 'Not selected'
                              : 'Binding offer'}
                        </small>
                      </span>
                      <strong>{money(bid.priceCents)}</strong>
                      {bid.status === 'won' && <Check size={18} />}
                    </div>
                  ))}
                </div>
              ) : (
                <p className="inference-muted">
                  {order.status === 'open'
                    ? 'Waiting for eligible provider bids.'
                    : 'No provider bids were accepted.'}
                </p>
              )}
              <p className="inference-muted">
                The lowest eligible fixed price wins. Equal prices use acceptance time, then bid ID.
              </p>
            </section>
            <section className="card">
              <h2>Order details</h2>
              <dl className="inference-definitions">
                <div>
                  <dt>Agent</dt>
                  <dd>
                    <Link href={`/agents/${order.grantId}`}>{resource.data.grant.name}</Link>
                  </dd>
                </div>
                <div>
                  <dt>Created</dt>
                  <dd>{dateTime(order.createdAt)}</dd>
                </div>
                <div>
                  <dt>Auction close</dt>
                  <dd>{dateTime(order.closesAt)}</dd>
                </div>
                <div>
                  <dt>Pack expiry</dt>
                  <dd>{dateTime(order.expiresAt)}</dd>
                </div>
              </dl>
              {order.status === 'open' && (
                <button className="button secondary" disabled={busy} onClick={() => void cancel()}>
                  {busy ? <Spinner label="Cancelling" /> : 'Cancel open auction'}
                </button>
              )}
              {['no_offers', 'cancelled', 'expired'].includes(order.status) && (
                <Link
                  href={`/token-orders/new?grantId=${order.grantId}`}
                  className="button secondary"
                >
                  Review a new purchase <ArrowRight size={14} />
                </Link>
              )}
            </section>
          </div>
          {resource.data.pack && (
            <section className="card">
              <h2>Purchased quota</h2>
              <PackCard pack={resource.data.pack} />
              <p className="inference-muted">
                Use this agent’s API key at <code>/api/v1</code>. Token redemption is included in
                the prepaid price.
              </p>
            </section>
          )}
        </>
      )}
    </div>
  );
}

export function ProviderInference() {
  const resource = useResource<{ offering: TokenOffering | null; catalog: InferenceCatalog }>(
      '/api/provider/inference/offering',
    ),
    packs = usePagedResource<TokenPack>('/api/provider/inference/packs', 10000);
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
        inputRateMicrosPerMillion: offering.inputRateMicrosPerMillion,
        outputRateMicrosPerMillion: offering.outputRateMicrosPerMillion,
        instantMarkupBps: offering.instantMarkupBps,
        minimumPriceCents: offering.minimumPriceCents,
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
    <div className="inference-workspace">
      <PageHeader
        eyebrow="PROVIDER MARKET"
        title="AI token supply"
        description="Publish fixed token-pack pricing and manage the quota you commit."
      >
        <button
          className="button secondary"
          onClick={() => {
            resource.reload();
            packs.reload();
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
      {offering && draft && (
        <>
          <div className="inference-stats">
            <StatCard
              label="Provider"
              value={providerName(offering.provider)}
              note={`Revision ${offering.revision}`}
            />
            <StatCard
              label="Committed input quota"
              value={count(offering.outstandingInputTokens)}
              note={`${count(offering.maxOutstandingInputTokens)} capacity`}
            />
            <StatCard
              label="Committed output quota"
              value={count(offering.outstandingOutputTokens)}
              note={`${count(offering.maxOutstandingOutputTokens)} capacity`}
            />
            <StatCard
              label="Provider share"
              value="85%"
              note="15% Broker commission on charged purchases"
            />
          </div>
          <form className="card" onSubmit={save}>
            <h2>Token offering</h2>
            <p className="inference-muted">
              Prices below are buyer-facing USD per million tokens. The server enforces provider
              cost coverage after the 15% commission. Accepted packs keep their original terms.
            </p>
            <fieldset className="inference-fieldset" disabled={busy}>
              <div className="inference-form-grid">
                <label className="field">
                  <span>Input price · USD / million</span>
                  <input
                    type="number"
                    min={0.000001}
                    step={0.000001}
                    required
                    value={draft.inputRateMicrosPerMillion / 1000000}
                    onChange={(e) =>
                      change(
                        'inputRateMicrosPerMillion',
                        Math.round(Number(e.target.value) * 1000000),
                      )
                    }
                  />
                  <small>
                    Provider cost: {moneyMicros(BigInt(offering.costInputRateMicrosPerMillion))} /
                    million
                  </small>
                </label>
                <label className="field">
                  <span>Output price · USD / million</span>
                  <input
                    type="number"
                    min={0.000001}
                    step={0.000001}
                    required
                    value={draft.outputRateMicrosPerMillion / 1000000}
                    onChange={(e) =>
                      change(
                        'outputRateMicrosPerMillion',
                        Math.round(Number(e.target.value) * 1000000),
                      )
                    }
                  />
                  <small>
                    Provider cost: {moneyMicros(BigInt(offering.costOutputRateMicrosPerMillion))} /
                    million
                  </small>
                </label>
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
                  min={1}
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
      <section className="card">
        <h2>Token commitments and earnings</h2>
        <p className="inference-muted">
          Revenue comes from charged pack purchases. Unallocated buyer funds incur no fee. Verified
          refunds reverse the corresponding provider share and commission; no payout is collected
          here.
        </p>
        <ErrorBox error={packs.error} retry={packs.reload} />
        {packs.loading ? (
          <Spinner label="Loading commitments" />
        ) : packs.data?.items.length ? (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Pack</th>
                  <th>Outstanding quota</th>
                  <th>Status</th>
                  <th>Charged / refunded</th>
                  <th>Provider net</th>
                  <th>Broker fee</th>
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
                    <td>
                      {count(pack.availableInputTokens + pack.heldInputTokens)} input
                      <br />
                      {count(pack.availableOutputTokens + pack.heldOutputTokens)} output
                    </td>
                    <td>
                      <State value={pack.status} />
                    </td>
                    <td>
                      {money(pack.priceCents)} / {money(pack.refundCents)}
                    </td>
                    <td>{moneyMicros(pack.revenueShare.providerNetMicros)}</td>
                    <td>{moneyMicros(pack.revenueShare.brokerFeeMicros)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="inference-muted">
            Purchased packs and their exact commission shares will appear here.
          </p>
        )}
        <LoadMore
          available={!!packs.nextCursor}
          loading={packs.loadingMore}
          onLoad={() => void packs.loadMore()}
          error={packs.moreError}
        />
      </section>
    </div>
  );
}
