-- Keep one durable Apply receipt per provider. New reviewed applications supersede
-- this receipt; old revisions still fail the normal compare-and-swap check.
-- This is deliberately bounded, with no append-only idempotency table.
ALTER TABLE broker_providers ADD COLUMN policy_apply_receipt jsonb
  CHECK (policy_apply_receipt IS NULL OR jsonb_typeof(policy_apply_receipt) = 'object');

-- A new reviewed Apply consumes a revision even when its limits are unchanged.
-- Thus replacing the bounded receipt cannot allow an evicted no-op operation to
-- be executed again at the same revision. Exact retries never reach this update.
CREATE OR REPLACE FUNCTION broker_provider_policy_revision() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.policy, NEW.total_capacity, NEW.policy_apply_receipt)
      IS DISTINCT FROM (OLD.policy, OLD.total_capacity, OLD.policy_apply_receipt) THEN
    NEW.policy_revision := OLD.policy_revision + 1;
  ELSE
    NEW.policy_revision := OLD.policy_revision;
  END IF;
  RETURN NEW;
END $$;
