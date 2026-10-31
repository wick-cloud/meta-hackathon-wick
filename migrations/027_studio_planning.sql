ALTER TABLE broker_studio_tasks ADD COLUMN plan_attempt integer NOT NULL DEFAULT 0 CHECK(plan_attempt BETWEEN 0 AND 1);
CREATE TABLE broker_studio_plan_attempts (
 task_id uuid NOT NULL REFERENCES broker_studio_tasks(id),
 attempt integer NOT NULL CHECK(attempt BETWEEN 0 AND 1),
 request_id uuid UNIQUE REFERENCES broker_inference_requests(id),
 response_cipher text,
 finish_reason text CHECK(length(finish_reason)<=80),
 failure_code text,
 started_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 completed_at timestamptz,
 PRIMARY KEY(task_id,attempt)
);
