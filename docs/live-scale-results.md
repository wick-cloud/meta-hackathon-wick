# Live E2B scale validation — 2026-10-28

The authorized run passed on commit `f96ee39a97297e5c0c2d578abadcce1715d71a9f`, from 13:37:07 to 13:40:14 UTC. This records observed behavior for one bounded run, not a production capacity guarantee.

## Scope and observed result

- Public `@wick-cloud/sdk@0.1.0-rc.0`; real Wick environments, E2B Micro/us.
- One Broker app with PostgreSQL. Customer environments only; no customer agent, task, repository, or setup execution. A bounded terminal marker command was used solely for this authorized diagnostic.
- Exactly 20 distinct native create keys and 20 real VMs observed running simultaneously.
- 20 authenticated Broker terminal WebSockets proved decoded marker output and fresh pongs, remained open concurrently for **30.613 seconds**, and passed the final liveness checkpoint.
- One successful canary preceded the remaining 19 allocations. Normal 30-second auctions were preserved.
- Supplier capacity rejected request 21 at capacity 20. After the supplier capacity was raised to 21, the global limit of 20 rejected its award: no 21st VM, create key, or invoice.
- 20 unique demo invoices matched their frozen accepted quotes.
- All 20 native environments had confirmed terminated status. Broker provider holds returned to zero. No unresolved resources remained; runner and independent watchdog exited successfully.
- Boat was excluded from customer integration and this test. The existing Boat development/app host remained running.
- Muse was explicitly in fixture mode; this run made no Meta model calls.

## Timing

Nearest-rank percentiles over the 20 rentals:

| Measurement                                   |      p50 |      p95 |  Maximum |
| --------------------------------------------- | -------: | -------: | -------: |
| Auction-close queue delay                     |  4.719 s |  8.732 s |  9.698 s |
| Provisioning: Broker VM record to ready       | 11.552 s | 12.007 s | 12.064 s |
| Request to ready, including 30-second auction | 44.608 s | 50.739 s | 51.250 s |

Worker concurrency remained auction close 2, auto-bid 4, provisioning 2, cleanup 2. Native create starts were independently limited to five per second and 20 distinct keys.

## Price basis and cleanup evidence

The live Wick catalog rate was 23 micro-USD/second. A full 900-second Micro rental therefore had an upstream compute estimate/reservation of $0.0207; 20 full terms correspond to $0.414. Each default Broker quote was $0.03 after the configurable 20% target markup and one upward cent rounding. The total demo invoice value was $0.60. These are full-term estimates and demo quotes, **not settled Wick usage or collected payments**. Actual VM lifetimes were shorter because cleanup completed before the 15-minute TTL.

A private fsynced journal recorded all intents, exact resource ownership, cleanup acknowledgments and the aggregate report. Credentials, native IDs, organization/team identifiers, terminal transcripts and test-account credentials are deliberately excluded from this repository. Terminated acknowledgments do not assert asynchronous physical data purge.

## Verification boundary

The scale benchmark used the commit above. Subsequent catalog-refresh scheduling and UI billing wording changes were checked separately and did not trigger another paid scale run. The same offline suite includes SDK contracts, discovery-only cleanup, uncertain-admission guards, price freezing, tenant isolation and terminal behavior. See [live-scale.md](live-scale.md) for the bounded runner and recovery rules.
