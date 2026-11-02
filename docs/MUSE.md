# Muse Spark Open on Baseten

Real Muse mode uses **Muse Spark Open · Baseten**, with the exact hackathon model identifier **`meta-models/muse-spark-open-1026`**. `MUSE_MODE=fixture` remains an explicit deterministic mode: its receipts say no model call, and fixture behavior never substitutes for a failed real request. Selecting real mode does not imply every decision called a model; ineligible bids and other deterministic decisions retain `modelCalled: false`.

Muse prepares editable proposals. It does not authorize spending, change policies, publish offerings, accept alternatives or start customer VMs by itself. Customers keep control of their terminal and commands.

## Where Muse is used

| Flow                       | Proposal endpoint                         | What the model contributes                                         | Required next step                                                            |
| -------------------------- | ----------------------------------------- | ------------------------------------------------------------------ | ----------------------------------------------------------------------------- |
| Buyer environment          | `POST /api/muse/translate`                | Approved configuration and supported resource requirements         | Buyer reviews before starting an auction                                      |
| Provider capacity strategy | `POST /api/provider/policy/propose`       | Editable limits using that provider's policy, capacity and catalog | Provider applies reviewed limits with revision and operation key              |
| Provider bid               | `POST /api/provider/requests/:id/propose` | Select the server-priced quote or decline                          | Saved policy, capacity and auction deadline are rechecked before any bid hold |
| Provider offerings         | `POST /api/provider/offerings/propose`    | Select approved candidates from bounded aggregate unmet demand     | Provider reviews and publishes                                                |
| Buyer alternatives         | `POST /api/intents/:id/propose`           | Select concrete eligible candidate IDs                             | Buyer explicitly accepts a frozen offer                                       |

Scheduled VM drafts have been removed from the hackathon product. Their retired endpoints return HTTP 410 before making a model call.

## Provider Capacity Manager

The provider Policy screen accepts a strategy such as “fill idle machines, keep two slots spare, never quote below $0.05.” `POST /api/provider/policy/propose` uses only the authenticated provider's current policy, capacity and approved catalog. It returns explicit editable limits, a receipt and the captured `baseRevision`; it changes no policy and reserves nothing. The provider reviews the floor, base/maximum prices, catalog allowlist, spare slots and automatic bidding, then applies them.

`PUT /api/provider/policy` requires `expectedRevision` and a stable `operationKey`. One durable latest-Apply receipt per provider returns the original response on an exact replay, without another activity event. Reusing that retained key with different input conflicts. Each new Apply consumes a revision, including unchanged limits; superseded original requests fail stale revision checks. The UI retains the exact operation and freezes edits after an uncertain response until the provider retries or resolves it. An additive database trigger increments `policy_revision` whenever policy or total capacity changes, including administrative writers. Stale proposals and concurrent edits cannot overwrite newer limits. Legacy rows default to zero spare slots; omitted optional capabilities are preserved. Existing holds remain binding even if capacity decreases below held slots.

Every new manual bid, automatic bid and negotiated acceptance checks the same sellable-capacity rule under the provider row lock: `max(0, total - held - reserveSlots)`. Floors, ceilings and allowlists are enforced again when taking a hold. The reviewed **Automatic bids and counteroffers** control uses `autoBid` for both forms of automation. Pausing it prevents automatic counteroffer generation and acceptance, including offers generated before the pause; manual bids remain available. Published listings alone do not enable automation. Fixture strategy parsing gives negation and disable instructions precedence over enable words. A proposal's explanation is not an authorization or reservation. Provider activity and the manager show deterministic proposed/accepted counteroffer receipts, fixed total, decision, and fixture/modelCalled labels. Proposed receipts explicitly say buyer acceptance is pending and no slot is held. Replays do not duplicate activity. Provider decision receipts may describe that provider's own limits; buyer alternatives never expose private floors, spare-slot counts or competitors' policies.

## Buyer-owned nonbinding intents

Binding requests retain their existing exact approved-catalog validators and immutable specification trigger. Unsupported hardware, canonical regions or durations can instead be reviewed at `/alternatives/new` and saved through `POST /api/intents`. A nonbinding intent stores desired CPU, fractional GiB, GPU, region, duration and maximum total separately from provisioning. Explicit prose budgets and regions are preserved; a typed budget takes precedence. The review never silently replaces them with a default $5 budget or a supported region. Multiple explicit money amounts use the smallest as a conservative review default. Bare “in” phrases only identify recognizable locations or regional identifiers; “develop in Python” and “use in testing” remain ordinary prose. Explicit “region <token>” preserves unsupported choices.

