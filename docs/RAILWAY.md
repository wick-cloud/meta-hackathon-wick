# Deploy Wick Broker on Railway

Deploy `wick-cloud/meta-hackathon-wick`, branch **`main`**, repository root `/`. The deployment has **one always-on app service and one PostgreSQL service**. The app serves the React UI, HTTP API, authentication, terminal WebSockets and durable jobs. It needs no Redis, separate worker, or app volume. Customer VMs remain in Wick; Railway hosts Broker.

## Build and service settings

`Dockerfile` builds Node 24 client/server artifacts without database or API credentials. The final runtime contains Node and production dependencies without npm or Yarn, runs as the `node` user, and includes compiled migration, seed and real-configuration commands. Operator commands run directly with Node. Private environment files, local build output and the Railway SDK are excluded from the runtime image.

Current Railway projects can use [`.railway/railway.ts`](../.railway/railway.ts), evaluated by the official Railway SDK pinned in `devDependencies`. It declares the branch, Docker build, app and Postgres, database reference and these settings:

| Setting                  | Value                           |
| ------------------------ | ------------------------------- |
| Builder                  | Dockerfile at `Dockerfile`      |
| Pre-deploy command       | `node dist/scripts/migrate.js`  |
| Pre-deploy timeout       | 120 seconds                     |
| Start command            | `node dist/src/server/index.js` |
| Healthcheck              | `/ready`, 120-second timeout    |
| Replicas                 | 1                               |
| Sleeping                 | Disabled                        |
| Extra deployment overlap | 0 seconds                       |
| Graceful draining        | 30 seconds                      |
| Restart policy           | On failure, at most 5 retries   |

Before deploying this image to an existing service, change its pre-deploy command to `node dist/scripts/migrate.js`; the preceding image supports that command too.

