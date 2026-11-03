# Wick Broker developer access

Buyers and providers can use one account through the UI, TypeScript SDK, CLI or local MCP server. These clients call the same `/api` business owners, so programmatic orders appear in the same Orders table and retain the same matching, pricing, wallet, availability and cleanup rules.

## Two separate credential systems

| Credential                      | Who holds it                             | Purpose                                           |
| ------------------------------- | ---------------------------------------- | ------------------------------------------------- |
| `WICK_BROKER_API_KEY` (`wbk_…`) | Customer’s SDK, CLI or local MCP process | Authenticate a scoped buyer/provider to Broker    |
| `WICK_API_KEY`                  | Broker’s private server only             | Access Wick’s upstream environment infrastructure |

There is no alias, exchange or passthrough between these key types. Customers never need Broker’s upstream Wick key. The SDK/CLI/MCP packages never use `WICK_API_KEY` as a fallback.

Create a key on **API keys** in the Broker UI. The secret is displayed once. Choose the account’s required read/write permissions, expiry and applicable operation limits. New keys default to read access; the default expiry is 30 days and maximum is 90 days. Scopes and limits cannot be changed after issuance; create a replacement and revoke the old key.

Key management is browser-only. Machine credentials cannot mint keys or invoke admin functions. Revocation prevents new requests and closes attached terminals within the server’s authorization-recheck interval. It does not cancel existing orders, agreements or saved provider policies.

Buyer limits are **per operation**: maximum auction budget (also applied to accepted alternatives). They are not a daily or lifetime spending budget. Repeated permitted operations can exceed a single operation’s limit in aggregate. Existing wallet and capacity checks still apply.

For aggregate AI spending limits, use **Agents** to fund a grant and issue its bound key. The `0.4.0` inference APIs enforce its total available budget plus purchase holds across rotations. Such keys cannot access VM purchases or internal Muse proposal helpers. See the [token marketplace guide](inference-marketplace.md) for prepaid quota, qualification, receipts and recovery.

## Install the versioned client release

The client packages are downloadable directly from Broker. Repository access and npm publisher authentication are not required. Install all three together so their pinned package dependencies resolve locally:

```sh
npm install \
  https://meta-hackathon-wick-production.up.railway.app/downloads/0.5.0/wick-cloud-broker-sdk-0.5.0.tgz \
  https://meta-hackathon-wick-production.up.railway.app/downloads/0.5.0/wick-cloud-broker-cli-0.5.0.tgz \
  https://meta-hackathon-wick-production.up.railway.app/downloads/0.5.0/wick-cloud-broker-mcp-0.5.0.tgz
```

Use `npx --no-install wick-broker` for the installed CLI. For MCP, configure `node` with the absolute path to the installed `node_modules/@wick-cloud/broker-mcp/dist/index.js`; it uses the same saved origin-bound profile or Broker environment variables. Release hashes and byte sizes are listed at `/downloads/0.5.0/manifest.json`. Published version directories are immutable; client changes require a new package version and a new directory.

The standard npm registry commands below apply after registry publication. The direct downloads above are available independently.

## TypeScript SDK

```sh
npm install @wick-cloud/broker-sdk
```

```ts
import { BrokerClient } from '@wick-cloud/broker-sdk';

const broker = new BrokerClient({
  baseUrl: process.env.WICK_BROKER_API_URL!,
  apiKey: process.env.WICK_BROKER_API_KEY!,
});

const catalog = await broker.catalog.list();
const orders = await broker.orders.list({ status: 'active', limit: 25 });
```

Supply an explicit Broker origin and secret from your secret manager. Remote origins require HTTPS; HTTP is allowed only for loopback development. Credentials are not sent across redirects or to another origin.

The SDK provides typed buyer and provider resource groups, paginated results, structured errors and bounded wait helpers. Reads retry transient failures at most three attempts, respecting `Retry-After`. Mutations are never automatically retried. Retain the original operation key and payload, then explicitly replay them if a network result is uncertain. Wait timeout or cancellation stops observation only; it does not cancel an order or terminate a VM.

