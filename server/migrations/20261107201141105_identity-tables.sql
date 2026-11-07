-- Up Migration
-- Better Auth identity tables (D-021, D-025). The columns, types, nullability
-- and defaults come from `auth@1.7.18 generate` with the modelName and fields
-- mapping in src/auth.ts. The only change is that every constraint and index
-- has an explicit name (D-026). The Better Auth CLI's `migrate` command is
-- never used (D-001, D-025).
CREATE TABLE users (
  id             text NOT NULL CONSTRAINT users_pkey PRIMARY KEY,
  name           text NOT NULL,
  email          text NOT NULL CONSTRAINT users_email_key UNIQUE,
  email_verified boolean NOT NULL,
  image          text,
  created_at     timestamptz DEFAULT CURRENT_TIMESTAMP NOT NULL,
  updated_at     timestamptz DEFAULT CURRENT_TIMESTAMP NOT NULL
);

CREATE TABLE sessions (
  id         text NOT NULL CONSTRAINT sessions_pkey PRIMARY KEY,
  expires_at timestamptz NOT NULL,
  token      text NOT NULL CONSTRAINT sessions_token_key UNIQUE,
  created_at timestamptz DEFAULT CURRENT_TIMESTAMP NOT NULL,
  updated_at timestamptz NOT NULL,
  ip_address text,
  user_agent text,
  -- ON DELETE CASCADE is the library's design; it differs on purpose from our own tables, which never cascade (D-026).
  user_id    text NOT NULL CONSTRAINT sessions_user_id_fkey REFERENCES users (id) ON DELETE CASCADE
);

CREATE TABLE accounts (
  id                       text NOT NULL CONSTRAINT accounts_pkey PRIMARY KEY,
  account_id               text NOT NULL,
  provider_id              text NOT NULL,
  -- ON DELETE CASCADE is the library's design; it differs on purpose from our own tables, which never cascade (D-026).
  user_id                  text NOT NULL CONSTRAINT accounts_user_id_fkey REFERENCES users (id) ON DELETE CASCADE,
  access_token             text,
  refresh_token            text,
  id_token                 text,
  access_token_expires_at  timestamptz,
  refresh_token_expires_at timestamptz,
  scope                    text,
  password                 text,
  created_at               timestamptz DEFAULT CURRENT_TIMESTAMP NOT NULL,
  updated_at               timestamptz NOT NULL
);

CREATE TABLE verifications (
  id         text NOT NULL CONSTRAINT verifications_pkey PRIMARY KEY,
  identifier text NOT NULL,
  value      text NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz DEFAULT CURRENT_TIMESTAMP NOT NULL,
  updated_at timestamptz DEFAULT CURRENT_TIMESTAMP NOT NULL
);

CREATE INDEX sessions_user_id_idx ON sessions (user_id);

CREATE INDEX accounts_user_id_idx ON accounts (user_id);

CREATE INDEX verifications_identifier_idx ON verifications (identifier);

-- Down Migration
-- Reverse dependency order; indexes and constraints are dropped with their tables.
DROP TABLE verifications;
DROP TABLE accounts;
DROP TABLE sessions;
DROP TABLE users;
