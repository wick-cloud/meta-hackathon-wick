-- Explicit demo adapter state. Never used as a fallback for upstream failures.
CREATE TABLE IF NOT EXISTS broker_fixture_environments (
  id text PRIMARY KEY,
  create_key text NOT NULL UNIQUE,
  input_hash text NOT NULL,
  input_json jsonb NOT NULL,
  status text NOT NULL CHECK (status IN ('provisioning','running','terminating','terminated','failed')),
  admitted_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL,
  ready_at timestamptz NOT NULL,
  termination_requested_at timestamptz
);
CREATE INDEX IF NOT EXISTS broker_fixture_environments_active_idx
  ON broker_fixture_environments(expires_at) WHERE status NOT IN ('terminated','failed');