The old `railway.toml` was removed because current Railway uses [Infrastructure as Code](https://docs.railway.com/infrastructure-as-code) for new services. You can also enter the settings above in the dashboard after connecting the GitHub branch; the Dockerfile builds the same image either way.

For IaC, install the [Railway CLI](https://docs.railway.com/cli#installing-the-cli) (5.42.1 or newer), run `npm ci`, and link a **dedicated project** for this app:

```sh
railway login
railway link
railway config plan
railway config apply
```

Review that the plan contains only `wick-broker` and `Postgres`. Applying the plan creates/configures cloud resources. This branch does not apply a plan or provision Railway resources by itself. Existing private variables use `preserve()` so a later apply keeps their Railway values. On a new service, set the variables below before expecting startup to succeed. Never put actual credentials in the authoring file.

For the existing hosted project, reuse its app and PostgreSQL rather than creating another pair. CLI examples below use the IaC app name `wick-broker`; select the existing `meta-hackathon-wick` service instead when operating that deployment.

## Runtime variables and public domain

Add PostgreSQL 16 or newer and wait for it to become available. Generate the app's public Railway domain using its detected listening port, then set the following app service variables. If you explicitly target port 3000 in Networking, also set `PORT=3000`; otherwise use Railway's provided port. When using a custom domain, use that exact HTTPS origin for `APP_URL`.

| Variable             | Initial value                                                            |
| -------------------- | ------------------------------------------------------------------------ |
| `NODE_ENV`           | `production`                                                             |
| `HOST`               | `0.0.0.0`                                                                |
| `DATABASE_URL`       | `${{Postgres.DATABASE_URL}}` (already referenced by IaC)                 |
| `APP_URL`            | `https://${{RAILWAY_PUBLIC_DOMAIN}}`, or the exact custom HTTPS origin   |
| `BETTER_AUTH_SECRET` | A private random value of at least 32 characters; keep it across deploys |
| `WICK_MODE`          | `fixture` for first-time account setup                                   |
| `MUSE_MODE`          | `fixture`                                                                |
| `MAX_CONCURRENT_VMS` | `20` (also the local default)                                            |

Let Railway supply `PORT`; the server honors it. Put keys only in server service variables. Keep Muse in fixture mode during initial account setup. Enable real Muse Spark Open inference using the private Baseten variables below. There is no Broker markup variable: the platform commission is fixed at 15% of provider gross rental revenue, leaving 85% before compute costs, with no added buyer fee.

## First-time invited accounts

A fresh database has no users and public signup is disabled. Set all five private seed passwords, each 12–128 characters:

```text
SEED_BUYER_PASSWORD
SEED_SUPPLIER_A_PASSWORD
SEED_SUPPLIER_B_PASSWORD
SEED_SUPPLIER_C_PASSWORD
SEED_ADMIN_PASSWORD
```

Optional `SEED_*_EMAIL` variables override the demo email addresses listed in the main README. Once the fixture app is running, select `wick-broker` in your linked CLI and run the compiled seed **once** in its container:

```sh
railway ssh --service wick-broker -- node dist/scripts/seed.js
```

The seed is never part of build, migrations, pre-deploy or startup. Re-running it resets the invited passwords and revokes their sessions, so ordinary redeploys must not run it. It refuses real Wick mode. `railway run` runs a command locally; use `railway ssh` for the private Railway database connection.

## Enable real Wick after account setup

With no outstanding fixture rental, set `WICK_MODE=real` and these server variables, then redeploy:

```text
WICK_API_KEY
WICK_ORGANIZATION_ID
WICK_GROUP_ID
```

`WICK_API_BASE` defaults to `https://app.wick-cloud.com/api`. Keep `MUSE_MODE=fixture`. Review the catalog from the running container without allocating a VM:

```sh
railway ssh --service wick-broker -- node dist/scripts/configure-real.js --list
```

The registry supports E2B, Daytona, Baseten (native Blaxel), Modal, Sail, Tenki, Freestyle, and Boat.dev. Supply private `REAL_PROVIDER_<KEY>_EMAIL` and `_CATALOG_IDS` only for the selected providers, plus `_PASSWORD` for newly created accounts. Keys are `E2B`, `DAYTONA`, `BLAXEL`, `MODAL`, `SAIL`, `TENKI`, `FREESTYLE`, and `BOAT`; catalog IDs must come from a fresh `--list`. Per-provider `_CAPACITY` overrides `REAL_PROVIDER_CAPACITY` and defaults to one slot. Staged account creation is explicit:

```sh
railway ssh --service wick-broker -- node dist/scripts/configure-real.js --apply-providers --providers sail,tenki,freestyle,boat --stage
```

An explicit subset is required (`REAL_PROVIDER_IDS` is an alternative). Staging creates missing accounts/bindings with new catalog rows unapproved, new offerings inactive, and automatic bidding disabled. Default retries preserve existing passwords, sessions, custom policies, capacity, approval/activity state, prices and frozen history. Existing passwords can be omitted and are never reset. Role or cloud-binding conflicts fail atomically. These configured slots are not measured upstream capacity; the shared global limit remains 20 VMs.

After service-credential and live lifecycle/terminal qualification, use `--apply-providers --providers <qualified-subset> --activate`. Activation preserves custom prices/capacity and fails if an existing offering is below the current floor. `--update-existing` explicitly replaces selected defaults/prices; use it only for an intended policy update. `_AUTO_BID=false` can keep automation disabled during activation. New account base/offer prices are 120% of the 30-minute cost-covered quote, rounded upward to $0.0001. One-slot accounts use base-only bidding; see [provider strategies](provider-marketplace.md).

Only set `REAL_RETIRED_SUPPLIER_EMAILS` when deliberately retiring existing unbound suppliers. Setup allocates no VMs and does not deploy the app. Never leave setup in startup or a permanent pre-deploy hook; keep `node dist/scripts/migrate.js` as the permanent command. Migration 032 expands identities and quarantines historical real Boat approvals/offerings while preserving rentals and cleanup.

Baseten remains the requested compute-account display alias for native `provider-blaxel`; the actual Baseten Muse API is separate. Native provider names are routing identities, not company-operated accounts. Real buyer allocations consume Wick credits; invoices/earnings remain demo accounting without collected payments or payouts. The [expansion record](provider-expansion-plan.md) distinguishes implemented support from deployment and live qualification.

The older `--apply` command remains for explicitly selected unbound demo suppliers through `REAL_CATALOG_IDS` and `REAL_SUPPLIER_EMAILS`; it refuses cloud-bound accounts. Use the subset-aware `--apply-providers` flow for registered provider accounts.

## Enable real Muse Spark Open on Baseten

Muse runs inside the existing Broker service; it needs no additional Railway app, worker or database. Real inference calls Baseten's hosted Chat Completions API with the fixed hackathon model **`meta-models/muse-spark-open-1026`**. Wick and Muse modes are independent: real Muse can prepare reviewed proposals while Wick remains in fixture mode.

Set the following private app-service variables, then deploy the updated application:

| Variable          | Real-mode value                                                     |
| ----------------- | ------------------------------------------------------------------- |
| `MUSE_MODE`       | `real`                                                              |
| `BASETEN_API_KEY` | Private Baseten API key; never a build argument or browser variable |
| `META_API_BASE`   | `https://inference.baseten.co/v1` (the default)                     |

`BASETEN_API_KEY` is the canonical credential. The legacy `META_API_KEY` alias is still accepted, with a non-empty canonical key taking precedence. Keep the key in Railway service variables; do not put it in `.railway/railway.ts`, the repository, a public log, `VITE_*` variables or browser storage. No extra model environment variable is needed.

The server sends a JSON schema and includes it in the prompt, then locally validates only final `message.content`. Muse accepts but does not enforce `json_schema` on Baseten, so the request is not a provider-enforcement guarantee. Separate reasoning is not shown, returned to browsers or logged. Invalid or failed real inference produces a visible error and leaves manual controls available; it never silently switches to fixture output. Proposals still require the same policy, price, schedule and consent checks before any binding action. See [Muse integration and seven-flow verification](MUSE.md) for the transport bounds, privacy rules and opt-in inference-only smoke command.

After deployment, check `/health` and `/ready`, then open **Environment mode** in the top bar. Real Muse identifies **Muse Spark Open · Baseten** and the exact model ID; fixture mode explicitly says no model calls. Exercise a reviewed proposal before applying any policy or funding an agreement. Configuration/source changes and the local synthetic smoke do not establish that Railway has deployed successfully; record that separately after verification.

## Redeploys and verification

Pre-deploy runs the compiled, advisory-locked application migrations and initializes/upgrades the pg-boss schema; failure blocks deployment. Production startup validates application migration digests and queue schema compatibility without applying schema upgrades. Non-Railway production deployments must run the same migration command before startup. `/ready` checks both database connections and worker polling, while `/health` is liveness. API and browser assets share the same origin and terminal connections use `wss://` on the public domain. Follow the [operation and recovery runbook](production-operations.md) for checksum baselining, alerting, backups, and rollback limits.

Keep PostgreSQL, the auth secret and adapter modes consistent across deploys. A brief Railway process overlap does not clear active VM leases: another process defers the lifecycle job until its lease expires. Crash recovery can wait for the remaining portion of the 90-second lease and reuses the original create key and expiry. SIGTERM drains jobs with a 25-second application shutdown bound inside Railway's 30-second draining window. Existing terminal connections may reconnect to the same rental after a deploy.

After deployment, check `/health` and `/ready`, sign in to each invited role, inspect provider policy/Earnings and confirm the 85/15 split. Run fixture buyer → auction → terminal → termination before switching to real allocations. Database migrations and redeploys must preserve accounts, accepted quotes, invoice history, reservations and cleanup state.

Official references: [Dockerfiles](https://docs.railway.com/builds/dockerfiles), [IaC](https://docs.railway.com/infrastructure-as-code), [pre-deploy commands](https://docs.railway.com/deployments/pre-deploy-command), [variables](https://docs.railway.com/variables), [deployment teardown](https://docs.railway.com/deployments/deployment-teardown), [SSH](https://docs.railway.com/cli/ssh).

## Broker client packages

The repository also contains the SDK, CLI and local MCP npm workspaces. Railway still deploys one Broker app and PostgreSQL. The Dockerfile installs only root dependencies with `--workspaces=false` and builds with `npm run build:app`; it copies the shared public API contract needed by the server. Customer credentials are issued and hashed in PostgreSQL, not configured as Wick environment variables. Ordinary deployments must not seed users or reset keys. See [developer access](developer-access.md).
