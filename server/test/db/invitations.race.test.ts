// Invitations under concurrent requests, on the test database. Each race
// runs for several rounds, because a single round can pass by luck.
//  - Two people accept one link at once: accepting deletes the row in the
//    same transaction that adds the membership, so the second waits on the
//    row lock, finds it gone and gets notFound. One membership, never two.
//  - Accept and cancel at once: one of them wins, never both.
//  - Two creates at 19 pending: the organization row is locked before the
//    count, so the second counts again after the first commits.
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { loadAppOnTestDatabase } from './helpers/auth-app.js';
import {
  connectAndVerify,
  requireTestDatabase,
  truncateTables,
} from './helpers/db-guard.js';

const ROUNDS = 20;

// The app's pool must point at the test database before src/ modules load.
const { pool } = await loadAppOnTestDatabase();
const { acceptInvitation, cancelInvitation, createInvitation, PENDING_LIMIT } =
  await import('../../src/data/invitations.js');
const { createClient } = requireTestDatabase();

let client: pg.Client;
let orgId: string;

async function count(sql: string, params: unknown[]): Promise<number> {
  const result = await client.query<{ count: number }>(
    `SELECT count(*)::int AS count FROM ${sql}`,
    params,
  );
  return result.rows[0]!.count;
}

async function newToken(): Promise<{ id: string; token: string }> {
  const created = await createInvitation(orgId, 'Racer');
  if (created.status !== 'created') throw new Error('Expected a new invite');
  return { id: created.invitation.id, token: created.token };
}

beforeAll(async () => {
  client = createClient();
  await connectAndVerify(client);
  await client.query(
    `INSERT INTO users (id, name, email, email_verified) VALUES
       ('race-owner', 'Owner', 'race-owner@example.com', true),
       ('race-bob', 'Bob', 'race-bob@example.com', true),
       ('race-carol', 'Carol', 'race-carol@example.com', true)`,
  );
  const org = await client.query<{ id: string }>(
    "INSERT INTO organizations (name) VALUES ('Race Invites Org') RETURNING id",
  );
  orgId = org.rows[0]!.id;
  await client.query(
    "INSERT INTO memberships (org_id, user_id, role) VALUES ($1, 'race-owner', 'owner')",
    [orgId],
  );
});

beforeEach(async () => {
  await client.query('DELETE FROM invitations');
  await client.query("DELETE FROM memberships WHERE role = 'staff'");
});

afterAll(async () => {
  await truncateTables(client);
  await client.end();
  await pool.end();
});

describe('two people accept one link at the same moment', () => {
  it(`lets exactly one in, over ${ROUNDS} rounds`, async () => {
    for (let round = 0; round < ROUNDS; round++) {
      await client.query("DELETE FROM memberships WHERE role = 'staff'");
      const { token } = await newToken();

      const results = await Promise.all([
        acceptInvitation(token, 'race-bob'),
        acceptInvitation(token, 'race-carol'),
      ]);

      expect({
        round,
        statuses: results.map((result) => result.status).sort(),
      }).toEqual({ round, statuses: ['accepted', 'notFound'] });
      expect(
        await count("memberships WHERE org_id = $1 AND role = 'staff'", [
          orgId,
        ]),
      ).toBe(1);
      expect(await count('invitations WHERE org_id = $1', [orgId])).toBe(0);
    }
  });
});

describe('accept and cancel at the same moment', () => {
  it(`lets one of them win, never both, over ${ROUNDS} rounds`, async () => {
    for (let round = 0; round < ROUNDS; round++) {
      await client.query("DELETE FROM memberships WHERE role = 'staff'");
      const { id, token } = await newToken();

      const [accepted, cancelled] = await Promise.all([
        acceptInvitation(token, 'race-bob'),
        cancelInvitation(orgId, id),
      ]);

      const joined = accepted.status === 'accepted';
      expect({ round, oneWinner: joined !== cancelled }).toEqual({
        round,
        oneWinner: true,
      });
      expect(
        await count('memberships WHERE org_id = $1 AND user_id = $2', [
          orgId,
          'race-bob',
        ]),
      ).toBe(joined ? 1 : 0);
    }
  });
});

describe('two creates at 19 pending', () => {
  it(`stop at ${PENDING_LIMIT}, over ${ROUNDS} rounds`, async () => {
    for (let round = 0; round < ROUNDS; round++) {
      await client.query('DELETE FROM invitations');
      for (let i = 0; i < PENDING_LIMIT - 1; i++) await newToken();

      const results = await Promise.all([
        createInvitation(orgId, 'Racer'),
        createInvitation(orgId, 'Racer'),
      ]);

      expect({
        round,
        statuses: results.map((result) => result.status).sort(),
      }).toEqual({ round, statuses: ['created', 'limitReached'] });
      expect(await count('invitations WHERE org_id = $1', [orgId])).toBe(
        PENDING_LIMIT,
      );
    }
  });
});
