ALTER TABLE broker_studio_tasks ADD COLUMN usage_features jsonb;
CREATE TABLE broker_studio_usage_estimates (
 task_id uuid NOT NULL REFERENCES broker_studio_tasks(id),
 purchase_round integer NOT NULL CHECK(purchase_round BETWEEN 0 AND 20),
 forecast jsonb NOT NULL,
 input_tokens integer NOT NULL CHECK(input_tokens BETWEEN 1 AND 10000000),
 output_tokens integer NOT NULL CHECK(output_tokens BETWEEN 1 AND 10000000),
 input_floor integer NOT NULL CHECK(input_floor BETWEEN 1 AND 10000000),
 output_floor integer NOT NULL CHECK(output_floor BETWEEN 1 AND 8192),
 reservation_limited boolean NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(task_id,purchase_round)
);
-- Numeric observations only; raw prompts, repository contents and model reasoning are excluded.
CREATE TABLE broker_studio_usage_samples (
 task_id uuid PRIMARY KEY REFERENCES broker_studio_tasks(id),
 buyer_id text NOT NULL REFERENCES "user"(id),
 source_mode text NOT NULL CHECK(source_mode IN('fixture','real')),
 model_output integer NOT NULL,
 estimator_version text NOT NULL,
 features jsonb NOT NULL,
 input_tokens bigint NOT NULL CHECK(input_tokens>0),
 output_tokens integer NOT NULL CHECK(output_tokens>0),
 model_calls integer NOT NULL CHECK(model_calls BETWEEN 2 AND 80),
 completed_at timestamptz NOT NULL
);
CREATE INDEX broker_studio_usage_training ON broker_studio_usage_samples(buyer_id,source_mode,model_output,estimator_version,completed_at DESC,task_id DESC);
