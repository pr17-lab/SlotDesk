// Database rule tests for the services table (D-032).
// Each test proves one database rule on a direct connection, without the API.
// Uses TEST_DATABASE_URL only, never DATABASE_URL (D-016).
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { insertOrg } from './helpers/booking-data.js';
import {
  connectAndVerify,
  expectError,
  requireTestDatabase,
  truncateTables,
} from './helpers/db-guard.js';

const { createClient } = requireTestDatabase();

let client: pg.Client;
let orgId: bigint;

async function insertService(
  oid: bigint | string,
  name: string | null,
  durationMinutes: number | null,
): Promise<void> {
  await client.query(
    'INSERT INTO services (org_id, name, duration_minutes) VALUES ($1, $2, $3)',
    [oid, name, durationMinutes],
  );
}

async function countServices(): Promise<number> {
  const r = await client.query<{ count: string }>(
    'SELECT count(*) FROM services',
  );
  return Number(r.rows[0]!.count);
}

beforeAll(async () => {
  client = createClient();
  await connectAndVerify(client);
  orgId = await insertOrg(client, 'Services Rules Org');
});

afterAll(async () => {
  await truncateTables(client);
  await client.end();
});

beforeEach(async () => {
  // bookings references services, and PostgreSQL refuses to truncate a
  // referenced table on its own, so both are named.
  await client.query('TRUNCATE bookings, services');
});

describe('services constraint tests', () => {
  it.each([5, 480, 30])('accepts a duration of %i minutes', async (minutes) => {
    await insertService(orgId, 'Haircut', minutes);
    expect(await countServices()).toBe(1);
  });

  // 0, -5 and 485 are multiples of 5, so only the range part of the CHECK can
  // refuse them. 7 is in range, so only the multiple-of-5 part can refuse it.
  it.each([0, -5, 485, 7])(
    'refuses a duration of %i minutes (23514)',
    async (minutes) => {
      const err = await expectError(() =>
        insertService(orgId, 'Haircut', minutes),
      );
      expect(err.code).toBe('23514');
      expect(err.constraint).toBe('services_duration_minutes_check');
      expect(await countServices()).toBe(0);
    },
  );

  it('refuses a NULL name (23502)', async () => {
    const err = await expectError(() => insertService(orgId, null, 30));
    expect(err.code).toBe('23502');
  });

  it('refuses a NULL duration (23502)', async () => {
    const err = await expectError(() => insertService(orgId, 'Haircut', null));
    expect(err.code).toBe('23502');
  });

  it('refuses an org_id that does not exist (23503)', async () => {
    const err = await expectError(() => insertService('999999', 'Haircut', 30));
    expect(err.code).toBe('23503');
    expect(err.constraint).toBe('services_org_id_fkey');
  });

  it('refuses deleting an organization that has a service (23503)', async () => {
    await insertService(orgId, 'Haircut', 30);
    const err = await expectError(() =>
      client.query('DELETE FROM organizations WHERE id = $1', [orgId]),
    );
    expect(err.code).toBe('23503');
    expect(err.constraint).toBe('services_org_id_fkey');
    expect(await countServices()).toBe(1);
  });

  it('has the unique key services_org_id_id_key', async () => {
    const r = await client.query<{ contype: string }>(
      `SELECT contype FROM pg_constraint
       WHERE conname = 'services_org_id_id_key'
         AND conrelid = 'services'::regclass`,
    );
    expect(r.rows).toEqual([{ contype: 'u' }]);
  });
});
