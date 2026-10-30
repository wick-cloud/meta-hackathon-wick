CREATE INDEX broker_token_packs_buyer_page ON broker_token_packs(buyer_id,created_at DESC,id DESC);
ALTER TABLE broker_api_keys
  ADD COLUMN pack_id uuid REFERENCES broker_token_packs(id),
  ADD COLUMN parent_key_id uuid REFERENCES broker_api_keys(id),
  ADD CONSTRAINT broker_api_keys_pack_scope CHECK(pack_id IS NULL OR(grant_id IS NOT NULL AND issued_role='buyer')),
  ADD CONSTRAINT broker_api_keys_parent_scope CHECK(parent_key_id IS NULL OR(pack_id IS NOT NULL AND parent_key_id<>id));
CREATE INDEX broker_api_keys_pack_active ON broker_api_keys(user_id,pack_id,id) WHERE pack_id IS NOT NULL AND revoked_at IS NULL;
CREATE INDEX broker_api_keys_children_active ON broker_api_keys(parent_key_id,id) WHERE parent_key_id IS NOT NULL AND revoked_at IS NULL;
