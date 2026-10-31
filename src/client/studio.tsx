import { useEffect, useRef, useState, type FormEvent } from 'react';
import {
  ArrowLeft,
  ArrowRight,
  Check,
  Clock3,
  FileDiff,
  FlaskConical,
  GitBranch,
  Plus,
  Server,
  ShieldCheck,
  Sparkles,
  Square,
  Wallet,
  ExternalLink,
} from 'lucide-react';
import type { StudioTask, StudioDetail, StudioStatus } from '../shared/studio';
import type { StudioUsage } from '../shared/studio-usage';
import { usdToCents } from '../shared/money';
import { money, post, dateTime, DEFAULT_PRICE_USD } from './api';
import {
  ErrorBox,
  Link,
  MarketDialog,
  PageHeader,
  Spinner,
  remaining,
  useNavigate,
  useNow,
  useResource,
} from './components';
import { TableViewport } from './table';
import './studio.css';

const finished = (s: StudioStatus) => ['completed', 'failed', 'stopped'].includes(s);
const names: Record<StudioStatus, string> = {
  queued: 'Preparing',
  model_auction: 'Securing model allowance',
  planning: 'Meta is planning',
  compute_auction: 'Compute auction',
  provisioning: 'Preparing the VM',
  running: 'Working',
  verifying: 'Verifying',
  cleaning_up: 'Cleaning up',
  needs_budget: 'Needs funding',
  needs_attention: 'Needs attention',
  completed: 'Completed',
  failed: 'Failed',
  stopped: 'Stopped',
};
const Meta = () => (
  <span className="studio-meta">
    <Sparkles size={14} />
    Powered by Meta Muse
  </span>
);
const Status = ({ task }: { task: StudioTask }) => (
  <span className={`studio-status ${task.status}`} role="status">
    {!finished(task.status) && !task.status.startsWith('needs_') && <span className="studio-dot" />}
    {names[task.status]}
  </span>
);
function Budget({
  task,
}: {
  task: Pick<
    StudioTask,
    'budgetCents' | 'spentCents' | 'reservedCents' | 'availableCents' | 'returnedCents'
  >;
}) {
  const percent = Math.min(100, Math.max(0, (task.spentCents / task.budgetCents) * 100));
  return (
    <section className="studio-card studio-budget" aria-label="Task budget">
      <div className="studio-section-head">
        <span>
          <Wallet size={16} />
          Task budget
        </span>
        <strong>{money(task.budgetCents)} maximum</strong>
      </div>
      <div
        className="studio-budget-bar"
        role="img"
        aria-label={`${money(task.spentCents)} spent from ${money(task.budgetCents)}`}
      >
        <span style={{ width: percent + '%' }} />
      </div>
      <dl className="studio-budget-values">
        <div>
          <dt>Spent</dt>
          <dd>{money(task.spentCents)}</dd>
        </div>
        <div>
          <dt>Reserved</dt>
          <dd>{money(task.reservedCents)}</dd>
        </div>
        <div>
          <dt>{task.returnedCents ? 'Returned' : 'Available'}</dt>
          <dd>{money(task.returnedCents || task.availableCents)}</dd>
        </div>
      </dl>
      <p>Compute and prepaid model purchases share this limit.</p>
    </section>
  );
}
export function Studio({ search = '' }: { search?: string }) {
  const navigate = useNavigate(),
    params = new URLSearchParams(search),
    cursor = params.get('cursor');
  const list = useResource<{ items: StudioTask[]; nextCursor: string | null }>(
    '/api/studio/tasks?limit=25' + (cursor ? '&cursor=' + encodeURIComponent(cursor) : ''),
    5000,
  );
  const options = useResource<{ mode: 'fixture' | 'real'; available: boolean; reason: string }>(
    '/api/studio/options',
  );
  const wallet = useResource<{ availableCents: number }>('/api/credits', 5000);
  const [compose, setCompose] = useState(params.get('new') === '1'),
    [goal, setGoal] = useState(''),
    [repo, setRepo] = useState(''),
    [budget, setBudget] = useState(DEFAULT_PRICE_USD),
    [duration, setDuration] = useState('30'),
    [instant, setInstant] = useState(true),
    [test, setTest] = useState(''),
    [review, setReview] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const operation = useRef(crypto.randomUUID()),
    amount = usdToCents(budget);
  function change() {
    operation.current = crypto.randomUUID();
    setError('');
  }
  function prepare(e: FormEvent) {
    e.preventDefault();
    setError('');
    try {
      const url = new URL(repo);
      if (
        url.protocol !== 'https:' ||
        url.hostname !== 'github.com' ||
        url.username ||
        url.password ||
        url.search ||
        url.hash ||
        !/^\/[A-Za-z0-9-]+\/[A-Za-z0-9_.-]+\/?$/.test(url.pathname)
      )
        throw Error('Use a public https://github.com/owner/repository URL.');
      if (amount === undefined || amount < 1) throw Error('Enter a valid task budget.');
      if (wallet.data && amount > wallet.data.availableCents)
        throw Error('Add available Broker credit before starting this task.');
      setReview(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Check the task details.');
    }
  }
  async function start() {
    setBusy(true);
    setError('');
    try {
      const task = await post<StudioTask>('/api/studio/tasks', {
        operationKey: operation.current,
        goal,
        repositoryUrl: repo,
        budgetCents: amount,
        durationMinutes: Number(duration),
        allowInstant: instant,
        ...(test.trim() ? { testCommand: test.trim() } : {}),
      });
      navigate('/studio/tasks/' + task.id);
    } catch (e) {
      setReview(false);
      setError(e instanceof Error ? e.message : 'Could not start the task.');
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="studio-page">
      <PageHeader
        eyebrow="MUSE STUDIO"
        title="Give it a task. Set a budget."
        description="Meta plans the work. Broker secures the resources. Wick provides the workspace."
      >
        <Meta />
        {!compose && (
          <button
            className="button primary"
            onClick={() => {
              setCompose(true);
              change();
            }}
          >
            <Plus size={16} />
            New task
          </button>
        )}
      </PageHeader>
      <ErrorBox error={error || list.error || options.error} />
      {options.data?.mode === 'fixture' && (
        <div className="studio-notice">
          Fixture demo · purchases, model responses, and VMs are simulated.
        </div>
      )}
      {options.data && !options.data.available && (
        <div className="studio-notice" role="status">
          {options.data.reason || 'Automatic task execution is unavailable.'}
        </div>
      )}
      {(compose || list.data?.items.length === 0) && (
        <div className="studio-compose">
          <form className="studio-card studio-form" onSubmit={prepare}>
            <div className="studio-section-head">
              <h2>What should we accomplish?</h2>
              <span className="studio-tag">Public repositories</span>
            </div>
            <label className="field">
              <span>Task</span>
              <textarea
                required
                minLength={10}
                maxLength={4000}
                rows={4}
                placeholder="Fix the failing authentication tests and verify the changes."
                value={goal}
                onChange={(e) => {
                  setGoal(e.target.value);
                  change();
                }}
              />
            </label>
            <label className="field">
              <span>Public repository</span>
              <input
                required
                type="url"
                placeholder="https://github.com/company/project"
                value={repo}
                onChange={(e) => {
                  setRepo(e.target.value);
                  change();
                }}
              />
            </label>
            <div className="studio-form-row">
              <label className="field">
                <span>Maximum total spend · USD</span>
                <input
                  required
                  inputMode="decimal"
                  value={budget}
                  onChange={(e) => {
                    setBudget(e.target.value);
                    change();
                  }}
                />
              </label>
              <label className="field">
                <span>Time limit</span>
                <select
                  value={duration}
                  onChange={(e) => {
                    setDuration(e.target.value);
                    change();
                  }}
                >
                  <option value="15">15 minutes</option>
                  <option value="30">30 minutes</option>
                  <option value="60">60 minutes</option>
                </select>
              </label>
            </div>
            <div className="studio-credit">
              <span>{money(wallet.data?.availableCents ?? 0)} available credit</span>
              <Link href="/credits">
                View wallet
                <ArrowRight size={13} />
              </Link>
            </div>
            <label className="studio-checkbox">
              <input
                type="checkbox"
                checked={instant}
                onChange={(e) => {
                  setInstant(e.target.checked);
                  change();
                }}
              />
              <span>Use instant model pricing if an auction has no offers</span>
            </label>
            <details className="studio-advanced">
              <summary>Advanced · completion checks</summary>
              <label className="field">
                <span>Test command · optional</span>
                <input
                  maxLength={500}
                  placeholder="Let Meta identify the project’s tests"
                  value={test}
                  onChange={(e) => {
                    setTest(e.target.value);
                    change();
                  }}
                />
              </label>
              <p>
                Studio freezes the test command before execution. Tests run in an isolated workspace
                without network access.
              </p>
            </details>
            <div className="studio-form-foot">
              <p>
                Starting authorizes Studio to buy compute and model allowance within your budget and
                prepare a disposable VM.
              </p>
              <button className="button primary" disabled={busy || !options.data?.available}>
                <Sparkles size={16} />
                {`Start task · ${money(amount ?? 0)} maximum`}
              </button>
              {compose && (
                <button type="button" className="button ghost" onClick={() => setCompose(false)}>
                  Cancel
                </button>
              )}
            </div>
          </form>
          <aside className="studio-card studio-explainer">
            <Meta />
            <h2>From brief to verified result.</h2>
            <ol>
              <li>
                <span>1</span>
                <div>
                  <strong>Plan the work</strong>
                  <p>Meta reads the project context and chooses compute and tests.</p>
                </div>
              </li>
              <li>
                <span>2</span>
                <div>
                  <strong>Let providers compete</strong>
                  <p>
                    Broker runs the auctions and checks every purchase against your remaining
                    budget.
                  </p>
                </div>
              </li>
              <li>
                <span>3</span>
                <div>
                  <strong>Run in a Wick VM</strong>
                  <p>Studio confirms setup, edits files, and tracks actual command receipts.</p>
                </div>
              </li>
              <li>
                <span>4</span>
                <div>
                  <strong>Verify and clean up</strong>
                  <p>
                    Get the patch, test output, and final cost. The disposable VM is terminated.
                  </p>
                </div>
              </li>
            </ol>
            <div className="studio-assurance">
              <ShieldCheck size={17} />
              <p>
                Unused funding returns after cleanup. Purchased model allowance is prepaid and
                unused quota is non-refundable.
              </p>
            </div>
          </aside>
        </div>
      )}
      <section className="studio-card studio-history">
        <div className="studio-section-head">
          <div>
            <h2>Your tasks</h2>
            <p>One saved record for the budget, purchases, work, and result.</p>
          </div>
          <Link href="/studio/legacy">
            Previous coding jobs
            <ArrowRight size={14} />
          </Link>
        </div>
        {list.loading && !list.data ? (
          <Spinner label="Loading tasks" />
        ) : list.data?.items.length ? (
          <TableViewport label="Studio tasks">
            <table className="studio-table">
              <thead>
                <tr>
                  <th>Task</th>
                  <th>Status</th>
                  <th>Budget</th>
                  <th>Spent</th>
                  <th>Created</th>
                  <th>
                    <span className="sr-only">Open</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {list.data.items.map((t) => (
                  <tr key={t.id}>
                    <td>
                      <Link href={'/studio/tasks/' + t.id}>{t.goal.slice(0, 85)}</Link>
                      <small>{t.repositoryUrl.replace('https://github.com/', '')}</small>
                    </td>
                    <td>
                      <Status task={t} />
                    </td>
                    <td>{money(t.budgetCents)}</td>
                    <td>{money(t.spentCents)}</td>
                    <td>{dateTime(t.createdAt)}</td>
                    <td>
                      <Link
                        aria-label={'Open task ' + t.goal.slice(0, 40)}
                        href={'/studio/tasks/' + t.id}
                      >
                        <ArrowRight size={16} />
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableViewport>
        ) : (
          <div className="studio-empty">
            <Sparkles size={25} />
            <h3>Your first task starts with a brief.</h3>
            <p>Studio handles the VM and model purchases for you.</p>
          </div>
        )}
        <div className="studio-pagination">
          {cursor && <Link href="/studio">Newest tasks</Link>}
          {list.data?.nextCursor && (
            <Link href={'/studio?cursor=' + encodeURIComponent(list.data.nextCursor)}>
              Older tasks
              <ArrowRight size={14} />
            </Link>
          )}
        </div>
      </section>
      {review && (
        <MarketDialog titleId="studio-review" busy={busy} onClose={() => setReview(false)}>
          <h2 id="studio-review">Start this task?</h2>
          <p>
            Studio will plan, purchase resources, execute the task, verify the result, and clean up.
          </p>
          <dl className="studio-review">
            <div>
              <dt>Maximum spend</dt>
              <dd>{money(amount ?? 0)}</dd>
            </div>
            <div>
              <dt>Time limit</dt>
              <dd>{duration} minutes</dd>
            </div>
            <div>
              <dt>Repository</dt>
              <dd>{repo}</dd>
            </div>
            <div>
              <dt>Instant model fallback</dt>
              <dd>{instant ? 'Allowed within budget' : 'Disabled'}</dd>
            </div>
          </dl>
          <p className="studio-fine">
            Includes paid planning, prepaid model allowance, and the accepted VM rental. Unspent
            funding is returned after cleanup; unused prepaid quota is non-refundable.
          </p>
          <div className="studio-actions">
            <button className="button secondary" disabled={busy} onClick={() => setReview(false)}>
              Back
            </button>
            <button className="button primary" disabled={busy} onClick={start}>
              {busy ? (
                <Spinner label="Reserving task budget" />
              ) : (
                <>
                  <Sparkles size={16} />
                  Start within {money(amount ?? 0)}
                </>
              )}
            </button>
          </div>
        </MarketDialog>
      )}
    </div>
  );
}
function Journey({ task, secured }: { task: StudioTask; secured: boolean }) {
  const current = task.status;
  const phases = [
    {
      title: 'Secure model allowance',
      done: secured,
      active: ['queued', 'model_auction'].includes(current),
    },
    { title: 'Meta prepares the plan', done: !!task.plan, active: current === 'planning' },
    {
      title: 'Buy and prepare compute',
      done: !!task.executionStartedAt,
      active: ['compute_auction', 'provisioning'].includes(current),
    },
    { title: 'Execute the task', done: !!task.verifiedAt, active: current === 'running' },
    { title: 'Verify the result', done: !!task.verifiedAt, active: current === 'verifying' },
    { title: 'Confirm cleanup', done: finished(current), active: current === 'cleaning_up' },
  ];
  return (
    <ol className="studio-journey" aria-label="Task progress">
      {phases.map((p, i) => (
        <li key={p.title} className={p.done ? 'done' : p.active ? 'active' : ''}>
          <span>{p.done ? <Check size={14} /> : i + 1}</span>
          <div>
            <strong>{p.title}</strong>
            {p.active && <small>In progress</small>}
          </div>
        </li>
      ))}
    </ol>
  );
}
function UsageEstimate({ usage }: { usage: StudioUsage }) {
  const f = usage.forecast,
    count = (n: number) => n.toLocaleString('en-US');
  const percent = (used: number, bought: number) =>
    bought ? `${((used / bought) * 100).toFixed(1)}%` : '—';
  return (
    <section className="studio-card studio-usage" aria-label="Model usage estimate">
      <div className="studio-section-head">
        <h2>Model usage</h2>
        <span className="studio-tag">90% target</span>
      </div>
      <p>
        {f.basis === 'learned'
          ? `Learned from ${f.trainingSamples} completed tasks in your account.`
          : 'Initial estimate · learning from completed tasks.'}{' '}
        Includes model reasoning.
      </p>
      <div className="studio-usage-grid" role="table" aria-label="Token forecast and usage">
        <div role="row">
          <span role="columnheader">Tokens</span>
          <span role="columnheader">Input</span>
          <span role="columnheader">Output</span>
        </div>
        <div role="row">
          <span role="rowheader">Expected task</span>
          <strong role="cell">{count(f.expectedInput)}</strong>
          <strong role="cell">{count(f.expectedOutput)}</strong>
        </div>
        <div role="row">
          <span role="rowheader">Used so far</span>
          <strong role="cell">{count(usage.settledInput)}</strong>
          <strong role="cell">{count(usage.settledOutput)}</strong>
        </div>
        <div role="row">
          <span role="rowheader">Purchased</span>
          <span role="cell">{count(usage.purchasedInput)}</span>
          <span role="cell">{count(usage.purchasedOutput)}</span>
        </div>
        <div role="row">
          <span role="rowheader">Utilization</span>
          <span role="cell">{percent(usage.settledInput, usage.purchasedInput)}</span>
          <span role="cell">{percent(usage.settledOutput, usage.purchasedOutput)}</span>
        </div>
      </div>
      {usage.unresolvedCalls > 0 && (
        <p role="status">
          {usage.unresolvedCalls} model {usage.unresolvedCalls === 1 ? 'call has' : 'calls have'}{' '}
          unresolved usage. Totals include settled usage only.
        </p>
      )}
      {usage.reservationLimited && (
        <p className="studio-usage-floor">
          Provider reservation requirements increase the allowance above the forecast. The 90%
          target cannot be reached while those requirements dominate.
        </p>
      )}
      <details>
        <summary>How this purchase was sized</summary>
        <p>
          Allowance {usage.purchaseRound + 1}: {count(usage.purchaseInput)} input /{' '}
          {count(usage.purchaseOutput)} output tokens. It includes room for a final call and targets
          90% utilization where provider requirements permit. This is a forecast, not a token limit
          or a spending guarantee.
        </p>
        <p>
          Per-call reservation: {count(usage.inputReservationFloor)} input /{' '}
          {count(usage.outputReservationFloor)} output tokens. Additional purchases must fit your
          remaining task budget.
        </p>
        <p>
          {f.validation
            ? `Held-out check: ${f.validation.samples} tasks; input error ${(f.validation.inputError * 100).toFixed(1)}%, output error ${(f.validation.outputError * 100).toFixed(1)}%.`
            : 'Not enough completed tasks for a held-out accuracy measurement yet.'}
        </p>
      </details>
    </section>
  );
}
export function StudioTaskPage({ id }: { id: string }) {
  const [poll, setPoll] = useState(2000),
    detail = useResource<StudioDetail>('/api/studio/tasks/' + id, poll),
    [tab, setTab] = useState<'activity' | 'changes' | 'tests' | 'purchases'>('activity'),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [fund, setFund] = useState(DEFAULT_PRICE_USD);
  const now = useNow(),
    task = detail.data?.task;
  useEffect(() => {
    setPoll(task && finished(task.status) ? 0 : 2000);
  }, [task?.status]);
  async function act(action: string) {
    setBusy(true);
    setError('');
    try {
      await post(
        '/api/studio/tasks/' + id + '/' + action,
        action === 'fund'
          ? { amountCents: usdToCents(fund), operationKey: crypto.randomUUID() }
          : {},
      );
      detail.reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not update the task.');
    } finally {
      setBusy(false);
    }
  }
  if (!task || !detail.data)
    return (
      <div className="studio-page">
        <ErrorBox error={detail.error} />
        {detail.loading && <Spinner label="Loading task" />}
      </div>
    );
  const data = detail.data,
    auction = data.computeAuction,
    modelOpen = data.modelPurchases.find((p) => p.status === 'open');
  return (
    <div className="studio-page">
      <Link className="back-link" href="/studio">
        <ArrowLeft size={14} />
        Back to Studio
      </Link>
      <PageHeader
        eyebrow={'TASK · ' + task.id.slice(0, 8)}
        title={task.goal.length > 120 ? task.goal.slice(0, 117) + '…' : task.goal}
        description={
          task.repositoryUrl.replace('https://github.com/', '') + ' · ' + task.commitSha.slice(0, 8)
        }
      >
        <Meta />
        <Status task={task} />
        {!finished(task.status) && (
          <button
            className="button secondary"
            disabled={busy || task.status === 'cleaning_up'}
            onClick={() => act('stop')}
          >
            <Square size={13} />
            Stop task
          </button>
        )}
      </PageHeader>
      <ErrorBox error={error || detail.error} />
      {task.mode === 'fixture' && (
        <div className="studio-notice">Fixture task · no live purchases or provider VMs.</div>
      )}
      <div className="studio-task-layout">
        <div className="studio-task-main">
          <Budget task={task} />
          {task.blockedReason && (
            <div
              className={'studio-notice ' + (task.status.startsWith('needs_') ? 'attention' : '')}
              role="status"
            >
              {task.blockedReason}
            </div>
          )}
          {data.planning && (data.planning.failureCode || task.status === 'needs_attention') && (
            <section className="studio-card" aria-label="Planning recovery">
              <div className="studio-section-head">
                <h3>Planning response</h3>
                <span className="studio-tag">Attempt {data.planning.attempt} of 2</span>
              </div>
              <p>
                Request: {data.planning.requestStatus.replaceAll('_', ' ')}
                {data.planning.finishReason && ` · Finish reason: ${data.planning.finishReason}`}
                {data.planning.outputTokens != null &&
                  ` · ${data.planning.outputTokens.toLocaleString('en-US')} output tokens used`}
              </p>
              <p>
                {data.planning.hasSavedResponse
                  ? 'A saved response is available. Recovery validates it before considering another model call.'
                  : data.planning.canRetry
                    ? 'A retry uses existing prepaid quota and the original deadline. It does not buy another token pack or VM.'
                    : [
                          'reserved',
                          'dispatching',
                          'outcome_unknown',
                          'needs_reconciliation',
                        ].includes(data.planning.requestStatus)
                      ? 'Usage is still unresolved. Keep the original receipt; a replacement call will not be sent.'
                      : data.planning.attempt >= 2
                        ? 'The single planning repair has been used. Stop the task to return unspent funding; existing prepaid purchases remain payable.'
                        : 'No new VM has been purchased. Stop the task to return unspent funding, or inspect the planning receipt.'}
              </p>
              {data.planning.canRetry && (
                <button
                  className="button primary"
                  disabled={busy}
                  onClick={() => act('retry-plan')}
                >
                  {data.planning.hasSavedResponse
                    ? 'Resume saved planning response'
                    : 'Retry planning with existing quota'}
                </button>
              )}
            </section>
          )}
          {task.status === 'needs_budget' && (
            <section className="studio-card studio-funding">
              <h3>More funding is needed</h3>
              <p>
                Muse cannot increase its own budget. Adding funding keeps the original deadline.
              </p>
              <div className="studio-actions">
                <label className="field">
                  <span>Add to budget · USD</span>
                  <input
                    inputMode="decimal"
                    value={fund}
                    onChange={(e) => setFund(e.target.value)}
                  />
                </label>
                <button
                  className="button primary"
                  disabled={busy || usdToCents(fund) === undefined}
                  onClick={() => act('fund')}
                >
                  Add funding and continue
                </button>
              </div>
            </section>
          )}
          {(auction?.status === 'open' || modelOpen) && (
            <div className="studio-auctions">
              {modelOpen && (
                <section className="studio-card">
                  <span className="studio-kicker">MODEL AUCTION</span>
                  <strong className="studio-countdown">
                    {Date.parse(modelOpen.closesAt) <= now
                      ? 'Selecting a provider…'
                      : remaining(modelOpen.closesAt, now)}
                  </strong>
                  <p>Providers are competing for model allowance.</p>
                  <Link href={'/token-orders/' + modelOpen.id}>
                    Open live auction
                    <ArrowRight size={14} />
                  </Link>
                </section>
              )}
              {auction?.status === 'open' && (
                <section className="studio-card">
                  <span className="studio-kicker">COMPUTE AUCTION</span>
                  <strong className="studio-countdown">
                    {Date.parse(auction.closesAt) <= now
                      ? 'Selecting a provider…'
                      : remaining(auction.closesAt, now)}
                  </strong>
                  <p>
                    {auction.bids.length} provider {auction.bids.length === 1 ? 'bid' : 'bids'}
                  </p>
                  {auction.bids.map((b, i) => (
                    <div className="studio-bid" key={i}>
                      <span>{b.provider}</span>
                      <strong>{money(b.priceCents)}</strong>
                    </div>
                  ))}
                  <Link href={'/requests/' + auction.id}>
                    Open live auction
                    <ArrowRight size={14} />
                  </Link>
                </section>
              )}
            </div>
          )}
          <section className="studio-card studio-result">
            <div className="studio-tabs" role="tablist" aria-label="Task details">
              {(['activity', 'changes', 'tests', 'purchases'] as const).map((t) => (
                <button
                  id={'studio-tab-' + t}
                  role="tab"
                  aria-controls="studio-tab-panel"
                  aria-selected={tab === t}
                  className={tab === t ? 'active' : ''}
                  key={t}
                  onClick={() => setTab(t)}
                >
                  {t === 'changes' ? (
                    <FileDiff size={15} />
                  ) : t === 'tests' ? (
                    <FlaskConical size={15} />
                  ) : t === 'purchases' ? (
                    <Wallet size={15} />
                  ) : (
                    <Sparkles size={15} />
                  )}
                  {
                    {
                      activity: 'Activity',
                      changes: 'Changes',
                      tests: 'Tests',
                      purchases: 'Purchases',
                    }[t]
                  }
                </button>
              ))}
            </div>
            <div id="studio-tab-panel" role="tabpanel" aria-labelledby={'studio-tab-' + tab}>
              {tab === 'activity' && (
                <div className="studio-events">
                  {data.events.map((e) => (
                    <article key={e.id}>
                      <span className={'studio-event-icon ' + e.kind}>
                        {e.kind === 'meta' ? (
                          <Sparkles size={15} />
                        ) : e.kind === 'cleanup' || e.kind === 'verification' ? (
                          <Check size={15} />
                        ) : (
                          <Clock3 size={15} />
                        )}
                      </span>
                      <div>
                        <div className="studio-event-head">
                          <h3>{e.title}</h3>
                          <time>{dateTime(e.createdAt)}</time>
                        </div>
                        <p>{e.message}</p>
                      </div>
                    </article>
                  ))}
                  {data.modelActivity.length > 0 && (
                    <details className="studio-receipts">
                      <summary>Meta model receipts · {data.modelActivity.length}</summary>
                      {data.modelActivity.map((r) => (
                        <div className="studio-receipt" key={r.id}>
                          <span>
                            <Sparkles size={13} />
                            {r.provider} · {r.phase}
                          </span>
                          <strong>{r.status}</strong>
                          <code>{r.id}</code>
                        </div>
                      ))}
                    </details>
                  )}
                  {!data.events.length && (
                    <div className="studio-empty">
                      <Spinner label="Preparing the task" />
                    </div>
                  )}
                </div>
              )}
              {tab === 'changes' &&
                (task.hasPatch ? (
                  <>
                    <div className="studio-section-head">
                      <h3>Verified patch</h3>
                      <a
                        className="button secondary"
                        href={'/api/studio/tasks/' + id + '/patch'}
                        download
                      >
                        Download patch
                        <ArrowRight size={14} />
                      </a>
                    </div>
                    <p>{task.summary}</p>
                    <pre className="studio-output studio-diff">{data.patch}</pre>
                    <p className="studio-fine">
                      Review the retained patch before applying it. Studio does not push to the
                      source repository.
                    </p>
                  </>
                ) : (
                  <div className="studio-empty">
                    <FileDiff size={25} />
                    <h3>The result appears after verification.</h3>
                    <p>A complete patch and passing checks are required.</p>
                  </div>
                ))}
              {tab === 'tests' &&
                (data.tests ? (
                  <>
                    <div className="studio-section-head">
                      <h3>{data.tests.exitCode === 0 ? 'Checks passed' : 'Latest test result'}</h3>
                      <span className="studio-tag">Exit {data.tests.exitCode}</span>
                    </div>
                    <pre className="studio-output">
                      {data.tests.output || 'The command returned no output.'}
                    </pre>
                    <p className="studio-fine">
                      Guest command receipt · {dateTime(data.tests.completedAt)}
                      {task.verifiedAt ? ' · Verification confirmed after the final edit.' : ''}
                    </p>
                  </>
                ) : (
                  <div className="studio-empty">
                    <FlaskConical size={25} />
                    <h3>Waiting for the first test receipt.</h3>
                    <p>VM readiness alone does not confirm that the task has started.</p>
                  </div>
                ))}
              {tab === 'purchases' && (
                <>
                  <p className="studio-fine">
                    Each purchase was checked against this task’s remaining funds.
                  </p>
                  <div className="studio-purchase">
                    <span>
                      <Server size={16} />
                      Compute rental
                    </span>
                    <strong>{money(task.computeChargedCents)}</strong>
                    {auction && (
                      <Link href={'/requests/' + auction.id}>
                        {names[task.status] === 'Compute auction' ? 'Bidding' : auction.status}
                        <ExternalLink size={13} />
                      </Link>
                    )}
                  </div>
                  {data.modelPurchases.map((p) => (
                    <div className="studio-purchase" key={p.id}>
                      <span>
                        <Sparkles size={16} />
                        {p.provider || 'Model allowance'}
                      </span>
                      <strong>
                        {p.priceCents == null ? 'Awaiting bids' : money(p.priceCents)}
                      </strong>
                      <Link href={'/token-orders/' + p.id}>
                        {p.status}
                        <ExternalLink size={13} />
                      </Link>
                    </div>
                  ))}
                  <p className="studio-fine">
                    Spend includes prepaid quota, including any unused quota. There is no separate
                    buyer fee.
                  </p>
                </>
              )}
            </div>
          </section>
        </div>
        <aside className="studio-task-aside">
          {data.usage && <UsageEstimate usage={data.usage} />}
          <section className="studio-card">
            <div className="studio-section-head">
              <h2>Task journey</h2>
              <GitBranch size={16} />
            </div>
            <Journey
              task={task}
              secured={data.modelPurchases.some((p) => p.status === 'awarded')}
            />
            <div className="studio-deadline">
              <Clock3 size={15} />
              <span>{finished(task.status) ? 'Original deadline' : 'Time remaining'}</span>
              <strong>
                {finished(task.status)
                  ? dateTime(task.deadlineAt)
                  : remaining(task.deadlineAt, now)}
              </strong>
            </div>
          </section>
          {task.plan && (
            <section className="studio-card studio-plan">
              <Meta />
              <h3>Why this setup?</h3>
              <p>{task.plan.explanation}</p>
              <details>
                <summary>Completion check</summary>
                <code>{task.plan.testCommand}</code>
              </details>
            </section>
          )}
          <section className="studio-card studio-controls">
            {data.vm && (
              <Link href={'/vms/' + data.vm.id}>
                <Server size={16} />
                {data.vm.cleanupConfirmedAt ? 'VM cleanup confirmed' : 'Open VM and terminal'}
                <ArrowRight size={14} />
              </Link>
            )}
            {task.codingJobId && (
              <Link href={'/studio/jobs/' + task.codingJobId}>
                Execution receipts
                <ArrowRight size={14} />
              </Link>
            )}
            {!finished(task.status) && (
              <>
                {task.status === 'needs_attention' && !data.planning && (
                  <button
                    className="button secondary"
                    disabled={busy}
                    onClick={() => act('resume')}
                  >
                    Resume after review
                  </button>
                )}
                <p>
                  Stopping cancels pending purchases and requests VM cleanup. Existing commitments
                  remain payable.
                </p>
              </>
            )}
          </section>
        </aside>
      </div>
    </div>
  );
}
