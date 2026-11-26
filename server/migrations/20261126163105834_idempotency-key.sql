-- Up Migration
-- The key a client sends with a booking so a retry gets the same booking
-- back instead of a 409. Only bookings made with a key have one; every
-- existing row stays NULL, and a plain UNIQUE allows any number of NULLs.
-- Scoped to the organization, so one business can never find another's
-- booking by its key. The uuid type refuses anything that isn't one.
ALTER TABLE bookings
  ADD COLUMN idempotency_key uuid,
  ADD CONSTRAINT bookings_org_idempotency_key_key UNIQUE (org_id, idempotency_key);

-- Down Migration
ALTER TABLE bookings
  DROP CONSTRAINT IF EXISTS bookings_org_idempotency_key_key,
  DROP COLUMN IF EXISTS idempotency_key;
