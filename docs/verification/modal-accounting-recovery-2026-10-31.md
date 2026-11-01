# Modal accounting recovery — October 31, 2026

This follows the [initial certificate review](accounting-certificate-review-2026-10-31.md). Increasing the platform discrepancy allowance from one token to two failed a new probe: Modal reported 256 completion tokens and 259 reasoning tokens. That provisional policy was never deployed.

## Verified generated-token contract

Modal's endpoint supports `return_token_ids: true`. Its choice contains `prompt_token_ids` and `response_token_ids`. Under the new, fingerprinted certificate policy `modal-generated-token-ids-v1`, Broker requires valid integer arrays and checks their lengths against `prompt_tokens` and `completion_tokens`. The primary total must still equal their sum; the existing input/output reservation checks remain authoritative. Missing, malformed, mismatched or excessive primary usage retains holds and stops further sales.

The [official SGLang response builder](https://github.com/sgl-project/sglang/blob/c108a656f138a17ba3601a311a0d8d6fb8896eea/python/sglang/srt/entrypoints/openai/serving_chat.py#L3004) returns the raw output IDs independently of reasoning/text parsing. Its [usage processor](https://github.com/sgl-project/sglang/blob/c108a656f138a17ba3601a311a0d8d6fb8896eea/python/sglang/srt/entrypoints/openai/usage_processor.py#L124) accounts for primary completion usage separately. An [upstream correction](https://github.com/sgl-project/sglang/blob/1457851e7ed56ba1b31dafc5e814020294f5c417/python/sglang/srt/managers/scheduler_components/output_streamer.py#L619-L626) describes speculative reasoning extending past the stopped output prefix. This matches the observed failure mode; Modal's exact serving revision has not been established.

For this reviewed route, supplemental reasoning counts are diagnostic metadata. Buyer usage comes from the independently checked generated sequence. A diagnostic discrepancy does not create a buyer charge or a fictitious platform invoice. Legacy certificates retain their original one-token policy. Baseten's strict adapter and its existing certificate are unchanged.

Token IDs can encode private content and reasoning. They are validated only in memory, within the existing bounded response body, and are never returned to clients, logged or persisted. Settlement records only the verification method, numeric primary counts and supplemental diagnostic counts in an idempotent audit event.

Five native Modal checks passed: 64 empty system messages, 64 empty assistant messages, literal control/media markers, long source text with JSON output, and JSON generation at the 2,048-token hard cap. Every prompt/output ID count matched its primary usage; all primary counts stayed within the reviewed byte envelope and dispatched cap. The certificate retains the original expiry and limits request output caps to 256–2,048. Private redacted evidence SHA-256: `9eab114bcf1a640ae3d79fbdda041cbf4d79c80fca19249ab702e18078152766`. Finite probes supplement the per-call verification, not replace it.

## Historical unknown call

The old manual test call has no retained authoritative primary usage. It cannot be relabeled as verified consumption. A new signed-in-admin operation explicitly accepts platform liability for an overdue unknown manual call whose owner has already closed or expired its pack. It requires a stable operation key and evidence, and only applies to a retiring pack in a closing grant. Coding/Studio calls and active customer packs are ineligible.

The transaction marks the receipt `written_off`, preserves null actual usage, original failure/provider ID and reserved bounds, moves held quota to retired, releases runtime occupancy and finishes grant closure. Its append-only event records the operator, evidence, frozen rate-based exposure and platform liability. The exposure is not a measured native invoice. Buyer money, accepted prices, refunds and provider revenue shares are unchanged. Unknown usage remains excluded from usage learning. Write-off does not clear quarantine or enable a provider.

## Rollout and verification

Deploy the code with Modal's existing certificate and sales paused. Apply the single audited write-off, verify zero remaining Modal commitments, then install the reviewed new certificate and restart that same release. Re-enable the existing offering with its prices and capacity preserved. Baseten remains enabled. A real production auction and inference must then verify settlement, duplicate-operation safety, the provider fee and test-grant closure. Existing immutable client downloads remain unchanged; current source contracts include the new receipt status.
