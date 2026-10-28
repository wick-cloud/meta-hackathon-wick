# Provider accounts and cross-provider matching

The four workspaces are operator-managed allocations using Wick's managed routes. They are not accounts operated by E2B, Daytona, Baseten or Modal, and their configured slots do not measure upstream free capacity. Customer VMs are still created through Wick; Broker runs as one Railway app with PostgreSQL.

| Account display | Immutable Wick provider ID | Environment key | Observed catalog configurations | Native region |
| --------------- | -------------------------- | --------------- | ------------------------------: | ------------- |
| E2B             | `e2b`                      | `E2B`           |                               3 | `us`          |
| Daytona         | `daytona`                  | `DAYTONA`       |                               3 | `us`          |
| Baseten         | `provider-blaxel`          | `BLAXEL`        |                               2 | `us-pdx-1`    |
| Modal           | `modal`                    | `MODAL`         |                               4 | `auto`        |

**Baseten is the requested display alias for this account; its actual underlying route is Blaxel.** The label does not imply that Baseten and Blaxel are the same company or that Broker connects to a Baseten API. The native provider ID remains visible in configuration and allocation descriptions.

## One-time account setup

Deploy `main` with the migration-only pre-deploy command. On a fresh database, bootstrap the original invited buyer/admin roles in fixture mode once as described in [Railway setup](RAILWAY.md). On the existing app, preserve those accounts and credentials; do not rerun the seed command. Any outstanding fixture rentals must finish confirmed cleanup before switching to real Wick mode.

Keep server-side `WICK_MODE=real`, `MUSE_MODE=fixture` and the existing managed Wick credential/scope. Review current eligible configurations from the app container:

```sh
npm run configure:real:production -- --list
```

Supply the following private variables for **each** key in the table:

```text
REAL_PROVIDER_<KEY>_EMAIL
REAL_PROVIDER_<KEY>_PASSWORD
REAL_PROVIDER_<KEY>_CATALOG_IDS
```

Passwords must contain 12–128 characters and belong only in private service variables. Catalog IDs are explicit comma-separated selections from the current listing; never invent an ID or substitute one provider's profile for another. Add:

```text
REAL_PROVIDER_CAPACITY=5
MAX_CONCURRENT_VMS=20
REAL_RETIRED_SUPPLIER_EMAILS=<comma-separated existing legacy supplier emails>
```

Then run once in the app container:

```sh
npm run configure:real:production -- --apply-providers
```

The setup creates missing provider credentials and binds each account to its own native configurations. Existing credentials and sessions are preserved, including on retries; a conflicting role or cloud binding fails explicitly. The operation keeps buyer/admin accounts, frozen bids, invoices, reservations and cleanup state. Explicitly retired legacy suppliers lose automatic bidding and active **real** offerings while their history and fixture records remain. The command allocates no VM and collects no payment.

Do not keep this command in startup or the permanent pre-deploy hook. If deployment access requires a temporary one-time setup hook, restore `npm run db:migrate:production` after success. Subsequent setup runs are explicit configuration operations, not routine deployment work. Account email and password changes require a separate deliberate operation; supplying another password on a setup retry does not reset an existing account.

## Buyer and provider interactions

The buyer reviews minimum CPU/memory, any GPU requirement, exact rental duration, maximum gross total and location before the 30-second auction. Cross-provider matching requires explicit `matchAcrossProviders` review. A named native region stays exact: `us`, `us-pdx-1` and `auto` are not silently treated as equivalent. The buyer must choose the available-region option to permit matching across those native locations.

Each eligible provider may bid only an active, approved offering belonging to its immutable upstream binding and satisfying the reviewed requirements. Providers can narrow their allowed configurations, pause automatic bidding, reserve spare capacity and adjust pricing within the cost floor and budget. They cannot broaden their cloud identity through policy edits. Each workspace starts with five configured slots; the global 20-VM admission limit still applies. Holds for accepted bids and rentals remain until their normal release or confirmed cleanup.

The selected offering's native provider, profile, region, resources and pricing are frozen for provisioning. The winning cloud's configuration is passed to Wick. Existing exact-route requests and historical snapshots keep their prior semantics; matching does not silently migrate an existing rental to a different cloud.

Suggested gross prices use the current managed Wick rate and the fixed provider commission. Broker receives **15% of provider gross**, and the provider retains **85% before compute costs**. There is no extra buyer fee and no stacked markup. Actual VM use consumes Wick credits. Customer invoices and provider earnings remain demo accounting records marked **No payment due**; payments and payouts are not implemented.

## Coverage record

Scope is Broker's customer VM admission, lifecycle and authenticated browser terminal through the public Wick SDK. This change does not implement or modify native Wick provider adapters or guest package installation. Git integration, copy/file tools, saved snapshots, pause/resume and other Wick product features are outside this Broker UI change; their absence here is not evidence that the corresponding native provider lacks them.

| Feature                                        | Implementation / offline coverage                                                                                                                                                                 | Four-provider live observation                                                                           |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| Native catalog and managed billing scope       | SDK parsing, route identity, resources, rate provenance and fail-closed preview contracts                                                                                                         | All 12 current routes passed read-only catalog/execution preview at 2026-10-28 18:33 UTC; no allocations |
| Provider identity and account setup            | [Setup DB tests](../tests/provider-setup-db.test.ts): role/binding collisions, hashed new credentials, existing auth/history preservation and concurrent retries                                  | Provider configuration is an operator action; preview does not verify login or upstream capacity         |
| Cross-provider matchmaking                     | [Matching owner](../src/server/marketplace/matching.ts) and [auction owner](../src/server/marketplace/auction.ts): explicit compatibility review, native region preservation and winning snapshot | No new live allocation claim                                                                             |
| VM create, admission expiry and idempotency    | Shared Wick SDK adapter plus fixture/contract and database tests; original create key and frozen quote retained                                                                                   | Not exercised by the read-only preview                                                                   |
| Ownership, scoped browser terminal and renewal | [Terminal contracts](../tests/wick-sdk-terminal.test.ts) and [terminal authorization](../tests/wick-terminal.test.ts)                                                                             | No four-provider live terminal/PTY validation in this change                                             |
| Cleanup, reservations and demo invoices        | Shared lifecycle/database coverage; holds release only after confirmed cleanup; exactly one frozen invoice on readiness                                                                           | No real VM was created or deleted by the preview                                                         |

Read-only preview success demonstrates a matching managed route at the observation time. It does not prove real provisioning, terminal interoperability, measured capacity, sustained scale or asynchronous physical deletion. Earlier [live scale results](live-scale-results.md) retain their original provider and test scope and must not be generalized to all four providers.
