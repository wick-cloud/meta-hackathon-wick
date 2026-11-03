# Provider accounts and cross-provider matching

Broker's registry supports **eight native Wick providers**: E2B, Daytona, Blaxel (displayed as Baseten), Modal, Sail, Tenki, Freestyle, and Boat.dev. As of November 2, 2026, all **eight configurations advertised across Sail, Tenki, Freestyle, and Boat.dev** passed live qualification and are enabled. Each of these four accounts now has **10 shared slots**, within the broker's existing global limit of 20. Boat Large passed a bounded retry after its first terminal attempt failed. See the [capacity receipt](verification/provider-capacity-10-2026-11-02.md), [all-sizes receipt](verification/provider-all-sizes-2026-11-02.md), [initial qualification receipt](verification/provider-live-qualification-2026-11-02.md), and [implementation and rollout record](provider-expansion-plan.md). These results do not change the original providers' historical qualification scope.

The workspaces are operator-managed allocations using Wick's managed routes, not accounts operated by the named companies. Configured slots do not measure upstream free capacity. Customer VMs are created through Wick; Broker remains one Railway app with PostgreSQL.

| Account display | Immutable Wick provider ID | Environment key | Documented configurations | Native region |
| --------------- | -------------------------- | --------------- | ------------------------: | ------------- |
| E2B             | `e2b`                      | `E2B`           |                         3 | `us`          |
| Daytona         | `daytona`                  | `DAYTONA`       |                         3 | `us`          |
| Baseten         | `provider-blaxel`          | `BLAXEL`        |                         2 | `us-pdx-1`    |
| Modal           | `modal`                    | `MODAL`         |                         4 | `auto`        |
| Sail            | `sail`                     | `SAIL`          |                         3 | `auto`        |
| Tenki           | `provider-tenki`           | `TENKI`         |                         1 | `auto`        |
| Freestyle       | `provider-freestyle`       | `FREESTYLE`     |                         1 | `auto`        |
| Boat.dev        | `boat`                     | `BOAT`          |                         3 | `auto`        |

Counts for the original four come from the October 28 baseline; additions were observed November 2. Always use a fresh catalog listing for setup. Boat Small advertises 3,814 MiB RAM, not 4 GiB; missing profiles are not synthesized.

**Baseten is the retained display alias for the Blaxel account.** Its native ID remains `provider-blaxel`; this does not make Blaxel and Baseten the same company or connect this compute route to the Baseten API. Muse inference separately uses the actual Baseten service.

## Incremental account setup

Deploy with the migration-only pre-deploy command. On a fresh database, bootstrap the original invited buyer/admin roles in fixture mode once as described in [Railway setup](RAILWAY.md). Do not reseed an existing app. Outstanding fixture rentals must complete cleanup before changing the app's Wick mode.

Use server-side `WICK_MODE=real` and the reviewed managed Wick credential/scope. Keep Muse fixtures for setup if live model decisions are not being tested. Review fresh eligible routes from the app container:

```sh
npm run configure:real:production -- --list
```

Supply private variables for **only the selected providers**:

```text
REAL_PROVIDER_<KEY>_EMAIL
REAL_PROVIDER_<KEY>_PASSWORD
REAL_PROVIDER_<KEY>_CATALOG_IDS
```

New-account passwords must contain 12–128 characters. Existing accounts need no password on retries; supplying another password never resets one. Catalog IDs are explicit comma-separated selections from the fresh listing, belonging to the selected native provider.

`REAL_PROVIDER_<KEY>_CAPACITY` overrides `REAL_PROVIDER_CAPACITY`; the default is **one slot**. `REAL_PROVIDER_<KEY>_AUTO_BID` defaults to `true` for explicit activation, but newly staged accounts always have automatic bidding disabled. `MAX_CONCURRENT_VMS` remains capped at 20. Set `REAL_RETIRED_SUPPLIER_EMAILS` only to explicitly retire existing unbound legacy suppliers; it is not needed for adding the new four.

Stage the additions with their own credentials and selected catalogs:

```sh
npm run configure:real:production -- --apply-providers --providers sail,tenki,freestyle,boat --stage
```

`--providers` accepts native IDs or environment keys, case-insensitively. `REAL_PROVIDER_IDS` is an alternative comma-separated selection. A subset is required; omitting it does not reconfigure all eight accounts. `--stage` is the default. New catalog rows are unapproved, new offerings inactive, and new accounts' automatic bidding off. Ordinary retries preserve existing custom policy, capacity, renamed offerings, prices, approval state, credentials, sessions, reservations, and frozen history. Staging is not a command to pause an already active account.

