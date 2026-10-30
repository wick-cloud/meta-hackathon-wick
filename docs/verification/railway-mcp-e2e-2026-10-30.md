# Railway MCP end-to-end verification — October 30, 2026

**Result: Baseten's task-to-VM inference flow passed. Modal's inference accounting failed and remains unresolved.** Both providers placed real bids before Modal was automatically quarantined.

This was an explicitly authorized live test from Codex against [Broker production](https://meta-hackathon-wick-production.up.railway.app), not a fixture run. The successful run lasted 14:07:29–14:08:27 America/Vancouver (21:07:29–21:08:27 UTC). [Sanitized evidence](railway-mcp-e2e-2026-10-30.json) contains timestamps, order and receipt IDs, quota snapshots, release hashes and cleanup acknowledgments.

## Environment and scope

- Railway deployment `f46c8854-4ed0-484d-a18b-962749797c32`, main commit `42a28da0b1173181d8ee5c672a968fcbfc61dc76` (PR #17).
- SDK, CLI and MCP **0.3.0**, installed together from the live `/downloads/0.3.0/` archives. SHA-256 and byte sizes matched the published manifest.
- Codex launched the released MCP executable over stdio and exchanged JSON-RPC `initialize`, `tools/list` and `tools/call` messages using protocol `2025-11-25`. No permanent Codex MCP configuration was changed.
- Native model: Meta Muse Spark Open through Broker's `meta/muse-spark-open` gateway route. VM: E2B Micro, US, 1 CPU / 2 GiB, 15-minute deadline.
- Owner session/API setup funded temporary grants from existing pilot credit and issued purchasing, compute and batch keys. Model-provider secrets never reached the MCP clients or VM.

## Successful Baseten run

Run ID: `f11b4c94-4941-4775-aed9-bcfe42af1771`.

1. The purchasing MCP client read real quotes and submitted `token_order_create` for **1,050,000 input / 512 output tokens**, with a $3.0000 ceiling. Its grant permitted Baseten only.
2. The saved [30-second auction](https://meta-hackathon-wick-production.up.railway.app/token-orders/0da9694b-61f8-49c1-813b-28d7a93cc4c4) awarded the pack for **$1.7879**. The pack retained its fixed expiry of 16:07:29 PDT / 23:07:29 UTC.
3. The compute MCP client submitted `auction_create` for one E2B VM with a $0.2500 ceiling. The accepted quote was $0.0500. The [VM](https://meta-hackathon-wick-production.up.railway.app/vms/fe037d65-cc69-4828-8a45-021c95f22600) reached `running` with `sourceMode: real`.
4. A batch-scoped MCP client called `inference_complete` and read its settled receipt. The deliberately short 64-token cap produced `finish_reason: length`; this checked bounded usage accounting.
5. Through MCP `terminal_open`, `terminal_write` and `terminal_read`, Codex verified a shell sentinel and `hostname`. A Python program executed **inside the VM**, used the batch key against Broker's OpenAI-compatible gateway, and received the exact task reply **`BROKER_MCP_TASK_OK`**. Its receipt settled successfully.
6. MCP quota reads and the owner's purchased-token inventory agreed. An excessive reservation was rejected, another batch's detail returned 404, and VM purchasing with a batch key returned 403. Replacing the batch key caused the old key to return 401 while preserving usage.

| Call                                                      | Input used | Output used | Observed elapsed | Outcome                      |
| --------------------------------------------------------- | ---------: | ----------: | ---------------: | ---------------------------- |
| Codex → MCP → Baseten                                     |        150 |          64 |           969 ms | Settled; capped at length    |
| VM Python task, controlled through MCP terminal → Baseten |        155 |         134 |         1,752 ms | Settled; task reply verified |
| Total                                                     |        305 |         198 |                  |                              |
| Available before cleanup                                  |  1,049,695 |     **314** |                  | No pending reservations      |

The over-quota request asked for 315 output tokens when only 314 remained and returned `token_allowance_exceeded`. Inference caused **no additional monetary debit** beyond the prepaid purchase. Exact stored fee allocation was 268,185 micro-USD to Broker and 1,519,715 micro-USD to the provider: 15% / 85% of $1.7879, before provider compute costs.

## Modal failure and current state

The earlier open-market [auction](https://meta-hackathon-wick-production.up.railway.app/token-orders/16f2a3f9-0569-4072-84ca-fff16316dcc8) received real bids from Modal (**$1.7354**, winner) and Baseten (**$1.7879**, lost). A second auction acquired a Baseten pack, and a real E2B VM was created.

The first Modal generation failed with HTTP 409 `inference_outcome_unknown`. Receipt `220e02b0-36df-4a6d-ad93-1f53a9a51e09` reported `failureCode: inconsistent_usage`. No generation was resent. At the final check it was `needs_reconciliation`, retaining **1,048,576 input / 64 output tokens**. The grant remains `closing` and its pack `retiring` because that usage is unresolved.

Broker automatically made Modal unavailable for further purchases: `qualified: false`, reason `Authoritative provider usage could not be verified.` Baseten remained qualified. The receipt does not expose the inconsistent native usage fields, so the precise mismatch was **not determined**. Operator reconciliation needs authoritative usage for that original provider request; this test did not invent usage, issue a refund or re-enable Modal.

The failed run's cleanup also retired its unused Baseten pack. A separate, bounded Baseten-only run then completed the successful flow above; it used a new purchase and a new VM.

## MCP gaps observed

- Released MCP 0.3.0 has **no batch-key issuance tool**. The owner/API setup step issued the batch key; MCP handled purchasing, quota reads, inference, VM creation and terminal control. A completely unattended, MCP-only key-delegation flow is not available in this release.
- MCP advertised 10 tools for a batch key, including `inference_grant_get`, which the server correctly rejected with 403. Tool discovery needs to account for `packId` and hide operations that batch keys cannot call. Server authorization held during the test.
- Both terminated VM responses retained the stale message `Waiting for Wick to confirm environment cleanup.` even after `cleanupPending: false` and a populated `cleanupConfirmedAt`.

## Cleanup, costs and limits

Both test VMs reached `terminated` with cleanup acknowledged at **21:05:50.110 UTC** and **21:08:25.133 UTC**. These are Wick/Broker cleanup acknowledgments; physical provider erasure was not independently verified. All **nine issued key handles were revoked**, MCP processes and terminal handles closed, and unspent grant funding was released. The Modal usage reservation was deliberately preserved for reconciliation.

Three packs charged **$5.3112 in pilot Broker credit**: $1.7354 Modal, $1.7879 unused Baseten from the failed run, and $1.7879 Baseten from the successful run. Unused purchased quota was retired without a refund under the existing policy. Each VM's accepted Broker quote was $0.0500; actual upstream compute billing was not measured and is separate from the token wallet. The successful pack's 314 remaining output tokens describe its **pre-cleanup** balance; the test grant is now closed.

Natural two-hour expiry, streaming, tools, load/concurrency and cross-provider failover were not exercised live. Existing offline coverage remains separate from this production test.

## Repeating the test

Use the [0.3.0 client installation instructions](../../client-releases/0.3.0/INSTALL.md) and the [batch connection API](../token-batches.md). Create a fresh owner-funded grant, a purchasing key and a separate compute key with a small auction ceiling. Start the MCP executable with `WICK_BROKER_API_URL` and the appropriate `WICK_BROKER_API_KEY`; keep keys out of command arguments and transcripts.

Read `inference_models_get` before selecting quantities or providers. Use stable operation keys for auctions and inference, and wait/read the saved order rather than placing a replacement. Issue the purchased batch's key through the owner/API setup step, use that key in a separate MCP client or VM workload, compare its receipts with `inference_packs_list`, then explicitly terminate the VM, revoke test keys and close the grant. An unknown generation must retain its original operation key and reservation until reconciliation.
