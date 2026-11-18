-- Up Migration
-- The service each booking is for (Step 10b, D-033). The booking route reads
-- the service's duration to set ends_at; the row records what was booked.
-- NOT NULL with no default: this fails on a table that already has rows,
-- which is intended (no booking has a service to fill in). The composite
-- foreign key means a booking cannot point at another organization's
-- service (23503), like bookings_resource_fk. No ON DELETE CASCADE (D-026):
-- deleting a service that has bookings is refused.
ALTER TABLE bookings
  ADD COLUMN service_id bigint NOT NULL,
  ADD CONSTRAINT bookings_service_fk
    FOREIGN KEY (org_id, service_id)
    REFERENCES services (org_id, id);

-- Down Migration
-- IF EXISTS so the down step also works on a database where the constraint or
-- column is missing, which is what a mutation proof leaves behind.
ALTER TABLE bookings
  DROP CONSTRAINT IF EXISTS bookings_service_fk,
  DROP COLUMN IF EXISTS service_id;
