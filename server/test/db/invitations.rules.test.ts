// Database rule tests for the invitations table. Each test proves one rule
// with a real PostgreSQL connection. Uses TEST_DATABASE_URL only (D-016).
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  connectAndVerify,
  expectError,
  requireTestDatabase,
  truncateTables,
} from './helpers/db-guard.js';

const { createClient } = requireTestDatabase();

let client: pg.Client;
let orgId: string;

function insert(
  org: string,
  label: string,
  tokenHash: Buffer,
): Promise<pg.QueryResult> {
  return client.query(
    `INSERT INTO invitations (org_id, label, token_hash, expires_at)
     VALUES ($1, $2, $3, now() + interval '24 hours')`,
    [org, label, tokenHash],
  );
}

const hash = () => randomBytes(32);

beforeAll(async () => {
  client = createClient();
  await connectAndVerify(client);
  const org = await client.query<{ id: string }>(
    "INSERT INTO organizations (name) VALUES ('Invitation Rules Org') RETURNING id",
  );
  orgId = org.rows[0]!.id;
});

beforeEach(async () => {
  await client.query('DELETE FROM invitations');
});

afterAll(async () => {
  await truncateTables(client);
  await client.end();
});

describe('invitations constraint tests', () => {
  it('accepts a 1- and a 100-character label', async () => {
    await insert(orgId, 'a', hash());
    await insert(orgId, 'a'.repeat(100), hash());
  });

  it('refuses an empty or 101-character label (23514)', async () => {
    for (const label of ['', 'a'.repeat(101)]) {
      const err = await expectError(() => insert(orgId, label, hash()));
      expect(err.code).toBe('23514');
      expect(err.constraint).toBe('invitations_label_check');
    }
  });

  it('refuses a hash that is not 32 bytes (23514)', async () => {
    for (const bytes of [31, 33]) {
      const err = await expectError(() =>
        insert(orgId, 'x', randomBytes(bytes)),
      );
      expect(err.code).toBe('23514');
      expect(err.constraint).toBe('invitations_token_hash_check');
    }
  });

  it('refuses the same hash twice (23505)', async () => {
    const same = hash();
    await insert(orgId, 'x', same);
    const err = await expectError(() => insert(orgId, 'y', same));
    expect(err.code).toBe('23505');
    expect(err.constraint).toBe('invitations_token_hash_key');
  });

  it('refuses an organization that does not exist (23503)', async () => {
    const err = await expectError(() => insert('999999', 'x', hash()));
    expect(err.code).toBe('23503');
    expect(err.constraint).toBe('invitations_org_id_fkey');
  });

  it('refuses to delete an organization that has invitations (23503)', async () => {
    await insert(orgId, 'x', hash());
    const err = await expectError(() =>
      client.query('DELETE FROM organizations WHERE id = $1', [orgId]),
    );
    expect(err.code).toBe('23503');
    expect(err.constraint).toBe('invitations_org_id_fkey');
  });
});
