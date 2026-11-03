# Architecture

Wick Broker runs one Node 24 process with Fastify, Better Auth, pg-boss, and a
same-origin WebSocket terminal bridge. React/Vite serves the browser UI, and
PostgreSQL stores identity, marketplace state, accounting, jobs, and recovery
records. The deployment uses one application replica; changing that topology
requires qualification of worker leases, admission limits, and in-memory guards.

## Application boundaries

- `src/server/app.ts`, `config.ts`, `auth.ts`, and `context.ts` compose the server,
  validate explicit runtime modes, and resolve the authenticated actor.
- `marketplace/`, `orders.ts`, and `agreements/` implement capacity, auctions,
  immutable quotes, order history, and retained legacy agreement settlement.
- `inference/` implements prepaid grants, token purchases, reservations, and the
  bounded inference gateway. Accepted usage is settled through the same ledger.
- `coding/` and `scripts/coding-guest.py` implement bounded public-repository jobs
  and Studio tasks. Untrusted repository code runs in an isolated customer VM,
  outside the Broker host. Missing isolation fails the job closed.
- `disks/` owns buyer disk state and file access. `demo/` owns the separately
  bounded, operator-sponsored public demonstration.
- `integrations/` holds Wick, Muse, terminal, and drive adapters. Fixture modes
  are explicit; a failed real call never silently falls back to a fixture.
- `packages/sdk`, `packages/cli`, and `packages/mcp` expose customer developer
  access. `client-releases/` contains immutable historical distribution artifacts.

See the [generated API contract](src/server/openapi.ts) and feature documentation
for current routes and schemas. [Public coding jobs](docs/public-repo-coding.md)
and Studio owner-session routes have separate authority from developer/agent keys.

## Identity and data access

Actors have buyer, provider, or administrator roles. Session and scoped-key
authentication resolve server-side actor identity; request bodies cannot select
another account's authority. Resource reads and mutations must validate ownership,
role, and scope. Provider identity is bound to its approved upstream route.
Browser terminal connections verify the owner, allowed origin, VM state, and
lease; provider credentials and upstream terminal tokens stay on the server.

Better Auth supplies invited email/password accounts with public signup disabled.
Account seeding is an explicit operator action. It is not part of normal startup
or deployment and must not be used to change provider pricing.

## Money and durability

Public `*Cents` fields retain cent units and support hundredths of a cent
($0.0001). PostgreSQL precision checks and integer hundredth-cent arithmetic
protect monetary operations. Commission accounting retains integer micro-USD
for the exact 15% Broker / 85% provider split. See [money](docs/money.md).

Persist idempotency intent before upstream effects. Domain updates and queue
enqueue use the same database transaction; external network calls stay outside
SQL transactions. Locks, holds, fenced leases, and unique constraints protect
concurrent work. An uncertain provider response retains its reservation until
reconciliation confirms the outcome; workers must not blindly replay it.

The default global admission limit is 20 VMs, separately bounded by configured
provider capacity and runtime policy. This is an operator limit, not a promise
of upstream availability. Leases, budget deadlines, and accepted prices remain
authoritative across restart. Cleanup releases capacity only after confirmation.

## Deployment and verification

The Docker image builds without deployment credentials and runs as a non-root
user. Migrations precede deployment; startup recovery resumes persisted work.
SIGTERM drains jobs. Runtime secrets come from deployment variables, and fixture
CI does not allocate paid infrastructure.

Type checking, tests, build verification, dependency/static analysis, and secret
scanning provide release evidence. Native provider qualification, backup restore,
and deployment behavior require their separate documented checks. Historical
verification reports describe the exact versions and operations tested and do
not certify newer source. See [security policy](SECURITY.md),
[testing](docs/testing.md), and [deployment](docs/RAILWAY.md).
