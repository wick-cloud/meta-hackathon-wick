# Production buyer exercise — November 3, 2026

Production: https://meta-hackathon-wick-production.up.railway.app. Three GPT-6.1 Sol agents at medium reasoning exercised the five funded demo buyer accounts, browser pages, and local concurrency tests. This report records the pre-fix exercise; application code and provider configuration were not changed during that exercise.

## Follow-up fixes

The subsequent fix recognizes the documented failed-launch cleanup proof, retains ownership and disk-detachment safeguards, preserves the original failure through later termination and clears obsolete cleanup messages. Wallet purchases now require a usable standalone input allowance, route output minimums reach the composer, and an optional local sample-prompt check sizes a single user message using the server's unchanged accounting envelope. Agent top-ups and completed purchase replays preserve their existing behavior. The lower-priority VM cancellation deadline question remains a product-contract observation, outside these confirmed bug fixes.

## Result

All five buyers completed a real VM auction, terminal command and confirmed termination across E2B, Daytona, Modal, Sail and Tenki. A separate Boat canary failed before readiness and exposed a cleanup accounting defect. Six VMs were allocated in total. Five request/provisioning lifecycles overlapped, but the highest confirmed overlap of ready VMs was two because each was stopped promptly after its terminal check. This is a bounded concurrent buyer exercise, not a sustained five-running-VM capacity test or a saturation test of the anonymous demo limit.

| Buyer | Provider | Admission to ready | Demo invoice | Final wallet | Cleanup   |
| ----- | -------- | ------------------ | ------------ | ------------ | --------- |
| 1     | E2B      | 8.2 seconds        | $0.0450      | $5.00        | Confirmed |
| 2     | Daytona  | 4.1 seconds        | $0.0450      | $5.00        | Confirmed |
| 3     | Modal    | 67.2 seconds       | $0.0100      | $5.00        | Confirmed |
| 4     | Sail     | 13.3 seconds       | $0.0324      | $5.00        | Confirmed |
| 5     | Tenki    | 3.5 seconds        | $0.0540      | $4.98        | Confirmed |

Each successful VM produced exactly one demo invoice. The total was $0.1864, explicitly “No payment due”; standard VM rentals do not debit the Broker pilot wallet. The failed Boat canary produced no invoice. Catalog estimates for all six complete 15-minute native VM lifetimes totaled $0.1044, but this is not a settled upstream bill. VMs were terminated before their full lifetimes.

Two one-cent wallet token purchases used two cents of buyer 5's credits. One demonstrated an unusable minimum pack; the second successfully ran one Baseten completion. All wallets ended with zero reserved credit. No new credits were granted.

## Confirmed defects

### High priority: failed launches with completed native cleanup retain Broker capacity

Boat request `2cb87044-5193-4919-8b98-7172d8dcdc72`, Broker VM `c497559a-b2b3-44e8-bb51-e1304dcd192a`, native environment `env_46267607a3e6498a8ef7c2f20a9f973e` failed before terminal readiness. Wick reported launch reason `internal`; the specific provider-side cause was not established.

The official SDK returned `status: failed`, `launch.state: failed`, `launch.cleanup: complete`, and `terminatedAt: 2026-11-03T18:12:31.600Z`. Broker continued showing cleanup pending and retained the provider hold. `parseEnvironment` in `src/server/integrations/wick.ts` retains these fields only in `raw`, while `cleanupVm` in `src/server/marketplace/lifecycle.ts` recognizes only `status === 'terminated'`. Failed-but-cleaned environments therefore continue retrying and occupying capacity.

Recommended correction: preserve and validate the authoritative cleanup fields, then recognize the narrow failed-launch/completed-cleanup proof while retaining exact ownership, adapter-mode and persistent-disk detachment checks. Do not treat failure or a termination timestamp alone as cleanup proof. Regression tests should cover pending/missing cleanup, invalid timestamps, mismatched ownership, attached disks, and observations both before and after a termination request.

Test cleanup: after independently re-reading the exact native resource and validating its ownership, buyer, status, lack of disk, lack of readiness and zero invoices, the existing deployed `confirmCleanup` domain function reconciled this single test VM at `2026-11-03T18:17:42.860Z`. It released the hold and retained a failed outcome with no invoice. The temporary Railway SSH key was removed. This operational cleanup of the test record did not itself fix the application defect; the follow-up code change is described above.

### Medium priority: the minimum standalone input pack cannot run a nonempty prompt

The UI and route catalog advertise a minimum of 4,128 input tokens. A wallet purchase of 4,128 input / 256 output tokens succeeded for one cent. A subsequent completion with `Reply with only OK.` and `max_tokens: 256` returned HTTP 409 before native dispatch because there was insufficient compatible prepaid input allowance.

