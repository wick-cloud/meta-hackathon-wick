import {
  TableViewport,
  TablePanel,
  TableTabs,
  TableFooter,
  TableIdentity,
  TableState,
  TableStatus,
} from './table';
import { lazy, Suspense, useEffect, useState } from 'react';
import { parseExplicitBuyerDescription } from '../shared/muse-contracts';
import { addCents, isMoneyCents, MIN_ORDER_PRICE_CENTS } from '../shared/money';
import { seedAlternativeDraft } from './negotiation';
import { AgreementCharges } from './agreement-charges';
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
  HardDrive,
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
  DEFAULT_PRICE_CENTS,
  museLabel,
  cloudRouteName,
  regionName,
  dateTime,
  loadDraft,
  money,
  moneyMicros,
  post,
  rentalSourceLabel,
  saveDraft,
  shortDate,
  type Bid,
  type EnvironmentRequest,
  type Invoice,
  type Proposal,
  type VM,
} from './api';
import {
  AuctionCountdown,
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
import { DiskPicker, useDiskOptions } from './disks';
import {
  FormPage,
  FormLayout,
  FormPanel,
  FormSection,
  FormSummary,
  FormSummaryRows,
  FormTotal,
  FormNotice,
  FormActions,
  FormDisclosure,
} from './form-layout';
import './compute-layout.css';

export function NewEnvironment() {
  const { catalog, modes, user } = useSession(),
    navigate = useNavigate();
  const params = new URLSearchParams(window.location.search),
    copyId = params.get('copy'),
    linkedDiskId = params.get('diskId') || undefined,
    diskOptions = useDiskOptions();
  const [description, setDescription] = useState(loadDraft()?.description || ''),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [budget, setBudget] = useState(loadDraft()?.maxPriceCents ?? DEFAULT_PRICE_CENTS),
    [budgetEdited, setBudgetEdited] = useState(false),
    [copying, setCopying] = useState(!!copyId);
  useEffect(() => {
    if (!copyId) return;
    const controller = new AbortController();
    let cancelled = false;
    setCopying(true);
    setError('');
    void api<{ request: EnvironmentRequest }>(`/api/requests/${encodeURIComponent(copyId)}`, {
      signal: controller.signal,
    })
      .then(({ request }) => {
        if (cancelled) return;
        saveDraft({
          description: request.description,
          ...(request.diskId ? { diskId: request.diskId } : {}),
          catalogId: request.catalogId,
          region: request.region,
          matchAcrossProviders: request.matchAcrossProviders,
          durationMinutes: request.durationMinutes,
          maxPriceCents: request.maxPriceCents,
          requirements: request.requirements,
        });
        navigate('/requests/review');
      })
      .catch((err: unknown) => {
        if (!cancelled)
          setError(err instanceof Error ? err.message : 'Unable to copy this request.');
      })
      .finally(() => {
        if (!cancelled) setCopying(false);
      });
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [copyId]);
  const approved = catalog.filter(
      (item) =>
        item.approved &&
        (!linkedDiskId ||
          (diskOptions.data?.enabled && diskOptions.data.eligibleCatalogIds.includes(item.id))),
    ),
    first = approved.find((item) => item.profile === 'small') ?? approved[0];
  const configurationError = linkedDiskId
    ? diskOptions.error ||
      (!diskOptions.data?.enabled
        ? 'Disk support is currently unavailable. Return to Disks to review this disk or try again.'
        : 'No approved configuration can mount this disk. Review the available disk-compatible configurations before continuing.')
    : 'No approved configurations are available. Your administrator can approve a catalog configuration.';
  const pending = copying
    ? 'Loading original request for a new review'
    : linkedDiskId && diskOptions.loading && !diskOptions.data
      ? 'Checking disk-compatible configurations'
      : '';
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
    if (!isMoneyCents(budget) || budget < MIN_ORDER_PRICE_CENTS) {
      setError('Enter a maximum total of at least $0.01.');
      return;
    }
    if (!first) {
      setError(configurationError);
      return;
    }
    const reviewed = loadDraft();
    if (reviewed) {
      saveDraft({
        description: description.trim(),
        ...(linkedDiskId || reviewed.diskId ? { diskId: linkedDiskId || reviewed.diskId } : {}),
        catalogId: reviewed.catalogId,
        region: 'any',
        matchAcrossProviders: true,
        durationMinutes: reviewed.durationMinutes,
        maxPriceCents: budget,
        requirements: reviewed.requirements,
      });
      navigate('/requests/review');
      return;
    }
    const explicit = parseExplicitBuyerDescription(description);
    saveDraft({
      description: description.trim(),
      ...(linkedDiskId ? { diskId: linkedDiskId } : {}),
      catalogId: first.id,
      region: 'any',
      matchAcrossProviders: true,
      durationMinutes:
        explicit.durationMinutes ??
        (first.durationMinutes.includes(30) ? 30 : first.durationMinutes[0]!),
      maxPriceCents: budget,
      requirements: {
        cpu: explicit.requirements.cpu ?? first.cpu,
        memoryGb: explicit.requirements.memoryGb ?? first.memoryGb,
        ...(explicit.requirements.gpu ? { gpu: explicit.requirements.gpu } : {}),
      },
    });
    navigate('/requests/review');
  }
  async function translate() {
    if (!first) {
      setError(configurationError);
      return;
    }
    if (!isMoneyCents(budget) || budget < MIN_ORDER_PRICE_CENTS) {
      setError('Enter a maximum total of at least $0.01.');
      return;
    }
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
        ...(linkedDiskId ? { diskId: linkedDiskId } : {}),
        region: 'any',
        matchAcrossProviders: true,
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
    <FormPage
      className="describe-page"
      eyebrow="AUCTION REQUEST"
      title="Launch a VM"
      description="Describe what you need. Review the details before providers start bidding."
      back={{ href: '/new', label: 'All purchase options' }}
      step="Step 1 of 3"
    >
      <FormLayout
        aside={
          <FormSummary
            title="Before you launch"
            description="Compatible providers compete for your requirements."
          >
            <FormSummaryRows
              items={[
                { label: 'Auction window', value: '30 seconds' },
                { label: 'Buyer fee', value: '$0' },
                ...(linkedDiskId ? [{ label: 'Workspace', value: 'Persistent disk' }] : []),
              ]}
            />
            <FormTotal label="Maximum total" value={money(budget)} note="USD · entire rental" />
            <ErrorBox
              error={error || (!pending && !first ? configurationError : '')}
              retry={linkedDiskId && diskOptions.error ? diskOptions.reload : undefined}
            />
            <FormActions className="describe-actions">
              <button
                type="button"
                className="button primary full-width"
                onClick={() => void translate()}
                disabled={busy || !first || !!pending}
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
              <button
                type="button"
                className="button secondary full-width"
                onClick={manual}
                disabled={busy || !first || !!pending}
              >
                Review manually
              </button>
            </FormActions>
            <FormNotice icon={<ShieldCheck size={16} />}>
              <p>
                <strong>You review before anything launches.</strong> Preparing a draft starts no
                auction and reserves no VM.
              </p>
            </FormNotice>
            <span className="quiet-badge">
              {modes.muse === 'fixture' ? 'Fixture mode · no model call' : museLabel}
            </span>
          </FormSummary>
        }
      >
        {pending ? (
          <FormPanel>
            <FormSection>
              <Spinner label={pending} />
            </FormSection>
          </FormPanel>
        ) : (
          <>
            <FormPanel aria-label="Environment description">
              <FormSection
                title="Environment requirements"
                description="Tell us the CPU, memory, and rental time you need."
              >
                <label className="field" htmlFor="environment-description">
                  <span>Describe your environment</span>
                  <textarea
                    id="environment-description"
                    aria-label="Describe your environment"
                    maxLength={4000}
                    rows={4}
                    placeholder="A Linux workspace with 2 vCPUs and 4 GiB of memory for 30 minutes…"
                    value={description}
                    onChange={(e) => changeDescription(e.target.value)}
                    disabled={busy}
                  />
                </label>
                <div className="describe-examples" aria-label="Example requirements">
                  <span>Try a starting point</span>
                  <div>
                    {[
                      [
                        'A lightweight Linux workspace',
                        'A lightweight Linux environment with 2 vCPUs and 4 GB memory for 30 minutes.',
                      ],
                      [
                        'A memory-rich environment',
                        'A Linux environment with at least 8 GB memory for a 30-minute session.',
                      ],
                      [
                        'A short compute session',
                        'A Linux environment with 4 vCPUs for a 15-minute session.',
                      ],
                    ].map(([label, value]) => (
                      <button
                        key={label}
                        type="button"
                        disabled={busy}
                        onClick={() => changeDescription(value!)}
                      >
                        {label}
                        <ArrowRight size={12} />
                      </button>
                    ))}
                  </div>
                </div>
              </FormSection>
              <FormSection
                className="form-budget"
                title="Your budget"
                description="Your ceiling for the entire rental. You can edit it during review."
              >
                <MoneyInput
                  id="initial-budget"
                  label="Your maximum total (USD)"
                  value={budget}
                  min={1}
                  disabled={busy}
                  onChange={(value) => {
                    setBudget(value);
                    setBudgetEdited(true);
                  }}
                />
                <p className="field-hint">
                  A budget in your description fills this in. Your edits take precedence.
                </p>
              </FormSection>
            </FormPanel>
            <button
              type="button"
              className="form-text-action"
              onClick={alternatives}
              disabled={busy}
            >
              Review unsupported needs and alternatives
              <ArrowRight size={14} />
            </button>
            <FormNotice icon={<LockKeyhole size={14} />}>
              <p>
                Only your environment requirements go to Muse. Never credentials or terminal
                contents.
              </p>
            </FormNotice>
          </>
        )}
      </FormLayout>
    </FormPage>
  );
}

export { RequestReview } from './auction-review';

export function AuctionPage({ id }: { id: string }) {
  const [poll, setPoll] = useState(2000);
  const { data, error, loading, reload } = useResource<{
      request: EnvironmentRequest;
      bids: Bid[];
      vm?: VM | null;
    }>(`/api/requests/${encodeURIComponent(id)}`, poll),
    now = useNow();
  const [busy, setBusy] = useState(''),
    [actionError, setActionError] = useState('');
  useEffect(() => {
    const settled = data?.vm
      ? !!data.vm.cleanupConfirmedAt && !data.vm.cleanupPending
      : !!data && ['no_offers', 'failed', 'cancelled'].includes(data.request.status);
    setPoll(settled ? 0 : 2000);
  }, [data]);
  async function action(kind: 'cancel') {
    setBusy(kind);
    setActionError('');
    try {
      await post<EnvironmentRequest>(`/api/requests/${id}/${kind}`);
      reload();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Request action failed.');
    } finally {
      setBusy('');
    }
  }
  if (loading || !data)
    return (
      <div className="form-page compute-page">
        <PageHeader
          eyebrow="AUCTION REQUEST"
          title="Your auction"
          description="Review provider offers and your rental status."
        />
        <FormPanel className="compute-loading">
          {loading ? (
            <Spinner label="Loading your auction" />
          ) : (
            <ErrorBox error={error || 'Request unavailable.'} retry={reload} />
          )}
        </FormPanel>
      </div>
    );
  const { request, bids, vm } = data;
  const open = request.status === 'open';
  const sorted = [...bids].sort(
    (a, b) =>
      a.totalPriceCents - b.totalPriceCents ||
      a.createdAt.localeCompare(b.createdAt) ||
      a.id.localeCompare(b.id),
  );
  const ended = ['no_offers', 'failed', 'cancelled'].includes(request.status);
  const rentalEnded =
    !!vm &&
    (!!vm.cleanupConfirmedAt ||
      ['terminating', 'terminated', 'expired', 'failed'].includes(vm.status) ||
      (!!vm.expiresAt && Date.parse(vm.expiresAt) <= now));
  const awaitingCleanup = rentalEnded && (!vm?.cleanupConfirmedAt || vm.cleanupPending);
  const completedRental = request.status === 'ready' && rentalEnded;
  return (
    <div className="form-page compute-page">
      <Link href="/orders" className="back-link">
        <ChevronLeft size={16} />
        All orders
      </Link>
      <PageHeader
        eyebrow="AUCTION REQUEST"
        title={
          open
            ? 'Live auction'
            : request.status === 'ready'
              ? completedRental
                ? awaitingCleanup
                  ? 'Environment ending'
                  : 'Rental completed'
                : 'Environment ready'
              : request.status === 'provisioning'
                ? 'Provisioning environment'
                : request.status === 'no_offers'
                  ? 'No offers received'
                  : request.status === 'cancelled'
                    ? 'Auction cancelled'
                    : 'Environment failed to start'
        }
        description={
          open
            ? 'Providers are reviewing your request. The lowest eligible total price wins automatically.'
            : ended
              ? 'Review your requirements and start another auction when you’re ready.'
              : 'Your specification and winning quote are locked in.'
        }
      >
        <span className="form-step" aria-current="step">
          Step 3 of 3
        </span>
        <StatusPill
          status={completedRental ? (awaitingCleanup ? 'ending' : 'completed') : request.status}
        />
      </PageHeader>
      <ErrorBox error={error || actionError} retry={error ? reload : undefined} />
      <div className="form-layout compute-auction-layout">
        <div>
          <FormPanel className={`auction-card ${open ? 'is-live' : ''}`}>
            <div className="auction-top">
              <div className="auction-live-label">
                <Radio size={17} />
                {open ? 'LIVE AUCTION' : 'AUCTION RESULT'}
              </div>
              <span className="small-muted">Request {request.id.slice(0, 8)}</span>
            </div>
            {open ? (
              <AuctionCountdown closesAt={request.closesAt} now={now} />
            ) : (
              <div className="auction-outcome">
                <span className={`icon-tile ${ended ? 'neutral' : 'emerald'}`}>
                  {ended ? <X size={24} /> : <Check size={24} />}
                </span>
                <div>
                  <h2>
                    {request.status === 'ready'
                      ? completedRental
                        ? awaitingCleanup
                          ? 'Rental ended · cleanup pending'
                          : 'Your rental is complete'
                        : 'Ready to make it yours'
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
                      : completedRental
                        ? awaitingCleanup
                          ? 'Terminal access has ended. Provider capacity remains reserved until cleanup is confirmed.'
                          : 'The winning offer and fixed rental price remain available below.'
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
                              : bid.simulated
                                ? 'Simulated demo supply'
                                : 'Wick-managed allocation'}
                      </span>
                      {bid.catalogName && (
                        <span>
                          {bid.catalogName} · {regionName(bid.region ?? '')}
                        </span>
                      )}
                      {bid.cloudProvider === 'provider-blaxel' && (
                        <span>Underlying Wick route: {cloudRouteName(bid.cloudProvider)}</span>
                      )}
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
          </FormPanel>
          {vm && (
            <div className="card auction-vm">
              <span className="icon-tile emerald">
                <Server size={21} />
              </span>
              <div>
                <h3>{vm.catalogName || 'Your environment'}</h3>
                <p>
                  {rentalEnded
                    ? awaitingCleanup
                      ? 'Terminal access has ended. Follow cleanup on your environment page.'
                      : 'Review the completed rental and its environment history.'
                    : vm.status === 'running'
                      ? 'Your browser terminal is available.'
                      : 'Follow setup and exact expiry on your environment page.'}
                </p>
              </div>
              <Link href={`/vms/${vm.id}`} className="button primary">
                {rentalEnded ? 'View environment history' : 'Open environment'}
                <ArrowRight size={16} />
              </Link>
            </div>
          )}
          {ended && (
            <div className="auction-retry">
              <Link className="button primary" href={`/new?copy=${encodeURIComponent(request.id)}`}>
                <RefreshCw size={16} />
                Try again · review first
              </Link>
              <Link href="/new/vm" className="button secondary">
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
          <FormSummary title="Your request" className="compute-request-summary">
            <p className="request-description">{request.description}</p>
            <FormSummaryRows
              items={[
                {
                  label: 'Resources',
                  value: `${request.requirements.cpu} vCPU · ${request.requirements.memoryGb} GiB`,
                },
                ...(request.requirements.gpu
                  ? [{ label: 'GPU', value: request.requirements.gpu }]
                  : []),
                { label: 'Region', value: regionName(request.region) },
                { label: 'Rental', value: `${request.durationMinutes} minutes` },
                { label: 'Auction closes', value: dateTime(request.closesAt) },
                ...(request.diskId
                  ? [
                      {
                        label: 'Persistent disk',
                        value: (
                          <Link href={'/disks/' + request.diskId}>
                            View disk <ArrowRight size={13} />
                          </Link>
                        ),
                      },
                    ]
                  : []),
              ]}
            />
            <FormTotal
              label="Maximum total"
              value={money(request.maxPriceCents)}
              note="USD · entire rental"
            />
            <FormNotice icon={<LockKeyhole size={15} />}>
              This specification is now fixed.
            </FormNotice>
            {open && (
              <button
                className="button secondary full-width"
                onClick={() => void action('cancel')}
                disabled={!!busy}
              >
                {busy === 'cancel' ? <Spinner label="Cancelling" /> : 'Cancel auction'}
              </button>
            )}
          </FormSummary>
          <FormNotice icon={<Clock3 size={17} />}>
            Your rental clock starts when Wick admits provisioning, including setup. Expiry is never
            reset by a retry or terminal reconnect.
          </FormNotice>
        </aside>
      </div>
    </div>
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
  if (loading || !vm)
    return (
      <div className="form-page compute-page">
        <PageHeader
          eyebrow="ENVIRONMENT"
          title="Your environment"
          description="Terminal access, rental details, and cleanup status."
        />
        <FormPanel className="compute-loading">
          {loading ? (
            <Spinner label="Loading environment" />
          ) : (
            <ErrorBox error={error || 'Environment unavailable.'} retry={reload} />
          )}
        </FormPanel>
      </div>
    );
  const active = vm.status === 'running' || vm.status === 'provisioning',
    isExpired = !!vm.expiresAt && new Date(vm.expiresAt).getTime() <= now,
    scheduled = vm.billingSource === 'scheduled_capacity',
    window = vm.scheduledWindow;
  return (
    <div className="form-page compute-page">
      <Link href="/vms" className="back-link">
        <ChevronLeft size={16} />
        My VMs
      </Link>
      <PageHeader
        eyebrow={`ENVIRONMENT ${vm.id.slice(0, 8)}`}
        title={vm.catalogName || 'Your environment'}
        description={`${vm.region} · ${scheduled ? 'Historical capacity booking' : `${vm.durationMinutes}-minute rental`} · Private visibility`}
      >
        <StatusPill status={vm.status} />
        {active && (
          <button className="button secondary danger-text" onClick={() => setConfirm(true)}>
            Terminate environment
          </button>
        )}
      </PageHeader>
      <ErrorBox error={error || actionError} retry={error ? reload : undefined} />
      {vm.diskId && (
        <div className="disk-workspace-detail">
          <HardDrive size={19} />
          <div>
            <Link href={'/disks/' + vm.diskId}>
              View persistent disk <ArrowRight size={13} />
            </Link>
            <small>Stopping this VM keeps the disk and other attached VMs available.</small>
          </div>
        </div>
      )}
      {confirm && (
        <div className="terminate-confirm" role="alert">
          <div>
            <strong>Terminate this environment?</strong>
            <p>
              Your terminal will disconnect immediately.{' '}
              {scheduled
                ? 'Your booked capacity remains payable; failed starts receive separate adjustments.'
                : vm.readyAt
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
      <FormPanel className="compute-strip" aria-label="Rental summary">
        <FormSummaryRows
          items={[
            {
              label: scheduled ? 'Time to hard end' : 'Time remaining',
              value: active ? remaining(vm.expiresAt, now) : '—',
            },
            {
              label: scheduled ? 'Immutable hard end' : 'Exact expiry',
              value: dateTime(vm.expiresAt),
            },
            {
              label: scheduled ? 'Booked slot-window total' : 'Fixed rental price',
              value: money(vm.priceCents),
            },
          ]}
        />
      </FormPanel>
      <FormNotice icon={<Clock3 size={16} />}>
        {scheduled
          ? 'Late starts do not extend the window. Save files before the hard end.'
          : 'Setup is included. Reconnecting does not reset expiry.'}
        <span className="compute-billing-note">
          {scheduled
            ? 'Part of your agreement · no additional VM charge'
            : vm.readyAt
              ? 'Ready confirmed · No payment due'
              : 'Only charged after confirmed readiness'}
        </span>
      </FormNotice>
      {vm.cleanupPending && (
        <FormNotice className="compute-warning" icon={<Clock3 size={16} />}>
          <span role="status">
            Wick cleanup is pending. Provider capacity remains reserved until cleanup is confirmed.
          </span>
        </FormNotice>
      )}
      {vm.failureReason && (!vm.cleanupConfirmedAt || !vm.readyAt) && (
        <ErrorBox error={vm.failureReason} />
      )}
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
      {scheduled && (
        <section className="card market-panel">
          <div className="section-heading">
            <h2>Historical booking · access deadlines</h2>
            {vm.agreementId && (
              <Link className="text-link" href={`/orders/${vm.agreementId}`}>
                View historical booking <ArrowRight size={14} />
              </Link>
            )}
          </div>
          {window && (
            <>
              <div className="market-clock-grid">
                <div>
                  <span>Window opens</span>
                  <strong>{dateTime(window.startsAt)}</strong>
                </div>
                <div>
                  <span>Discount ends</span>
                  <strong>{dateTime(window.discountEndsAt)}</strong>
                </div>
                <div>
                  <span>Hard VM end</span>
                  <strong>{dateTime(window.endsAt)}</strong>
                </div>
              </div>
              <DetailRow
                label={active && !isExpired ? 'Current matched rate' : 'Frozen discounted rate'}
              >
                {money(
                  active && !isExpired && now >= Date.parse(window.discountEndsAt)
                    ? window.normalRateCentsPerHour
                    : window.discountRateCentsPerHour,
                )}{' '}
                / VM-hour
              </DetailRow>
              <DetailRow label="Frozen normal rate">
                {money(window.normalRateCentsPerHour)} / VM-hour
              </DetailRow>
            </>
          )}
          <p className="field-hint">
            Your booked capacity is already part of the agreement. The discount boundary changes the
            billing segment on this same VM; the hard end terminates it. Booked idle capacity
            remains paid. Start a fresh VM in the next window; retained disk storage is not
            included.
          </p>
        </section>
      )}
      <div className="vm-detail-bottom">
        <FormDisclosure
          title="Rental details"
          icon={<ReceiptText size={16} />}
          className="compute-rental-details"
        >
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
          <DetailRow label={scheduled ? 'Booked slot-window total' : 'Rental price'}>
            {money(vm.priceCents)} USD ·{' '}
            {scheduled ? 'part of agreement commitment' : 'fixed total'}
          </DetailRow>
          <DetailRow label="Added buyer fee">$0.00</DetailRow>
          {!scheduled && vm.pricing && (
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
            {scheduled ? (
              vm.agreementId && (
                <ArrowLink to={`/orders/${vm.agreementId}`}>
                  View booking details &amp; billing
                </ArrowLink>
              )
            ) : (
              <ArrowLink to={`/requests/${vm.requestId}`}>View auction & winning offer</ArrowLink>
            )}
          </div>
        </FormDisclosure>
        <FormDisclosure
          title="Using your terminal"
          icon={<SquareTerminal size={16} />}
          className="rental-guide"
        >
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
        </FormDisclosure>
      </div>
    </div>
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
          (amount(invoice) / 100).toFixed(4),
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
    <div className="form-page compute-page">
      <PageHeader
        eyebrow="BUYER BILLING"
        title="Billing"
        description="Instant VM rental invoices, with no added buyer fee."
      >
        {items.length > 0 && (
          <button className="button secondary" onClick={download}>
            <ArrowDownToLine size={16} />
            Export loaded invoices
          </button>
        )}
      </PageHeader>
      <FormNotice className="compute-billing-notice" icon={<ReceiptText size={18} />}>
        <strong>These are demo invoices. No payment due.</strong> Broker’s 15% commission comes from
        provider revenue. No buyer fee, payments, or payouts are collected.
      </FormNotice>
      <FormPanel className="compute-strip" aria-label="Loaded invoice summary">
        <FormSummaryRows
          items={[
            {
              label: 'Loaded instant charges',
              value: data
                ? money(items.reduce((total, invoice) => addCents(total, amount(invoice)), 0))
                : '—',
            },
            { label: 'Loaded instant invoices', value: data ? items.length : '—' },
            { label: 'Payment due', value: '$0.00' },
          ]}
        />
        <p className="field-hint">
          Totals cover loaded invoices only. Exactly one invoice per ready environment.
        </p>
      </FormPanel>
      <ErrorBox error={data ? error : ''} retry={reload} />
      <TablePanel label="Instant rental invoices">
        <TableTabs
          actions={
            <span className="small-muted">{nextCursor ? 'More invoices available' : 'USD'}</span>
          }
        >
          <h2>Instant rental invoices</h2>
        </TableTabs>
        {loading ? (
          <TableState loading />
        ) : error && !data ? (
          <TableState error={error} onRetry={reload} />
        ) : items.length ? (
          <TableViewport label="Instant rental invoices" minWidth={760} className="table-scroll">
            <table>
              <caption className="sr-only">Instant rental invoices</caption>
              <thead>
                <tr>
                  <th scope="col">Invoice</th>
                  <th scope="col">Environment</th>
                  <th scope="col">Created</th>
                  <th className="numeric-cell" scope="col">
                    Fixed total
                  </th>
                  <th scope="col">Status</th>
                </tr>
              </thead>
              <tbody>
                {items.map((invoice) => (
                  <tr key={invoice.id}>
                    <td>
                      <TableIdentity
                        icon={<FileText size={16} />}
                        title={invoice.number || invoice.id.slice(0, 8)}
                        subtitle={invoice.id.slice(0, 8)}
                      />
                    </td>
                    <td>
                      <Link className="text-link" href={`/vms/${invoice.vmId}`}>
                        {invoice.catalogName || invoice.vmId.slice(0, 8)}
                      </Link>
                    </td>
                    <td>{shortDate(invoice.createdAt)}</td>
                    <td className="money-cell numeric-cell">{money(amount(invoice))}</td>
                    <td>
                      <TableStatus>No payment due</TableStatus>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableViewport>
        ) : (
          <TableState
            title="Nothing to account for yet"
            description="An invoice appears only after Wick confirms your environment is running and terminal access is available."
          />
        )}
        <TableFooter count={data ? items.length : undefined} noun="invoices">
          <LoadMore
            available={!!nextCursor}
            loading={loadingMore}
            onLoad={() => void loadMore()}
            error={moreError}
          />
        </TableFooter>
      </TablePanel>
      <FormDisclosure title="How rental invoices are calculated" icon={<ReceiptText size={16} />}>
        <p>
          Customer fixed quotes are separate from Wick’s actual internal usage. Full-term compute
          estimates are not settled usage. Rental prices are accepted provider bids; Broker’s 15%
          commission comes from provider revenue.
        </p>
      </FormDisclosure>
      <AgreementCharges />
      <div className="info-note">
        <ShieldCheck size={17} />
        <p>
          For instant rentals, failed, cancelled, and expired-before-ready attempts have no charge.
          Termination after readiness keeps the full fixed rental charge.
        </p>
      </div>
    </div>
  );
}
