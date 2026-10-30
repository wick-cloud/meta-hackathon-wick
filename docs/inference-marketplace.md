# Agent token marketplace

The token market runs in the existing Fastify service, Railway app, PgBoss queues and Postgres database. It does not provision VMs or alter Wick routing. Migration `019_inference_market.sql` is additive; the previous VM and scheduled-capacity ledger entries keep their existing meanings.

## Pilot configuration

`INFERENCE_MARKET_MODE` defaults to `off`. Use `fixture` for a complete simulated purchase/inference demo with existing pilot Broker credits. Fixture auctions use policies belonging to the first two fixture supplier accounts, ordered by ID; they do not represent offers submitted by Modal or Baseten. All screens, bids, packs and receipts identify fixture mode. Do not switch modes on a funded grant: close it, reconcile pending usage and retire its packs first.

Real routes use separate inference credentials and approved model mappings:

| Provider | Base URL                                    | Native model                                                      | Readiness                                                       |
| -------- | ------------------------------------------- | ----------------------------------------------------------------- | --------------------------------------------------------------- |
| Baseten  | `https://inference.baseten.co/v1`           | Hackathon `meta-models/muse-spark-open-1026`                      | Adapter fixture-tested; real accounting qualification required  |
| Modal    | `https://inference.us-west.modal.direct/v1` | Actual SharedEndpoint hostname from authenticated model discovery | Endpoint/proxy credential and accounting qualification required |

The canonical buyer-facing model is `meta/muse-spark-open`. Modal's model creation name is not a substitute for discovering the actual endpoint model ID. Its inference proxy credential is separate from Wick/Modal VM credentials. Run `npm run inference:readiness -- --discover-modal` with the private server environment to make a bounded **GET only** discovery call. It never creates an endpoint or sends a completion. A listed endpoint must still be confirmed to serve Muse Spark Open. No private credential or one-time key belongs in this repository.

Map existing provider accounts using `INFERENCE_BASETEN_PROVIDER_EMAIL` and `INFERENCE_MODAL_PROVIDER_EMAIL`; no accounts or passwords are reset or created by this feature. Real offerings begin inactive. The mapped provider must publish its pricing and capacity at `/provider/inference`. A policy update affects unawarded demand; purchased quota and price snapshots remain frozen. Seller identity is frozen on each pack, so remapping a route never transfers the prior seller's history. Remapping/model/accounting changes with outstanding quota fail closed until retirement/reconciliation. Qualification renewal with unchanged semantic revision preserves purchased terms.

On Railway, keep the same service and Postgres attachment. Add these server variables only when needed: `INFERENCE_MARKET_MODE`, `INFERENCE_BASETEN_API_KEY` (optional override of the existing Baseten Muse key), provider emails, `INFERENCE_MODAL_MODEL`, `INFERENCE_MODAL_PROXY_TOKEN`, and `INFERENCE_QUALIFICATION_JSON` as a sealed server variable. Alternatively, `INFERENCE_QUALIFICATION_FILE` may point to a private mounted JSON file; set exactly one. The sealed variable supports the same Railway service without adding a volume. Restart after a reviewed certificate change. No extra frontend service, secret in `VITE_*`, public Wick source, billing service or worker service is required. New queues run in the existing process and recover due work from Postgres at startup and every minute. Exact auction closure is also scheduled in its durable 30-second queue; worker scheduling may delay award visibility, but no bid/cancel is accepted after the DB deadline.

## Accounting qualification gate

Neither live provider is pre-qualified. An API key alone cannot enable sales. A trusted operator must obtain evidence for **all accepted text, template framing, authoritative per-request usage, reasoning-inclusive completion usage, hard output limits and pre-generation rejection semantics**. This version deliberately reserves a conservative fixed input upper bound for real routes; it does not pretend a character estimate is a tokenizer. The certificate must cover the 64 KiB accepted body, all 64 accepted messages, system messages, Unicode and the provider chat template. A route with no defensible bound remains disabled.

