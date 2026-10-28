# Wick Broker v1

A single-process environment marketplace: describe an environment, review an immutable specification, run a 30-second provider auction, and open the winning VM's browser terminal. Customers type their own commands. Wick Broker does not execute customer workloads, inspect repositories, or launch customer agents.

Node 24 · TypeScript · Fastify · React/Vite · PostgreSQL · Better Auth · pg-boss · xterm.js.

## Local start

Use Node 24 and PostgreSQL 16 or newer. The included Compose file runs PostgreSQL locally:

```sh
npm ci
docker compose up -d postgres
cp .env.example .env
```

Edit `.env`: set a random `BETTER_AUTH_SECRET` of at least 32 characters and all five `SEED_*_PASSWORD` values (12 to 128 characters each). Select `WICK_MODE=fixture` and `MUSE_MODE=fixture` explicitly for local testing. These modes run no paid APIs and allocate no real VMs. Fixtures never replace a failed real API call.

```sh
npm run db:migrate
npm run db:seed
npm run build
npm start
```

Open http://localhost:3000. The app binds `0.0.0.0:3000` by default. `npm run dev` runs the same Fastify process with Vite middleware when there is no built frontend. Delete `dist/client` to use that development middleware after a production build.

Seeded identities are `buyer@demo.wick.local`, `supplier-a@demo.wick.local`, `supplier-b@demo.wick.local`, `supplier-c@demo.wick.local`, and `admin@demo.wick.local`; passwords come only from the environment. Public signup is disabled. The explicit seed command updates those invited credentials and revokes their existing sessions when rerun; it does not run automatically at startup. Suppliers begin with simulated capacities **3, 2, 0**. No passwords are committed.

## Product behavior

- Buyers review catalog, region, resources, exact 15/30/60-minute duration, and maximum total USD price before starting an auction. Default duration is 30 minutes.
- Providers manage simulated capacity, private pricing policy, manual/automatic bidding, approved-configuration offerings, and activity in the same application.
- Manual and auto bids share a locked capacity reservation path. The lowest total price wins; equal prices use accepted timestamp, then ID. Losing holds release at close. The winner's hold remains until confirmed cleanup.
- The request specification, awarded offering revision, quote, and create idempotency key are frozen. Retries cannot silently start another auction or extend the rental clock.
- Exactly one fixed-price demo invoice is issued after Wick confirms both running state and terminal capability. Failed, cancelled, or expired-before-ready environments incur no charge. Early termination after readiness retains the full fixed price. Every invoice says **No payment due**; there are no payments, payouts, or topups.
- The returned Wick admission expiry is authoritative and includes setup time. Reconnecting attaches to the same environment. Disconnecting leaves the rental running; process survival is not guaranteed.
- Muse has three bounded, validated uses: requirement translation; isolated supplier bid proposal/decline; and offering suggestions from recorded unmatched demand. Manual controls remain available after a visible model failure.
- Admins approve existing catalog configurations, adjust the default two-VM admission limit, and retry unresolved cleanup reconciliation. No generated setup code or preparation jobs exist.

The simulated inventory and customer demo quote are distinct from Wick's real operational costs, even when a real Wick adapter is selected.

## Real integrations

Configure real modes and server-only credentials in `.env` or Railway variables. Real Wick uses the exact published `@wick-cloud/sdk@0.1.0-rc.0`, with an API base, organization ID, group ID, and service credential. The official SDK manages scoped terminal authentication and renewal. No upstream credential or scoped token reaches the browser. Terminal output goes only to the authenticated owning browser and is not logged or sent to Muse. Keep `MUSE_MODE=fixture` for the scale baseline; real Muse calls require separate authorization.

Managed real offerings freeze the published micro-USD/second rate and its local retrieval time. `BROKER_TARGET_MARKUP_BPS` defaults to 2000 (20%). The suggested target quote is `max(1, ceil(rate × durationSeconds × (10000 + markupBps) / 100000000))` USD cents, using integer arithmetic and rounding upward once. Manual and Muse bids may differ from this target within supplier policy and buyer budget; each must cover `max(1, ceil(rate × durationSeconds / 10000))` cents of estimated compute cost. The accepted price, target quote, and raw upstream cost basis are frozen separately. New approvals, offerings, requests, and bids require a source retrieved within 15 minutes, with at most 60 seconds of future clock skew; historical quotes remain readable and unchanged. Sync the catalog to refresh a stale source, and explicitly update offerings if its rate changed. The upstream full-term estimate is separate from the customer's fixed quote; neither is settled Wick usage. Managed rates already include Wick's price. BYOK is unsupported. Existing fixture prices and accepted quotes remain unchanged. Suppliers are explicitly demo allocations backed by Wick, not independent provider firms.

Use the separate `scripts/configure-real.ts` command to review and explicitly approve selected real configurations for existing supplier accounts. It preserves passwords, sessions, reservations, and frozen quotes; do not rerun account seeding to change pricing. See [real Wick operation](docs/REAL_WICK.md) for setup and isolated scale-run commands.

Read [Wick contract evidence](docs/WICK_CONTRACT.md) and [Muse contract evidence](docs/MUSE.md) before enabling real modes. Public documentation and offline contract tests do not verify live allocations or live terminal behavior. Real catalog entries require administrator approval. Missing required rate or compute fields fails closed; optional upstream catalog version, currency, money unit, revision, and mode are not invented or required.

## Deploy shape

One Railway app service using `Dockerfile` and `railway.toml`, plus PostgreSQL. Set `DATABASE_URL`, `APP_URL` (HTTPS in production), `BETTER_AUTH_SECRET`, explicit adapter modes, and required real credentials. The same always-on process serves UI, APIs, authentication, terminal WebSockets, and durable queue consumers. Use one replica for v1. `/health` is liveness; `/ready` checks database availability after startup. Migrations run under an advisory lock at startup; SIGTERM closes connections and drains jobs.

Run the explicit seed separately where environment-supplied seed passwords are available: `npm run db:seed` from the development checkout or `npm run seed:production` in the built image. No external deployment or service-account changes were performed during this build.

## Verification

```sh
npm run typecheck
npm test
npm run build
npm run test:browser
```

Set `TEST_DATABASE_URL` to a dedicated test database for PostgreSQL concurrency/auth tests; these use disposable schemas. Browser tests require the seeded fixture application at `E2E_BASE_URL` (default `http://localhost:3000`) and seed credentials. Install Chromium once using `npx playwright install --with-deps chromium`.

For an additional local process-restart check, stop the preview and run `npm run test:recovery`. It requires a built, seeded fixture app and loopback database, manages one app process at a time, and stops it when finished. Restart the preview with `npm start` afterward.

CI explicitly selects fixture adapters and never allocates real compute or uses paid APIs. See [testing notes](docs/testing.md) and [HANDOFF.md](HANDOFF.md) for checks actually run and remaining limits.

Deferred: SSH, file browser, public port previews, snapshots, pause/resume, extensions, longer rentals, supplier setup code, and payments.
