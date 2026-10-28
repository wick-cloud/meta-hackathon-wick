# Wick integration contract and verification

The real adapter uses the exact published npm package `@wick-cloud/sdk@0.1.0-rc.0` through `import { Wick } from "@wick-cloud/sdk"`. Its public README, types, and distributed JavaScript establish the wire contract. No private Wick source was accessed or copied. Offline tests use synthetic responses and isolated local PostgreSQL; they never allocate real environments.

## Evidence inspected

On 2026-10-28, an unauthenticated, read-only GET of <https://app.wick-cloud.com/api/openapi.json> returned the public Wick OpenAPI 3.0.3 document, API version 0.1.0. Focused schemas and the retrieved document's SHA-256 are retained in [wick-public-schema-excerpts.json](wick-public-schema-excerpts.json). These are published schemas, not evidence of a successful real allocation.

| Operation | Published response / implementation |
| --- | --- |
| `GET /v1/catalog?organizationId=…` | `{profiles,offers}`; profiles identify CPU/memory and offer metadata identifies provider/profile/region, availability, capabilities, and maximum TTL. |
| Managed catalog selection | Available managed offers retain `rateMicrosPerSecond`, a local retrieval timestamp, provenance, and exact offering resources. BYOK/provider-key offers are unsupported and excluded. |
| `POST /v1/environments/preview` | Ordinary create body; `{eligible,blockers,requiredReservationMicros,fallbackProviders,…}`. No allocation is performed by preview. |
| `POST /v1/execution-preview` | Read-only SDK `executionPreview.create({body:{kind:'environment',input}})` verifies exact organization/group and selected E2B provider/profile/region, `wick_managed`, no provider key, no external compute, and no fallback. Catalog BYOK capability alone is not a billing-route decision. |
| `POST /v1/environments` | Required `Idempotency-Key`; HTTP 202 `{environment,operation,replayed?}`. The normalized adapter result keeps the complete envelope in `raw`. |
| `GET /v1/environments/{id}` | Direct `CustomerEnvironment`; lifecycle status and returned `expiresAt` are authoritative. Missing expiry remains null; an environment ID differing from the requested ID is rejected. |
| `GET /v1/environments/{id}/connections` | `{provider,terminal,ssh}`. Only the explicit terminal boolean can satisfy terminal availability. |
| `POST /v1/environments/{id}/sessions` | HTTP 201 `{session:{environmentId,expiresAt,…},token,terminalWebsocketUrl?,…}`. Expiry is nested inside `session`, and scope must match the server-owned environment ID. |
| `POST /v1/environments/{id}/terminate` | HTTP 202 mutation envelope. Acceptance does not prove cleanup; caller must poll the environment. |

The published create schema accepts integer `ttlSeconds` from 60 through 86400. Together with each offer's `maxTtlSeconds`, this supports an exact bounded TTL mapping: the broker offers only 900, 1800, and 3600 seconds that are no greater than the published offer maximum. All real catalog entries start unapproved. There is no conversion from a fixed quote into hourly charging.

The only create fields sent are `organizationId`, `groupId`, `name`, `provider`, `profile`, optional `region`, `ttlSeconds`, `maximumPriceMicrosPerSecond`, and `visibility:'private'`. Provider, profile, region, organization, group, and maximum published rate are frozen and pinned in preview/create. A server-side price increase cannot silently increase the maximum accepted rate. The adapter enumerates these fields, so accidental extra `repository`, `agent`, `setup`, task, or secret properties cannot reach Wick. Snapshot fields are excluded from v1.

The authenticated customer catalog can omit version, provider revision, currency, money unit, and mode; none is required or invented. The published rate is interpreted as micro-USD per second under the managed contract. The public resource schema has CPU, memory MiB, and disk MiB; it contains no GPU resource field. The adapter does not claim GPU availability in real catalog entries. The GPU demo offering is explicitly simulated. Real API responses and catalog failures never fall back to fixture values.

Boat customer allocations are excluded by user choice. Current real catalogs expose only verified E2B routes; the reviewed scale default is Micro/us. A permitted read-only SDK execution preview confirmed that route selects managed billing. This evidence does not demonstrate a successful allocation or a 20-VM run. The actual returned environment must independently pass billing and ownership checks before invoicing.

## Terminal boundary

