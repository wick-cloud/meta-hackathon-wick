# Agent buying workspace

Broker now has one owner workspace for funded agents and token purchasing. It uses the existing Railway application, Postgres database, PgBoss worker, wallet, auction and inference gateway. The agent's task still runs in the customer's own environment.

## User flow and layout changes

- **Agents** replaces the card-based agent-budget page with a searchable, URL-filtered table. Columns separate funding available, purchase holds, eligible calls, buying policy and expiry. The page fetches 25 rows with keyset pagination; browser Back retains the filter and cursor.
- **Overview** shows the Muse purchasing assistant beside purchased allowance and the current policy. Cash, tokens reserved for inference, and unresolved usage remain distinct.
- **Buying policy** has a draft form and a review dialog. The owner chooses suggestions, review per purchase, or automatic buying. Controls include maximum per purchase, output cap per request, pack size of one to eight bounded calls, refill trigger and permission for an instant fallback.
- **Activity & receipts** keeps the latest 25 buying decisions alongside existing pack, order and inference history. Every purchase links to its permanent token-auction page. Full order and batch history remains in Orders and Purchased tokens.
- **Connection** retains grant key issuance, connection examples, original grant limits and closing controls.
- The sidebar has one **New purchase** action, then Orders, Virtual machines, Purchased tokens and Agents. VM and token purchase forms remain reachable through the chooser and contextual actions.
- Provider **AI capacity** separates Supply & pricing from Commitments. Its allocation bars show configured token commitments, not upstream GPU utilization. Muse can suggest rates for review; applying a suggestion changes the draft only. The provider must save to publish.

The design uses existing Wick colors, typography and components, with compact tables, orange primary actions, responsive columns, visible errors and confirmation dialogs. Tabs and list filters are URL-backed. Polling pauses in hidden tabs using the existing resource hook.

## Purchasing rules

A new grant defaults to two hours. Existing grant deadlines are unchanged, and new packs keep the grant's original expiry. The API still supports explicit grant lifetimes between one minute and seven days. Only the owner can fund, close, change policy or issue a key.

Automatic buying is off until the owner explicitly saves that mode. The worker checks up to four due grants per minute, sequentially. Each grant allows one evaluation per minute and at most 20 claimed evaluations over its lifetime, including interrupted attempts and fixture evaluations. Policy edits do not reset that cap. This cadence does not guarantee uninterrupted inference; use manual purchasing when immediate capacity is needed.

Before a recommendation, the server checks the grant, fixed expiry, budget, outstanding purchase holds, pending orders and unresolved inference. It builds at most six qualified candidates from current supplier prices. It uses each route's existing conservative input reservation and the owner's output cap. Quota from different packs is never combined into one call. The output cap must fit the qualified provider limit; smaller input bounds require separate accounting qualification.

Muse sees priced candidate IDs, quantities, eligible call counts and remaining time. It selects a candidate or recommends waiting. It cannot set prices, increase funding, enable providers or change permissions. Real-mode output is schema-validated; failures remain visible and never fall back to simulated advice. Customer prompts, answers, API keys, signed quote tokens and competing suppliers' private settings are not sent to this helper.

The owner reviews a suggested purchase before committing. Automatic mode performs that same transaction using the approved policy. Both recheck policy revision, grant authority, current allowance, expiry, funding and supply. An instant candidate is allowed only when the original grant and buying policy allow it and no qualified call remains. Instant-only provider supply is supported.

Only one purchase can be pending when an automatic purchase is admitted. Decisions use a stable `buying:<decision-id>` operation key; the order, hold and decision link commit atomically. Concurrent acceptance or recovery returns the existing order. A new policy supersedes outstanding recommendations. Pausing stops future automatic purchases; already committed orders retain their normal auction lifecycle. Closing or expiry pauses the policy, cancels unawarded orders and follows the existing settlement rules. Key rotation does not remove the owner's buying policy; pause it or close the grant to stop owner-authorized buying.

Unknown inference outcomes pause buying until reconciled. Nothing automatically resends the customer's inference request or refunds uncertain usage. The existing gateway, purchase ledger and provider fee calculations remain authoritative.

## Receipts and selling windows

