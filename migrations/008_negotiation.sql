-- Buyer-owned nonbinding desired requirements never enter the provisioning queue.
CREATE TABLE broker_intents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  buyer_id text NOT NULL,
  operation_key text NOT NULL CHECK(length(operation_key) BETWEEN 8 AND 160),
  description text NOT NULL,
  desired jsonb NOT NULL,
  flexibility jsonb NOT NULL,
  source_mode text NOT NULL CHECK(source_mode IN ('fixture','real')),
  source_request_id uuid UNIQUE REFERENCES broker_requests(id),
  status text NOT NULL DEFAULT 'open' CHECK(status IN ('open','accepted','resolved')),
  accepted_offer_id uuid,
  accepted_request_id uuid REFERENCES broker_requests(id),
  acceptance_key text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(buyer_id,operation_key)
);
CREATE INDEX broker_intents_buyer_page ON broker_intents(buyer_id,created_at DESC,id DESC);
CREATE INDEX broker_intents_demand ON broker_intents(source_mode,created_at DESC) WHERE status='open';
CREATE TABLE broker_counteroffers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  intent_id uuid NOT NULL REFERENCES broker_intents(id),
  provider_id uuid NOT NULL REFERENCES broker_providers(id),
  offering_id uuid NOT NULL REFERENCES broker_offerings(id),
  candidate_key text NOT NULL,
  snapshot jsonb NOT NULL,
  mode text NOT NULL CHECK(mode IN ('fixture','real')),
  model_called boolean NOT NULL,
  expires_at timestamptz NOT NULL DEFAULT now()+interval '5 minutes',
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(intent_id,candidate_key)
);
ALTER TABLE broker_intents ADD CONSTRAINT broker_intents_offer_fk FOREIGN KEY(accepted_offer_id) REFERENCES broker_counteroffers(id);
ALTER TABLE broker_requests ADD COLUMN resolution_request_id uuid REFERENCES broker_requests(id);
ALTER TABLE broker_requests ADD COLUMN negotiation_intent_id uuid UNIQUE REFERENCES broker_intents(id);
-- Existing request specs and original drafts remain immutable; resolutions are separate metadata.
CREATE FUNCTION broker_immutable_intent() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF (NEW.buyer_id,NEW.operation_key,NEW.description,NEW.desired,NEW.flexibility,NEW.source_mode,NEW.source_request_id,NEW.created_at)
 IS DISTINCT FROM (OLD.buyer_id,OLD.operation_key,OLD.description,OLD.desired,OLD.flexibility,OLD.source_mode,OLD.source_request_id,OLD.created_at) THEN
  RAISE EXCEPTION 'Buyer intent specification is immutable';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER broker_intent_immutable BEFORE UPDATE ON broker_intents FOR EACH ROW EXECUTE FUNCTION broker_immutable_intent();