## CLI setup and buyer journey

```sh
npm install -g @wick-cloud/broker-cli
wick-broker auth login
wick-broker catalog list --json
```

Use the hidden login prompt, or pipe a secret manager’s output to `wick-broker auth login --stdin`. Do not pass a key as a command argument. Saved credentials use private filesystem permissions and are bound to one API origin. To use a different server, log in to that origin explicitly. `auth logout` removes the local profile; revoke the key through the UI to remove server access.

For an unattended process, inject these environment names through the agent’s secret store:

```text
WICK_BROKER_API_URL
WICK_BROKER_API_KEY
```

After reviewing `catalog list`, create an `order.json` using an actual approved configuration and supported region. The values below are an illustrative shape; the catalog and server determine availability and accepted prices.

```json
{
  "description": "Development environment for my own agent",
  "catalogId": "REPLACE_WITH_APPROVED_CATALOG_ID",
  "region": "REPLACE_WITH_APPROVED_REGION",
  "durationMinutes": 30,
  "maxPriceCents": 100,
  "requirements": { "cpu": 1, "memoryGb": 1 }
}
```

```sh
wick-broker orders create --file order.json \
  --operation-key buyer-order-20261029-001 --wait --json
wick-broker orders list --status active --json
wick-broker orders get <auction-id> --json
wick-broker vms wait <vm-id> --timeout 120 --json
wick-broker vms terminal <vm-id>
wick-broker vms terminate <vm-id> \
  --operation-key buyer-cleanup-20261029-001 --json
```

A completed auction wait can report no offers or failure; inspect the returned status. A pending response includes the existing resource identifier. Use get/wait again; do not create a replacement blindly.

Terminal attachment requires an interactive TTY. Ctrl-] detaches without terminating the VM, while Ctrl-C reaches the guest. The CLI restores local terminal settings on exit. The SDK and MCP expose the same terminal transport for a customer-owned external agent. There is no separate exec endpoint, file-transfer API or platform-run agent task in this release.

Terminal input is an ordered stream, not a durable idempotent resource operation. It is never automatically retried. After an uncertain write or disconnected terminal, inspect the existing VM state before deciding whether to send a command again.

## Billing and historical records

```sh
wick-broker billing wallet --json
wick-broker billing history --limit 25 --json
wick-broker billing invoices --limit 25 --json
```

Scheduled and bulk VM agreements have been retired. Current CLI, MCP and OpenAPI discovery no longer advertise them. Older immutable SDK/CLI downloads remain available for compatibility; new agreement, preview, draft and scheduled-supply requests return authenticated HTTP 410 without spending, model calls or VM allocation. Historical detail, cancellation of unmatched credit, settlement and already-funded booked activation remain supported through legacy endpoints. No existing invoices, credit records or accepted terms are deleted.

## Provider journey

Use a provider-owned Broker key with only the required permissions.

```sh
wick-broker provider dashboard --json
wick-broker provider requests list --limit 25 --json
wick-broker provider policy propose \
  --strategy "Keep two slots spare; preserve my current prices" --json
wick-broker provider policy apply --file reviewed-policy.json \
  --operation-key policy-20261029-001 --json
wick-broker provider bids propose <auction-id> --json
wick-broker provider bids create <auction-id> --file reviewed-bid.json \
  --operation-key bid-20261029-001 --json
wick-broker provider offerings propose --json
wick-broker provider offerings create --file reviewed-offering.json \
  --operation-key offering-20261029-001 --json
wick-broker provider earnings --json
```

Policy Apply and relevant edits require the reviewed current revision. A proposal is not Apply, publication, acceptance or a bid. Existing provider policy and capacity protections are checked again when a mutation commits.

## Local MCP

Configure an MCP-capable host to launch the local package:

