# Five-buyer concurrent retest — November 3, 2026

Retested production commit `377adc4999b4e9caa71aea1896599c0af1bbb404` after PR #69 using three GPT-6.1 Sol agents at medium reasoning. No new application defects were confirmed in this run. No application code, provider settings or funding configuration changed.

This record precedes the subsequent request to raise model concurrency to five globally and five per provider. The four-call admission result below describes the configuration tested here.

## Five buyers running together

All five buyers launched one 15-minute micro VM each across E2B, Daytona, Modal, Sail and Tenki. Unlike the earlier exercise, every VM stayed running until all five reached readiness and completed the shared terminal window.

- All five VMs and terminal connections stayed active from **18:34:58.714Z to 18:35:29.136Z: 30.422 seconds**.
- Seven rounds per buyer produced **35 verified executions**, each with distinct-line command markers, a unique file written and read back, `Linux` from `uname`, a completion marker and a fresh pong.
- Six additional polling rounds each confirmed all five VMs still running. An independent native status snapshot at 18:35:25Z also showed all five running and ready.
- Same-key duplicate creates returned the same IDs; changed payloads returned 409. Duplicate termination requests were accepted without duplicate resources or invoices.
- Each VM produced exactly one demo invoice. These invoices are “No payment due” and do not debit Broker pilot wallets.

## Concurrent token purchases and model calls

At 18:34:43Z, each buyer purchased one 4,608-input / 256-output token pack for one cent, using simultaneous duplicate submissions with the same operation key. All five produced one order and one debit each. Mismatched replays returned 409. Invalid pack quantities were rejected with no credit change. Cross-buyer pack reads returned 404.

Five model calls were submitted within two milliseconds. Four returned HTTP 200 with authoritative usage; the fifth received the expected pre-dispatch `429 inference_busy` at the configured concurrency limit. Its quota remained untouched. There was no retry or extra native dispatch. Successful-call replays returned the documented receipt-only response, without another charge. All five pack keys were revoked and every token hold returned to zero.

New wallet spending was **$0.05 total**. Buyers 1–4 ended with **$4.99** each; buyer 5 ended with **$4.97**. All reserved balances were zero. Prepaid packs retain their normal expiry. The full 15-minute native VM catalog estimate was $0.0999, but that is not a settled upstream bill; all VMs were stopped early.

## Browser and isolation checks

Five independent browser contexts reused the five existing test sessions, avoiding extra login attempts. Desktop and 390px mobile pages showed all five Running inventories concurrently in 13 observations spanning 30.662 seconds. Forty-nine screenshots covered actual VM inventory, orders, requests, wallet and token form states. There were no console/page errors or horizontal overflow. All 20 foreign request reads returned 404.

The prompt allowance check introduced by PR #69 worked in all five contexts: insufficient input blocked purchase, and applying the computed allowance enabled purchase after acknowledgment. The browser observer made no purchases and opened no extra terminal sockets.

## Cleanup and verification limits

All five native VMs independently reported terminated with cleanup complete. Broker confirmed cleanup for all five and cleared stale failure messages. Modal was slower: native termination completed at 18:36:07.389Z and Broker confirmed it at 18:36:12.450Z. This was pending provider cleanup, not a stuck Broker hold.

At 18:37:35.219Z, the service was ready with the queue running, every provider had zero held slots, and the unresolved-cleanup list was empty. Railway HTTP logs for the exercise contained no 5xx responses. All five test sessions were explicitly signed out with HTTP 200 and subsequent `/api/me` checks returned no user. Cookies were removed from the private test journal. A local harness hook failed while deferring logout; the independent sign-out verification completed cleanup and was not classified as an application defect.

This was a bounded five-buyer exercise, not a long-duration soak or proof of capacity above five VMs. The four-call inference ceiling behaved as configured; five concurrent successful model calls are not claimed. Agent top-up workflows were not repeated because these buyers have no agent grants. The anonymous demo admission cap was not saturated by this authenticated-buyer test.

Compact evidence: `buyer-concurrent-retest-2026-11-03.json`. Browser artifacts are under `verification-results/five-buyer-observer-20261103/`; detailed local harness reports are `/tmp/buyer-five-barrier-report.json` and `/tmp/buyer-token-five/report.json`. No credentials or active session/pack keys are included in the compact evidence.
