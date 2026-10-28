# Wick Broker — current reviewed handoff

The reviewed Muse negotiation implementation is on `codex/broker-real-wick`. Feature commit `df70b71f4ce26fcdfe89bfa9619825cb0a1555c2` was promoted to the existing VM preview on 2026-10-28 after independent review, 303 offline tests and nine browser scenarios passed.

The preview runs one app in tmux `wick-broker` on port 3000 with **real Wick/E2B and fixture Muse**, as requested. The verified production build was promoted and additive migrations 007–009 were applied. Existing credentials, accounts, sessions, policies and rental history were preserved; no seed command was run. A private recovery snapshot and the preceding build remain outside Git. The existing Boat VM is only the development/app host.

This enhancement made no real Meta calls or new paid VM allocations. Only this standalone repository and the published Wick SDK were used; private Wick source and history remain separate.

## Current application

One Node app and PostgreSQL serve authentication, buyer/provider/admin views, HTTP APIs, terminal WebSockets and pg-boss workers. Customers receive finite private VMs and run their own commands. The product does not run workloads, agents, tasks, repositories, setup or provider diagnostics. Payments and payouts remain absent; invoices explicitly say **No payment due**, while upstream real Wick compute consumes real credit.

Real Wick uses published `@wick-cloud/sdk@0.1.0-rc.0`, managed E2B route verification, frozen rate caps, the official scoped terminal transport and ownership checks. Catalog prices refresh every five minutes and must be no more than fifteen minutes old for new admission. Fractional resources, one-round-up integer pricing, competitive manual prices, historical source labels and mode isolation remain intact. Cleanup never creates: missing receipts use bounded read-only discovery, uncertain outcomes retain holds, and only confirmed termination releases them.

## New reviewed flows

- **Muse Capacity Manager:** provider strategy becomes editable explicit limits. Nothing activates until Apply. Policy/capacity revisions reject stale suggestions. Apply uses a bounded durable latest-operation receipt for exact retries and consumes a revision even for unchanged limits. The shared “Automatic bids and counteroffers” control gates proposal generation and locked acceptance; pausing preserves manual bidding. Negated fixture strategies keep automation off. Spare-slot reservations and deterministic floors apply to manual bids, automatic bids and negotiated acceptance; policy changes do not release existing holds.
- **Nonbinding buyer intents:** unsupported resources, regions and durations can be recorded separately from binding requests. Prose/typed budgets and canonical regions survive review. Flexibility defaults off; buyers explicitly choose minima, regions/durations, GPU constraint and hard total.
- **Concrete counteroffers:** bounded per-provider model projections select server-priced supported candidates. Proposals reserve nothing. Per-intent in-flight deduplication and a bounded 30-second state-validated cache avoid repeated model fanout; provider-only activity receipts show proposed and accepted decisions without exposing private limits to buyers. Before/after fields, supplier, exact fixed total and tradeoffs require explicit buyer acceptance.
- **Atomic direct acceptance:** source/intent resolution locks serialize duplicate, sibling and ordinary retry races. Acceptance rechecks current mode, approvals/resources, rate, offering revision/price, provider policy/reserve/capacity, ownership and global admission; it atomically freezes a new linked request/bid/hold and uses the existing award/provision owner, without a second auction. Rejections roll back; accepted lower budgets remain binding through later retries.
- **Unmet demand suggestions:** bounded, recent, unresolved current-mode aggregates omit identities/free text and resolved substitutes. Providers review server-priced 30-minute publication baselines and publish existing configurations; models select candidate IDs only. Public copy is constructed from catalog facts, and private policy is omitted from this offering prompt.

Muse remains explicitly fixture mode. Real structured-output contracts are implemented and tested offline with strict schemas, low reasoning effort, exact stop completion, projections/redaction and bounded calls. There is no claim of live Meta account/schema acceptance, latency or quality. Details: [docs/MUSE.md](docs/MUSE.md).

## Verification

