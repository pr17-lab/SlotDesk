-- Up Migration
-- A service an organization offers, with a fixed duration (D-032).
-- Every resource offers every service in the MVP, so there is no link table.
-- No ON DELETE CASCADE (D-026), and no route deletes services: Week 3
-- bookings will probably refer to them.
CREATE TABLE services (
  id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id           bigint NOT NULL CONSTRAINT services_org_id_fkey REFERENCES organizations (id),
  name             text NOT NULL,
  duration_minutes integer NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  -- 5 to 480 minutes (8 hours), in steps of 5. The API checks the same rule
  -- first; this is the guarantee if a bug or a manual query skips the API.
  CONSTRAINT services_duration_minutes_check
    CHECK (duration_minutes BETWEEN 5 AND 480 AND duration_minutes % 5 = 0),
  -- Composite unique key so later tables can reference a service by
  -- (org_id, id) and cannot point at another organization's service.
  CONSTRAINT services_org_id_id_key UNIQUE (org_id, id)
);

-- Down Migration
DROP TABLE services;
