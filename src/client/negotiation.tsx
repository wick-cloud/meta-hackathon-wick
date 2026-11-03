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
import './negotiation.css';
import type { FixedQuote } from '../shared/types';
import { ComputePromotionNotice } from './compute-promotion';
import {
  FormDisclosure,
  FormLayout,
  FormPage,
  FormPanel,
  FormSection,
  FormSummary,
  FormSummaryRows,
} from './form-layout';
import { useEffect, useState, type FormEvent } from 'react';
import { ArrowRight, Layers3, RefreshCw, Sparkles } from 'lucide-react';
import {
  museLabel,
  DEFAULT_PRICE_CENTS,
  ApiError,
  api,
  dateTime,
  money,
  post,
  regionName,
  type EnvironmentRequest,
} from './api';
import {
  DetailRow,
  EmptyState,
  ErrorBox,
  Link,
  MoneyInput,
  PageHeader,
  Spinner,
  useNavigate,
  useResource,
  useSession,
} from './components';

interface Desired {
  diskId?: string;
  cpu: number;
  memoryGb: number;
  gpu?: string;
  region: string;
  durationMinutes: number;
  maxPriceCents: number;
}
interface Flexibility {
  minCPU: number;
  minMemoryGb: number;
  allowedRegions: string[];
  allowedDurations: number[];
  hardMaxPriceCents: number;
  gpu: 'preserve' | 'none' | 'any';
}
interface Intent {
  id: string;
  description: string;
  desired: Desired;
  flexibility: Flexibility;
  status: 'open' | 'accepted' | 'resolved';
  sourceMode: 'fixture' | 'real';
  sourceRequestId?: string;
  acceptedRequestId?: string;
  createdAt: string;
}
interface Offer {
  id: string;
  providerName: string;
  catalogName: string;
  before: Desired;
  after: Desired;
  totalPriceCents: number;
  pricing?: FixedQuote;
  tradeoffs: string[];
  expiresAt: string;
  mode: 'fixture' | 'real';
  modelCalled: boolean;
}
interface IntentDraft {
  operationKey: string;
  description: string;
  desired: Desired;
  flexible: boolean;
  flexibility: Flexibility;
  sourceRequestId?: string;
  attempted?: boolean;
}
const draftKey = (actorId: string, source = '') => `wick-intent:${actorId}:${source}`;
const definitelyRejected = (error: unknown) =>
  error instanceof ApiError && [400, 401, 403, 404, 409, 422, 429].includes(error.status);
function readDraft(key: string): IntentDraft | undefined {
  try {
    return JSON.parse(sessionStorage.getItem(key) || 'null') || undefined;
  } catch {
    return undefined;
  }
}
export function seedAlternativeDraft(actorId: string, description: string, desired: Desired) {
  const draft: IntentDraft = {
    operationKey: crypto.randomUUID(),
    description,
    desired,
    flexible: false,
    flexibility: {
      minCPU: desired.cpu,
      minMemoryGb: desired.memoryGb,
      allowedRegions: [],
      allowedDurations: [],
      hardMaxPriceCents: desired.maxPriceCents,
      gpu: 'preserve',
    },
  };
  sessionStorage.setItem(draftKey(actorId), JSON.stringify(draft));
}