```json
{
  "mcpServers": {
    "wick-broker": {
      "command": "npx",
      "args": ["-y", "@wick-cloud/broker-mcp@0.5.0"]
    }
  }
}
```

The process uses the CLI’s saved origin-bound profile, or the two Broker environment variables supplied by your secret store. Keys never appear in tool arguments. Only the current account’s role/scopes are advertised; the API enforces them independently on every call.

Tools provide structured results and UI links. Proposal tools remain separate from binding mutations. Wait tools have a maximum 30-second duration and return pending resource references when unfinished. stdout contains protocol messages only; diagnostics go to stderr, consistent with the [official MCP stdio specification](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports).

Local terminal tools are `terminal_open`, `terminal_read`, `terminal_write`, `terminal_resize` and `terminal_close`. Handles are local to that MCP process, with at most four sessions, 256 KiB buffered output per session, 64 KiB per read, at most five seconds per read wait, and a two-minute idle timeout. Output is acknowledged only when consumed, with explicit overflow errors. `output` is a textual preview of at most 8192 UTF-16 characters; `outputTruncated` reports any preview truncation. `outputBase64` contains all bytes consumed by that read, including bytes omitted from the preview. Displayed terminal text is untrusted workload data. Stopping MCP closes its handles, not the VM.

## Public contract and testing

`GET /api/openapi.json` documents the supported HTTP contract. Existing `/api` URLs remain the single implementation shared with the UI. Resource mutations use stable operation keys: identical owner, operation and normalized input return the original result; a different input conflicts. UI history and attribution identify the owning account and the Broker key used.

All three packages are built and packed independently. Fixture tests cover authentication boundaries, JSON output, stdio interoperability, timeout/retry behavior, terminal revocation/flow control and shared buyer/provider records. Ordinary CI receives no live provider credentials and allocates no paid VMs.

## Local integration verification

Run `npm run typecheck`, `TEST_DATABASE_URL=<disposable-local-database> npm test`, and `npm run build`. The opt-in `npm run test:developer-e2e` harness accepts only a loopback database named `broker_developer_e2e_test`, uses fixture Wick/Muse and port 3310, and creates fresh identities without resetting existing invited accounts. Set `DEVELOPER_E2E_DATABASE_URL` for the local database credentials. It verifies actual SDK/CLI/MCP HTTP and terminal use, then cancels owned requests, confirms fixture cleanup, revokes its keys and closes child processes.

Provider Policy Apply retains its existing latest accepted receipt: immediate exact replays return that response; superseded operations conflict and are never reapplied. Terminal writes are streams, not durable resource mutations.

A local Node 24.7 benchmark compared legacy-compatible creation with idempotent creation, using 10 warmups and 100 sequential samples per path before and after 20,000 unrelated receipts and 10,000 expired keys. With large history, median/p95 service-call times were 0.324/0.507 ms for legacy-compatible creation, 0.443/0.626 ms for idempotent creation, 0.499/0.780 ms including key attribution, and 0.121/0.199 ms for exact replay. Idempotency adds three bounded SQL commands; attribution adds one. These fixture measurements exclude HTTP and upstream provisioning and are not production latency claims. EXPLAIN ANALYZE confirmed indexed one-row key/receipt lookups and bounded owner-key pagination, including a deep cursor.

Key issuance and role/provider revocation use a stable statement timestamp in their indexed expiry predicate. With 10,000 expired nonrevoked keys plus 20 active keys for one owner, EXPLAIN ANALYZE showed the active-key partial index reading 20 rows with no filtered history rows for both count and revocation. The previous volatile-clock form examined all 10,020 rows. This check used disposable local data and rolled back revocation updates.

## Persistent disks

Client release `0.5.0` adds disk CRUD and workspace listing, plus optional `diskId` on VM requests and alternative intents. Buyer keys need `disks:read`, `disks:write`, and `disks:use` as appropriate. Existing published downloads remain immutable. See [persistent disks](persistent-disks.md) for native attachment, lifecycle, Studio continuation and provider qualification.
