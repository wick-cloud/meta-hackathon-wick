# Improve my sales

Sellers open **Improve my sales** from the sidebar, Capacity, or Policy. They
describe a goal, inspect up to three Meta Muse recommendations and their evidence,
then select **Review changes**. The review compares every policy setting before
the seller explicitly applies one alternative. Generating a report changes no
policy, offering, bid, hold or VM.

The first version recommends policy changes for VM sellers:

- Enable automatic bids and counteroffers when matching demand exists.
- Reduce the base price by up to 5% or 10% only when the server's comparison finds
  additional matching requests. Discounts never lower the saved price floor.
- Include other approved configurations the seller has already published when
  they match additional requests.

Every candidate preserves the saved minimum, maximum and spare-slot reserve.
Candidates do not create listings or change total capacity. No supported change,
no available capacity, or insufficient evidence produces an honest empty result.
An active sponsored Modal promotion withholds ordinary base-price advice.

## Evidence and Meta

`POST /api/provider/sales/propose` accepts `{ "goal": "..." }`, up to 1,000
characters, from an authenticated provider session at the application origin.
Broker API keys cannot call this helper. It allows one analysis in flight and five
attempts per seller per minute. The response includes the captured policy
revision, source mode, model-call status, evidence and exact candidate policies.

The server reads a consistent provider/catalog/request/bid snapshot without
mutation. It considers at most 100 approved configurations, the latest 200
completed auctions in seven days before filtering to the provider's reviewed
scope, and up to 200 of that provider's recent bids. Recent unresolved demand
uses the existing bounded, aggregate demand query. Mode and native provider
identity are enforced. Only active offerings with valid current managed rates
can contribute real-route matches.

Base-price comparisons test current settings and each candidate against the
same original request scope, resources, duration and budget, using current rates.
They do not replay historical capacity, auction timing, discounts, competing
bids, or actual wins. Disk requests and sponsored homepage demo requests are
excluded. Configured slots are not upstream telemetry. Bid outcomes do not
establish causation, and no revenue or profit forecast is produced.

Meta receives only the seller goal, projected policy, capacity, canonical
aggregate evidence and server-built candidates. Buyer identities, descriptions,
credentials, Wick organization/group identifiers and competitors' private
policies are omitted. Common secret patterns are redacted from the goal.
Meta ranks supplied candidate IDs and explains their relevance with references
to supplied evidence. It cannot generate prices or new policies. Unknown or
duplicate candidates, unrelated evidence and malformed output are rejected.
Only final content is read; model reasoning is never exposed.

The existing Muse Spark Open/Baseten configuration supplies real mode. Fixture
mode is explicitly labeled and makes no paid calls. Empty candidate sets also
make no model call. A failed real call stays visible and never becomes fixture
advice. Model calls run outside database transactions. The provider session and
policy revision are rechecked after inference.

## Applying and recovering

The review calls the existing `PUT /api/provider/policy` with the exact selected
policy, `expectedProviderId`, `expectedRevision` and a stable `operationKey`. The
locked provider identity must match the recommendation, including if another
browser tab changed the signed-in account. Existing row locks,
provider identity, reserve/capacity validation and the durable policy-apply
receipt remain authoritative. Applying a recommendation creates the normal
policy activity record; accepted bids and existing commitments retain their
terms.

An uncertain Apply keeps the exact payload and operation key and freezes the
review until the seller retries. A successful retry recovers the original result.
A revision conflict discards all stale alternatives. Success clears the report,
so another change requires fresh analysis. Recommendations are transient;
ordinary policy history and the retained latest Apply receipt provide the audit
record. There is no background seller agent or autonomous policy adjustment.

Migration `034_sales_analysis_indexes.sql` adds bounded-sample query indexes
only. No new service, dependency or secret is needed.

## Verification

- `tests/sales-analysis.test.ts`: deterministic matching and candidate boundaries.
- `tests/sales-muse.test.ts`: mocked real transport, strict final-output validation,
  privacy projection, fixture behavior and visible model failures.
- `tests/sales-db.test.ts`: disposable PostgreSQL isolation, read-only analysis,
  stale revisions and the existing idempotent policy Apply transaction.
- `tests/browser/sales.spec.ts`: mocked browser review/apply, uncertain retries,
  conflicts, errors, empty results and mobile layout.

Tests use synthetic data and do not change production seller settings.

### Verification on November 3, 2026

TypeScript, production builds and the full then-current suite passed (1,290
tests). After adding the final scenario and account-switch isolation cases, all
93 focused sales and policy checks passed against a disposable local PostgreSQL database. Eighteen
browser checks passed across the six new sales scenarios and existing provider
flows; desktop and mobile screenshots were inspected.

One bounded live Baseten call with the pinned Muse model and synthetic E2B
data returned two valid, evidence-linked price alternatives. It preserved the
supplied floor and reserve, distinguished matches from wins, and required
review. That smoke created no application records and changed no seller policy.
It verifies this model response, not production deployment or sales outcomes.
