// Database rule tests for the bookings table (Step 3a, D-026).
// Each test proves one database constraint using a real PostgreSQL connection.
// Tests commit for real; tenant tables are truncated after this file runs.
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
// Throws immediately if the URL is missing or points at a non-test database.
const { createClient } = requireTestDatabase();

// ── Shared state ─────────────────────────────────────────────────────────────
// One client for the whole file; each test helper function gets its own
// short-lived client for concurrent-connection tests.
let client: pg.Client;
let orgId: bigint;
let resourceId: bigint;
let resource2Id: bigint;

// ── Helpers ──────────────────────────────────────────────────────────────────

// Insert one organization and return its id.
async function insertOrg(c: pg.Client, name: string): Promise<bigint> {
  const r = await c.query<{ id: string }>(
    'INSERT INTO organizations (name) VALUES ($1) RETURNING id',
    [name],
  );
  return BigInt(r.rows[0]!.id);
}

// Insert one resource under the given org and return its id.
async function insertResource(
  c: pg.Client,
  oid: bigint,
  name: string,
): Promise<bigint> {
  const r = await c.query<{ id: string }>(
    "INSERT INTO resources (org_id, name, time_zone) VALUES ($1, $2, 'UTC') RETURNING id",
    [oid, name],
  );
  return BigInt(r.rows[0]!.id);
}

// Insert a confirmed booking and return its id.
async function insertBooking(
  c: pg.Client,
  oid: bigint,
  rid: bigint,
  startsAt: string,
  endsAt: string,
  status = 'confirmed',
  customerName = 'Alice',
  customerEmail = 'alice@example.com',
): Promise<bigint> {
  const r = await c.query<{ id: string }>(
    `INSERT INTO bookings
       (org_id, resource_id, starts_at, ends_at, status, customer_name, customer_email)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING id`,
    [oid, rid, startsAt, endsAt, status, customerName, customerEmail],
  );
  return BigInt(r.rows[0]!.id);
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

  // Each test file creates its own org and resources so files cannot
  // interfere with one another even when running serially (D-016).
  orgId = await insertOrg(client, 'Rules Test Org');
  resourceId = await insertResource(client, orgId, 'Room A');
  resource2Id = await insertResource(client, orgId, 'Room B');
});

afterAll(async () => {
  // Truncate all tenant tables so the next file starts from a clean state.
  await truncateTables(client);
  await client.end();
});

// Clean up bookings between tests so each test starts with an empty bookings
// table but keeps the same org and resources (faster than re-inserting them).
beforeEach(async () => {
  await client.query('TRUNCATE bookings RESTART IDENTITY');
});

// ── Tests ────────────────────────────────────────────────────────────────────

