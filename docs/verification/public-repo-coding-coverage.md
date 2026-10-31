# Coding pilot coverage

Scope: Broker repository; pinned public Wick SDK `0.1.0-rc.0`; additive structured
`environments.runCommand` wrapper. No private Wick providers, routing,
credentials, allocation or lifecycle implementations were changed. Live
diagnostics were not requested for this implementation.

The Wick provider inventory and all 14 product feature IDs were reviewed.
Broker exposes E2B, Daytona, Modal and Blaxel. For each of these four providers:

| Feature/check | Implementation | Local evidence | Live evidence |
| --- | --- | --- | --- |
| Structured commands | Same bounded SDK command wrapper, one POST, real exit status | Synthetic request/response test per route; lost-response no-retry checks | Not run |
| Public Git/files/context | Anonymous pinned clone, bounded text files, symlink/path checks, read-before-write conflicts | Guest source/syntax check and worker fixtures | Not run; native Linux/image prerequisites outstanding |
| Isolation/resources/cancel | Bubblewrap preflight, no-network tests, process groups, stop marker, guest journal | Synthetic journal/lost response/restart checks; no native sandbox claim | Not run; kernel, native timeout and process cleanup outstanding |
| Allocation/sizes/lifetimes/cleanup | Existing owners unchanged; job uses an existing VM and fixed deadline | Existing marketplace/lifecycle regression suite | No new paid allocation or deletion performed |
| Interactive terminal | Existing SDK transport preserved; coding UI links to it | Existing terminal regressions and unchanged wrapper method | Not run for this change |
| Private preview/SSH/pause-resume/copy/templates/retention/extension/preauthorized-agent/logs/never-auto-termination/drives/shared-files | Outside coding pilot; existing methods, flags and support are unchanged | Existing regressions where present; no new feature proof claimed | Not run |

Micro/Small/Medium/Large: no size-specific API changes or native size
certification. Fixtures do not prove that an image has working Python, Git,
bubblewrap or test dependencies.

Other reviewed inventory entries are unaffected because Broker does not expose
them and their connectors are unchanged: Sail, Boat, Declaw, Runloop, Docker
Sandboxes, Agent37, Isorun, Tensorlake, MIOSA, Novita AI, Superserve, Freestyle,
Tenki and Vercel Sandbox.

Local evidence:

* `tests/coding.test.ts`: public URL/visibility/pinned commit, no credentials,
  restricted model actions, authenticated artifact encryption.
* `tests/coding-db.test.ts`: real disposable Postgres, prepaid usage settlement,
  owner authority, concurrent VM claims, operation replay, quota pause/resume,
  lost command receipt recovery, unknown inference holds, passing-test gate,
  stop, tenant pagination, retention and indexed 10,000-row history.
* `tests/wick-coding-contract.test.ts`: all four synthetic route contracts and
  no command POST retry after an ambiguous transport failure.
* `tests/coding-guest-files.test.ts`: actual local Python read/write/path guards,
  symlink rejection, external edit preservation, expiry and journal replay
  protection; this does not exercise Linux namespaces.
* Browser: real app/auth/Postgres/PgBoss with explicit synthetic model/guest
  adapters, from form/review through tests, patch and Meta receipts. This is
  fixture execution, not live provider/model evidence.

No Wick provider resources were allocated and no provider cleanup receipt is
claimed. Local Linux test resources are recorded separately below. Production
deployment and live provider diagnostics remain separate actions.

## Local Linux verification — 2026-10-31

`npm run test:coding-local` passed with actual Linux commands in an isolated
Colima VM (aarch64, 2 CPUs/2 GiB, no host mounts or forwarded SSH agent). The
test container was privileged for nested namespaces and limited to one CPU,
768 MB/128 processes. Versions: Linux 6.8.0-117-generic, Python 3.12.16,
Git 2.39.5, bubblewrap 0.8.0. The fixture image pins its official Python base
digest. This is local Linux proof, not Wick API/provider/profile qualification.

The real anonymous repository was `https://github.com/pypa/sampleproject`, pinned
at `621e4974ca25ce531773def586ba3ed8e736b3fc`. The real app, auth, Postgres and
PgBoss worker produced two new files, six passing Linux tests and an HTTP patch.
Meta decisions, token counts and pilot money were explicit fixtures; no paid
inference or Wick provider VM was used.

Thirteen checks passed: anonymous pinned cloning; real edits/tests; private
workspace/environment/network isolation; baseline failure then success; lost
response reconciliation; same-step replay prevention; no surviving child
process; patch export and creation idempotency; absolute cutoff; stop marker;
16 KB output truncation; rejection of a fast 72 MB write; and missing-bubblewrap
rejection before clone. Test containers/databases were removed after the run.

The first overflow probe exposed a real bug: a quick writer could exit zero
between periodic scans. The executor now performs a bounded final scan after
cleanup and marks policy violations explicitly. The worker pauses them before
another model call; a Postgres regression also covers a zero-exit overflow.

The intentional child-cleanup test emits Python's expected ResourceWarning for
an unreaped subprocess inside the test. A separate process inspection verifies
that no marked child remains after the namespace exits.

## Automatic Studio task verification — 2026-10-31

The task-budget extension uses the same public SDK command transport and all
four route contracts above. E2B, Daytona, Modal and Blaxel each retain their
existing allocation, terminal, Git, file/copy, snapshot, pause/resume and native
lifecycle owners. No provider-specific implementation, capability flag or
private Wick source changed. Native automatic-task setup remains unverified
for all four providers and every size; fixture contracts are not native proof.

`npm run test:studio-local` passed 17 checks in the isolated Linux environment
above. It deliberately removed bubblewrap from its own disposable container
before starting a task through the authenticated owner HTTP API. The fresh-VM
bootstrap installed the missing fixed OS package, verified namespaces, cloned
the pinned public repository, and ran the actual edits and six tests. Both
model and compute fixture auctions observed their full 30-second deadlines.
The result retained a patch, confirmed fixture VM cleanup, returned unspent
funding, and removed the actual container and database at teardown. Its task
spent $1.6120 from $10.0000 and returned $8.3880, with six settled fixture model
receipts and no pending budget holds. These amounts are fixture accounting,
not real provider charges.

A separate browser-started task used only the task, public repository and a
$5.0000 budget, without selecting a VM, grant or model quantities. It completed
the same Linux work and returned $3.3880. Desktop inspection verified the
budget breakdown, activity, test receipts and cleanup state. Small-screen CSS
was reviewed; no runtime device-viewport verification is claimed.

The complete disposable-Postgres suite passed 821 tests across 63 files,
including 18 Studio tests for funding, operation replay, isolation, leases,
unknown usage, stop/deadline, replenishment, verified completion and bounded
10,000-row task history. Type checking and production builds also passed.
Live Meta responses, native VM images and larger provider output-accounting
contracts require separate qualification before enabling real automatic tasks.
