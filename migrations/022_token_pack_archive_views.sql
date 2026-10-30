-- The active inventory must stay bounded as settled purchase history grows.
-- Keep unresolved quota visible even if a pack has an inconsistent terminal status.
CREATE INDEX broker_token_packs_buyer_active_page ON broker_token_packs(buyer_id,created_at DESC,id DESC)
  WHERE status<>'settled' OR held_input>0 OR held_output>0;
