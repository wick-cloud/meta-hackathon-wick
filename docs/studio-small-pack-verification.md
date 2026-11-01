# Studio small-pack verification — 2026-11-01 UTC

Base: `ab43fe8` (PR #31). Checks ran against a local Broker app and disposable PostgreSQL 17 databases. Baseten and Modal inference, Wick provisioning and guest execution were real. Production Railway records, variables, credentials and routes were not changed.

## Purchase regression

The reported forecast of 13,443 input / 3,346 output now sizes the first purchase to **14,788 / 3,681**, when the qualified next-request reservation fits. The prior 1,068,741 / 7,067 purchase included a full-context input floor and additional headroom. Existing saved purchases are immutable.

New first purchases add 10% to each forecast dimension. A definite allowance admission failure can open a small refill using settled consumption and the saved next request. Unknown outcomes retain their holds. Provider reservation minimums remain authoritative; estimates cannot lower them.

## Real provider flows

Each run used a fresh $1 pilot wallet, one published inference seller and one real E2B Micro VM in `us`. Both model and compute auctions kept their real 30-second deadlines. Each provider was tested separately so generation could not silently fall back to the other provider.

The task added a Python greeting module and stdlib regression tests to the pinned public `octocat/Hello-World` repository. During the compute auction, an owner-issued grant key made three real metered calls to exhaust the initial output quota. No balances, usage receipts or auction clocks were overwritten. Inference consumed prepaid quota without another monetary charge. The subsequent coding job had to buy more through the normal marketplace.

| Check | Baseten | Modal |
| --- | ---: | ---: |
| Expected input / output | 17,324 / 4,240 | 17,324 / 4,240 |
| First purchased input / output | 19,057 / 4,664 | 19,057 / 4,664 |
| Real requests, including three load calls | 14 | 12 |
| Task-only settled input / output | 12,280 / 3,453 | 9,864 / 3,691 |
| Refill auctions | 6 | 5 |
| Broker model purchases | $0.2181 | $0.1934 |
| Broker compute charge | $0.0300 | $0.0300 |
| Unspent credit returned | $0.7519 | $0.7766 |
| Unresolved calls | 0 | 0 |
| Guest tests, retained patch, browser receipt | Passed | Passed |
| One logical native allocation, original deadline | Passed | Passed |
| VM cleanup confirmed | Yes | Yes |

These Broker prices use the test seller's published $1.70/M input and $5.60/M output ask, with the existing 15% provider fee. They are pilot wallet amounts, separate from native provider invoices and external payment collection. Native cleanup acknowledgment does not establish asynchronous physical purge.

The first-purchase buffer does **not** cap total purchases at forecast + 10%. Actual input usage can be much lower than its conservative reservation, and a request still needs sufficient input and output in one compatible pack. Pack-specific quota can therefore require several refills while leaving unused input elsewhere. Unused prepaid quota remains non-refundable. The deliberate quota-exhaustion scenario is not an estimate-accuracy or utilization benchmark.

Private redacted report SHA-256 values (credentials and response bodies excluded):

- Baseten: `343d145eb91f7bb7924fb42cdd2f87f5448094a3f45d885e8f551af9a51ffac2`
- Modal: `5e6a5abd7d108310c086e702d23fe425f496bb3932439f77384504d0a83fd267`

## Accounting and execution checks

Native diagnostics exercised JSON, Unicode/normalization expansion, template-like text, long code, 64 messages and the actual 2,048-token output limit. Eleven Baseten attempts returned validated usage. Eight of ten Modal attempts returned validated usage; two 8-token truncation probes had contradictory reasoning counters and were rejected. Larger output-budget probes completed. The existing one-token platform exception was not expanded. Strict quarantine and unresolved-usage behavior remains covered by tests.

Native JSON-object output was checked on both providers. Internal planning/coding uses it while retaining strict response validation. Invalid absolute, traversal and Git-metadata paths are rejected before guest execution; the existing bounded settled-action correction can then request a valid action. The guest filesystem checks remain authoritative. Exploratory six-file runs at low reasoning were stopped after repeated reads; those runs are not completion passes. Arbitrary multi-file task quality has not been established.

The final prompts use reasoning strength 8 for planning and 32 for coding. Eight command receipts, the latest model decision and up to 40 confirmed write paths form bounded context. Oversized context omits whole records and stays valid JSON within the encoded request budget.

## Local verification

- `TEST_DATABASE_URL=... npm run check`: **878 tests passed**, including disposable PostgreSQL, typecheck, app build and SDK/CLI/MCP builds.
- Relevant browser suites: Studio usage/planning, coding outcomes and inference marketplace, **43 checks passed** on desktop/mobile cases. Final copy distinguishes the initial 10% buffer from later reservation floors.
- Database query checks use 10,000 historical jobs/steps and `EXPLAIN (ANALYZE, BUFFERS)` to verify indexed, job-scoped reads and bounded returned rows. No new index is needed.
- Unicode and escaped-output checks verify bounded valid JSON; concurrent spending, idempotency, unknown usage and existing VM workflows remain covered.

Live tests are opt-in: `RUN_STUDIO_LIVE_TEST=1`, `STUDIO_LIVE_PROVIDER`, a fresh loopback `STUDIO_LIVE_DATABASE_URL` named `broker_studio_live_test_*`, private Wick/model credentials and reviewed qualification input are required for `npm run test:studio-live`. Each run caps logical VM creation at one, native model dispatches at 30 and pilot funding at $1. Credentials are never written into the repository or report.

## Rollout boundary

Finite live probes do not prove accounting for every accepted input or renew qualification. The request-sized UTF-8 method and native JSON behavior require independent operator review. Production certificates were not changed. A legacy fixed-context route cannot start new automatic Studio tasks under this change. Before rollout, reconcile/retire old commitments and install reviewed certificates with the new accounting fingerprint; existing manual packs and accepted prices are not rewritten. This branch was not deployed.
