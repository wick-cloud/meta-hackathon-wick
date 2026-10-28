# Wick integration contract and verification

The adapter is independently implemented from the public API schema and the requested integration contract. No private Wick source, SDK internals, credentials, production records, or implementation artifacts were used. CI tests use synthetic values and local PostgreSQL; they never allocate real environments.

## Evidence inspected

On 2026-10-28, an unauthenticated, read-only GET of <https://app.wick-cloud.com/api/openapi.json> returned the public Wick OpenAPI 3.0.3 document, API version 0.1.0. Focused schemas and the retrieved document's SHA-256 are retained in [wick-public-schema-excerpts.json](wick-public-schema-excerpts.json). These are published schemas, not evidence of a successful real allocation.

| Operation | Published response / implementation |
| --- | --- |
| `GET /v1/catalog?organizationId=…` | `{profiles,offers}`; profiles identify CPU/memory and offer metadata identifies provider/profile/region, availability, capabilities, and maximum TTL. |
| `GET /v1/organizations/{id}/providers` | `{data,nextCursor?}`; bounded to five pages of 200. Organization-private offers require a published `providerKeyId` to enter the broker catalog. |
| `POST /v1/environments/preview` | Ordinary create body; `{eligible,blockers,requiredReservationMicros,fallbackProviders,…}`. No allocation is performed by preview. |
| `POST /v1/environments` | Required `Idempotency-Key`; HTTP 202 `{environment,operation,replayed?}`. The normalized adapter result keeps the complete envelope in `raw`. |
| `GET /v1/environments/{id}` | Direct `CustomerEnvironment`; lifecycle status and returned `expiresAt` are authoritative. Missing expiry remains null. |
| `GET /v1/environments/{id}/connections` | `{provider,terminal,ssh}`. Only the explicit terminal boolean can satisfy terminal availability. |
| `POST /v1/environments/{id}/sessions` | HTTP 201 `{session:{environmentId,expiresAt,…},token,terminalWebsocketUrl?,…}`. Expiry is nested inside `session`, and scope must match the server-owned environment ID. |
| `POST /v1/environments/{id}/terminate` | HTTP 202 mutation envelope. Acceptance does not prove cleanup; caller must poll the environment. |

The published create schema accepts integer `ttlSeconds` from 60 through 86400. Together with each offer's `maxTtlSeconds`, this supports an exact bounded TTL mapping: the broker offers only 900, 1800, and 3600 seconds that are no greater than the published offer maximum. All real catalog entries start unapproved. There is no conversion from a fixed quote into hourly charging.

The only create fields sent are `organizationId`, `groupId`, `name`, `provider`, `profile`, optional `region` and `providerKeyId`, `ttlSeconds`, and `visibility:'private'`. Region and an available organization provider key are frozen with the selected catalog configuration and pinned in create. The adapter enumerates these fields, so accidental extra `repository`, `agent`, `setup`, task, or secret properties cannot reach Wick. Snapshot fields are excluded from v1.

The public resource schema has CPU, memory MiB, and disk MiB; it contains no GPU resource field. The adapter does not claim GPU availability in real catalog entries. The GPU demo offering is explicitly simulated. Real API responses and catalog failures never fall back to fixture values.

## Terminal boundary

The browser connects only to the application's same-origin `/api/vms/:id/terminal`. Before upgrading, the server validates the exact configured Origin, current Better Auth buyer session, owner-scoped VM row, running lifecycle state, and future authoritative expiry. It repeats session/ownership/rental validation every two seconds and installs a timer for the exact expiry. Revocation, logout, termination, expiry, or an upstream failure closes the bridge. Disconnect alone does not terminate a rental or promise shell-process survival.

The bridge accepts only bounded JSON `input`, `resize`, `ack`, and `ping` frames. Browser endpoints, environment identifiers, tokens, and reauthentication frames are discarded or rejected. Output is forwarded as validated base64; ready, exit, error, and pong frames are narrowed before they reach the browser. Error text from the upstream is not forwarded. There are at most two simultaneous shells per VM and 64 across the application process, 32 KiB client frames, 256 KiB buffers, a 150-frame-per-second input bound, and a 12-second upstream handshake deadline.

Only a short-lived environment session token is used for the upstream WebSocket. The service API key never reaches a browser or terminal socket. The server connects to the session's returned `terminalWebsocketUrl` with the scoped token as a Bearer header. Renewal happens by 240 seconds, or 30 seconds before the returned expiry if sooner, and sends `{type:'reauth',token}` to the established upstream socket. URLs/tokens, customer input/output, and transcripts are not logged; connect/disconnect audit messages contain VM ID, mode, and reason only.

**Remaining public-contract gap:** OpenAPI describes the session and terminal URL, but it does not publish the WebSocket frame protocol, initial authentication transport, token renewal acknowledgement behavior, or shell reconnect semantics. The frame shapes and reauth behavior are implemented from the supplied task contract. The returned URL is used verbatim (it may already contain scoped authorization), with the scoped Bearer header added. This transport must be checked against an official terminal protocol reference or an explicitly authorized real integration test before claiming real terminal interoperability. No paid allocation or authenticated upstream API call was made during this build.

## Failure and recovery behavior

REST calls have a 12-second deadline, a 1 MiB response limit, and reject redirects. The adapter does not retry automatically: the durable marketplace worker supplies the persisted create key for reconciliation. Network errors, timeouts, HTTP 401/403/409/429, and server errors remain uncertain. Only create HTTP 400/422 are classified as admission rejection; no error response body or service key is exposed. Unsupported lifecycle states are rejected rather than interpreted as readiness or cleanup.

The caller must only charge after real `running` status, explicit terminal capability, and a future returned expiry. Cleanup release must wait for a confirmed terminal lifecycle state. A successful terminate request alone cannot release a supplier hold.

## Explicit fixture mode

`WICK_MODE=fixture` requires PostgreSQL and never calls Wick. `broker_fixture_environments` durably stores the create key, input hash, admission time, fixed expiry, readiness time, and termination progress. Simultaneous retries share one allocation and cannot reset its clock; reused keys with changed inputs fail. Admission includes simulated setup time. Termination first becomes `terminating`, then becomes confirmed `terminated` on a later read.

The fixture terminal is an in-memory line editor with a short list of visibly simulated responses. It never starts a shell, process, agent, workload, or customer command on the application VM. Its current input line is discarded on disconnect. All catalog descriptions and the terminal banner identify simulated demo supply.

## Checks

`npm exec vitest run tests/wick-contract.test.ts tests/wick-terminal.test.ts tests/wick-fixture-db.test.ts`

The contract tests cover published envelope shape, nested session expiry, environment scoping, finite duration mapping, Bearer auth, exact idempotency-key forwarding, removal of workload fields, response errors, and no fixture fallback. Local WebSocket tests cover cross-origin and cross-owner rejection, inactive rentals, explicit simulation, logout/revocation, concurrent shell bounds, and exact expiry. PostgreSQL tests exercise twelve concurrent creates with one key, restart-safe expiry, input-hash mismatch rejection, asynchronous cleanup, and expiry before readiness. PostgreSQL tests run when `TEST_DATABASE_URL` is supplied; they use unique keys and remove only their own fixture rows.
