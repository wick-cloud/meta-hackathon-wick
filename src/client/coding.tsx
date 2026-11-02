import { useEffect, useRef, useState, type FormEvent } from 'react';
import {
  ArrowLeft,
  ArrowRight,
  AlertTriangle,
  Check,
  X,
  Code2,
  Download,
  FileDiff,
  FlaskConical,
  GitBranch,
  Pause,
  Play,
  Plus,
  RefreshCw,
  Server,
  ShieldCheck,
  Sparkles,
  Square,
  TerminalSquare,
} from 'lucide-react';
import type { CodingDetail, CodingJob, CodingStep } from '../shared/coding';
import { dateTime, money, post } from './api';
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
import {
  TableViewport,
  TablePanel,
  TableTabs,
  TableFooter,
  TableIdentity,
  TableState,
  TableStatus,
} from './table';
import {
  baselineTest,
  codingPolling,
  jobState,
  stepState,
  testResult,
  type CodingTone,
} from './coding-state';
import './coding.css';

const labels: Record<string, string> = {
  queued: 'Queued',
  running: 'Working',
  paused: 'Paused',
  needs_allowance: 'Needs allowance',
  uncertain: 'Needs reconciliation',
  stopping: 'Stopping',
  stopped: 'Stopped',
  failed: 'Failed',
  ready: 'Ready for review',
};
const statusTone = (tone: CodingTone) =>
  tone === 'error' ? 'danger' : tone === 'active' ? 'info' : tone;
