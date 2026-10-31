CREATE TABLE broker_coding_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  buyer_id text NOT NULL REFERENCES "user"(id),
  vm_id uuid NOT NULL REFERENCES broker_vms(id),
  grant_id uuid NOT NULL REFERENCES broker_inference_grants(id),
  environment_id text NOT NULL,
  operation_key text NOT NULL,
  input_fingerprint text NOT NULL,
  repository_url text NOT NULL,
  commit_sha text NOT NULL CHECK(commit_sha ~ '^[a-f0-9]{40}$'),
  base_ref text NOT NULL,
  goal text NOT NULL,
  test_command text NOT NULL,
  source_mode text NOT NULL CHECK(source_mode IN('fixture','real')),
  status text NOT NULL DEFAULT 'queued' CHECK(status IN('queued','running','paused','needs_allowance','uncertain','stopping','stopped','failed','ready')),
  requested_action text CHECK(requested_action IN('pause','stop')),
  blocked_reason text,
  deadline_at timestamptz NOT NULL,
  max_calls integer NOT NULL DEFAULT 8 CHECK(max_calls BETWEEN 1 AND 8),
  max_output_tokens integer NOT NULL DEFAULT 512 CHECK(max_output_tokens BETWEEN 128 AND 512),
  model_calls integer NOT NULL DEFAULT 0 CHECK(model_calls BETWEEN 0 AND 8),
  next_step integer NOT NULL DEFAULT 0 CHECK(next_step BETWEEN 0 AND 24),
  tests_passed boolean NOT NULL DEFAULT false,
  lease_token uuid,
  lease_until timestamptz,
  artifacts_expire_at timestamptz NOT NULL DEFAULT now()+interval '24 hours',
  artifacts_purged_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(buyer_id,operation_key)
);
CREATE UNIQUE INDEX broker_coding_vm_active ON broker_coding_jobs(vm_id)
  WHERE status NOT IN('stopped','failed','ready');
CREATE INDEX broker_coding_buyer_page ON broker_coding_jobs(buyer_id,created_at DESC,id DESC);
CREATE INDEX broker_coding_work ON broker_coding_jobs(status,lease_until,created_at,id)
  WHERE status IN('queued','running','stopping');
CREATE INDEX broker_coding_expiry ON broker_coding_jobs(deadline_at,id)
  WHERE status NOT IN('stopped','failed','ready','uncertain');
CREATE TABLE broker_coding_steps (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id uuid NOT NULL REFERENCES broker_coding_jobs(id),
  sequence integer NOT NULL CHECK(sequence BETWEEN 0 AND 24),
  kind text NOT NULL CHECK(kind IN('command','model')),
  status text NOT NULL DEFAULT 'pending' CHECK(status IN('pending','dispatching','completed','uncertain','rejected')),
  payload_cipher text NOT NULL,
  result_cipher text,
  inference_request_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  UNIQUE(job_id,sequence)
);
CREATE INDEX broker_coding_step_pending ON broker_coding_steps(job_id,sequence)
  WHERE status IN('dispatching','uncertain');
ALTER TABLE broker_inference_requests ALTER COLUMN source_key_id DROP NOT NULL;
ALTER TABLE broker_inference_requests ADD COLUMN source_job_id uuid REFERENCES broker_coding_jobs(id);
ALTER TABLE broker_inference_requests ADD CONSTRAINT broker_inference_request_authority
  CHECK((source_key_id IS NOT NULL)<>(source_job_id IS NOT NULL));
ALTER TABLE broker_coding_steps ADD CONSTRAINT broker_coding_step_receipt
  FOREIGN KEY(inference_request_id) REFERENCES broker_inference_requests(id);
CREATE INDEX broker_coding_artifact_expiry ON broker_coding_jobs(artifacts_expire_at,id) WHERE artifacts_purged_at IS NULL;
