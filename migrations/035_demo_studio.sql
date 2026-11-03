ALTER TABLE broker_demo_runs ADD COLUMN kind text NOT NULL DEFAULT 'terminal'
  CHECK (kind IN ('terminal','studio'));
CREATE FUNCTION broker_demo_kind_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.kind IS DISTINCT FROM OLD.kind THEN RAISE EXCEPTION 'Demo kind is immutable'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER broker_demo_kind_immutable BEFORE UPDATE ON broker_demo_runs
  FOR EACH ROW EXECUTE FUNCTION broker_demo_kind_immutable();

CREATE TABLE broker_demo_studio (
  run_id uuid PRIMARY KEY REFERENCES broker_demo_runs(id),
  status text NOT NULL DEFAULT 'waiting' CHECK (status IN ('waiting','generating','running','passed','needs_attention')),
  attempt smallint NOT NULL DEFAULT 0 CHECK (attempt IN (0,1)),
  source_cipher text,
  result_cipher text,
  code_sha256 text CHECK (code_sha256 IS NULL OR code_sha256 ~ '^[a-f0-9]{64}$'),
  execution_started_at timestamptz,
  execution_completed_at timestamptz,
  verified_at timestamptz,
  failure_code text,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (status<>'passed' OR (verified_at IS NOT NULL AND execution_completed_at IS NOT NULL AND result_cipher IS NOT NULL))
);
CREATE TABLE broker_demo_studio_attempts (
  run_id uuid NOT NULL REFERENCES broker_demo_studio(run_id),
  attempt smallint NOT NULL CHECK (attempt IN (0,1)),
  request_id uuid UNIQUE REFERENCES broker_inference_requests(id),
  response_cipher text,
  finish_reason text,
  failure_code text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  completed_at timestamptz,
  PRIMARY KEY(run_id,attempt)
);

-- A guided demo is a distinct internal authority, never a coding job, full Studio task, or API key.
ALTER TABLE broker_inference_requests ADD COLUMN source_demo_run_id uuid REFERENCES broker_demo_runs(id);
ALTER TABLE broker_inference_requests DROP CONSTRAINT broker_inference_request_authority;
ALTER TABLE broker_inference_requests ADD CONSTRAINT broker_inference_request_authority
  CHECK (num_nonnulls(source_key_id,source_job_id,source_task_id,source_demo_run_id)=1);
