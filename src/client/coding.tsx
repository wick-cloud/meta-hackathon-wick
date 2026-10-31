import { useEffect, useRef, useState, type FormEvent } from 'react';
import {
  ArrowLeft,
  ArrowRight,
  Check,
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
import { TableViewport } from './table';
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
const finished = (job: CodingJob) => ['ready', 'failed', 'stopped'].includes(job.status);
const Meta = () => (
  <span className="coding-meta">
    <Sparkles size={15} />
    Meta Muse Spark Open
  </span>
);
function JobStatus({ job }: { job: CodingJob }) {
  return (
    <span className={`coding-status ${job.status}`} role="status">
      {labels[job.status]}
    </span>
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
      <ErrorBox error={options.error || list.error} />
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
              <span className="coding-status">Public GitHub only</span>
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
      <section className="coding-history">
        <div className="coding-title">
          <h2>Coding jobs</h2>
          <span className="coding-note">Saved across navigation and refresh</span>
        </div>
        {list.loading ? (
          <Spinner label="Loading coding jobs" />
        ) : !list.data?.items.length ? (
          <div className="coding-empty">
            <Code2 size={24} />
            <h3>Your next fix starts here.</h3>
            <p>Pick a public repository, a VM, and a funded agent.</p>
            {!compose && (
              <button className="button primary" onClick={() => setCompose(true)}>
                Create a coding task
              </button>
            )}
          </div>
        ) : (
          <TableViewport label="Coding jobs" minWidth={680}>
            <table className="data-table">
              <thead>
                <tr>
                  <th>Task</th>
                  <th>Repository</th>
                  <th>Status</th>
                  <th>Meta calls</th>
                  <th>Created</th>
                  <th>
                    <span className="sr-only">Action</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {list.data.items.map((job) => (
                  <tr key={job.id}>
                    <td>
                      <Link href={'/studio/jobs/' + job.id}>{job.goal.slice(0, 65)}</Link>
                      <small>CJ-{job.id.slice(0, 8)}</small>
                    </td>
                    <td>
                      {job.repositoryUrl.replace('https://github.com/', '')}
                      <small>{job.commitSha.slice(0, 8)}</small>
                    </td>
                    <td>
                      <JobStatus job={job} />
                    </td>
                    <td>{job.modelCalls}</td>
                    <td>{dateTime(job.createdAt)}</td>
                    <td>
                      <Link href={'/studio/jobs/' + job.id}>
                        Open <ArrowRight size={14} />
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableViewport>
        )}
        <div className="coding-actions">
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
        </div>
      </section>
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
export function CodingJobPage({ id }: { id: string }) {
  const [poll, setPoll] = useState(3000);
  const detail = useResource<CodingDetail>('/api/coding/jobs/' + id, poll),
    [tab, setTab] = useState<'changes' | 'tests' | 'meta'>('changes'),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const now = useNow();
  const job = detail.data?.job,
    steps = detail.data?.steps ?? [];
  useEffect(() => {
    setPoll(job && finished(job) ? 0 : 3000);
  }, [job?.status]);
  async function control(action: string) {
    setBusy(true);
    setError('');
    try {
      await post('/api/coding/jobs/' + id + '/' + action, {});
      detail.reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not update the task.');
    } finally {
      setBusy(false);
    }
  }
  if (!job)
    return (
      <div className="coding-page">
        <ErrorBox error={detail.error} />
        {detail.loading && <Spinner label="Loading coding job" />}
      </div>
    );
  const diffs = steps.filter((s) => s.action === 'diff' && s.result),
    tests = steps.filter((s) => s.action === 'test' && s.result),
    models = steps.filter((s) => s.kind === 'model'),
    patch = diffs.at(-1)?.result?.result as { output?: string; truncated?: boolean } | undefined;
  return (
    <div className="coding-page">
      <Link className="back-link" href="/studio">
        <ArrowLeft size={15} />
        Back to coding jobs
      </Link>
      <PageHeader
        eyebrow={'CJ-' + job.id.slice(0, 8)}
        title={job.goal}
        description={
          job.repositoryUrl.replace('https://github.com/', '') + ' · ' + job.commitSha.slice(0, 8)
        }
      >
        <Meta />
      </PageHeader>
      <div className="coding-jobbar">
        <Link href={'/vms/' + job.vmId}>
          <Server size={15} />
          Wick VM
        </Link>
        <span>
          Deadline <strong>{remaining(job.deadlineAt, now)}</strong>
        </span>
        <span>
          Meta calls <strong>{job.modelCalls}</strong>
        </span>
        <JobStatus job={job} />
        {job.mode === 'fixture' && (
          <span className="coding-status">Fixture job · no live execution</span>
        )}
      </div>
      <ErrorBox error={detail.error || error} />
      {job.blockedReason && (
        <div className="coding-notice" role="status">
          {job.blockedReason}
        </div>
      )}
      {job.requestedAction && (
        <p className="coding-note">
          {job.requestedAction === 'pause'
            ? 'Pause requested; waiting for the current step.'
            : 'Stop requested; waiting for process cleanup acknowledgment.'}
        </p>
      )}
      {job.status === 'ready' && (
        <div className="coding-notice">
          <strong>Ready for your review.</strong> The patch is in the job clone and tests passed
          after the last edit.
        </div>
      )}
      {detail.data?.artifactsExpired && (
        <div className="coding-notice">
          The 24-hour artifact retention has ended. Job metadata and inference receipts remain
          available.
        </div>
      )}
      <div className="coding-workspace">
        <section className="coding-panel">
          <h2>Activity</h2>
          <ol className="coding-timeline">
            {steps.map((step) => (
              <li key={step.id} className={step.status}>
                <span className="coding-dot">
                  {step.status === 'completed' ? <Check size={12} /> : step.sequence + 1}
                </span>
                <div>
                  {actionLabel(step)}
                  <small>
                    {step.kind === 'model' ? 'Meta Muse · inference' : 'Wick · command receipt'} ·{' '}
                    {step.status}
                  </small>
                </div>
              </li>
            ))}
          </ol>
          <p className="coding-note">Job clone</p>
          <code className="coding-path">/tmp/wick-broker-coding/{job.id}/repository</code>
        </section>
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
              (patch ? (
                <>
                  <div className="coding-title">
                    <h2>Review patch</h2>
                    <span className="coding-note">
                      {patch.truncated ? 'Truncated · inspect VM' : 'Fresh job branch'}
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
                  <p>
                    {steps.some((s) => s.action === 'write')
                      ? 'Edits are saved in the VM. The final patch appears after the review step.'
                      : 'The patch appears after Muse has inspected and edited the repository.'}
                  </p>
                </div>
              ))}
            {tab === 'tests' && (
              <>
                <div className="coding-title">
                  <h2>Test evidence</h2>
                  <span className={'coding-status ' + (job.testsPassed ? 'ready' : '')}>
                    {job.testsPassed ? 'Passed after last edit' : 'No current passing result'}
                  </span>
                </div>
                <code>{job.testCommand}</code>
                {!tests.length && (
                  <div className="coding-empty">
                    <FlaskConical size={24} />
                    <p>No test command result has been recorded.</p>
                  </div>
                )}
                {tests.map((step) => {
                  const r = step.result?.result as
                    | {
                        exitCode?: number;
                        output?: string;
                        truncated?: boolean;
                        interrupted?: boolean;
                      }
                    | undefined;
                  return (
                    <section className="coding-test-result" key={step.id}>
                      <h3>
                        Step {step.sequence + 1} · exit {r?.exitCode ?? 'unknown'}
                        {r?.interrupted ? ' · interrupted' : ''}
                      </h3>
                      <pre className="coding-code">
                        {r?.output || JSON.stringify(step.result, null, 2)}
                      </pre>
                      {r?.truncated && (
                        <p className="coding-note">Output was truncated at the retained limit.</p>
                      )}
                    </section>
                  );
                })}
              </>
            )}
            {tab === 'meta' && (
              <>
                <h2>Meta Muse activity</h2>
                <p className="coding-note">
                  Model actions use prepaid allowance. Reasoning tokens are included in the output
                  count; hidden reasoning is not displayed.
                </p>
                {models.map((step) => {
                  const r = step.result as {
                    provider?: string;
                    usage?: { prompt_tokens: number; completion_tokens: number };
                    action?: { action: string; path?: string; summary?: string };
                  } | null;
                  return (
                    <section className="coding-model-result" key={step.id}>
                      <Meta />
                      <h3>
                        {r?.action?.action ?? step.status}
                        {r?.action?.path ? ' · ' + r.action.path : ''}
                      </h3>
                      {r?.action?.summary && <p>{r.action.summary}</p>}
                      <p className="coding-note">
                        {r?.provider ?? step.receipt?.provider ?? 'Awaiting route receipt'} · Input{' '}
                        {r?.usage?.prompt_tokens ?? step.receipt?.inputTokens ?? '—'} · Output
                        including reasoning{' '}
                        {r?.usage?.completion_tokens ?? step.receipt?.outputTokens ?? '—'}
                      </p>
                      {step.receipt && (
                        <p className="coding-note">
                          Receipt {step.receipt.status} · Reserved input{' '}
                          {step.receipt.heldInputTokens.toLocaleString()} · Reserved output{' '}
                          {step.receipt.heldOutputTokens.toLocaleString()}
                        </p>
                      )}
                      {step.inferenceRequestId && <code>Receipt {step.inferenceRequestId}</code>}
                    </section>
                  );
                })}
                {!models.length && <p className="coding-note">No model call has been sent.</p>}
              </>
            )}
          </div>
          <div className="coding-actions">
            {!finished(job) && (
              <>
                {['paused', 'needs_allowance'].includes(job.status) ? (
                  <button
                    className="button secondary"
                    disabled={busy}
                    onClick={() => control('resume')}
                  >
                    <Play size={15} />
                    Resume task
                  </button>
                ) : ['running', 'queued'].includes(job.status) ? (
                  <button
                    className="button secondary"
                    disabled={busy || !!job.requestedAction}
                    onClick={() => control('pause')}
                  >
                    <Pause size={15} />
                    Pause task
                  </button>
                ) : null}
                {job.status === 'uncertain' && (
                  <button
                    className="button secondary"
                    disabled={busy}
                    onClick={() => control('reconcile')}
                  >
                    <RefreshCw size={15} />
                    {steps.at(-1)?.kind === 'model'
                      ? 'Check existing receipt'
                      : 'Inspect existing command'}
                  </button>
                )}
                <button
                  className="button secondary"
                  disabled={busy || job.status === 'stopping'}
                  onClick={() => control('stop')}
                >
                  <Square size={14} />
                  Stop task
                </button>
              </>
            )}
            <Link className="button secondary" href={'/vms/' + job.vmId}>
              <TerminalSquare size={15} />
              Open VM terminal
            </Link>
          </div>
          {job.status === 'needs_allowance' && (
            <div className="coding-actions">
              <Link className="button primary" href={'/token-orders/new?grantId=' + job.grantId}>
                Buy allowance <ArrowRight size={15} />
              </Link>
              <Link href={'/agents/' + job.grantId}>Inspect agent budget</Link>
            </div>
          )}
          <div className="coding-footer">
            <ShieldCheck size={15} />
            Commands stay in the job sandbox. VM rental and prepaid token purchases remain separate.
          </div>
        </section>
      </div>
    </div>
  );
}
