-- Up Migration
-- The cancel link a customer gets after booking online. Whoever holds its
-- secret can see and cancel that one booking. Only the SHA-256 of the
-- secret is stored, never the secret. Staff bookings never have one, and
-- online bookings made before this stay NULL: they simply have no link. A
-- plain UNIQUE allows any number of NULLs.
ALTER TABLE bookings
  ADD COLUMN manage_token_hash bytea,
  ADD CONSTRAINT bookings_manage_token_hash_key UNIQUE (manage_token_hash),
  ADD CONSTRAINT bookings_manage_token_hash_check
    CHECK (octet_length(manage_token_hash) = 32),
  ADD CONSTRAINT bookings_manage_token_source_check
    CHECK (source = 'public' OR manage_token_hash IS NULL);

-- Down Migration
ALTER TABLE bookings
  DROP CONSTRAINT IF EXISTS bookings_manage_token_source_check,
  DROP CONSTRAINT IF EXISTS bookings_manage_token_hash_check,
  DROP CONSTRAINT IF EXISTS bookings_manage_token_hash_key,
  DROP COLUMN IF EXISTS manage_token_hash;
