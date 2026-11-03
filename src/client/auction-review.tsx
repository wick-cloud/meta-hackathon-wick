import { useEffect, useState, type FormEvent } from 'react';
import { ArrowRight, ChevronLeft, Clock3, Cpu, ShieldCheck, Sparkles } from 'lucide-react';
import { isMoneyCents, MIN_ORDER_PRICE_CENTS } from '../shared/money';
import { loadDraft, money, post, saveDraft, type Draft, type EnvironmentRequest } from './api';
import {
  EmptyState,
  ErrorBox,
  Link,
  MoneyInput,
  ReceiptCard,
  Spinner,
  useNavigate,
  useSession,
} from './components';
import { DiskPicker, useDiskOptions } from './disks';

export function RequestReview() {
  const { catalog, modes } = useSession(),
    navigate = useNavigate();
  const [draft, setDraft] = useState<Draft | null>(() => {
    const saved = loadDraft();
    return saved ? { ...saved, region: 'any', matchAcrossProviders: true } : null;
  });
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const disks = useDiskOptions();
  const approved = catalog.filter(
    (item) =>
      item.approved &&
      (!draft?.diskId || (disks.data?.enabled && disks.data.eligibleCatalogIds.includes(item.id))),
  );
  const matches = draft
    ? approved.filter(
        (item) =>
          item.cpu >= draft.requirements.cpu &&
          item.memoryGb >= draft.requirements.memoryGb &&
          item.durationMinutes.includes(draft.durationMinutes) &&
          (!draft.requirements.gpu ||
            (draft.requirements.gpu === 'any'
              ? Boolean(item.gpu)
              : item.gpu === draft.requirements.gpu)),
      )
    : [];
  // The API needs a compatible catalog snapshot. This is an internal admission anchor;
  // the auction freezes every compatible route and never restricts bids to this provider.
  const admission = matches.find((item) => item.id === draft?.catalogId) ?? matches[0];
  const diskPending = Boolean(draft?.diskId && disks.loading && !disks.data);
  useEffect(() => {
    if (draft)
      saveDraft({
        ...draft,
        catalogId: admission?.id ?? draft.catalogId,
        region: 'any',
        matchAcrossProviders: true,
      });
  }, [draft, admission?.id]);
  function update(change: Partial<Draft>) {
    setDraft((old) =>
      old ? { ...old, ...change, region: 'any', matchAcrossProviders: true } : old,
    );
    setError('');
  }
  if (!draft)
    return (
      <>
        <div className="auction-review">
          <header className="auction-review-header">
            <div>
              <span className="auction-review-eyebrow">AUCTION REQUEST</span>
              <h1>Review your auction</h1>
            </div>
          </header>
          <EmptyState
            icon={<Cpu size={26} />}
            title="No request to review yet"
            description="Describe the resources you need to get started."
          >
            <Link href="/new/vm" className="button primary">
              New environment
              <ArrowRight size={16} />
            </Link>
          </EmptyState>
        </div>
      </>
    );
  const resourcesValid =
    Number.isInteger(draft.requirements.cpu) &&
    draft.requirements.cpu >= 1 &&
    draft.requirements.cpu <= 1024 &&
    Number.isFinite(draft.requirements.memoryGb) &&
    draft.requirements.memoryGb > 0 &&
    draft.requirements.memoryGb <= 16384;
  const canSubmit = Boolean(
    admission &&
    !diskPending &&
    resourcesValid &&
    isMoneyCents(draft.maxPriceCents) &&
    draft.maxPriceCents >= MIN_ORDER_PRICE_CENTS,
  );
  const matchingProviders = new Set(matches.map((item) => item.provider).filter(Boolean)).size;
  const noMatch = diskPending
    ? ''
    : draft.diskId && !disks.data?.enabled
      ? disks.error || 'Disk support is currently unavailable. Remove the disk or try again later.'
      : !matches.length
        ? draft.diskId
          ? 'No disk-compatible configurations meet these requirements. Adjust your resources or rental duration, or remove the disk.'
          : 'No available configurations meet these requirements. Adjust your resources or rental duration.'
        : '';
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!draft || !admission || !canSubmit) return;
    setBusy(true);
    setError('');
    try {
      const request = await post<EnvironmentRequest>('/api/requests', {
        description:
          draft.description.trim() ||
          `${draft.requirements.cpu} vCPU, ${draft.requirements.memoryGb} GiB environment`,
        ...(draft.diskId ? { diskId: draft.diskId } : {}),
        catalogId: admission.id,
        region: 'any',
        matchAcrossProviders: true,
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
    <div className="auction-review">
      <Link href="/new/vm" className="back-link">
        <ChevronLeft size={16} />
        Back to description
      </Link>
      <header className="auction-review-header">
        <div>
          <span className="auction-review-eyebrow">AUCTION REQUEST</span>
          <h1>Review your auction</h1>
          <p>Define what you need. Let the best eligible offer win.</p>
        </div>
        <span className="auction-review-step">Step 2 of 3</span>
      </header>
      <form onSubmit={submit} className="auction-review-layout">
        <div className="auction-review-main">
          <section className="auction-review-panel" aria-label="Auction requirements">
            <div className="auction-review-section">
              <div className="auction-review-section-heading">
                <h2>Environment requirements</h2>
                <p>Set the minimum. Compatible providers compete to meet it.</p>
              </div>
              <label className="field" htmlFor="review-description">
                <span>Your requirement</span>
                <textarea
                  id="review-description"
                  rows={3}
                  maxLength={4000}
                  value={draft.description}
                  onChange={(e) => update({ description: e.target.value })}
                  placeholder="What will you use this environment for?"
                />
              </label>
              <div className="auction-review-resources">
                <label className="field" htmlFor="cpus">
                  <span>Minimum vCPUs</span>
                  <div className="auction-review-input-unit">
                    <input
                      id="cpus"
                      aria-label="Minimum vCPUs"
                      type="number"
                      min={1}
                      max={1024}
                      step={1}
                      value={draft.requirements.cpu || ''}
                      onChange={(e) =>
                        update({
                          requirements: { ...draft.requirements, cpu: Number(e.target.value) },
                        })
                      }
                      required
                    />
                    <span aria-hidden="true">vCPU</span>
                  </div>
                </label>
                <label className="field" htmlFor="memory">
                  <span>Minimum memory (GiB)</span>
                  <div className="auction-review-input-unit">
                    <input
                      id="memory"
                      aria-label="Minimum memory (GiB)"
                      type="number"
                      min={Number.MIN_VALUE}
                      max={16384}
                      step="any"
                      value={draft.requirements.memoryGb || ''}
                      onChange={(e) =>
                        update({
                          requirements: { ...draft.requirements, memoryGb: Number(e.target.value) },
                        })
                      }
                      required
                    />
                    <span aria-hidden="true">GiB</span>
                  </div>
                </label>
              </div>
              {draft.requirements.gpu && (
                <p className="field-hint">
                  GPU required:{' '}
                  {draft.requirements.gpu === 'any' ? 'Any GPU' : draft.requirements.gpu}
                </p>
              )}
              <div className="field">
                <span id="duration-label">Rental duration</span>
                <div
                  className="auction-review-duration"
                  role="group"
                  aria-labelledby="duration-label"
                >
                  {[15, 30, 60].map((minutes) => (
                    <button
                      key={minutes}
                      type="button"
                      aria-pressed={draft.durationMinutes === minutes}
                      disabled={
                        busy || !approved.some((item) => item.durationMinutes.includes(minutes))
                      }
                      onClick={() => update({ durationMinutes: minutes })}
                    >
                      {minutes} minutes
                    </button>
                  ))}
                </div>
              </div>
            </div>
            <div className="auction-review-section auction-review-storage">
              <DiskPicker
                value={draft.diskId ?? ''}
                options={disks.data}
                onChange={(diskId) => update({ diskId: diskId || undefined })}
              />
              <p className="field-hint">
                {draft.diskId
                  ? 'Your files persist. Only configurations that support this disk can bid.'
                  : 'Use a temporary workspace, or attach a disk to keep files between rentals.'}
              </p>
            </div>
            <div className="auction-review-section auction-review-budget">
              <div className="auction-review-section-heading">
                <h2>Your budget</h2>
                <p>A ceiling for the entire rental, including setup time.</p>
              </div>
              <MoneyInput
                id="max-price"
                label="Maximum total price (USD)"
                value={draft.maxPriceCents}
                onChange={(maxPriceCents) => update({ maxPriceCents })}
                min={MIN_ORDER_PRICE_CENTS}
              />
              <p className="field-hint">The lowest eligible bid wins. No extra buyer fee.</p>
            </div>
          </section>
          {draft.receipt && (
            <details className="auction-review-receipt">
              <summary>
                <Sparkles size={15} />
                How Muse prepared this request
              </summary>
              <div className="auction-review-receipt-content">
                <ReceiptCard receipt={draft.receipt} mode={draft.museMode} />
              </div>
            </details>
          )}
          <ErrorBox
            error={noMatch || error}
            retry={draft.diskId && disks.error ? disks.reload : undefined}
          />
        </div>
        <aside className="auction-review-aside">
          <section className="auction-review-summary" aria-label="Auction summary">
            <div className="auction-review-summary-heading">
              <h2>Ready for bids</h2>
              <p>Open to all compatible providers</p>
            </div>
            <dl className="auction-review-specs">
              <div>
                <dt>Compute</dt>
                <dd>{draft.requirements.cpu || '—'} vCPU minimum</dd>
              </div>
              <div>
                <dt>Memory</dt>
                <dd>{draft.requirements.memoryGb || '—'} GiB minimum</dd>
              </div>
              {draft.requirements.gpu && (
                <div>
                  <dt>GPU</dt>
                  <dd>{draft.requirements.gpu === 'any' ? 'Any GPU' : draft.requirements.gpu}</dd>
                </div>
              )}
              <div>
                <dt>Duration</dt>
                <dd>{draft.durationMinutes} minutes</dd>
              </div>
              <div>
                <dt>Workspace</dt>
                <dd>{draft.diskId ? 'Persistent disk' : 'Temporary'}</dd>
              </div>
            </dl>
            <div className="auction-review-matches">
              <strong>
                {diskPending
                  ? 'Checking compatibility…'
                  : `${matches.length} matching configuration${matches.length === 1 ? '' : 's'}`}
              </strong>
              <span>
                {matchingProviders
                  ? `Across ${matchingProviders} provider${matchingProviders === 1 ? '' : 's'}. `
                  : ''}
                Availability is confirmed when providers bid.
              </span>
            </div>
            <div className="auction-review-total">
              <span>Maximum total</span>
              <strong>{money(draft.maxPriceCents)}</strong>
              <small>USD · entire rental</small>
            </div>
            <button
              type="submit"
              className="button primary auction-review-submit"
              disabled={busy || !canSubmit}
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
            <div className="auction-review-explainer">
              <Clock3 size={15} />
              <p>Providers have 30 seconds to bid. The lowest eligible offer wins automatically.</p>
            </div>
            <div className="auction-review-explainer">
              <ShieldCheck size={15} />
              <p>Your accepted offer locks the rental price. The rental clock includes setup.</p>
            </div>
            <p className="demo-price-note">
              {modes.wick === 'real' ? 'Wick-backed environments' : 'Simulated demo supply'} · No
              payment due
            </p>
          </section>
        </aside>
      </form>
    </div>
  );
}
