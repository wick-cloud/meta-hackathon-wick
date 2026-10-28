-- Historical fixture offerings, accepted quotes and invoices are deliberately untouched.
ALTER TABLE broker_offerings ADD COLUMN pricing jsonb;
ALTER TABLE broker_offerings ADD CONSTRAINT broker_offerings_pricing_model
  CHECK (pricing IS NULL OR pricing->>'model' = 'wick-managed-rate-v1');