export function AlternativeComposer({ sourceRequestId }: { sourceRequestId?: string }) {
  const { user, catalog, modes } = useSession(),
    navigate = useNavigate();
  const key = draftKey(user!.id, sourceRequestId),
    approved = catalog.filter((item) => item.approved),
    first = approved[0];
  const [draft, setDraft] = useState<IntentDraft>(
    () =>
      readDraft(key) || {
        operationKey: crypto.randomUUID(),
        description: '',
        flexible: false,
        sourceRequestId,
        desired: {
          cpu: first?.cpu || 2,
          memoryGb: first?.memoryGb || 4,
          region: first?.region || '',
          durationMinutes: 30,
          maxPriceCents: DEFAULT_PRICE_CENTS,
        },
        flexibility: {
          minCPU: first?.cpu || 2,
          minMemoryGb: first?.memoryGb || 4,
          allowedRegions: [],
          allowedDurations: [],
          hardMaxPriceCents: DEFAULT_PRICE_CENTS,
          gpu: 'preserve',
        },
      },
  );
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [sourceLoaded, setSourceLoaded] = useState(!sourceRequestId || !!readDraft(key));
  useEffect(() => {
    if (sourceLoaded) sessionStorage.setItem(key, JSON.stringify(draft));
  }, [key, draft, sourceLoaded]);
  useEffect(() => {
    if (!sourceRequestId || sourceLoaded) return;
    let cancelled = false;
    void api<{ request: EnvironmentRequest }>(
      `/api/requests/${encodeURIComponent(sourceRequestId)}`,
    )
      .then(({ request }) => {
        if (cancelled) return;
        if (request.status !== 'no_offers') {
          setError('Only a request with no offers can be linked here.');
          return;
        }
        const desired = {
          ...request.requirements,
          ...(request.diskId ? { diskId: request.diskId } : {}),
          region: request.region,
          durationMinutes: request.durationMinutes,
          maxPriceCents: request.maxPriceCents,
        };
        setDraft((old) => ({
          ...old,
          description: request.description,
          desired,
          flexibility: {
            minCPU: desired.cpu,
            minMemoryGb: desired.memoryGb,
            allowedRegions: [],
            allowedDurations: [],
            hardMaxPriceCents: desired.maxPriceCents,
            gpu: 'preserve',
          },
        }));
        setSourceLoaded(true);
      })
      .catch((err: Error) => {
        if (!cancelled) setError(err.message);
      });
    return () => {
      cancelled = true;
    };
  }, [sourceRequestId, sourceLoaded]);
  const regions = [...new Set(approved.map((item) => item.region))].sort();
  const durations = [...new Set(approved.flatMap((item) => item.durationMinutes))]
    .filter((n) => [15, 30, 60].includes(n))
    .sort((a, b) => a - b);
  const locked = busy || !!draft.attempted;
  function updateDesired(change: Partial<Desired>) {
    setDraft((old) => ({ ...old, desired: { ...old.desired, ...change } }));
  }
  function updateFlex(change: Partial<Flexibility>) {
    setDraft((old) => ({ ...old, flexibility: { ...old.flexibility, ...change } }));
  }
  async function save(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError('');
    const snapshot = { ...draft, attempted: true };
    sessionStorage.setItem(key, JSON.stringify(snapshot));
    setDraft(snapshot);
    try {
      const result = await post<Intent>('/api/intents', {
        operationKey: draft.operationKey,
        description: draft.description.trim(),
        desired: {
          ...draft.desired,
          ...(draft.desired.gpu?.trim() ? { gpu: draft.desired.gpu.trim() } : { gpu: undefined }),
        },
        ...(draft.flexible ? { flexibility: draft.flexibility } : {}),
        ...(sourceRequestId ? { sourceRequestId } : {}),
      });
      sessionStorage.removeItem(key);
      navigate(`/alternatives/${result.id}`);
    } catch (err) {
      if (definitelyRejected(err)) {
        const editable = { ...snapshot, attempted: false, operationKey: crypto.randomUUID() };
        sessionStorage.setItem(key, JSON.stringify(editable));
        setDraft(editable);
      }
      setError(err instanceof Error ? err.message : 'Unable to save your reviewed intent.');
    } finally {
      setBusy(false);
    }
  }
  return (
    <FormPage
      className="negotiation-page"
      back={{ href: '/alternatives', label: 'Saved alternatives' }}
      eyebrow="BUYER CONTROLLED ALTERNATIVES"
      title="Request alternatives"
      description="Record unsupported requirements without starting an auction. You approve an exact provider and fixed price before any VM is reserved."
    >
      <form onSubmit={(event) => void save(event)}>
        <FormLayout
          aside={
            <FormSummary title="Review before saving">
              <DesiredSummary desired={draft.desired} />
              <p>
                {draft.flexible
                  ? 'Only your explicitly selected alternatives may be proposed.'
                  : 'Flexibility is off. Original resource minimums, GPU, region, duration and budget remain binding.'}
              </p>
              <FormDisclosure title="How suggestions work">
                <p className="field-hint">
                  Saving and suggesting reserve nothing. Final acceptance creates one linked request
                  at the reviewed provider and price.
                </p>
                <span className="tiny-label">
                  {modes.muse === 'fixture'
                    ? 'Fixture Muse · no model call'
                    : `${museLabel} · review required`}{' '}
                  · No payment due
                </span>
              </FormDisclosure>
              <ErrorBox error={error} />
              {draft.attempted && !busy && (
                <p className="field-hint">
                  This reviewed snapshot is preserved for a safe retry. Saved alternatives can show
                  whether the previous attempt completed.
                </p>
              )}
              <button
                type="submit"
                className="button primary form-submit"
                disabled={
                  busy ||
                  !sourceLoaded ||
                  (draft.flexible &&
                    (!draft.flexibility.allowedRegions.length ||
                      !draft.flexibility.allowedDurations.length ||
                      draft.flexibility.hardMaxPriceCents > draft.desired.maxPriceCents))
                }
              >
                {busy ? (
                  <Spinner label="Saving reviewed intent" />
                ) : draft.attempted ? (
                  'Retry saving reviewed intent'
                ) : (
                  'Save reviewed intent'
                )}
                <ArrowRight size={16} />
              </button>
            </FormSummary>
          }
        >
          <FormPanel>
            <fieldset
              disabled={locked || !sourceLoaded}
              style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}
            >
              <FormSection title="Your original requirements">
                {sourceRequestId && (
                  <p className="field-hint">
                    Linked to your finished auction. Its original specification stays unchanged.
                  </p>
                )}

                <fieldset
                  disabled={!!sourceRequestId}
                  style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}
                >
                  <label className="field" htmlFor="intent-description">
                    <span>Requirement description</span>
                    <textarea
                      id="intent-description"
                      maxLength={4000}
                      rows={3}
                      value={draft.description}
                      onChange={(event) =>
                        setDraft((old) => ({ ...old, description: event.target.value }))
                      }
                      required
                    />
                  </label>
                  <div className="field-grid">
                    <label className="field" htmlFor="intent-cpu">
                      <span>Requested vCPUs</span>
                      <input
                        id="intent-cpu"
                        type="number"
                        min={1}
                        max={1024}
                        step={1}
                        value={draft.desired.cpu}
                        onChange={(event) => updateDesired({ cpu: Number(event.target.value) })}
                        required
                      />
                    </label>
                    <label className="field" htmlFor="intent-memory">
                      <span>Requested memory (GiB)</span>
                      <input
                        id="intent-memory"
                        type="number"
                        min={0.001}
                        max={16384}
                        step="any"
                        value={draft.desired.memoryGb}
                        onChange={(event) =>
                          updateDesired({ memoryGb: Number(event.target.value) })
                        }
                        required
                      />
                    </label>
                  </div>
                  <label className="field" htmlFor="intent-gpu">
                    <span>Requested GPU (blank means none)</span>
                    <input
                      id="intent-gpu"
                      maxLength={120}
                      value={draft.desired.gpu || ''}
                      onChange={(event) => updateDesired({ gpu: event.target.value })}
                    />
                  </label>
                  <div className="field-grid">
                    <label className="field" htmlFor="intent-region">
                      <span>Requested region</span>
                      <input
                        id="intent-region"
                        maxLength={120}
                        value={draft.desired.region}
                        onChange={(event) => updateDesired({ region: event.target.value })}
                        required
                      />
                      <span className="field-hint">
                        Preserve the region you actually want, even if currently unsupported.
                      </span>
                    </label>
                    <label className="field" htmlFor="intent-duration">
                      <span>Requested duration (minutes)</span>
                      <input
                        id="intent-duration"
                        type="number"
                        min={1}
                        max={1440}
                        step={1}
                        value={draft.desired.durationMinutes}
                        onChange={(event) =>
                          updateDesired({ durationMinutes: Number(event.target.value) })
                        }
                        required
                      />
                    </label>
                  </div>
                  <MoneyInput
                    id="intent-budget"
                    label="Original maximum total (USD)"
                    value={draft.desired.maxPriceCents}
                    min={1}
                    onChange={(maxPriceCents) => updateDesired({ maxPriceCents })}
                  />
                </fieldset>
              </FormSection>
              <FormSection title="Permission to suggest changes">
                <label className="negotiation-choice">
                  <input
                    type="checkbox"
                    checked={draft.flexible}
                    onChange={(event) =>
                      setDraft((old) => ({
                        ...old,
                        flexible: event.target.checked,
                        flexibility: {
                          ...old.flexibility,
                          minCPU: old.desired.cpu,
                          minMemoryGb: old.desired.memoryGb,
                          hardMaxPriceCents: old.desired.maxPriceCents,
                          allowedRegions: regions.includes(old.desired.region)
                            ? [old.desired.region]
                            : [],
                          allowedDurations: durations.includes(old.desired.durationMinutes)
                            ? [old.desired.durationMinutes]
                            : [],
                        },
                      }))
                    }
                  />
                  Allow only the alternatives I specify below
                </label>
                {!draft.flexible && (
                  <p className="field-hint">
                    Strict by default: CPU and memory minimums, GPU, region, duration and budget
                    stay as requested. Any larger supported size is shown for final review.
                  </p>
                )}
                {draft.flexible && (
                  <>
                    <div className="field-grid">
                      <label className="field" htmlFor="flex-cpu">
                        <span>Lowest acceptable vCPUs</span>
                        <input
                          id="flex-cpu"
                          type="number"
                          min={1}
                          max={draft.desired.cpu}
                          step={1}
                          value={draft.flexibility.minCPU}
                          onChange={(event) => updateFlex({ minCPU: Number(event.target.value) })}
                          required
                        />
                      </label>
                      <label className="field" htmlFor="flex-memory">
                        <span>Lowest acceptable memory (GiB)</span>
                        <input
                          id="flex-memory"
                          type="number"
                          min={0.001}
                          max={draft.desired.memoryGb}
                          step="any"
                          value={draft.flexibility.minMemoryGb}
                          onChange={(event) =>
                            updateFlex({ minMemoryGb: Number(event.target.value) })
                          }
                          required
                        />
                      </label>
                    </div>
                    <fieldset className="negotiation-options">
                      <legend>Allowed supported regions</legend>
                      {regions.map((region) => (
                        <label className="negotiation-choice" key={region}>
                          <input
                            type="checkbox"
                            checked={draft.flexibility.allowedRegions.includes(region)}
                            onChange={(event) =>
                              updateFlex({
                                allowedRegions: event.target.checked
                                  ? [...draft.flexibility.allowedRegions, region]
                                  : draft.flexibility.allowedRegions.filter(
                                      (value) => value !== region,
                                    ),
                              })
                            }
                          />
                          {region}
                        </label>
                      ))}
                    </fieldset>
                    <fieldset className="negotiation-options">
                      <legend>Allowed rental durations</legend>
                      {durations.map((duration) => (
                        <label className="negotiation-choice" key={duration}>
                          <input
                            type="checkbox"
                            checked={draft.flexibility.allowedDurations.includes(duration)}
                            onChange={(event) =>
                              updateFlex({
                                allowedDurations: event.target.checked
                                  ? [...draft.flexibility.allowedDurations, duration]
                                  : draft.flexibility.allowedDurations.filter(
                                      (value) => value !== duration,
                                    ),
                              })
                            }
                          />
                          {duration} minutes
                        </label>
                      ))}
                    </fieldset>
                    <label className="field" htmlFor="flex-gpu">
                      <span>GPU permission</span>
                      <select
                        id="flex-gpu"
                        value={draft.flexibility.gpu}
                        onChange={(event) =>
                          updateFlex({ gpu: event.target.value as Flexibility['gpu'] })
                        }
                      >
                        <option value="preserve">Preserve my original GPU requirement</option>
                        <option value="none">A CPU-only alternative is acceptable</option>
                        <option value="any">Any supported GPU model (GPU required)</option>
                      </select>
                    </label>
                    <MoneyInput
                      id="flex-budget"
                      label="Hard maximum alternative total (USD)"
                      value={draft.flexibility.hardMaxPriceCents}
                      min={1}
                      onChange={(hardMaxPriceCents) => updateFlex({ hardMaxPriceCents })}
                    />
                    <p className="field-hint">
                      This limit cannot exceed your original maximum. Muse cannot raise it.
                    </p>
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

function DesiredSummary({ desired }: { desired: Desired }) {
  return (
    <FormSummaryRows
      items={[
        { label: 'Resources', value: `${desired.cpu} vCPU · ${desired.memoryGb} GiB` },
        { label: 'GPU', value: desired.gpu || 'None' },
        { label: 'Region', value: desired.region },
        { label: 'Duration', value: `${desired.durationMinutes} minutes` },
        { label: 'Maximum total', value: money(desired.maxPriceCents) },
        ...(desired.diskId
          ? [
              {
                label: 'Persistent disk',
                value: (
                  <Link href={'/disks/' + desired.diskId}>
                    View disk <ArrowRight size={13} />
                  </Link>
                ),
              },
            ]
          : []),
      ]}
    />
  );
}

export function AlternativeList() {
  const { data, loading, error, reload } = useResource<{ items: Intent[] }>('/api/intents', 5000);
  return (
    <div className="form-page negotiation-page">
      <PageHeader
        eyebrow="SAVED BUYER INTENTS"
        title="Alternatives"
        description="Review nonbinding requirements and proposals before accepting an exact offer."
      >
        <Link href="/alternatives/new" className="button primary">
          Review a new intent
          <ArrowRight size={16} />
        </Link>
      </PageHeader>
      <TablePanel label="Saved alternatives">
        <TableToolbar>
          <div>
            <h2>Saved intents</h2>
            <p className="field-hint">No rental starts until you accept an exact offer.</p>
          </div>
          <button className="button secondary small" onClick={reload}>
            <RefreshCw size={14} />
            Refresh
          </button>
        </TableToolbar>
        <ErrorBox error={data ? error : ''} retry={reload} />
        {loading ? (
          <TableState loading />
        ) : error && !data ? (
          <TableState error={error} onRetry={reload} />
        ) : data?.items.length ? (
          <>
            <TableViewport embedded label="Saved alternatives" minWidth={1000}>
              <table className="alternatives-table">
                <caption className="sr-only">Saved alternatives</caption>
                <thead>
                  <tr>
                    <th scope="col">Intent</th>
                    <th scope="col">Status</th>
                    <th scope="col">Requirements</th>
                    <th scope="col">Region</th>
                    <th scope="col" className="numeric-cell">
                      Maximum total
                    </th>
                    <th scope="col">Created</th>
                    <th scope="col" className="actions-cell">
                      Action
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {data.items.map((intent) => (
                    <tr key={intent.id}>
                      <td>
                        <TableIdentity
                          icon={<Layers3 size={17} />}
                          title={
                            <Link href={`/alternatives/${intent.id}`}>{intent.description}</Link>
                          }
                          subtitle={<code>{intent.id.slice(0, 8)}</code>}
                        />
                      </td>
                      <td>
                        <TableStatus
                          tone={
                            intent.status === 'accepted'
                              ? 'success'
                              : intent.status === 'open'
                                ? 'warning'
                                : 'neutral'
                          }
                        >
                          {intent.status === 'open'
                            ? 'Open'
                            : intent.status === 'accepted'
                              ? 'Accepted'
                              : 'Resolved'}
                        </TableStatus>
                        <small>
                          {intent.sourceMode === 'fixture'
                            ? 'Fixture rental source'
                            : 'Wick rental source'}
                        </small>
                      </td>
                      <td>
                        {intent.desired.cpu} vCPU · {intent.desired.memoryGb} GiB
                        <small>
                          {intent.desired.durationMinutes} min
                          {intent.desired.gpu ? ` · ${intent.desired.gpu}` : ''}
                        </small>
                      </td>
                      <td>{regionName(intent.desired.region)}</td>
                      <td className="numeric-cell">{money(intent.desired.maxPriceCents)}</td>
                      <td>{dateTime(intent.createdAt)}</td>
                      <td className="actions-cell">
                        <TableActions>
                          <Link
                            href={`/alternatives/${intent.id}`}
                            className="button secondary small"
                          >
                            Review alternatives
                            <ArrowRight size={14} />
                          </Link>
                        </TableActions>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableViewport>
          </>
        ) : (
          <TableState
            title="No saved intents yet"
            description="Start with exactly what you want, including requirements unavailable in the current catalog."
          />
        )}
        <TableFooter count={data?.items.length} noun="intents" />
      </TablePanel>
    </div>
  );
}

export function AlternativeDetail({ id }: { id: string }) {
  const { user } = useSession(),
    navigate = useNavigate();
  const { data, loading, error, reload } = useResource<{ intent: Intent; offers: Offer[] }>(
    `/api/intents/${encodeURIComponent(id)}`,
    3000,
  );
  const acceptKey = `wick-intent-accept:${user!.id}:${id}`;
  const [selectedId, setSelectedId] = useState(''),
    [consent, setConsent] = useState(false),
    [busy, setBusy] = useState(''),
    [actionError, setActionError] = useState('');
  const [attempt, setAttempt] = useState<{ operationKey: string; offerId: string } | undefined>(
    () => {
      try {
        return JSON.parse(sessionStorage.getItem(acceptKey) || 'null') || undefined;
      } catch {
        return undefined;
      }
    },
  );
  useEffect(() => {
    if (attempt) setSelectedId(attempt.offerId);
  }, [attempt]);
  if (loading || !data)
    return (
      <FormPage
        className="negotiation-page"
        title="Review alternative"
        eyebrow="EXPLICIT BUYER REVIEW"
        back={{ href: '/alternatives', label: 'Saved alternatives' }}
      >
        <FormPanel>
          <FormSection>
            {loading ? (
              <Spinner label="Loading reviewed alternatives" />
            ) : (
              <ErrorBox error={error || 'Intent unavailable.'} retry={reload} />
            )}
          </FormSection>
        </FormPanel>
      </FormPage>
    );
  const { intent, offers } = data,
    selected = offers.find((offer) => offer.id === selectedId);
  async function propose() {
    setBusy('propose');
    setActionError('');
    setSelectedId('');
    setConsent(false);
    try {
      await post(`/api/intents/${id}/propose`);
      reload();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Unable to suggest alternatives.');
    } finally {
      setBusy('');
    }
  }
  async function accept() {
    if (!selected || !consent) return;
    const receipt = attempt || { operationKey: crypto.randomUUID(), offerId: selected.id };
    sessionStorage.setItem(acceptKey, JSON.stringify(receipt));
    setAttempt(receipt);
    setBusy('accept');
    setActionError('');
    try {
      const result = await post<{ requestId: string; vmId: string }>(
        `/api/intents/${id}/offers/${receipt.offerId}/accept`,
        { operationKey: receipt.operationKey },
      );
      navigate(`/vms/${result.vmId}`);
    } catch (err) {
      if (definitelyRejected(err)) {
        sessionStorage.removeItem(acceptKey);
        setAttempt(undefined);
        setConsent(false);
      }
      setActionError(err instanceof Error ? err.message : 'Offer acceptance failed.');
      reload();
    } finally {
      setBusy('');
    }
  }
  return (
    <FormPage
      className="negotiation-page"
      back={{ href: '/alternatives', label: 'Saved alternatives' }}
      eyebrow="EXPLICIT BUYER REVIEW"
      title="Review alternative"
      description={intent.description}
    >
      <ErrorBox error={error || actionError} retry={error ? reload : undefined} />
      <FormLayout
        aside={
          <FormSummary title="Your immutable intent">
            <DesiredSummary desired={intent.desired} />
            {intent.sourceRequestId && (
              <Link href={`/requests/${intent.sourceRequestId}`}>
                View unchanged original auction
              </Link>
            )}
            <p className="field-hint">
              Proposals reserve no capacity and create no VM. Acceptance rechecks the current
              configuration, price, policy and available capacity.
            </p>
            {intent.status === 'open' ? (
              <button
                className={selected ? 'button secondary full-width' : 'button primary form-submit'}
                disabled={!!busy || !!attempt}
                onClick={() => void propose()}
              >
                {busy === 'propose' ? (
                  <Spinner label="Preparing alternatives" />
                ) : (
                  <>
                    <Sparkles size={16} />
                    Suggest reviewed alternatives
                  </>
                )}
              </button>
            ) : (
              <p>
                This intent is {intent.status}.{' '}
                {intent.acceptedRequestId && (
                  <Link href={`/requests/${intent.acceptedRequestId}`}>
                    Open its accepted environment request
                    <ArrowRight size={16} />
                  </Link>
                )}
              </p>
            )}
          </FormSummary>
        }
      >
        {intent.status === 'open' && !offers.length && (
          <FormPanel>
            <FormSection>
              <EmptyState
                icon={<Layers3 size={24} />}
                title="No alternatives are available yet"
                description="Suggestions must fit your explicit permissions and current approved supply."
              />
            </FormSection>
          </FormPanel>
        )}
        <div className="negotiation-cards">
          {offers.map((offer) => (
            <FormPanel
              key={offer.id}
              className={selectedId === offer.id ? 'is-selected' : undefined}
            >
              <FormSection title={offer.catalogName}>
                <p>
                  {offer.providerName} · {money(offer.totalPriceCents)} fixed total
                </p>
                <span className="tiny-label">
                  {offer.mode === 'fixture'
                    ? 'Fixture Muse · No model call'
                    : offer.modelCalled
                      ? museLabel
                      : 'Validated locally · no model call'}{' '}
                  · No payment due
                </span>
                <p>
                  {offer.after.cpu} vCPU · {offer.after.memoryGb} GiB · {offer.after.region} ·{' '}
                  {offer.after.durationMinutes} minutes
                </p>
                <button
                  className="button secondary"
                  disabled={!!busy || !!attempt || intent.status !== 'open'}
                  onClick={() => {
                    setSelectedId(offer.id);
                    setConsent(false);
                  }}
                >
                  Review this exact offer
                </button>
              </FormSection>
            </FormPanel>
          ))}
        </div>
        {selected && intent.status === 'open' && (
          <FormPanel aria-label="Final counteroffer review">
            <FormSection
              title="Review every change before accepting"
              description={`${selected.providerName} · ${selected.catalogName}`}
            >
              <TablePanel embedded label="Alternative comparison">
                <TableViewport
                  embedded
                  label="Alternative comparison"
                  minWidth={680}
                  className="table-scroll"
                >
                  <table>
                    <caption className="sr-only">Alternative comparison</caption>
                    <thead>
                      <tr>
                        <th scope="col">Dimension</th>
                        <th scope="col">Originally requested</th>
                        <th scope="col">Reviewed alternative</th>
                      </tr>
                    </thead>
                    <tbody>
                      {[
                        ['vCPUs', selected.before.cpu, selected.after.cpu],
                        ['Memory (GiB)', selected.before.memoryGb, selected.after.memoryGb],
                        ['GPU', selected.before.gpu || 'None', selected.after.gpu || 'None'],
                        [
                          'Region',
                          regionName(selected.before.region),
                          regionName(selected.after.region),
                        ],
                        [
                          'Duration (minutes)',
                          selected.before.durationMinutes,
                          selected.after.durationMinutes,
                        ],
                        [
                          'Maximum total',
                          money(selected.before.maxPriceCents),
                          money(intent.flexibility.hardMaxPriceCents),
                        ],
                      ].map(([label, before, after]) => (
                        <tr key={label}>
                          <th scope="row">{label}</th>
                          <td>{before}</td>
                          <td>{after}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </TableViewport>
              </TablePanel>
              <DetailRow label="Fixed full rental total">
                {money(selected.totalPriceCents)} · No payment due
              </DetailRow>
              <ComputePromotionNotice pricing={selected.pricing} />
              <DetailRow label="Added buyer fee">$0.00 · Provider pays Broker’s 15%</DetailRow>
              <DetailRow label="Offer expires">{dateTime(selected.expiresAt)}</DetailRow>
              <ul>
                {selected.tradeoffs.map((tradeoff, index) => (
                  <li key={index}>{tradeoff}</li>
                ))}
              </ul>
              <p className="field-hint">
                Accepting binds this provider and total immediately and starts provisioning. No
                second auction. Your original requirements stay intact.
              </p>
              <label className="negotiation-choice">
                <input
                  type="checkbox"
                  checked={consent}
                  disabled={!!busy}
                  onChange={(event) => setConsent(event.target.checked)}
                />
                I accept these exact changes, provider and fixed total.
              </label>
              <button
                className="button primary"
                disabled={
                  !consent ||
                  !!busy ||
                  (!attempt && new Date(selected.expiresAt).getTime() <= Date.now())
                }
                onClick={() => void accept()}
              >
                {busy === 'accept' ? (
                  <Spinner label="Accepting reviewed offer" />
                ) : attempt ? (
                  'Retry this acceptance'
                ) : (
                  'Accept reviewed offer'
                )}
                <ArrowRight size={16} />
              </button>
              {attempt && (
                <p className="field-hint">
                  Retries use this same reviewed offer and operation key. Other alternatives stay
                  locked while the result is reconciled.
                </p>
              )}
            </FormSection>
          </FormPanel>
        )}
      </FormLayout>
    </FormPage>
  );
}
