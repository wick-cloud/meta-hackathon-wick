CREATE TABLE broker_credit_wallets (
  buyer_id text PRIMARY KEY,
  balance_cents bigint NOT NULL DEFAULT 0 CHECK(balance_cents BETWEEN 0 AND 1000000000000),
  reserved_cents bigint NOT NULL DEFAULT 0 CHECK(reserved_cents>=0 AND reserved_cents<=balance_cents),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE broker_agreements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), buyer_id text NOT NULL,
  operation_key text NOT NULL, input_fingerprint text NOT NULL,
  description text NOT NULL, specification jsonb NOT NULL,
  status text NOT NULL DEFAULT 'open' CHECK(status IN('open','approved','expired','cancelled')),
  target_quantity integer NOT NULL CHECK(target_quantity BETWEEN 1 AND 20),
  minimum_quantity integer NOT NULL CHECK(minimum_quantity BETWEEN 1 AND target_quantity),
  starts_at timestamptz NOT NULL, expires_at timestamptz NOT NULL CHECK(expires_at>starts_at),
  time_zone text NOT NULL, source_mode text NOT NULL CHECK(source_mode IN('fixture','real')),
  max_amount_cents bigint NOT NULL CHECK(max_amount_cents BETWEEN 1 AND 100000000),
  reserved_cents bigint NOT NULL DEFAULT 0 CHECK(reserved_cents>=0),
  committed_cents bigint NOT NULL DEFAULT 0 CHECK(committed_cents>=0),
  settled_cents bigint NOT NULL DEFAULT 0 CHECK(settled_cents>=0),
  adjustment_cents bigint NOT NULL DEFAULT 0 CHECK(adjustment_cents>=0),
  accepting_topups boolean NOT NULL DEFAULT true,
  blocked_reason text, blocked_code text CHECK(blocked_code IN('needs_credit','awaiting_capacity','deadline_unsupported')),
  next_match_at timestamptz NOT NULL DEFAULT now(), created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(buyer_id,operation_key)
);
CREATE INDEX broker_agreements_buyer_page ON broker_agreements(buyer_id,created_at DESC,id DESC);
CREATE INDEX broker_agreements_due ON broker_agreements(next_match_at,id) WHERE status IN('open','approved') AND accepting_topups;
CREATE INDEX broker_agreements_release_due ON broker_agreements(next_match_at,id,expires_at) WHERE status IN('open','approved') OR(status='expired' AND reserved_cents>0);
CREATE TABLE broker_credit_ledger (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), buyer_id text NOT NULL,
  agreement_id uuid REFERENCES broker_agreements(id), operation_key text NOT NULL,
  kind text NOT NULL CHECK(kind IN('grant','reserve','book','settle','release','failed_start_credit')),
  amount_cents bigint NOT NULL, reserved_delta_cents bigint NOT NULL,
  description text NOT NULL, input_fingerprint text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(buyer_id,operation_key)
);
CREATE INDEX broker_credit_ledger_buyer_page ON broker_credit_ledger(buyer_id,created_at DESC,id DESC);
CREATE TABLE broker_agreement_windows (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), agreement_id uuid NOT NULL REFERENCES broker_agreements(id),
  starts_at timestamptz NOT NULL, discount_ends_at timestamptz NOT NULL, ends_at timestamptz NOT NULL,
  approved_quantity integer NOT NULL DEFAULT 0 CHECK(approved_quantity BETWEEN 0 AND 20),
  committed_cents bigint NOT NULL DEFAULT 0 CHECK(committed_cents>=0),
  adjustment_cents bigint NOT NULL DEFAULT 0 CHECK(adjustment_cents>=0),
  settled_cents bigint NOT NULL DEFAULT 0 CHECK(settled_cents>=0), settled_at timestamptz,
  CHECK(starts_at<discount_ends_at AND discount_ends_at<=ends_at), UNIQUE(agreement_id,starts_at)
);
CREATE INDEX broker_agreement_windows_due ON broker_agreement_windows(ends_at,id) WHERE settled_at IS NULL;
CREATE TABLE broker_scheduled_offerings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), provider_id uuid NOT NULL REFERENCES broker_providers(id),
  operation_key text NOT NULL, input_fingerprint text NOT NULL,
  catalog_id text NOT NULL REFERENCES broker_catalog(id), name text NOT NULL,
  kind text NOT NULL CHECK(kind IN('discount_schedule','capacity_window')),
  time_zone text NOT NULL, weekdays integer[] NOT NULL CHECK(cardinality(weekdays) BETWEEN 1 AND 7),
  window_start text NOT NULL, window_end text NOT NULL, available_until text NOT NULL,
  capacity_quantity integer NOT NULL CHECK(capacity_quantity BETWEEN 1 AND 20),
  discount_rate_cents_per_hour integer NOT NULL CHECK(discount_rate_cents_per_hour BETWEEN 1 AND 100000000),
  normal_rate_cents_per_hour integer NOT NULL CHECK(normal_rate_cents_per_hour BETWEEN 1 AND 100000000),
  active boolean NOT NULL DEFAULT true, revision integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(provider_id,operation_key)
);
CREATE INDEX broker_scheduled_offerings_provider_page ON broker_scheduled_offerings(provider_id,created_at DESC,id DESC);
CREATE INDEX broker_scheduled_offerings_candidates ON broker_scheduled_offerings(catalog_id,provider_id) WHERE active;
CREATE TABLE broker_agreement_bookings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), agreement_id uuid NOT NULL REFERENCES broker_agreements(id),
  window_id uuid NOT NULL REFERENCES broker_agreement_windows(id),
  provider_id uuid NOT NULL REFERENCES broker_providers(id),
  scheduled_offering_id uuid NOT NULL REFERENCES broker_scheduled_offerings(id),
  catalog_id text NOT NULL REFERENCES broker_catalog(id), snapshot jsonb NOT NULL,
  quantity integer NOT NULL CHECK(quantity BETWEEN 1 AND 20),
  unit_price_cents integer NOT NULL CHECK(unit_price_cents>0),
  starts_at timestamptz NOT NULL, discount_ends_at timestamptz NOT NULL, ends_at timestamptz NOT NULL,
  adjustment_cents bigint NOT NULL DEFAULT 0 CHECK(adjustment_cents>=0),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK(starts_at<discount_ends_at AND discount_ends_at<=ends_at),
  UNIQUE(window_id,scheduled_offering_id)
);
CREATE INDEX broker_agreement_bookings_provider ON broker_agreement_bookings(provider_id,starts_at,id);
CREATE INDEX broker_agreement_bookings_window ON broker_agreement_bookings(window_id,id);
CREATE INDEX broker_agreement_bookings_interval ON broker_agreement_bookings USING gist(tstzrange(starts_at,ends_at,'[)'));
CREATE TABLE broker_agreement_actions (
  agreement_id uuid NOT NULL REFERENCES broker_agreements(id), operation_key text NOT NULL,
  kind text NOT NULL, input_fingerprint text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(agreement_id,operation_key)
);
CREATE TABLE broker_agreement_activations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), agreement_id uuid NOT NULL REFERENCES broker_agreements(id),
  window_id uuid NOT NULL REFERENCES broker_agreement_windows(id), booking_id uuid NOT NULL REFERENCES broker_agreement_bookings(id),
  slot_index integer NOT NULL CHECK(slot_index BETWEEN 1 AND 20),
  operation_key text NOT NULL, item_number integer NOT NULL CHECK(item_number BETWEEN 1 AND 20),
  status text NOT NULL DEFAULT 'provisioning' CHECK(status IN('provisioning','running','terminating','terminated','failed')),
  request_id uuid UNIQUE REFERENCES broker_requests(id), vm_id uuid UNIQUE REFERENCES broker_vms(id),
  ends_at timestamptz NOT NULL, first_ready_at timestamptz, cleaned_at timestamptz,
  failure_reason text, created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(agreement_id,operation_key,item_number)
);
CREATE UNIQUE INDEX broker_agreement_activation_slot ON broker_agreement_activations(booking_id,slot_index) WHERE cleaned_at IS NULL;
CREATE INDEX broker_agreement_activations_window ON broker_agreement_activations(window_id,status,id);
CREATE INDEX broker_agreement_activations_pending ON broker_agreement_activations(agreement_id,id) WHERE cleaned_at IS NULL;
CREATE INDEX broker_agreement_activations_page ON broker_agreement_activations(agreement_id,(cleaned_at IS NULL) DESC,created_at DESC,id DESC);
CREATE INDEX broker_agreement_activations_delivered ON broker_agreement_activations(booking_id,slot_index) WHERE first_ready_at IS NOT NULL;
CREATE TABLE broker_agreement_adjustments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), agreement_id uuid NOT NULL REFERENCES broker_agreements(id),
  window_id uuid NOT NULL REFERENCES broker_agreement_windows(id), booking_id uuid NOT NULL REFERENCES broker_agreement_bookings(id),
  slot_index integer NOT NULL, activation_id uuid NOT NULL UNIQUE REFERENCES broker_agreement_activations(id),
  amount_cents integer NOT NULL CHECK(amount_cents>0), created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(booking_id,slot_index)
);
CREATE TABLE broker_agreement_charges (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), booking_id uuid NOT NULL UNIQUE REFERENCES broker_agreement_bookings(id),
  agreement_id uuid NOT NULL REFERENCES broker_agreements(id), window_id uuid NOT NULL REFERENCES broker_agreement_windows(id),
  buyer_id text NOT NULL, provider_id uuid NOT NULL REFERENCES broker_providers(id),
  gross_cents bigint NOT NULL, credit_cents bigint NOT NULL, total_cents bigint NOT NULL,
  revenue_share jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  CHECK(total_cents=gross_cents-credit_cents AND total_cents>=0)
);
CREATE INDEX broker_agreement_charges_buyer ON broker_agreement_charges(buyer_id,created_at DESC,id DESC);
ALTER TABLE broker_requests ADD COLUMN agreement_id uuid REFERENCES broker_agreements(id);
ALTER TABLE broker_requests ADD COLUMN agreement_activation_id uuid UNIQUE REFERENCES broker_agreement_activations(id);
ALTER TABLE broker_requests DROP CONSTRAINT broker_requests_duration_minutes_check;
ALTER TABLE broker_requests ADD CONSTRAINT broker_requests_duration_minutes_check CHECK(
 (agreement_id IS NULL AND duration_minutes IN(15,30,60)) OR (agreement_id IS NOT NULL AND duration_minutes BETWEEN 1 AND 1440)
);