Flexibility starts **off**. With it off, resource minima and the exact region, duration, GPU and budget remain strict. Explicit flexibility supplies minimum CPU/GiB, allowed supported regions/durations, a hard total no greater than the original budget, and a GPU constraint. “Any GPU” still requires an actual GPU; CPU-only substitution needs explicit permission. These permissions are not inferred from vague prose.

Finished unsuccessful requests may link to an intent; their original immutable specification remains untouched. Saved intents are immutable, and each source request has one negotiation resolution. A new standalone review can express a separate need; it is not a hidden edit of an existing request.

## Concrete offers and explicit acceptance

`POST /api/intents/:id/propose` generates bounded feasible candidates from current approved catalog entries and active provider offerings. Code computes the exact duration price, resource changes and tradeoffs. Muse selects candidate IDs; it cannot invent a configuration, provider, price, discount or workload. Each provider model call receives only that provider's own policy/capacity and public requested requirements. Buyer-facing tradeoffs are regenerated from public facts rather than forwarding private model rationale.

Search is deliberately bounded: at most four provider snapshots, twelve offerings/candidates per provider, two concurrent provider calls, and three stored selections per proposal. It is not an exhaustive marketplace search. Proposals are limited to ten per buyer per minute and expire after five minutes. Same-intent parallel work is coalesced after ownership and mode checks. A 30-second cache reuses results only when current candidate/policy/capacity fingerprints and stored offer expiry still match. The one-process maps hold at most 128 pending operations and 256 cached results; an empty decision is cached too. Model calls remain outside SQL locks. Proposal creation takes no bid hold, creates no binding request or VM, and enqueues no provisioning.

The buyer reviews before/after CPU, memory, GPU, region, duration and hard budget, the named demo supplier and exact fixed total. `POST /api/intents/:id/offers/:offerId/accept` is the explicit consent action. In one transaction it:

- Locks source-request/intent resolution and revalidates ownership and source mode.
- Rechecks catalog approval/resources, rate freshness and exact frozen rate, offering activity/revision/price, provider policy revision/limits, reserve/capacity and global VM admission.
- Rechecks expiry and rate age after lock waits.
- Creates a linked immutable request, frozen bid/quote and one hold, then uses the existing shared award/provision owner directly. There is no second auction.

The accepted request freezes the lower approved hard budget, so later retries cannot broaden it. Exact duplicate acceptance returns the same result; sibling alternatives and ordinary source retries share resolution locks and cannot produce another rental. Any failed validation or enqueue rolls back the request, bid, hold and VM together. UI operation keys persist through uncertain network failures; definitive rejection allows a fresh explicit review. Normal readiness, invoice, terminal, expiry and confirmed-cleanup rules remain unchanged.

## Deterministic pricing and reviewed offering suggestions

New rentals use a fixed 15% commission deducted from provider gross revenue, with 85% retained by the provider before compute costs and no added customer fee. Managed suggestions and bid floors use `max(1, ceil(raw upstream micro-USD / 8500))` cents so the provider share covers the compute estimate. There is no additional target markup. Integer micro-USD snapshots preserve the exact split at binding acceptance and invoice readiness; historical accepted quotes and invoices retain their original terms. Provider limits and buyer budgets remain gross rental amounts.

Muse bid suggestions select or decline a server-computed gross price; model output never supplies the money or commission rate. Fixed customer quotes, demo provider earnings, upstream estimates and actual usage remain separate. Invoices say **No payment due** and no payments or payouts occur.

`POST /api/provider/offerings/propose` aggregates only recent unresolved demand in the current Wick mode and applicable provider catalog allowlist. It excludes resolved substitutes/retries and duplicate source-intent demand, considers at most 200 recent requests and 200 recent intents before a combined 200-row/40-group bound, and uses a seven-day window. Buyer identities and free text are not selected. Unsupported exact dimensions that no existing configuration satisfies do not become invented provider offerings.

Suggestions select approved configurations using server-priced **30-minute publication baselines**. The offering model receives only bounded aggregate demand, approved public catalog facts and priced candidates; private supplier policy is omitted. Its output contains candidate IDs only. Public names/descriptions are constructed from approved catalog resources, region and duration, so model-written private limits or fabricated hardware cannot become listing text. A configuration may address 15/60-minute demand when it supports that exact duration, but the displayed publication price remains explicitly 30 minutes; actual managed rental quotes are computed by duration. Provider review and ordinary publish are required. Publishing checks current allowlist, price/floor and approval; a changed server-priced suggestion returns a conflict rather than silently repricing the reviewed amount. Fixture prices remain explicitly simulated.

