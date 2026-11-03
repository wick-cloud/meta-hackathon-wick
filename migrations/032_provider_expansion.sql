-- Expand identities without rebinding existing accounts or changing accepted rentals.
ALTER TABLE broker_providers DROP CONSTRAINT broker_providers_cloud_provider_check;
ALTER TABLE broker_providers ADD CONSTRAINT broker_providers_cloud_provider_check
  CHECK (cloud_provider IS NULL OR cloud_provider IN (
    'e2b','daytona','provider-blaxel','modal',
    'sail','provider-tenki','provider-freestyle','boat'
  ));

-- Boat was previously excluded from customer discovery. Old stored approval is
-- not qualification: require a fresh approval and offering activation now that
-- the shared registry admits this route. Frozen bids, rentals and invoices stay intact.
UPDATE broker_catalog SET approved=false,updated_at=clock_timestamp()
  WHERE source_mode='real' AND item->>'provider'='boat' AND approved;
UPDATE broker_offerings o SET active=false,revision=o.revision+1
  FROM broker_catalog c
  WHERE o.catalog_id=c.id AND c.source_mode='real' AND c.item->>'provider'='boat' AND o.active;
UPDATE broker_scheduled_offerings o SET active=false,revision=o.revision+1
  FROM broker_catalog c
  WHERE o.catalog_id=c.id AND c.source_mode='real' AND c.item->>'provider'='boat' AND o.active;
