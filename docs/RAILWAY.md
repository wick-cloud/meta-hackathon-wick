# Deploy Wick Broker on Railway

Deploy `wick-cloud/meta-hackathon-wick`, branch **`codex/broker-real-wick`**, repository root `/`. The deployment has **one always-on app service and one PostgreSQL service**. The app serves the React UI, HTTP API, authentication, terminal WebSockets and durable jobs. It needs no Redis, separate worker, or app volume. Customer VMs remain in Wick; Railway hosts Broker.

## Build and service settings

`Dockerfile` builds Node 24 client/server artifacts without database or API credentials. The runtime installs production dependencies only, runs as the `node` user, and includes compiled migration, seed and real-configuration commands. Private environment files, local build output and the Railway SDK are excluded from the runtime image.

Current Railway projects can use [`.railway/railway.ts`](../.railway/railway.ts), evaluated by the official Railway SDK pinned in `devDependencies`. It declares the branch, Docker build, app and Postgres, database reference and these settings:

| Setting                  | Value                           |
| ------------------------ | ------------------------------- |
| Builder                  | Dockerfile at `Dockerfile`      |
| Pre-deploy command       | `npm run db:migrate:production` |
| Pre-deploy timeout       | 120 seconds                     |
| Start command            | `node dist/src/server/index.js` |
| Healthcheck              | `/ready`, 120-second timeout    |
| Replicas                 | 1                               |
| Sleeping                 | Disabled                        |
| Extra deployment overlap | 0 seconds                       |
| Graceful draining        | 30 seconds                      |
| Restart policy           | On failure, at most 5 retries   |

The old `railway.toml` was removed because current Railway uses [Infrastructure as Code](https://docs.railway.com/infrastructure-as-code) for new services. You can also enter the settings above in the dashboard after connecting the GitHub branch; the Dockerfile builds the same image either way.

For IaC, install the [Railway CLI](https://docs.railway.com/guides/cli) (5.42.1 or newer), run `npm ci`, and link a **dedicated project** for this app:

```sh
railway login
railway link
railway config plan
railway config apply
```

Review that the plan contains only `wick-broker` and `Postgres`. Applying the plan creates/configures cloud resources. This branch does not apply a plan or provision Railway resources by itself. Existing private variables use `preserve()` so a later apply keeps their Railway values. On a new service, set the variables below before expecting startup to succeed. Never put actual credentials in the authoring file.

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
| `MAX_CONCURRENT_VMS` | `2` initially, up to `20` when explicitly needed                         |

Let Railway supply `PORT`; the server honors it. Put keys only in server service variables. Muse stays in fixture mode until real Meta access is configured deliberately. There is no Broker markup variable: the platform commission is fixed at 15% of provider gross rental revenue, leaving 85% before compute costs, with no added buyer fee.

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
railway ssh --service wick-broker -- npm run seed:production
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
railway ssh --service wick-broker -- npm run configure:real:production -- --list
```

Set `REAL_CATALOG_IDS` to the explicit supported configurations you approve, `REAL_SUPPLIER_EMAILS` to existing provider account emails, and optionally `REAL_SUPPLIER_CAPACITY` / `REAL_SUPPLIER_AUTO_BID`. Apply the reviewed setup:

```sh
railway ssh --service wick-broker -- npm run configure:real:production -- --apply
```

This updates selected catalog approvals and offerings without resetting accounts or creating VMs. Use E2B for the current integration; Boat is excluded from customer integration. See [real Wick operations](REAL_WICK.md) for managed-route checks and rate freshness. An actual buyer allocation consumes Wick credits. Customer invoices and provider earnings remain demo records; payments and payouts are not collected.

## Redeploys and verification

Pre-deploy runs the compiled, advisory-locked migrations; failure blocks deployment. Startup also checks migrations, preserving normal non-Railway operation. `/ready` responds after database/queue startup, while `/health` is liveness. API and browser assets share the same origin and terminal connections use `wss://` on the public domain.

Keep PostgreSQL, the auth secret and adapter modes consistent across deploys. A brief Railway process overlap does not clear active VM leases: another process defers the lifecycle job until its lease expires. Crash recovery can wait for the remaining portion of the 90-second lease and reuses the original create key and expiry. SIGTERM drains jobs with a 25-second application shutdown bound inside Railway's 30-second draining window. Existing terminal connections may reconnect to the same rental after a deploy.

After deployment, check `/health` and `/ready`, sign in to each invited role, inspect provider policy/Earnings and confirm the 85/15 split. Run fixture buyer → auction → terminal → termination before switching to real allocations. Database migrations and redeploys must preserve accounts, accepted quotes, invoice history, reservations and cleanup state.

Official references: [Dockerfiles](https://docs.railway.com/builds/dockerfiles), [IaC](https://docs.railway.com/infrastructure-as-code), [pre-deploy commands](https://docs.railway.com/deployments/pre-deploy-command), [variables](https://docs.railway.com/variables), [deployment teardown](https://docs.railway.com/deployments/deployment-teardown), [SSH](https://docs.railway.com/cli/ssh).
