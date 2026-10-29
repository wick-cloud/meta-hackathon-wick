# Orders and funded scheduled agreements

Broker remains one Fastify/React application with PostgreSQL and pg-boss. Ordinary instant auctions still close after 30 seconds and create at most one VM. Scheduled agreements never execute workloads and never automatically start VMs.

## Orders and navigation

Buyers land on `/orders`. The server reads historical auctions directly from their existing records and merges them with agreements. A row remains discoverable after success, failure, cancellation and cleanup. Auction results and VM state are separate; existing `/requests/:id` URLs remain valid. Every auction, agreement and VM has return navigation. Retry creates an editable draft and requires a new explicit auction submission.

Type, status, date and cursor filters live in the URL. The default page is 25 rows, maximum 100, newest first. Cursor timestamps retain PostgreSQL microseconds, with source kind and UUID as tie breakers. The client keys rows by `kind:id` and preserves server order. Source filters apply before pagination; bid counts, selected windows and running counts are enriched in bounded batches. Agreement activation child requests do not appear as extra instant auctions. Hidden tabs pause polling.

## Funded agreements

An order selects seven consecutive local dates within a 30-day forecast, an IANA timezone, required region/resources, target and minimum quantities, discounted hours and optional normal-rate continuation. Provider region and schedule timezone are separate fields. Ambiguous or missing daylight-saving boundary times require a new reviewed choice.

Initial approval requires the minimum in **every** window and the full maximum credit reservation in the same database transaction. Global and provider capacity calendars include the whole authorized interval, including normal-rate continuation. Quotes freeze prices, resource scope and dates. Provider edits affect unbooked supply; booked rights remain binding. Additional quantities can match only before their windows start and within remaining funded allowance.

At illustrative rates of $0.10/VM-hour discounted and $0.20 normally, 20 target slots for seven days with six discounted hours plus two normal hours require a $140 maximum reservation. With 12 approved slots, $84 is committed and $56 remains reserved for additional matches. A $200 wallet has $60 available elsewhere. These figures are examples, not currently published Singapore inventory or quotes.

Booked idle capacity is payable. Window settlement debits the booked amount once, applies confirmed failed-start adjustments, and releases the corresponding credit hold. Unused matching allowance returns after cancellation or term-expiry reconciliation. Cleanup uncertainty retains the relevant resource/funding fences. Provider revenue share is exactly 15% Broker / 85% provider before compute costs, calculated on net charged capacity, never on unused reserves. No fee is added to the buyer.

Broker credit is a separate append-only pilot ledger, funded by authenticated administrator grants. It is not Wick compute credit and does not collect card payments or perform supplier payouts. Wick's configured organization must still have upstream compute funding at activation. Instant invoices and scheduled capacity charges are separately labeled in buyer billing and provider earnings.

## Manual activation and deadlines

Agreement approval and window opening allocate zero environments. The customer explicitly selects a quantity and confirms **Start VMs**. Server checks ownership, integration mode, funding, the current window, free approved slots, actual provider occupancy, global occupancy and current route eligibility. Starting/unknown/cleanup-pending allocations retain their slots. A repeated operation key cannot create duplicate environments.

New real starts refresh one native catalog snapshot outside the admission transaction, after ownership/window checks; existing action replays skip that read. Accepted buyer prices remain frozen. A known provider admission failure records an undelivered-slot receipt and idempotent settlement adjustment before returning the error. A later ready activation of that slot removes its pending adjustment. Unavailable catalog reads return a sanitized error without creating an environment or changing booked credit.

Each scheduled VM receives the original window's absolute `hardEndAt`, rather than a new full lease based on the customer's click time. If normal-rate continuation was prebooked, one initial lease spans both accepted price periods; the VM is not renewed at the discount boundary. Without continuation it ends at the discount cutoff. Reconnecting does not reset either deadline. A subsequent window uses a fresh VM; automatic snapshots or workspace retention are not included.

**Real activation is gated.** A route must explicitly attest `deadlineEnforcement: native`, support the whole requested lease, and return the exact cap receipt with an expiry no later than it. Missing metadata, stale pricing, a higher upstream price than the frozen ceiling, or resource/scope drift prevents activation. A private Wick contract change adds the immutable cap and lifecycle fences, but this public repository contains no private Wick source. Existing live routes are not certified by ordinary terminal or relative-TTL tests. Until independent native enforcement is verified and deployed, the full scheduled lifecycle can be explored in clearly labeled fixture mode; ordinary real instant rentals retain their existing behavior.

## Interfaces

- `GET /api/orders`: unified read-only history with `kind`, `status`, `created`, `limit`, `cursor`.
- `POST /api/agreements`, `GET /api/agreements/:id`: reviewed agreement and funding/booking detail.
- `POST /api/agreements/:id/activate`, `/cancel-unmatched`: explicit idempotent customer actions.
- `GET /api/credits`, `/api/credits/history`; `POST /api/admin/credits`: buyer wallet, ledger and admin pilot grants.
- `/api/provider/scheduled-offerings`: owner-scoped publication and revision-safe pause/resume; `/api/provider/commitments` and `/agreement-demand`: calendar and eligible demand.
- `GET /api/agreement-charges`, `/api/provider/agreement-charges`: settled booked blocks and credit adjustments, without synthetic VM invoices.
- Scheduled draft routes are nonbinding. Real Muse uses the configured Meta adapter; fixture drafts report `modelCalled: false`.

## Local verification

Use a dedicated disposable PostgreSQL URL, explicit `WICK_MODE=fixture` / `MUSE_MODE=fixture`, and private seeded credentials. No test needs live provider credentials.

```sh
TEST_DATABASE_URL=postgresql://... npm test
npm run typecheck
npm run build
```

`tests/browser/orders-agreements.spec.ts` uses intercepted API fixtures for UI states and performs no allocations. The additional `funded-agreements-e2e.spec.ts` is opt-in with `RUN_FUNDED_AGREEMENT_E2E=1`, requires localhost and explicit fixture/fixture health, and exercises actual auth/PostgreSQL, a full 30-second auction, credit funding, provider publication, all-seven-window approval, actual-clock manual activation, fixture terminal and confirmed cleanup. Keep its seed passwords in the environment. No interception or database clock edit is used in that flow.

SQL tests cover credit and capacity concurrency, uncertain cleanup, immutable pricing, DST, replay, separate settlement and large-history query plans. Live native cutoff certification is a separate diagnostic and is not implied by these fixture results.

Verified locally on October 29, 2026:

- All 452 tests in 32 Vitest files passed with disposable PostgreSQL, including 10,000-order history and indexed overlap-plan checks.
- All 18 intercepted Orders/agreement UI tests and all six existing auth/PostgreSQL browser flows passed, with no browser-test skips.
- The opt-in full fixture journey passed: a real 30-second auction, seven funded windows, two manual scheduled starts, fixture terminal connection and confirmed cleanup of all three test environments. No real provider allocations were made.
- Typecheck, the complete client/server production build, Prettier, local documentation links and diff checks passed.
