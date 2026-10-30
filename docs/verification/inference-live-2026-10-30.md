# Live inference marketplace verification — 2026-10-30

Both Baseten and Modal passed a separately authorized, paid buffered-text pilot against an isolated loopback Broker app and disposable Postgres. This does not describe a Railway deployment. Each run used fresh buyer/provider/operator accounts and admin-funded pilot credit, real native inference credentials, actual browser sessions, durable queues and packaged clients. VM provisioning and internal Muse helpers stayed in fixture mode and were not invoked by the inference flow. No paid VM was allocated.

## Marketplace results

| Check                                                                           | Baseten                                      | Modal          |
| ------------------------------------------------------------------------------- | -------------------------------------------- | -------------- |
| Owner funds grant and issues restricted agent key                               | Passed                                       | Passed         |
| Supplier publishes pricing through authenticated provider API                   | Passed                                       | Passed         |
| 30-second auction receives the selected supplier policy's bid                   | Passed                                       | Passed         |
| Saved Orders view observes award without manual refresh                         | 32.646 seconds from submit to observed award | 32.638 seconds |
| Pack purchase, quota reservation and native settlement                          | Passed                                       | Passed         |
| SDK, CLI and MCP use real inference                                             | Three calls                                  | Three calls    |
| Duplicate operation makes no additional native call                             | Passed                                       | Passed         |
| Insufficient budget / unsupported output allowance blocked before dispatch      | Passed                                       | Passed         |
| Agent cannot fund itself; replacement revokes prior key without resetting spend | Passed                                       | Passed         |
| Provider commitments appear in browser                                          | Passed                                       | Passed         |
| 15% provider fee, wallet invariant and no second inference charge               | Passed                                       | Passed         |
| Closed grant, revoked test keys, purchase holds / unresolved calls              | 0 / 0                                        | 0 / 0          |

These were Broker policy bids published by controlled test supplier accounts mapped to the real routes. Neither company was contacted to place a bid, and the native inference APIs do not themselves implement an auction. Each isolated auction restricted the grant to the provider under test; these runs do not claim a two-supplier competitive live auction.

Native completion receipts from the six marketplace calls:

| Client                    | Provider | Prompt tokens | Agent completion tokens | Native latency |
| ------------------------- | -------- | ------------: | ----------------------: | -------------: |
| SDK                       | Baseten  |           153 |                      43 |         708 ms |
| CLI                       | Baseten  |           153 |                      64 |         668 ms |
| MCP                       | Baseten  |           153 |                     146 |       1,146 ms |
| SDK, intentionally capped | Modal    |           152 |                       8 |         589 ms |
| CLI                       | Modal    |           152 |                     213 |         577 ms |
| MCP                       | Modal    |           152 |                     228 |         639 ms |

The Modal SDK call intentionally ended during reasoning, proving bounded settlement without a final answer. The other five calls produced the expected final answer. Each run bought three packs for $10.27 of disposable pilot credit; this is prepaid quota pricing, not the cost of the few tokens generated during the test and not a payment collected from a customer.

## Modal's platform-paid token

Direct native probes showed reasoning counts of 9 with 8 completion tokens and 129 with 128 completion tokens on truncated responses. A completed response was consistent: 187 completion tokens, including 180 reasoning tokens. The actual billing interpretation of that extra diagnostic token has not been confirmed by Modal.

The owner explicitly authorized Wick to absorb exactly one token. The gateway therefore charges the pack only the reported completion count and atomically records a `platform_output_absorbed` event for the extra token. The live Modal SDK receipt consumed 8 output tokens and recorded **one Wick-paid token**, with no extra buyer charge or unresolved hold. This exception applies only to Modal. Larger discrepancies, conflicting detail counters and invalid totals still fail closed; authoritative completion usage must still fit the agent's reservation. Offline database tests verify single-event settlement on replay and quarantine for a larger discrepancy.

## Qualification scope and limitations

- Baseten used the pinned hackathon model `meta-models/muse-spark-open-1026`. Authenticated Modal model discovery identified the user's SharedEndpoint; its responses identified `meta-models/Muse-Spark-Open-816B-A42B`. Credentials, endpoint account identifiers, prompts, answers and reasoning traces are excluded from this record.
- Both pilot certificates used a conservative **1,048,576-token input reservation** based on [Meta's documented context ceiling](https://dev.meta.ai/docs/muse-spark-open/settings), rather than claiming an exact tokenizer. Each pack contained 2,000,000 input tokens. This reserve is intentionally expensive in available quota for small packs; a tighter reservation requires separately verified token counting.
- Pilot output caps were **512 tokens**, with separate truncation probes at 8 and 128 tokens. Usage totals were validated against prompt plus completion tokens; reasoning was counted once. This does not qualify tools, streaming, multimodal input or every provider output limit.
- Baseten Unicode/system-message input and a pre-generation HTTP 400 rejection passed. Modal rejected an invalid role with HTTP 400. Modal accepted native `max_tokens: 0`; Broker rejects zero before dispatch and does not rely on it as a rejection probe.
- No private qualification certificate is shipped. Production defaults remain gated and require private credentials, reviewed qualification and an explicitly authorized deployment.

Reproduce with the opt-in `npm run test:inference-live` diagnostic and the private variables described in [the marketplace guide](../inference-marketplace.md#verification-record). It permits at most three native completion attempts per provider run and never automatically retries an uncertain call. Raw redacted probe metadata and screenshots were retained privately outside Git.

## Local regression checks

- All-source TypeScript and production app build passed.
- Adapter, pricing and disposable-Postgres marketplace suites: **89 tests passed**, including atomic platform absorption, duplicate settlement and quarantine beyond the one-token allowance.
- `test:developer-e2e` passed the existing fixture VM auction, provider bid, SDK/MCP terminals and cleanup, plus SDK/CLI/MCP token purchases and inference through another real-time 30-second auction. These regression calls used fixtures, separately from the six real marketplace completions above.
- The live harness's unqualified-route preflight exited cleanly with zero native attempts. Patch credential scanning and whitespace checks passed.
