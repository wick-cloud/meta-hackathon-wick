# Studio usage forecasting

Studio forecasts total input, output **including reasoning**, and model calls from task scope, goal length, root file count and manifest size. Its first purchase is the forecast plus **10%**, rounded upward once per token dimension, or the exact next-call reservation if that is larger. It no longer adds a full context window or a full final-call block to every purchase.

Cold starts use explicit task-size priors. After twelve completed examples, ridge regression learns bounded log residuals of those priors, separately for input, output and call count. This is a small usage predictor, not training Muse's weights. Prediction multipliers remain bounded between 0.25 and 4. The purchase buffer stays 10%; held-out forecast errors are diagnostics, not an additional purchasing multiplier.

Studio waits for a definite pre-dispatch allowance failure before buying more. It uses the saved next request and buys at most **two estimated calls** of additional work plus 10%, with input admission headroom for the other call in that chunk. Once the original call forecast is exhausted, a refill still covers two calls instead of opening an auction after every call. A new pack has at least 1,024 output tokens (or the smaller qualified task maximum). If another usable pack has become available, execution resumes without another auction. Refills reuse the same job, VM, deadline and total spending ceiling. Unknown model outcomes stop for reconciliation; they never trigger another speculative purchase.

Internal Studio/coding calls can reserve a lower hard output cap from an existing pack (minimum 256, up to the configured qualified maximum) before buying again. The native request receives that lower cap, and settlement checks the persisted reservation. Public agent calls retain their exact requested `max_tokens`; their output limit is never silently reduced. No call combines different packs.

## Learning and evaluation

- Training uses at most the latest 200 fully completed, reconciled tasks for the same buyer, fixture/real mode and maximum-output contract. New tasks become observations only after cleanup and grant closure. Failed, stopped and unresolved work is excluded; partial usage is a censored observation of full-task demand.
- Only four numeric metadata features and authoritative usage counts are retained in the training table. No additional source, goals, prompts, completions or reasoning are stored there. The existing artifact retention rules still apply to task artifacts.
- At twenty examples, the latest 20% form a chronological holdout. The UI reports weighted absolute input and output error, separately from utilization. These are diagnostics, not a promise of 90% accuracy or completion.
- Every purchase round stores an immutable forecast and allowance. A restart, auction-to-instant fallback or a later training update cannot change the operation's quantities. Existing purchase idempotency, owner funding and accounting holds remain authoritative.
- Bump `USAGE_ESTIMATOR_VERSION` when the executor prompt/context or feature meaning changes materially; old observations must not silently train a changed contract.

For offline evaluation, export numeric records in chronological order, oldest first, and run:

```sh
npm run studio:usage:evaluate -- numeric-samples.json
```

The file contains `{ "inputReservationFloor": 7000, "outputReservationFloor": 256, "samples": [{ "features": { "goalBytes": 150, "scope": 3, "repositoryFiles": 10, "manifestBytes": 400 }, "input": 19000, "output": 4500, "calls": 10 }, ...] }`. Supply 20–200 examples from one buyer, mode and output contract. The tool makes no provider calls and does not change the database. It evaluates a chronological held-out partition and reports errors, initial-pack utilization, underestimates and cases constrained by reservations. Aggregate utilization alone cannot prove final-call admission; replay call receipts when qualifying a purchase policy.

## Request-sized accounting qualification

Studio requires an operator-qualified `utf8-bytes-v1` input contract and at least a 2,048-token native output limit. Legacy real routes keep their existing fixed context reservation for manual token purchases, but cannot start new automatic Studio tasks. A forecast never substitutes for this accounting gate.

The request-sized contract reserves 4,096 tokens for Muse's fixed system/template framing, 32 per accepted text message, and the largest UTF-8 byte length of the raw content or any standard Unicode normalization form. The original certified context upper bound remains the final cap. This is a conservative byte envelope, **not an exact tokenizer**. No tools, media, message names or custom templates are accepted. Provider/template behavior must be qualified independently before enabling this method. Contradictory or excessive authoritative usage still retains holds and quarantines the route.

The system prompts use the [Meta prompting guide](https://dev.meta.ai/docs/muse-spark-open/prompting#control-reasoning)'s numeric strengths: 8 for short planning and 32 for coding. Internal task calls request native JSON-object output and still validate the final object strictly; public calls do not gain a new output-format parameter. The executor retains a compact list of the last 40 confirmed write paths alongside eight recent command receipts and the latest model decision, so multi-file tasks can track completed work without reloading old file contents. These remain within existing encrypted artifact retention. The encoded message envelope stays below 60,000 UTF-8 bytes; older records are omitted intact and marked, rather than cutting serialized JSON.

For the reported 13,443-input / 3,346-output task, a qualifying next request below the forecast produces a first pack of **14,788 input / 3,681 output**, rather than 1,068,741 / 7,067. Larger request framing can require a larger reservation; the UI shows that constraint separately. Unused prepaid quota remains non-refundable, and unspent funding returns only after normal reconciliation and cleanup.

Accounting-method changes affect the route fingerprint. Existing quotes/packs are not rewritten; retire and reconcile outstanding commitments before changing the production certificate. The new estimator version is `studio-usage-v3-small-packs`, separating the bounded-reasoning prompts and purchasing policy from earlier training observations. Immutable estimates/orders already in progress retain their saved quantities.
