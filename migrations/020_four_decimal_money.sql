-- Keep cents as the API unit, with hundredths of a cent ($0.0001) stored exactly.
-- Lock waits fail explicitly instead of holding production requests indefinitely.
SET LOCAL lock_timeout='5s';
ALTER TABLE broker_invoices DROP CONSTRAINT broker_invoices_revenue_share_valid;
ALTER TABLE broker_offerings
  ALTER COLUMN price_cents TYPE numeric USING price_cents::numeric;
ALTER TABLE broker_offerings ADD CONSTRAINT broker_offerings_money_precision CHECK ((price_cents IS NULL OR (price_cents BETWEEN -1000000000000 AND 1000000000000 AND price_cents=trunc(price_cents,2))));
ALTER TABLE broker_requests
  ALTER COLUMN max_price_cents TYPE numeric USING max_price_cents::numeric;
ALTER TABLE broker_requests ADD CONSTRAINT broker_requests_money_precision CHECK ((max_price_cents IS NULL OR (max_price_cents BETWEEN -1000000000000 AND 1000000000000 AND max_price_cents=trunc(max_price_cents,2))));
ALTER TABLE broker_bids
  ALTER COLUMN total_price_cents TYPE numeric USING total_price_cents::numeric;
ALTER TABLE broker_bids ADD CONSTRAINT broker_bids_money_precision CHECK ((total_price_cents IS NULL OR (total_price_cents BETWEEN -1000000000000 AND 1000000000000 AND total_price_cents=trunc(total_price_cents,2))));
ALTER TABLE broker_invoices
  ALTER COLUMN subtotal_cents TYPE numeric USING subtotal_cents::numeric,
  ALTER COLUMN fee_cents TYPE numeric USING fee_cents::numeric,
  ALTER COLUMN total_cents TYPE numeric USING total_cents::numeric;
ALTER TABLE broker_invoices ADD CONSTRAINT broker_invoices_money_precision CHECK ((subtotal_cents IS NULL OR (subtotal_cents BETWEEN -1000000000000 AND 1000000000000 AND subtotal_cents=trunc(subtotal_cents,2))) AND (fee_cents IS NULL OR (fee_cents BETWEEN -1000000000000 AND 1000000000000 AND fee_cents=trunc(fee_cents,2))) AND (total_cents IS NULL OR (total_cents BETWEEN -1000000000000 AND 1000000000000 AND total_cents=trunc(total_cents,2))));
ALTER TABLE broker_credit_wallets
  ALTER COLUMN balance_cents TYPE numeric USING balance_cents::numeric,
  ALTER COLUMN reserved_cents TYPE numeric USING reserved_cents::numeric;
ALTER TABLE broker_credit_wallets ADD CONSTRAINT broker_credit_wallets_money_precision CHECK ((balance_cents IS NULL OR (balance_cents BETWEEN -1000000000000 AND 1000000000000 AND balance_cents=trunc(balance_cents,2))) AND (reserved_cents IS NULL OR (reserved_cents BETWEEN -1000000000000 AND 1000000000000 AND reserved_cents=trunc(reserved_cents,2))));
ALTER TABLE broker_agreements
  ALTER COLUMN max_amount_cents TYPE numeric USING max_amount_cents::numeric,
  ALTER COLUMN reserved_cents TYPE numeric USING reserved_cents::numeric,
  ALTER COLUMN committed_cents TYPE numeric USING committed_cents::numeric,
  ALTER COLUMN settled_cents TYPE numeric USING settled_cents::numeric,
  ALTER COLUMN adjustment_cents TYPE numeric USING adjustment_cents::numeric;
ALTER TABLE broker_agreements ADD CONSTRAINT broker_agreements_money_precision CHECK ((max_amount_cents IS NULL OR (max_amount_cents BETWEEN -1000000000000 AND 1000000000000 AND max_amount_cents=trunc(max_amount_cents,2))) AND (reserved_cents IS NULL OR (reserved_cents BETWEEN -1000000000000 AND 1000000000000 AND reserved_cents=trunc(reserved_cents,2))) AND (committed_cents IS NULL OR (committed_cents BETWEEN -1000000000000 AND 1000000000000 AND committed_cents=trunc(committed_cents,2))) AND (settled_cents IS NULL OR (settled_cents BETWEEN -1000000000000 AND 1000000000000 AND settled_cents=trunc(settled_cents,2))) AND (adjustment_cents IS NULL OR (adjustment_cents BETWEEN -1000000000000 AND 1000000000000 AND adjustment_cents=trunc(adjustment_cents,2))));
ALTER TABLE broker_credit_ledger
  ALTER COLUMN amount_cents TYPE numeric USING amount_cents::numeric,
  ALTER COLUMN reserved_delta_cents TYPE numeric USING reserved_delta_cents::numeric;
