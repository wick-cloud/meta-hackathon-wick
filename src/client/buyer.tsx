import { lazy, Suspense, useEffect, useState, type FormEvent } from 'react';
import { fixedQuote, managedPricing } from '../shared/pricing';
import { parseExplicitBuyerDescription } from '../shared/muse-contracts';
import { seedAlternativeDraft } from './negotiation';
import {
  ArrowDownToLine,
  ArrowRight,
  Check,
  CheckCircle2,
  ChevronLeft,
  CircleDollarSign,
  Clock3,
  Cpu,
  FileText,
  Globe2,
  Layers3,
  LockKeyhole,
  Plus,
  Radio,
  ReceiptText,
  RefreshCw,
  Server,
  ShieldCheck,
  Sparkles,
  SquareTerminal,
  Timer,
  X,
} from 'lucide-react';
import {
  api,
  dateTime,
  loadDraft,
  money,
  moneyMicros,
  post,
  rentalSourceLabel,
  saveDraft,
  shortDate,
  type Bid,
  type Draft,
  type EnvironmentRequest,
  type Invoice,
  type Proposal,
  type VM,
} from './api';
import {
  ArrowLink,
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
  Steps,
  remaining,
  useNavigate,
  useNow,
  usePagedResource,
  useResource,
  useSession,
} from './components';
const TerminalPanel = lazy(() =>
  import('./terminal').then((module) => ({ default: module.TerminalPanel })),
);

