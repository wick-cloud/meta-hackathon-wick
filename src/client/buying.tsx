import { useEffect, useRef, useState, type FormEvent } from 'react';
import { ArrowRight, CircleCheck, Pause, Play, ShieldCheck, Sparkles } from 'lucide-react';
import type {
  BuyingDecision,
  BuyingPolicy,
  BuyingPolicyInput,
  BuyingWorkspace,
} from '../shared/buying';
import type { InferenceGrantDetail, TokenOrder } from '../shared/inference';
import { dateTime, money, post, put } from './api';
import {
  DetailRow,
  ErrorBox,
  Link,
  MarketDialog,
  MoneyInput,
  Spinner,
  useNavigate,
  useNow,
  useResource,
} from './components';
import './buying.css';

const modes = {
  suggest: 'Suggestions only',
  review: 'Review each purchase',
  automatic: 'Automatic within limits',
};
const count = (n: number) => n.toLocaleString('en-US');
const errorMessage = (e: unknown) =>
  e instanceof Error ? e.message : 'This action could not be confirmed.';
export function AgentBuying({
  detail,
  tab,
  onChanged,
}: {
  detail: InferenceGrantDetail;
  tab: string;
  onChanged: () => void;
}) {
  const { grant } = detail,
    now = useNow(),
    navigate = useNavigate();
  const resource = useResource<BuyingWorkspace>(`/api/inference/grants/${grant.id}/buying`, 5000);
  const [draft, setDraft] = useState<BuyingPolicyInput | null>(null),
    [review, setReview] = useState(false),
    [confirm, setConfirm] = useState<BuyingDecision | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const operation = useRef<{ body: string; key: string } | null>(null);
  const data = resource.data,
    policy = data?.policy,
    latest = data?.decisions[0];
  const active = grant.status === 'active' && Date.parse(grant.expiresAt) > now;
  useEffect(() => {
    if (!data || draft) return;
    setDraft({
      operationKey: '',
      expectedRevision: policy?.revision ?? 0,
      mode: policy?.mode ?? 'review',
      paused: policy?.paused ?? false,
      maxPurchaseCents: policy?.maxPurchaseCents ?? grant.maxPurchaseCents,
      outputPerCall:
        policy?.outputPerCall ??
        Math.min(
          512,
          ...detail.catalog.routes.filter((r) => r.qualified).map((r) => r.maximumOutputTokens),
        ),
      targetCalls: policy?.targetCalls ?? 1,
      refillAtCalls: policy?.refillAtCalls ?? 1,
      allowInstant: policy?.allowInstant ?? false,
    });
  }, [data, draft, policy, grant.maxPurchaseCents, detail.catalog.routes]);
  const stale = !!draft && draft.expectedRevision !== (policy?.revision ?? 0);
  function change<K extends keyof BuyingPolicyInput>(key: K, value: BuyingPolicyInput[K]) {
    setReview(false);
    setDraft((old) => (old ? { ...old, [key]: value } : old));
  }
  async function save(input: BuyingPolicyInput) {
    setBusy(true);
    setError('');
    const clean = {
      expectedRevision: input.expectedRevision,
      mode: input.mode,
      paused: input.paused,
      maxPurchaseCents: input.maxPurchaseCents,
      outputPerCall: input.outputPerCall,
      targetCalls: input.targetCalls,
      refillAtCalls: input.refillAtCalls,
      allowInstant: input.allowInstant,
    };
    const body = JSON.stringify(clean);
    if (operation.current?.body !== body) operation.current = { body, key: crypto.randomUUID() };
    try {
      const saved = await put<BuyingPolicy>(`/api/inference/grants/${grant.id}/buying`, {
        ...clean,
        operationKey: operation.current.key,
      });
      operation.current = null;
      setDraft({ ...clean, operationKey: '', expectedRevision: saved.revision });
      setReview(false);
      await resource.reload();
      onChanged();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  async function evaluate() {
    setBusy(true);
    setError('');
    try {
      await post(`/api/inference/grants/${grant.id}/buying/evaluate`, {});
      await resource.reload();
    } catch (e) {
      setError(errorMessage(e));
      await resource.reload();
    } finally {
      setBusy(false);
    }
  }
  async function accept() {
    if (!confirm) return;
    setBusy(true);
    setError('');
    try {
      const order = await post<TokenOrder>(`/api/inference/grants/${grant.id}/buying/accept`, {
        decisionId: confirm.id,
      });
      navigate(`/token-orders/${order.id}`);
    } catch (e) {
      setError(errorMessage(e));
      await resource.reload();
    } finally {
      setBusy(false);
    }
  }
  const eligible =
    latest?.status === 'recommended' &&
    Date.parse(latest.expiresAt) > now &&
    latest.policyRevision === policy?.revision &&
    !policy?.paused;
  const allowance = data?.allowance;
  const currentPolicy = (
    <section className="card buying-policy-summary">
      <div className="buying-section-heading">
        <h2>Buying policy</h2>
        {policy && (
          <span className="buying-badge">{policy.paused ? 'Paused' : modes[policy.mode]}</span>
        )}
      </div>
      <DetailRow label="Per-purchase ceiling">
        {money(policy?.maxPurchaseCents ?? grant.maxPurchaseCents)}
      </DetailRow>
      <DetailRow label="Allowed providers">
        {grant.allowedProviders.map((p) => (p === 'modal' ? 'Modal' : 'Baseten')).join(' · ')}
      </DetailRow>
      <DetailRow label="Instant fallback">
        {policy?.allowInstant ? 'Within saved limits' : 'Off'}
      </DetailRow>
      <DetailRow label="Expiry">{dateTime(grant.expiresAt)}</DetailRow>
      <p className="buying-note">
        Only you can add funds. Purchases keep this fixed expiry. No VM purchasing permission is
        granted.
      </p>
      <div className="buying-actions">
        <Link className="text-link" href={`/agents/${grant.id}?tab=policy`}>
          Manage limits <ArrowRight size={14} />
        </Link>
        {policy && (
          <button
            className="button secondary small"
            disabled={busy || !active}
            onClick={() =>
              void save({
                operationKey: '',
                expectedRevision: policy.revision,
                ...policy,
                paused: !policy.paused,
              } as BuyingPolicyInput)
            }
          >
            {policy.paused ? <Play size={13} /> : <Pause size={13} />}{' '}
            {policy.paused ? 'Resume buying' : 'Pause buying'}
          </button>
        )}
      </div>
    </section>
  );
  const allowancePanel = (
    <section className="card buying-allowance">
      <div className="buying-section-heading">
        <h2>Purchased allowance</h2>
        <Link href={`/agents/${grant.id}?tab=activity`} className="text-link">
          View batches
        </Link>
      </div>
      {allowance ? (
        <>
          <DetailRow label="Eligible calls">
            <strong>{count(allowance.eligibleCalls)}</strong> at {count(allowance.outputPerCall)}{' '}
            output / call
          </DetailRow>
          <DetailRow label="Available input">{count(allowance.availableInputTokens)}</DetailRow>
          <DetailRow label="Available output">{count(allowance.availableOutputTokens)}</DetailRow>
          <div className="buying-note">
            Call counts use qualified input bounds, or the conservative fixture request bound, and
            the configured output cap. Quota from different packs is not combined.
          </div>
          <DetailRow label="Unresolved usage">{allowance.unresolvedRequests} requests</DetailRow>
          <small>
            {count(allowance.heldInputTokens)} input · {count(allowance.heldOutputTokens)} output
            reserved for in-flight or unresolved requests.
          </small>
        </>
      ) : (
        <Spinner label="Loading allowance" />
      )}
    </section>
  );
  return (
    <div className="buying-workspace">
      <ErrorBox error={resource.error} retry={resource.reload} />
      <ErrorBox error={error} />
      {resource.loading && <Spinner label="Loading buying workspace" />}
      {tab === 'overview' && data && (
        <div className="buying-grid">
          <div className="buying-stack">
            <section className="card buying-recommendation">
              <div className="buying-section-heading">
                <span className="buying-muse">
                  <Sparkles size={16} /> Muse purchasing assistant
                </span>
                <span className="buying-badge">
                  {policy?.paused ? 'Paused' : policy ? modes[policy.mode] : 'Not configured'}
                </span>
              </div>
              <h2>
                {latest?.status === 'ordered'
                  ? 'Your next pack is purchased.'
                  : eligible
                    ? 'A purchase ready for your review.'
                    : !policy
                      ? 'A budget with buying boundaries.'
                      : 'Buy only what your agent can use.'}
              </h2>
              <p>
                {latest?.reason ??
                  'Set a buying policy. Muse can recommend a pack using your remaining allowance, approved routes, and fixed expiry.'}
              </p>
              {latest?.candidate && (
                <div className="buying-candidate">
                  <DetailRow label="Recommended allowance">
                    {count(latest.candidate.inputTokens)} input ·{' '}
                    {count(latest.candidate.outputTokens)} output
                  </DetailRow>
                  <DetailRow label="Purchase method">
                    {latest.candidate.mode === 'auction' ? '30-second auction' : 'Instant quote'}
                  </DetailRow>
                  <DetailRow label="Maximum purchase">
                    {money(latest.candidate.maxTotalCents)}
                  </DetailRow>
                  <DetailRow label="Pack expiry">{dateTime(grant.expiresAt)}</DetailRow>
                </div>
              )}
              <div className="buying-actions">
                {latest?.orderId ? (
                  <Link className="button primary" href={`/token-orders/${latest.orderId}`}>
                    Open purchase <ArrowRight size={15} />
                  </Link>
                ) : eligible ? (
                  <button
                    className="button primary"
                    disabled={busy || !active}
                    onClick={() => setConfirm(latest!)}
                  >
                    Review purchase <ArrowRight size={15} />
                  </button>
                ) : policy ? (
                  <button
                    className="button primary"
                    disabled={
                      busy ||
                      !active ||
                      policy.paused ||
                      (latest?.status === 'evaluating' && Date.parse(latest.expiresAt) > now) ||
                      Date.parse(policy.nextEvaluationAt) > now
                    }
                    onClick={() => void evaluate()}
                  >
                    {busy ? (
                      <Spinner label="Evaluating" />
                    ) : (
                      <>
                        <Sparkles size={15} /> Get Muse recommendation
                      </>
                    )}
                  </button>
                ) : (
                  <Link className="button primary" href={`/agents/${grant.id}?tab=policy`}>
                    Set buying policy
                  </Link>
                )}
                <Link className="text-link" href={`/token-orders/new?grantId=${grant.id}`}>
                  Buy manually
                </Link>
              </div>
              <small>
                {latest?.mode === 'fixture'
                  ? 'Fixture recommendation · no model call.'
                  : latest?.modelCalled
                    ? 'Real Muse evaluation attempted · see the outcome above.'
                    : 'No model decision has been claimed.'}{' '}
                Decisions are limited to one per minute, up to 20 per grant.
              </small>
              {latest?.status === 'recommended' && !eligible && (
                <p className="buying-warning">
                  This recommendation expired or its policy changed. Request a fresh one before
                  buying.
                </p>
              )}
            </section>
            <DecisionHistory decisions={data.decisions.slice(0, 3)} />
          </div>
          <aside className="buying-stack">
            {allowancePanel}
            {currentPolicy}
          </aside>
        </div>
      )}
      {tab === 'policy' && draft && (
        <div className="buying-grid">
          <form
            className="card buying-form"
            onSubmit={(e: FormEvent) => {
              e.preventDefault();
              setReview(true);
            }}
          >
            <div className="buying-section-heading">
              <h2>Purchase controls</h2>
              <span className="buying-badge">Draft changes</span>
            </div>
            {stale && (
              <div className="buying-warning">
                The policy changed while you were editing.{' '}
                <button
                  type="button"
                  className="text-button"
                  onClick={() => {
                    setDraft(null);
                    setReview(false);
                  }}
                >
                  Reload policy
                </button>
              </div>
            )}
            <fieldset disabled={busy || !active || stale}>
              <legend>How should purchases happen?</legend>
              <div className="buying-choices">
                {(['suggest', 'review', 'automatic'] as const).map((mode) => (
                  <label className="buying-choice" key={mode}>
                    <input
                      type="radio"
                      name="buying-mode"
                      checked={draft.mode === mode}
                      onChange={() => change('mode', mode)}
                    />
                    <span>
                      {modes[mode]}
                      <small>
                        {mode === 'automatic'
                          ? 'The worker may purchase within these owner-approved limits.'
                          : mode === 'review'
                            ? 'Review the exact allowance and price ceiling before committing.'
                            : 'Muse recommends; you choose when to purchase.'}
                      </small>
                    </span>
                  </label>
                ))}
              </div>
              <div className="buying-form-grid">
                <MoneyInput
                  id="buying-ceiling"
                  label="Maximum per purchase"
                  value={draft.maxPurchaseCents}
                  min={0.01}
                  onChange={(v) => change('maxPurchaseCents', v)}
                />
                <label className="field">
                  <span>Output limit per request</span>
                  <input
                    type="number"
                    min={1}
                    max={8192}
                    required
                    value={draft.outputPerCall}
                    onChange={(e) => change('outputPerCall', Number(e.target.value))}
                  />
                </label>
                <label className="field">
                  <span>Buy up to this many calls</span>
                  <input
                    type="number"
                    min={1}
                    max={8}
                    required
                    value={draft.targetCalls}
                    onChange={(e) => change('targetCalls', Number(e.target.value))}
                  />
                </label>
                <label className="field">
                  <span>Refill at calls remaining</span>
                  <input
                    type="number"
                    min={0}
                    max={8}
                    required
                    value={draft.refillAtCalls}
                    onChange={(e) => change('refillAtCalls', Number(e.target.value))}
                  />
                </label>
              </div>
              <label className="buying-check">
                <input
                  type="checkbox"
                  checked={draft.allowInstant}
                  disabled={!grant.allowInstant}
                  onChange={(e) => change('allowInstant', e.target.checked)}
                />
                <span>
                  Allow an instant purchase when no usable call remains
                  <small>Requires original grant permission and the same spending ceiling.</small>
                </span>
              </label>
              <label className="buying-check">
                <input
                  type="checkbox"
                  checked={draft.paused}
                  onChange={(e) => change('paused', e.target.checked)}
                />{' '}
                Pause new recommendations and automatic purchases
              </label>
              <div className="buying-form-footer">
                <small>Only the owner can change these controls.</small>
                <button className="button primary">
                  Review changes <ArrowRight size={15} />
                </button>
              </div>
            </fieldset>
          </form>
          <aside className="buying-stack">
            {currentPolicy}
            <section className="card">
              <h2>Enforced before every purchase</h2>
              <ul className="buying-rules">
                <li>Grant budget, per-purchase limit, and fixed expiry.</li>
                <li>Qualified route and usable input/output allowance.</li>
                <li>One pending purchase; no replacement of uncertain inference.</li>
                <li>No automatic funding or VM permissions.</li>
              </ul>
              <p className="buying-note">
                Your agent keeps running in its own environment. Broker manages purchasing and
                prepaid inference.
              </p>
            </section>
          </aside>
        </div>
      )}
      {tab === 'activity' && data && <DecisionHistory decisions={data.decisions} />}
      {review && draft && (
        <MarketDialog titleId="buying-review-title" onClose={() => setReview(false)} busy={busy}>
          <h2 id="buying-review-title">Review buying policy</h2>
          <DetailRow label="Mode">{modes[draft.mode]}</DetailRow>
          <DetailRow label="Maximum per purchase">{money(draft.maxPurchaseCents)}</DetailRow>
          <DetailRow label="Funded budget">{money(grant.fundedCents)}</DetailRow>
          <DetailRow label="Expires">{dateTime(grant.expiresAt)}</DetailRow>
          <p className="buying-note">
            {draft.mode === 'automatic'
              ? 'Saving authorizes the buying worker to initiate purchases under these limits.'
              : 'Each purchase still requires your action.'}{' '}
            No funds are added and no expiry changes.
          </p>
          <ErrorBox error={error} />
          <div className="buying-actions">
            <button className="button secondary" disabled={busy} onClick={() => setReview(false)}>
              Keep editing
            </button>
            <button
              className="button primary"
              disabled={busy || stale}
              onClick={() => void save(draft)}
            >
              {busy ? 'Saving…' : 'Save buying policy'}
            </button>
          </div>
        </MarketDialog>
      )}
      {confirm?.candidate && (
        <MarketDialog titleId="buying-accept-title" onClose={() => setConfirm(null)} busy={busy}>
          <h2 id="buying-accept-title">Review token purchase</h2>
          <DetailRow label="Input / output">
            {count(confirm.candidate.inputTokens)} / {count(confirm.candidate.outputTokens)}
          </DetailRow>
          <DetailRow label="Maximum total">{money(confirm.candidate.maxTotalCents)}</DetailRow>
          <DetailRow label="Buyer fee">{money(0)}</DetailRow>
          <DetailRow label="Pack expires">{dateTime(grant.expiresAt)}</DetailRow>
          <p className="buying-note">
            The ceiling is reserved from this grant. Unused prepaid quota is not automatically
            refundable.
          </p>
          <ErrorBox error={error} />
          <div className="buying-actions">
            <button className="button secondary" disabled={busy} onClick={() => setConfirm(null)}>
              Cancel
            </button>
            <button
              className="button primary"
              disabled={busy || Date.parse(confirm.expiresAt) <= now}
              onClick={() => void accept()}
            >
              {busy
                ? 'Placing order…'
                : confirm.candidate.mode === 'auction'
                  ? 'Start 30-second auction'
                  : 'Buy at instant price'}
            </button>
          </div>
        </MarketDialog>
      )}
    </div>
  );
}

function DecisionHistory({ decisions }: { decisions: BuyingDecision[] }) {
  return (
    <section className="card buying-history">
      <div className="buying-section-heading">
        <h2>Buying decisions</h2>
        <small>Latest {decisions.length}</small>
      </div>
      {decisions.length ? (
        decisions.map((d) => (
          <article key={d.id} className="buying-event">
            <span>
              {d.status === 'ordered' ? <CircleCheck size={16} /> : <Sparkles size={16} />}
            </span>
            <div>
              <div className="buying-event-heading">
                <strong>
                  {d.status === 'ordered'
                    ? 'Purchase placed'
                    : d.status === 'recommended'
                      ? 'Purchase recommended'
                      : d.status.replaceAll('_', ' ')}
                </strong>
                <time>{dateTime(d.createdAt)}</time>
              </div>
              <p>{d.reason}</p>
              {d.orderId && (
                <Link className="text-link" href={`/token-orders/${d.orderId}`}>
                  View order <ArrowRight size={13} />
                </Link>
              )}
            </div>
          </article>
        ))
      ) : (
        <p className="buying-note">
          Save a policy and request a recommendation. Every decision stays linked to its purchase.
        </p>
      )}
    </section>
  );
}

export function BuyingReceipt({ order }: { order: TokenOrder }) {
  const receipt = useResource<{ decision: BuyingDecision | null }>(
    `/api/token-orders/${order.id}/purchase-receipt`,
  );
  const d = receipt.data?.decision,
    baseline = d?.baseline;
  if (!d) return null;
  const same =
    baseline?.inputTokens === order.inputTokens &&
    baseline?.outputTokens === order.outputTokens &&
    baseline?.packExpiresAt === order.expiresAt;
  return (
    <section className="card buying-receipt">
      <div className="buying-section-heading">
        <h2>
          <ShieldCheck size={16} /> Purchase receipt
        </h2>
        <span className="buying-badge">
          {d.mode === 'fixture' ? 'Fixture decision' : 'Muse decision'}
        </span>
      </div>
      <p>{d.reason}</p>
      {baseline && same ? (
        <>
          <DetailRow label="Captured instant quote">{money(baseline.priceCents)}</DetailRow>
          <small>{dateTime(baseline.capturedAt)} · same allowance and expiry</small>
          {order.priceCents !== null && (
            <DetailRow label="Purchase saving">
              {money(baseline.priceCents - order.priceCents)}
            </DetailRow>
          )}
        </>
      ) : (
        <p className="buying-note">
          No comparable instant baseline was captured. Savings are not estimated.
        </p>
      )}
      <DetailRow
        label={
          order.priceCents === null
            ? order.status === 'open'
              ? 'Reserved ceiling'
              : 'Released purchase ceiling'
            : 'Charged once'
        }
      >
        {money(order.priceCents ?? order.maxTotalCents)}
      </DetailRow>
      <p className="buying-note">
        Purchase savings exclude the effect of unused or retired quota. Inference consumes prepaid
        tokens without another monetary charge.
      </p>
    </section>
  );
}
