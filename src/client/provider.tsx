import {
  TableActions,
  TableFooter,
  TableIdentity,
  TablePanel,
  TableState,
  TableStatus,
  TableToolbar,
  TableViewport,
} from './table';
import './provider-console.css';
import {
  ComputePromotionBadge,
  ComputePromotionNotice,
  modalPromotionPreview,
} from './compute-promotion';
import { FormLayout, FormPage, FormPanel, FormSection, FormSummary } from './form-layout';
import { isMoneyCents, moneyUnits } from '../shared/money';
import { Fragment, useEffect, useState, type FormEvent, type ReactNode } from 'react';
import {
  Activity,
  ArrowRight,
  Check,
  CheckCircle2,
  Clock3,
  CircleDollarSign,
  ChevronDown,
  Cpu,
  Eye,
  Globe2,
  Layers3,
  Plus,
  Radio,
  RefreshCw,
  Save,
  Server,
  ShieldCheck,
  Sparkles,
  X,
} from 'lucide-react';
import type {
  BidProposal,
  CatalogItem,
  Mode,
  OfferingProposal,
  Receipt,
  SupplierPolicy,
} from '../shared/types';
import { fixedQuote, managedPricing, revenueShare } from '../shared/pricing';
import { AgreementCharges } from './agreement-charges';
import {
  ApiError,
  api,
  DEFAULT_PRICE_CENTS,
  museLabel,
  MUSE_MODEL,
  cloudRouteName,
  regionName,
  dateTime,
  money,
  moneyMicros,
  post,
  put,
  shortDate,
  type Activity as ActivityItem,
  type Dashboard,
  type EnvironmentRequest,
  type Offering,
  type PolicyProposal,
  type ProviderEarning,
  type VM,
} from './api';
import {
  DetailRow,
  EmptyState,
  ErrorBox,
  Link,
  LoadMore,
  MoneyInput,
  PageHeader,
  ReceiptCard,
  Spinner,
  StatCard,
  StatusPill,
  SuccessBox,
  remaining,
  useNow,
  usePagedResource,
  useResource,
  useSession,
} from './components';

function ProviderRevenueSplit({ grossCents }: { grossCents: number }) {
  if (!isMoneyCents(grossCents) || grossCents < 0.01 || grossCents > 100000000) return null;
  const split = revenueShare(grossCents);
  return (
    <div className="provider-revenue-split" aria-label="Rental revenue breakdown">
      <DetailRow label="Buyer pays · your gross">{money(grossCents)}</DetailRow>
      <DetailRow label="Broker commission · 15%">{moneyMicros(split.brokerFeeMicros)}</DetailRow>
      <DetailRow label="You keep · 85%">{moneyMicros(split.providerNetMicros)}</DetailRow>
      <p className="field-hint">
        Your share is before compute costs. No fee is added to the buyer’s price.
      </p>
    </div>
  );
}

function ProviderPageState({
  title,
  eyebrow,
  children,
}: {
  title: string;
  eyebrow: string;
  children: ReactNode;
}) {
  return (
    <FormPage title={title} eyebrow={eyebrow} className="provider-page">
      <FormPanel>
        <FormSection>{children}</FormSection>
      </FormPanel>
    </FormPage>
  );
}

export function ProviderCapacity() {
  const { data, error, loading, reload } = useResource<Dashboard>('/api/provider/dashboard', 5000);
  const [total, setTotal] = useState<number | null>(null),
    [capacityRevision, setCapacityRevision] = useState<number | null>(null),
    [busy, setBusy] = useState(false),
    [actionError, setActionError] = useState(''),
    [saved, setSaved] = useState(false);
  async function save(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setActionError('');
    setSaved(false);
    try {
      await put('/api/provider/capacity', {
        total: total ?? data?.capacity.total,
        expectedRevision: capacityRevision ?? data?.policyRevision,
      });
      setTotal(null);
      setCapacityRevision(null);
      setSaved(true);
      reload();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Capacity could not be updated.');
      setTotal(null);
      setCapacityRevision(null);
      reload();
    } finally {
      setBusy(false);
    }
  }
  if (loading || !data)
    return (
      <ProviderPageState title="Capacity" eyebrow="PROVIDER WORKSPACE">
        {loading ? (
          <Spinner label="Loading your capacity" />
        ) : (
          <ErrorBox error={error || 'Provider unavailable.'} retry={reload} />
        )}
      </ProviderPageState>
    );
  const { capacity, provider } = data;
  const protectedSpare = Math.max(0, capacity.total - capacity.held - capacity.available);
  const share = (quantity: number) =>
    `${capacity.total ? Math.min(100, (quantity / capacity.total) * 100) : 0}%`;
  return (
    <div className="form-page provider-page">
      <PageHeader
        eyebrow="PROVIDER WORKSPACE"
        title="Capacity"
        description={`${provider.name} · Manage runtime allocation and availability.`}
      >
        <span className="quiet-badge">
          {provider.simulated ? 'Simulated demo supply' : 'Wick-managed allocation'}
        </span>
        <Link className="button secondary" href="/provider/sales">
          <Sparkles size={15} /> Improve my sales
        </Link>
      </PageHeader>
      <nav className="provider-setup-guide" aria-label="Provider setup">
        <span className="provider-setup-label">Start selling</span>
        <ol>
          <li>
            <Link href="/provider/offerings">
              <span>1</span> Publish an offering <ArrowRight size={14} />
            </Link>
          </li>
          <li>
            <Link href="/provider/policy">
              <span>2</span> Set bidding policy <ArrowRight size={14} />
            </Link>
          </li>
          <li>
            <Link href="/provider/requests">
              <span>3</span> Review buyer requests <ArrowRight size={14} />
            </Link>
          </li>
        </ol>
        <Link className="provider-setup-ai" href="/provider/inference">
          Sell AI capacity <ArrowRight size={14} />
        </Link>
      </nav>
      {provider.cloudProvider && (
        <div className="info-note">
          <Server size={18} />
          <p>
            Underlying Wick route: <strong>{cloudRouteName(provider.cloudProvider)}</strong>. This
            account can offer only that provider’s approved configurations.
          </p>
        </div>
      )}
      <div className="stats-grid">
        <StatCard
          label="Total capacity"
          value={capacity.total}
          note="Configured VM slots"
          icon={<Server size={18} />}
        />
        <StatCard
          label="Runtime slots held"
          value={capacity.held}
          note="Bids and environments awaiting cleanup"
          icon={<Layers3 size={18} />}
        />
        <StatCard
          label="Runtime headroom"
          value={capacity.available}
          note={`${data.policy.reserveSlots ?? 0} spare slots protected by policy`}
          icon={<CheckCircle2 size={18} />}
        />
      </div>
      <ErrorBox error={error || actionError} retry={error ? reload : undefined} />
      <FormLayout
        aside={
          <FormSummary
            title="Current allocation"
            description={`${capacity.total} configured slots`}
          >
            <div
              className="capacity-meter"
              role="img"
              aria-label={`${capacity.held} held, ${protectedSpare} protected spare and ${capacity.available} available of ${capacity.total} configured slots`}
            >
              <span className="held" style={{ width: share(capacity.held) }} />
              <span className="spare" style={{ width: share(protectedSpare) }} />
              <span className="available" style={{ width: share(capacity.available) }} />
            </div>
            <dl className="capacity-breakdown">
              <div>
                <dt>
                  <i className="dot held" /> Runtime slots held
                </dt>
                <dd>{capacity.held}</dd>
                <p>Bids and environments, including allocations awaiting cleanup.</p>
              </div>
              <div>
                <dt>
                  <i className="dot spare" /> Protected spare
                </dt>
                <dd>{protectedSpare}</dd>
                <p>Headroom retained by your current capacity policy.</p>
              </div>
              <div>
                <dt>
                  <i className="dot available" /> Available for new bids
                </dt>
                <dd>{capacity.available}</dd>
                <p>Configured allocation; upstream capacity and Wick admission still apply.</p>
              </div>
            </dl>
          </FormSummary>
        }
      >
        <FormPanel>
          <FormSection title="Allocation settings">
            <p className="muted-text">
              Set the total slots this account makes available. Existing reservations and historical
              capacity commitments remain protected.
            </p>
            <p>
              <Link className="text-link" href="/provider/policy">
                Review a selling strategy with Muse <ArrowRight size={14} />
              </Link>
            </p>
            <form onSubmit={save}>
              <label className="field" htmlFor="total-capacity">
                <span>Total VM slots</span>
                <input
                  id="total-capacity"
                  type="number"
                  min={0}
                  max={100}
                  step={1}
                  value={total ?? capacity.total}
                  onChange={(e) => {
                    if (capacityRevision === null) setCapacityRevision(data.policyRevision);
                    setTotal(Number(e.target.value));
                    setSaved(false);
                  }}
                  required
                />
                <span className="field-hint">
                  You currently have {capacity.held} reserved{' '}
                  {capacity.held === 1 ? 'slot' : 'slots'}. Existing reservations are preserved.
                </span>
              </label>
              <button className="button primary" disabled={busy}>
                {busy ? (
                  <Spinner label="Saving" />
                ) : (
                  <>
                    <Save size={16} />
                    Save capacity
                  </>
                )}
              </button>
              {saved && <SuccessBox>Capacity updated.</SuccessBox>}
            </form>
            <div className="capacity-calendar-link">
              <span>85% provider share · 15% Broker fee</span>
              <Link href="/provider/earnings">
                View earnings <ArrowRight size={14} />
              </Link>
            </div>
          </FormSection>
        </FormPanel>
      </FormLayout>
      <FormPanel className="recent-activity">
        <FormSection>
          <div className="section-heading">
            <h2>Recent activity</h2>
            <Link className="text-link" href="/provider/activity">
              View all
              <ArrowRight size={14} />
            </Link>
          </div>
          <ActivityList items={data.activity.slice(0, 5)} />
        </FormSection>
      </FormPanel>
    </div>
  );
}

