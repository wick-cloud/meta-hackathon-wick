# Full-stack local development

For the judge-facing browser demo, use the [README quickstart](../README.md#run-locally). It needs no database or credentials. The setup below runs the actual Broker server with PostgreSQL and simulated provider/model adapters; it is a separate developer workflow.

Run all commands from the repository root. Keep an existing `.env` if it contains your configuration; copy the example only for a new setup.

## Setup

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

These full-stack fixture modes exercise server and database behavior. They do not implement the hosted Wick platform or prove real provider availability. The core platform and its shared-file infrastructure live in a separate private repository.

## Frontend-only demo checks

```sh
npx playwright install --with-deps chromium
npm run test:demo
```

The demo test command starts its own frontend server. It does not need this guide's database, accounts, or `.env` setup. See [interactive demo behavior](interactive-demo.md).

## Verification

```sh
npm run typecheck
npm test
npm run build
npm run test:browser
```

Set `TEST_DATABASE_URL` to a dedicated test database for PostgreSQL concurrency/auth tests; these use disposable schemas. Browser tests require the seeded fixture application at `E2E_BASE_URL` (default `http://localhost:3000`) and seed credentials. Install Chromium once using `npx playwright install --with-deps chromium`.

For an additional local process-restart check, stop the preview and run `npm run test:recovery`. It requires a built, seeded fixture app and loopback database, manages one app process at a time, and stops it when finished. Restart the preview with `npm start` afterward.

CI explicitly selects fixture adapters and never allocates real compute or uses paid APIs. See [testing notes](testing.md) and [HANDOFF.md](../HANDOFF.md) for checks actually run and remaining limits.

Run `npm run security:secrets` after building to scan Git history, current source, release archives, and built assets. Read the [security policy](../SECURITY.md), [scanner coverage](security-scanning.md), and [contribution guide](../CONTRIBUTING.md) before publishing changes. Current source and newly built packages use [MIT](../LICENSE); historical client archives retain their original metadata.