const finished = (job: CodingJob) => ['ready', 'failed', 'stopped'].includes(job.status);
const Meta = () => (
  <span className="coding-meta">
    <Sparkles size={15} />
    Meta Muse Spark Open
  </span>
);
function JobStatus({ job }: { job: CodingJob }) {
  return (
    <TableStatus
      role="status"
      tone={
        job.status === 'ready'
          ? 'success'
          : job.status === 'failed'
            ? 'danger'
            : ['needs_allowance', 'uncertain', 'paused'].includes(job.status)
              ? 'warning'
              : finished(job)
                ? 'neutral'
                : 'info'
      }
    >
      {labels[job.status]}
    </TableStatus>
  );
}
interface Options {
  vms: { id: string; name: string; provider: string; expires_at: string }[];
  grants: { id: string; name: string; available_cents: number; expires_at: string }[];
  mode: 'fixture' | 'real';
  executionAvailable: boolean;
  requirements: string;
}
export function CodingStudio({ search = '' }: { search?: string }) {
  const navigate = useNavigate(),
    params = new URLSearchParams(search),
    cursor = params.get('cursor');
  const options = useResource<Options>('/api/coding/options');
  const list = useResource<{ items: CodingJob[]; nextCursor: string | null }>(
    `/api/coding/jobs?limit=25${cursor ? '&cursor=' + encodeURIComponent(cursor) : ''}`,
    5000,
  );
  const [compose, setCompose] = useState(params.get('new') === '1'),
    [repo, setRepo] = useState(''),
    [ref, setRef] = useState(''),
    [goal, setGoal] = useState(''),
    [command, setCommand] = useState('python3 -m unittest discover -s tests'),
    [vm, setVm] = useState(''),
    [grant, setGrant] = useState(''),
    [review, setReview] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const operation = useRef(crypto.randomUUID());
  const data = options.data,
    vmId = vm || data?.vms[0]?.id || '',
    grantId = grant || data?.grants[0]?.id || '';
  function openReview(event: FormEvent) {
    event.preventDefault();
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
        throw new Error();
      setReview(true);
    } catch {
      setError('Use a public https://github.com/owner/repository URL.');
    }
  }
  async function start() {
    setBusy(true);
    setError('');
    try {
      const job = await post<CodingJob>('/api/coding/jobs', {
        operationKey: operation.current,
        repositoryUrl: repo,
        baseRef: ref,
        vmId,
        grantId,
        goal,
        testCommand: command,
      });
      navigate('/studio/jobs/' + job.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not start the coding job.');
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="coding-page">
      <PageHeader
        eyebrow="MUSE STUDIO"
        title="Turn a public repo into a working fix."
        description="Meta edits a job branch and runs tests inside your Wick VM."
      >
        <Meta />
        {!compose && (
          <button
            className="button primary"
            onClick={() => {
              setCompose(true);
              operation.current = crypto.randomUUID();
            }}
          >
            <Plus size={16} />
            New coding task
          </button>
        )}
      </PageHeader>
      <ErrorBox error={options.error || (list.data ? list.error : '')} />
      {data?.mode === 'fixture' && (
        <div className="coding-notice">
          Fixture environment: coding execution and Meta responses require explicit test adapters.
          No live provider calls are made here.
        </div>
      )}
      {compose && (
        <div className="coding-compose">
          <form className="coding-panel" onSubmit={openReview}>
            <div className="coding-title">
              <h2>What should Muse work on?</h2>
              <TableStatus>Public GitHub only</TableStatus>
            </div>
            <label className="field">
              <span>Public repository URL</span>
              <input
                type="url"
                required
                placeholder="https://github.com/owner/repository"
                value={repo}
                onChange={(e) => {
                  setRepo(e.target.value);
                  operation.current = crypto.randomUUID();
                }}
              />
            </label>
            <p className="coding-note">
              Broker verifies anonymous public access and pins the source commit before cloning.
            </p>
            <label className="field">
              <span>Task</span>
              <textarea
                required
                minLength={10}
                maxLength={4000}
                placeholder="Describe the bug or small feature, and what passing tests should prove."
                value={goal}
                onChange={(e) => {
                  setGoal(e.target.value);
                  operation.current = crypto.randomUUID();
                }}
              />
            </label>
            <div className="coding-fields">
              <label className="field">
                <span>Running Wick VM</span>
                <select
                  required
                  value={vmId}
                  onChange={(e) => {
                    setVm(e.target.value);
                    operation.current = crypto.randomUUID();
                  }}
                >
                  <option value="" disabled>
                    Select a VM
                  </option>
                  {data?.vms.map((v) => (
                    <option key={v.id} value={v.id}>
                      {v.name || v.id.slice(0, 8)} · {v.provider}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field">
                <span>Base branch or commit</span>
                <input
                  maxLength={100}
                  placeholder="Default branch"
                  value={ref}
                  onChange={(e) => {
                    setRef(e.target.value);
                    operation.current = crypto.randomUUID();
                  }}
                />
              </label>
            </div>
            <label className="field">
              <span>Funded agent</span>
              <select
                required
                value={grantId}
                onChange={(e) => {
                  setGrant(e.target.value);
                  operation.current = crypto.randomUUID();
                }}
              >
                <option value="" disabled>
                  Select an agent
                </option>
                {data?.grants.map((g) => (
                  <option key={g.id} value={g.id}>
                    {g.name} · {money(g.available_cents)} unspent
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>Test command</span>
              <input
                required
                maxLength={500}
                value={command}
                onChange={(e) => {
                  setCommand(e.target.value);
                  operation.current = crypto.randomUUID();
                }}
              />
            </label>
            <p className="coding-note">
              Tests use preinstalled tools and run without network access. Source edits stay in a
              fresh job clone.
            </p>
            <ErrorBox error={error} />
            <div className="coding-actions">
              <button
                className="button primary"
                disabled={busy || !data?.executionAvailable || !vmId || !grantId}
              >
                <Sparkles size={16} />
                Review coding task
              </button>
              <button type="button" className="button secondary" onClick={() => setCompose(false)}>
                Cancel
              </button>
            </div>
          </form>
          <aside className="coding-stack">
            <section className="coding-panel">
              <h2>Bounded by your allowance</h2>
              <dl className="coding-dl">
                <div>
                  <dt>Model</dt>
                  <dd>Meta Muse Spark Open</dd>
                </div>
                <div>
                  <dt>Job limit</dt>
                  <dd>Up to 10 minutes within VM and grant deadlines</dd>
                </div>
                <div>
                  <dt>Model allowance</dt>
                  <dd>Existing purchased allowance</dd>
                </div>
                <div>
                  <dt>Command limit</dt>
                  <dd>90 seconds</dd>
                </div>
                <div>
                  <dt>When quota runs low</dt>
                  <dd>Pause for another purchase</dd>
                </div>
              </dl>
              <p className="coding-note">
                Every model call consumes purchased tokens. VM rental is separate. All deadlines
                keep their original expiry.
              </p>
              <Link href="/agents">
                Manage agents and allowance <ArrowRight size={14} />
              </Link>
            </section>
            <section className="coding-panel">
              <h2>
                <ShieldCheck size={17} /> Workspace boundary
              </h2>
              <p className="coding-note">{data?.requirements || 'Checking available execution…'}</p>
              <p className="coding-note">
                Only the job clone and its output enter Meta context. Review or export the resulting
                patch before merging it.
              </p>
              {data && !data.executionAvailable && (
                <ErrorBox error="Structured coding execution is unavailable in this VM adapter. Fixture terminals cannot execute real repository jobs." />
              )}
              {data && !data.vms.length && (
                <Link href="/new/vm">
                  Rent a Wick VM <ArrowRight size={14} />
                </Link>
              )}
              {data && !data.grants.length && (
                <Link href="/agents">
                  Create a funded agent <ArrowRight size={14} />
                </Link>
              )}
            </section>
          </aside>
        </div>
      )}
      <TablePanel className="coding-history" label="Coding jobs">
        <TableTabs>
          <h2>Coding jobs</h2>
          <span className="coding-note">Saved across navigation and refresh</span>
        </TableTabs>
        {list.loading ? (
          <TableState loading title="Loading coding jobs" />
        ) : !list.data && list.error ? (
          <TableState error={list.error} onRetry={list.reload} />
        ) : !list.data?.items.length ? (
          <TableState
            title="Your next fix starts here."
            description="Pick a public repository, a VM, and a funded agent."
          >
            {!compose && (
              <button className="button primary" onClick={() => setCompose(true)}>
                Create a coding task
              </button>
            )}
          </TableState>
        ) : (
          <TableViewport label="Coding jobs" minWidth={680}>
            <table className="data-table" aria-label="Coding jobs">
              <thead>
                <tr>
                  <th scope="col">Task</th>
                  <th scope="col">Repository</th>
                  <th scope="col">Status</th>
                  <th scope="col" className="numeric-cell">
                    Meta calls
                  </th>
                  <th scope="col">Created</th>
                  <th scope="col" className="actions-cell">
                    <span className="sr-only">Action</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {list.data.items.map((job) => (
                  <tr key={job.id}>
                    <td>
                      <TableIdentity
                        title={<Link href={'/studio/jobs/' + job.id}>{job.goal.slice(0, 65)}</Link>}
                        subtitle={'CJ-' + job.id.slice(0, 8)}
                      />
                    </td>
                    <td>
                      {job.repositoryUrl.replace('https://github.com/', '')}
                      <small>{job.commitSha.slice(0, 8)}</small>
                    </td>
                    <td>
                      <JobStatus job={job} />
                    </td>
                    <td className="numeric-cell">{job.modelCalls}</td>
                    <td>{dateTime(job.createdAt)}</td>
                    <td className="actions-cell">
                      <Link className="table-open-link" href={'/studio/jobs/' + job.id}>
                        Open <ArrowRight size={14} />
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableViewport>
        )}
        <TableFooter count={list.data?.items.length} noun="jobs">
          {cursor && (
            <Link className="button secondary" href="/studio">
              Newest jobs
            </Link>
          )}
          {list.data?.nextCursor && (
            <Link
              className="button secondary"
              href={'/studio?cursor=' + encodeURIComponent(list.data.nextCursor)}
            >
              Older jobs <ArrowRight size={14} />
            </Link>
          )}
        </TableFooter>
      </TablePanel>
      {review && (
        <MarketDialog titleId="coding-review-title" onClose={() => setReview(false)} busy={busy}>
          <h2 id="coding-review-title">Review this coding task</h2>
          <p>Muse can edit the fresh clone and run your test command inside the selected VM.</p>
          <dl className="coding-dl">
            <div>
              <dt>Public repository</dt>
              <dd>{repo}</dd>
            </div>
            <div>
              <dt>Base ref</dt>
              <dd>{ref || 'Default branch'}</dd>
            </div>
            <div>
              <dt>Test command</dt>
              <dd>
                <code>{command}</code>
              </dd>
            </div>
            <div>
              <dt>Funding</dt>
              <dd>Existing purchased agent quota</dd>
            </div>
            <div>
              <dt>Limits</dt>
              <dd>Up to 10 minutes within VM and grant deadlines</dd>
            </div>
          </dl>
          <p className="coding-note">
            Selected repository files and command output are sent to Meta through your purchased
            route. The job pauses if no pack can cover the next call.
          </p>
          <ErrorBox error={error} />
          <div className="coding-actions">
            <button className="button secondary" disabled={busy} onClick={() => setReview(false)}>
              Cancel
            </button>
            <button className="button primary" disabled={busy} onClick={start}>
              {busy ? (
                <Spinner label="Checking public repository" />
              ) : (
                <>
                  <Sparkles size={16} />
                  Start coding task
                </>
              )}
            </button>
          </div>
        </MarketDialog>
      )}
    </div>
  );
}
const actionLabel = (step: CodingStep) =>
  ({
    clone: 'Clone and inspect public repo',
    read: 'Read selected file',
    write: 'Apply file change',
    test: 'Run test command',
    diff: 'Prepare review patch',
    model: 'Meta chooses the next action',
    expired: 'Artifact expired',
  })[step.action] || step.action;
function TestRun({ step, current = true }: { step: CodingStep; current?: boolean }) {
  const result = testResult(step),
    state = stepState(step);
  const stale = result?.exitCode === 0 && !current && state.tone === 'success';
  return (
    <section className="coding-test-result">
      <div className="coding-title">
        <h3>{baselineTest(step) ? 'Before changes' : 'After changes'}</h3>
        <TableStatus tone={stale ? 'warning' : statusTone(state.tone)}>
          {stale ? 'Fresh verification needed' : state.label}
        </TableStatus>
      </div>
      {state.message && <p className="coding-note">{state.message}</p>}
      {stale && (
        <p className="coding-note">This passing run does not verify the latest file state.</p>
      )}
      <p className="coding-note">
        Step {step.sequence + 1} · Exit {result?.exitCode ?? 'unavailable'}
      </p>
      <pre className="coding-code">
        {result?.output || String(step.result?.error || 'No command output was retained.')}
      </pre>
      {result?.truncated && (
        <p className="coding-note">Output was truncated at the retained limit.</p>
      )}
    </section>
  );
}
export function CodingJobPage({ id }: { id: string }) {
  const [poll, setPoll] = useState(3000);
  const detail = useResource<CodingDetail>('/api/coding/jobs/' + id, poll),
    [tab, setTab] = useState<'changes' | 'tests' | 'meta'>('changes'),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const now = useNow(
      !detail.data || !finished(detail.data.job) || detail.data.vm?.status === 'running',
    ),
    data = detail.data,
    job = data?.job;
  useEffect(() => {
    setPoll(codingPolling(data));
  }, [data]);
  async function control(action: string) {
    setBusy(true);
    setError('');
    try {
      await post('/api/coding/jobs/' + id + '/' + action, {});
      detail.reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not update execution.');
    } finally {
      setBusy(false);
    }
  }
  if (!job || !data)
    return (
      <div className="coding-page">
        <Link className="back-link" href="/studio">
          <ArrowLeft size={15} />
          Back to Studio
        </Link>
        {detail.loading ? (
          <Spinner label="Loading execution details" />
        ) : (
          <section className="coding-panel">
            <h2>Could not load execution details</h2>
            <p className="coding-note">
              Check your access and connection, then reload this saved job. Reloading does not start
              new work.
            </p>
            <ErrorBox error={detail.error} />
            <button className="button secondary" onClick={detail.reload}>
              Reload details
            </button>
          </section>
        )}
      </div>
    );
  const steps = data.steps,
    parent = data.parentTask,
    vm = data.vm,
    state = jobState(data, now),
    taskLink = parent ? '/studio/tasks/' + parent.id : '/studio/legacy',
    tests = steps.filter((s) => s.action === 'test' && s.result),
    latestTest = tests.at(-1),
    models = steps.filter((s) => s.kind === 'model'),
    patch = steps.findLast((s) => s.action === 'diff' && s.result)?.result?.result as
      { output?: string; truncated?: boolean } | undefined,
    canConnect = vm?.status === 'running' && !!vm.expiresAt && Date.parse(vm.expiresAt) > now,
    closed = finished(job),
    showCountdown = !closed && job.status !== 'uncertain' && Date.parse(job.deadlineAt) > now,
    shortGoal =
      job.goal.match(/^.{1,110}?[.!?](?:\s|$)/)?.[0].trim() ||
      (job.goal.length > 110 ? job.goal.slice(0, 107) + '…' : job.goal),
    settled = models.filter((s) => s.receipt?.status === 'settled').length;
  return (
    <div className="coding-page coding-execution">
      <Link className="back-link" href={taskLink}>
        <ArrowLeft size={15} />
        {parent ? 'Back to Studio task' : 'Back to coding jobs'}
      </Link>
      <PageHeader
        eyebrow={'EXECUTION · ' + job.id.slice(0, 8)}
        title={shortGoal}
        description={
          job.repositoryUrl.replace('https://github.com/', '') + ' · ' + job.commitSha.slice(0, 8)
        }
      >
        <Meta />
      </PageHeader>
      <details className="coding-brief">
        <summary>Task brief</summary>
        <p>{job.goal}</p>
      </details>
      <div className="coding-jobbar">
        <Link href={'/vms/' + job.vmId}>
          <Server size={15} />
          {vm?.cleanupConfirmedAt
            ? 'VM cleanup confirmed'
            : canConnect
              ? 'VM running'
              : 'VM details'}
        </Link>
        <span>
          {showCountdown ? 'Time remaining' : 'Original deadline'}{' '}
          <strong>
            {showCountdown ? remaining(job.deadlineAt, now) : dateTime(job.deadlineAt)}
          </strong>
        </span>
        <span>
          Meta calls <strong>{job.modelCalls}</strong>
        </span>
        <TableStatus tone={statusTone(state.tone)}>{state.label}</TableStatus>
        {job.mode === 'fixture' && <TableStatus>Fixture job · no live execution</TableStatus>}
      </div>
      {(detail.error || error) && (
        <section className="coding-notice error" role="alert">
          <strong>
            {error ? 'Could not update execution' : 'Could not refresh execution details'}
          </strong>
          <p>
            {error
              ? 'Check the saved execution status before trying the action again.'
              : 'The saved result may be out of date. Reloading only reads the existing job.'}
          </p>
          <ErrorBox error={detail.error || error} />
          <button className="button secondary" onClick={detail.reload}>
            Reload details
          </button>
        </section>
      )}
      <section
        className={'coding-outcome ' + state.tone}
        role={state.tone === 'error' ? 'alert' : 'status'}
      >
        <div className="coding-outcome-icon">
          {state.tone === 'success' ? (
            <Check size={19} />
          ) : state.tone === 'error' || state.tone === 'warning' ? (
            <AlertTriangle size={19} />
          ) : (
            <Code2 size={19} />
          )}
        </div>
        <div>
          <h2>{state.label}</h2>
          <p>{state.message}</p>
          {job.status === 'uncertain' && (
            <p>Usage reservations stay held until the original outcome is reconciled.</p>
          )}
          {job.requestedAction && !closed && (
            <p>
              {job.requestedAction === 'pause'
                ? 'Pause requested; waiting for the current step.'
                : 'Stop requested; waiting for process cleanup confirmation.'}
            </p>
          )}
        </div>
      </section>
      {job.blockedReason && !state.message?.includes(job.blockedReason) && !closed && (
        <details className="coding-disclosure">
          <summary>Failure details</summary>
          <p>{job.blockedReason}</p>
        </details>
      )}
      <div className="coding-workspace">
        <section className="coding-panel">
          <div className="coding-tabs" role="tablist" aria-label="Coding job details">
            {(['changes', 'tests', 'meta'] as const).map((key) => (
              <button
                id={'coding-tab-' + key}
                key={key}
                type="button"
                role="tab"
                aria-controls="coding-detail"
                aria-selected={tab === key}
                onClick={() => setTab(key)}
              >
                {key === 'changes' ? (
                  <>
                    <FileDiff size={15} />
                    Changes
                  </>
                ) : key === 'tests' ? (
                  <>
                    <FlaskConical size={15} />
                    Test output
                  </>
                ) : (
                  <>
                    <Sparkles size={15} />
                    Meta activity
                  </>
                )}
              </button>
            ))}
          </div>
          <div id="coding-detail" role="tabpanel" aria-labelledby={'coding-tab-' + tab}>
            {tab === 'changes' &&
              (data.artifactsExpired ? (
                <div className="coding-empty">
                  <FileDiff size={24} />
                  <h3>Patch retention ended</h3>
                  <p>
                    Source artifacts are retained for 24 hours. Job metadata and usage receipts
                    remain available.
                  </p>
                </div>
              ) : patch ? (
                <>
                  <div className="coding-title">
                    <h2>{job.testsPassed ? 'Verified patch' : 'Retained patch'}</h2>
                    <span className="coding-note">
                      {patch.truncated ? 'Export incomplete' : 'Saved for review'}
                    </span>
                  </div>
                  <pre className="coding-code">
                    {patch.output || 'No source changes were recorded in this job.'}
                  </pre>
                  {!patch.truncated && patch.output && (
                    <a className="button secondary" href={'/api/coding/jobs/' + id + '/patch'}>
                      <Download size={15} />
                      Download patch
                    </a>
                  )}
                </>
              ) : (
                <div className="coding-empty">
                  <FileDiff size={24} />
                  <h3>{closed ? 'No retained patch' : 'Changes will appear here'}</h3>
                  <p>
                    {closed
                      ? 'Execution ended without a complete exported patch. Review the saved history for the last confirmed result.'
                      : 'Muse will inspect the repository, edit files, and verify the result before preparing the patch.'}
                  </p>
                </div>
              ))}
            {tab === 'tests' && (
              <>
                <div className="coding-title">
                  <h2>Latest test result</h2>
                  <TableStatus tone={job.testsPassed ? 'success' : 'warning'}>
                    {job.testsPassed ? 'Passed after last edit' : 'Verification needed'}
                  </TableStatus>
                </div>
                <code className="coding-test-command">{job.testCommand}</code>
                {latestTest ? (
                  <TestRun step={latestTest} current={job.testsPassed} />
                ) : (
                  <div className="coding-empty">
                    <FlaskConical size={24} />
                    <h3>
                      {data.artifactsExpired ? 'Test output retention ended' : 'No test result yet'}
                    </h3>
                    <p>
                      {data.artifactsExpired
                        ? 'The retained command output has expired. The recorded verification status remains available.'
                        : 'A completed test receipt will appear here.'}
                    </p>
                  </div>
                )}
                {tests.length > 1 && (
                  <details className="coding-disclosure">
                    <summary>Earlier test runs ({tests.length - 1})</summary>
                    <p className="coding-note">
                      These checks ran before the latest result. A failed earlier check does not
                      describe the final file state.
                    </p>
                    {tests
                      .slice(0, -1)
                      .reverse()
                      .map((step) => (
                        <TestRun step={step} key={step.id} />
                      ))}
                  </details>
                )}
              </>
            )}
            {tab === 'meta' && (
              <>
                <div className="coding-title">
                  <h2>Meta Muse activity</h2>
                  <span className="coding-note">
                    {job.modelCalls} coding calls · {settled} settled in this history
                  </span>
                </div>
                <p className="coding-note">
                  Model calls consume prepaid allowance. Output counts include reasoning; hidden
                  reasoning is not displayed.
                </p>
                {models.map((step) => {
                  const r = step.result as {
                    provider?: string;
                    usage?: { prompt_tokens: number; completion_tokens: number };
                    action?: { action: string; path?: string; summary?: string };
                  } | null;
                  const outcome = stepState(step);
                  return (
                    <details className="coding-receipt" key={step.id}>
                      <summary>
                        <span>
                          {r?.action?.action ?? 'Model request'}
                          {r?.action?.path ? ' · ' + r.action.path : ''}
                        </span>
                        <TableStatus tone={statusTone(outcome.tone)}>
                          {step.receipt?.status === 'settled' && outcome.tone === 'success'
                            ? 'Settled'
                            : outcome.label}
                        </TableStatus>
                      </summary>
                      {r?.action?.summary && <p>{r.action.summary}</p>}
                      <p className="coding-note">
                        {r?.provider ?? step.receipt?.provider ?? 'Awaiting provider'} · Input{' '}
                        {r?.usage?.prompt_tokens ?? step.receipt?.inputTokens ?? '—'} · Output
                        including reasoning{' '}
                        {r?.usage?.completion_tokens ?? step.receipt?.outputTokens ?? '—'}
                      </p>
                      {step.receipt && (
                        <p className="coding-note">
                          Receipt {step.receipt.status} · Held input{' '}
                          {step.receipt.heldInputTokens.toLocaleString()} · Held output{' '}
                          {step.receipt.heldOutputTokens.toLocaleString()}
                        </p>
                      )}
                      {step.inferenceRequestId && <code>Receipt {step.inferenceRequestId}</code>}
                    </details>
                  );
                })}
                {!models.length && (
                  <p className="coding-note">No model receipt is available in this history.</p>
                )}
              </>
            )}
          </div>
          <div className="coding-actions">
            {parent ? (
              <Link className="button secondary" href={taskLink}>
                View Studio task <ArrowRight size={14} />
              </Link>
            ) : (
              !closed && (
                <>
                  {['paused', 'needs_allowance'].includes(job.status) &&
                  canConnect &&
                  Date.parse(job.deadlineAt) > now ? (
                    <button
                      className="button secondary"
                      disabled={busy}
                      onClick={() => control('resume')}
                    >
                      <Play size={15} />
                      Resume execution
                    </button>
                  ) : ['running', 'queued'].includes(job.status) ? (
                    <button
                      className="button secondary"
                      disabled={busy || !!job.requestedAction}
                      onClick={() => control('pause')}
                    >
                      <Pause size={15} />
                      Pause execution
                    </button>
                  ) : null}
                  <button
                    className="button secondary"
                    disabled={busy || job.status === 'stopping'}
                    onClick={() => control('stop')}
                  >
                    <Square size={14} />
                    Stop execution
                  </button>
                </>
              )
            )}
            {job.status === 'uncertain' && steps.at(-1)?.kind === 'command' && (
              <button
                className="button secondary"
                disabled={busy}
                onClick={() => control('reconcile')}
              >
                <RefreshCw size={15} />
                Inspect existing command
              </button>
            )}
            {canConnect && (
              <Link className="button secondary" href={'/vms/' + job.vmId}>
                <TerminalSquare size={15} />
                Open VM terminal
              </Link>
            )}
          </div>
          {!parent && job.status === 'needs_allowance' && (
            <div className="coding-actions">
              <Link className="button primary" href={'/token-orders/new?grantId=' + job.grantId}>
                Buy allowance <ArrowRight size={15} />
              </Link>
              <Link href={'/agents/' + job.grantId}>Inspect agent budget</Link>
            </div>
          )}
          <div className="coding-footer">
            <ShieldCheck size={15} />
            {parent
              ? 'Resources and prepaid model allowance share the Studio task budget.'
              : 'Commands run in the job sandbox. VM rental and prepaid allowance are purchased separately.'}
          </div>
        </section>
        <details className="coding-panel coding-history-details">
          <summary>Execution history · {steps.length} recorded steps</summary>
          <p className="coding-note">
            Command receipt completion and command success are recorded separately. Expand
            individual results above for evidence.
          </p>
          <ol className="coding-timeline">
            {steps.map((step) => {
              const outcome = stepState(step);
              return (
                <li key={step.id} className={outcome.tone}>
                  <span className="coding-dot">
                    {outcome.tone === 'success' ? (
                      <Check size={12} />
                    ) : outcome.tone === 'error' ? (
                      <X size={12} />
                    ) : (
                      step.sequence + 1
                    )}
                  </span>
                  <div>
                    {baselineTest(step) ? 'Check tests before changes' : actionLabel(step)}
                    <small>
                      {step.kind === 'model' ? 'Meta Muse' : 'Wick command'} · {outcome.label}
                    </small>
                  </div>
                </li>
              );
            })}
          </ol>
          <details className="coding-disclosure">
            <summary>Workspace details</summary>
            <p className="coding-note">
              {vm?.cleanupConfirmedAt
                ? 'The VM workspace has been closed. Retained artifacts can be reviewed above.'
                : 'Commands are confined to this job clone.'}
            </p>
            {!vm?.cleanupConfirmedAt && (
              <code className="coding-path">/tmp/wick-broker-coding/{job.id}/repository</code>
            )}
          </details>
        </details>
      </div>
    </div>
  );
}
