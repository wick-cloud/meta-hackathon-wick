# Purchased token batches and VM connections

**Purchased tokens** in the buyer sidebar opens `/tokens`. The table lists purchased batches across the owner's agent budgets, including completed and expired batches. It shows purchased and available input/output quota separately, consumed tokens, pending usage, expiry countdown and exact date, paid price, refunds and purchase links. A deadline passing removes usable availability immediately in the UI; unresolved usage remains shown as pending.

The page reads only its current 25-row page, newest first, with a stable cursor in the URL. Visible pages refresh every five seconds; hidden tabs pause network polling. An index on buyer/date/ID supports inventory reads without scanning unrelated buyers or loading private accounting snapshots. Viewing history never creates an order, VM or credential.

## Task → VM → purchased inference

1. The owner funds a task grant and issues the agent's purchasing key. VM launch permission uses the existing compute-scoped Broker credential; a token usage key cannot launch VMs.
2. The agent requests its input/output pack in a 30-second auction or buys an instant quote, and reads the saved order until purchase is confirmed.
3. After the pack exists, the owner clicks **Connect**, or the purchasing agent calls the batch-key endpoint below. The response contains a batch-only key, OpenAI-compatible base URL, canonical model and fixed expiry.
4. Launch or open the task's VM through the existing VM flow. Put the batch key and connection URL in that workload's environment and call the model gateway. The Connect dialog supplies a copyable shell example.
5. The inventory shows available, consumed and pending quota as the task runs. When another batch is needed, the purchasing agent buys it within its funded grant and issues a new batch key. A batch key cannot increase funding or buy more tokens itself.

The base URL is the same Broker gateway for every batch (`/api/v1`); the key selects its batch. The canonical model is `meta/muse-spark-open`. Input reservation bounds and maximum output sizes come from the route catalog. V1 supports buffered text requests, with a stable `Idempotency-Key` per logical call and no automatic generation retry after a timeout. Model calls consume prepaid quota without another money charge. No VM or model call is triggered by connecting a batch.

## API

| Endpoint                             | Access                                                                           |
| ------------------------------------ | -------------------------------------------------------------------------------- |
| `GET /api/inference/packs`           | Owner: all own purchases; purchasing key: its grant; batch key: its single batch |
| `GET /api/inference/packs/:id`       | Owned or key-bound batch only                                                    |
| `POST /api/inference/packs/:id/keys` | Signed-in owner or that grant's purchasing key                                   |
| `POST /api/v1/chat/completions`      | Batch key redeems only its own purchased quota                                   |
| `GET /api/inference/requests/:id`    | Owner/grant access as before; batch keys see only their own receipts             |

Issuance accepts `{ "operationKey": "unique-key-issuance-id", "name": "Task batch" }` and returns `{ key, token, connection: { packId, baseUrl, model, expiresAt } }`. Machine requests also send the matching `Idempotency-Key`. Ordinary buyer keys cannot issue batch credentials. Existing OpenAI-compatible clients and Broker completion calls can use the returned `wbk_…` key.

Only a digest is stored. The secret is returned once, is not recoverable by refresh, and is never placed in connection URLs, browser storage, audit events or the setup example. Replaying a successful issuance returns `409 secret_already_issued`, never another secret or an implicit rotation. If a response is uncertain, creating a replacement is an explicit action with a new operation key.

A replacement revokes only that batch's old key. Expiry cannot exceed the batch, task grant or issuing purchasing key. Delegated keys inherit parent revocation; replacing the grant's purchasing key retains the existing behavior of revoking all that grant's keys. Account/role changes and the existing 20-active-key account limit still apply. A batch key cannot purchase, fund, manage keys, access VM controls, inspect other batches or silently consume a different pack when exhausted. Rotation preserves usage and unresolved reservations.

The connection link `/tokens?connect=<pack-id>` opens an authenticated owner dialog without embedding a secret. Session ownership and all key scopes are revalidated by the server. Payment collection and supplier payouts remain separate; unused purchased quota is not automatically refundable.

See the [October 30 Railway MCP verification](verification/railway-mcp-e2e-2026-10-30.md) for the live Baseten task/VM result, Modal accounting failure, MCP release gaps and cleanup evidence.
