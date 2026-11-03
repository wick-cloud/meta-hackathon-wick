import { useState, type FormEvent } from 'react';
import { ArrowRight, BarChart3, Check, CheckCircle2, ShieldCheck, Sparkles } from 'lucide-react';
import type { SalesReport } from '../shared/sales';
import type { SupplierPolicy } from '../shared/types';
import { ApiError, dateTime, money, museLabel, post, put } from './api';
import {
  ErrorBox,
  Link,
  MarketDialog,
  PageHeader,
  Spinner,
  SuccessBox,
  useSession,
} from './components';
import { FormPanel, FormSection } from './form-layout';
import './sales.css';

type Recommendation = SalesReport['recommendations'][number];
type ApplyAttempt = SupplierPolicy & { expectedRevision: number; operationKey: string };

const goals = [
  'Help me reach more suitable buyer requests.',
  'Find pricing changes that could help my idle capacity sell.',
  'Explain what is limiting my sales while preserving my price floor and spare slots.',
];

function policyRows(before: SupplierPolicy, after: SupplierPolicy, names: Record<string, string>) {
  const allowed = (value: SupplierPolicy) =>
    value.allowedCatalogIds === undefined
      ? 'All approved configurations'
      : value.allowedCatalogIds.length
        ? [...value.allowedCatalogIds]
            .sort()
            .map((id) => names[id] ?? id)
            .join(', ')
        : 'No configurations';
  const priceLimit = (value: number | undefined) =>
    value === undefined ? 'No ceiling' : money(value);
  return [
    {
      label: 'Base rental price',
      before: money(before.basePriceCents),
      after: money(after.basePriceCents),
    },
    {
      label: 'Minimum rental price',
      before: money(before.minimumPriceCents),
      after: money(after.minimumPriceCents),
    },
    {
      label: 'Maximum rental price',
      before: priceLimit(before.maxPriceCents),
      after: priceLimit(after.maxPriceCents),
    },
    {
      label: 'Spare slots',
      before: String(before.reserveSlots ?? 0),
      after: String(after.reserveSlots ?? 0),
    },
    {
      label: 'Automatic bids & counteroffers',
      before: before.autoBid ? 'On' : 'Off',
      after: after.autoBid ? 'On' : 'Off',
    },
    { label: 'Allowed configurations', before: allowed(before), after: allowed(after) },
  ];
}

function PolicyComparison({
  report,
  recommendation,
}: {
  report: SalesReport;
  recommendation: Recommendation;
}) {
  return (
    <div
      className="sales-policy-table-wrap"
      tabIndex={0}
      role="region"
      aria-label="Policy comparison"
    >
      <table className="sales-policy-table">
        <caption className="sr-only">Current and recommended policy settings</caption>
        <thead>
          <tr>
            <th scope="col">Setting</th>
            <th scope="col">Current</th>
            <th scope="col">Proposed</th>
          </tr>
        </thead>
        <tbody>
          {policyRows(report.currentPolicy, recommendation.policy, report.catalogNames).map(
            (row) => (
              <tr
                key={row.label}
                className={row.before !== row.after ? 'sales-policy-changed' : undefined}
              >
                <th scope="row">{row.label}</th>
                <td>{row.before}</td>
                <td>
                  {row.after}
                  {row.before !== row.after && <span className="sales-changed-label">Change</span>}
                </td>
              </tr>
            ),
          )}
        </tbody>
      </table>
    </div>
  );
}

function MatchComparison({ recommendation }: { recommendation: Recommendation }) {
  const { sampledRequests, currentMatches, proposedMatches } = recommendation.comparison;
  return (
    <div className="sales-match-comparison">
      <div>
        <span className="sales-small-label">Base-price matches</span>
        <div
          className="sales-match-numbers"
          aria-label={`${currentMatches} current matches, ${proposedMatches} proposed matches`}
        >
          <span>
            {currentMatches}
            <small>Current</small>
          </span>
          <ArrowRight size={18} aria-hidden="true" />
          <span>
            {proposedMatches}
            <small>Proposed</small>
          </span>
        </div>
      </div>
      <p>
        Compared against {sampledRequests} recent {sampledRequests === 1 ? 'request' : 'requests'}.
        Matches are not predicted wins.
      </p>
    </div>
  );
}

