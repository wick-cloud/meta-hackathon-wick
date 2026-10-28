ALTER TABLE broker_activity ADD COLUMN receipt jsonb;
ALTER TABLE broker_activity ADD COLUMN mode text CHECK(mode IN ('fixture','real'));
ALTER TABLE broker_activity ADD COLUMN model_called boolean;
CREATE INDEX IF NOT EXISTS broker_requests_unmatched ON broker_requests(created_at DESC,id DESC) WHERE status='no_offers';
CREATE INDEX broker_activity_provider_page_time ON broker_activity(provider_id,created_at DESC,id DESC);
CREATE INDEX broker_offerings_provider_page ON broker_offerings(provider_id,created_at DESC,id DESC);