export function NewEnvironment() {
  const { catalog, modes, user } = useSession(),
    navigate = useNavigate();
  const [description, setDescription] = useState(loadDraft()?.description || ''),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [budget, setBudget] = useState(loadDraft()?.maxPriceCents ?? 500),
    [budgetEdited, setBudgetEdited] = useState(false);
  const approved = catalog.filter((item) => item.approved),
    first = approved[0];
  function changeDescription(value: string) {
    setDescription(value);
    const explicit = parseExplicitBuyerDescription(value);
    if (!budgetEdited && explicit.maxPriceCents !== undefined) setBudget(explicit.maxPriceCents);
  }
  function alternatives() {
    const explicit = parseExplicitBuyerDescription(description);
    seedAlternativeDraft(user!.id, description.trim(), {
      cpu: explicit.requirements.cpu ?? first?.cpu ?? 2,
      memoryGb: explicit.requirements.memoryGb ?? first?.memoryGb ?? 4,
      ...(explicit.requirements.gpu ? { gpu: explicit.requirements.gpu } : {}),
      region: explicit.region ?? first?.region ?? '',
      durationMinutes: explicit.durationMinutes ?? 30,
      maxPriceCents: budget,
    });
    navigate('/alternatives/new');
  }
  function manual() {
    if (!first) {
      setError(
        'No approved configurations are available. Your administrator can approve a catalog configuration.',
      );
      return;
    }
    saveDraft({
      description: description.trim(),
      catalogId: first.id,
      region: first.region,
      durationMinutes: first.durationMinutes.includes(30) ? 30 : first.durationMinutes[0]!,
      maxPriceCents: budget,
      requirements: {
        cpu: first.cpu,
        memoryGb: first.memoryGb,
        ...(first.gpu ? { gpu: first.gpu } : {}),
      },
    });
    navigate('/requests/review');
  }
  async function translate() {
    if (!description.trim()) {
      setError('Describe the environment you need, or use manual review.');
      return;
    }
    setBusy(true);
    setError('');
    try {
      const result = await post<Proposal>('/api/muse/translate', {
        description: description.trim(),
      });
      saveDraft({
        ...result.proposal,
        description: description.trim(),
        maxPriceCents: budget,
        receipt: result.receipt,
        museMode: result.mode,
      });
      navigate('/requests/review');
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : 'Muse could not prepare your request. Manual review is available.',
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <PageHeader
        eyebrow="A FRESH PLACE TO BUILD"
        title="Your next environment starts here."
        description="Tell us what you need. We’ll find the right fit, at a clear price."
      />
      <Steps active={0} />
      <div className="new-environment-grid">
        <section className="card request-composer">
          <div className="card-heading">
            <div className="icon-tile emerald">
              <SquareTerminal size={21} />
            </div>
            <div>
              <h2>What do you have in mind?</h2>
              <p>A few details are all it takes to get started.</p>
            </div>
          </div>
          <label className="field prompt-field" htmlFor="environment-description">
            <span>Describe your environment</span>
            <textarea
              id="environment-description"
              maxLength={4000}
              rows={6}
              placeholder="I need a small Linux environment with 2 vCPUs and 4 GB of memory for 30 minutes…"
              value={description}
              onChange={(e) => changeDescription(e.target.value)}
            />
            <span className="field-hint">
              Include the resources, region, and rental length you need. You’ll review everything
              before the auction.
            </span>
          </label>
          <div className="prompt-examples">
            <span>Try a starting point</span>
            <div>
              {[
                'A lightweight Linux workspace',
                'A memory-rich environment',
                'A short compute session',
              ].map((text, i) => (
                <button
                  key={text}
                  className="suggestion-chip"
                  onClick={() =>
                    changeDescription(
                      [
                        `A lightweight Linux environment with 2 vCPUs and 4 GB memory for 30 minutes.`,
                        `A Linux environment with at least 8 GB memory for a 30-minute session.`,
                        `A Linux environment with 4 vCPUs for a 15-minute session.`,
                      ][i]!,
                    )
                  }
                >
                  {text}
                  <ArrowRight size={12} />
                </button>
              ))}
            </div>
          </div>
          <MoneyInput
            id="initial-budget"
            label="Your maximum total (USD)"
            value={budget}
            min={1}
            onChange={(value) => {
              setBudget(value);
              setBudgetEdited(true);
            }}
          />
          <p className="field-hint">
            Explicit budgets in your description fill this field. Your edits take precedence; review
            the amount before continuing.
          </p>
          <ErrorBox error={error} />
          <div className="composer-actions">
            <button className="button secondary" onClick={manual} disabled={busy || !first}>
              Review manually
            </button>
            <button
              className="button primary"
              onClick={() => void translate()}
              disabled={busy || !first}
            >
              {busy ? (
                <Spinner label="Preparing review" />
              ) : (
                <>
                  <Sparkles size={16} />
                  Prepare with Muse
                  <ArrowRight size={16} />
                </>
              )}
            </button>
          </div>
          <button className="button secondary full-width" onClick={alternatives} disabled={busy}>
            Review unsupported needs and alternatives
            <ArrowRight size={16} />
          </button>
          <div className="composer-note">
            <LockKeyhole size={13} />
            Only your environment requirements go to Muse. Never credentials or terminal contents.
          </div>
        </section>
        <aside className="new-side">
          <div className="environment-illustration">
            <div className="illustration-caption">
              <span className="green-dot" />A SPACE OF YOUR OWN
            </div>
            <div className="server-stack">
              <div className="server-layer back">
                <i />
                <i />
                <span />
              </div>
              <div className="server-layer middle">
                <i />
                <i />
                <span />
              </div>
              <div className="server-layer front">
                <div className="server-logo">w</div>
                <div className="server-leds">
                  <i />
                  <i />
                  <i />
                </div>
                <span className="server-line" />
              </div>
              <div className="server-orbit orbit-one" />
              <div className="server-orbit orbit-two" />
              <span className="floating-chip">
                <LockKeyhole size={12} />
                Private
              </span>
            </div>
            <h3>
              Just the environment.
              <br />
              The rest is yours.
            </h3>
            <p>Open a browser terminal and run your own commands when you’re ready.</p>
          </div>
          <div className="muse-explainer">
            <span className="icon-tile violet">
              <Sparkles size={19} />
            </span>
            <div>
              <h3>A thoughtful starting point</h3>
              <p>
                Muse matches your description to approved configurations. Every choice stays
                editable.
              </p>
              <span className="tiny-label">
                {modes.muse === 'fixture' ? 'Fixture mode · no model call' : 'muse-wonder-1.0'}
              </span>
            </div>
          </div>
        </aside>
      </div>
      <section className="how-it-works">
        <div className="section-heading">
          <h2>A clear path from idea to terminal</h2>
          <span>Three small steps. One ready environment.</span>
        </div>
        <div className="how-grid">
          <div>
            <span className="how-number">01</span>
            <h3>Make it your own</h3>
            <p>Review the configuration, exact rental duration, and maximum total price.</p>
          </div>
          <div>
            <span className="how-number">02</span>
            <h3>Let providers compete</h3>
            <p>A 30-second auction finds the lowest eligible total offer automatically.</p>
          </div>
          <div>
            <span className="how-number">03</span>
            <h3>Open your terminal</h3>
            <p>Connect in your browser. Your rental clock begins when Wick admits provisioning.</p>
          </div>
        </div>
      </section>
      {!first && (
        <ErrorBox error="No approved configurations are available. Ask an administrator to approve a supported configuration." />
      )}
    </>
  );
}

export function RequestReview() {
  const { catalog, modes } = useSession(),
    navigate = useNavigate();
  const [draft, setDraft] = useState<Draft | null>(loadDraft),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const approved = catalog.filter((item) => item.approved),
    selected = approved.find((item) => item.id === draft?.catalogId);
  function update(change: Partial<Draft>) {
    setDraft((old) => (old ? { ...old, ...change } : old));
  }
  useEffect(() => {
    if (draft) saveDraft(draft);
  }, [draft]);
  if (!draft)
    return (
      <>
        <PageHeader title="Let’s start with an environment." />
        <EmptyState
          icon={<SquareTerminal size={26} />}
          title="No request to review yet"
          description="Describe what you need, or choose your configuration manually."
        >
          <Link href="/new" className="button primary">
            New environment
            <ArrowRight size={16} />
          </Link>
        </EmptyState>
      </>
    );
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!draft || !selected) return;
    setBusy(true);
    setError('');
    try {
      const request = await post<EnvironmentRequest>('/api/requests', {
        description: draft.description.trim() || `${selected.name} environment`,
        catalogId: draft.catalogId,
        region: draft.region,
        durationMinutes: draft.durationMinutes,
        maxPriceCents: draft.maxPriceCents,
        requirements: draft.requirements,
      });
      sessionStorage.removeItem('wick-draft');
      navigate(`/requests/${request.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to start auction.');
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <Link href="/new" className="back-link">
        <ChevronLeft size={16} />
        Back to description
      </Link>
      <PageHeader
        title="A good fit. A few final details."
        description="Review your environment before providers start bidding."
      />
      <Steps active={1} />
      <form onSubmit={submit}>
        <div className="review-grid">
          <section className="card">
            <div className="section-heading">
              <h2>Environment specification</h2>
              <span className="quiet-badge">Editable review</span>
            </div>
            <label className="field" htmlFor="review-description">
              <span>Your requirement</span>
              <textarea
                id="review-description"
                rows={3}
                maxLength={4000}
                value={draft.description}
                onChange={(e) => update({ description: e.target.value })}
                placeholder="Describe your environment"
              />
            </label>
            <label className="field" htmlFor="configuration">
              <span>Configuration</span>
              <select
                id="configuration"
                value={draft.catalogId}
                onChange={(e) => {
                  const item = approved.find((c) => c.id === e.target.value)!;
                  update({
                    catalogId: item.id,
                    region: item.region,
                    requirements: {
                      cpu: item.cpu,
                      memoryGb: item.memoryGb,
                      ...(item.gpu ? { gpu: item.gpu } : {}),
                    },
                    durationMinutes: item.durationMinutes.includes(draft.durationMinutes)
                      ? draft.durationMinutes
                      : item.durationMinutes.includes(30)
                        ? 30
                        : item.durationMinutes[0]!,
                  });
                }}
                required
              >
                {approved.map((item) => (
                  <option value={item.id} key={item.id}>
                    {item.name} · {item.cpu} vCPU · {item.memoryGb} GiB RAM
                  </option>
                ))}
              </select>
              {selected && <span className="field-hint">{selected.description}</span>}
            </label>
            <div className="field-grid">
              <label className="field" htmlFor="region">
                <span>Region</span>
                <select
                  id="region"
                  value={draft.region}
                  onChange={(e) => update({ region: e.target.value })}
                >
                  {selected && <option value={selected.region}>{selected.region}</option>}
                </select>
              </label>
              <label className="field" htmlFor="duration">
                <span>Rental duration</span>
                <select
                  id="duration"
                  value={draft.durationMinutes}
                  onChange={(e) => update({ durationMinutes: Number(e.target.value) })}
                >
                  {selected?.durationMinutes
                    .filter((n) => [15, 30, 60].includes(n))
                    .map((n) => (
                      <option value={n} key={n}>
                        {n} minutes
                      </option>
                    ))}
                </select>
              </label>
            </div>
            <div className="field-grid">
              <label className="field" htmlFor="cpus">
                <span>Minimum vCPUs</span>
                <input
                  id="cpus"
                  type="number"
                  min={1}
                  max={selected?.cpu || 256}
                  step={1}
                  value={draft.requirements.cpu}
                  onChange={(e) =>
                    update({ requirements: { ...draft.requirements, cpu: Number(e.target.value) } })
                  }
                  required
                />
              </label>
              <label className="field" htmlFor="memory">
                <span>Minimum memory (GiB)</span>
                <input
                  id="memory"
                  type="number"
                  min={Number.MIN_VALUE}
                  max={selected?.memoryGb || 2048}
                  step="any"
                  value={draft.requirements.memoryGb}
                  onChange={(e) =>
                    update({
                      requirements: { ...draft.requirements, memoryGb: Number(e.target.value) },
                    })
                  }
                  required
                />
              </label>
            </div>
            <MoneyInput
              id="max-price"
              label="Maximum total price (USD)"
              value={draft.maxPriceCents}
              onChange={(maxPriceCents) => update({ maxPriceCents })}
              min={1}
            />
            <p className="field-hint">
              Your ceiling for the entire rental. The lowest eligible bid wins. No Broker fee is
              added to the accepted total; the provider pays the 15% commission.
            </p>
            {draft.receipt && <ReceiptCard receipt={draft.receipt} mode={draft.museMode} />}
          </section>
          <aside className="review-side">
            <div className="card order-summary">
              <div className="icon-tile emerald">
                <Layers3 size={21} />
              </div>
              <h2>Your environment, at a glance</h2>
              <p>{selected?.name || 'Select a configuration'}</p>
              <DetailRow label="Resources">
                {draft.requirements.cpu} vCPU · {draft.requirements.memoryGb} GiB
              </DetailRow>
              <DetailRow label="Region">{draft.region}</DetailRow>
              <DetailRow label="Rental">{draft.durationMinutes} minutes</DetailRow>
              <DetailRow label="Auction length">30 seconds</DetailRow>
              {selected?.pricingMode === 'managed' &&
                selected.rateMicrosPerSecond !== undefined && (
                  <>
                    <DetailRow label="Managed rate">
                      {selected.rateMicrosPerSecond} µUSD / second
                    </DetailRow>
                    <DetailRow label="Suggested target quote">
                      {money(
                        fixedQuote(managedPricing(selected), draft.durationMinutes).totalPriceCents,
                      )}
                    </DetailRow>
                    <p className="field-hint">
                      The suggested total covers estimated compute after the provider’s 15%
                      commission. Your accepted offer freezes the full rental price, with no added
                      Broker fee.
                    </p>
                  </>
                )}
              <div className="summary-total">
                <span>Maximum total</span>
                <strong>
                  {money(draft.maxPriceCents)}
                  <small>USD</small>
                </strong>
              </div>
              <span className="demo-price-note">
                {modes.wick === 'real'
                  ? 'Demo supplier allocation backed by Wick'
                  : 'Simulated demo supply'}{' '}
                · No payment due
              </span>
              <button
                type="submit"
                className="button primary full-width"
                disabled={busy || !selected}
              >
                {busy ? (
                  <Spinner label="Starting auction" />
                ) : (
                  <>
                    Start 30-second auction
                    <ArrowRight size={16} />
                  </>
                )}
              </button>
            </div>
            <div className="rental-notes">
              <div>
                <Clock3 size={17} />
                <p>
                  <strong>The clock includes setup.</strong> Your rental begins at Wick provisioning
                  admission. The exact expiry appears on your VM.
                </p>
              </div>
              <div>
                <ShieldCheck size={17} />
                <p>
                  <strong>Ready is what counts.</strong> One fixed charge only after Wick confirms
                  running and terminal capability. No charge if it expires before ready.
                </p>
              </div>
              <div>
                <LockKeyhole size={17} />
                <p>
                  <strong>Your request becomes final.</strong> Changing requirements after launch
                  means starting a new auction.
                </p>
              </div>
            </div>
          </aside>
        </div>
        <ErrorBox error={error} />
      </form>
    </>
  );
}

export function AuctionPage({ id }: { id: string }) {
  const { data, error, loading, reload } = useResource<{
      request: EnvironmentRequest;
      bids: Bid[];
      vm?: VM | null;
    }>(`/api/requests/${encodeURIComponent(id)}`, 2000),
    navigate = useNavigate(),
    now = useNow();
  const [busy, setBusy] = useState(''),
    [actionError, setActionError] = useState('');
  async function action(kind: 'cancel' | 'retry') {
    setBusy(kind);
    setActionError('');
    try {
      const result = await post<EnvironmentRequest>(`/api/requests/${id}/${kind}`);
      if (kind === 'retry') navigate(`/requests/${result.id}`);
      else reload();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Request action failed.');
    } finally {
      setBusy('');
    }
  }
  if (loading) return <Spinner label="Loading your auction" />;
  if (!data) return <ErrorBox error={error || 'Request unavailable.'} retry={reload} />;
  const { request, bids, vm } = data;
  const seconds = Math.max(0, Math.ceil((new Date(request.closesAt).getTime() - now) / 1000));
  const open = request.status === 'open';
  const sorted = [...bids].sort(
    (a, b) =>
      a.totalPriceCents - b.totalPriceCents ||
      a.createdAt.localeCompare(b.createdAt) ||
      a.id.localeCompare(b.id),
  );
  const ended = ['no_offers', 'failed', 'cancelled'].includes(request.status);
  return (
    <>
      <PageHeader
        eyebrow="REQUEST MATCHING"
        title={
          open
            ? 'A little competition. A better fit.'
            : request.status === 'ready'
              ? 'Your environment is ready.'
              : request.status === 'provisioning'
                ? 'A match made. Getting you ready.'
                : request.status === 'no_offers'
                  ? 'No match this time.'
                  : request.status === 'cancelled'
                    ? 'This auction was cancelled.'
                    : 'Provisioning couldn’t finish.'
        }
        description={
          open
            ? 'Providers are reviewing your request. The lowest eligible total price wins automatically.'
            : ended
              ? 'Review your requirements and start another auction when you’re ready.'
              : 'Your specification and winning quote are locked in.'
        }
      >
        <StatusPill status={request.status} />
      </PageHeader>
      <Steps active={2} />
      <ErrorBox error={error || actionError} retry={error ? reload : undefined} />
      <div className="auction-grid">
        <div>
          <section className={`card auction-card ${open ? 'is-live' : ''}`}>
            <div className="auction-top">
              <div className="auction-live-label">
                <Radio size={17} />
                {open ? 'LIVE AUCTION' : 'AUCTION RESULT'}
              </div>
              <span className="small-muted">Request {request.id.slice(0, 8)}</span>
            </div>
            {open ? (
              <>
                <div className="auction-countdown">
                  <span>{seconds.toString().padStart(2, '0')}</span>
                  <div>
                    <strong>{seconds === 0 ? 'Selecting your match' : 'seconds remaining'}</strong>
                    <p>
                      {seconds === 0
                        ? 'The auction is closing. No further bids will be accepted.'
                        : 'The winning bid will be selected automatically.'}
                    </p>
                  </div>
                </div>
                <div className="auction-progress">
                  <span style={{ width: `${Math.min(100, ((30 - seconds) / 30) * 100)}%` }} />
                </div>
              </>
            ) : (
              <div className="auction-outcome">
                <span className={`icon-tile ${ended ? 'neutral' : 'emerald'}`}>
                  {ended ? <X size={24} /> : <Check size={24} />}
                </span>
                <div>
                  <h2>
                    {request.status === 'ready'
                      ? 'Ready to make it yours'
                      : request.status === 'provisioning'
                        ? 'Your winning offer is being provisioned'
                        : request.status === 'no_offers'
                          ? 'No eligible bids were received'
                          : request.status === 'cancelled'
                            ? 'No environment was provisioned'
                            : 'Your environment did not become ready'}
                  </h2>
                  <p>
                    {ended
                      ? 'No charge for this attempt.'
                      : request.status === 'provisioning'
                        ? 'Setup is included in your rental time. We’ll keep you updated.'
                        : 'A fixed demo invoice is recorded when readiness is confirmed.'}
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
            {sorted.length ? (
              <div className="bid-list">
                {sorted.map((bid, index) => (
                  <div
                    className={`bid-row ${bid.id === request.winningBidId ? 'winning' : ''}`}
                    key={bid.id}
                  >
                    <div className={`provider-avatar provider-${index % 3}`}>
                      {(bid.providerName || 'P').replace('Demo ', '').slice(-1)}
                    </div>
                    <div className="bid-provider">
                      <strong>{bid.providerName || 'Provider'}</strong>
                      <span>
                        {bid.id === request.winningBidId
                          ? 'Winning offer'
                          : index === 0 && open
                            ? 'Lowest eligible offer'
                            : bid.status === 'lost'
                              ? 'Capacity released'
                              : 'Simulated demo supply'}
                      </span>
                    </div>
                    <div className="bid-price">
                      <strong>{money(bid.totalPriceCents)}</strong>
                      <span>
                        {bid.id === request.winningBidId ? (
                          <CheckCircle2 size={15} />
                        ) : index === 0 && open ? (
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
                    ? 'Available providers can submit a price during this 30-second window.'
                    : 'You can adjust your request and try another auction.'}
                </p>
              </div>
            )}
            <div className="auction-footnote">
              <ShieldCheck size={15} />
              Prices are fixed for the full rental. Ties are resolved by accepted time, then bid ID.
            </div>
          </section>
          {vm && (
            <div className="card auction-vm">
              <span className="icon-tile emerald">
                <Server size={21} />
              </span>
              <div>
                <h3>{vm.catalogName || 'Your environment'}</h3>
                <p>
                  {vm.status === 'running'
                    ? 'Your browser terminal is available.'
                    : 'Follow setup and exact expiry on your environment page.'}
                </p>
              </div>
              <Link href={`/vms/${vm.id}`} className="button primary">
                Open environment
                <ArrowRight size={16} />
              </Link>
            </div>
          )}
          {ended && (
            <div className="auction-retry">
              <button
                className="button primary"
                onClick={() => void action('retry')}
                disabled={!!busy}
              >
                {busy === 'retry' ? (
                  <Spinner label="Starting auction" />
                ) : (
                  <>
                    <RefreshCw size={16} />
                    Try a new auction
                  </>
                )}
              </button>
              <Link href="/new" className="button secondary">
                Change requirements
              </Link>
              {request.status === 'no_offers' && (
                <Link href={`/alternatives/from/${request.id}`} className="button secondary">
                  Review flexible alternatives
                  <ArrowRight size={16} />
                </Link>
              )}
            </div>
          )}
        </div>
        <aside>
          <section className="card request-summary">
            <h2>Your request</h2>
            <p className="request-description">{request.description}</p>
            <DetailRow label="Resources">
              {request.requirements.cpu} vCPU · {request.requirements.memoryGb} GiB
            </DetailRow>
            <DetailRow label="Region">{request.region}</DetailRow>
            <DetailRow label="Rental">{request.durationMinutes} minutes</DetailRow>
            <DetailRow label="Maximum total">{money(request.maxPriceCents)}</DetailRow>
            <DetailRow label="Auction closes">{dateTime(request.closesAt)}</DetailRow>
            <div className="immutable-note">
              <LockKeyhole size={14} />
              This specification is now fixed.
            </div>
            {open && (
              <button
                className="button secondary full-width"
                onClick={() => void action('cancel')}
                disabled={!!busy}
              >
                {busy === 'cancel' ? <Spinner label="Cancelling" /> : 'Cancel auction'}
              </button>
            )}
          </section>
          <div className="info-note">
            <Clock3 size={17} />
            <p>
              Your rental clock starts when Wick admits provisioning, including setup. Expiry is
              never reset by a retry or terminal reconnect.
            </p>
          </div>
        </aside>
      </div>
    </>
  );
}

export function MyVMs() {
  const vms = usePagedResource<VM>('/api/vms', 5000),
    requests = usePagedResource<EnvironmentRequest>('/api/requests', 5000),
    now = useNow();
  const [tab, setTab] = useState<'all' | 'active' | 'past'>('all');
  const all = vms.data?.items || [],
    active = all.filter((vm) => ['running', 'provisioning', 'terminating'].includes(vm.status)),
    shown = all.filter(
      (vm) => tab === 'all' || (tab === 'active' ? active.includes(vm) : !active.includes(vm)),
    );
  const pending = (requests.data?.items || []).filter((request) =>
    ['open', 'no_offers', 'failed'].includes(request.status),
  );
  return (
    <>
      <PageHeader
        eyebrow="YOUR WORKSPACE"
        title="Room to make things happen."
        description="Keep an eye on your environments, from first boot to final minute."
      >
        <Link href="/new" className="button primary">
          <Plus size={16} />
          New environment
        </Link>
      </PageHeader>
      <div className="stats-grid">
        <StatCard
          label="Active environments loaded"
          value={active.length}
          note="Default limit: 2 actual customer VMs"
          icon={<Server size={18} />}
        />
        <StatCard
          label="Running VMs loaded"
          value={all.filter((vm) => vm.status === 'running').length}
          note="Terminal capability confirmed"
          icon={<SquareTerminal size={18} />}
        />
        <StatCard
          label="Live auctions loaded"
          value={(requests.data?.items || []).filter((r) => r.status === 'open').length}
          note="30-second automatic matching"
          icon={<Radio size={18} />}
        />
      </div>
      <ErrorBox
        error={vms.error || requests.error}
        retry={() => {
          vms.reload();
          requests.reload();
        }}
      />
      {(pending.length > 0 || requests.nextCursor) && (
        <section className="card pending-requests">
          <div className="section-heading">
            <h2>Recent requests</h2>
            <span>{pending.length} to review</span>
          </div>
          {pending.map((request) => (
            <Link className="pending-request" href={`/requests/${request.id}`} key={request.id}>
              <span className="icon-tile small neutral">
                <Radio size={16} />
              </span>
              <div>
                <strong>{request.description || 'Environment request'}</strong>
                <span>
                  {request.durationMinutes} min · up to {money(request.maxPriceCents)}
                </span>
              </div>
              <StatusPill status={request.status} />
              <ArrowRight size={16} />
            </Link>
          ))}
          <LoadMore
            available={!!requests.nextCursor}
            loading={requests.loadingMore}
            onLoad={() => void requests.loadMore()}
            error={requests.moreError}
          />
        </section>
      )}
      <section className="card environments-card">
        <div className="section-heading">
          <h2>My environments</h2>
          <div className="segmented-control" aria-label="Filter environments">
            {(['all', 'active', 'past'] as const).map((value) => (
              <button
                className={tab === value ? 'selected' : ''}
                onClick={() => setTab(value)}
                key={value}
              >
                {value === 'all' ? 'All' : value === 'active' ? 'Active' : 'Past'}
              </button>
            ))}
          </div>
        </div>
        {vms.loading ? (
          <Spinner label="Loading your environments" />
        ) : shown.length ? (
          <div className="vm-grid">
            {shown.map((vm) => (
              <Link href={`/vms/${vm.id}`} key={vm.id} className="vm-card">
                <div className="vm-card-top">
                  <span className="icon-tile neutral">
                    <Server size={21} />
                  </span>
                  <StatusPill status={vm.status} />
                </div>
                <h3>{vm.catalogName || 'Environment'}</h3>
                <span className="small-muted">{rentalSourceLabel(vm.sourceMode)}</span>
                <span className="small-muted vm-card-id">{vm.id.slice(0, 8)}</span>
                <div className="vm-card-spec">
                  <span>
                    <Globe2 size={14} />
                    {vm.region}
                  </span>
                  <span>
                    <Clock3 size={14} />
                    {vm.durationMinutes} min
                  </span>
                </div>
                <div className="vm-card-bottom">
                  <div>
                    <span>
                      {['running', 'provisioning'].includes(vm.status)
                        ? 'Time remaining'
                        : 'Fixed rental price'}
                    </span>
                    <strong>
                      {['running', 'provisioning'].includes(vm.status)
                        ? remaining(vm.expiresAt, now)
                        : money(vm.priceCents)}
                    </strong>
                  </div>
                  <span className="vm-open">
                    <ArrowRight size={18} />
                  </span>
                </div>
              </Link>
            ))}
          </div>
        ) : (
          <EmptyState
            icon={<Server size={27} />}
            title={tab === 'past' ? 'No past environments yet' : 'A fresh workspace, ready for you'}
            description={
              tab === 'past'
                ? 'Completed rentals will appear here.'
                : 'Describe your next environment and let providers find you a match.'
            }
          >
            <Link href="/new" className="button primary">
              <Plus size={16} />
              New environment
            </Link>
          </EmptyState>
        )}
        <LoadMore
          available={!!vms.nextCursor}
          loading={vms.loadingMore}
          onLoad={() => void vms.loadMore()}
          error={vms.moreError}
        />
      </section>
    </>
  );
}

export function VMDetail({ id }: { id: string }) {
  const {
      data: vm,
      error,
      loading,
      reload,
    } = useResource<VM>(`/api/vms/${encodeURIComponent(id)}`, 3000),
    now = useNow();
  const [confirm, setConfirm] = useState(false),
    [busy, setBusy] = useState(false),
    [actionError, setActionError] = useState('');
  async function terminate() {
    setBusy(true);
    setActionError('');
    try {
      await post(`/api/vms/${id}/terminate`);
      setConfirm(false);
      reload();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Unable to request termination.');
    } finally {
      setBusy(false);
    }
  }
  if (loading) return <Spinner label="Loading environment" />;
  if (!vm) return <ErrorBox error={error || 'Environment unavailable.'} retry={reload} />;
  const active = vm.status === 'running' || vm.status === 'provisioning',
    isExpired = !!vm.expiresAt && new Date(vm.expiresAt).getTime() <= now;
  return (
    <>
      <Link href="/vms" className="back-link">
        <ChevronLeft size={16} />
        My VMs
      </Link>
      <PageHeader
        eyebrow={`ENVIRONMENT ${vm.id.slice(0, 8)}`}
        title={vm.catalogName || 'Your environment'}
        description={`${vm.region} · ${vm.durationMinutes}-minute rental · Private visibility`}
      >
        <StatusPill status={vm.status} />
        {active && (
          <button className="button secondary danger-text" onClick={() => setConfirm(true)}>
            Terminate environment
          </button>
        )}
      </PageHeader>
      <ErrorBox error={error || actionError} retry={error ? reload : undefined} />
      {confirm && (
        <div className="terminate-confirm" role="alert">
          <div>
            <strong>Terminate this environment?</strong>
            <p>
              Your terminal will disconnect immediately.{' '}
              {vm.readyAt
                ? 'The full fixed rental charge still applies.'
                : 'There is no charge if the environment never became ready.'}{' '}
              Capacity is released after Wick confirms cleanup.
            </p>
          </div>
          <button className="button secondary" onClick={() => setConfirm(false)} disabled={busy}>
            Keep environment
          </button>
          <button className="button danger" onClick={() => void terminate()} disabled={busy}>
            {busy ? <Spinner label="Terminating" /> : 'Confirm termination'}
          </button>
        </div>
      )}
      <div className="stats-grid vm-detail-stats">
        <StatCard
          label="Time remaining"
          value={active ? remaining(vm.expiresAt, now) : '—'}
          note="Clock starts at provisioning admission"
          icon={<Timer size={18} />}
        />
        <StatCard
          label="Exact expiry"
          value={<span className="date-value">{dateTime(vm.expiresAt)}</span>}
          note="Setup included · reconnects do not reset expiry"
          icon={<Clock3 size={18} />}
        />
        <StatCard
          label="Fixed rental price"
          value={money(vm.priceCents)}
          note={
            vm.readyAt
              ? 'Ready confirmed · No payment due'
              : 'Only charged after confirmed readiness'
          }
          icon={<CircleDollarSign size={18} />}
        />
      </div>
      {vm.failureReason && <ErrorBox error={vm.failureReason} />}
      <Suspense
        fallback={
          <div className="card">
            <Spinner label="Loading terminal" />
          </div>
        }
      >
        <TerminalPanel
          vmId={vm.id}
          enabled={vm.status === 'running' && !isExpired}
          status={vm.status}
          mode={vm.sourceMode ?? 'fixture'}
        />
      </Suspense>
      <div className="vm-detail-bottom">
        <section className="card">
          <h2>Rental details</h2>
          <DetailRow label="Environment source">{rentalSourceLabel(vm.sourceMode)}</DetailRow>
          <DetailRow label="Created">{dateTime(vm.createdAt)}</DetailRow>
          <DetailRow label="Ready confirmed">
            {vm.readyAt ? dateTime(vm.readyAt) : 'Not yet confirmed'}
          </DetailRow>
          <DetailRow label="Visibility">
            <span className="inline-icon">
              <LockKeyhole size={13} />
              Private
            </span>
          </DetailRow>
          <DetailRow label="Rental price">{money(vm.priceCents)} USD · fixed total</DetailRow>
          <DetailRow label="Added buyer fee">$0.00</DetailRow>
          {vm.pricing && (
            <>
              <DetailRow label="Wick compute estimate">
                {moneyMicros(vm.pricing.upstreamEstimatedComputeMicros)} USD for the full term
              </DetailRow>
              <p className="field-hint">
                The estimate uses the frozen published rate and is not settled usage. Your rental
                price is the accepted provider bid.
                {vm.pricing.model === 'wick-managed-rate-v1' && vm.pricing.markupBps !== undefined
                  ? ` This historical quote used a ${vm.pricing.markupBps / 100}% target markup; its accepted price is unchanged.`
                  : ' The provider pays Broker’s 15% commission from that total. No Broker fee is added for you.'}{' '}
                No payment due.
              </p>
            </>
          )}
          <div className="card-footer-link">
            <ArrowLink to={`/requests/${vm.requestId}`}>View auction & winning offer</ArrowLink>
          </div>
        </section>
        <section className="card rental-guide">
          <h2>Your terminal, your commands.</h2>
          <div>
            <span className="icon-tile small neutral">
              <SquareTerminal size={16} />
            </span>
            <p>Wick Broker connects you to the environment. You choose what to run.</p>
          </div>
          <div>
            <span className="icon-tile small neutral">
              <RefreshCw size={16} />
            </span>
            <p>
              Disconnecting leaves the rental running. Reconnect attaches to this same VM; process
              survival is not guaranteed.
            </p>
          </div>
          <div>
            <span className="icon-tile small neutral">
              <ShieldCheck size={16} />
            </span>
            <p>
              Terminal contents are not retained or sent to Muse. Only connection metadata is
              audited.
            </p>
          </div>
          {vm.cleanupPending && (
            <div className="info-note">
              <Clock3 size={16} />
              <p>
                Wick cleanup is pending. Provider capacity remains reserved until cleanup is
                confirmed.
              </p>
            </div>
          )}
        </section>
      </div>
    </>
  );
}

export function Invoices() {
  const { data, error, loading, reload, nextCursor, loadingMore, loadMore, moreError } =
    usePagedResource<Invoice>('/api/invoices');
  const items = data?.items || [];
  const amount = (invoice: Invoice) =>
    invoice.amountCents ?? invoice.totalPriceCents ?? invoice.totalCents ?? invoice.priceCents ?? 0;
  function download() {
    const content = [
      'Invoice,Environment,Date,Total USD,Payment status',
      ...items.map((invoice) =>
        [
          invoice.number || invoice.id,
          invoice.vmId,
          new Date(invoice.createdAt).toISOString(),
          (amount(invoice) / 100).toFixed(2),
          'No payment due',
        ]
          .map((field) => `"${String(field).replaceAll('"', '""')}"`)
          .join(','),
      ),
    ].join('\n');
    const url = URL.createObjectURL(new Blob([content], { type: 'text/csv;charset=utf-8' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = 'wick-demo-invoices.csv';
    a.click();
    URL.revokeObjectURL(url);
  }
  return (
    <>
      <PageHeader
        eyebrow="CLEAR FROM THE START"
        title="Every rental, accounted for."
        description="One fixed demo invoice when your environment is confirmed ready."
      >
        {items.length > 0 && (
          <button className="button secondary" onClick={download}>
            <ArrowDownToLine size={16} />
            Export loaded invoices
          </button>
        )}
      </PageHeader>
      <div className="invoice-banner">
        <span className="icon-tile emerald">
          <ReceiptText size={23} />
        </span>
        <div>
          <h3>These are demo invoices. No payment due.</h3>
          <p>
            Customer fixed quotes are separate from Wick’s actual internal usage. Full-term compute
            estimates are not settled usage. Broker’s 15% commission comes from provider revenue,
            not an added buyer fee. No payments or payouts are collected.
          </p>
        </div>
        <span className="quiet-badge">Added buyer fee: $0.00</span>
      </div>
      <div className="stats-grid">
        <StatCard
          label="Loaded demo charges"
          value={money(items.reduce((total, invoice) => total + amount(invoice), 0))}
          note="Fixed rental totals in USD"
          icon={<CircleDollarSign size={18} />}
        />
        <StatCard
          label="Loaded invoices"
          value={items.length}
          note="Exactly one invoice per ready environment"
          icon={<CheckCircle2 size={18} />}
        />
        <StatCard
          label="Payment due"
          value="$0.00"
          note="Demo only · no payment collection"
          icon={<ShieldCheck size={18} />}
        />
      </div>
      <ErrorBox error={error} retry={reload} />
      <section className="card">
        <div className="section-heading">
          <h2>Rental invoices</h2>
          <span>
            {items.length} loaded{nextCursor ? ' · more available' : ''}
          </span>
        </div>
        {loading ? (
          <Spinner label="Loading invoices" />
        ) : items.length ? (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Invoice</th>
                  <th>Environment</th>
                  <th>Created</th>
                  <th>Fixed total</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {items.map((invoice) => (
                  <tr key={invoice.id}>
                    <td>
                      <span className="inline-icon">
                        <FileText size={16} />
                        <strong>{invoice.number || invoice.id.slice(0, 8)}</strong>
                      </span>
                    </td>
                    <td>
                      <Link className="text-link" href={`/vms/${invoice.vmId}`}>
                        {invoice.catalogName || invoice.vmId.slice(0, 8)}
                      </Link>
                    </td>
                    <td>{shortDate(invoice.createdAt)}</td>
                    <td className="money-cell">{money(amount(invoice))}</td>
                    <td>
                      <span className="quiet-badge">No payment due</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <EmptyState
            icon={<ReceiptText size={27} />}
            title="Nothing to account for yet"
            description="An invoice appears only after Wick confirms your environment is running and terminal access is available."
          />
        )}
        <LoadMore
          available={!!nextCursor}
          loading={loadingMore}
          onLoad={() => void loadMore()}
          error={moreError}
        />
      </section>
      <div className="info-note">
        <ShieldCheck size={17} />
        <p>
          Failed, cancelled, and expired-before-ready attempts have no charge. Termination after
          readiness keeps the full fixed rental charge.
        </p>
      </div>
    </>
  );
}