A decision may capture an instant quote with the same model, input/output quantities and grant expiry. The order page shows the accepted purchase price against that captured baseline. It does not invent savings without a comparable quote. Purchase savings exclude unused prepaid quota, and calls still consume tokens without a second monetary charge.

An offering can specify an optional dated selling window. Both timestamps are required together, with the end after the start; clearing both removes the window. The browser displays the operator's timezone and persists UTC. New quotes, auction eligibility and auction awards respect the window. A provider must leave the window open through auction closing to participate. Existing sold packs remain usable until their frozen deadline, even when new sales have stopped.

Muse supply suggestions use only that provider's configured rates, cost assumptions, qualification and uncommitted allocation. Rates cover configured cost after the 15% Broker commission. Suggestions never publish, change GPU allocation or reduce existing commitments. These are one-off dated sales windows, not recurring capacity calendars or infrastructure telemetry.

## Interfaces and rollout

Migration `023_inference_buying.sql` adds policies, durable decisions and selling-window fields. Deploy with the normal migration-before-start process. No new service or secret is required; purchasing and supply helpers use the existing Muse configuration.

New owner-session endpoints:

| Method    | Path                                        | Purpose                          |
| --------- | ------------------------------------------- | -------------------------------- |
| GET       | `/api/inference/agents`                     | Filtered agent page              |
| GET / PUT | `/api/inference/grants/:id/buying`          | Workspace / versioned policy     |
| POST      | `/api/inference/grants/:id/buying/evaluate` | Claim an evaluation              |
| POST      | `/api/inference/grants/:id/buying/accept`   | Commit a decision by ID          |
| GET       | `/api/token-orders/:id/purchase-receipt`    | Decision and comparison baseline |
| POST      | `/api/provider/inference/propose`           | Provider-session supply draft    |

Mutation routes require the application origin. Agent keys cannot use these unmetered helpers or change policies. Existing SDK/CLI/MCP purchase interfaces remain compatible; the SDK offering type accepts optional selling-window fields. Published immutable client downloads have not been replaced, and no client release is part of this change.

## Verification

- Disposable-Postgres tests cover concurrent acceptance, ownership, stale revisions and deadlines, instant-only fallback, model failure, an owner closing during model evaluation, interrupted decision recovery, the lifetime evaluation cap, manual-spend conflicts, unresolved usage, selling windows and preserved purchased quota.
- Adapter tests use mocked Baseten HTTP responses to check model identity, candidate validation and explicit real-mode failure. They do not call a paid provider.
- Browser tests intercept all APIs and cover policy review, pause/resume, recommendation acceptance, permanent countdown/receipt navigation, provider rate drafts and selling windows, mobile layout and the existing VM/token workflows.
- The query test inserts 14,000 closed grants with paused policies. It asserts two list queries, enrichment restricted to selected IDs, indexed newest-first listing and the partial worker due index. It inspects `EXPLAIN (ANALYZE, BUFFERS)` for those queries on the disposable database. Substring name search can scan the selected owner's name history; it is not a constant-time search index.

Run `TEST_DATABASE_URL=<disposable database> npm run check` and browser tests against a local Vite server. Add `BUYING_QUERY_EVIDENCE=1` to the focused database test to print query plans' row, buffer and timing summaries. These local results do not establish production latency or live model accuracy. This change does not perform live-provider qualification or deployment.

### Local run, October 30, 2026

The full check completed with 774 passing tests across 57 files. All 68 selected browser checks passed, including VM inventory, Orders/agreements, token inventory and the buying workspace. The final model-attempt audit change was rechecked with all 52 focused database/adapter tests. TypeScript, application build, SDK/CLI/MCP builds, local documentation links and diff whitespace checks passed. Vite reports a non-fatal main-chunk size warning (about 530 kB before gzip).

With 14,000 closed grants, the sampled default agent page returned six rows including its pagination sentinel using 23 shared buffers; its selected-page allowance query returned one aggregate using seven buffers. The due-worker query returned one eligible grant using seven buffers and the partial due index. These are single local query-plan observations, not production benchmarks. Name substring search retains the owner-history scan limitation described above.

No production configuration, deployment, immutable download, real provider qualification or paid model request was changed by this implementation.