The private certificate is a JSON array of at most two entries (32 KiB total). Each entry has exactly:

```json
{
  "provider": "baseten",
  "contract": "muse-spark-open-text-v1",
  "nativeModel": "meta-models/muse-spark-open-1026",
  "revision": "reviewed-accounting-revision",
  "evidence": "Private evidence reference for the reviewed provider contract and accounting tests",
  "validUntil": "2026-10-01T00:00:00.000Z",
  "fixedInputUpperBound": 1000000,
  "maximumOutputTokens": 8192,
  "authoritativeUsage": true,
  "outputIncludesReasoning": true,
  "allAcceptedTextCovered": true,
  "rejectionHasNoUsage": true
}
```

This is an **expired format example**, not qualification evidence. Do not enable it by simply changing the date. Verification must establish the declared bounds and native endpoint's Muse identity first, with separately authorized bounded live checks. The certificate's validity must cover the entire grant term before selling any pack, and its minimum input reservation must fit the pack. Actual authoritative usage releases unused call reservations. Streaming, tools, images/audio/video, multi-choice completions and generic agent-framework compatibility are not advertised or accepted. A reasoning-only response with a null text answer still settles its reported usage. Reasoning tokens are included once in completion usage; contradictory detail counters quarantine the route.

Input bounds/output limits, native model and semantic revision form the frozen accounting fingerprint. Merely renewing evidence/expiry does not change it. Missing or contradictory usage and bound violations preserve token holds and quarantine future sales. Quarantine is not cleared by restarting or renewing a certificate. A new reviewed semantic revision can replace a quarantined route only after its outstanding quota and calls have been resolved/retired.

## Funding and purchase invariants

Only the signed-in owner can create, fund, close or replace a grant key. Each grant defaults to 24 hours (one minute to seven days configurable). Funding reserves credit once from the owner's existing wallet; no external charge is collected. The cash invariant, in integer cents, is:

`funded = available + purchase holds + net pack spend + returned to owner`.

Agents have only `account:read`, `inference:read`, `inference:use`, `tokens:buy`. They cannot buy VMs, call internal unmetered Muse helpers, alter funding or issue keys. Replacement revokes the old key and binds the replacement to the same grant and spending history. Closing stops new purchases and inference, cancels open orders, retires unused quota and returns uncommitted cash; unknown calls keep the grant in `closing` until reconciliation. Old key revocation does not erase paid packs or receipts. Auction awards originating under a revoked key cancel their unspent purchase hold.

A 30-second auction reserves its full maximum within the grant; an instant purchase uses a signed, owner/grant/quantity/route/revision-bound 60-second quote. Both award through the same transaction. Lowest eligible total wins, then earliest bid and ID. No automatic fallback, refill or grant top-up occurs. Provider policies auto-bid for new demand; inactive policies and exhausted capacity do not bid. Purchases and inference require a stable operation key. Duplicate purchases return the original order before checking quote freshness, and mismatched payloads conflict.

Prices combine both dimensions using BigInt and round once to whole cents. Provider asks are separate from native cost assumptions. Initial researched uncached cost rates are $1.25/M input and $4.25/M output; cached discounts are not assumed in the floor. Gross pack prices must cover that combined cost after the 15% provider commission. Ordinary unused prepaid quota is non-refundable. Calls consume purchased quota and create **no second money charge**. Exact fee/share microUSD use the existing revenue-share helper. The token market does not produce VM invoices or change VM pricing.

## Quota and uncertainty

Each pack independently enforces `issued = available + held + consumed + retired`, for both token dimensions. A call must reserve its full input bound and requested `max_tokens` from one pack before dispatch. It never silently combines separate providers' packs. Route commitments count available and held tokens; unresolved calls retain both occupancy and quota. Exhausted packs retire any unusable remainder so an agent with funding can refill. V1 caps are 20 open grants/owner, 10 unsettled packs/grant, five pending/recent purchases/grant, two unresolved/active calls/grant and two per route/four globally. These limits are separate from the existing 20-VM limit.

