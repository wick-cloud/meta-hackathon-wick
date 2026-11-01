# Studio compute admission — November 1, 2026

Production Studio verification exposed two independent failures before this change:

- A 15-minute Micro request had a three-cent managed cost floor and a 3.75-cent Studio ceiling. The provider's published policy had a five-cent base quote, so automatic bidding declined. No VM was created. A later E2B 15-minute attempt encountered the same quote mismatch.
- A 30-minute Daytona Micro allocation was created, but the guest isolation preflight failed before cloning or executing repository code. Cleanup was confirmed. This is a Studio execution failure; it does not establish that ordinary Daytona VM rental or terminal access is unavailable.

## Quote-aware compute budget

Automatic compute bidding accepts or declines a deterministic server quote. That quote is the maximum of the provider's minimum/base policy, the selected rental's current managed cost floor, and the minimum order price. A published offering's 30-minute baseline price is not a new price for every rental duration.

Studio now reads active published offerings and their provider policies for the selected catalog page. It applies the same provider identity, allowed configurations, automatic-bid selection and price-cap rules, and rejects stale or missing managed pricing snapshots. A five-cent base quote therefore gets a 6.25-cent ceiling under the existing 25% reservation buffer, rather than the insufficient 3.75-cent ceiling. The final charge still comes from the binding auction bid. Provider prices, accepted commitments and billing semantics are unchanged.

The read uses at most sixteen selected catalog IDs and eight eligible provider/listing pairs per configuration in one batched query, matching the auction's actual automatic-bid fanout and ordering. A cheaper ninth seller cannot lower the ceiling when it will not receive an automatic-bid job. Historical duplicate listings do not grow the returned page. Current availability, calendar commitments and final auction eligibility remain authoritative at bid submission; this estimate promises no future capacity.

## Execution qualification

Real Studio admission also requires `STUDIO_APPROVED_COMPUTE_CATALOG_IDS`, an explicit comma-separated list of at most sixteen existing approved catalog IDs. The list filters the source catalog query before sorting and pagination. An empty list, an unqualified route or absent eligible published supply rejects a new task before credit reservation. Fixture qualification and the ordinary VM rental, terminal and Wick routing interfaces are unchanged.

The default Studio options endpoint checks qualified published supply for its default 30-minute term. Task admission validates the owner's exact selected duration independently. Qualification does not install guest tools or bypass the existing isolation preflight.

| Compute route                               | Studio evidence                                                                                                                                                                                                                                | Qualification decision                                                                                                                   |
| ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| E2B Micro, US                               | Prior real Studio flows with both inference providers passed guest tests, retained patches and cleanup; see the [small-pack verification](../studio-small-pack-verification.md). The current pre-fix 15-minute quote failed before allocation. | Exact route `e2b:micro:us` may be explicitly qualified from that prior execution evidence; verify the new production flow after rollout. |
| Daytona Micro, US                           | Current live allocation failed the isolation preflight; no repository code ran; cleanup confirmed.                                                                                                                                             | Leave Studio execution unqualified pending investigation. Ordinary VM/terminal availability is not changed.                              |
| Modal compute routes                        | Native Studio isolation has not been verified in this review.                                                                                                                                                                                  | No Studio execution qualification inferred.                                                                                              |
| Blaxel compute routes, displayed as Baseten | Native Studio isolation has not been verified in this review.                                                                                                                                                                                  | No Studio execution qualification inferred.                                                                                              |

These are compute-route decisions. Modal and Baseten **inference** qualifications and pricing are separate and are not narrowed by this list.

## Verification

Focused disposable-Postgres checks exercise the 15-minute quote mismatch with unchanged provider policy, a valid five-cent binding bid, missing execution qualification without funding, inactive/unpublished supply, provider identity, allowed catalogs, disabled automatic bidding, stale rate snapshots, provider price caps, and qualification filtering before the bounded catalog page. A history case with two thousand additional active offerings verifies the query still returns only the selected provider/listing pairs. These are synthetic real-mode policy checks; no native provider is contacted.

The opt-in paid harness now requires an explicitly qualified E2B catalog and no longer lowers its provider's base price to fit a 15-minute request. Production end-to-end results must be recorded separately after rollout; these local checks do not certify another native guest package or isolation mechanism.
