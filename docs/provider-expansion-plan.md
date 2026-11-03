# Provider expansion: implementation and rollout

Status: **deployed, live qualified, and enabled for all eight advertised configurations on 2026-11-02 (America/New_York)**. PR #42 deployed as `3286db792cd17d80e746ab609aec145d2e32c181`. The four initial configurations were enabled at **10:48:44 p.m. Eastern**; Sail/Boat Medium and Large followed at **11:17:29 p.m. Eastern**. Each provider's shared capacity was raised to **10 slots at 11:22:53 p.m. Eastern**; the global broker limit remains 20. Boat Large passed a bounded retry after its first terminal attempt failed. See the [capacity receipt](verification/provider-capacity-10-2026-11-02.md), [all-sizes qualification and activation receipt](verification/provider-all-sizes-2026-11-02.md), [initial live receipt](verification/provider-live-qualification-2026-11-02.md), and [production staging receipt](verification/provider-expansion-2026-11-02.md).

The existing Wick adapter now admits **Sail, Tenki, Freestyle, and Boat.dev**, alongside E2B, Daytona, Modal, and `provider-blaxel` (displayed as Baseten). The registry contains eight identities. Support does not imply that every provider is approved or operational at all times.

## Selected providers

The live Wick organization catalog and managed catalog advertised all four as available with `interactive-terminal`, `exec`, `files`, `native-ttl`, and a maximum TTL of 3,600 seconds. The prices below are observed Wick catalog rates, not Broker customer quotes or guaranteed future rates.

