# Marketplace and rental semantics

Wick Broker sells an interactive environment for a fixed duration. It never executes customer workloads. The customer types commands through the terminal after Wick confirms readiness. Supplier capacity, supplier prices, and invoices are simulated demo marketplace data, including when Wick itself is configured to use its real API. Real Wick operating costs are separate from these customer demo quotes. Every invoice says **No payment due**.

## Auctions and reservations

A request freezes its description, exact approved catalog configuration, resource requirements, region, duration, and maximum total USD cents. PostgreSQL prevents mutation of that specification. Supported durations are 15, 30, and 60 minutes, and the catalog must explicitly support the selected duration. A request opens a 30-second auction.

Manual bids and automatic Muse proposals share `submitBid`. This function locks the request and provider, validates the current policy and offering, and reserves one supplier slot in the same transaction as the bid. Accepted time is captured once in SQL after potentially blocking locks; a bid cannot cross the deadline while waiting for capacity. A provider can submit one binding bid per request. Reducing capacity, changing policy, or deactivating an offering does not invalidate an existing reservation.

The closing transaction sorts eligible bids by total cents, accepted timestamp, then bid UUID. It releases losing reservations, freezes the winning quote and accepted offering revision, records a VM with its permanent Wick create key, and enqueues provisioning in the same transaction. A global advisory lock enforces the concurrent VM limit; unresolved cleanup still counts against that limit. The default is two, configurable by environment until an administrator saves an override.

No offers, cancellation, and confirmed provisioning failure end an attempt. The customer must explicitly start another auction. A retry creates a new immutable request rather than reopening the prior one.

## Admission, readiness, and invoices

Provisioning sends only the persisted ordinary Wick create input with its persisted idempotency key. It never generates a replacement key after an uncertain response. No upstream network operation runs inside a SQL transaction.

Wick's returned `expiresAt` is authoritative and includes setup time. The broker never extends it during retries or reconnection; an earlier observed upstream expiry shortens it. Missing expiry prevents readiness and billing. Missing upstream admission time stays unknown rather than being fabricated.

Readiness requires both confirmed `running` state and available terminal capability before expiry. The readiness transaction changes state, inserts exactly one invoice under a unique VM constraint, and schedules cleanup. Opening the browser terminal is not required for billing. Cancelling, failing, or expiring before readiness creates no invoice. Terminating after readiness leaves the original fixed invoice unchanged; there is no prorating or extra fee.

## Provider commission and earnings

Broker takes 15% of the provider's gross rental revenue. The provider retains 85% before compute costs. The buyer's accepted fixed total includes the commission; there is no added Broker buyer fee. Price floors, base prices, ceilings and budgets are gross totals.

The shared pricing owner calculates the exact split using integer micro-USD. New bids freeze it when accepted; counteroffers freeze it on explicit buyer acceptance. Awarding and readiness copy that snapshot instead of recomputing it. Exactly one invoice records gross and split in the readiness transaction. Unsuccessful pre-ready attempts record no earnings. Early termination retains the fixed invoice. Historical accepted records without a split remain legacy and are never assigned retrospective commission.

Provider Earnings reads only the authenticated provider's invoices with indexed keyset pagination. Summaries cover loaded records with an explicit commission snapshot, and legacy records are counted separately. Earnings are demo accounting records, not payouts or profit. Upstream compute cost remains separate.

## Cleanup and recovery

A termination response is only acceptance. Supplier capacity is released after observing Wick `terminated`, after an owned failed launch explicitly reports `launch.state: failed`, `launch.cleanup: complete` and a valid past `terminatedAt`, or after a definitive initial create rejection before admission. A failed status alone never proves cleanup. Persistent disks must independently confirm that the environment is no longer attached. Cancelling before the first create attempt allocates nothing. If any create attempt was uncertain, cleanup reconciles that same key before terminating the discovered environment.

Provisioning and cleanup each have a maximum of 60 durable attempts, with bounded delays and upstream timeouts. Unresolved cleanup retains the reservation and appears in administrator configuration. The administrator can explicitly retry reconciliation. Startup restores work for open auctions and unresolved VMs without changing their key or expiry. Queue inserts and related domain changes use one PostgreSQL transaction.

This service is deployed as one application instance. Startup preserves active lifecycle leases during deployment overlap. A competing worker retries after the remaining 90-second lease; expired leases are recovered with the existing create key. PostgreSQL locks and uniqueness constraints still protect duplicate job delivery.

## Explicit adapter modes

Catalog rows record their source adapter mode. Requests and VMs freeze that mode in `catalog_snapshot.sourceMode`. Fixture configurations cannot enter a real auction, and workers cannot confirm readiness or cleanup with an adapter from another mode. Switching Wick mode while any prior-mode rental awaits cleanup is rejected at startup; restart in the original mode and confirm cleanup first.

Catalog refresh marks disappeared configurations unapproved. New real configurations require administrator approval. Approval changes never rewrite existing request snapshots. Fixtures are explicitly selected; API failures do not turn into fixture success.

Supplier proposal activity stores only a bounded decision receipt (`observed`, `decision`, `constraints`), selected integration mode, and whether a model call actually occurred. It stores no hidden model reasoning or terminal contents. Manual proposal calls are limited to ten per supplier per minute; manual bidding remains available when Muse fails.

## API pagination

List endpoints return `{ items, nextCursor? }` with a maximum page size of 100. Cursors are opaque base64url encodings of the exact PostgreSQL timestamp and identifier. Tuple comparisons preserve records sharing a timestamp, including sub-millisecond precision. Buyer resources are always selected with the authenticated buyer ID; supplier policy and activity are scoped to the authenticated supplier.
