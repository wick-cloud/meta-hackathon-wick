CREATE TABLE broker_inference_grants (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), buyer_id text NOT NULL,
 name text NOT NULL CHECK(char_length(name) BETWEEN 1 AND 100),
 status text NOT NULL DEFAULT 'active' CHECK(status IN('active','closing','closed')),
 source_mode text NOT NULL CHECK(source_mode IN('fixture','real')),
 funded_cents bigint NOT NULL CHECK(funded_cents BETWEEN 1 AND 100000000),
 available_cents bigint NOT NULL CHECK(available_cents>=0),
 held_cents bigint NOT NULL DEFAULT 0 CHECK(held_cents>=0),
 spent_cents bigint NOT NULL DEFAULT 0 CHECK(spent_cents>=0),
 returned_cents bigint NOT NULL DEFAULT 0 CHECK(returned_cents>=0),
 max_purchase_cents integer NOT NULL CHECK(max_purchase_cents BETWEEN 1 AND 100000000),
 allowed_providers jsonb NOT NULL CHECK(jsonb_typeof(allowed_providers)='array' AND allowed_providers<@'["modal","baseten"]'::jsonb AND jsonb_array_length(allowed_providers)>0),
 allow_instant boolean NOT NULL DEFAULT true,
 expires_at timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 CHECK(funded_cents=available_cents+held_cents+spent_cents+returned_cents), CHECK(expires_at>created_at)
);
CREATE INDEX broker_inference_grants_owner ON broker_inference_grants(buyer_id,created_at DESC,id DESC);
CREATE INDEX broker_inference_grants_active_owner ON broker_inference_grants(buyer_id) WHERE status<>'closed';
CREATE INDEX broker_inference_grants_due ON broker_inference_grants(expires_at,id) WHERE status='active';
ALTER TABLE broker_api_keys ADD COLUMN grant_id uuid REFERENCES broker_inference_grants(id);
ALTER TABLE broker_api_keys ADD CONSTRAINT broker_agent_key_scopes CHECK(
 (grant_id IS NULL AND NOT(scopes ?| ARRAY['inference:read','inference:use','tokens:buy'])) OR
 (grant_id IS NOT NULL AND issued_role='buyer' AND limits='{}'::jsonb AND
 scopes<@'["account:read","inference:read","inference:use","tokens:buy"]'::jsonb AND
 scopes@>'["account:read","inference:read"]'::jsonb));
CREATE INDEX broker_api_keys_grant ON broker_api_keys(grant_id) WHERE revoked_at IS NULL;
ALTER TABLE broker_credit_ledger ADD COLUMN grant_id uuid REFERENCES broker_inference_grants(id);
ALTER TABLE broker_credit_ledger DROP CONSTRAINT broker_credit_ledger_kind_check;
ALTER TABLE broker_credit_ledger ADD CONSTRAINT broker_credit_ledger_kind_check CHECK(kind IN(
 'grant','reserve','book','settle','release','failed_start_credit',
 'agent_fund','token_purchase','agent_release','token_refund'));

