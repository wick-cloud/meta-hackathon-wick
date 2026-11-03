CREATE TABLE broker_demo_visitors (
 id uuid PRIMARY KEY,
 secret_digest text NOT NULL UNIQUE CHECK(length(secret_digest)=64),
 buyer_id text NOT NULL UNIQUE REFERENCES "user"(id),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE broker_demo_days (
 day date PRIMARY KEY,
 reserved_cents integer NOT NULL DEFAULT 0 CHECK(reserved_cents BETWEEN 0 AND 500)
);
CREATE TABLE broker_demo_runs (
 id uuid PRIMARY KEY,
 visitor_id uuid NOT NULL REFERENCES broker_demo_visitors(id),
 buyer_id text NOT NULL REFERENCES "user"(id),
 ip_digest text NOT NULL CHECK(length(ip_digest)=64),
 operation_key text NOT NULL,
 source_mode text NOT NULL CHECK(source_mode IN('real','fixture')),
 budget_day date NOT NULL REFERENCES broker_demo_days(day),
 reserved_cents integer NOT NULL DEFAULT 50 CHECK(reserved_cents=50),
 status text NOT NULL DEFAULT 'starting' CHECK(status IN('starting','auction','provisioning','ready','ending','ended','failed')),
 message text NOT NULL DEFAULT 'Preparing your private demo.',
 stop_requested boolean NOT NULL DEFAULT false,
 failed boolean NOT NULL DEFAULT false,
 grant_id uuid REFERENCES broker_inference_grants(id),
 token_order_id uuid REFERENCES broker_token_orders(id),
 pack_id uuid REFERENCES broker_token_packs(id),
 disk_id uuid REFERENCES broker_disks(id),
 request_id uuid REFERENCES broker_requests(id),
 vm_id uuid REFERENCES broker_vms(id),
 native_attempted_at timestamptz,
 bootstrap_started_at timestamptz,
 bootstrap_completed_at timestamptz,
 key_issued_at timestamptz,
 lease_token uuid,
 lease_until timestamptz,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 expires_at timestamptz NOT NULL DEFAULT clock_timestamp()+interval '18 minutes',
 vm_cleanup_at timestamptz,
 ended_at timestamptz,
 cooldown_until timestamptz,
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(visitor_id,operation_key)
);
CREATE INDEX broker_demo_runs_visitor_idx ON broker_demo_runs(visitor_id,created_at DESC,id DESC);
CREATE INDEX broker_demo_runs_ip_idx ON broker_demo_runs(ip_digest,created_at DESC,id DESC);
CREATE INDEX broker_demo_runs_active_idx ON broker_demo_runs(updated_at,id) WHERE ended_at IS NULL;
CREATE UNIQUE INDEX broker_demo_runs_one_visitor_idx ON broker_demo_runs(visitor_id) WHERE ended_at IS NULL;
CREATE UNIQUE INDEX broker_demo_runs_one_ip_idx ON broker_demo_runs(ip_digest) WHERE ended_at IS NULL;
CREATE UNIQUE INDEX broker_demo_runs_pack_idx ON broker_demo_runs(pack_id) WHERE pack_id IS NOT NULL;
CREATE UNIQUE INDEX broker_demo_runs_grant_idx ON broker_demo_runs(grant_id) WHERE grant_id IS NOT NULL;
CREATE TABLE broker_demo_events (
 id bigserial PRIMARY KEY,
 run_id uuid NOT NULL REFERENCES broker_demo_runs(id),
 kind text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(run_id,kind)
);
CREATE TABLE broker_demo_mutations (
 visitor_id uuid NOT NULL REFERENCES broker_demo_visitors(id),
 operation text NOT NULL CHECK(operation IN('end','key')),
 operation_key text NOT NULL,
 run_id uuid NOT NULL REFERENCES broker_demo_runs(id),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(visitor_id,operation,operation_key)
);
