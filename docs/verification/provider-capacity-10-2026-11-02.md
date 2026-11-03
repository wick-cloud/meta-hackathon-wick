# Provider capacity increase — 2026-11-02

At the operator's request, Sail, Tenki, Freestyle, and Boat.dev were each set to **10 configured slots**, shared across that provider's enabled profiles. Live readback completed at **11:22:53 p.m. America/New_York on November 2, 2026** (`2026-11-03T04:22:53.414Z`).

| Provider  | Previous slots | Configured slots | Held at verification | Available at verification | Policy revision | Automatic bidding | Active configurations |
| --------- | -------------: | ---------------: | -------------------: | ------------------------: | --------------: | ----------------- | --------------------: |
| Sail      |              1 |               10 |                    0 |                        10 |               5 | Enabled           |                     3 |
| Tenki     |              1 |               10 |                    0 |                        10 |               3 | Enabled           |                     1 |
| Freestyle |              1 |               10 |                    0 |                        10 |               3 | Enabled           |                     1 |
| Boat.dev  |              1 |               10 |                    0 |                        10 |               5 | Enabled           |                     3 |

Each update used the owning provider's authenticated capacity endpoint with an expected policy revision and stable operation key. Provider dashboard and administrator readback both confirmed the new totals. Saved policies and complete offering records were compared before and after and were unchanged; capacity updates advanced the policy revision. All eight previously qualified catalog configurations remain approved and active.

These accounts now have **40 configured slots combined**. They share the broker's existing **20-VM global admission limit** with the other provider accounts. Ten Sail slots are shared across Micro, Medium, and Large; ten Boat slots are shared across Small, Medium, and Large.

The existing bidding strategy applies at the higher capacity. Sufficient free capacity and price headroom can permit an optional discount; when no discount is selected, the effective base-price behavior remains in force. No pricing or bidding code changed in this operation.

Health and readiness returned HTTP 200. All five temporary verification sessions were signed out. No VM was allocated by this capacity change. The [earlier all-sizes receipt](provider-all-sizes-2026-11-02.md) records individual profile qualification and its cleanup; it does not establish concurrent load at ten slots per provider.

Sanitized detailed receipts are retained privately under `../.broker-run/real-wick-20261028/capacity-10-20261102/`, relative to the repository root. Credentials and session cookies are omitted from this report.
