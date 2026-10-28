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

For a finite 15, 30, or 60 minute rental, the quote in USD cents is:

```text
max(1, ceil(rateMicrosPerSecond × durationSeconds × (10000 + markupBps) / 100000000))
```

All arithmetic is integral (`BigInt`), with one upward rounding after markup. The raw upstream full-term compute estimate stays in micro-USD and is explicitly an estimate. Customer fixed quote/invoice is separate from actual Wick internal usage; no invoice represents settled usage and no payment is due. Managed rates already include Wick's pricing, so no BYOK fee is added. Accepted quotes do not change when rates change. New bids reject changed rate snapshots, and preview/create carry the frozen `maximumPriceMicrosPerSecond`.

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