describe('bookings constraint tests', () => {
  // a. An overlapping confirmed booking is rejected.
  it('a: overlapping confirmed booking is rejected (23P01)', async () => {
    await insertBooking(
      client,
      orgId,
      resourceId,
      '2026-11-10 10:00Z',
      '2026-11-10 11:00Z',
    );
    const err = await expectError(() =>
      insertBooking(
        client,
        orgId,
        resourceId,
        '2026-11-10 10:30Z',
        '2026-11-10 11:30Z',
      ),
    );
    expect(err.code).toBe('23P01');
  });

  // b. An exact duplicate is rejected.
  it('b: exact duplicate confirmed booking is rejected (23P01)', async () => {
    await insertBooking(
      client,
      orgId,
      resourceId,
      '2026-11-10 10:00Z',
      '2026-11-10 11:00Z',
    );
    const err = await expectError(() =>
      insertBooking(
        client,
        orgId,
        resourceId,
        '2026-11-10 10:00Z',
        '2026-11-10 11:00Z',
      ),
    );
    expect(err.code).toBe('23P01');
  });

  // c. A booking that starts exactly when another ends is allowed
  //    (half-open range [starts_at, ends_at) — no overlap at the boundary).
  it('c: back-to-back booking (starts when other ends) is allowed', async () => {
    await insertBooking(
      client,
      orgId,
      resourceId,
      '2026-11-10 10:00Z',
      '2026-11-10 11:00Z',
    );
    // Should succeed — no error expected.
    await insertBooking(
      client,
      orgId,
      resourceId,
      '2026-11-10 11:00Z',
      '2026-11-10 12:00Z',
    );
  });

  // d. A cancelled booking does not block a new booking in the same slot.
  it('d: cancelled booking does not block the same slot', async () => {
    await insertBooking(
      client,
      orgId,
      resourceId,
      '2026-11-10 10:00Z',
      '2026-11-10 11:00Z',
      'cancelled',
    );
    // Should succeed — cancelled booking is excluded from the constraint.
    await insertBooking(
      client,
      orgId,
      resourceId,
      '2026-11-10 10:00Z',
      '2026-11-10 11:00Z',
    );
  });

  // e. Setting a cancelled booking back to confirmed, when it now conflicts,
  //    is rejected (23P01).
  it('e: reactivating a cancelled booking into a conflict is rejected (23P01)', async () => {
    // First booking is confirmed and holds the slot.
    const firstId = await insertBooking(
      client,
      orgId,
      resourceId,
      '2026-11-10 10:00Z',
      '2026-11-10 11:00Z',
    );
    // Second booking is inserted as cancelled (no conflict yet).
    const cancelledId = await insertBooking(
      client,
      orgId,
      resourceId,
      '2026-11-10 10:00Z',
      '2026-11-10 11:00Z',
      'cancelled',
    );
    // Confirm the cancelled booking — now it conflicts with the first.
    const err = await expectError(() =>
      client.query("UPDATE bookings SET status = 'confirmed' WHERE id = $1", [
        cancelledId,
      ]),
    );
    expect(err.code).toBe('23P01');
    // Suppress unused variable lint warning — firstId is intentional.
    void firstId;
  });

  // f. Moving an existing confirmed booking's times so it overlaps another
  //    is rejected (23P01). Tested via UPDATE.
  it('f: updating a booking to overlap another is rejected (23P01)', async () => {
    await insertBooking(
      client,
      orgId,
      resourceId,
      '2026-11-10 10:00Z',
      '2026-11-10 11:00Z',
    );
    const movingId = await insertBooking(
      client,
      orgId,
      resourceId,
      '2026-11-10 12:00Z',
      '2026-11-10 13:00Z',
    );
    // Move the second booking so it overlaps the first.
    const err = await expectError(() =>
      client.query(
        "UPDATE bookings SET starts_at = '2026-11-10 10:30Z', ends_at = '2026-11-10 11:30Z' WHERE id = $1",
        [movingId],
      ),
    );
    expect(err.code).toBe('23P01');
  });

  // g. The same instant written with different UTC offsets is caught.
  //    '2026-11-10 15:30+05:30' and '2026-11-10 10:00Z' are the same moment.
  it('g: same moment in different UTC offsets conflicts (23P01)', async () => {
    await insertBooking(
      client,
      orgId,
      resourceId,
      '2026-11-10 15:30+05:30',
      '2026-11-10 16:30+05:30',
    );
    // '2026-11-10 10:00Z' is the same UTC instant as '2026-11-10 15:30+05:30'.
    const err = await expectError(() =>
      insertBooking(
        client,
        orgId,
        resourceId,
        '2026-11-10 10:00Z',
        '2026-11-10 11:00Z',
      ),
    );
    expect(err.code).toBe('23P01');
  });

  // h. Two different resources in the same org can be booked at the same time.
  it('h: same time slot on different resources in same org is allowed', async () => {
    await insertBooking(
      client,
      orgId,
      resourceId,
      '2026-11-10 10:00Z',
      '2026-11-10 11:00Z',
    );
    // Should succeed — different resource_id means no conflict.
    await insertBooking(
      client,
      orgId,
      resource2Id,
      '2026-11-10 10:00Z',
      '2026-11-10 11:00Z',
    );
  });

  // i. A booking whose org_id differs from its resource's org_id is rejected
  //    by the composite foreign key (23503).
  it('i: booking with mismatched org_id is rejected (23503)', async () => {
    // Create a second org and put resource2Id-equivalent in that org so we can
    // try to use it with a different org_id.
    const otherOrgId = await insertOrg(client, 'Other Org');

    // Try to insert a booking claiming orgId but pointing at a resource that
    // belongs to otherOrgId — use a fake resource_id in otherOrgId context.
    // Simpler: insert booking with otherOrgId but resourceId (which belongs to orgId).
    const err = await expectError(() =>
      insertBooking(
        client,
        otherOrgId,
        resourceId,
        '2026-11-10 10:00Z',
        '2026-11-10 11:00Z',
      ),
    );
    // The composite FK (org_id, resource_id) → resources(org_id, id) fails.
    expect(err.code).toBe('23503');
  });

  // j. ends_at equal to or before starts_at is rejected (23514).
  it('j: ends_at equal to starts_at is rejected (23514)', async () => {
    const err = await expectError(() =>
      insertBooking(
        client,
        orgId,
        resourceId,
        '2026-11-10 10:00Z',
        '2026-11-10 10:00Z',
      ),
    );
    expect(err.code).toBe('23514');
  });

  it('j: ends_at before starts_at is rejected (23514)', async () => {
    const err = await expectError(() =>
      insertBooking(
        client,
        orgId,
        resourceId,
        '2026-11-10 11:00Z',
        '2026-11-10 10:00Z',
      ),
    );
    expect(err.code).toBe('23514');
  });

  // k. A status other than 'confirmed' or 'cancelled' is rejected (23514).
  it('k: invalid status is rejected (23514)', async () => {
    const err = await expectError(() =>
      insertBooking(
        client,
        orgId,
        resourceId,
        '2026-11-10 10:00Z',
        '2026-11-10 11:00Z',
        'pending',
      ),
    );
    expect(err.code).toBe('23514');
  });

  // l. A booking with a null customer_name is rejected (23502).
  it('l: null customer_name is rejected (23502)', async () => {
    const err = await expectError(() =>
      client.query(
        `INSERT INTO bookings
           (org_id, resource_id, starts_at, ends_at, customer_name, customer_email)
         VALUES ($1, $2, '2026-11-10 10:00Z', '2026-11-10 11:00Z', NULL, 'alice@example.com')`,
        [orgId, resourceId],
      ),
    );
    expect(err.code).toBe('23502');
  });

  // m. The guard refuses a TEST_DATABASE_URL whose database name does not end
  //    in _test. This test never connects to any database; it only proves the
  //    URL check (check 2) fires before any SQL.
  it('m: guard refuses a non-test database URL without connecting', () => {
    // Temporarily override the environment variable for this test only.
    const original = process.env['TEST_DATABASE_URL'];
    process.env['TEST_DATABASE_URL'] =
      'postgresql://user:pass@localhost:5432/slotdesk';

    try {
      // requireTestDatabase() must throw before opening any connection.
      expect(() => requireTestDatabase()).toThrow(/does not end in _test/);
    } finally {
      // Restore the original value so subsequent tests are unaffected.
      process.env['TEST_DATABASE_URL'] = original;
    }
  });
});
