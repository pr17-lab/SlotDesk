-- Up Migration
-- A resource's weekly opening windows (D-032). Times are minutes since local
-- midnight in the resource's own time zone (540 is 09:00, 1440 is the end of
-- the day). Step 9d converts them to UTC. Several windows per day are allowed
-- (for example a lunch break). Out of scope: overnight windows, holidays and
-- time off, buffers.
-- No ON DELETE CASCADE (D-026).
CREATE TABLE working_hours (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id       bigint NOT NULL,
  resource_id  bigint NOT NULL,
  -- ISO weekday: 1 is Monday, 7 is Sunday.
  weekday      smallint NOT NULL,
  start_minute integer NOT NULL,
  end_minute   integer NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  -- Composite foreign key: a window cannot point at another organization's
  -- resource (D-011).
  CONSTRAINT working_hours_resource_fkey
    FOREIGN KEY (org_id, resource_id) REFERENCES resources (org_id, id),
  CONSTRAINT working_hours_weekday_check CHECK (weekday BETWEEN 1 AND 7),
  CONSTRAINT working_hours_minutes_check
    CHECK (0 <= start_minute AND start_minute < end_minute AND end_minute <= 1440),
  -- Two windows of the same resource on the same weekday cannot overlap.
  -- int4range(start, end) is half-open, [start, end), so 09:00-13:00 and
  -- 13:00-17:00 touch but do not overlap and are both allowed. Needs
  -- btree_gist (first migration) for the = parts.
  CONSTRAINT working_hours_no_overlap
    EXCLUDE USING gist (
      resource_id WITH =,
      weekday WITH =,
      int4range(start_minute, end_minute) WITH &&
    )
);

-- Down Migration
DROP TABLE working_hours;
