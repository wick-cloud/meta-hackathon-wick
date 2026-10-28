# Real Wick configuration and validation

The app uses the exact published `@wick-cloud/sdk@0.1.0-rc.0`. Real compute requires explicit `WICK_MODE=real`; keep `MUSE_MODE=fixture` for this baseline. All real catalog configurations start unapproved. Supplier accounts represent demo allocations backed by Wick, not independent provider firms. BYOK is unsupported.

## Preserve an existing preview

Do not run `db:seed` to switch an existing preview to real pricing: that command resets invited credentials and sessions. Do not run a second Broker against its database. Outstanding rentals must finish confirmed cleanup in their original mode before switching the running app's `WICK_MODE`; startup enforces that boundary.

After credentials and catalog selections have been reviewed, the following setup commands make no VM allocations:

```sh
npx tsx scripts/configure-real.ts --list
npx tsx scripts/configure-real.ts --apply
```

Required environment names: `DATABASE_URL`, `BETTER_AUTH_SECRET`, `WICK_MODE`, `MUSE_MODE`, `WICK_API_KEY`, `WICK_ORGANIZATION_ID`, `WICK_GROUP_ID`. Use the appropriate `APP_URL` and `NODE_ENV` for the existing preview. `WICK_API_BASE` defaults to the public Wick API.

`--apply` also requires comma-separated `REAL_CATALOG_IDS` and `REAL_SUPPLIER_EMAILS`, identifying explicitly approved managed catalog configurations and existing provider accounts. Optional `REAL_SUPPLIER_CAPACITY` defaults to 1 per selected demo supplier, `REAL_SUPPLIER_AUTO_BID` defaults to true, and `BROKER_TARGET_MARKUP_BPS` defaults to 2000 (20%). The command updates only selected catalog configurations and demo supplier allocations/offerings. Repeated application is idempotent. It preserves users, passwords, sessions, existing reservations, invoices, fixture prices, and accepted quote snapshots. Applying configuration does not restart or publish the app.

## Price semantics

The selected offering freezes `rateMicrosPerSecond`, provenance, retrieval time, and markup. Compute sizes use the offer's exact metadata. Optional catalog version, provider revision, currency, money unit, and mode are not required or invented.

For a finite 15, 30, or 60 minute rental, the default target quote in USD cents is:

```text
max(1, ceil(rateMicrosPerSecond × durationSeconds × (10000 + markupBps) / 100000000))
```

The target markup is a suggestion, not a mandatory bid price. Manual and Muse bids may differ, subject to supplier policy, buyer budget, and the upward-rounded upstream compute cost floor (minimum one cent). The actual accepted bid, target quote, and upstream estimate are frozen separately.

All arithmetic is integral (`BigInt`), with one upward rounding after markup. The raw upstream full-term compute estimate stays in micro-USD and is explicitly an estimate. Customer fixed quote/invoice is separate from actual Wick internal usage; no invoice represents settled usage and no payment is due. Managed rates already include Wick's pricing, so no BYOK fee is added. Accepted quotes do not change when rates change. New bids reject changed rate snapshots, and preview/create carry the frozen `maximumPriceMicrosPerSecond`.

New requests, approvals, offerings, and bids require catalog retrieval within 15 minutes, allowing at most 60 seconds of future clock skew. Historical quotes remain readable unchanged. Refresh the catalog when stale. Boat customer allocations are excluded by explicit user choice. The live test selects `e2b:micro:us`; setup still requires explicit catalog IDs. E2B advertises BYOK capability, so capability alone cannot prove the selected billing route. For each E2B candidate, the official SDK performs a bounded, read-only execution preview in the configured organization/group and requires exact provider/profile/region, `billingMode=wick_managed`, no provider key, `externalCompute=false`, and no fallback offers. Unsupported, BYOK, or ambiguous selected routes remain unavailable. A bounded read-only E2B Micro/us preview passed with these checks; it did not allocate an environment. Catalog rates remain dynamic. Actual create has no extra asynchronous preflight between the safety gate and SDK transport; the catalog proof is frozen alongside its retrieval time, and the actual environment must pass the independent billing check. Actual environment ownership and `billingMode=wick_managed` with no provider key must be verified before invoicing; unexpected owned BYOK resources are quarantined for cleanup without a charge.

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

The browser harness creates fresh test identities, starts one fixture app on loopback port 3301, runs the six existing browsers, and closes its process. `FIXTURE_BROWSER_PORT` can choose another port except 3000; `FIXTURE_BROWSER_ARTIFACTS` should point into the private control directory. It never resets existing account passwords or uses the preview process. `.verify-dist` is ignored so building does not replace assets served by a live preview.

## Separately authorized live scale run

See [the live runner procedure](live-scale.md) for the private journal, isolated test database, detached watchdog, approval gate, runner, cleanup modes, and exact environment names. The runner uses one canary then nineteen additional 15-minute VMs. It measures actual simultaneous running state and twenty authenticated Broker terminal connections, uses unchanged 30-second auctions, exercises provider/global 21st-request rejection, and verifies fixed invoices and confirmed cleanup.

Offline checks do not demonstrate live capacity, pricing availability, SDK interoperability with the deployed service, or live scale performance. No paid allocation or real Meta call is part of the offline verification phase.

## Ongoing catalog freshness

Real mode refreshes the live Wick catalog every five minutes using the existing in-process pg-boss scheduler. Startup queues a refresh when approved prices are older than five minutes. The refresh queue has one worker and bounded retries; a shared advisory lock prevents simultaneous manual and automatic refreshes. SDK reads occur outside SQL transactions.

A successful refresh preserves approval flags and all frozen request, accepted-bid, VM, and invoice prices. Newly discovered configurations require approval. Failed refreshes preserve the previous successful timestamp, and the 15-minute admission freshness check remains enforced. If an upstream rate changes, providers must update their offering before new bids can use it.

See [the observed 20-VM validation](live-scale-results.md) for live results and its exact scope.
