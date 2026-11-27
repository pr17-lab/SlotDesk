-- Up Migration
-- One-time invite links. The owner sends the link; whoever holds its secret
-- can join the organization as staff once, within 24 hours. Only the
-- SHA-256 of the secret is stored, never the secret. A row is deleted when
-- its link is accepted, declined or cancelled, so a link can't work twice.
-- The label is only for the owner's list ("Priya, front desk") and is never
-- checked against anything. No ON DELETE CASCADE (D-026).
CREATE TABLE invitations (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id     bigint NOT NULL CONSTRAINT invitations_org_id_fkey REFERENCES organizations (id),
  label      text NOT NULL,
  token_hash bytea NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT invitations_token_hash_key UNIQUE (token_hash),
  CONSTRAINT invitations_label_check CHECK (char_length(label) BETWEEN 1 AND 100),
  CONSTRAINT invitations_token_hash_check CHECK (octet_length(token_hash) = 32)
);

-- The owner's list and the pending count. The unique index on token_hash
-- can't serve a lookup by organization.
CREATE INDEX invitations_org_id_idx ON invitations (org_id);

-- Down Migration
DROP TABLE invitations;
