import { TableViewport } from './table';
import { centsToUsd, usdToCents, moneyUnits } from '../shared/money';
import { useRef, useState, type FormEvent } from 'react';
import {
  ArrowRight,
  CalendarClock,
  Check,
  Clock3,
  Layers3,
  Pause,
  Play,
  Plus,
  Sparkles,
  Wallet,
} from 'lucide-react';
import type {
  AgreementDemand,
  AgreementDraftResult,
  ProviderCommitment,
  ScheduledOffering,
  ScheduledOfferingInput,
} from '../shared/agreements';
import {
  museLabel,
  api,
  money,
  moneyMicros,
  post,
  regionName,
  DEFAULT_PRICE_CENTS,
  type Dashboard,
} from './api';
import {
  DetailRow,
  EmptyState,
  ErrorBox,
  LoadMore,
  PageHeader,
  Spinner,
  SuccessBox,
  usePagedResource,
  useResource,
  useSession,
} from './components';
import { hourly, zonedTime } from './agreements';
import './market.css';

const weekdays = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
export function ProviderScheduled() {
  const { catalog, modes } = useSession();
  const dashboard = useResource<Dashboard>('/api/provider/dashboard', 5000);
  const offerings = usePagedResource<ScheduledOffering>('/api/provider/scheduled-offerings', 5000);
  const commitments = usePagedResource<ProviderCommitment>('/api/provider/commitments', 5000);
  const demand = usePagedResource<AgreementDemand>('/api/provider/agreement-demand', 5000);
  const approved = catalog.filter(
    (c) =>
      c.approved &&
      (!dashboard.data?.provider.cloudProvider ||
        c.provider === dashboard.data.provider.cloudProvider) &&
      (!dashboard.data?.policy.allowedCatalogIds ||
        dashboard.data.policy.allowedCatalogIds.includes(c.id)),
  );
  const [editor, setEditor] = useState(false),
    [review, setReview] = useState<ScheduledOfferingInput | null>(null),
    [form, setForm] = useState<ScheduledOfferingInput>({
      operationKey: '',
      catalogId: '',
      name: '',
      kind: 'discount_schedule',
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
      weekdays: [0, 1, 2, 3, 4, 5, 6],
      windowStart: '00:00',
      windowEnd: '06:00',
      availableUntil: '08:00',
      capacityQuantity: 1,
      discountRateCentsPerHour: DEFAULT_PRICE_CENTS,
      normalRateCentsPerHour: DEFAULT_PRICE_CENTS,
    }),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [success, setSuccess] = useState(''),
    [prompt, setPrompt] = useState(''),
    [draftBusy, setDraftBusy] = useState(false),
    [suggestion, setSuggestion] = useState<AgreementDraftResult<ScheduledOfferingInput> | null>(
      null,
    ),
    [tab, setTab] = useState<'offerings' | 'commitments' | 'demand'>('offerings');
  const pendingToggle = useRef(new Set<string>());
  function change<K extends keyof ScheduledOfferingInput>(
    key: K,
    value: ScheduledOfferingInput[K],
  ) {
    setForm((old) => ({ ...old, [key]: value }));
    setError('');
  }
  function begin() {
    setEditor(true);
    setReview(null);
    setError('');
    setSuccess('');
    setForm((old) => ({ ...old, catalogId: old.catalogId || approved[0]?.id || '' }));
  }
  async function draft() {
    setDraftBusy(true);
    setError('');
    try {
      setSuggestion(
        await post<AgreementDraftResult<ScheduledOfferingInput>>(
          '/api/provider/scheduled-offerings/draft',
          { prompt },
        ),
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not prepare a schedule.');
    } finally {
      setDraftBusy(false);
    }
  }
  function prepareReview(event: FormEvent) {
    event.preventDefault();
    setError('');
    if (!approved.some((c) => c.id === form.catalogId)) {
      setError('Choose an approved route for this provider.');
      return;
    }
    if (!form.weekdays.length) {
      setError('Choose at least one day.');
      return;
    }
    try {
      new Intl.DateTimeFormat(undefined, { timeZone: form.timeZone });
    } catch {
      setError('Use a valid IANA time zone.');
      return;
    }
    if (form.discountRateCentsPerHour > form.normalRateCentsPerHour) {
      setError('The discounted rate cannot exceed your published normal rate.');
      return;
    }
    setReview({ ...form, operationKey: crypto.randomUUID() });
  }
  async function publish() {
    if (!review || busy) return;
    setBusy(true);
    setError('');
    try {
      await post('/api/provider/scheduled-offerings', review);
      setReview(null);
      setEditor(false);
      setSuccess(
        'Scheduled offering published. Only eligible, funded demand can reserve its capacity.',
      );
      offerings.reload();
      commitments.reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not publish the offering.');
    } finally {
      setBusy(false);
    }
  }
  async function toggle(o: ScheduledOffering) {
    if (pendingToggle.current.has(o.id)) return;
    pendingToggle.current.add(o.id);
    setBusy(true);
    setError('');
    setSuccess('');
    try {
      await api(`/api/provider/scheduled-offerings/${o.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ active: !o.active, expectedRevision: o.revision }),
      });
      offerings.reload();
      setSuccess(
        o.active
          ? 'Offering paused for new commitments. Existing bookings retain their terms.'
          : 'Offering resumed for eligible future matching.',
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not change the offering.');
      offerings.reload();
    } finally {
      pendingToggle.current.delete(o.id);
      setBusy(false);
    }
  }
  const chosen = approved.find((c) => c.id === (review?.catalogId ?? form.catalogId));
  const chosenNativeEligible = modes.wick === 'fixture' || chosen?.deadlineEnforcement === 'native';
  const chronologicalCommitments = [...(commitments.data?.items ?? [])].sort(
    (a, b) => a.startsAt.localeCompare(b.startsAt) || a.id.localeCompare(b.id),
  );
  return (
    <>
      <PageHeader
        eyebrow="PROVIDER CAPACITY"
        title="Scheduled offerings"
        description="Publish availability and prices. Track booked capacity and buyer demand."
      >
        <button
          className="button primary"
          onClick={begin}
          disabled={!approved.length || dashboard.loading}
        >
          <Plus size={16} />
          Publish scheduled offering
        </button>
      </PageHeader>
      <ErrorBox
        error={
          dashboard.error ||
          offerings.error ||
          commitments.error ||
          demand.error ||
          (!editor ? error : '')
        }
        retry={() => {
          dashboard.reload();
          offerings.reload();
          commitments.reload();
          demand.reload();
        }}
      />
      {success && <SuccessBox>{success}</SuccessBox>}
      <div className="market-order-intro">
        <span className="icon-tile emerald">
          <CalendarClock size={21} />
        </span>
        <div>
          <strong>Discount end changes the price. Hard end stops the VM.</strong>
          <p>
            Region sets the compute location; time zone sets the clock. Normal-rate continuation
            must be booked through its hard end.
          </p>
        </div>
      </div>
      {editor && (
        <div className="market-two-column">
          <section className="card market-panel">
            <div className="section-heading">
              <h2>{review ? 'Review scheduled offering' : 'Offering details'}</h2>
              <button
                className="text-button"
                disabled={busy}
                onClick={() => {
                  setEditor(false);
                  setReview(null);
                }}
              >
                Close
              </button>
            </div>
            {!review ? (
              <>
                <div className="market-muse">
                  <label className="field">
                    <span>Prepare a schedule with Muse</span>
                    <textarea
                      rows={2}
                      value={prompt}
                      onChange={(e) => setPrompt(e.target.value)}
                      placeholder="Half-price overnight capacity on weekdays, with a hard availability cutoff…"
                    />
                  </label>
                  <button
                    className="button secondary small"
                    disabled={!prompt.trim() || draftBusy}
                    onClick={() => void draft()}
                  >
                    {draftBusy ? (
                      <Spinner label="Preparing draft" />
                    ) : (
                      <>
                        <Sparkles size={14} />
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
                            ? `${museLabel} · review before publishing`
                            : 'Prepared locally · no model call'}
                      </strong>
                      <p>{suggestion.explanation}</p>
                      <details className="market-disclosure">
                        <summary>View suggested fields</summary>
                        <pre>{JSON.stringify(suggestion.draft, null, 2)}</pre>
                      </details>
                      <button
                        className="button secondary small"
                        onClick={() => {
                          setForm((old) => ({ ...old, ...suggestion.draft }));
                          setSuggestion(null);
                        }}
                      >
                        Use draft in form <ArrowRight size={13} />
                      </button>
                    </div>
                  )}
                </div>
                <form onSubmit={prepareReview}>
                  <label className="field">
                    <span>Offering name</span>
                    <input
                      required
                      maxLength={200}
                      value={form.name}
                      onChange={(e) => change('name', e.target.value)}
                      placeholder="Weeknight capacity"
                    />
                  </label>
                  <label className="field">
                    <span>Approved provider configuration</span>
                    <select
                      aria-label="Approved provider configuration"
                      required
                      value={form.catalogId}
                      onChange={(e) => change('catalogId', e.target.value)}
                    >
                      <option value="" disabled>
                        Choose a configuration
                      </option>
                      {approved.map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.name} · {c.cpu} vCPU / {c.memoryGb} GB · {c.region}
                        </option>
                      ))}
                    </select>
                    <span className="field-hint">
                      Location is {chosen?.region ?? 'set by your configuration'}. Schedule time
                      zone never changes the location.
                    </span>
                  </label>
                  <div className="market-form-grid">
                    <label className="field">
                      <span>Offering type</span>
                      <select
                        value={form.kind}
                        onChange={(e) =>
                          change('kind', e.target.value as ScheduledOfferingInput['kind'])
                        }
                      >
                        <option value="discount_schedule">Discount schedule</option>
                        <option value="capacity_window">Enforced capacity window</option>
                      </select>
                    </label>
                    <label className="field">
                      <span>Schedule time zone (IANA)</span>
                      <input
                        required
                        value={form.timeZone}
                        onChange={(e) => change('timeZone', e.target.value)}
                      />
                    </label>
                  </div>
                  <fieldset className="market-weekdays">
                    <legend>Days of week</legend>
                    {weekdays.map((day, i) => (
                      <label key={day}>
                        <input
                          type="checkbox"
                          checked={form.weekdays.includes(i)}
                          onChange={(e) =>
                            change(
                              'weekdays',
                              e.target.checked
                                ? [...form.weekdays, i].sort()
                                : form.weekdays.filter((d) => d !== i),
                            )
                          }
                        />
                        <span>{day}</span>
                      </label>
                    ))}
                  </fieldset>
                  <div className="market-form-grid">
                    <label className="field">
                      <span>Discount opens</span>
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
                    <label className="field">
                      <span>Actual availability ends</span>
                      <input
                        type="time"
                        required
                        value={form.availableUntil}
                        onChange={(e) => change('availableUntil', e.target.value)}
                      />
                      <span className="field-hint">
                        The hard latest end for reserved continuation.
                      </span>
                    </label>
                    <label className="field">
                      <span>Capacity slots</span>
                      <input
                        type="number"
                        min={1}
                        max={20}
                        required
                        value={form.capacityQuantity}
                        onChange={(e) => change('capacityQuantity', Number(e.target.value))}
                      />
                    </label>
                    <label className="field">
                      <span>Normal rate (USD / VM-hour)</span>
                      <input
                        type="number"
                        min="0.0001"
                        step="0.0001"
                        required
                        value={centsToUsd(form.normalRateCentsPerHour)}
                        onChange={(e) =>
                          change(
                            'normalRateCentsPerHour',
                            usdToCents(e.target.value || '0') ?? form.normalRateCentsPerHour,
                          )
                        }
                      />
                    </label>
                    <label className="field">
                      <span>Discounted rate (USD / VM-hour)</span>
                      <input
                        type="number"
                        min="0.0001"
                        step="0.0001"
                        required
                        value={centsToUsd(form.discountRateCentsPerHour)}
                        onChange={(e) =>
                          change(
                            'discountRateCentsPerHour',
                            usdToCents(e.target.value || '0') ?? form.discountRateCentsPerHour,
                          )
                        }
                      />
                    </label>
                  </div>
                  <ErrorBox error={error} />
                  <button className="button primary">
                    Review publication <ArrowRight size={15} />
                  </button>
                </form>
              </>
            ) : (
              <>
                <DetailRow label="Offering">{review.name}</DetailRow>
                <DetailRow label="Compute region">
                  {chosen?.region ?? 'Unavailable configuration'}
                </DetailRow>
                <DetailRow label="Clock / days">
                  {review.timeZone} · {review.weekdays.map((d) => weekdays[d]).join(', ')}
                </DetailRow>
                <DetailRow label="Discounted hours">
                  {review.windowStart}–{review.windowEnd} ·{' '}
                  {hourly(review.discountRateCentsPerHour)}
                </DetailRow>
                <DetailRow label="Published normal continuation">
                  Through {review.availableUntil} · {hourly(review.normalRateCentsPerHour)}
                </DetailRow>
                <DetailRow label="Capacity per window">{review.capacityQuantity} slots</DetailRow>
                <div className="market-notice">
                  <Check size={18} />
                  <p>
                    Publishing offers new future commitments at these rates. Existing bookings
                    retain frozen prices and deadlines. Broker takes 15% from provider gross; no
                    buyer fee is added.
                  </p>
                </div>
                <ErrorBox error={error} />
                <div className="market-button-row">
                  <button
                    className="button secondary"
                    disabled={busy}
                    onClick={() => setReview(null)}
                  >
                    Edit schedule
                  </button>
                  <button
                    className="button primary"
                    disabled={busy || !chosenNativeEligible}
                    onClick={() => void publish()}
                  >
                    {busy ? <Spinner label="Publishing schedule" /> : 'Publish scheduled offering'}
                  </button>
                </div>
              </>
            )}
          </section>
          <aside>
            <section className="card market-panel">
              <span className="market-kicker">
                <Wallet size={16} />
                HOURLY PRICING
              </span>
              <DetailRow label="Discounted buyer price">
                {hourly(form.discountRateCentsPerHour)}
              </DetailRow>
              <DetailRow label="You keep · 85%">
                {moneyMicros(moneyUnits(Math.max(0, form.discountRateCentsPerHour)) * 85n)} /
                VM-hour
              </DetailRow>
              <DetailRow label="Broker · 15%">
                {moneyMicros(moneyUnits(Math.max(0, form.discountRateCentsPerHour)) * 15n)} /
                VM-hour
              </DetailRow>
              <p className="field-hint">
                Provider net is before compute costs. Buyers pay no added fee.
              </p>
              {chosen?.rateMicrosPerSecond !== undefined && (
                <DetailRow label="Current compute estimate">
                  {moneyMicros(BigInt(chosen.rateMicrosPerSecond) * 3600n)} / VM-hour
                </DetailRow>
              )}
              {!chosenNativeEligible && chosen ? (
                <div className="market-notice">
                  <Clock3 size={16} />
                  <p>
                    This route has no verified native hard deadline. Publication and matching remain
                    blocked.
                  </p>
                </div>
              ) : (
                <p className="field-hint">
                  Real schedules require verified native hard-deadline enforcement.
                </p>
              )}
              <details className="market-disclosure">
                <summary>Pricing and eligibility checks</summary>
                <p className="field-hint">
                  The server checks current compute prices, route authorization, hard-deadline
                  support and overlapping commitments. Publishing does not change route
                  capabilities.
                </p>
              </details>
            </section>
          </aside>
        </div>
      )}
      <section className="card market-panel">
        <div className="section-heading">
          <h2>Scheduled marketplace</h2>
          <div className="segmented-control" aria-label="Scheduled marketplace view">
            {(['offerings', 'commitments', 'demand'] as const).map((t) => (
              <button key={t} className={tab === t ? 'selected' : ''} onClick={() => setTab(t)}>
                {t === 'offerings'
                  ? 'My schedules'
                  : t === 'commitments'
                    ? 'Capacity calendar'
                    : 'Buyer demand'}
              </button>
            ))}
          </div>
        </div>
        {tab === 'offerings' && (
          <>
            {offerings.loading ? (
              <Spinner label="Loading schedules" />
            ) : offerings.data?.items.length ? (
              <TableViewport
                label="Scheduled offerings"
                minWidth={1000}
                className="market-table-scroll"
              >
                <table className="market-table">
                  <caption className="sr-only">Scheduled offerings</caption>
                  <thead>
                    <tr>
                      <th scope="col">Offering</th>
                      <th scope="col">Schedule</th>
                      <th className="numeric-cell" scope="col">
                        Slots
                      </th>
                      <th className="numeric-cell" scope="col">
                        Rates / VM-hour
                      </th>
                      <th scope="col">State</th>
                      <th className="actions-cell" scope="col">
                        Action
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {offerings.data.items.map((o) => (
                      <tr key={o.id}>
                        <td>
                          <strong>{o.name}</strong>
                          <div className="market-meta">
                            {catalog.find((c) => c.id === o.catalogId)?.name ?? 'Configuration'} ·{' '}
                            {regionName(catalog.find((c) => c.id === o.catalogId)?.region ?? '')}
                          </div>
                        </td>
                        <td>
                          <strong>
                            {o.windowStart}–{o.windowEnd}
                          </strong>
                          <div className="market-meta">
                            Available until {o.availableUntil}
                            <br />
                            {o.weekdays.length === 7
                              ? 'Daily'
                              : o.weekdays.map((d) => weekdays[d]).join(', ')}{' '}
                            · {o.timeZone}
                          </div>
                        </td>
                        <td className="numeric-cell">
                          {o.capacityQuantity}
                          <div className="market-meta">Revision {o.revision}</div>
                        </td>
                        <td className="numeric-cell">
                          {hourly(o.discountRateCentsPerHour)}
                          <div className="market-meta">
                            Normal {hourly(o.normalRateCentsPerHour)}
                          </div>
                        </td>
                        <td>
                          <span
                            className={`status-pill status-${o.active ? (o.deadlineEligible ? 'approved' : 'failed') : 'cancelled'}`}
                          >
                            <span />
                            {o.active ? (o.deadlineEligible ? 'Published' : 'Blocked') : 'Paused'}
                          </span>
                          {!o.deadlineEligible && (
                            <div className="market-meta">
                              {o.blockedReason ||
                                'Native hard deadline is unverified; matching is blocked.'}
                            </div>
                          )}
                        </td>
                        <td className="actions-cell">
                          <button
                            className="button secondary small"
                            disabled={busy || (!o.active && !o.deadlineEligible)}
                            onClick={() => void toggle(o)}
                          >
                            {o.active ? <Pause size={13} /> : <Play size={13} />}{' '}
                            {o.active ? 'Pause new commitments' : 'Resume matching'}
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </TableViewport>
            ) : (
              <EmptyState
                icon={<CalendarClock size={24} />}
                title="No schedules published"
                description="Offer quiet-hour discounts with a separate actual capacity cutoff."
              >
                <button className="button primary" onClick={begin} disabled={!approved.length}>
                  Create a schedule
                </button>
              </EmptyState>
            )}
            <LoadMore
              available={!!offerings.nextCursor}
              loading={offerings.loadingMore}
              onLoad={() => void offerings.loadMore()}
              error={offerings.moreError}
            />
          </>
        )}
        {tab === 'commitments' && (
          <>
            {commitments.loading ? (
              <Spinner label="Loading commitments" />
            ) : commitments.data?.items.length ? (
              <TableViewport
                label="Capacity commitments"
                minWidth={920}
                className="market-table-scroll"
              >
                <table className="market-table">
                  <caption className="sr-only">Capacity commitments</caption>
                  <thead>
                    <tr>
                      <th scope="col">Agreement / window</th>
                      <th className="numeric-cell" scope="col">
                        Slots
                      </th>
                      <th className="numeric-cell" scope="col">
                        Rates / VM-hour
                      </th>
                      <th className="numeric-cell" scope="col">
                        Booked amount
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {chronologicalCommitments.map((c) => (
                      <tr key={c.id}>
                        <td>
                          <strong>{c.agreementDescription}</strong>
                          <div className="market-meta">
                            {c.timeZone ?? 'UTC'} · opens{' '}
                            {zonedTime(c.startsAt, c.timeZone ?? 'UTC')}
                            <br />
                            Discount ends {zonedTime(c.discountEndsAt, c.timeZone ?? 'UTC')}
                            <br />
                            Hard end {zonedTime(c.endsAt, c.timeZone ?? 'UTC')}
                          </div>
                        </td>
                        <td className="numeric-cell">
                          <strong>{c.quantity} booked</strong>
                          <div className="market-meta">
                            {c.runningQuantity} runtime slots held · idle slots remain paid
                          </div>
                        </td>
                        <td className="numeric-cell">
                          {hourly(c.discountRateCentsPerHour)}
                          <div className="market-meta">Then {hourly(c.normalRateCentsPerHour)}</div>
                        </td>
                        <td className="numeric-cell">
                          <strong>{money(c.totalCents)} gross</strong>
                          <div className="market-meta">
                            {moneyMicros(moneyUnits(c.totalCents) * 85n)} estimated net before
                            compute
                            <br />
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <p className="field-hint">
                  Booked amounts include idle capacity. Final settled charges and failed-start
                  adjustments appear in Earnings. Broker fee 15%; buyer fee $0.
                </p>
              </TableViewport>
            ) : (
              <EmptyState
                icon={<Layers3 size={24} />}
                title="No future capacity committed"
                description="Funded buyer matches create frozen capacity blocks here. Pausing an offering does not cancel existing bookings."
              />
            )}
            <LoadMore
              available={!!commitments.nextCursor}
              loading={commitments.loadingMore}
              onLoad={() => void commitments.loadMore()}
              error={commitments.moreError}
            />
          </>
        )}
        {tab === 'demand' && (
          <>
            {demand.loading ? (
              <Spinner label="Loading agreement demand" />
            ) : demand.data?.items.length ? (
              <TableViewport
                label="Scheduled buyer demand"
                minWidth={920}
                className="market-table-scroll"
              >
                <table className="market-table">
                  <caption className="sr-only">Scheduled buyer demand</caption>
                  <thead>
                    <tr>
                      <th scope="col">Buyer demand</th>
                      <th className="numeric-cell" scope="col">
                        Capacity
                      </th>
                      <th className="numeric-cell" scope="col">
                        Price caps
                      </th>
                      <th scope="col">Schedule</th>
                    </tr>
                  </thead>
                  <tbody>
                    {demand.data.items.map((d) => (
                      <tr key={d.id}>
                        <td>
                          <strong>{d.description}</strong>
                          <div className="market-meta">
                            {d.requirements.cpu} vCPU / {d.requirements.memoryGb} GB ·{' '}
                            {regionName(d.region)}
                          </div>
                        </td>
                        <td className="numeric-cell">
                          {d.approvedQuantity} approved / {d.targetQuantity} target
                          <div className="market-meta">Minimum {d.minimumQuantity} per window</div>
                        </td>
                        <td className="numeric-cell">
                          {hourly(d.maxDiscountRateCentsPerHour)}
                          <div className="market-meta">
                            Normal cap {hourly(d.maxNormalRateCentsPerHour)}
                          </div>
                        </td>
                        <td>
                          {zonedTime(d.startsAt, d.timeZone)}
                          <div className="market-meta">
                            Through {zonedTime(d.endsAt, d.timeZone)}
                            <br />
                            {d.timeZone}
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </TableViewport>
            ) : (
              <EmptyState
                icon={<CalendarClock size={24} />}
                title="No matching buyer demand"
                description="Publish eligible schedules to compete for funded agreements. Matching respects frozen prices, resources, region and capacity."
              />
            )}
            <LoadMore
              available={!!demand.nextCursor}
              loading={demand.loadingMore}
              onLoad={() => void demand.loadMore()}
              error={demand.moreError}
            />
          </>
        )}
      </section>
    </>
  );
}
