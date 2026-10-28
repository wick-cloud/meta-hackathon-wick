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

Broker earns a fixed **15% commission from the provider's gross rental price**. The buyer pays the accepted fixed total, with no added Broker fee. Providers retain 85% before their own compute costs. For a $10.00 rental, Broker's share is $1.50 and the provider's share is $8.50. Prices, provider policy limits and budgets are gross rental totals. There are no subscriptions, listing charges, payments or payouts in this demo.

Managed real offerings freeze the published micro-USD/second rate and retrieval time. New suggested quotes use `max(1, ceil(rate × durationSeconds / 8500))` USD cents so the provider's 85% share covers the estimated compute cost. Manual and Muse bids may differ within provider policy and buyer budget, but must meet that same cost floor. The old configurable 20% target markup is no longer used for new business. Each binding bid freezes the exact gross, 15% Broker share and 85% provider share in integer micro-USD; readiness copies the snapshot into exactly one demo invoice. This preserves the exact split even for sub-cent fees. Historical accepted quotes and invoices remain unchanged; absent historical commission records are explicitly labeled legacy rather than retroactively charged.

New approvals, offerings, requests and bids still require a rate retrieved within 15 minutes, with at most 60 seconds of future clock skew. Historical quotes remain readable. The upstream full-term estimate is separate from the customer's fixed quote and provider share; none is settled Wick usage. Managed rates already include Wick's price. BYOK is unsupported. Suppliers are demo allocations backed by Wick, not independent provider firms. Providers can review gross, Broker commission and their net share on the paginated Earnings screen; totals cover the displayed commission records only.

Use the separate `scripts/configure-real.ts` command to review and explicitly approve selected real configurations for existing supplier accounts. It preserves passwords, sessions, reservations, and frozen quotes; do not rerun account seeding to change pricing. See [real Wick operation](docs/REAL_WICK.md) for setup and isolated scale-run commands.

Read [Wick contract evidence](docs/WICK_CONTRACT.md) and [Muse contract evidence](docs/MUSE.md) before enabling real modes. Public documentation and offline contract tests do not verify live allocations or live terminal behavior. Real catalog entries require administrator approval. Missing required rate or compute fields fails closed; optional upstream catalog version, currency, money unit, revision, and mode are not invented or required.

## Deploy shape

Deploy the review branch as **one always-on Railway app and PostgreSQL**. The Dockerfile builds Node 24 without runtime credentials and includes production migration/seed/setup commands. [Railway configuration](.railway/railway.ts) declares the branch, database reference, migration hook, readiness check and one replica. Follow the [Railway deployment guide](docs/RAILWAY.md) for service variables, first-time accounts and real Wick setup.

Migrations run separately before deployment and remain advisory-locked at startup. Active VM leases survive brief process overlap during redeploys; SIGTERM drains jobs. Account seeding is an explicit first-time action and never runs on a normal deployment.

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