The browser connects only to the application's same-origin `/api/vms/:id/terminal`. Before upgrading, the server validates the exact configured Origin, current Better Auth buyer session, owner-scoped VM row, running lifecycle state, and future authoritative expiry. It repeats session/ownership/rental validation every two seconds and installs a timer for the exact expiry. The frozen rental integration mode must also match the active adapter. Revocation, logout, termination, expiry, or an upstream failure closes the bridge; peers that ignore close frames are forcefully disconnected after two seconds, including during application shutdown. Disconnect alone does not terminate a rental or promise shell-process survival.

The bridge accepts only bounded JSON `input`, `resize`, `ack`, and `ping` frames. Browser endpoints, environment identifiers, tokens, and reauthentication frames are discarded or rejected. Output is forwarded as validated base64; ready, exit, error, and pong frames are narrowed before they reach the browser. Error text from the upstream is not forwarded. There are at most two simultaneous shells per VM and 64 across the application process, 32 KiB client frames, 256 KiB buffers, a 150-frame-per-second input bound plus a separate 2000-acknowledgement-per-second allowance, and a 12-second upstream handshake deadline.

The official SDK creates and validates scoped terminal sessions, sends the initial `{type:'auth',token,cols,rows}` frame, and renews every 120 seconds. The SDK async iterator returns decoded `Uint8Array` output; the common adapter forwards it as browser-compatible base64 and passes bounded input, resize, acknowledgement, and close operations back to the SDK. The browser keeps its existing protocol. The service credential is used only for HTTPS API calls and never appears in browser or terminal frames. HTTP redirects and WebSocket redirects are disabled. No manual Bearer-only terminal handshake remains.

Fixture and real terminals share a small typed adapter. The bridge preserves ownership, exact Origin, current authentication, rental expiry, output budgets, and acknowledgement flow control. Output, input, session tokens, and transcripts are not logged. Tests execute the installed official SDK against synthetic fetch and WebSocket responses, including scoped authentication, renewal, decoded output, and sanitization. This is offline evidence; real terminal interoperability and 20 simultaneous VMs still require the separately authorized live run.

## Failure and recovery behavior

REST calls have a 12-second deadline, a 1 MiB response limit, and reject redirects. The adapter does not retry automatically: the durable marketplace worker supplies the persisted create key for reconciliation. Network errors, timeouts, HTTP 401/403/409/429, and server errors remain uncertain. Only create HTTP 400/422 are classified as admission rejection; no error response body or service key is exposed. Unsupported lifecycle states are rejected rather than interpreted as readiness or cleanup. Provisioning observations keep the earliest authoritative expiry and cannot extend the clock. A cancellation before the first admission attempt avoids an upstream create entirely. Frozen rental modes prevent a real allocation from being reconciled through the fixture adapter after a configuration change.

The caller must only charge after exact owned environment identity, real `running` status, explicit terminal capability, finite future returned expiry, and verified `wick_managed` billing without a provider key. Unexpected billing is quarantined; foreign scope is never bound or terminated. Cleanup never replays create: bounded read-only exact-name/scope/time discovery retains missing receipts as UNKNOWN and does not release holds. Cleanup release must wait for a confirmed terminal lifecycle state. A successful terminate request alone cannot release a supplier hold.

## Explicit fixture mode

`WICK_MODE=fixture` requires PostgreSQL and never calls Wick. `broker_fixture_environments` durably stores the create key, input hash, admission time, fixed expiry, readiness time, and termination progress. Simultaneous retries share one allocation and cannot reset its clock; reused keys with changed inputs fail. Admission includes simulated setup time. Termination first becomes `terminating`, then becomes confirmed `terminated` on a later read.

The fixture terminal is an in-memory line editor with a short list of visibly simulated responses. It never starts a shell, process, agent, workload, or customer command on the application VM. Its current input line is discarded on disconnect. All catalog descriptions and the terminal banner identify simulated demo supply.

## Checks

`npx vitest run tests/wick-contract.test.ts tests/wick-terminal.test.ts tests/wick-sdk-terminal.test.ts tests/wick-fixture-db.test.ts`

The contract tests cover published envelope shape, nested session expiry, environment scoping, finite duration mapping, service REST authentication, official terminal auth/renewal frames, exact idempotency-key forwarding, removal of workload fields, response errors, and no fixture fallback. Local WebSocket tests cover cross-origin and cross-owner rejection, inactive rentals, explicit simulation, logout/revocation, concurrent shell bounds, and exact expiry. PostgreSQL tests exercise twelve concurrent creates with one key, restart-safe expiry, input-hash mismatch rejection, asynchronous cleanup, and expiry before readiness. PostgreSQL tests run when `TEST_DATABASE_URL` is supplied; they use unique keys and remove only their own fixture rows.
