import { useState, type FormEvent } from 'react';
import { Copy, KeyRound, Plus, RefreshCw, ShieldCheck, X } from 'lucide-react';
import { api, ApiError, dateTime, post } from './api';
import {
  EmptyState,
  ErrorBox,
  LoadMore,
  MarketDialog,
  PageHeader,
  Spinner,
  SuccessBox,
  usePagedResource,
  useSession,
} from './components';
import {
  defaultScopes,
  scopesForRole,
  type BrokerKeyLimits,
  type BrokerKeySummary,
  type BrokerScope,
} from '../shared/developer';
import './developer-keys.css';

const labels: Record<BrokerScope, string> = {
  'account:read': 'Read account identity',
  'catalog:read': 'Read approved configurations',
  'muse:propose': 'Request Muse proposals',
  'orders:read': 'Read orders and alternatives',
  'orders:write': 'Create, cancel and retry orders; accept alternatives',
  'agreements:read': 'Read and preview agreements',
  'agreements:write': 'Place agreements and cancel unmatched capacity',
  'agreements:activate': 'Start booked environments',
  'vms:read': 'Read environments',
  'vms:terminal': 'Connect to environment terminals',
  'vms:terminate': 'Terminate environments',
  'billing:read': 'Read wallet and billing history',
  'provider:read': 'Read provider capacity, demand and earnings',
  'provider:bids:write': 'Submit provider bids',
  'provider:capacity:write': 'Change available capacity',
  'provider:policy:write': 'Apply selling policies',
  'provider:offerings:write': 'Publish and update offerings',
};
const shortMoney = (cents?: number) => (cents === undefined ? '—' : `$${(cents / 100).toFixed(2)}`);
function Limits({ value }: { value: BrokerKeyLimits }) {
  return (
    <span className="key-limits">
      {[
        value.maxAuctionCents !== undefined ? `${shortMoney(value.maxAuctionCents)} / order` : null,
        value.maxAgreementReservationCents !== undefined
          ? `${shortMoney(value.maxAgreementReservationCents)} / agreement`
          : null,
        value.maxActivationQuantity !== undefined
          ? `${value.maxActivationQuantity} / activation`
          : null,
      ]
        .filter(Boolean)
        .join(' · ') || 'No purchasing permissions'}
    </span>
  );
}
export function DeveloperKeys() {
  const session = useSession(),
    role = session.user!.role;
  const list = usePagedResource<BrokerKeySummary>('/api/keys');
  const [creating, setCreating] = useState(false),
    [name, setName] = useState(''),
    [days, setDays] = useState(30),
    [scopes, setScopes] = useState<BrokerScope[]>(() => defaultScopes(role)),
    [auction, setAuction] = useState(''),
    [agreement, setAgreement] = useState(''),
    [quantity, setQuantity] = useState(1),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [created, setCreated] = useState<{ key: BrokerKeySummary; token: string } | null>(null),
    [copied, setCopied] = useState(false),
    [revoking, setRevoking] = useState<BrokerKeySummary | null>(null);
  function openCreate() {
    setName('');
    setDays(30);
    setScopes(defaultScopes(role));
    setAuction('');
    setAgreement('');
    setQuantity(1);
    setError('');
    setCreating(true);
  }
  async function create(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError('');
    const limits: BrokerKeyLimits = {};
    if (scopes.includes('orders:write')) limits.maxAuctionCents = Math.round(Number(auction) * 100);
    if (scopes.includes('agreements:write'))
      limits.maxAgreementReservationCents = Math.round(Number(agreement) * 100);
    if (scopes.includes('agreements:activate')) limits.maxActivationQuantity = quantity;
    try {
      const result = await post<{ key: BrokerKeySummary; token: string }>('/api/keys', {
        name,
        scopes,
        limits,
        expiresInDays: days,
      });
      setCreated(result);
      setCopied(false);
      setCreating(false);
      list.reload();
    } catch (err) {
      setError(
        err instanceof ApiError
          ? err.message
          : 'Could not confirm key creation. Refresh the list and revoke any key whose secret you did not receive before creating another.',
      );
    } finally {
      setBusy(false);
    }
  }
  async function revoke() {
    if (!revoking) return;
    setBusy(true);
    setError('');
    try {
      await api(`/api/keys/${revoking.id}`, { method: 'DELETE' });
      setRevoking(null);
      list.reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not revoke this key.');
    } finally {
      setBusy(false);
    }
  }
  async function copy() {
    try {
      await navigator.clipboard.writeText(created!.token);
      setCopied(true);
    } catch {
      setError('Clipboard access is unavailable. Select and copy the key below.');
    }
  }
  return (
    <div className="developer-keys">
      <PageHeader
        eyebrow="DEVELOPER ACCESS"
        title="API keys"
        description="Connect your scripts and agents to Wick Broker with permissions you control."
      >
        <button className="button secondary" onClick={list.reload}>
          <RefreshCw size={15} />
          Refresh
        </button>
        <button className="button primary" onClick={openCreate}>
          <Plus size={16} />
          Create key
        </button>
      </PageHeader>
      <div className="key-boundary">
        <ShieldCheck size={18} />
        <div>
          <strong>Broker keys are separate from Wick keys.</strong>
          <p>
            These keys access your Broker account. Wick infrastructure credentials stay on the
            server.
          </p>
        </div>
      </div>
      <ErrorBox
        error={list.error || (!creating && !revoking && !created ? error : '')}
        retry={list.error ? list.reload : undefined}
      />
      <section className="card key-list">
        <div className="section-heading">
          <h2>Your keys</h2>
          <span>Up to 20 active keys</span>
        </div>
        {list.loading ? (
          <Spinner label="Loading API keys" />
        ) : !list.data?.items.length ? (
          <EmptyState
            icon={<KeyRound size={24} />}
            title="Connect your first client"
            description="Create a read-only key, then choose additional permissions when your agent needs them."
          >
            <button className="button secondary" onClick={openCreate}>
              Create key
            </button>
          </EmptyState>
        ) : (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Name / prefix</th>
                  <th>Access</th>
                  <th>Per-operation limits</th>
                  <th>Last used</th>
                  <th>Expires</th>
                  <th>Status</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {list.data.items.map((key) => {
                  const expired = Date.parse(key.expiresAt) <= Date.now(),
                    inactive = !!key.revokedAt || expired;
                  return (
                    <tr key={key.id}>
                      <td>
                        <strong>{key.name}</strong>
                        <code className="key-prefix">{key.prefix.slice(0, 18)}…</code>
                      </td>
                      <td>
                        <details>
                          <summary>{key.scopes.length} permissions</summary>
                          <ul>
                            {key.scopes.map((scope) => (
                              <li key={scope}>{labels[scope]}</li>
                            ))}
                          </ul>
                        </details>
                      </td>
                      <td>
                        <Limits value={key.limits} />
                      </td>
                      <td>{key.lastUsedAt ? dateTime(key.lastUsedAt) : 'Never'}</td>
                      <td>{dateTime(key.expiresAt)}</td>
                      <td>
                        <span className={`key-status ${inactive ? 'inactive' : ''}`}>
                          {key.revokedAt ? 'Revoked' : expired ? 'Expired' : 'Active'}
                        </span>
                      </td>
                      <td>
                        {!key.revokedAt && (
                          <button
                            className="text-button"
                            onClick={() => {
                              setError('');
                              setRevoking(key);
                            }}
                          >
                            Revoke
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        <LoadMore
          available={!!list.nextCursor}
          loading={list.loadingMore}
          onLoad={() => void list.loadMore()}
          error={list.moreError}
        />
      </section>
      <section className="card key-setup">
        <div className="section-heading">
          <h2>Use your key</h2>
          <span>SDK · CLI · MCP</span>
        </div>
        <p>
          Use <code>WICK_BROKER_API_KEY</code> for authentication and{' '}
          <code>WICK_BROKER_API_URL</code> for your Broker URL. Never substitute a Wick
          infrastructure key.
        </p>
        <h3>Install the clients</h3>
        <pre>
          {[
            'npm install \\',
            `  ${window.location.origin}/downloads/0.1.0/wick-cloud-broker-sdk-0.1.0.tgz \\`,
            `  ${window.location.origin}/downloads/0.1.0/wick-cloud-broker-cli-0.1.0.tgz \\`,
            `  ${window.location.origin}/downloads/0.1.0/wick-cloud-broker-mcp-0.1.0.tgz`,
          ].join('\n')}
        </pre>
        <div className="key-setup-grid">
          <div>
            <h3>TypeScript SDK</h3>
            <pre>{`import { BrokerClient } from '@wick-cloud/broker-sdk';\n\nconst broker = new BrokerClient({\n  apiKey: process.env.WICK_BROKER_API_KEY!,\n  baseUrl: '${window.location.origin}',\n});\nconst orders = await broker.orders.list();`}</pre>
          </div>
          <div>
            <h3>CLI</h3>
            <pre>{`npx --no-install wick-broker auth login --api-url ${window.location.origin}\nnpx --no-install wick-broker orders list --json`}</pre>
            <h3>Local MCP</h3>
            <pre>{`node /absolute/path/to/your/project/node_modules/@wick-cloud/broker-mcp/dist/index.js`}</pre>
            <p>
              Your MCP host supplies the Broker key through its private environment configuration.
            </p>
          </div>
        </div>
        <p className="key-fine">
          Permissions and limits apply to all clients. Limits are per operation, not daily or
          lifetime budgets. Revoking a key stops access; existing orders and commitments continue.
        </p>
      </section>
      {creating && (
        <MarketDialog titleId="create-key-heading" onClose={() => setCreating(false)} busy={busy}>
          <form onSubmit={create} className="key-create-form">
            <div className="key-dialog-heading">
              <h2 id="create-key-heading">Create Broker API key</h2>
              <button
                type="button"
                className="icon-button"
                aria-label="Close key creation"
                onClick={() => setCreating(false)}
                disabled={busy}
              >
                <X size={19} />
              </button>
            </div>
            <div className="key-basic-fields">
              <label className="field">
                <span>Name</span>
                <input
                  autoFocus
                  required
                  maxLength={64}
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Development agent"
                />
              </label>
              <label className="field">
                <span>Expires in</span>
                <select value={days} onChange={(e) => setDays(Number(e.target.value))}>
                  {[1, 7, 30, 90].map((n) => (
                    <option key={n} value={n}>
                      {n} {n === 1 ? 'day' : 'days'}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <fieldset className="key-scopes">
              <legend>Permissions</legend>
              <p>
                Read access is selected by default. Grant write access only for operations this
                client should perform.
              </p>
              {scopesForRole(role).map((scope) => (
                <label key={scope} className="key-scope">
                  <input
                    type="checkbox"
                    checked={scopes.includes(scope)}
                    disabled={scope === 'account:read'}
                    onChange={(e) =>
                      setScopes((old) =>
                        e.target.checked ? [...old, scope] : old.filter((s) => s !== scope),
                      )
                    }
                  />
                  <span>
                    {labels[scope]}
                    <code>{scope}</code>
                  </span>
                </label>
              ))}
            </fieldset>
            {role === 'buyer' &&
              (scopes.includes('orders:write') ||
                scopes.includes('agreements:write') ||
                scopes.includes('agreements:activate')) && (
                <fieldset className="key-operation-limits">
                  <legend>Per-operation limits</legend>
                  <p>
                    These limits apply to each operation. Multiple operations can exceed these
                    amounts in total.
                  </p>
                  <div className="key-limit-fields">
                    {scopes.includes('orders:write') && (
                      <label className="field">
                        <span>Maximum order budget · USD</span>
                        <input
                          type="number"
                          min="0.01"
                          max="1000000"
                          step="0.01"
                          required
                          value={auction}
                          onChange={(e) => setAuction(e.target.value)}
                        />
                      </label>
                    )}
                    {scopes.includes('agreements:write') && (
                      <label className="field">
                        <span>Maximum agreement reservation · USD</span>
                        <input
                          type="number"
                          min="0.01"
                          max="1000000"
                          step="0.01"
                          required
                          value={agreement}
                          onChange={(e) => setAgreement(e.target.value)}
                        />
                      </label>
                    )}
                    {scopes.includes('agreements:activate') && (
                      <label className="field">
                        <span>Maximum VMs per activation</span>
                        <input
                          type="number"
                          min="1"
                          max="20"
                          step="1"
                          required
                          value={quantity}
                          onChange={(e) => setQuantity(Number(e.target.value))}
                        />
                      </label>
                    )}
                  </div>
                </fieldset>
              )}
            <ErrorBox error={error} />
            <div className="key-dialog-actions">
              <button
                type="button"
                className="button secondary"
                disabled={busy}
                onClick={() => setCreating(false)}
              >
                Cancel
              </button>
              <button className="button primary" disabled={busy || !scopes.length}>
                {busy ? <Spinner label="Creating key" /> : 'Create key'}
              </button>
            </div>
          </form>
        </MarketDialog>
      )}
      {created && (
        <MarketDialog
          titleId="key-created-heading"
          onClose={() => {
            setCreated(null);
            setError('');
          }}
        >
          <div className="key-dialog-heading">
            <h2 id="key-created-heading">Save your key</h2>
            <KeyRound size={23} />
          </div>
          <p>
            This secret is shown once. Store it in your agent’s secret manager or sign in through
            the CLI’s hidden prompt.
          </p>
          <label className="field">
            <span>{created.key.name}</span>
            <input
              className="key-secret"
              readOnly
              value={created.token}
              onFocus={(e) => e.target.select()}
              aria-label="New Broker API key"
              autoComplete="off"
              spellCheck={false}
            />
          </label>
          <button className="button secondary" onClick={() => void copy()}>
            <Copy size={15} />
            {copied ? 'Copied' : 'Copy key'}
          </button>
          {copied && <SuccessBox>Copied. Keep the key private.</SuccessBox>}
          <ErrorBox error={error} />
          <p className="key-fine">
            If you lose this secret, revoke this key and create a replacement. It cannot be
            recovered.
          </p>
          <div className="key-dialog-actions">
            <button
              className="button primary"
              onClick={() => {
                setCreated(null);
                setError('');
              }}
            >
              I’ve saved the key
            </button>
          </div>
        </MarketDialog>
      )}
      {revoking && (
        <MarketDialog titleId="revoke-key-heading" onClose={() => setRevoking(null)} busy={busy}>
          <h2 id="revoke-key-heading">Revoke {revoking.name}?</h2>
          <p>
            API access stops and attached terminals disconnect. Existing orders, commitments and
            saved provider policies continue.
          </p>
          <ErrorBox error={error} />
          <div className="key-dialog-actions">
            <button className="button secondary" disabled={busy} onClick={() => setRevoking(null)}>
              Keep key
            </button>
            <button className="button primary" disabled={busy} onClick={() => void revoke()}>
              {busy ? <Spinner label="Revoking key" /> : 'Revoke key'}
            </button>
          </div>
        </MarketDialog>
      )}
    </div>
  );
}