- `npm run typecheck`: passed.
- `npm test`: **303/303 tests passed across 19 suites**, 31.66 seconds, with isolated local PostgreSQL schemas and no skipped database suites. The original baseline was 208 tests; the parent-review repair baseline was 274.
- Isolated production client/server builds passed: `NODE_ENV=production npx vite build --outDir .verify-dist/client` and `npx tsc -p tsconfig.server.json --outDir .verify-dist`.
- **9/9 browser cases passed in 59.2 seconds** on a fresh dedicated fixture database and port 3301, including the six existing cases and three new negotiation/demand cases.
- Focused overlapping checks passed: 32 negotiation database tests, 16 capacity-policy tests and 75 Muse adapter tests. Independent review separately ran nine targeted expiry, budget, retry and rollback regressions; unchanged demand/route coverage passed in the full suite.
- `git diff --check` and configured private-value scan passed. Private screenshots of provider strategy and exact buyer offer review were inspected; screenshots/traces remain outside Git.

Validation uses the existing dedicated TEST_DATABASE_URL with isolated schemas, plus a separate fixture browser database on port 3301. Browser tests exercise actual authentication/API/SQL/queues, explicit strategy consent, paused proposal generation, reviewed re-enablement, lost-response Apply replay without duplicate activity, private counteroffer receipts, buyer offer consent and simulated terminal/invoice/cleanup. No test connects to preview port 3000 or creates real compute. Validation built artifacts in `.verify-dist`; the reviewed artifacts were subsequently promoted to the preview’s `dist` during the coordinated cutover.

Independent review rechecked every parent finding against current code: expiry/rate age after locks, lower budget preservation, conservative money parsing, consent in generation/persistence/acceptance, true parallel-call deduplication, bounded durable Apply replay, private provider receipts, model-safe public copy and region parsing. Existing acceptance/retry/cancel ordering and atomic enqueue rollback remain intact. Findings were fixed and regressions added. Final SHA, each parent finding disposition, commands, changed files and private artifact locations are in the parent control handoff `READY-REVIEWED.md` under `/home/user/wick-workspace/.broker-run/muse-negotiation-20261028`.

## Historical real Wick evidence

The authorized 20-VM E2B run passed **only on `f96ee39a97297e5c0c2d578abadcce1715d71a9f`**, 2026-10-28 13:37:07–13:40:14 UTC. It observed 20 simultaneous running VMs and 20 real Broker terminal connections for 30.613 seconds, both 21st-request capacity probes, quote-matching invoices, confirmed termination and zero remaining holds. Muse was fixture. [docs/live-scale-results.md](docs/live-scale-results.md) preserves the exact benchmark and historical boundary; this new negotiation build has not been live-scale tested.

## Deployment and repeatable cutover

The existing preview has completed these steps. For another deployment:

1. Review committed changes and readiness results. Keep existing private credentials, database, accounts and `MUSE_MODE=fixture`; do not run any seed command.
2. Save a recovery point and coordinate the single-process cutover. Apply additive migrations `007_capacity_policy.sql`, `008_negotiation.sql` and `009_policy_apply_receipt.sql` with `npm run db:migrate` against the intended deployment database. These add policy revision tracking, intents/counteroffers and request resolution metadata without rewriting historical specifications or authentication.
3. At cutover, promote the verified production artifacts or build the normal `dist`, then replace the one existing app process. Do not run two Brokers against one database: worker startup manages leases. The implementation tests used isolated artifacts and a separate fixture database.
4. Check health/readiness, login, existing history and fixture Muse labels. New strategy/negotiation flows can be reviewed without accepting an allocation. Accepting a real E2B offer consumes Wick credit. Automated paid validation remains separate from the offline fixture suite.

`PUT /api/provider/policy` now requires `expectedRevision` and a stable `operationKey`; the UI and live-runner setup use the dashboard's current revision. Existing policy rows default to zero spare slots and preserve optional fields. Apply retains only the latest successful receipt; superseded original operations fail stale revision checks. Every new Apply consumes one revision even when its limits are unchanged. Existing holds survive policy/capacity changes. The current branch adds no services, Redis or dependencies.

## Explicit limits

Search is capped at four providers and twelve candidates per provider, with three selected offers; it is not an exhaustive supplier search. Offers expire after five minutes and stale state requires new review. Saved intents are immutable; a source request has one resolution, while separate needs use a new standalone intent. Fixture language parsing is deterministic and intentionally limited, so explicit editable review remains authoritative.

Real GPU capacity is not invented; GPU fixture offerings are labeled simulated. Real Meta remains unverified and disabled by the user's choice. Upstream ambiguity can require administrator cleanup reconciliation; uncertain holds are retained. Existing live-scale watchdog recovery constraints remain: never restart an unguarded real test app against a crashed scale database.
