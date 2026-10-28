# Wick Broker v1 handoff

Implemented on `codex/broker-v1` in `/home/user/wick-workspace/meta-hackathon-wick`. All work is local; nothing was pushed, merged, deployed, purchased, or allocated through Wick. No Wick tasks, additional VMs, private Wick source, or production data were used. The original Boat development VM remains running.

## Running preview and credentials

The built application is running on **0.0.0.0:3000** in tmux session **wick-broker**. Open **http://localhost:3000** through your local forwarding setup. `/health` and `/ready` are available. The application log is `/home/user/wick-workspace/.broker-run/preview.log`.

This VM has Node **24.22.1** at `/usr/local/bin/node` and a running native PostgreSQL **16** service. Its ignored `.env` contains generated local auth/seed secrets and database configuration. Do not overwrite it with `.env.example` on this prepared VM. The explicit seed has created:

| Role | Email | Password variable in local `.env` |
| --- | --- | --- |
| Buyer | buyer@demo.wick.local | SEED_BUYER_PASSWORD |
| Supplier A | supplier-a@demo.wick.local | SEED_SUPPLIER_A_PASSWORD |
| Supplier B | supplier-b@demo.wick.local | SEED_SUPPLIER_B_PASSWORD |
| Supplier C | supplier-c@demo.wick.local | SEED_SUPPLIER_C_PASSWORD |
| Admin | admin@demo.wick.local | SEED_ADMIN_PASSWORD |

Passwords are not included in Git or this handoff. Public signup is disabled. Rerunning `npm run db:seed` explicitly updates seed passwords and revokes existing sessions. Supplier capacities are **3, 2, 0**, visibly labeled simulated demo supply. Both adapters currently use explicit fixture mode, so no real VM or paid model call occurs.

`APP_URL` is currently `http://localhost:3000`. If using a different forwarded browser origin, set `APP_URL` to that exact origin and restart; HTTP/WS Origin checks intentionally reject other origins. Do not run Docker Compose PostgreSQL alongside the already-running native service on port 5432.

From a fresh checkout, follow [README.md](README.md): Node 24, PostgreSQL, `npm ci`, an edited `.env`, `npm run db:migrate`, explicit `npm run db:seed`, `npm run build`, then `npm start`. One app process serves UI, API, Better Auth, terminal WebSockets, and pg-boss consumers. Docker and Railway configuration deploy that same process with PostgreSQL and one always-on app replica.

## Implemented behavior

- Responsive buyer pages for description, editable review, live 30-second auction, VM list/detail/browser terminal, and demo invoices. Provider capacity, policy, requests, offerings, and activity, plus administrator configuration, live in the same app. Local Inter fonts, emerald actions, violet Muse receipts, cursor pagination, and loading/empty/error states are implemented controls, not screenshots.
- Immutable resource/region/duration/budget requests; exact catalog-supported 15/30/60-minute choices, default 30. Manual and automatic bids use the same atomic capacity-hold path. Lowest total integer-cent USD quote wins; ties use accepted timestamp and ID. Late bids are rejected even after waiting for database locks.
- Frozen offering/quote/create-input/idempotency-key snapshots. Losers release at auction close. The winner remains reserved until confirmed cleanup; termination acceptance alone does not release it. Existing holds survive policy changes. Default global customer-VM limit is two.
- One fixed demo invoice only after confirmed running state, terminal capability, and a future authoritative expiry. Browser opening is irrelevant. Failure, cancellation, or expiry before readiness has no charge; termination after readiness retains the fixed charge. Fee is zero, every invoice says **No payment due**, and no payments/payouts exist.
- Durable PostgreSQL transactions and pg-boss jobs, bounded retries, restart recovery, same-key uncertain-create reconciliation, no upstream network work inside SQL transactions, and administrator cleanup reconciliation. Rental expiry includes setup time and never extends on retry/reconnect.
- Invite-only Better Auth email/password sessions with server-enforced buyer/provider/admin roles. Terminal bridge validates Origin, ownership, session and active rental continuously, renews scoped upstream tokens, bounds shells/buffers, and closes on logout/revocation/expiry/termination. Tokens stay server-side; terminal contents are not retained.
- Real Meta `muse-wonder-1.0` structured-output adapter with deterministic validation, deadlines and bounded calls. Three uses: requirement translation, isolated supplier bid/decline proposals, and reviewed offering suggestions based on recorded unmatched demand and administrator-approved existing configurations. Fixtures identify themselves and never claim a model call happened.
- Independent real Wick REST adapter based on the public OpenAPI document and supplied contract, with typed envelope parsing and exact approved target pinning. Explicit persistent fixtures exercise the app without real compute. Adapter modes are frozen with rentals; switching modes cannot release an unresolved reservation through the wrong adapter.

