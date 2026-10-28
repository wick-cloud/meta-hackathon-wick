# Real Wick configuration and validation

The app uses the exact published `@wick-cloud/sdk@0.1.0-rc.0`. Real compute requires explicit `WICK_MODE=real`; keep `MUSE_MODE=fixture` for this baseline. All real catalog configurations start unapproved. Provider accounts represent operator-managed allocations backed by Wick, not accounts operated by independent provider firms. BYOK is unsupported. Native route IDs are `e2b`, `daytona`, `provider-blaxel` and `modal`. The requested Baseten account display name uses the underlying Blaxel route; it is not a separate Baseten API integration.

## Preserve an existing preview

Do not run `db:seed` to switch an existing preview to real pricing: that command resets invited credentials and sessions. Do not run a second Broker against its database. Outstanding rentals must finish confirmed cleanup in their original mode before switching the running app's `WICK_MODE`; startup enforces that boundary.

After credentials and catalog selections have been reviewed, the following setup commands make no VM allocations:

```sh
npx tsx scripts/configure-real.ts --list
npx tsx scripts/configure-real.ts --apply-providers
```

Required environment names: `DATABASE_URL`, `BETTER_AUTH_SECRET`, `WICK_MODE`, `MUSE_MODE`, `WICK_API_KEY`, `WICK_ORGANIZATION_ID`, `WICK_GROUP_ID`. Use the appropriate `APP_URL` and `NODE_ENV` for the existing preview. `WICK_API_BASE` defaults to the public Wick API.

`--apply-providers` requires the four `REAL_PROVIDER_<KEY>_EMAIL`, `_PASSWORD` and `_CATALOG_IDS` sets, with keys `E2B`, `DAYTONA`, `BLAXEL` and `MODAL`. Select each account's native IDs from `--list`; the command rejects a cross-cloud selection. Capacity defaults to five per workspace through `REAL_PROVIDER_CAPACITY`. `REAL_RETIRED_SUPPLIER_EMAILS` explicitly identifies legacy accounts whose automatic bidding and active real offerings are retired. The shared 20-VM admission limit remains separate.

The operation hashes supplied new passwords before its transaction, creates missing accounts, and preserves existing credential hashes and sessions on retries. A collision with another role or upstream binding fails without repurposing the account. It preserves existing reservations, invoices, fixture records and accepted quote snapshots. Repeated application is idempotent; applying configuration does not restart or publish the app. Keep setup outside normal startup and permanent pre-deploy hooks. See [provider marketplace setup and coverage](provider-marketplace.md).

The older `--apply` command still supports explicitly chosen unbound demo suppliers through `REAL_CATALOG_IDS`, `REAL_SUPPLIER_EMAILS`, `REAL_SUPPLIER_CAPACITY` and `REAL_SUPPLIER_AUTO_BID`. It refuses the cloud-bound provider accounts. Broker commission remains fixed at 15% of provider gross rental revenue; there is no configurable target markup.

## Price semantics

The selected offering freezes `rateMicrosPerSecond`, provenance and retrieval time. Compute sizes use the offer's exact metadata. Optional catalog version, provider revision, currency, money unit and mode are not required or invented.

The buyer's accepted total is the provider's gross rental revenue. Broker deducts 15% from that revenue, leaving 85% to the provider before compute costs. Broker adds no customer fee. For finite 15, 30 or 60 minute rentals, the suggested managed gross and minimum bid in USD cents are:

```text
max(1, ceil(rateMicrosPerSecond × durationSeconds / 8500))
```

One gross cent leaves 8,500 micro-USD to the provider. This floor covers the raw upstream estimate after commission; rounding the upstream estimate to cents first would overstate the floor. Manual and Muse bids may exceed the suggestion within supplier policy and buyer budget. The previous 20% target markup is not stacked onto the commission.

For a gross price of `g` cents, the frozen Broker commission is `g × 1500` micro-USD and the provider's share is `g × 8500` micro-USD. Integer arithmetic preserves exactly 15% and 85%, including small rentals: a $0.03 total has a $0.0045 Broker share and a $0.0255 provider share. This accounting precision does not introduce a payment processor or settlement policy. Buyer invoice fees stay zero; invoices say **No payment due**.

