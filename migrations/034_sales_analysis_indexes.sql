-- Bounded seller sales-analysis samples; no new policies or financial records.
CREATE INDEX broker_requests_sales_sample ON broker_requests(created_at DESC,id DESC)
  WHERE status NOT IN ('open','cancelled') AND disk_id IS NULL;
CREATE INDEX broker_bids_provider_sales_sample ON broker_bids(provider_id,created_at DESC,id DESC);
CREATE INDEX broker_demo_runs_sales_exclusion ON broker_demo_runs(request_id) WHERE request_id IS NOT NULL;
