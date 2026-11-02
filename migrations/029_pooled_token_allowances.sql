-- A request may reserve independently conserved quota from compatible prepaid packs.
-- Legacy requests have no rows and retain their original single-pack allocation.
CREATE TABLE broker_inference_allocations (
 request_id uuid NOT NULL REFERENCES broker_inference_requests(id),
 pack_id uuid NOT NULL REFERENCES broker_token_packs(id),
 allocation_order smallint NOT NULL CHECK(allocation_order BETWEEN 0 AND 9),
 reserved_input integer NOT NULL CHECK(reserved_input>=0),
 reserved_output integer NOT NULL CHECK(reserved_output>=0),
 input_tokens integer CHECK(input_tokens>=0 AND input_tokens<=reserved_input),
 output_tokens integer CHECK(output_tokens>=0 AND output_tokens<=reserved_output),
 PRIMARY KEY(request_id,pack_id), UNIQUE(request_id,allocation_order),
 CHECK(reserved_input>0 OR reserved_output>0),
 CHECK((input_tokens IS NULL)=(output_tokens IS NULL))
);
CREATE INDEX broker_inference_allocations_pack ON broker_inference_allocations(pack_id,request_id);
ALTER TABLE broker_token_orders
 ADD COLUMN provider_constraint text REFERENCES broker_inference_routes(provider),
 ADD COLUMN required_input integer CHECK(required_input>0),
 ADD COLUMN required_output integer CHECK(required_output>0),
 ADD COLUMN required_routes jsonb CHECK(required_routes IS NULL OR(jsonb_typeof(required_routes)='array' AND jsonb_array_length(required_routes) BETWEEN 1 AND 2)),
 ADD CONSTRAINT broker_token_order_requirement CHECK((required_input IS NULL)=(required_output IS NULL));
ALTER TABLE broker_studio_usage_estimates
 ADD COLUMN required_provider text REFERENCES broker_inference_routes(provider),
 ADD COLUMN required_routes jsonb CHECK(required_routes IS NULL OR(jsonb_typeof(required_routes)='array' AND jsonb_array_length(required_routes) BETWEEN 1 AND 2)),
 ADD COLUMN existing_input bigint NOT NULL DEFAULT 0 CHECK(existing_input>=0),
 ADD COLUMN existing_output bigint NOT NULL DEFAULT 0 CHECK(existing_output>=0);

CREATE INDEX broker_token_packs_legacy_residual ON broker_token_packs(grant_id,expires_at,id)
 WHERE status='settled' AND retirement_reason='quota_exhausted' AND(retired_input>0 OR retired_output>0);

-- Restore quota retired solely because one dimension could not admit a call.
-- No funding, accepted price, expiry, consumed usage or refund is changed.
-- Lock in the same grant -> routes -> packs order as allocation and retirement.
SELECT id FROM broker_inference_grants
 WHERE status='active' AND expires_at>clock_timestamp()
 AND EXISTS(SELECT 1 FROM broker_token_packs p WHERE p.grant_id=broker_inference_grants.id
   AND p.status='settled' AND p.retirement_reason='quota_exhausted'
   AND p.expires_at>clock_timestamp() AND p.refund_cents=0
   AND p.held_input=0 AND p.held_output=0 AND p.available_input=0 AND p.available_output=0 AND (p.retired_input>0 OR p.retired_output>0))
 ORDER BY id FOR UPDATE;
SELECT provider FROM broker_inference_routes ORDER BY provider FOR UPDATE;
WITH eligible AS (
 SELECT p.id,p.grant_id,row_number() OVER(PARTITION BY p.grant_id ORDER BY p.expires_at,p.id) rank,
   (SELECT count(*) FROM broker_token_packs unsettled WHERE unsettled.grant_id=p.grant_id AND unsettled.status<>'settled') existing
 FROM broker_token_packs p
 JOIN broker_inference_grants g ON g.id=p.grant_id
 JOIN broker_inference_routes r ON r.provider=p.provider
 WHERE g.status='active' AND g.expires_at>clock_timestamp()
   AND g.allowed_providers ? p.provider
   AND p.status='settled' AND p.retirement_reason='quota_exhausted'
   AND p.expires_at>clock_timestamp() AND p.refund_cents=0
   AND p.held_input=0 AND p.held_output=0 AND p.available_input=0 AND p.available_output=0 AND (p.retired_input>0 OR p.retired_output>0)
   AND r.qualified AND r.quarantined_at IS NULL AND r.provider_id=p.provider_id
   AND r.source_mode=p.source_mode AND g.source_mode=p.source_mode
   AND r.fingerprint=p.route_fingerprint
), restored AS (
 UPDATE broker_token_packs p
 SET available_input=p.available_input+p.retired_input,
     available_output=p.available_output+p.retired_output,
     retired_input=0,retired_output=0,status='active',retirement_reason=NULL
 FROM broker_inference_grants g,broker_inference_routes r
 WHERE p.grant_id=g.id AND p.provider=r.provider
   AND p.id IN(SELECT id FROM eligible WHERE rank+existing<=10)
   AND g.allowed_providers ? p.provider
   AND g.status='active' AND g.expires_at>clock_timestamp()
   AND p.status='settled' AND p.retirement_reason='quota_exhausted'
   AND p.expires_at>clock_timestamp() AND p.refund_cents=0
   AND p.held_input=0 AND p.held_output=0 AND p.available_input=0 AND p.available_output=0 AND (p.retired_input>0 OR p.retired_output>0)
   AND r.qualified AND r.quarantined_at IS NULL AND r.provider_id=p.provider_id
   AND r.source_mode=p.source_mode AND g.source_mode=p.source_mode
   AND r.fingerprint=p.route_fingerprint
 RETURNING p.id,p.grant_id,p.provider,p.available_input,p.available_output
), totals AS (
 SELECT provider,sum(available_input) input_tokens,sum(available_output) output_tokens
 FROM restored GROUP BY provider
), updated AS (
 UPDATE broker_inference_routes r
 SET outstanding_input=r.outstanding_input+t.input_tokens,
     outstanding_output=r.outstanding_output+t.output_tokens
 FROM totals t WHERE r.provider=t.provider RETURNING r.provider
)
INSERT INTO broker_inference_events(grant_id,operation_key,kind,resource_id,details)
 SELECT grant_id,'pool-repair:'||id,'quota_restored',id,
 jsonb_build_object('reason','single_pack_fragmentation','inputTokens',available_input,
                   'outputTokens',available_output,'buyerMoneyChanged',false)
 FROM restored;
