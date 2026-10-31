# Studio usage forecasting

Studio no longer buys a fixed input allowance plus 131,072 tokens and four maximum-output calls for every task. It forecasts total input, output **including reasoning**, and model calls from task scope, goal length, root file count and manifest size. It then sizes a pack for a 90% utilization target, subject to qualified per-call reservations and final-call headroom.

This is a small usage predictor, not pretraining or fine-tuning Muse's weights. Cold starts use explicit task-size priors. After twelve completed examples, ridge regression learns log residuals of those priors. This limits sensitivity to small datasets and learns separate input, output and call-count corrections. Prediction multipliers are bounded between 0.25 and 4. A missed forecast buys at most six estimated calls of remaining work rather than buying the whole original pack again. Existing budget, purchase-round and deadline limits still apply.

When the input reservation dominates the forecast, small repeated packs are costly. Purchases then include demand headroom plus a complete final call: 50% cold-start headroom, 25% after twelve examples, then a bounded 90th-percentile one-sided error multiplier from the chronological holdout after twenty examples. This is an empirical buffer, not a calibrated coverage guarantee. It is separate from the 90% utilization target. Without a dominating reservation, the utilization target and final-call headroom determine pack size.

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

The file contains `{ "inputReservationFloor": 1048576, "outputReservationFloor": 2048, "samples": [{ "features": { "goalBytes": 150, "scope": 3, "repositoryFiles": 10, "manifestBytes": 400 }, "input": 19000, "output": 4500, "calls": 10 }, ...] }`. Supply 20–200 examples from one buyer, mode and output contract. The tool makes no provider calls and does not change the database. It evaluates a chronological held-out partition and reports errors, initial-pack utilization, underestimates and cases constrained by reservations. Aggregate utilization alone cannot prove final-call admission; replay call receipts when qualifying a purchase policy.

## Current real-provider limitation

The deployed input contract reserves **1,048,576 input tokens per real call**. A statistical forecast cannot replace this bound. Buying a smaller pack without changing that qualified contract would prevent calls or risk unaccounted usage. Consequently, input utilization will remain far below 90% for short tasks, even with an accurate forecast. Studio exposes expected usage, purchased quota, settled usage, unresolved calls and the reservation constraint separately.

Reaching approximately 90% of purchased quota requires a separately qualified request-specific token counter or a tighter native accounting bound, plus appropriate output-call headroom. That work must verify provider framing and reasoning accounting; the predictor never weakens native limits, changes accepted pack terms, releases uncertain holds, or refunds ordinary unused prepaid quota. No new live-provider qualification or paid diagnostics are part of this change.

Existing completed tasks without saved numeric features are not silently imported as training records. They remain in normal history. The predictor starts collecting eligible examples after this migration.