No database transaction spans network I/O. Dispatch intent is durable before the one upstream POST. A request abandoned while `reserved` can be released on recovery because no dispatch intent exists. `dispatching` and `outcome_unknown` requests become `needs_reconciliation` after their deadline, without a resend, failover or automatic refund. A revoked key prevents admission/dispatch; already admitted work still settles. No prompt, answer or reasoning trace is persisted in receipts/events.

The error's `requestId` is HTTP correlation; `inferenceRequestId` is the persisted inference receipt ID. On a timeout reuse the original operation key and identical body to discover its receipt-only error; never regenerate the work under a new key. Completed replay returns `completed_without_result`. Read `GET /api/inference/requests/:id` for token holds and settlement. Owner grant screens show the latest 25 orders, packs and requests; the permanent Orders table and paginated grant/pack APIs retain complete history.

An authenticated browser operator may reconcile unknown requests using `POST /api/admin/inference/requests/:id/resolve`, with a stable operation key, authoritative `providerRequestId`, evidence, input/output usage and a verified rejection flag. Usage must remain within its reserved bounds. Accounting contract violations remain held until truthful bounded settlement evidence is available; excess provider-side usage must not be shifted to another agent pack. No buyer key can reach this route.

For a verified provider outage, the operator may retire an active pack through `POST /api/admin/inference/packs/:id/provider-failure`, supplying an operation key and evidence. Further dispatch stops immediately. One terminal refund occurs only after all held calls resolve: floor(pack price × unused weighted quota / issued weighted quota), using frozen input/output ask weights. Active grants regain spendable budget; closing/closed grants return that cash to the owner without reviving the agent. Ordinary expiry/owner closure/exhaustion does not cause a refund. Settlement and refunds are idempotent; provider commission applies to gross less verified refund, never unspent grant reserves. Payment collection and payouts remain separate from this pilot credit ledger.

## Verification record

Local qualification and real qualification are distinct. `tests/inference-adapters.test.ts` covers both native HTTP contracts with mocked responses, including missing usage, reasoning, output limits, rejection/uncertainty and response bounds. `tests/inference-market-db.test.ts` runs against disposable Postgres with real browser-session authentication and HTTP, financial/quota concurrency, duplicate operations, key replacement/revocation, route quarantine, history, expiry and refunds. `tests/developer-access-e2e.ts` runs actual packaged SDK/CLI/MCP processes against the same fixture app and database, including a full 30-second token auction and the existing VM auction/terminal regression. `tests/browser/inference.spec.ts` verifies desktop/mobile interactions with every API request intercepted. None of those results certify a live provider's tokenizer or billing semantics.

| Coverage                                                 | Baseten inference                | Modal inference                                         |
| -------------------------------------------------------- | -------------------------------- | ------------------------------------------------------- |
| Buffered text and independent input/output quota         | Implemented, fixture-tested      | Implemented, fixture-tested                             |
| Native mapping/auth, usage and reasoning parsing         | Mocked contract tests            | Mocked contract tests                                   |
| Endpoint/tokenizer/output-limit qualification            | Not live-qualified               | Actual account endpoint/proxy and qualification pending |
| Tools, streaming, multimodal                             | Rejected in v1                   | Rejected in v1                                          |
| VM provisioning, Git, PTY, copy, snapshots, pause/resume | Existing Wick adapters unchanged | Existing Wick adapters unchanged                        |

Provider sources: [Modal endpoint integrations](https://modal.com/docs/guide/endpoint-integrations), [Modal supported models and rates](https://modal.com/docs/guide/supported-models), [Baseten Muse launch](https://www.baseten.co/resources/changelog/muse-spark-open-and-nemotron-35-super-vl-available-on-baseten/), [Baseten reasoning](https://docs.baseten.co/inference/model-apis/reasoning), [Meta Muse settings](https://dev.meta.ai/docs/muse-spark-open/settings). The hackathon slug is pinned to the event's Baseten instructions, which override the general model-name examples.