export function ProviderPolicy() {
  const { data, error, loading, reload } = useResource<Dashboard>('/api/provider/dashboard', 5000),
    { catalog, modes, computePromotion } = useSession();
  const [policy, setPolicy] = useState<SupplierPolicy | null>(null),
    [baseRevision, setBaseRevision] = useState<number | null>(null),
    [applyAttempt, setApplyAttempt] = useState<
      (SupplierPolicy & { expectedRevision: number; operationKey: string }) | null
    >(null),
    [dirty, setDirty] = useState(false),
    [strategy, setStrategy] = useState(''),
    [proposal, setProposal] = useState<PolicyProposal | null>(null),
    [busy, setBusy] = useState<'save' | 'propose' | ''>(''),
    [actionError, setActionError] = useState(''),
    [saved, setSaved] = useState(false);
  useEffect(() => {
    if (
      data &&
      !dirty &&
      !proposal &&
      !applyAttempt &&
      (baseRevision === null || data.policyRevision >= baseRevision)
    ) {
      setPolicy({ ...data.policy, reserveSlots: data.policy.reserveSlots ?? 0 });
      setBaseRevision(data.policyRevision);
    }
  }, [data, dirty, proposal, baseRevision, applyAttempt]);
  function update(change: Partial<SupplierPolicy>) {
    setPolicy((old) => (old ? { ...old, ...change } : old));
    setDirty(true);
    setSaved(false);
    setApplyAttempt(null);
  }
  function discardDraft() {
    if (!data) return;
    setPolicy({ ...data.policy, reserveSlots: data.policy.reserveSlots ?? 0 });
    setBaseRevision(data.policyRevision);
    setDirty(false);
    setProposal(null);
    setActionError('');
    setSaved(false);
    setApplyAttempt(null);
  }
  async function propose(event: FormEvent) {
    event.preventDefault();
    setBusy('propose');
    setActionError('');
    setSaved(false);
    try {
      const result = await post<PolicyProposal>('/api/provider/policy/propose', { strategy });
      const current = await api<Dashboard>('/api/provider/dashboard');
      if (current.policyRevision !== result.baseRevision)
        throw new Error(
          'Your saved limits changed while Muse prepared this proposal. Reload saved limits and try again.',
        );
      setPolicy({ ...result.policy, reserveSlots: result.policy.reserveSlots ?? 0 });
      setBaseRevision(result.baseRevision);
      setProposal(result);
      setApplyAttempt(null);
      setDirty(true);
      reload();
    } catch (err) {
      setActionError(
        err instanceof Error
          ? err.message
          : 'Muse could not propose limits. Your saved policy is unchanged.',
      );
    } finally {
      setBusy('');
    }
  }
  async function save(event: FormEvent) {
    event.preventDefault();
    if (!policy || baseRevision === null) return;
    setBusy('save');
    setActionError('');
    const attempt = applyAttempt ?? {
      ...policy,
      expectedRevision: baseRevision,
      operationKey: crypto.randomUUID(),
    };
    setApplyAttempt(attempt);
    try {
      const result = await put<{ policy: SupplierPolicy; policyRevision: number }>(
        '/api/provider/policy',
        attempt,
      );
      setPolicy({ ...result.policy, reserveSlots: result.policy.reserveSlots ?? 0 });
      setBaseRevision(result.policyRevision);
      setProposal(null);
      setApplyAttempt(null);
      setDirty(false);
      setSaved(true);
      reload();
    } catch (err) {
      if (err instanceof ApiError && [400, 401, 403, 404, 409, 422, 429].includes(err.status))
        setApplyAttempt(null);
      setActionError(err instanceof Error ? err.message : 'Policy could not be saved.');
      reload();
    } finally {
      setBusy('');
    }
  }
  if (loading || !policy)
    return (
      <ProviderPageState title="Pricing & policy" eyebrow="PROVIDER SETTINGS">
        {loading || !error ? (
          <Spinner label="Loading policy" />
        ) : (
          <ErrorBox error={error || 'Policy unavailable.'} retry={reload} />
        )}
      </ProviderPageState>
    );
  const promotedProvider =
    !!computePromotion &&
    modes.wick === 'real' &&
    data?.provider.cloudProvider === 'modal' &&
    data.provider.simulated === false;
  const ownCatalog = catalog.filter(
    (c) =>
      c.approved && (!data?.provider.cloudProvider || c.provider === data.provider.cloudProvider),
  );
  const allowed = policy.allowedCatalogIds ?? ownCatalog.map((c) => c.id);
  const stale = baseRevision !== null && !!data && data.policyRevision > baseRevision;
  const spare = policy.reserveSlots ?? 0;
  const proposedAvailable = Math.max(
    0,
    (data?.capacity.total ?? 0) - (data?.capacity.held ?? 0) - spare,
  );
  return (
    <div className="form-page provider-page">
      <PageHeader
        eyebrow="PROVIDER SETTINGS"
        title="Pricing & policy"
        description="Set your selling strategy and keep 85% of rental revenue. Review your limits before applying them."
      >
        <span className="quiet-badge">
          {modes.muse === 'fixture' ? 'Fixture Muse · no model calls' : museLabel}
        </span>
        <Link className="button secondary" href="/provider/sales">
          <Sparkles size={15} /> Improve my sales
        </Link>
      </PageHeader>
      <ComputePromotionNotice available={promotedProvider} audience="provider" />
      <FormPanel>
        <FormSection
          title="Your selling strategy"
          description="Muse uses only your own saved policy, current capacity, and approved configurations. A proposal holds no slots and changes no active limits."
        >
          <form onSubmit={propose}>
            <label className="field" htmlFor="selling-strategy">
              <span>Natural-language selling strategy</span>
              <textarea
                id="selling-strategy"
                value={strategy}
                onChange={(event) => setStrategy(event.target.value)}
                rows={3}
                maxLength={1000}
                minLength={3}
                required
                disabled={!!busy || !!applyAttempt}
                placeholder="Fill idle machines, keep two slots spare, never quote below $0.05."
              />
            </label>
            <div className="form-actions">
              <button className="button muse-button" disabled={!!busy || stale || !!applyAttempt}>
                {busy === 'propose' ? (
                  <Spinner label="Preparing limits" />
                ) : (
                  <>
                    <Sparkles size={16} />
                    Propose editable limits
                  </>
                )}
              </button>
              <span className="field-hint">
                Replaces the draft below for your review. Apply is a separate action.
              </span>
            </div>
          </form>
        </FormSection>
      </FormPanel>
      {data && (
        <FormPanel className="policy-notes">
          <FormSection>
            <div className="section-heading">
              <h2>Current capacity and active policy</h2>
              <span>Revision {data.policyRevision}</span>
            </div>
            <DetailRow label="Configured VM slots">{data.capacity.total}</DetailRow>
            <DetailRow label="Existing holds">{data.capacity.held}</DetailRow>
            <DetailRow label="Kept spare by active policy">
              {data.policy.reserveSlots ?? 0}
            </DetailRow>
            <DetailRow label="Available for new holds">{data.capacity.available}</DetailRow>
            <DetailRow label="Active minimum total">
              {money(data.policy.minimumPriceCents)}
            </DetailRow>
            <DetailRow label="Automatic bids and counteroffers">
              {data.policy.autoBid
                ? 'Enabled within your approved limits'
                : 'Paused; manual bids remain available'}
            </DetailRow>
          </FormSection>
        </FormPanel>
      )}
      {stale && !applyAttempt && (
        <div className="error-box" role="alert">
          <div>
            Your saved policy or capacity changed. This draft is based on revision {baseRevision};
            reload current limits before applying.
          </div>
          <button type="button" className="text-button" onClick={discardDraft} disabled={!!busy}>
            Reload saved limits
          </button>
        </div>
      )}
      {proposal && (
        <FormPanel>
          <FormSection
            title="Proposed limits · not active"
            description="Review and edit every limit below. The decision receipt describes the original proposal; your edits are applied only when you choose Apply reviewed limits."
          >
            <ReceiptCard
              receipt={proposal.receipt}
              mode={proposal.mode}
              modelCalled={proposal.modelCalled}
            />
          </FormSection>
        </FormPanel>
      )}
      <ErrorBox error={error || actionError} retry={error ? reload : undefined} />
      {applyAttempt && !busy && (
        <div className="info-note" role="status">
          <ShieldCheck size={17} />
          <p>
            Apply may have succeeded. Retry the same reviewed limits to recover its result before
            editing. The retry uses the original operation key and cannot apply twice.
          </p>
        </div>
      )}
      <form onSubmit={save}>
        <fieldset disabled={!!busy} style={{ border: 0, padding: 0, margin: 0 }}>
          <FormLayout
            aside={
              <>
                <FormSummary title="A proposal with boundaries">
                  <p className="muted-text">
                    With at least two free slots and half of unreserved capacity available, Muse may
                    offer up to 10% off without crossing your floor. Declining the discount keeps
                    the eligible base. Capacity, budget, pricing limits, and the auction deadline
                    still apply.
                  </p>
                  <span className="tiny-label">
                    {modes.muse === 'fixture' ? 'Fixture proposals · no model calls' : museLabel}
                  </span>
                </FormSummary>
                <FormSummary title="What your policy changes" className="policy-notes">
                  <DetailRow label="Broker commission">15% of your gross rental revenue</DetailRow>
                  <DetailRow label="Added buyer fee">$0.00</DetailRow>
                  <DetailRow label="Future bids">Use your saved policy</DetailRow>
                  <DetailRow label="Existing reservations">Remain in place</DetailRow>
                  <DetailRow label="Awarded quotes">Stay fixed</DetailRow>
                  <DetailRow label="Manual bids">
                    Same floor, spare slots, and capacity checks
                  </DetailRow>
                  <DetailRow label="Buyer-approved alternatives">
                    Require active automation and saved limits, rechecked on acceptance
                  </DetailRow>
                  <p className="small-muted">
                    Your private policy is isolated from other suppliers. Credentials and customer
                    terminal contents never go to Muse.
                  </p>
                </FormSummary>
              </>
            }
          >
            <FormPanel>
              <FormSection>
                <div className="section-heading">
                  <h2>{proposal ? 'Review proposed limits' : 'Bidding policy'}</h2>
                  <span>Based on revision {baseRevision}</span>
                </div>
                <label className="field" htmlFor="reserve-slots">
                  <span>Slots to keep spare</span>
                  <input
                    id="reserve-slots"
                    type="number"
                    min={0}
                    max={100}
                    step={1}
                    required
                    disabled={!!applyAttempt}
                    value={spare}
                    onChange={(event) => update({ reserveSlots: Number(event.target.value) })}
                  />
                  <span className="field-hint">
                    With current holds, these limits allow {proposedAvailable} new slots. Spare
                    slots apply to manual bids, automatic bids, and accepted alternatives. Existing
                    holds remain intact.
                  </span>
                </label>
                <label className="toggle-row" htmlFor="auto-bid">
                  <div>
                    <strong>Automatic bids and counteroffers</strong>
                    <p>
                      Broker submits eligible base-price bids. Muse may choose an optional discount;
                      declining it keeps the base when it fits the buyer’s budget. Buyer acceptance
                      can bind a counteroffer and start provisioning. Pausing stops new automatic
                      bids and counteroffer fills; manual bids remain available.
                    </p>
                  </div>
                  <input
                    id="auto-bid"
                    type="checkbox"
                    className="toggle-input"
                    checked={policy.autoBid}
                    disabled={!!applyAttempt}
                    onChange={(e) => update({ autoBid: e.target.checked })}
                  />
                  <span className="toggle-track" aria-hidden="true" />
                </label>
                <div className="field-grid">
                  <MoneyInput
                    id="minimum-price"
                    label="Minimum total price (USD)"
                    value={policy.minimumPriceCents}
                    disabled={!!applyAttempt}
                    onChange={(minimumPriceCents) => update({ minimumPriceCents })}
                  />
                  <MoneyInput
                    id="base-price"
                    label="Base total price (USD)"
                    value={policy.basePriceCents}
                    disabled={!!applyAttempt}
                    onChange={(basePriceCents) => update({ basePriceCents })}
                  />
                </div>
                <MoneyInput
                  id="policy-max-price"
                  label="Maximum total price (USD)"
                  value={policy.maxPriceCents ?? policy.basePriceCents}
                  disabled={!!applyAttempt}
                  onChange={(maxPriceCents) => update({ maxPriceCents })}
                />
                <p className="field-hint">
                  These limits are the gross total the buyer pays, before Broker’s 15% commission.
                  You keep 85% before compute costs. The buyer’s budget also applies.{' '}
                  {promotedProvider
                    ? 'Eligible sponsored Modal bids cost the buyer $0.01 when your saved limits allow it; the operator’s Wick account covers compute beyond your share. Other bids use your base or the ordinary compute cost floor, whichever is higher.'
                    : 'Real Wick bids must leave enough after commission to cover the estimated compute cost. Automatic bids use your base or that cost floor, whichever is higher. The last free slot stays at base.'}
                </p>
                <ProviderRevenueSplit grossCents={policy.basePriceCents} />
                <div className="form-divider" />
                <h3>Eligible configurations</h3>
                <p className="muted-text">
                  Only administrator-approved existing Wick configurations can be offered.
                </p>
                <div className="catalog-checks">
                  {ownCatalog.map((item) => (
                    <label key={item.id}>
                      <input
                        type="checkbox"
                        checked={allowed.includes(item.id)}
                        disabled={!!applyAttempt}
                        onChange={(e) =>
                          update({
                            allowedCatalogIds: e.target.checked
                              ? [...allowed, item.id]
                              : allowed.filter((id) => id !== item.id),
                          })
                        }
                      />
                      <div>
                        <strong>{item.name}</strong>
                        <span>
                          {item.cpu} vCPU · {item.memoryGb} GiB · {item.region}
                        </span>
                      </div>
                    </label>
                  ))}
                </div>
                <div className="form-actions">
                  <button
                    className="button primary"
                    disabled={!!busy || (stale && !applyAttempt) || baseRevision === null}
                  >
                    {busy === 'save' ? (
                      <Spinner label="Saving policy" />
                    ) : (
                      <>
                        <Save size={16} />
                        {applyAttempt
                          ? 'Retry same apply'
                          : proposal
                            ? 'Apply reviewed limits'
                            : 'Save policy'}
                      </>
                    )}
                  </button>
                  {(dirty || proposal) && (
                    <button
                      type="button"
                      className="button secondary"
                      onClick={discardDraft}
                      disabled={!!applyAttempt}
                    >
                      Discard draft
                    </button>
                  )}
                  {saved && (
                    <span className="saved-label">
                      <Check size={15} />
                      Policy saved
                    </span>
                  )}
                </div>
              </FormSection>
            </FormPanel>
          </FormLayout>
        </fieldset>
      </form>
      <FormPanel className="recent-activity">
        <FormSection>
          <div className="section-heading">
            <h2>Counteroffer decisions</h2>
            <Link className="text-link" href="/provider/activity">
              View all activity <ArrowRight size={14} />
            </Link>
          </div>
          <p className="muted-text">
            Your private decision receipts. Proposed alternatives hold no slots until the buyer
            explicitly accepts.
          </p>
          <ActivityList
            items={(data?.activity ?? [])
              .filter((item) => item.kind.startsWith('counteroffer_'))
              .slice(0, 5)}
          />
        </FormSection>
      </FormPanel>
    </div>
  );
}

