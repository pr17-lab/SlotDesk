-- Up Migration
-- Links users to organizations with a role (D-030).
-- Primary key is the natural key (org_id, user_id): a person is in an
-- organization at most once, and nothing needs a separate id (D-021
-- exception for link tables).
-- No ON DELETE CASCADE (D-026): deleting a user or an organization that
-- still has memberships is refused.
CREATE TABLE memberships (
  org_id     bigint NOT NULL CONSTRAINT memberships_org_id_fkey REFERENCES organizations (id),
  user_id    text NOT NULL CONSTRAINT memberships_user_id_fkey REFERENCES users (id),
  role       text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT memberships_pkey PRIMARY KEY (org_id, user_id),
  CONSTRAINT memberships_role_check CHECK (role IN ('owner', 'staff'))
);

-- At most one owner per organization. A partial unique index: uniqueness
-- applies only to rows where role = 'owner'. "At least one owner" is
-- guaranteed by the app, not here (D-030).
CREATE UNIQUE INDEX memberships_one_owner_per_org ON memberships (org_id) WHERE role = 'owner';

-- Lists a user's organizations. The primary key starts with org_id, so it
-- cannot serve a lookup by user_id alone.
CREATE INDEX memberships_user_id_idx ON memberships (user_id);

-- Down Migration
DROP TABLE memberships;
