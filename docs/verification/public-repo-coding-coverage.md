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

No native resources or provider cleanup receipts exist for this implementation.
Production deployment and live diagnostics remain separate actions.
