# Public repository coding pilot

Muse Studio (`/studio`) runs small coding tasks in an existing owned Wick VM.
It uses the existing Railway app, Postgres and PgBoss, and the public Wick SDK.

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
capped at 16 KB. Workspace growth is limited to 64 MB/4,000 entries using a
bounded scan. Per-process CPU/address-space/file-size/process/descriptor limits
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
25 step rows and never call providers per row. Three-minute fenced leases and
bounded maintenance batches recover missed queue wakes. The Railway image
ships the guest helper as inert source; customer code never runs on Railway.

## Verification limits

Run `TEST_DATABASE_URL=<disposable Postgres> npm test`, `npm run typecheck`, and
`npm run build`. Local tests exercise real SQL and ledger settlement with
explicit synthetic guest/model adapters. Browser fixture checks cover the real
app/auth/Postgres/PgBoss flow, not native VM or live Meta execution.

The development host is macOS and its Docker daemon is unavailable. Native
Linux bubblewrap execution, live model coding at the 512-token cap, native
provider timeouts, process cleanup and each provider/profile remain unverified.
Missing native evidence does not enable a weaker path. Larger coding tasks need
separate output/accounting qualification. See the
[provider coverage record](verification/public-repo-coding-coverage.md).
