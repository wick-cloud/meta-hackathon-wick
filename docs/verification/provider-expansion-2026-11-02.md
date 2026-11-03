# Provider expansion and staged account verification — 2026-11-02

On November 2, 2026, the operator requested a PR adding Sail, Tenki, Freestyle, and Boat.dev, accounts for each, and base-price bids when a provider declines an optional discount. This record separates the implementation checks from the production account operation.

## Production account operation

At approximately **10:01 p.m. America/New_York**, four accounts were created in the existing Railway Broker database using the new explicit subset setup in **stage** mode. Migration `032_provider_expansion.sql` was applied to admit the new native identities and quarantine historical Boat approvals. No application deployment or PR merge was performed by this operation.

| Account   | Native provider      | Initial catalog ID              | Slots | Saved base total (30-minute reference) | State  |
| --------- | -------------------- | ------------------------------- | ----: | -------------------------------------: | ------ |
| Sail      | `sail`               | `sail:micro:auto`               |     1 |                                $0.0360 | Paused |
| Tenki     | `provider-tenki`     | `provider-tenki:micro:auto`     |     1 |                                $0.0600 | Paused |
| Freestyle | `provider-freestyle` | `provider-freestyle:small:auto` |     1 |                                $0.1080 | Paused |
| Boat.dev  | `boat`               | `boat:small:auto`               |     1 |                                $0.0240 | Paused |

For all four accounts, `autoBid=false`, active offerings were zero, and selected catalog approvals were zero. No legacy suppliers were retired. Existing provider identity, policy and capacity records and existing credential records were compared before and after setup and were unchanged. Account passwords were generated privately, are stored outside the repository, and are omitted from this report.

All four accounts subsequently returned HTTP 200 from the deployed sign-in endpoint with the provider role and a linked provider ID. Verification sessions were signed out. This proves account access, not native sandbox operation.

Before setup, the expanded adapter used the deployed Broker's own Wick service credential and configured organization/group to retrieve and verify **20 managed routes**, including all eight profile/region routes across the four additions. These bounded SDK execution previews required exact route identity, managed billing, no provider key, no external compute, and no fallback. They allocated no VMs. The initial selected routes were refreshed again by setup.

## Implemented bidding behavior

The effective base total is the higher of the saved provider base, policy minimum, and current managed compute floor after the fixed 15% provider-paid commission. The last available slot bids base. When more than one slot is free and at least half the unreserved capacity remains, the server can calculate an optional discount of up to 10%, bounded by the floor.

Muse may accept that discount or decline it. A declined discount results in the unchanged effective base when it is within buyer and provider limits. No discount candidate means a direct base bid without a model call. Model failures remain visible errors. Automatic submissions recheck the current allowable base/discount under the provider lock, so changed base prices or capacity cannot bind stale discounted proposals. Manual pricing retains its existing policy bounds.

New account defaults use a base 20% above the 30-minute cost-covered quote; existing providers' custom settings are preserved. This is a provider pricing default, not another Broker fee. The one-slot accounts start with base-only bidding once activated. Every request still uses its actual duration and current cost floor, so the saved base is not a promise of the same total for every rental length.

## Verification

- Typecheck and SDK/CLI/MCP package builds passed.
- The complete unit/database suite passed: **68 files, 1,057 tests**, using a dedicated local PostgreSQL test database. No database suites were skipped for missing `TEST_DATABASE_URL`.
- Production client and server builds passed using isolated verification output.
- Database coverage includes eight-provider auction participation and native Boat winner snapshots; 32-route acceptance/33-route rejection; incremental account staging/activation and retry preservation; Boat approval quarantine; fractional memory; model-declined discounts; and price/capacity changes between proposal and automatic submission.
- The first full browser run exposed an existing explicit-budget parser bug: sentence-ending periods in `$0.05.` and `$10.00.` discarded the stated amount. The narrow punctuation fix preserves rejection of excess decimal precision. Its 25 new parser cases and the affected Muse suites passed (128 focused tests).
- The final full browser run passed **161 tests**, with one inference end-to-end scenario skipped because this harness does not enable that separate integration. It used fresh fixture accounts and a dedicated local database; no native compute or real model calls were made.

The temporary setup bundle was removed from the app container, the temporary Railway SSH registration was revoked, and its local key files were deleted after account verification.

No paid native VM, live PTY, native cleanup, or real Muse inference test was run during this staging operation. The offerings were paused at its completion. PR #42 subsequently deployed, and all four initial configurations passed live qualification and were activated at 10:48:44 p.m. Eastern; see the separate [live qualification and activation receipt](provider-live-qualification-2026-11-02.md). Historical four-provider scale results retain their original scope. Existing rentals and their cleanup were not changed by staging.
