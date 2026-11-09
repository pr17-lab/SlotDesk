// Database rule tests for the memberships table (Step 6a, D-030).
// Each test proves one database rule using a real PostgreSQL connection.
// Tests commit for real; tables are truncated after this file runs.
// Uses TEST_DATABASE_URL only — never DATABASE_URL (D-016).

import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  connectAndVerify,
  requireTestDatabase,
  truncateTables,
} from './helpers/db-guard.js';

// ── Guard ────────────────────────────────────────────────────────────────────
// Validates TEST_DATABASE_URL and the database name before any connection.
const { createClient } = requireTestDatabase();

// ── Shared state ─────────────────────────────────────────────────────────────
let client: pg.Client;
let orgId: string;
let org2Id: string;

// ── Helpers ──────────────────────────────────────────────────────────────────

// Insert one membership row.
async function insertMembership(
  c: pg.Client,
  oid: string,
  userId: string,
  role: string | null,
): Promise<void> {
  await c.query(
    'INSERT INTO memberships (org_id, user_id, role) VALUES ($1, $2, $3)',
    [oid, userId, role],
  );
}

// Count rows matching a query, to check what still exists after a refusal.
async function countRows(
  c: pg.Client,
  sql: string,
  params: unknown[],
): Promise<number> {
  const r = await c.query<{ count: string }>(sql, params);
  return Number(r.rows[0]!.count);
}

// Run a statement and return the pg error, or null if it succeeded.
async function expectError(
  fn: () => Promise<unknown>,
): Promise<pg.DatabaseError> {
  try {
    await fn();
    throw new Error('Expected a database error but the statement succeeded.');
  } catch (err) {
    if (err instanceof pg.DatabaseError) return err;
    throw err;
  }
}

// ── Setup / teardown ─────────────────────────────────────────────────────────

beforeAll(async () => {
  client = createClient();
  // Check 3: verify the live database name ends in _test before any writes.
  await connectAndVerify(client);

  const o1 = await client.query<{ id: string }>(
    "INSERT INTO organizations (name) VALUES ('Memberships Org A') RETURNING id",
  );
  orgId = o1.rows[0]!.id;
  const o2 = await client.query<{ id: string }>(
    "INSERT INTO organizations (name) VALUES ('Memberships Org B') RETURNING id",
  );
  org2Id = o2.rows[0]!.id;

  await client.query(
    `INSERT INTO users (id, name, email, email_verified) VALUES
       ('user-owner', 'Owner', 'owner@example.com', true),
       ('user-staff1', 'Staff One', 'staff1@example.com', true),
       ('user-staff2', 'Staff Two', 'staff2@example.com', true)`,
  );
});

afterAll(async () => {
  await truncateTables(client);
  await client.end();
});

// Each test starts with no memberships but keeps the same orgs and users.
beforeEach(async () => {
  await client.query('TRUNCATE memberships');
});

// ── Tests ────────────────────────────────────────────────────────────────────

describe('memberships constraint tests', () => {
  it('a: one owner and two staff in one organization are accepted', async () => {
    await insertMembership(client, orgId, 'user-owner', 'owner');
    await insertMembership(client, orgId, 'user-staff1', 'staff');
    await insertMembership(client, orgId, 'user-staff2', 'staff');
    const count = await countRows(
      client,
      'SELECT count(*) FROM memberships WHERE org_id = $1',
      [orgId],
    );
    expect(count).toBe(3);
  });

  it('b: a second owner in the same organization is rejected (23505)', async () => {
    await insertMembership(client, orgId, 'user-owner', 'owner');
    const err = await expectError(() =>
      insertMembership(client, orgId, 'user-staff1', 'owner'),
    );
    expect(err.code).toBe('23505');
    expect(err.constraint).toBe('memberships_one_owner_per_org');
  });

  it('c: the same user twice in one organization is rejected (23505)', async () => {
    await insertMembership(client, orgId, 'user-staff1', 'staff');
    const err = await expectError(() =>
      insertMembership(client, orgId, 'user-staff1', 'owner'),
    );
    expect(err.code).toBe('23505');
    expect(err.constraint).toBe('memberships_pkey');
  });

  it('d: one user can be owner of two different organizations', async () => {
    await insertMembership(client, orgId, 'user-owner', 'owner');
    await insertMembership(client, org2Id, 'user-owner', 'owner');
    const count = await countRows(
      client,
      'SELECT count(*) FROM memberships WHERE user_id = $1',
      ['user-owner'],
    );
    expect(count).toBe(2);
  });

  it('e: a role other than owner or staff is rejected (23514)', async () => {
    const err = await expectError(() =>
      insertMembership(client, orgId, 'user-staff1', 'admin'),
    );
    expect(err.code).toBe('23514');
    expect(err.constraint).toBe('memberships_role_check');
  });

  it('f: a NULL role is rejected (23502)', async () => {
    const err = await expectError(() =>
      insertMembership(client, orgId, 'user-staff1', null),
    );
    expect(err.code).toBe('23502');
  });

  it('g: an unknown user_id is rejected (23503)', async () => {
    const err = await expectError(() =>
      insertMembership(client, orgId, 'user-does-not-exist', 'staff'),
    );
    expect(err.code).toBe('23503');
    expect(err.constraint).toBe('memberships_user_id_fkey');
  });

  it('h: an unknown org_id is rejected (23503)', async () => {
    const err = await expectError(() =>
      insertMembership(client, '999999', 'user-staff1', 'staff'),
    );
    expect(err.code).toBe('23503');
    expect(err.constraint).toBe('memberships_org_id_fkey');
  });

  it('i: updating staff to owner when an owner exists is rejected (23505)', async () => {
    await insertMembership(client, orgId, 'user-owner', 'owner');
    await insertMembership(client, orgId, 'user-staff1', 'staff');
    const err = await expectError(() =>
      client.query(
        "UPDATE memberships SET role = 'owner' WHERE org_id = $1 AND user_id = $2",
        [orgId, 'user-staff1'],
      ),
    );
    expect(err.code).toBe('23505');
    expect(err.constraint).toBe('memberships_one_owner_per_org');
  });

  it('j: deleting a user who has a membership is rejected (23503)', async () => {
    await insertMembership(client, orgId, 'user-staff1', 'staff');
    const err = await expectError(() =>
      client.query('DELETE FROM users WHERE id = $1', ['user-staff1']),
    );
    expect(err.code).toBe('23503');
    expect(err.constraint).toBe('memberships_user_id_fkey');

    const users = await countRows(
      client,
      'SELECT count(*) FROM users WHERE id = $1',
      ['user-staff1'],
    );
    const memberships = await countRows(
      client,
      'SELECT count(*) FROM memberships WHERE org_id = $1 AND user_id = $2',
      [orgId, 'user-staff1'],
    );
    expect(users).toBe(1);
    expect(memberships).toBe(1);
  });

  it('k: deleting an organization that has memberships is rejected (23503)', async () => {
    await insertMembership(client, orgId, 'user-owner', 'owner');
    const err = await expectError(() =>
      client.query('DELETE FROM organizations WHERE id = $1', [orgId]),
    );
    expect(err.code).toBe('23503');
    expect(err.constraint).toBe('memberships_org_id_fkey');

    const orgs = await countRows(
      client,
      'SELECT count(*) FROM organizations WHERE id = $1',
      [orgId],
    );
    const memberships = await countRows(
      client,
      'SELECT count(*) FROM memberships WHERE org_id = $1 AND user_id = $2',
      [orgId, 'user-owner'],
    );
    expect(orgs).toBe(1);
    expect(memberships).toBe(1);
  });
});