ALTER TABLE broker_credit_ledger ADD CONSTRAINT broker_credit_ledger_money_precision CHECK ((amount_cents IS NULL OR (amount_cents BETWEEN -1000000000000 AND 1000000000000 AND amount_cents=trunc(amount_cents,2))) AND (reserved_delta_cents IS NULL OR (reserved_delta_cents BETWEEN -1000000000000 AND 1000000000000 AND reserved_delta_cents=trunc(reserved_delta_cents,2))));
ALTER TABLE broker_agreement_windows
  ALTER COLUMN committed_cents TYPE numeric USING committed_cents::numeric,
  ALTER COLUMN adjustment_cents TYPE numeric USING adjustment_cents::numeric,
  ALTER COLUMN settled_cents TYPE numeric USING settled_cents::numeric;
ALTER TABLE broker_agreement_windows ADD CONSTRAINT broker_agreement_windows_money_precision CHECK ((committed_cents IS NULL OR (committed_cents BETWEEN -1000000000000 AND 1000000000000 AND committed_cents=trunc(committed_cents,2))) AND (adjustment_cents IS NULL OR (adjustment_cents BETWEEN -1000000000000 AND 1000000000000 AND adjustment_cents=trunc(adjustment_cents,2))) AND (settled_cents IS NULL OR (settled_cents BETWEEN -1000000000000 AND 1000000000000 AND settled_cents=trunc(settled_cents,2))));
ALTER TABLE broker_scheduled_offerings
  ALTER COLUMN discount_rate_cents_per_hour TYPE numeric USING discount_rate_cents_per_hour::numeric,
  ALTER COLUMN normal_rate_cents_per_hour TYPE numeric USING normal_rate_cents_per_hour::numeric;
ALTER TABLE broker_scheduled_offerings ADD CONSTRAINT broker_scheduled_offerings_money_precision CHECK ((discount_rate_cents_per_hour IS NULL OR (discount_rate_cents_per_hour BETWEEN -1000000000000 AND 1000000000000 AND discount_rate_cents_per_hour=trunc(discount_rate_cents_per_hour,2))) AND (normal_rate_cents_per_hour IS NULL OR (normal_rate_cents_per_hour BETWEEN -1000000000000 AND 1000000000000 AND normal_rate_cents_per_hour=trunc(normal_rate_cents_per_hour,2))));
ALTER TABLE broker_agreement_bookings
  ALTER COLUMN unit_price_cents TYPE numeric USING unit_price_cents::numeric,
  ALTER COLUMN adjustment_cents TYPE numeric USING adjustment_cents::numeric;
ALTER TABLE broker_agreement_bookings ADD CONSTRAINT broker_agreement_bookings_money_precision CHECK ((unit_price_cents IS NULL OR (unit_price_cents BETWEEN -1000000000000 AND 1000000000000 AND unit_price_cents=trunc(unit_price_cents,2))) AND (adjustment_cents IS NULL OR (adjustment_cents BETWEEN -1000000000000 AND 1000000000000 AND adjustment_cents=trunc(adjustment_cents,2))));
ALTER TABLE broker_agreement_adjustments
  ALTER COLUMN amount_cents TYPE numeric USING amount_cents::numeric;
ALTER TABLE broker_agreement_adjustments ADD CONSTRAINT broker_agreement_adjustments_money_precision CHECK ((amount_cents IS NULL OR (amount_cents BETWEEN -1000000000000 AND 1000000000000 AND amount_cents=trunc(amount_cents,2))));
ALTER TABLE broker_agreement_charges
  ALTER COLUMN gross_cents TYPE numeric USING gross_cents::numeric,
  ALTER COLUMN credit_cents TYPE numeric USING credit_cents::numeric,
  ALTER COLUMN total_cents TYPE numeric USING total_cents::numeric;
