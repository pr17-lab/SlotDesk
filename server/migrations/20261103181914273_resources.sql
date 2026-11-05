-- Up Migration
CREATE TABLE resources (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id     bigint NOT NULL REFERENCES organizations (id),
  name       text NOT NULL,
  time_zone  text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  -- Composite unique key lets bookings reference resources by (org_id, id),
  -- preventing a booking from pointing at another organization's resource.
  CONSTRAINT resources_org_id_id_key UNIQUE (org_id, id)
);

-- Down Migration
DROP TABLE resources;
