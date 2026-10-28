# Verification and test operation

## Real SDK readiness evidence, 2026-10-28

The real Wick implementation passed **146/146 offline tests across 11 suites**, including the installed official SDK wire contract, scoped terminal renewal/flow control, integer pricing and stale snapshots, PostgreSQL 20/21 admission, cleanup, and the independent live runner's journal/watchdog guards. `npm run typecheck` passed. The production Vite build and server TypeScript compilation passed with output directed to `.verify-dist`, preserving the existing preview's served `dist` files.

All **6/6 browser cases passed in 42.4 seconds** on a separate local fixture database and port 3301 through `scripts/verify-fixture-browser.ts`. This covered the real 30-second Broker auction, fixture terminal reconnect, invoice, provider, and admin flows. That isolated test process exited afterward. No real VM allocations or real Meta calls were made; the 20-VM live runner has not been executed. See [real Wick operation](REAL_WICK.md) and [the guarded live-run procedure](live-scale.md).

Use Node 24. These tests run locally or in CI without paid Wick allocations or Meta calls. Unit adapter tests inject HTTP responses; PostgreSQL lifecycle tests use an explicitly constructed in-memory Wick adapter; browser tests require both application adapters to be in fixture mode before creating a rental.

## Commands

```sh
npm ci
npm run typecheck
npm test
npm run build
```

Database suites require `TEST_DATABASE_URL` pointing to a dedicated local test database. The marketplace suite creates uniquely named schemas, applies the real versioned migrations, starts real pg-boss queues in a separate uniquely named schema, and removes both schemas afterward. The database user needs schema creation privileges. It does not truncate the application's public schema. Without `TEST_DATABASE_URL`, database tests are explicitly skipped; a skipped suite is not evidence of concurrency verification.

```sh
TEST_DATABASE_URL=postgres://wick:wick@localhost:5432/wick_broker_test npm run test:db
```

The connection string above is a local setup example, not a production credential. Prefer the configured, ignored `.env` for local secrets.

## Browser fixture tests

Start and seed the real application with PostgreSQL, `WICK_MODE=fixture`, and `MUSE_MODE=fixture`. Install Chromium with `npx playwright install --with-deps chromium`, then run:

```sh
npm run test:browser
```

Playwright loads the ignored local `.env`. `E2E_BASE_URL` defaults to `APP_URL`, then `http://localhost:3000`. The URL must match the application's allowed origin. Buyer credentials use `SEED_BUYER_EMAIL` / `SEED_BUYER_PASSWORD`; provider credentials use `SEED_SUPPLIER_A_EMAIL` / `SEED_SUPPLIER_A_PASSWORD`. The default emails match the explicit seed command. `E2E_BUYER_EMAIL` and `E2E_PROVIDER_EMAIL` can override the seeded emails. No password is committed or provided by the tests.

The application must already be running; the suite does not create additional app processes, VMs, or Wick tasks. Missing credential variables cause the relevant authenticated tests to skip. The buyer test creates one real database request, waits for the actual 30-second auction and durable-job consumers, connects through the fixture terminal WebSocket bridge, reconnects to the same environment without resetting expiry, checks exactly one invoice, and requests termination in a `finally` block. It never runs a customer workload. Additional browser cases exercise the Muse fixture review, provider capacity/policy/offering controls, and administrator catalog approval/VM limit controls. Provider and administrator settings are restored in `finally` blocks; the test offering is unpublished. Admin credentials use `SEED_ADMIN_EMAIL` / `SEED_ADMIN_PASSWORD`. Traces and screenshots on failure remain in ignored Playwright artifact directories.

## Marketplace invariants verified against PostgreSQL

- Concurrent requests cannot reserve a supplier's single capacity slot twice.
- Duplicate concurrent bids create one bid and hold; late bids reserve nothing.
- Concurrent close processing awards once, selects the lowest total price, and uses accepted timestamp then ID for ties.
- Loser holds release at close; the winning hold remains through asynchronous termination acceptance and releases only on confirmed cleanup.
- Queue insertion failure rolls back the award, VM insertion, and capacity changes together.
- Accepted reservations and their fixed quote survive supplier policy, offering price, revision, and active-state changes.
- Concurrent awards enforce the two-VM admission limit.
- SQL rejects mutation of the accepted environment specification.
- Running state plus terminal capability creates exactly one fixed demo invoice, independent of browser activity.
- Missing terminal capability, absent authoritative expiry, expiration before readiness, confirmed create rejection, and cancellation racing readiness do not charge.
- An uncertain create retries the persisted idempotency key and identical input. Later observations cannot extend the first authoritative expiry.
- A non-owner cannot terminate a VM. Owner cancellation racing create remains cancelled.
- Early termination after readiness keeps the full fixed charge.
- No-offer attempts end without a VM or automatic new auction. Exact catalog duration and integer-cent pricing are enforced; customer execution fields are rejected.
- A bid waiting for a provider lock cannot be accepted after its auction deadline.
- Owner-scoped HTTP reads, lists, cancellation, and retry prevent another buyer accessing a rental.
- Tuple pagination retains records sharing the same exact PostgreSQL timestamp.
- Cancellation before any create attempt releases capacity without allocating an environment.
- Fixture adapters cannot reconcile, charge, or release holds for a rental admitted under real mode. Fixture catalog IDs cannot enter real-mode requests, and catalog sync revokes approval for vanished configurations.
- The configured VM concurrency limit applies when no administrator override exists.

## Live process recovery

After a production build and explicit seed, stop the existing local preview and run:

```sh
npx tsx scripts/verify-recovery.ts
```

The script rejects non-loopback app/database URLs and requires both adapter modes to be `fixture`. It manages one built application process at a time. It creates one actual database auction, restarts the app gracefully before the 30-second close, waits for the durable consumers to produce a ready fixture VM and one invoice, and restarts again. It asserts that the existing Better Auth session still works and the environment ID, create key, exact PostgreSQL expiry, readiness time, invoice ID, and price remain unchanged. It checks there is exactly one VM, fixture environment, and invoice, then terminates the fixture rental and waits for confirmed cleanup and capacity release.

The script stops its application process on completion. Restart your ordinary preview afterward with `npm start`. This is a manual local integration check, not an external allocation test or a deployment step.

## Evidence from this build

At 2026-10-28 06:32 UTC, `npm run test:db` passed all **26** marketplace tests against local PostgreSQL 16 with Node 24.22.1 and Vitest 5.0.5. At 06:43 UTC, the live process recovery script passed both graceful restarts and confirmed final cleanup. At 06:44 UTC, the final combined `npm run test:browser` run passed **6/6** cases in 40.7 seconds against the built application, real Better Auth, real PostgreSQL and durable job consumers. The buyer workflow included the actual 30-second auction and an authenticated fixture WebSocket connection/reconnection. Earlier test-harness assumptions about review URL matching and numeric-input formatting were corrected before this final run. This is local fixture/domain evidence, not verification of Wick's production API or the real Meta service. Final project-wide checks are recorded in `HANDOFF.md`.