function ProviderRequestCard({
  request,
  basePriceCents,
  onBid,
}: {
  request: EnvironmentRequest;
  basePriceCents: number;
  onBid: () => void;
}) {
  const { modes } = useSession(),
    now = useNow();
  const [price, setPrice] = useState(
      request.pricing?.totalPriceCents ?? Math.min(basePriceCents, request.maxPriceCents),
    ),
    [proposal, setProposal] = useState<
      (BidProposal & { mode: Mode; modelCalled?: boolean; submittedBid?: unknown }) | null
    >(null),
    [busy, setBusy] = useState(''),
    [error, setError] = useState(''),
    [success, setSuccess] = useState(false),
    [expanded, setExpanded] = useState(false);
  const ended = new Date(request.closesAt).getTime() <= now || request.status !== 'open';
  async function propose() {
    setBusy('muse');
    setError('');
    try {
      const result = await post<
        BidProposal & { mode: Mode; modelCalled?: boolean; submittedBid?: unknown }
      >(`/api/provider/requests/${request.id}/propose`);
      setProposal(result);
      if (result.decision === 'bid' && result.totalPriceCents !== undefined)
        setPrice(result.totalPriceCents);
      if (result.submittedBid) {
        setSuccess(true);
        onBid();
      }
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : 'Muse could not produce a proposal. You can still bid manually.',
      );
    } finally {
      setBusy('');
    }
  }
  async function bid(event: FormEvent) {
    event.preventDefault();
    setBusy('bid');
    setError('');
    try {
      await post(`/api/provider/requests/${request.id}/bids`, {
        totalPriceCents: price,
        offeringId: proposal?.offeringId,
      });
      setSuccess(true);
      onBid();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Bid could not be accepted.');
    } finally {
      setBusy('');
    }
  }
  return (
    <Fragment>
      <tr>
        <td>
          <TableIdentity
            icon={<Server size={17} />}
            title={request.description || 'Environment request'}
            subtitle={<code>{request.id.slice(0, 8)}</code>}
          />
        </td>
        <td>
          <TableStatus tone={ended ? 'neutral' : 'warning'}>
            {ended ? 'Auction closed' : `${remaining(request.closesAt, now)} remaining`}
          </TableStatus>
        </td>
        <td className="provider-resource-cell">
          {request.requirements.cpu} vCPU · {request.requirements.memoryGb} GiB
          <small>{regionName(request.region)}</small>
        </td>
        <td className="numeric-cell">{request.durationMinutes} min</td>
        <td className="numeric-cell">{money(request.maxPriceCents)}</td>
        <td className="actions-cell">
          <TableActions>
            <button
              type="button"
              className="button secondary small"
              aria-expanded={expanded}
              aria-controls={`bid-details-${request.id}`}
              onClick={() => setExpanded(!expanded)}
            >
              {expanded ? 'Hide bid' : 'Review bid'}
              <ChevronDown size={14} className={expanded ? 'provider-chevron-open' : ''} />
            </button>
          </TableActions>
        </td>
      </tr>
      <tr className="provider-expansion-row" hidden={!expanded}>
        <td colSpan={6}>
          <article
            id={`bid-details-${request.id}`}
            className="provider-request provider-expanded-content"
            aria-label={`Bid for ${request.description || request.id.slice(0, 8)}`}
          >
            <div className="provider-request-top">
              <span className="quiet-badge">
                <Radio size={13} />
                {ended ? 'Auction closed' : `${remaining(request.closesAt, now)} remaining`}
              </span>
              <span className="small-muted">{request.id.slice(0, 8)}</span>
            </div>
            <h3>{request.description || 'Environment request'}</h3>
            <div className="request-spec-tags">
              <span>
                <Cpu size={13} />
                {request.requirements.cpu} vCPU
              </span>
              <span>
                <Layers3 size={13} />
                {request.requirements.memoryGb} GiB RAM
              </span>
              <span>
                <Globe2 size={13} />
                {regionName(request.region)}
              </span>
              <span>
                <Clock3 size={13} />
                {request.durationMinutes} min
              </span>
            </div>
            <div className="request-budget">
              <span>Customer’s maximum total</span>
              <strong>{money(request.maxPriceCents)}</strong>
            </div>
            {success ? (
              <SuccessBox>Your bid is accepted and capacity is reserved.</SuccessBox>
            ) : (
              <form onSubmit={bid}>
                <MoneyInput
                  id={`bid-${request.id}`}
                  label="Your total bid (USD)"
                  value={price}
                  onChange={setPrice}
                  min={1}
                  disabled={ended}
                />
                <ProviderRevenueSplit grossCents={price} />
                <div className="provider-request-actions">
                  <button
                    type="button"
                    className="button muse-button"
                    onClick={() => void propose()}
                    disabled={!!busy || ended}
                  >
                    {busy === 'muse' ? (
                      <Spinner label="Considering" />
                    ) : (
                      <>
                        <Sparkles size={15} />
                        Ask Muse
                      </>
                    )}
                  </button>
                  <button className="button primary" disabled={!!busy || ended}>
                    {busy === 'bid' ? (
                      <Spinner label="Submitting" />
                    ) : (
                      <>
                        Submit bid
                        <ArrowRight size={15} />
                      </>
                    )}
                  </button>
                </div>
              </form>
            )}
            <ErrorBox error={error} />
            {proposal && (
              <>
                <div className="proposal-decision">
                  {proposal.decision === 'decline' ? (
                    <>
                      <X size={15} />
                      No eligible bid
                    </>
                  ) : (
                    <>
                      <Check size={15} />
                      Suggested total: {money(proposal.totalPriceCents)}
                    </>
                  )}
                </div>
                <ReceiptCard
                  receipt={proposal.receipt}
                  mode={proposal.mode || modes.muse}
                  modelCalled={proposal.modelCalled}
                />
              </>
            )}
          </article>
        </td>
      </tr>
    </Fragment>
  );
}
export function ProviderRequests() {
  const { data, error, loading, reload, nextCursor, loadingMore, loadMore, moreError } =
      usePagedResource<EnvironmentRequest>('/api/provider/requests', 3000),
    dashboard = useResource<Dashboard>('/api/provider/dashboard', 5000);
  const items = data?.items || [];
  return (
    <div className="form-page provider-page">
      <PageHeader
        eyebrow="THE MARKETPLACE"
        title="Buyer requests"
        description="Offer a fixed total price for requests that fit your available capacity."
      >
        <button className="button secondary" onClick={reload}>
          <RefreshCw size={15} />
          Refresh requests
        </button>
      </PageHeader>
      <div className="provider-request-banner">
        <span className="icon-tile emerald">
          <Radio size={21} />
        </span>
        <div>
          <h3>
            {dashboard.data?.capacity.available ?? '—'} available slots ·{' '}
            {data ? items.length : '—'} loaded requests
          </h3>
          <p>
            Manual and automatic bids honor your saved price floor and spare slots. Late offers are
            rejected.
          </p>
        </div>
        <span className="quiet-badge">
          Automatic bids and counteroffers{' '}
          {dashboard.data ? (dashboard.data.policy.autoBid ? 'on' : 'paused') : 'unavailable'}
        </span>
      </div>
      <ErrorBox
        error={(data ? error : '') || dashboard.error}
        retry={() => {
          reload();
          dashboard.reload();
        }}
      />
      <TablePanel label="Buyer requests">
        <TableToolbar>
          <div>
            <h2>Open requests</h2>
            <p className="field-hint">30-second auctions · lowest eligible total wins</p>
          </div>
          <span className="small-muted">{data ? items.length : '—'} loaded</span>
        </TableToolbar>
        {loading ? (
          <TableState loading title="Loading marketplace requests" />
        ) : error && !data ? (
          <TableState error={error} onRetry={reload} />
        ) : items.length ? (
          <TableViewport embedded label="Buyer requests" minWidth={1020}>
            <table className="provider-requests-table">
              <caption className="sr-only">Buyer requests</caption>
              <thead>
                <tr>
                  <th scope="col">Request</th>
                  <th scope="col">Auction</th>
                  <th scope="col">Resources / region</th>
                  <th scope="col" className="numeric-cell">
                    Duration
                  </th>
                  <th scope="col" className="numeric-cell">
                    Buyer maximum
                  </th>
                  <th scope="col" className="actions-cell">
                    Action
                  </th>
                </tr>
              </thead>
              <tbody>
                {items.map((request) => (
                  <ProviderRequestCard
                    key={request.id}
                    request={request}
                    basePriceCents={dashboard.data?.policy.basePriceCents ?? DEFAULT_PRICE_CENTS}
                    onBid={() => {
                      reload();
                      dashboard.reload();
                    }}
                  />
                ))}
              </tbody>
            </table>
          </TableViewport>
        ) : (
          <TableState
            title="No open buyer requests"
            description="New customer requests appear during their 30-second auctions. This view refreshes automatically."
          />
        )}
        <TableFooter count={data?.items.length} noun="requests">
          <LoadMore
            available={!!nextCursor}
            loading={loadingMore}
            onLoad={() => void loadMore()}
            error={moreError}
          />
        </TableFooter>
      </TablePanel>
    </div>
  );
}

