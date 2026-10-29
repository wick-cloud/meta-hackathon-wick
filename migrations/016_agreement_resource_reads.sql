-- These reads are scoped to one agreement/window or a bounded worker page.
-- Retired activation history must not slow down live-slot counts and detail polls.
CREATE INDEX broker_agreement_bookings_agreement_page ON broker_agreement_bookings(agreement_id,starts_at,id);
CREATE INDEX broker_agreement_activations_pending_window ON broker_agreement_activations(window_id,booking_id)
  WHERE cleaned_at IS NULL;
CREATE INDEX broker_agreements_expiry_work ON broker_agreements(expires_at,next_match_at,id)
  WHERE status IN ('open','approved') OR (status='expired' AND reserved_cents>0);
CREATE INDEX broker_agreements_demand_page ON broker_agreements(source_mode,created_at DESC,id DESC)
  WHERE status IN ('open','approved') AND accepting_topups;
CREATE INDEX broker_agreements_funded_mode ON broker_agreements(source_mode,expires_at)
  WHERE reserved_cents>0 OR status='approved';