export function ProviderSales() {
  const { modes } = useSession();
  const [goal, setGoal] = useState('');
  const [report, setReport] = useState<SalesReport | null>(null);
  const [selected, setSelected] = useState<Recommendation | null>(null);
  const [attempt, setAttempt] = useState<ApplyAttempt | null>(null);
  const [busy, setBusy] = useState<'analyze' | 'apply' | ''>('');
  const [error, setError] = useState('');
  const [applyError, setApplyError] = useState('');
  const [saved, setSaved] = useState('');
  const locked = !!attempt || busy === 'apply';

  async function analyze(event: FormEvent) {
    event.preventDefault();
    if (busy || locked || !goal.trim()) return;
    setBusy('analyze');
    setError('');
    setSaved('');
    setReport(null);
    setSelected(null);
    try {
      setReport(await post<SalesReport>('/api/provider/sales/propose', { goal: goal.trim() }));
    } catch (err) {
      setError(
        err instanceof Error ? err.message : 'Muse could not prepare recommendations. Try again.',
      );
    } finally {
      setBusy('');
    }
  }

  function review(recommendation: Recommendation) {
    if (busy || locked) return;
    setApplyError('');
    setSelected(recommendation);
  }

  async function apply() {
    if (!selected || !report || busy) return;
    const pending = attempt ?? {
      ...selected.policy,
      expectedRevision: report.baseRevision,
      operationKey: crypto.randomUUID(),
    };
    setAttempt(pending);
    setBusy('apply');
    setApplyError('');
    try {
      await put<{ policy: SupplierPolicy; policyRevision: number }>(
        '/api/provider/policy',
        pending,
      );
      setSaved(`${selected.title} applied. Your selling policy is updated.`);
      setSelected(null);
      setReport(null);
      setAttempt(null);
    } catch (err) {
      const definitive =
        err instanceof ApiError && [400, 401, 403, 404, 409, 422, 429].includes(err.status);
      if (definitive) setAttempt(null);
      if (err instanceof ApiError && err.status === 409) {
        setSelected(null);
        setReport(null);
        setError(
          'Your policy or capacity changed. Generate fresh recommendations before applying a change.',
        );
      } else {
        setApplyError(
          definitive
            ? err.message
            : 'The result of Apply is not confirmed. Retry the same change to recover its result before continuing.',
        );
      }
    } finally {
      setBusy('');
    }
  }

  const modelStatus = report
    ? report.mode === 'fixture'
      ? 'Fixture recommendations · no Meta call'
      : report.modelCalled
        ? `${museLabel} · model called`
        : 'Checked by Broker · no Meta call'
    : modes.muse === 'fixture'
      ? 'Fixture Muse · no model calls'
      : museLabel;

  return (
    <div className="form-page provider-page sales-page">
      <PageHeader
        eyebrow="SELLER ADVISOR"
        title="Improve my sales"
        description="Turn recent demand and your selling history into a policy you can review."
      >
        <span className="quiet-badge">{modelStatus}</span>
      </PageHeader>

      <FormPanel className="sales-goal-panel">
        <div className="sales-goal-heading">
          <span className="sales-advisor-icon">
            <Sparkles size={22} aria-hidden="true" />
          </span>
          <div>
            <h2>What would you like to improve?</h2>
            <p>
              Muse considers your goal, available capacity, recent bids and relevant buyer demand.
            </p>
          </div>
        </div>
        <form onSubmit={(event) => void analyze(event)}>
          <label className="field" htmlFor="sales-goal">
            <span>Your selling goal</span>
            <textarea
              id="sales-goal"
              value={goal}
              onChange={(event) => setGoal(event.target.value)}
              placeholder="Help my idle capacity sell while preserving my price floor and spare slots."
              maxLength={1000}
              rows={3}
              disabled={!!busy || locked}
              required
            />
          </label>
          <div className="sales-goal-examples" aria-label="Example selling goals">
            {goals.map((example, i) => (
              <button
                key={example}
                type="button"
                disabled={!!busy || locked}
                onClick={() => setGoal(example)}
              >
                {['Reach more buyers', 'Review my pricing', 'Understand missed sales'][i]}
              </button>
            ))}
          </div>
          <div className="sales-generate-actions">
            <p>
              <ShieldCheck size={16} aria-hidden="true" /> Your price floor and spare slots stay
              protected. You review each change.
            </p>
            <button className="button primary" disabled={!!busy || locked || !goal.trim()}>
              {busy === 'analyze' ? (
                <Spinner label="Analyzing sales" />
              ) : (
                <>
                  <Sparkles size={16} />
                  {report ? 'Refresh recommendations' : 'Get recommendations'}
                </>
              )}
            </button>
          </div>
        </form>
      </FormPanel>

      <ErrorBox error={error} />
      {saved && (
        <SuccessBox>
          {saved}{' '}
          <Link className="text-link" href="/provider/policy">
            View policy <ArrowRight size={14} />
          </Link>
        </SuccessBox>
      )}

      {busy === 'analyze' && (
        <div className="sales-analysis-status" role="status">
          <BarChart3 size={20} aria-hidden="true" />
          <div>
            <strong>Reviewing your selling opportunities</strong>
            <p>Comparing your current policy with recent demand. Your settings stay as they are.</p>
          </div>
        </div>
      )}

      {!report && !busy && !saved && (
        <div className="sales-intro-grid">
          {[
            [
              '01',
              'Understand the evidence',
              'Review your recent bid outcomes, available slots and relevant demand.',
            ],
            [
              '02',
              'Compare your options',
              'See the exact policy changes and how they match recent requests.',
            ],
            [
              '03',
              'Choose what to apply',
              'Apply one recommendation after reviewing it. Existing commitments stay binding.',
            ],
          ].map(([step, title, description]) => (
            <div className="sales-intro-step" key={step}>
              <span>{step}</span>
              <h3>{title}</h3>
              <p>{description}</p>
            </div>
          ))}
        </div>
      )}

      {report && (
        <div className="sales-report" aria-live="polite">
          <div className="sales-report-heading">
            <div>
              <span className="sales-small-label">YOUR SALES REVIEW</span>
              <h2>
                {report.recommendations.length ? 'Options worth reviewing' : 'No changes to review'}
              </h2>
            </div>
            <span className="sales-report-date">Prepared {dateTime(report.generatedAt)}</span>
          </div>
          <p className="sales-summary">{report.summary}</p>
          <div className="sales-capacity-strip" aria-label="Reviewed capacity">
            <span>
              <strong>{report.capacity.available}</strong> slots available
            </span>
            <span>
              <strong>{report.capacity.held}</strong> slots held
            </span>
            <span>
              <strong>{report.currentPolicy.reserveSlots ?? 0}</strong> spare slots protected
            </span>
            {report.sourceMode === 'fixture' && (
              <span className="quiet-badge">Simulated marketplace data</span>
            )}
          </div>

          {report.recommendations.length ? (
            <div className="sales-recommendations">
              {report.recommendations.map((recommendation, i) => (
                <section
                  className="sales-recommendation"
                  key={recommendation.id}
                  aria-labelledby={`sales-option-${i}`}
                >
                  <div className="sales-recommendation-heading">
                    <span className="sales-option-number">{String(i + 1).padStart(2, '0')}</span>
                    <div>
                      <h3 id={`sales-option-${i}`}>{recommendation.title}</h3>
                      <p>{recommendation.description}</p>
                    </div>
                  </div>
                  <p className="sales-explanation">{recommendation.explanation}</p>
                  <MatchComparison recommendation={recommendation} />
                  <div className="sales-recommendation-footer">
                    <div className="sales-evidence-links" aria-label="Supporting evidence">
                      {recommendation.evidenceIds.map((id) => {
                        const evidence = report.evidence.find((item) => item.id === id);
                        return evidence ? (
                          <a key={id} href={`#sales-evidence-${id}`}>
                            {evidence.label}
                          </a>
                        ) : null;
                      })}
                    </div>
                    <button
                      className="button secondary"
                      disabled={!!busy || locked}
                      onClick={() => review(recommendation)}
                    >
                      Review changes <ArrowRight size={15} />
                    </button>
                  </div>
                </section>
              ))}
            </div>
          ) : (
            <div className="sales-no-changes">
              <CheckCircle2 size={22} />
              <div>
                <h3>No policy change recommended</h3>
                <p>
                  You can review the evidence below or try another goal as more sales data becomes
                  available.
                </p>
              </div>
            </div>
          )}

          <FormPanel>
            <FormSection
              title="Evidence behind this review"
              description="Recorded facts and server-calculated comparisons from this account's review."
            >
              <dl className="sales-evidence-list">
                {report.evidence.map((item) => (
                  <div key={item.id} id={`sales-evidence-${item.id}`} tabIndex={-1}>
                    <dt>{item.label}</dt>
                    <dd>{item.detail}</dd>
                  </div>
                ))}
              </dl>
            </FormSection>
          </FormPanel>
          <details className="sales-limitations">
            <summary>How to read these recommendations</summary>
            <p>
              Base-price matches compare recent requests using the reviewed settings. They do not
              replay historical capacity, guarantee a bid, or predict wins or revenue.
            </p>
            <ul>
              {report.limitations.map((limitation, i) => (
                <li key={i}>{limitation}</li>
              ))}
            </ul>
          </details>
        </div>
      )}

      {selected && report && (
        <MarketDialog
          titleId="sales-review-title"
          onClose={() => {
            if (!locked) setSelected(null);
          }}
          busy={locked}
          size="wide"
        >
          <div className="sales-dialog-layout">
            <div className="sales-dialog-body">
              <span className="sales-small-label">REVIEW BEFORE APPLYING</span>
              <h2 id="sales-review-title">{selected.title}</h2>
              <p>{selected.explanation}</p>
              {!report.currentPolicy.autoBid && selected.policy.autoBid && (
                <p className="sales-automation-notice">
                  <ShieldCheck size={17} />
                  Applying enables automatic bids and counteroffers under the proposed limits.
                </p>
              )}
              <PolicyComparison report={report} recommendation={selected} />
              <MatchComparison recommendation={selected} />
              <p>
                These settings apply to future selling decisions. Existing bids and reservations
                remain binding. Other recommendations will need a fresh review after this change.
              </p>
            </div>
            <ErrorBox error={applyError} />
            <div className="sales-dialog-actions">
              <button
                type="button"
                className="button secondary"
                disabled={locked}
                onClick={() => setSelected(null)}
              >
                Back to recommendations
              </button>
              <button
                type="button"
                className="button primary"
                disabled={!!busy}
                onClick={() => void apply()}
              >
                {busy === 'apply' ? (
                  <Spinner label="Applying change" />
                ) : attempt ? (
                  'Retry same change'
                ) : (
                  <>
                    <Check size={16} />
                    Apply this change
                  </>
                )}
              </button>
            </div>
          </div>
        </MarketDialog>
      )}
    </div>
  );
}
