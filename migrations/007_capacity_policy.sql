ALTER TABLE broker_providers ADD COLUMN policy_revision integer NOT NULL DEFAULT 1
  CHECK (policy_revision > 0);

-- Every writer, including administrative setup, invalidates proposals based on old limits.
-- Existing reservations remain binding and no hold is released by a policy change.
CREATE FUNCTION broker_provider_policy_revision() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.policy, NEW.total_capacity) IS DISTINCT FROM (OLD.policy, OLD.total_capacity) THEN
    NEW.policy_revision := OLD.policy_revision + 1;
  ELSE
    NEW.policy_revision := OLD.policy_revision;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER broker_provider_policy_revision BEFORE UPDATE ON broker_providers
  FOR EACH ROW EXECUTE FUNCTION broker_provider_policy_revision();
