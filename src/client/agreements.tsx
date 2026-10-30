import { centsToUsd, usdToCents, isMoneyCents } from '../shared/money';
import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
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
  AgreementPreview,
  ActivateAgreementInput,
  ActivateAgreementResult,
  CreditHistory,
  CreditWallet,
} from '../shared/agreements';
import { museLabel, api, dateTime, money, post } from './api';
import { agreementEstimate, agreementWindows } from '../shared/schedule';
export { agreementEstimate } from '../shared/schedule';
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
const utcStamp = (value: string) =>
  new Date(value).toISOString().replace('T', ' ').replace('.000Z', ' UTC');
function ServerSchedule({ preview }: { preview: AgreementPreview }) {
  return (
    <div className="market-table-scroll">
      <table className="market-table">
        <thead>
          <tr>
            <th>Window opens · UTC</th>
            <th>Discount ends · UTC</th>
            <th>Hard end · UTC</th>
          </tr>
        </thead>
        <tbody>
          {preview.windows.map((w) => (
            <tr key={w.startsAt}>
              <td>
                <time dateTime={w.startsAt}>{utcStamp(w.startsAt)}</time>
              </td>
              <td>
                <time dateTime={w.discountEndsAt}>{utcStamp(w.discountEndsAt)}</time>
              </td>
              <td>
                <time dateTime={w.endsAt}>{utcStamp(w.endsAt)}</time>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
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
    [preview, setPreview] = useState<AgreementPreview | null>(null),
    [previewBusy, setPreviewBusy] = useState(false),
    [scheduleDiffers, setScheduleDiffers] = useState(false),
    [accepted, setAccepted] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [prompt, setPrompt] = useState(''),
    [suggestion, setSuggestion] = useState<AgreementDraftResult<AgreementInput> | null>(null),
    [draftBusy, setDraftBusy] = useState(false);
  const inputRevision = useRef(0),
    previewController = useRef<AbortController | null>(null);
  useEffect(() => () => previewController.current?.abort(), []);
  const wallet = useResource<CreditWallet>('/api/credits');
  const funding = useMemo(() => {
    try {
      return { estimate: agreementEstimate(form), error: '' };
    } catch (error) {
      return {
        estimate: null,
        error:
          error instanceof Error
            ? error.message
            : 'Complete the schedule to calculate its funding.',
      };
    }
  }, [
    form.startDate,
    form.timeZone,
    form.windowStart,
    form.windowEnd,
    form.minimumQuantity,
    form.targetQuantity,
    form.maxDiscountRateCentsPerHour,
    form.continuation?.enabled,
    form.continuation?.until,
    form.continuation?.maxRateCentsPerHour,
  ]);
  const estimate = funding.estimate;
  const quote =
    review && preview
      ? { maximum: preview.maxAmountCents, minimum: preview.minimumAmountCents }
      : estimate;
  const validClock = (value: string | undefined) =>
    !!value && /^([01]\d|2[0-3]):[0-5]\d$/.test(value);
  const basicComplete =
    !!form.description.trim() &&
    /^\d{4}-\d{2}-\d{2}$/.test(form.startDate) &&
    !!form.timeZone.trim() &&
    validClock(form.windowStart) &&
    validClock(form.windowEnd) &&
    Number.isSafeInteger(form.targetQuantity) &&
    form.targetQuantity >= 1 &&
    form.targetQuantity <= 20 &&
    Number.isSafeInteger(form.minimumQuantity) &&
    form.minimumQuantity >= 1 &&
    form.minimumQuantity <= form.targetQuantity &&
    isMoneyCents(form.maxDiscountRateCentsPerHour) &&
    form.maxDiscountRateCentsPerHour > 0 &&
    (!form.continuation?.enabled ||
      (validClock(form.continuation.until) &&
        isMoneyCents(form.continuation.maxRateCentsPerHour) &&
        form.continuation.maxRateCentsPerHour > 0));
  function updateForm(updater: (old: typeof form) => typeof form) {
    inputRevision.current++;
    previewController.current?.abort();
    setPreviewBusy(false);
    setPreview(null);
    setScheduleDiffers(false);
    setForm(updater);
    setError('');
  }
  function change<K extends keyof typeof form>(key: K, value: (typeof form)[K]) {
    updateForm((old) => ({ ...old, [key]: value }));
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
    const { operationKey: _key, maxReservationCents: _cap, ...draft } = suggestion.draft;
    const candidate = approved.find(
      (c) =>
        (!draft.region || c.region === draft.region) &&
        (!draft.requirements ||
          (c.cpu >= draft.requirements.cpu && c.memoryGb >= draft.requirements.memoryGb)),
    );
    if (candidate) setCatalogId(candidate.id);
    updateForm((old) => ({
      ...old,
      ...draft,
      requirements: draft.requirements ?? old.requirements,
      continuation: draft.continuation ?? old.continuation,
    }));
    setSuggestion(null);
  }
  async function startReview(event: FormEvent) {
    event.preventDefault();
    setError('');
    if (!basicComplete || previewBusy) return;
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
    const revision = inputRevision.current;
    const candidate: AgreementInput = {
      ...form,
      description: form.description.trim(),
      timeZone: form.timeZone.trim(),
      operationKey: crypto.randomUUID(),
      maxReservationCents: undefined,
    };
    previewController.current?.abort();
    const controller = new AbortController();
    previewController.current = controller;
    setPreviewBusy(true);
    try {
      const confirmed = await api<AgreementPreview>('/api/agreements/preview', {
        method: 'POST',
        body: JSON.stringify(candidate),
        signal: controller.signal,
      });
      if (controller.signal.aborted || revision !== inputRevision.current) return;
      if (
        !isMoneyCents(confirmed.maxAmountCents) ||
        confirmed.maxAmountCents < 1 ||
        !isMoneyCents(confirmed.minimumAmountCents) ||
        confirmed.minimumAmountCents < 1 ||
        confirmed.minimumAmountCents > confirmed.maxAmountCents ||
        !Array.isArray(confirmed.windows) ||
        confirmed.windows.length !== 7 ||
        confirmed.windows.some(
          (w) =>
            !w ||
            [w.startsAt, w.discountEndsAt, w.endsAt].some(
              (value) =>
                typeof value !== 'string' ||
                !value.endsWith('Z') ||
                !Number.isFinite(Date.parse(value)),
            ),
        )
      )
        throw new Error('The server could not confirm a valid funding quote. Please retry review.');
      let differs = true;
      try {
        const localWindows = agreementWindows(candidate),
          localQuote = agreementEstimate(candidate);
        differs =
          localQuote.maximum !== confirmed.maxAmountCents ||
          localQuote.minimum !== confirmed.minimumAmountCents ||
          localWindows.some(
            (w, i) =>
              w.startsAt !== confirmed.windows[i]?.startsAt ||
              w.discountEndsAt !== confirmed.windows[i]?.discountEndsAt ||
              w.endsAt !== confirmed.windows[i]?.endsAt,
          );
      } catch {
        /* The server can support timezone rules unavailable in this browser. */
      }
      setPreview(confirmed);
      setScheduleDiffers(differs);
      setReview({ ...candidate, maxReservationCents: confirmed.maxAmountCents });
      setAccepted(false);
    } catch (err) {
      if (!controller.signal.aborted && revision === inputRevision.current)
        setError(
          err instanceof Error ? err.message : 'The server could not confirm this schedule.',
        );
    } finally {
      if (
        !controller.signal.aborted &&
        revision === inputRevision.current &&
        previewController.current === controller
      )
        setPreviewBusy(false);
    }
  }
  async function submit() {
    if (!review || !accepted || busy || !preview) return;
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
        eyebrow="SCHEDULED CAPACITY"
        title={review ? 'Review capacity agreement' : 'New capacity agreement'}
        description="Book seven daily windows. Start VMs manually within your approved slots and hours."
      />
      {modes.wick === 'real' && (
        <div className="market-notice">
          <ShieldCheck size={18} />
          <p>
            Scheduled matching and VM starts require verified native hard-deadline enforcement.
            Instant catalog approval alone does not qualify; uncertified routes stay blocked.
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
                    rows={2}
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
                          ? `${museLabel} · review required`
                          : 'Prepared locally · no model call'}
                    </strong>
                    <p>{suggestion.explanation}</p>
                    <details className="market-disclosure">
                      <summary>View suggested fields</summary>
                      <pre>{JSON.stringify(suggestion.draft, null, 2)}</pre>
                    </details>
                    <button className="button secondary small" onClick={applySuggestion}>
                      Use draft in form <ArrowRight size={14} />
                    </button>
                  </div>
                )}
              </section>
              <form id="agreement-form" className="card market-panel" onSubmit={startReview}>
                <h2>Your capacity request</h2>
                <p className="market-copy">
                  Approval requires the minimum in every window and reserves credit. It never starts
                  a VM.
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
                      updateForm((old) => ({
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
                    Region sets the compute location; the schedule time zone sets the clock.
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
                    min="0.0001"
                    step="0.0001"
                    required
                    value={centsToUsd(form.maxDiscountRateCentsPerHour)}
                    onChange={(e) =>
                      change(
                        'maxDiscountRateCentsPerHour',
                        usdToCents(e.target.value || '0') ?? form.maxDiscountRateCentsPerHour,
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
                        min="0.0001"
                        step="0.0001"
                        required
                        value={centsToUsd(form.continuation.maxRateCentsPerHour)}
                        onChange={(e) =>
                          change('continuation', {
                            ...form.continuation!,
                            maxRateCentsPerHour:
                              usdToCents(e.target.value || '0') ??
                              form.continuation!.maxRateCentsPerHour,
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
                <button
                  className="button primary"
                  disabled={!approved.length || !basicComplete || previewBusy}
                >
                  {previewBusy ? (
                    <Spinner label="Confirming schedule" />
                  ) : (
                    <>
                      Review agreement <ArrowRight size={16} />
                    </>
                  )}
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
              <DetailRow label="Maximum full-term reservation">
                {preview ? money(preview.maxAmountCents) : 'Unavailable'}
              </DetailRow>
              {preview &&
                (scheduleDiffers ? (
                  <section aria-label="Server-confirmed schedule">
                    <div className="market-notice" role="status">
                      <Clock3 size={18} />
                      <p>
                        Time-zone rules differ on this device. Review the server-confirmed schedule
                        below.
                      </p>
                    </div>
                    <h3>Server-confirmed schedule · UTC</h3>
                    <ServerSchedule preview={preview} />
                  </section>
                ) : (
                  <details className="market-disclosure">
                    <summary>Server-confirmed schedule · UTC</summary>
                    <ServerSchedule preview={preview} />
                  </details>
                ))}
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
                  termination at each hard end under the server-confirmed schedule. I will start VMs
                  manually.
                </span>
              </label>
              <ErrorBox error={error} />
              <div className="market-button-row">
                <button
                  className="button secondary"
                  disabled={busy}
                  onClick={() => {
                    setReview(null);
                    setPreview(null);
                    setScheduleDiffers(false);
                    setError('');
                  }}
                >
                  Edit request
                </button>
                <button
                  className="button primary"
                  disabled={!accepted || busy || !preview}
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
            <h2>
              {quote
                ? `${review ? '' : 'Estimated '}${money(quote.maximum)} maximum`
                : basicComplete
                  ? 'Server preview required'
                  : 'Complete the schedule for an estimate'}
            </h2>
            <p className="market-copy">
              {review
                ? 'Server-confirmed full target · all 7 days · includes your continuation cap.'
                : 'Estimate for the full target and all 7 days. Review confirms the exact server schedule and reservation.'}
            </p>
            <DetailRow label="Available Broker credit">
              {wallet.data ? money(wallet.data.availableCents) : 'Loading…'}
            </DetailRow>
            <DetailRow label="At your minimum">
              {quote ? `Up to ${money(quote.minimum)}` : '—'}
            </DetailRow>
            <DetailRow label="Target top-up allowance">
              {quote ? money(quote.maximum - quote.minimum) : '—'}
            </DetailRow>
            <DetailRow label="Buyer platform fee">{money(0)}</DetailRow>
            <p className="field-hint" role={funding.error ? 'status' : undefined}>
              {review
                ? 'This confirmed amount is the maximum credit reservation you consent to. A higher recomputed reservation requires a new review.'
                : funding.error
                  ? `Browser estimate unavailable: ${funding.error} Review requests a server-confirmed quote.`
                  : 'Estimated per VM and per window at your price caps. Review checks the authoritative server clock before you consent.'}
            </p>
            <Link href="/credits" className="text-link">
              View wallet <ArrowRight size={14} />
            </Link>
            <div className="market-divider" />
            <details className="market-disclosure">
              <summary>Schedule and expiry details</summary>
              <ol className="market-explain-list">
                <li>The discount end changes the price.</li>
                <li>The hard end terminates each VM.</li>
                <li>The seven-day term ends with credit reconciliation.</li>
              </ol>
            </details>
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
        description={`${a.minimumQuantity} minimum / ${a.targetQuantity} target approved slots per window · ${a.timeZone}`}
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
          label="Booked capacity"
          value={money(a.committedCents)}
          note="Booked capacity · idle slots are paid"
          icon={<Layers3 size={18} />}
        />
        <StatCard
          label="Runtime slots held"
          value={a.windows.reduce((total, window) => total + window.runningQuantity, 0)}
          note="Includes starts, running VMs and pending cleanup"
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
                  <span>Hard VM end · terminates</span>
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
                    The same VM continues at the rate boundary and terminates at the hard end.
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
            {!a.deadlineEligible && !a.blockedReason && (
              <div className="market-notice">
                <ShieldCheck size={18} />
                <p>
                  Native hard-deadline enforcement is unverified for this route. VM starts remain
                  blocked.
                </p>
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
                ? `${available} unused approved slots in this window. In-flight, running and cleanup-held activations count against capacity.`
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
                    <th>Runtime slots held</th>
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
                        {w.runningQuantity} held
                        <span className="market-meta">Includes starts and pending cleanup</span>
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
            <details className="card market-panel market-disclosure">
              <summary>Frozen provider bookings · {bookings.length} blocks</summary>
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
            </details>
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
            <p className="field-hint">
              Save files before each hard end; retained storage is not included.
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
        title="Broker wallet"
        description="Available credit, reservations and scheduled capacity charges."
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