New binding bids and accepted counteroffers freeze their revenue split, which is copied into the invoice only on readiness. Historical accepted bids, VM quotes and invoices retain their original economics. Existing records without a commission snapshot display as legacy; they are not assigned a new fee retroactively. New business uses the commission model, including bids against older active offerings. Published rates remain subject to freshness and change checks. Preview/create carry the frozen `maximumPriceMicrosPerSecond`. Managed rates already include Wick pricing; BYOK remains unsupported.

New requests, approvals, offerings, and bids require catalog retrieval within 15 minutes, allowing at most 60 seconds of future clock skew. Historical quotes remain readable unchanged. Refresh the catalog when stale. Boat customer allocations remain excluded. For each candidate from E2B, Daytona, Blaxel or Modal, the official SDK performs a bounded, read-only execution preview in the configured organization/group and requires exact provider/profile/region, `billingMode=wick_managed`, no provider key, `externalCompute=false`, and no fallback offers. Capability advertising alone cannot prove the selected billing route. Unsupported, BYOK, or ambiguous routes remain unavailable.

At **2026-10-28 18:33 UTC**, the read-only catalog/execution-preview check passed for all **12** current routes across the four upstream providers. It allocated no VMs and did not test a real terminal connection. Rates and availability remain dynamic; this result is not a four-provider live allocation or scale claim. The [provider coverage record](provider-marketplace.md) separates implementation, offline verification and this read-only observation.

Actual create has no extra asynchronous preflight between the safety gate and SDK transport; the catalog proof is frozen alongside its retrieval time, and the actual environment must pass the independent billing check. Actual environment ownership and `billingMode=wick_managed` with no provider key must be verified before invoicing; unexpected owned BYOK resources are quarantined for cleanup without a charge.

Cleanup never calls create, even with the original key. Uncertain admission is discovered through bounded exact-name/scope/time environment listings. Absence remains UNKNOWN; native TTL is only a backstop, and holds are not falsely released.

## Offline checks while preserving a preview

Use a dedicated local `TEST_DATABASE_URL`; never use the preview DB. Unit and database suites use synthetic SDK responses and isolated database schemas:

```sh
npm run typecheck
npm test
NODE_ENV=production npx vite build --outDir .verify-dist/client
npx tsc -p tsconfig.server.json --outDir .verify-dist
npx tsx scripts/verify-fixture-browser.ts
```

The browser harness creates fresh test identities, starts one fixture app on loopback port 3301, runs the browser scenarios, and closes its process. `FIXTURE_BROWSER_PORT` can choose another port except 3000; `FIXTURE_BROWSER_ARTIFACTS` should point into the private control directory. It never resets existing account passwords or uses the preview process. `.verify-dist` is ignored so building does not replace assets served by a live preview.

## Separately authorized live scale run

See [the live runner procedure](live-scale.md) for the private journal, isolated test database, detached watchdog, approval gate, runner, cleanup modes, and exact environment names. The runner uses one canary then nineteen additional 15-minute VMs. It measures actual simultaneous running state and twenty authenticated Broker terminal connections, uses unchanged 30-second auctions, exercises provider/global 21st-request rejection, and verifies fixed invoices and confirmed cleanup.

Offline checks do not demonstrate live capacity, pricing availability, SDK interoperability with the deployed service, or live scale performance. No paid allocation or real Meta call is part of the offline verification phase.

## Ongoing catalog freshness

Real mode refreshes the live Wick catalog every five minutes using the existing in-process pg-boss scheduler. Startup queues a refresh when approved prices are older than five minutes. The refresh queue has one worker and bounded retries; a shared advisory lock prevents simultaneous manual and automatic refreshes. SDK reads occur outside SQL transactions.

A successful refresh preserves approval flags and all frozen request, accepted-bid, VM, and invoice prices. Newly discovered configurations require approval. Failed refreshes preserve the previous successful timestamp, and the 15-minute admission freshness check remains enforced. If an upstream rate changes, providers must update their offering before new bids can use it.

See [the observed 20-VM validation](live-scale-results.md) for live results and its exact scope.
