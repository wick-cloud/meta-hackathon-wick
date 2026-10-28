# Wick Broker — current reviewed handoff

The provider commission update is deployed to the existing preview on `codex/broker-real-wick`, based on `5c846952fa1d54642d4a8db00c5a5726e1c07a8d`. Verification and cutover completed on 2026-10-28. Migration 010 was applied, the verified build was promoted, and health/readiness confirmed real Wick with fixture Muse. Existing accounts, sessions and rental history were preserved without seeding; zero active VMs or open auctions were present at cutover. A private recovery snapshot and preceding build remain outside Git.

## Business model

Broker takes exactly **15% of the provider's gross rental price**. The provider retains **85% before compute costs**. The buyer pays the accepted fixed total with no added Broker fee. This replaces the prior configurable 20% target markup for new business. Payments and payouts remain absent; invoices explicitly say **No payment due**. Upstream real Wick compute still consumes real credit.

New suggested managed quotes and gross bid floors use `max(1, ceil(upstreamEstimateMicros / 8500))` cents. This leaves enough in the provider's 85% share to cover the raw full-term compute estimate. Provider price limits and buyer budgets remain gross totals. Manual prices may be higher within the saved policy and buyer budget. Muse cannot set the commission or supply an arbitrary model-generated price.

Exact integer micro-USD preserves fractional-cent shares: a $0.03 rental has a $0.0045 Broker commission and a $0.0255 provider share. A binding bid freezes its split; award and readiness copy it, with one invoice in the readiness transaction. Reviewed counteroffers also freeze the split, and old nonbinding proposals require renewed review. Historical accepted bids, VM quotes and invoices are unchanged. Historical records without a frozen split show **Not assessed**, rather than a retrospective fee.

## User experience

Provider Capacity and Capacity Manager explain the 85/15 model. Policy base prices, manual bids and offering publication show gross, Broker commission and provider share before costs. The new **Earnings** page shows fixed invoice splits, loaded-record summaries and honest historical labels. The API authorizes the provider before SQL keyset pagination and does not expose buyer identity. A provider/time/ID index supports growing invoice history.

Buyer request review, alternatives, VM details and invoices explain that no Broker fee is added. Existing VM access, finite rentals, explicit buyer acceptance, provider strategy review and offering publication stay in one application. Customers receive an environment and run their own commands; the app does not run customer workloads or agents.

## Verification actually run

- Linux Node 24 / PostgreSQL: **312/312 tests across 20 suites passed**, including isolated SQL suites; no database skips. Full-suite duration: 27.08 seconds.
- **9/9 browser scenarios passed in 59.3 seconds** against a separate fixture database on loopback port 3301. Coverage includes exact small-price splits, earnings pagination, historical exclusions, normal auction and negotiated invoices, provider accounting and role isolation.
- Initial expanded browser run had nine passes and a final sign-in failure: its eleventh login exceeded the unchanged 10/minute sign-in limit. Earnings assertions were combined with the existing provider sign-in; authentication failures are now reported immediately. Production authentication protections were not weakened.
- Final focused provider-earnings SQL suite passed all three tests, including the stronger rows-removed bound; 13 focused Muse route/demand checks passed after obsolete markup test configuration was removed. Typecheck and isolated production client/server builds passed. Independent arithmetic/formatting review passed 13,024 cases.
- Representative `EXPLAIN (ANALYZE, BUFFERS)` used disposable schemas: 20 and 10,020 invoice histories. At the larger size, first and cursor pages read 21 invoices through the provider index, performed 21 VM primary-key lookups, removed no rows by filter and did not spill. These are local query-plan observations, not live-provider scale claims.
- Local macOS cannot run the Linux `flock` safety harness; the complete Linux run above is authoritative. No new paid VM or Meta call was used in this verification.

Private test reports, browser artifacts and query plans remain outside Git in the provider-commission control directory. The two fixtures use dedicated test databases and isolated schemas; they never use preview port 3000 or the preview database.

## Deployment and retained boundaries

The existing preview uses one Node app, PostgreSQL and tmux `wick-broker` on port 3000, with **real Wick/E2B and fixture Muse**. Its existing Boat VM is only the development/app host; Boat customer integration is excluded. Preserve private `.env`, accounts, passwords, sessions, policies and rental history. Never run the account-reset seed during cutover. Migration `010_provider_commission.sql` is additive: it permits the new pricing model, adds a nullable invoice split with strict accounting checks, and creates the provider earnings index. No historical economics are backfilled.

The public Wick SDK remains `@wick-cloud/sdk@0.1.0-rc.0`. Exact managed routing, rate freshness, frozen upstream caps, scoped terminal ownership, capacity reserves, idempotency and confirmed cleanup are preserved. Muse remains explicitly fixture; real Meta account interoperability, quality and latency are unverified. Payments/payouts and live provider-capacity discovery are not implemented. Supplier accounts and configured slot limits remain demo marketplace supply.

The historical 20-VM E2B proof applies only to `f96ee39a97297e5c0c2d578abadcce1715d71a9f`, as recorded in [docs/live-scale-results.md](docs/live-scale-results.md). It is not a live scale test of this commission update. New counteroffer search remains bounded to four providers, twelve candidates per provider and three output offers, with five-minute expiry; it is not exhaustive marketplace search.
