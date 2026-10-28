CREATE INDEX IF NOT EXISTS broker_offerings_active_price_idx
  ON broker_offerings(provider_id, catalog_id, price_cents, id)
  WHERE active;

CREATE INDEX IF NOT EXISTS broker_providers_auto_bid_idx
  ON broker_providers(id)
  WHERE policy->>'autoBid'='true';
