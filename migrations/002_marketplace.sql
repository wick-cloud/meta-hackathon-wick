CREATE TABLE broker_catalog (
  id text PRIMARY KEY,
  item jsonb NOT NULL,
  approved boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE broker_providers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id text NOT NULL UNIQUE,
  name text NOT NULL,
  total_capacity integer NOT NULL CHECK(total_capacity BETWEEN 0 AND 10000),
  policy jsonb NOT NULL,
  simulated boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE broker_offerings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_id uuid NOT NULL REFERENCES broker_providers(id),
  catalog_id text NOT NULL REFERENCES broker_catalog(id),
  name text NOT NULL,
  description text NOT NULL,
  price_cents integer NOT NULL CHECK(price_cents BETWEEN 0 AND 100000000),
  revision integer NOT NULL DEFAULT 1,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(provider_id,catalog_id,name)
);
CREATE TABLE broker_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  buyer_id text NOT NULL,
  description text NOT NULL,
  catalog_id text NOT NULL REFERENCES broker_catalog(id),
  catalog_snapshot jsonb NOT NULL,
  region text NOT NULL,
  duration_minutes integer NOT NULL CHECK(duration_minutes IN (15,30,60)),
  max_price_cents integer NOT NULL CHECK(max_price_cents BETWEEN 0 AND 100000000),
  requirements jsonb NOT NULL,
  status text NOT NULL DEFAULT 'open' CHECK(status IN ('open','provisioning','ready','no_offers','failed','cancelled')),
  closes_at timestamptz NOT NULL DEFAULT now() + interval '30 seconds',
  winning_bid_id uuid,
  failure_reason text,
  prior_request_id uuid REFERENCES broker_requests(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX broker_requests_buyer_page ON broker_requests(buyer_id,created_at DESC,id DESC);
CREATE INDEX broker_requests_unmatched ON broker_requests(created_at DESC,id DESC) WHERE status='no_offers';
CREATE INDEX broker_requests_open ON broker_requests(closes_at) WHERE status='open';
CREATE TABLE broker_bids (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id uuid NOT NULL REFERENCES broker_requests(id),
  provider_id uuid NOT NULL REFERENCES broker_providers(id),
  offering_id uuid NOT NULL REFERENCES broker_offerings(id),
  offering_snapshot jsonb NOT NULL,
  total_price_cents integer NOT NULL CHECK(total_price_cents BETWEEN 0 AND 100000000),
  status text NOT NULL DEFAULT 'held' CHECK(status IN ('held','won','lost','cancelled')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(request_id,provider_id)
);
ALTER TABLE broker_requests ADD CONSTRAINT broker_requests_winning_bid_fk FOREIGN KEY(winning_bid_id) REFERENCES broker_bids(id);
CREATE INDEX broker_bids_winner ON broker_bids(request_id,total_price_cents,created_at,id);
CREATE TABLE broker_holds (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bid_id uuid NOT NULL UNIQUE REFERENCES broker_bids(id),
  provider_id uuid NOT NULL REFERENCES broker_providers(id),
  released_at timestamptz,
  release_reason text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX broker_holds_active ON broker_holds(provider_id) WHERE released_at IS NULL;
CREATE TABLE broker_vms (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id uuid NOT NULL UNIQUE REFERENCES broker_requests(id),
  buyer_id text NOT NULL,
  provider_id uuid NOT NULL REFERENCES broker_providers(id),
  bid_id uuid NOT NULL UNIQUE REFERENCES broker_bids(id),
  status text NOT NULL DEFAULT 'provisioning' CHECK(status IN ('provisioning','running','terminating','terminated','failed','expired')),
  environment_id text UNIQUE,
  create_key text NOT NULL UNIQUE,
  create_input jsonb NOT NULL,
  catalog_snapshot jsonb NOT NULL,
  quote_snapshot jsonb NOT NULL,
  admitted_at timestamptz,
  expires_at timestamptz,
  ready_at timestamptz,
  cleanup_confirmed_at timestamptz,
  termination_requested_at timestamptz,
  failure_reason text,
  poll_attempts integer NOT NULL DEFAULT 0,
  cleanup_attempts integer NOT NULL DEFAULT 0,
  lease_until timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX broker_vms_buyer_page ON broker_vms(buyer_id,created_at DESC,id DESC);
CREATE INDEX broker_vms_active ON broker_vms(status,expires_at) WHERE cleanup_confirmed_at IS NULL;
CREATE TABLE broker_invoices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  vm_id uuid NOT NULL UNIQUE REFERENCES broker_vms(id),
  buyer_id text NOT NULL,
  provider_id uuid NOT NULL REFERENCES broker_providers(id),
  subtotal_cents integer NOT NULL CHECK(subtotal_cents>=0),
  fee_cents integer NOT NULL DEFAULT 0 CHECK(fee_cents=0),
  total_cents integer NOT NULL CHECK(total_cents=subtotal_cents+fee_cents),
  currency text NOT NULL DEFAULT 'USD' CHECK(currency='USD'),
  status text NOT NULL DEFAULT 'demo' CHECK(status='demo'),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX broker_invoices_buyer_page ON broker_invoices(buyer_id,created_at DESC,id DESC);
CREATE TABLE broker_activity (
  id bigserial PRIMARY KEY,
  provider_id uuid REFERENCES broker_providers(id),
  request_id uuid REFERENCES broker_requests(id),
  kind text NOT NULL,
  message text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX broker_activity_provider_page ON broker_activity(provider_id,id DESC);
CREATE TABLE broker_settings (key text PRIMARY KEY,value jsonb NOT NULL);
-- The environment specification is immutable after admission to an auction.
CREATE FUNCTION broker_immutable_request() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.buyer_id,NEW.description,NEW.catalog_id,NEW.catalog_snapshot,NEW.region,NEW.duration_minutes,NEW.max_price_cents,NEW.requirements,NEW.closes_at,NEW.created_at)
     IS DISTINCT FROM
     (OLD.buyer_id,OLD.description,OLD.catalog_id,OLD.catalog_snapshot,OLD.region,OLD.duration_minutes,OLD.max_price_cents,OLD.requirements,OLD.closes_at,OLD.created_at) THEN
    RAISE EXCEPTION 'Environment request specification is immutable';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER broker_request_immutable BEFORE UPDATE ON broker_requests FOR EACH ROW EXECUTE FUNCTION broker_immutable_request();
