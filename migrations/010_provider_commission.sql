-- Additive accounting only. Existing quotes, bids, invoices and published prices stay unchanged.
ALTER TABLE broker_offerings DROP CONSTRAINT broker_offerings_pricing_model;
ALTER TABLE broker_offerings ADD CONSTRAINT broker_offerings_pricing_model
  CHECK (pricing IS NULL OR pricing->>'model' IN ('wick-managed-rate-v1','wick-provider-commission-v1'));
ALTER TABLE broker_invoices ADD COLUMN revenue_share jsonb;
ALTER TABLE broker_invoices ADD CONSTRAINT broker_invoices_revenue_share_valid CHECK (
  revenue_share IS NULL OR ((
    jsonb_typeof(revenue_share)='object'
    AND revenue_share ?& ARRAY['commissionBps','grossCents','brokerFeeMicros','providerNetMicros']
    AND jsonb_typeof(revenue_share->'commissionBps')='number'
    AND jsonb_typeof(revenue_share->'grossCents')='number'
    AND jsonb_typeof(revenue_share->'brokerFeeMicros')='string'
    AND jsonb_typeof(revenue_share->'providerNetMicros')='string'
    AND revenue_share->>'brokerFeeMicros' ~ '^[0-9]+$'
    AND revenue_share->>'providerNetMicros' ~ '^[0-9]+$'
    AND (revenue_share->>'commissionBps')::integer=1500
    AND (revenue_share->>'grossCents')::numeric=total_cents
    AND (revenue_share->>'brokerFeeMicros')::numeric=total_cents::bigint*1500
    AND (revenue_share->>'providerNetMicros')::numeric=total_cents::bigint*8500
  ) IS TRUE)
);
CREATE INDEX broker_invoices_provider_page ON broker_invoices(provider_id,created_at DESC,id DESC);