After qualification, activate only the reviewed provider/configuration subset:

```sh
npm run configure:real:production -- --apply-providers --providers sail --activate
```

Activation refreshes selected catalog/pricing evidence, approves those routes, activates the selected setup offering, and applies the selected automatic-bidding setting. It preserves custom capacity, base price, and offering price. If an existing offering is below the current cost floor, activation fails atomically. `--update-existing` is the separate explicit option for replacing selected accounts' default capacity/policy and selected offering prices; combine it with `--activate` only when those changes and activation are intended. Ambiguous multiple customized offerings require the provider console. A conflicting role/cloud binding fails without repurposing the account.

Setup allocates no VM and collects no payment. Keep it out of startup and permanent pre-deploy hooks. Migration 032 admits the new identities and quarantines historical real Boat approvals plus ordinary/scheduled offerings; old history and cleanup remain intact.

## Provider prices and automatic bids

The managed cost-covered floor is `max(1, ceil(rateMicrosPerSecond × durationSeconds / 8500))` cents. New bound accounts start with base and offering prices **20% above the 30-minute cost-covered quote**, rounded upward to $0.0001. With several selected routes, the provider base uses the lowest selected baseline. Minimum policy price starts at one cent; every actual real bid must also meet the route's duration-specific cost floor. Existing custom policies are unchanged by ordinary setup retries.

Automatic bids use the higher of the saved base and current required floor. The last available slot stays at base. When more than one slot is free and at least half of unreserved capacity is available, the server may offer up to 10% off, bounded by the floor. Muse decides whether to use that discount; declining it leaves the exact base price if it fits buyer/provider limits. With no discount candidate, base bids need no model call. An unaffordable base is not lowered to the buyer's budget. Model errors remain errors. Capacity, price, eligibility, and auction deadlines are checked before a binding hold. New one-slot accounts therefore begin with base-only bidding after activation.

Broker deducts **15% of provider gross revenue**, leaving **85% before compute costs**, with no extra buyer fee. The default provider margin is a selling-policy choice, not another Broker fee or a change to the managed rate. Invoices and earnings remain demo records marked **No payment due**; payments and payouts are not implemented.

## Buyer matching and availability

Buyers review minimum CPU/memory, GPU requirements, exact 15/30/60-minute duration, maximum gross total, and location before the 30-second auction. Cross-provider matching requires explicit review. Native `us`, `us-pdx-1`, and `auto` remain distinct; choose the available-region option to compare them. Discovery and frozen cross-provider books are bounded at 32 routes, with four concurrent read-only Wick previews; excess routes fail explicitly.

Providers can only bid active, approved offerings belonging to their immutable cloud binding. Policy edits cannot broaden that identity. The winning native provider/profile/region/resources/pricing are frozen. Exact-route requests and historical snapshots retain their original semantics. Configured capacity and the global 20-VM cap remain separate; holds persist until their normal release or confirmed cleanup. Studio qualification remains a separate allowlist.

## Coverage and historical evidence

Offline coverage includes [SDK contracts](../tests/wick-contract.test.ts), [provider setup and preservation](../tests/provider-setup-db.test.ts), [identity boundaries](../tests/provider-identity-routes.test.ts), [cross-provider matching](../tests/cross-provider-auction.test.ts), [discount/base decisions](../tests/base-bidding.test.ts), and [fractional memory](../tests/fractional-memory-db.test.ts). Database suites require a dedicated `TEST_DATABASE_URL`; skipped suites are not passing database evidence.

The October 28 read-only check observed twelve routes across the original four providers. The [four-provider live record](live-four-provider-scale-results.md) later reported 20 compute VMs and 15 maintained E2B/Daytona/Modal terminals, with full four-provider terminal overlap failing and Blaxel listings paused. The [earlier E2B scale result](live-scale-results.md) has its own scope. None qualifies the four new providers.

November 2 catalog and user-scoped doctor checks established advertised capabilities and admission eligibility. The [production staging receipt](verification/provider-expansion-2026-11-02.md), [initial live receipt](verification/provider-live-qualification-2026-11-02.md), and [all-sizes receipt](verification/provider-all-sizes-2026-11-02.md) separately record setup, actual provisioning, strict Broker PTY and explicit SDK renewal proofs, invoices, confirmed cleanup, and activation. All eight advertised configurations across the additions are enabled; Boat Large's successful retry does not erase its first terminal failure or establish that failure's cause. Full-duration expiry, larger capacity, and eight-provider concurrent scale remain outside these results.
