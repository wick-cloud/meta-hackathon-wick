# Public repository coding pilot

The saved coding-job worker runs small coding tasks in an owned Wick VM.
It uses the existing Railway app, Postgres and PgBoss, and the public Wick SDK.
The default `/studio` experience now orchestrates the entire task through a
[single task budget](studio-task-budgets.md), including model and VM purchases,
execution verification and cleanup. The manual existing-VM composer remains at
`/studio/legacy`; saved `/studio/jobs/:id` links remain valid. The limits below
describe that legacy pilot, not user-facing controls in the task workflow.

## Customer flow

1. Choose a public HTTPS GitHub URL, branch/commit, running VM, funded agent,
   task and test command. Broker checks anonymous visibility and the repository
   size (20 MB metadata limit), then pins the source commit.
2. The worker clones into `/tmp/wick-broker-coding/<job-id>/repository`, on its
   own `muse/<job-id>` branch. Existing VM checkouts are outside the job.
3. Meta returns validated text JSON actions: read a small file, replace a small
   UTF-8 file, run the frozen test command, or propose completion. This uses
   buffered text inference, not native function calling or streaming.
4. Inspect **Changes**, **Test output**, and **Meta activity**. Tests must pass
   after the last write before readiness. Download the patch or open the VM
   terminal. Push, merge, PR creation and deployment remain separate actions.

Private repositories, repository credentials, SSH/custom Git hosts, redirects,
submodule recursion and Git LFS downloads are excluded. No VM is automatically
purchased or extended by a coding job.

Execution details show the latest test result first, with earlier runs and the
command history collapsed. The initial check runs before edits; if its test
directory does not exist yet, it is labeled **Could not start**, with the original
output retained. Other nonzero test exits remain failures. A completed command
receipt is not presented as a passing test. A pass before a later edit requires
fresh verification.

Studio-owned jobs link back to their task and include its completion and VM
cleanup state. Finished jobs show an absolute deadline, and terminal access is
offered only for a running, unexpired VM. Failed checks, missing allowance,
expired artifacts, unavailable workspaces and unresolved results have distinct
messages. Unknown command/model outcomes retain their reservations and are never
automatically resent; command inspection reads the original journal.

## Guest prerequisites and execution

The VM requires Linux, Python 3, Git and `bwrap` (bubblewrap), with working user,
PID and network namespaces. The first step probes the actual sandbox before
downloading or spending model quota. Missing tools or disabled namespaces fail
the job explicitly. There is no unsandboxed fallback or automatic privileged
package installation.

Tests mount the fresh clone at `/repo`, system tools read-only, a private
`/tmp`, a fresh `/proc`, and minimal `/dev`. Customer home/workspace directories,
Broker credentials and guest environment variables are not passed through.
Tests have no network access; dependencies must already be available in the
VM's system tool environment. Public repositories are still untrusted code.
Post-test Git operations run inside the same boundary because tests can alter
repository-local Git configuration.

Commands have a 90-second maximum, shortened by the job deadline. Output is
capped at 16 KB. A bounded scan monitors the 64 MB/4,000-entry workspace policy
and checks again after command cleanup, including fast writers that exit zero
between scans. A limit violation pauses the job without accepting passing tests
or spending another model call. The polling policy can observe overshoot; it is
not a filesystem quota. Per-process CPU/address-space/file-size/process/descriptor limits
supplement the existing VM resource ceiling; they are not an independent cgroup
CPU or aggregate memory reservation. Process groups are killed on completion
and interruption. Bubblewrap parent-death and PID isolation prevent retained
background test processes.

## Funding, authority and recovery

* Owner sessions alone create/control/read jobs. Agent and batch keys cannot
  use coding endpoints or gain VM command authority. Jobs have their own
  durable owner/VM/grant/deadline authority, independent of browser lifetime.
* Account role, grant, VM identity/state, deadline, lease, and pause/stop intent
  are rechecked at dispatch. Revocation stops new actions; an already dispatched
  step may complete while cleanup/reconciliation remains pending.
* Every coding model call uses the existing qualified prepaid gateway. Both
  token dimensions must fit in one pack. Reservations, usage settlement,
  concurrency and unknown outcomes preserve existing ledger behavior. There is
  no second inference money charge or unmetered Muse helper fallback.
