# Wick Broker v1

A single-process environment marketplace: describe an environment, review an immutable specification, run a 30-second provider auction, and open the winning VM's browser terminal. Customers can run their own commands or explicitly authorize a bounded public-repository coding job in Muse Studio.

**Muse Studio:** start a public-repository task with one [total budget](docs/studio-task-budgets.md). Studio purchases model allowance, asks Meta to select compute and completion checks, runs the VM auction, confirms guest execution, verifies the patch, and cleans up. No manual VM/grant selection or token-limit control is required. The existing [coding worker](docs/public-repo-coding.md), wallet, marketplaces, history and recovery remain in this one app/database. Local Linux execution is verified with fixture model decisions; automatic-task native provider and live-model qualification remain separate checks. Missing guest isolation fails closed.

The permanent **Orders** hub retains every auction and funded scheduled agreement. Seven-day agreements reserve Broker pilot credit and future capacity; customers manually start VMs inside accepted windows. See [Orders and funded agreements](docs/orders-and-agreements.md) for the UI, funding model, API and real-provider enforcement boundary.

**Developer access:** buyers and providers can create separate Broker API keys in **API keys**, then use the [TypeScript SDK, CLI and local MCP server](docs/developer-access.md). The same account, orders, funding and capacity rules apply. Broker keys are independent of Wick service credentials.

**Agent purchasing:** the [buying workspace](docs/agent-buying.md) adds owner-reviewed Muse recommendations, optional automatic refills, purchase comparison receipts, and provider selling windows. It uses the existing app, database, wallet and worker. New agent grants default to two hours; buying never extends their deadline.

**Agent tokens:** the [prepaid inference marketplace](docs/inference-marketplace.md) adds owner-funded agent budgets, grant-bound API keys, 30-second token auctions, instant quotes and a buffered Meta Muse gateway in this same app/database. Modal and Baseten inference are separate from VM providers. It defaults off; unqualified real routes cannot sell token packs. SDK/CLI/MCP `0.3.0` includes the inference interfaces and [four-decimal USD prices](docs/money.md), alongside immutable earlier client downloads.

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

- Buyers review catalog, region, minimum resources, exact 15/30/60-minute duration, and maximum total USD price before starting an auction. Default duration is 30 minutes. An explicitly reviewed cross-provider request can compare compatible offerings; exact-route requests retain their selected configuration.
- Providers manage configured capacity, private pricing policy, manual/automatic bidding, approved-configuration offerings, and activity in the same application. Real operator-managed provider accounts are bound to their own upstream cloud; changing a pricing policy cannot widen that identity.
- Manual and auto bids share a locked capacity reservation path. The lowest total price wins; equal prices use accepted timestamp, then ID. Losing holds release at close. The winner's hold remains until confirmed cleanup.
- The request specification, awarded offering revision, quote, and create idempotency key are frozen. Retries cannot silently start another auction or extend the rental clock.
- For instant rentals, exactly one fixed-price demo invoice is issued after Wick confirms both running state and terminal capability. Failed, cancelled, or expired-before-ready instant environments incur no charge. Early termination after readiness retains the fixed price. Scheduled capacity is settled separately against reserved Broker pilot credit, including booked idle slots; a scheduled VM never receives an additional instant-rental invoice. There is no external payment collection or payout.
- The returned Wick admission expiry is authoritative and includes setup time. Reconnecting attaches to the same environment. Disconnecting leaves the rental running; process survival is not guaranteed.
- Muse Spark Open on Baseten provides bounded, reviewed proposals for requirements, supplier policy, bids, alternatives, offerings and scheduled agreement drafts. Manual controls remain available after a visible model failure. Drafts create no bookings, credit reservations or VMs.
- Admins approve existing catalog configurations, adjust the default 20-VM admission limit, and retry unresolved cleanup reconciliation. No generated setup code or preparation jobs exist.

Configured provider allocations and customer demo quotes are distinct from Wick's actual operational costs. A configured slot is an operator allocation, not a measurement or guarantee of upstream free capacity.

## Real integrations

Configure real modes and server-only credentials in `.env` or Railway variables. Real Wick uses the exact published `@wick-cloud/sdk@0.1.0-rc.0`, with an API base, organization ID, group ID, and service credential. The official SDK manages scoped terminal authentication and renewal. No upstream credential or scoped token reaches the browser. Terminal output goes only to the authenticated owning browser and is not logged or sent to Muse. The existing four-provider scale baseline used Muse fixture mode. Real Muse inference is a separate integration and does not change that historical evidence.