| Rollout order | Provider                      | Native Wick ID       | Observed profiles    | First configuration                     | Observed USD/hour for first configuration | Reason to add                                                   |
| ------------- | ----------------------------- | -------------------- | -------------------- | --------------------------------------- | ----------------------------------------: | --------------------------------------------------------------- |
| 1             | Sail                          | `sail`               | Micro, Medium, Large | Micro: 1 CPU, 2 GiB RAM, 8 GiB disk     |                                   $0.0432 | Low entry rate and a path to larger workloads.                  |
| 2             | Tenki                         | `provider-tenki`     | Micro                | Micro: 1 CPU, 1 GiB RAM, 5 GiB disk     |                                   $0.0684 | A smaller-memory option for lightweight jobs.                   |
| 3             | Freestyle                     | `provider-freestyle` | Small                | Small: 2 CPU, 4 GiB RAM, 16 GiB disk    |                                   $0.1368 | A 2-CPU development option with 16 GiB of advertised disk.      |
| 4             | [Boat.dev](https://boat.dev/) | `boat`               | Small, Medium, Large | Small: 2 CPU, 3,814 MiB RAM, 8 GiB disk |                                   $0.0180 | Low-cost 2-CPU entry configuration with larger sizes available. |

Every listed configuration uses native region `auto`. Preserve that value; do not equate it with `us`. Match actual Wick resource metadata: Tenki Micro has 1 GiB RAM; Boat Small/Medium/Large advertise 3,814/7,629/15,258 MiB RAM. Do not round Boat Small up to 4 GiB when evaluating a buyer's minimum memory, or substitute Boat's public marketing specifications for Wick's offered resources. Do not manufacture missing sizes such as Sail Small or Boat Micro.

## Evidence and remaining qualification

Read-only checks used Wick CLI **0.1.7**, the signed-in user's **harsha-test** organization, and the **WICK-BROKER** group on November 2, 2026, around 9:35–9:39 p.m. Eastern. The commands were:

```sh
wick --organization harsha-test --json catalog
wick --organization harsha-test --json catalog --global
wick --organization harsha-test --group WICK-BROKER --json doctor --vm --provider sail --profile micro --ttl 15m
wick --organization harsha-test --group WICK-BROKER --json doctor --vm --provider tenki --profile micro --ttl 15m
wick --organization harsha-test --group WICK-BROKER --json doctor --vm --provider freestyle --profile small --ttl 15m
wick --organization harsha-test --group WICK-BROKER --json doctor --vm --provider boat --profile small --ttl 15m
```

All four doctor checks returned `ready=true`, `admission.eligible=true`, no blockers, and no fallback providers. Selected native IDs were respectively `sail`, `provider-tenki`, `provider-freestyle`, and `boat`. Boat's managed catalog and Small admission were checked again at approximately 9:39 p.m. Eastern after the requested substitution. The CLI catalog shortens provider IDs for display; use the native IDs in Broker bindings and SDK calls.

These initial checks established catalog availability and 15-minute admission eligibility under that user and group. It does **not** establish production service-key permissions, the complete Broker managed-billing contract, actual VM creation, PTY behavior, or cleanup. At the time of this research, the checkout used fixture Wick without a real service key. Before activation, repeat exact-route SDK previews with the deployed Broker credential and configured organization/group, checking `billingMode=wick_managed`, no provider key, `externalCompute=false`, no fallback, exact provider/profile/region, and the frozen maximum price. Qualify each offered duration, including 30 and 60 minutes. No credits were reserved and no VM was allocated during this research.

The subsequent [production staging receipt](verification/provider-expansion-2026-11-02.md) records fresh production-service-credential discovery/previews for twenty routes, including the eight new configurations. That verification and account staging did not allocate a VM or test a terminal.

Other options reviewed:

- **Runloop:** currently `available=false`; do not treat registered support as enablement.
- **Vercel Sandbox:** available, but its current Wick route has a 120-second maximum TTL, below Broker's 15-minute minimum. This is a Wick route observation, not a claim about Vercel's general product limits.
- **Declaw:** available and passed the earlier Small admission check; replaced by Boat.dev at the user's request.
- **Agent37 and Docker Sandboxes:** also advertised as available. They are reserves rather than part of this four-provider batch; no admission checks were performed for them here. Agent37 advertises Wick-managed TTL rather than the native TTL advertised by the selected four.

## Implemented changes

### Shared provider identity and Boat quarantine

[The shared registry](../src/shared/providers.ts) owns native IDs, display names and setup environment keys. Discovery/create, provider identity validation, account setup, client display names, agreement matching, and catalog/negotiation filters use the registry. Unknown and BYOK routes remain excluded. The Baseten display alias remains attached only to native `provider-blaxel`.

[Migration 032](../migrations/032_provider_expansion.sql) expands `broker_providers.cloud_provider`. It also removes approval from existing real Boat catalog rows and deactivates their ordinary and scheduled offerings. This prevents old hidden approvals becoming saleable when Boat is admitted. Historical bids, rentals, invoices, holds and cleanup are preserved. Existing provider accounts are not rebound.

### Bounded discovery and matching

The additions advertised eight configurations; with the original twelve documented routes the combined book can reach twenty. Both `MAX_MANAGED_ROUTES` and `MAX_MATCH_CATALOGS` are now **32**, with four concurrent read-only previews. The limit-plus-one matching query still rejects overflow without truncation. Tests cover 32-route acceptance and 33-route rejection.

Exact region/resource/duration checks, managed billing, rate freshness, frozen bids and terminal requirements remain in force. Boat Small retains 3,814 MiB, so it cannot satisfy a 4-GiB minimum. Missing sizes are not synthesized. The separate global admission limit stays at **20 VMs**. Studio's 16-ID approved-compute list still requires its own guest execution/isolation qualification.

### Incremental staged onboarding

The setup command requires a provider subset and uses only those providers' private credentials and selected catalog IDs:

```sh
npm run configure:real:production -- --apply-providers --providers sail,tenki,freestyle,boat --stage
```

New catalog entries are unapproved, new offerings inactive, and automatic bids disabled. Passwords are required for new accounts only and never reset on retries. Existing custom capacity, policy, prices, renamed offerings, approval/activity state, sessions and financial history are preserved by default. The per-provider `_CAPACITY` variables are set to one for this rollout; they override any existing shared `REAL_PROVIDER_CAPACITY=5` value. Scope the initial catalogs to Sail/Tenki Micro and Freestyle/Boat Small.

After qualification, `--activate` enables the selected routes/offerings and automatic-bidding setting while preserving custom prices/capacity. `--update-existing` is required to intentionally replace selected account defaults or offering prices. Activation fails atomically when an existing offering price is below the current floor. Staging is not a pause operation for existing active accounts. See [the complete setup interface](provider-marketplace.md).

### Base bidding and optional discounts

New bound accounts use a one-cent policy minimum, with the route-specific cost floor enforced at every real bid. Base and offering prices start at **120% of the 30-minute cost-covered quote**, rounded upward to $0.0001. The provider base uses the lowest selected baseline when several configurations are supplied. Existing custom policies are preserved.

Automatic bids use the higher of saved base and required floor. With more than one free slot and at least half of unreserved capacity available, the server can offer up to 10% off without crossing the floor. Muse chooses that discount or declines it. Declining keeps the exact base if it fits the buyer budget/provider maximum; no model call is needed when there is no discount candidate. The last free slot stays at base, so the new one-slot accounts initially use base-only bidding after activation. Model errors remain errors and unaffordable base prices are not trimmed to budget. Current strategy, capacity, rate and deadline are rechecked before a binding automatic bid. Manual bids retain their reviewed-price controls.

The provider margin does not add a buyer fee or change Broker's **15% gross commission**. Frozen quotes retain their original financial terms.

## Verification scope

Relevant coverage includes:

- `wick-contract` / `wick-discovery`: native IDs, exact route preview/create, terminal/billing rejection, finite durations, absent profiles, 32/33-route boundaries.
- `marketplace-concurrency`: old Boat approval/offer quarantine with preserved historical records; unknown/BYOK filters.
- `fractional-memory-db` / matching: exact Boat fractional GiB and rejection of an unmet 4-GiB requirement.
- `provider-setup-options` / `provider-setup-db`: explicit subset, staged defaults, activation/update separation, preserved custom/auth state, and atomic failures. The focused onboarding run passed **12 tests** using a dedicated local PostgreSQL database.
- `provider-identity-routes` / `cross-provider-auction`: eight identities, cloud ownership, exact regions/resources and frozen winning route.
- `base-bidding` / `real-pricing-db`: bounded discounts, declined-discount base fallback, exact money, cost/budget limits, and submission rechecks.

The full unit/database run passed **1,057 tests**, and typecheck and build passed. Browser verification is recorded separately in the [verification receipt](verification/provider-expansion-2026-11-02.md). Database suites require a dedicated `TEST_DATABASE_URL`; skipped suites are not passing evidence. Offline fixtures and synthetic model responses do not prove live Wick provisioning or live Muse decisions. The original four-provider scale reports retain their exact historical scope.

## Rollout and qualification record

Steps 1–6 below were completed for the four initial configurations on November 2, 2026. The [initial live receipt](verification/provider-live-qualification-2026-11-02.md) records those results. The subsequent [all-sizes receipt](verification/provider-all-sizes-2026-11-02.md) completes qualification and activation of all eight configurations advertised across Sail, Tenki, Freestyle, and Boat, including the preserved Boat Large first failure and successful retry. The [capacity receipt](verification/provider-capacity-10-2026-11-02.md) records the later requested increase to ten shared slots each. Future profiles, full-duration expiry, and increased concurrent load require their own qualification. The checklist below retains the rollout sequence and its constraints.

1. **Completed:** the four accounts were created staged with one slot each, automatic bidding off, no active offerings and no approved new catalogs. Existing account policy/capacity and credential fingerprints were unchanged; no suppliers were retired. All four new logins returned HTTP 200 with the provider role and were signed out after verification. Initial 30-minute base totals are Sail **$0.0360**, Tenki **$0.0600**, Freestyle **$0.1080**, and Boat **$0.0240**. See the [production receipt](verification/provider-expansion-2026-11-02.md). This did not deploy or merge the branch or activate inventory.
2. Review/deploy the implementation with migration-only startup/pre-deploy handling. Migration 032 preserves active cleanup and quarantines old Boat saleable state. Retain the existing shared 20-VM limit.
3. Fresh production-service-credential catalog previews have passed for twenty routes. Recheck them on the deployed revision before activation, including every duration offered; catalog previews do not replace live lifecycle/terminal qualification.
4. `scripts/hosted-scale.ts` has a strict `provider-canary` mode for the four exact initial configurations, `provider-size-canary` for each reviewed Sail/Boat Medium or Large pair, and `provider-size-retry-canary` for one Boat Large retry. Each mode bounds attempts, freezes manual effective-base bids with automatic bidding off, restores temporary listings, and uses an independent cleanup watchdog. Its original 20-VM modes retain their scope. The older `scripts/live-scale.ts` still explicitly rejects Boat and was not used for this qualification.
5. Prepare a finite live-test budget and independent cleanup watchdog. In an isolated Broker test scope or separately reviewed canary-only activation, run one 15-minute canary per provider through the normal auction, using the initial profiles above. Require actual native start/billing identity, PTY input/output, persistent state/cwd, resize, scoped renewal, frozen invoice/commission, confirmed termination, and released holds. A terminal capability flag or created session is not a PTY pass. Do not use Blaxel diagnostic exceptions as acceptance criteria.
6. Activate production offerings individually after their own qualification and monitor normal rentals before adding profiles or slots. A failing provider remains paused while its cleanup proceeds. Do not remove the expanded identity constraint while rows use the new IDs.

All eight advertised configurations across the four additions are now qualified and activated after confirmed cleanup. Each account has ten shared slots following the operator's later capacity request; saved base prices are unchanged. The all-sizes receipt retains Boat Large's failed first terminal attempt and successful singleton retry without assigning an unconfirmed cause. No eight-provider concurrent-scale result is asserted. Future deployment, activation and live-test receipts must record their actual outcomes rather than infer them from code or capability flags.
