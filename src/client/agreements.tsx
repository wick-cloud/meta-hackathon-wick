import { useRef, useState, type FormEvent } from 'react';
import {
  ArrowLeft,
  ArrowRight,
  CalendarClock,
  Check,
  Clock3,
  Layers3,
  Play,
  ShieldCheck,
  Sparkles,
  Wallet,
  X,
} from 'lucide-react';
import type {
  AgreementDetail as AgreementDetailDTO,
  AgreementDraftResult,
  AgreementInput,
  ActivateAgreementInput,
  ActivateAgreementResult,
  CreditHistory,
  CreditWallet,
} from '../shared/agreements';
import { api, dateTime, money, post } from './api';
import {
  DetailRow,
  EmptyState,
  ErrorBox,
  Link,
  LoadMore,
  MarketDialog,
  PageHeader,
  Spinner,
  StatCard,
  StatusPill,
  SuccessBox,
  remaining,
  useNavigate,
  useNow,
  usePagedResource,
  useResource,
  useSession,
} from './components';
import './market.css';

export const hourly = (cents: number) => `${money(cents)} / VM-hour`;
export const zonedTime = (date: string, timeZone: string) =>
  new Date(date).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZone,
    timeZoneName: 'short',
  });
const localDate = () => {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const minutes = (v: string) => {
  const [h, m] = v.split(':').map(Number);
  return h * 60 + m;
};
export function agreementEstimate(input: Omit<AgreementInput, 'operationKey'>) {
  const start = minutes(input.windowStart);
  let end = minutes(input.windowEnd);
  if (end <= start) end += 1440;
  let until = input.continuation?.enabled ? minutes(input.continuation.until) : end;
  while (until < end) until += 1440;
  const daily =
    ((end - start) / 60) * input.maxDiscountRateCentsPerHour +
    ((until - end) / 60) * (input.continuation?.maxRateCentsPerHour ?? 0);
  return {
    daily,
    maximum: Math.ceil(daily * input.targetQuantity * 7),
    minimum: Math.ceil(daily * input.minimumQuantity * 7),
  };
}

export function AgreementComposer() {
  const { catalog, modes } = useSession(),
    navigate = useNavigate();
  const approved = catalog.filter((c) => c.approved),
    first = approved[0];
  const [form, setForm] = useState<Omit<AgreementInput, 'operationKey'>>({
    description: '',
    startDate: localDate(),
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
    windowStart: '00:00',
    windowEnd: '06:00',
    minimumQuantity: 1,
    targetQuantity: 1,
    requirements: { cpu: first?.cpu ?? 1, memoryGb: first?.memoryGb ?? 1 },
    region: first?.region ?? '',
    maxDiscountRateCentsPerHour: 10,
    continuation: { enabled: false, until: '08:00', maxRateCentsPerHour: 20 },
  });
  const [catalogId, setCatalogId] = useState(first?.id ?? ''),
    [review, setReview] = useState<AgreementInput | null>(null),
    [accepted, setAccepted] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [prompt, setPrompt] = useState(''),
    [suggestion, setSuggestion] = useState<AgreementDraftResult<AgreementInput> | null>(null),
    [draftBusy, setDraftBusy] = useState(false);
  const wallet = useResource<CreditWallet>('/api/credits');
  const estimate = agreementEstimate(form);
  function change<K extends keyof typeof form>(key: K, value: (typeof form)[K]) {
    setForm((old) => ({ ...old, [key]: value }));
    setError('');
  }
  async function prepare() {
    setDraftBusy(true);
    setError('');
    setSuggestion(null);
    try {
      setSuggestion(
        await post<AgreementDraftResult<AgreementInput>>('/api/agreements/draft', { prompt }),
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not prepare a draft.');
    } finally {
      setDraftBusy(false);
    }
  }
  function applySuggestion() {
    if (!suggestion) return;
    const { operationKey: _key, ...draft } = suggestion.draft;
    const candidate = approved.find(
      (c) =>
        (!draft.region || c.region === draft.region) &&
        (!draft.requirements ||
          (c.cpu >= draft.requirements.cpu && c.memoryGb >= draft.requirements.memoryGb)),
    );
    if (candidate) setCatalogId(candidate.id);
    setForm((old) => ({
      ...old,
      ...draft,
      requirements: draft.requirements ?? old.requirements,
      continuation: draft.continuation ?? old.continuation,
    }));
    setSuggestion(null);
  }
  function startReview(event: FormEvent) {
    event.preventDefault();
    setError('');
    if (
      !approved.some(
        (c) =>
          c.id === catalogId &&
          c.region === form.region &&
          c.cpu >= form.requirements.cpu &&
          c.memoryGb >= form.requirements.memoryGb,
      )
    ) {
      setError('Choose an approved configuration for these resources and region.');
      return;
    }
    if (form.minimumQuantity > form.targetQuantity) {
      setError('Minimum approved slots cannot exceed the target.');
      return;
    }
    try {
      new Intl.DateTimeFormat(undefined, { timeZone: form.timeZone });
    } catch {
      setError('Enter a valid IANA time zone, for example America/Vancouver.');
      return;
    }
    setReview({ ...form, operationKey: crypto.randomUUID() });
    setAccepted(false);
  }
  async function submit() {
    if (!review || !accepted || busy) return;
    setBusy(true);
    setError('');
    try {
      const detail = await post<AgreementDetailDTO>('/api/agreements', review);
      navigate(`/orders/${detail.agreement.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not create the agreement.');
      wallet.reload();
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <Link href="/orders" className="text-link market-back">
        <ArrowLeft size={14} />
        All orders
      </Link>
      <PageHeader
        eyebrow="BOOK AHEAD. START ON YOUR TERMS."
        title={review ? 'Review your seven-day agreement.' : 'Capacity for your next seven days.'}
        description="Approve capacity now. Manually start any number of VMs within your approved slots and active window."
      />
      {modes.wick === 'real' && (
        <div className="market-notice">
          <ShieldCheck size={18} />
          <p>
            Scheduled capacity requires a verified native or supervised physical cutoff. Instant
            catalog approval alone does not qualify. The server keeps uncertified routes blocked for
            scheduled matching and VM starts.
          </p>
        </div>
      )}
      <div className="market-two-column">
        <div>
          {!review ? (
            <>
              <section className="card market-panel market-muse">
                <span className="market-kicker">
                  <Sparkles size={16} />
                  PREPARE WITH MUSE
                </span>
                <label className="field">
                  <span>Describe your schedule</span>
                  <textarea
                    value={prompt}
                    onChange={(e) => setPrompt(e.target.value)}
                    placeholder="20 environments, at least 12 approved slots per night, midnight to 6am for seven days…"
                    rows={3}
                  />
                </label>
                <button
                  className="button secondary"
                  disabled={!prompt.trim() || draftBusy}
                  onClick={() => void prepare()}
                >
                  {draftBusy ? (
                    <Spinner label="Preparing draft" />
                  ) : (
                    <>
                      <Sparkles size={15} />
                      Prepare draft
                    </>
                  )}
                </button>
                {suggestion && (
                  <div className="market-suggestion">
                    <strong>
                      {suggestion.mode === 'fixture'
                        ? 'Fixture draft · no model call'
                        : suggestion.modelCalled
                          ? 'Muse draft · review required'
                          : 'Prepared locally · no model call'}
                    </strong>
                    <p>{suggestion.explanation}</p>
                    <pre>{JSON.stringify(suggestion.draft, null, 2)}</pre>
                    <button className="button secondary small" onClick={applySuggestion}>
                      Use draft in form <ArrowRight size={14} />
                    </button>
                  </div>
                )}
              </section>
              <form id="agreement-form" className="card market-panel" onSubmit={startReview}>
                <h2>Your capacity request</h2>
                <p className="market-copy">
                  Matching is best effort until the minimum is committed for every selected window.
                  Approval reserves credit; it never starts a VM.
                </p>
                <label className="field">
                  <span>Agreement name</span>
                  <input
                    required
                    maxLength={1000}
                    value={form.description}
                    onChange={(e) => change('description', e.target.value)}
                    placeholder="Nightly development fleet"
                  />
                </label>
                <label className="field">
                  <span>Reference resource configuration</span>
                  <select
                    aria-label="Reference resource configuration"
                    required
                    value={catalogId}
                    onChange={(e) => {
                      const c = approved.find((c) => c.id === e.target.value)!;
                      setCatalogId(c.id);
                      setForm((old) => ({
                        ...old,
                        region: c.region,
                        requirements: {
                          cpu: c.cpu,
                          memoryGb: c.memoryGb,
                          ...(c.gpu ? { gpu: c.gpu } : {}),
                        },
                      }));
                    }}
                  >
                    <option value="" disabled>
                      Select a configuration
                    </option>
                    {approved.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name} · {c.cpu} vCPU / {c.memoryGb} GB · {c.region}
                      </option>
                    ))}
                  </select>
                  <span className="field-hint">
                    Region controls where VMs run. The schedule time zone below only controls the
                    clock.
                  </span>
                </label>
                <div className="market-form-grid">
                  <label className="field">
                    <span>Target slots per window</span>
                    <input
                      type="number"
                      min={1}
                      max={20}
                      required
                      value={form.targetQuantity}
                      onChange={(e) => change('targetQuantity', Number(e.target.value))}
                    />
                  </label>
                  <label className="field">
                    <span>Minimum approved per window</span>
                    <input
                      aria-label="Minimum approved per window"
                      type="number"
                      min={1}
                      max={form.targetQuantity}
                      required
                      value={form.minimumQuantity}
                      onChange={(e) => change('minimumQuantity', Number(e.target.value))}
                    />
                    <span className="field-hint">
                      This is booked capacity, not a minimum number running.
                    </span>
                  </label>
                </div>
                <h3>Seven consecutive daily windows</h3>
                <div className="market-form-grid">
                  <label className="field">
                    <span>First local date</span>
                    <input
                      type="date"
                      required
                      value={form.startDate}
                      onChange={(e) => change('startDate', e.target.value)}
                    />
                  </label>
                  <label className="field">
                    <span>Schedule time zone (IANA)</span>
                    <input
                      required
                      value={form.timeZone}
                      onChange={(e) => change('timeZone', e.target.value)}
                      list="market-timezones"
                    />
                    <datalist id="market-timezones">
                      {[
                        'UTC',
                        'America/Vancouver',
                        'America/New_York',
                        'Europe/London',
                        'Asia/Singapore',
                        'Asia/Tokyo',
                      ].map((z) => (
                        <option key={z} value={z} />
                      ))}
                    </datalist>
                  </label>
                  <label className="field">
                    <span>Window opens</span>
                    <input
                      type="time"
                      required
                      value={form.windowStart}
                      onChange={(e) => change('windowStart', e.target.value)}
                    />
                  </label>
                  <label className="field">
                    <span>Discount ends</span>
                    <input
                      type="time"
                      required
                      value={form.windowEnd}
                      onChange={(e) => change('windowEnd', e.target.value)}
                    />
                  </label>
                </div>
                <label className="field">
                  <span>Maximum discounted rate (USD / VM-hour)</span>
                  <input
                    type="number"
                    min="0.01"
                    step="0.01"
                    required
                    value={form.maxDiscountRateCentsPerHour / 100}
                    onChange={(e) =>
                      change(
                        'maxDiscountRateCentsPerHour',
                        Math.round(Number(e.target.value) * 100),
                      )
                    }
                  />
                </label>
                <label className="market-checkbox">
                  <input
                    type="checkbox"
                    checked={form.continuation?.enabled ?? false}
                    onChange={(e) =>
                      change('continuation', {
                        until: form.continuation?.until ?? '08:00',
                        maxRateCentsPerHour: form.continuation?.maxRateCentsPerHour ?? 20,
                        enabled: e.target.checked,
                      })
                    }
                  />
                  <span>
                    <strong>Reserve a normal-rate continuation</strong>
                    <small>
                      Keep the same VM after the discount ends. Reserve the tail now; the normal
                      rate freezes at match.
                    </small>
                  </span>
                </label>
                {form.continuation?.enabled && (
                  <div className="market-form-grid">
                    <label className="field">
                      <span>Hard latest end</span>
                      <input
                        type="time"
                        required
                        value={form.continuation.until}
                        onChange={(e) =>
                          change('continuation', { ...form.continuation!, until: e.target.value })
                        }
                      />
                    </label>
                    <label className="field">
                      <span>Maximum normal rate (USD / VM-hour)</span>
                      <input
                        type="number"
                        min="0.01"
                        step="0.01"
                        required
                        value={form.continuation.maxRateCentsPerHour / 100}
                        onChange={(e) =>
                          change('continuation', {
                            ...form.continuation!,
                            maxRateCentsPerHour: Math.round(Number(e.target.value) * 100),
                          })
                        }
                      />
                    </label>
                  </div>
                )}
                <div className="market-notice">
                  <ShieldCheck size={18} />
                  <p>
                    Each window ends in termination. Start a fresh VM in the next window. Save your
                    files before the hard end; disk retention is not included.
                  </p>
                </div>
                <ErrorBox error={error} />
                <button className="button primary" disabled={!approved.length}>
                  Review agreement <ArrowRight size={16} />
                </button>
              </form>
            </>
          ) : (
            <section className="card market-panel">
              <span className="market-kicker">
                <Check size={16} />
                READY FOR YOUR REVIEW
              </span>
              <h2>{review.description}</h2>
              <DetailRow label="Resource location">
                {review.region} · {review.requirements.cpu} vCPU / {review.requirements.memoryGb} GB
              </DetailRow>
              <DetailRow label="Schedule">
                7 daily windows from {review.startDate} · {review.timeZone}
              </DetailRow>
              <DetailRow label="Discount window">
                {review.windowStart}–{review.windowEnd} · up to{' '}
                {hourly(review.maxDiscountRateCentsPerHour)}
              </DetailRow>
              <DetailRow label="Continuation">
                {review.continuation?.enabled
                  ? `Until ${review.continuation.until} · up to ${hourly(review.continuation.maxRateCentsPerHour)}`
                  : 'Off · terminate at discount end'}
              </DetailRow>
              <DetailRow label="Approved capacity minimum">
                {review.minimumQuantity} in every window · target {review.targetQuantity}
              </DetailRow>
              <DetailRow label="Maximum full-term reservation">{money(estimate.maximum)}</DetailRow>
              <div className="market-notice">
                <Wallet size={19} />
                <p>
                  The full target maximum is reserved in your Broker wallet. Booked slots are paid
                  even when idle. Unmatched allowance releases on expiry or when you cancel the
                  unmatched remainder. Failed starts receive separate adjustments.
                </p>
              </div>
              <label className="market-checkbox">
                <input
                  type="checkbox"
                  checked={accepted}
                  onChange={(e) => setAccepted(e.target.checked)}
                />
                <span>
                  I accept the booked-capacity charges, the full-term credit reservation and
                  termination at each hard end. I will start VMs manually.
                </span>
              </label>
              <ErrorBox error={error} />
              <div className="market-button-row">
                <button
                  className="button secondary"
                  disabled={busy}
                  onClick={() => {
                    setReview(null);
                    setError('');
                  }}
                >
                  Edit request
                </button>
                <button
                  className="button primary"
                  disabled={!accepted || busy}
                  onClick={() => void submit()}
                >
                  {busy ? (
                    <Spinner label="Submitting agreement" />
                  ) : (
                    <>
                      Fund & request capacity <ArrowRight size={16} />
                    </>
                  )}
                </button>
              </div>
            </section>
          )}
        </div>
        <aside>
          <section className="card market-panel market-sticky">
            <span className="market-kicker">
              <Wallet size={16} />
              YOUR FUNDING
            </span>
            <h2>{money(estimate.maximum)} maximum</h2>
            <p className="market-copy">
              Full target · all 7 days · includes your optional continuation cap.
            </p>
            <DetailRow label="Available Broker credit">
              {wallet.data ? money(wallet.data.availableCents) : 'Loading…'}
            </DetailRow>
            <DetailRow label="At your minimum">Up to {money(estimate.minimum)}</DetailRow>
            <DetailRow label="Target top-up allowance">
              {money(estimate.maximum - estimate.minimum)}
            </DetailRow>
            <DetailRow label="Buyer platform fee">{money(0)}</DetailRow>
            <p className="field-hint">
              Estimate at your caps. The server validates the exact reservation, route eligibility
              and time-zone transitions.
            </p>
            <Link href="/credits" className="text-link">
              View wallet <ArrowRight size={14} />
            </Link>
            <div className="market-divider" />
            <h3>Three separate clocks</h3>
            <ol className="market-explain-list">
              <li>Discounted active hours.</li>
              <li>Reserved continuation and hard VM end.</li>
              <li>Seven-day agreement expiry and credit reconciliation.</li>
            </ol>
            <p className="field-hint">
              Broker pilot credit and Wick compute credit are separate balances. Providers pay the
              15% Broker fee from their earnings.
            </p>
            <ErrorBox error={wallet.error} retry={wallet.reload} />
          </section>
        </aside>
      </div>
    </>
  );
}

export function AgreementDetail({ id }: { id: string }) {
  const detail = useResource<AgreementDetailDTO>(`/api/agreements/${encodeURIComponent(id)}`, 5000),
    now = useNow();
  const [intent, setIntent] = useState<ActivateAgreementInput | null>(null),
    [quantity, setQuantity] = useState(1),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [success, setSuccess] = useState(''),
    [cancelReview, setCancelReview] = useState(false);
  const cancelKey = useRef(crypto.randomUUID());
  if (detail.loading) return <Spinner label="Loading scheduled agreement" />;
  if (!detail.data)
    return <ErrorBox error={detail.error || 'Agreement unavailable.'} retry={detail.reload} />;
  const { agreement: a, bookings, activations } = detail.data;
  const current = a.windows.find(
    (w) => Date.parse(w.startsAt) <= now && Date.parse(w.endsAt) > now,
  );
  const next = a.windows.find((w) => Date.parse(w.startsAt) > now);
  const used = (windowId: string) =>
    activations.filter(
      (v) =>
        v.windowId === windowId && ['provisioning', 'running', 'terminating'].includes(v.status),
    ).length;
  const available = current?.availableToActivate ?? 0;
  const canStart = a.status === 'approved' && a.deadlineEligible && !!current && available > 0;
  const currentRates = current
    ? bookings
        .filter((b) => b.windowId === current.id)
        .map((b) =>
          now >= Date.parse(current.discountEndsAt)
            ? b.normalRateCentsPerHour
            : b.discountRateCentsPerHour,
        )
    : [];
  const currentRate = currentRates.length
    ? Math.min(...currentRates) === Math.max(...currentRates)
      ? hourly(currentRates[0]!)
      : `${money(Math.min(...currentRates))}–${money(Math.max(...currentRates))} / VM-hour`
    : null;
  const title =
    a.blockedCode === 'needs_credit'
      ? 'Needs credit'
      : a.status === 'open'
        ? 'Pending matching'
        : a.status === 'approved'
          ? current
            ? 'Active window'
            : 'Approved · waiting for window'
          : a.status === 'expired' && a.reservedCents > 0
            ? 'Expired · credit release pending'
            : a.status === 'cancelled' && a.reservedCents > 0
              ? 'Unmatched remainder cancelled · booked credit reserved'
              : a.status === 'expired'
                ? 'Expired'
                : 'Unmatched remainder cancelled';
  async function activate() {
    if (!intent || busy) return;
    setBusy(true);
    setError('');
    setSuccess('');
    try {
      const result = await post<ActivateAgreementResult>(`/api/agreements/${id}/activate`, intent);
      setSuccess(
        `${result.activations.length} VM start${result.activations.length === 1 ? '' : 's'} requested${result.replayed ? ' · existing request recovered' : ''}.`,
      );
      setIntent(null);
      detail.reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not start VMs.');
      // Admission can persist a failed-start receipt before returning an error.
      // Refresh its outcome without creating another activation intent.
      detail.reload();
    } finally {
      setBusy(false);
    }
  }
  async function cancel() {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      await post(`/api/agreements/${id}/cancel-unmatched`, { operationKey: cancelKey.current });
      setCancelReview(false);
      setSuccess('Unmatched remainder cancellation recorded. Booked commitments remain in effect.');
      detail.reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not cancel unmatched capacity.');
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <Link href="/orders" className="text-link market-back">
        <ArrowLeft size={14} />
        All orders
      </Link>
      <PageHeader
        eyebrow="SCHEDULED CAPACITY · MANUAL START"
        title={a.description}
        description={title}
      >
        <span className={`status-pill status-${a.status}`}>
          <span />
          {title}
        </span>
      </PageHeader>
      <ErrorBox
        error={detail.error || (!intent && !cancelReview ? error : '')}
        retry={detail.error ? detail.reload : undefined}
      />
      {success && <SuccessBox>{success}</SuccessBox>}
      <div className="stats-grid">
        <StatCard
          label="Broker credit reserved"
          value={money(a.reservedCents)}
          note={`Full-term maximum ${money(a.maxAmountCents)}`}
          icon={<Wallet size={18} />}
        />
        <StatCard
          label="Booked capacity commitment"
          value={money(a.committedCents)}
          note="Subset of reserved credit · idle slots are paid"
          icon={<Layers3 size={18} />}
        />
        <StatCard
          label="Running now"
          value={activations.filter((v) => v.status === 'running').length}
          note={`Target ${a.targetQuantity} · minimum ${a.minimumQuantity} approved per window`}
          icon={<Play size={18} />}
        />
      </div>
      <div className="market-two-column">
        <div>
          <section className="card market-panel">
            <div className="section-heading">
              <h2>
                {current ? 'Your active window' : next ? 'Your next window' : 'Window schedule'}
              </h2>
              <span className="tiny-label">{a.timeZone}</span>
            </div>
            {(current || next) && (
              <div className="market-clock-grid">
                <div>
                  <span>Window opens</span>
                  <strong>{zonedTime((current ?? next)!.startsAt, a.timeZone)}</strong>
                </div>
                <div>
                  <span>Discount ends</span>
                  <strong>{zonedTime((current ?? next)!.discountEndsAt, a.timeZone)}</strong>
                </div>
                <div>
                  <span>Hard VM end</span>
                  <strong>{zonedTime((current ?? next)!.endsAt, a.timeZone)}</strong>
                </div>
              </div>
            )}
            {current && (
              <div className="market-active-window">
                <div>
                  <strong>{remaining(current.endsAt, now)} to hard end</strong>
                  {currentRate && (
                    <p>
                      <strong>Current matched rate: {currentRate}</strong>
                    </p>
                  )}
                  <p>
                    {now >= Date.parse(current.discountEndsAt)
                      ? 'Reserved continuation · matched normal rate now applies.'
                      : 'Discounted window · the matched rate applies.'}{' '}
                    Same VM at the rate boundary; termination at the hard end.
                  </p>
                </div>
              </div>
            )}
            {a.blockedReason && (
              <div className="market-notice">
                <ShieldCheck size={18} />
                <p>{a.blockedReason}</p>
              </div>
            )}
            <div className="market-start-row">
              <label className="field">
                <span>VMs to start manually</span>
                <input
                  aria-label="VMs to start manually"
                  type="number"
                  min={1}
                  max={available || 1}
                  value={quantity}
                  disabled={!canStart}
                  onChange={(e) => setQuantity(Number(e.target.value))}
                />
              </label>
              <button
                className="button primary"
                disabled={
                  !canStart ||
                  !Number.isSafeInteger(quantity) ||
                  quantity < 1 ||
                  quantity > available ||
                  busy
                }
                onClick={() => {
                  setIntent({ windowId: current!.id, quantity, operationKey: crypto.randomUUID() });
                  setError('');
                }}
              >
                <Play size={15} />
                Review VM starts
              </button>
            </div>
            <p className="field-hint">
              {current
                ? `${available} startable approved slots in this window. In-flight, running and cleanup-held activations count against capacity.`
                : 'VM starts open only during an approved active window.'}{' '}
              Running zero is valid. Approval never runs customer work.
            </p>
          </section>
          <section className="card market-panel">
            <h2>Seven-day capacity calendar</h2>
            <p className="market-copy">
              Every window needs {a.minimumQuantity} approved slots before the agreement is
              approved. Providers may fill toward the target of {a.targetQuantity}.
            </p>
            <div className="market-table-scroll">
              <table className="market-table">
                <thead>
                  <tr>
                    <th>Window · {a.timeZone}</th>
                    <th>Approved / target</th>
                    <th>Active</th>
                    <th>Booked</th>
                  </tr>
                </thead>
                <tbody>
                  {a.windows.map((w) => (
                    <tr key={w.id}>
                      <td>
                        <strong>{zonedTime(w.startsAt, a.timeZone)}</strong>
                        <div className="market-meta">
                          Discount ends {zonedTime(w.discountEndsAt, a.timeZone)}
                          <br />
                          Hard end {zonedTime(w.endsAt, a.timeZone)}
                        </div>
                      </td>
                      <td>
                        <strong>
                          {w.approvedQuantity} / {a.targetQuantity}
                        </strong>
                        <div className="market-capacity-track">
                          <span
                            style={{
                              width: `${Math.min(100, (w.approvedQuantity / a.targetQuantity) * 100)}%`,
                            }}
                          />
                        </div>
                        <span className="market-meta">
                          {w.approvedQuantity >= a.minimumQuantity
                            ? 'Minimum committed'
                            : `${a.minimumQuantity - w.approvedQuantity} more to minimum`}
                        </span>
                      </td>
                      <td>
                        {w.runningQuantity} running
                        <br />
                        <span className="market-meta">{used(w.id)} slots in use</span>
                      </td>
                      <td>{money(w.committedCents)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
          <section className="card market-panel">
            <h2>Your environments</h2>
            {activations.length ? (
              <div className="market-activation-list">
                {activations.map((v) =>
                  v.vmId ? (
                    <Link className="market-activation" key={v.id} href={`/vms/${v.vmId}`}>
                      <span>
                        <strong>Environment {v.vmId.slice(0, 8)}</strong>
                        <span className="market-meta">
                          {v.status} · hard end {dateTime(v.endsAt)}
                          {v.failureReason ? ` · ${v.failureReason}` : ''}
                        </span>
                      </span>
                      <ArrowRight size={16} />
                    </Link>
                  ) : (
                    <div className="market-activation" key={v.id}>
                      <span>
                        <strong>
                          {v.status === 'failed' ? 'VM start rejected' : 'VM start receipt'}
                        </strong>
                        <span className="market-meta">
                          {dateTime(v.createdAt)} ·{' '}
                          {v.status === 'failed'
                            ? 'No environment created'
                            : 'No environment reference'}
                        </span>
                        {v.failureReason && <span className="market-meta">{v.failureReason}</span>}
                        <span className="market-meta">
                          Failed-start adjustments are finalized when the window settles. A later
                          successful start in the same booked slot can remove the adjustment.
                        </span>
                      </span>
                      <StatusPill status={v.status} />
                    </div>
                  ),
                )}
              </div>
            ) : (
              <EmptyState
                icon={<Play size={22} />}
                title="No VMs started"
                description="Your booked slots are ready for manual starts once the agreement is approved and its window opens."
              />
            )}
          </section>
          {bookings.length > 0 && (
            <section className="card market-panel">
              <h2>Frozen provider bookings</h2>
              <div className="market-table-scroll">
                <table className="market-table">
                  <thead>
                    <tr>
                      <th>Provider / window</th>
                      <th>Slots</th>
                      <th>Discount</th>
                      <th>Normal</th>
                      <th>Booked total</th>
                    </tr>
                  </thead>
                  <tbody>
                    {bookings.map((b) => (
                      <tr key={b.id}>
                        <td>
                          <strong>{b.providerName}</strong>
                          <div className="market-meta">{zonedTime(b.startsAt, a.timeZone)}</div>
                        </td>
                        <td>{b.quantity}</td>
                        <td>{hourly(b.discountRateCentsPerHour)}</td>
                        <td>{hourly(b.normalRateCentsPerHour)}</td>
                        <td>{money(b.totalCents)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}
        </div>
        <aside>
          <section className="card market-panel market-sticky">
            <span className="market-kicker">
              <CalendarClock size={16} />
              AGREEMENT TERMS
            </span>
            <DetailRow label="Agreement expiry">{zonedTime(a.expiresAt, a.timeZone)}</DetailRow>
            <DetailRow label="Activation">Manual only · 0 to approved slots</DetailRow>
            <DetailRow label="End behavior">Terminate · fresh VM next window</DetailRow>
            <DetailRow label="Buyer fee">{money(0)}</DetailRow>
            <DetailRow label="Unmatched top-up allowance">{money(a.topUpAllowanceCents)}</DetailRow>
            <DetailRow label="Settled from wallet">{money(a.settledCents)}</DetailRow>
            <DetailRow label="Failed-start adjustments">{money(a.adjustmentCents)}</DetailRow>
            <p className="market-copy">
              An agreement expiry, a discount boundary and a VM hard end are separate events. Save
              your files before each hard end; retained storage is not included.
            </p>
            <Link href="/credits" className="text-link">
              Credit history <ArrowRight size={14} />
            </Link>
            {a.acceptingTopUps && (a.status === 'open' || a.status === 'approved') ? (
              <>
                <div className="market-divider" />
                <button
                  className="button secondary full-width"
                  disabled={busy}
                  onClick={() => {
                    setCancelReview(true);
                    setError('');
                  }}
                >
                  Cancel unmatched remainder
                </button>
                <p className="field-hint">
                  Existing bookings and active VMs keep their agreed terms. Only unfilled target
                  capacity is cancelled.
                </p>
              </>
            ) : null}
          </section>
        </aside>
      </div>
      {intent && (
        <MarketDialog titleId="start-title" busy={busy} onClose={() => setIntent(null)}>
          <h2 id="start-title">
            Start {intent.quantity} VM{intent.quantity === 1 ? '' : 's'}?
          </h2>
          <p>
            These starts use your approved capacity in the current window. They end at{' '}
            {current ? zonedTime(current.endsAt, a.timeZone) : 'the booked hard end'} even if
            started late. Booked capacity has already been committed.
          </p>
          <ErrorBox error={error} />
          <div className="market-button-row">
            <button className="button secondary" disabled={busy} onClick={() => setIntent(null)}>
              Back
            </button>
            <button className="button primary" disabled={busy} onClick={() => void activate()}>
              {busy ? (
                <Spinner label="Starting VMs" />
              ) : (
                <>
                  Start VMs <Play size={14} />
                </>
              )}
            </button>
          </div>
        </MarketDialog>
      )}
      {cancelReview && (
        <MarketDialog titleId="cancel-title" busy={busy} onClose={() => setCancelReview(false)}>
          <h2 id="cancel-title">Cancel only the unmatched remainder?</h2>
          <p>
            Stop future top-ups to this agreement. Booked capacity remains payable, including idle
            slots. Active VMs keep their hard end. Credit becomes available only when the server
            confirms the unmatched release.
          </p>
          <ErrorBox error={error} />
          <div className="market-button-row">
            <button
              className="button secondary"
              disabled={busy}
              onClick={() => setCancelReview(false)}
            >
              Keep matching
            </button>
            <button className="button primary" disabled={busy} onClick={() => void cancel()}>
              {busy ? <Spinner label="Cancelling remainder" /> : 'Cancel unmatched remainder'}
            </button>
          </div>
        </MarketDialog>
      )}
    </>
  );
}

export function Credits() {
  const history = usePagedResource<CreditHistory['items'][number]>('/api/credits/history', 5000);
  const wallet = useResource<CreditWallet>('/api/credits', 5000);
  return (
    <>
      <PageHeader
        eyebrow="BROKER PILOT WALLET"
        title="Credit with clear commitments."
        description="See what is available, what is reserved and how your scheduled capacity changes the ledger."
      />
      <ErrorBox
        error={wallet.error || history.error}
        retry={() => {
          wallet.reload();
          history.reload();
        }}
      />
      {wallet.data && (
        <div className="stats-grid">
          <StatCard
            label="Available to reserve"
            value={money(wallet.data.availableCents)}
            note="Unreserved Broker pilot credit"
            icon={<Wallet size={18} />}
          />
          <StatCard
            label="Reserved for agreements"
            value={money(wallet.data.reservedCents)}
            note="Unavailable for other orders"
            icon={<ShieldCheck size={18} />}
          />
          <StatCard
            label="Broker wallet balance"
            value={money(wallet.data.balanceCents)}
            note="USD · includes reserved credit"
            icon={<Layers3 size={18} />}
          />
        </div>
      )}
      <div className="market-notice">
        <Wallet size={19} />
        <p>
          This is Broker pilot credit, separate from Wick compute credits. No payment is collected
          in this pilot. Ask your administrator for a credit grant. Scheduled booked capacity is
          paid even while idle; unfilled credit and failed-start adjustments appear here after
          reconciliation.
        </p>
      </div>
      <section className="card market-panel">
        <h2>Credit history</h2>
        {history.loading ? (
          <Spinner label="Loading credit history" />
        ) : history.data?.items.length ? (
          <div className="market-table-scroll">
            <table className="market-table">
              <thead>
                <tr>
                  <th>Entry</th>
                  <th>Credit change</th>
                  <th>Reserved change</th>
                  <th>When</th>
                </tr>
              </thead>
              <tbody>
                {history.data.items.map((e) => (
                  <tr key={e.id}>
                    <td>
                      <strong>{e.kind.replaceAll('_', ' ')}</strong>
                      <div className="market-meta">{e.description}</div>
                      {e.agreementId && (
                        <Link className="text-link" href={`/orders/${e.agreementId}`}>
                          View agreement <ArrowRight size={12} />
                        </Link>
                      )}
                    </td>
                    <td>
                      {e.amountCents > 0 ? '+' : ''}
                      {money(e.amountCents)}
                    </td>
                    <td>
                      {e.reservedDeltaCents > 0 ? '+' : ''}
                      {money(e.reservedDeltaCents)}
                    </td>
                    <td>{dateTime(e.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <EmptyState
            icon={<Wallet size={25} />}
            title="No credit entries yet"
            description="Your administrator’s grants and scheduled-capacity reservations will appear here."
          />
        )}
        <LoadMore
          available={!!history.nextCursor}
          loading={history.loadingMore}
          onLoad={() => void history.loadMore()}
          error={history.moreError}
        />
      </section>
    </>
  );
}