ALTER TABLE broker_agreement_charges ADD CONSTRAINT broker_agreement_charges_money_precision CHECK ((gross_cents IS NULL OR (gross_cents BETWEEN -1000000000000 AND 1000000000000 AND gross_cents=trunc(gross_cents,2))) AND (credit_cents IS NULL OR (credit_cents BETWEEN -1000000000000 AND 1000000000000 AND credit_cents=trunc(credit_cents,2))) AND (total_cents IS NULL OR (total_cents BETWEEN -1000000000000 AND 1000000000000 AND total_cents=trunc(total_cents,2))));
ALTER TABLE broker_inference_grants
  ALTER COLUMN funded_cents TYPE numeric USING funded_cents::numeric,
  ALTER COLUMN available_cents TYPE numeric USING available_cents::numeric,
  ALTER COLUMN held_cents TYPE numeric USING held_cents::numeric,
  ALTER COLUMN spent_cents TYPE numeric USING spent_cents::numeric,
  ALTER COLUMN returned_cents TYPE numeric USING returned_cents::numeric,
  ALTER COLUMN max_purchase_cents TYPE numeric USING max_purchase_cents::numeric;
ALTER TABLE broker_inference_grants ADD CONSTRAINT broker_inference_grants_money_precision CHECK ((funded_cents IS NULL OR (funded_cents BETWEEN -1000000000000 AND 1000000000000 AND funded_cents=trunc(funded_cents,2))) AND (available_cents IS NULL OR (available_cents BETWEEN -1000000000000 AND 1000000000000 AND available_cents=trunc(available_cents,2))) AND (held_cents IS NULL OR (held_cents BETWEEN -1000000000000 AND 1000000000000 AND held_cents=trunc(held_cents,2))) AND (spent_cents IS NULL OR (spent_cents BETWEEN -1000000000000 AND 1000000000000 AND spent_cents=trunc(spent_cents,2))) AND (returned_cents IS NULL OR (returned_cents BETWEEN -1000000000000 AND 1000000000000 AND returned_cents=trunc(returned_cents,2))) AND (max_purchase_cents IS NULL OR (max_purchase_cents BETWEEN -1000000000000 AND 1000000000000 AND max_purchase_cents=trunc(max_purchase_cents,2))));
ALTER TABLE broker_token_offerings
  ALTER COLUMN minimum_price_cents TYPE numeric USING minimum_price_cents::numeric;
ALTER TABLE broker_token_offerings ADD CONSTRAINT broker_token_offerings_money_precision CHECK ((minimum_price_cents IS NULL OR (minimum_price_cents BETWEEN -1000000000000 AND 1000000000000 AND minimum_price_cents=trunc(minimum_price_cents,2))));
ALTER TABLE broker_token_orders
  ALTER COLUMN max_total_cents TYPE numeric USING max_total_cents::numeric,
  ALTER COLUMN price_cents TYPE numeric USING price_cents::numeric;
ALTER TABLE broker_token_orders ADD CONSTRAINT broker_token_orders_money_precision CHECK ((max_total_cents IS NULL OR (max_total_cents BETWEEN -1000000000000 AND 1000000000000 AND max_total_cents=trunc(max_total_cents,2))) AND (price_cents IS NULL OR (price_cents BETWEEN -1000000000000 AND 1000000000000 AND price_cents=trunc(price_cents,2))));
ALTER TABLE broker_token_bids
  ALTER COLUMN price_cents TYPE numeric USING price_cents::numeric;
ALTER TABLE broker_token_bids ADD CONSTRAINT broker_token_bids_money_precision CHECK ((price_cents IS NULL OR (price_cents BETWEEN -1000000000000 AND 1000000000000 AND price_cents=trunc(price_cents,2))));
ALTER TABLE broker_token_packs
  ALTER COLUMN price_cents TYPE numeric USING price_cents::numeric,
  ALTER COLUMN refund_cents TYPE numeric USING refund_cents::numeric;
ALTER TABLE broker_token_packs ADD CONSTRAINT broker_token_packs_money_precision CHECK ((price_cents IS NULL OR (price_cents BETWEEN -1000000000000 AND 1000000000000 AND price_cents=trunc(price_cents,2))) AND (refund_cents IS NULL OR (refund_cents BETWEEN -1000000000000 AND 1000000000000 AND refund_cents=trunc(refund_cents,2))));
ALTER TABLE broker_inference_events
  ALTER COLUMN amount_cents TYPE numeric USING amount_cents::numeric;
