// Database rule tests for the bookings table (D-026).
// Each test proves one database constraint using a real PostgreSQL connection.
// Tests commit for real; tenant tables are truncated after this file runs.
// Uses TEST_DATABASE_URL only — never DATABASE_URL (D-016).

import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  insertOrg,
  insertResource,
  insertService,
} from './helpers/booking-data.js';
import {
  connectAndVerify,
  expectError,
  requireTestDatabase,
  truncateTables,
} from './helpers/db-guard.js';

const { createClient } = requireTestDatabase();

let client: pg.Client;
let orgId: bigint;
let resourceId: bigint;
let resource2Id: bigint;
let serviceId: bigint;

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
       (org_id, resource_id, service_id, starts_at, ends_at, status,
        customer_name, customer_email)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING id`,
    [
      oid,
      rid,
      serviceId,
      startsAt,
      endsAt,
      status,
      customerName,
      customerEmail,
    ],
  );
  return BigInt(r.rows[0]!.id);
}

beforeAll(async () => {
  client = createClient();
  await connectAndVerify(client);

  // Each file makes its own org and resources so files cannot affect each
  // other (D-016).
  orgId = await insertOrg(client, 'Rules Test Org');
  resourceId = await insertResource(client, orgId, 'Room A');
  resource2Id = await insertResource(client, orgId, 'Room B');
  serviceId = await insertService(client, orgId, 'Haircut');
});

afterAll(async () => {
  await truncateTables(client);
  await client.end();
});

// Each test starts with no bookings but keeps the org and resources.
beforeEach(async () => {
  await client.query('TRUNCATE bookings RESTART IDENTITY');
});

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
    const firstId = await insertBooking(
      client,
      orgId,
      resourceId,
      '2026-11-10 10:00Z',
      '2026-11-10 11:00Z',
    );
    // Same slot, but cancelled, so no conflict yet.
    const cancelledId = await insertBooking(
      client,
      orgId,
      resourceId,
      '2026-11-10 10:00Z',
      '2026-11-10 11:00Z',
      'cancelled',
    );
    const err = await expectError(() =>
      client.query("UPDATE bookings SET status = 'confirmed' WHERE id = $1", [
        cancelledId,
      ]),
    );
    expect(err.code).toBe('23P01');
    // firstId only holds the slot; this keeps lint quiet.
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
    const otherOrgId = await insertOrg(client, 'Other Org');

    // The booking claims otherOrgId, but resourceId belongs to orgId.
    const err = await expectError(() =>
      insertBooking(
        client,
        otherOrgId,
        resourceId,
        '2026-11-10 10:00Z',
        '2026-11-10 11:00Z',
      ),
    );
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
           (org_id, resource_id, service_id, starts_at, ends_at, customer_name, customer_email)
         VALUES ($1, $2, $3, '2026-11-10 10:00Z', '2026-11-10 11:00Z', NULL, 'alice@example.com')`,
        [orgId, resourceId, serviceId],
      ),
    );
    expect(err.code).toBe('23502');
  });

  // n. service_id (D-033). Both foreign keys give 23503, so each
  //    test also checks the constraint name.
  it('n: unknown service_id is rejected (23503, bookings_service_fk)', async () => {
    const err = await expectError(() =>
      client.query(
        `INSERT INTO bookings
           (org_id, resource_id, service_id, starts_at, ends_at, customer_name, customer_email)
         VALUES ($1, $2, 999999, '2026-11-10 10:00Z', '2026-11-10 11:00Z', 'Alice', 'alice@example.com')`,
        [orgId, resourceId],
      ),
    );
    expect(err.code).toBe('23503');
    expect(err.constraint).toBe('bookings_service_fk');
  });

  it("n: another organization's service is rejected (23503, bookings_service_fk)", async () => {
    const otherOrgId = await insertOrg(client, 'Service Owner Org');
    const otherServiceId = await insertService(client, otherOrgId, 'Other');
    const err = await expectError(() =>
      client.query(
        `INSERT INTO bookings
           (org_id, resource_id, service_id, starts_at, ends_at, customer_name, customer_email)
         VALUES ($1, $2, $3, '2026-11-10 10:00Z', '2026-11-10 11:00Z', 'Alice', 'alice@example.com')`,
        [orgId, resourceId, otherServiceId],
      ),
    );
    expect(err.code).toBe('23503');
    expect(err.constraint).toBe('bookings_service_fk');
  });

  it('n: null service_id is rejected (23502)', async () => {
    const err = await expectError(() =>
      client.query(
        `INSERT INTO bookings
           (org_id, resource_id, service_id, starts_at, ends_at, customer_name, customer_email)
         VALUES ($1, $2, NULL, '2026-11-10 10:00Z', '2026-11-10 11:00Z', 'Alice', 'alice@example.com')`,
        [orgId, resourceId],
      ),
    );
    expect(err.code).toBe('23502');
    expect(err.column).toBe('service_id');
  });

  it('n: deleting a service that has a booking is refused (23503)', async () => {
    await insertBooking(
      client,
      orgId,
      resourceId,
      '2026-11-10 10:00Z',
      '2026-11-10 11:00Z',
    );
    const err = await expectError(() =>
      client.query('DELETE FROM services WHERE id = $1', [serviceId]),
    );
    expect(err.code).toBe('23503');
    expect(err.constraint).toBe('bookings_service_fk');
  });

  // m. The guard refuses a TEST_DATABASE_URL whose database name does not end
  //    in _test, before any connection is opened.
  it('m: guard refuses a non-test database URL without connecting', () => {
    const original = process.env['TEST_DATABASE_URL'];
    process.env['TEST_DATABASE_URL'] =
      'postgresql://user:pass@localhost:5432/slotdesk';

    try {
      expect(() => requireTestDatabase()).toThrow(/does not end in _test/);
    } finally {
      process.env['TEST_DATABASE_URL'] = original;
    }
  });
});
