-- Operator write-off retires uncertain quota without inventing measured usage.
ALTER TABLE broker_inference_requests DROP CONSTRAINT broker_inference_requests_status_check;
ALTER TABLE broker_inference_requests ADD CONSTRAINT broker_inference_requests_status_check
 CHECK(status IN('reserved','dispatching','settled','rejected','outcome_unknown','needs_reconciliation','written_off'));
ALTER TABLE broker_inference_requests ADD CONSTRAINT broker_inference_writeoff_unknown
 CHECK(status<>'written_off' OR (input_tokens IS NULL AND output_tokens IS NULL AND completed_at IS NOT NULL));

DROP INDEX broker_inference_requests_pack;
CREATE INDEX broker_inference_requests_pack ON broker_inference_requests(pack_id)
 WHERE status NOT IN('settled','rejected','written_off');
DROP INDEX broker_inference_requests_unresolved;
CREATE INDEX broker_inference_requests_unresolved ON broker_inference_requests(grant_id,id)
 WHERE status NOT IN('settled','rejected','written_off');