## Real adapter contract and privacy

`src/shared/muse.ts` owns the fixed model ID and public display/provider labels. The real adapter sends non-streaming Chat Completions requests to **`https://inference.baseten.co/v1/chat/completions`** with Bearer authentication, `model: "meta-models/muse-spark-open-1026"`, `max_tokens: 8192` and strict `response_format.json_schema`. It does not send `reasoning_effort` or `max_completion_tokens`. The endpoint and authentication follow [Baseten Chat Completions](https://docs.baseten.co/reference/inference-api/chat-completions); see [Baseten structured outputs](https://docs.baseten.co/inference/structured-outputs) for model-specific support. Baseten documents that Muse accepts `json_schema` but does **not** enforce it. Broker therefore includes the schema in the system prompt and locally validates every returned final proposal; `strict: true` in the request is not a provider-enforcement guarantee.

Every schema object disallows extra properties, requires its declared properties and uses nullable fields for optional decisions. Broker requires one complete choice with `finish_reason: "stop"`, parses **only the final `message.content`**, then validates the domain proposal. Separate `reasoning_content` is ignored: it is never displayed, used as a decision receipt, returned to the browser or logged. Decision receipts contain bounded application facts and validated decisions, not the model's private reasoning. Missing, truncated, refused, malformed or ineligible results fail explicitly; real mode never falls back to fixtures. See [Baseten reasoning response fields](https://docs.baseten.co/inference/model-apis/reasoning).

The default interactive deadline is 45 seconds. Bid suggestions have an eight-second maximum, further limited by the remaining database-clock auction budget; a late result cannot revive an expired auction. Calls have no automatic retries, 64 KiB request/response bounds, redirect rejection and a default six-call process concurrency bound. Actor rate limits also apply. Model/network calls stay outside SQL transactions and row/advisory locks.

Set these **server-only** variables for real inference:

```text
MUSE_MODE=real
BASETEN_API_KEY=<private Baseten API key>
META_API_BASE=https://inference.baseten.co/v1
```

`BASETEN_API_KEY` is canonical. `META_API_KEY` remains a backward-compatible alias; a non-empty `BASETEN_API_KEY` takes precedence. `META_API_BASE` defaults to the Baseten URL above and must be a plain HTTPS API base. No model override is required: the hackathon model ID is fixed in shared code. Keep keys in a private server environment or Railway service variables, never `VITE_*` variables, browser storage, source files, screenshots or a public repository. Setting these variables does not by itself deploy or verify a hosted app.

Explicit prompt projections exclude credentials, Wick organization/group identifiers, buyer identity, repositories, terminal contents and other providers' policies. Common pasted secret patterns are redacted from free text. This is a bounded requirements assistant, not a general secret detector; descriptions should contain requirements only. Prompts, raw responses, reasoning and terminal transcripts are not logged. Muse never runs agents, tasks, setup scripts, repositories, diagnostics or customer commands.

## Verification and migration

Offline tests exercise fixture behavior, exact model/transport envelopes, final-content parsing, reasoning exclusion, request bounds, sanitized failures, policy isolation and deterministic validation. Browser fixtures separately exercise reviewed UI behavior without any paid API calls.

A controlled live smoke on 2026-10-29 passed all **seven** adapter flows with the exact Baseten model, JSON-schema requests and local validation of final content: translation, capacity policy, bid, offering suggestions, alternatives, buyer agreement draft and provider schedule draft. It used a synthetic approved catalog, made **zero database writes and zero Wick/VM allocations**, and did not deploy Railway. This confirms those inference/adapter paths for that run; it does not establish production deployment status or native VM enforcement.

The two schedule draft flows were subsequently retired. To run the five remaining proposal checks deliberately, supply the private server key locally and run:

```sh
npx tsx scripts/verify-baseten-muse.ts --live
```

The `--live` flag is required and permits five real Baseten inference calls. The script requires `BASETEN_API_KEY` or its legacy alias, does not connect to PostgreSQL or Wick, and emits a redacted pass/fail summary. Ordinary CI remains fixture-only and does not need inference credentials.

No database migration is needed to change the Muse transport or model label. Existing policies, holds, accounts, accepted quotes and financial history remain under their normal migration and review rules. Never reseed accounts to switch model modes. Keep one Broker process for the Railway deployment and follow [Railway configuration](RAILWAY.md) when setting private runtime variables. Earlier provider-scale evidence used Muse fixtures; it is a separate verification boundary from the Baseten inference smoke.
