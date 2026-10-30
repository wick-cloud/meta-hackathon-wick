CREATE TABLE broker_inference_buying_policies (
 grant_id uuid PRIMARY KEY REFERENCES broker_inference_grants(id),
 revision integer NOT NULL DEFAULT 1 CHECK(revision>0),
 mode text NOT NULL CHECK(mode IN('suggest','review','automatic')),
 paused boolean NOT NULL DEFAULT false,
 max_purchase_cents numeric(12,2) NOT NULL CHECK(max_purchase_cents BETWEEN 0.01 AND 100000000),
 output_per_call integer NOT NULL CHECK(output_per_call BETWEEN 1 AND 8192),
 target_calls integer NOT NULL CHECK(target_calls BETWEEN 1 AND 8),
 refill_at_calls integer NOT NULL CHECK(refill_at_calls BETWEEN 0 AND 8),
 allow_instant boolean NOT NULL DEFAULT false,
 model_calls integer NOT NULL DEFAULT 0 CHECK(model_calls BETWEEN 0 AND 20),
 last_evaluated_at timestamptz,
 next_evaluation_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX broker_inference_buying_due ON broker_inference_buying_policies(next_evaluation_at,grant_id)
 WHERE mode='automatic' AND NOT paused AND model_calls<20;
CREATE TABLE broker_inference_buying_decisions (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 grant_id uuid NOT NULL REFERENCES broker_inference_grants(id),
 policy_revision integer NOT NULL,
 status text NOT NULL CHECK(status IN('evaluating','recommended','skipped','blocked','failed','superseded','ordered')),
 reason text NOT NULL,
 source_mode text NOT NULL CHECK(source_mode IN('fixture','real')),
 model_called boolean NOT NULL DEFAULT false,
 candidate jsonb,
 baseline jsonb,
 order_id uuid UNIQUE REFERENCES broker_token_orders(id),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 expires_at timestamptz NOT NULL,
 CHECK((status='ordered')=(order_id IS NOT NULL))
);
CREATE INDEX broker_inference_buying_history ON broker_inference_buying_decisions(grant_id,created_at DESC,id DESC);
CREATE UNIQUE INDEX broker_inference_buying_one_proposal ON broker_inference_buying_decisions(grant_id)
 WHERE status IN('evaluating','recommended');
ALTER TABLE broker_token_offerings ADD COLUMN sales_start_at timestamptz;
ALTER TABLE broker_token_offerings ADD COLUMN sales_end_at timestamptz;
ALTER TABLE broker_token_offerings ADD COLUMN muse_proposed_at timestamptz;
ALTER TABLE broker_token_offerings ADD CONSTRAINT broker_token_sales_window
 CHECK((sales_start_at IS NULL AND sales_end_at IS NULL) OR
 (sales_start_at IS NOT NULL AND sales_end_at IS NOT NULL AND sales_start_at<sales_end_at));
