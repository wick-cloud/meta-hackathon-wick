-- Attribution IDs survive key/account deletion; credentials are validated by the auth owner.
CREATE TABLE broker_operation_receipts (
  owner_id text NOT NULL,
  operation text NOT NULL,
  operation_key text NOT NULL,
  input_fingerprint text NOT NULL,
  response jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(owner_id, operation, operation_key)
);
CREATE TABLE broker_key_actions (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  owner_id text NOT NULL,
  api_key_id uuid NOT NULL,
  operation text NOT NULL,
  operation_key text NOT NULL,
  resource_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(owner_id,operation,operation_key)
);
CREATE INDEX broker_key_actions_resource ON broker_key_actions(owner_id,resource_id,created_at DESC);
ALTER TABLE broker_requests ADD COLUMN source_api_key_id uuid;
ALTER TABLE broker_bids ADD COLUMN source_api_key_id uuid;
ALTER TABLE broker_agreements ADD COLUMN source_api_key_id uuid;
ALTER TABLE broker_offerings ADD COLUMN source_api_key_id uuid;
