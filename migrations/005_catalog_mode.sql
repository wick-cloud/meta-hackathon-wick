-- Explicit adapter isolation: previously seeded fixture supply is never implicitly real.
ALTER TABLE broker_catalog ADD COLUMN source_mode text NOT NULL DEFAULT 'fixture' CHECK(source_mode IN ('fixture','real'));
CREATE INDEX broker_catalog_mode_approved ON broker_catalog(source_mode,approved);