`minimumInputReservation` in `src/server/inference/runtime.ts` returns 4,128 for request-sized accounting, but `inputReservation` requires 4,096 plus 32 per message plus the message's UTF-8 byte envelope. The tested single message requires 4,147; every nonempty single message requires more than 4,128. A key for this wallet pack cannot pool quota from another wallet purchase. The financial guard behaved correctly; the defect is allowing purchase of a standalone minimum that cannot serve a useful request.

Order `5e67e8ea-d427-42b2-98f9-aca3b0fc71f5`; pack `f30d0278-468a-4ed4-a58e-8162588fd541`. The pack retained all its quota, held zero tokens, and its test key was revoked. Its prepaid quota expires at `2026-11-03T20:12:38.402Z`; no refund was fabricated. The purchase flow should explain or estimate a usable request envelope and prevent unusable standalone pack sizes.

### Medium priority: output quota validation permits a pack no current route can serve

On `/token-orders/new`, setting input to 4,128 and output to 1, then accepting the prepaid terms, leaves the form valid and the auction button enabled. Production quotes for those quantities return zero eligible offers; changing output to 256 returns two eligible one-cent quotes. The invalid auction was not submitted.

`src/client/inference.tsx` hardcodes output `min={1}` and only rejects output below 1. `routeView` in `src/server/inference/runtime.ts` omits `minimumOutputTokens`, although current qualified routes require at least 256 and the server enforces that in `src/server/inference/market.ts`. Expose route limits to the composer and validate usable output allowance, while preserving legitimate top-ups for compatible agent quota.

### Lower priority: lifecycle messages remain stale or erase the original failure

`requestCleanup` preserves an existing VM polling message with `COALESCE(failure_reason, ...)`; a later owner termination overwrites a pre-ready request's upstream failure with a cancellation message. Successful terminated VMs also retained “Waiting for Wick to confirm environment cleanup” in `failureReason` despite `cleanupPending: false` and a confirmed timestamp. Keep the original failure cause separate from current cleanup progress and clear obsolete progress messages after success.

## Passing checks

- Simultaneous same-key creates returned the same request ID; changed payloads with the same key returned HTTP 409. Duplicate terminations did not create extra resources or invoices.
- Buyers 2–5 received HTTP 404 when reading buyer 1's request and VM; the owner could read them.
- All five provider terminals returned a unique command marker and `Linux` from `uname -s`. Actual file-content output was captured for Daytona only; the other terminal checks closed before capturing that later output.
- The successful 4,608-input / 256-output pack cost one cent and returned HTTP 200 from Baseten. Receipt `4a03ee42-c18b-4420-93b2-ee9504573357` reported 150 input and 58 output tokens, with zero remaining holds. Same-key purchase replay kept the same order; completion replay correctly returned receipt-only `completed_without_result` behavior without redispatch or another wallet debit.
- Twenty-six browser page visits at desktop and mobile sizes had no console/runtime errors, failed data reads or document overflow. This covered orders, credits, purchase forms, agents, Studio, VMs, disks, tokens, invoices, API keys and alternatives.
- 112 targeted tests passed in a fresh disposable local PostgreSQL cluster: 95 marketplace/operation/agreement/order tests and 17 selected inference wallet/concurrency tests. The cluster was stopped afterward.
- Authentication rate limits were encountered during repeated test logins and honored. A harness sign-out without Origin received an expected CSRF rejection; corrected cleanup succeeded. Neither was classified as an application defect.

## Additional behavior to review

An offline reproduction showed that a VM auction still marked `open` can be cancelled after its database deadline if its closing worker is delayed. Token auctions reject late cancellation. `cancelRequest` checks status but not `closes_at`. Treat this as a possible contract inconsistency, rather than a demonstrated financial exploit, until the intended VM cancellation deadline is confirmed.

## Final state and evidence

At `2026-11-03T18:18:05.444Z`, `/ready` reported ready with the queue running, every provider held zero slots, and the admin unresolved list was empty. Independent Wick status reads confirmed all five successful environments terminated with cleanup complete; the Boat failure's cleanup was independently confirmed and its Broker hold reconciled. All established test sessions were signed out, test pack keys revoked, and no active test VMs remained. The two prepaid packs remain in buyer 5's purchase history with their normal expiry.

Sanitized evidence is saved beside this report in `buyer-stress-2026-11-03.json`. Local detailed reproduction artifacts are `/tmp/buyer-ui-stress/findings.md`, `/tmp/buyer-ui-stress/output-one-enabled.png`, `/tmp/broker-live-compute-summary.json`, and `/tmp/buyer-late-cancel-audit.mts`. No credentials, session cookies, provider keys or token-pack keys are included in this report.
