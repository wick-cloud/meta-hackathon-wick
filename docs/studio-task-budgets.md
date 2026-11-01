# Studio task budgets

`/studio` now starts with a public repository, task, one total spending ceiling,
and a time limit. Customers do not select a VM, create a grant, or configure
model quantities. The task creates its own private grant and orchestrates the
existing marketplaces, coding worker and cleanup owners in the same Railway
app, Postgres and PgBoss instance.

## Flow

1. Verify anonymous GitHub access and pin the commit. In one transaction create
   the task and reserve the entire owner-funded budget. Competing starts cannot
   reserve the same wallet credit; operation replay returns the original task.
2. Reserve the cheapest reviewed compute ceiling inside the same grant, then
   auction a server-sized model pack. Planning itself uses this purchased
   allowance through the existing inference gateway, never an unmetered helper.
   An explicitly allowed instant model quote may replace an unsuccessful auction.
3. Fetch bounded, pinned public project metadata. Meta selects a supplied compute
   candidate and a test command; it cannot invent prices or provider identities.
   Save the validated plan before resizing the compute reservation. If more
   funding is needed, resume the saved plan without another generation.
4. Run the ordinary 30-second compute auction. Creation is linked atomically to
   its task, and awards recheck task authority and its compute reservation.
   Existing global VM admission/capacity limits apply.
5. Confirm VM readiness and prepare the sandbox in the fresh disposable VM.
   A confirmed clone receipt marks execution as started. A browser terminal
   connection or a queue state alone does not prove execution.
6. Run the coding job using purchased allowance. A missing pack triggers another
   bounded purchase from remaining funds, followed by resumption of the same job
   and VM. Two known, settled invalid actions may receive new attempts. Unknown
   model outcomes and missing command receipts are never automatically replayed.
7. Require passing tests after the last edit, a complete retained patch, and a
   ready coding receipt. Copy the patch before cleanup. Terminate the task VM,
   settle usage, close funding, and return unspent credit. Only then mark the
   task completed. Expiry and owner stop follow the same cleanup path.

Both auctions remain available through their existing saved order links. The
task page includes a budget breakdown, actual purchase receipts, Meta's setup
explanation, guest test output, retained patch, and saved activity. Existing
bring-your-own-VM coding links remain at `/studio/jobs/:id`; their old composer
is available at `/studio/legacy`.

## Planning recovery

Planning sends no reasoning-effort override; Muse's serving endpoint controls
reasoning for both the initial task and repair. It uses a compact repository summary: at most
50 root entries and two 4,000-character manifest excerpts, marked when truncated.
This keeps VM selection and offline verification planning separate from coding.
The existing qualified per-call input/output bounds stay in force. Omitting an
override does not guarantee adaptive reasoning or prevent response truncation;
provider defaults still apply. Recovery therefore handles a capped response
explicitly instead of assuming every task will fit on its first attempt.

Each task has at most two planning attempts. A settled truncated or malformed
reply gets one shorter automatic repair from existing prepaid quota. Invalid
VM choices, changed owner commands and refusals stop for review. No repair buys
another pack or starts a VM. Unknown usage is never retried or released merely
because a worker restarted. Owner, grant, deadline and lease checks apply at
admission, dispatch and plan acceptance.

The bounded final reply is encrypted with the existing artifact key and saved
in the same transaction as usage settlement. A lost worker checkpoint recovers
that saved reply instead of repeating the provider call. Responses expire with
the task's existing 24-hour artifacts; finish reason and failure category remain
as diagnostic metadata. Response bodies and reasoning are never returned in the
task API or copied into repair prompts.

The task UI shows the failure category, attempt, finish reason and settled usage.
An owner can recover a saved result or authorize the one remaining repair for a
legacy settled call whose response was not retained. Both actions use the
original deadline and existing allowance. Unresolved receipts and exhausted
repairs have no retry action. Older 2,048-token receipts without a finish reason
remain inconclusive about truncation; the new diagnostics do not fabricate one.

## Money and authority

The grant's existing equation remains authoritative:

`funded = available + held + spent + returned`.

Compute holds and pending model purchases share `held`, so they cannot spend
the same credit. A ready VM's accepted rental is charged once through an
append-only `studio_compute` entry; its existing single VM invoice is the
receipt for that rental, not a second wallet charge. Failed starts release
compute only after definitive cleanup or proof that admission never happened.
Closing a grant retains unresolved compute and inference holds. Inference calls
consume quota without another monetary charge.

Spend includes prepaid model packs, including unused quota. Unspent grant
funding is returned; unused prepaid quota follows the existing non-refundable
policy. Provider fees remain 15%, with no separate buyer fee. Payment collection,
native Wick credit, and provider payouts remain separate pilot systems.

