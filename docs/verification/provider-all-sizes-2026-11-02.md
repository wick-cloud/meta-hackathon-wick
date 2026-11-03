# Advertised provider sizes — 2026-11-02

**Status: all eight advertised configurations are qualified and enabled in production.** Boat Large passed a separately bounded retry after its first terminal attempt failed; the cause of that first failure remains unconfirmed. Activation completed at **11:17:29 p.m. America/New_York on November 2, 2026** (`2026-11-03T04:17:29.906Z`). This expands the existing four accounts to every size then advertised by Wick for Sail, Tenki, Freestyle, and Boat.dev, without additional accounts or increased capacity.

The four initial configurations already passed live qualification and were activated; see the [initial live receipt](provider-live-qualification-2026-11-02.md). This receipt covers the additional Sail Medium/Large and Boat Medium/Large configurations. It preserves the earlier result's original scope.

## Advertised configurations

The production-service catalog retrieved at `2026-11-03T03:58:49.793Z` advertised the following exact resources and managed rates. Rates are observations, not guarantees of future prices. All configurations use requested region `auto` and advertise 15-, 30-, and 60-minute durations.

| Provider  | Profile | CPUs | Memory (GiB) |     Disk (GiB) | Rate (micro-USD/second) | USD/hour |
| --------- | ------- | ---: | -----------: | -------------: | ----------------------: | -------: |
| Sail      | Micro   |    1 |            2 |              8 |                      12 |  $0.0432 |
| Sail      | Medium  |    4 |            8 |             32 |                      44 |  $0.1584 |
| Sail      | Large   |    8 |           16 |             64 |                      85 |  $0.3060 |
| Tenki     | Micro   |    1 |            1 |              5 |                      19 |  $0.0684 |
| Freestyle | Small   |    2 |            4 |             16 |                      38 |  $0.1368 |
| Boat.dev  | Small   |    2 |  3.724609375 |              8 |                       5 |  $0.0180 |
| Boat.dev  | Medium  |    4 | 7.4501953125 |             32 |                      10 |  $0.0360 |
| Boat.dev  | Large   |    8 | 14.900390625 | 116.4150390625 |                      20 |  $0.0720 |

Boat's memory corresponds to 3,814 / 7,629 / 15,258 MiB and is not rounded upward for buyer matching. Its Large disk value is retained exactly as advertised. Sail Small, Boat Micro, and additional Tenki or Freestyle sizes are not advertised in this catalog and were not invented.

Twelve fresh read-only execution previews passed for the four additions at 900, 1,800, and 3,600 seconds, with exact provider/profile, managed billing, eligibility, and no fallback. These previews create no VM and do not establish live terminal or full-duration behavior.

## Staging and unchanged account limits

The deployed `configureProviderMarketplace` implementation staged only the four new catalog selections with `mode=stage`, `updateExisting=false`, and no supplier retirement. It created inactive offerings at 120% of each current 30-minute cost-covered quote. Existing account, authentication, capacity, and policy fingerprints were unchanged by staging. The temporary SSH key was revoked and its local files removed after setup.

| Additional configuration | 30-minute cost-covered floor | Staged 30-minute listing price | Reviewed 15-minute test quote |
| ------------------------ | ---------------------------: | -----------------------------: | ----------------------------: |
| Sail Medium              |                      $0.1000 |                        $0.1200 |                       $0.0500 |
| Sail Large               |                      $0.1800 |                        $0.2160 |                       $0.0900 |
| Boat.dev Medium          |                      $0.0300 |                        $0.0360 |                       $0.0240 |
| Boat.dev Large           |                      $0.0500 |                        $0.0600 |                       $0.0300 |

Sail and Boat were then explicitly paused for qualification with `autoBid=false` and their allowlists expanded to their three advertised configurations. Each retained capacity one, held slots zero at the pause check, and unchanged saved base/minimum/maximum prices and reserve slots. Tenki and Freestyle require no additional size offering.

**Capacity remains one per provider account, shared across its profiles.** Adding Medium and Large does not give Sail or Boat three concurrent slots. Saved account bases remain Sail $0.0360, Tenki $0.0600, Freestyle $0.1080, and Boat $0.0240.

The deployed automatic auction formula remains the greater of saved account base, policy minimum, and the requested duration's current compute floor after the 15% commission. A one-slot account bids that effective base without a discount decision. The listing prices are 30-minute display baselines; they do not override that formula. Existing real counteroffer pricing also retains its duration-specific floor and policy minimum. No saved price limits or production pricing code changed in this size expansion.