export function ProviderOfferings() {
  const { data, error, loading, reload, nextCursor, loadingMore, loadMore, moreError } =
      usePagedResource<Offering>('/api/provider/offerings'),
    { catalog, modes, computePromotion } = useSession(),
    dashboard = useResource<Dashboard>('/api/provider/dashboard'),
    approved = catalog.filter(
      (item) =>
        !!dashboard.data &&
        item.approved &&
        (!dashboard.data?.provider.cloudProvider ||
          item.provider === dashboard.data.provider.cloudProvider) &&
        (!dashboard.data?.policy.allowedCatalogIds ||
          dashboard.data.policy.allowedCatalogIds.includes(item.id)),
    );
  const [draft, setDraft] = useState<OfferingProposal>({
      catalogId: approved[0]?.id || '',
      name: '',
      description: '',
      priceCents: DEFAULT_PRICE_CENTS,
    }),
    [showForm, setShowForm] = useState(false),
    [expandedOffering, setExpandedOffering] = useState<string | null>(null),
    [busy, setBusy] = useState(''),
    [actionError, setActionError] = useState(''),
    [success, setSuccess] = useState(''),
    [suggestions, setSuggestions] = useState<{
      proposals: OfferingProposal[];
      receipt: Receipt;
      mode: Mode;
      modelCalled?: boolean;
    } | null>(null);
  const promotedProvider =
    !!computePromotion &&
    modes.wick === 'real' &&
    dashboard.data?.provider.cloudProvider === 'modal' &&
    dashboard.data.provider.simulated === false;
  const selected = approved.find((item) => item.id === draft.catalogId);
  const firstApprovedId = approved[0]?.id ?? '';
  useEffect(() => {
    if (!dashboard.data || selected) return;
    setDraft((old) => ({
      ...old,
      catalogId: firstApprovedId,
      durationMinutes: undefined,
      priceBasis: undefined,
    }));
  }, [dashboard.data, selected?.id, firstApprovedId]);
  let publishPrice: number | undefined = selected ? draft.priceCents : undefined;
  let quoteError = !dashboard.data
    ? 'Loading your approved configurations and current pricing policy.'
    : !selected
      ? 'No configurations are available under your current provider policy.'
      : '';
  if (modes.wick === 'real' && draft.priceBasis !== 'server-priced-candidate') {
    try {
      if (!selected || !dashboard.data) throw new Error(quoteError);
      const promotion = promotedProvider && modalPromotionPreview(selected, 30);
      const policyAllowsPromotion =
        dashboard.data.policy.minimumPriceCents <= 1 &&
        (dashboard.data.policy.maxPriceCents === undefined ||
          dashboard.data.policy.maxPriceCents >= 1);
      publishPrice =
        promotion && policyAllowsPromotion
          ? promotion.totalPriceCents
          : Math.max(
              fixedQuote(managedPricing(selected), 30).totalPriceCents,
              dashboard.data.policy.minimumPriceCents,
            );
    } catch (error) {
      publishPrice = undefined;
      quoteError =
        error instanceof Error ? error.message : 'A current rate is required to review this price.';
    }
  }
  async function create(event: FormEvent) {
    event.preventDefault();
    if (!selected || !dashboard.data || publishPrice === undefined) return;
    setBusy('create');
    setActionError('');
    setSuccess('');
    try {
      await post('/api/provider/offerings', { ...draft, priceCents: publishPrice });
      setShowForm(false);
      setSuccess('Offering published. New bids can use this revision.');
      setDraft({
        catalogId: approved[0]?.id || '',
        name: '',
        description: '',
        priceCents: DEFAULT_PRICE_CENTS,
      });
      reload();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Offering could not be published.');
    } finally {
      setBusy('');
    }
  }
  async function toggle(item: Offering) {
    setBusy(item.id);
    setActionError('');
    try {
      await api(`/api/provider/offerings/${item.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ active: !item.active }),
      });
      reload();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Offering could not be updated.');
    } finally {
      setBusy('');
    }
  }
  async function propose() {
    setBusy('muse');
    setActionError('');
    try {
      setSuggestions(await post('/api/provider/offerings/propose'));
    } catch (err) {
      setActionError(
        err instanceof Error
          ? err.message
          : 'Muse could not suggest offerings. You can create one manually.',
      );
    } finally {
      setBusy('');
    }
  }
  return (
    <div className="form-page provider-page">
      <PageHeader
        eyebrow="PROVIDER SUPPLY"
        title="Instant offerings"
        description="Publish clear, fixed-price offerings from approved Wick configurations."
      >
        <button
          className="button primary"
          onClick={() => {
            setShowForm(!showForm);
            setSuccess('');
          }}
        >
          {showForm ? <X size={16} /> : <Plus size={16} />}{' '}
          {showForm ? 'Close form' : 'New offering'}
        </button>
      </PageHeader>
      <ComputePromotionNotice available={promotedProvider} audience="provider" />
      <div className="provider-assist-bar">
        <span className="icon-tile violet">
          <Sparkles size={22} />
        </span>
        <div>
          <h3>Supply recommendations</h3>
          <p>
            Suggest approved configurations from recent buyer demand. Review configurations and
            policy-checked totals before publishing.
          </p>
          <span>
            {modes.muse === 'fixture'
              ? 'Fixture suggestions · no model calls'
              : `${museLabel} · approved configurations`}
          </span>
        </div>
        <button className="button muse-button" onClick={() => void propose()} disabled={!!busy}>
          {busy === 'muse' ? (
            <Spinner label="Reviewing demand" />
          ) : (
            <>
              <Sparkles size={15} />
              Suggest offerings
            </>
          )}
        </button>
      </div>
      <ErrorBox
        error={(data ? error : '') || actionError || dashboard.error}
        retry={data && error ? reload : dashboard.error ? dashboard.reload : undefined}
      />
      {success && <SuccessBox>{success}</SuccessBox>}
      {suggestions && (
        <FormPanel className="offering-suggestions">
          <FormSection>
            <div className="section-heading">
              <h2>Suggested for your review</h2>
              <button
                className="icon-button"
                onClick={() => setSuggestions(null)}
                aria-label="Close offering suggestions"
              >
                <X size={17} />
              </button>
            </div>
            {suggestions.proposals.length ? (
              <div className="suggestion-list">
                {suggestions.proposals.map((proposal, i) => (
                  <div key={i}>
                    <div>
                      <strong>{proposal.name}</strong>
                      <p>{proposal.description}</p>
                      <span>
                        {money(proposal.priceCents)}{' '}
                        {proposal.durationMinutes
                          ? `· ${proposal.durationMinutes} minute example`
                          : modes.wick === 'real'
                            ? '· 30 minute example'
                            : 'fixed fixture rental total'}
                      </span>
                    </div>
                    <button
                      className="button secondary small"
                      onClick={() => {
                        setDraft(proposal);
                        setShowForm(true);
                      }}
                    >
                      Review suggestion
                      <ArrowRight size={14} />
                    </button>
                  </div>
                ))}
              </div>
            ) : (
              <p className="muted-text">
                No offering suggestions right now. Record unmatched demand or create an offering
                manually.
              </p>
            )}
            <ReceiptCard
              receipt={suggestions.receipt}
              mode={suggestions.mode}
              modelCalled={suggestions.modelCalled}
            />
          </FormSection>
        </FormPanel>
      )}
      {showForm && (
        <FormPanel className="offering-form">
          <FormSection>
            <div className="section-heading">
              <h2>Review & publish an offering</h2>
              <span className="quiet-badge">
                {dashboard.data?.provider.simulated === false
                  ? 'Wick-managed allocation'
                  : 'Simulated demo supply'}
              </span>
            </div>
            <form onSubmit={create}>
              <div className="field-grid">
                <label className="field" htmlFor="offering-name">
                  <span>Offering name</span>
                  <input
                    id="offering-name"
                    maxLength={100}
                    value={draft.name}
                    onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                    placeholder="A little room to explore"
                    required
                  />
                </label>
                <label className="field" htmlFor="offering-config">
                  <span>Approved configuration</span>
                  <select
                    id="offering-config"
                    value={draft.catalogId}
                    disabled={!dashboard.data || !approved.length}
                    onChange={(e) =>
                      setDraft({
                        ...draft,
                        catalogId: e.target.value,
                        durationMinutes: undefined,
                        priceBasis: undefined,
                      })
                    }
                    required
                  >
                    {!selected && (
                      <option value={draft.catalogId} disabled>
                        {dashboard.data ? 'No approved configurations' : 'Loading configurations…'}
                      </option>
                    )}
                    {approved.map((item) => (
                      <option key={item.id} value={item.id}>
                        {item.name}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              <label className="field" htmlFor="offering-description">
                <span>Description</span>
                <textarea
                  id="offering-description"
                  rows={2}
                  maxLength={1000}
                  value={draft.description}
                  onChange={(e) => setDraft({ ...draft, description: e.target.value })}
                  placeholder="What this environment offers"
                  required
                />
              </label>
              <div className="field-grid">
                {modes.wick === 'fixture' ? (
                  <MoneyInput
                    id="offering-price"
                    label="Fixed rental price (USD)"
                    value={draft.priceCents}
                    onChange={(priceCents) => setDraft({ ...draft, priceCents })}
                    min={1}
                  />
                ) : (
                  <div className="field">
                    <span>Reviewed 30 minute example</span>
                    <strong>
                      {publishPrice === undefined ? 'Quote unavailable' : money(publishPrice)}
                    </strong>
                    <p className="field-hint">
                      Publishing stores this example total. A changed rate or policy is rejected for
                      a fresh review. Each rental gets a duration-specific fixed quote. Binding bids
                      may differ within your policy and the buyer’s budget.{' '}
                      {promotedProvider
                        ? 'Eligible sponsored Modal offers charge buyers $0.01; the operator’s Wick account covers compute beyond your 85% share. Other offers must cover the estimated upstream compute cost.'
                        : 'Your 85% share must cover the estimated upstream compute cost.'}
                    </p>
                  </div>
                )}
                <div className="field">
                  <span>Supported durations</span>
                  <div className="supported-duration-tags">
                    {approved
                      .find((c) => c.id === draft.catalogId)
                      ?.durationMinutes.map((n) => (
                        <span key={n} className="quiet-badge">
                          {n} min
                        </span>
                      ))}
                  </div>
                </div>
              </div>
              <ErrorBox error={quoteError} />
              {publishPrice !== undefined && <ProviderRevenueSplit grossCents={publishPrice} />}
              <div className="form-actions">
                <button
                  className="button primary"
                  disabled={!!busy || !selected || !dashboard.data || publishPrice === undefined}
                >
                  {busy === 'create' ? (
                    <Spinner label="Publishing" />
                  ) : (
                    <>
                      <Check size={16} />
                      Publish offering
                    </>
                  )}
                </button>
                <button
                  type="button"
                  className="button secondary"
                  onClick={() => setShowForm(false)}
                >
                  Cancel
                </button>
              </div>
            </form>
          </FormSection>
        </FormPanel>
      )}
      <TablePanel label="Instant offerings">
        <TableToolbar>
          <div>
            <h2>Published supply</h2>
            <p className="field-hint">Approved configurations and fixed rental totals</p>
          </div>
          <button className="button secondary small" onClick={reload}>
            <RefreshCw size={14} />
            Refresh
          </button>
        </TableToolbar>
        {loading ? (
          <TableState loading title="Loading your offerings" />
        ) : error && !data ? (
          <TableState error={error} onRetry={reload} />
        ) : data?.items.length ? (
          <TableViewport embedded label="Instant offerings" minWidth={960}>
            <table className="provider-offerings-table">
              <caption className="sr-only">Instant offerings</caption>
              <thead>
                <tr>
                  <th scope="col">Offering</th>
                  <th scope="col">Status</th>
                  <th scope="col">Resources</th>
                  <th scope="col">Region</th>
                  <th scope="col" className="numeric-cell">
                    Published total
                  </th>
                  <th scope="col" className="actions-cell">
                    Action
                  </th>
                </tr>
              </thead>
              <tbody>
                {data.items.map((item) => {
                  const config = catalog.find((c) => c.id === item.catalogId);
                  const expanded = expandedOffering === item.id;
                  return (
                    <Fragment key={item.id}>
                      <tr>
                        <td>
                          <TableIdentity
                            icon={<Server size={17} />}
                            title={item.name}
                            subtitle={config?.name || 'Approved configuration'}
                          />
                        </td>
                        <td>
                          <TableStatus tone={item.active ? 'success' : 'neutral'}>
                            {item.active ? 'Published' : 'Inactive'}
                          </TableStatus>
                        </td>
                        <td className="provider-resource-cell">
                          {config?.cpu ?? '—'} vCPU · {config?.memoryGb ?? '—'} GiB
                        </td>
                        <td>{config ? regionName(config.region) : '—'}</td>
                        <td className="numeric-cell">
                          {money(item.priceCents)}
                          <small>
                            {item.pricing ? '30 minute baseline' : 'Fixed rental total'}
                          </small>
                        </td>
                        <td className="actions-cell">
                          <TableActions>
                            <button
                              type="button"
                              className="button secondary small"
                              aria-expanded={expanded}
                              aria-controls={`offering-details-${item.id}`}
                              onClick={() => setExpandedOffering(expanded ? null : item.id)}
                            >
                              {expanded ? 'Hide details' : 'Manage offering'}
                              <ChevronDown
                                size={14}
                                className={expanded ? 'provider-chevron-open' : ''}
                              />
                            </button>
                          </TableActions>
                        </td>
                      </tr>
                      <tr className="provider-expansion-row" hidden={!expanded}>
                        <td colSpan={6}>
                          <section
                            id={`offering-details-${item.id}`}
                            className="provider-expanded-content"
                            aria-label={`${item.name} details`}
                          >
                            <div className="section-heading">
                              <div>
                                <h3>{item.name}</h3>
                                <p className="muted-text">{item.description}</p>
                              </div>
                              <span className="small-muted">Revision {item.revision}</span>
                            </div>
                            <DetailRow label="Supported durations">
                              {config?.durationMinutes.map((n) => `${n} min`).join(' · ') ||
                                'Unavailable configuration'}
                            </DetailRow>
                            <DetailRow label="Supply">
                              {dashboard.data?.provider.simulated === false
                                ? 'Wick-managed allocation'
                                : 'Simulated demo supply'}
                            </DetailRow>
                            <p className="field-hint">
                              {item.pricing
                                ? 'Published 30 minute baseline · review the current quote before bidding. '
                                : ''}
                              You keep 85%; Broker receives 15% of the accepted rental total.
                            </p>
                            <div className="form-actions">
                              <button
                                className="button secondary small"
                                onClick={() => void toggle(item)}
                                disabled={!!busy}
                              >
                                {busy === item.id
                                  ? 'Updating…'
                                  : item.active
                                    ? 'Unpublish'
                                    : 'Publish'}
                              </button>
                              <span className="field-hint">
                                Applies to future bids. Awarded rentals retain their frozen quote.
                              </span>
                            </div>
                          </section>
                        </td>
                      </tr>
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </TableViewport>
        ) : (
          <TableState
            title="No offerings published"
            description="Choose an approved configuration and a fixed total price to publish your first offering."
          >
            <button className="button primary" onClick={() => setShowForm(true)}>
              <Plus size={15} />
              New offering
            </button>
          </TableState>
        )}
        <TableFooter count={data?.items.length} noun="offerings">
          <LoadMore
            available={!!nextCursor}
            loading={loadingMore}
            onLoad={() => void loadMore()}
            error={moreError}
          />
        </TableFooter>
      </TablePanel>
      <div className="info-note">
        <ShieldCheck size={17} />
        <p>
          Awarded rentals retain their offering revision and quote. Unpublishing an offering affects
          future bids only.
        </p>
      </div>
    </div>
  );
}

export function ProviderEarnings() {
  const { modes } = useSession();
  const { data, error, loading, reload, nextCursor, loadingMore, loadMore, moreError } =
    usePagedResource<ProviderEarning>('/api/provider/earnings');
  const items = data?.items ?? [];
  const assessed = items.filter((item) => !!item.revenueShare);
  const gross = assessed.reduce(
    (sum, item) => sum + moneyUnits(item.revenueShare!.grossCents) * 100n,
    0n,
  );
  const fee = assessed.reduce((sum, item) => sum + BigInt(item.revenueShare!.brokerFeeMicros), 0n);
  const net = assessed.reduce(
    (sum, item) => sum + BigInt(item.revenueShare!.providerNetMicros),
    0n,
  );
  return (
    <div className="form-page provider-page">
      <PageHeader
        eyebrow="PROVIDER EARNINGS"
        title="Earnings"
        description="You keep 85% of each new rental. Broker receives 15% from your gross revenue, with no added buyer fee."
      >
        <button className="button secondary" onClick={reload}>
          <RefreshCw size={15} />
          Refresh
        </button>
      </PageHeader>
      <div className="invoice-banner">
        <span className="icon-tile emerald">
          <CircleDollarSign size={23} />
        </span>
        <div>
          <h3>
            {modes.wick === 'fixture'
              ? 'Demo earnings · no payouts'
              : 'Recorded earnings · no payouts'}
          </h3>
          <p>
            For instant rentals, each split is fixed with the accepted offer and recorded once the
            VM is ready. Your share is before compute costs, so it is not profit. No payments or
            payouts are collected.
          </p>
        </div>
        <span className="quiet-badge">85% you · 15% Broker</span>
      </div>
      <div className="stats-grid">
        <StatCard
          label="Assessed instant-rental gross"
          value={data ? moneyMicros(gross) : '—'}
          note="Loaded records with a frozen split"
          icon={<CircleDollarSign size={18} />}
        />
        <StatCard
          label="Instant-rental commission"
          value={data ? moneyMicros(fee) : '—'}
          note="15% of the assessed gross"
          icon={<Layers3 size={18} />}
        />
        <StatCard
          label="Instant-rental net revenue"
          value={data ? moneyMicros(net) : '—'}
          note="85%, before your compute costs"
          icon={<CheckCircle2 size={18} />}
        />
      </div>
      <ErrorBox error={data ? error : ''} retry={reload} />
      <TablePanel label="Rental revenue">
        <TableToolbar>
          <h2>Rental revenue</h2>
          <span>
            {data ? items.length : '—'} loaded{nextCursor ? ' · more available' : ''}
          </span>
        </TableToolbar>
        <p className="field-hint provider-panel-note">
          Totals cover only loaded records with an assessed split. Historical rentals without a
          frozen commission are unchanged and excluded. Fractions of a cent are preserved so Broker
          receives exactly 15%.
        </p>
        {loading ? (
          <TableState loading />
        ) : error && !data ? (
          <TableState error={error} onRetry={reload} />
        ) : items.length ? (
          <TableViewport embedded label="Rental revenue" minWidth={1000} className="table-scroll">
            <table>
              <caption className="sr-only">Rental revenue</caption>
              <thead>
                <tr>
                  <th scope="col">Invoice</th>
                  <th scope="col">Environment</th>
                  <th scope="col">Created</th>
                  <th className="numeric-cell" scope="col">
                    Rental gross
                  </th>
                  <th className="numeric-cell" scope="col">
                    Broker fee · 15%
                  </th>
                  <th className="numeric-cell" scope="col">
                    You keep · 85%
                  </th>
                  <th scope="col">Status</th>
                </tr>
              </thead>
              <tbody>
                {items.map((item) => (
                  <tr key={item.id} data-invoice-id={item.id}>
                    <td>
                      <TableIdentity
                        icon={<CircleDollarSign size={16} />}
                        title={<code>{item.id.slice(0, 8)}</code>}
                      />
                    </td>
                    <td>{item.catalogName || item.vmId.slice(0, 8)}</td>
                    <td>{shortDate(item.createdAt)}</td>
                    <td className="money-cell numeric-cell">
                      {money(item.totalCents)}
                      <ComputePromotionBadge pricing={item.pricing} />
                    </td>
                    <td className="money-cell numeric-cell">
                      {item.revenueShare
                        ? moneyMicros(item.revenueShare.brokerFeeMicros)
                        : 'Not assessed'}
                    </td>
                    <td className="money-cell numeric-cell">
                      {item.revenueShare
                        ? moneyMicros(item.revenueShare.providerNetMicros)
                        : 'Not assessed'}
                    </td>
                    <td>
                      <TableStatus>
                        {item.revenueShare ? 'Recorded · no payout' : 'Historical · unchanged'}
                      </TableStatus>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableViewport>
        ) : (
          <TableState
            title="Your first rental starts the record"
            description="A revenue split appears after a rental becomes ready. Failed or cancelled attempts before readiness create no earnings."
          />
        )}
        <TableFooter count={data?.items.length} noun="records">
          <LoadMore
            available={!!nextCursor}
            loading={loadingMore}
            onLoad={() => void loadMore()}
            error={moreError}
          />
        </TableFooter>
      </TablePanel>
      <AgreementCharges provider />
    </div>
  );
}

function ActivityList({ items }: { items: ActivityItem[] }) {
  return items.length ? (
    <div className="activity-list">
      {items.map((item) => (
        <div className="activity-item" key={item.id}>
          <span className="activity-dot">
            <Activity size={14} />
          </span>
          <div>
            <strong>{item.message}</strong>
            <span>{item.kind.replaceAll('_', ' ')}</span>
            {item.receipt && (
              <ReceiptCard receipt={item.receipt} mode={item.mode} modelCalled={item.modelCalled} />
            )}
          </div>
          <time dateTime={item.createdAt}>{shortDate(item.createdAt)}</time>
        </div>
      ))}
    </div>
  ) : (
    <TableState
      title="Your activity will appear here"
      description="Capacity updates, bid decisions, and lifecycle changes are recorded as metadata."
    />
  );
}
export function ProviderActivity() {
  const { data, error, loading, reload, nextCursor, loadingMore, loadMore, moreError } =
    usePagedResource<ActivityItem>('/api/provider/activity', 5000);
  return (
    <div className="form-page provider-page">
      <PageHeader
        eyebrow="PROVIDER HISTORY"
        title="Activity"
        description="Your provider’s capacity, bids, counteroffer decisions, and lifecycle activity in one place."
      >
        <button className="button secondary" onClick={reload}>
          <RefreshCw size={15} />
          Refresh
        </button>
      </PageHeader>
      <ErrorBox error={data ? error : ''} retry={reload} />
      <TablePanel label="Provider activity" className="provider-activity-panel">
        <TableToolbar>
          <h2>Provider activity</h2>
          <span>Metadata only</span>
        </TableToolbar>
        {loading ? (
          <TableState loading />
        ) : error && !data ? (
          <TableState error={error} onRetry={reload} />
        ) : (
          <ActivityList items={data?.items || []} />
        )}
        <TableFooter count={data?.items.length} noun="events">
          <LoadMore
            available={!!nextCursor}
            loading={loadingMore}
            onLoad={() => void loadMore()}
            error={moreError}
          />
        </TableFooter>
      </TablePanel>
    </div>
  );
}

interface AdminData {
  modes: { wick: Mode; muse: Mode };
  catalog: CatalogItem[];
  providers: { id: string; name: string; capacity?: number; simulated?: boolean }[];
  unresolved?: VM[];
  maxConcurrentVms?: number;
}
export function AdminConfig({ onUpdated }: { onUpdated: () => void }) {
  const { data, error, loading, reload } = useResource<AdminData>('/api/admin/config'),
    session = useSession();
  const [busy, setBusy] = useState(''),
    [actionError, setActionError] = useState(''),
    [success, setSuccess] = useState(''),
    [limit, setLimit] = useState<number | null>(null);
  async function act(key: string, operation: () => Promise<unknown>, message: string) {
    setBusy(key);
    setActionError('');
    setSuccess('');
    try {
      await operation();
      setSuccess(message);
      reload();
      onUpdated();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Configuration could not be updated.');
    } finally {
      setBusy('');
    }
  }
  if (loading || !data)
    return (
      <ProviderPageState title="Marketplace configuration" eyebrow="ADMINISTRATION">
        {loading ? (
          <Spinner label="Loading administration" />
        ) : (
          <ErrorBox error={error || 'Configuration unavailable.'} retry={reload} />
        )}
      </ProviderPageState>
    );
  const modes = data.modes || session.modes,
    catalog = data.catalog || session.catalog;
  return (
    <div className="form-page provider-page">
      <PageHeader
        eyebrow="ADMINISTRATION"
        title="Marketplace configuration"
        description="Approve configurations, manage the customer VM limit, and review recovery work."
      />
      <ErrorBox error={error || actionError} retry={error ? reload : undefined} />
      {success && <SuccessBox>{success}</SuccessBox>}
      <div className="stats-grid">
        <StatCard
          label="Wick integration"
          value={
            <span className="mode-stat">{modes.wick === 'fixture' ? 'Fixture' : 'Real API'}</span>
          }
          note={
            modes.wick === 'fixture'
              ? 'Explicit simulated VM lifecycle'
              : 'Configured server-side · no fallback'
          }
          icon={<Server size={18} />}
        />
        <StatCard
          label="Muse integration"
          value={
            <span className="mode-stat">{modes.muse === 'fixture' ? 'Fixture' : 'Real API'}</span>
          }
          note={
            modes.muse === 'fixture'
              ? 'Simulated responses · no model calls'
              : `${museLabel} · ${MUSE_MODEL}`
          }
          icon={<Sparkles size={18} />}
        />
        <StatCard
          label="Approved configurations"
          value={catalog.filter((c) => c.approved).length}
          note="Exact supported rental durations only"
          icon={<ShieldCheck size={18} />}
        />
      </div>
      <TablePanel label="Catalog configurations" className="provider-catalog-panel">
        <TableToolbar>
          <div>
            <h2>Wick configuration catalog</h2>
            <p>
              Only approved configurations can be used in customer requests and supplier offerings.
            </p>
          </div>
          <button
            className="button secondary"
            disabled={!!busy}
            onClick={() =>
              void act(
                'sync',
                () => post('/api/admin/catalog/sync'),
                'Catalog metadata refreshed. Review approved targets and durations.',
              )
            }
          >
            {busy === 'sync' ? (
              <Spinner label="Syncing" />
            ) : (
              <>
                <RefreshCw size={15} />
                Sync catalog
              </>
            )}
          </button>
        </TableToolbar>
        <TableViewport
          embedded
          label="Catalog configurations"
          minWidth={820}
          className="table-scroll"
        >
          <table>
            <caption className="sr-only">Catalog configurations</caption>
            <thead>
              <tr>
                <th scope="col">Configuration</th>
                <th scope="col">Resources</th>
                <th scope="col">Region</th>
                <th scope="col">Exact rentals</th>
                <th className="actions-cell" scope="col">
                  Approval
                </th>
              </tr>
            </thead>
            <tbody>
              {catalog.map((item) => (
                <tr key={item.id}>
                  <td>
                    <strong>{item.name}</strong>
                    <span className="table-subtitle">
                      {item.provider} / {item.profile}
                    </span>
                  </td>
                  <td>
                    {item.cpu} vCPU · {item.memoryGb} GiB
                    {item.gpu && <span className="table-subtitle">{item.gpu}</span>}
                  </td>
                  <td>{regionName(item.region)}</td>
                  <td>{item.durationMinutes.map((n) => `${n}m`).join(' · ')}</td>
                  <td className="actions-cell">
                    <button
                      className={`button small ${item.approved ? 'approved-button' : 'secondary'}`}
                      disabled={!!busy}
                      onClick={() =>
                        void act(
                          item.id,
                          () => put(`/api/admin/catalog/${item.id}`, { approved: !item.approved }),
                          `${item.name} ${item.approved ? 'unapproved' : 'approved'} for future requests.`,
                        )
                      }
                    >
                      {busy === item.id ? (
                        'Updating…'
                      ) : item.approved ? (
                        <>
                          <Check size={14} />
                          Approved
                        </>
                      ) : (
                        'Approve'
                      )}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableViewport>
        {catalog.length === 0 && (
          <EmptyState
            icon={<Server size={24} />}
            title="No catalog configurations"
            description="Sync metadata from the selected Wick adapter, then review and approve supported configurations."
          />
        )}
        <TableFooter count={catalog.length} noun="configurations" />
      </TablePanel>
      <FormLayout
        aside={
          <FormSummary
            title="Providers"
            description="Each account manages its own capacity and approved Wick configurations. Customer quotes stay fixed; provider earnings and upstream compute costs are tracked separately."
          >
            <div className="admin-provider-list">
              {data.providers?.map((provider, index) => (
                <div key={provider.id}>
                  <span className={`provider-avatar provider-${index % 3}`}>
                    {provider.name.slice(-1)}
                  </span>
                  <div>
                    <strong>{provider.name}</strong>
                    <span>
                      {provider.simulated === false
                        ? 'Wick-managed provider'
                        : 'Simulated demo supplier'}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          </FormSummary>
        }
      >
        <FormPanel>
          <FormSection
            title="Customer VM limit"
            description="Limit concurrent actual customer environments. Provisioning and pending cleanup continue to count."
          >
            <form
              onSubmit={(event) => {
                event.preventDefault();
                void act(
                  'limit',
                  () =>
                    put('/api/admin/config', {
                      maxConcurrentVms: limit ?? data.maxConcurrentVms ?? 20,
                    }),
                  'Customer VM limit updated.',
                );
              }}
            >
              <label className="field" htmlFor="vm-limit">
                <span>Maximum concurrent VMs</span>
                <input
                  id="vm-limit"
                  type="number"
                  min={1}
                  max={20}
                  step={1}
                  value={limit ?? data.maxConcurrentVms ?? 20}
                  onChange={(e) => setLimit(Number(e.target.value))}
                  required
                />
              </label>
              <button className="button primary" disabled={!!busy}>
                {busy === 'limit' ? (
                  <Spinner label="Saving" />
                ) : (
                  <>
                    <Save size={15} />
                    Save limit
                  </>
                )}
              </button>
            </form>
          </FormSection>
        </FormPanel>
      </FormLayout>
      <FormPanel className="unresolved-card">
        <FormSection>
          <div className="section-heading">
            <h2>Lifecycle recovery</h2>
            <span>{data.unresolved?.length || 0} unresolved</span>
          </div>
          {data.unresolved?.length ? (
            <div className="recovery-list">
              {data.unresolved.map((vm) => (
                <div key={vm.id}>
                  <span className="icon-tile small neutral">
                    <RefreshCw size={15} />
                  </span>
                  <div>
                    <strong>{vm.catalogName || vm.id.slice(0, 8)}</strong>
                    <span>
                      {vm.failureReason || 'Awaiting confirmed upstream state'} ·{' '}
                      {dateTime(vm.createdAt)}
                    </span>
                  </div>
                  <StatusPill status={vm.status} />
                  <button
                    className="button secondary small"
                    disabled={!!busy}
                    onClick={() =>
                      void act(
                        vm.id,
                        () => post(`/api/admin/vms/${vm.id}/reconcile`),
                        'Reconciliation queued. Capacity remains held until cleanup is confirmed.',
                      )
                    }
                  >
                    {busy === vm.id ? 'Queuing…' : 'Reconcile'}
                  </button>
                </div>
              ))}
            </div>
          ) : (
            <EmptyState
              icon={<CheckCircle2 size={25} />}
              title="Nothing needs recovery"
              description="Uncertain lifecycle operations retain their reservation and appear here for reconciliation."
            />
          )}
        </FormSection>
      </FormPanel>
    </div>
  );
}
