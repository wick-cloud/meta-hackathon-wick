# Verification and test operation

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

The application must already be running; the suite does not create additional app processes, VMs, or Wick tasks. Missing credential variables cause the relevant authenticated tests to skip. The buyer test creates one real database request, waits for the actual 30-second auction and durable-job consumers, opens the fixture terminal UI, checks that reconnect does not reset expiry, checks exactly one invoice, and requests termination in a `finally` block. It never runs a customer workload. Traces and screenshots on failure remain in ignored Playwright artifact directories.

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

## Evidence from this build

At 2026-10-28 06:24 UTC, `npm run test:db` passed all **19** marketplace tests against local PostgreSQL 16 with Node 24.22.1 and Vitest 5.0.5. This is local fixture/domain evidence, not verification of Wick's production API or the real Meta service. Final project-wide checks and browser results are recorded in `HANDOFF.md`.
