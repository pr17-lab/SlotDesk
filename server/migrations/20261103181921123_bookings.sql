-- Up Migration
CREATE TABLE bookings (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id         bigint NOT NULL,
  resource_id    bigint NOT NULL,
  starts_at      timestamptz NOT NULL,
  ends_at        timestamptz NOT NULL,
  status         text NOT NULL DEFAULT 'confirmed',
  customer_name  text NOT NULL,
  customer_email text NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),

  -- Only 'confirmed' and 'cancelled' are valid statuses.
  CONSTRAINT bookings_status_check CHECK (status IN ('confirmed', 'cancelled')),

  -- The end must be strictly after the start; zero-length and backward
  -- bookings are rejected.
  CONSTRAINT bookings_valid_range CHECK (ends_at > starts_at),

  -- Composite foreign key ensures resource_id belongs to the same org as the
  -- booking. A booking cannot point at another organization's resource (D-011).
  -- No separate org_id → organizations FK is needed; the composite key implies
  -- org_id is a valid organization.
  CONSTRAINT bookings_resource_fk
    FOREIGN KEY (org_id, resource_id)
    REFERENCES resources (org_id, id),

  -- Exclusion constraint: two confirmed bookings for the same resource whose
  -- time ranges overlap are rejected with error 23P01. Requires btree_gist
  -- (enabled by the first migration). The half-open range [starts_at, ends_at)
  -- is expressed as tstzrange; back-to-back bookings share a boundary but do
  -- not overlap, so they are allowed. Cancelled bookings are excluded from the
  -- constraint so a cancelled slot can be rebooked (D-012, D-026).
  CONSTRAINT bookings_no_overlap
    EXCLUDE USING gist (
      resource_id WITH =,
      tstzrange(starts_at, ends_at) WITH &&
    ) WHERE (status = 'confirmed')
);

-- Down Migration
DROP TABLE bookings;
