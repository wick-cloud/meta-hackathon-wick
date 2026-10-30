# Prices and credit precision

Broker displays USD with two to four decimal places and accepts $0.0001 increments for buyer limits, provider bids and asks, agreement rates, wallet credit and agent funding. A smaller entered amount is rejected rather than silently rounded. Payment collection and payouts remain separate.

Public `*Cents` fields keep their existing unit. `$1.2345` is `123.45` cents, and `$0.0001` is `0.01` cents. Integers from existing clients still mean the same number of cents. SDK, CLI and MCP version `0.3.0` describe and accept this precision; previous download directories remain immutable.

The database stores decimal cents as unscaled `NUMERIC` with a precision check, so values beyond hundredths of a cent fail instead of being rounded by a column scale. In-memory additions, subtractions, quantity multiplication and wallet checks use integer hundredth-cent units. Quantities, token counts, revisions and capacity remain whole numbers. Existing monetary history is converted without rescaling, rewriting accepted prices or adding ledger entries.

New token pack quotes and scheduled per-VM window costs round upward once to $0.0001, covering the provider's cost after commission. Existing VM automatic quote calculation remains unchanged; manual bids can use four-decimal USD amounts within the published cost floor and provider policy. Accepted prices and rates remain frozen.

Broker takes exactly 15% from the provider, with no separate buyer fee. Fee and provider-share accounting retains integer micro-USD: a $0.0001 purchase allocates 15 micro-USD to Broker and 85 to the provider. Displayed shares round to four USD decimals; the exact stored shares are unchanged by display rounding.

Verified provider-failure refunds floor the unused weighted value to the purchased pack's currency precision. New packs freeze `currencyDecimals: 4`; older packs without that marker retain their original whole-cent refund floor. Ordinary unused prepaid quota remains non-refundable.

Migration `020_four_decimal_money.sql` changes monetary column types in one transaction with a bounded lock wait. Release it with writes and workers drained; old application processes must not transact against the new schema. Historical client downloads are retained alongside the new release. Local migration tests verify existing wallet/ledger values survive unchanged and finer amounts fail database checks.
