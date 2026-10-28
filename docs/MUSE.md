# Muse strategy and reviewed negotiation

The deployed app uses **fixture Muse by user choice**. This change keeps `MUSE_MODE=fixture`; it does not make Meta calls or enable task mode. Fixture receipts say `modelCalled: false`. The real adapter implements the public `muse-wonder-1.0` structured-output contract for future separately authorized validation, without claiming live account access, schema acceptance, latency, or model quality.

## Provider Capacity Manager

The provider Policy screen accepts a strategy such as “fill idle machines, keep two slots spare, never quote below $0.05.” `POST /api/provider/policy/propose` uses only the authenticated provider's current policy, capacity and approved catalog. It returns explicit editable limits, a receipt and the captured `baseRevision`; it changes no policy and reserves nothing. The provider reviews the floor, base/maximum prices, catalog allowlist, spare slots and automatic bidding, then applies them.

`PUT /api/provider/policy` requires `expectedRevision`. An additive database trigger increments `policy_revision` whenever policy or total capacity changes, including administrative writers. Stale proposals and concurrent edits cannot overwrite newer limits. Legacy rows default to zero spare slots; omitted optional capabilities are preserved. Existing holds remain binding even if capacity decreases below held slots.

Every new manual bid, automatic bid and negotiated acceptance checks the same sellable-capacity rule under the provider row lock: `max(0, total - held - reserveSlots)`. Floors, ceilings and allowlists are enforced again when taking a hold. A proposal's explanation is not an authorization or reservation. Provider decision receipts may describe that provider's own limits; buyer alternatives never expose private floors, spare-slot counts or competitors' policies.

## Buyer-owned nonbinding intents

Binding requests retain their existing exact approved-catalog validators and immutable specification trigger. Unsupported hardware, canonical regions or durations can instead be reviewed at `/alternatives/new` and saved through `POST /api/intents`. A nonbinding intent stores desired CPU, fractional GiB, GPU, region, duration and maximum total separately from provisioning. Explicit prose budgets and regions are preserved; a typed budget takes precedence. The review never silently replaces them with a default $5 budget or a supported region.

Flexibility starts **off**. With it off, resource minima and the exact region, duration, GPU and budget remain strict. Explicit flexibility supplies minimum CPU/GiB, allowed supported regions/durations, a hard total no greater than the original budget, and a GPU constraint. “Any GPU” still requires an actual GPU; CPU-only substitution needs explicit permission. These permissions are not inferred from vague prose.

Finished unsuccessful requests may link to an intent; their original immutable specification remains untouched. Saved intents are immutable, and each source request has one negotiation resolution. A new standalone review can express a separate need; it is not a hidden edit of an existing request.

## Concrete offers and explicit acceptance

`POST /api/intents/:id/propose` generates bounded feasible candidates from current approved catalog entries and active provider offerings. Code computes the exact duration price, resource changes and tradeoffs. Muse selects candidate IDs; it cannot invent a configuration, provider, price, discount or workload. Each provider model call receives only that provider's own policy/capacity and public requested requirements. Buyer-facing tradeoffs are regenerated from public facts rather than forwarding private model rationale.

Search is deliberately bounded: at most four provider snapshots, twelve offerings/candidates per provider, two concurrent provider calls, and three stored selections per proposal. It is not an exhaustive marketplace search. Proposals are limited to ten per buyer per minute and expire after five minutes. Proposal creation takes no bid hold, creates no binding request or VM, and enqueues no provisioning.

The buyer reviews before/after CPU, memory, GPU, region, duration and hard budget, the named demo supplier and exact fixed total. `POST /api/intents/:id/offers/:offerId/accept` is the explicit consent action. In one transaction it:

- Locks source-request/intent resolution and revalidates ownership and source mode.
- Rechecks catalog approval/resources, rate freshness and exact frozen rate, offering activity/revision/price, provider policy revision/limits, reserve/capacity and global VM admission.
- Rechecks expiry and rate age after lock waits.
- Creates a linked immutable request, frozen bid/quote and one hold, then uses the existing shared award/provision owner directly. There is no second auction.

