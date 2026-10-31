CREATE TABLE broker_studio_tasks (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), buyer_id text NOT NULL REFERENCES "user"(id),
 grant_id uuid NOT NULL UNIQUE REFERENCES broker_inference_grants(id),
 operation_key text NOT NULL, input_fingerprint text NOT NULL,
 repository_url text NOT NULL, commit_sha text NOT NULL CHECK(commit_sha ~ '^[a-f0-9]{40}$'),
 base_ref text NOT NULL, goal text NOT NULL, test_command text,
 source_mode text NOT NULL CHECK(source_mode IN('fixture','real')),
 status text NOT NULL DEFAULT 'queued' CHECK(status IN('queued','model_auction','planning','compute_auction','provisioning','running','verifying','cleaning_up','needs_budget','needs_attention','completed','failed','stopped')),
 outcome text CHECK(outcome IN('completed','failed','stopped')), stop_requested boolean NOT NULL DEFAULT false,
 allow_instant boolean NOT NULL DEFAULT true, duration_minutes integer NOT NULL CHECK(duration_minutes IN(15,30,60)),
 deadline_at timestamptz NOT NULL, blocked_reason text,
 plan_cipher text, plan_input_cipher text, plan_dispatch_started_at timestamptz,
 plan_request_id uuid REFERENCES broker_inference_requests(id),
 model_order_id uuid REFERENCES broker_token_orders(id), purchase_round integer NOT NULL DEFAULT 0 CHECK(purchase_round BETWEEN 0 AND 20),
 model_output integer NOT NULL CHECK(model_output BETWEEN 128 AND 8192),
 vm_request_id uuid REFERENCES broker_requests(id), coding_job_id uuid REFERENCES broker_coding_jobs(id),
 compute_reserved_cents numeric(16,2) NOT NULL DEFAULT 0 CHECK(compute_reserved_cents>=0),
 compute_charged_cents numeric(16,2) NOT NULL DEFAULT 0 CHECK(compute_charged_cents>=0),
 execution_started_at timestamptz, verified_at timestamptz, completed_at timestamptz,
 patch_cipher text, result_summary text,
 action_retries integer NOT NULL DEFAULT 0 CHECK(action_retries BETWEEN 0 AND 2),
 lease_token uuid, lease_until timestamptz, next_tick_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 artifacts_expire_at timestamptz NOT NULL DEFAULT clock_timestamp()+interval '24 hours', artifacts_purged_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(), updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(buyer_id,operation_key), CHECK(compute_reserved_cents=trunc(compute_reserved_cents,2))
);
CREATE INDEX broker_studio_owner_page ON broker_studio_tasks(buyer_id,created_at DESC,id DESC);
CREATE INDEX broker_studio_due ON broker_studio_tasks(next_tick_at,id) WHERE status NOT IN('completed','failed','stopped');
CREATE INDEX broker_studio_artifacts ON broker_studio_tasks(artifacts_expire_at,id) WHERE artifacts_purged_at IS NULL;
CREATE TABLE broker_studio_events (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), task_id uuid NOT NULL REFERENCES broker_studio_tasks(id),
 event_key text NOT NULL, kind text NOT NULL, title text NOT NULL, message text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(), UNIQUE(task_id,event_key)
);
CREATE INDEX broker_studio_event_page ON broker_studio_events(task_id,created_at DESC,id DESC);
ALTER TABLE broker_requests ADD COLUMN studio_task_id uuid UNIQUE REFERENCES broker_studio_tasks(id);
ALTER TABLE broker_coding_jobs ADD COLUMN studio_task_id uuid UNIQUE REFERENCES broker_studio_tasks(id);
ALTER TABLE broker_inference_requests ADD COLUMN source_task_id uuid REFERENCES broker_studio_tasks(id);
ALTER TABLE broker_inference_requests DROP CONSTRAINT broker_inference_request_authority;
ALTER TABLE broker_inference_requests ADD CONSTRAINT broker_inference_request_authority CHECK(num_nonnulls(source_key_id,source_job_id,source_task_id)=1);
ALTER TABLE broker_credit_ledger DROP CONSTRAINT broker_credit_ledger_kind_check;
ALTER TABLE broker_credit_ledger ADD CONSTRAINT broker_credit_ledger_kind_check CHECK(kind IN('grant','reserve','book','settle','release','failed_start_credit','agent_fund','token_purchase','agent_release','token_refund','studio_compute'));
ALTER TABLE broker_coding_jobs DROP CONSTRAINT broker_coding_jobs_max_calls_check;
ALTER TABLE broker_coding_jobs ADD CONSTRAINT broker_coding_jobs_max_calls_check CHECK(max_calls BETWEEN 1 AND 64);
ALTER TABLE broker_coding_jobs DROP CONSTRAINT broker_coding_jobs_model_calls_check;
ALTER TABLE broker_coding_jobs ADD CONSTRAINT broker_coding_jobs_model_calls_check CHECK(model_calls BETWEEN 0 AND 64);
ALTER TABLE broker_coding_jobs DROP CONSTRAINT broker_coding_jobs_max_output_tokens_check;
ALTER TABLE broker_coding_jobs ADD CONSTRAINT broker_coding_jobs_max_output_tokens_check CHECK(max_output_tokens BETWEEN 128 AND 8192);
ALTER TABLE broker_coding_jobs DROP CONSTRAINT broker_coding_jobs_next_step_check;
ALTER TABLE broker_coding_jobs ADD CONSTRAINT broker_coding_jobs_next_step_check CHECK(next_step BETWEEN 0 AND 256);
ALTER TABLE broker_coding_steps DROP CONSTRAINT broker_coding_steps_sequence_check;
ALTER TABLE broker_coding_steps ADD CONSTRAINT broker_coding_steps_sequence_check CHECK(sequence BETWEEN 0 AND 255);

ALTER TABLE broker_coding_steps ADD COLUMN action text;
CREATE INDEX broker_coding_step_action ON broker_coding_steps(job_id,action,sequence DESC) WHERE status='completed';