Only an authenticated owner session may start, fund, stop or inspect tasks.
Agent/API keys cannot acquire task command authority. Internal planning has its
own fenced task lease and inference-request authority, checked at reservation
and dispatch. No service key is issued to the guest. Account changes, stop,
deadline and grant status are checked before new actions. Task deadlines and
native rental expiries are never automatically extended.

## Execution and qualification

Studio automatically sizes model allowance within the budget. There is no
customer-facing token-limit control. Provider accounting bounds remain mandatory
server-side. A route unsuitable for coding is rejected **before budget funding
or purchases**. The narrow production routes from the earlier coding diagnostic
need a larger output contract qualified before this automatic workflow can be
enabled live; this implementation does not silently widen their certificates.

Python 3 must already exist in the guest. A task-owned fresh Debian/Ubuntu VM
may install only fixed OS packages (`git`, `bubblewrap`, `ca-certificates`)
from its configured package repositories, using root or noninteractive sudo.
This occurs under the same durable command journal before cloning repository
code. Existing customer-selected VMs do not opt into this privileged setup.
Missing privileges/package management or unavailable namespaces fail closed.
Repository code never runs with setup privileges. Tests still have no network
and use preinstalled dependencies; arbitrary dependency installation and private
repositories are outside this pilot.

The task time limit stops admission of new work. Native finite VM lifetime is
the backstop during Broker downtime; exact physical purge is not asserted.
Unknown allocation or cleanup continues to hold its runtime slot and budget.
Native provider/image/kernel behavior must be checked independently.

## Bounded work and recovery

Task history uses buyer-scoped keyset pagination, default 25 and maximum 100;
listing excludes retained source and patch bodies. Indexed task events and
model receipts are bounded at 40 and 25 rows. The latest test uses a dedicated
job/action/sequence index and loads one receipt, regardless of job history.
Details make a fixed number of batched reads, with no per-row HTTP requests.
Polling pauses in hidden tabs and stops after terminal states.

There are four active Studio slots, including unresolved tasks, and the existing
four-job coding and 20-VM admission limits. Two workers process fenced,
three-minute task leases. Immediate delayed wakes handle normal progress;
bounded maintenance recovers missed wakes. Each tick performs at most four
state transitions. Coding executes bounded step batches with internal resource
guards and the task's immutable deadline. Models cannot raise their own funding.

An interrupted purchase recovers its original operation key and linked order.
An interrupted plan retains its original inference receipt instead of
regenerating. An interrupted VM create uses existing lifecycle recovery and
exact allocation identity. Terminal state requires reconciled funding and
confirmed cleanup. Artifacts are encrypted and retained for 24 hours; rotating
the authentication secret invalidates retained artifact encryption.

## Verification

`tests/studio-db.test.ts` uses disposable Postgres for end-to-end state changes,
concurrent budget/purchase holds, replay, cancellation, failed-start uncertainty,
lost planning responses, funding closure, replenishment without a second VM or
deadline extension, tenant isolation, and verified completion. A 10,000-task
history checks bounded payloads and an `EXPLAIN (ANALYZE, BUFFERS)` plan using
the owner-page and grant-primary-key indexes.
Planning checks also exercise concurrent owner retries and workers, exhausted
prepaid quota, and stop/deadline/revocation/lease changes during a provider call.

```sh
TEST_DATABASE_URL=postgresql://localhost/disposable npm run check
CODING_TEST_DOCKER_CONTEXT=YOUR_ISOLATED_LOCAL_CONTEXT TEST_DATABASE_URL=postgresql://localhost/postgres npm run test:studio-local
```

The opt-in Linux runner executes actual public Git cloning, source edits,
sandboxed tests and patch export. It waits for both real 30-second fixture
auctions, injects one capped planning response, repairs it using existing quota,
then performs automatic verification and funding release. It verifies that
planning, repair and coding calls have no Broker reasoning override, and removes
its own container/database. Model decisions, prices, allocations and money are
explicit fixtures; this is not live Meta/Wick-provider qualification. The
test container has no host-directory mounts or SSH-agent forwarding. A browser
run also starts a second task solely through the new form and verifies its
completion, receipts, patch and cleanup.

Provider scope: E2B, Daytona, Modal and Blaxel retain the same public Wick SDK
transport. Existing lifecycle, terminal, copy, Git, snapshots, pause/resume,
retention, profiles and other native methods are unchanged. Debian/Ubuntu setup
is shared guest behavior and is tested separately from native route claims.
The other Wick providers are not exposed by Broker and are unaffected. Current
automatic-task native provider and live-model verification has not been run.
