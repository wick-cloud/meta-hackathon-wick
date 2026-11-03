-- A wallet purchase keeps an internal accounting grant without creating an agent.
ALTER TABLE broker_inference_grants
 ADD COLUMN funding_source text NOT NULL DEFAULT 'agent' CHECK(funding_source IN('agent','wallet')),
 ADD CONSTRAINT broker_inference_grants_funding_identity UNIQUE(id,funding_source);
ALTER TABLE broker_token_orders
 ADD COLUMN funding_source text NOT NULL DEFAULT 'agent' CHECK(funding_source IN('agent','wallet')),
 ADD CONSTRAINT broker_token_orders_funding_grant FOREIGN KEY(grant_id,funding_source)
   REFERENCES broker_inference_grants(id,funding_source),
 ADD CONSTRAINT broker_token_orders_funding_identity UNIQUE(id,grant_id,funding_source);
ALTER TABLE broker_token_packs
 ADD COLUMN funding_source text NOT NULL DEFAULT 'agent' CHECK(funding_source IN('agent','wallet')),
 ADD CONSTRAINT broker_token_packs_funding_order FOREIGN KEY(order_id,grant_id,funding_source)
   REFERENCES broker_token_orders(id,grant_id,funding_source);
CREATE UNIQUE INDEX broker_wallet_token_order_operation
 ON broker_token_orders(buyer_id,operation_key) WHERE funding_source='wallet';
CREATE UNIQUE INDEX broker_wallet_token_order_grant
 ON broker_token_orders(grant_id) WHERE funding_source='wallet';
CREATE INDEX broker_wallet_token_orders_recent
 ON broker_token_orders(buyer_id,created_at DESC) WHERE funding_source='wallet';
CREATE INDEX broker_wallet_token_packs_active
 ON broker_token_packs(buyer_id,id) WHERE funding_source='wallet' AND status<>'settled';
CREATE INDEX broker_agent_grants_owner_page
 ON broker_inference_grants(buyer_id,created_at DESC,id DESC) WHERE funding_source='agent';
CREATE INDEX broker_agent_grants_active_owner
 ON broker_inference_grants(buyer_id) WHERE funding_source='agent' AND status<>'closed';