The accepted request freezes the lower approved hard budget, so later retries cannot broaden it. Exact duplicate acceptance returns the same result; sibling alternatives and ordinary source retries share resolution locks and cannot produce another rental. Any failed validation or enqueue rolls back the request, bid, hold and VM together. UI operation keys persist through uncertain network failures; definitive rejection allows a fresh explicit review. Normal readiness, invoice, terminal, expiry and confirmed-cleanup rules remain unchanged.

## Deterministic pricing and reviewed offering suggestions

Managed prices retain the published rate, source time, integer compute floor and configurable 20% target. BigInt applies markup before one upward cent rounding, minimum one cent. Manual competitive bids remain possible within provider policy, buyer budget and compute floor. Muse bid suggestions select/decline a server-computed price; model output never supplies the money. Fixed customer quotes and demo invoices remain separate from upstream estimated reservations and actual usage, with **No payment due** and no payments/payouts.

`POST /api/provider/offerings/propose` aggregates only recent unresolved demand in the current Wick mode and applicable provider catalog allowlist. It excludes resolved substitutes/retries and duplicate source-intent demand, considers at most 200 recent requests and 200 recent intents before a combined 200-row/40-group bound, and uses a seven-day window. Buyer identities and free text are not selected. Unsupported exact dimensions that no existing configuration satisfies do not become invented provider offerings.

Suggestions select approved configurations using server-priced **30-minute publication baselines**. A configuration may address 15/60-minute demand when it supports that exact duration, but the displayed publication price remains explicitly 30 minutes; actual managed rental quotes are computed by duration. Provider review and ordinary publish are required. Publishing checks current allowlist, price/floor and approval; a changed server-priced suggestion returns a conflict rather than silently repricing the reviewed amount. Fixture prices remain explicitly simulated.

## Real adapter contract and privacy

The public Meta contract is Chat Completions at `https://api.meta.ai/v1/chat/completions`, model `muse-wonder-1.0`, Bearer authorization and strict `response_format.json_schema`. Every schema object uses `additionalProperties: false`, all properties are required, and nullable fields express optional decisions. Requests explicitly set `reasoning_effort: 'low'`; `none` is not used. A response must have exactly one choice with `finish_reason === 'stop'`; missing/truncated/refused/malformed/hallucinated output fails closed. Only validated `message.content` is read; `reasoning_content` is never exposed.

Calls have no automatic retry, an eight-second deadline, 1,600 completion tokens, 64 KiB input/output bounds, redirect rejection and a six-call process concurrency bound. Actor rate limits bound interactive operations. No model/network call runs under SQL transactions or row/advisory locks. Failed real calls never fall back to fixture mode.

Explicit projections exclude credentials, Wick org/group identifiers, buyer identity, repositories, terminal contents and other providers' policies. Common pasted secret patterns are redacted from free text. This is a bounded requirements assistant, not a general secret detector; descriptions should contain requirements only. Model prompts/responses, reasoning and terminal transcripts are not logged. The product never runs agents, tasks, setup scripts, repositories, diagnostics or customer commands for Muse.

Official references: [models](https://dev.meta.ai/docs/models), [structured output](https://dev.meta.ai/docs/structured-output), [Chat Completions](https://dev.meta.ai/docs/protocols/chat-completions), [schemas](https://dev.meta.ai/docs/api-reference/chat-completions/schemas), [reasoning](https://dev.meta.ai/docs/reasoning). Offline fixtures verify application behavior and documented envelopes; they do not establish live Meta interoperability.

## Verification and migration

Migrations `007_capacity_policy.sql` and `008_negotiation.sql` are additive. They preserve authentication, existing policies/holds, original requests and historical quotes. Parent-controlled publication/cutover must retain the existing private environment, keep fixture Muse, migrate without reseeding, and run exactly one Broker process.

Focused offline tests: `tests/capacity-policy.test.ts`, `tests/negotiation.test.ts`, `tests/muse-negotiation-adapter.test.ts`, `tests/muse-demand-db.test.ts`, plus existing Muse/marketplace regressions. The isolated browser harness exercises strategy review/apply, unsupported intent/flexibility, exact offer acceptance, fixture VM/terminal/invoice/cleanup and offering review/publish through actual authentication and HTTP APIs. See [HANDOFF.md](../HANDOFF.md) for final results and the live Wick evidence boundary.
