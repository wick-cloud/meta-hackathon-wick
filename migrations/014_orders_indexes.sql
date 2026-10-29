-- History is read directly from its original records. Child activation requests
-- are excluded, so a bulk agreement does not appear as many instant auctions.
CREATE INDEX broker_requests_auction_buyer_page ON broker_requests(buyer_id,created_at DESC,id DESC)
  WHERE agreement_id IS NULL;
CREATE INDEX broker_requests_open_buyer_page ON broker_requests(buyer_id,created_at DESC,id DESC)
  WHERE agreement_id IS NULL AND status IN ('open','provisioning');
CREATE INDEX broker_requests_attention_buyer_page ON broker_requests(buyer_id,created_at DESC,id DESC)
  WHERE agreement_id IS NULL AND status IN ('no_offers','failed');
CREATE INDEX broker_vms_buyer_unresolved ON broker_vms(buyer_id,created_at DESC,request_id)
  WHERE cleanup_confirmed_at IS NULL;
CREATE INDEX broker_agreements_active_buyer_page ON broker_agreements(buyer_id,created_at DESC,id DESC)
  WHERE status IN ('open','approved') OR reserved_cents>0;
