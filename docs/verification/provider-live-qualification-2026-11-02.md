# Four-provider live qualification — 2026-11-02

**Status: all four providers passed live qualification, confirmed cleanup, and are enabled in production with one slot each.** The run completed at **10:47:22 p.m. America/New_York on November 2, 2026** (`2026-11-03T03:47:22.599Z`). Activation completed at **10:48:44 p.m. Eastern** (`2026-11-03T03:48:44.505Z`).

## Scope and deployed revision

PR #42 was merged and Railway deployed commit `3286db792cd17d80e746ab609aec145d2e32c181` successfully. Health, readiness, and the application returned HTTP 200, and the job queue was running. See the earlier [account staging and implementation receipt](provider-expansion-2026-11-02.md).

The live run used one 15-minute Broker rental for each initial route: Sail Micro, Tenki Micro, Freestyle Small, and Boat Small. Requests froze the exact provider, profile, resources, offering, and quoted base price. Requested region was `auto`; a nonempty native resolved region was recorded separately when present. No provider fallback was allowed. The test runner had a 12-minute maximum and an independent cleanup watchdog.

Each account retained one slot and `autoBid=false` during qualification. The selected catalog and existing offering were exposed briefly to submit the owned test request's reviewed manual base bid, then immediately restored to unapproved/inactive. No other profiles or additional capacity were enabled by the test.

## Confirmed observations

- All four native environments reached `running` with the expected managed provider/profile and owned Broker identity.
- All four passed initial, refreshed, and final strict Broker PTY proofs, including a **130,992 ms** terminal hold. The checks required terminal input/output, persistent shell state and working directory, and observed resize to 113 columns by 37 rows. Capability flags, socket readiness, and echoed commands did not count as proof.
- All twelve read-only duration previews—15, 30, and 60 minutes for each initial route—were eligible with the exact route and no fallback. Only the four 15-minute rentals were allocated; longer previews are not live duration tests.
- Each owned rental has exactly one frozen Broker invoice, matching its reviewed base total. Buyer fee is zero and the gross split is 15% Broker / 85% provider. These are Broker demo invoices; the report does not infer actual upstream compute spend from them.

| Provider  | Initial route                   | Frozen total | Broker share | Provider share before compute |
| --------- | ------------------------------- | -----------: | -----------: | ----------------------------: |
| Sail      | `sail:micro:auto`               |      $0.0360 |      $0.0054 |                       $0.0306 |
| Tenki     | `provider-tenki:micro:auto`     |      $0.0600 |      $0.0090 |                       $0.0510 |
| Freestyle | `provider-freestyle:small:auto` |      $0.1080 |      $0.0162 |                       $0.0918 |
| Boat.dev  | `boat:small:auto`               |      $0.0240 |      $0.0036 |                       $0.0204 |

The quoted totals are saved base prices established against a 30-minute reference, used unchanged for these reviewed 15-minute bids. They are not universal prices for every duration.

## Completed acceptance results

| Acceptance check                                                     | Sail | Tenki | Freestyle | Boat.dev |
| -------------------------------------------------------------------- | ---- | ----- | --------- | -------- |
| Final native identity and unexpired rental                           | Pass | Pass  | Pass      | Pass     |
| Broker PTY after at least 130 seconds                                | Pass | Pass  | Pass      | Pass     |
| Explicit direct-SDK scoped renewal and fresh post-renewal PTY output | Pass | Pass  | Pass      | Pass     |
| Broker cleanup confirmed and native termination observed             | Pass | Pass  | Pass      | Pass     |
| Held slots returned to zero                                          | Pass | Pass  | Pass      | Pass     |
| Test catalog/offering exposure restored                              | Pass | Pass  | Pass      | Pass     |

Broker terminal continuity and direct-SDK renewal are separate evidence. For each of the four existing native environments, the optional SDK observer received an explicit renewal event, observed **two scoped-session responses**, and then received a fresh PTY proof marker with retained shell state. It created no VM. All observer PTYs closed; the main runner closed its Broker terminals during cleanup.

The main report records `validationPassed=true`, four invoices and four native environments, and cleanup `{confirmed:true, unknown:0, pending:0, holdsReleased:true, nativeConfirmed:4, listingsRestored:true}`. The local report is `../.broker-run/real-wick-20261028/qualification-20261102/live.jsonl.report.json`, relative to the repository root. Its detailed identifiers remain private.

## Production activation

After both the runner and independent watchdog confirmed cleanup and exited, each qualified initial catalog was approved, its existing offering activated, and its fresh provider policy applied with only `autoBid` changed to `true`. Readback confirmed exactly one approved catalog and one active offering per new provider, capacity one, held slots zero, and unchanged base/minimum/maximum prices, reserve slots, and catalog allowlists. Policy revisions advanced from one to two. The shared global limit remains 20.

These one-slot providers use the deployed base-price bidding behavior. Higher-duration quotes still enforce the current compute floor. No additional test rental was created for activation. This run does not qualify additional profiles, sustained production load, eight-provider concurrent scale, full-duration expiry, or live model discount decisions.

## Local verification and evidence handling

The focused qualification/helper checks passed 32 tests; TypeScript and the production build passed. These local checks support runner correctness and do not substitute for the live results above. Earlier implementation and browser coverage retain the scope recorded in the staging receipt.

Detailed timestamps, native identifiers, request identifiers, and sanitized execution receipts are retained in the private run journal. Credentials, tokens, cookies, organization identifiers, account email addresses, and terminal transcripts are omitted from this public report.

After activation, `/health`, `/ready`, and `/` returned HTTP 200. All six temporary verification sessions were signed out and the temporary settings file containing service credentials and cookies was removed. The four provider account credentials remain in the operator's private account artifact.