The fixture terminal is explicitly simulated and never executes commands on the application VM. Customer workloads, repository inspection, tests, and agents are not run by the product.

## Checks actually run

- `npm run typecheck` — passed.
- `npm test` — **110 passed**, seven files, no skips, with the dedicated local PostgreSQL test database. Includes **26** real PostgreSQL marketplace concurrency/lifecycle tests, **5** real Better Auth tests, **40** Muse adapter/route tests, and **39** Wick contract/terminal/durable-fixture tests.
- `npm run build` — passed; production React build, locally bundled fonts, lazy terminal chunk, compiled server and explicit seed. Build forces production mode even when local `.env` selects development runtime settings.
- Six Playwright browser scenarios passed: anonymous access rejection; actual buyer login/manual review/30-second auction/running VM/WS connect/reconnect/same expiry/one invoice/termination; provider role enforcement; Muse fixture editable review; provider capacity/policy/offering controls; administrator catalog approval and VM limit controls. The final combined run passed **6/6 in 40.7 seconds at 06:44 UTC**.
- `npx tsx scripts/verify-recovery.ts` (also available as `npm run test:recovery`) — passed against the real local app/database: an open auction and then running rental survived **two graceful process restarts**. Session, create key, environment, exact expiry, readiness and invoice stayed unchanged; exactly one VM/environment/invoice existed; cleanup was confirmed and the capacity hold released. The script only runs with loopback app/database URLs and both fixture modes.
- `docker build -t wick-broker:v1 .` — passed. A temporary local production-container smoke check served `/ready` and UI, included production security headers, contained no local `.env` or TypeScript dev dependency, and stopped with exit code 0. Its container and temporary database were removed.
- Desktop and 390-pixel mobile browser captures were inspected. No horizontal overflow, browser page errors, or external browser requests were observed. Final local cleanup check found **0 active customer VMs, 0 active holds, and 0 open auctions**.
- `npm audit --omit=dev --audit-level=moderate` — zero vulnerabilities. `git diff --check` passed. Generated local passwords/auth secrets were checked against tracked files and were not present.

CI uses fixture modes and local PostgreSQL; test execution makes no paid API calls or compute allocations. Browser and runtime fixture checks exercise actual auth, SQL, queues, HTTP and WebSockets. These results do **not** verify real upstream allocations or model responses.

## Remaining limits

No real Wick allocation, authenticated upstream API call, or real Meta call was made. Wick's public OpenAPI verifies REST envelope evidence, but does not document initial WebSocket authentication transport, renewal acknowledgements, or reconnect semantics. The bridge implements the supplied frame contract and scoped Bearer transport; real terminal interoperability must be verified against official protocol documentation or an explicitly authorized live test. See [docs/WICK_CONTRACT.md](docs/WICK_CONTRACT.md) and [docs/MUSE.md](docs/MUSE.md).

The public Wick resource schema exposes no GPU field, so real GPU availability is not invented; the GPU fixture is visibly simulated. Provider capacity and customer prices remain simulated demo supply, distinct from Wick's operational cost. Administrator approval is required for real catalog configurations. Reconciliation stops after bounded attempts and retains unresolved holds for administrator review. V1 is configured for one app replica.

SSH, file browser, public port previews, snapshots, pause/resume, extensions, 2/4/8-hour rentals, generated setup code, preparation jobs, and payments remain deferred as requested.

## Retrieval

The final standalone Git bundle is `/home/user/wick-workspace/.broker-run/result.bundle` and contains all refs. The supervising session can fetch that bundle and publish `codex/broker-v1` using its existing GitHub authentication; no GitHub credential was requested or sought in this VM. Milestones are in `/home/user/wick-workspace/.broker-run/progress.log`, and the final response is saved to `/home/user/wick-workspace/.broker-run/final.md`.

Local visual captures are `/home/user/wick-workspace/.broker-run/buyer-desktop.png`, `buyer-mobile.png`, and `invoices-desktop.png`; they are inspection artifacts, not application UI assets.

Operational details: [docs/marketplace.md](docs/marketplace.md). Test commands/evidence: [docs/testing.md](docs/testing.md).