Real Muse uses **Muse Spark Open · Baseten**, with the exact hackathon model **`meta-models/muse-spark-open-1026`**. Set server-only `MUSE_MODE=real` and `BASETEN_API_KEY`; `META_API_BASE` defaults to `https://inference.baseten.co/v1`. `META_API_KEY` remains a legacy alias, and a non-empty `BASETEN_API_KEY` takes precedence. The backend sends Chat Completions JSON-schema requests, includes the schema in the prompt and locally validates final `message.content` and never exposes model reasoning or credentials to the browser. Baseten accepts but does not enforce `json_schema` for Muse; local validation remains authoritative. Failed real calls remain visible and do not fall back to fixtures. Both schedule draft flows use this same real adapter; model proposals never create bookings, reserve credit or start VMs by themselves. See [Muse configuration, flows and evidence](docs/MUSE.md).

The controlled Baseten smoke passed all seven adapter flows using a synthetic catalog, with no PostgreSQL writes and no Wick/VM allocations. That verifies the inference paths for that run, not Railway deployment or native VM behavior. The optional `npx tsx scripts/verify-baseten-muse.ts --live` diagnostic makes seven real inference calls and requires a privately configured server key; ordinary CI stays fixture-only.

Broker earns a fixed **15% commission from the provider's gross rental price**. The buyer pays the accepted fixed total, with no added Broker fee. Providers retain 85% before their own compute costs. For a $10.00 rental, Broker's share is $1.50 and the provider's share is $8.50. Prices, provider policy limits and budgets are gross rental totals. There are no subscriptions, listing charges, payments or payouts in this demo.

Managed real offerings freeze the published micro-USD/second rate and retrieval time. New suggested quotes use `max(1, ceil(rate × durationSeconds / 8500))` USD cents so the provider's 85% share covers the estimated compute cost. Manual and Muse bids may differ within provider policy and buyer budget, but must meet that same cost floor. The old configurable 20% target markup is no longer used for new business. Each binding bid freezes the exact gross, 15% Broker share and 85% provider share in integer micro-USD; readiness copies the snapshot into exactly one demo invoice. This preserves the exact split even for sub-cent fees. Historical accepted quotes and invoices remain unchanged; absent historical commission records are explicitly labeled legacy rather than retroactively charged.

New approvals, offerings, requests and bids still require a rate retrieved within 15 minutes, with at most 60 seconds of future clock skew. Historical quotes remain readable. The upstream full-term estimate is separate from the customer's fixed quote and provider share; none is settled Wick usage. Managed rates already include Wick's price. BYOK is unsupported. E2B, Daytona, Baseten and Modal workspaces represent operator-managed Wick allocations, not accounts operated by those companies. The requested **Baseten** display name routes through **Blaxel**, whose actual Wick provider identifier is `provider-blaxel`; it does not assert that Baseten and Blaxel are the same service. The actual Baseten inference API used by Muse is a separate integration from this compute-account display label. Providers can review gross, Broker commission and their net share on the paginated Earnings screen; totals cover the displayed commission records only.

Use `scripts/configure-real.ts --list` to review current managed routes and `--apply-providers` to configure the four provider accounts with explicit credentials and native catalog IDs. Setup preserves existing passwords, sessions, reservations and frozen quotes; it retires explicitly selected legacy suppliers without deleting their history. Do not rerun account seeding to change pricing. See [provider marketplace setup and coverage](docs/provider-marketplace.md) and [real Wick operation](docs/REAL_WICK.md).

Read [Wick contract evidence](docs/WICK_CONTRACT.md) and [Muse contract evidence](docs/MUSE.md) before enabling real modes. Public documentation and offline contract tests do not verify live allocations or live terminal behavior. Real catalog entries require administrator approval. Missing required rate or compute fields fails closed; optional upstream catalog version, currency, money unit, revision, and mode are not invented or required.

## Deploy shape

Deploy **`main`** as **one always-on Railway app and PostgreSQL**. The Dockerfile builds Node 24 without runtime credentials and includes production migration/seed/setup commands. [Railway configuration](.railway/railway.ts) declares the branch, database reference, migration hook, readiness check and one replica. Follow the [Railway deployment guide](docs/RAILWAY.md) for service variables, first-time accounts and real Wick setup. The four provider accounts each start with five configured slots, subject to the shared 20-VM admission limit.

Migrations run separately before deployment and remain advisory-locked at startup. Active VM leases survive brief process overlap during redeploys; SIGTERM drains jobs. Account seeding and provider setup are explicit operator actions and never run on a normal deployment. Keep the permanent pre-deploy command migration-only.

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

Deferred: SSH, file browser, public port previews, snapshots, pause/resume, unbounded runtime extensions, longer standalone instant rentals, supplier setup code, and external payments. Scheduled initial leases can be longer only where an explicit independent native cutoff contract is available; existing real routes are not assumed certified.
