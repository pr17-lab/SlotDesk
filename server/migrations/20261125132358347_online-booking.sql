-- Up Migration
-- Online booking. A business turns its public page on by choosing a link
-- name; NULL means the page is off, so every existing organization stays
-- off. The format check means mixed case can never be stored. A plain
-- UNIQUE is enough: PostgreSQL treats NULLs as different, so any number of
-- businesses can be off.
ALTER TABLE organizations
  ADD COLUMN booking_slug text,
  ADD CONSTRAINT organizations_booking_slug_key UNIQUE (booking_slug),
  ADD CONSTRAINT organizations_booking_slug_check
    CHECK (booking_slug ~ '^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$');

-- How a booking was made: by staff, or by a customer on the public page.
-- Every booking so far was made by staff, so that's the default.
ALTER TABLE bookings
  ADD COLUMN source text NOT NULL DEFAULT 'staff',
  ADD CONSTRAINT bookings_source_check CHECK (source IN ('staff', 'public'));

-- Down Migration
ALTER TABLE bookings
  DROP CONSTRAINT IF EXISTS bookings_source_check,
  DROP COLUMN IF EXISTS source;

ALTER TABLE organizations
  DROP CONSTRAINT IF EXISTS organizations_booking_slug_check,
  DROP CONSTRAINT IF EXISTS organizations_booking_slug_key,
  DROP COLUMN IF EXISTS booking_slug;