* Migration 024 adds `source_job_id` authority. Normal public completions still
  require a grant-bound API key; owner-session access is not enabled globally.
* Defaults: 10 minutes, 8 model attempts/24 steps, 512 output tokens including
  reasoning, four active pilot jobs globally and one per VM. Paused/unresolved
  jobs retain those slots. The earliest task/VM/grant deadline is immutable.
* Missing quota pauses the job. Purchase another pack through the existing
  30-second auction or instant quote, then resume. Funding and expiry do not
  change automatically.
* Guest commands journal intent before execution and atomically save their
  bounded receipts. Lost responses or worker leases never trigger automatic
  command replay. **Inspect existing command** reads the same journal; only a
  definitive receipt permits recovery.
* Missing/uncertain Meta output is never automatically regenerated, even if
  usage settled. Receipts remain attached and unresolved quota stays held.
* Stop persists intent and sets the guest stop marker. It becomes terminal only
  after command cleanup is acknowledged; otherwise it remains uncertain.

## Retention and owner-session APIs

Source context, model actions, diffs and test output are encrypted at rest with
a domain-separated key derived from the app auth secret. Owner-only reads
decrypt artifacts for 24 hours. Maintenance purges payloads while keeping job
metadata and inference/audit receipts. Rotating the auth secret invalidates
retained artifact encryption. Hidden model reasoning is not shown or retained.
Guest clones share the customer VM's existing finite lifetime.

These intentionally are not agent-key SDK/OpenAPI routes:

* `GET /api/coding/options`
* `GET /api/coding/jobs?limit=25&cursor=...`
* `POST /api/coding/jobs` with a stable `operationKey`
* `GET /api/coding/jobs/:id`
* `POST /api/coding/jobs/:id/{pause,resume,stop,reconcile}`
* `GET /api/coding/jobs/:id/patch`

History uses buyer-scoped keyset pagination, maximum 100. Details load at most
64 recent step rows and never call providers per row. Three-minute fenced leases and
bounded maintenance batches recover missed queue wakes. The Railway image
ships the guest helper as inert source; customer code never runs on Railway.

## Verification limits

Run `TEST_DATABASE_URL=<disposable Postgres> npm test`, `npm run typecheck`, and
`npm run build`. Local tests exercise real SQL and ledger settlement with
explicit synthetic guest/model adapters. Browser fixture checks cover the real
app/auth/Postgres/PgBoss flow, not native VM or live Meta execution.

The opt-in local Linux runner uses a real public GitHub clone and the production
guest helper through a local Docker command adapter, with actual file edits and sandboxed test execution. Model
decisions and money stay fixtures. It exercises the real app/auth/Postgres/PgBoss
workflow, lost-response reconciliation, replay prevention, process cleanup,
deadline/stop enforcement, output bounds, fast workspace overflow and missing
sandbox rejection. Docker is a local testing dependency, not a customer-VM
requirement.

To reproduce on an explicitly chosen disposable local Docker context:

```sh
docker --context YOUR_LOCAL_CONTEXT build -f tests/fixtures/coding-linux.Dockerfile -t wick-broker-coding-local:bookworm .
CODING_TEST_DOCKER_CONTEXT=YOUR_LOCAL_CONTEXT TEST_DATABASE_URL=postgresql://localhost:5432/postgres npm run test:coding-local
```

The runner requires a loopback Postgres server and a Unix-socket Docker context.
It creates and removes its own database/container. The container is privileged
to allow nested namespaces, so use a separate local Linux VM without host home
mounts; it is bounded to one CPU, 768 MB and 128 processes. The tested Colima
profile used `--activate=false --mount none --ssh-agent=false --ssh-config=false`
and did not change the user's Docker context. The report distinguishes actual
Linux execution from fixture inference. Set `CODING_LOCAL_REPORT` to save its
JSON evidence; `CODING_LOCAL_PREVIEW=1` keeps the app open for a browser check.

Native Wick provider command/timeouts/profile behavior and real Muse coding at
the 512-token cap remain unverified. The local Docker transport does not certify
E2B, Daytona, Modal or Blaxel. Larger coding tasks still need separate accounting
qualification. See the [coverage record](verification/public-repo-coding-coverage.md).
