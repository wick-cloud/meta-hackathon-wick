-- A fresh start key can resume an existing browser run. Keep that accepted key
-- tied to its original outcome after cleanup, cooldown, and later demo runs.
CREATE TABLE broker_demo_start_replays (
  visitor_id uuid NOT NULL REFERENCES broker_demo_visitors(id),
  operation_key text NOT NULL,
  requested_kind text NOT NULL CHECK (requested_kind IN ('terminal','studio')),
  requested_name text NOT NULL CHECK (length(requested_name)<=40),
  run_id uuid NOT NULL REFERENCES broker_demo_runs(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(visitor_id,operation_key),
  CHECK (requested_kind='studio' OR requested_name='')
);