## Live qualification results

The bounded `provider-size-canary` runner used two separate waves: Sail/Boat Medium, then Sail/Boat Large. Each wave permitted exactly two owned 15-minute requests, one per provider. Automatic bids remained paused; each manual test quote was frozen to the reviewed effective base above. Exact-route listing exposure was restored immediately after the binding bid. Each wave had an independent cleanup watchdog and a 12-minute maximum.

The Medium wave began at approximately `2026-11-03T04:04Z` (11:04 p.m. Eastern, November 2). Sail Medium and Boat Medium both passed native, terminal, invoice, and explicit SDK renewal checks, with a **130,264 ms** Broker terminal hold. Each SDK observer recorded two scoped-session responses, fresh post-renewal output, and closed its PTY. Cleanup confirmed zero unknown or pending resources, two native confirmations, released holds, and restored listings; the independent watchdog exited.

The Large wave began at approximately `2026-11-03T04:08Z`, after Medium cleanup. Sail Large passed, including a **130,637 ms** Broker terminal hold. Boat Large reached native running state with the exact managed route but failed its initial Broker and SDK terminal checks. That failed attempt remains part of the result; the cause is unconfirmed.

After confirmed Large-wave cleanup, a separate `provider-size-retry-canary` run permitted exactly one Boat Large 15-minute rental at a three-cent quote. It passed native, Broker PTY, invoice, and explicit SDK renewal checks, with a **130,069 ms** Broker terminal hold. The observer received two scoped-session responses, explicit renewal, and fresh post-renewal PTY output, then closed its PTY. Cleanup confirmed one native environment cleaned up, zero unknown or pending resources, zero held slots, and restored listings; the watchdog exited. The retry finished at approximately `2026-11-03T04:17:19Z`. Its success does not establish the cause of the earlier failure.

| Acceptance check                                                             | Sail Medium | Boat Medium | Sail Large | Boat Large                          |
| ---------------------------------------------------------------------------- | ----------- | ----------- | ---------- | ----------------------------------- |
| Exact native ownership, running state, managed billing and future expiry     | Pass        | Pass        | Pass       | Pass on retry                       |
| Strict Broker PTY, persistent state/cwd, resize and at least 130-second hold | Pass        | Pass        | Pass       | Pass on retry; first attempt failed |
| Explicit SDK renewal and fresh post-renewal PTY proof                        | Pass        | Pass        | Pass       | Pass on retry; first attempt failed |
| One frozen invoice with zero buyer fee and 15%/85% gross split               | Pass        | Pass        | Pass       | Pass on retry                       |
| Broker/native cleanup, zero held slots and restored test listings            | Pass        | Pass        | Pass       | Pass for both attempts              |

The renewal observer attached only to an already-owned native VM. Each successful configuration received an explicit renewal event, a second scoped-session response, fresh PTY output and retained state, and closed its sessions during cleanup. It created no VM. Broker continuity and direct-SDK renewal remain distinct proofs. This size expansion used **five VMs total**, including the failed first Boat Large attempt and its retry; native cleanup was confirmed for all five.

## Production activation

Activation followed the completed qualification and cleanup receipts. Final readback at `2026-11-03T04:17:29.906Z` confirmed **eight approved catalogs and eight active offerings across these four accounts**: three each for Sail and Boat, one each for Tenki and Freestyle. All four accounts have `autoBid=true`, capacity one, and held slots zero. Saved base/minimum/maximum prices and reserve slots remain unchanged. Sail and Boat policy revisions are four; Tenki and Freestyle remain at two. The shared global VM limit remains 20.

This work does not establish sustained production load, eight-provider concurrent scale, full-duration expiry, live model discount decisions, or support for profiles absent from Wick's catalog.

## Local verification and private evidence

The combined focused offline checks passed **49 tests**; TypeScript and the production build passed. Tests cover the exact two-provider size waves, Boat Large singleton retry, original four-provider mode, quote bounds, frozen fingerprint, receipt limits, and preserved cleanup controls. Offline checks support the runners; the separate live receipts establish the results above.

The private evidence directory is `../.broker-run/real-wick-20261028/all-sizes-20261102/`, relative to the repository root. Detailed execution receipts stay there. This public report omits credentials, tokens, cookies, organization/account identifiers, native VM identifiers, and terminal transcripts.

After activation, `/health`, `/ready`, and `/` returned HTTP 200, and the buyer catalog independently showed all eight approved configurations. All six temporary verification sessions were signed out and four temporary credential files removed. The temporary SSH key had already been revoked and its files deleted.
