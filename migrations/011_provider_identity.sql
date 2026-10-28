-- A provider account's upstream route is assigned by the operator, never by its pricing policy.
-- Existing supplier accounts remain unbound so historical fixtures and reservations retain ownership.
ALTER TABLE broker_providers ADD COLUMN cloud_provider text
  CHECK (cloud_provider IS NULL OR cloud_provider IN ('e2b','daytona','provider-blaxel','modal'));
