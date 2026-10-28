import { useEffect, useState, type FormEvent } from 'react';
import {
  Activity,
  ArrowRight,
  Check,
  CheckCircle2,
  Clock3,
  Cpu,
  Eye,
  Globe2,
  Layers3,
  Plus,
  Radio,
  RefreshCw,
  Save,
  Server,
  Settings2,
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
import {
  api,
  dateTime,
  money,
  post,
  put,
  shortDate,
  type Activity as ActivityItem,
  type Dashboard,
  type EnvironmentRequest,
  type Offering,
  type PolicyProposal,
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
  if (loading) return <Spinner label="Loading your capacity" />;
  if (!data) return <ErrorBox error={error || 'Provider unavailable.'} retry={reload} />;
  const { capacity, provider } = data;
  return (
    <>
      <PageHeader
        eyebrow="PROVIDER WORKSPACE"
        title={`A little room for what’s next.`}
        description={`${provider.name} · Manage the supply you make available to the marketplace.`}
      >
        <span className="quiet-badge">Simulated demo supply</span>
      </PageHeader>
      <div className="stats-grid">
        <StatCard
          label="Total capacity"
          value={capacity.total}
          note="Configured demo VM slots"
          icon={<Server size={18} />}
        />
        <StatCard
          label="Reserved slots"
          value={capacity.held}
          note="Bids and environments awaiting cleanup"
          icon={<Layers3 size={18} />}
        />
        <StatCard
          label="Available now"
          value={capacity.available}
          note={`${data.policy.reserveSlots ?? 0} spare slots protected by policy`}
          icon={<CheckCircle2 size={18} />}
        />
      </div>
      <ErrorBox error={error || actionError} retry={error ? reload : undefined} />
      <div className="provider-two-column">
        <section className="card">
          <div className="section-heading">
            <h2>Capacity overview</h2>
            <span>Demo inventory</span>
          </div>
          <div className="capacity-slots">
            {capacity.total > 0 ? (
              Array.from({ length: Math.min(capacity.total, 24) }, (_, i) => (
                <div
                  className={`capacity-slot ${i < capacity.held || i >= capacity.held + capacity.available ? 'held' : 'available'}`}
                  key={i}
                >
                  <Server size={23} />
                  <strong>Slot {i + 1}</strong>
                  <span>
                    {i < capacity.held
                      ? 'Held'
                      : i >= capacity.held + capacity.available
                        ? 'Kept spare'
                        : 'Available'}
                  </span>
                </div>
              ))
            ) : (
              <EmptyState
                icon={<Server size={24} />}
                title="No capacity published"
                description="Add a slot to make your provider eligible to bid."
              />
            )}
          </div>
          {capacity.total > 24 && (
            <p className="small-muted">Showing 24 of {capacity.total} configured slots.</p>
          )}
          <div className="capacity-legend">
            <span>
              <i className="available-dot" />
              Available for bids
            </span>
            <span>
              <i className="held-dot" />
              Held or kept spare
            </span>
          </div>
          <div className="info-note">
            <ShieldCheck size={17} />
            <p>
              Every accepted bid reserves a slot atomically. Losing bids release at auction close; a
              winning slot stays reserved until Wick confirms cleanup.
            </p>
          </div>
        </section>
        <section className="card">
          <div className="section-heading">
            <h2>Adjust your capacity</h2>
            <Settings2 size={18} />
          </div>
          <p className="muted-text">
            Publish the number of demo VM slots you want to offer. This is simulated inventory, not
            measured provider capacity.
          </p>
          <p>
            <Link className="text-link" href="/provider/policy">
              Open Muse Capacity Manager <ArrowRight size={14} />
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
                You currently have {capacity.held} reserved {capacity.held === 1 ? 'slot' : 'slots'}
                . Existing reservations are preserved.
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
        </section>
      </div>
      <section className="card recent-activity">
        <div className="section-heading">
          <h2>Recent activity</h2>
          <Link className="text-link" href="/provider/activity">
            View all
            <ArrowRight size={14} />
          </Link>
        </div>
        <ActivityList items={data.activity.slice(0, 5)} />
      </section>
    </>
  );
}

export function ProviderPolicy() {
  const { data, error, loading, reload } = useResource<Dashboard>('/api/provider/dashboard', 5000),
    { catalog, modes } = useSession();
  const [policy, setPolicy] = useState<SupplierPolicy | null>(null),
    [baseRevision, setBaseRevision] = useState<number | null>(null),
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
      (baseRevision === null || data.policyRevision >= baseRevision)
    ) {
      setPolicy({ ...data.policy, reserveSlots: data.policy.reserveSlots ?? 0 });
      setBaseRevision(data.policyRevision);
    }
  }, [data, dirty, proposal, baseRevision]);
  function update(change: Partial<SupplierPolicy>) {
    setPolicy((old) => (old ? { ...old, ...change } : old));
    setDirty(true);
    setSaved(false);
  }
  function discardDraft() {
    if (!data) return;
    setPolicy({ ...data.policy, reserveSlots: data.policy.reserveSlots ?? 0 });
    setBaseRevision(data.policyRevision);
    setDirty(false);
    setProposal(null);
    setActionError('');
    setSaved(false);
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
    try {
      const result = await put<{ policy: SupplierPolicy; policyRevision: number }>(
        '/api/provider/policy',
        {
          ...policy,
          expectedRevision: baseRevision,
        },
      );
      setPolicy({ ...result.policy, reserveSlots: result.policy.reserveSlots ?? 0 });
      setBaseRevision(result.policyRevision);
      setProposal(null);
      setDirty(false);
      setSaved(true);
      reload();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Policy could not be saved.');
      reload();
    } finally {
      setBusy('');
    }
  }
  if (loading || (!policy && !error)) return <Spinner label="Loading policy" />;
  if (!policy) return <ErrorBox error={error || 'Policy unavailable.'} retry={reload} />;
  const allowed = policy.allowedCatalogIds ?? catalog.filter((c) => c.approved).map((c) => c.id);
  const stale = baseRevision !== null && !!data && data.policyRevision > baseRevision;
  const spare = policy.reserveSlots ?? 0;
  const proposedAvailable = Math.max(
    0,
    (data?.capacity.total ?? 0) - (data?.capacity.held ?? 0) - spare,
  );
  return (
    <>
      <PageHeader
        eyebrow="YOUR PRICING, YOUR RULES"
        title="Muse Capacity Manager"
        description="Describe your selling strategy, review explicit limits, then choose whether to apply them."
      >
        <span className="quiet-badge">
          {modes.muse === 'fixture' ? 'Fixture Muse · no model calls' : 'Muse · reviewed proposals'}
        </span>
      </PageHeader>
      <section className="card">
        <h2>Your selling strategy</h2>
        <p className="muted-text">
          Muse uses only your own saved policy, current capacity, and approved configurations. A
          proposal holds no slots and changes no active limits.
        </p>
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
              disabled={!!busy}
              placeholder="Fill idle machines, keep two slots spare, never quote below $0.05."
            />
          </label>
          <div className="form-actions">
            <button className="button muse-button" disabled={!!busy || stale}>
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
      </section>
      {data && (
        <section className="card policy-notes">
          <div className="section-heading">
            <h2>Current capacity and active policy</h2>
            <span>Revision {data.policyRevision}</span>
          </div>
          <DetailRow label="Configured demo slots">{data.capacity.total}</DetailRow>
          <DetailRow label="Existing holds">{data.capacity.held}</DetailRow>
          <DetailRow label="Kept spare by active policy">{data.policy.reserveSlots ?? 0}</DetailRow>
          <DetailRow label="Available for new holds">{data.capacity.available}</DetailRow>
          <DetailRow label="Active minimum total">{money(data.policy.minimumPriceCents)}</DetailRow>
        </section>
      )}
      {stale && (
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
        <section className="card">
          <h2>Proposed limits · not active</h2>
          <p className="muted-text">
            Review and edit every limit below. The decision receipt describes the original proposal;
            your edits are applied only when you choose Apply reviewed limits.
          </p>
          <ReceiptCard
            receipt={proposal.receipt}
            mode={proposal.mode}
            modelCalled={proposal.modelCalled}
          />
        </section>
      )}
      <ErrorBox error={error || actionError} retry={error ? reload : undefined} />
      <form onSubmit={save}>
        <fieldset disabled={!!busy} style={{ border: 0, padding: 0, margin: 0 }}>
          <div className="provider-two-column">
            <section className="card">
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
                  value={spare}
                  onChange={(event) => update({ reserveSlots: Number(event.target.value) })}
                />
                <span className="field-hint">
                  With current holds, these limits allow {proposedAvailable} new slots. Spare slots
                  apply to manual bids, automatic bids, and accepted alternatives. Existing holds
                  remain intact.
                </span>
              </label>
              <label className="toggle-row" htmlFor="auto-bid">
                <div>
                  <strong>Automatic bidding</strong>
                  <p>After you apply, Muse may submit eligible bids within these limits.</p>
                </div>
                <input
                  id="auto-bid"
                  type="checkbox"
                  className="toggle-input"
                  checked={policy.autoBid}
                  onChange={(e) => update({ autoBid: e.target.checked })}
                />
                <span className="toggle-track" aria-hidden="true" />
              </label>
              <div className="field-grid">
                <MoneyInput
                  id="minimum-price"
                  label="Minimum total price (USD)"
                  value={policy.minimumPriceCents}
                  onChange={(minimumPriceCents) => update({ minimumPriceCents })}
                />
                <MoneyInput
                  id="base-price"
                  label="Base total price (USD)"
                  value={policy.basePriceCents}
                  onChange={(basePriceCents) => update({ basePriceCents })}
                />
              </div>
              <MoneyInput
                id="policy-max-price"
                label="Maximum total price (USD)"
                value={policy.maxPriceCents ?? policy.basePriceCents}
                onChange={(maxPriceCents) => update({ maxPriceCents })}
              />
              <p className="field-hint">
                Fixed totals for the selected rental, in integer USD cents. The customer’s maximum
                price also applies. For real Wick rentals, the rounded upstream compute cost is an
                additional minimum.
              </p>
              <div className="form-divider" />
              <h3>Eligible configurations</h3>
              <p className="muted-text">
                Only administrator-approved existing Wick configurations can be offered.
              </p>
              <div className="catalog-checks">
                {catalog
                  .filter((c) => c.approved)
                  .map((item) => (
                    <label key={item.id}>
                      <input
                        type="checkbox"
                        checked={allowed.includes(item.id)}
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
                  disabled={!!busy || stale || baseRevision === null}
                >
                  {busy === 'save' ? (
                    <Spinner label="Saving policy" />
                  ) : (
                    <>
                      <Save size={16} />
                      {proposal ? 'Apply reviewed limits' : 'Save policy'}
                    </>
                  )}
                </button>
                {(dirty || proposal) && (
                  <button type="button" className="button secondary" onClick={discardDraft}>
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
            </section>
            <aside>
              <div className="muse-explainer large">
                <span className="icon-tile violet">
                  <Sparkles size={20} />
                </span>
                <div>
                  <h3>A proposal with boundaries</h3>
                  <p>
                    Muse can propose a price or decline. Deterministic validation checks the
                    configuration, available capacity, pricing bounds, and auction deadline.
                  </p>
                  <span className="tiny-label">
                    {modes.muse === 'fixture'
                      ? 'Fixture proposals · no model calls'
                      : 'Powered by muse-wonder-1.0'}
                  </span>
                </div>
              </div>
              <div className="card policy-notes">
                <h3>What your policy changes</h3>
                <DetailRow label="Future bids">Use your saved policy</DetailRow>
                <DetailRow label="Existing reservations">Remain in place</DetailRow>
                <DetailRow label="Awarded quotes">Stay fixed</DetailRow>
                <DetailRow label="Manual bids">
                  Same floor, spare slots, and capacity checks
                </DetailRow>
                <DetailRow label="Buyer-approved alternatives">
                  Same saved limits, rechecked on acceptance
                </DetailRow>
                <p className="small-muted">
                  Your private policy is isolated from other suppliers. Credentials and customer
                  terminal contents never go to Muse.
                </p>
              </div>
            </aside>
          </div>
        </fieldset>
      </form>
    </>
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
    [success, setSuccess] = useState(false);
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
      await post(`/api/provider/requests/${request.id}/bids`, { totalPriceCents: price });
      setSuccess(true);
      onBid();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Bid could not be accepted.');
    } finally {
      setBusy('');
    }
  }
  return (
    <article className="card provider-request">
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
          {request.region}
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
                Muse recommends declining
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
  );
}
export function ProviderRequests() {
  const { data, error, loading, reload, nextCursor, loadingMore, loadMore, moreError } =
      usePagedResource<EnvironmentRequest>('/api/provider/requests', 3000),
    dashboard = useResource<Dashboard>('/api/provider/dashboard', 5000);
  const items = data?.items || [];
  return (
    <>
      <PageHeader
        eyebrow="THE MARKETPLACE"
        title="Find your next match."
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
            {dashboard.data?.capacity.available ?? '—'} available slots · {items.length} loaded
            requests
          </h3>
          <p>
            Manual and automatic bids honor your saved price floor and spare slots. Late offers are
            rejected.
          </p>
        </div>
        <span className="quiet-badge">
          Auto bidding {dashboard.data?.policy.autoBid ? 'on' : 'off'}
        </span>
      </div>
      <ErrorBox
        error={error || dashboard.error}
        retry={() => {
          reload();
          dashboard.reload();
        }}
      />
      {loading ? (
        <Spinner label="Loading marketplace requests" />
      ) : items.length ? (
        <div className="provider-requests-grid">
          {items.map((request) => (
            <ProviderRequestCard
              key={request.id}
              request={request}
              basePriceCents={dashboard.data?.policy.basePriceCents ?? 150}
              onBid={() => {
                reload();
                dashboard.reload();
              }}
            />
          ))}
        </div>
      ) : (
        <section className="card">
          <EmptyState
            icon={<Radio size={26} />}
            title="A quiet moment in the marketplace"
            description="New customer requests appear here during their 30-second auctions. This view refreshes automatically."
          />
        </section>
      )}
      <LoadMore
        available={!!nextCursor}
        loading={loadingMore}
        onLoad={() => void loadMore()}
        error={moreError}
      />
    </>
  );
}

export function ProviderOfferings() {
  const { data, error, loading, reload, nextCursor, loadingMore, loadMore, moreError } =
      usePagedResource<Offering>('/api/provider/offerings'),
    { catalog, modes } = useSession(),
    approved = catalog.filter((item) => item.approved);
  const [draft, setDraft] = useState<OfferingProposal>({
      catalogId: approved[0]?.id || '',
      name: '',
      description: '',
      priceCents: 150,
    }),
    [showForm, setShowForm] = useState(false),
    [busy, setBusy] = useState(''),
    [actionError, setActionError] = useState(''),
    [success, setSuccess] = useState(''),
    [suggestions, setSuggestions] = useState<{
      proposals: OfferingProposal[];
      receipt: Receipt;
      mode: Mode;
      modelCalled?: boolean;
    } | null>(null);
  async function create(event: FormEvent) {
    event.preventDefault();
    setBusy('create');
    setActionError('');
    setSuccess('');
    try {
      await post('/api/provider/offerings', draft);
      setShowForm(false);
      setSuccess('Offering published. New bids can use this revision.');
      setDraft({ catalogId: approved[0]?.id || '', name: '', description: '', priceCents: 150 });
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
    <>
      <PageHeader
        eyebrow="YOUR SHELF OF POSSIBILITIES"
        title="Offer something that fits."
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
      <div className="offering-muse-banner">
        <span className="icon-tile violet">
          <Sparkles size={22} />
        </span>
        <div>
          <h3>Let demand point the way.</h3>
          <p>
            Muse can suggest offerings from recorded unmatched requests and your private policy.
            Review before publishing.
          </p>
          <span>
            {modes.muse === 'fixture'
              ? 'Fixture suggestions · no model calls'
              : 'muse-wonder-1.0 · approved configurations only'}
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
      <ErrorBox error={error || actionError} retry={error ? reload : undefined} />
      {success && <SuccessBox>{success}</SuccessBox>}
      {suggestions && (
        <section className="card offering-suggestions">
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
                      {modes.wick === 'real' ? '· 30 minute example' : 'fixed fixture rental total'}
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
        </section>
      )}
      {showForm && (
        <section className="card offering-form">
          <div className="section-heading">
            <h2>Review & publish an offering</h2>
            <span className="quiet-badge">Simulated demo supply</span>
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
                  onChange={(e) => setDraft({ ...draft, catalogId: e.target.value })}
                  required
                >
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
                <p className="field-hint">
                  Publishing stores a 30 minute example based on the current Wick rate and target
                  markup. Each rental gets a duration-specific fixed quote. Your binding bid can
                  differ within your policy and the buyer’s budget, at or above the rounded upstream
                  compute cost.
                </p>
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
            <div className="form-actions">
              <button className="button primary" disabled={!!busy || !draft.catalogId}>
                {busy === 'create' ? (
                  <Spinner label="Publishing" />
                ) : (
                  <>
                    <Check size={16} />
                    Publish offering
                  </>
                )}
              </button>
              <button type="button" className="button secondary" onClick={() => setShowForm(false)}>
                Cancel
              </button>
            </div>
          </form>
        </section>
      )}
      {loading ? (
        <Spinner label="Loading your offerings" />
      ) : data?.items.length ? (
        <div className="offerings-grid">
          {data.items.map((item) => {
            const config = catalog.find((c) => c.id === item.catalogId);
            return (
              <article
                key={item.id}
                className={`card offering-card ${!item.active ? 'offering-inactive' : ''}`}
              >
                <div className="offering-card-top">
                  <span className="icon-tile neutral">
                    <Server size={23} />
                  </span>
                  <span className={`quiet-badge ${item.active ? 'green-badge' : ''}`}>
                    {item.active ? 'Published' : 'Inactive'}
                  </span>
                </div>
                <h3>{item.name}</h3>
                <p>{item.description}</p>
                <div className="request-spec-tags">
                  <span>{config?.cpu ?? '—'} vCPU</span>
                  <span>{config?.memoryGb ?? '—'} GiB RAM</span>
                  <span>{config?.region || 'Approved configuration'}</span>
                </div>
                <div className="offering-price">
                  <strong>{money(item.priceCents)}</strong>
                  <span>
                    {item.pricing
                      ? '30 minute example · duration-based fixed quote'
                      : 'fixed rental total'}
                  </span>
                </div>
                <div className="offering-card-footer">
                  <span>
                    Revision {item.revision}
                    <span className="middle-dot">·</span>Demo supply
                  </span>
                  <button
                    className="text-button"
                    onClick={() => void toggle(item)}
                    disabled={!!busy}
                  >
                    {busy === item.id ? 'Updating…' : item.active ? 'Unpublish' : 'Publish'}
                  </button>
                </div>
              </article>
            );
          })}
        </div>
      ) : (
        <section className="card">
          <EmptyState
            icon={<Layers3 size={26} />}
            title="Your next offering starts here"
            description="Choose an approved configuration and a fixed total price to publish your first offering."
          >
            <button className="button primary" onClick={() => setShowForm(true)}>
              <Plus size={15} />
              New offering
            </button>
          </EmptyState>
        </section>
      )}
      <LoadMore
        available={!!nextCursor}
        loading={loadingMore}
        onLoad={() => void loadMore()}
        error={moreError}
      />
      <div className="info-note">
        <ShieldCheck size={17} />
        <p>
          Awarded rentals retain their offering revision and quote. Unpublishing an offering affects
          future bids only.
        </p>
      </div>
    </>
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
    <EmptyState
      icon={<Activity size={25} />}
      title="Your activity will appear here"
      description="Capacity updates, bid decisions, and lifecycle changes are recorded as metadata."
    />
  );
}
export function ProviderActivity() {
  const { data, error, loading, reload, nextCursor, loadingMore, loadMore, moreError } =
    usePagedResource<ActivityItem>('/api/provider/activity', 5000);
  return (
    <>
      <PageHeader
        eyebrow="A CLEAR RECORD"
        title="See how things are moving."
        description="Your provider’s capacity, bids, and lifecycle activity in one place."
      >
        <button className="button secondary" onClick={reload}>
          <RefreshCw size={15} />
          Refresh
        </button>
      </PageHeader>
      <ErrorBox error={error} retry={reload} />
      <section className="card">
        <div className="section-heading">
          <h2>Provider activity</h2>
          <span>Metadata only</span>
        </div>
        {loading ? (
          <Spinner label="Loading activity" />
        ) : (
          <ActivityList items={data?.items || []} />
        )}
        <LoadMore
          available={!!nextCursor}
          loading={loadingMore}
          onLoad={() => void loadMore()}
          error={moreError}
        />
      </section>
    </>
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
  if (loading) return <Spinner label="Loading administration" />;
  if (!data) return <ErrorBox error={error || 'Configuration unavailable.'} retry={reload} />;
  const modes = data.modes || session.modes,
    catalog = data.catalog || session.catalog;
  return (
    <>
      <PageHeader
        eyebrow="ADMINISTRATION"
        title="Keep the marketplace in good shape."
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
            modes.muse === 'fixture' ? 'No model calls or model success claims' : 'muse-wonder-1.0'
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
      <section className="card admin-catalog">
        <div className="section-heading">
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
        </div>
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Configuration</th>
                <th>Resources</th>
                <th>Region</th>
                <th>Exact rentals</th>
                <th>Approval</th>
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
                  <td>{item.region}</td>
                  <td>{item.durationMinutes.map((n) => `${n}m`).join(' · ')}</td>
                  <td>
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
        </div>
        {catalog.length === 0 && (
          <EmptyState
            icon={<Server size={24} />}
            title="No catalog configurations"
            description="Sync metadata from the selected Wick adapter, then review and approve supported configurations."
          />
        )}
      </section>
      <div className="provider-two-column">
        <section className="card">
          <h2>Customer VM limit</h2>
          <p className="muted-text">
            Limit concurrent actual customer environments. Provisioning and pending cleanup continue
            to count.
          </p>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void act(
                'limit',
                () =>
                  put('/api/admin/config', {
                    maxConcurrentVms: limit ?? data.maxConcurrentVms ?? 2,
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
                value={limit ?? data.maxConcurrentVms ?? 2}
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
        </section>
        <section className="card">
          <h2>Providers</h2>
          <p className="muted-text">
            These accounts manage demo supplier allocations backed by Wick; they are not independent
            provider firms. Customer fixed quotes and Wick internal usage are separate. No payment
            due.
          </p>
          <div className="admin-provider-list">
            {data.providers?.map((provider, index) => (
              <div key={provider.id}>
                <span className={`provider-avatar provider-${index % 3}`}>
                  {provider.name.slice(-1)}
                </span>
                <div>
                  <strong>{provider.name}</strong>
                  <span>Simulated demo supplier</span>
                </div>
              </div>
            ))}
          </div>
        </section>
      </div>
      <section className="card unresolved-card">
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
      </section>
    </>
  );
}