CREATE TABLE broker_inference_routes (
 provider text PRIMARY KEY CHECK(provider IN('modal','baseten')),
 provider_id uuid REFERENCES broker_providers(id) ON DELETE SET NULL,
 source_mode text NOT NULL CHECK(source_mode IN('fixture','real')),
 fingerprint text NOT NULL,
 qualified boolean NOT NULL DEFAULT false, blocked_reason text NOT NULL,
 quarantined_at timestamptz,
 input_bound integer NOT NULL CHECK(input_bound BETWEEN 1 AND 10000000),
 max_output_tokens integer NOT NULL CHECK(max_output_tokens BETWEEN 1 AND 8192),
 max_concurrent integer NOT NULL DEFAULT 2 CHECK(max_concurrent BETWEEN 1 AND 20),
 held_calls integer NOT NULL DEFAULT 0 CHECK(held_calls>=0),
 outstanding_input bigint NOT NULL DEFAULT 0 CHECK(outstanding_input>=0),
 outstanding_output bigint NOT NULL DEFAULT 0 CHECK(outstanding_output>=0),
 cost_input_rate bigint NOT NULL CHECK(cost_input_rate BETWEEN 1 AND 1000000000000),
 cost_output_rate bigint NOT NULL CHECK(cost_output_rate BETWEEN 1 AND 1000000000000),
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE broker_token_offerings (
 provider text PRIMARY KEY REFERENCES broker_inference_routes(provider),
 revision integer NOT NULL DEFAULT 1,
 active boolean NOT NULL DEFAULT true, auto_bid boolean NOT NULL DEFAULT true,
 input_rate bigint NOT NULL CHECK(input_rate BETWEEN 1 AND 1000000000000),
 output_rate bigint NOT NULL CHECK(output_rate BETWEEN 1 AND 1000000000000),
 instant_markup_bps integer NOT NULL DEFAULT 1000 CHECK(instant_markup_bps BETWEEN 0 AND 100000),
 minimum_price_cents integer NOT NULL DEFAULT 1 CHECK(minimum_price_cents BETWEEN 1 AND 100000000),
 max_outstanding_input bigint NOT NULL DEFAULT 10000000 CHECK(max_outstanding_input BETWEEN 1 AND 100000000),
 max_outstanding_output bigint NOT NULL DEFAULT 2000000 CHECK(max_outstanding_output BETWEEN 1 AND 10000000),
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE broker_token_orders (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), grant_id uuid NOT NULL REFERENCES broker_inference_grants(id),
 buyer_id text NOT NULL, source_key_id uuid, operation_key text NOT NULL, input_fingerprint text NOT NULL,
 mode text NOT NULL CHECK(mode IN('auction','instant')),
 source_mode text NOT NULL CHECK(source_mode IN('fixture','real')),
 status text NOT NULL DEFAULT 'open' CHECK(status IN('open','awarded','no_offers','cancelled','expired')),
 input_tokens integer NOT NULL CHECK(input_tokens BETWEEN 1 AND 10000000),
 output_tokens integer NOT NULL CHECK(output_tokens BETWEEN 1 AND 1000000),
 max_total_cents integer NOT NULL CHECK(max_total_cents BETWEEN 1 AND 100000000),
 price_cents integer, provider text REFERENCES broker_inference_routes(provider),
 closes_at timestamptz NOT NULL, expires_at timestamptz NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(grant_id,operation_key)
);
CREATE INDEX broker_token_orders_owner ON broker_token_orders(buyer_id,created_at DESC,id DESC);
CREATE INDEX broker_token_orders_owner_active ON broker_token_orders(buyer_id,created_at DESC,id DESC) WHERE status='open';
CREATE INDEX broker_token_orders_owner_history ON broker_token_orders(buyer_id,created_at DESC,id DESC) WHERE status<>'open';
CREATE INDEX broker_token_orders_owner_attention ON broker_token_orders(buyer_id,created_at DESC,id DESC) WHERE status IN('no_offers','expired');
CREATE INDEX broker_token_orders_grant ON broker_token_orders(grant_id,created_at DESC,id DESC);
CREATE INDEX broker_token_orders_pending ON broker_token_orders(grant_id,id) WHERE status='open';
CREATE INDEX broker_token_orders_due ON broker_token_orders(closes_at,id) WHERE status='open';
CREATE TABLE broker_token_bids (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), order_id uuid NOT NULL REFERENCES broker_token_orders(id),
 provider text NOT NULL REFERENCES broker_inference_routes(provider),
 price_cents integer NOT NULL CHECK(price_cents BETWEEN 1 AND 100000000),
 snapshot jsonb NOT NULL,
 status text NOT NULL DEFAULT 'offered' CHECK(status IN('offered','won','lost')),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(), UNIQUE(order_id,provider)
);
CREATE INDEX broker_token_bids_rank ON broker_token_bids(order_id,price_cents,created_at,id);
CREATE TABLE broker_token_packs (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), order_id uuid NOT NULL UNIQUE REFERENCES broker_token_orders(id),
 grant_id uuid NOT NULL REFERENCES broker_inference_grants(id), buyer_id text NOT NULL,
 provider text NOT NULL REFERENCES broker_inference_routes(provider), provider_id uuid NOT NULL REFERENCES broker_providers(id),
 source_mode text NOT NULL CHECK(source_mode IN('fixture','real')),
 route_fingerprint text NOT NULL, snapshot jsonb NOT NULL,
 status text NOT NULL DEFAULT 'active' CHECK(status IN('active','retiring','settled')),
 input_tokens bigint NOT NULL CHECK(input_tokens>0), output_tokens bigint NOT NULL CHECK(output_tokens>0),
 available_input bigint NOT NULL CHECK(available_input>=0), available_output bigint NOT NULL CHECK(available_output>=0),
 held_input bigint NOT NULL DEFAULT 0 CHECK(held_input>=0), held_output bigint NOT NULL DEFAULT 0 CHECK(held_output>=0),
 consumed_input bigint NOT NULL DEFAULT 0 CHECK(consumed_input>=0), consumed_output bigint NOT NULL DEFAULT 0 CHECK(consumed_output>=0),
 retired_input bigint NOT NULL DEFAULT 0 CHECK(retired_input>=0), retired_output bigint NOT NULL DEFAULT 0 CHECK(retired_output>=0),
 price_cents integer NOT NULL CHECK(price_cents BETWEEN 1 AND 100000000),
 refund_cents integer NOT NULL DEFAULT 0 CHECK(refund_cents>=0 AND refund_cents<=price_cents),
 retirement_reason text, refund_evidence text,
 expires_at timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 CHECK(input_tokens=available_input+held_input+consumed_input+retired_input),
 CHECK(output_tokens=available_output+held_output+consumed_output+retired_output)
);
CREATE INDEX broker_token_packs_grant ON broker_token_packs(grant_id,created_at DESC,id DESC);
CREATE INDEX broker_token_packs_available ON broker_token_packs(grant_id,expires_at,id) WHERE status='active';
CREATE INDEX broker_token_packs_unsettled ON broker_token_packs(grant_id,id) WHERE status<>'settled';
CREATE INDEX broker_token_packs_provider ON broker_token_packs(provider,created_at DESC,id DESC);
CREATE INDEX broker_token_packs_seller ON broker_token_packs(provider_id,created_at DESC,id DESC);
CREATE INDEX broker_token_packs_due ON broker_token_packs(expires_at,id) WHERE status<>'settled';
CREATE TABLE broker_inference_requests (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), grant_id uuid NOT NULL REFERENCES broker_inference_grants(id),
 pack_id uuid NOT NULL REFERENCES broker_token_packs(id), buyer_id text NOT NULL, source_key_id uuid NOT NULL,
 provider text NOT NULL REFERENCES broker_inference_routes(provider), source_mode text NOT NULL CHECK(source_mode IN('fixture','real')),
 operation_key text NOT NULL, input_fingerprint text NOT NULL,
 status text NOT NULL DEFAULT 'reserved' CHECK(status IN('reserved','dispatching','settled','rejected','outcome_unknown','needs_reconciliation')),
 reserved_input integer NOT NULL CHECK(reserved_input>0), reserved_output integer NOT NULL CHECK(reserved_output>0),
 input_tokens integer, output_tokens integer, provider_request_id text, failure_code text,
 usage_evidence text, resolution_actor text,
 dispatch_started_at timestamptz, deadline_at timestamptz NOT NULL,
 completed_at timestamptz, created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 CHECK(input_tokens IS NULL OR input_tokens>=0), CHECK(output_tokens IS NULL OR output_tokens>=0),
 UNIQUE(grant_id,operation_key)
);
CREATE INDEX broker_inference_requests_grant ON broker_inference_requests(grant_id,created_at DESC,id DESC);
CREATE INDEX broker_inference_requests_due ON broker_inference_requests(deadline_at,id) WHERE status IN('reserved','dispatching','outcome_unknown');
CREATE INDEX broker_inference_requests_pack ON broker_inference_requests(pack_id) WHERE status NOT IN('settled','rejected');
CREATE INDEX broker_inference_requests_unresolved ON broker_inference_requests(grant_id,id) WHERE status NOT IN('settled','rejected');
CREATE TABLE broker_inference_events (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), grant_id uuid NOT NULL REFERENCES broker_inference_grants(id),
 operation_key text NOT NULL, kind text NOT NULL, resource_id uuid,
 amount_cents bigint NOT NULL DEFAULT 0, input_tokens bigint NOT NULL DEFAULT 0, output_tokens bigint NOT NULL DEFAULT 0,
 actor_id text, details jsonb NOT NULL DEFAULT '{}', created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(grant_id,operation_key)
);
CREATE INDEX broker_inference_events_page ON broker_inference_events(grant_id,created_at DESC,id DESC);