ALTER TABLE broker_inference_events ADD CONSTRAINT broker_inference_events_money_precision CHECK ((amount_cents IS NULL OR (amount_cents BETWEEN -1000000000000 AND 1000000000000 AND amount_cents=trunc(amount_cents,2))));
ALTER TABLE broker_agreements DROP CONSTRAINT broker_agreements_max_amount_cents_check;
ALTER TABLE broker_agreements ADD CONSTRAINT broker_agreements_max_amount_cents_check CHECK(max_amount_cents BETWEEN 0.01 AND 100000000);
ALTER TABLE broker_scheduled_offerings DROP CONSTRAINT broker_scheduled_offerings_discount_rate_cents_per_hour_check;
ALTER TABLE broker_scheduled_offerings ADD CONSTRAINT broker_scheduled_offerings_discount_rate_cents_per_hour_check CHECK(discount_rate_cents_per_hour BETWEEN 0.01 AND 100000000);
ALTER TABLE broker_scheduled_offerings DROP CONSTRAINT broker_scheduled_offerings_normal_rate_cents_per_hour_check;
ALTER TABLE broker_scheduled_offerings ADD CONSTRAINT broker_scheduled_offerings_normal_rate_cents_per_hour_check CHECK(normal_rate_cents_per_hour BETWEEN 0.01 AND 100000000);
ALTER TABLE broker_inference_grants DROP CONSTRAINT broker_inference_grants_funded_cents_check;
ALTER TABLE broker_inference_grants ADD CONSTRAINT broker_inference_grants_funded_cents_check CHECK(funded_cents BETWEEN 0.01 AND 100000000);
ALTER TABLE broker_inference_grants DROP CONSTRAINT broker_inference_grants_max_purchase_cents_check;
ALTER TABLE broker_inference_grants ADD CONSTRAINT broker_inference_grants_max_purchase_cents_check CHECK(max_purchase_cents BETWEEN 0.01 AND 100000000);
ALTER TABLE broker_token_offerings DROP CONSTRAINT broker_token_offerings_minimum_price_cents_check;
ALTER TABLE broker_token_offerings ADD CONSTRAINT broker_token_offerings_minimum_price_cents_check CHECK(minimum_price_cents BETWEEN 0.01 AND 100000000);
ALTER TABLE broker_token_orders DROP CONSTRAINT broker_token_orders_max_total_cents_check;
ALTER TABLE broker_token_orders ADD CONSTRAINT broker_token_orders_max_total_cents_check CHECK(max_total_cents BETWEEN 0.01 AND 100000000);
ALTER TABLE broker_token_bids DROP CONSTRAINT broker_token_bids_price_cents_check;
ALTER TABLE broker_token_bids ADD CONSTRAINT broker_token_bids_price_cents_check CHECK(price_cents BETWEEN 0.01 AND 100000000);
ALTER TABLE broker_token_packs DROP CONSTRAINT broker_token_packs_price_cents_check;
ALTER TABLE broker_token_packs ADD CONSTRAINT broker_token_packs_price_cents_check CHECK(price_cents BETWEEN 0.01 AND 100000000);
ALTER TABLE broker_invoices ADD CONSTRAINT broker_invoices_revenue_share_valid CHECK (
 revenue_share IS NULL OR ((jsonb_typeof(revenue_share)='object'
 AND revenue_share ?& ARRAY['commissionBps','grossCents','brokerFeeMicros','providerNetMicros']
 AND jsonb_typeof(revenue_share->'commissionBps')='number'
 AND jsonb_typeof(revenue_share->'grossCents')='number'
 AND jsonb_typeof(revenue_share->'brokerFeeMicros')='string'
 AND jsonb_typeof(revenue_share->'providerNetMicros')='string'
 AND revenue_share->>'brokerFeeMicros' ~ '^[0-9]+$'
 AND revenue_share->>'providerNetMicros' ~ '^[0-9]+$'
 AND (revenue_share->>'commissionBps')::integer=1500
 AND (revenue_share->>'grossCents')::numeric=total_cents
 AND (revenue_share->>'brokerFeeMicros')::numeric=total_cents*1500
 AND (revenue_share->>'providerNetMicros')::numeric=total_cents*8500) IS TRUE));

ALTER TABLE broker_token_offerings ALTER COLUMN minimum_price_cents SET DEFAULT 0.01;
