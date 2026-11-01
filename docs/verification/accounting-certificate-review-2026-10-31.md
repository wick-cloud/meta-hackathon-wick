# Request-sized accounting certificate review — October 31, 2026

This operator review covers PR #32's `utf8-bytes-v1` text envelope, native JSON-object output and a 256–2,048-token request-output range. It supplements the [two real Studio flows](../studio-small-pack-verification.md); those runs alone did not qualify a new accounting contract.

The subsequent [Modal accounting recovery review](modal-accounting-recovery-2026-10-31.md) adds per-call generated-token verification and an explicit audited platform write-off. The decisions below record the original review before that follow-up.

## Decision

- **Baseten: approved for the reviewed range**, using the existing hackathon model mapping and original certificate expiry. The rollout must first stop new sales and verify zero outstanding quota/calls before changing its fingerprint. Existing purchased terms must not be rewritten.
- **Modal: the new certificate is not approved.** A control-token text probe returned `completion_tokens: 5`, `reasoning_tokens: 7`. The adapter correctly rejected it. A separate older production test receipt remains `needs_reconciliation`, holding its original input/output reservation in a closing grant. Neither a newer successful probe nor grant expiry establishes that receipt's usage. Keep its original records and certificate unchanged; pause new Modal sales pending authoritative reconciliation and a defensible usage contract. Do not clear quarantine or release holds to make deployment succeed.

The existing one-token Modal platform exception is unchanged. The review does not authorize a larger tolerance, invented usage, automatic request replay, a quota refund or a changed native provider route. Credentials remain configured privately. Modal is not claimed as ready for new request-sized Studio purchases.

## Input envelope

Meta publishes the Muse text framing and reasoning controls in its [prompting guide](https://dev.meta.ai/docs/muse-spark-open/prompting). The [publisher's Spark release record](https://github.com/huggingface/blog/blob/main/meta-muse-spark-open.md) identifies the shared Spark/Glimmer tokenizer. The publicly available [Glimmer tokenizer](https://huggingface.co/meta-models/Muse-Glimmer-30B) and text template were inspected without downloading weights or accepting gated Spark access.

The tokenizer uses byte-level BPE, with no normalizer or added byte-level prefix space. Splitting partitions text and BPE merges reduce the initial byte-symbol count. The server therefore bounds each accepted text message by its rendered UTF-8 byte count, including all standard Unicode normalization forms. It also covers the published system-template expansion from the four supported “reasoning effort” spellings to “reasoning strength.” It sends the original content unchanged.

The admitted API is bounded to 64 KiB and 64 string-only messages with `system`, `user` or `assistant` roles. Tools, media, names, custom templates and arbitrary extra fields are rejected. The fixed allowance is 4,096 tokens plus 32 per message, in addition to content bytes; the original 1,048,576-token context ceiling remains the final cap. Boundary probes covered 64 empty system messages, 64 empty assistant messages, long source text and literal template/media markers. Earlier Unicode and normalization probes are recorded separately. This structural envelope is conservative; it is not an exact tokenizer or a usage prediction.

Inspected metadata SHA-256 values:

| Asset                   | SHA-256                                                            |
| ----------------------- | ------------------------------------------------------------------ |
| `tokenizer.json`        | `c9dbee66967b58f31a7c27f723c3760da3526ccd0427578e8905b0abb0031c4d` |
| `tokenizer_config.json` | `781e6c74f571642c71202167b67d9255b28cc439bdda1582ff31346182f5a9c5` |
| `chat_template.jinja`   | `cfc67e5f349f37690dfd31ed1f18bc4442a9dd32fe39a648f993cb4eb3cae678` |

These hashes identify reviewed metadata, not a permanent guarantee about a hosted provider. A changed model/template/accounting revision requires another review.

## Output, usage and failure behavior

The final ten-call boundary report validated all five Baseten responses and four of five Modal responses. Both JSON-output stress cases stopped at exactly 2,048 completion tokens; input usage stayed within the byte envelope. The failing Modal response above remains a failed result in the report. Report SHA-256: `35b013b6f64b82775343a84e6628801e999a7ed14c9ef8942d449c07ac58ab2d`. Private evidence contains counters and provider response IDs, without prompts, answers or credentials. Earlier interrupted diagnostics and successful repeats do not replace the failed observation.

Certificates now support a fingerprinted `minimumOutputTokens`. Purchase quotes, auctions, buying policies and gateway admission respect the range; the adapter also checks it before HTTP dispatch. Public `max_tokens` is never silently changed. Internal adaptive caps must remain within the certified range. Residual prepaid output below the frozen minimum retires through the existing quota ledger. Omitted or explicit `1` preserves the legacy fingerprint.

Only internally opted-in calls send native `response_format: {type: "json_object"}`. Strict object validation remains required. Reasoning is counted inside reported completion usage, and total/detail counters are checked. Missing, contradictory or excessive usage retains reservations and quarantines future sales. There is one native POST, no automatic failover or resend, and no transaction across network I/O. Only an authoritative pre-generation rejection releases its reservation as unused.

## Financial and rollout checks

The review preserves owner funding, atomic cash/purchase holds, independent input/output quotas, seller identity, accepted prices, the 15% provider fee, one monetary charge per prepaid pack and non-refundable ordinary unused quota. Existing permanent order/receipt history remains intact. Legacy commitments must be retired and reconciled before a route fingerprint changes.

Production preflight found zero outstanding Baseten quota and one unresolved Modal test call. Its grant had already returned uncommitted money; the unresolved token hold must remain until truthful provider evidence is available. Deployment may proceed with the approved Baseten certificate and Modal sales paused, without changing that historical receipt.

Local verification passed 881 tests across 66 files, disposable PostgreSQL, typecheck, app and SDK/CLI/MCP builds. Focused range tests cover rejected purchases/calls, no provider dispatch or receipt creation, buying-policy eligibility, and retirement of unusable remaining quota. Template-expansion assertions cover repeated system directives. Exact-head CI must pass before merge. This record is a review decision, not proof that the new revision has already reached Railway.
