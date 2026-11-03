# Production operation and recovery

The application runs one configured replica. Request and task-preparation limits are
process-local; overlapping deploys can temporarily multiply them. Scaling beyond one
replica requires a shared rate-limit store and an independently tested ingress policy.
`AUTH_TRUST_RAILWAY_PROXY=true` is appropriate only when all public traffic passes
through the Railway HTTP edge that overwrites `X-Real-IP`. Keep it false for direct,
private, or TCP ingress. Arbitrary `X-Forwarded-For` chains are never trusted.

## Deployment and schema integrity

Run `npm run db:migrate:production` as the pre-deploy command. It applies application
migrations under an advisory lock and installs/upgrades the pg-boss schema. Production
startup validates application migration names and SHA-256 digests and starts pg-boss
without schema migrations. Missing, modified, or removed migrations fail startup.
Development and test startup retain automatic migrations for disposable databases.

The first upgrade baselines old migration rows whose digest is absent. This cannot
prove which bytes were applied before checksum tracking existed. Review the trusted
release history before that upgrade. Never edit an applied migration to repair data;
add a new migration. Deploy the same migration set and compatible queue version when
rolling back application code. An older release missing a recorded migration will
fail validation; use a reviewed forward fix or a compatible rollback artifact.

Use separate operator and runtime credentials where database permissions permit.
Startup validation removes application DDL from production startup, but pg-boss
queue creation/maintenance may still require ownership or DDL permissions. Test the
actual grants in staging before reducing them; do not claim the runtime is read-only.
Seeding rotates invited passwords and revokes sessions, so never include it in routine
deployment commands.

## Health and alerts

`/health` reports process liveness. `/ready` checks both the application and pg-boss
database connections, registered consumers, and recent idle polling. Busy consumers
have a finite allowance for the longest coding job. Responses contain no account,
queue payload, or provider details. Probes coalesce database work and return within
two seconds. Shutdown removes readiness before workers drain.

Configure external alerts for repeated readiness failures, queue errors, oldest queued
work, failed jobs, expired VMs without confirmed cleanup, exhausted cleanup retries,
and unresolved inference reservations. Readiness alone does not certify provider health
or successful business processing. Inspect the admin reconciliation views and retained
operation receipts before retrying anything with an unknown outcome. Never clear a hold
or mark an allocation deleted merely because an API call timed out.

## Backups and restoration

Before accepting production data, enable encrypted managed backups, select retention,
and record recovery-point and recovery-time objectives with the operator. Verify a
restore to a separate database and staging application. These hosting settings and
production restoration cannot be established by source-code tests.

`npm run test:restore` uses `TEST_DATABASE_URL` only to create two new disposable
loopback databases. It applies migrations, inserts fixture wallet/ledger records,
performs `pg_dump`/`pg_restore`, and verifies exact records and migration digests.
It requires PostgreSQL client tools compatible with the server. It never restores
over the provided database and removes its temporary databases/dump afterward.

For an incident:

1. Stop new purchases and preserve encrypted database backups and sanitized logs.
2. Record deployed commit/image digest and adapter modes; preserve the original
   authentication secret in the secret manager. Artifact encryption depends on it.
3. Restore to a separate database, validate migration history, and reconcile active
   upstream allocations and their original idempotency keys before enabling workers.
4. Start the matching release against staging. Verify ownership, sessions, ledgers,
   active deadlines, terminal revocation and cleanup. Restoring old data can replay
   queue intent, so inspect provider receipts before dispatching uncertain operations.
5. Switch traffic only after reconciliation and readiness checks pass. Record actual
   data loss and recovery time against the selected objectives.

If a secret was exposed, revoke/rotate it and assess sessions, scoped keys, artifacts
and backups before restoring service. Removing a file or rewriting Git history does
not revoke a credential. Authentication-secret rotation invalidates retained encrypted
artifacts; do not silently discard or relabel failures as successful recovery.

## Dependency exception lifecycle

The `@fastify/static` dependency currently receives a scoped override to `glob@14.0.2`,
which also selects a patched minimatch. Static-file serving and traversal rejection
are covered by a regression test. Remove the override when the upstream dependency
supports the patched chain directly, after rerunning the production image smoke test.
An empty package audit is useful evidence, not proof that every code path is safe.

## Release evidence

Required checks include full database tests (with no unexpected skips), browser tests,
process recovery, backup restoration, Linux guest sandbox execution, production image
smoke testing, and redacted secret scans of history/current files/archive members/built
assets. Keep the exact commit, dependency lockfile, image digest and check results.
CI uses fixture provider/model decisions; native provider behavior and live model
accounting require separate controlled qualification before enabling those features.
